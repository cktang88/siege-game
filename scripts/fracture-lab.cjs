/*
  Fracture lab: fires each munition at test blocks of each material and checks what src/fracture.ts
  makes of it: splits (piece counts, cut direction), marks (craters, scorch, holes, bores, dents,
  pockmarks, gouges), hits-to-break per material, obliquity / speed / ricochet, objectives, caps.
  Prints a PASS/FAIL table; exit code 1 if anything fails.

    npx vite --port 5195 --host 127.0.0.1 --strictPort &      # then:
    BASE=http://127.0.0.1:5195 NODE_PATH=$(npm root -g) node scripts/fracture-lab.cjs [test ids, comma separated]
    SHOTS=/some/dir ... also saves screenshots of the showcase scenes (1600x900)

  Lab scenes sit at x >= 20 on flat ground; 'rock' blocks are indestructible backstops.
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

function installLab() {
  const L = {};
  window.__flab = L;
  L.init = async () => {
    L.hud = await import('/src/hud.ts');
    L.cfg = await import('/src/config.ts');
    L.prog = await import('/src/progress.ts');
    L.dec = await import('/src/decals.ts');
  };
  L.setup = (blocks, o = {}) => {
    const S = window.siege;
    const lvl = {
      id: 'flab', name: 'Fracture lab', brief: '', intel: [], budget: 1, wind: [0, 0], parTime: 60, ground: [[-80, 0], [400, 0]], cannonX: 0,
      blocks: [...blocks, ...(o.noAnchor ? [] : [{ x: 390, y: 0, w: 1, h: 1, mat: 'rock', target: 'command' }])],
      houses: [], objectives: o.objectives || ['command'], stars: [1, 2, 3], collateralMult: 1,
    };
    S.level = lvl;
    S.game.stats = Object.assign(L.prog.baseStats(), o.stats || {});
    S.game.load(lvl);
    const inv = {};
    for (const a of L.cfg.SHOP_AMMO()) inv[a.id] = 99;
    L.hud.startBattle(inv, 0, 999999);
    S.mode = 'map';
    const g = S.game;
    g.wind = 0; g.reload = 0;
    L.g = g;
    L.off();
    L.n0 = g.blocks.length;
    return g;
  };
  L.off = () => { const g = L.g; g.artT = g.barT = g.repT = g.rebT = 999; g.air.spawnT = 999; };
  L.step = (secs) => { const g = L.g; for (let i = 0; i < Math.round(secs * 60); i++) { L.off(); g.reload = 0; g.update(1 / 60); } };
  L.b = (i) => L.g.blocks[i];
  L.shoot = (id, x, y, vx, vy, extra) => L.g.spawnProjectile(L.cfg.AMMO_BY_ID[id], x, y, vx, vy, false, extra || {});
  /** live pieces descended from block i (heir chains and fragments created since setup) */
  L.pieces = (i) => {
    const g = L.g, root = g.blocks[i];
    if (!root.dead) return [root];
    return g.blocks.slice(L.n0).filter((b) => !b.dead && b.frag);
  };
  L.marks = (b) => L.g.frac.marks(b).map((m) => m.type);
  L.T = { CRATER: 1, SCORCH: 2, HOLE: 3, DENT: 4, POCK: 5, BORE: 6, BORE_END: 7, GOUGE: 8 };
  L.has = (b, t) => L.marks(b).includes(L.T[t]);
  L.allMarks = () => { const out = {}; for (const b of L.g.blocks) if (!b.dead) for (const t of L.marks(b)) out[t] = (out[t] || 0) + 1; return out; };
  L.r = (v, n = 2) => +(+v).toFixed(n);
  /** world-space outline edges of a block, as unit directions */
  L.edges = (b) => {
    const d = b.def, w = b.w, h = b.h, rot = b.body.rotation();
    const pts = d.poly ? d.poly.map(([x, y]) => [x - w / 2, y - h / 2]) : [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const c = Math.cos(rot), s = Math.sin(rot);
    return pts.map((p, k) => { const q = pts[(k + 1) % pts.length]; const ex = q[0] - p[0], ey = q[1] - p[1]; const l = Math.hypot(ex, ey); return { x: (ex * c - ey * s) / l, y: (ex * s + ey * c) / l, len: l }; });
  };
  L.area = (b) => {
    const d = b.def; if (!d.poly) return b.w * b.h;
    let a = 0; for (let k = 0; k < d.poly.length; k++) { const p = d.poly[k], q = d.poly[(k + 1) % d.poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2);
  };
  /** fire round shot square at block i (aimed at its centre) until it breaks; returns hits taken (99 = never) */
  L.hitsToBreak = (mat, speed, max) => {
    // a course block set in a wall: bedrock below, above and behind it, as masonry round it would be
    L.setup([{ x: 30, y: 1, w: 1, h: 1, mat }, { x: 28, y: 0, w: 7, h: 1, mat: 'rock' }, { x: 31.0, y: 1, w: 3, h: 3, mat: 'rock' }, { x: 29.9, y: 2, w: 1.1, h: 0.6, mat: 'rock' }]);
    const b = L.b(0);
    let marks = 0;
    for (let k = 1; k <= max; k++) {
      const t = b.body.translation();
      L.shoot('shell', t.x - 3, t.y, speed, 1.5);
      L.step(1.6);
      for (const p of L.g.projectiles) if (!p.dead && p.inert !== undefined) L.g.removeProjectile(p);
      if (b.dead) return { hits: k, marks };
      marks = L.marks(b).length;
    }
    return { hits: 99, marks, hp: L.r(b.hp / b.maxHp) };
  };
}

const T = [];
const test = (id, claim, fn) => T.push({ id, claim, fn: fn.toString() });

// ───────────── hits to break (round shot ~28 m/s, square on, 1 m blocks against a backstop) ─────────────
test('break_hits', 'Round shot at 28 m/s breaks timber/plaster/tile in 1-2 hits, masonry 3-4, firebrick 3-5, concrete 6-9; steel only dents through 8', () => {
  const L = window.__flab;
  // materials raised in the damage pass (BALANCE.md): masonry 170 hp takes 3 (was 2-3), firebrick 4, concrete 7-8 (was 6-7)
  const want = { wood: [1, 2], plaster: [1, 2], tile: [1, 2], stone: [3, 4], fireproof: [3, 5], concrete: [6, 9], steel: [9, 99] };
  const res = {}, bad = [];
  for (const m of Object.keys(want)) {
    const r = L.hitsToBreak(m, 28, m === 'steel' ? 8 : 12);
    res[m] = r.hits === 99 ? `>${m === 'steel' ? 8 : 12}` : r.hits;
    const h = r.hits === 99 ? 99 : r.hits;
    if (h < want[m][0] || h > want[m][1]) bad.push(m);
  }
  return { pass: !bad.length, info: Object.entries(res).map(([k, v]) => `${k} ${v}`).join(', ') + (bad.length ? ` (off: ${bad.join(',')})` : '') };
});

test('break_marks_accumulate', 'Each round-shot hit on masonry adds marks before it breaks', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 1.5, mat: 'stone' }, { x: 31.52, y: 0, w: 1, h: 3, mat: 'rock' }]);
  const b = L.b(0), seen = [];
  for (let k = 0; k < 3 && !b.dead; k++) {
    const t = b.body.translation();
    L.shoot('shell', t.x - 3, t.y + (k - 1) * 0.4, 28, 1.5); L.step(1.6);
    if (!b.dead) seen.push(L.marks(b).filter((m) => m === L.T.CRATER).length);
  }
  return { pass: seen.length >= 2 && seen[1] > seen[0] && seen[0] >= 1, info: `craters after each hit: ${seen.join(' → ')}${b.dead ? ' then broke' : ''}` };
});

