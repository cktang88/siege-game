/*
  Fire lab: deterministic (seeded Math.random) fire-spread runs, stepped in-page at 60 Hz.
    lab       timber frame room A between a firebrick vault (crates inside) and a stone wall, shed B beyond
    crates    3x3 stack of munitions crates          tanks / bigtanks  rows of fuel tanks (first one destroyed)
    orient    burning timber with timbers above, left, right and below (seconds to catch each)
    outpost / kurogane   an incendiary-sized burst (r 2.2, ignite) on a central timber; kurogane0 = no fire
    big       largest themed level, every flammable block lit at once (fire-code timing)
  Each line is JSON: timeline every 5 s, per-group lit/destroyed counts, garrison casualties/fled, fire ms.

    npx vite --port 5184 --strictPort &      # then:
    node scripts/fire-lab.cjs [scenarios=lab,crates,tanks,orient,kurogane,outpost] [seeds=3] [wind=0]
    BASE=http://127.0.0.1:5173 node scripts/fire-lab.cjs

  Needs playwright (npm i -D playwright, or a global install).
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
const which = (process.argv[2] || 'lab,crates,tanks,orient,kurogane,outpost').split(',');
const seeds = +(process.argv[3] || 3);
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5184') + '/?dev');
  await page.waitForFunction(() => window.siege && window.siege.game, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const S = window.siege;
    const { startBattle } = await import('/src/hud.ts');
    const { THEMED, compose } = await import('/src/archetypes.ts');
    const { LEVELS } = await import('/src/levels.ts');
    const realRandom = Math.random;
    const seedRng = (s) => { let a = s >>> 0; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const base = (blocks, extra = {}) => ({ id: 'lab', name: 'Lab', brief: '', intel: [], budget: 1, wind: [0, 0], parTime: 60, ground: [[-80, 0], [300, 0]], cannonX: 0,
      blocks: [...blocks, { x: 160, y: 0, w: 1, h: 1, mat: 'stone', target: 'command' }], houses: [], objectives: ['command'], stars: [1, 2, 3], collateralMult: 1, ...extra });
    const W = (x, y, w, h, mat = 'wood', o = {}) => ({ x, y, w, h, mat, ...o });
    const labs = {
      lab: () => {
        const b = [];
        // firebrick vault (left) holding two crates and a timber shelf
        b.push(W(34, 0, 0.45, 2.5, 'fireproof'), W(39.55, 0, 0.45, 2.5, 'fireproof'), W(34, 2.5, 6, 0.45, 'fireproof'));
        b.push(W(35, 0, 1, 1, 'crate', { tag: 'vault' }), W(36.2, 0, 1, 1, 'crate', { tag: 'vault' }), W(37.6, 0, 1.6, 0.3, 'wood', { tag: 'vault' }));
        // timber frame room A: two storeys, plaster roof (touching vault right wall at x=40)
        b.push(W(40, 0, 6, 0.3, 'wood', { tag: 'A' }));
        for (const x of [40, 42.8, 45.6]) b.push(W(x, 0.3, 0.4, 2.4, 'wood', { tag: 'A' }));
        b.push(W(40, 2.7, 6, 0.3, 'wood', { tag: 'A' }));
        for (const x of [40, 45.6]) b.push(W(x, 3.0, 0.4, 2.0, 'wood', { tag: 'A' }));
        b.push(W(40, 5.0, 6, 0.3, 'plaster', { tag: 'A' }));
        // stone wall touching on the right
        b.push(W(46, 0, 1, 5.3, 'stone'));
        // timber shed B beyond the stone wall
        b.push(W(47, 0, 4, 0.3, 'wood', { tag: 'B' }), W(47, 0.3, 0.4, 2.2, 'wood', { tag: 'B' }), W(50.6, 0.3, 0.4, 2.2, 'wood', { tag: 'B' }), W(47, 2.5, 4, 0.3, 'wood', { tag: 'B' }));
        const rooms = [{ x0: 34.45, x1: 39.55, y0: 0, y1: 2.5, floorIdx: -1, deps: [0, 1, 2] }, { x0: 40.4, x1: 45.6, y0: 0.3, y1: 2.7, floorIdx: 6, deps: [7, 8, 9, 10] },
          { x0: 40.4, x1: 45.6, y0: 3.0, y1: 5.0, floorIdx: 10, deps: [11, 12, 13] }, { x0: 47.4, x1: 50.6, y0: 0.3, y1: 2.5, floorIdx: 15, deps: [16, 17, 18] }];
        return { lvl: base(b, { rooms }), ign: (g) => g.blocks.find((x) => x.def.tag === 'A' && x.def.y === 0.3 && x.def.x === 42.8) };
      },
      crates: () => {
        const b = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) b.push(W(60 + c * 1.0, r * 1.0, 1, 1, 'crate', { tag: 'C' }));
        return { lvl: base(b), ign: (g) => g.blocks[0] };
      },
      tanks: () => {
        const b = [];
        for (let i = 0; i < 5; i++) b.push(W(80 + i * 1.8, 0, 1.5, 2, 'fuel', { tag: 'T' }));
        return { lvl: base(b), ign: (g) => g.blocks[0], destroy: true };
      },
      bigtanks: () => {
        const b = [];
        let x = 80;
        for (let i = 0; i < 3; i++) { b.push(W(x, 0, 4, 4, 'fuel', { tag: 'T' })); b.push(W(x + 4.4, 0, 0.3, 2.6, 'steel'), W(x + 6.0, 0, 0.3, 2.6, 'steel'), W(x + 4.2, 2.6, 2.3, 0.25, 'steel')); x += 6.6; }
        return { lvl: base(b), ign: (g) => g.blocks[0], destroy: true };
      },
    };
    window.fireRun = (name, seed, secs = 60, windv = 0) => {
      seedRng(seed);
      const g = S.game;
      let L, ign, destroy = false, incAt = null;
      if (labs[name]) ({ lvl: L, ign, destroy } = labs[name]());
      else if (name === 'orient') {
        // a burning 1x0.5 timber block with identical timbers above, left, right and below it, each with a 0.05 m gap
        const b = [W(48, 0, 7, 0.5, 'stone'), W(51, 0.5, 1, 0.5, 'wood', { tag: 'below' }), W(51, 1.0, 1, 0.5, 'wood', { tag: 'src' }), W(51, 1.5, 1, 0.5, 'wood', { tag: 'above' }),
          W(49.95, 0.5, 1, 0.5, 'stone'), W(49.95, 1.0, 1, 0.5, 'wood', { tag: 'left' }), W(52.05, 0.5, 1, 0.5, 'stone'), W(52.05, 1.0, 1, 0.5, 'wood', { tag: 'right' })];
        L = base(b); ign = (g) => g.blocks.find((x) => x.def.tag === 'src');
      } else if (name === 'kurogane') { L = compose(THEMED.find((t) => t.id === 'kurogane')); }
      else if (name === 'kurogane0') { L = compose(THEMED.find((t) => t.id === 'kurogane')); ign = () => null; }
      else if (name === 'outpost') { L = LEVELS.find((l) => l.id === 'outpost'); }
      else if (name === 'big') {
        // the largest composed level, every flammable block lit at once: worst case for the fire code
        let best = null;
        for (const t of THEMED) { const l = compose(t); if (!best || l.blocks.length > best.blocks.length) best = l; }
        L = best; ign = (g) => { for (const b of g.blocks) if (b.mat.flammable && !b.mat.volatile && b.target !== 'ammo') g.ignite(b); return null; }; destroy = false;
      }
      L = { ...L, wind: [windv, windv] };
      S.level = L; g.load(L); startBattle({ incendiary: 3 }, 0, 9999);
      g.artT = g.barT = g.repT = g.rebT = 999; if (g.air) g.air.spawnT = 999;
      // settle
      for (let i = 0; i < 120; i++) g.update(1 / 60);
      g.artT = g.barT = g.repT = g.rebT = 999; if (g.air) g.air.spawnT = 999;
      const all = g.blocks.slice();
      const flam = all.filter((b) => b.mat.flammable);
      const ever = new Map(); const deadAt = new Map();
      const grp = (b) => b.def.tag || b.matId;
      if (ign) {
        const b = ign(g);
        if (b) { if (destroy) g.destroyBlock(b); else g.ignite(b, 8); }
      } else {
        // incendiary-equivalent burst on a central timber/plaster block
        const cand = flam.filter((b) => !b.dead).sort((a, b) => a.body.translation().x - b.body.translation().x);
        const tb = cand[Math.floor(cand.length * 0.45)];
        const t = tb.body.translation();
        incAt = { x: +t.x.toFixed(1), y: +t.y.toFixed(1), mat: tb.matId };
        const a = { blastRadius: 2.2, blastDamage: 20, ignite: 3.2 };
        g.explode(t.x, t.y, a.blastRadius, a.blastDamage, { ignite: a.ignite, visual: 0.9 });
      }
      const tl = [];
      const kills = []; let stepI = 0;
      const gk = g.garrison.kill.bind(g.garrison);
      g.garrison.kill = (d, f) => { if (d.person && d.state !== 'dead') kills.push(`${(stepI / 60).toFixed(1)}s:x${d.x.toFixed(1)}y${d.y.toFixed(1)}:${d.state}${d.deps.some((b) => b.burning > 0) ? ':fire' : ''}`); gk(d, f); };
      let fled = 0;
      const wasHome = new Map();
      let fireMs = 0, fireMax = 0, frameFire = 0;
      const sf = g.spreadFire.bind(g), ue = g.updateEmbers.bind(g);
      g.spreadFire = (...a) => { const t0 = performance.now(); sf(...a); frameFire += performance.now() - t0; };
      g.updateEmbers = (...a) => { const t0 = performance.now(); ue(...a); frameFire += performance.now() - t0; };
      let worst = 0;
      const casual0 = g.garrison.casualties;
      for (let i = 1; i <= secs * 60; i++) {
        const t0 = performance.now();
        stepI = i;
        g.update(1 / 60);
        worst = Math.max(worst, performance.now() - t0);
        fireMs += frameFire; fireMax = Math.max(fireMax, frameFire); frameFire = 0;
        for (const b of all) { if (!b.dead && b.burning > 0 && !ever.has(b)) ever.set(b, +(i / 60).toFixed(1)); if (b.dead && !deadAt.has(b)) deadAt.set(b, +(i / 60).toFixed(1)); }
        if (i % (5 * 60) === 0) {
          const burning = all.filter((b) => !b.dead && b.burning > 0).length;
          const dead = flam.filter((b) => b.dead).length;
          tl.push(`${i / 60}s: burning ${burning}, everLit ${ever.size}/${flam.length}, flamDestroyed ${dead}`);
        }
      }
      const by = {};
      for (const b of all) {
        const k = grp(b);
        by[k] = by[k] || { n: 0, lit: 0, dead: 0 };
        by[k].n++; if (ever.has(b)) by[k].lit++; if (b.dead) by[k].dead++;
      }
      const res = { name, seed, wind: windv, incAt, timeline: tl, by, casualties: g.garrison.casualties - casual0, garrison: g.garrison.total,
        kills: kills.join(" "), fled: g.garrison.fled,
        people: g.garrison.list.filter((d) => d.person).map((d) => `${d.state}${d.floor ? '' : '(out)'}@${d.x.toFixed(1)}`).join(' '),
        props: g.garrison.list.filter((d) => !d.person).map((d) => d.char.toFixed(2)).join(' '), worstStepMs: +worst.toFixed(1), fireMsAvg: +(fireMs / (secs * 60)).toFixed(3), fireMsMax: +fireMax.toFixed(2), level: L.name, nblocks: all.length };
      if (name === 'orient') res.orient = Object.fromEntries(all.filter((b) => b.def.tag).map((b) => [b.def.tag, ever.get(b) ?? null]));
      if (name === 'tanks' || name === 'bigtanks') res.tankDeaths = all.filter((b) => b.matId === 'fuel').map((b) => b.dead ? 'dead@' + deadAt.get(b) : `hp${Math.round(b.hp)}`);
      delete g.garrison.kill;
      delete g.spreadFire; delete g.updateEmbers;
      Math.random = realRandom;
      return res;
    };
  });
  const args = process.argv[4] ? +process.argv[4] : 0;
  for (const w of which) {
    for (let s = 1; s <= seeds; s++) {
      const secs = w === 'orient' ? 30 : 60;
      const r = await page.evaluate(([w, s, secs, args]) => window.fireRun(w, s, secs, args), [w, s, secs, args]);
      if (w === 'orient') console.log(`orient seed ${s}: ${JSON.stringify(r.orient)}`);
      else console.log(JSON.stringify(r));
    }
  }
  await browser.close();
})();
