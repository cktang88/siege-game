/*
  Munition lab: for every round in src/config.ts AMMO (and the counters the README and the round
  descriptions claim), builds a minimal scenario, fires the round, steps the simulation in-page and
  checks the claim with numbers. Prints a PASS/FAIL table; exit code 1 if anything hard-fails.

    npx vite --port 5188 --host 127.0.0.1 --strictPort &      # then:
    BASE=http://127.0.0.1:5188 node scripts/munition-lab.cjs [test-or-munition ids, comma separated]
    (if playwright is not a local dependency: NODE_PATH=$(npm root -g) node scripts/munition-lab.cjs)

  Lab scenarios sit at x >= 20 on flat ground (the gun's redoubt spans cannonX-15 .. cannonX+12).
  Tests marked "soft" are reported but do not fail the run (tuning owned elsewhere).
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

// ───────────────────────── in-page helpers ─────────────────────────
function installLab() {
  const L = {};
  window.__lab = L;
  L.init = async () => {
    L.hud = await import('/src/hud.ts');
    L.cfg = await import('/src/config.ts');
    L.prog = await import('/src/progress.ts');
    L.shapes = await import('/src/shapes.ts');
  };
  /** load a lab level with these blocks; o.stats overrides research, o.live keeps the enemy timers running */
  L.setup = (blocks, o = {}) => {
    const S = window.siege;
    const lvl = {
      id: 'lab', name: 'Lab', brief: '', intel: [], budget: 1, wind: [0, 0], parTime: 60, ground: [[-80, 0], [400, 0]], cannonX: 0,
      // an indestructible objective far away keeps the battle from ending
      blocks: [...blocks, { x: 390, y: 0, w: 1, h: 1, mat: 'rock', target: 'command' }],
      houses: o.houses || [], objectives: ['command'], stars: [1, 2, 3], collateralMult: 1,
    };
    S.level = lvl;
    S.game.stats = Object.assign(L.prog.baseStats(), o.stats || {});
    S.game.load(lvl);
    const inv = {};
    for (const a of L.cfg.SHOP_AMMO()) inv[a.id] = 99;
    L.hud.startBattle(inv, 0, 999999);
    L.hud.dismissBriefing(true);
    S.mode = 'map'; // the page's own frame loop stops stepping the battle: the lab steps it
    const g = S.game;
    g.wind = 0;
    g.reload = 0;
    L.g = g;
    L.live = !!o.live;
    L.off();
    // per-block damage ledger (includes overkill)
    L.dmg = new Map();
    if (!g.__labWrapped) {
      g.__labWrapped = true;
      const orig = g.damageBlock.bind(g);
      g.damageBlock = (b, d, c) => { if (!b.dead && d > 0 && !b.mat.indestructible) L.dmg.set(b, (L.dmg.get(b) || 0) + d); return orig(b, d, c); };
      const ox = g.explode.bind(g);
      g.explode = (x, y, r, d, opts) => { L.blasts.push({ x, y, r, d, src: opts && opts.source, t: g.time }); return ox(x, y, r, d, opts); };
    }
    L.blasts = [];
    return g;
  };
  L.off = () => { const g = L.g; if (!L.live) { g.artT = g.barT = g.repT = g.rebT = 999; } g.air.spawnT = 999; };
  /** step the simulation; each(i) may return true to stop early */
  L.step = (secs, each) => {
    const g = L.g;
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) { L.off(); g.reload = 0; g.update(1 / 60); if (each && each(i)) return i; }
    return n;
  };
  L.b = (i) => L.g.blocks[i];
  L.dealt = (i) => L.dmg.get(L.g.blocks[i]) || 0;
  /** damage as a share of the block's max HP */
  L.frac = (i) => +(L.dealt(i) / L.g.blocks[i].maxHp).toFixed(3);
  L.pos = (i) => { const b = L.g.blocks[i]; if (b.dead) return null; const t = b.body.translation(); return { x: t.x, y: t.y, rot: b.body.rotation() }; };
  L.shoot = (id, x, y, vx, vy, extra) => L.g.spawnProjectile(L.cfg.AMMO_BY_ID[id], x, y, vx, vy, false, extra || {});
  L.live = false;
  L.r = (v, n = 2) => +(+v).toFixed(n);
  /** elevation (rad) that puts a round of speed s from the muzzle through (tx, ty) on the flatter arc */
  L.aim = (s, tx, ty) => {
    const g = L.g;
    let best = 0, err = 1e9;
    for (let d = -30; d <= 80; d += 0.05) {
      const a = (d * Math.PI) / 180;
      const bx = g.barrel.position.x, by = g.barrel.position.y;
      const mx = bx + Math.cos(a) * 2.5, my = by + Math.sin(a) * 2.5;
      const vx = Math.cos(a) * s; if (vx <= 0) continue;
      const t = (tx - mx) / vx; if (t <= 0) continue;
      const y = my + Math.sin(a) * s * t - 4.905 * t * t;
      if (Math.abs(y - ty) < err) { err = Math.abs(y - ty); best = a; }
      if (err < 0.02) break;
    }
    return best;
  };
  /** the machine-gun post: hold the trigger for `secs`, re-aiming at aim() each tick (stop(i) may end it early); returns rounds fired */
  L.mgFire = (secs, aim, stop) => {
    const m = L.g.mg; m.active = true; m.trigger = true;
    const f0 = m.fired;
    L.step(secs, (i) => { const p = aim(); if (p) m.aimAt(p.x, p.y); return stop ? stop(i) : false; });
    m.trigger = false;
    return m.fired - f0;
  };
}

// ───────────────────────── tests ─────────────────────────
// each runs in the page with L = window.__lab; returns { pass, info }
const T = [];
const test = (id, ammo, claim, fn, soft = false) => T.push({ id, ammo, claim, fn: fn.toString(), soft });

test('shell_knock', 'shell', 'Round shot knocks a loose timber stack apart', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1, h: 1, mat: 'wood' }, { x: 30, y: 1, w: 1, h: 1, mat: 'wood' }, { x: 30, y: 2, w: 1, h: 1, mat: 'wood' }]);
  const p0 = L.pos(2);
  L.shoot('shell', 26, 2.5, 30, 0);
  L.step(3);
  const p = L.pos(2);
  const moved = p ? Math.hypot(p.x - p0.x, p.y - p0.y) : 99;
  return { pass: moved > 0.8, info: `top block moved ${L.r(moved)} m${p ? '' : ' (destroyed)'}, dmg ${L.r(L.dealt(2), 0)}` };
});

test('shell_armor', 'shell', 'Round shot is poor against armor (steel takes far less than timber)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1, h: 1, mat: 'wood' }]);
  L.shoot('shell', 26, 0.5, 30, 0); L.step(1);
  const wood = L.frac(0);
  L.setup([{ x: 30, y: 0, w: 1, h: 1, mat: 'steel' }]);
  L.shoot('shell', 26, 0.5, 30, 0); L.step(1);
  const steel = L.frac(0);
  return { pass: wood > 0.6 && steel < wood / 4, info: `timber ${L.r(wood * 100, 0)}% hp, steel ${L.r(steel * 100, 0)}% hp` };
});

test('shell_file', 'shell', 'Solid shot ploughs through a file of infantry', () => {
  const L = window.__lab; const g = L.setup([]);
  for (const x of [26, 27.2, 28.4, 29.6]) g.spawnSoldier(x);
  L.shoot('shell', 22, 0.8, 30, 0.5);
  L.step(1);
  const k = g.soldiers.filter((s) => s.dead).length;
  return { pass: k >= 3, info: `${k}/4 killed` };
});

test('heavy_topple', 'heavy', 'Heavy shell shoves a masonry tower over; round shot only chips it', () => {
  const L = window.__lab;
  // a six-storey tower of 1.5 m masonry courses, hit square on the fifth course (best of two for round shot, worst of two for heavy)
  const run = (id, v) => {
    L.setup([0, 1, 2, 3, 4, 5].map((k) => ({ x: 30, y: k, w: 1.5, h: 1, mat: 'stone' })));
    L.shoot(id, 26, 4.5, v, 0); L.step(4);
    // courses knocked more than 0.5 m out of place, tipped, or destroyed
    return [0, 1, 2, 3, 4, 5].filter((k) => { const p = L.pos(k); return !p || Math.hypot(p.x - 30.75, p.y - k - 0.5) > 0.5 || Math.abs(p.rot) > 0.3; }).length;
  };
  const h = Math.min(run('heavy', 30 * 0.92), run('heavy', 30 * 0.92)), s = Math.max(run('shell', 30), run('shell', 30));
  return { pass: h >= 4 && s <= 2, info: `courses of a 6-course tower knocked out of place: heavy ${h}, round shot ${s}` };
});