// ───────────── armour-piercing ─────────────
test('ap_cut_column', 'AP through a slender stone column cuts it in two along the shot line (with bore marks)', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 0.5, h: 3, mat: 'stone' }]);
  L.shoot('ap', 26, 1.6, 34, 0);
  L.step(0.15);
  const ps = L.pieces(0).filter((b) => L.area(b) > 0.2);
  // the cut edge runs along the shot direction (horizontal here)
  const cutEdge = ps.length >= 2 && ps.every((b) => L.edges(b).some((e) => Math.abs(e.y) < 0.15 && e.len > 0.3));
  const bores = ps.filter((b) => L.has(b, 'HOLE') || L.has(b, 'BORE')).length;
  return { pass: L.b(0).dead && ps.length >= 2 && cutEdge && bores >= 1, info: `${ps.length} pieces, cut edge along shot: ${cutEdge}, pieces with hole/bore marks: ${bores}` };
});

test('ap_cut_follows_shot', 'An AP shot crossing a beam at an angle cuts it along its own (slanted) path', () => {
  const L = window.__flab;
  // a beam lying on two rock piers; AP comes in steeply from the upper left
  L.setup([{ x: 29, y: 0, w: 0.6, h: 1.2, mat: 'rock' }, { x: 33.4, y: 0, w: 0.6, h: 1.2, mat: 'rock' }, { x: 29, y: 1.2, w: 5, h: 0.5, mat: 'wood' }]);
  const a = -40 * Math.PI / 180, sp = 34;
  // aim through the beam centre (31.5, 1.45)
  const x0 = 31.5 - Math.cos(a) * 3, y0 = 1.45 - Math.sin(a) * 3;
  L.shoot('ap', x0, y0, Math.cos(a) * sp, Math.sin(a) * sp);
  L.step(0.12);
  const ps = L.pieces(2).filter((b) => L.area(b) > 0.2);
  const dx = Math.cos(a), dy = Math.sin(a);
  const along = ps.length >= 2 && ps.every((b) => L.edges(b).some((e) => Math.abs(e.x * dy - e.y * dx) < 0.2 && e.len > 0.2));
  return { pass: ps.length >= 2 && along, info: `${ps.length} pieces (${ps.map((b) => L.edges(b).map((e) => Math.round(Math.atan2(e.y, e.x) * 57.3)).join('/')).join('; ')}); a cut edge within ~11° of the 40° shot line: ${along}` };
});

