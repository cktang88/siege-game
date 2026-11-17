/*
  Value lab: is every round worth its price? For each purchasable munition it fires an equal spend of
  that round, aimed by a solver at the target the round is meant for, on real campaign levels, and
  measures what the spend bought (block HP removed, objective HP, objectives killed, garrison and
  infantry killed, aircraft downed, rooms uncovered, counter-battery damage avoided). Results are
  given per 100 credits and as a ratio to the best of the baseline rounds (round shot / HE).

    npx vite --port 5193 --host 127.0.0.1 --strictPort &      # then:
    BASE=http://127.0.0.1:5193 NODE_PATH=$(npm root -g) node scripts/value-lab.cjs [sections] [trials]
      sections: comma list of struct,niche,campaign,infantry,air,smoke,drone,pen (default: all)
      trials:   seeds per cell (default 3)
    VALUE_JSON=out.json also writes the raw rows.

  The simulation is stepped in-page (window.siege.game.update) with the page's own frame loop parked,
  so a whole trial runs synchronously inside one page.evaluate and is reproducible: Math.random is
  replaced by a seeded generator for the trial. Research is the base tree except for muzzle velocity
  (set to the level's planned gun cap + 4 m/s) and reload (1.0 s); no damage upgrades are applied.
  Enemy timers (counter-battery, reinforcements, engineers, air waves) are off except where a section
  measures them.
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

// ───────────────────────── in-page library ─────────────────────────
function installValue() {
  const V = {};
  window.__val = V;
  V.init = async () => {
    V.hud = await import('/src/hud.ts');
    V.cfg = await import('/src/config.ts');
    V.prog = await import('/src/progress.ts');
    V.camp = await import('/src/campaign.ts');
  };
  const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  V.gauss = () => { const u = Math.random() || 1e-9, v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /** load a campaign operation; o.live = which enemy timers keep running */
  V.load = (nodeId, o = {}) => {
    Math.random = mulberry((o.seed || 1) * 2654435761);
    const S = window.siege, g = S.game;
    delete g.checkEnd; // undo a previous trial's override
    const lvl = V.camp.NODE_BY_ID[nodeId].level();
    S.level = lvl;
    g.stats = Object.assign(V.prog.baseStats(), { reload: 1 }, o.stats || {});
    g.load(lvl);
    g.stats.maxSpeed = (o.stats && o.stats.maxSpeed) || (g.level.gunCap || 36) + 4;
    const inv = {};
    for (const a of V.cfg.SHOP_AMMO()) inv[a.id] = 999;
    V.hud.startBattle(inv, 0, 999999);
    S.mode = 'map'; // park the page's frame loop: the lab steps the battle itself
    g.wind = 0;
    g.reload = 0;
    g.cannonHp = 1e6; // the lab never loses its gun
    V.g = g;
    V.live = o.live || {};
    V.off();
    V.start = g.blocks.filter((b) => !b.mat.indestructible);
    V.hp0 = V.hpOf(V.start);
    V.obj = V.start.filter((b) => b.target && g.level.objectives.includes(b.target));
    V.cas0 = g.garrison.casualties;
    V.hidden0 = g.garrison.rooms.list.filter((r) => r.hidden).length;
    return g;
  };
  V.hpOf = (bs) => bs.reduce((s, b) => s + (b.dead ? 0 : Math.max(0, b.hp)), 0);
  V.off = () => {
    const g = V.g, L = V.live;
    if (!L.art) g.artT = 999;
    if (!L.bar) g.barT = 999;
    g.repT = g.rebT = 999;
    if (!L.air) g.air.spawnT = 999;
    g.motor && (g.motor.spawnT = 999);
  };
  V.step = (secs, each) => {
    const g = V.g, n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) { V.off(); g.update(1 / 60); if (each && each(i)) return i + 1; }
    return n;
  };
  /** step until the player's ordnance, teams and chain blasts are all spent (plus a settle), capped */
  V.settle = (max = 25, tail = 1) => {
    const g = V.g;
    let quiet = 0, t = 0;
    for (; t < max * 60; t++) {
      V.off(); g.update(1 / 60);
      const busy = g.projectiles.some((p) => !p.enemy && !p.dead) || g.planes.length || g.saboteurs.length || g.pending.length || g.drones.length;
      quiet = busy ? 0 : quiet + 1;
      if (quiet > tail * 60) break;
    }
    return t / 60;
  };
  V.metrics = () => {
    const g = V.g;
    const objFrac = V.obj.reduce((s, b) => s + (b.dead ? 1 : 1 - Math.max(0, b.hp) / b.maxHp), 0);
    return {
      hp: V.hp0 - V.hpOf(V.start),
      objFrac,
      objKills: V.obj.filter((b) => b.dead).length,
      objTotal: V.obj.length,
      garrison: g.garrison.casualties - V.cas0,
      uncovered: V.hidden0 - g.garrison.rooms.list.filter((r) => r.hidden).length,
      won: V.obj.every((b) => b.dead),
    };
  };

  // ── ballistics ──
  const G = 9.81;
  V.muzzleAt = (a) => { const bp = V.g.barrel.position; return { x: bp.x + Math.cos(a) * 2.5, y: bp.y + Math.sin(a) * 2.5 }; };
  /** height of the shell at x for elevation a and speed s (no wind) */
  V.yAt = (a, s, x) => { const m = V.muzzleAt(a); const vx = Math.cos(a) * s; if (vx <= 1e-3) return NaN; const t = (x - m.x) / vx; if (t < 0) return NaN; return m.y + Math.sin(a) * s * t - 0.5 * G * t * t; };
  /** every elevation that puts a shell of speed s through (tx, ty): flat and lofted roots */
  V.roots = (s, tx, ty) => {
    const g = V.g, lo = g.stats.minAngle, hi = g.stats.maxAngle;
    const out = [];
    let pa = null, pf = null;
    for (let d = lo; d <= hi; d += 0.5) {
      const a = (d * Math.PI) / 180, f = V.yAt(a, s, tx) - ty;
      if (pf !== null && !isNaN(f) && !isNaN(pf) && Math.sign(f) !== Math.sign(pf)) {
        let a0 = pa, a1 = a, f0 = pf;
        for (let k = 0; k < 30; k++) { const am = (a0 + a1) / 2, fm = V.yAt(am, s, tx) - ty; if (Math.sign(fm) === Math.sign(f0)) { a0 = am; f0 = fm; } else a1 = am; }
        out.push((a0 + a1) / 2);
      }
      pa = a; pf = f;
    }
    return out;
  };
  V.blockAt = (x, y) => {
    let found = null;
    V.g.world.intersectionsWithPoint({ x, y }, (c) => { const o = V.g.owners.get(c.handle); if (o && o.t === 'block' && !o.b.dead) { found = o.b; return false; } return true; });
    return found;
  };
  /** fly the path; first contact with a block or the ground. crossed: blocks passed through before x reaches tx */
  V.trace = (a, s, tx, stopAtTarget) => {
    const g = V.g, m = V.muzzleAt(a);
    let x = m.x, y = m.y, vx = Math.cos(a) * s, vy = Math.sin(a) * s;
    const dt = 1 / 240;
    const crossed = [];
    let first = null;
    for (let i = 0; i < 240 * 8; i++) {
      vy -= G * dt; x += vx * dt; y += vy * dt;
      if (y <= g.groundY(x)) { if (!first) first = { x, y, b: null, t: i * dt }; break; }
      const b = V.blockAt(x, y);
      if (b) {
        if (!first) first = { x, y, b, t: i * dt };
        if (!stopAtTarget) break;
        if (b === stopAtTarget) break;
        if (!crossed.includes(b)) crossed.push(b);
      }
      if (x > tx + 30 || y < -30) break;
    }
    return { first, crossed };
  };
  const centre = (b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; };
  V.centre = centre;
  /**
   * The gunner: for the target block (or ground point), try flat and lofted arcs at several charges and
   * pick the one whose first contact is the target (or nearest to it). Penetrators pick the arc that
   * crosses the least armour on the way. Returns { a, s, t (flight time to first contact) }.
   */
  V.solve = (ammo, tgt, opt = {}) => {
    const g = V.g;
    const vmax = g.stats.maxSpeed * (ammo.speed || 1);
    const pt = tgt.x !== undefined ? tgt : centre(tgt);
    const blk = tgt.body ? tgt : null;
    let best = null;
    for (const f of [1, 0.92, 0.84, 0.76, 0.68, 0.6]) {
      const s = vmax * f;
      for (const a of V.roots(s, pt.x, pt.y)) {
        let score;
        const tr = V.trace(a, s, pt.x, ammo.mode === 'penetrator' ? blk : null);
        if (!tr.first) continue;
        if (ammo.mode === 'penetrator' && blk) {
          // armour on the way: sum of hp / pierce of the blocks crossed before the target
          score = tr.crossed.reduce((q, b) => q + b.hp / b.mat.pierce, 0) + (tr.first.b === blk || tr.crossed.length ? 0 : Math.hypot(tr.first.x - pt.x, tr.first.y - pt.y) * 100);
        } else if (opt.ground) {
          score = tr.first.b ? 50 + Math.hypot(tr.first.x - pt.x, tr.first.y - pt.y) : Math.abs(tr.first.x - pt.x);
        } else {
          score = tr.first.b === blk && blk ? 0 : Math.hypot(tr.first.x - pt.x, tr.first.y - pt.y);
        }
        score += f < 1 ? 0.02 * (1 - f) : 0; // prefer full charge on ties
        if (opt.lofted) score += a < 0.7 ? 0.5 : 0;
        if (!best || score < best.score) best = { a, s, score, t: tr.first.t, hitTarget: tr.first.b === blk && !!blk };
      }
    }
    return best;
  };
  /** fire `ammo` at a target block or point with aiming error sigma (metres at the target) */
  V.fireAt = (id, tgt, o = {}) => {
    const g = V.g, ammo = V.cfg.AMMO_BY_ID[id];
    const sol = V.solve(ammo, tgt, o);
    if (!sol) return null;
    const m = V.muzzleAt(sol.a), pt = tgt.x !== undefined ? tgt : centre(tgt);
    const dist = Math.hypot(pt.x - m.x, pt.y - m.y);
    const sigma = o.sigma ?? 0.35;
    g.selected = id;
    g.angle = sol.a + (V.gauss() * sigma) / Math.max(5, dist);
    g.speed = sol.s;
    if (id === 'delayed') g.fuseSetting = o.fuse ?? 1;
    if (id === 'cluster') g.airburst = o.airburst ?? Math.max(0.2, sol.t - 0.3);
    if (id === 'flak') g.flakFuse = o.flakFuse ?? sol.t + 0.3;
    g.reload = 0;
    const ok = g.fire();
    g.airburst = 0;
    return ok ? sol : null;
  };

  /** nearest live objective (or any live target of a kind) */
  V.nextObjective = () => {
    const g = V.g, cx = g.level.cannonX;
    const live = V.obj.filter((b) => !b.dead);
    live.sort((a, b) => Math.abs(centre(a).x - cx) - Math.abs(centre(b).x - cx));
    return live[0] || null;
  };
  /**
   * The drill shot a skilled gunner takes: the open patch of ground nearest short of the target that a
   * shell can actually land on (first contact is that ground), searching back to the glacis.
   */
  V.drillShot = (b) => {
    const g = V.g, a = V.cfg.AMMO_BY_ID.drill;
    const t = centre(b);
    const clear = (x) => { const gy = g.groundY(x); for (const dx of [-0.5, 0, 0.5]) for (const dy of [0.2, 1, 2, 3.5]) if (V.blockAt(x + dx, gy + dy)) return false; return true; };
    for (let x = t.x - b.w / 2 - 1; x > g.level.cannonX + 15; x -= 0.5) {
      if (!clear(x)) continue;
      const pt = { x, y: g.groundY(x) + 0.02 };
      const sol = V.solve(a, pt, { ground: true });
      if (sol && sol.score < 0.6) return pt;
    }
    return null;
  };

  /**
   * Structural trial: spend `budget` on round `id` against the level's objectives, re-aiming each round.
   * Records what the spend removed after a common 20 s tail (fires burn, masonry settles).
   */
  V.structTrial = (o) => {
    const g = V.load(o.level, { seed: o.seed, stats: o.stats });
    if (o.stop === false) g.checkEnd = () => {}; // equal spend: the battle never ends, keep firing
    const a = V.cfg.AMMO_BY_ID[o.id];
    const n = Math.max(1, Math.round(o.budget / a.price));
    let fired = 0, time = 0, hitTarget = 0;
    const out = { burrow: 0, direct: 0, embed: 0, ricochet: 0, premature: 0, sabKilled: 0, bombs: 0 };
    // instrument the round's behaviour
    const pStop = g.penetratorStop.bind(g);
    g.penetratorStop = (p, dir, b) => { if (p.ammo.id === o.id && p.ammo.fuse) out.embed++; return pStop(p, dir, b); };
    const ric = g.ricochet.bind(g);
    g.ricochet = (...r) => { out.ricochet++; return ric(...r); };
    const toast = g.toast.bind(g);
    g.toast = (t, tone) => { if (/burrowing/.test(t)) out.burrow++; if (/gunned down|caught in the blast/.test(t)) out.sabKilled++; return toast(t, tone); };
    for (let i = 0; i < n; i++) {
      let t = V.nextObjective();
      if (!t && o.stop === false) {
        // objectives down: keep working on the structure where they stood (biggest live block nearest them)
        const oc = V.obj.map((b) => b.def).reduce((q, d) => ({ x: q.x + (d.x + d.w / 2) / V.obj.length, y: q.y + (d.y + d.h / 2) / V.obj.length }), { x: 0, y: 0 });
        t = V.start.filter((b) => !b.dead).sort((p, q) => (Math.hypot(centre(p).x - oc.x, centre(p).y - oc.y) - p.maxHp / 60) - (Math.hypot(centre(q).x - oc.x, centre(q).y - oc.y) - q.maxHp / 60))[0];
      }
      if (!t) break;
      if (a.mode === 'saboteur') { g.sabTarget = null; g.selected = 'saboteur'; g.reload = 0; g.fire(); }
      else if (a.mode === 'airstrike') {
        Object.assign(g.strike, { x: centre(t).x, dir: 1, alt: 24, dive: 0, spacing: 1.6, ordnance: 'he' });
        g.selected = 'airstrike'; g.reload = 0; g.fire();
      } else if (o.id === 'drill') {
        const pt = V.drillShot(t);
        const sol = pt && V.fireAt('drill', pt, { ground: true, sigma: 0.35 });
        if (!sol) break;
      } else {
        let sol = V.fireAt(o.id, t, { sigma: 0.35 });
        if (!sol) {
          // out of reach (sticky charges are slow): hit the nearest block toward it that can be reached
          const tc = centre(t);
          const near = V.start.filter((b) => !b.dead).sort((p, q) => Math.hypot(centre(p).x - tc.x, centre(p).y - tc.y) - Math.hypot(centre(q).x - tc.x, centre(q).y - tc.y));
          let pick = null;
          for (const b of near.slice(0, 60)) { const s2 = V.solve(a, b); if (s2 && (!pick || s2.score < pick.score)) pick = { b, score: s2.score }; if (s2 && s2.score < 0.5) break; }
          if (pick) { sol = V.fireAt(o.id, pick.b, { sigma: 0.35 }); out.fallback = (out.fallback || 0) + 1; }
        }
        if (!sol) break;
        if (sol.hitTarget) hitTarget++;
      }
      fired++;
      time += V.settle(o.id === 'saboteur' || o.id === 'airstrike' ? 30 : 12, 0.6);
      if (o.stop !== false && V.obj.every((b) => b.dead)) break;
    }
    V.step(o.tail ?? 20);
    const m = V.metrics();
    g.penetratorStop = pStop; g.ricochet = ric; g.toast = toast;
    return { ...m, fired, spent: fired * a.price, time, hitTarget, ...out };
  };

  /** drill behaviour probe: where do drills land, do they burrow, how far, what do they blow */
  V.drillProbe = (o) => {
    V.load(o.level, { seed: o.seed });
    const t = V.nextObjective();
    const tx = centre(t).x; // read before firing: a destroyed block's body is freed
    const pt = V.drillShot(t);
    if (!pt) return { aimX: NaN, land: null, burrowed: false, blew: null, target: tx };
    V.fireAt('drill', pt, { ground: true, sigma: 0.35 });
    const p = V.g.projectiles.find((q) => q.ammo.id === 'drill');
    let land = null, blew = null, burrowed = false;
    const ex = V.g.explode.bind(V.g);
    V.g.explode = (x, y, r, d, op) => { if (!blew) blew = { x, y, r, d }; return ex(x, y, r, d, op); };
    V.step(12, () => { if (p.burrow && !land) { land = p.x; burrowed = true; } return p.dead; });
    V.g.explode = ex;
    return { aimX: pt.x, land, burrowed, blew, target: tx, killed: t.dead };
  };

  /** infantry: a file of four men walking in; one round at them; kills */
  V.infantryTrial = (o) => {
    const g = V.load(o.level, { seed: o.seed });
    const cx = g.level.cannonX;
    const N = o.n || 4;
    for (let i = 0; i < N; i++) g.spawnSoldier(cx + 34 + i * (o.gap || 2.2), Math.random() < (o.shields ?? 0));
    for (const s of g.soldiers) s.stopX = cx + 14;
    V.step(1.5);
    const live = g.soldiers.filter((s) => !s.dead);
    const mid = (live[0].x + live[live.length - 1].x) / 2;
    // lead: they walk 1.6 m/s toward the gun
    const a = V.cfg.AMMO_BY_ID[o.id];
    let tx = mid;
    // cluster is lobbed and burst early over the file, as it is meant to be used
    const lofted = o.id === 'cluster';
    let sol = null;
    for (let k = 0; k < 3; k++) {
      sol = V.solve(a, { x: tx, y: g.groundY(tx) + (o.id === 'canister' || o.id === 'shell' ? 0.9 : 0.15) }, { ground: o.id !== 'canister' && o.id !== 'shell', lofted });
      tx = mid - 1.6 * (sol ? sol.t : 0.8);
    }
    const aimY = g.groundY(tx) + (o.id === 'canister' || o.id === 'shell' ? 0.9 : 0.15);
    V.fireAt(o.id, { x: tx, y: aimY }, { sigma: 0.35, ground: o.id !== 'canister' && o.id !== 'shell', lofted, airburst: lofted && sol ? Math.max(0.2, sol.t - 0.9) : undefined });
    V.settle(6, 0.5);
    return { kills: g.soldiers.filter((s) => s.dead).length, n: N, shields: g.soldiers.filter((s) => s.shield > 0 || s.rig.shieldDropped).length };
  };

  /** aircraft: launch one unit from a mast, fire up to 8 rounds with lead until it is down */
  V.airTrial = (o) => {
    const g = V.load(o.level, { seed: o.seed, });
    const mast = g.blocks.find((b) => b.target === 'mast' && !b.dead);
    g.air.launch(o.kind, mast);
    const u = g.air.units[0];
    V.step(o.kind === 'gyro' ? 3 : 6);
    const a = V.cfg.AMMO_BY_ID[o.id];
    let shots = 0;
    for (; shots < 8 && !u.down; shots++) {
      // lead the target by the flight time (iterate)
      let px = u.x, py = u.y, sol = null;
      for (let k = 0; k < 4; k++) {
        const vmax = g.stats.maxSpeed * (a.speed || 1), rts = V.roots(vmax, px, py);
        sol = rts.length ? { a: rts[0], s: vmax, t: (px - V.muzzleAt(rts[0]).x) / (Math.cos(rts[0]) * vmax) } : null;
        if (!sol) break;
        px = u.x + u.vx * sol.t; py = u.y + u.vy * sol.t;
      }
      if (!sol) break;
      const m = V.muzzleAt(sol.a), dist = Math.hypot(px - m.x, py - m.y);
      g.selected = o.id; g.angle = sol.a + (V.gauss() * 0.6) / Math.max(5, dist); g.speed = sol.s; g.flakFuse = sol.t + 0.4; g.airburst = o.id === 'cluster' ? Math.max(0.2, sol.t - 0.25) : 0; g.reload = 0;
      g.fire(); g.airburst = 0;
      V.step(1.0);
      if (u.down) { shots++; break; }
    }
    V.step(1);
    return { down: u.down, shots: u.down ? shots : 8 };
  };

  /** counter-battery: 90 s of live enemy artillery; smoke every 15 s, or nothing */
  V.smokeTrial = (o) => {
    const g = V.load(o.level, { seed: o.seed });
    V.live = { art: true };
    g.artT = 4;
    const hp0 = g.cannonHp;
    let smokes = 0;
    for (let t = 0; t < 90; t += 0.5) {
      if (o.smoke && t >= (o.lead ?? 0) && smokes * 15 <= t - (o.lead ?? 0) && g.enemyBlind <= 0.5) {
        const pt = { x: g.level.cannonX + 25, y: g.groundY(g.level.cannonX + 25) };
        V.fireAt('smoke', pt, { ground: true });
        smokes++;
      }
      V.step(0.5);
    }
    return { dmg: hp0 - g.cannonHp, shots: g.artilleryShots, smokes };
  };

  /** drone: one scout drone over the fortress centre (or o.x); rooms uncovered */
  V.droneTrial = (o) => {
    const g = V.load(o.level, { seed: o.seed, stats: o.stats });
    const rooms = g.garrison.rooms.list;
    const hid = rooms.filter((r) => r.hidden);
    const objHid = hid.filter((r) => r.target && g.level.objectives.includes(r.target.target));
    const fb = g.fortressBounds;
    // default: where the game puts it (over the middle, 6 m above the highest block); o.fx/o.h: a chosen loiter point
    const dx = o.fx !== undefined ? fb.x0 + (fb.x1 - fb.x0) * o.fx : (fb.x0 + fb.x1) / 2;
    g.droneTarget = o.h !== undefined ? { x: dx, y: g.groundY(dx) + o.h } : g.defaultLoiter ? g.defaultLoiter() : { x: dx, y: fb.y1 + 6 };
    g.selected = 'drone'; g.reload = 0; g.fire();
    V.settle(20, 0.2);
    const still = rooms.filter((r) => r.hidden);
    return { hidden: hid.length, found: hid.length - still.length, objHidden: objHid.length, objFound: objHid.filter((r) => !r.hidden).length, rooms: rooms.length, x0: fb.x0, x1: fb.x1 };
  };

  /** how many HE rounds (aimed at the room centre) break open hidden room k */
  V.breachTrial = (o) => {
    const g = V.load(o.level, { seed: o.seed });
    const hid = g.garrison.rooms.list.filter((r) => r.hidden);
    const r = hid[o.k % hid.length];
    if (!r) return null;
    const pt = { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
    let n = 0;
    for (; n < 8 && r.hidden; n++) { V.fireAt(o.id || 'he', pt, { sigma: 0.35 }); V.settle(8, 0.5); }
    return { rounds: r.hidden ? 9 : n, obj: !!(r.target && g.level.objectives.includes(r.target.target)), hidden: hid.length };
  };

  /**
   * Niche scenes on flat lab ground: fire one kind of round until the target in the scene is destroyed
   * (8 rounds max). Shots are the textbook delivery for each round: flat at full charge for shells and
   * penetrators, a lobbed burst over the top for cluster, a short landing for the drill, a run on foot for
   * the saboteur, a bomb run for the air strike.
   */
  V.nicheLab = (o) => {
    const S = window.siege;
    Math.random = mulberry((o.seed || 7) * 7919);
    const scenes = {
      // a masonry blockhouse wearing a reactive skin, its command post inside
      reactive: [{ x: 30, y: 0, w: 0.5, h: 3, mat: 'reactive' }, { x: 30.5, y: 0, w: 1, h: 3, mat: 'stone' }, { x: 31.5, y: 0, w: 1.4, h: 1.2, mat: 'wood', target: 'command' }, { x: 32.9, y: 0, w: 1, h: 3, mat: 'stone' }, { x: 30, y: 3, w: 3.9, h: 0.7, mat: 'stone' }],
      // a gun pit behind two rammed-earth berms
      earth: [{ x: 30, y: 0, w: 3, h: 2.2, mat: 'earth' }, { x: 33.5, y: 0, w: 3, h: 2.2, mat: 'earth' }, { x: 37, y: 0, w: 1.4, h: 1.2, mat: 'wood', target: 'artillery' }],
      // a concrete casemate (2 m walls, 1 m roof)
      casemate: [{ x: 30, y: 0, w: 2, h: 3.2, mat: 'concrete' }, { x: 32, y: 0, w: 1.6, h: 1.2, mat: 'wood', target: 'artillery' }, { x: 33.6, y: 0, w: 2, h: 3.2, mat: 'concrete' }, { x: 30, y: 3.2, w: 5.6, h: 1, mat: 'concrete' }],
      // a timber blockhouse: the store inside sits behind a timber wall, under a timber roof
      timber: [{ x: 30, y: 0, w: 0.6, h: 2.6, mat: 'wood' }, { x: 30.6, y: 0, w: 1.4, h: 1.2, mat: 'crate', target: 'ammo' }, { x: 32, y: 0, w: 0.6, h: 2.6, mat: 'wood' }, { x: 30, y: 2.6, w: 2.6, h: 0.5, mat: 'wood' }, { x: 33.5, y: 0, w: 2, h: 2, mat: 'wood' }, { x: 36, y: 0, w: 2, h: 2, mat: 'wood' }],
      // a tall masonry tower with the post on its top floor
      tower: [0, 1.5, 3, 4.5, 6].map((y) => ({ x: 30, y, w: 1.6, h: 1.5, mat: 'stone' })).concat([{ x: 30.2, y: 7.5, w: 1.2, h: 1, mat: 'wood', target: 'command' }]),
      // a lookout post on a slender tower, boxed in masonry (no clean line): bring the tower down
      topple: [0, 1, 2, 3, 4, 5].map((y) => ({ x: 30, y, w: 1.5, h: 1, mat: 'stone' })).concat([{ x: 29.7, y: 6, w: 0.4, h: 1.4, mat: 'stone' }, { x: 30.1, y: 6, w: 1, h: 1, mat: 'wood', target: 'command' }, { x: 31.1, y: 6, w: 0.4, h: 1.4, mat: 'stone' }, { x: 29.7, y: 7.4, w: 1.8, h: 0.4, mat: 'stone' }]),
      // an open gun line: three guns 3 m apart behind a 1.2 m earth parapet (every gun must go)
      battery: [{ x: 32, y: 0, w: 1.2, h: 1.2, mat: 'earth' }, { x: 34, y: 0, w: 1.4, h: 0.9, mat: 'steel', target: 'artillery' }, { x: 37, y: 0, w: 1.4, h: 0.9, mat: 'steel', target: 'artillery' }, { x: 40, y: 0, w: 1.4, h: 0.9, mat: 'steel', target: 'artillery' }],
    };
    const blocks = scenes[o.scene];
    const lvl = { id: 'lab', name: 'Lab', brief: '', intel: [], budget: 1, wind: [0, 0], parTime: 60, ground: [[-80, 0], [400, 0]], cannonX: 0,
      blocks: [...blocks, { x: 390, y: 0, w: 1, h: 1, mat: 'rock', target: 'command' }], houses: [], objectives: ['command'], stars: [1, 2, 3], collateralMult: 1 };
    S.level = lvl;
    const g = S.game;
    delete g.checkEnd;
    g.stats = Object.assign(V.prog.baseStats(), o.stats || {});
    g.load(lvl);
    g.checkEnd = () => {};
    const inv = {}; for (const a of V.cfg.SHOP_AMMO()) inv[a.id] = 99;
    V.hud.startBattle(inv, 0, 999999); S.mode = 'map'; g.wind = 0; g.cannonHp = 1e6;
    V.g = g; V.live = {}; V.off();
    const tgts = g.blocks.filter((b) => b.target && !b.mat.indestructible);
    const multi = tgts.length > 1;
    const a = V.cfg.AMMO_BY_ID[o.id];
    const hp0 = V.hpOf(g.blocks.filter((b) => !b.mat.indestructible));
    let n = 0;
    for (; n < 8 && tgts.some((b) => !b.dead); n++) {
      const tgt = tgts.find((b) => !b.dead);
      const tc = centre(tgt);
      const j = () => V.gauss() * 0.15;
      if (multi && a.mode !== 'saboteur' && a.mode !== 'airstrike' && o.id !== 'drill') {
        // a gun line: the gunner's solver against the next gun (cluster lobbed and burst early over the line)
        const lofted = o.id === 'cluster';
        const mid = o.id === 'cluster' ? { x: (tgts[0].def.x + tgts[tgts.length - 1].def.x + 1.4) / 2, y: 0.5 } : tgt;
        const sol = V.solve(a, mid, { lofted, ground: !mid.body });
        V.fireAt(o.id, mid, { sigma: 0.35, lofted, ground: !mid.body, airburst: lofted && sol ? Math.max(0.2, sol.t - 0.6) : undefined });
        V.settle(25, 0.6);
        continue;
      }
      if (a.mode === 'saboteur') { g.sabTarget = null; g.selected = 'saboteur'; g.reload = 0; g.fire(); }
      else if (a.mode === 'airstrike') { Object.assign(g.strike, { x: tc.x, dir: 1, alt: 24, dive: 0, spacing: 1.6, ordnance: 'he' }); g.selected = 'airstrike'; g.reload = 0; g.fire(); }
      else if (o.id === 'drill') V.shoot('drill', 22, 3, 14, -4 + j());
      else if (o.id === 'cluster') { const p = V.shoot('cluster', tc.x - 8, 12 + j(), 9, 0); V.step(0.3); if (!p.dead) g.splitCluster(p); }
      else V.shoot(o.id, 26, (o.scene === 'topple' && tc.y > 5 ? 4.5 : Math.max(0.4, tc.y)) + j(), 30 * (a.speed || 1), 0);
      V.settle(25, 0.6);
    }
    V.step(o.id === 'incendiary' ? 15 : 2);
    const all = tgts.every((b) => b.dead);
    return { killed: all, rounds: all ? n : NaN, cost: all ? n * a.price : NaN, hp: hp0 - V.hpOf(g.blocks.filter((b) => !b.mat.indestructible)) };
  };
  V.shoot = (id, x, y, vx, vy) => V.g.spawnProjectile(V.cfg.AMMO_BY_ID[id], x, y, vx, vy, false, {});

  /** penetrator behaviour on a thick lab bunker: where does it stop, what dies */
  V.penLab = (o) => {
    const S = window.siege;
    Math.random = mulberry(o.seed || 7);
    const W = o.wall;
    const blocks = [
      { x: 30, y: 0, w: W, h: 3.2, mat: o.mat || 'concrete' },
      { x: 30 + W, y: 0, w: 2.4, h: 1.4, mat: 'wood', target: 'command' },
      { x: 32.4 + W, y: 0, w: 1, h: 3.2, mat: o.mat || 'concrete' },
      { x: 30, y: 3.2, w: W + 3.4, h: 1, mat: o.mat || 'concrete' },
    ];
    const lvl = { id: 'lab', name: 'Lab', brief: '', intel: [], budget: 1, wind: [0, 0], parTime: 60, ground: [[-80, 0], [400, 0]], cannonX: 0,
      blocks: [...blocks, { x: 390, y: 0, w: 1, h: 1, mat: 'rock', target: 'command' }], houses: [], objectives: ['command'], stars: [1, 2, 3], collateralMult: 1 };
    S.level = lvl;
    const g = S.game;
    g.stats = Object.assign(V.prog.baseStats(), o.stats || {});
    g.load(lvl);
    const inv = {}; for (const a of V.cfg.SHOP_AMMO()) inv[a.id] = 99;
    V.hud.startBattle(inv, 0, 999999); S.mode = 'map'; g.wind = 0;
    V.g = g; V.live = {}; V.off();
    const a = V.cfg.AMMO_BY_ID[o.id];
    let blew = null;
    const ex = g.explode.bind(g);
    g.explode = (x, y, r, d, op) => { if (!blew) blew = { x, y }; return ex(x, y, r, d, op); };
    const sp = 30 * (a.speed || 1);
    g.spawnProjectile(a, 26, 1.0, sp, 0, false);
    V.step(3);
    g.explode = ex;
    const b = g.blocks;
    return { wallDead: b[0].dead, wallFrac: b[0].dead ? 1 : 1 - b[0].hp / b[0].maxHp, tgtDead: b[1].dead, tgtFrac: b[1].dead ? 1 : 1 - b[1].hp / b[1].maxHp, blewX: blew && +blew.x.toFixed(2), wallHp: Math.round(b[0].maxHp) };
  };
}

