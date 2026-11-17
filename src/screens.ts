import { AMMO_BY_ID, MATERIALS, SHOP_AMMO, type AmmoId } from './config';
import { CAMPAIGN, NODE_BY_ID, devCatalog, generateCastle, nodeState } from './campaign';
import { startBattle, targetName } from './hud';
import type { LevelDef } from './levels';
import { BRANCHES, TECH, TECH_BY_ID, availableAmmo, canRefund, canResearch, computeStats, dependents, hasTech, missionReward, refund, research, salvageReward, writeSave, type Branch, type Reward } from './progress';
import { $, S, icon } from './state';
import { audio } from './audio';
import { settingsSheets, wireSettings } from './settingsui';

const screen = () => $('#screen');
const totalStars = () => Object.values(S.save.stars).reduce((a, b) => a + b, 0);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function topbar(active: 'map' | 'tech' | 'armory' | 'settings' | 'picker') {
  return `<div class="topbar">
    <div class="plate title">Siege</div>
    <button class="btn ${active === 'map' ? '' : 'steel'}" data-go="map">Operations</button>
    <button class="btn ${active === 'tech' ? '' : 'steel'}" data-go="tech">Research</button>
    ${S.save.dev ? `<button class="btn ${active === 'picker' ? '' : 'steel'}" data-go="picker" title="Dev: pick any castle, or generate one">Castles</button>` : ''}
    <button class="btn ${active === 'settings' ? '' : 'steel'}" data-go="settings">Settings</button>
    <div class="spacer"></div>
    <div class="plate chip stars"><span class="label">Stars</span><b>★ ${totalStars()}</b></div>
    <div class="plate chip funds"><span class="label">War funds</span><b>${S.save.funds.toLocaleString()}</b></div>
    <button class="btn small ${S.save.dev ? 'dev-on' : 'ghost'}" data-go="dev" title="Dev mode: every castle and every technology">Dev ${S.save.dev ? 'on' : 'off'}</button>
  </div>`;
}

function wireTopbar(rerender: () => void) {
  screen().querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.go;
    if (g === 'map') showMap();
    else if (g === 'tech') showTech();
    else if (g === 'settings') showSettings();
    else if (g === 'picker') showPicker();
    else if (g === 'dev') { S.save.dev = !S.save.dev; writeSave(S.save); if (!S.save.dev && S.mode === 'picker') showMap(); else rerender(); }
  }));
}

function setBattleView(level: LevelDef) {
  S.level = level;
  S.game.stats = computeStats(S.save);
  S.game.load(level);
}

// ───────────────────────── Operations map ─────────────────────────
export function showMap() {
  S.mode = 'map';
  $('#hud').classList.add('hidden');
  $('#labels').innerHTML = '';
  const stars = S.save.stars;
  const dev = S.save.dev;
  const lines = CAMPAIGN.flatMap((n) => n.from.map((f) => {
    const a = NODE_BY_ID[f];
    const lit = (stars[f] ?? 0) > 0 || dev;
    return `<line x1="${a.mx}" y1="${a.my}" x2="${n.mx}" y2="${n.my}" class="${lit ? '' : 'dim'}" vector-effect="non-scaling-stroke"/>`;
  })).join('');
  const nodes = CAMPAIGN.map((n, i) => {
    const st = nodeState(n, stars, dev);
    const s = stars[n.id] ?? 0;
    const lvl = n.level();
    return `<div class="node ${st} ${S.selectedNode === n.id ? 'sel' : ''}" data-n="${n.id}" style="left:${n.mx}%;top:${n.my}%">
      <div class="pin"><i>${st === 'gated' ? '★' : i + 1}</i></div>
      <div class="nm">${esc(lvl.name)}</div>
      <div class="st">${st === 'cleared' ? '★'.repeat(s) + '☆'.repeat(3 - s) : st === 'gated' ? `needs ★${n.starGate}` : ''}</div>
    </div>`;
  }).join('');
  screen().innerHTML = `<div class="opmap">
    ${topbar('map')}
    <div class="sheet"><svg class="routes" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>${nodes}<div class="front">Western front · operations map</div></div>
    <div class="paper dossier" id="dossier"></div>
  </div>`;
  wireTopbar(showMap);
  screen().querySelectorAll<HTMLElement>('.node').forEach((el) => el.addEventListener('click', () => {
    S.selectedNode = el.dataset.n!;
    screen().querySelectorAll('.node').forEach((x) => x.classList.toggle('sel', x === el));
    renderDossier();
  }));
  renderDossier();
}

