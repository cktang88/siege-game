import type { AmmoId } from './config';

// ───────────────────────── Tech tree ─────────────────────────
export type Branch = 'ordnance' | 'gunnery' | 'air' | 'special' | 'logistics';

export const BRANCHES: Record<Branch, { name: string; motto: string }> = {
  ordnance: { name: 'Ordnance', motto: 'What goes in the barrel' },
  gunnery: { name: 'Gunnery', motto: 'Putting it where you mean it' },
  air: { name: 'Air Wing', motto: 'Death from above' },
  special: { name: 'Special Ops', motto: 'Eyes and hands inside the walls' },
  logistics: { name: 'Logistics', motto: 'Wars are won by supply' },
};

export interface TechNode {
  id: string;
  branch: Branch;
  name: string;
  desc: string;
  cost: number;
  tier: number;
  requires: string[];
  /** munitions this node makes available in the armory */
  unlocks?: AmmoId[];
  fx?: Partial<Stats> | ((s: Stats) => void);
}

/** Everything progression can change about a battle. */
export interface Stats {
  maxSpeed: number;          // m/s muzzle velocity cap
  minAngle: number;          // degrees
  maxAngle: number;
  reload: number;            // seconds
  previewSteps: number;      // trajectory preview length (dots)
  windReadout: boolean;      // exact wind number vs. vague arrow
  cannonHp: number;
  budgetMult: number;
  shieldedGun: boolean;      // counter-battery shells do half damage
  dmg: Partial<Record<AmmoId, number>>;   // damage multiplier
  radius: Partial<Record<AmmoId, number>>; // blast radius multiplier
  pen: Partial<Record<AmmoId, number>>;
  priceMult: Partial<Record<AmmoId, number>>;
  bombs: number;             // bombs per air strike
  dive: boolean;             // dive-bomb angle control
  bombTypes: ('he' | 'incendiary' | 'penetrator')[];
  ecm: boolean;              // bomber survives flak longer
  droneTime: number;
  droneStealth: boolean;
  saboteurs: number;         // commandos per deployment
  sabCharge: number;         // charge multiplier
  clusterCount: number;
  stickyFuse: number;
  drillRange: number;
}

export const baseStats = (): Stats => ({
  maxSpeed: 30, minAngle: -10, maxAngle: 80, reload: 1.6, previewSteps: 10, windReadout: false, cannonHp: 100,
  budgetMult: 1, shieldedGun: false, dmg: {}, radius: {}, pen: {}, priceMult: {},
  bombs: 3, dive: false, bombTypes: ['he'], ecm: false, droneTime: 3, droneStealth: false,
  saboteurs: 1, sabCharge: 1, clusterCount: 6, stickyFuse: 2.5, drillRange: 12,
});

const mul = (k: 'dmg' | 'radius' | 'pen' | 'priceMult', id: AmmoId, m: number) => (s: Stats) => { s[k][id] = (s[k][id] ?? 1) * m; };

