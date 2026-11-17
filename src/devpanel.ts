import { DEV_CAP, type DevUnit } from './game';
import { toast } from './hud';
import { $, S } from './state';

/*
  Dev sandbox panel in battle (dev mode only): put any number of enemy units on the field, and switches
  for the enemy's timers, the gun's armour, reload and simulation speed. ` (backquote) folds it away.
*/

const UNITS: [DevUnit, string, string][] = [
  ['infantry', 'Infantry', 'riflemen from the castle foot'],
  ['shield', 'Shield inf.', 'pavise or ballistic shield'],
  ['car', 'Armd. car', 'fast, MG turret'],
  ['tank', 'Light tank', 'sloped glacis, main gun'],
  ['gyro', 'Gyrocopter', 'strafes the gun'],
  ['airship', 'Airship', 'bombs the gun'],
];

let count = 1;
let folded = false;

export function buildDevPanel() {
  document.querySelector('#devpanel')?.remove();
  if (!S.save.dev) return;
  const g = S.game;
  const el = document.createElement('div');
  el.id = 'devpanel';
  el.className = `plate ${folded ? 'folded' : ''}`;
  const tog = (k: string, label: string, on: boolean, title: string) => `<button class="switch ${on ? 'on' : ''}" data-t="${k}" title="${title}">${label}</button>`;
  el.innerHTML = `<div class="head"><span class="stencil">Dev sandbox</span><button class="fold" title="Fold the panel (\`)">${folded ? '+' : '−'}</button></div>
    <div class="body">
      <div class="drow"><span class="label">Spawn</span><div class="seg cnt">${[1, 5, 10].map((n) => `<button data-n="${n}" class="${count === n ? 'on' : ''}">×${n}</button>`).join('')}</div></div>
      <div class="spawns">${UNITS.map(([k, name, tip]) => `<button data-u="${k}" title="${tip}"><b>${name}</b><span data-c="${k}">0</span></button>`).join('')}</div>
      <div class="label" style="margin:8px 0 4px">Switches</div>
      <div class="toggles">
        ${tog('freeze', 'Freeze enemy', g.dev.freeze, 'Stop the enemy timers: no counter-battery fire, reinforcements, repairs, air raids or motor pool sorties')}
        ${tog('god', 'God-mode gun', g.dev.god, 'Your gun takes no damage')}
        ${tog('reload', 'Instant reload', g.dev.instantReload, 'No reload wait between shots')}
        ${tog('slow', 'Slow-mo ¼', S.timeScale < 1, 'Run the simulation at quarter speed')}
      </div>
      <div class="drow" style="margin-top:6px"><button class="btn ghost small" data-a="reveal" title="Break open every concealed room">Reveal rooms</button><button class="btn ghost small" data-a="clear" title="Kill every enemy unit on the field">Clear field</button></div>
      <div class="foot mono">${g.dev.unlimited ? 'Rack: every round ∞' : 'Rack: bought rounds'} · not scored</div>
    </div>`;
  $('#hud').appendChild(el);
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.querySelector('.fold')!.addEventListener('click', () => toggleDevPanel());
  el.querySelectorAll<HTMLElement>('[data-n]').forEach((b) => b.addEventListener('click', () => {
    count = +b.dataset.n!;
    el.querySelectorAll('[data-n]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  el.querySelectorAll<HTMLElement>('[data-u]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.u as DevUnit;
    const made = S.game.devSpawn(k, count);
    if (made < count) toast(`Dev cap: at most ${k === 'car' || k === 'tank' ? DEV_CAP.vehicle + ' vehicles' : k === 'gyro' || k === 'airship' ? DEV_CAP.air + ' aircraft' : DEV_CAP.infantry + ' infantry'} alive at once.`, 'bad');
    b.blur();
  }));
  el.querySelectorAll<HTMLElement>('[data-t]').forEach((b) => b.addEventListener('click', () => {
    const d = S.game.dev, t = b.dataset.t;
    if (t === 'freeze') d.freeze = !d.freeze;
    else if (t === 'god') d.god = !d.god;
    else if (t === 'reload') d.instantReload = !d.instantReload;
    else if (t === 'slow') S.timeScale = S.timeScale < 1 ? 1 : 0.25;
    const on = t === 'freeze' ? d.freeze : t === 'god' ? d.god : t === 'reload' ? d.instantReload : S.timeScale < 1;
    b.classList.toggle('on', on);
    b.blur();
  }));
  el.querySelector('[data-a="reveal"]')!.addEventListener('click', () => {
    const n = S.game.devRevealRooms();
    toast(n ? `${n} hidden room${n > 1 ? 's' : ''} opened.` : 'No hidden rooms left.');
  });
  el.querySelector('[data-a="clear"]')!.addEventListener('click', () => S.game.devClearField());
}

export function toggleDevPanel() {
  const el = document.querySelector<HTMLElement>('#devpanel');
  if (!el) return;
  folded = !folded;
  el.classList.toggle('folded', folded);
  el.querySelector('.fold')!.textContent = folded ? '+' : '−';
}

/** live unit tallies on the spawn buttons */
let tick = 0;
export function updateDevPanel() {
  if (tick++ % 10) return;
  const el = document.querySelector('#devpanel');
  if (!el || folded) return;
  const g = S.game;
  const n: Record<DevUnit, number> = { infantry: 0, shield: 0, car: 0, tank: 0, gyro: 0, airship: 0 };
  for (const s of g.soldiers) if (!s.dead) n[s.shield > 0 ? 'shield' : 'infantry']++;
  for (const u of g.motor.alive) n[u.kind]++;
  for (const u of g.air.units) if (!u.down) n[u.kind]++;
  for (const k of Object.keys(n) as DevUnit[]) { const c = el.querySelector(`[data-c="${k}"]`); if (c && c.textContent !== String(n[k])) c.textContent = String(n[k]); }
}