function renderDossier() {
  const n = NODE_BY_ID[S.selectedNode] ?? CAMPAIGN[0];
  const st = nodeState(n, S.save.stars, S.save.dev);
  const lvl = n.level();
  const stats = computeStats(S.save);
  const s = S.save.stars[n.id] ?? 0;
  const best = S.save.best[n.id];
  const reason = st === 'locked' ? `Clear ${n.from.map((f) => NODE_BY_ID[f].level().name).join(' or ')} first.`
    : st === 'gated' ? `High command wants ★${n.starGate} total before committing to ${n.region}. You have ★${totalStars()}.` : '';
  const objs = lvl.objectives.map((o) => targetName(o)).join(', ');
  let html = `<div class="stamp classified ${st === 'cleared' ? 'ok' : ''}">${st === 'cleared' ? 'Taken' : st === 'open' ? 'Priority' : 'Classified'}</div>
    <div class="region">${esc(n.region)} sector</div>
    <h2>${esc(lvl.name)}</h2>
    <p>${esc(lvl.brief)}</p>
    <div class="label">Objectives</div><p style="margin-top:3px">${objs}</p>
    <div class="label">Intelligence</div>
    <ul>${lvl.intel.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    <div class="meta">
      <div>Budget<b>$${Math.round(lvl.budget * stats.budgetMult)}</b></div>
      <div>Par time<b>${lvl.parTime}s</b></div>
      <div>Record<b>${best ? best.toLocaleString() : '—'}</b></div>
      <div>Stars<b style="color:#8a6a10">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</b></div>
    </div>`;
  html += st === 'locked' || st === 'gated' ? `<p><b>${reason}</b></p>` : `<button class="btn" id="plan" style="width:100%">Plan the assault</button>`;
  if (S.save.dev) {
    html += `<div class="label" style="margin-top:16px">Dev · sandbox</div><p style="margin-top:3px">Every munition unlimited, no budget, nothing saved. Any castle, generated ones included, is in the castle picker.</p><button class="btn ghost small" id="topicker" style="width:100%">Open the castle picker</button>`;
  }
  const d = $('#dossier');
  d.innerHTML = html;
  d.querySelector('#plan')?.addEventListener('click', () => { S.nodeId = n.id; showArmory(lvl); });
  d.querySelector('#topicker')?.addEventListener('click', showPicker);
  // preview the castle behind the map
  setBattleView(lvl);
}

// ───────────────────────── Research ─────────────────────────
/** a picture for upgrades that unlock nothing: the munition they improve, else the branch insignia */
const TECH_ICON: Record<string, AmmoId> = {
  ord_he2: 'he', ord_ap2: 'ap', ord_napalm: 'incendiary', ord_cluster2: 'cluster', ord_drill2: 'drill',
  gun_shell2: 'heavy', air_bay: 'airstrike', air_dive: 'airstrike', air_inc: 'incendiary', air_pen: 'bunker', air_ecm: 'airstrike', air_bay2: 'airstrike',
  sp_drone2: 'drone', sp_sab2: 'saboteur', sp_charge: 'sticky', sp_fuse: 'sticky', log_bulk: 'shell',
};
const techIcon = (n: { id: string; branch: Branch; unlocks?: AmmoId[] }) => {
  const a = n.unlocks?.[0] ?? TECH_ICON[n.id];
  return a ? `<img src="${icon(a)}" alt="">` : `<img class="ins" src="ui/ins_${n.branch}.png" alt="">`;
};

