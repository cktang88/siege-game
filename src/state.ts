import type { AmmoId } from './config';
import type { Game } from './game';
import type { LevelDef } from './levels';
import { loadSave, type Save } from './progress';
import type { Renderer } from './render';

export type Mode = 'map' | 'tech' | 'armory' | 'battle' | 'result';

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
  /** dev mode: unlimited budget in the armory */
  devBudget: false,
  /** armory survey: hover blocks on the field to read them */
  survey: false,
  /** battle: the barrel follows the mouse over the battlefield (T toggles) */
  mouseAim: true,
};

export const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

export const icon = (id: string) => `ui/am_${id}.png`;
