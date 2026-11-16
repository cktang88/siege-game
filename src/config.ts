// ───────────────────────── Materials ─────────────────────────
export type MatId = 'wood' | 'stone' | 'concrete' | 'steel' | 'reactive' | 'fireproof' | 'crate' | 'rock' | 'earth' | 'tile' | 'plaster' | 'fuel';

export interface MaterialDef {
  name: string;
  density: number;
  hp: number;
  /** damage multipliers */
  kinetic: number;
  blast: number;
  fire: number;
  /** how easily penetrators pass through (1 = easy, low = hard) */
  pierce: number;
  flammable: boolean;
  /** blows up when destroyed (fuel tanks) */
  volatile?: boolean;
  friction: number;
  color: [number, number, number];
  /** shader pattern id */
  kind: number;
  indestructible?: boolean;
  blurb: string;
}

export const MATERIALS: Record<MatId, MaterialDef> = {
  wood: { name: 'Timber', density: 0.6, hp: 60, kinetic: 1.1, blast: 1.1, fire: 1, pierce: 1.6, flammable: true, friction: 0.8,
    color: [0.62, 0.42, 0.24], kind: 0, blurb: 'Light. Burns.' },
  stone: { name: 'Masonry', density: 2.0, hp: 140, kinetic: 0.8, blast: 0.8, fire: 0, pierce: 1, flammable: false, friction: 0.9,
    color: [0.62, 0.6, 0.55], kind: 1, blurb: 'Heavy, brittle under blast.' },
  concrete: { name: 'Reinforced concrete', density: 2.4, hp: 220, kinetic: 0.55, blast: 0.5, fire: 0, pierce: 0.7, flammable: false, friction: 0.9,
    color: [0.58, 0.6, 0.62], kind: 2, blurb: 'Shrugs off HE. Bunker busters crack it.' },
  steel: { name: 'Armor plate', density: 3.6, hp: 260, kinetic: 0.35, blast: 0.55, fire: 0, pierce: 0.35, flammable: false, friction: 0.75,
    color: [0.42, 0.46, 0.52], kind: 3, blurb: 'Stops armor-piercing rounds.' },
  reactive: { name: 'Reactive armor', density: 2.5, hp: 90, kinetic: 0.3, blast: 0.6, fire: 0, pierce: 0.4, flammable: false, friction: 0.6,
    color: [0.45, 0.5, 0.36], kind: 4, blurb: 'Detonates incoming shells. Slow charges get through.' },
  fireproof: { name: 'Firebrick', density: 2.2, hp: 160, kinetic: 0.8, blast: 0.75, fire: 0, pierce: 0.9, flammable: false, friction: 0.9,
    color: [0.66, 0.38, 0.26], kind: 5, blurb: 'Fire cannot spread through it.' },
  crate: { name: 'Munitions', density: 0.9, hp: 70, kinetic: 1.0, blast: 1.2, fire: 1.2, pierce: 1.5, flammable: true, friction: 0.8,
    color: [0.45, 0.42, 0.25], kind: 6, blurb: 'Volatile.' },
  earth: { name: 'Earthworks', density: 1.7, hp: 260, kinetic: 0.3, blast: 0.32, fire: 0, pierce: 2.2, flammable: false, friction: 1,
    color: [0.47, 0.4, 0.28], kind: 8, blurb: 'Rammed earth soaks up blast. Penetrators and drills cut it.' },
  tile: { name: 'Clay roof', density: 0.9, hp: 45, kinetic: 1.3, blast: 1.3, fire: 0, pierce: 2, flammable: false, friction: 0.7,
    color: [0.55, 0.27, 0.2], kind: 9, blurb: 'Light and brittle. Shrapnel shreds it.' },
  plaster: { name: 'Plaster on timber', density: 0.8, hp: 70, kinetic: 1, blast: 1.05, fire: 0.9, pierce: 1.5, flammable: true, friction: 0.8,
    color: [0.86, 0.84, 0.78], kind: 10, blurb: 'Lime plaster over a timber frame. Burns from inside.' },
  fuel: { name: 'Fuel tank', density: 0.7, hp: 80, kinetic: 1.1, blast: 1.2, fire: 1.3, pierce: 1.6, flammable: true, volatile: true, friction: 0.6,
    color: [0.62, 0.6, 0.5], kind: 11, blurb: 'Volatile. Explodes when breached.' },
  rock: { name: 'Bedrock', density: 3, hp: 1e9, kinetic: 0, blast: 0, fire: 0, pierce: 0.01, flammable: false, friction: 1,
    color: [0.36, 0.33, 0.3], kind: 7, indestructible: true, blurb: '' },
};