export function showTech() {
  const prevScroll = S.mode === 'tech' ? screen().querySelector('.techscreen')?.scrollTop ?? 0 : 0;
  S.mode = 'tech';
  $('#hud').classList.add('hidden');
  const branches = Object.keys(BRANCHES) as Branch[];
  const col = (b: Branch) => {
    const nodes = TECH.filter((t) => t.branch === b);
    const tiers = [...new Set(nodes.map((n) => n.tier))].sort((a, c) => a - c);
    return `<section class="plate branch">
      <header><img src="ui/ins_${b}.png" alt=""><div><h3>${BRANCHES[b].name}</h3><small>${BRANCHES[b].motto}</small></div></header>
      ${tiers.map((t) => `<div class="tier-label">TIER ${['I', 'II', 'III', 'IV', 'V', 'VI'][t - 1]}</div><div class="tnodes">${nodes.filter((n) => n.tier === t).map((n) => {
        const owned = hasTech(S.save, n.id);
        const reqOk = n.requires.every((r) => hasTech(S.save, r));
        const poor = S.save.funds < n.cost;
        const cls = owned ? `owned ${canRefund(S.save, n.id) ? 'refundable' : ''}` : reqOk ? `avail ${poor ? 'poor' : ''}` : 'locked';
        const deps = owned ? dependents(S.save, n.id) : [];
        const tip = owned ? (S.save.dev ? 'Dev mode: every technology is on' : n.id === 'ord_he' ? 'Standard issue' : deps.length ? `Refund ${deps.map((d) => d.name).join(', ')} first` : `Click to refund ${n.cost}`)
          : reqOk ? (poor ? `Need ${n.cost - S.save.funds} more war funds` : `Click to research for ${n.cost}`) : '';
        return `<div class="tnode ${cls}" data-t="${n.id}" title="${tip}">
          <div class="ic">${techIcon(n)}</div>
          <div class="tx">
            <div class="top"><h4>${n.name}</h4><span class="cost">${owned ? (canRefund(S.save, n.id) ? `<span class="own">OWNED</span><span class="ref">REFUND ${n.cost}</span>` : 'OWNED') : n.cost === 0 ? 'FREE' : n.cost}</span></div>
            <p>${n.desc}</p>
            ${!owned && !reqOk ? `<div class="req">needs ${n.requires.filter((r) => !hasTech(S.save, r)).map((r) => TECH_BY_ID[r].name).join(' + ')}</div>` : ''}
          </div>
        </div>`;
      }).join('')}</div>`).join('')}
    </section>`;
  };
  screen().innerHTML = `<div class="techscreen">${topbar('tech')}
    <div class="techbar">
      <span class="mono">Click an orange card to research it. Click an owned card to refund it in full (top of a branch first). Refunds are free: experiment.</span>
      <button class="btn ghost small" id="reset">Refund all research</button>
    </div>
    <div class="board">${branches.map(col).join('')}</div>
  </div>`;
  screen().querySelector('.techscreen')!.scrollTop = prevScroll;
  wireTopbar(showTech);
  screen().querySelectorAll<HTMLElement>('.tnode.avail').forEach((el) => el.addEventListener('click', () => {
    const n = TECH_BY_ID[el.dataset.t!];
    if (canResearch(S.save, n)) { research(S.save, n.id); audio.play('stamp'); audio.play('coins', undefined, 1, 1, 120); showTech(); }
  }));
  screen().querySelectorAll<HTMLElement>('.tnode.refundable').forEach((el) => el.addEventListener('click', () => {
    if (refund(S.save, el.dataset.t!)) { audio.play('coins', undefined, 1, 1, 0); showTech(); }
  }));
  const reset = $<HTMLButtonElement>('#reset');
  reset.disabled = S.save.dev || S.save.tech.every((id) => id === 'ord_he');
  reset.addEventListener('click', () => {
    if (S.save.dev) return;
    const back = S.save.tech.reduce((s, id) => s + (TECH_BY_ID[id]?.cost ?? 0), 0);
    S.save.funds += back;
    S.save.tech = ['ord_he'];
    writeSave(S.save);
    showTech();
  });
}

// ───────────────────────── Armory ─────────────────────────
const price = (id: AmmoId) => Math.round(AMMO_BY_ID[id].price * (computeStats(S.save).priceMult[id] ?? 1));
const budget = () => (S.devBudget && S.save.dev ? 99999 : Math.round(S.level.budget * computeStats(S.save).budgetMult));
/** dev sandbox rack: every munition, unlimited, nothing bought */
const sandbox = () => S.save.dev && S.devSandbox;
const cartCost = () => (Object.keys(S.cart) as AmmoId[]).reduce((s, k) => s + (S.cart[k] ?? 0) * price(k), 0);