test('ap_bore_thick', 'AP through a thick masonry block bores it (entry/exit holes, bore) and it survives', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.6, h: 1.6, mat: 'stone' }]);
  L.shoot('ap', 26, 0.8, 34, 0);
  L.step(0.4);
  const b = L.b(0);
  return { pass: !b.dead && L.has(b, 'BORE') && L.marks(b).filter((m) => m === L.T.HOLE).length >= 2, info: `${b.dead ? 'destroyed' : 'standing'}, marks ${L.marks(b).join(',')}` };
});

test('ap_steel_dent', 'Armor plate stops AP: dent and a shallow hole, no split', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 0.6, h: 2, mat: 'steel' }]);
  L.shoot('ap', 26, 1, 34, 0); L.step(0.6);
  const b = L.b(0);
  return { pass: !b.dead && L.has(b, 'DENT') && L.has(b, 'HOLE'), info: `${b.dead ? 'split/destroyed' : 'intact'}, marks ${L.marks(b).join(',')}` };
});

// ───────────── HE, timber, steel, earth ─────────────
test('he_shatter_stone', 'HE against a masonry wall cracks it (2-3 pieces) with scorch; a second HE on the same face shatters what is left', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.2, h: 2.4, mat: 'stone' }, { x: 31.25, y: 0, w: 1, h: 3, mat: 'rock' }]);
  const s0 = L.g.frac.stats.frags;
  L.shoot('he', 27, 1.2, 28, 1); L.step(0.25);
  const ps = L.pieces(0), frags = L.g.frac.stats.frags - s0;
  const scorch = ps.some((b) => L.has(b, 'SCORCH'));
  // graded (BALANCE.md, damage pass): one HE takes about half a big masonry block and cracks it; it no longer shatters it outright
  const first = ps.length + frags;
  const sh0 = L.g.frac.stats.shatters;
  L.shoot('he', 27, 1.2, 28, 1); L.step(0.25);
  const sh = L.g.frac.stats.shatters - sh0, left = L.pieces(0).length;
  return { pass: L.b(0).dead && first >= 2 && first <= 3 && scorch && (sh >= 1 || left < first), info: `first HE: ${ps.length} physics pieces + ${frags} fragments, scorch on pieces: ${scorch}; second HE: ${sh} shattered, ${left} pieces left` };
});

test('he_scorch_survivor', 'A distant HE burst only scorches a masonry wall (no split)', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 3, mat: 'stone' }]);
  L.shoot('he', 27.2, 2.6, 0, -15); L.step(0.6);
  const b = L.b(0);
  return { pass: !b.dead && L.has(b, 'SCORCH'), info: `${b.dead ? 'split' : 'intact'} hp ${L.r(b.hp / b.maxHp)}, marks ${L.marks(b).join(',')}` };
});

