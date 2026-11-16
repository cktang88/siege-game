import './style.css';
import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { AMMO, AMMO_BY_ID, MATERIALS, TARGETS, type AmmoId, type TargetKind } from './config';
import { Game, type Block } from './game';
import { LEVELS, type LevelDef } from './levels';
import { Renderer, loadTextures } from './render';

THREE.ColorManagement.enabled = false;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const canvas = $<HTMLCanvasElement>('#view');
const screen = $('#screen');
const hud = $('#hud');

let renderer: Renderer;
let game: Game;
let state: 'title' | 'shop' | 'battle' | 'result' = 'title';
let levelIdx = 0;
let cart: Partial<Record<AmmoId, number>> = {};
const labels = new Map<Block, HTMLElement>();

// ───────────────────────── persistence ─────────────────────────
function loadProgress(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem('siege-progress') || '{}'); } catch { return {}; }
}
function saveProgress(id: string, stars: number) {
  try {
    const p = loadProgress();
    p[id] = Math.max(p[id] ?? 0, stars);
    localStorage.setItem('siege-progress', JSON.stringify(p));
  } catch { /* storage unavailable */ }
}

const css = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
const icon = (id: AmmoId) => {
  const a = AMMO_BY_ID[id];
  return `<div class="ico" style="background:radial-gradient(circle at 35% 35%, ${css(a.color.map((v) => v * 1.6) as [number, number, number])}, ${css(a.color)} 70%)">${a.short}</div>`;
};

// ───────────────────────── screens ─────────────────────────
function showTitle() {
  state = 'title';
  hud.classList.add('hidden');
  clearLabels();
  game.load(LEVELS[levelIdx]);
  const prog = loadProgress();
  screen.innerHTML = `<div class="modal" style="max-width:860px">
    <h1>Siege</h1>
    <p>Plan before you fire. Read the structure like an engineer, pick your munitions within budget, and bring the fortress down before the enemy rebuilds, returns fire, or overruns your gun.</p>
    <div class="levels">${LEVELS.map((l, i) => `<div class="lvl" data-i="${i}">
      <div class="nm">${i + 1}. ${l.name}</div>
      <div class="st">${'★'.repeat(prog[l.id] ?? 0)}<span style="opacity:.2">${'★'.repeat(3 - (prog[l.id] ?? 0))}</span></div>
      <p>${l.brief}</p></div>`).join('')}</div>
  </div>`;
  screen.querySelectorAll<HTMLElement>('.lvl').forEach((el) => el.addEventListener('click', () => { levelIdx = +el.dataset.i!; showShop(); }));
}

function cartCost() { return (Object.keys(cart) as AmmoId[]).reduce((s, k) => s + (cart[k] ?? 0) * AMMO_BY_ID[k].price, 0); }

function showShop(keepCart = false) {
  state = 'shop';
  const lvl = LEVELS[levelIdx];
  game.load(lvl);
  hud.classList.add('hidden');
  if (!keepCart) cart = {};
  buildLabels();
  renderShop(lvl);
}