// ───────────────────────── runner ─────────────────────────
const SECTIONS = (process.argv[2] && process.argv[2] !== 'all' ? process.argv[2] : 'struct,niche,campaign,infantry,air,smoke,drone,pen').split(',');
const TRIALS = +(process.argv[3] || 3);
const BASE = process.env.BASE || 'http://127.0.0.1:5193';

const STRUCT_ROUNDS_ALL = ['shell', 'he', 'heavy', 'ap', 'incendiary', 'bunker', 'cluster', 'delayed', 'sticky', 'drill', 'saboteur', 'airstrike', 'canister', 'flak'];
const STRUCT_ROUNDS = process.env.ONLY ? process.env.ONLY.split(',') : STRUCT_ROUNDS_ALL;
const STRUCT_LEVELS_ALL = [
  ['millford', 'early timber stockade'],
  ['bastion', 'reactive-armour bastion'],
  ['redhill', 'mid stone castle (Kurogane)'],
  ['greywater', 'concrete/steel/earth battery'],
  ['kestrel', 'grand castle, hidden rooms'],
];
const STRUCT_LEVELS = process.env.LEVELS ? STRUCT_LEVELS_ALL.filter(([l]) => process.env.LEVELS.split(',').includes(l)) : STRUCT_LEVELS_ALL;

