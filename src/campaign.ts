import { generateLevel, type GenSpec } from './fortgen';
import { generateGrand } from './grandgen';
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
    level: themed('ironcrown') },
  { id: 'warden', mx: 92, my: 38, from: ['kestrel', 'thronefall'], starGate: 28, region: 'Capital',
    level: themed('warden') },
  { id: 'blackcitadel', mx: 93, my: 62, from: ['warden', 'ironcrown'], starGate: 32, region: 'Capital',
    level: themed('blackcitadel') },
];

/**
 * Campaign tuning (docs/BALANCE.md, "Campaign difficulty"): each operation's budget and par time, set from
 * what the value-lab gunner (aiming error 0.5 m, ranging in on each target, the research the war funds have
 * bought by then) spends and takes to win it. The border is generous (the first operation is won with about
 * 45% of its budget), every later one with 55-60%: enough slack for misses and a scout drone, little for
 * shelling the wrong wall. The castles' own generators give much bigger budgets; those still apply to the
 * dev castles. Budgets here are before research (Quartermaster and War Bonds multiply them).
 */
const TUNE: Record<string, { budget: number; par: number }> = {
  outpost: { budget: 1200, par: 110 },
  millford: { budget: 500, par: 60 },
  cleancut: { budget: 900, par: 140 },
  redhill: { budget: 750, par: 60 },
  saltworks: { budget: 3400, par: 230 },
  bastion: { budget: 1050, par: 135 }, // the casual gunner only won it 1 in 2 at 91%: more slack, and a lower curtain (levels.ts)
  causeway: { budget: 1200, par: 115 },
  ironmill: { budget: 3000, par: 260 },
  citadel: { budget: 1150, par: 60 },
  greywater: { budget: 1650, par: 100 },
  hollowcrown: { budget: 3200, par: 200 },
  thronefall: { budget: 1300, par: 60 },
  kestrel: { budget: 3100, par: 240 },
  ironcrown: { budget: 4900, par: 385 },
  warden: { budget: 5200, par: 340 },
  blackcitadel: { budget: 6100, par: 440 },
};

/**
 * Star thresholds from budget and par. The score is 3000, plus 3 a credit left unspent (half for rounds
 * bought and not fired), 60 a second under par, up to 1000 for the gun's condition, and bonuses. Three
 * stars: a win spending at most `spend3` of the budget with 30% of par to spare and a nearly whole gun;
 * two stars: halfway from one star (any clean win) to that.
 */
export function starsFor(budget: number, par: number, one = 3000, spend3 = 0.6): [number, number, number] {
  const three = 3000 + 900 + 3 * budget * (1 - spend3) + 60 * par * 0.3;
  const r = (v: number) => Math.round(v / 100) * 100;
  return [one, r(one + (three - one) / 2), r(three)];
}

for (const n of CAMPAIGN) {
  const t = TUNE[n.id];
  if (!t) continue;
  const base = n.level;
  let cache: LevelDef | null = null;
  n.level = () => (cache ??= (() => {
    const l = base();
    return { ...l, budget: t.budget, parTime: t.par, stars: starsFor(t.budget, t.par, Math.min(l.stars[0], 3000), n.id === 'outpost' ? 0.5 : 0.6) };
  })());
}

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

export interface CastleGroup { title: string; note: string; levels: LevelDef[] }
let catalog: CastleGroup[] | null = null;

/** dev mode: every castle, grouped for the castle picker (built once: the generators are not free) */
export function devCatalog(): CastleGroup[] {
  if (catalog) return catalog;
  const themes = ['timber', 'stone', 'concrete', 'mixed'] as const;
  const proving: LevelDef[] = [];
  for (let i = 0; i < 12; i++) {
    proving.push(generateLevel({ id: `dev${i}`, name: `Proving Ground ${i + 1}`, seed: 1000 + i * 17, theme: themes[i % 4], difficulty: 1 + (i % 5) }));
  }
  const themedExtra = THEMED.filter((t) => !CAMPAIGN.some((n) => n.level().id === t.id)).map((t) => compose(t));
  const handExtra = LEVELS.filter((l) => !CAMPAIGN.some((n) => n.level().id === l.id));
  const grand: LevelDef[] = [];
  for (let i = 0; i < 4; i++) {
    grand.push(generateGrand({ id: `devgrand${i}`, name: `Grand Proving Ground ${i + 1}`, seed: 2000 + i * 31, difficulty: 5 + i, theme: (['stone', 'mixed', 'concrete', 'mixed'] as const)[i], keeps: i === 3 ? 2 : 1 }));
  }
  catalog = [
    { title: 'Campaign', note: 'every operation on the map', levels: CAMPAIGN.map((n) => n.level()) },
    { title: 'Themed fortresses', note: 'real-structure archetypes off the campaign', levels: [...themedExtra, ...handExtra] },
    { title: 'Proving grounds', note: 'seeded modular generator', levels: proving },
    { title: 'Grand proving grounds', note: '40+ room great fortresses', levels: grand },
  ].filter((g) => g.levels.length);
  return catalog;
}

/** dev mode: every castle, including extra procedurally generated ones */
export function devCastles(): LevelDef[] {
  return devCatalog().flatMap((g) => g.levels);
}

/** dev mode: a freshly generated castle (fortress: difficulty 1-5, any theme; grand: difficulty 5-8, no timber) */
export function generateCastle(kind: 'fort' | 'grand', seed: number, difficulty: number, theme: 'timber' | 'stone' | 'concrete' | 'mixed'): LevelDef {
  seed = Number.isFinite(seed) ? Math.min(2147483647, Math.max(1, Math.floor(seed))) : 1;
  if (!Number.isFinite(difficulty)) difficulty = kind === 'grand' ? 6 : 3;
  if (kind === 'grand') {
    const d = Math.max(5, Math.min(8, Math.round(difficulty)));
    return generateGrand({ id: `gen-grand-${seed}-${d}`, name: `Generated Grand ${seed}`, seed, difficulty: d, theme: theme === 'timber' ? 'stone' : theme, keeps: d >= 8 ? 2 : 1 });
  }
  const d = Math.max(1, Math.min(5, Math.round(difficulty)));
  return generateLevel({ id: `gen-${seed}-${d}`, name: `Generated Fort ${seed}`, seed, theme, difficulty: d });
}