// ───────────────────────── Targets ─────────────────────────
export type TargetKind = 'command' | 'ammo' | 'barracks' | 'artillery' | 'workshop' | 'flak' | 'mast' | 'depot';

export const TARGETS: Record<TargetKind, { label: string; desc: string; color: string }> = {
  command: { label: 'HQ', desc: 'Command post', color: '#e0503a' },
  ammo: { label: 'AMMO', desc: 'Munitions store — detonates when destroyed or set alight', color: '#e8b03a' },
  barracks: { label: 'BARRACKS', desc: 'Sends infantry at your gun until destroyed', color: '#9fb35a' },
  artillery: { label: 'GUN', desc: 'Counter-battery gun — fires at your cannon', color: '#d27a3a' },
  workshop: { label: 'ENGINEERS', desc: 'Repairs damage and rebuilds walls', color: '#5aa6d2' },
  flak: { label: 'FLAK', desc: 'Anti-air — shoots down bombers and drones', color: '#b77ad2' },
  mast: { label: 'MAST', desc: 'Airship mast — launches gyrocopters and airships until destroyed', color: '#6fd0c0' },
  depot: { label: 'DEPOT', desc: 'Motor pool — sends armoured cars and light tanks at your gun until destroyed', color: '#c8b46a' },
};

// ───────────────────────── Ammunition ─────────────────────────
export type AmmoId =
  | 'shell' | 'heavy' | 'ap' | 'he' | 'incendiary' | 'bunker' | 'cluster' | 'delayed'
  | 'sticky' | 'drill' | 'canister' | 'smoke' | 'drone' | 'saboteur' | 'airstrike' | 'flak'
  | 'bomb_he' | 'bomb_inc' | 'bomb_pen';

export type AmmoMode = 'physics' | 'penetrator' | 'pellets' | 'drone' | 'saboteur' | 'airstrike';

export interface AmmoDef {
  id: AmmoId;
  name: string;
  short: string;
  price: number;
  desc: string;
  good: string;
  bad: string;
  mode: AmmoMode;
  color: [number, number, number];
  radius: number;
  density: number;
  /** muzzle speed multiplier */
  speed: number;
  /** wind sensitivity */
  wind: number;
  /** direct impact damage at 30 m/s */
  kinetic: number;
  blastRadius: number;
  blastDamage: number;
  /** penetrator power */
  pen?: number;
  /** fuse after first impact (s) */
  fuse?: number;
  ignite?: number;
  bonus?: Partial<Record<MatId, number>>;
  /** player can tap during flight */
  ability?: string;
  /** not sold in the armory (air-dropped ordnance) */
  internal?: boolean;
}

