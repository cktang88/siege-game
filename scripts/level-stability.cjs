/*
  Level stability check: loads every level (campaign, themed, hand-built, dev proving grounds), disables the
  enemy timers, simulates N seconds untouched and lists blocks that moved, tipped or died.
  Collider half-extents are shrunk 5 mm a side, so a stack sinks ~1 cm per joint; that is discounted.

    npx vite --port 5184 --strictPort &      # then:
    node scripts/level-stability.cjs [ids,comma,separated|all] [seconds=10] [x0:x1 to dump a range]
    BASE=http://127.0.0.1:5173 node scripts/level-stability.cjs

  Needs playwright (npm i -D playwright, or a global install).
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
(async () => {
  const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
  const secs = +(process.argv[3] || 10);
  const rng = process.argv[4] ? process.argv[4].split(':').map(Number) : null;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5184') + '/?dev');
  await page.waitForFunction(() => window.siege && window.siege.game, null, { timeout: 60000 });
  const ids = await page.evaluate(async () => {
    const { devCastles } = await import('/src/campaign.ts');
    window.__lv = devCastles();
    const { LEVELS } = await import('/src/levels.ts');
    for (const l of LEVELS) if (!window.__lv.some((x) => x.id === l.id)) window.__lv.push(l);
    return window.__lv.map((l) => l.id);
  });
  let bad = 0;
  for (const id of ids) {
    if (only && !only.includes(id)) continue;
    const r = await page.evaluate(async ([id, secs, rng]) => {
      const S = window.siege; const { startBattle } = await import('/src/hud.ts');
      const lvl = window.__lv.find((l) => l.id === id);
      S.level = lvl; S.game.load(lvl); startBattle({ shell: 1 }, 0, 9999);
      const g = S.game;
      const off = () => { g.artT = g.barT = g.repT = g.rebT = 999; if (g.air) g.air.spawnT = 999; };
      off();
      const post = g.blocks.map((b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; });
      for (let i = 0; i < secs * 60; i++) { off(); g.update(1 / 60); }
      const moved = [], died = [];
      let maxSettle = 0;
      g.blocks.forEach((b, i) => {
        const d = b.def;
        if (b.dead) { died.push(`${i}:${d.mat}${d.target ? '/' + d.target : ''}@${d.x.toFixed(1)},${d.y.toFixed(1)}`); return; }
        const t = b.body.translation();
        const cy = d.y + d.h / 2;
        const dx = t.x - (d.x + d.w / 2), dy = t.y - cy;
        const dd = Math.hypot(dx, dy);
        const dp = Math.hypot(t.x - post[i].x, t.y - post[i].y);
        const rot = Math.abs(b.body.rotation());
        // collider half-extents are shrunk 5 mm a side, so a stack of n blocks sinks ~1 cm per joint: discount that
        const sinkAllow = 0.0125 * Math.max(0, cy - g.groundY(t.x)) / 1.0;
        const anom = Math.max(Math.abs(dx), Math.max(0, -dy - sinkAllow), dy, rot * Math.max(d.w, d.h) / 2);
        maxSettle = Math.max(maxSettle, anom);
        if (rng ? (d.x + d.w > rng[0] && d.x < rng[1]) : (anom > 0.25 || dp > 0.1)) moved.push({ s: anom, t: `${i}:${d.mat}${d.poly ? 'P' : ''}${d.target ? '/' + d.target : ''}@${d.x.toFixed(1)},${d.y.toFixed(1)} ${d.w.toFixed(1)}x${d.h.toFixed(1)} dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} rot=${rot.toFixed(2)} dp=${dp.toFixed(2)}` });
      });
      moved.sort((a, b) => b.s - a.s);
      return { id, n: g.blocks.length, maxSettle: +maxSettle.toFixed(3), moved: moved.map((m) => m.t), died, objDone: g.ended };
    }, [id, secs, rng]);
    if (r.moved.length || r.died.length) bad++;
    console.log(`${r.id.padEnd(14)} n=${r.n} maxSettle=${r.maxSettle} moved=${r.moved.length} died=${r.died.length} ended=${r.objDone}`);
    for (const m of r.moved.slice(0, rng ? 200 : 12)) console.log('   M', m);
    for (const m of r.died.slice(0, 12)) console.log('   D', m);
  }
  console.log('BAD LEVELS:', bad);
  await browser.close();
  process.exitCode = bad ? 1 : 0;
})();
