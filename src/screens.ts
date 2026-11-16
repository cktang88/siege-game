import { AMMO_BY_ID, MATERIALS, SHOP_AMMO, TARGETS, type AmmoId } from './config';
import { CAMPAIGN, NODE_BY_ID, devCastles, nodeState } from './campaign';
import { startBattle } from './hud';
import type { LevelDef } from './levels';
import { BRANCHES, TECH, TECH_BY_ID, availableAmmo, canResearch, computeStats, hasTech, missionReward, research, writeSave, type Branch } from './progress';
import { $, S, icon } from './state';

const screen = () => $('#screen');
const totalStars = () => Object.values(S.save.stars).reduce((a, b) => a + b, 0);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function topbar(active: 'map' | 'tech' | 'armory') {
  return `<div class="topbar">
    <div class="plate title">Siege</div>
    <button class="btn ${active === 'map' ? '' : 'steel'}" data-go="map">Operations</button>
    <button class="btn ${active === 'tech' ? '' : 'steel'}" data-go="tech">Research</button>
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
    else if (g === 'dev') { S.save.dev = !S.save.dev; writeSave(S.save); rerender(); }
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
  const objs = lvl.objectives.map((o) => TARGETS[o].desc.split(' — ')[0]).join(', ');
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
    html += `<div class="label" style="margin-top:16px">Dev · every castle</div><div class="devlist">${devCastles().map((l, i) => `<button data-i="${i}">${esc(l.name)} <span style="opacity:.6">(${l.blocks.length} blocks)</span></button>`).join('')}</div>`;
  }
  const d = $('#dossier');
  d.innerHTML = html;
  d.querySelector('#plan')?.addEventListener('click', () => { S.nodeId = n.id; showArmory(lvl); });
  d.querySelectorAll<HTMLElement>('.devlist button').forEach((b) => b.addEventListener('click', () => {
    const l = devCastles()[+b.dataset.i!];
    const node = CAMPAIGN.find((c) => c.level().id === l.id);
    S.nodeId = node ? node.id : null;
    showArmory(l);
  }));
  // preview the castle behind the map
  setBattleView(lvl);
}

// ───────────────────────── Research ─────────────────────────
export function showTech() {
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
        const cls = owned ? 'owned' : reqOk ? `avail ${S.save.funds < n.cost ? 'poor' : ''}` : 'locked';
        return `<div class="tnode ${cls}" data-t="${n.id}">
          <span class="cost">${owned ? 'OWNED' : n.cost === 0 ? 'FREE' : n.cost}</span>
          <h4>${n.name}</h4><p>${n.desc}</p>
          ${n.unlocks ? `<div class="unl">${n.unlocks.map((a) => `<img src="${icon(a)}" title="${AMMO_BY_ID[a].name}">`).join('')}</div>` : ''}
          ${!owned && n.requires.length ? `<div class="req">needs ${n.requires.map((r) => TECH_BY_ID[r].name).join(' + ')}</div>` : ''}
        </div>`;
      }).join('')}</div>`).join('')}
    </section>`;
  };
  screen().innerHTML = `<div class="techscreen">${topbar('tech')}
    <div class="board">${branches.map(col).join('')}</div>
    <div style="margin:0 16px 20px;display:flex;gap:10px;align-items:center">
      <button class="btn ghost small" id="reset">Refund all research</button>
      <span class="mono" style="color:var(--bone-dim);font-size:12px">Refunds are free. Experiment.</span>
    </div></div>`;
  wireTopbar(showTech);
  screen().querySelectorAll<HTMLElement>('.tnode.avail').forEach((el) => el.addEventListener('click', () => {
    const n = TECH_BY_ID[el.dataset.t!];
    if (canResearch(S.save, n)) { research(S.save, n.id); showTech(); }
  }));
  $('#reset').addEventListener('click', () => {
    const refund = S.save.tech.reduce((s, id) => s + (TECH_BY_ID[id]?.cost ?? 0), 0);
    S.save.funds += refund;
    S.save.tech = ['ord_he'];
    writeSave(S.save);
    showTech();
  });
}

// ───────────────────────── Armory ─────────────────────────
const price = (id: AmmoId) => Math.round(AMMO_BY_ID[id].price * (computeStats(S.save).priceMult[id] ?? 1));
const budget = () => (S.devBudget && S.save.dev ? 99999 : Math.round(S.level.budget * computeStats(S.save).budgetMult));
const cartCost = () => (Object.keys(S.cart) as AmmoId[]).reduce((s, k) => s + (S.cart[k] ?? 0) * price(k), 0);

export function showArmory(level: LevelDef, keepCart = false) {
  S.mode = 'armory';
  setBattleView(level);
  $('#hud').classList.add('hidden');
  if (!keepCart) S.cart = {};
  renderArmory();
}

function renderArmory() {
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
      <div class="label" style="margin-top:14px">Funds remaining</div>
      <div class="budget">$${left.toLocaleString()}</div>
      <p style="font-size:12px;margin:4px 0 14px">Unspent funds and unfired rounds count toward your score.</p>
      ${S.save.dev ? `<label class="mono" style="font-size:12px;display:block;margin-bottom:10px"><input type="checkbox" id="devb" ${S.devBudget ? 'checked' : ''}> Dev: unlimited budget</label>` : ''}
      <div class="row-btns" style="justify-content:flex-start">
        <button class="btn" id="deploy" ${cartCost() === 0 ? 'disabled' : ''}>Deploy</button>
        <button class="btn ghost" id="survey">Survey</button>
        <button class="btn ghost" id="back">Back</button>
      </div>
    </div>
    <div class="plate rack">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="stencil" style="font-size:22px">Munitions rack</span><span class="label">Muzzle velocity cap ${st.maxSpeed} m/s · reload ${st.reload}s</span></div>
      <div class="rackgrid">${SHOP_AMMO().map((a) => {
        const has = owned.has(a.id);
        const n = S.cart[a.id] ?? 0;
        const p = price(a.id);
        if (!has) {
          const t = lockedBy(a.id);
          return `<div class="munition locked"><img src="${icon(a.id)}" alt=""><div class="nm">${a.name}</div><div class="d">Requires research: ${t ? t.name : '?'} (${t ? BRANCHES[t.branch].name : ''})</div><div></div></div>`;
        }
        return `<div class="munition ${n ? 'has' : ''}">
          <img src="${icon(a.id)}" alt="">
          <div class="nm">${a.name}<span>$${p}</span></div>
          <div class="d">${a.desc}</div>
          <div class="qty"><button data-a="${a.id}" data-d="-1" ${n ? '' : 'disabled'}>−</button><b>${n}</b><button data-a="${a.id}" data-d="1" ${p <= left ? '' : 'disabled'}>+</button></div>
          <div class="gb"><span class="g">+ ${a.good}</span> &nbsp; <span class="b">− ${a.bad}</span></div>
        </div>`;
      }).join('')}</div>
    </div>
  </div>`;
  screen().querySelectorAll<HTMLButtonElement>('.qty button').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.a as AmmoId;
    S.cart[id] = Math.max(0, (S.cart[id] ?? 0) + +b.dataset.d!);
    if (!S.cart[id]) delete S.cart[id];
    renderArmory();
  }));
  $('#devb')?.addEventListener('change', (e) => { S.devBudget = (e.target as HTMLInputElement).checked; renderArmory(); });
  $('#deploy').addEventListener('click', () => startBattle(S.cart, cartCost(), budget()));
  $('#back').addEventListener('click', showMap);
  $('#survey').addEventListener('click', () => {
    screen().innerHTML = `<div class="plate" style="position:absolute;top:14px;left:50%;transform:translateX(-50%);padding:10px 16px;display:flex;gap:12px;align-items:center">
      <span class="mono" style="font-size:13px;color:var(--bone-dim)">Hover blocks to inspect. Wheel zooms, right-drag pans.</span><button class="btn small" id="ret">Back to armory</button></div>`;
    $('#ret').addEventListener('click', renderArmory);
  });
}