function renderShop(lvl: LevelDef) {
  const left = lvl.budget - cartCost();
  const objs = lvl.objectives.map((k) => TARGETS[k].desc).join(', ');
  const windTxt = `${Math.abs(game.wind).toFixed(1)} m/s ${game.wind >= 0 ? '→' : '←'}`;
  screen.innerHTML = `<div class="modal" id="shop-modal">
    <div class="shop">
      <div>
        <h2>${lvl.name}</h2>
        <p>${lvl.brief}</p>
        <p><b style="color:var(--ink)">Objectives:</b> ${objs}</p>
        <ul class="intel">${lvl.intel.map((i) => `<li>${i}</li>`).join('')}<li>Forecast wind: ${windTxt}</li></ul>
        <div style="margin-top:14px;color:var(--dim);font-size:13px">Budget remaining</div>
        <div class="budget">$${left}</div>
        <div style="font-size:12px;color:var(--dim);margin-bottom:12px">Unspent money and unfired rounds add to your score.</div>
        <div class="row-btns" style="justify-content:flex-start">
          <button class="btn" id="deploy" ${cartCost() === 0 ? 'disabled' : ''}>Deploy</button>
          <button class="btn ghost" id="survey">Survey fortress</button>
          <button class="btn ghost" id="back">Back</button>
        </div>
      </div>
      <div class="cards">${AMMO.map((a) => {
        const n = cart[a.id] ?? 0;
        return `<div class="card ${n ? 'has' : ''}">
          <div class="top">${icon(a.id).replace('class="ico"', 'class="ico"')}<div class="nm">${a.name}</div><div class="pr">$${a.price}</div></div>
          <div class="d">${a.desc}</div>
          <div class="gb"><span class="g">+ ${a.good}</span><br><span class="b">− ${a.bad}</span></div>
          <div class="qty"><button data-a="${a.id}" data-d="-1" ${n ? '' : 'disabled'}>−</button><span>${n}</span><button data-a="${a.id}" data-d="1" ${a.price <= left ? '' : 'disabled'}>+</button></div>
        </div>`;
      }).join('')}</div>
    </div>
  </div>`;
  screen.querySelectorAll<HTMLButtonElement>('.qty button').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.a as AmmoId;
    cart[id] = Math.max(0, (cart[id] ?? 0) + +b.dataset.d!);
    if (!cart[id]) delete cart[id];
    renderShop(lvl);
  }));
  $('#deploy').addEventListener('click', startBattle);
  $('#back').addEventListener('click', showTitle);
  $('#survey').addEventListener('click', () => {
    screen.innerHTML = `<div style="position:absolute;top:16px;left:50%;transform:translateX(-50%)" class="panel"><div style="padding:10px 14px;display:flex;gap:12px;align-items:center">
      <span style="font-size:13px;color:var(--dim)">Hover blocks to inspect materials. Wheel to zoom, right-drag to pan.</span><button class="btn" id="ret">Back to armory</button></div></div>`;
    $('#ret').addEventListener('click', () => renderShop(lvl));
  });
}

function startBattle() {
  state = 'battle';
  screen.innerHTML = '';
  hud.classList.remove('hidden');
  game.start(cart, cartCost());
  $('#lvl-name').textContent = game.level.name;
  buildAmmoBar();
  updateObjectives();
}