export function showArmory(level: LevelDef, keepCart = false) {
  S.mode = 'armory';
  setBattleView(level);
  $('#hud').classList.add('hidden');
  S.survey = false;
  if (!keepCart) S.cart = {};
  // a kept cart (retry) may hold rounds whose research was refunded, or cost more than the budget now allows
  const owned = new Set(availableAmmo(S.save));
  for (const id of Object.keys(S.cart) as AmmoId[]) if (!owned.has(id)) delete S.cart[id];
  for (const id of (Object.keys(S.cart) as AmmoId[]).sort((a, b) => price(b) - price(a))) {
    while ((S.cart[id] ?? 0) > 0 && cartCost() > budget()) S.cart[id]! -= 1;
    if (!S.cart[id]) delete S.cart[id];
  }
  renderArmory();
}

/** press-and-hold on +/−: one step now, then repeats that speed up while held */
let hold: { id: AmmoId; d: number; timer: number; n: number } | null = null;
function stopHold() { if (hold) { clearTimeout(hold.timer); hold = null; } }
window.addEventListener('pointerup', stopHold);
window.addEventListener('pointercancel', stopHold);
window.addEventListener('blur', stopHold);

function stepCart(id: AmmoId, d: number, mult = 1) {
  const have = S.cart[id] ?? 0;
  let n = Math.max(0, have + d * mult);
  // never overspend
  while (n > have && cartCost() + (n - have) * price(id) > budget()) n--;
  if (n === have) return false;
  S.cart[id] = n;
  if (!S.cart[id]) delete S.cart[id];
  renderArmory();
  return true;
}