export const TECH: TechNode[] = [
  // Ordnance
  { id: 'ord_he', branch: 'ordnance', tier: 1, name: 'High Explosive', desc: 'Unlocks HE shells.', cost: 0, requires: [], unlocks: ['he'] },
  { id: 'ord_heavy', branch: 'ordnance', tier: 1, name: 'Heavy Shot', desc: 'Unlocks the heavy shell.', cost: 150, requires: [], unlocks: ['heavy'] },
  { id: 'ord_inc', branch: 'ordnance', tier: 2, name: 'Incendiary', desc: 'Unlocks incendiary shells.', cost: 250, requires: ['ord_he'], unlocks: ['incendiary'] },
  { id: 'ord_ap', branch: 'ordnance', tier: 2, name: 'Armor-Piercing', desc: 'Unlocks AP rounds.', cost: 300, requires: ['ord_heavy'], unlocks: ['ap'] },
  { id: 'ord_he2', branch: 'ordnance', tier: 2, name: 'Amatol Filler', desc: 'HE and cluster damage +25%.', cost: 350, requires: ['ord_he'], fx: (s) => { mul('dmg', 'he', 1.25)(s); mul('dmg', 'cluster', 1.25)(s); } },
  { id: 'ord_cluster', branch: 'ordnance', tier: 3, name: 'Cluster Shell', desc: 'Unlocks cluster shells.', cost: 450, requires: ['ord_he2'], unlocks: ['cluster'] },
  { id: 'ord_delay', branch: 'ordnance', tier: 3, name: 'Delay Fuses', desc: 'Unlocks delayed-fuse shells.', cost: 350, requires: ['ord_he'], unlocks: ['delayed'] },
  { id: 'ord_bunker', branch: 'ordnance', tier: 4, name: 'Bunker Buster', desc: 'Unlocks bunker busters.', cost: 650, requires: ['ord_ap', 'ord_delay'], unlocks: ['bunker'] },
  { id: 'ord_ap2', branch: 'ordnance', tier: 4, name: 'Tungsten Core', desc: 'AP and bunker-buster penetration +40%.', cost: 600, requires: ['ord_ap'], fx: (s) => { mul('pen', 'ap', 1.4)(s); mul('pen', 'bunker', 1.4)(s); } },
  { id: 'ord_napalm', branch: 'ordnance', tier: 4, name: 'Thermite', desc: 'Incendiary radius +40%, burns longer.', cost: 500, requires: ['ord_inc'], fx: (s) => { mul('radius', 'incendiary', 1.4)(s); mul('dmg', 'incendiary', 1.3)(s); } },
  { id: 'ord_cluster2', branch: 'ordnance', tier: 5, name: 'Submunition Rack', desc: 'Cluster shells carry 10 bomblets.', cost: 700, requires: ['ord_cluster'], fx: { clusterCount: 10 } },
  { id: 'ord_drill', branch: 'ordnance', tier: 5, name: 'Burrowing Drill', desc: 'Unlocks the drill round.', cost: 800, requires: ['ord_bunker'], unlocks: ['drill'] },
  { id: 'ord_drill2', branch: 'ordnance', tier: 6, name: 'Deep Bore', desc: 'Drill tunnels 20m and hits 30% harder.', cost: 700, requires: ['ord_drill'], fx: (s) => { s.drillRange = 20; mul('dmg', 'drill', 1.3)(s); } },

  // Gunnery
  { id: 'gun_charge', branch: 'gunnery', tier: 1, name: 'Double Charge', desc: 'Max muzzle velocity 30 → 36 m/s.', cost: 200, requires: [], fx: { maxSpeed: 36 } },
  { id: 'gun_sight', branch: 'gunnery', tier: 1, name: 'Quadrant Sight', desc: 'Longer trajectory preview.', cost: 150, requires: [], fx: { previewSteps: 16 } },
  { id: 'gun_wind', branch: 'gunnery', tier: 2, name: 'Anemometer', desc: 'Exact wind speed readout.', cost: 200, requires: ['gun_sight'], fx: { windReadout: true } },
  { id: 'gun_reload', branch: 'gunnery', tier: 2, name: 'Drilled Crew', desc: 'Reload 1.6s → 1.0s.', cost: 300, requires: ['gun_charge'], fx: { reload: 1 } },
  { id: 'gun_elev', branch: 'gunnery', tier: 2, name: 'High-Angle Mount', desc: 'Elevation up to 88° for plunging fire.', cost: 250, requires: ['gun_charge'], fx: { maxAngle: 88 } },
  { id: 'gun_range', branch: 'gunnery', tier: 3, name: 'Rangefinder', desc: 'Much longer trajectory preview.', cost: 450, requires: ['gun_wind'], fx: { previewSteps: 26 } },
  { id: 'gun_charge2', branch: 'gunnery', tier: 3, name: 'Cordite Charges', desc: 'Max muzzle velocity → 44 m/s.', cost: 550, requires: ['gun_reload'], fx: { maxSpeed: 44 } },
  { id: 'gun_shield', branch: 'gunnery', tier: 3, name: 'Gun Shield', desc: 'Counter-battery hits do half damage.', cost: 400, requires: ['gun_elev'], fx: { shieldedGun: true } },
  { id: 'gun_shell2', branch: 'gunnery', tier: 4, name: 'Rifled Barrel', desc: 'Round shot and heavy shell damage +30%.', cost: 500, requires: ['gun_charge2'], fx: (s) => { mul('dmg', 'shell', 1.3)(s); mul('dmg', 'heavy', 1.3)(s); } },
  { id: 'gun_range2', branch: 'gunnery', tier: 5, name: 'Fire Control Computer', desc: 'Full trajectory preview.', cost: 900, requires: ['gun_range', 'gun_charge2'], fx: { previewSteps: 60 } },

  // Air wing
  { id: 'air_strike', branch: 'air', tier: 2, name: 'Air Support', desc: 'Unlocks bomber strikes (3 bombs).', cost: 400, requires: [], unlocks: ['airstrike'] },
  { id: 'air_bay', branch: 'air', tier: 3, name: 'Extended Bomb Bay', desc: '5 bombs per strike.', cost: 450, requires: ['air_strike'], fx: { bombs: 5 } },
  { id: 'air_dive', branch: 'air', tier: 3, name: 'Dive Bombing', desc: 'Set the dive angle: steep dives hit walls and bunkers precisely.', cost: 500, requires: ['air_strike'], fx: { dive: true } },
  { id: 'air_inc', branch: 'air', tier: 4, name: 'Firebombs', desc: 'Bombers can carry incendiaries.', cost: 450, requires: ['air_bay'], fx: (s) => { s.bombTypes.push('incendiary'); } },
  { id: 'air_pen', branch: 'air', tier: 4, name: 'Armor-Piercing Bombs', desc: 'Bombers can carry penetrating bombs.', cost: 600, requires: ['air_dive'], fx: (s) => { s.bombTypes.push('penetrator'); } },
  { id: 'air_ecm', branch: 'air', tier: 5, name: 'Chaff & Jammers', desc: 'Bombers survive flak long enough to finish their run.', cost: 800, requires: ['air_pen', 'air_inc'], fx: { ecm: true } },
  { id: 'air_bay2', branch: 'air', tier: 5, name: 'Heavy Bomber', desc: '8 bombs per strike; air strikes −20% price.', cost: 900, requires: ['air_bay'], fx: (s) => { s.bombs = 8; mul('priceMult', 'airstrike', 0.8)(s); } },

  // Special ops
  { id: 'sp_drone', branch: 'special', tier: 1, name: 'Scout Drone', desc: 'Unlocks scout drones.', cost: 100, requires: [], unlocks: ['drone'] },
  { id: 'sp_smoke', branch: 'special', tier: 1, name: 'Smoke Shells', desc: 'Unlocks smoke screens.', cost: 150, requires: [], unlocks: ['smoke'] },
  { id: 'sp_sticky', branch: 'special', tier: 2, name: 'Sticky Charges', desc: 'Unlocks sticky charges.', cost: 300, requires: ['sp_smoke'], unlocks: ['sticky'] },
  { id: 'sp_sab', branch: 'special', tier: 2, name: 'Commandos', desc: 'Unlocks saboteurs.', cost: 350, requires: ['sp_drone'], unlocks: ['saboteur'] },
  { id: 'sp_drone2', branch: 'special', tier: 3, name: 'Long-Endurance Drone', desc: 'Drone loiters 8s; flak takes longer to find it.', cost: 350, requires: ['sp_drone'], fx: { droneTime: 8, droneStealth: true } },
  { id: 'sp_sab2', branch: 'special', tier: 3, name: 'Fire Team', desc: 'Two saboteurs per deployment.', cost: 500, requires: ['sp_sab'], fx: { saboteurs: 2 } },
  { id: 'sp_charge', branch: 'special', tier: 4, name: 'Shaped Charges', desc: 'Saboteur and sticky charges +50%.', cost: 550, requires: ['sp_sab2', 'sp_sticky'], fx: (s) => { s.sabCharge = 1.5; mul('dmg', 'sticky', 1.5)(s); } },
  { id: 'sp_fuse', branch: 'special', tier: 4, name: 'Timer Pencils', desc: 'Sticky charge fuse 2.5s → 1.2s.', cost: 300, requires: ['sp_sticky'], fx: { stickyFuse: 1.2 } },

  // Logistics
  { id: 'log_canister', branch: 'logistics', tier: 1, name: 'Canister Shot', desc: 'Unlocks canister against infantry.', cost: 100, requires: [], unlocks: ['canister'] },
  { id: 'log_budget', branch: 'logistics', tier: 2, name: 'Quartermaster', desc: 'Mission budgets +15%.', cost: 400, requires: [], fx: (s) => { s.budgetMult *= 1.15; } },
  { id: 'log_armor', branch: 'logistics', tier: 2, name: 'Sandbagged Position', desc: 'Cannon HP 100 → 150.', cost: 300, requires: ['log_canister'], fx: { cannonHp: 150 } },
  { id: 'log_bulk', branch: 'logistics', tier: 3, name: 'Bulk Contracts', desc: 'Round shot and HE −25% price.', cost: 450, requires: ['log_budget'], fx: (s) => { mul('priceMult', 'shell', 0.75)(s); mul('priceMult', 'he', 0.75)(s); } },
  { id: 'log_budget2', branch: 'logistics', tier: 4, name: 'War Bonds', desc: 'Mission budgets +20% more.', cost: 800, requires: ['log_bulk'], fx: (s) => { s.budgetMult *= 1.2; } },
  { id: 'log_armor2', branch: 'logistics', tier: 4, name: 'Casemate', desc: 'Cannon HP → 220.', cost: 650, requires: ['log_armor'], fx: { cannonHp: 220 } },
];