test('heavy_reactive', 'heavy', 'Reactive armor detonates a heavy shell (wall behind spared)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 2, mat: 'reactive' }, { x: 30.6, y: 0, w: 1, h: 2, mat: 'stone' }]);
  L.shoot('heavy', 26, 1, 27.6, 0); L.step(2);
  const det = L.b(0).dead, behind = L.frac(1);
  // control: the same shot without the reactive skin
  L.setup([{ x: 30.6, y: 0, w: 1, h: 2, mat: 'stone' }]);
  L.shoot('heavy', 26, 1, 27.6, 0); L.step(2);
  const bare = L.frac(0);
  return { pass: det && behind < bare * 0.35, info: `reactive ${det ? 'fired' : 'intact'}; wall behind ${L.r(behind * 100, 0)}% vs ${L.r(bare * 100, 0)}% bare` };
});

test('ap_masonry', 'ap', 'AP punches through several masonry blocks', () => {
  const L = window.__lab;
  L.setup([30, 31.5, 33, 34.5].map((x) => ({ x, y: 0, w: 1, h: 2, mat: 'stone' })));
  L.shoot('ap', 26, 1, 34.5, 0); L.step(1);
  const dead = [0, 1, 2, 3].filter((i) => L.b(i).dead).length;
  return { pass: dead >= 2, info: `${dead}/4 masonry blocks holed` };
});

test('ap_steel', 'ap', 'Armor plate stops AP (plate survives, room behind untouched)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.6, h: 2, mat: 'steel' }, { x: 31.5, y: 0, w: 1, h: 2, mat: 'stone' }]);
  L.shoot('ap', 26, 1, 34.5, 0); L.step(1.5);
  return { pass: !L.b(0).dead && L.frac(1) < 0.15, info: `plate ${L.b(0).dead ? 'holed' : L.r(L.frac(0) * 100, 0) + '% dmg'}; behind ${L.r(L.frac(1) * 100, 0)}%` };
});

test('ap_reactive', 'ap', 'Reactive armor detonates AP (stone behind spared)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 2, mat: 'reactive' }, { x: 30.8, y: 0, w: 1, h: 2, mat: 'stone' }]);
  L.shoot('ap', 26, 1, 34.5, 0); L.step(1.5);
  return { pass: L.b(0).dead && !L.b(1).dead && L.frac(1) < 0.15, info: `reactive ${L.b(0).dead ? 'fired' : 'intact'}; behind ${L.r(L.frac(1) * 100, 0)}%` };
});

test('he_masonry', 'he', 'HE: big blast on contact wrecks timber and hurts masonry around the hit (round shot does not)', () => {
  const L = window.__lab;
  // a shell plunging into the yard between a timber hut and a masonry wall, 1.5 m from each
  const blocks = [{ x: 29, y: 0, w: 1, h: 1.5, mat: 'wood' }, { x: 33, y: 0, w: 1, h: 2, mat: 'stone' }];
  const run = (id) => { L.setup(blocks); L.shoot(id, 31.5, 3, 0, -20); L.step(1); return [L.b(0).dead ? 1 : L.frac(0), L.b(1).dead ? 1 : L.frac(1)]; };
  const he = run('he'), rs = run('shell');
  // blast falls off with the square of distance (BALANCE.md, damage pass): 1.5 m off, masonry takes ~15% (it took ~35% under linear falloff)
  return { pass: he[0] >= 1 && he[1] > 0.1 && rs[0] < 0.2 && rs[1] < 0.2, info: `near miss: HE timber ${L.r(he[0] * 100, 0)}% masonry ${L.r(he[1] * 100, 0)}%; round shot ${L.r(rs[0] * 100, 0)}% / ${L.r(rs[1] * 100, 0)}%` };
});

test('he_troops', 'he', 'HE kills troops in its blast', () => {
  const L = window.__lab; const g = L.setup([]);
  for (const x of [27, 28.5, 30, 31.5]) g.spawnSoldier(x);
  L.shoot('he', 29, 6, 0, -12); L.step(1);
  const k = g.soldiers.filter((s) => s.dead).length;
  return { pass: k >= 3, info: `${k}/4 killed` };
});

test('he_concrete', 'he', 'Concrete shrugs off HE (vs masonry)', () => {
  const L = window.__lab;
  const run = (mat) => { L.setup([{ x: 30, y: 0, w: 1.5, h: 2, mat }]); L.shoot('he', 26, 1, 30, 0); L.step(1); return L.frac(0); };
  const st = run('stone'), co = run('concrete');
  return { pass: co < st * 0.5 && co < 0.25, info: `masonry ${L.r(st * 100, 0)}% hp, concrete ${L.r(co * 100, 0)}% hp` };
});

test('he_doublewall', 'he', 'Double walls: the first wall occludes the blast from the second', () => {
  const L = window.__lab;
  // spaced walls as in the citadel: 1 m leaves, 2 m apart
  L.setup([{ x: 30, y: 0, w: 1, h: 3, mat: 'stone' }, { x: 33, y: 0, w: 1, h: 3, mat: 'stone' }]);
  L.shoot('he', 26, 1.5, 30, 0); L.step(1);
  const bl = L.blasts[0];
  const rear = L.dealt(1);
  L.setup([{ x: 33, y: 0, w: 1, h: 3, mat: 'stone' }]);
  L.g.explode(bl.x, bl.y, bl.r, bl.d);
  const open = L.dealt(0);
  return { pass: rear < open * 0.5, info: `rear wall ${L.r(rear, 0)} dmg vs ${L.r(open, 0)} unshielded` };
});

test('inc_timber', 'incendiary', 'Incendiary sets the timber it lands among ablaze and burns it down (stone does not burn)', () => {
  const L = window.__lab;
  const huts = [30, 31, 32, 33].map((x) => ({ x, y: 0, w: 1, h: 1, mat: 'wood' })).concat([{ x: 34, y: 0, w: 1, h: 1, mat: 'stone' }]);
  L.setup(huts);
  L.shoot('incendiary', 32, 4, 0, -12);
  let lit = 0;
  L.step(0.3);
  lit = [0, 1, 2, 3].filter((i) => L.b(i).burning > 0 || L.b(i).dead).length;
  L.step(15);
  const dead = [0, 1, 2, 3].filter((i) => L.b(i).dead).length;
  return { pass: lit >= 2 && dead >= 2 && !L.b(4).dead && L.b(4).burning <= 0, info: `${lit}/4 timber lit on impact, ${dead}/4 burned down in 15 s; stone ${L.b(4).burning > 0 ? 'burning?!' : 'unburnt'}` };
});

test('fire_spread', 'incendiary', 'Fire spreads along touching timber (4-block row lit from one end)', () => {
  const L = window.__lab;
  L.setup([30, 31, 32, 33].map((x) => ({ x, y: 0, w: 1, h: 1, mat: 'wood' })));
  L.shoot('incendiary', 26, 0.5, 30, 0);
  let lit = 0;
  L.step(25, () => { lit = Math.max(lit, L.g.blocks.slice(0, 4).filter((b) => b.burning > 0 || b.dead).length); });
  return { pass: lit >= 3, info: `${lit}/4 caught fire in 25 s (fire spread is random)` };
}, true);

test('inc_firebrick', 'incendiary', 'Firebrick stops incendiary: timber behind it does not catch', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 2, mat: 'fireproof' }, { x: 30.5, y: 0, w: 1, h: 1, mat: 'wood' }, { x: 30.5, y: 1, w: 1, h: 1, mat: 'wood' }]);
  L.shoot('incendiary', 26, 1, 30, 0);
  let lit = 0;
  L.step(10, () => { lit = Math.max(lit, [1, 2].filter((i) => L.b(i).burning > 0).length); });
  return { pass: lit === 0, info: `${lit}/2 timber blocks behind firebrick ignited` };
});

test('inc_ammo', 'incendiary', 'Incendiary sets a munitions store alight: it cooks off and detonates', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1.2, h: 1.2, mat: 'crate', target: 'ammo' }, { x: 33, y: 0, w: 1, h: 2, mat: 'stone' }]);
  L.shoot('incendiary', 26, 0.6, 30, 0);
  let t = -1;
  L.step(8, (i) => { if (L.b(0).dead && t < 0) t = i / 60; });
  const big = L.blasts.some((b) => b.src === 'ammo');
  return { pass: t > 0 && big && L.frac(1) > 0.2, info: `store ${t > 0 ? 'detonated at ' + L.r(t, 1) + ' s' : 'intact'}; secondary blast ${big}; neighbour ${L.r(L.frac(1) * 100, 0)}%` };
});

test('bunker_concrete', 'bunker', 'Bunker buster cracks concrete (HE does not)', () => {
  const L = window.__lab;
  const run = (id, v) => { L.setup([{ x: 30, y: 0, w: 2, h: 2, mat: 'concrete' }]); L.shoot(id, 26, 1, v, 0); L.step(2); return L.b(0).dead ? 1 : L.frac(0); };
  const bb = run('bunker', 31.5), he = run('he', 30);
  return { pass: bb >= 1 && he < 0.25, info: `concrete 2x2: bunker buster ${L.r(bb * 100, 0)}% hp, HE ${L.r(he * 100, 0)}%` };
});