function showResult(win: boolean, reason: string) {
  state = 'result';
  const sc = game.score();
  const stars = win ? sc.stars : 0;
  if (win) saveProgress(game.level.id, stars);
  const rows: [string, number][] = [
    ['Base', sc.parts.base], ['Time bonus', sc.parts.time], ['Budget discipline', sc.parts.budget],
    ['Optional targets', sc.parts.optional], ['Cannon condition', sc.parts.cannon], ['Collateral damage', sc.parts.collateral],
  ];
  const hasNext = levelIdx < LEVELS.length - 1;
  setTimeout(() => {
    screen.innerHTML = `<div class="modal" style="width:440px">
      <h2>${win ? 'Fortress fallen' : 'Mission failed'}</h2>
      <p>${reason}</p>
      ${win ? `<div class="stars">${[0, 1, 2].map((i) => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('')}</div>
      <table class="score">${rows.map(([k, v]) => `<tr><td>${k}</td><td style="color:${v < 0 ? 'var(--bad)' : 'inherit'}">${v}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td><b>${sc.total}</b></td></tr></table>
      <p style="font-size:12px">Time ${fmtTime(game.battleTime)} · Spent $${game.spentBudget} of $${game.level.budget}</p>` : ''}
      <div class="row-btns">
        <button class="btn ghost" id="menu">Levels</button>
        <button class="btn ghost" id="retry">Retry</button>
        ${win && hasNext ? '<button class="btn" id="next">Next</button>' : ''}
        ${!win ? '<button class="btn" id="rearm">Re-arm</button>' : ''}
      </div></div>`;
    $('#menu').addEventListener('click', showTitle);
    $('#retry').addEventListener('click', () => showShop(true));
    $('#next')?.addEventListener('click', () => { levelIdx++; showShop(); });
    $('#rearm')?.addEventListener('click', () => showShop(true));
  }, 900);
}

// ───────────────────────── HUD ─────────────────────────
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function buildAmmoBar() {
  const bar = $('#ammo-bar');
  const ids = (Object.keys(game.inventory) as AmmoId[]).sort((a, b) => AMMO.findIndex((x) => x.id === a) - AMMO.findIndex((x) => x.id === b));
  bar.innerHTML = ids.map((id, i) => `<button class="ammo-btn" data-a="${id}"><span class="key">${i < 9 ? i + 1 : ''}</span>${icon(id)}<div class="nm">${AMMO_BY_ID[id].name}</div><span class="ct"></span><div class="reload"></div></button>`).join('');
  bar.querySelectorAll<HTMLElement>('.ammo-btn').forEach((el) => {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', () => { game.selected = el.dataset.a as AmmoId; });
  });
}

function updateAmmoBar() {
  document.querySelectorAll<HTMLElement>('.ammo-btn').forEach((el) => {
    const id = el.dataset.a as AmmoId;
    const n = game.inventory[id] ?? 0;
    el.querySelector('.ct')!.textContent = String(n);
    el.classList.toggle('sel', game.selected === id);
    el.classList.toggle('empty', n <= 0);
    (el.querySelector('.reload') as HTMLElement).style.width = game.selected === id ? `${(game.reload / 1.4) * 100}%` : '0';
  });
}

function updateObjectives() {
  const l = game.level;
  const kinds = Object.keys(game.targetsTotal) as TargetKind[];
  kinds.sort((a, b) => +l.objectives.includes(b) - +l.objectives.includes(a));
  $('#objectives').innerHTML = kinds.map((k) => {
    const tot = game.targetsTotal[k] ?? 0, d = game.targetsDestroyed[k] ?? 0;
    const obj = l.objectives.includes(k);
    return `<li class="${d >= tot ? 'done' : ''} ${obj ? '' : 'opt'}"><span class="dot" style="background:${TARGETS[k].color}"></span>${obj ? '' : '(optional) '}${TARGETS[k].desc.split(' — ')[0]}${tot > 1 ? ` ${d}/${tot}` : ''}</li>`;
  }).join('');
}

function toast(text: string, tone = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild!.remove();
  setTimeout(() => { el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 3200);
}

function updateHud() {
  $('#timer').textContent = `${fmtTime(game.battleTime)} · par ${fmtTime(game.level.parTime)}`;
  const w = game.wind;
  $('#wind').textContent = `${w >= 0 ? '→' : '←'} ${Math.abs(w).toFixed(1)} m/s`;
  const hp = $('#hp-fill');
  hp.style.width = `${game.cannonHp}%`;
  hp.style.background = game.cannonHp > 50 ? 'var(--good)' : game.cannonHp > 25 ? 'var(--accent)' : 'var(--bad)';
  $('#collateral').textContent = String(Math.round(game.collateral));
  $('#collateral').style.color = game.collateral > 0 ? 'var(--bad)' : '';
  const hasGuns = game.liveTargets('artillery').length > 0;
  $('#blind-row').classList.toggle('hidden', !hasGuns);
  $('#blind').textContent = game.enemyBlind > 0 ? `blinded ${Math.ceil(game.enemyBlind)}s` : `firing in ${Math.max(0, Math.ceil(game.artT))}s`;
  const a = AMMO_BY_ID[game.selected];
  const ab = game.hasAbilityProjectile() ? ' · <b style="color:var(--accent)">TAP / SPACE: scatter</b>' : '';
  $('#aim-readout').innerHTML = a.mode === 'airstrike' ? 'Click the map to call in the bomber' : a.mode === 'drone' || a.mode === 'saboteur' ? 'Click or Space to deploy' + ab
    : `Angle ${(game.angle * 180 / Math.PI).toFixed(1)}° · ${game.launchSpeed.toFixed(1)} m/s${ab}`;
  updateAmmoBar();
}

function buildLabels() {
  clearLabels();
  const box = $('#labels');
  for (const b of game.blocks) {
    if (!b.target) continue;
    const el = document.createElement('div');
    const t = TARGETS[b.target];
    el.className = `tlabel ${game.level.objectives.includes(b.target) ? 'obj' : ''}`;
    el.style.color = t.color;
    el.style.borderColor = t.color;
    el.innerHTML = `${t.label}<div class="hp"><i></i></div>`;
    box.appendChild(el);
    labels.set(b, el);
  }
}
function clearLabels() { labels.forEach((el) => el.remove()); labels.clear(); }
function updateLabels() {
  labels.forEach((el, b) => {
    if (b.dead) { el.remove(); labels.delete(b); return; }
    const t = b.body.translation();
    const s = renderer.worldToScreen(t.x, t.y + b.h / 2 + 0.25);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    (el.querySelector('.hp i') as HTMLElement).style.width = `${Math.max(0, (b.hp / b.maxHp) * 100)}%`;
  });
}

// ───────────────────────── input ─────────────────────────
let down: { x: number; y: number; btn: number; cx: number; pan: number } | null = null;
let aiming = false;
let mouse = { x: 0, y: 0 };

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, btn: e.button, cx: renderer.cx, pan: game.pan };
  aiming = false;
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  if (down.btn === 2 || down.btn === 1 || state !== 'battle') {
    game.pan = down.pan - (dx / renderer.width) * renderer.viewW;
    return;
  }
  const a = AMMO_BY_ID[game.selected];
  if (a.mode === 'airstrike' || a.mode === 'drone' || a.mode === 'saboteur') return;
  if (!aiming && Math.hypot(dx, dy) > 10) aiming = true;
  if (aiming) {
    const vx = -dx, vy = dy; // pull back like a slingshot (screen y is down)
    game.setAngleDeg((Math.atan2(vy, vx) * 180) / Math.PI);
    game.setSpeed(6 + (game.stats.maxSpeed - 6) * Math.min(1, Math.hypot(dx, dy) / Math.min(320, renderer.height * 0.4)));
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const d = down;
  down = null;
  if (state !== 'battle' || d.btn !== 0) return;
  if (aiming) { aiming = false; game.fire(); return; }
  // click
  if (game.triggerAbility()) return;
  const a = AMMO_BY_ID[game.selected];
  if (a.mode === 'airstrike') game.fire(renderer.screenToWorld(e.clientX, e.clientY));
  else if (a.mode === 'drone' || a.mode === 'saboteur') game.fire();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  game.zoom = Math.max(0.6, Math.min(3, game.zoom * Math.exp(-e.deltaY * 0.0012)));
}, { passive: false });

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (state !== 'battle') return;
  keys.add(e.key);
  if (e.key === ' ') {
    e.preventDefault();
    if (!game.triggerAbility()) {
      const a = AMMO_BY_ID[game.selected];
      if (a.mode === 'airstrike') game.fire(renderer.screenToWorld(mouse.x, mouse.y));
      else game.fire();
    }
  }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) {
    const ids = Array.from(document.querySelectorAll<HTMLElement>('.ammo-btn')).map((el) => el.dataset.a as AmmoId);
    if (ids[n - 1]) game.selected = ids[n - 1];
  }
  if (e.key === 'r' || e.key === 'R') { game.zoom = 1; game.pan = 0; }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));

function handleKeys(dt: number) {
  const fine = keys.has('Shift') ? 0.25 : 1;
  const deg = (game.angle * 180) / Math.PI;
  if (keys.has('ArrowUp')) game.setAngleDeg(deg + dt * 20 * fine);
  if (keys.has('ArrowDown')) game.setAngleDeg(deg - dt * 20 * fine);
  if (keys.has('ArrowRight')) game.setSpeed(game.speed + dt * 6 * fine);
  if (keys.has('ArrowLeft')) game.setSpeed(game.speed - dt * 6 * fine);
}

function updateTooltip() {
  const tip = $('#tooltip');
  if (down || (state !== 'battle' && state !== 'shop')) { tip.classList.add('hidden'); return; }
  const w = renderer.screenToWorld(mouse.x, mouse.y);
  const b = game.pickBlock(w.x, w.y);
  if (!b) { tip.classList.add('hidden'); return; }
  const m = MATERIALS[game.shownMat(b)];
  const known = game.revealed || !b.def.disguise;
  const hp = known ? `${Math.max(0, Math.round(b.hp))}/${Math.round(b.maxHp)}` : '?';
  tip.innerHTML = `<b>${b.target ? TARGETS[b.target].label + ' · ' : ''}${m.name}</b> ${b.highlight ? '<span style="color:#f3d36a">· load-bearing</span>' : ''}<br>
    <span style="color:var(--dim)">${m.blurb} HP ${hp}${b.burning > 0 ? ' · <span style="color:#f08a3a">burning</span>' : ''}</span>`;
  tip.classList.remove('hidden');
  hud.classList.remove('hidden');
  if (state === 'shop') { document.querySelectorAll<HTMLElement>('#hud > *:not(#tooltip)').forEach((el) => el.style.visibility = 'hidden'); }
  else document.querySelectorAll<HTMLElement>('#hud > *').forEach((el) => el.style.visibility = '');
  tip.style.left = `${Math.min(mouse.x + 16, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${mouse.y + 18}px`;
}

// ───────────────────────── loop ─────────────────────────
let last = performance.now();
let acc = 0;
let focusHold = 0;
let lastFocus: { x: number; y: number } | null = null;

function pickFocus(): { x: number; y: number } | null {
  const own = game.projectiles.filter((p) => !p.enemy && !p.dead && !p.pellet);
  if (own.length) {
    const p = own[own.length - 1];
    return { x: p.x, y: p.y };
  }
  if (game.planes.length) return { x: game.planes[0].x + 6, y: game.planes[0].y - 8 };
  if (game.drones.length) return { x: game.drones[0].x, y: game.drones[0].y - 6 };
  if (game.saboteurs.length) return { x: game.saboteurs[0].x + 4, y: game.saboteurs[0].y + 4 };
  return null;
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state === 'battle' || state === 'result' || state === 'shop') {
    if (state === 'battle') handleKeys(dt);
    acc += dt;
    let steps = 0;
    while (acc >= 1 / 60 && steps < 4) {
      if (state !== 'shop') game.update(1 / 60);
      acc -= 1 / 60; steps++;
    }
    if (state === 'shop') { game.time += dt; game.syncMeshes(); }
    if (steps >= 4) acc = 0;
    for (const ev of game.events) {
      if (ev.type === 'toast') toast(ev.text, ev.tone);
      else if (ev.type === 'target') updateObjectives();
      else if (ev.type === 'end') showResult(ev.win, ev.reason);
    }
    game.events.length = 0;
    // camera
    const f = state === 'battle' || state === 'result' ? pickFocus() : null;
    if (f) { lastFocus = f; focusHold = 1.2; } else focusHold -= dt;
    game.focus = f ?? (focusHold > 0 ? lastFocus : null);
    game.frameCamera(false, dt);
    if (state === 'battle') {
      const a = AMMO_BY_ID[game.selected];
      game.updatePreview(aiming || (a.mode !== 'airstrike' && !game.focus));
      game.aimMarker.visible = a.mode === 'airstrike' || game.airMarker !== null;
      if (game.airMarker !== null) game.aimMarker.position.set(game.airMarker, game.groundY(game.airMarker) + 1, 13);
      else if (a.mode === 'airstrike') { const w = renderer.screenToWorld(mouse.x, mouse.y); game.aimMarker.position.set(w.x, game.groundY(w.x) + 1, 13); }
      updateHud();
    } else { game.updatePreview(false); game.aimMarker.visible = false; }
    updateLabels();
    updateTooltip();
  } else {
    game.time += dt;
    game.frameCamera(false, dt);
    game.syncMeshes();
  }
  renderer.render(dt, now / 1000);
  requestAnimationFrame(frame);
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  await Promise.all([RAPIER.init(), loadTextures()]);
  renderer = new Renderer(canvas, (x) => game?.groundY(x) ?? 0);
  renderer.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  game = new Game(renderer);
  window.addEventListener('resize', () => renderer.resize());
  (window as unknown as { siege: unknown }).siege = { game, renderer, startBattle, showShop, get cart() { return cart; }, set cart(v) { cart = v; } };
  showTitle();
  requestAnimationFrame(frame);
}
boot();