test('timber_splinter', 'Heavy shot on a timber beam splinters it along the grain (long pieces)', () => {
  const L = window.__flab;
  L.setup([{ x: 29, y: 0, w: 0.6, h: 1.2, mat: 'rock' }, { x: 33.4, y: 0, w: 0.6, h: 1.2, mat: 'rock' }, { x: 29, y: 1.2, w: 5, h: 0.6, mat: 'wood' }]);
  L.shoot('heavy', 31.5, 4, 0, -24); L.step(0.35);
  const ps = L.pieces(2).filter((b) => L.area(b) > 0.1);
  const long = ps.filter((b) => b.w / b.h >= 3).length;
  return { pass: L.b(2).dead && ps.length >= 2 && long >= 2, info: `${ps.length} pieces, ${long} long (w/h >= 3): ${ps.map((b) => `${L.r(b.w, 1)}x${L.r(b.h, 2)}`).join(' ')}` };
});

test('steel_dents', 'Round shot and HE on armour plate leave dents, never split it', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1, h: 2.4, mat: 'steel' }, { x: 31.02, y: 0, w: 1, h: 3, mat: 'rock' }]);
  L.shoot('shell', 27, 0.6, 28, 1); L.step(1.2);
  L.shoot('he', 27, 1.8, 28, 1); L.step(1.2);
  const b = L.b(0);
  return { pass: !b.dead && L.has(b, 'DENT'), info: `${b.dead ? 'split' : 'intact'}, marks ${L.marks(b).join(',')}` };
});

test('earth_erodes', 'A drill blowing under earthworks takes mass off it (one smaller block, no chunks)', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 2, h: 2, mat: 'earth' }]);
  L.shoot('drill', 26, 0.6, 14, -2); L.step(2.5);
  const ps = L.pieces(0);
  const a = ps.reduce((s, b) => s + L.area(b), 0);
  return { pass: L.b(0).dead && ps.length === 1 && a < 3.9 && a > 1.2, info: `${ps.length} piece(s), area 4 → ${L.r(a)}` };
});

// ───────────── the rest of the rack ─────────────
test('canister_pocks', 'Canister leaves pockmarks only on masonry', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 3, mat: 'stone' }]);
  for (let k = 0; k < 10; k++) L.shoot('canister', 26, 1 + k * 0.12, 30, 0, { pellet: true });
  L.step(0.5);
  const b = L.b(0);
  const ms = L.marks(b);
  return { pass: !b.dead && ms.length > 0 && ms.every((m) => m === L.T.POCK), info: `marks ${ms.join(',')}` };
});

test('incendiary_scorch', 'Incendiary on masonry scorches, no split', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 3, mat: 'stone' }]);
  L.shoot('incendiary', 27, 1.5, 28, 1); L.step(0.6);
  const b = L.b(0);
  return { pass: !b.dead && L.has(b, 'SCORCH') && !L.has(b, 'CRATER'), info: `marks ${L.marks(b).join(',')}` };
});

test('sticky_crater', 'A sticky charge on a big masonry block shatters it from where it stuck (scorch/crater)', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 2, h: 2, mat: 'stone' }]);
  L.shoot('sticky', 27.5, 1.5, 12, 1); L.step(4);
  const ps = L.pieces(0);
  const m = ps.some((b) => L.has(b, 'SCORCH') || L.has(b, 'CRATER'));
  return { pass: L.b(0).dead && (ps.length >= 2 || L.g.frac.stats.shatters > 0), info: `${ps.length} pieces; marks on pieces: ${m}; shatters ${L.g.frac.stats.shatters}` };
});