test('bunker_inside', 'bunker', 'Bunker buster burrows into a casemate and detonates inside', () => {
  const L = window.__lab;
  const cas = [{ x: 30, y: 0, w: 1, h: 3, mat: 'concrete' }, { x: 31, y: 0, w: 1.6, h: 1.2, mat: 'wood', target: 'artillery' }, { x: 32.6, y: 0, w: 1, h: 3, mat: 'concrete' }, { x: 30, y: 3, w: 3.6, h: 0.8, mat: 'concrete' }];
  const run = (id, v) => { L.setup(cas); L.shoot(id, 26, 0.7, v, 0.8); L.step(2); return L.b(1).dead ? 1 : L.frac(1); };
  const bb = run('bunker', 31.5), he = run('he', 30);
  return { pass: bb >= 1 && he < 0.4, info: `gun inside casemate: bunker buster ${bb >= 1 ? 'destroyed' : L.r(bb * 100, 0) + '%'}, HE ${L.r(he * 100, 0)}%` };
});

test('bunker_reactive', 'bunker', 'Reactive armor makes a bunker buster detonate prematurely', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 2, mat: 'reactive' }, { x: 30.6, y: 0, w: 2, h: 2, mat: 'concrete' }]);
  L.shoot('bunker', 26, 1, 31.5, 0); L.step(2);
  return { pass: L.b(0).dead && L.frac(1) < 0.4, info: `concrete behind ${L.r(L.frac(1) * 100, 0)}% (vs ≥100% bare)` };
});

test('cluster_tap', 'cluster', 'Cluster: tap in flight scatters bomblets over a wide area', () => {
  const L = window.__lab;
  // three shells (the scatter is random): every one splits into clusterCount bomblets that each burst
  let ok = true, n = 0, bursts = 0, spread = 0, hit = 0, g;
  for (let k = 0; k < 3; k++) {
    g = L.setup([26, 28, 30, 32, 34, 36, 38, 40].map((x) => ({ x, y: 0, w: 1, h: 1, mat: 'wood' })));
    const p = L.shoot('cluster', 24, 14, 9, 0);
    L.step(0.25);
    ok = ok && g.triggerAbility() && p.split;
    n += g.projectiles.filter((q) => q.bomblet && !q.dead).length / 3;
    L.step(4);
    hit += [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => L.dealt(i) > 0).length / 3;
    const xs = L.blasts.map((b) => b.x);
    spread += (Math.max(...xs) - Math.min(...xs)) / 3; bursts += L.blasts.length / 3;
  }
  return { pass: ok && n === g.stats.clusterCount && bursts >= n && spread > 4.5 && hit >= 3, info: `${L.r(n, 1)} bomblets (clusterCount ${g.stats.clusterCount}), ${L.r(bursts, 1)} bursts over ${L.r(spread, 1)} m; ${L.r(hit, 1)}/8 spaced huts hit (mean of 3)` };
});

test('cluster_airburst', 'cluster', 'Cluster airburst timer splits the shell in the air at the set time', () => {
  const L = window.__lab; const g = L.setup([]);
  g.selected = 'cluster'; g.airburst = 0.9; g.speed = 25; g.angle = 0.6;
  g.fire();
  const p = g.projectiles.find((q) => q.ammo.id === 'cluster' && !q.bomblet);
  let at = -1, y = 0;
  L.step(2, () => { if (at < 0 && p.split) { at = p.age; y = p.y - g.groundY(p.x); return false; } });
  const n = g.projectiles.filter((q) => q.bomblet).length + g.projectiles.length * 0;
  return { pass: Math.abs(at - 0.9) < 0.04 && y > 3, info: `split at ${L.r(at)} s, ${L.r(y, 1)} m up` };
});

test('cluster_reactive', 'cluster', 'Cluster bomblets come down on top of a reactive-skinned wall (skin no help)', () => {
  const L = window.__lab;
  const blocks = [{ x: 30, y: 0, w: 0.4, h: 2.6, mat: 'reactive' }, { x: 30.5, y: 0, w: 5, h: 2, mat: 'wood' }];
  const run = (fn) => { const g = L.setup(blocks); fn(g); L.step(4); return { skin: L.b(0).dead, hut: L.b(1).dead ? 1 : L.frac(1) }; };
  // burst over the hut (mean of three, the scatter is random)
  let cs = 0;
  for (let k = 0; k < 3; k++) cs += run((g) => { L.shoot('cluster', 32, 10, 1, 0); L.step(0.1); g.triggerAbility(); }).hut / 3;
  const c = { hut: cs };
  const h = run(() => L.shoot('he', 26, 1.2, 30, 0));
  return { pass: c.hut > 0.4 && h.hut < 0.2, info: `timber behind skin: cluster ${L.r(c.hut * 100, 0)}%, HE at the skin ${L.r(h.hut * 100, 0)}%` };
});

test('delayed_fuse', 'delayed', 'Delayed fuse bounces/rolls and blows the set time after first impact', () => {
  const L = window.__lab; const g = L.setup([]);
  g.selected = 'delayed'; g.fuseSetting = 1.7; g.speed = 16; g.angle = 0.25;
  g.fire();
  const p = g.projectiles.find((q) => q.ammo.id === 'delayed');
  let t0 = -1, t1 = -1, x0 = 0;
  L.step(6, (i) => {
    if (t0 < 0 && p.impacted) { t0 = i / 60; x0 = p.x; }
    if (t1 < 0 && p.dead) { t1 = i / 60; return true; }
  });
  const roll = L.blasts[0] ? L.blasts[0].x - x0 : 0;
  return { pass: Math.abs(t1 - t0 - 1.7) < 0.05 && roll > 1, info: `blew ${L.r(t1 - t0)} s after first impact (set 1.7), travelled ${L.r(roll, 1)} m after it` };
});

test('sticky_glue', 'sticky', 'Sticky charge glues to a pillar, rides it, then blows', () => {
  const L = window.__lab; const g = L.setup([{ x: 30, y: 0, w: 0.8, h: 3, mat: 'stone' }]);
  const p = L.shoot('sticky', 26, 2, 22.5, 0);
  let stuckOn = null, stuckAt = -1, blew = -1;
  L.step(5, (i) => { if (!stuckOn && p.stuck) { stuckOn = p.stuck.block; stuckAt = i / 60; } if (blew < 0 && p.dead) { blew = i / 60; return true; } });
  const fuse = blew - stuckAt;
  return { pass: stuckOn === L.b(0) && Math.abs(fuse - g.stats.stickyFuse) < 0.05 && L.frac(0) > 0.6, info: `stuck to pillar: ${stuckOn === L.b(0)}; blew after ${L.r(fuse)} s; pillar ${L.r(L.frac(0) * 100, 0)}% hp` };
});

test('sticky_reactive', 'sticky', 'Sticky charge is too slow to set off reactive armor, then breaks it', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 2, mat: 'reactive' }, { x: 30.6, y: 0, w: 1, h: 2, mat: 'stone' }]);
  const p = L.shoot('sticky', 26, 1, 22.5, 0);
  let aliveAtStick = null;
  L.step(4, () => { if (aliveAtStick === null && p.stuck) aliveAtStick = !L.b(0).dead; });
  // the reactive plate soaks most of the charge (occlusion; blast falls off with the square of distance): the masonry behind takes a few per cent
  return { pass: aliveAtStick === true && L.b(0).dead && L.frac(1) > 0.03, info: `reactive intact on contact: ${aliveAtStick}; broken by charge: ${L.b(0).dead}; behind ${L.r(L.frac(1) * 100, 0)}%` };
});

test('drill_foundation', 'drill', 'Drill lands short, tunnels forward and blows the foundations from below', () => {
  const L = window.__lab;
  const tower = [0, 1, 2, 3].map((k) => ({ x: 36, y: k, w: 1.2, h: 1, mat: 'stone' }));
  L.setup(tower);
  const top0 = L.pos(3);
  const p = L.shoot('drill', 24, 3, 14, -4);
  let land = null;
  L.step(5, () => { if (!land && p.burrow) land = p.x; });
  const bl = L.blasts[0];
  const top = L.pos(3);
  const drop = top ? top0.y - top.y : 9;
  return { pass: land !== null && land < 34 && bl && bl.y < 0 && Math.abs(bl.x - 36.6) < 1 && (L.b(0).dead || drop > 0.6), info: `landed x=${land && L.r(land, 1)}, blew at x=${bl && L.r(bl.x, 1)} y=${bl && L.r(bl.y, 1)}; base ${L.b(0).dead ? 'destroyed' : L.r(L.frac(0) * 100, 0) + '%'}; top dropped ${L.r(drop, 1)} m` };
});