function renderArmory() {
  const scroll = (document.querySelector('.armory .rack') as HTMLElement | null)?.scrollTop ?? 0;
  const lvl = S.level;
  const owned = new Set(availableAmmo(S.save));
  const left = budget() - cartCost();
  const w = S.game.wind;
  const st = computeStats(S.save);
  const windTxt = st.windReadout ? `${Math.abs(w).toFixed(1)} m/s ${w >= 0 ? 'east' : 'west'}` : `${Math.abs(w) < 1.5 ? 'light' : Math.abs(w) < 3 ? 'moderate' : 'strong'} ${w >= 0 ? 'easterly drift' : 'westerly drift'}`;
  const lockedBy = (id: AmmoId) => TECH.find((t) => t.unlocks?.includes(id));
  screen().innerHTML = `<div class="armory">
    <div class="paper brief">
      <div class="label">Operation order</div>
      <h2>${esc(lvl.name)}</h2>
      <p>${esc(lvl.brief)}</p>
      <ul style="font:13px/1.45 var(--mono);padding-left:16px">${lvl.intel.map((i) => `<li>${esc(i)}</li>`).join('')}<li>Forecast: ${windTxt}</li></ul>
      ${sandbox() ? `<div class="label" style="margin-top:14px">Dev sandbox</div>
      <div class="budget">∞</div>
      <p style="font-size:12px;margin:4px 0 14px">Every munition, researched or not, unlimited and free. Nothing from this battle is scored into the campaign.</p>` : `<div class="label" style="margin-top:14px">Funds remaining</div>
      <div class="budget">$${left.toLocaleString()}</div>
      <p style="font-size:12px;margin:4px 0 14px">Unspent funds and unfired rounds count toward your score.</p>`}
      ${S.save.dev ? `<label class="mono devchk"><input type="checkbox" id="devsand" ${S.devSandbox ? 'checked' : ''}> Dev: sandbox rack (every round ∞)</label>` : ''}
      ${S.save.dev && !S.devSandbox ? `<label class="mono devchk"><input type="checkbox" id="devb" ${S.devBudget ? 'checked' : ''}> Dev: unlimited budget</label>` : ''}
      <div class="row-btns" style="justify-content:flex-start">
        <button class="btn" id="deploy" ${cartCost() === 0 && !sandbox() ? 'disabled title="Buy at least one round first"' : ''}>Deploy</button>
        <button class="btn ghost" id="survey">Survey</button>
        <button class="btn ghost" id="back">Back</button>
      </div>
      ${cartCost() === 0 && !sandbox() ? '<p class="mono nudge">Buy rounds with <b>+</b> on the munitions rack, then deploy.</p>' : ''}
    </div>
    <div class="plate rack">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="stencil" style="font-size:22px">Munitions rack</span><span class="label">Muzzle velocity cap ${st.maxSpeed} m/s · reload ${st.reload}s</span></div>
      <div class="rackgrid">${SHOP_AMMO().map((a) => {
        const has = owned.has(a.id);
        const n = S.cart[a.id] ?? 0;
        const p = price(a.id);
        if (sandbox()) {
          return `<div class="munition has">
          <img src="${icon(a.id)}" alt="">
          <div class="nm">${a.name}<span>free</span></div>
          <div class="d">${a.desc}</div>
          <div class="qty inf"><b>∞</b>${has ? '' : '<span class="label">unresearched</span>'}</div>
          <div class="gb"><span class="g">+ ${a.good}</span> &nbsp; <span class="b">− ${a.bad}</span></div>
        </div>`;
        }
        if (!has) {
          const t = lockedBy(a.id);
          return `<div class="munition locked"><img src="${icon(a.id)}" alt=""><div class="nm">${a.name}</div><div class="d">Requires research: ${t ? t.name : '?'} (${t ? BRANCHES[t.branch].name : ''})</div><div></div></div>`;
        }
        return `<div class="munition ${n ? 'has' : ''}">
          <img src="${icon(a.id)}" alt="">
          <div class="nm">${a.name}<span>$${p}</span></div>
          <div class="d">${a.desc}</div>
          <div class="qty"><button data-a="${a.id}" data-d="-1" ${n ? '' : 'disabled'} title="Remove one">−</button><b>${n}</b><button data-a="${a.id}" data-d="1" ${p <= left ? 'title="Add one (shift-click: five)"' : `disabled title="Not enough funds left ($${left})"`}>+</button></div>
          <div class="gb"><span class="g">+ ${a.good}</span> &nbsp; <span class="b">− ${a.bad}</span></div>
        </div>`;
      }).join('')}</div>
    </div>
  </div>`;
  const rack = document.querySelector('.armory .rack') as HTMLElement | null;
  if (rack) rack.scrollTop = scroll;
  screen().querySelectorAll<HTMLButtonElement>('.qty button').forEach((b) => {
    const id = b.dataset.a as AmmoId, d = +b.dataset.d!;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      stopHold();
      // shift buys/sells five at a time
      if (!stepCart(id, d, e.shiftKey ? 5 : 1)) return;
      const tick = () => {
        if (!hold) return;
        hold.n++;
        if (!stepCart(id, d, e.shiftKey ? 5 : 1)) { stopHold(); return; }
        audio.play('click');
        hold.timer = window.setTimeout(tick, hold.n < 6 ? 120 : hold.n < 16 ? 70 : 40);
      };
      hold = { id, d, n: 0, timer: window.setTimeout(tick, 380) };
    });
    // keyboard activation (Enter/Space on a focused button) still works
    b.addEventListener('click', (e) => { if (e.detail === 0) stepCart(id, d, 1); });
  });
  $('#devb')?.addEventListener('change', (e) => { S.devBudget = (e.target as HTMLInputElement).checked; renderArmory(); });
  $('#devsand')?.addEventListener('change', (e) => { S.devSandbox = (e.target as HTMLInputElement).checked; renderArmory(); });
  $('#deploy').addEventListener('click', () => {
    if (sandbox()) startBattle(Object.fromEntries(SHOP_AMMO().map((a) => [a.id, 1])), 0, 0, true);
    else startBattle(S.cart, cartCost(), budget());
  });
  $('#back').addEventListener('click', showMap);
  $('#survey').addEventListener('click', () => {
    S.survey = true;
    screen().innerHTML = `<div class="plate" style="position:absolute;top:14px;left:50%;transform:translateX(-50%);padding:10px 16px;display:flex;gap:12px;align-items:center">
      <span class="mono" style="font-size:13px;color:var(--bone-dim)">Hover blocks to inspect. Wheel zooms, drag pans.</span><button class="btn small" id="ret">Back to armory</button></div>`;
    $('#ret').addEventListener('click', () => { S.survey = false; renderArmory(); });
  });
}