test('bunker_internal', 'Bunker buster: bores into a concrete bunker wall, holes the block it stops in, then shatters it from inside', () => {
  const L = window.__flab;
  L.setup([0, 1, 2].map((k) => ({ x: 30 + k * 1.2, y: 0, w: 1.2, h: 2.4, mat: 'concrete' })));
  L.shoot('bunker', 26, 1.2, 32, 0);
  let host = null;
  for (let i = 0; i < 30 && !host; i++) { L.step(1 / 60); const p = L.g.projectiles.find((q) => q.stuck && q.stuck.block); if (p) host = p.stuck.block; }
  const hole = !!host && L.has(host, 'HOLE');
  const s0 = L.g.frac.stats.shatters;
  L.step(1.2);
  const shat = L.g.frac.stats.shatters - s0;
  return { pass: hole && host.dead && (shat >= 1 || L.g.frac.stats.rubble > 0), info: `embedded with an entry hole: ${hole}; host ${host && host.dead ? 'broken' : 'standing'}; shatters ${shat}, rubble ${L.g.frac.stats.rubble}` };
});

// ───────────── velocity, obliquity, ricochet ─────────────
test('angle_square_vs_steep', 'Heavy shot square on splits a masonry slab; the same round at a steep angle (cos 0.42) only pits/gouges it', () => {
  const L = window.__flab;
  const run = (deg) => {
    L.setup([{ x: 29.8, y: 0, w: 2.4, h: 1, mat: 'stone' }]);
    const a = -deg * Math.PI / 180, sp = 28;
    L.shoot('heavy', 31 - Math.cos(a) * 2.5, 1 + 0.42 - Math.sin(a) * 2.5, Math.cos(a) * sp, Math.sin(a) * sp);
    L.step(0.4);
    return { split: L.b(0).dead, marks: L.b(0).dead ? [] : L.marks(L.b(0)) };
  };
  const sq = run(90), steep = run(25);
  return { pass: sq.split && !steep.split && steep.marks.includes(L.T.GOUGE), info: `square: ${sq.split ? 'split' : 'held'}; 25° steep: ${steep.split ? 'split' : 'held'}, marks ${steep.marks.join(',')}` };
});

test('ricochet_gouge', 'A round glancing off sloped steel leaves only a gouge streak, never a split', () => {
  const L = window.__flab;
  L.setup([{ x: 29, y: 0, w: 4, h: 0.8, mat: 'steel' }]);
  const a = -18 * Math.PI / 180, sp = 30;
  L.shoot('heavy', 31 - Math.cos(a) * 2.5, 0.8 + 0.42 - Math.sin(a) * 2.5, Math.cos(a) * sp, Math.sin(a) * sp);
  L.step(0.5);
  const b = L.b(0);
  return { pass: !b.dead && L.has(b, 'GOUGE') && !L.has(b, 'CRATER'), info: `${b.dead ? 'split' : 'intact'}, marks ${L.marks(b).join(',')}` };
});

test('fast_vs_slow', 'Heavy shot at 28 m/s splits a masonry block; at 8 m/s it only scuffs it', () => {
  const L = window.__flab;
  const run = (v) => {
    L.setup([{ x: 30, y: 0, w: 1.5, h: 1.5, mat: 'stone' }, { x: 31.52, y: 0, w: 1, h: 3, mat: 'rock' }]);
    L.shoot('heavy', 29.2, 0.75, v, 0.3); L.step(0.5);
    const b = L.b(0);
    return { split: b.dead, marks: b.dead ? [] : L.marks(b), hp: L.r(b.hp / b.maxHp) };
  };
  const f = run(28), s = run(8);
  return { pass: f.split && !s.split && s.marks.length > 0 && !s.marks.includes(L.T.CRATER), info: `fast: ${f.split ? 'split' : 'held'}; slow: ${s.split ? 'split' : 'held'} hp ${s.hp}, marks ${s.marks.join(',')}` };
});

// ───────────── objectives, links, caps ─────────────
test('objective_whole', 'An objective hit by a shell dies whole and is counted; HE near one never leaves a split objective', () => {
  const L = window.__flab;
  L.setup([{ x: 30, y: 0, w: 1.5, h: 1.5, mat: 'stone', target: 'command' }], { noAnchor: true });
  L.shoot('shell', 27, 0.75, 28, 1); L.step(1);
  const a = L.g.targetsDestroyed.command || 0;
  const split1 = L.g.blocks.some((b) => b.frag && b.target);
  L.setup([{ x: 30, y: 0, w: 2, h: 2, mat: 'concrete', target: 'command' }], { noAnchor: true });
  L.shoot('he', 28.5, 3, 0, -10); L.step(1);
  const b = L.b(0);
  const split2 = L.g.blocks.some((q) => q.frag && q.target);
  const ok2 = b.dead ? (L.g.targetsDestroyed.command || 0) === 1 : true;
  return { pass: a === 1 && !split1 && !split2 && ok2, info: `shell: destroyed count ${a}; HE: ${b.dead ? 'destroyed, counted ' + (L.g.targetsDestroyed.command || 0) : 'standing hp ' + L.r(b.hp / b.maxHp)}; target pieces: ${split1 || split2}` };
});

