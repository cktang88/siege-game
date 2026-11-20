import { audio } from './audio';
import { resetSave, writeSave } from './progress';
import { DEFAULTS, SET, resetSettings, setSetting, type Settings } from './settings';
import { S } from './state';

/*
  The settings sheets, shared by the settings screen (from the operations map) and the pause menu in battle.
  Every control writes through setSetting, which stores the settings and applies them at once.
*/

type NumKey = 'master' | 'music' | 'sfx' | 'chargeDist' | 'panSpeed' | 'shake';
type BoolKey = 'muted' | 'mouseAim' | 'aimDistance' | 'trajectory' | 'helpLine' | 'autoCam' | 'briefCard';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const FMT: Record<NumKey, (v: number) => string> = {
  master: pct, music: pct, sfx: pct, shake: (v) => (v === 0 ? 'off' : pct(v)), panSpeed: (v) => `${v.toFixed(1)}×`,
  chargeDist: (v) => `${Math.round(v * 100)}% wide`,
};

const row = (label: string, hint: string, control: string, cls = '') =>
  `<div class="srow ${cls}"><div class="sl"><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</div><div class="sc">${control}</div></div>`;
const slider = (k: NumKey, min: number, max: number, step: number) =>
  `<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${SET[k]}"><span class="readout" data-v="${k}">${FMT[k](SET[k])}</span>`;
const sw = (k: BoolKey, on = 'On', off = 'Off') =>
  `<button class="switch ${SET[k] ? 'on' : ''}" data-b="${k}" data-on="${on}" data-off="${off}" aria-pressed="${SET[k]}">${SET[k] ? on : off}</button>`;
const seg = <K extends 'quality' | 'uiScale'>(k: K, opts: [Settings[K], string][]) =>
  `<div class="seg">${opts.map(([v, t]) => `<button data-s="${k}" data-sv="${v}" class="${SET[k] === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;

const QUALITY_NOTE: Record<Settings['quality'], string> = {
  high: 'Full particle pools, bloom, sharp pixels on high-DPI screens.',
  medium: 'Particle pools at 60%, bloom on, pixel ratio up to 1.5.',
  low: 'Particle pools at 35%, no bloom, 1× pixels, coarser fire and smoke.',
};

/** the settings sections; `inBattle` leaves out the campaign records (no wiping a save mid-battle) */
export function settingsSheets(inBattle = false) {
  const totalStars = Object.values(S.save.stars).reduce((a, b) => a + b, 0);
  const cleared = Object.values(S.save.stars).filter((n) => n > 0).length;
  return `<div class="sheets">
    <section class="plate sheet-s">
      <header><span class="stencil">Signals</span><small>sound</small></header>
      ${row('Master volume', '', slider('master', 0, 1, 0.05))}
      ${row('Music', 'the field march under the guns', slider('music', 0, 1, 0.05))}
      ${row('Effects', 'guns, blasts, fire and the UI', slider('sfx', 0, 1, 0.05))}
      ${row('Mute all', 'M in battle', sw('muted', 'Muted', 'Off'))}
    </section>
    <section class="plate sheet-s">
      <header><span class="stencil">Fire control</span><small>aiming</small></header>
      ${row('Mouse aim', 'the barrel follows the cursor when a battle starts · T toggles it in battle', sw('mouseAim'))}
      ${row('Distance sets velocity', 'the further the cursor from the gun, the harder the charge. Off: elevation only; set velocity with the wheel, ← →, or the dial', sw('aimDistance'))}
      ${row('Full-charge distance', 'how far from the gun (share of the screen width) the cursor gives a full charge', slider('chargeDist', 0.25, 0.9, 0.05), SET.aimDistance ? '' : 'dim')}
      ${row('Trajectory dots', 'the preview arc in front of the gun (research makes it longer)', sw('trajectory', 'Shown', 'Hidden'))}
    </section>
    <section class="plate sheet-s">
      <header><span class="stencil">Field camera</span><small>view</small></header>
      ${row('Auto camera', 'frames infantry and vehicles at your gun, and widens for incoming aircraft · panning or zooming hands you the camera for 8 s · R re-centres', sw('autoCam'))}
      ${row('Pan speed', 'WASD scrolling (Shift is faster still)', slider('panSpeed', 0.4, 2.5, 0.1))}
      ${row('Screen shake', 'from the gun and from blasts', slider('shake', 0, 1.5, 0.05))}
    </section>
    <section class="plate sheet-s">
      <header><span class="stencil">Optics</span><small>graphics</small></header>
      ${row('Effects quality', `<span data-qnote>${QUALITY_NOTE[SET.quality]}</span>`, seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]))}
      ${row('UI scale', 'panels, plates and screens', seg('uiScale', [[90, '90%'], [100, '100%'], [115, '115%']]))}
      ${row('Controls line', 'the one-line key reminder along the bottom of the battle screen', sw('helpLine', 'Shown', 'Hidden'))}
      ${row('Orders card', 'the operation and its objectives in the middle of the screen before the battle clock starts (Space to dismiss)', sw('briefCard', 'Shown', 'Skip'))}
      <div class="srow foot"><button class="btn ghost small" data-act="defaults">Restore default settings</button></div>
    </section>
    ${inBattle ? '' : `<section class="plate sheet-s">
      <header><span class="stencil">Records</span><small>campaign save</small></header>
      ${row('Campaign', `${cleared} operation${cleared === 1 ? '' : 's'} taken · ★ ${totalStars} · ${S.save.funds.toLocaleString()} war funds · ${S.save.tech.length} research`, '<button class="btn small danger" data-act="reset">Reset progress</button>')}
      <p class="snote">Wipes stars, records, war funds and research back to a fresh commission. Settings are kept. This cannot be undone.</p>
    </section>`}
    <section class="plate sheet-s dev">
      <header><span class="stencil">Dev mode</span><small>sandbox</small></header>
      ${row('Dev mode', 'every castle, every technology, unlimited rounds of every munition and an enemy spawn panel in battle', `<button class="switch ${S.save.dev ? 'on' : ''}" data-act="dev">${S.save.dev ? 'On' : 'Off'}</button>`)}
      <p class="snote">Lasts for this browser tab only and is never written to the save. Open the game with <b>?dev</b> on the address (e.g. <b>…/siege-game/?dev</b>) to start in it. Dev battles pay no war funds and record no stars.</p>
    </section>
  </div>`;
}

