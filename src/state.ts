import type { AmmoId } from './config';
import type { Game } from './game';
import type { LevelDef } from './levels';
import { loadSave, type Save } from './progress';
import type { Renderer } from './render';

export type Mode = 'map' | 'tech' | 'armory' | 'battle' | 'result' | 'settings' | 'picker';

/** shared app state, wired up in main.ts */
export const S = {
  mode: 'map' as Mode,
  save: loadSave() as Save,
  game: null as unknown as Game,
  renderer: null as unknown as Renderer,
  level: null as unknown as LevelDef,
  /** campaign node id, or null for dev proving grounds */
  nodeId: null as string | null,
  selectedNode: 'outpost',
  cart: {} as Partial<Record<AmmoId, number>>,
  /** the level the cart was filled for: coming back to the same operation keeps it */
  cartFor: null as string | null,
  /** dev mode: unlimited budget in the armory */
  devBudget: false,
  /** armory survey: hover blocks on the field to read them */
  survey: false,
  /** battle: the barrel follows the mouse over the battlefield (T toggles; the default is a setting) */
  mouseAim: true,
  /** dev mode: the armory issues every munition, unlimited, with no budget (off: buy rounds as normal) */
  devSandbox: true,
  /** this battle was started in dev mode: it never pays out or records anything, even if dev mode is turned off mid-battle */
  devBattle: false,
  /** battle halted behind the pause menu */
  paused: false,
  /** dev panel: simulation speed (1 = normal, 0.25 = slow motion) */
  timeScale: 1,
};

export const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

export const icon = (id: string) => `ui/am_${id}.png`;
