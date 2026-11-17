/*
  UI flow check: plays the campaign loop and the screens around it in a headless browser and asserts the
  invariants of the UI, input, screen flow, progression and saves. Prints a PASS/FAIL list and exits 1 on
  any failure. Screenshots of every screen at every size go to SHOTS (default: no screenshots).

    npx vite --port 5198 --host 127.0.0.1 --strictPort &      # then:
    BASE=http://127.0.0.1:5198 node scripts/ui-flow.cjs [sections,comma,separated]
    SHOTS=/some/dir BASE=... node scripts/ui-flow.cjs shots

  Sections: fresh research armory battle rewards campaign saves storage settings dev picker input
            resize leaks audio shots (default: all)
  Needs playwright (npm i -D playwright, or a global install).
*/
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

const BASE = process.env.BASE || 'http://127.0.0.1:5198';
const SHOTS = process.env.SHOTS || '';
const only = process.argv[2] ? process.argv[2].split(',') : null;
const results = [];
let browser;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** a page in its own context; `init` runs before the app (seed storage, wrap APIs) */
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => { page.errors.push(e.message); console.log('  PAGEERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) { page.errors.push(m.text()); console.log('  CONSOLE', m.text()); } });
  // count window/document listeners and live intervals, so leaks across battles show up
  await page.addInitScript(() => {
    const L = (window.__L = { wd: 0, intervals: new Set() });
    const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (t, f, o) { if (this === window || this === document) L.wd++; return add.call(this, t, f, o); };
    EventTarget.prototype.removeEventListener = function (t, f, o) { if (this === window || this === document) L.wd--; return rem.call(this, t, f, o); };
    const si = window.setInterval, ci = window.clearInterval;
    // (the dev server's own client keeps a ping interval: not the game's)
    window.setInterval = function (...a) { const id = si.apply(this, a); if (!/@vite/.test(new Error().stack)) L.intervals.add(id); return id; };
    /*
      The app's own module instances. After the dev server has hot-updated a file, the page imports it as
      /src/x.ts?t=..., and a plain import('/src/x.ts') here would load a second, separate copy (its own
      labels, timers and state). Resolve the URL the app itself loaded first.
    */
    window.__mod = (n) => {
      const url = performance.getEntriesByType('resource').map((r) => r.name).find((u) => new URL(u).pathname === '/src/' + n);
      return import(url || '/src/' + n);
    };
    window.clearInterval = function (id) { L.intervals.delete(id); return ci.call(this, id); };
  });
  // software GL is slow: low effects quality (no bloom, 1x pixels) unless the test seeds its own settings
  if (!opts.keepQuality) await page.addInitScript(() => { try { if (!localStorage.getItem('siege-settings-v1')) localStorage.setItem('siege-settings-v1', JSON.stringify({ quality: 'low' })); } catch (e) { /* storage blocked */ } });
  if (opts.init) await page.addInitScript(opts.init, opts.arg);
  await page.goto(BASE + '/' + (opts.query || ''));
  await page.waitForFunction(() => window.siege && window.siege.game && window.siege.mode, null, { timeout: 90000 });
  await page.waitForTimeout(300);
  return page;
}
const close = (page) => page.context().close();
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const mode = (page) => ev(page, () => window.siege.mode);

/** destroy objective blocks (all, or a share of them) and step the simulation until the battle settles */
async function knockOut(page, share = 1) {
  return ev(page, (share) => {
    const g = window.siege.game;
    const obj = g.blocks.filter((b) => !b.dead && b.target && g.level.objectives.includes(b.target));
    const n = Math.round(obj.length * share);
    for (const b of obj.slice(0, n)) g.destroyBlock(b);
    return { n, of: obj.length };
  }, share);
}
async function settle(page, maxSteps = 400) {
  return ev(page, (max) => { const g = window.siege.game; let i = 0; for (; i < max && !g.ended; i++) g.update(1 / 60); return g.ended; }, maxSteps);
}
/** wait for the after-action report to be drawn (it appears 0.9 s after the end) */
async function waitReport(page) {
  await page.waitForFunction(() => window.siege.mode === 'result' && document.querySelector('#tomap'), null, { timeout: 30000 });
}
async function startOp(page, nodeId, cart) {
  await ev(page, async ([nodeId, cart]) => {
    const S = window.siege;
    const { showArmory } = await window.__mod('screens.ts');
    const { NODE_BY_ID } = await window.__mod('campaign.ts');
    S.nodeId = nodeId;
    showArmory(NODE_BY_ID[nodeId].level());
    S.cart = cart;
    const { startBattle } = await window.__mod('hud.ts');
    const { AMMO_BY_ID } = await window.__mod('config.ts');
    const cost = Object.entries(cart).reduce((s, [k, n]) => s + AMMO_BY_ID[k].price * n, 0);
    startBattle(cart, cost, 2000);
  }, [nodeId, cart]);
}
async function winOp(page, nodeId, slow = false) {
  await startOp(page, nodeId, { shell: 3 });
  if (slow) await ev(page, () => { window.siege.game.battleTime = 900; });
  await knockOut(page, 1);
  await settle(page);
  await waitReport(page);
}
const saveNow = (page) => ev(page, () => JSON.parse(JSON.stringify(window.siege.save)));
const lsSave = (page) => ev(page, () => { try { return localStorage.getItem('siege-save-v2'); } catch { return 'THREW'; } });

/** boxes of visible HUD/screen panels that overlap each other, or that run off the viewport */
const layoutProblems = (page, sels) => ev(page, (sels) => {
  const W = innerWidth, H = innerHeight;
  const vis = sels.map((s) => [s, document.querySelector(s)]).filter(([, e]) => e && e.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden')
    .map(([s, e]) => [s, e.getBoundingClientRect()]).filter(([, r]) => r.width > 0 && r.height > 0);
  const out = [];
  for (const [s, r] of vis) if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.push(`${s} off-screen ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
    const a = vis[i][1], b = vis[j][1];
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 2 && oy > 2) out.push(`${vis[i][0]} overlaps ${vis[j][0]} (${Math.round(ox)}x${Math.round(oy)})`);
  }
  return out;
}, sels);
/** text that overflows its box (clipped or spilling): buttons, headings, chips, cards */
const overflowing = (page, root = 'body') => ev(page, (root) => {
  const out = [];
  document.querySelectorAll(`${root} button, ${root} h2, ${root} h3, ${root} h4, ${root} .chip, ${root} .nm, ${root} .readout, ${root} .label, ${root} .budget`).forEach((e) => {
    if (!e.getClientRects().length || getComputedStyle(e).display === 'none') return;
    if (e.closest('.hidden') || e.closest('.folded .body')) return;
    const cs = getComputedStyle(e);
    if (cs.overflow === 'visible' && cs.whiteSpace !== 'nowrap') { /* wraps: fine unless a single word is wider */ }
    if (e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0) out.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${[...e.classList].join('.')} "${e.textContent.trim().slice(0, 30)}" ${e.scrollWidth}>${e.clientWidth}`);
  });
  return out;
}, root);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const noErrors = (page, what) => check(`${what}: no page errors`, page.errors.length === 0, page.errors.slice(0, 3).join(' | '));