test('room_relink', 'A room floor that splits hands its people to the piece under them; the room fails when pieces fall', () => {
  const L = window.__flab;
  // two columns and a floor slab; room on the slab
  const lvl = [{ x: 30, y: 0, w: 0.5, h: 2, mat: 'stone' }, { x: 34.5, y: 0, w: 0.5, h: 2, mat: 'stone' }, { x: 30, y: 2, w: 5, h: 0.5, mat: 'wood' },
    { x: 30, y: 2.5, w: 0.5, h: 2, mat: 'stone' }, { x: 34.5, y: 2.5, w: 0.5, h: 2, mat: 'stone' }, { x: 30, y: 4.5, w: 5, h: 0.5, mat: 'wood' }];
  const S = window.siege;
  L.setup(lvl);
  S.level.rooms = [{ x0: 30.5, x1: 34.5, y0: 2.5, y1: 4.5, floorIdx: 2, deps: [2, 3, 4, 5] }];
  S.game.garrison.spawn(S.level, S.game.root);
  const rt = S.game.garrison.rooms.list[0];
  const floor0 = rt.floor;
  // AP straight down through the roof and the floor slab, just off the room's middle
  L.shoot('ap', 32.1, 8, 0, -34);
  L.step(0.3);
  const relinked = floor0.dead && rt.floor && !rt.floor.dead && rt.floor !== floor0;
  const depsOk = rt.deps.every((b) => !b.dead || b === floor0) && !rt.deps.includes(floor0);
  const riders = S.game.garrison.list.filter((d) => d.floor === floor0).length;
  return { pass: !!relinked && depsOk && riders === 0, info: `floor relinked ${!!relinked}, deps updated ${depsOk}, people still on the old floor ${riders}` };
});

test('cap_bodies', 'A barrage of HE on a big masonry wall keeps live blocks, rubble and fragments under their caps', () => {
  const L = window.__flab;
  const wall = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 8; y++) wall.push({ x: 30 + x, y, w: 1, h: 1, mat: 'stone' });
  L.setup(wall);
  let maxLive = 0, maxFx = 0;
  for (let k = 0; k < 12; k++) {
    L.shoot('he', 26, 1 + (k % 6), 28, 1); L.shoot('heavy', 26, 2 + (k % 5), 28, 1);
    for (let i = 0; i < 30; i++) { L.step(1 / 60); maxLive = Math.max(maxLive, L.g.blocks.filter((b) => !b.dead).length); maxFx = Math.max(maxFx, L.g.frac.fx.length); }
  }
  return { pass: maxLive <= 600 && maxFx <= 80, info: `peak live blocks ${maxLive}, peak fragments ${maxFx}, splits ${L.g.frac.stats.splits}, rubble ${L.g.frac.stats.rubble}` };
});