async function pool(n) {
  const browser = await chromium.launch();
  const pages = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.goto(BASE + '/?dev');
    await page.waitForFunction(() => window.siege && window.siege.game, null, { timeout: 120000 });
    await page.evaluate(`(${installValue.toString()})()`);
    await page.evaluate(() => window.__val.init());
    pages.push(page);
  }
  return { browser, pages };
}

async function runAll(pages, jobs) {
  const out = new Array(jobs.length);
  let next = 0, done = 0;
  await Promise.all(pages.map(async (page) => {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i];
      try { out[i] = { ...j, r: await page.evaluate(([fn, arg]) => window.__val[fn](arg), [j.fn, j.arg]) }; }
      catch (e) { out[i] = { ...j, r: null, err: String(e.message || e).split('\n')[0] }; console.log('ERR', j.fn, JSON.stringify(j.arg), out[i].err); }
      if (++done % 20 === 0) process.stderr.write(`  ${done}/${jobs.length}\n`);
    }
  }));
  return out;
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const f1 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

(async () => {
  const t0 = Date.now();
  const { browser, pages } = await pool(+(process.env.PAGES || 3));
  const cfg = await pages[0].evaluate(() => window.__val.cfg.SHOP_AMMO().map((a) => ({ id: a.id, price: a.price })));
  const price = Object.fromEntries(cfg.map((a) => [a.id, a.price]));
  const report = { price };
  console.log('prices:', JSON.stringify(price));

  if (SECTIONS.includes('struct')) {
    const jobs = [];
    const stop = process.env.PROTO !== 'spend';
    for (const [lv] of STRUCT_LEVELS) for (const id of STRUCT_ROUNDS) for (let s = 1; s <= TRIALS; s++) jobs.push({ fn: 'structTrial', arg: { level: lv, id, seed: s, budget: +(process.env.BUDGET || (stop ? 1400 : 520)), stop }, lv, id });
    const res = await runAll(pages, jobs);
    report.struct = {};
    for (const [lv, desc] of STRUCT_LEVELS) {
      console.log(process.env.PROTO === 'spend'
        ? `\n## Equal spend: ${lv} (${desc}), ${process.env.BUDGET || 520} cr per trial (keeps firing at the structure once the objectives are down), ${TRIALS} trials`
        : `\n## To the win: ${lv} (${desc}), up to ${process.env.BUDGET || 1400} cr per trial (stops when every objective is down), ${TRIALS} trials, aimed at the nearest live objective`);
      const rows = {};
      for (const id of STRUCT_ROUNDS) {
        const rs = res.filter((x) => x.lv === lv && x.id === id && x.r).map((x) => x.r);
        if (!rs.length) continue;
        const per = (k) => mean(rs.map((r) => (r[k] / Math.max(1, r.spent)) * 100));
        const row = {
          price: price[id], fired: mean(rs.map((r) => r.fired)), hp: per('hp'), obj: per('objFrac') * 100, kills: per('objKills') * 10, gar: per('garrison'), rooms: per('uncovered'),
          hit: mean(rs.map((r) => r.hitTarget / Math.max(1, r.fired))), won: rs.filter((r) => r.won).length,
          win: rs.filter((r) => r.won).length / rs.length, winCost: mean(rs.filter((r) => r.won).map((r) => r.spent)),
          notes: `won ${rs.filter((r) => r.won).length}/${rs.length}` + (rs.some((r) => r.won) ? ` (${Math.round(mean(rs.filter((r) => r.won).map((r) => r.spent)))} cr)` : '') + (id === 'bunker' ? ` embed ${mean(rs.map((r) => r.embed)).toFixed(1)}` : '') + (mean(rs.map((r) => r.ricochet)) ? ` ricochets ${mean(rs.map((r) => r.ricochet)).toFixed(1)}` : '') + (mean(rs.map((r) => r.fallback || 0)) ? ` out-of-reach ${mean(rs.map((r) => r.fallback || 0)).toFixed(1)}` : '') + (id === 'drill' ? ` burrowed ${mean(rs.map((r) => r.burrow)).toFixed(1)}/${mean(rs.map((r) => r.fired)).toFixed(1)}` : ''),
        };
        rows[id] = row;
      }
      // ratios to the better baseline (round shot or HE); "score" charges each round 3 pts per credit plus 1.6 s of reload at 60 pts/s
      const sc = (id, v) => (v * price[id] / 100) / (3 * price[id] + 96);
      const bObj = Math.max(rows.shell?.obj ?? 0, rows.he?.obj ?? 0), bHp = Math.max(rows.shell?.hp ?? 0, rows.he?.hp ?? 0);
      const bSc = Math.max(rows.shell ? sc('shell', rows.shell.obj) : 0, rows.he ? sc('he', rows.he.obj) : 0);
      console.log('| round | price | fired | HP removed /100cr | obj HP% /100cr | obj kills /1000cr | garrison /100cr | rooms opened /100cr | HP vs base | obj vs base | obj/score-cost vs base | hit 1st | notes |');
      console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const [id, row] of Object.entries(rows)) {
        row.hpVs = bHp ? row.hp / bHp : 0; row.objVs = bObj ? row.obj / bObj : 0; row.scVs = bSc ? sc(id, row.obj) / bSc : 0;
        console.log(`| ${id} | ${row.price} | ${row.fired.toFixed(1)} | ${f1(row.hp)} | ${f1(row.obj)} | ${f1(row.kills)} | ${f1(row.gar)} | ${f1(row.rooms)} | ${row.hpVs.toFixed(2)} | ${row.objVs.toFixed(2)} | ${row.scVs.toFixed(2)} | ${(row.hit * 100).toFixed(0)}% | ${row.notes} |`);
      }
      report.struct[lv] = rows;
    }
  }

  if (SECTIONS.includes('pen')) {
    console.log('\n## Penetrators on a lab casemate (wall W m thick, 3.2 m high, gun room behind), flat shot at 30 m/s × round speed');
    console.log('| round | wall | wall HP | wall destroyed | wall dmg | target inside | burst x (wall face at 30) |');
    console.log('|---|---|---|---|---|---|---|');
    const jobs = [];
    for (const id of ['he', 'ap', 'bunker', 'heavy']) for (const [mat, W] of [['concrete', 1], ['concrete', 2], ['concrete', 3], ['stone', 2], ['earth', 3]]) jobs.push({ fn: 'penLab', arg: { id, wall: W, mat, seed: 3 }, id, W, mat });
    const res = await runAll(pages, jobs);
    report.pen = res.map((x) => ({ id: x.id, mat: x.mat, W: x.W, ...x.r }));
    for (const x of res) if (x.r) console.log(`| ${x.id} | ${x.W} m ${x.mat} | ${x.r.wallHp} | ${x.r.wallDead} | ${(x.r.wallFrac * 100).toFixed(0)}% | ${x.r.tgtDead ? 'destroyed' : (x.r.tgtFrac * 100).toFixed(0) + '%'} | ${x.r.blewX} |`);
    const dj = [];
    for (const [lv] of STRUCT_LEVELS) for (let s = 1; s <= TRIALS; s++) dj.push({ fn: 'drillProbe', arg: { level: lv, seed: s }, lv });
    const dr = await runAll(pages, dj);
    console.log('\n## Drill shots on campaign levels (aimed at open ground just short of the objective)');
    console.log('| level | aim x | landed (burrowed) | blew at | objective x | objective destroyed |');
    console.log('|---|---|---|---|---|---|');
    report.drill = dr.map((x) => ({ lv: x.lv, ...x.r }));
    for (const x of dr) if (x.r) console.log(`| ${x.lv} | ${x.r.aimX.toFixed(1)} | ${x.r.burrowed ? x.r.land.toFixed(1) : 'no (hit a block)'} | ${x.r.blew ? x.r.blew.x.toFixed(1) + ',' + x.r.blew.y.toFixed(1) + ' r' + x.r.blew.r : '-'} | ${x.r.target.toFixed(1)} | ${!!x.r.killed} |`);
  }

  if (SECTIONS.includes('niche')) {
    const scenes = ['reactive', 'earth', 'casemate', 'timber', 'tower', 'topple', 'battery'];
    const ids = ['shell', 'he', 'heavy', 'ap', 'incendiary', 'bunker', 'cluster', 'delayed', 'sticky', 'drill', 'saboteur', 'airstrike'];
    const jobs = [];
    for (const scene of scenes) for (const id of ids) for (let s = 1; s <= TRIALS; s++) jobs.push({ fn: 'nicheLab', arg: { scene, id, seed: s }, scene, id });
    const res = await runAll(pages, jobs);
    report.niche = {};
    console.log('\n## Niche scenes (lab): credits to destroy the target, mean of trials (× = not destroyed in 8 rounds)');
    console.log('| round | price | ' + scenes.join(' | ') + ' |');
    console.log('|---|---|' + scenes.map(() => '---').join('|') + '|');
    for (const id of ids) {
      const cells = scenes.map((scene) => {
        const rs = res.filter((x) => x.scene === scene && x.id === id && x.r).map((x) => x.r);
        const ok = rs.filter((r) => r.killed);
        const c = ok.length ? mean(ok.map((r) => r.cost)) : NaN;
        (report.niche[scene] ??= {})[id] = { cost: c, ok: ok.length, n: rs.length };
        return ok.length ? `${Math.round(c)}${ok.length < rs.length ? ` (${ok.length}/${rs.length})` : ''}` : '×';
      });
      console.log(`| ${id} | ${price[id]} | ${cells.join(' | ')} |`);
    }
    const best = scenes.map((scene) => { const e = Object.entries(report.niche[scene]).filter(([, v]) => v.ok === v.n && v.n).sort((a, b) => a[1].cost - b[1].cost)[0]; return e ? `${scene}: ${e[0]}` : `${scene}: -`; });
    console.log('cheapest sure kill: ' + best.join(', '));
  }

  if (SECTIONS.includes('campaign')) {
    // can every operation still be won inside its own budget? one round type at a time, base research
    const nodes = await pages[0].evaluate(() => window.__val.camp.CAMPAIGN.map((n) => ({ id: n.id, budget: n.level().budget })));
    const ids = ['shell', 'he', 'ap', 'bunker', 'cluster', 'delayed'];
    const jobs = [];
    for (const n of nodes) for (const id of ids) jobs.push({ fn: 'structTrial', arg: { level: n.id, id, seed: 1, budget: n.budget, tail: 2 }, lv: n.id, id, budget: n.budget });
    const res = await runAll(pages, jobs);
    report.campaign = {};
    console.log('\n## Campaign: each operation fought with a single round type, inside its own budget (credits spent to win; × = not won)');
    console.log('| operation | budget | ' + ids.join(' | ') + ' | cheapest |');
    console.log('|---|---|' + ids.map(() => '---').join('|') + '|---|');
    for (const n of nodes) {
      const row = ids.map((id) => res.find((x) => x.lv === n.id && x.id === id)?.r);
      const cells = row.map((r) => (r && r.won ? String(r.spent) : '×'));
      const won = row.map((r, i) => [ids[i], r && r.won ? r.spent : Infinity]).sort((a, b) => a[1] - b[1])[0];
      report.campaign[n.id] = Object.fromEntries(row.map((r, i) => [ids[i], r && r.won ? r.spent : null]));
      console.log(`| ${n.id} | ${n.budget} | ${cells.join(' | ')} | ${won[1] < Infinity ? won[0] + ' ' + won[1] : 'NONE'} |`);
    }
  }

  if (SECTIONS.includes('infantry')) {
    const jobs = [];
    const lvls = [['redhill', 0, 'redhill (no shields)', 4], ['greywater', 0.25, 'greywater (25% shields)', 4], ['greywater', 0.55, 'greywater (55% shields, late campaign)', 4], ['greywater', 0.25, 'greywater, a crowd of 8 (25% shields)', 8]];
    for (const [lv, sh, key, n] of lvls) for (const id of ['canister', 'shell', 'he', 'cluster', 'flak', 'incendiary']) for (let s = 1; s <= TRIALS * 3; s++) jobs.push({ fn: 'infantryTrial', arg: { level: lv, id, seed: s, shields: sh, n }, lv: key, id });
    const res = await runAll(pages, jobs);
    report.infantry = {};
    console.log('\n## Infantry: a file of men (2.2 m apart) walking in; one aimed round; kills');
    console.log('| level | round | price | kills/round | kills per 100 cr |');
    console.log('|---|---|---|---|---|');
    for (const [, , lv] of lvls) {
      report.infantry[lv] = {};
      for (const id of ['canister', 'shell', 'he', 'cluster', 'flak', 'incendiary']) {
        const rs = res.filter((x) => x.lv === lv && x.id === id && x.r).map((x) => x.r);
        const k = mean(rs.map((r) => r.kills));
        report.infantry[lv][id] = { kills: k, per100: (k / price[id]) * 100 };
        console.log(`| ${lv} | ${id} | ${price[id]} | ${k.toFixed(2)} | ${((k / price[id]) * 100).toFixed(2)} |`);
      }
    }
  }

  if (SECTIONS.includes('air')) {
    const jobs = [];
    const ids = ['flak', 'he', 'shell', 'canister', 'cluster'];
    for (const kind of ['gyro', 'airship']) for (const id of ids) for (let s = 1; s <= TRIALS * 2; s++) jobs.push({ fn: 'airTrial', arg: { level: 'thronefall', kind, id, seed: s }, kind, id });
    const res = await runAll(pages, jobs);
    report.air = {};
    console.log('\n## Aircraft (Zoo Flak Tower mast): rounds until one aircraft is down (8 max, led aim, 0.6 m error)');
    console.log('| aircraft | round | price | downed | mean rounds | kills per 1000 cr |');
    console.log('|---|---|---|---|---|---|');
    for (const kind of ['gyro', 'airship']) {
      report.air[kind] = {};
      for (const id of ids) {
        const rs = res.filter((x) => x.kind === kind && x.id === id && x.r).map((x) => x.r);
        const downs = rs.filter((r) => r.down).length;
        const shots = rs.reduce((s, r) => s + r.shots, 0);
        const per = (downs / Math.max(1, shots * price[id])) * 1000;
        report.air[kind][id] = { downs, n: rs.length, shots: shots / rs.length, per1000: per };
        console.log(`| ${kind} | ${id} | ${price[id]} | ${downs}/${rs.length} | ${(shots / rs.length).toFixed(1)} | ${per.toFixed(2)} |`);
      }
    }
  }

  if (SECTIONS.includes('smoke')) {
    const jobs = [];
    for (const lv of ['bastion', 'greywater']) for (const smoke of [false, true]) for (let s = 1; s <= TRIALS; s++) jobs.push({ fn: 'smokeTrial', arg: { level: lv, smoke, seed: s }, lv, smoke });
    const res = await runAll(pages, jobs);
    report.smoke = {};
    console.log('\n## Smoke: 90 s under live counter-battery fire (no return fire)');
    console.log('| level | smoke | smoke rounds | enemy shots | gun damage |');
    console.log('|---|---|---|---|---|');
    for (const lv of ['bastion', 'greywater']) {
      report.smoke[lv] = {};
      for (const smoke of [false, true]) {
        const rs = res.filter((x) => x.lv === lv && x.smoke === smoke && x.r).map((x) => x.r);
        const row = { smokes: mean(rs.map((r) => r.smokes)), shots: mean(rs.map((r) => r.shots)), dmg: mean(rs.map((r) => r.dmg)) };
        report.smoke[lv][smoke ? 'smoke' : 'none'] = row;
        console.log(`| ${lv} | ${smoke} | ${row.smokes.toFixed(1)} | ${row.shots.toFixed(1)} | ${row.dmg.toFixed(1)} |`);
      }
    }
  }

  if (SECTIONS.includes('drone')) {
    const lvls = ['redhill', 'thronefall', 'kestrel', 'blackcitadel'];
    const jobs = [];
    for (const lv of lvls) {
      jobs.push({ fn: 'droneTrial', arg: { level: lv, seed: 1 }, lv, kind: 'drone' });
      for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const h of [8, 13, 18]) {
        jobs.push({ fn: 'droneTrial', arg: { level: lv, seed: 1, fx, h }, lv, kind: 'placed', fx, h });
        jobs.push({ fn: 'droneTrial', arg: { level: lv, seed: 1, fx, h, stats: { droneTime: 8, droneStealth: true } }, lv, kind: 'placed8', fx, h });
      }
      for (let k = 0; k < 6; k++) jobs.push({ fn: 'breachTrial', arg: { level: lv, seed: 1 + k, k: k * 3 + 1 }, lv, kind: 'breach' });
    }
    const res = await runAll(pages, jobs);
    report.drone = {};
    console.log('\n## Drone vs blasting: hidden rooms');
    console.log('| level | hidden rooms | hidden objective rooms | 1 drone, default loiter point | 1 drone, best loiter point (x frac, height) | objective rooms opened (best) | placements opening ≥1 room | HE rounds to breach one hidden room |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const lv of lvls) {
      const d = res.find((x) => x.lv === lv && x.kind === 'drone')?.r;
      const pl = res.filter((x) => x.lv === lv && x.kind === 'placed' && x.r);
      const best = pl.slice().sort((a, b) => b.r.found - a.r.found || b.r.objFound - a.r.objFound)[0];
      const useful = pl.filter((x) => x.r.found > 0).length;
      const meanFound = mean(pl.map((x) => x.r.found));
      const br = res.filter((x) => x.lv === lv && x.kind === 'breach' && x.r).map((x) => x.r);
      const rounds = mean(br.map((b) => b.rounds));
      report.drone[lv] = { d, best: best && { fx: best.fx, h: best.h, ...best.r }, meanFound, useful, n: pl.length, breach: rounds };
      if (d) console.log(`| ${lv} | ${d.hidden} | ${d.objHidden} | ${d.found} | ${best ? best.r.found + ' (' + best.fx + ', ' + best.h + ' m)' : '-'} | ${best ? best.r.objFound : '-'}/${d.objHidden} | ${useful}/${pl.length} (mean ${meanFound.toFixed(1)} rooms) | ${rounds.toFixed(2)} |`);
    }
  }

  if (process.env.VALUE_JSON) require('fs').writeFileSync(process.env.VALUE_JSON, JSON.stringify(report, null, 1));
  console.log(`\n(done in ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await browser.close();
})();