test('drill_high', 'drill', 'Drill does little to a target high up on a solid base', () => {
  const L = window.__lab;
  L.setup([0, 1.5, 3, 4.5].map((y) => ({ x: 34, y, w: 3, h: 1.5, mat: 'concrete' })).concat([{ x: 35, y: 6, w: 1, h: 1, mat: 'wood', target: 'flak' }]));
  L.shoot('drill', 24, 3, 14, -4); L.step(5);
  return { pass: !L.b(4).dead && L.frac(4) < 0.3, info: `target 6 m up took ${L.r(L.frac(4) * 100, 0)}%; base course ${L.b(0).dead ? 'destroyed' : L.r(L.frac(0) * 100, 0) + '%'}` };
});

test('drill_earth', 'drill', 'Earthworks: drills cut them (HE barely scratches them)', () => {
  const L = window.__lab;
  const run = (id, sh) => { L.setup([{ x: 34, y: 0, w: 3, h: 2, mat: 'earth' }]); sh(); L.step(4); return L.b(0).dead ? 1 : L.frac(0); };
  const dr = run('drill', () => L.shoot('drill', 24, 3, 14, -4));
  const he = run('he', () => L.shoot('he', 30, 1, 30, 0));
  return { pass: dr >= 0.5 && he < 0.15, info: `earth berm 3x2: drill ${L.r(dr * 100, 0)}%, HE ${L.r(he * 100, 0)}%` };
});

test('drill_under', 'drill', 'Drill tunnels under a wall and blows beneath the target behind it', () => {
  const L = window.__lab;
  // a masonry curtain wall, then a ground-floor magazine 3 m behind it
  L.setup([{ x: 33, y: 0, w: 1.2, h: 3, mat: 'stone' }, { x: 37, y: 0, w: 1.4, h: 1.2, mat: 'wood', target: 'workshop' }]);
  L.shoot('drill', 22, 3, 14, -4); L.step(5);
  const bl = L.blasts[0];
  return { pass: L.b(1).dead && bl && bl.x > 36.5, info: `blew at x=${bl && L.r(bl.x, 1)} (wall 33-34.2, target 37-38.4); target ${L.b(1).dead ? 'destroyed' : L.r(L.frac(1) * 100, 0) + '%'}; wall ${L.b(0).dead ? 'destroyed' : L.r(L.frac(0) * 100, 0) + '%'}` };
});

test('drill_wall', 'drill', 'A drill that strikes a wall instead of earth still goes off in it (no fizzle)', () => {
  const L = window.__lab;
  const run = (id, vx) => { L.setup([{ x: 30, y: 0, w: 1, h: 3, mat: 'stone' }]); L.shoot(id, 26, 1.5, vx, 0); L.step(2); return L.b(0).dead ? 1 : L.frac(0); };
  const dr = run('drill', 30), he = run('he', 30);
  return { pass: dr >= he * 0.8 && dr > 0.5, info: `masonry wall: drill ${L.r(dr * 100, 0)}%, HE ${L.r(he * 100, 0)}%` };
});

test('flak_infantry', 'flak', 'Flak bursting among infantry on the ground is no canister (kills only men right beside it)', () => {
  const L = window.__lab; const g = L.setup([]);
  for (const x of [26, 28, 30, 32]) g.spawnSoldier(x);
  L.shoot('flak', 29, 6, 0, -12); L.step(1);
  const f = g.soldiers.filter((s) => s.dead).length;
  const g2 = L.setup([]);
  for (const x of [26, 28, 30, 32]) g2.spawnSoldier(x);
  L.shoot('he', 29, 6, 0, -12); L.step(1);
  const h = g2.soldiers.filter((s) => s.dead).length;
  return { pass: f <= 2 && h >= 3, info: `4 men 2 m apart, burst in the middle: flak ${f} killed, HE ${h}` };
});

test('canister_infantry', 'canister', 'Canister shreds advancing infantry', () => {
  const L = window.__lab; const g = L.setup([]);
  for (const x of [24, 25.2, 26.4, 27.6, 28.8, 30]) g.spawnSoldier(x);
  g.selected = 'canister'; g.speed = 30;
  g.angle = L.aim(30 * 1.05, 26, 0.8);
  g.fire(); L.step(1.5);
  const k = g.soldiers.filter((s) => s.dead).length;
  return { pass: k >= 5, info: `${k}/6 killed by one volley` };
});

test('canister_spread', 'canister', 'One canister volley clears most of a spread-out file at mid range, more than an HE shell does; it thins out at long range; shields stop it from the front (mean of three volleys)', () => {
  const L = window.__lab;
  // six men 2.2 m apart centred d m out; one volley laid to graze the ground just beyond them, at chest height through the file
  const run = (id, d, shields) => {
    let k = 0;
    for (let t = 0; t < 3; t++) {
      const g = L.setup([]);
      for (let i = 0; i < 6; i++) g.spawnSoldier(d - 5.5 + i * 2.2, shields && i % 2 === 0);
      for (const s of g.soldiers) s.stopX = s.x - 0.01;
      g.selected = id; g.speed = 30;
      g.angle = id === 'canister' ? L.aim(30 * 1.05, d + 7, 0.1) : L.aim(30, d, 0.1);
      g.fire(); L.step(3);
      k += g.soldiers.filter((s) => s.dead).length / 3;
    }
    return k;
  };
  const mid = run('canister', 30, false), he = run('he', 30, false), far = run('canister', 62, false), sh = run('canister', 30, true);
  return { pass: mid >= 4 && mid > he && far <= mid * 0.6 && sh <= 3.4, info: `6 men at 30 m: canister ${L.r(mid, 1)}, HE ${L.r(he, 1)}; at 62 m: canister ${L.r(far, 1)}; at 30 m, every other man shielded: canister ${L.r(sh, 1)}` };
});

test('canister_building', 'canister', 'Canister is poor against buildings (well under a round shot)', () => {
  const L = window.__lab;
  const run = (id) => { const g = L.setup([{ x: 26, y: 0, w: 1, h: 2, mat: 'stone' }]); g.selected = id; g.speed = 30; g.angle = L.aim(30 * (id === 'canister' ? 1.05 : 1), 26, 1); g.fire(); L.step(1.5); return L.dealt(0); };
  const c = run('canister'), s = run('shell');
  return { pass: c < s * 0.5, info: `masonry dmg: canister ${L.r(c, 0)}, round shot ${L.r(s, 0)}` };
});

test('canister_research', 'canister', 'Canister pellet damage follows research multipliers (stats.dmg)', () => {
  const L = window.__lab;
  // a fixed volley of 14 pellets straight into a timber wall
  const run = (m) => { L.setup([{ x: 26, y: 0, w: 1, h: 2, mat: 'wood' }], { stats: { dmg: { canister: m } } }); for (let k = 0; k < 14; k++) L.shoot('canister', 23, 0.3 + k * 0.1, 31.5, 0, { pellet: true }); L.step(1); return L.dealt(0); };
  const a = run(1), b = run(2);
  return { pass: b > a * 1.6, info: `dmg x1: ${L.r(a, 0)}, x2: ${L.r(b, 0)}` };
});

test('flak_gyro', 'flak', 'Flak proximity burst near a gyrocopter downs it', () => {
  const L = window.__lab; const g = L.setup([{ x: 80, y: 0, w: 1, h: 6, mat: 'stone', target: 'mast' }]);
  g.air.launch('gyro', L.b(0));
  const u = g.air.units[0];
  L.step(0.5);
  // shell crosses the gyro's path 1.8 m below it (never touching it)
  const t = 0.6;
  const tx = u.x + u.vx * t, ty = u.y + u.vy * t - 1.8;
  L.shoot('flak', tx - 33 * t, ty + 4.905 * t * t, 33, 0, { fuseSetting: 3 });
  L.step(2);
  return { pass: u.down, info: `gyro ${u.down ? 'down' : 'flying, hp ' + L.r(u.hp, 0)}` };
});

test('flak_airship', 'flak', 'Flak bursts bring down an armoured airship in a few shells', () => {
  const L = window.__lab; const g = L.setup([{ x: 80, y: 0, w: 1, h: 6, mat: 'stone', target: 'mast' }]);
  g.air.launch('airship', L.b(0));
  const u = g.air.units[0];
  let shots = 0;
  for (; shots < 6 && !u.down; shots++) {
    L.step(0.4);
    L.shoot('flak', u.x - 18, u.y - 2.5 + 4.905 * (18 / 33) ** 2, 33, 0, { fuseSetting: 3 });
    L.step(0.8);
  }
  return { pass: u.down && shots <= 4, info: `airship ${u.down ? 'down after ' + shots + ' shells' : 'still up after 6'}` };
});

test('flak_timer', 'flak', 'Flak bursts on its timer when nothing is near', () => {
  const L = window.__lab; const g = L.setup([]);
  g.selected = 'flak'; g.flakFuse = 1.2; g.speed = 30; g.angle = 0.8;
  g.fire();
  let t = -1;
  L.step(3, (i) => { if (t < 0 && L.blasts.length) { t = (i + 1) / 60; return true; } });
  return { pass: Math.abs(t - 1.2) < 0.04, info: `burst at ${L.r(t)} s (set 1.2)` };
});

