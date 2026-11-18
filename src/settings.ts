/*
  Player settings: stored in their own localStorage key, apart from the campaign save, and applied live.
  Every field is checked on load, so missing, old or hand-edited data falls back to the defaults.
*/

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  /** volumes, 0..1 */
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
  /** the barrel follows the mouse over the battlefield when a battle starts (T toggles it in battle) */
  mouseAim: boolean;
  /** with mouse aim, the cursor's distance from the gun sets muzzle velocity (off: wheel, keys and dials only) */
  aimDistance: boolean;
  /** cursor distance for a full charge, as a fraction of the screen width */
  chargeDist: number;
  /** the camera frames threats at the gun and incoming aircraft by itself (manual pan or zoom suspends it for a few seconds) */
  autoCam: boolean;
  /** WASD camera pan speed multiplier */
  panSpeed: number;
  /** screen shake multiplier (0 = none) */
  shake: number;
  quality: Quality;
  /** trajectory preview dots in front of the gun */
  trajectory: boolean;
  /** the one-line controls reminder at the bottom of the battle screen */
  helpLine: boolean;
  /** UI scale, percent */
  uiScale: 90 | 100 | 115;
  /** the fire-control panel folded to one row (the dials hidden) */
  compactFcp: boolean;
}

export const SETTINGS_KEY = 'siege-settings-v1';

export const DEFAULTS: Settings = {
  master: 0.8, music: 0.6, sfx: 1, muted: false,
  mouseAim: true, aimDistance: true, chargeDist: 0.6, autoCam: true, panSpeed: 1,
  shake: 1, quality: 'high', trajectory: true, helpLine: true, uiScale: 100, compactFcp: false,
};

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const pick = <T>(v: unknown, opts: readonly T[], d: T) => (opts.includes(v as T) ? (v as T) : d);

export function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const D = DEFAULTS;
  return {
    master: num(r.master, 0, 1, D.master),
    music: num(r.music, 0, 1, D.music),
    sfx: num(r.sfx, 0, 1, D.sfx),
    muted: bool(r.muted, D.muted),
    mouseAim: bool(r.mouseAim, D.mouseAim),
    aimDistance: bool(r.aimDistance, D.aimDistance),
    chargeDist: num(r.chargeDist, 0.25, 0.9, D.chargeDist),
    autoCam: bool(r.autoCam, D.autoCam),
    panSpeed: num(r.panSpeed, 0.4, 2.5, D.panSpeed),
    shake: num(r.shake, 0, 1.5, D.shake),
    quality: pick(r.quality, ['low', 'medium', 'high'] as const, D.quality),
    trajectory: bool(r.trajectory, D.trajectory),
    helpLine: bool(r.helpLine, D.helpLine),
    uiScale: pick(r.uiScale, [90, 100, 115] as const, D.uiScale),
    compactFcp: bool(r.compactFcp, D.compactFcp),
  };
}

export function loadSettings(): Settings {
  let raw: unknown = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* storage unavailable or corrupt */ }
  const s = sanitize(raw);
  // carry over the mute flag from before settings had their own key
  if (raw === null) {
    try { if (localStorage.getItem('siege-muted') === '1') s.muted = true; } catch { /* storage unavailable */ }
  }
  return s;
}

export function writeSettings(s: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** the live settings object; change it through setSetting so it is saved and applied */
export const SET: Settings = loadSettings();

const listeners: ((s: Settings, key: keyof Settings | null) => void)[] = [];
/** run `fn` now and after every change */
export function onSettings(fn: (s: Settings, key: keyof Settings | null) => void) { listeners.push(fn); fn(SET, null); }

export function setSetting<K extends keyof Settings>(k: K, v: Settings[K]) {
  SET[k] = sanitize({ ...SET, [k]: v })[k];
  writeSettings(SET);
  for (const fn of listeners) fn(SET, k);
}

export function resetSettings() {
  Object.assign(SET, DEFAULTS);
  writeSettings(SET);
  for (const fn of listeners) fn(SET, null);
}