// ───────────────────────── After-action report ─────────────────────────
export function showResult(win: boolean, reason: string) {
  S.mode = 'result';
  const g = S.game;
  const sc = g.score();
  // taking the objectives always clears the operation, so a win is worth at least one star
  const stars = win ? Math.max(1, sc.stars) : 0;
  let reward: Reward = { total: 0, lines: [] };
  let record = false;
  let opened: string[] = [];
  const id = S.nodeId;
  // a battle begun in dev mode never touches the save, even if dev mode was switched off during it
  const dev = S.save.dev || S.devBattle;
  if (id && !dev) {
    const prev = S.save.stars[id] ?? 0;
    const prevBest = S.save.best[id] ?? 0;
    if (win) {
      const before = new Set(CAMPAIGN.filter((n) => nodeState(n, S.save.stars, false) === 'open').map((n) => n.id));
      reward = missionReward(sc.total, stars, prev, prevBest);
      record = sc.total > prevBest;
      S.save.stars[id] = Math.max(prev, stars);
      S.save.best[id] = Math.max(prevBest, sc.total);
      opened = CAMPAIGN.filter((n) => !before.has(n.id) && nodeState(n, S.save.stars, false) === 'open').map((n) => n.id);
      if (opened.length) S.selectedNode = opened[0];
    } else {
      const obj = g.level.objectives;
      const tot = obj.reduce((a, k) => a + (g.targetsTotal[k] ?? 0), 0);
      const hit = obj.reduce((a, k) => a + Math.min(g.targetsDestroyed[k] ?? 0, g.targetsTotal[k] ?? 0), 0);
      reward = salvageReward(S.save, id, tot ? hit / tot : 0);
    }
    S.save.funds += reward.total;
    writeSave(S.save);
  }
  const earned = reward.total;
  const rows: [string, number][] = [
    ['Base', sc.parts.base], ['Time vs. par', sc.parts.time], ['Budget discipline', sc.parts.budget],
    ['Secondary targets', sc.parts.optional], ['Garrison casualties', sc.parts.garrison], ['Gun condition', sc.parts.cannon], ['Collateral', sc.parts.collateral],
  ];
  const payNote = dev ? 'Dev battle: no score, stars or war funds go into the campaign.'
    : !id ? '' : earned ? ''
    : win ? 'No new stars or record: replays pay only for improvements.'
    : (S.save.stars[id] ?? 0) > 0 ? 'Failed replays pay nothing.' : 'No salvage: knock out more objectives than last time to earn some.';
  // a failed attempt scores nothing: show what still stands instead of a points table
  const objRows = g.level.objectives.map((k) => {
    const tot = g.targetsTotal[k] ?? 0, d = Math.min(tot, g.targetsDestroyed[k] ?? 0);
    return `<tr class="${d >= tot ? 'done' : 'left'}"><td>${d >= tot ? '✓' : '✗'} ${targetName(k)}</td><td>${d}/${tot}</td></tr>`;
  }).join('');
  const standing = g.level.objectives.filter((k) => (g.targetsDestroyed[k] ?? 0) < (g.targetsTotal[k] ?? 0)).map((k) => targetName(k));
  const why = win || !standing.length ? reason : `${reason} Still standing: ${standing.join(', ')}.`;
  const thresholds = g.level.stars.map((t, i) => `${'★'.repeat(i + 1)} ${t.toLocaleString()}`).join(' · ');
  const nextNames = opened.map((n) => NODE_BY_ID[n].level().name);
  audio.play(win ? 'win' : 'fail');
  setTimeout(() => {
    if (S.mode !== 'result') return;
    if (win) for (let i = 0; i < stars; i++) audio.play('star', undefined, 0.8, 1 + i * 0.12, 250 + i * 330);
    if (earned) audio.play('coins', undefined, 1, 1, 400 + stars * 330);
    screen().innerHTML = `<div class="modalwrap"><div class="paper aar">
      <div class="stamp ${win ? 'ok' : ''}">${win ? 'Accomplished' : 'Failed'}</div>
      <div class="label">After-action report${dev ? ' <span class="devtag">dev · not scored</span>' : ''}</div>
      <h2>${esc(g.level.name)}</h2>
      <p class="mono" style="font-size:13px">${esc(why)}</p>
      ${win ? `<div class="stars">${[0, 1, 2].map((i) => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('')}</div>` : ''}
      ${win ? '' : `<div class="label">Objectives</div><table class="objtally">${objRows}</table>`}
      ${!win ? '' : `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td style="color:${v < 0 ? '#9a2a1a' : 'inherit'}">${v.toLocaleString()}</td></tr>`).join('')}
      <tr><td><b>Total</b>${record && win ? ' <span class="rec">new record</span>' : ''}</td><td><b>${sc.total.toLocaleString()}</b></td></tr></table>`}
      <p class="mono" style="font-size:12px;margin:0 0 4px">Time ${Math.floor(g.battleTime / 60)}:${String(Math.floor(g.battleTime % 60)).padStart(2, '0')} · Spent $${g.spentBudget}${win ? ` · Stars at ${thresholds}` : ''}</p>
      ${earned ? `<p class="earn">+${earned.toLocaleString()} war funds <span>${reward.lines.map(([k, v]) => `${k} +${v}`).join(' · ')}</span></p>` : ''}
      ${payNote ? `<p class="mono" style="font-size:12px;opacity:.75">${payNote}</p>` : ''}
      ${nextNames.length ? `<p class="mono opened">New operation${nextNames.length > 1 ? 's' : ''} open: <b>${nextNames.map(esc).join(', ')}</b></p>` : ''}
      <div class="row-btns">
        <button class="btn ${win ? '' : 'ghost'}" id="tomap">Operations map</button>
        <button class="btn ${win ? 'ghost' : ''}" id="retry">Retry</button>
        <button class="btn ghost" id="research">Research</button>
      </div></div></div>`;
    $('#tomap').addEventListener('click', showMap);
    $('#retry').addEventListener('click', () => showArmory(S.level, true));
    $('#research').addEventListener('click', showTech);
  }, 900);
}

// ───────────────────────── Settings ─────────────────────────
export function showSettings() {
  const prevScroll = S.mode === 'settings' ? screen().querySelector('.settingsscreen')?.scrollTop ?? 0 : 0;
  S.mode = 'settings';
  $('#hud').classList.add('hidden');
  screen().innerHTML = `<div class="settingsscreen">${topbar('settings')}
    <div class="setbar"><span class="stencil">Standing orders</span><span class="mono">Changes take effect at once and are kept in this browser.</span></div>
    ${settingsSheets(false)}
  </div>`;
  screen().querySelector('.settingsscreen')!.scrollTop = prevScroll;
  wireTopbar(showSettings);
  wireSettings(screen().querySelector('.settingsscreen')!, showSettings);
}

// ───────────────────────── Dev: castle picker ─────────────────────────
let picked: LevelDef | null = null;
const gen = { kind: 'fort' as 'fort' | 'grand', seed: 1234, difficulty: 3, theme: 'stone' as 'timber' | 'stone' | 'concrete' | 'mixed' };

export function showPicker() {
  if (!S.save.dev) { showMap(); return; }
  S.mode = 'picker';
  $('#hud').classList.add('hidden');
  const scroll = screen().querySelector('.picker .castles')?.scrollTop ?? 0;
  const groups = devCatalog();
  const lv = picked ?? S.level;
  const cell = (l: LevelDef) => `<button class="castle ${lv && lv.id === l.id ? 'on' : ''}" data-id="${esc(l.id)}">
      <b>${esc(l.name)}</b><span>${l.blocks.length} blocks${l.rooms?.length ? ` · ${l.rooms.length} rooms` : ''}${l.difficulty ? ` · d${l.difficulty}` : ''}</span></button>`;
  const themes = gen.kind === 'grand' ? ['stone', 'concrete', 'mixed'] : ['timber', 'stone', 'concrete', 'mixed'];
  if (!themes.includes(gen.theme)) gen.theme = 'stone';
  const dMin = gen.kind === 'grand' ? 5 : 1, dMax = gen.kind === 'grand' ? 8 : 5;
  gen.difficulty = Math.max(dMin, Math.min(dMax, gen.difficulty));
  screen().innerHTML = `<div class="picker">${topbar('picker')}
    <div class="plate castles">
      <div class="phead"><span class="stencil">Castle picker</span><span class="label">dev · any castle, any time</span></div>
      ${groups.map((g) => `<div class="pgroup"><div class="label">${g.title} <i>${g.levels.length} · ${g.note}</i></div><div class="pgrid">${g.levels.map(cell).join('')}</div></div>`).join('')}
    </div>
    <div class="paper pickcard">
      <div class="label">Selected</div>
      <h2>${esc(lv.name)}</h2>
      <p class="mono">${lv.blocks.length} blocks · ${lv.rooms?.length ?? 0} rooms · objectives: ${lv.objectives.map((o) => targetName(o)).join(', ')}${lv.difficulty ? ` · difficulty ${lv.difficulty}` : ''}</p>
      <button class="btn" id="pk-go" style="width:100%">Plan the assault</button>
      <div class="label" style="margin-top:16px">Random generated</div>
      <div class="genform">
        <span>Generator</span><div class="seg pseg"><button data-gk="fort" class="${gen.kind === 'fort' ? 'on' : ''}">Fortress</button><button data-gk="grand" class="${gen.kind === 'grand' ? 'on' : ''}">Grand</button></div>
        <span>Theme</span><div class="seg pseg">${themes.map((t) => `<button data-gt="${t}" class="${gen.theme === t ? 'on' : ''}">${t}</button>`).join('')}</div>
        <span>Seed</span><div class="gin"><input id="pk-seed" type="number" min="1" step="1" value="${gen.seed}"><button class="btn ghost small" id="pk-roll" title="Random seed">Roll</button></div>
        <span>Difficulty</span><div class="gin"><input id="pk-diff" type="number" min="${dMin}" max="${dMax}" step="1" value="${gen.difficulty}"><i>${dMin}–${dMax}</i></div>
      </div>
      <button class="btn steel" id="pk-gen" style="width:100%;margin-top:10px">Generate</button>
    </div>
  </div>`;
  screen().querySelector('.picker .castles')!.scrollTop = scroll;
  wireTopbar(showPicker);
  const all = groups.flatMap((g) => g.levels);
  screen().querySelectorAll<HTMLElement>('.castle').forEach((b) => b.addEventListener('click', () => {
    picked = all.find((l) => l.id === b.dataset.id) ?? null;
    if (picked) setBattleView(picked);
    showPicker();
  }));
  const readForm = () => {
    gen.seed = Math.max(1, Math.floor(+$<HTMLInputElement>('#pk-seed').value || 1));
    gen.difficulty = Math.round(+$<HTMLInputElement>('#pk-diff').value || dMin);
  };
  screen().querySelectorAll<HTMLElement>('[data-gk]').forEach((b) => b.addEventListener('click', () => { readForm(); gen.kind = b.dataset.gk as 'fort' | 'grand'; gen.difficulty = gen.kind === 'grand' ? 6 : 3; showPicker(); }));
  screen().querySelectorAll<HTMLElement>('[data-gt]').forEach((b) => b.addEventListener('click', () => { readForm(); gen.theme = b.dataset.gt as 'stone'; showPicker(); }));
  $('#pk-roll').addEventListener('click', () => { readForm(); gen.seed = 1 + Math.floor(Math.random() * 99999); showPicker(); });
  $('#pk-gen').addEventListener('click', () => {
    readForm();
    picked = generateCastle(gen.kind, gen.seed, gen.difficulty, gen.theme);
    setBattleView(picked);
    showPicker();
  });
  $('#pk-go').addEventListener('click', () => {
    const node = CAMPAIGN.find((c) => c.level().id === lv.id);
    S.nodeId = node ? node.id : null;
    showArmory(lv);
  });
  if (S.level !== lv) setBattleView(lv);
}

/** block inspector text */
export function blockTip(matShown: keyof typeof MATERIALS, known: boolean, hp: number, max: number, target: string | undefined, load: boolean, burning: boolean) {
  const m = MATERIALS[matShown];
  return `<b>${target ? target + ' · ' : ''}${m.name}</b>${load ? ' <span style="color:#f3d36a">· load-bearing</span>' : ''}<br>
    <span style="color:var(--bone-dim)">${m.blurb} HP ${known ? `${Math.max(0, Math.round(hp))}/${Math.round(max)}` : '?'}${burning ? ' · <span style="color:#f08a3a">burning</span>' : ''}</span>`;
}