test('flak_walls', 'flak', 'Flak is poor against walls (well under an HE shell)', () => {
  const L = window.__lab;
  const run = (id) => { L.setup([{ x: 30, y: 0, w: 1.5, h: 2, mat: 'stone' }]); L.shoot(id, 26, 1, 30, 0); L.step(1); return L.dealt(0); };
  const f = run('flak'), h = run('he');
  return { pass: f < h * 0.45, info: `masonry dmg: flak ${L.r(f, 0)}, HE ${L.r(h, 0)}` };
});

test('smoke_blind', 'smoke', 'Smoke blinds the counter-battery gun for ~15 s', () => {
  const L = window.__lab; const g = L.setup([{ x: 70, y: 0, w: 1.5, h: 1.5, mat: 'stone', target: 'artillery' }], { live: true });
  g.barT = g.repT = g.rebT = 999;
  const enemy = () => g.artilleryShots;
  g.artT = 0.3;
  L.shoot('smoke', 60, 0.5, 0, -5);
  let first = -1, blind0 = 0;
  L.step(20, (i) => { g.barT = g.repT = g.rebT = 999; blind0 = Math.max(blind0, g.enemyBlind); if (first < 0 && enemy() > 0) { first = (i + 1) / 60; return true; } });
  return { pass: blind0 > 14 && first > 14 && first < 18, info: `blind ${L.r(blind0, 1)} s; gun's next shot at ${L.r(first, 1)} s after smoke` };
});

test('drone_reveal', 'drone', 'Drone reveals disguised armor and marks load-bearing members', () => {
  const L = window.__lab;
  const g = L.setup([
    { x: 30, y: 0, w: 0.6, h: 3, mat: 'stone' }, { x: 33.4, y: 0, w: 0.6, h: 3, mat: 'stone' }, { x: 29.8, y: 3, w: 4.4, h: 0.6, mat: 'stone' }, { x: 30.5, y: 3.6, w: 3, h: 1.5, mat: 'stone' },
    { x: 40, y: 0, w: 1, h: 2, mat: 'steel', disguise: 'stone' }, { x: 44, y: 0, w: 1, h: 1, mat: 'wood' },
  ]);
  const kind0 = L.b(4).uni.uKind.value;
  g.droneTarget = { x: 36, y: 12 }; g.selected = 'drone'; g.fire();
  let t = -1;
  L.step(6, (i) => { if (g.revealed && t < 0) { t = i / 60; return true; } });
  const kind1 = L.b(4).uni.uKind.value;
  const cols = [0, 1].filter((i) => L.b(i).highlight).length;
  return { pass: g.revealed && kind0 !== kind1 && kind1 === L.cfg.MATERIALS.steel.kind && cols === 2 && !L.b(5).highlight, info: `revealed at ${L.r(t, 1)} s; disguised block shows ${kind1 === L.cfg.MATERIALS.steel.kind ? 'steel' : 'still stone'}; ${cols}/2 columns marked; lone hut marked ${!!L.b(5).highlight}` };
});

test('drone_flak', 'drone', 'Flak shoots the drone down', () => {
  const L = window.__lab; const g = L.setup([{ x: 40, y: 0, w: 1.5, h: 1.5, mat: 'stone', target: 'flak' }]);
  g.droneTarget = { x: 38, y: 12 }; g.selected = 'drone'; g.fire();
  const d = g.drones[0];
  let st = '';
  L.step(6, () => { if (d.state === 'down') { st = 'down'; return true; } });
  return { pass: st === 'down', info: `drone ${st || d.state}` };
});

test('sab_point', 'saboteur', 'Saboteur plants the charge at the chosen point', () => {
  const L = window.__lab;
  const run = (target) => {
    const g = L.setup([{ x: 40, y: 0, w: 1, h: 2, mat: 'stone' }]);
    g.sabTarget = target; g.selected = 'saboteur'; g.fire();
    let at = null;
    L.step(14, () => { const c = g.projectiles.find((q) => q.ammo.id === 'saboteur'); if (c && !at) at = { x: c.x, block: c.stuck && c.stuck.block === L.b(0) }; return false; });
    return { at, wall: L.b(0).dead ? 1 : L.frac(0) };
  };
  const a = run(30), b = run(null);
  return { pass: a.at && Math.abs(a.at.x - 30) < 0.8 && b.at && b.at.block && b.wall >= 1, info: `target x=30 → planted at ${a.at && L.r(a.at.x, 1)}; no target → at wall (${b.at && L.r(b.at.x, 1)}), wall ${b.wall >= 1 ? 'destroyed' : L.r(b.wall * 100, 0) + '%'}` };
});

test('sab_reactive', 'saboteur', 'Saboteur charge does not set off reactive armor early and breaks it', () => {
  const L = window.__lab; const g = L.setup([{ x: 40, y: 0, w: 0.5, h: 2, mat: 'reactive' }, { x: 40.6, y: 0, w: 1, h: 2, mat: 'stone' }]);
  g.sabTarget = null; g.selected = 'saboteur'; g.fire();
  let plantedIntact = null;
  L.step(14, () => { const c = g.projectiles.find((q) => q.ammo.id === 'saboteur'); if (c && plantedIntact === null) plantedIntact = !L.b(0).dead; });
  return { pass: plantedIntact === true && L.b(0).dead && L.frac(1) > 0.3, info: `reactive intact at plant: ${plantedIntact}; broken: ${L.b(0).dead}; stone behind ${L.r(L.frac(1) * 100, 0)}%` };
});

test('sab_infantry', 'saboteur', 'Enemy infantry gun the saboteur down', () => {
  const L = window.__lab; const g = L.setup([{ x: 60, y: 0, w: 1, h: 2, mat: 'stone' }]);
  g.spawnSoldier(30);
  g.sabTarget = null; g.selected = 'saboteur'; g.fire();
  L.step(10);
  const planted = L.blasts.length > 0;
  return { pass: g.saboteurs.length === 0 && !planted, info: `saboteur ${g.saboteurs.length ? 'alive' : 'killed'}; charge planted ${planted}` };
});

const strikeTest = (ord, dive, desc, check) => test(`air_${ord}${dive ? '_dive' : ''}`, 'airstrike', desc, `() => {
  const L = window.__lab;
  const g = L.setup([{ x: 49, y: 0, w: 2, h: 2, mat: ${ord === 'penetrator' ? "'concrete'" : ord === 'incendiary' ? "'wood'" : "'stone'"} }], { stats: { dive: ${dive > 0}, bombs: 5, bombTypes: ['he', 'incendiary', 'penetrator'] } });
  Object.assign(g.strike, { x: 50, dir: 1, alt: 24, dive: ${dive}, spacing: 2.4, ordnance: '${ord}' });
  const sol = g.planStrike();
  g.selected = 'airstrike'; g.fire();
  const hits = [];
  const seen = new Set();
  let lit = 0;
  L.step(14, () => { lit = Math.max(lit, L.b(0).burning > 0 || L.b(0).dead ? 1 : 0); for (const b of L.blasts) if (!seen.has(b)) { seen.add(b); hits.push(b.x); } });
  const mean = hits.reduce((s, x) => s + x, 0) / Math.max(1, hits.length);
  const spread = Math.max(...hits) - Math.min(...hits);
  const frac = L.b(0).dead ? 1 : L.frac(0);
  ${check}
}`);
// (the test body is assembled as a string so each variant can carry its own check)
// (the stick is solved for the ground at x 50: bombs that strike the 2 m block's top burst ~2 m short, and with the
// bigger GP bomb the block can go after the first bomb, so the mean wanders 0.5-1.5 m short: allow 2 m)
strikeTest('he', 0, 'GP bomb stick lands across the aim point and wrecks masonry there', `return { pass: sol.ok && hits.length >= 5 && Math.abs(mean - 50) < 2 && spread < 5 * 2.4 + 2 && frac > 0.5, info: hits.length + ' bombs, mean x ' + L.r(mean, 1) + ' (aim 50), spread ' + L.r(spread, 1) + ' m; masonry ' + L.r(frac * 100, 0) + '%' };`);
strikeTest('incendiary', 0, 'Firebombs land on the aim point and set timber alight', `return { pass: hits.length >= 5 && Math.abs(mean - 50) < 1.5 && lit > 0, info: hits.length + ' firebombs, mean x ' + L.r(mean, 1) + '; timber lit: ' + (lit > 0) };`);
strikeTest('penetrator', 0, 'AP bombs land on the aim point and crack concrete from above', `return { pass: Math.abs(mean - 50) < 2 && frac >= 1, info: 'mean x ' + L.r(mean, 1) + '; concrete 2x2 ' + L.r(frac * 100, 0) + '%' };`);
strikeTest('he', 50, 'Dive-bombing still lands on the aim point (tighter stick)', `return { pass: sol.ok && hits.length >= 5 && Math.abs(mean - 50) < 1.5 && frac > 0.5, info: hits.length + ' bombs, mean x ' + L.r(mean, 1) + ', spread ' + L.r(spread, 1) + ' m; masonry ' + L.r(frac * 100, 0) + '%' };`);

