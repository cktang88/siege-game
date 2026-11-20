/*
  Soak / fuzz harness for the battle simulation. For every level (campaign, themed, dev proving and grand
  castles, plus a few generated from random seeds) it starts a battle with every munition in the rack and
  runs a seeded random barrage (random rounds, elevations, charges, fuses, air strikes with random plans,
  drones, saboteurs, cluster and flak triggers, dev-spawned enemy units, raw rounds dropped anywhere)
  with the enemy left fully active. After every 1/60 s step it checks invariants and records violations:

    - page errors, console errors, WASM traps ("unreachable", "null pointer"), exceptions out of update()
    - NaN / Infinity in blocks, projectiles, soldiers, vehicles, aircraft, bombers, drones, saboteurs,
      dwellers, particles, debris and the camera; live objects far below the world or flung absurdly far
    - target bookkeeping: destroyed > total, total - destroyed != live target blocks
    - battles that never end (objectives down, or nothing left to fire and nothing moving)
    - garrison counts out of range; engineers patching a dead / rubble / moving / burning block
    - orphan meshes: children of the battle root that no live object accounts for
    - covers left on uncovered rooms; fires on dead blocks
    - frame-time spikes (> SPIKE ms per update), with what was going on
  Then a leak pass: load -> play -> load another (5 battles, three times round) and compare renderer.info.memory
  and scene sizes at the start of each battle.

    npx vite --port 5197 --host 127.0.0.1 --strictPort &      # then:
    BASE=http://127.0.0.1:5197 NODE_PATH=$(npm root -g) node scripts/soak.cjs [ids|all] [secs=100] [seeds=2]
    env: WORKERS=3 (parallel pages), GEN=3 (random generated castles), SPIKE=50, LEAK=1 (0 skips the leak pass)

  Exit code 1 if any hard violation was recorded.
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

// ───────────────────────── in-page harness ─────────────────────────
function installSoak() {
  const K = {};
  window.__soak = K;
  K.init = async () => {
    K.hud = await import('/src/hud.ts');
    K.cfg = await import('/src/config.ts');
    K.prog = await import('/src/progress.ts');
    K.camp = await import('/src/campaign.ts');
    K.levels = await import('/src/levels.ts');
    K.list = K.camp.devCastles().slice();
    for (const l of K.levels.LEVELS) if (!K.list.some((x) => x.id === l.id)) K.list.push(l);
    return K.list.map((l) => l.id);
  };
  K.addGenerated = (n, seed0) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const s = seed0 + i * 7919;
      const grand = i % 3 === 2;
      const th = ['timber', 'stone', 'concrete', 'mixed'][i % 4];
      const lvl = K.camp.generateCastle(grand ? 'grand' : 'fort', s, grand ? 5 + (i % 4) : 1 + (i % 5), th);
      K.list.push(lvl); ids.push(lvl.id);
    }
    return ids;
  };
  // seeded RNG for the barrage (the simulation itself keeps Math.random)
  const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  K.viol = [];
  K.violKeys = new Map();
  const V = (kind, msg) => {
    const key = kind + '|' + msg.slice(0, 80);
    const n = K.violKeys.get(key) || 0;
    K.violKeys.set(key, n + 1);
    if (n < 3) K.viol.push({ kind, msg, t: +(K.g ? K.g.battleTime : 0).toFixed(2) });
  };
  K.V = V;
  // capture console errors and uncaught errors raised in-page outside our try/catch
  if (!K.hooked) {
    K.hooked = true;
    const ce = console.error.bind(console);
    console.error = (...a) => { V('console', a.map(String).join(' ').slice(0, 300)); ce(...a); };
    window.addEventListener('error', (e) => V('pageerror', String(e.message)));
    window.addEventListener('unhandledrejection', (e) => V('pageerror', 'rejection: ' + String(e.reason)));
  }

  /** the expected number of children of the battle root: anything beyond it is an orphan mesh */
  // (10 fixed children: ground, barrel, carriage, preview dots, strike line, strike marks, bomb fall paths, ...)
  K.expectedChildren = (g) => {
    const live = g.blocks.filter((b) => !b.dead).length;
    const ga = g.garrison;
    const covers = ga.rooms.list.filter((r) => r.cover).length;
    return 10 + live + g.enemyGuns.size + g.mastSprites.size + g.backdrops.length + g.houses.length + ga.list.length + ga.rooms.ladders.length + covers
      + g.projectiles.filter((p) => !p.dead).length + g.soldiers.length + g.planes.length + g.drones.length + g.saboteurs.length
      + g.motor.units.length * 2 + g.air.units.length + g.incoming.length + (g.frac.fx ? g.frac.fx.length : 0) + (g.crew ? g.crew.rootChildren : 0) + (g.mg ? g.mg.rootChildren : 0);
  };

  K.start = (idx, seed, o) => {
    const S = window.siege;
    const lvl = K.list[idx];
    K.R = mulberry(seed * 2654435761 + idx * 97);
    K.viol = []; K.violKeys = new Map();
    S.level = lvl;
    const g = S.game;
    g.stats = Object.assign(K.prog.baseStats(), {
      saboteurs: 2, dive: true, bombTypes: ['he', 'incendiary', 'penetrator'], bombs: 4, droneStealth: K.R() < 0.5, ecm: K.R() < 0.5,
      maxSpeed: 34, clusterCount: 8, drillRange: 16,
    });
    g.load(lvl);
    const inv = {};
    // finite racks on odd seeds (the battle must end when they run dry), unlimited on even ones
    for (const a of K.cfg.SHOP_AMMO()) inv[a.id] = o.finite ? 1 + Math.floor(K.R() * 3) : 99;
    K.hud.startBattle(inv, 0, 999999, !o.finite);
    // the dev unlimited rack needs dev mode in the save; make sure finite racks really run out
    g.dev.unlimited = !o.finite;
    // unlimited racks soak the full time: the gun cannot be knocked out (finite racks play it straight)
    g.dev.god = !o.finite;
    S.mode = 'map'; // the page's own loop stops stepping the battle: the harness steps it
    K.g = g;
    K.o = o;
    K.nextAct = 0.5;
    K.stepN = 0;
    K.spikes = [];
    K.slow = 0;
    K.maxMs = 0;
    K.sumMs = 0;
    K.endedAt = -1;
    K.endReason = '';
    K.objDownAt = -1;
    K.idleSince = -1;
    K.blasts = 0;
    if (!g.__soakWrapped) {
      g.__soakWrapped = true;
      const ox = g.explode.bind(g);
      g.explode = (...a) => { K.blasts++; return ox(...a); };
      // per-part timing, reported with each spike
      K.T = {};
      const wrap = (obj, name, key) => { const o = obj[name].bind(obj); obj[name] = (...a) => { const t = performance.now(); try { return o(...a); } finally { K.T[key] = (K.T[key] || 0) + performance.now() - t; } }; };
      for (const n of ['updateBlocks', 'updateProjectiles', 'updatePending', 'updateSoldiers', 'updateAir', 'updateEnemy', 'syncMeshes']) wrap(g, n, n);
      wrap(g.frac, 'update', 'fracture'); wrap(g.garrison, 'update', 'garrison'); wrap(g.air, 'update', 'aircraft'); wrap(g.motor, 'update', 'vehicles');
    }
    // the physics world is new on every load
    { const w = g.world, o = w.step.bind(w); w.step = (...a) => { const t = performance.now(); o(...a); K.T.physics = (K.T.physics || 0) + performance.now() - t; }; }
    K.vehStuck = new Map();
    K.seen = { maxBlocks: 0, maxProj: 0, maxParts: 0, maxRoot: 0, maxLights: 0, maxRubble: 0 };
    return { id: lvl.id, blocks: g.blocks.length, rooms: g.garrison.rooms.list.length, hidden: g.garrison.rooms.concealed, objectives: lvl.objectives.join('+') };
  };

  /** one random player action */
  K.act = () => {
    const g = K.g, R = K.R;
    const pick = (a) => a[Math.floor(R() * a.length)];
    const r = R();
    const fb = g.fortressBounds;
    if (r < 0.06) {
      // a raw round dropped anywhere over the works (including the internal bombs), any velocity
      const ids = ['shell', 'heavy', 'ap', 'he', 'incendiary', 'bunker', 'cluster', 'delayed', 'sticky', 'drill', 'flak', 'smoke', 'bomb_he', 'bomb_inc', 'bomb_pen'];
      const a = K.cfg.AMMO_BY_ID[pick(ids)];
      const x = fb.x0 - 5 + R() * (fb.x1 - fb.x0 + 10);
      const y = g.groundY(x) + 1 + R() * 30;
      g.spawnProjectile(a, x, y, (R() - 0.5) * 60, (R() - 0.7) * 50, false, R() < 0.2 ? { bomblet: true } : {});
      return 'raw';
    }
    if (r < 0.1) {
      const k = pick(['infantry', 'shield', 'car', 'tank', 'gyro', 'airship']);
      g.devSpawn(k, 1 + Math.floor(R() * 4));
      return 'spawn:' + k;
    }
    if (r < 0.11) { g.devRevealRooms(); return 'reveal'; }
    if (r < 0.115) { g.devClearField(); return 'clear'; }
    // the machine-gun post: a burst (or a pause) at a random elevation; the trigger stays as set until the next MG action
    if (r < 0.13 && g.mg) { g.mg.active = true; g.mg.trigger = R() < 0.75; g.mg.setAngleDeg(-35 + R() * 105); if (R() < 0.1) g.mg.reload(); return 'mg'; }
    if (r < 0.15) { g.triggerAbility(); return 'ability'; }
    // fire something from the rack
    const have = Object.keys(g.inventory).filter((k) => (g.inventory[k] || 0) > 0);
    if (!have.length) return 'dry';
    g.selected = pick(have);
    const a = K.cfg.AMMO_BY_ID[g.selected];
    // half the shots go roughly at the works (a ballistic guess), half anywhere in the gun's arc
    if (R() < 0.5) {
      const tx = fb.x0 + R() * (fb.x1 - fb.x0), d = tx - g.muzzle.x;
      g.setAngleDeg(20 + R() * 40);
      g.setSpeed(Math.sqrt(Math.max(1, 9.81 * d / Math.sin(2 * g.angle))) * (0.85 + R() * 0.3));
    } else {
      g.setAngleDeg(g.stats.minAngle + R() * (g.stats.maxAngle - g.stats.minAngle));
      g.setSpeed(6 + R() * 40);
    }
    g.fuseSetting = pick([0, 0.1, 0.5, 2, 3, 6, NaN]);
    g.flakFuse = pick([0, 0.2, 1, 2.5, 4, NaN]);
    g.airburst = pick([0, 0, 0.3, 1, 2, 4]);
    g.strike = { x: fb.x0 - 20 + R() * (fb.x1 - fb.x0 + 40), dir: R() < 0.5 ? 1 : -1, alt: 3 + R() * 60, dive: R() * 85, spacing: R() * 6, ordnance: pick(['he', 'incendiary', 'penetrator']) };
    g.droneTarget = R() < 0.2 ? null : { x: fb.x0 - 10 + R() * (fb.x1 - fb.x0 + 20), y: g.groundY(fb.x0) + R() * 40 };
    g.sabTarget = R() < 0.4 ? null : fb.x0 - 5 + R() * (fb.x1 - fb.x0 + 10);
    if (R() < 0.7) g.reload = 0;
    const ok = g.fire(a.mode === 'airstrike' && R() < 0.5 ? { x: fb.x0 + R() * (fb.x1 - fb.x0), y: 0 } : undefined);
    return (ok ? 'fire:' : 'nofire:') + a.id;
  };

  const vecOk = (v) => v && fin(v.x) && fin(v.y);
  /** cheap per-step checks */
  K.check = () => {
    const g = K.g;
    const minG = Math.min(...g.groundPts.map((p) => p[1]));
    const cx = g.level.cannonX;
    for (const b of g.blocks) {
      if (b.dead) continue;
      const t = b.body.translation(), v = b.body.linvel();
      if (!vecOk(t) || !vecOk(v) || !fin(b.body.rotation())) V('nan', `block ${b.id} ${b.matId} pos ${t.x},${t.y} vel ${v.x},${v.y}`);
      else if (t.y < minG - 22 || Math.abs(t.x - cx) > 700) V('far', `block ${b.id} ${b.matId} live at ${t.x.toFixed(1)},${t.y.toFixed(1)}`);
      if (!fin(b.hp) || !fin(b.burning) || !fin(b.maxHp) || b.maxHp <= 0) V('nan', `block ${b.id} hp ${b.hp}/${b.maxHp} burning ${b.burning}`);
    }
    for (const p of g.projectiles) {
      if (p.dead) continue;
      if (!fin(p.x) || !fin(p.y) || !fin(p.vx) || !fin(p.vy)) V('nan', `projectile ${p.ammo.id} ${p.x},${p.y} v ${p.vx},${p.vy}`);
      if (p.body) { const t = p.body.translation(); if (!vecOk(t)) V('nan', `projectile body ${p.ammo.id}`); }
      if (p.stuck && p.stuck.block && p.stuck.block.dead && !p.dead) {
        // tolerated for one frame (updateProjectiles re-anchors), flagged after
        p.__deadHost = (p.__deadHost || 0) + 1;
        if (p.__deadHost > 2) V('dead', `projectile ${p.ammo.id} stuck to dead block for ${p.__deadHost} steps`);
      }
    }
    for (const s of g.soldiers) if (!fin(s.x) || !fin(s.y)) V('nan', `soldier ${s.x},${s.y}`);
    for (const u of g.motor.units) if (!fin(u.x) || !fin(u.y) || !fin(u.rot) || !fin(u.hp)) V('nan', `vehicle ${u.kind} ${u.x},${u.y} hp ${u.hp}`);
    for (const u of g.air.units) {
      if (!fin(u.x) || !fin(u.y) || !fin(u.vx) || !fin(u.vy)) V('nan', `aircraft ${u.kind} ${u.x},${u.y}`);
      else if (Math.abs(u.x - cx) > 900 || u.y > 400 || u.y < minG - 50) V('far', `aircraft ${u.kind} at ${u.x.toFixed(0)},${u.y.toFixed(0)} down=${u.down}`);
    }
    for (const p of g.planes) if (!fin(p.x) || !fin(p.y)) V('nan', `bomber ${p.x},${p.y}`);
    for (const d of g.drones) if (!fin(d.x) || !fin(d.y)) V('nan', `drone ${d.x},${d.y}`);
    for (const s of g.saboteurs) if (!fin(s.x) || !fin(s.y)) V('nan', `saboteur ${s.x},${s.y}`);
    for (const d of g.garrison.list) {
      if (!fin(d.x) || !fin(d.y)) V('nan', `dweller ${d.state} ${d.x},${d.y}`);
      else if (d.y < minG - 22) V('far', `dweller ${d.person ? 'person' : 'prop'} ${d.state} fell to ${d.y.toFixed(1)}`);
    }
    for (const e of g.embers) if (!fin(e.x) || !fin(e.y)) V('nan', `ember ${e.x},${e.y}`);
    for (const e of g.pending) if (!fin(e.x) || !fin(e.y) || !fin(e.r)) V('nan', `pending blast ${e.x},${e.y},${e.r}`);
    const r = g.r;
    if (!fin(r.cx) || !fin(r.cy) || !fin(r.viewH) || r.viewH <= 0) V('nan', `camera ${r.cx},${r.cy},${r.viewH}`);
    if (!fin(g.cannonHp) || !fin(g.collateral)) V('nan', `cannonHp ${g.cannonHp} collateral ${g.collateral}`);
    // engineers only patch whole, still, unburnt, non-objective blocks
    // (only while the enemy is active: after the battle ends the crew's last job is simply left as it was)
    const rp = g.running && !g.ended ? g.repairing : null;
    if (rp) {
      if (rp.dead) V('engineer', `repairing dead block ${rp.id}`);
      else if (g.frac.isRubble(rp)) V('engineer', `repairing rubble ${rp.id}`);
      else if (rp.burning > 0) V('engineer', `repairing burning block ${rp.id}`);
      else if (rp.target) V('engineer', `repairing objective ${rp.id}`);
      else { const v = rp.body.linvel(); if (Math.hypot(v.x, v.y) > 0.5) V('engineer', `repairing moving block ${rp.id} v=${Math.hypot(v.x, v.y).toFixed(2)}`); }
    }
  };

  /** heavier checks, a few times a second */
  K.checkSlow = () => {
    const g = K.g;
    // targets
    const live = {};
    for (const b of g.blocks) if (!b.dead && b.target) live[b.target] = (live[b.target] || 0) + 1;
    for (const k of Object.keys(g.targetsTotal)) {
      const tot = g.targetsTotal[k] || 0, des = g.targetsDestroyed[k] || 0;
      if (des > tot) V('targets', `${k} destroyed ${des} > total ${tot}`);
      if (tot - des !== (live[k] || 0)) V('targets', `${k}: total ${tot} - destroyed ${des} != live ${live[k] || 0}`);
    }
    for (const k of Object.keys(live)) if (!(k in g.targetsTotal)) V('targets', `live ${k} not in targetsTotal`);
    // garrison
    const ga = g.garrison;
    if (ga.casualties < 0 || ga.casualties > ga.total || ga.fled < 0 || ga.casualties + ga.fled > ga.total) V('garrison', `casualties ${ga.casualties} fled ${ga.fled} total ${ga.total}`);
    for (const rm of ga.rooms.list) {
      if (rm.pop < 0) V('garrison', `room ${rm.i} pop ${rm.pop} < 0`);
      if (rm.dead > rm.spawnPop) V('garrison', `room ${rm.i} dead ${rm.dead} > spawnPop ${rm.spawnPop}`);
      if (!rm.hidden && rm.cover && rm.cover.fade <= 0) V('cover', `room ${rm.i} cover faded but kept`);
      if (rm.hidden && rm.target && rm.target.dead) { /* fine: a dead objective in a walled room */ }
    }
    const people = ga.list.filter((d) => d.person && d.state !== 'dead' && d.state !== 'fled').length;
    if (people > ga.total) V('garrison', `${people} people alive > total ${ga.total}`);
    // home people should be counted by a room pop (pop counts people heading in via ladder too)
    const popSum = ga.rooms.list.reduce((s, rm) => s + rm.pop, 0);
    const homeIn = ga.list.filter((d) => d.person && d.state === 'home' && (d.room || d.climb)).length
      + ga.list.filter((d) => d.person && d.state === 'home' && d.room && d.next === 'ladder' && d.ladder && !d.climb).length;
    if (popSum !== homeIn) {
      g.__popOff = (g.__popOff || 0) + 1;
      if (g.__popOff > 3) V('garrison', `room pops sum ${popSum} != people living in rooms ${homeIn}`);
    } else g.__popOff = 0;
    // orphan meshes
    const exp = K.expectedChildren(g), got = g.root.children.length;
    if (got !== exp) V('orphan', `battle root has ${got} children, live objects account for ${exp}`);
    // particles
    for (const [n, pool] of [['smoke', g.r.smoke], ['fire', g.r.fire], ['flame', g.r.flame]]) {
      for (const p of pool.parts) if (!fin(p.x) || !fin(p.y) || !fin(p.vx) || !fin(p.vy)) { V('nan', `${n} particle ${p.x},${p.y}`); break; }
      if (pool.parts.length > pool.limit) V('count', `${n} pool ${pool.parts.length} > limit ${pool.limit}`);
    }
    for (const c of g.r.debris.chunks) if (!fin(c.x) || !fin(c.y)) { V('nan', `debris ${c.x},${c.y}`); break; }
    if (g.r.lights.lights.length > 400) V('count', `${g.r.lights.lights.length} lights alive`);
    if (g.embers.length > 60) V('count', `${g.embers.length} embers`);
    // a stuck vehicle: alive, short of its halt point, not moving for 40 s
    for (const u of g.motor.units) {
      if (u.wreckT >= 0) continue;
      const s = K.vehStuck.get(u) || { x: u.x, t: g.battleTime };
      if (Math.abs(s.x - u.x) > 0.3) { s.x = u.x; s.t = g.battleTime; }
      K.vehStuck.set(u, s);
      if (u.x > u.stopX + 1 && g.battleTime - s.t > 40 && !s.told) {
        s.told = true;
        // what holds it: a vehicle or wreck ahead, or a block in its path
        const ahead = g.motor.units.filter((o) => o !== u && o.x < u.x && u.x - o.x - (u.len + o.len) / 2 < 1.2).map((o) => `${o.kind}${o.wreckT >= 0 ? ' wreck ' + o.wreckT.toFixed(0) + 's' : ''}`);
        const blk = g.blocks.filter((b) => !b.dead && Math.abs(b.body.translation().x - (u.x - u.len / 2 - 0.35)) < b.w / 2 + 0.4 && b.body.translation().y - b.h / 2 < u.y + 1.5).map((b) => `${b.matId}${b.frag ? ' frag' : ''}${g.frac.isRubble(b) ? ' rubble' : ''} ${b.w.toFixed(1)}x${b.h.toFixed(1)}`);
        // queueing behind a halted vehicle, or held by masonry in the road, is by design (it still fires from there)
        if (!ahead.length && !blk.length) V('stuck', `${u.kind} halted at ${u.x.toFixed(1)} short of ${u.stopX.toFixed(1)} for 40 s; ahead: ${ahead.join(',') || '-'}; blocks: ${blk.join(',') || '-'}`);
      }
    }
    const sn = K.seen;
    sn.maxBlocks = Math.max(sn.maxBlocks, g.blocks.filter((b) => !b.dead).length);
    sn.maxProj = Math.max(sn.maxProj, g.projectiles.length);
    sn.maxParts = Math.max(sn.maxParts, g.r.smoke.parts.length + g.r.fire.parts.length + g.r.flame.parts.length);
    sn.maxRoot = Math.max(sn.maxRoot, g.root.children.length);
    sn.maxLights = Math.max(sn.maxLights, g.r.lights.lights.length);
    sn.allBlocks = g.blocks.length;
  };

  /** the end conditions */
  K.checkEnd = () => {
    const g = K.g;
    if (g.ended) { if (K.endedAt < 0) K.endedAt = g.battleTime; return; }
    const obj = g.level.objectives;
    const down = obj.every((k) => (g.targetsDestroyed[k] || 0) >= (g.targetsTotal[k] || 0));
    if (down) { if (K.objDownAt < 0) K.objDownAt = g.battleTime; if (g.battleTime - K.objDownAt > 4) V('end', `objectives down ${(g.battleTime - K.objDownAt).toFixed(1)} s ago, battle not ended`); }
    const ammo = Object.values(g.inventory).reduce((s, n) => s + (n || 0), 0);
    if (ammo === 0 && !g.projectiles.some((p) => !p.enemy) && !g.planes.length && !g.saboteurs.length && !g.drones.length && !g.pending.length) {
      if (K.idleSince < 0) K.idleSince = g.battleTime;
      if (g.battleTime - K.idleSince > 90) V('end', `out of ammo and idle for ${(g.battleTime - K.idleSince).toFixed(0)} s, battle not ended (burning ${g.blocks.filter((b) => !b.dead && b.burning > 0).length}, awake ${g.blocks.filter((b) => !b.dead && !b.body.isSleeping()).length})`);
    } else K.idleSince = -1;
  };

  /** step `secs` of battle: random actions, invariant checks, timing */
  K.run = (secs, opts = {}) => {
    const g = K.g, r = g.r;
    const n = Math.round(secs * 60);
    const quiet = !!opts.quiet;
    for (let i = 0; i < n; i++) {
      if (!quiet && !g.ended) {
        K.nextAct -= 1 / 60;
        if (K.nextAct <= 0) {
          K.nextAct = 0.3 + K.R() * 2.2;
          try { K.lastAct = K.act(); } catch (e) { V('exception', `act ${K.lastAct}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
        }
      }
      const b0 = K.blasts, s0 = g.frac.stats.splits + g.frac.stats.pieces;
      for (const k in K.T) K.T[k] = 0;
      const t0 = performance.now();
      try { g.update(1 / 60); } catch (e) {
        V('exception', `update: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
        return { crashed: true };
      }
      const ms = performance.now() - t0;
      K.sumMs += ms; K.stepN++;
      K.maxMs = Math.max(K.maxMs, ms);
      if (ms > (opts.spike || 50)) {
        K.slow++;
        if (K.spikes.length < 8 || ms > Math.min(...K.spikes.map((s) => s.ms))) {
          K.spikes.push({ ms: +ms.toFixed(1), t: +g.battleTime.toFixed(2), blasts: K.blasts - b0, split: g.frac.stats.splits + g.frac.stats.pieces - s0, live: g.blocks.filter((b) => !b.dead).length, proj: g.projectiles.length, act: K.lastAct, burning: g.blocks.filter((b) => !b.dead && b.burning > 0).length,
            parts: Object.entries(K.T).filter(([, v]) => v > 3).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') });
          K.spikes.sort((a, b) => b.ms - a.ms); K.spikes.length = Math.min(8, K.spikes.length);
        }
      }
      for (const ev of g.events) if (ev.type === 'end') K.endReason = (ev.win ? 'won: ' : 'lost: ') + ev.reason;
      g.events.length = 0;
      try { r.tickFx(1 / 60, g.time); g.frameCamera(false, 1 / 60); K.check(); if (i % 20 === 0) K.checkSlow(); K.checkEnd(); } catch (e) { V('exception', `check: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
    }
    // draw a frame so new geometry is uploaded (renderer.info.memory counts what the GPU holds)
    try { r.render(0, g.time); } catch (e) { V('exception', `render: ${e && e.message}`); }
    return K.status();
  };

  K.status = () => {
    const g = K.g, mem = g.r.renderer.info.memory;
    return {
      t: +g.battleTime.toFixed(1), ended: g.ended, endedAt: K.endedAt, endReason: K.endReason, live: g.blocks.filter((b) => !b.dead).length, all: g.blocks.length,
      proj: g.projectiles.length, soldiers: g.soldiers.length, veh: g.motor.units.length, air: g.air.units.length, root: g.root.children.length,
      geo: mem.geometries, tex: mem.textures, parts: g.r.smoke.parts.length + g.r.fire.parts.length + g.r.flame.parts.length, lights: g.r.lights.lights.length,
      ammo: Object.values(g.inventory).reduce((s, n) => s + (n || 0), 0), cannon: +g.cannonHp.toFixed(0),
      destroyed: Object.values(g.targetsDestroyed).reduce((s, n) => s + n, 0), totalT: Object.values(g.targetsTotal).reduce((s, n) => s + n, 0),
      splits: g.frac.stats.splits, maxMs: +K.maxMs.toFixed(1), avgMs: +(K.sumMs / Math.max(1, K.stepN)).toFixed(2), slow: K.slow, spikes: K.spikes,
      viol: K.viol, violCounts: [...K.violKeys.entries()].map(([k, n]) => [k, n]), seen: K.seen,
    };
  };

  /** memory and scene size after loading a level and rendering once */
  K.memAfterLoad = (idx) => {
    const S = window.siege, g = S.game;
    const lvl = K.list[idx];
    S.level = lvl; g.load(lvl);
    const inv = {}; for (const a of K.cfg.SHOP_AMMO()) inv[a.id] = 99;
    K.hud.startBattle(inv, 0, 999999, true);
    S.mode = 'map';
    g.r.render(0, g.time);
    const m = g.r.renderer.info.memory;
    let sceneObjs = 0; g.r.scene.traverse(() => { sceneObjs++; });
    return { id: lvl.id, geo: m.geometries, tex: m.textures, progs: (g.r.renderer.info.programs || []).length, scene: sceneObjs, sceneKids: g.r.scene.children.length, worldKids: g.r.world.children.length, parts: g.r.smoke.parts.length + g.r.fire.parts.length + g.r.flame.parts.length, debris: g.r.debris.chunks.length, lights: g.r.lights.lights.length };
  };
}

// ───────────────────────── runner ─────────────────────────
module.exports = { installSoak };
if (require.main === module) (async () => {
  const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
  const secs = +(process.argv[3] || 100);
  const seeds = +(process.argv[4] || 2);
  const WORKERS = +(process.env.WORKERS || 3);
  const GEN = +(process.env.GEN || 3);
  const SPIKE = +(process.env.SPIKE || 50);
  const LEAK = process.env.LEAK !== '0';
  const BASE = process.env.BASE || 'http://127.0.0.1:5197';
  const genSeed = +(process.env.GENSEED || 4242);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.errs = [];
    page.on('pageerror', (e) => page.errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') page.errs.push('console: ' + m.text()); });
    await page.goto(BASE + '/?dev');
    await page.waitForFunction(() => window.siege && window.siege.game, null, { timeout: 120000 });
    await page.evaluate(`(${installSoak.toString()})()`);
    const ids = await page.evaluate(() => window.__soak.init());
    const gen = GEN ? await page.evaluate(([n, s]) => window.__soak.addGenerated(n, s), [GEN, genSeed]) : [];
    return { page, ids: ids.concat(gen) };
  };
  const first = await newPage();
  const ids = first.ids;
  const jobs = [];
  ids.forEach((id, idx) => { if (!only || only.includes(id)) for (let s = 0; s < seeds; s++) jobs.push({ id, idx, seed: s + 1 }); });
  console.log(`soak: ${jobs.length} runs (${new Set(jobs.map((j) => j.id)).size} levels x ${seeds} seeds x ${secs} s), ${WORKERS} workers`);
  const results = [];
  const pages = [first.page];
  for (let w = 1; w < WORKERS; w++) pages.push((await newPage()).page);
  let next = 0;
  const t0 = Date.now();
  const worker = async (page) => {
    while (next < jobs.length) {
      const j = jobs[next++];
      page.errs = [];
      const info = await page.evaluate(([idx, seed]) => window.__soak.start(idx, seed, { finite: seed % 2 === 1 }), [j.idx, j.seed]);
      let st = null;
      let crashed = false;
      for (let t = 0; t < secs; t += 5) {
        try { st = await page.evaluate(([n, spike]) => window.__soak.run(n, { spike }), [Math.min(5, secs - t), SPIKE]); } catch (e) { crashed = true; st = { viol: [{ kind: 'harness', msg: String(e.message).slice(0, 300) }], violCounts: [] }; break; }
        if (st.crashed) { crashed = true; st = await page.evaluate(() => window.__soak.status()); break; }
      }
      const errs = page.errs.filter((e) => !/favicon|404/.test(e));
      const viol = (st.viol || []).concat(errs.map((e) => ({ kind: 'pageerror', msg: e.slice(0, 300) })));
      const r = { ...j, info, st, viol, crashed };
      results.push(r);
      const vc = (st.violCounts || []).reduce((s, [, n]) => s + n, 0) + errs.length;
      console.log(`${String(results.length).padStart(3)}/${jobs.length} ${j.id.padEnd(16)} s${j.seed} ${crashed ? 'CRASH ' : ''}t=${st.t} ended=${st.ended}${st.ended ? '@' + st.endedAt.toFixed(0) + ' (' + st.endReason + ')' : ''} live=${st.live}/${st.all} obj=${st.destroyed}/${st.totalT} splits=${st.splits} avg=${st.avgMs}ms max=${st.maxMs}ms slow=${st.slow} geo=${st.geo} root=${st.root} viol=${vc}  [${((Date.now() - t0) / 60000).toFixed(1)} min]`);
      for (const v of viol.slice(0, 6)) console.log(`      ${v.kind}: ${v.msg}${v.t !== undefined ? ' @' + v.t : ''}`);
    }
  };
  await Promise.all(pages.map(worker));

  // ── leak pass: load -> play -> load another, 5 battles, twice round; memory at the start of each ──
  let leak = null;
  if (LEAK) {
    const page = first.page;
    const pickIdx = ['outpost', 'kestrel', 'devgrand0', 'citadel', 'blackcitadel'].map((id) => ids.indexOf(id)).filter((i) => i >= 0);
    while (pickIdx.length < 5) pickIdx.push(pickIdx.length);
    const rows = [];
    for (let round = 0; round < 3; round++) {
      for (const idx of pickIdx) {
        const m = await page.evaluate((i) => window.__soak.memAfterLoad(i), idx);
        rows.push({ round, ...m });
        await page.evaluate((i) => window.__soak.start(i, 9, { finite: false }), idx);
        for (let k = 0; k < 4; k++) await page.evaluate(() => window.__soak.run(5, {}));
      }
    }
    // round 1 warms the caches (shared shell looks, canvas textures made on first use): compare rounds 2 and 3
    const first5 = rows.slice(5, 10), second5 = rows.slice(10);
    leak = rows;
    console.log('\nleak pass (memory just after each load, after the previous battle was played 20 s; rounds 2 and 3 must match):');
    console.log('| round | level | geometries | textures | programs | scene objects | scene children | world children |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.round + 1} | ${r.id} | ${r.geo} | ${r.tex} | ${r.progs} | ${r.scene} | ${r.sceneKids} | ${r.worldKids} |`);
    // geometries are counted once drawn, so what is in frame varies a little: allow 3% + 8
    const grew = second5.filter((r, i) => r.geo > first5[i].geo * 1.03 + 8 || r.tex > first5[i].tex || r.scene > first5[i].scene || r.worldKids > first5[i].worldKids);
    if (grew.length) console.log(`LEAK: ${grew.length}/5 levels hold more on the second load: ${grew.map((r, i) => `${r.id} geo ${first5[second5.indexOf(r)].geo}->${r.geo} tex ${first5[second5.indexOf(r)].tex}->${r.tex} scene ${first5[second5.indexOf(r)].scene}->${r.scene}`).join('; ')}`);
    else console.log('no growth between rounds');
    leak.grew = grew.length;
  }

  // ── summary ──
  const hard = results.filter((r) => r.crashed || r.viol.some((v) => v.kind !== 'stuck'));
  const byKind = {};
  for (const r of results) for (const [k, n] of r.st.violCounts || []) { const kind = k.split('|')[0]; byKind[kind] = (byKind[kind] || 0) + n; }
  for (const r of results) for (const v of r.viol) if (v.kind === 'pageerror') byKind.pageerror = (byKind.pageerror || 0) + 1;
  const worst = results.flatMap((r) => (r.st.spikes || []).map((s) => ({ ...s, id: r.id, seed: r.seed }))).sort((a, b) => b.ms - a.ms).slice(0, 10);
  const simTime = results.reduce((s, r) => s + (r.st.t || 0), 0);
  console.log(`\n=== soak summary: ${results.length} runs, ${simTime.toFixed(0)} simulated s, ${((Date.now() - t0) / 60000).toFixed(1)} min wall ===`);
  console.log(`runs with violations: ${hard.length}; by kind: ${JSON.stringify(byKind)}`);
  console.log(`battles ended: ${results.filter((r) => r.st.ended).length}/${results.length} (finite racks: ${results.filter((r) => r.seed % 2 === 1 && r.st.ended).length}/${results.filter((r) => r.seed % 2 === 1).length})`);
  console.log(`update ms: mean of means ${(results.reduce((s, r) => s + (r.st.avgMs || 0), 0) / Math.max(1, results.length)).toFixed(2)}, max ${Math.max(...results.map((r) => r.st.maxMs || 0))}, steps > ${SPIKE} ms: ${results.reduce((s, r) => s + (r.st.slow || 0), 0)}`);
  console.log('worst steps:');
  for (const w of worst) console.log(`  ${w.ms} ms  ${w.id} s${w.seed} t=${w.t} blasts=${w.blasts} splitPieces=${w.split} live=${w.live} proj=${w.proj} burning=${w.burning} lastAct=${w.act} [${w.parts}]`);
  await browser.close();
  process.exitCode = hard.length || (leak && leak.grew) ? 1 : 0;
})();