// ───────────────────────── After-action report ─────────────────────────
export function showResult(win: boolean, reason: string) {
  S.mode = 'result';
  const g = S.game;
  const sc = g.score();
  const stars = win ? sc.stars : 0;
  let earned = 0;
  const id = S.nodeId;
  if (id && !S.save.dev) {
    const prev = S.save.stars[id] ?? 0;
    earned = win ? missionReward(sc.total, stars, prev) : Math.round(sc.total / 80);
    S.save.funds += earned;
    if (win) {
      S.save.stars[id] = Math.max(prev, stars);
      S.save.best[id] = Math.max(S.save.best[id] ?? 0, sc.total);
    }
    writeSave(S.save);
  } else if (id && S.save.dev && win) {
    S.save.stars[id] = Math.max(S.save.stars[id] ?? 0, stars);
    writeSave(S.save);
  }
  const rows: [string, number][] = [
    ['Base', sc.parts.base], ['Time vs. par', sc.parts.time], ['Budget discipline', sc.parts.budget],
    ['Secondary targets', sc.parts.optional], ['Gun condition', sc.parts.cannon], ['Collateral', sc.parts.collateral],
  ];
  setTimeout(() => {
    screen().innerHTML = `<div class="modalwrap"><div class="paper aar">
      <div class="stamp ${win ? 'ok' : ''}">${win ? 'Accomplished' : 'Failed'}</div>
      <div class="label">After-action report</div>
      <h2>${esc(g.level.name)}</h2>
      <p class="mono" style="font-size:13px">${esc(reason)}</p>
      ${win ? `<div class="stars">${[0, 1, 2].map((i) => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('')}</div>` : ''}
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td style="color:${v < 0 ? '#9a2a1a' : 'inherit'}">${v.toLocaleString()}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td><b>${sc.total.toLocaleString()}</b></td></tr></table>
      <p class="mono" style="font-size:12px">Time ${Math.floor(g.battleTime / 60)}:${String(Math.floor(g.battleTime % 60)).padStart(2, '0')} · Spent $${g.spentBudget}</p>
      ${earned ? `<p class="earn">+${earned.toLocaleString()} war funds</p>` : ''}
      <div class="row-btns">
        <button class="btn ghost" id="tomap">Operations map</button>
        <button class="btn ghost" id="retry">Retry</button>
        <button class="btn" id="research">Research</button>
      </div></div></div>`;
    $('#tomap').addEventListener('click', showMap);
    $('#retry').addEventListener('click', () => showArmory(S.level, true));
    $('#research').addEventListener('click', showTech);
  }, 900);
}

/** block inspector text */
export function blockTip(matShown: keyof typeof MATERIALS, known: boolean, hp: number, max: number, target: string | undefined, load: boolean, burning: boolean) {
  const m = MATERIALS[matShown];
  return `<b>${target ? target + ' · ' : ''}${m.name}</b>${load ? ' <span style="color:#f3d36a">· load-bearing</span>' : ''}<br>
    <span style="color:var(--bone-dim)">${m.blurb} HP ${known ? `${Math.max(0, Math.round(hp))}/${Math.round(max)}` : '?'}${burning ? ' · <span style="color:#f08a3a">burning</span>' : ''}</span>`;
}