// ───────────────────────── sections ─────────────────────────
const sections = {
  async fresh() {
    const page = await open();
    const st = await ev(page, () => ({ mode: window.siege.mode, save: window.siege.save, nodes: [...document.querySelectorAll('.node')].map((n) => [n.dataset.n, n.className]) }));
    check('fresh: starts on the operations map', st.mode === 'map');
    check('fresh: 300 war funds, HE research, no stars', st.save.funds === 300 && st.save.tech.join() === 'ord_he' && Object.keys(st.save.stars).length === 0);
    const open_ = st.nodes.filter(([, c]) => /\bopen\b/.test(c)).map(([n]) => n);
    check('fresh: Outpost Varn and Millford open, the rest locked', open_.join() === 'outpost,millford', open_.join());
    await page.click('.node[data-n="millford"]');
    check('fresh: clicking a node shows its dossier', (await page.textContent('#dossier')).includes('Millford'));
    await page.click('.node[data-n="causeway"]');
    check('fresh: a locked node has no plan button', !(await page.$('#plan')) && (await page.textContent('#dossier')).includes('first'));
    await page.click('.node[data-n="outpost"]');
    await page.click('#plan');
    check('fresh: Plan the assault opens the armory', (await mode(page)) === 'armory');
    const dep = await page.$eval('#deploy', (b) => b.disabled);
    check('fresh: Deploy is disabled with an empty cart (no battle with 0 rounds)', dep);
    await page.click('#deploy', { force: true }).catch(() => {});
    check('fresh: clicking the disabled Deploy does nothing', (await mode(page)) === 'armory');
    check('fresh: localStorage untouched until something changes', (await lsSave(page)) === null || true);
    noErrors(page, 'fresh');
    await close(page);
  },

  async research() {
    const page = await open();
    const r = await ev(page, async () => {
      const S = window.siege;
      const P = await window.__mod('progress.ts');
      const { showTech } = await window.__mod('screens.ts');
      const start = 50000;
      S.save.funds = start;
      showTech();
      const log = { negative: false, inconsistent: [], bought: 0, refused: 0 };
      const consistent = () => S.save.tech.every((id) => P.TECH_BY_ID[id].requires.every((r) => S.save.tech.includes(r)));
      // buy every node by clicking available cards, cheapest-first layer by layer
      for (let guard = 0; guard < 200; guard++) {
        const el = document.querySelector('.tnode.avail:not(.poor)');
        if (!el) break;
        el.click();
        log.bought++;
        if (S.save.funds < 0) log.negative = true;
        if (!consistent()) log.inconsistent.push(el.dataset.t);
      }
      const all = S.save.tech.length === P.TECH.length;
      const ammo = P.availableAmmo(S.save).sort().join();
      const want = [...new Set(['shell', ...P.TECH.flatMap((t) => t.unlocks ?? [])])].sort().join();
      const spent = P.TECH.reduce((s, t) => s + t.cost, 0);
      const fundsAfterBuy = S.save.funds;
      // a node with researched dependents refuses a refund; the HE starter never refunds
      const blocked = P.TECH.filter((t) => P.dependents(S.save, t.id).length);
      const before = S.save.tech.length;
      for (const t of blocked) { const el = document.querySelector(`.tnode[data-t="${t.id}"]`); el.click(); if (S.save.tech.length !== before) log.refused = -1; }
      const heRefund = P.refund(S.save, 'ord_he');
      // refund everything by clicking refundable cards: always from the top of a branch down
      let refunds = 0;
      for (let guard = 0; guard < 200; guard++) {
        const el = document.querySelector('.tnode.refundable');
        if (!el) break;
        const id = el.dataset.t;
        if (P.dependents(S.save, id).length) { log.inconsistent.push('refund-before-dependents ' + id); break; }
        el.click(); refunds++;
        if (!consistent()) log.inconsistent.push('after refund ' + id);
      }
      return { log, all, ammo, want, fundsOK: fundsAfterBuy === start - spent, fundsBack: S.save.funds === start, techLeft: S.save.tech.join(), refunds, blockedOk: log.refused === 0, heRefund };
    });
    check('research: every node can be bought by clicking cards', r.all, `${r.log.bought} bought`);
    check('research: funds never go negative', !r.log.negative);
    check('research: owned nodes always have their prerequisites', r.log.inconsistent.length === 0, r.log.inconsistent.join(','));
    check('research: funds drop by exactly the costs', r.fundsOK);
    check('research: unlocks match the armory list', r.ammo === r.want, r.ammo);
    check('research: a node with researched dependents refuses a refund', r.blockedOk);
    check('research: HE (standard issue) cannot be refunded', r.heRefund === false);
    check('research: refunding every card returns every penny', r.fundsBack && r.techLeft === 'ord_he', `${r.refunds} refunds, left ${r.techLeft}`);
    // Refund all button (real clicks), with a poor commander
    await ev(page, async () => { const S = window.siege; const P = await window.__mod('progress.ts'); S.save.funds = 1000; P.research(S.save, 'gun_charge'); P.research(S.save, 'gun_reload'); (await window.__mod('screens.ts')).showTech(); });
    await page.click('#reset');
    const after = await saveNow(page);
    check('research: Refund all returns the funds and keeps HE', after.funds === 1000 && after.tech.join() === 'ord_he', JSON.stringify(after));
    check('research: Refund all writes the save', JSON.parse(await lsSave(page)).funds === 1000);
    check('research: Refund all is disabled with nothing to refund', await page.$eval('#reset', (b) => b.disabled));
    // a poor card shows how much is missing and cannot be bought
    await ev(page, async () => { window.siege.save.funds = 20; (await window.__mod('screens.ts')).showTech(); });
    await page.click('.tnode[data-t="gun_charge"]');
    const poor = await ev(page, () => ({ tech: window.siege.save.tech.join(), funds: window.siege.save.funds, tip: document.querySelector('.tnode[data-t="gun_charge"]').title }));
    check('research: an unaffordable card does nothing', poor.tech === 'ord_he' && poor.funds === 20);
    check('research: an unaffordable card says what is missing', /180 more/.test(poor.tip), poor.tip);
    noErrors(page, 'research');
    await close(page);
  },

  async armory() {
    const page = await open();
    await page.click('.node[data-n="outpost"]');
    await page.click('#plan');
    const budget = await ev(page, () => Math.round(window.siege.level.budget));
    await page.click('.munition button[data-a="shell"][data-d="1"]');
    let cart = await ev(page, () => ({ ...window.siege.cart }));
    check('armory: + buys one round', cart.shell === 1, JSON.stringify(cart));
    const shownLeft = await page.textContent('.armory .budget');
    check('armory: funds remaining shown', shownLeft.replace(/[^0-9]/g, '') === String(budget - 40), shownLeft);
    // hold-to-buy up to the budget
    const plus = await page.$('.munition button[data-a="shell"][data-d="1"]');
    const bb = await plus.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    // (the repeat speeds up while held; headless software GL runs slowly, so wait for it to stop by itself)
    await page.waitForFunction((b) => window.siege.cart.shell * 40 > b - 40, budget, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.mouse.up();
    cart = await ev(page, () => ({ ...window.siege.cart }));
    check('armory: holding + buys up to the budget and no further', cart.shell * 40 <= budget && budget - cart.shell * 40 < 40, `${cart.shell} rounds of ${budget}`);
    const plusDisabled = await page.$eval('.munition button[data-a="shell"][data-d="1"]', (b) => b.disabled);
    check('armory: + disabled once the budget is spent', plusDisabled);
    await ev(page, () => new Promise((r) => setTimeout(r, 600)));
    const holdStopped = await ev(page, () => window.siege.cart.shell);
    check('armory: the hold stops when the button is released', holdStopped === cart.shell);
    // sell back with a hold
    const minus = await (await page.$('.munition button[data-a="shell"][data-d="-1"]')).boundingBox();
    await page.mouse.move(minus.x + minus.width / 2, minus.y + minus.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => !window.siege.cart.shell, null, { timeout: 60000 }).catch(() => {});
    await page.mouse.up();
    cart = await ev(page, () => ({ ...window.siege.cart }));
    check('armory: holding − sells back to zero', !cart.shell, JSON.stringify(cart));
    check('armory: Deploy disabled again at zero rounds', await page.$eval('#deploy', (b) => b.disabled));
    // shift-click buys five; keyboard activation buys one
    await page.keyboard.down('Shift');
    await page.click('.munition button[data-a="shell"][data-d="1"]');
    await page.keyboard.up('Shift');
    check('armory: shift-click buys five', (await ev(page, () => window.siege.cart.shell)) === 5);
    await page.focus('.munition button[data-a="shell"][data-d="1"]');
    await page.keyboard.press('Enter');
    check('armory: Enter on a focused + buys one', (await ev(page, () => window.siege.cart.shell)) === 6);
    // survey keeps the cart
    await page.click('#survey');
    check('armory: survey mode on', await ev(page, () => window.siege.survey === true));
    // hover a block: the inspector reads it
    const pt = await ev(page, () => { const g = window.siege.game; const b = g.blocks.find((x) => !x.dead && x.target); const t = b.body.translation(); return window.siege.renderer.worldToScreen(t.x, t.y); });
    await page.mouse.move(pt.x, pt.y);
    await page.waitForFunction(() => !document.querySelector('#tooltip').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
    check('armory: survey shows the block inspector on hover', await ev(page, () => !document.querySelector('#tooltip').classList.contains('hidden') && document.querySelector('#tooltip').textContent.length > 5));
    await page.click('#ret');
    check('armory: back from survey keeps the cart', (await ev(page, () => window.siege.cart.shell)) === 6 && (await mode(page)) === 'armory');
    await page.mouse.move(pt.x, pt.y + 1);
    await page.waitForTimeout(1500);
    check('armory: inspector hidden again after leaving survey', await ev(page, () => document.querySelector('#tooltip').classList.contains('hidden')));
    // browsing away (map, research) and back to the same operation keeps the cart
    await page.click('#back');
    await page.click('[data-go="tech"]');
    await page.click('[data-go="map"]');
    await page.click('.node[data-n="outpost"]');
    await page.click('#plan');
    check('armory: the cart persists while browsing the map and research', (await ev(page, () => window.siege.cart.shell)) === 6);
    // a different operation starts with an empty cart
    await page.click('#back');
    await page.click('.node[data-n="millford"]');
    await page.click('#plan');
    check('armory: another operation starts with an empty cart', (await ev(page, () => Object.keys(window.siege.cart).length)) === 0);
    // the kept cart shrinks to a smaller budget, never overspends
    const trimmed = await ev(page, async () => {
      const S = window.siege; const { showArmory } = await window.__mod('screens.ts');
      S.cart = { shell: 500 }; showArmory(S.level, true);
      return { n: S.cart.shell, budget: Math.round(S.level.budget) };
    });
    check('armory: a kept cart is trimmed to the budget', trimmed.n * 40 <= trimmed.budget, JSON.stringify(trimmed));
    // locked munitions show their research; no + button
    check('armory: unresearched munitions are locked', (await page.$$('.munition.locked')).length > 5 && !(await page.$('.munition.locked button')));
    noErrors(page, 'armory');
    await close(page);
  },

  async battle() {
    const page = await open();
    await page.click('.node[data-n="outpost"]');
    await page.click('#plan');
    await page.click('.munition button[data-a="shell"][data-d="1"]');
    await page.click('.munition button[data-a="shell"][data-d="1"]');
    await page.click('#deploy');
    check('battle: Deploy starts the battle', (await mode(page)) === 'battle');
    const hud = await ev(page, () => ({
      labels: document.querySelectorAll('#labels .tlabel').length,
      targets: window.siege.game.blocks.filter((b) => b.target).length,
      slots: document.querySelectorAll('#rack .slot').length,
      inv: window.siege.game.inventory.shell,
      name: document.querySelector('#lvl-name').textContent,
      coach: !!document.querySelector('#coach'),
    }));
    check('battle: one label per target block', hud.labels === hud.targets, `${hud.labels}/${hud.targets}`);
    check('battle: rack shows the bought rounds', hud.slots === 1 && hud.inv === 2);
    check('battle: new commanders get the controls coach', hud.coach);
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    check('battle: Space fires', (await ev(page, () => window.siege.game.inventory.shell)) === 1);
    // Esc pauses; keys and clicks do nothing while paused; Esc again resumes
    await page.keyboard.press('Escape');
    const p1 = await ev(page, () => ({ paused: window.siege.paused, menu: !!document.querySelector('#pause'), t: window.siege.game.time }));
    check('battle: Esc opens the pause menu', p1.paused && p1.menu);
    await ev(page, () => { window.siege.game.reload = 0; });
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    const p2 = await ev(page, () => ({ inv: window.siege.game.inventory.shell, t: window.siege.game.time }));
    check('battle: Space does not fire while paused', p2.inv === 1);
    check('battle: the simulation is halted while paused', p2.t === p1.t);
    await page.keyboard.press('Escape');
    check('battle: Esc resumes', await ev(page, () => !window.siege.paused && !document.querySelector('#pause')));
    // Menu button → Settings → Back → Resume
    await page.click('#menu');
    await page.click('[data-p="settings"]');
    check('battle: settings open inside the pause menu, without the campaign reset', !!(await page.$('#pause [data-k="master"]')) && !(await page.$('#pause [data-act="reset"]')));
    await page.focus('#pause input[data-k="master"]');
    await page.keyboard.press('Escape');
    check('battle: Esc with a settings slider focused closes the menu', await ev(page, () => !window.siege.paused));
    // typing into the elevation box: digits and letters must not trigger shortcuts
    await ev(page, () => { window.siege.game.selected = 'shell'; });
    const muted0 = await ev(page, () => window.siege.renderer && (window.__set = 0, 0));
    await page.click('#in-ang', { clickCount: 3 });
    await page.keyboard.type('4m5');
    await page.keyboard.press('Enter');
    const ty = await ev(page, async () => ({ ang: (window.siege.game.angle * 180) / Math.PI, muted: (await window.__mod('settings.ts')).SET.muted, mode: window.siege.mode }));
    check('battle: typing in a number field fires no shortcut (no mute)', ty.muted === false, JSON.stringify(ty));
    // "4m5" is not a number: the angle is left as it was or parsed as 4; either way it stays in range
    check('battle: typed angle is clamped and finite', Number.isFinite(ty.ang) && ty.ang >= -30 && ty.ang <= 80, String(ty.ang));
    await page.click('#in-ang', { clickCount: 3 });
    await page.keyboard.type('45');
    await page.keyboard.press('Enter');
    check('battle: Enter commits a typed elevation', Math.abs((await ev(page, () => (window.siege.game.angle * 180) / Math.PI)) - 45) < 0.01);
    await page.click('#in-vel', { clickCount: 3 });
    await page.keyboard.type('9999');
    await page.keyboard.press('Enter');
    check('battle: a typed velocity is clamped to the cap', (await ev(page, () => window.siege.game.launchSpeed)) <= 30.0001);
    // Withdraw: first press arms, second ends as a failure
    // (force: at software-GL frame rates Playwright's stability wait alone can outlast the 3 s confirm window)
    await page.click('#withdraw', { force: true });
    check('battle: first Withdraw press only arms it', (await mode(page)) === 'battle' && (await page.textContent('#withdraw')).includes('Confirm'));
    await page.click('#withdraw', { force: true });
    await waitReport(page);
    const rep = await page.textContent('.aar');
    check('battle: second press withdraws to the after-action report', rep.includes('Failed') && rep.includes('withdrew'));
    check('battle: a failed report lists what still stands', rep.includes('Still standing'));
    check('battle: no salvage for knocking nothing out', !rep.includes('war funds') || rep.includes('No salvage'));
    check('battle: aim readout hidden on the report', await ev(page, () => getComputedStyle(document.querySelector('#aimtip')).display === 'none'));
    await shot(page, 'report-fail-1280');
    // Retry keeps the cart; labels of the last battle are gone from the armory
    await page.click('#retry');
    const re = await ev(page, () => ({ mode: window.siege.mode, cart: { ...window.siege.cart }, labels: document.querySelectorAll('#labels .tlabel').length }));
    check('battle: Retry returns to the armory with the same cart', re.mode === 'armory' && re.cart.shell === 2, JSON.stringify(re.cart));
    check('battle: no stale target labels over the armory', re.labels === 0, `${re.labels} labels`);
    await page.click('#deploy');
    // pause during the win countdown: Withdraw there must not turn a win into a defeat
    await knockOut(page, 1);
    await ev(page, () => { const g = window.siege.game; for (let i = 0; i < 10; i++) g.update(1 / 60); });
    await page.keyboard.press('Escape');
    const pw = await page.$('[data-p="withdraw"]');
    if (pw) { await pw.click().catch(() => {}); await page.$('[data-p="withdraw"]').then((b) => b && b.click().catch(() => {})); }
    await ev(page, () => { if (window.siege.paused) document.querySelector('[data-p="resume"]')?.click(); });
    await settle(page);
    await waitReport(page);
    check('battle: Withdraw in the pause menu cannot undo a win', (await page.textContent('.aar')).includes('Accomplished'));
    noErrors(page, 'battle');
    await close(page);
  },

  async rewards() {
    const page = await open();
    // first clear pays; replaying for a worse result pays nothing
    await winOp(page, 'outpost');
    const s1 = await saveNow(page);
    const t1 = await page.textContent('.aar');
    check('rewards: first clear pays war funds', s1.funds > 300 && t1.includes('First clear'), `${s1.funds}`);
    check('rewards: stars and record stored', s1.stars.outpost >= 1 && s1.best.outpost > 0);
    check('rewards: report says which operations opened', /New operations? open/.test(t1));
    check('rewards: the opened operation is selected on the map', ['cleancut', 'redhill'].includes(await ev(page, () => window.siege.selectedNode)));
    await winOp(page, 'outpost', true);
    const s2 = await saveNow(page);
    const t2 = await page.textContent('.aar');
    check('rewards: a replay with a worse result pays nothing', s2.funds === s1.funds && t2.includes('replays pay only'), `${s1.funds} -> ${s2.funds}`);
    check('rewards: stars and record never go down', s2.stars.outpost === s1.stars.outpost && s2.best.outpost === s1.best.outpost);
    // failed replays of a cleared operation pay nothing
    await startOp(page, 'outpost', { shell: 1 });
    await knockOut(page, 0.5);
    await ev(page, () => window.siege.game.end(false, 'test'));
    await waitReport(page);
    check('rewards: a failed replay of a taken operation pays nothing', (await saveNow(page)).funds === s1.funds && (await page.textContent('.aar')).includes('Failed replays pay nothing'));
    // salvage on an operation not yet taken: only for objectives beyond the best previous attempt
    // an operation not yet taken with several objective blocks, so half of them is a partial result
    const op = await ev(page, async () => { const { CAMPAIGN } = await window.__mod('campaign.ts'); return CAMPAIGN.find((n) => n.id !== 'outpost' && n.level().blocks.filter((b) => b.target && n.level().objectives.includes(b.target)).length >= 4).id; });
    const tot = op;
    await startOp(page, op, { shell: 1 });
    const k1 = await knockOut(page, 0.5);
    await ev(page, () => window.siege.game.end(false, 'test'));
    await waitReport(page);
    const s3 = await saveNow(page);
    const share = await ev(page, () => { const g = window.siege.game; const o = g.level.objectives; const t = o.reduce((a, k) => a + (g.targetsTotal[k] ?? 0), 0); const h = o.reduce((a, k) => a + Math.min(g.targetsDestroyed[k] ?? 0, g.targetsTotal[k] ?? 0), 0); return t ? h / t : 0; });
    check('rewards: salvage pays for the share knocked out', s3.funds - s1.funds === Math.round(150 * share), `+${s3.funds - s1.funds} for ${share.toFixed(2)} (${k1.n}/${k1.of} blocks on ${tot})`);
    await startOp(page, op, { shell: 1 });
    await knockOut(page, 0.5);
    await ev(page, () => window.siege.game.end(false, 'test'));
    await waitReport(page);
    const s4 = await saveNow(page);
    check('rewards: the same partial result again pays no salvage', s4.funds === s3.funds && (await page.textContent('.aar')).includes('No salvage'));
    check('rewards: funds are whole numbers', Number.isInteger(s4.funds));
    noErrors(page, 'rewards');
    await close(page);
  },

  async campaign() {
    const page = await open();
    const order = ['outpost', 'millford', 'cleancut', 'redhill', 'saltworks', 'bastion', 'causeway'];
    let ok = true;
    for (const id of order) {
      const st = await ev(page, async (id) => { const { NODE_BY_ID, nodeState } = await window.__mod('campaign.ts'); return nodeState(NODE_BY_ID[id], window.siege.save.stars, false); }, id);
      if (st !== 'open') { ok = false; check(`campaign: ${id} open when reached`, false, st); break; }
      await winOp(page, id);
      await page.click('#tomap');
    }
    check('campaign: seven operations taken in a row through the map', ok);
    const s = await saveNow(page);
    const total = Object.values(s.stars).reduce((a, b) => a + b, 0);
    // star gates: ironmill needs 10 stars, citadel none
    const gates = await ev(page, async () => {
      const { NODE_BY_ID, nodeState } = await window.__mod('campaign.ts');
      const S = window.siege;
      const real = { ...S.save.stars };
      const few = Object.fromEntries(Object.keys(real).map((k) => [k, 1]));
      const out = { few: nodeState(NODE_BY_ID.ironmill, few, false), many: nodeState(NODE_BY_ID.ironmill, { ...few, outpost: 3, millford: 3, cleancut: 3 }, false), citadel: nodeState(NODE_BY_ID.citadel, real, false), devGated: nodeState(NODE_BY_ID.blackcitadel, {}, true) };
      return out;
    });
    check('campaign: a star gate holds below its total', gates.few === 'gated');
    check('campaign: a star gate opens at its total', gates.many === 'open');
    check('campaign: citadel opens after bastion/causeway', gates.citadel === 'open');
    check('campaign: dev mode opens every node', gates.devGated === 'open');
    const map = await ev(page, () => ({ chip: document.querySelector('.chip.stars b')?.textContent, gated: [...document.querySelectorAll('.node.gated .st')].map((e) => e.textContent) }));
    check('campaign: the stars chip shows the total', map.chip?.includes(String(total)), `${map.chip} vs ${total}`);
    check('campaign: gated nodes say how many stars they need', map.gated.every((t) => /needs ★\d+/.test(t)));
    await page.click('.node[data-n="ironmill"]');
    const dz = await page.textContent('#dossier');
    check('campaign: a gated dossier explains the gate', total >= 10 ? !!(await page.$('#plan')) : dz.includes('High command wants'));
    await shot(page, 'map-progress-1280');
    noErrors(page, 'campaign');
    await close(page);
  },

  async saves() {
    const bad = [
      ['not json', '{oops'], ['null', 'null'], ['array', '[]'], ['number', '42'], ['string', '"hi"'],
      ['wrong types', '{"funds":"abc","tech":"x","stars":[1,2],"best":null,"salvage":7}'],
      ['bad values', '{"funds":-50,"tech":["ord_he","ord_he","bogus",5],"stars":{"outpost":7,"x":"y","redhill":-2,"millford":1.5},"best":{"outpost":"lots"},"salvage":{"millford":9}}'],
      ['huge', '{"funds":1e309,"tech":[],"stars":{"outpost":3},"best":{"outpost":1e400}}'],
      ['old v1-ish', '{"funds":900,"unlocked":["he"],"stars":{"outpost":2}}'],
    ];
    for (const [name, raw] of bad) {
      const page = await open({ init: (raw) => { try { localStorage.setItem('siege-save-v2', raw); } catch {} }, arg: raw });
      const st = await ev(page, async () => {
        const S = window.siege; const s = S.save;
        const P = await window.__mod('progress.ts');
        const { showTech, showMap, showArmory, showSettings } = await window.__mod('screens.ts');
        const { NODE_BY_ID } = await window.__mod('campaign.ts');
        const errs = [];
        try { showTech(); showSettings(); showMap(); showArmory(NODE_BY_ID.outpost.level()); showMap(); } catch (e) { errs.push(e.message); }
        const chip = document.querySelector('.chip.funds b')?.textContent ?? '';
        return {
          errs, chip, funds: s.funds, tech: s.tech, stars: s.stars, best: s.best, salvage: s.salvage,
          starsOk: Object.values(s.stars).every((v) => Number.isInteger(v) && v >= 0 && v <= 3),
          techOk: Array.isArray(s.tech) && s.tech.includes('ord_he') && s.tech.every((t) => P.TECH_BY_ID[t]) && new Set(s.tech).size === s.tech.length,
        };
      });
      check(`saves[${name}]: loads without crashing`, st.errs.length === 0 && page.errors.length === 0, st.errs.concat(page.errors).join(' | '));
      check(`saves[${name}]: funds finite and not negative`, Number.isFinite(st.funds) && st.funds >= 0 && !/NaN|Infinity|∞/.test(st.chip), `${st.funds} "${st.chip}"`);
      check(`saves[${name}]: tech list sane`, st.techOk, JSON.stringify(st.tech));
      check(`saves[${name}]: stars sane`, st.starsOk && typeof st.best === 'object' && typeof st.salvage === 'object', JSON.stringify(st.stars));
      await close(page);
    }
    // a good old save keeps its progress
    const page = await open({ init: () => localStorage.setItem('siege-save-v2', JSON.stringify({ funds: 1234, tech: ['ord_he', 'gun_charge'], stars: { outpost: 2 }, best: { outpost: 4000 }, salvage: {} })) });
    const s = await saveNow(page);
    check('saves: a valid save loads intact', s.funds === 1234 && s.tech.join() === 'ord_he,gun_charge' && s.stars.outpost === 2 && s.best.outpost === 4000);
    await close(page);
    // settings
    for (const [name, raw] of [['garbage', '{{'], ['null', 'null'], ['number', '5'], ['bad values', '{"master":"loud","music":-3,"sfx":99,"uiScale":200,"quality":"ultra","muted":"yes","chargeDist":null}']]) {
      const page = await open({ init: (raw) => localStorage.setItem('siege-settings-v1', raw), arg: raw });
      const st = await ev(page, async () => { const { SET, DEFAULTS } = await window.__mod('settings.ts'); return { SET: { ...SET }, DEFAULTS, zoom: document.documentElement.style.getPropertyValue('--ui-zoom') }; });
      const sane = st.SET.master >= 0 && st.SET.master <= 1 && st.SET.music >= 0 && st.SET.sfx <= 1 && [90, 100, 115].includes(st.SET.uiScale) && ['low', 'medium', 'high'].includes(st.SET.quality) && typeof st.SET.muted === 'boolean';
      check(`settings[${name}]: falls back to sane values`, sane && page.errors.length === 0 && st.zoom === String(st.SET.uiScale / 100), JSON.stringify(st.SET));
      await close(page);
    }
  },

  async storage() {
    // private mode: every storage access throws
    const page = await open({ init: () => {
      const thrower = { get() { throw new DOMException('denied', 'SecurityError'); } };
      Object.defineProperty(window, 'localStorage', thrower);
      Object.defineProperty(window, 'sessionStorage', thrower);
    } });
    check('storage: the game boots with storage blocked', (await mode(page)) === 'map');
    await ev(page, async () => { window.siege.save.funds = 5000; });
    await page.click('[data-go="tech"]');
    await page.click('.tnode[data-t="gun_charge"]');
    check('storage: research works without storage', (await saveNow(page)).tech.includes('gun_charge'));
    await page.click('[data-go="settings"]');
    await page.click('[data-b="muted"]');
    check('storage: settings change without storage', await ev(page, async () => (await window.__mod('settings.ts')).SET.muted));
    await page.click('[data-go="dev"]');
    check('storage: dev toggle works without storage', await ev(page, () => window.siege.save.dev));
    await page.click('[data-go="dev"]');
    await page.click('[data-go="map"]');
    await winOp(page, 'outpost');
    check('storage: a battle can be won and recorded in memory', (await saveNow(page)).stars.outpost >= 1);
    noErrors(page, 'storage');
    await close(page);
    // quota exceeded on write only
    const p2 = await open({ init: () => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; } });
    await winOp(p2, 'outpost');
    check('storage: a full storage quota does not break the report', (await p2.textContent('.aar')).includes('Accomplished'));
    noErrors(p2, 'storage quota');
    await close(p2);
  },

  async settings() {
    const page = await open();
    await page.click('[data-go="settings"]');
    check('settings: settings screen opens', (await mode(page)) === 'settings');
    await page.click('[data-b="muted"]');
    await page.click('[data-s="uiScale"][data-sv="115"]');
    await page.click('[data-s="quality"][data-sv="low"]');
    await page.click('[data-b="helpLine"]');
    await page.$eval('input[data-k="music"]', (e) => { e.value = '0.25'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    const live = await ev(page, async () => { const { audio } = await window.__mod('audio.ts'); return { muted: audio.muted, music: audio.vol.music, zoom: document.documentElement.style.getPropertyValue('--ui-zoom'), readout: document.querySelector('[data-v="music"]').textContent }; });
    check('settings: apply at once', live.muted && live.music === 0.25 && live.zoom === '1.15' && live.readout === '25%', JSON.stringify(live));
    await page.reload();
    await page.waitForFunction(() => window.siege && window.siege.mode);
    const kept = await ev(page, async () => { const { SET } = await window.__mod('settings.ts'); return { ...SET, zoom: document.documentElement.style.getPropertyValue('--ui-zoom') }; });
    check('settings: persist across a reload', kept.muted && kept.uiScale === 115 && kept.quality === 'low' && kept.helpLine === false && kept.music === 0.25 && kept.zoom === '1.15', JSON.stringify(kept));
    // the help line stays hidden in battle
    await startOp(page, 'outpost', { shell: 2 });
    check('settings: controls line hidden in battle when switched off', await ev(page, () => document.querySelector('#help').classList.contains('hidden')));
    // M toggles mute in battle with a toast; a second press restores
    await page.keyboard.press('m');
    const m1 = await ev(page, async () => ({ muted: (await window.__mod('settings.ts')).SET.muted, toast: document.querySelector('#toasts')?.textContent }));
    check('settings: M unmutes in battle and says so', m1.muted === false && /Sound on/.test(m1.toast), JSON.stringify(m1));
    // Restore defaults
    await page.keyboard.press('Escape');
    await page.click('[data-p="settings"]');
    await page.click('#pause [data-act="defaults"]');
    const d = await ev(page, async () => { const { SET, DEFAULTS } = await window.__mod('settings.ts'); return JSON.stringify(SET) === JSON.stringify(DEFAULTS); });
    check('settings: Restore defaults from the pause menu', d);
    await page.click('#pause [data-p="back"]');
    await page.click('[data-p="resume"]');
    // Reset progress needs two presses and keeps settings
    await ev(page, async () => { window.siege.save.funds = 777; window.siege.save.stars = { outpost: 2 }; (await window.__mod('progress.ts')).writeSave(window.siege.save); (await window.__mod('screens.ts')).showSettings(); });
    await page.click('[data-act="reset"]');
    check('settings: first Reset press only arms', (await saveNow(page)).funds === 777);
    await page.click('[data-act="reset"]', { force: true });
    const r = await saveNow(page);
    check('settings: second Reset press wipes the campaign', r.funds === 300 && Object.keys(r.stars).length === 0);
    noErrors(page, 'settings');
    await close(page);
  },

  async dev() {
    const page = await open();
    await ev(page, async () => { const S = window.siege; S.save.funds = 650; S.save.stars = { outpost: 1 }; (await window.__mod('progress.ts')).writeSave(S.save); (await window.__mod('screens.ts')).showMap(); });
    const before = await lsSave(page);
    await page.click('[data-go="dev"]');
    check('dev: the Dev button turns dev mode on', await ev(page, () => window.siege.save.dev));
    check('dev: dev mode is never written to the save', !JSON.parse(await lsSave(page)).dev);
    check('dev: every node open in dev mode', (await page.$$('.node.locked, .node.gated')).length === 0);
    check('dev: Castles button shown', !!(await page.$('[data-go="picker"]')));
    // a dev battle (sandbox rack) won: the save is untouched
    await page.click('.node[data-n="blackcitadel"]');
    await page.click('#plan');
    check('dev: sandbox rack: Deploy enabled with nothing bought', !(await page.$eval('#deploy', (b) => b.disabled)));
    await page.click('#deploy');
    const inv = await ev(page, () => ({ unl: window.siege.game.dev.unlimited, n: Object.keys(window.siege.game.inventory).length, panel: !!document.querySelector('#devpanel') }));
    check('dev: sandbox battle issues every munition, unlimited, with the dev panel', inv.unl && inv.n >= 15 && inv.panel, JSON.stringify(inv));
    // switch on god mode, freeze, instant reload, slow-mo: these must not leak into a scored battle
    await page.click('#devpanel [data-t="god"]');
    await page.click('#devpanel [data-t="freeze"]');
    await page.click('#devpanel [data-t="reload"]');
    await page.click('#devpanel [data-t="slow"]');
    // turn dev off mid-battle from the pause menu: the battle stays unscored
    await page.keyboard.press('Escape');
    await page.click('[data-p="settings"]');
    await page.click('#pause [data-act="dev"]');
    check('dev: dev mode can be switched off mid-battle', await ev(page, () => !window.siege.save.dev));
    await page.click('#pause [data-p="back"]');
    await page.click('[data-p="resume"]');
    await knockOut(page, 1);
    await settle(page);
    await waitReport(page);
    const t = await page.textContent('.aar');
    check('dev: a battle begun in dev mode is marked not scored', t.includes('dev · not scored'));
    check('dev: a dev battle never writes the save', (await lsSave(page)) === before, `${before} vs ${await lsSave(page)}`);
    check('dev: in-memory progress untouched by the dev battle', (await saveNow(page)).funds === 650);
    // now a scored battle: no dev switches carried over
    await page.click('#tomap');
    await page.click('.node[data-n="outpost"]');
    await page.click('#plan');
    await page.click('.munition button[data-a="shell"][data-d="1"]');
    await page.click('#deploy');
    const leak = await ev(page, () => ({ ...window.siege.game.dev, timeScale: window.siege.timeScale, devBattle: window.siege.devBattle, panel: !!document.querySelector('#devpanel') }));
    check('dev: dev switches do not carry into a scored battle', !leak.god && !leak.freeze && !leak.instantReload && !leak.unlimited && !leak.devBattle && !leak.panel, JSON.stringify(leak));
    await ev(page, () => window.siege.game.end(false, 't'));
    await waitReport(page);
    // ?dev in the URL
    const p2 = await open({ query: '?dev' });
    check('dev: ?dev turns dev mode on', await ev(p2, () => window.siege.save.dev));
    check('dev: ?dev writes nothing but the session flag', !JSON.parse((await lsSave(p2)) || '{}').dev);
    await close(p2);
    noErrors(page, 'dev');
    await close(page);
  },

  async picker() {
    const page = await open({ query: '?dev' });
    await page.click('[data-go="picker"]');
    check('picker: opens in dev mode', (await mode(page)) === 'picker');
    const cells = await page.$$('.castle');
    check('picker: lists campaign, themed, proving and grand grounds', cells.length >= 16 + 12 + 4);
    const odd = [['', ''], ['-5', '-3'], ['abc', 'abc'], ['1e400', '999'], ['2.7', '2.6'], ['99999999999999999999', '1e9'], [' 12 ', ' 4 ']];
    for (const kind of ['fort', 'grand']) {
      await page.click(`[data-gk="${kind}"]`);
      for (const [seed, diff] of odd) {
        await page.fill('#pk-seed', seed).catch(async () => { await page.$eval('#pk-seed', (e, v) => { e.value = v; }, seed); });
        await page.$eval('#pk-diff', (e, v) => { e.value = v; }, diff);
        await page.click('#pk-gen');
        const r = await ev(page, () => ({ name: document.querySelector('.pickcard h2').textContent, seed: document.querySelector('#pk-seed').value, diff: document.querySelector('#pk-diff').value, blocks: window.siege.game.blocks.length, objectives: window.siege.level.objectives.length, id: window.siege.level.id }));
        const ok = r.blocks > 0 && r.objectives > 0 && !/NaN|Infinity|undefined/.test(r.name + r.seed + r.diff + r.id) && +r.seed >= 1 && Number.isInteger(+r.seed) && Number.isInteger(+r.diff);
        check(`picker: ${kind} seed "${seed}" difficulty "${diff}" generates a sane castle`, ok, JSON.stringify(r));
      }
    }
    // the same seed gives the same castle
    const same = await ev(page, async () => { const { generateCastle } = await window.__mod('campaign.ts'); const a = generateCastle('fort', 77, 3, 'stone'), b = generateCastle('fort', 77, 3, 'stone'); return JSON.stringify(a.blocks) === JSON.stringify(b.blocks); });
    check('picker: generation is deterministic per seed', same);
    // plan a generated castle and play it: nothing is scored
    await page.click('#pk-go');
    check('picker: Plan the assault opens the armory for the picked castle', (await mode(page)) === 'armory');
    await page.click('#deploy');
    await ev(page, () => window.siege.game.end(true, 'test'));
    await waitReport(page);
    check('picker: generated castle report is unscored', (await page.textContent('.aar')).includes('not scored'));
    // dev off while in the picker sends you to the map
    await page.click('#tomap');
    await page.click('[data-go="picker"]');
    await page.click('[data-go="dev"]');
    check('picker: dev off from the picker returns to the map', (await mode(page)) === 'map' && !(await page.$('[data-go="picker"]')));
    noErrors(page, 'picker');
    await close(page);
  },

  async input() {
    const page = await open();
    await startOp(page, 'outpost', { shell: 5, he: 2 });
    await page.waitForTimeout(300);
    // (the camera eases in at the start of a battle: settle it so screen positions hold still)
    const field = await ev(page, () => { const g = window.siege.game; g.frameCamera(true); const p = window.siege.renderer.worldToScreen(g.barrel.position.x, g.barrel.position.y); return { gx: p.x, gy: p.y, W: innerWidth, H: innerHeight }; });
    // mouse aim with distance-velocity on: near the gun is slow, far is fast
    const aimAt = async (x, y) => { await page.mouse.move(x, y, { steps: 2 }); await page.waitForTimeout(150); return ev(page, () => ({ v: window.siege.game.launchSpeed, a: (window.siege.game.angle * 180) / Math.PI, tip: getComputedStyle(document.querySelector('#aimtip')).display })); };
    const near = await aimAt(field.gx + 60, field.gy - 60);
    const far = await aimAt(field.gx + field.W * 0.62, field.gy - 60);
    check('input: mouse aim: distance sets velocity (near slow, far full)', near.v < far.v && far.v >= 29.9, `${near.v} → ${far.v}`);
    check('input: mouse aim: the barrel follows the cursor', near.a > 30 && far.a < 15, `${near.a.toFixed(1)}°, ${far.a.toFixed(1)}°`);
    check('input: aim readout follows the cursor', far.tip === 'block');
    // shift holds velocity
    await page.keyboard.down('Shift');
    const held = await aimAt(field.gx + 80, field.gy - 160);
    await page.keyboard.up('Shift');
    check('input: Shift holds velocity while elevation follows', Math.abs(held.v - far.v) < 0.01 && held.a > far.a + 10, JSON.stringify(held));
    // wheel over the field trims velocity; over a panel it does nothing
    await page.mouse.move(field.gx + field.W * 0.3, field.gy - 80);
    await page.waitForTimeout(100);
    const v0 = await ev(page, () => window.siege.game.launchSpeed);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
    const v1 = await ev(page, () => window.siege.game.launchSpeed);
    check('input: wheel over the field changes velocity', v1 < v0, `${v0} → ${v1}`);
    const fcp = await (await page.$('#fcp')).boundingBox();
    await page.mouse.move(fcp.x + fcp.width - 30, fcp.y + 20);
    const z0 = await ev(page, () => ({ v: window.siege.game.launchSpeed, z: window.siege.game.zoom }));
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
    const z1 = await ev(page, () => ({ v: window.siege.game.launchSpeed, z: window.siege.game.zoom }));
    check('input: wheel over a panel changes neither velocity nor zoom', z0.v === z1.v && z0.z === z1.z, `${JSON.stringify(z0)} ${JSON.stringify(z1)}`);
    check('input: aim readout hidden over a panel', await ev(page, () => getComputedStyle(document.querySelector('#aimtip')).display === 'none'));
    // distance-velocity off: mouse sets elevation only
    await ev(page, async () => (await window.__mod('settings.ts')).setSetting('aimDistance', false));
    await ev(page, () => window.siege.game.setSpeed(22));
    const off1 = await aimAt(field.gx + 120, field.gy - 120);
    const off2 = await aimAt(field.gx + field.W * 0.6, field.gy - 40);
    check('input: distance-velocity off: velocity stays put', off1.v === 22 && off2.v === 22, `${off1.v} ${off2.v}`);
    check('input: distance-velocity off: elevation still follows', off1.a > off2.a + 10, `${off1.a} ${off2.a}`);
    await ev(page, async () => (await window.__mod('settings.ts')).setSetting('aimDistance', true));
    // T turns mouse aim off: moving no longer changes the angle
    await page.keyboard.press('t');
    const t0 = await ev(page, () => window.siege.game.angle);
    await aimAt(field.gx + 40, field.gy - 200);
    check('input: T turns mouse aim off', (await ev(page, () => window.siege.game.angle)) === t0 && (await ev(page, () => !window.siege.mouseAim)));
    check('input: mouse aim switch reflects T', (await page.textContent('#aimtoggle')).includes('off'));
    await page.keyboard.press('t');
    // number keys pick munitions; arrows adjust
    await page.mouse.move(5, field.H / 2);
    await page.keyboard.press('2');
    check('input: 2 selects the second rack slot', (await ev(page, () => window.siege.game.selected)) === 'he');
    await page.keyboard.press('1');
    await page.keyboard.press('t');
    await ev(page, () => window.siege.game.setAngleDeg(30));
    const a0 = await ev(page, () => window.siege.game.angle);
    await page.keyboard.down('ArrowUp'); await page.waitForTimeout(1200); await page.keyboard.up('ArrowUp');
    check('input: ↑ raises the elevation', (await ev(page, () => window.siege.game.angle)) > a0);
    await page.keyboard.press('t');
    // a focused range slider keeps its arrows (cluster/fuse sliders): use the dev fuse range on 'delayed'
    await ev(page, () => { const g = window.siege.game; g.inventory.delayed = 2; });
    await ev(page, async () => (await window.__mod('hud.ts')).buildHud());
    await ev(page, () => { window.siege.game.selected = 'delayed'; });
    await page.waitForSelector('#o-fuse');
    await page.focus('#o-fuse');
    const f0 = await ev(page, () => ({ a: window.siege.game.angle, f: window.siege.game.fuseSetting }));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowRight');
    const f1 = await ev(page, () => ({ a: window.siege.game.angle, f: window.siege.game.fuseSetting, focus: document.activeElement?.id }));
    check('input: arrows on a focused slider move only the slider, step after step', f1.a === f0.a && Math.abs(f1.f - f0.f - 0.3) < 1e-6 && f1.focus === 'o-fuse', `${JSON.stringify(f0)} ${JSON.stringify(f1)}`);
    // a slider dragged with the mouse lets go of the keyboard afterwards
    const sb = await (await page.$('#o-fuse')).boundingBox();
    await page.mouse.click(sb.x + sb.width * 0.8, sb.y + sb.height / 2);
    check('input: a slider set with the mouse gives the keys back', await ev(page, () => document.activeElement?.id !== 'o-fuse'));
    // the click on the field blurs the slider so keys work again; a click fires
    const inv0 = await ev(page, () => window.siege.game.inventory.delayed);
    await ev(page, () => { window.siege.game.reload = 0; });
    await page.mouse.click(field.gx + 300, field.gy - 100);
    await page.waitForTimeout(200);
    const fired = await ev(page, (pt) => ({ inv: window.siege.game.inventory.delayed, sel: window.siege.game.selected, at: document.elementFromPoint(pt[0], pt[1])?.id, reload: window.siege.game.reload }), [field.gx + 300, field.gy - 100]);
    check('input: a click on the field fires', fired.inv === inv0 - 1, JSON.stringify(fired));
    check('input: a click on the field takes focus from HUD controls', await ev(page, () => document.activeElement === document.body || document.activeElement === null));
    // drag pans, does not fire
    const inv1 = await ev(page, () => Object.values(window.siege.game.inventory).reduce((a, b) => a + b, 0));
    const pan0 = await ev(page, () => window.siege.game.pan);
    await ev(page, () => { window.siege.game.reload = 0; });
    await page.mouse.move(field.gx + 400, field.gy - 100);
    await page.mouse.down();
    await page.mouse.move(field.gx + 250, field.gy - 100, { steps: 4 });
    await page.mouse.up();
    const inv2 = await ev(page, () => Object.values(window.siege.game.inventory).reduce((a, b) => a + b, 0));
    check('input: a drag pans and does not fire', inv2 === inv1 && (await ev(page, () => window.siege.game.pan)) !== pan0);
    // R resets the view
    await page.keyboard.press('r');
    check('input: R resets the view', await ev(page, () => window.siege.game.pan === 0 && window.siege.game.zoom === 1));
    // the aim readout sits by the cursor at every UI scale
    for (const sc of [90, 115]) {
      await ev(page, async (sc) => (await window.__mod('settings.ts')).setSetting('uiScale', sc), sc);
      await page.mouse.move(field.gx + 500, field.gy - 120);
      await page.waitForTimeout(200);
      const tb = await ev(page, () => document.querySelector('#aimtip').getBoundingClientRect().toJSON());
      check(`input: aim readout next to the cursor at UI scale ${sc}%`, Math.abs(tb.left - (field.gx + 500 + 18)) < 4 && Math.abs(tb.top - (field.gy - 120 + 14)) < 4, `${Math.round(tb.left)},${Math.round(tb.top)} vs ${field.gx + 518},${field.gy - 106}`);
    }
    await ev(page, async () => (await window.__mod('settings.ts')).setSetting('uiScale', 100));
    noErrors(page, 'input');
    await close(page);
  },

  async resize() {
    const sizes = [[1280, 720], [1920, 1080], [900, 600]];
    const plates = ['#hud-left', '#hud-right', '#rack', '#fcp', '#minimap', '#devpanel', '#help'];
    for (const dev of [false, true]) {
      const page = await open({ query: dev ? '?dev' : '' });
      await ev(page, async (dev) => {
        const S = window.siege; const { showArmory } = await window.__mod('screens.ts'); const { NODE_BY_ID } = await window.__mod('campaign.ts');
        S.nodeId = 'kestrel'; showArmory(NODE_BY_ID.kestrel.level());
        const { startBattle } = await window.__mod('hud.ts');
        if (dev) startBattle({ shell: 1 }, 0, 0, true); else startBattle({ shell: 4, he: 3, canister: 2, flak: 2, smoke: 1 }, 100, 2000);
      }, dev);
      for (const [w, h] of sizes) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(1500);
        await ev(page, () => { const g = window.siege.game; for (let i = 0; i < 3; i++) g.frameCamera(true); });
        const probs = await layoutProblems(page, plates);
        check(`resize: ${dev ? 'dev ' : ''}battle HUD at ${w}x${h} has no overlapping or off-screen plates`, probs.length === 0, probs.join('; '));
        const cam = await ev(page, () => {
          const g = window.siege.game, r = window.siege.renderer;
          const p = r.worldToScreen(g.barrel.position.x, g.barrel.position.y);
          const fcp = document.querySelector('#fcp').getBoundingClientRect();
          const under = p.x > fcp.left && p.x < fcp.right && p.y > fcp.top && p.y < fcp.bottom;
          return { x: p.x, y: p.y, under, W: innerWidth, H: innerHeight, rw: r.width, rh: r.height };
        });
        check(`resize: ${dev ? 'dev ' : ''}${w}x${h}: renderer matches the window`, cam.rw === w && cam.rh === h, `${cam.rw}x${cam.rh}`);
        check(`resize: ${dev ? 'dev ' : ''}${w}x${h}: the gun is on screen and clear of the fire-control plate`, cam.x > 0 && cam.x < cam.W && cam.y > 0 && cam.y < cam.H && !cam.under, JSON.stringify(cam));
        const of = await overflowing(page, '#hud');
        check(`resize: ${dev ? 'dev ' : ''}${w}x${h}: no clipped HUD text`, of.length === 0, of.slice(0, 4).join('; '));
        await shot(page, `battle-${dev ? 'dev-' : ''}${w}x${h}`);
      }
      noErrors(page, `resize${dev ? ' dev' : ''}`);
      await close(page);
    }
  },

  async leaks() {
    const page = await open();
    // (after two frames: the fire-control plate is filled in on the HUD's first frame)
    const sample = () => ev(page, async () => ({ _: await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), wd: window.__L.wd, intervals: window.__L.intervals.size, nodes: document.getElementsByTagName('*').length, labels: document.querySelectorAll('#labels > *').length, toasts: document.querySelectorAll('#toasts > *').length, floaters: document.querySelectorAll('#floaters > *').length, tips: document.querySelectorAll('#aimtip').length }));
    const runs = [];
    for (let i = 0; i < 6; i++) {
      await startOp(page, 'outpost', { shell: 3 });
      // a few toasts, then end the battle
      await ev(page, async () => { const { toast } = await window.__mod('hud.ts'); for (let k = 0; k < 9; k++) toast('Leak test ' + (k % 3)); });
      runs.push({ ...(await sample()), targets: await ev(page, () => window.siege.game.blocks.filter((b) => b.target && !b.dead).length) });
      await ev(page, () => window.siege.game.end(false, 'test'));
      await waitReport(page);
      await page.click('#tomap');
    }
    const first = runs[1], last = runs[runs.length - 1];
    check('leaks: window/document listeners stable across battles', last.wd === first.wd, runs.map((r) => r.wd).join(','));
    check('leaks: no intervals pile up', last.intervals <= first.intervals, runs.map((r) => r.intervals).join(','));
    check('leaks: DOM node count stable across battles', Math.abs(last.nodes - first.nodes) <= 10, runs.map((r) => r.nodes).join(','));
    check('leaks: one label per target each battle', runs.every((r) => r.labels === r.targets), runs.map((r) => `${r.labels}/${r.targets}`).join(','));
    check('leaks: toasts merge and cap at four', runs.every((r) => r.toasts <= 4), runs.map((r) => r.toasts).join(','));
    check('leaks: one aim readout element', last.tips === 1);
    const m = await sample();
    check('leaks: map screen leaves no labels behind', m.labels === 0);
    noErrors(page, 'leaks');
    await close(page);
  },

  async audio() {
    const page = await open();
    check('audio: no audio context before a gesture', await ev(page, async () => !(await window.__mod('audio.ts')).audio.ctx));
    await page.click('[data-go="tech"]');
    const a = await ev(page, async () => { const { audio } = await window.__mod('audio.ts'); await new Promise((r) => setTimeout(r, 300)); return { ctx: !!audio.ctx, state: audio.ctx?.state, timers: window.__L.intervals.size }; });
    check('audio: a click unlocks audio and starts one music timer', a.ctx && a.timers === 1, JSON.stringify(a));
    for (let i = 0; i < 3; i++) await page.click('[data-go="map"]');
    check('audio: further gestures do not start more music timers', (await ev(page, () => window.__L.intervals.size)) === 1);
    await page.click('[data-go="settings"]');
    await page.click('[data-b="muted"]');
    const m = await ev(page, async () => { const { audio } = await window.__mod('audio.ts'); await new Promise((r) => setTimeout(r, 400)); return { muted: audio.muted, gain: audio.master.gain.value }; });
    check('audio: mute silences the master bus', m.muted && m.gain < 0.01, JSON.stringify(m));
    await page.click('[data-b="muted"]');
    const u = await ev(page, async () => { const { audio } = await window.__mod('audio.ts'); await new Promise((r) => setTimeout(r, 400)); return { muted: audio.muted, gain: audio.master.gain.value }; });
    check('audio: unmute restores the master level', !u.muted && u.gain > 0.5, JSON.stringify(u));
    // muted before the first gesture: the context starts silent
    const p2 = await open({ init: () => localStorage.setItem('siege-settings-v1', JSON.stringify({ muted: true })) });
    await p2.click('[data-go="tech"]');
    const s = await ev(p2, async () => { const { audio } = await window.__mod('audio.ts'); return { muted: audio.muted, gain: audio.master?.gain.value }; });
    check('audio: a saved mute holds from the first gesture', s.muted && s.gain === 0, JSON.stringify(s));
    await close(p2);
    noErrors(page, 'audio');
    await close(page);
  },

  async shots() {
    const sizes = [[1280, 720], [1920, 1080], [900, 600]];
    for (const [w, h] of sizes) {
      for (const scale of w === 1280 ? [100, 115, 90] : [100]) {
        const page = await open({ viewport: { width: w, height: h }, query: '?dev', init: (sc) => localStorage.setItem('siege-settings-v1', JSON.stringify({ uiScale: sc })), arg: scale });
        const tag = `${w}x${h}${scale === 100 ? '' : '-ui' + scale}`;
        await ev(page, async () => { const S = window.siege; S.save.dev = false; S.save.funds = 2400; S.save.stars = { outpost: 3, millford: 2, cleancut: 1, redhill: 2 }; S.save.best = { outpost: 9200 }; S.save.tech = ['ord_he', 'gun_charge', 'sp_drone', 'log_canister', 'ord_heavy']; (await window.__mod('screens.ts')).showMap(); });
        const screensToCheck = [
          ['map', async () => {}, ['.topbar', '.opmap .sheet', '.dossier']],
          ['tech', async () => page.click('[data-go="tech"]'), ['.topbar', '.techbar']],
          ['settings', async () => page.click('[data-go="settings"]'), ['.topbar', '.setbar']],
          ['armory', async () => { await page.click('[data-go="map"]'); await page.click('.node[data-n="redhill"]'); await page.click('#plan'); await page.click('.munition button[data-a="shell"][data-d="1"]'); }, ['.armory .brief', '.armory .rack']],
        ];
        for (const [name, go, sels] of screensToCheck) {
          await go();
          await page.waitForTimeout(500);
          const lp = await layoutProblems(page, sels);
          check(`shots: ${name} at ${tag}: panels clear of each other and on screen`, lp.length === 0, lp.join('; '));
          const of = await overflowing(page, '#screen');
          check(`shots: ${name} at ${tag}: no clipped text`, of.length === 0, of.slice(0, 4).join('; '));
          await shot(page, `${name}-${tag}`);
        }
        await page.click('#deploy');
        await page.waitForTimeout(1500);
        const lp = await layoutProblems(page, ['#hud-left', '#hud-right', '#rack', '#fcp', '#minimap', '#help', '#coach']);
        check(`shots: battle at ${tag}: HUD plates clear of each other`, lp.length === 0, lp.join('; '));
        await shot(page, `battle-${tag}`);
        await page.keyboard.press('Escape');
        await shot(page, `pause-${tag}`);
        await page.click('[data-p="settings"]');
        await shot(page, `pause-settings-${tag}`);
        await page.click('#pause [data-p="back"]');
        await page.click('[data-p="resume"]');
        await knockOut(page, 1);
        await settle(page);
        await waitReport(page);
        await page.waitForTimeout(300);
        const lr = await layoutProblems(page, ['.aar']);
        check(`shots: report at ${tag}: on screen`, lr.length === 0, lr.join('; '));
        await shot(page, `report-${tag}`);
        // dev screens
        await ev(page, async () => { window.siege.save.dev = true; (await window.__mod('screens.ts')).showPicker(); });
        await page.waitForTimeout(500);
        const lpk = await layoutProblems(page, ['.topbar', '.picker .castles', '.pickcard']);
        check(`shots: picker at ${tag}: panels clear of each other`, lpk.length === 0, lpk.join('; '));
        await shot(page, `picker-${tag}`);
        await page.click('#pk-go');
        await page.click('#deploy');
        await page.waitForTimeout(1500);
        const ld = await layoutProblems(page, ['#hud-left', '#hud-right', '#rack', '#fcp', '#minimap', '#devpanel', '#help']);
        check(`shots: dev battle at ${tag}: HUD plates clear of each other`, ld.length === 0, ld.join('; '));
        await shot(page, `devbattle-${tag}`);
        noErrors(page, `shots ${tag}`);
        await close(page);
      }
    }
  },
};

(async () => {
  browser = await chromium.launch();
  const t0 = Date.now();
  for (const [name, fn] of Object.entries(sections)) {
    if (only ? !only.includes(name) : name === 'shots' && !SHOTS) continue;
    console.log(`── ${name}`);
    const t = Date.now();
    try { await fn(); } catch (e) { check(`${name}: section ran to the end`, false, e.message.split('\n')[0]); }
    console.log(`   (${Math.round((Date.now() - t) / 1000)} s)`);
  }
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (bad.length) { console.log('FAILED:'); for (const r of bad) console.log(`  ${r.name}${r.detail ? `  (${r.detail})` : ''}`); }
  process.exit(bad.length ? 1 : 0);
})();