test('air_flak', 'airstrike', 'Flak defending the aim point shoots the bomber down on its run (battery made indestructible: this tests the flak, not the bombs)', () => {
  const L = window.__lab; const g = L.setup([{ x: 51, y: 0, w: 1.5, h: 1.5, mat: 'rock', target: 'flak' }]);
  Object.assign(g.strike, { x: 50, dir: 1, alt: 24, dive: 0, spacing: 2.4, ordnance: 'he' });
  g.selected = 'airstrike'; g.fire();
  const pl = g.planes[0];
  let down = -1;
  L.step(14, (i) => { if (pl.down) { down = pl.x; return true; } });
  // with Chaff & Jammers it gets through
  const g2 = L.setup([{ x: 51, y: 0, w: 1.5, h: 1.5, mat: 'rock', target: 'flak' }], { stats: { ecm: true } });
  Object.assign(g2.strike, { x: 50, dir: 1, alt: 24, dive: 0, spacing: 2.4, ordnance: 'he' });
  g2.selected = 'airstrike'; g2.fire();
  const pl2 = g2.planes[0];
  let down2 = false;
  L.step(14, () => { if (pl2.down) { down2 = true; return true; } });
  return { pass: down > 0 && !down2, info: `bomber ${down > 0 ? 'shot down at x=' + L.r(down, 0) : 'survived'}; with ECM ${down2 ? 'shot down' : 'survived'}` };
});

test('air_flak_aim', 'airstrike', 'Flak in reach of the release point throws the bombs off the aim point', () => {
  const L = window.__lab;
  const run = (flak) => {
    const errs = [];
    for (let k = 0; k < 3; k++) {
      const g = L.setup(flak ? [{ x: 40, y: 0, w: 1.5, h: 1.5, mat: 'stone', target: 'flak' }] : [], { stats: { bombs: 5 } });
      Object.assign(g.strike, { x: 60, dir: 1, alt: 10, dive: 0, spacing: 0.15, ordnance: 'he' });
      g.selected = 'airstrike'; g.fire();
      L.step(8);
      // GP bomb bursts only (not the wreck of a downed bomber)
      for (const b of L.blasts) if (b.r === L.cfg.AMMO_BY_ID.bomb_he.blastRadius && b.d === L.cfg.AMMO_BY_ID.bomb_he.blastDamage) errs.push(Math.abs(b.x - 60));
    }
    return errs.reduce((s, e) => s + e, 0) / Math.max(1, errs.length);
  };
  const clear = run(false), flak = run(true);
  return { pass: clear < 2.2 && flak > clear * 2.5, info: `(sticks at least 1.2 m apart) mean miss: clear sky ${L.r(clear)} m, under flak ${L.r(flak)} m` };
});

test('reactive_fast', 'shell', 'Reactive armor detonates fast rounds (wall behind spared)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 2, mat: 'reactive' }, { x: 30.6, y: 0, w: 1, h: 2, mat: 'wood' }]);
  L.shoot('he', 26, 1, 30, 0); L.step(1);
  return { pass: L.b(0).dead && !L.b(1).dead && L.frac(1) < 0.5, info: `HE on reactive skin: skin ${L.b(0).dead ? 'fired' : 'intact'}; timber behind ${L.r(L.frac(1) * 100, 0)}% (bare: destroyed)` };
});

test('sloped_steel', 'ap', 'Sloped steel glacis: flat shots ricochet, plunging hits bite', () => {
  const L = window.__lab;
  const run = (id, x, y, vx, vy) => {
    L.setup([L.shapes.wedge(30, 0, 4, 2, 'steel', 'right')]);
    let ric = false;
    const g = L.g, orig = g.ricochet;
    g.ricochet = function (...a) { ric = true; return orig.apply(this, a); };
    L.shoot(id, x, y, vx, vy);
    L.step(1.5);
    g.ricochet = orig;
    return { d: L.dealt(0), ric };
  };
  // flat: hits the 27° glacis at ~63° obliquity. plunging: 60° down onto the same face
  const fs = run('shell', 27, 0.9, 30, 0), ps = run('shell', 32 - 0.5 * 4, 1 + 0.866 * 4, 15, -26);
  const fa = run('ap', 27, 0.9, 34.5, 0), pa = run('ap', 32 - 0.5 * 4, 1 + 0.866 * 4, 17.2, -29.9);
  return { pass: fs.ric && !ps.ric && ps.d > 2 * fs.d && fa.ric && !pa.ric && pa.d > 2 * fa.d, info: `round shot flat ${L.r(fs.d, 0)}${fs.ric ? ' (ricochet)' : ''} vs plunging ${L.r(ps.d, 0)}${ps.ric ? ' (ricochet)' : ''}; AP flat ${L.r(fa.d, 0)}${fa.ric ? ' (ricochet)' : ''} vs plunging ${L.r(pa.d, 0)}${pa.ric ? ' (ricochet)' : ''}` };
});

test('earth_bunker', 'bunker', 'Earthworks soak HE but bunker busters cut them', () => {
  const L = window.__lab;
  const run = (id, v) => { L.setup([{ x: 30, y: 0, w: 3, h: 2, mat: 'earth' }]); L.shoot(id, 26, 1, v, 0); L.step(2); return L.b(0).dead ? 1 : L.frac(0); };
  const bb = run('bunker', 31.5), he = run('he', 30), ap = run('ap', 34.5);
  return { pass: bb >= 0.6 && he < 0.15, info: `earth berm 3x2: bunker buster ${L.r(bb * 100, 0)}%, AP ${L.r(ap * 100, 0)}%, HE ${L.r(he * 100, 0)}%` };
});

test('fuel_tank', 'he', 'Fuel tanks explode when breached', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 2, mat: 'fuel' }, { x: 32.5, y: 0, w: 1, h: 1, mat: 'wood' }]);
  L.shoot('he', 26, 1, 30, 0); L.step(2);
  const boom = L.blasts.some((b) => b.src === 'fuel');
  return { pass: L.b(0).dead && boom && L.dealt(1) > 0, info: `tank ${L.b(0).dead ? 'breached' : 'intact'}; fuel blast ${boom}; hut next door ${L.r(L.frac(1) * 100, 0)}%` };
});

test('fuel_chain', 'he', 'Fuel tanks chain-explode (tank 1.5 m away goes up too)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 2, mat: 'fuel' }, { x: 33, y: 0, w: 1.5, h: 2, mat: 'fuel' }]);
  L.shoot('he', 26, 1, 30, 0); L.step(6);
  return { pass: L.b(1).dead, info: `second tank ${L.b(1).dead ? 'exploded' : L.r(L.frac(1) * 100, 0) + '% dmg, burning ' + (L.b(1).burning > 0)}` };
}, true);

test('ammo_cookoff', 'he', 'A destroyed munitions store detonates (secondary blast)', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1, h: 1, mat: 'crate', target: 'ammo' }, { x: 32.5, y: 0, w: 1, h: 2, mat: 'stone' }]);
  L.shoot('he', 26, 0.5, 30, 0); L.step(2);
  const big = L.blasts.some((b) => b.src === 'ammo');
  return { pass: L.b(0).dead && big && L.frac(1) > 0.2, info: `store ${L.b(0).dead ? 'destroyed' : 'intact'}; secondary ${big}; stone 2.5 m away ${L.r(L.frac(1) * 100, 0)}%` };
});

test('objective_direct', 'shell', 'One direct round-shot hit knocks out an objective, whatever it is built of', () => {
  const L = window.__lab; const out = [];
  let ok = true;
  for (const mat of ['wood', 'stone', 'concrete']) {
    L.setup([{ x: 30, y: 0, w: 1.6, h: 1.4, mat, target: 'barracks' }]);
    L.shoot('shell', 26, 0.7, 26, 0); L.step(1);
    out.push(`${mat} ${L.b(0).dead ? 'down' : 'standing'}`);
    ok = ok && L.b(0).dead;
  }
  return { pass: ok, info: out.join(', ') };
});

test('objective_near', 'he', 'Two near misses (HE landing beside it) knock out an objective; one does not', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1.6, h: 1.4, mat: 'stone', target: 'barracks' }, { x: 26, y: 0, w: 0.6, h: 0.3, mat: 'rock' }]);
  L.g.explode(28.4, 0.4, 4.2, 115, { source: 'he' }); L.step(0.5);
  const one = L.b(0).dead;
  L.g.explode(28.4, 0.4, 4.2, 115, { source: 'he' }); L.step(0.5);
  return { pass: !one && L.b(0).dead, info: `after one: ${one ? 'down' : 'standing'}; after two: ${L.b(0).dead ? 'down' : 'standing'}` };
});