/** wire the controls inside `root`; `rerender` redraws the sheets when a change alters them (dev toggle, reset) */
export function wireSettings(root: HTMLElement, rerender: () => void) {
  root.querySelectorAll<HTMLInputElement>('input[type=range][data-k]').forEach((el) => {
    const k = el.dataset.k as NumKey;
    el.addEventListener('input', () => {
      setSetting(k, +el.value);
      const v = root.querySelector(`[data-v="${k}"]`);
      if (v) v.textContent = FMT[k](SET[k]);
      // a short tick so the effects level can be heard while dragging
      if (k === 'sfx' || k === 'master') audio.play('click');
    });
    // mouse: let go of the keys afterwards; keyboard: keep focus so the arrows can keep stepping
    el.addEventListener('pointerup', () => el.blur());
  });
  root.querySelectorAll<HTMLElement>('[data-b]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.b as BoolKey;
    setSetting(k, !SET[k]);
    b.classList.toggle('on', SET[k]);
    b.setAttribute('aria-pressed', String(SET[k]));
    b.textContent = SET[k] ? b.dataset.on! : b.dataset.off!;
    if (k === 'mouseAim') S.mouseAim = SET.mouseAim;
    if (k === 'aimDistance') root.querySelector('[data-k="chargeDist"]')?.closest('.srow')?.classList.toggle('dim', !SET.aimDistance);
  }));
  root.querySelectorAll<HTMLElement>('[data-s]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.s as 'quality' | 'uiScale';
    if (k === 'quality') setSetting('quality', b.dataset.sv as Settings['quality']);
    else setSetting('uiScale', +b.dataset.sv! as Settings['uiScale']);
    root.querySelectorAll<HTMLElement>(`[data-s="${k}"]`).forEach((x) => x.classList.toggle('on', x.dataset.sv === String(SET[k])));
    const note = root.querySelector('[data-qnote]');
    if (note) note.textContent = QUALITY_NOTE[SET.quality];
  }));
  root.querySelector('[data-act="defaults"]')?.addEventListener('click', () => { resetSettings(); S.mouseAim = DEFAULTS.mouseAim; rerender(); });
  root.querySelector('[data-act="dev"]')?.addEventListener('click', () => { S.save.dev = !S.save.dev; writeSave(S.save); rerender(); });
  // reset progress: the first press arms it, a second within 4 s wipes the save
  const reset = root.querySelector<HTMLButtonElement>('[data-act="reset"]');
  let armed = 0;
  reset?.addEventListener('click', () => {
    if (performance.now() < armed) {
      resetSave(S.save);
      S.selectedNode = 'outpost';
      audio.play('stamp');
      rerender();
      return;
    }
    armed = performance.now() + 4000;
    reset.classList.add('armed');
    reset.textContent = 'Confirm: erase all progress';
    setTimeout(() => { if (performance.now() >= armed && reset.isConnected) { reset.classList.remove('armed'); reset.textContent = 'Reset progress'; } }, 4050);
  });
}