export const AMMO: AmmoDef[] = [
  { id: 'shell', name: 'Round Shot', short: 'RS', price: 40, mode: 'physics', color: [0.25, 0.25, 0.27], radius: 0.24, density: 9, speed: 1, wind: 0.6,
    kinetic: 55, blastRadius: 1.2, blastDamage: 25, desc: 'Plain iron ball. Cheap and honest.', good: 'Timber, loose stacks', bad: 'Anything armored' },
  { id: 'heavy', name: 'Heavy Shell', short: 'HV', price: 140, mode: 'physics', color: [0.2, 0.2, 0.22], radius: 0.42, density: 14, speed: 0.92, wind: 0.25,
    kinetic: 120, blastRadius: 2.2, blastDamage: 55, desc: 'Massive slug that shoves whole walls over.', good: 'Toppling towers, pillars', bad: 'Reactive armor' },
  { id: 'ap', name: 'Armor-Piercing', short: 'AP', price: 120, mode: 'penetrator', color: [0.55, 0.5, 0.38], radius: 0.16, density: 12, speed: 1.15, wind: 0.2,
    kinetic: 0, blastRadius: 1.0, blastDamage: 30, pen: 480, desc: 'Punches straight through several blocks.', good: 'Masonry, reaching inner rooms', bad: 'Armor plate, reactive armor' },
  { id: 'he', name: 'High Explosive', short: 'HE', price: 130, mode: 'physics', color: [0.55, 0.22, 0.18], radius: 0.28, density: 7, speed: 1, wind: 0.5,
    kinetic: 30, blastRadius: 4.2, blastDamage: 115, desc: 'Big blast on contact.', good: 'Masonry, timber, troops', bad: 'Concrete, reactive armor, double walls' },
  { id: 'incendiary', name: 'Incendiary', short: 'IN', price: 100, mode: 'physics', color: [0.85, 0.42, 0.12], radius: 0.26, density: 6, speed: 1, wind: 0.6,
    kinetic: 25, blastRadius: 2.2, blastDamage: 20, ignite: 3.2, desc: 'Sets timber and munitions ablaze. Fire spreads.', good: 'Wooden forts, ammo stores', bad: 'Firebrick rooms, stone' },
  { id: 'bunker', name: 'Bunker Buster', short: 'BB', price: 260, mode: 'penetrator', color: [0.3, 0.34, 0.24], radius: 0.24, density: 12, speed: 1.05, wind: 0.2,
    kinetic: 0, blastRadius: 3.4, blastDamage: 200, pen: 700, fuse: 0.35, bonus: { concrete: 3.2, stone: 1.3 },
    desc: 'Burrows into the structure, then detonates inside.', good: 'Concrete bunkers', bad: 'Reactive armor (premature det.)' },
  { id: 'cluster', name: 'Cluster Shell', short: 'CL', price: 170, mode: 'physics', color: [0.5, 0.5, 0.2], radius: 0.3, density: 6, speed: 1, wind: 0.5,
    kinetic: 30, blastRadius: 1.6, blastDamage: 30, ability: 'Tap to scatter 8 bomblets',
    desc: 'Splits into bomblets (tap/space in flight).', good: 'Wide, soft targets, troops, tops of reactive walls', bad: 'Single hard points' },
  { id: 'delayed', name: 'Delayed Fuse', short: 'DF', price: 110, mode: 'physics', color: [0.35, 0.3, 0.45], radius: 0.3, density: 8, speed: 1, wind: 0.5,
    kinetic: 40, blastRadius: 3.0, blastDamage: 110, fuse: 3,
    desc: 'Bounces and rolls, detonates 3s after first impact.', good: 'Rolling into rooms, gaps behind walls', bad: 'Impatient players' },
  { id: 'sticky', name: 'Sticky Charge', short: 'ST', price: 120, mode: 'physics', color: [0.3, 0.45, 0.32], radius: 0.26, density: 3, speed: 0.75, wind: 0.8,
    kinetic: 0, blastRadius: 2.6, blastDamage: 150, fuse: 2.5,
    desc: 'Lobbed charge that glues to a surface, then blows.', good: 'Reactive armor (too slow to trigger it), pillars', bad: 'Wind, long range' },
  { id: 'drill', name: 'Burrowing Drill', short: 'DR', price: 190, mode: 'physics', color: [0.6, 0.45, 0.2], radius: 0.25, density: 10, speed: 1, wind: 0.3,
    kinetic: 30, blastRadius: 4.2, blastDamage: 170, bonus: { earth: 3 }, desc: 'Lands short, tunnels forward and blows the foundations from below.',
    good: 'Undermining foundations, earthworks', bad: 'Targets high up' },
  { id: 'canister', name: 'Canister Shot', short: 'CN', price: 35, mode: 'pellets', color: [0.5, 0.5, 0.5], radius: 0.09, density: 10, speed: 1.05, wind: 0.6,
    kinetic: 2.5, blastRadius: 0, blastDamage: 0, desc: 'Spray of lead balls. Shreds infantry.', good: 'Advancing soldiers', bad: 'Buildings' },
  { id: 'flak', name: 'Flak Burst', short: 'FK', price: 45, mode: 'physics', color: [0.4, 0.4, 0.22], radius: 0.22, density: 7, speed: 1.1, wind: 0.4,
    kinetic: 20, blastRadius: 4.4, blastDamage: 65, desc: 'Proximity-fuzed AA shell: bursts near aircraft, or on its timer.', good: 'Gyrocopters, airships', bad: 'Walls' },
  { id: 'smoke', name: 'Smoke Screen', short: 'SM', price: 60, mode: 'physics', color: [0.75, 0.75, 0.72], radius: 0.24, density: 5, speed: 1, wind: 0.6,
    kinetic: 5, blastRadius: 0, blastDamage: 0, desc: 'Blinds the enemy counter-battery guns for 15s.', good: 'Shutting down counter-battery fire', bad: 'Does no damage' },
  { id: 'drone', name: 'Scout Drone', short: 'UAV', price: 80, mode: 'drone', color: [0.3, 0.3, 0.32], radius: 0, density: 0, speed: 0, wind: 0,
    kinetic: 0, blastRadius: 0, blastDamage: 0, desc: 'Reveals hidden armor, health and load-bearing members.', good: 'Planning', bad: 'Flak' },
  { id: 'saboteur', name: 'Saboteur', short: 'SAB', price: 160, mode: 'saboteur', color: [0.2, 0.2, 0.2], radius: 0, density: 0, speed: 0, wind: 0,
    kinetic: 0, blastRadius: 3.6, blastDamage: 190, fuse: 3,
    desc: 'Sprints in and plants a demolition charge at the base of the wall.', good: 'Ground-floor targets, reactive armor', bad: 'Enemy infantry' },
  { id: 'airstrike', name: 'Air Strike', short: 'AIR', price: 340, mode: 'airstrike', color: [0.4, 0.42, 0.3], radius: 0.3, density: 8, speed: 0, wind: 0.1,
    kinetic: 40, blastRadius: 3.2, blastDamage: 120, desc: 'Click a spot: a bomber drops a stick of bombs across it (3, more with research).',
    good: 'Roofs, anything without overhead cover', bad: 'Flak guns: they shake low runs off target and down the bomber' },
  // air-dropped ordnance (carried by the bomber)
  { id: 'bomb_he', name: 'GP Bomb', short: 'B', price: 0, mode: 'physics', color: [0.35, 0.38, 0.28], radius: 0.3, density: 8, speed: 0, wind: 0.1,
    kinetic: 40, blastRadius: 3.2, blastDamage: 120, desc: '', good: '', bad: '', internal: true },
  { id: 'bomb_inc', name: 'Firebomb', short: 'B', price: 0, mode: 'physics', color: [0.7, 0.35, 0.12], radius: 0.3, density: 6, speed: 0, wind: 0.15,
    kinetic: 25, blastRadius: 2.6, blastDamage: 35, ignite: 3.5, desc: '', good: '', bad: '', internal: true },
  { id: 'bomb_pen', name: 'AP Bomb', short: 'B', price: 0, mode: 'penetrator', color: [0.3, 0.3, 0.32], radius: 0.24, density: 12, speed: 0, wind: 0.05,
    kinetic: 0, blastRadius: 3, blastDamage: 170, pen: 650, fuse: 0.25, bonus: { concrete: 2.4, steel: 1.5 }, desc: '', good: '', bad: '', internal: true },
];

export const SHOP_AMMO = () => AMMO.filter((a) => !a.internal);

export const AMMO_BY_ID = Object.fromEntries(AMMO.map((a) => [a.id, a])) as Record<AmmoId, AmmoDef>;

export const PHYS = {
  gravity: -9.81,
  minSpeed: 6,
};