test('objective_angle', 'shell', 'A glancing or slow hit on an objective does far less than a square, fast one', () => {
  const L = window.__lab;
  // square on at 26 m/s
  L.setup([{ x: 30, y: 0, w: 1.6, h: 1.4, mat: 'stone', target: 'barracks' }]);
  L.shoot('shell', 26, 0.7, 26, 0); L.step(1);
  const square = L.b(0).dead;
  // slow lob dropping on it at ~8 m/s
  L.setup([{ x: 30, y: 0, w: 1.6, h: 1.4, mat: 'stone', target: 'barracks' }]);
  L.shoot('shell', 30, 3.2, 0, -2); L.step(1);
  const slow = L.b(0).dead ? 1 : L.frac(0);
  return { pass: square && slow < 0.75, info: `square 26 m/s: ${square ? 'down' : 'standing'}; slow drop: ${slow === 1 ? 'down' : L.r(slow * 100, 0) + '% hp'}` };
});

test('objective_type', 'heavy', 'What a direct hit does depends on the round: a heavy shell at 12 m/s knocks an objective out, a light incendiary casing does not', () => {
  const L = window.__lab;
  L.setup([{ x: 30, y: 0, w: 1.6, h: 1.4, mat: 'stone', target: 'barracks' }]);
  L.shoot('heavy', 27.5, 0.7, 12, 0); L.step(0.6);
  const heavy = L.b(0).dead;
  L.setup([{ x: 30, y: 0, w: 1.6, h: 1.4, mat: 'stone', target: 'barracks' }]);
  L.shoot('incendiary', 27.5, 0.7, 12, 0); L.step(0.6);
  const inc = L.b(0).dead ? 1 : L.frac(0);
  return { pass: heavy && inc < 1, info: `heavy: ${heavy ? 'down' : 'standing'}; incendiary: ${inc === 1 ? 'down' : L.r(inc * 100, 0) + '% hp'}` };
});

test('engineers_slow', 'shell', 'Engineers walk out, put up a scaffold and patch one cracked block at a time, bottom first, slowly; not burning ones', () => {
  const L = window.__lab;
  const g = L.setup([{ x: 30, y: 0, w: 1, h: 1, mat: 'stone' }, { x: 30, y: 1, w: 1, h: 1, mat: 'stone' }, { x: 22, y: 0, w: 1, h: 1, mat: 'wood' },
    { x: 40, y: 0, w: 1.2, h: 1, mat: 'stone', target: 'workshop' }], { live: true });
  g.artT = g.barT = 999; g.repT = 0;
  for (const i of [0, 1]) L.b(i).hp = L.b(i).maxHp * 0.4;
  L.b(2).hp = L.b(2).maxHp * 0.5; g.ignite(L.b(2));
  // the crew has to walk ~10 m and put the scaffold up first
  const t0 = L.step(40, () => g.crew.working > 0) / 60;
  const h = (i) => L.r(L.b(i).hp / L.b(i).maxHp * 100, 0);
  const a0 = h(0);
  L.step(6);
  const a = [h(0), h(1)];
  return { pass: t0 > 5 && t0 < 30 && a0 <= 41 && a[0] - a0 > 6 && a[0] - a0 < 30 && a[1] <= 40.5 && L.b(2).hp <= L.b(2).maxHp * 0.5,
    info: `at work after ${L.r(t0, 1)} s (bottom still ${a0}%); 6 s later: bottom ${a[0]}%, top ${a[1]}%, burning timber ${h(2)}%` };
});

test('engineers_present', 'shell', 'No repair unless an engineer is at work at the block', () => {
  const L = window.__lab;
  const g = L.setup([{ x: 30, y: 0, w: 1.4, h: 1.2, mat: 'stone' }, { x: 40, y: 0, w: 1.2, h: 1, mat: 'stone', target: 'workshop' }], { live: true });
  g.artT = g.barT = 999; g.repT = 0;
  const b = L.b(0); b.hp = b.maxHp * 0.4;
  let bad = 0, last = b.hp, worked = 0;
  L.step(30, () => { if (b.hp > last + 1e-6 && g.crew.working === 0) bad++; if (g.crew.working) worked++; last = b.hp; });
  return { pass: bad === 0 && worked > 0 && b.hp > b.maxHp * 0.45, info: `${bad} frames mended with nobody at work; ${L.r(worked / 60, 1)} s of hands at work, block now ${L.r(b.hp / b.maxHp * 100, 0)}%` };
});

test('engineers_killed', 'canister', 'Killing the crew stops repairs (and counts as casualties) until the workshop sends more', () => {
  const L = window.__lab;
  const g = L.setup([{ x: 30, y: 0, w: 1.4, h: 1.2, mat: 'stone' }, { x: 40, y: 0, w: 1.2, h: 1, mat: 'stone', target: 'workshop' }], { live: true });
  g.artT = g.barT = 999; g.repT = 0;
  const b = L.b(0); b.hp = b.maxHp * 0.3;
  L.step(40, () => g.crew.working > 0);
  const c0 = g.garrison.casualties;
  // a canister load through the crew
  const men = g.crew.alive.length;
  for (const e of g.crew.alive) L.shoot('canister', e.s.x - 3, e.s.y + 0.8, 30, 0, { pellet: true });
  L.step(0.5);
  const killed = g.garrison.casualties - c0;
  const hp1 = b.hp;
  L.step(10);
  const still = b.hp - hp1;
  // replacements: one man every ~20 s
  const t = L.step(60, () => g.crew.working > 0) / 60;
  return { pass: killed === men && still < 1e-6 && g.crew.working > 0, info: `${killed}/${men} killed by canister; mended in the next 10 s: ${L.r(still, 2)} hp; a replacement at work ${L.r(t + 10.5, 0)} s after: ${g.crew.working > 0} (${g.crew.list.map((e) => e.mode + '/' + e.goal).join(' ')}, scaffold ${g.crew.scaf ? g.crew.scaf.state : '-'})` };
});

test('scaffold_cycle', 'he', 'A scaffold goes up for the job, comes down after it; a blast beside it knocks it down; a destroyed workshop ends repairs', () => {
  const L = window.__lab;
  const g = L.setup([{ x: 30, y: 0, w: 1.4, h: 1.2, mat: 'stone' }, { x: 30, y: 1.2, w: 1.4, h: 1.2, mat: 'stone' }, { x: 40, y: 0, w: 1.2, h: 1, mat: 'stone', target: 'workshop' }], { live: true });
  g.artT = g.barT = 999; g.repT = 0;
  const b = L.b(1); b.hp = b.maxHp * 0.7;
  let up = false;
  L.step(40, () => { if (g.crew.scaf && g.crew.scaf.built && g.crew.scaf.members.some((m) => m.mesh.visible)) up = true; return up && g.crew.working > 0; });
  // made good, struck and taken away
  let struck = false;
  L.step(60, () => { if (g.crew.scaf && g.crew.scaf.state === 'strike') struck = true; return struck && !g.crew.scaf; });
  const mended = b.hp >= b.maxHp * 0.97, gone = !g.crew.scaf;
  // a second job: blow its scaffold down
  b.hp = b.maxHp * 0.5;
  L.step(40, () => g.crew.scaf && g.crew.scaf.built);
  const had = !!(g.crew.scaf && g.crew.scaf.built);
  g.explode(28.6, 1, 2, 60, { source: 'test' });
  L.step(0.2);
  const blown = had && !g.crew.scaf && g.crew.fallen.length > 0;
  // the workshop goes: no more repairs
  g.destroyBlock(L.b(2));
  const hp = b.hp;
  L.step(25);
  return { pass: up && mended && struck && gone && blown && b.hp === hp && !g.crew.job, info: `up ${up}, block mended ${mended}, struck ${struck}, removed ${gone}; blast knocked it down ${blown}; workshop gone: mended ${L.r(b.hp - hp, 2)} hp after` };
});

// ───────────────────────── the machine-gun post (src/mg.ts) ─────────────────────────
// (the lab level has no era: the modern, water-cooled gun; L.step does not touch the MG)
test('mg_infantry', 'mg', 'The machine gun kills unarmoured infantry, but clearing a file of six takes seconds (mean of three runs)', () => {
  const L = window.__lab;
  const runs = [];
  for (let r = 0; r < 3; r++) {
    const g = L.setup([], { stats: { cannonHp: 9999 } });
    for (const x of [14, 15.5, 17, 18.5, 20, 21.5]) g.spawnSoldier(x);
    L.step(1);
    let t = 99;
    const n = L.mgFire(20, () => { const s = g.soldiers.find((q) => !q.dead); return s && { x: s.x, y: s.y + 0.55 }; }, (i) => { if (g.soldiers.every((q) => q.dead)) { t = i / 60; return true; } return false; });
    // (corpses are taken off the field after ~3.7 s, so count the clear by the stop time)
    runs.push({ t, n, left: g.soldiers.filter((s) => !s.dead).length });
  }
  const mean = runs.reduce((a, r) => a + r.t, 0) / runs.length;
  return { pass: runs.every((r) => r.t < 99) && mean >= 1.6 && mean < 12, info: `file of six cleared in ${runs.map((r) => (r.t < 99 ? L.r(r.t, 1) : `not (${r.left} left)`)).join(', ')} s (${runs.map((r) => r.n).join(', ')} rounds)` };
});

