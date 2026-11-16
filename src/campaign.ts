import { generateLevel, type GenSpec } from './fortgen';
import { LEVELS, type LevelDef } from './levels';

export interface CampaignNode {
  id: string;
  /** position on the war map, percent */
  mx: number;
  my: number;
  /** cleared nodes that open this one (any of them) */
  from: string[];
  /** total stars needed before it can be attempted */
  starGate?: number;
  level: () => LevelDef;
  region: string;
}

const hand = (i: number) => () => LEVELS[i];
const gen = (spec: GenSpec) => {
  let cache: LevelDef | null = null;
  return () => (cache ??= generateLevel(spec));
};

/**
 * A branching front. Clearing a node opens one or two neighbours, so there are always
 * a few operations to choose from; a few deep nodes also need a star total.
 */
export const CAMPAIGN: CampaignNode[] = [
  { id: 'outpost', mx: 12, my: 70, from: [], level: hand(0), region: 'Border' },
  { id: 'millford', mx: 20, my: 44, from: [], region: 'Border', level: gen({ id: 'millford', name: 'Millford Stockade', seed: 11, theme: 'timber', difficulty: 1, village: true }) },
  { id: 'cleancut', mx: 28, my: 82, from: ['outpost'], level: hand(3), region: 'Border' },
  { id: 'redhill', mx: 33, my: 58, from: ['outpost', 'millford'], region: 'Lowlands', level: gen({ id: 'redhill', name: 'Redhill Keep', seed: 23, theme: 'stone', difficulty: 2 }) },
  { id: 'saltworks', mx: 36, my: 26, from: ['millford'], region: 'Lowlands', level: gen({ id: 'saltworks', name: 'Saltworks Depot', seed: 37, theme: 'mixed', difficulty: 2, objectives: ['command', 'ammo'] }) },
  { id: 'bastion', mx: 49, my: 70, from: ['redhill', 'cleancut'], level: hand(1), region: 'Lowlands' },
  { id: 'causeway', mx: 52, my: 42, from: ['redhill', 'saltworks'], region: 'River Line', level: gen({ id: 'causeway', name: 'Causeway Redoubt', seed: 51, theme: 'concrete', difficulty: 3 }) },
  { id: 'ironmill', mx: 63, my: 22, from: ['saltworks', 'causeway'], starGate: 10, region: 'River Line', level: gen({ id: 'ironmill', name: 'Ironmill Works', seed: 67, theme: 'mixed', difficulty: 3, village: true }) },
  { id: 'citadel', mx: 66, my: 62, from: ['bastion', 'causeway'], level: hand(2), region: 'River Line' },
  { id: 'greywater', mx: 76, my: 40, from: ['citadel', 'ironmill'], starGate: 16, region: 'Highlands', level: gen({ id: 'greywater', name: 'Greywater Fortress', seed: 83, theme: 'concrete', difficulty: 4 }) },
  { id: 'hollowcrown', mx: 80, my: 78, from: ['citadel'], starGate: 14, region: 'Highlands', level: gen({ id: 'hollowcrown', name: 'Hollow Crown', seed: 97, theme: 'stone', difficulty: 4, village: true }) },
  { id: 'thronefall', mx: 90, my: 56, from: ['greywater', 'hollowcrown'], starGate: 22, region: 'Capital', level: gen({ id: 'thronefall', name: 'Thronefall Citadel', seed: 131, theme: 'mixed', difficulty: 5, objectives: ['command', 'ammo'] }) },
];

export const NODE_BY_ID = Object.fromEntries(CAMPAIGN.map((n) => [n.id, n])) as Record<string, CampaignNode>;

export type NodeState = 'locked' | 'gated' | 'open' | 'cleared';

export function nodeState(n: CampaignNode, stars: Record<string, number>, dev: boolean): NodeState {
  if ((stars[n.id] ?? 0) > 0) return 'cleared';
  if (dev) return 'open';
  const reachable = n.from.length === 0 || n.from.some((f) => (stars[f] ?? 0) > 0);
  if (!reachable) return 'locked';
  const total = Object.values(stars).reduce((a, b) => a + b, 0);
  if (n.starGate && total < n.starGate) return 'gated';
  return 'open';
}

/** dev mode: every castle, including extra procedurally generated ones */
export function devCastles(): LevelDef[] {
  const extra: LevelDef[] = [];
  const themes = ['timber', 'stone', 'concrete', 'mixed'] as const;
  for (let i = 0; i < 12; i++) {
    extra.push(generateLevel({ id: `dev${i}`, name: `Proving Ground ${i + 1}`, seed: 1000 + i * 17, theme: themes[i % 4], difficulty: 1 + (i % 5) }));
  }
  return [...CAMPAIGN.map((n) => n.level()), ...extra];
}
