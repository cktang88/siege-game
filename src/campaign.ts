import { generateLevel, type GenSpec } from './fortgen';
import { generateGrand, type GrandSpec } from './grandgen';
import { THEMED, compose } from './archetypes';
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
const grand = (spec: GrandSpec) => {
  let cache: LevelDef | null = null;
  return () => (cache ??= generateGrand(spec));
};
const themed = (id: string) => {
  let cache: LevelDef | null = null;
  return () => (cache ??= compose(THEMED.find((t) => t.id === id)!));
};
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
  { id: 'millford', mx: 18, my: 44, from: [], region: 'Border', level: gen({ id: 'millford', name: 'Millford Stockade', seed: 11, theme: 'timber', difficulty: 1, village: true }) },
  { id: 'cleancut', mx: 24, my: 82, from: ['outpost'], level: hand(3), region: 'Border' },
  { id: 'redhill', mx: 28, my: 58, from: ['outpost', 'millford'], region: 'Lowlands', level: themed('kurogane') },
  { id: 'saltworks', mx: 31, my: 26, from: ['millford'], region: 'Lowlands', level: themed('saltworks') },
  { id: 'bastion', mx: 41, my: 70, from: ['redhill', 'cleancut'], level: hand(1), region: 'Lowlands' },
  { id: 'causeway', mx: 44, my: 42, from: ['redhill', 'saltworks'], region: 'River Line', level: themed('sainte-barbe') },
  { id: 'ironmill', mx: 52, my: 22, from: ['saltworks', 'causeway'], starGate: 10, region: 'River Line', level: themed('harrowgate') },
  { id: 'citadel', mx: 55, my: 62, from: ['bastion', 'causeway'], level: hand(2), region: 'River Line' },
  { id: 'greywater', mx: 63, my: 40, from: ['citadel', 'ironmill'], starGate: 16, region: 'Highlands', level: themed('greywater') },
  { id: 'hollowcrown', mx: 66, my: 78, from: ['citadel'], starGate: 14, region: 'Highlands', level: themed('abbey') },
  { id: 'thronefall', mx: 74, my: 56, from: ['greywater', 'hollowcrown'], starGate: 22, region: 'Capital', level: themed('zooflak') },

  // ── the great fortresses: 20–40+ room castles, the end of the front ──
  { id: 'kestrel', mx: 84, my: 18, from: ['greywater', 'ironmill'], starGate: 20, region: 'Marches',
    level: themed('kestrel') },
  { id: 'ironcrown', mx: 88, my: 84, from: ['hollowcrown', 'thronefall'], starGate: 24, region: 'Marches',
    level: grand({ id: 'ironcrown', name: 'Castle Ironcrown', seed: 307, difficulty: 6, theme: 'mixed' }) },
  { id: 'warden', mx: 92, my: 38, from: ['kestrel', 'thronefall'], starGate: 28, region: 'Capital',
    level: themed('warden') },
  { id: 'blackcitadel', mx: 93, my: 62, from: ['warden', 'ironcrown'], starGate: 32, region: 'Capital',
    level: grand({ id: 'blackcitadel', name: 'The Black Citadel', seed: 523, difficulty: 8, theme: 'mixed', keeps: 2,
      brief: 'The capital\'s citadel: two keeps, three gun towers, double curtain walls. End the war here.' }) },
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
  for (const t of THEMED) if (!CAMPAIGN.some((n) => n.level().id === t.id)) extra.push(compose(t));
  for (let i = 0; i < 4; i++) {
    extra.push(generateGrand({ id: `devgrand${i}`, name: `Grand Proving Ground ${i + 1}`, seed: 2000 + i * 31, difficulty: 5 + i, theme: (['stone', 'mixed', 'concrete', 'mixed'] as const)[i], keeps: i === 3 ? 2 : 1 }));
  }
  return [...CAMPAIGN.map((n) => n.level()), ...extra];
}