test('mg_engineer', 'mg', 'Engineers are men in the open too', () => {
  const L = window.__lab; const g = L.setup([]);
  g.spawnSoldier(18);
  const s = g.soldiers[0]; s.eng = true;
  const n = L.mgFire(6, () => ({ x: s.x, y: s.y + 0.55 }), () => s.dead);
  return { pass: s.dead, info: `engineer ${s.dead ? 'down' : 'standing'} after ${n} rounds` };
});

test('mg_shield', 'mg', 'Shields stop machine-gun fire from the front; sustained fire wears the shield through', () => {
  const L = window.__lab; const g = L.setup([], { stats: { cannonHp: 9999 } });
  g.spawnSoldier(17, true);
  const s = g.soldiers[0];
  L.step(1);
  const n1 = L.mgFire(1.5, () => ({ x: s.x, y: s.y + 0.6 }));
  const alive1 = !s.dead, sh1 = s.shield;
  let n2 = 0;
  for (let k = 0; k < 6 && !s.dead; k++) { n2 += L.mgFire(4, () => ({ x: s.x, y: s.y + 0.6 }), () => s.dead); L.step(3); }
  return { pass: alive1 && sh1 < 70 && s.dead, info: `after ${n1} rounds: ${alive1 ? 'alive' : 'dead'}, shield ${L.r(sh1, 0)}/70; down after ${n1 + n2} rounds` };
});

test('mg_armour', 'mg', 'Machine-gun fire does nothing to armoured cars and tanks (sparks only)', () => {
  const L = window.__lab; const g = L.setup([], { stats: { cannonHp: 9999 } });
  g.motor.launch('car', null, 24); g.motor.launch('tank', null, 32);
  const [car, tank] = g.motor.units;
  const h0 = [car.hp, tank.hp];
  const n = L.mgFire(5, () => ({ x: car.x, y: car.y + 1 })) + L.mgFire(5, () => ({ x: tank.x, y: tank.y + 1 }));
  return { pass: car.hp === h0[0] && tank.hp === h0[1] && car.wreckT < 0 && tank.wreckT < 0, info: `${n} rounds: car ${L.r(car.hp, 0)}/${h0[0]}, tank ${L.r(tank.hp, 0)}/${h0[1]}` };
});

test('mg_masonry', 'mg', 'Against masonry it only pockmarks (no structural damage)', () => {
  const L = window.__lab; const g = L.setup([{ x: 26, y: 0, w: 1.5, h: 3, mat: 'stone' }]);
  const n = L.mgFire(3, () => ({ x: 26.5, y: 1.5 }));
  L.step(0.2);
  const marks = g.frac.state(L.b(0)).marks.length;
  return { pass: L.dealt(0) === 0 && marks > 0, info: `${n} rounds: ${L.r(L.dealt(0), 1)} damage, ${marks} pockmark patch(es)` };
});

test('mg_air', 'mg', 'Machine-gun fire hurts a gyrocopter a little and an airship next to nothing', () => {
  const L = window.__lab; const g = L.setup([]);
  g.air.launch('gyro', null, { x: 22, y: 12 });
  const u = g.air.units[0];
  const n1 = L.mgFire(3, () => (u.down ? null : { x: u.x, y: u.y }), () => u.down);
  const gyro = 1 - Math.max(0, u.hp) / u.maxHp;
  g.air.launch('airship', null, { x: 30, y: 20 });
  const a = g.air.units.find((q) => q.kind === 'airship');
  const n2 = L.mgFire(4, () => ({ x: a.x, y: a.y }));
  const ship = 1 - a.hp / a.maxHp;
  return { pass: gyro > 0.1 && ship < 0.05, info: `gyrocopter lost ${L.r(gyro * 100, 0)}% in ${n1} rounds, airship ${L.r(ship * 100, 1)}% in ${n2}` };
});

test('mg_overheat', 'mg', 'Continuous fire boils the jacket: the gun locks until it cools, then fires again; an empty strip is reloaded', () => {
  const L = window.__lab; const g = L.setup([]);
  const m = g.mg;
  let hotAt = -1, backAt = -1, reloadAt = -1;
  const n = L.mgFire(30, () => ({ x: 40, y: 15 }), (i) => {
    if (m.overheated && hotAt < 0) hotAt = i / 60;
    if (hotAt >= 0 && backAt < 0 && !m.overheated) backAt = i / 60;
    if (m.reloadT > 0 && reloadAt < 0) reloadAt = i / 60;
    return false;
  });
  const steady = m.spec.rate * 30;
  return { pass: hotAt > 3 && hotAt < 16 && backAt > hotAt + 1.5 && reloadAt > 0 && n < steady * 0.85, info: `overheated at ${L.r(hotAt, 1)} s, firing again at ${L.r(backAt, 1)} s, strip reload at ${L.r(reloadAt, 1)} s; ${n} rounds in 30 s (${steady} at the cyclic rate)` };
});

test('mg_cannon_reload', 'mg', 'The cannon keeps reloading while the machine gun is manned', () => {
  const L = window.__lab; const g = L.setup([]);
  g.mg.active = true; g.mg.trigger = true; g.reload = 3;
  for (let i = 0; i < 60; i++) { L.off(); g.update(1 / 60); }
  g.mg.trigger = false;
  return { pass: Math.abs(g.reload - 2) < 0.05 && g.mg.fired > 3, info: `cannon reload 3.0 → ${L.r(g.reload, 2)} s over 1 s of MG fire (${g.mg.fired} rounds)` };
});

test('fall_damage', 'shell', 'Falls hurt: ordinary blocks take minor damage growing with height (capped), objectives much more, a munitions store dropped a storey goes up', () => {
  const L = window.__lab; const out = {};
  const drop = (mat, target, h) => {
    L.setup([{ x: 30, y: 0, w: 1.2, h: 1, mat, target }]);
    // (the loader seats blocks on what is under them: lift this one to the drop height after loading)
    const bl = L.b(0); bl.body.setTranslation({ x: 30.6, y: h + 0.5 }, true); bl.body.setLinvel({ x: 0, y: 0 }, true); bl.body.wakeUp(); bl.lastVel = { x: 0, y: 0 };
    L.step(2.5);
    return L.b(0).dead ? 1 : L.frac(0);
  };
  for (const [k, mat, target] of [['stone', 'stone', undefined], ['wood', 'wood', undefined], ['hq', 'stone', 'command'], ['ammo', 'crate', 'ammo']]) out[k] = [1, 3, 5].map((h) => drop(mat, target, h));
  const pct = (a) => a.map((v) => (v === 1 ? 'gone' : Math.round(v * 100) + '%')).join('/');
  const pass = out.stone[0] < 0.08 && out.stone[2] > out.stone[1] && out.stone[2] <= 0.31 && out.wood[2] <= 0.31
    && out.hq[1] > out.stone[1] * 2.5 && out.hq[2] > 0.3 && out.ammo[1] === 1;
  return { pass, info: `1/3/5 m drops: stone ${pct(out.stone)}, timber ${pct(out.wood)}, HQ ${pct(out.hq)}, munitions ${pct(out.ammo)}` };
});

// ───────────────────────── runner ─────────────────────────
module.exports = { installLab };
if (require.main === module) (async () => {
  const only = process.argv[2] ? process.argv[2].split(',') : null;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  let pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5188') + '/?dev');
  await page.waitForFunction(() => window.siege && window.siege.game, null, { timeout: 90000 });
  await page.evaluate(`(${installLab.toString()})()`);
  await page.evaluate(() => window.__lab.init());
  const rows = [];
  for (const t of T) {
    if (only && !only.includes(t.id) && !only.includes(t.ammo)) continue;
    pageErrors = [];
    let r;
    try {
      r = await page.evaluate(`(${t.fn})()`);
    } catch (e) {
      r = { pass: false, info: 'threw: ' + String(e.message || e).split('\n')[0] };
    }
    if (pageErrors.length) r = { pass: false, info: `${r.info} | pageerror: ${pageErrors[0]}` };
    rows.push({ ...t, ...r });
    console.log(`${r.pass ? 'PASS' : t.soft ? 'SOFT' : 'FAIL'}  ${t.id.padEnd(18)} ${t.ammo.padEnd(10)} ${r.info}`);
  }
  const fails = rows.filter((r) => !r.pass && !r.soft);
  console.log('\n| result | test | munition | claim | measured |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.pass ? 'PASS' : r.soft ? 'SOFT' : 'FAIL'} | ${r.id} | ${r.ammo} | ${r.claim} | ${r.info} |`);
  const softFails = rows.filter((r) => !r.pass && r.soft).length;
  console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} pass, ${fails.length} fail${softFails ? `, ${softFails} soft fail (reported, not counted)` : ''}`);
  await browser.close();
  process.exitCode = fails.length ? 1 : 0;
})();