// ───────────── showcase screenshots ─────────────
async function shots(page, dir) {
  const fs = require('fs');
  fs.mkdirSync(dir, { recursive: true });
  await page.addStyleTag({ content: 'body > *:not(canvas) { display: none !important; } canvas { display: block !important; }' });
  const scenes = [
    ['ap_cut_beam', () => { const L = window.__flab;
      L.setup([{ x: 28, y: 0, w: 0.6, h: 1.6, mat: 'rock' }, { x: 34.4, y: 0, w: 0.6, h: 1.6, mat: 'rock' }, { x: 28, y: 1.6, w: 7, h: 0.5, mat: 'stone' }, { x: 37, y: 0, w: 0.5, h: 3.2, mat: 'stone' }]);
      const a = -35 * Math.PI / 180; L.shoot('ap', 31.2 - Math.cos(a) * 3, 1.85 - Math.sin(a) * 3, Math.cos(a) * 34, Math.sin(a) * 34);
      L.shoot('ap', 35.3, 1.2, 34, 0); L.step(0.5); return { x: 32.8, y: 2, h: 7 }; }],
    ['he_shatter_stone', () => { const L = window.__flab; const w = []; for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) w.push({ x: 30 + x * 1.2, y: y * 1.2, w: 1.2, h: 1.2, mat: 'stone' });
      L.setup(w); L.shoot('he', 27, 2.2, 28, 1); L.step(0.3); return { x: 32, y: 2.6, h: 9 }; }],
    ['timber_splinter', () => { const L = window.__flab; L.setup([{ x: 29, y: 0, w: 0.6, h: 1.2, mat: 'rock' }, { x: 33.4, y: 0, w: 0.6, h: 1.2, mat: 'rock' }, { x: 29, y: 1.2, w: 5, h: 0.6, mat: 'wood' }, { x: 29, y: 1.8, w: 5, h: 0.6, mat: 'wood' }]);
      L.shoot('heavy', 31.5, 5, 0, -24); L.step(0.4); for (const p of L.g.projectiles) L.g.removeProjectile(p); return { x: 31.5, y: 1.8, h: 6 }; }],
    ['marks_wall', () => { const L = window.__flab; L.setup([{ x: 30, y: 0, w: 3, h: 3.2, mat: 'stone' }]);
      L.shoot('shell', 27, 2.3, 28, 1); L.step(1.2); L.shoot('he', 27.4, 4, 0, -10); L.step(1); L.shoot('ap', 26, 0.7, 34, 0); L.step(0.4);
      for (let k = 0; k < 12; k++) L.shoot('canister', 26, 1.4 + k * 0.1, 30, 0, { pellet: true });
      L.step(0.4); L.shoot('shell', 28.6, 1.5, 8, 0.5); L.step(3); return { x: 31.5, y: 1.8, h: 5.5 }; }],
    ['steel_dents', () => { const L = window.__flab; L.setup([{ x: 30, y: 0, w: 1.4, h: 3, mat: 'steel' }, { x: 31.42, y: 0, w: 3, h: 5, mat: 'rock' }, { x: 29.4, y: 0, w: 0.58, h: 0.6, mat: 'rock' }]);
      L.shoot('shell', 27, 0.8, 28, 1); L.step(1); L.shoot('heavy', 27, 2.2, 26, 1); L.step(1); L.shoot('ap', 26, 1.5, 34, 0); L.step(0.6);
      L.shoot('shell', 27, 2.7, 28, 0.5); L.step(3); for (const p of L.g.projectiles) L.g.removeProjectile(p); return { x: 31, y: 1.6, h: 4.5 }; }],
  ];
  for (const [name, fn] of scenes) {
    await page.evaluate((src) => {
      const view = (0, eval)('(' + src + ')')();
      const S = window.siege, r = S.renderer;
      S.game.frameCamera = () => { r.cx = view.x; r.cy = view.y; r.viewH = view.h; };
      // smoke and flame would hide the stonework: clear them for the still
      r.smoke.parts.length = 0; r.flame.parts.length = 0; r.fire.parts.length = 0; r.debris.chunks.length = 0;
    }, fn.toString());
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${dir}/${name}.png` });
    console.log('saved', `${dir}/${name}.png`);
  }
}

(async () => {
  const only = process.argv[2] ? process.argv[2].split(',') : null;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5195') + '/?dev');
  await page.waitForFunction(() => window.siege && window.siege.game, null, { timeout: 120000 });
  await page.evaluate(`(${installLab.toString()})()`);
  await page.evaluate(() => window.__flab.init());
  let fail = 0;
  const rows = [];
  for (const t of T) {
    if (only && !only.includes(t.id)) continue;
    let r;
    try { r = await page.evaluate((src) => (0, eval)('(' + src + ')')(), t.fn); } catch (e) { r = { pass: false, info: 'ERROR ' + e.message.split('\n')[0] }; }
    if (!r.pass) fail++;
    rows.push(`${r.pass ? 'PASS' : 'FAIL'}  ${t.id.padEnd(24)} ${r.info}\n      ${t.claim}`);
    console.log(rows[rows.length - 1]);
  }
  console.log(`\n${rows.length - fail}/${rows.length} passed`);
  if (process.env.SHOTS) await shots(page, process.env.SHOTS);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