export const TECH_BY_ID = Object.fromEntries(TECH.map((t) => [t.id, t])) as Record<string, TechNode>;
/** always available without research */
export const BASE_AMMO: AmmoId[] = ['shell'];

// ───────────────────────── Save data ─────────────────────────
export interface Save {
  funds: number;
  tech: string[];
  stars: Record<string, number>;
  best: Record<string, number>;
  dev: boolean;
}

const KEY = 'siege-save-v2';
export function loadSave(): Save {
  let s: Partial<Save> = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* storage unavailable */ }
  return { funds: s.funds ?? 300, tech: s.tech ?? ['ord_he'], stars: s.stars ?? {}, best: s.best ?? {}, dev: s.dev ?? false };
}
export function writeSave(s: Save) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function hasTech(s: Save, id: string) { return s.dev || s.tech.includes(id); }

export function canResearch(s: Save, n: TechNode) {
  return !hasTech(s, n.id) && n.requires.every((r) => hasTech(s, r)) && s.funds >= n.cost;
}

export function research(s: Save, id: string): boolean {
  const n = TECH_BY_ID[id];
  if (!n || !canResearch(s, n)) return false;
  s.funds -= n.cost;
  s.tech.push(id);
  writeSave(s);
  return true;
}

export function computeStats(s: Save): Stats {
  const st = baseStats();
  for (const n of TECH) {
    if (!hasTech(s, n.id) || !n.fx) continue;
    if (typeof n.fx === 'function') n.fx(st);
    else Object.assign(st, n.fx);
  }
  return st;
}

export function availableAmmo(s: Save): AmmoId[] {
  const set = new Set<AmmoId>(BASE_AMMO);
  for (const n of TECH) if (hasTech(s, n.id)) n.unlocks?.forEach((a) => set.add(a));
  return [...set];
}

/** funds awarded for a mission result */
export function missionReward(score: number, stars: number, prevStars: number) {
  const firstClear = prevStars === 0 && stars > 0 ? 250 : 0;
  const newStars = Math.max(0, stars - prevStars) * 120;
  return Math.round(score / 25) + firstClear + newStars;
}
