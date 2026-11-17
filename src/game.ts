import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { AMMO_BY_ID, MATERIALS, PHYS, TARGETS, type AmmoDef, type AmmoId, type MatId, type MaterialDef, type TargetKind } from './config';
import type { BlockDef, HouseDef, LevelDef } from './levels';
import { Renderer, blockGeometry, disposeTree, dropObject, makeBlockMaterial, makeGround, makeSprite } from './render';
import { fxBurning, fxExplosion, fxSmokeCloud } from './fx';
import { baseStats, type Stats } from './progress';
import { SoldierRig } from './soldier';
import { audio } from './audio';
import { Garrison } from './dwellers';
import { AirForce } from './aircraft';
import { elevate } from './elevate';
import { MotorPool } from './vehicles';
import { Fracture } from './fracture';
import { Crew } from './engineers';

type V2 = { x: number; y: number };

export interface Block {
  id: number;
  def: BlockDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Mesh;
  uni: Record<string, THREE.IUniform>;
  matId: MatId;
  mat: MaterialDef;
  hp: number;
  maxHp: number;
  w: number;
  h: number;
  target?: TargetKind;
  dead: boolean;
  /** seconds of fire left while alight (0 = not burning) */
  burning: number;
  burnAmt: number;
  /** unburnt fuel, seconds (-1 until first lit); a block that has burnt out cannot catch again */
  fuel: number;
  fuelMax: number;
  /** seconds since this fire took hold (it grows from a lick of flame to full heat) */
  fireT: number;
  flash: number;
  lastVel: V2;
  cookoff: number;
  highlight: number;
  spreadT: number;
  rebuilt: number;
  /** a piece of a fractured block (src/fracture.ts): engineers do not rebuild it */
  frag?: boolean;
  /** set when this block split: the piece that carries on its role (target, room frame, floor) */
  heir?: Block;
}

interface House { def: HouseDef; hp: number; maxHp: number; mesh: THREE.Mesh; collider: RAPIER.Collider; body: RAPIER.RigidBody; dead: boolean }

export interface Projectile {
  ammo: AmmoDef;
  enemy: boolean;
  body?: RAPIER.RigidBody;
  collider?: RAPIER.Collider;
  mesh: THREE.Object3D;
  x: number; y: number; vx: number; vy: number;
  age: number;
  impacted: boolean;
  fuse: number; // <0 = none
  stuck?: { block?: Block; lx: number; ly: number; rot: number };
  pen: number;
  bomblet?: boolean;
  split?: boolean;
  /** burrowing drill: heading, distance tunnelled, and the last x it passed under a structure */
  burrow?: { dir: number; dist: number; under?: number };
  dead: boolean;
  trail: number;
  inert?: number;
  path?: V2[];
  pellet?: boolean;
  blastScale: number;
  dmgMul: number;
  radMul: number;
  /** where a penetrator first entered a structure */
  entry?: V2;
  /** last frame's position, for swept hit tests against infantry */
  prev?: V2;
  /** infantry a pellet has already gone through */
  kills?: number;
  fuseSetting?: number;
  airburst?: number;
  /** flak proximity fuze: closest distance to an aircraft seen so far */
  prox?: number;
  /** stopped by a shield: no longer harms infantry */
  harmless?: boolean;
}

export interface Soldier { x: number; y: number; rig: SoldierRig; dead: boolean; shootT: number; stopX: number; phase: number; deadT: number; /** shield hit points (0 = none) */ shield: number; /** a repair-crew engineer (src/engineers.ts moves him) */ eng?: boolean }

interface Plane {
  mesh: THREE.Mesh; x: number; y: number; ux: number; uy: number; speed: number; s: number;
  releases: number[]; ammo: AmmoDef; down: boolean; dead: boolean; flakT: number; exposure: number; vy: number; climbing: boolean;
}

export interface StrikePlan { x: number; dir: 1 | -1; alt: number; dive: number; spacing: number; ordnance: 'he' | 'incendiary' | 'penetrator' }
export interface StrikeSolution { sx: number; sy: number; ux: number; uy: number; speed: number; releases: number[]; impacts: V2[]; releasePts: V2[]; ok: boolean }
interface Drone { mesh: THREE.Mesh; x: number; y: number; tx: number; ty: number; state: 'out' | 'hover' | 'back' | 'down'; t: number; vy: number; dead: boolean }
interface Saboteur { mesh: THREE.Mesh; x: number; y: number; state: 'run' | 'back'; exposed: number; dead: boolean; dir: number; phase: number; target: number | null }

interface PendingBlast { x: number; y: number; r: number; dmg: number; delay: number; opts: BlastOpts }
/** a glowing brand thrown off a burning block as it breaks up; sets alight what it lands on */
interface Ember { x: number; y: number; vx: number; vy: number; life: number }

/*
  Fire. A lit block burns through its fuel (material burn time x size), charring and losing HP as it
  goes, so a timber member usually gives way near the end of its burn. Every FIRE_TICK each fire heats
  the flammable blocks within FIRE_REACH of its surface; each catches with a hazard rate set by the
  gap (contact = full heat), the length of the shared face, the direction (flames climb: a block above
  catches ~3.5x as readily as one beside it, one below ~5x less readily), wind (downwind faces catch
  more), the neighbour's material (`catches`) and how far the fire has grown. Stone, concrete, steel,
  earth, tile and firebrick never catch and also shadow the heat (a ray from the fire to the neighbour
  that meets a non-flammable block is blocked), so masonry walls and firebrick vaults stop a fire.
  Burning blocks that break up throw embers that can light whatever they fall on. Fuel tanks that
  catch fire (or are breached below ~45% HP) cook off a couple of seconds later.
*/
const FIRE_REACH = 0.4;
const FIRE_TICK = 0.5;
/** ignition hazard (per second) for full contact, full face, side-on, still air, timber neighbour */
const FIRE_RATE = 0.11;
export interface BlastOpts { fuelChain?: boolean; flak?: boolean; bonus?: Partial<Record<MatId, number>>; ignite?: number; enemy?: boolean; under?: boolean; push?: number; visual?: number; smoke?: boolean; source?: string }

export type GameEvent =
  | { type: 'toast'; text: string; tone?: 'good' | 'bad' | 'info' }
  | { type: 'target'; kind: TargetKind }
  | { type: 'end'; win: boolean; reason: string }
  | { type: 'fired' }
  | { type: 'gunhit'; dmg: number };

const DT = 1 / 60;
/** cos(obliquity) below which rounds glance off (steel ~56°, concrete ~65°, bedrock 60°) */
const RICOCHET: Partial<Record<MatId, number>> = { steel: 0.56, concrete: 0.42, rock: 0.5 };
/** projectile colliders: member of group 2, interact with everything except group 2 */
const PROJ_GROUPS = (0x0002 << 16) | 0xfffd;

export type DevUnit = 'infantry' | 'shield' | 'car' | 'tank' | 'gyro' | 'airship';
/** most of each unit family the dev panel will keep alive at once (frame time, not physics safety) */
export const DEV_CAP = { infantry: 300, vehicle: 80, air: 80 };

export class Game {
  world!: RAPIER.World;
  eq!: RAPIER.EventQueue;
  r: Renderer;
  level!: LevelDef;
  blocks: Block[] = [];
  houses: House[] = [];
  projectiles: Projectile[] = [];
  soldiers: Soldier[] = [];
  planes: Plane[] = [];
  drones: Drone[] = [];
  saboteurs: Saboteur[] = [];
  pending: PendingBlast[] = [];
  embers: Ember[] = [];
  owners = new Map<number, { t: 'block'; b: Block } | { t: 'ground' } | { t: 'house'; h: House } | { t: 'proj'; p: Projectile }>();
  groundPts: [number, number][] = [];
  root = new THREE.Group();
  inventory: Partial<Record<AmmoId, number>> = {};
  selected: AmmoId = 'shell';
  angle = 0.6;
  /** muzzle velocity, m/s */
  speed = 22;
  /** delayed-fuse setting, seconds */
  fuseSetting = 3;
  /** cluster airburst timer, seconds after launch (0 = manual) */
  airburst = 0;
  stats: Stats = baseStats();
  strike: StrikePlan = { x: 60, dir: 1, alt: 24, dive: 0, spacing: 2.4, ordnance: 'he' };
  droneTarget: V2 | null = null;
  sabTarget: number | null = null;
  reload = 0;
  wind = 0;
  time = 0;
  battleTime = 0;
  running = false;
  ended = false;
  revealed = false;
  enemyBlind = 0;
  cannonHp = 100;
  collateral = 0;
  spentBudget = 0;
  moneyLeft = 0;
  targetsDestroyed: Partial<Record<TargetKind, number>> = {};
  targetsTotal: Partial<Record<TargetKind, number>> = {};
  events: GameEvent[] = [];
  artilleryShots = 0;
  /** how far the enemy gunners have walked their fall of shot onto your gun */
  bracket = 0;
  artT = 9; barT = 12; repT = 5; rebT = 14;
  destroyedSlots: { def: BlockDef; t: number }[] = [];
  carriage!: THREE.Mesh;
  barrel!: THREE.Group;
  enemyGuns = new Map<Block, THREE.Mesh>();
  /** last elevation each enemy gun fired at (drives the barrel sprite) */
  gunElev = new Map<Block, number>();
  previewDots!: THREE.InstancedMesh;
  ghost!: THREE.Line;
  lastPath: V2[] = [];
  focus: V2 | null = null;
  idleT = 0;
  winT = -1;
  nextId = 1;
  zoom = 1;
  pan = 0;
  panY = 0;
  /** gun hit flash (0..1) */
  gunFlash = 0;
  gunCritical = false;
  /** predicted impact points of incoming enemy shells */
  incoming: { x: number; t: number; mesh: THREE.Mesh }[] = [];
  hpBar!: THREE.Group;
  aimMarker!: THREE.Mesh;
  strikeLine!: THREE.Line;
  strikeMarks!: THREE.InstancedMesh;
  airMarker: number | null = null;
  lastCollateralToast = -10;
  baseCx = 0;
  hpLag = 1;
  lastRicochetToast = -10;
  garrison = new Garrison(this);
  air = new AirForce(this);
  motor = new MotorPool(this);
  /** block splitting and marks */
  frac = new Fracture(this);
  /** the enemy repair crew and its scaffolding (src/engineers.ts) */
  crew = new Crew(this);
  /** flak burst timer, seconds after launch */
  flakFuse = 2.5;
  mastSprites = new Map<Block, THREE.Mesh>();
  backdrops: { mesh: THREE.Mesh; deps: Block[]; home: V2[]; fade: number }[] = [];
  backdropT = 0;
  /**
   * Dev sandbox switches (dev mode only; see src/devpanel.ts). `unlimited`: rounds never run out (set per
   * battle by the dev armory); `freeze`: the enemy's own timers stop (counter-battery, reinforcements,
   * engineers, air raids, motor pool); `god`: the gun takes no damage; `instantReload`: no reload wait.
   */
  dev = { unlimited: false, freeze: false, god: false, instantReload: false };

  constructor(r: Renderer) {
    this.r = r;
  }

  // ───────────────────────── Setup ─────────────────────────
  load(source: LevelDef) {
    this.dispose();
    // castles stand on hills (src/elevate.ts); lab levels without an elevation stay flat
    const level = elevate(source);
    this.level = level;
    this.world = new RAPIER.World({ x: 0, y: PHYS.gravity });
    // tall multi-storey frames need more solver iterations to stand still
    this.world.numSolverIterations = level.blocks.length > 150 ? 16 : 10;
    this.eq = new RAPIER.EventQueue(true);
    this.r.world.add(this.root);
    this.wind = +(level.wind[0] + Math.random() * (level.wind[1] - level.wind[0])).toFixed(1);
    this.r.wind = this.wind;
    this.cannonHp = 100;
    this.time = 0; this.battleTime = 0;
    this.ended = false; this.running = false; this.revealed = false;
    this.artilleryShots = 0; this.bracket = 0; this.artT = 10; this.barT = 12; this.repT = 5; this.rebT = 14; this.repairing = null; this.repairToast = false;
    this.collateral = 0; this.enemyBlind = 0; this.winT = -1; this.idleT = 0;
    this.targetsDestroyed = {}; this.targetsTotal = {}; this.shieldsSeen = false;
    this.lastPath = [];
    this.zoom = 1; this.pan = 0; this.panY = 0; this.gunFlash = 0; this.gunCritical = false; this.incoming = [];
    // per-battle clocks and timers: `time` restarts at 0, so toast cooldowns stamped in the last battle would mute these for minutes
    this.reload = 0; this.airMarker = null; this.lastCollateralToast = -10; this.lastRicochetToast = -10;

    // ground
    const ground = this.withRedoubt(level);
    this.groundPts = ground;
    const verts = new Float32Array(ground.flat());
    const gb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const gc = this.world.createCollider(RAPIER.ColliderDesc.polyline(verts).setFriction(1), gb);
    this.owners.set(gc.handle, { t: 'ground' });
    // thick ground slab so things can't tunnel
    const slab = this.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 5).setTranslation(60, -5 + Math.min(...ground.map((p) => p[1]))), gb);
    this.owners.set(slab.handle, { t: 'ground' });
    this.root.add(makeGround(ground));

    for (const d of level.blocks) this.addBlock(d);
    // cutaway interior walls behind each room: dark, non-colliding, gone once the room's frame fails
    for (const bd of level.backdrops ?? []) {
      const m = MATERIALS[bd.mat];
      const geo = blockGeometry(bd.w, bd.h);
      const mat = makeBlockMaterial(m.color.map((c) => c * 0.5) as [number, number, number], bd.w, bd.h, m.kind, geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(bd.x + bd.w / 2, bd.y + bd.h / 2, 2.6);
      this.root.add(mesh);
      const deps = bd.deps.map((i) => this.blocks[i]).filter(Boolean);
      this.backdrops.push({ mesh, deps, home: deps.map((b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; }), fade: 1 });
    }
    for (const t of level.blocks) if (t.target) this.targetsTotal[t.target] = (this.targetsTotal[t.target] ?? 0) + 1;
    for (const h of level.houses) this.addHouse(h);

    // player cannon
    const gy = this.groundY(level.cannonX);
    this.carriage = makeSprite('carriage', 1.7, 7);
    this.carriage.position.set(level.cannonX - 0.4, gy + 0.82, 7);
    this.barrel = new THREE.Group();
    const bm = makeSprite('barrel', 0.55, 6.5);
    (bm.geometry as THREE.PlaneGeometry).computeBoundingBox();
    const bw = (bm.geometry.boundingBox!.max.x - bm.geometry.boundingBox!.min.x);
    const scale = 3 / bw;
    bm.scale.set(scale, scale, 1);
    bm.position.x = 1.1;
    this.barrel.add(bm);
    this.barrel.position.set(level.cannonX + 0.15, gy + 1.15, 6.5);
    // world-space health bar over the gun: dark backing, coloured fill, tick marks
    this.hpBar = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.34), new THREE.MeshBasicMaterial({ color: 0x0b0c0e, transparent: true, opacity: 0.85, depthTest: false }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.22), new THREE.MeshBasicMaterial({ color: 0x8fc46a, depthTest: false }));
    fill.geometry.translate(1.25, 0, 0);
    fill.position.set(-1.25, 0, 0.01);
    fill.name = 'fill';
    const lag = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.22), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    lag.geometry.translate(1.25, 0, 0);
    lag.position.set(-1.25, 0, 0.005);
    lag.name = 'lag';
    this.hpBar.add(back, lag, fill);
    for (let i = 1; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.26), new THREE.MeshBasicMaterial({ color: 0x0b0c0e, depthTest: false }));
      tick.position.set(-1.25 + i * 0.625, 0, 0.02);
      this.hpBar.add(tick);
    }
    this.hpBar.position.set(level.cannonX - 0.1, gy + 2.9, 14);
    // draw order: backing, lost-health trail, fill, ticks
    back.renderOrder = 30; lag.renderOrder = 31; fill.renderOrder = 32;
    this.hpBar.children.slice(3).forEach((t) => { t.renderOrder = 33; });
    for (const m of [lag, fill]) (m.material as THREE.MeshBasicMaterial).transparent = true;
    this.root.add(this.hpBar);
    this.hpLag = 1;
    this.root.add(this.carriage, this.barrel);

    // aim preview dots
    this.previewDots = new THREE.InstancedMesh(new THREE.CircleGeometry(0.11, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }), 60);
    this.previewDots.position.z = 12;
    this.previewDots.frustumCulled = false;
    this.root.add(this.previewDots);
    this.ghost = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.4, gapSize: 0.5, transparent: true, opacity: 0.35 }));
    this.ghost.position.z = 11;
    this.ghost.frustumCulled = false;
    this.root.add(this.ghost);
    this.aimMarker = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.2, 32), new THREE.MeshBasicMaterial({ color: 0xff5040, transparent: true, opacity: 0.8 }));
    this.aimMarker.position.z = 13; this.aimMarker.visible = false;
    this.root.add(this.aimMarker);
    this.strikeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffb347, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.8 }));
    this.strikeLine.position.z = 13; this.strikeLine.frustumCulled = false; this.strikeLine.visible = false;
    this.strikeMarks = new THREE.InstancedMesh(new THREE.RingGeometry(0.28, 0.45, 16), new THREE.MeshBasicMaterial({ color: 0xff5a1f }), 24);
    this.strikeMarks.position.z = 13; this.strikeMarks.frustumCulled = false; this.strikeMarks.visible = false;
    this.root.add(this.strikeLine, this.strikeMarks);

    // settle the structures quietly
    for (let i = 0; i < 90; i++) this.world.step(this.eq);
    this.eq.drainCollisionEvents(() => {});
    for (const b of this.blocks) { const v = b.body.linvel(); b.lastVel = { x: v.x, y: v.y }; }
    // back walls remember where their frame came to rest, not where it was spawned
    for (const bd of this.backdrops) bd.home = bd.deps.map((b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; });
    this.garrison.spawn(level, this.root);
    this.syncMeshes();
    this.frameCamera(true);
  }

  dispose() {
    // free every geometry and material the last battle left on the GPU (blocks, sprites, rigs, markers, HUD bars)
    disposeTree(this.root);
    for (const b of this.blocks) b.mesh.geometry.dispose();
    this.root.clear();
    this.r.world.remove(this.root);
    this.root = new THREE.Group();
    this.garrison.clear();
    this.air.clear();
    this.motor.clear();
    this.frac.clear();
    this.crew.clear();
    this.mastSprites.clear();
    this.blocks = []; this.houses = []; this.backdrops = []; this.projectiles = []; this.soldiers = []; this.planes = []; this.drones = []; this.saboteurs = [];
    this.pending = []; this.embers = []; this.owners.clear(); this.destroyedSlots = []; this.enemyGuns.clear(); this.gunElev.clear(); this.events = [];
    if (this.world) { this.world.free(); this.eq.free(); }
    this.r.smoke.parts.length = 0; this.r.fire.parts.length = 0; this.r.flame.parts.length = 0; this.r.debris.chunks.length = 0; this.r.lights.lights.length = 0;
  }

  /**
   * The gun sits on a raised earthen redoubt (~3.5 m), so it can fire down on infantry at the foot of
   * the slope. The terrain polyline gets a flat-topped mound around cannonX with a ramp toward the enemy.
   */
  withRedoubt(level: LevelDef): [number, number][] {
    const cx = level.cannonX;
    const x0 = cx - 15, x1 = cx + 12;
    const clear = !level.houses.some((h) => h.x < x1 + 1 && h.x + h.w > x0 - 1) && !level.blocks.some((b) => b.x < x1 + 1 && b.x + b.w > x0 - 1);
    if (!clear) return level.ground;
    this.groundPts = level.ground;
    const gy = this.groundY(cx);
    const H = 3.5;
    const out = level.ground.filter(([x]) => x < x0 || x > x1);
    out.push([x0, this.groundY(x0)], [cx - 9, gy + H], [cx + 3, gy + H], [x1, this.groundY(x1)]);
    return out.sort((a, b) => a[0] - b[0]);
  }

  groundY(x: number) {
    const p = this.groundPts;
    if (!p.length) return 0;
    if (x <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (x <= p[i][0]) {
        const t = (x - p[i - 1][0]) / (p[i][0] - p[i - 1][0]);
        return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t;
      }
    }
    return p[p.length - 1][1];
  }

  shownMat(b: Block): MatId { return !this.revealed && b.def.disguise ? b.def.disguise : b.matId; }

  addBlock(d: BlockDef, fadeIn = false) {
    const mat = MATERIALS[d.mat];
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(d.x + d.w / 2, d.y + d.h / 2).setCanSleep(true).setAngularDamping(0.4).setLinearDamping(0.05),
    );
    // a degenerate outline (collinear points) has no hull: fall back to the bounding box rather than crash
    const shape = (d.poly && RAPIER.ColliderDesc.convexHull(new Float32Array(d.poly.flatMap(([x, y]) => [x - d.w / 2, y - d.h / 2]))))
      || RAPIER.ColliderDesc.cuboid(Math.max(0.01, d.w / 2 - 0.005), Math.max(0.01, d.h / 2)); // shrink sideways only: stacks must not sink a centimetre per joint
    const col = this.world.createCollider(shape.setDensity(mat.density).setFriction(mat.friction).setRestitution(0.05), body);
    const shown = MATERIALS[!this.revealed && d.disguise ? d.disguise : d.mat];
    const geo = blockGeometry(d.w, d.h, d.poly);
    const sm = makeBlockMaterial(shown.color, d.w, d.h, shown.kind, geo);
    const mesh = new THREE.Mesh(geo, sm);
    mesh.position.z = 4;
    if (d.target) {
      sm.uniforms.uTarget.value = 1;
      sm.uniforms.uTargetColor.value = new THREE.Color(TARGETS[d.target].color);
    }
    this.root.add(mesh);
    const hp = mat.hp * (d.target ? 1.2 : 1) * Math.min(2, Math.sqrt(Math.max(0.3, d.w * d.h)));
    const b: Block = {
      id: this.nextId++, def: d, body, collider: col, mesh, uni: sm.uniforms, matId: d.mat, mat, hp, maxHp: hp, w: d.w, h: d.h,
      target: d.target, dead: false, burning: 0, burnAmt: 0, flash: 0, lastVel: { x: 0, y: 0 }, cookoff: -1, highlight: 0, spreadT: 0, fuel: -1, fuelMax: 0, fireT: 0,
      rebuilt: fadeIn ? 0 : 1,
    };
    if (d.target === 'mast') {
      const m = makeSprite('mast', d.h * 1.06, 4.2);
      this.root.add(m);
      this.mastSprites.set(b, m);
    }
    if (d.target === 'artillery') {
      const gun = makeSprite('barrel', 0.45, 3.9);
      gun.scale.x = -1;
      gun.geometry.translate(-1.0, 0, 0);
      this.root.add(gun);
      this.enemyGuns.set(b, gun);
    }
    this.blocks.push(b);
    this.owners.set(col.handle, { t: 'block', b });
    return b;
  }

  addHouse(d: HouseDef) {
    const gy = this.groundY(d.x + d.w / 2);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(d.x + d.w / 2, gy + d.h * 0.45));
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(d.w * 0.42, d.h * 0.45), body);
    const mesh = makeSprite('house', d.h, 2);
    mesh.position.set(d.x + d.w / 2, gy + d.h / 2 - 0.05, 2);
    this.root.add(mesh);
    const h: House = { def: d, hp: 160, maxHp: 160, mesh, collider: col, body, dead: false };
    this.houses.push(h);
    this.owners.set(col.handle, { t: 'house', h });
  }

  get fortressBounds() {
    let x0 = Infinity, x1 = -Infinity, y1 = 0;
    for (const b of this.level.blocks) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    return { x0, x1, y1 };
  }

  // ───────────────────────── Battle control ─────────────────────────
  start(inventory: Partial<Record<AmmoId, number>>, spent: number, budget = this.level.budget, unlimited = false) {
    this.inventory = { ...inventory };
    this.dev.unlimited = unlimited;
    this.cannonHp = this.stats.cannonHp;
    this.speed = Math.min(this.speed, this.stats.maxSpeed);
    const fb = this.fortressBounds;
    this.strike.x = (fb.x0 + fb.x1) / 2;
    this.droneTarget = this.defaultLoiter();
    this.sabTarget = null;
    this.spentBudget = spent;
    this.moneyLeft = budget - spent;
    this.running = true;
    const first = (Object.keys(this.inventory) as AmmoId[]).find((k) => (this.inventory[k] ?? 0) > 0);
    if (first) this.selected = first;
  }

  get muzzle(): V2 {
    const bx = this.barrel.position.x, by = this.barrel.position.y;
    return { x: bx + Math.cos(this.angle) * 2.5, y: by + Math.sin(this.angle) * 2.5 };
  }

  /** max muzzle velocity for the selected round (light charges fly faster, heavy ones slower) */
  get maxSpeedFor() { return this.stats.maxSpeed * (AMMO_BY_ID[this.selected].speed || 1); }
  get launchSpeed() { return Math.max(PHYS.minSpeed, Math.min(this.speed, this.maxSpeedFor)); }
  setAngleDeg(d: number) { this.angle = (Math.max(this.stats.minAngle, Math.min(this.stats.maxAngle, d)) * Math.PI) / 180; }
  setSpeed(v: number) { this.speed = Math.max(PHYS.minSpeed, Math.min(this.stats.maxSpeed, v)); }

  canFire() {
    return this.running && !this.ended && this.reload <= 0 && (this.inventory[this.selected] ?? 0) > 0;
  }

  /** returns true if fired */
  fire(worldTarget?: V2): boolean {
    if (!this.canFire()) return false;
    const a = AMMO_BY_ID[this.selected];
    if (a.mode === 'airstrike') {
      if (worldTarget) this.strike.x = worldTarget.x;
      if (!this.launchAirstrike()) return false;
    } else if (a.mode === 'drone') {
      this.launchDrone();
    } else if (a.mode === 'saboteur') {
      for (let i = 0; i < this.stats.saboteurs; i++) this.launchSaboteur(i);
    } else {
      const m = this.muzzle;
      const s = this.launchSpeed;
      if (a.mode === 'pellets') {
        for (let i = 0; i < 14; i++) {
          const an = this.angle + (Math.random() - 0.5) * 0.14;
          const sp = s * (0.92 + Math.random() * 0.12);
          this.spawnProjectile(a, m.x, m.y, Math.cos(an) * sp, Math.sin(an) * sp, false, { pellet: true });
        }
      } else {
        const p = this.spawnProjectile(a, m.x, m.y, Math.cos(this.angle) * s, Math.sin(this.angle) * s, false);
        p.path = [{ x: m.x, y: m.y }];
        // a zero/NaN fuse would never count down (fuse > 0 gate) and the round would sit inert until it expired
        if (a.id === 'delayed') p.fuseSetting = Math.max(0.1, this.fuseSetting || 0);
        if (a.id === 'flak') p.fuseSetting = Math.max(0.2, this.flakFuse || 0);
        if (a.id === 'cluster' && this.airburst > 0) p.airburst = this.airburst;
      }
      this.muzzleBlast(m.x, m.y, this.angle, 1);
      this.r.shake = Math.max(this.r.shake, 0.5);
      audio.play('cannon', m.x, a.mode === 'pellets' ? 0.8 : 1, a.id === 'heavy' ? 0.85 : 1);
    }
    if (!this.dev.unlimited) this.inventory[this.selected] = (this.inventory[this.selected] ?? 0) - 1;
    this.reload = this.stats.reload;
    this.events.push({ type: 'fired' });
    if ((this.inventory[this.selected] ?? 0) <= 0) {
      const next = (Object.keys(this.inventory) as AmmoId[]).find((k) => (this.inventory[k] ?? 0) > 0);
      if (next) this.selected = next;
    }
    return true;
  }

  /** in-flight ability (cluster split) */
  triggerAbility(): boolean {
    for (const p of this.projectiles) {
      if (!p.dead && !p.enemy && p.ammo.id === 'cluster' && !p.bomblet && !p.split && !p.impacted) {
        this.splitCluster(p);
        return true;
      }
    }
    return false;
  }

  hasAbilityProjectile() {
    return this.projectiles.some((p) => !p.dead && !p.enemy && p.ammo.id === 'cluster' && !p.bomblet && !p.split && !p.impacted);
  }

  muzzleBlast(x: number, y: number, ang: number, scale: number) {
    this.r.lights.add(x, y, 6 * scale, [1, 0.75, 0.4], 1.4, 0.14);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (let i = 0; i < 14 * scale; i++) {
      const s = 2 + Math.random() * 6;
      this.r.fire.spawn({ x, y, vx: dx * s * 2 + (Math.random() - 0.5) * 3, vy: dy * s * 2 + (Math.random() - 0.5) * 3, max: 0.18 + Math.random() * 0.12,
        size0: 0.9 * scale, size1: 0.2, c0: [2.5, 1.6, 0.6], c1: [1.2, 0.3, 0.05], a0: 1, a1: 0, drag: 6 });
    }
    for (let i = 0; i < 10 * scale; i++) {
      const s = 1 + Math.random() * 3;
      this.r.smoke.spawn({ x, y, vx: dx * s + (Math.random() - 0.5), vy: dy * s + Math.random(), max: 1.4 + Math.random(),
        size0: 0.6 * scale, size1: 2.2 * scale, c0: [0.8, 0.78, 0.74], c1: [0.6, 0.6, 0.6], a0: 0.8, a1: 0, drag: 2.5, grav: 0.3 });
    }
  }

  private shellLooks = new Map<string, [THREE.BufferGeometry, THREE.Material][]>();
  spawnProjectile(a: AmmoDef, x: number, y: number, vx: number, vy: number, enemy: boolean, extra: Partial<Projectile> = {}): Projectile {
    const r = extra.pellet ? 0.09 : extra.bomblet ? 0.16 : a.radius;
    const g = new THREE.Group();
    // shell look (ink rim, body, highlight) is shared per calibre and colour: a canister volley used to
    // allocate (and never free) three geometries and three materials per pellet
    const key = `${r}|${a.color.join(',')}`;
    let look = this.shellLooks.get(key);
    if (!look) {
      look = [
        [new THREE.CircleGeometry(r * 1.25, 18), new THREE.MeshBasicMaterial({ color: 0x111111 })],
        [new THREE.CircleGeometry(r, 18), new THREE.MeshBasicMaterial({ color: new THREE.Color(...a.color) })],
        [new THREE.CircleGeometry(r * 0.4, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(...a.color).multiplyScalar(1.8) })],
      ];
      for (const [geo, mat] of look) { geo.userData.shared = true; mat.userData.shared = true; }
      this.shellLooks.set(key, look);
    }
    const [outline, core, hl] = look.map(([geo, mat]) => new THREE.Mesh(geo, mat));
    hl.position.set(-r * 0.35, r * 0.35, 0.02);
    core.position.z = 0.01;
    g.add(outline, core, hl);
    g.position.set(x, y, 10);
    this.root.add(g);
    const p: Projectile = {
      ammo: a, enemy, dmgMul: this.stats.dmg[a.id] ?? 1, radMul: this.stats.radius[a.id] ?? 1, mesh: g, x, y, vx, vy, age: 0, impacted: false, fuse: -1, pen: (a.pen ?? 0) * (this.stats.pen[a.id] ?? 1), dead: false, trail: 0, blastScale: 1, ...extra,
    };
    if ((a.mode === 'physics' || a.mode === 'airstrike') && !extra.pellet) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(vx, vy).setCcdEnabled(true).setAngularDamping(0.5));
      const col = this.world.createCollider(
        RAPIER.ColliderDesc.ball(r).setDensity(a.density).setRestitution(a.id === 'delayed' ? 0.45 : 0.2).setFriction(0.6)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
          // rounds don't collide with each other: bomblets spawn overlapping, and a spent ball resting at a wall
          // would otherwise shield it (proj-vs-proj contacts are ignored by onPhysicsImpact, so the HE would bounce off unexploded)
          .setCollisionGroups(PROJ_GROUPS),
        body,
      );
      p.body = body; p.collider = col;
      this.owners.set(col.handle, { t: 'proj', p });
    }
    this.projectiles.push(p);
    return p;
  }

  removeProjectile(p: Projectile) {
    if (p.dead) return;
    p.dead = true;
    if (p.body) { this.owners.delete(p.collider!.handle); this.world.removeRigidBody(p.body); p.body = undefined; }
    dropObject(p.mesh);
    if (p.path && !p.enemy && p.path.length > 2) this.setGhost(p.path);
  }

  setGhost(path: V2[]) {
    this.lastPath = path;
    const g = new THREE.BufferGeometry().setFromPoints(path.map((q) => new THREE.Vector3(q.x, q.y, 0)));
    this.ghost.geometry.dispose();
    this.ghost.geometry = g;
    this.ghost.computeLineDistances();
  }

  // ───────────────────────── Special launches ─────────────────────────
  /** ballistic impact point for a free-falling/flying body (bombsight solution, includes wind) */
  predictImpact(x: number, y: number, vx: number, vy: number, windSens: number): V2 {
    for (let i = 0; i < 900; i++) {
      vy += PHYS.gravity * DT; vx += this.wind * windSens * 0.35 * DT;
      x += vx * DT; y += vy * DT;
      if (y <= this.groundY(x)) return { x, y: this.groundY(x) };
    }
    return { x, y };
  }

  bombAmmo(): AmmoDef {
    const o = this.strike.ordnance;
    return AMMO_BY_ID[o === 'incendiary' ? 'bomb_inc' : o === 'penetrator' ? 'bomb_pen' : 'bomb_he'];
  }

  /**
   * Solve the bomb run: the bomber flies a straight line at the chosen dive angle and heading.
   * The middle of the stick is released at the chosen altitude so that it lands on the aim point;
   * each bomb's release point is found by bisection so the stick lands at the chosen spacing.
   */
  planStrike(): StrikeSolution {
    const st = this.strike;
    const n = this.stats.bombs;
    const speed = 26;
    const dive = this.stats.dive ? Math.max(0, Math.min(70, st.dive)) : 0;
    const th = (dive * Math.PI) / 180;
    const ux = st.dir * Math.cos(th), uy = -Math.sin(th);
    const a = this.bombAmmo();
    const ry = this.groundY(st.x) + Math.max(6, st.alt);
    let rx = st.x;
    for (let k = 0; k < 8; k++) {
      const imp = this.predictImpact(rx, ry, ux * speed, uy * speed, a.wind);
      rx += st.x - imp.x;
    }
    // the stick: bombs released every `spacing` metres of flight, centred on the solved release point
    const impactAt = (sp: number) => this.predictImpact(rx + ux * sp, ry + uy * sp, ux * speed, uy * speed, a.wind);
    const releases: number[] = [];
    const impacts: V2[] = [];
    const releasePts: V2[] = [];
    for (let i = 0; i < n; i++) {
      const sp = (i - (n - 1) / 2) * Math.max(0.15, st.spacing);
      releases.push(sp);
      impacts.push(impactAt(sp));
      releasePts.push({ x: rx + ux * sp, y: ry + uy * sp });
    }
    const first = Math.min(...releases);
    const back = 45;
    const sx = rx + ux * (first - back), sy = ry + uy * (first - back);
    const lowest = Math.min(...releasePts.map((q) => q.y - this.groundY(q.x)));
    // fly the pull-out after the last release exactly as updateAir will, to see if it clears the ground
    const last = Math.max(...releases);
    let px = rx + ux * last, py = ry + uy * last, ang = Math.atan2(uy, ux), floor = Infinity;
    const climb = ux >= 0 ? 0.35 : Math.PI - 0.35;
    for (let i = 0; i < 300; i++) {
      let d = climb - ang;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ang += Math.sign(d) * Math.min(Math.abs(d), DT * 1.6);
      px += Math.cos(ang) * speed * DT; py += Math.sin(ang) * speed * DT;
      floor = Math.min(floor, py - this.groundY(px));
      if (Math.abs(d) < 1e-3 && py - this.groundY(px) > 8) break;
    }
    return { sx, sy, ux, uy, speed, releases: releases.map((r) => r - (first - back)), impacts, releasePts, ok: lowest > 4 && floor > 1.5 };
  }

  launchAirstrike(): boolean {
    const sol = this.planStrike();
    const mesh = makeSprite('plane', 2.2, 14);
    if (sol.ux < 0) mesh.scale.x = -1;
    const p: Plane = {
      mesh, x: sol.sx, y: sol.sy, ux: sol.ux, uy: sol.uy, speed: sol.speed, s: 0, releases: [...sol.releases].sort((a, b) => a - b),
      ammo: this.bombAmmo(), down: false, dead: false, flakT: 0, exposure: 0, vy: 0, climbing: false,
    };
    mesh.position.set(p.x, p.y, 14);
    this.root.add(mesh);
    this.planes.push(p);
    this.airMarker = this.strike.x;
    this.toast(sol.ok ? 'Bomber inbound.' : 'Bomber inbound. That run is dangerously low!', sol.ok ? 'info' : 'bad');
    return true;
  }

  /**
   * Where the drone loiters unless the player picks a spot: deep over the fortress (70% of the way across),
   * 10 m above its ground, so its cameras sweep the rooms on the way in. (It used to default to 6 m above
   * the highest block over the middle: over a spired grand castle that is 30+ m up, out of camera range
   * of every walled-up room.)
   */
  defaultLoiter(): V2 {
    const fb = this.fortressBounds, x = fb.x0 + (fb.x1 - fb.x0) * 0.7;
    return { x, y: Math.min(fb.y1 + 6, this.groundY(x) + 10) };
  }

  launchDrone() {
    const tgt = this.droneTarget ?? this.defaultLoiter();
    const mesh = makeSprite('drone', 0.9, 14);
    const d: Drone = { mesh, x: this.level.cannonX, y: this.groundY(this.level.cannonX) + 3, tx: tgt.x, ty: Math.max(tgt.y, this.groundY(tgt.x) + 3), state: 'out', t: 0, vy: 0, dead: false };
    mesh.position.set(d.x, d.y, 14);
    this.root.add(mesh);
    this.drones.push(d);
  }

  launchSaboteur(i = 0) {
    const mesh = makeSprite('saboteur', 1.3, 7.5);
    const x = this.level.cannonX + 1.5 - i * 1.4;
    const s: Saboteur = { mesh, x, y: this.groundY(x), state: 'run', exposed: -i * 0.4, dead: false, dir: 1, phase: i, target: this.sabTarget };
    this.root.add(mesh);
    this.saboteurs.push(s);
    if (i === 0) this.toast(this.stats.saboteurs > 1 ? 'Fire team moving out.' : 'Saboteur moving out.', 'info');
  }

  splitCluster(p: Projectile) {
    p.split = true;
    const v = p.body ? p.body.linvel() : { x: p.vx, y: p.vy };
    const t = p.body ? p.body.translation() : { x: p.x, y: p.y };
    for (let i = 0; i < this.stats.clusterCount; i++) {
      const s = 0.7 + Math.random() * 0.6;
      this.spawnProjectile(p.ammo, t.x, t.y, v.x * s + (Math.random() - 0.5) * 6, v.y * s + (Math.random() - 0.5) * 6, false, { bomblet: true });
    }
    this.burst(t.x, t.y, 0.5);
    this.removeProjectile(p);
  }

  // ───────────────────────── Damage ─────────────────────────
  toast(text: string, tone: 'good' | 'bad' | 'info' = 'info') { this.events.push({ type: 'toast', text, tone }); }

  /**
    Objectives are the soft heart of a work (a map table, a powder store, a radio room), not its walls:
    a shell striking one squarely and hard knocks it out. What counts is the velocity along the face
    normal (speed x cos of the obliquity) against what that round needs: a 9 kg round shot needs 15 m/s
    square-on, a heavy shell about 10, a light incendiary or HE casing 20+ (HE's own blast does the
    rest). Below that the hit does a share falling to a third at 40% of the kill speed, and under that
    only its ordinary damage. Rounds past the ricochet angle glance off before they get here. Canister
    pellets, smoke and flak do their ordinary damage.
  */
  /** live block standing over the ground at x (what a burrowing drill is under) */
  blockOver(x: number): Block | undefined {
    const hit = this.world.castRay(new RAPIER.Ray({ x, y: this.groundY(x) + 0.05 }, { x: 0, y: 1 }), 1.2, true, undefined, undefined, undefined, undefined,
      (c) => this.owners.get(c.handle)?.t === 'block');
    const o = hit ? this.owners.get(hit.collider.handle) : undefined;
    return o?.t === 'block' && !o.b.dead ? o.b : undefined;
  }

  objectiveHit(b: Block, p: Projectile, speed: number, cosI = 1) {
    if (!b.target || p.enemy || p.pellet) return 0;
    const a = p.ammo;
    if (a.id === 'smoke' || a.id === 'flak') return 0;
    const punch = Math.max(10, a.kinetic, (a.pen ?? 0) * 0.4);
    const vKill = 15 * Math.sqrt(55 / punch), vMin = vKill * 0.4;
    const vn = speed * cosI;
    if (vn < vMin) return 0;
    return b.maxHp * 1.05 * Math.min(1, 0.34 + 0.66 * (vn - vMin) / (vKill - vMin));
  }

  damageBlock(b: Block, dmg: number, cause = '') {
    if (b.dead || b.mat.indestructible || dmg <= 0) return;
    b.hp -= dmg;
    b.flash = Math.min(1, b.flash + Math.min(0.8, dmg / 60));
    if (b.hp <= 0) this.destroyBlock(b, cause);
    // a breached fuel tank leaks and catches: it cooks off shortly after
    else if (b.mat.volatile && b.burning <= 0 && b.hp < b.maxHp * 0.45) this.ignite(b);
  }

  destroyBlock(b: Block, _cause = '') {
    if (b.dead) return;
    this.frac.onDestroy(b);
    b.dead = true;
    const t = b.body.translation();
    const rot = b.body.rotation();
    const v = b.body.linvel();
    this.owners.delete(b.collider.handle);
    this.world.removeRigidBody(b.body);
    dropObject(b.mesh);
    const gun = this.enemyGuns.get(b);
    if (gun) { dropObject(gun); this.enemyGuns.delete(b); }
    const mast = this.mastSprites.get(b);
    if (mast) { dropObject(mast); this.mastSprites.delete(b); }
    audio.play(b.matId === 'wood' || b.matId === 'crate' ? 'splinter' : b.matId === 'steel' || b.matId === 'reactive' ? 'clang' : 'crumble', t.x, 0.7);
    // debris
    const c = new THREE.Color(...MATERIALS[this.shownMat(b)].color);
    const n = Math.min(26, 4 + Math.round(b.w * b.h * 6));
    for (let i = 0; i < n; i++) {
      const lx = (Math.random() - 0.5) * b.w, ly = (Math.random() - 0.5) * b.h;
      const x = t.x + lx * Math.cos(rot) - ly * Math.sin(rot), y = t.y + lx * Math.sin(rot) + ly * Math.cos(rot);
      const cc = c.clone().multiplyScalar(0.7 + Math.random() * 0.45);
      this.r.debris.spawn(x, y, v.x + (Math.random() - 0.5) * 7, v.y + Math.random() * 6, 0.12 + Math.random() * 0.28, cc);
    }
    for (let i = 0; i < 6; i++) {
      this.r.smoke.spawn({ x: t.x + (Math.random() - 0.5) * b.w, y: t.y + (Math.random() - 0.5) * b.h, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 1.5,
        max: 1.5 + Math.random(), size0: 0.8, size1: 2.5, c0: [0.72, 0.68, 0.6], c1: [0.6, 0.58, 0.55], a0: 0.7, a1: 0, drag: 1.5 });
    }
    if (b.mat.volatile) {
      // bigger tanks throw a bigger fireball; the blast ignites (rather than outright flattens) the next
      // tank along, which then cooks off a couple of seconds later: a reliable chain, not an instant one
      const s = Math.min(2.2, Math.max(0.7, Math.sqrt(b.w * b.h)));
      this.pending.push({ x: t.x, y: t.y, r: 2.5 + 1.6 * s, dmg: 140, delay: 0.08 + Math.random() * 0.15, opts: { ignite: 5, visual: 0.8 + 0.4 * s, source: 'fuel', fuelChain: true } });
    } else if (b.burning > 0 && b.mat.flammable) this.shedEmbers(b, t, v);
    if (b.target) {
      this.targetsDestroyed[b.target] = (this.targetsDestroyed[b.target] ?? 0) + 1;
      this.events.push({ type: 'target', kind: b.target });
      const remaining = (this.targetsTotal[b.target] ?? 0) - (this.targetsDestroyed[b.target] ?? 0);
      const names: Record<TargetKind, string> = {
        command: 'Command post destroyed!', ammo: 'Munitions store detonated!', barracks: 'Barracks destroyed. No more reinforcements.',
        artillery: 'Enemy gun silenced!', workshop: 'Engineers eliminated. No more repairs.', flak: 'Flak gun destroyed. Skies are clear.',
        mast: 'Mooring mast down. No more aircraft from it.', depot: 'Motor pool destroyed. No more vehicles.',
      };
      this.toast(remaining > 0 && b.target === 'ammo' ? 'Munitions detonated! One store remains.' : names[b.target], 'good');
      if (b.target === 'ammo') {
        this.pending.push({ x: t.x, y: t.y, r: 5, dmg: 200, delay: 0.05, opts: { ignite: 6, visual: 1.8, source: 'ammo' } });
      }
    } else if (!b.def.target && b.rebuilt >= 1 && !b.frag) {
      this.destroyedSlots.push({ def: b.def, t: this.battleTime });
    }
  }

  damageHouse(h: House, dmg: number) {
    if (h.dead || dmg <= 0) return;
    const d = Math.min(h.hp, dmg);
    h.hp -= d;
    this.collateral += d * 3 * this.level.collateralMult;
    if (h.hp <= 0) {
      h.dead = true;
      this.collateral += 600 * this.level.collateralMult;
      (h.mesh.material as THREE.MeshBasicMaterial).color.setRGB(0.35, 0.3, 0.28);
      h.mesh.scale.y = 0.45;
      h.mesh.position.y -= h.def.h * 0.27;
      const c = new THREE.Color(0.55, 0.42, 0.32);
      for (let i = 0; i < 24; i++) this.r.debris.spawn(h.mesh.position.x + (Math.random() - 0.5) * h.def.w, h.mesh.position.y + Math.random() * 2, (Math.random() - 0.5) * 8, Math.random() * 8, 0.2 + Math.random() * 0.3, c.clone().multiplyScalar(0.7 + Math.random() * 0.5));
      this.toast('Civilian home destroyed. Heavy collateral penalty.', 'bad');
    } else if (d > 10 && this.time - this.lastCollateralToast > 2) {
      this.lastCollateralToast = this.time;
      this.toast('Civilian property hit. Collateral penalty.', 'bad');
    }
  }

  /** player ordnance blast, scaled by researched upgrades */
  boom(p: Projectile, x: number, y: number, radius: number, dmg: number, opts: BlastOpts = {}) {
    this.explode(x, y, radius * p.radMul, dmg * p.dmgMul, opts);
  }

  explode(x: number, y: number, radius: number, dmg: number, opts: BlastOpts = {}) {
    const vis = opts.visual ?? radius / 3;
    if (!opts.smoke) audio.play(radius < 2.2 ? 'blastSmall' : radius < 4.6 ? 'blast' : 'blastBig', x, Math.min(1.2, 0.5 + radius / 5));
    // visuals
    this.burst(x, y, vis, opts.smoke, opts.source === 'fuel' || opts.source === 'ammo');
    this.r.shake = Math.min(2.2, this.r.shake + vis * 0.7);
    if (vis > 1.2) { this.r.flash = Math.min(1, this.r.flash + 0.5); this.r.split = Math.min(1, this.r.split + vis * 0.45); }
    if (!opts.smoke) this.r.lights.add(x, y + 0.5, Math.max(4, radius * 2.6), [1.0, 0.62, 0.28], 1.6 + vis * 0.4, 0.35 + vis * 0.2, 0.3);
    if (radius <= 0) return;
    const ball = new RAPIER.Ball(radius);
    const hitBlocks: Block[] = [];
    const hitHouses: House[] = [];
    this.world.intersectionsWithShape({ x, y }, 0, ball, (col) => {
      const o = this.owners.get(col.handle);
      if (o?.t === 'block') hitBlocks.push(o.b);
      else if (o?.t === 'house') hitHouses.push(o.h);
      return true;
    });
    for (const b of hitBlocks) {
      if (b.dead) continue;
      const t = b.body.translation();
      const dx = t.x - x, dy = t.y - y;
      const dist = Math.hypot(dx, dy);
      // distance to the block's nearest surface, not its centre: long slabs and beams take the blast where it touches them
      const near = b.collider.projectPoint({ x, y }, true);
      const qx = near ? near.point.x : t.x, qy = near ? near.point.y : t.y;
      const d = near ? Math.hypot(qx - x, qy - y) : Math.max(0, dist - Math.min(b.w, b.h) * 0.5);
      let f = Math.max(0, 1 - d / radius);
      if (f <= 0) continue;
      // occlusion: blast spends itself on the first wall between the burst and this block
      let shielded = false;
      if (d > 0.4) {
        const dir = { x: (qx - x) / d, y: (qy - y) / d };
        const hit = this.world.castRay(new RAPIER.Ray({ x, y }, dir), d, true, undefined, undefined, undefined, undefined, (c) => {
          const o = this.owners.get(c.handle);
          return o?.t === 'block' && o.b !== b && !o.b.dead;
        });
        if (hit && hit.timeOfImpact > 0.15) {
          f *= 0.35;
          const o = this.owners.get(hit.collider.handle);
          shielded = !(o?.t === 'block' && o.b.mat.flammable);
        }
      }
      // a tank blast spends itself mostly on air: the next tank along is holed and set alight, and cooks off on its own
      const bonus = opts.bonus?.[b.matId] ?? (opts.fuelChain && b.mat.volatile ? 0.5 : 1);
      // flak shells are thin-walled fragmentation rounds: little effect on masonry
      let bd = dmg * f * b.mat.blast * bonus * (opts.flak ? 0.4 : 1);
      // an HE shell (or bigger) bursting close to an objective, not behind a wall, takes half its strength:
      // two near misses finish it. Smaller charges count in proportion (a heavy shell's burst ~30%, a round shot's ~14%).
      if (b.target && !opts.enemy && !opts.flak && !opts.smoke && f > 0.25) bd = Math.max(bd, b.maxHp * (shielded ? 0.3 : 0.55) * Math.min(1, dmg / 100));
      this.frac.hit(b, { kind: 'blast', x: qx, y: qy, dx: d > 0.01 ? (qx - x) / d : 0, dy: d > 0.01 ? (qy - y) / d : 1, e: bd, fire: !!opts.ignite, quiet: opts.source === 'shot' || opts.smoke });
      this.damageBlock(b, bd, opts.source);
      // the fireball does not lick round a wall: a firebrick (or other non-flammable) wall in the way keeps the flames off
      if (opts.ignite && b.mat.flammable && f > 0.25 && !shielded) this.ignite(b, opts.ignite * 2.5);
      // burning fuel sprays over neighbouring tanks: they catch even behind pipework, and cook off
      else if (opts.fuelChain && b.mat.volatile) this.ignite(b, 5);
      if (!b.dead) {
        const push = (opts.push ?? 1) * dmg * f * 0.075;
        const nx = dist > 0.01 ? dx / dist : 0, ny = dist > 0.01 ? dy / dist : 1;
        b.body.applyImpulse({ x: nx * push, y: ny * push + (opts.under ? push * 1.4 : push * 0.15) }, true);
        b.body.applyTorqueImpulse((Math.random() - 0.5) * push * 0.3, true);
        const v = b.body.linvel();
        b.lastVel = { x: v.x, y: v.y };
      }
    }
    for (const h of hitHouses) {
      const t = h.body.translation();
      const d = Math.max(0, Math.hypot(t.x - x, t.y - y) - 1.6);
      const f = Math.max(0, 1 - d / radius);
      if (!opts.enemy) this.damageHouse(h, dmg * f * 0.8);
    }
    // projectiles: kick resting ones
    for (const p of this.projectiles) {
      if (p.body && !p.dead) {
        const t = p.body.translation();
        const d = Math.hypot(t.x - x, t.y - y);
        if (d < radius && d > 0.01) p.body.applyImpulse({ x: (t.x - x) / d * dmg * 0.01, y: (t.y - y) / d * dmg * 0.01 + 0.5 }, true);
      }
    }
    this.garrison.blast(x, y, radius);
    this.crew.blast(x, y, radius);
    if (!opts.enemy) this.air.blast(x, y, radius, dmg, !!opts.flak);
    // infantry
    if (!opts.enemy) this.motor.blast(x, y, radius, dmg, opts);
    for (const s of this.soldiers) {
      if (s.dead) continue;
      // a flak shell is a thin-cased AA round: bursting on the ground it kills only the men right beside it
      // (it used to kill anyone in its full 4.4 m radius, so a 45-credit AA round out-killed canister)
      const R = (opts.flak ? radius * 0.35 : radius * 1.15) + 0.3, d = Math.hypot(s.x - x, s.y + 0.6 - y);
      if (d >= R) continue;
      // a shield takes a weak burst in front of it (solid shot striking it); a real blast, fire, or a burst behind or over him kills
      const e = dmg * (1 - d / R);
      if (s.shield > 0 && !opts.ignite && e < 30 && x < s.x - 0.1 && y < s.y + 1.3) { this.hitShield(s, e); continue; }
      this.killSoldier(s);
    }
    for (const s of this.saboteurs) if (!s.dead && Math.hypot(s.x - x, s.y + 0.6 - y) < radius * 0.9) this.killSaboteur(s, 'Saboteur caught in the blast.');
    // player cannon
    const cx = this.level.cannonX, cy = this.groundY(cx) + 1;
    const cd = Math.hypot(cx - x, cy - y);
    if (cd < radius + 1.2) this.damageCannon((dmg * 0.32 * (1 - cd / (radius + 1.2)) + (opts.enemy ? 6 : 0)) * (opts.enemy && this.stats.shieldedGun ? 0.5 : 1));
  }

  burst(x: number, y: number, s: number, smokeOnly = false, fuel = false) {
    const nearGround = y - this.groundY(x) < 1.5;
    if (smokeOnly) fxSmokeCloud(this.r.fx, x, y);
    else fxExplosion(this.r.fx, x, y, s, fuel);
    if (nearGround && !smokeOnly) {
      const c = new THREE.Color(0.4, 0.31, 0.22);
      for (let i = 0; i < 10 * s + 2; i++) this.r.debris.spawn(x, this.groundY(x) + 0.1, (Math.random() - 0.5) * 10 * s, 3 + Math.random() * 8 * s, 0.1 + Math.random() * 0.2, c.clone().multiplyScalar(0.7 + Math.random() * 0.5));
    }
  }

  /** seconds of fire a block holds: material burn time scaled by its size */
  burnTime(b: Block) { return (b.mat.burn ?? 12) * Math.min(1.45, Math.max(0.6, Math.sqrt(b.w * b.h))); } // a big timber burns ~15-18 s, not half a minute

  /**
   * Set a block alight. Once it catches it burns through all its remaining fuel; `_heat` (the old
   * burn-seconds argument) is kept for callers but no longer sets the duration.
   */
  ignite(b: Block, _heat = 8) {
    if (b.dead || !b.mat.flammable) return;
    if (b.fuel < 0) { b.fuelMax = this.burnTime(b); b.fuel = b.fuelMax; }
    if (b.fuel <= 0.5 || b.burning > 0) return; // burnt out, or already alight
    if (b.target === 'ammo') {
      b.cookoff = 2.5;
      this.toast('Munitions store is burning…', 'good');
    } else if (b.mat.volatile && b.cookoff <= 0) b.cookoff = 1.2 + Math.random() * 1.6;
    b.fireT = 0;
    b.burning = b.fuel;
    b.spreadT = Math.random() * FIRE_TICK;
  }

  /** a burning block breaking up throws brands that can light what they land on */
  shedEmbers(b: Block, t: V2, v: V2) {
    const n = 2 + Math.min(4, Math.round(b.w * b.h * 3));
    for (let i = 0; i < n && this.embers.length < 60; i++) {
      this.embers.push({ x: t.x + (Math.random() - 0.5) * b.w, y: t.y + (Math.random() - 0.5) * b.h,
        vx: v.x * 0.6 + (Math.random() - 0.5) * 3 + this.wind * 0.3, vy: v.y * 0.6 + 0.5 + Math.random() * 2.5, life: 2.5 + Math.random() * 1.5 });
    }
  }

  updateEmbers(dt: number) {
    if (!this.embers.length) return;
    for (const e of this.embers) {
      e.life -= dt;
      e.vy -= 7 * dt;
      e.vx += (this.wind * 0.4 - e.vx) * Math.min(1, dt * 0.8);
      e.x += e.vx * dt; e.y += e.vy * dt;
      if (Math.random() < 0.5) this.r.fire.spawn({ x: e.x, y: e.y, max: 0.18, size0: 0.16, size1: 0.04, c0: [3, 1.4, 0.35], c1: [1.4, 0.25, 0.04], a0: 1, a1: 0 });
      if (e.y <= this.groundY(e.x)) { e.life = 0; continue; }
      if (e.vy > 0) continue;
      let hit: Block | null = null;
      this.world.intersectionsWithPoint({ x: e.x, y: e.y }, (c) => {
        const o = this.owners.get(c.handle);
        if (o?.t === 'block' && !o.b.dead) { hit = o.b; return false; }
        return true;
      });
      if (hit) {
        const h = hit as Block;
        e.life = 0;
        if (h.mat.flammable && Math.random() < 0.3 * (h.mat.catches ?? 1)) this.ignite(h);
      }
    }
    this.embers = this.embers.filter((e) => e.life > 0);
  }

  /**
   * Radiant heat from burning block `b` (centre `t`): roll ignition for each flammable neighbour
   * within FIRE_REACH of its surface. Runs once per FIRE_TICK per fire, so ~400 blocks stay cheap.
   */
  spreadFire(b: Block, t: V2) {
    const shape = new RAPIER.Cuboid(b.w / 2 + FIRE_REACH, b.h / 2 + FIRE_REACH);
    const near: Block[] = [];
    this.world.intersectionsWithShape(t, b.body.rotation(), shape, (c) => {
      const o = this.owners.get(c.handle);
      if (o?.t === 'block' && o.b !== b && !o.b.dead && o.b.mat.flammable && o.b.burning <= 0 && o.b.fuel !== 0) near.push(o.b);
      return true;
    });
    if (!near.length) return;
    // the fire grows over its first ~2 s and dies down over its last 2
    const grow = Math.min(1, 0.3 + b.fireT / 3) * Math.min(1, 0.4 + b.burning / 3);
    const sv = b.body.linvel();
    const tumbling = sv.x * sv.x + sv.y * sv.y > 2.5;
    for (const n of near) {
      const c = b.collider.contactCollider(n.collider, FIRE_REACH);
      if (!c) continue;
      const gap = Math.max(0, c.distance);
      if (gap >= FIRE_REACH) continue;
      const heat = gap < 0.03 ? 1 : (1 - gap / FIRE_REACH) ** 1.5;
      const nx = c.normal1.x, ny = c.normal1.y;
      // masonry, firebrick and the like in the gap shadow the heat
      if (gap > 0.06) {
        const blocked = this.world.castRay(new RAPIER.Ray(c.point1, { x: nx, y: ny }), gap, true, undefined, undefined, undefined, undefined, (cc) => {
          const o = this.owners.get(cc.handle);
          return o?.t === 'block' && o.b !== b && o.b !== n && !o.b.dead && !o.b.mat.flammable;
        });
        if (blocked) continue;
      }
      // length of the shared face, along the contact tangent
      const ov = this.faceOverlap(b, n, -ny, nx);
      const area = Math.min(1.3, 0.3 + 0.7 * ov / 0.8);
      // flames climb: above x3.5, beside x1, below x0.2 (unless this block is itself falling onto it)
      const orient = ny >= 0 ? 1 + 2.5 * ny : tumbling ? 1 : 1 + 0.8 * ny;
      const wind = Math.min(1.8, Math.max(0.4, 1 + nx * this.wind * 0.18));
      const rate = FIRE_RATE * heat * area * orient * wind * (n.mat.catches ?? 1) * grow;
      if (Math.random() < 1 - Math.exp(-rate * FIRE_TICK)) this.ignite(n);
    }
  }

  /** overlap of two blocks' outlines projected on direction (tx, ty), metres */
  faceOverlap(a: Block, b: Block, tx: number, ty: number) {
    const span = (k: Block) => {
      const p = k.body.translation(), r = k.body.rotation();
      const c = Math.cos(r), s = Math.sin(r);
      const mid = p.x * tx + p.y * ty;
      const half = Math.abs((c * tx + s * ty) * k.w / 2) + Math.abs((-s * tx + c * ty) * k.h / 2);
      return [mid - half, mid + half];
    };
    const [a0, a1] = span(a), [b0, b1] = span(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  damageCannon(d: number) {
    if (d <= 0 || this.ended || this.winT >= 0 || this.dev.god) return;
    this.cannonHp = Math.max(0, this.cannonHp - d);
    this.gunFlash = 1;
    this.events.push({ type: 'gunhit', dmg: d });
    const b = this.barrel.position;
    this.sparks(b.x, b.y, Math.min(14, 3 + Math.round(d)));
    if (!this.gunCritical && this.cannonHp / this.stats.cannonHp < 0.3 && this.cannonHp > 0) {
      this.gunCritical = true;
      this.toast('Gun critical! Silence the guns or blind them with smoke.', 'bad');
      audio.play('fail', undefined, 0.6, 1.4);
    }
    if (this.cannonHp <= 0) this.end(false, 'Your cannon was destroyed.');
  }

  /** does the path (x0,y0)->(x1,y1) pass within r of a standing soldier's body? */
  sweptHit(s: Soldier, x0: number, y0: number, x1: number, y1: number, r: number) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / 0.2));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      if (Math.abs(x - s.x) < r && y > s.y - 0.1 && y < s.y + 1.45) return true;
    }
    return false;
  }

  killSoldier(s: Soldier) {
    if (s.dead) return;
    s.dead = true;
    s.deadT = 0;
    const c = new THREE.Color(0.35, 0.4, 0.3);
    for (let i = 0; i < 4; i++) this.r.debris.spawn(s.x, s.y + 0.6, (Math.random() - 0.5) * 4, Math.random() * 4, 0.12, c);
  }

  /**
   * A round reaching soldier s at velocity (vx, vy). A shield faces the gun: it stops rounds from the gun's side
   * flatter than ~50° of plunge unless they carry enough energy to knock him flat. Returns true if he went down.
   */
  shotSoldier(s: Soldier, vx: number, vy: number, energy: number) {
    if (s.dead) return false;
    if (!(s.shield > 0 && vx > 0 && -vy < vx * 1.2) || energy >= 95) { this.killSoldier(s); return true; }
    this.hitShield(s, energy);
    return false;
  }

  hitShield(s: Soldier, dmg: number) {
    const m = s.rig.muzzle();
    this.sparks(s.x - 0.35, m.y - 0.1, 4);
    if (Math.random() < 0.4) audio.play('clang', s.x, 0.4, 1.5);
    s.shield -= dmg;
    if (s.shield > 0) return;
    s.shield = 0;
    s.rig.dropShield();
    const c = new THREE.Color(0.4, 0.42, 0.45);
    for (let i = 0; i < 6; i++) this.r.debris.spawn(s.x - 0.35, s.y + 0.4 + Math.random() * 0.8, (Math.random() - 0.7) * 4, Math.random() * 4, 0.1 + Math.random() * 0.12, c);
  }

  killSaboteur(s: Saboteur, msg: string) {
    if (s.dead) return;
    s.dead = true;
    dropObject(s.mesh);
    this.toast(msg, 'bad');
  }

  // ───────────────────────── Projectile impacts ─────────────────────────
  onPhysicsImpact(p: Projectile, other: ReturnType<Game['owners']['get']>) {
    if (p.dead || !p.body) return;
    if (other?.t === 'proj') return;
    const a = p.ammo;
    const t = p.body.translation();
    const v = { x: p.vx, y: p.vy }; // pre-impact velocity
    const speed = Math.hypot(v.x, v.y);
    const block = other?.t === 'block' ? other.b : undefined;
    const house = other?.t === 'house' ? other.h : undefined;
    const ground = other?.t === 'ground';

    if (p.enemy) {
      this.explode(t.x, t.y, 3.2, 70, { enemy: true });
      this.removeProjectile(p);
      return;
    }
    if (p.inert !== undefined) return;

    // reactive armor
    if (block && block.matId === 'reactive' && !block.dead && speed > 14 && !(a.id === 'sticky')) {
      this.reactiveDetonate(block, t.x, t.y);
      if (a.id === 'smoke') this.smokeScreen(t.x, t.y);
      this.removeProjectile(p);
      return;
    }

    // sloped armour: effective thickness grows as 1/cos(obliquity); past the critical angle the round glances off
    let cosI = 1;
    if (block && !p.impacted && speed > 1) {
      this.world.contactPair(p.collider!, block.collider, (m) => { const n = m.normal(); cosI = Math.abs((v.x * n.x + v.y * n.y) / speed); });
      const crit = RICOCHET[block.matId];
      if (crit && cosI < crit && !['sticky', 'delayed', 'smoke'].includes(a.id) && !p.bomblet) {
        this.ricochet(t.x, t.y, block);
        const rd = a.kinetic * (speed / 30) ** 2 * block.mat.kinetic * cosI * 0.5;
        this.frac.hit(block, { kind: 'glance', x: t.x, y: t.y, dx: v.x / speed, dy: v.y / speed, e: rd, ammo: a.id, r: a.radius, speed, cosI });
        this.damageBlock(block, rd);
        p.impacted = true;
        p.inert = 2;
        return;
      }
    }
    if (speed > 6 && !p.impacted) this.garrison.blast(t.x, t.y, 0.7);
    const kin = a.kinetic * (speed / 30) ** 2 * cosI;
    if (block && !p.impacted) {
      const kd = Math.max(kin * block.mat.kinetic, this.objectiveHit(block, p, speed, cosI));
      if (speed > 1) this.frac.hit(block, { kind: 'shot', x: t.x, y: t.y, dx: v.x / speed, dy: v.y / speed, e: kd, ammo: a.id, r: p.bomblet ? 0.16 : a.radius, speed, cosI });
      this.damageBlock(block, kd);
    }
    if (house && !p.impacted) this.damageHouse(house, kin * 0.6);

    if (p.bomblet) {
      this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage);
      this.removeProjectile(p);
      return;
    }
    switch (a.id) {
      case 'shell':
      case 'heavy':
        if (!p.impacted) this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage, { push: a.id === 'heavy' ? 1.6 : 1, source: 'shot' });
        p.impacted = true;
        p.inert = 2.5;
        break;
      case 'he':
      case 'cluster':
        this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage);
        this.removeProjectile(p);
        break;
      case 'incendiary':
      case 'bomb_inc':
        this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage, { ignite: a.ignite, visual: 0.9 });
        for (let i = 0; i < 40; i++) {
          const an = Math.random() * Math.PI;
          this.r.fire.spawn({ x: t.x, y: t.y, vx: Math.cos(an) * 6, vy: Math.sin(an) * 6, max: 1 + Math.random(), size0: 0.5, size1: 0.1, c0: [3, 1.2, 0.2], c1: [1.5, 0.3, 0], a0: 1, a1: 0, grav: -9, drag: 0.5 });
        }
        this.removeProjectile(p);
        break;
      case 'flak':
        this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage, { flak: true, visual: 0.8 });
        this.removeProjectile(p);
        break;
      case 'smoke':
        this.smokeScreen(t.x, t.y);
        this.removeProjectile(p);
        break;
      case 'delayed':
        if (!p.impacted) { p.impacted = true; p.fuse = p.fuseSetting ?? a.fuse ?? 3; }
        break;
      case 'sticky':
        if (!p.impacted) {
          p.impacted = true;
          p.fuse = this.stats.stickyFuse;
          if (block && !block.dead) {
            const bt = block.body.translation(), br = block.body.rotation();
            const dx = t.x - bt.x, dy = t.y - bt.y;
            const c = Math.cos(-br), s = Math.sin(-br);
            p.stuck = { block, lx: dx * c - dy * s, ly: dx * s + dy * c, rot: 0 };
          } else p.stuck = { lx: t.x, ly: t.y, rot: 0 };
          this.owners.delete(p.collider!.handle);
          this.world.removeRigidBody(p.body);
          p.body = undefined;
          p.x = t.x; p.y = t.y;
        }
        break;
      case 'drill':
        // earthworks are dirt like the ground: the drill bores into them too and blows from beneath
        if ((ground || block?.matId === 'earth') && !p.impacted) {
          p.impacted = true;
          p.burrow = { dir: Math.sign(v.x) || 1, dist: 0 };
          this.owners.delete(p.collider!.handle);
          this.world.removeRigidBody(p.body);
          p.body = undefined;
          p.x = t.x; p.y = this.groundY(t.x) - 0.9;
          this.burst(t.x, this.groundY(t.x), 0.4, false);
          this.toast('Drill is burrowing…', 'info');
        } else if (!ground) {
          // struck masonry instead of earth: the bit grinds into the block and the charge goes off inside it
          // (it used to fizzle with a 70-damage pop, wasting the round on any wall it clipped)
          if (block && !block.dead) {
            const bd = p.dmgMul * a.blastDamage * block.mat.blast * (a.bonus?.[block.matId] ?? 1);
            this.frac.hit(block, { kind: 'charge', x: t.x, y: t.y, dx: 0, dy: 0, e: bd, ammo: a.id });
            this.damageBlock(block, bd);
          }
          this.boom(p, t.x, t.y, a.blastRadius * 0.8, a.blastDamage, { bonus: a.bonus });
          this.removeProjectile(p);
        }
        break;
      default:
        this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage);
        this.removeProjectile(p);
    }
  }

  ricochet(x: number, y: number, b: Block) {
    this.sparks(x, y, 14);
    audio.play('clang', x, 0.9, 1.15);
    if (this.time - this.lastRicochetToast > 4) { this.lastRicochetToast = this.time; this.toast(`Ricochet off sloped ${MATERIALS[this.shownMat(b)].name.toLowerCase()}. Hit it square.`, 'info'); }
  }

  reactiveDetonate(b: Block, x: number, y: number) {
    audio.play('reactive', x);
    this.burst(x, y, 0.8);
    this.r.flash = Math.min(1, this.r.flash + 0.3);
    this.destroyBlock(b, 'reactive');
    this.toast('Reactive armor detonated your round!', 'bad');
  }

  smokeScreen(x: number, y: number) {
    this.burst(x, y, 1, true);
    this.enemyBlind = 15;
    this.toast('Smoke screen: enemy guns blinded for 15s.', 'good');
  }

  /** manual ballistic step for penetrators and pellets */
  stepPenetrator(p: Projectile, dt: number) {
    const a = p.ammo;
    const sx0 = p.x, sy0 = p.y;
    p.vy += PHYS.gravity * dt;
    p.vx += this.wind * a.wind * 0.35 * dt;
    let remaining = Math.hypot(p.vx, p.vy) * dt;
    // infantry along this step's path, checked before walls or ground can end the step
    if (p.pellet || a.id === 'ap') {
      const ex = sx0 + p.vx * dt, ey = sy0 + p.vy * dt;
      for (const s of this.soldiers) {
        if (s.dead || !this.sweptHit(s, sx0, sy0, ex, ey, p.pellet ? 0.35 : 0.3)) continue;
        // a shield stops a pellet; AP goes through shield and man alike
        if (!this.shotSoldier(s, p.vx, p.vy, p.pellet ? 2.5 : 999)) { this.removeProjectile(p); return; }
        p.kills = (p.kills ?? 0) + 1;
        if (p.pellet && p.kills >= 2) { this.removeProjectile(p); return; }
      }
    }
    // blocks this round has already bored or cut through stay out of its way
    const exclude = this.frac.passedBy(p);
    let guard = 0;
    while (remaining > 1e-4 && guard++ < 12 && !p.dead) {
      const sp = Math.hypot(p.vx, p.vy);
      const dir = { x: p.vx / sp, y: p.vy / sp };
      const hit = this.world.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y: p.y }, dir), remaining, true, undefined, undefined, undefined, undefined, (c) => {
        if (exclude.has(c.handle)) return false;
        const o = this.owners.get(c.handle);
        return !!o && o.t !== 'proj';
      });
      if (!hit) { p.x += dir.x * remaining; p.y += dir.y * remaining; break; }
      const toi = hit.timeOfImpact;
      p.x += dir.x * toi; p.y += dir.y * toi;
      remaining -= toi;
      const o = this.owners.get(hit.collider.handle);
      if (p.pellet) {
        this.garrison.blast(p.x, p.y, 0.55);
        if (o?.t === 'block') {
          this.frac.hit(o.b, { kind: 'pellet', x: p.x, y: p.y, dx: dir.x, dy: dir.y, e: a.kinetic * o.b.mat.kinetic * p.dmgMul });
          this.damageBlock(o.b, a.kinetic * o.b.mat.kinetic * p.dmgMul);
        }
        if (o?.t === 'house') this.damageHouse(o.h, 3 * p.dmgMul);
        this.sparks(p.x, p.y, 4);
        this.removeProjectile(p);
        return;
      }
      if (o?.t === 'block') {
        const b = o.b;
        if (b.matId === 'reactive') {
          this.reactiveDetonate(b, p.x, p.y);
          if (a.id === 'bunker') { this.boom(p, p.x - dir.x * 0.5, p.y - dir.y * 0.5, a.blastRadius * 0.7, a.blastDamage * 0.5); this.toast('Bunker buster detonated prematurely.', 'bad'); }
          this.removeProjectile(p);
          return;
        }
        // a ray that starts inside a collider (a block fell onto the round) has no face normal: treat as head-on,
        // otherwise it "ricochets" in place every step and never resolves
        const inside = toi <= 1e-6 || Math.hypot(hit.normal.x, hit.normal.y) < 0.5;
        const cosI = inside ? 1 : Math.max(0.2, Math.abs(dir.x * hit.normal.x + dir.y * hit.normal.y));
        const crit = RICOCHET[b.matId];
        if (crit && !inside && cosI < crit * 0.95) {
          // glance: reflect off the face, lose energy and most of the penetrating power
          const dn = dir.x * hit.normal.x + dir.y * hit.normal.y;
          const rx = dir.x - 2 * dn * hit.normal.x, ry = dir.y - 2 * dn * hit.normal.y;
          const sp2 = Math.hypot(p.vx, p.vy) * 0.65;
          p.vx = rx * sp2; p.vy = ry * sp2;
          p.pen *= 0.55;
          p.x += hit.normal.x * 0.05; p.y += hit.normal.y * 0.05;
          this.frac.hit(b, { kind: 'glance', x: p.x, y: p.y, dx: dir.x, dy: dir.y, e: p.pen * b.mat.pierce * cosI * 0.3, ammo: a.id, r: a.radius, cosI });
          this.damageBlock(b, p.pen * b.mat.pierce * cosI * 0.3);
          this.ricochet(p.x, p.y, b);
          remaining *= 0.5;
          continue;
        }
        const eff = b.hp / b.mat.pierce / cosI;
        b.body.applyImpulse({ x: dir.x * 4, y: dir.y * 4 }, true);
        this.sparks(p.x, p.y, 8);
        if (!p.entry) p.entry = { x: p.x, y: p.y };
        this.garrison.blast(p.x, p.y, 0.8);
        // a bunker buster arms on entry and goes off inside, not after boring out the far side
        const deep = a.fuse && Math.hypot(p.x - p.entry.x, p.y - p.entry.y) > 2.6;
        if (p.pen >= eff && !b.mat.indestructible && !deep) {
          p.pen -= eff;
          // a slender member is cut in two along the shot, a thick one bored through (src/fracture.ts); otherwise it is holed out
          const out = this.frac.apThrough(b, p.x, p.y, dir, a.id);
          if (!out) this.destroyBlock(b, 'ap');
          else {
            // the block still stands (bored, or cut at the end of the frame): the round comes out the far side
            const adv = Math.hypot(out.x - p.x, out.y - p.y);
            p.x = out.x; p.y = out.y;
            remaining = Math.max(0, remaining - adv);
          }
          exclude.add(hit.collider.handle);
          p.vx *= 0.88; p.vy *= 0.88;
          p.x += dir.x * 0.01; p.y += dir.y * 0.01;
          continue;
        }
        const sd = Math.max(p.pen * b.mat.pierce * cosI, this.objectiveHit(b, p, Math.hypot(p.vx, p.vy), cosI));
        this.frac.hit(b, { kind: 'apStop', x: p.x, y: p.y, dx: dir.x, dy: dir.y, e: sd, ammo: a.id, cosI });
        this.damageBlock(b, sd);
        if (b.matId === 'steel' && a.id === 'ap') this.toast('Armor plate stopped the AP round.', 'info');
        // never hand a destroyed block (its Rapier body is freed) to the embed code
        this.penetratorStop(p, dir, b.dead ? undefined : b);
        return;
      }
      if (o?.t === 'house') {
        this.damageHouse(o.h, 60);
        this.penetratorStop(p, dir);
        return;
      }
      // ground
      this.penetratorStop(p, dir);
      return;
    }
    // pellets vs infantry

  }

  penetratorStop(p: Projectile, dir: V2, b?: Block) {
    const a = p.ammo;
    if (a.fuse) {
      // bunker buster: embed and arm
      p.impacted = true;
      p.fuse = a.fuse;
      p.vx = 0; p.vy = 0;
      if (b && !b.dead) {
        const bt = b.body.translation(), br = b.body.rotation();
        const x = p.x + dir.x * 0.25, y = p.y + dir.y * 0.25;
        const dx = x - bt.x, dy = y - bt.y;
        const c = Math.cos(-br), s = Math.sin(-br);
        p.stuck = { block: b, lx: dx * c - dy * s, ly: dx * s + dy * c, rot: 0 };
      } else p.stuck = { lx: p.x + dir.x * 0.6, ly: p.y + dir.y * 0.6, rot: 0 };
    } else {
      this.boom(p, p.x, p.y, a.blastRadius, a.blastDamage);
      this.removeProjectile(p);
    }
  }

  sparks(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++) {
      const an = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 10;
      this.r.fire.spawn({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, max: 0.25 + Math.random() * 0.25, size0: 0.15, size1: 0.05, c0: [3, 2.4, 1.2], c1: [2, 0.6, 0.1], a0: 1, a1: 0, grav: -14 });
    }
  }

  // ───────────────────────── Main update ─────────────────────────
  update(dt: number) {
    this.time += dt;
    if (this.running && !this.ended) this.battleTime += dt;
    this.reload = this.dev.instantReload ? 0 : Math.max(0, this.reload - dt);
    this.enemyBlind = Math.max(0, this.enemyBlind - dt);

    // capture pre-step velocities of projectiles
    for (const p of this.projectiles) {
      if (p.body && !p.dead) {
        const v = p.body.linvel();
        p.vx = v.x; p.vy = v.y;
        // wind
        p.body.setLinvel({ x: v.x + this.wind * p.ammo.wind * 0.35 * dt, y: v.y }, true);
      }
    }

    this.world.step(this.eq);
    this.eq.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const o1 = this.owners.get(h1), o2 = this.owners.get(h2);
      if (o1?.t === 'proj') this.onPhysicsImpact(o1.p, o2);
      if (o2?.t === 'proj') this.onPhysicsImpact(o2.p, o1);
    });

    this.updateBlocks(dt);
    this.updateEmbers(dt);
    this.updateBackdrops(dt);
    this.garrison.update(dt);
    this.updateGunFx(dt);
    this.air.update(dt, this.running && !this.ended);
    this.updateProjectiles(dt);
    this.updatePending(dt);
    // splits and marks from this frame's hits (outside the physics step and the event drain)
    this.frac.update(dt);
    this.updateSoldiers(dt);
    this.motor.update(dt, this.running && !this.ended);
    this.updateAir(dt);
    this.updateSaboteurs(dt);
    if (this.running && !this.ended) this.updateEnemy(dt);
    this.checkEnd(dt);
    this.syncMeshes();
  }

  updateBackdrops(dt: number) {
    this.backdropT -= dt;
    const check = this.backdropT <= 0;
    if (check) this.backdropT = 0.2;
    for (const bd of this.backdrops) {
      if (bd.fade < 1 || check) {
        if (bd.fade === 1) {
          const failed = bd.deps.some((b, i) => {
            if (b.dead) return true;
            const t = b.body.translation();
            return Math.hypot(t.x - bd.home[i].x, t.y - bd.home[i].y) > 0.6;
          });
          if (!failed) continue;
          const p = bd.mesh.position;
          for (let i = 0; i < 6; i++) this.r.smoke.spawn({ x: p.x + (Math.random() - 0.5) * 3, y: p.y + (Math.random() - 0.5) * 2, vy: 0.6, max: 2, size0: 1, size1: 3, c0: [0.5, 0.47, 0.42], c1: [0.6, 0.58, 0.55], a0: 0.5, a1: 0, drag: 1 });
          bd.fade = 0.999;
        }
        bd.fade = Math.max(0, bd.fade - dt * 2.5);
        (bd.mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = bd.fade;
        if (bd.fade <= 0) bd.mesh.visible = false;
      }
    }
  }

  /** gun damage feedback: flash, health bar with a trailing 'lost' segment, smoke and fire when critical, incoming markers */
  updateGunFx(dt: number) {
    if (!this.hpBar) return;
    const frac = Math.max(0, this.cannonHp / this.stats.cannonHp);
    this.gunFlash = Math.max(0, this.gunFlash - dt * 4);
    this.hpLag = this.hpLag > frac ? Math.max(frac, this.hpLag - dt * 0.35) : frac;
    const fill = this.hpBar.getObjectByName('fill') as THREE.Mesh;
    const lag = this.hpBar.getObjectByName('lag') as THREE.Mesh;
    fill.scale.x = Math.max(0.001, frac);
    lag.scale.x = Math.max(0.001, this.hpLag);
    (fill.material as THREE.MeshBasicMaterial).color.set(frac > 0.5 ? 0x8fc46a : frac > 0.3 ? 0xffb347 : 0xe2503a);
    (lag.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.85 - this.gunFlash * 0.5, 0.6 - this.gunFlash * 0.5);
    const jit = this.gunFlash * 0.08;
    this.hpBar.position.x = this.level.cannonX - 0.1 + (Math.random() - 0.5) * jit;
    // the gun itself flashes red when hit
    for (const m of [this.carriage, this.barrel.children[0] as THREE.Mesh]) {
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setRGB(1 + this.gunFlash * 1.5, 1 - this.gunFlash * 0.6, 1 - this.gunFlash * 0.6);
    }
    // a damaged gun smokes; a critical one burns
    const b = this.barrel.position;
    if (frac < 0.6 && Math.random() < dt * (frac < 0.3 ? 18 : 6)) {
      this.r.smoke.spawn({ x: b.x - 0.4 + Math.random() * 0.8, y: b.y + 0.2, vx: this.wind * 0.4, vy: 1.2, max: 2.5, size0: 0.5, size1: 2.2, c0: [0.2, 0.19, 0.18], c1: [0.45, 0.44, 0.42], a0: 0.7, a1: 0, drag: 0.6 });
    }
    if (frac < 0.3 && frac > 0) {
      if (Math.random() < dt * 14) this.r.fire.spawn({ x: b.x - 0.6 + Math.random() * 1.2, y: b.y - 0.1, vy: 1.6, max: 0.5, size0: 0.55, size1: 0.1, c0: [2.6, 1.1, 0.25], c1: [1.2, 0.2, 0.02], a0: 1, a1: 0 });
      this.r.lights.set('gunfire', b.x, b.y, 3, [1, 0.5, 0.15], 0.8, 0.5);
    }
    // incoming shell markers pulse and tighten as the shell nears
    for (const m of this.incoming) {
      m.t -= dt;
      const k = Math.max(0, m.t);
      const s = 0.8 + Math.min(1.6, k * 0.4) + Math.sin(this.time * 14) * 0.08;
      m.mesh.scale.set(s, s * 0.35, 1);
      (m.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.5 * Math.abs(Math.sin(this.time * (k < 1 ? 16 : 7)));
      if (m.t < -0.4) dropObject(m.mesh);
    }
    this.incoming = this.incoming.filter((m) => m.t >= -0.4);
  }

  updateBlocks(dt: number) {
    const settle = this.running;
    for (const b of this.blocks) {
      if (b.dead) continue;
      const v = b.body.linvel();
      if (settle && !b.body.isSleeping()) {
        const dv = Math.hypot(v.x - b.lastVel.x, v.y - b.lastVel.y);
        if (dv > 4.5 && !this.frac.inGrace(b)) {
          const id = Math.pow(dv - 4.5, 1.5) * 3 * b.mat.kinetic;
          const t = b.body.translation();
          this.frac.hit(b, { kind: 'impact', x: t.x, y: t.y, dx: (v.x - b.lastVel.x) / dv, dy: (v.y - b.lastVel.y) / dv, e: id });
          this.damageBlock(b, id, 'impact');
        }
        // crush soldiers
        if (!b.dead && Math.hypot(v.x, v.y) > 2.5) {
          const t = b.body.translation();
          for (const s of this.soldiers) if (!s.dead && Math.abs(s.x - t.x) < b.w / 2 + 0.3 && s.y + 1.2 > t.y - b.h / 2 && s.y < t.y + b.h / 2) this.killSoldier(s);
        }
      }
      if (b.dead) continue;
      b.lastVel = { x: v.x, y: v.y };
      const t = b.body.translation();
      if (t.y < -20) { this.destroyBlock(b); continue; }
      // fire
      if (b.burning > 0) {
        if (b.fuelMax <= 0) b.fuelMax = Math.max(b.burning, this.burnTime(b)); // set alight without ignite()
        b.burning -= dt;
        b.fireT += dt;
        b.fuel = Math.max(0, b.burning);
        const grow = Math.min(1, 0.3 + b.fireT / 3) * Math.min(1, 0.4 + b.burning / 3);
        this.r.lights.set(`fire${b.id}`, t.x, t.y + b.h * 0.3, (3.5 + b.w) * (0.6 + 0.4 * grow), [1, 0.5, 0.15], 0.9 * grow, 0.45);
        if (Math.random() < dt * 3) audio.play('fire', t.x, 0.5);
        // chars as it burns through its fuel
        b.burnAmt = Math.min(1, Math.max(b.burnAmt, 0.1 + 1.1 * (1 - b.fuel / b.fuelMax)));
        // HP goes over ~80% of the burn: timber usually gives way before it burns out
        this.damageBlock(b, b.mat.fire * grow * b.maxHp / (b.fuelMax * 0.8) * dt, 'fire');
        if (b.dead) continue;
        fxBurning(this.r.fx, t.x, t.y, b.w, b.h, grow, dt, b.body.rotation());
        b.spreadT -= dt;
        if (b.spreadT <= 0) {
          b.spreadT = FIRE_TICK;
          this.spreadFire(b, t);
        }
      }
      if (b.cookoff > 0) {
        b.cookoff -= dt;
        if (b.cookoff <= 0) this.destroyBlock(b, 'fire');
      }
    }
  }

  updateProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (p.dead) continue;
      p.age += dt;
      // aircraft: flak bursts by proximity or timer; everything else hits what it touches
      if (!p.enemy && !p.impacted && !p.stuck && !p.burrow) {
        const isFlak = p.ammo.id === 'flak';
        const u = this.air.at(p.x, p.y, isFlak ? 2.4 : 0.15);
        let flakGo = false;
        if (isFlak) {
          // proximity fuze: arm inside the sensing radius, burst at the point of closest approach
          // (or on contact), so a well-aimed shell bursts right beside the aircraft instead of at the edge of its range
          const d = u ? Math.hypot(u.x - p.x, u.y - p.y) : Infinity;
          if (u && this.air.at(p.x, p.y, 0.15)) flakGo = true;
          else if (p.prox !== undefined && d >= p.prox - 1e-3) flakGo = true;
          else if (u) p.prox = d;
          if (p.age >= (p.fuseSetting ?? 2.5)) flakGo = true;
        }
        if (flakGo || (!isFlak && u)) {
          if (isFlak) { this.boom(p, p.x, p.y, p.ammo.blastRadius, p.ammo.blastDamage, { flak: true, visual: 0.8 }); this.removeProjectile(p); continue; }
          if (u) {
            this.air.damage(u, p.pellet ? 9 * p.dmgMul : p.ammo.kinetic * 1.4 + (p.ammo.pen ?? 0) * 0.25);
            if (p.ammo.blastRadius > 0) this.boom(p, p.x, p.y, p.ammo.blastRadius, p.ammo.blastDamage);
            else if (p.ammo.id === 'smoke') this.smokeScreen(p.x, p.y);
            else this.sparks(p.x, p.y, 8);
            this.removeProjectile(p);
            continue;
          }
        }
      }
      // enemy armour in the way
      this.motor.hit(p, dt);
      if (p.dead) continue;
      if (p.airburst && !p.split && !p.impacted && p.age >= p.airburst) { this.splitCluster(p); continue; }
      if (p.body) {
        const t = p.body.translation();
        p.x = t.x; p.y = t.y;
        if (p.path && !p.impacted) p.path.push({ x: t.x, y: t.y });
      } else if (p.burrow) {
        const step = 9 * dt * p.burrow.dir;
        p.x += step; p.burrow.dist += Math.abs(step);
        p.y = this.groundY(p.x) - 0.9;
        if (Math.random() < 0.5) this.r.debris.spawn(p.x, this.groundY(p.x) + 0.05, (Math.random() - 0.5) * 2, 2 + Math.random() * 2, 0.12, new THREE.Color(0.42, 0.32, 0.22));
        // the drill runs on under walls: it blows beneath the first target it reaches, or at the end of its run
        // beneath the last structure it passed under (it used to stop under the first block, so the outer wall
        // or glacis always took it and nothing behind could be reached)
        const over = this.blockOver(p.x);
        if (over) p.burrow.under = p.x;
        const end = p.burrow.dist > this.stats.drillRange;
        if (over?.target || end) {
          if (!over && p.burrow.under !== undefined) p.x = p.burrow.under;
          const ob = over ?? this.blockOver(p.x);
          const gy = this.groundY(p.x);
          const a = p.ammo;
          // a tamped charge: the block sitting over the drill takes the focused blast (like a planted charge),
          // and an objective right above it is as good as hit; earthworks are dirt like the ground, so the drill
          // cuts them where shells only soak in
          if (ob) {
            const od = p.dmgMul * a.blastDamage * ob.mat.blast * (a.bonus?.[ob.matId] ?? 1);
            this.frac.hit(ob, { kind: 'charge', x: p.x, y: gy + 0.05, dx: 0, dy: 1, e: od, ammo: a.id });
            this.damageBlock(ob, Math.max(od, this.objectiveHit(ob, p, 99)));
          }
          this.boom(p, p.x, gy - 0.4, a.blastRadius, a.blastDamage, { under: true, push: 1.4, bonus: a.bonus });
          this.removeProjectile(p);
          continue;
        }
      } else if (p.stuck) {
        if (p.stuck.block) {
          const b = p.stuck.block;
          if (b.dead) { p.stuck = { lx: p.x, ly: p.y, rot: 0 }; } else {
            const bt = b.body.translation(), br = b.body.rotation();
            const c = Math.cos(br), s = Math.sin(br);
            p.x = bt.x + p.stuck.lx * c - p.stuck.ly * s;
            p.y = bt.y + p.stuck.lx * s + p.stuck.ly * c;
          }
        } else { p.x = p.stuck.lx; p.y = p.stuck.ly; }
      } else if (p.ammo.mode === 'penetrator' || p.pellet) {
        if (p.path && !p.impacted) p.path.push({ x: p.x, y: p.y });
        this.stepPenetrator(p, dt);
        if (p.dead) continue;
      }
      // trail
      if (!p.impacted && !p.pellet) {
        p.trail -= dt;
        if (p.trail <= 0) {
          p.trail = 0.025;
          const hot = p.ammo.id === 'incendiary';
          this.r.smoke.spawn({ x: p.x, y: p.y, max: 0.9, size0: p.bomblet ? 0.25 : 0.45, size1: 1.1, c0: hot ? [0.4, 0.3, 0.25] : [0.85, 0.83, 0.8], c1: [0.7, 0.7, 0.7], a0: 0.55, a1: 0, drag: 1 });
          if (hot) this.r.fire.spawn({ x: p.x, y: p.y, max: 0.3, size0: 0.6, size1: 0.1, c0: [3, 1.2, 0.2], c1: [1, 0.2, 0], a0: 1, a1: 0 });
        }
      }
      // fuses
      if (p.fuse > 0) {
        p.fuse -= dt;
        if (Math.floor(p.fuse * 6) % 2 === 0) this.r.fire.spawn({ x: p.x, y: p.y + 0.2, max: 0.1, size0: 0.4, size1: 0.3, c0: [3, 0.4, 0.2], c1: [3, 0.4, 0.2], a0: 1, a1: 0 });
        if (p.fuse <= 0) {
          const a = p.ammo;
          // charges in contact with (or buried in) a block hit it with the full, focused blast
          const host = p.stuck?.block;
          // a saboteur's demolition charge is tamped against the wall like a bunker buster's
          if (host && !host.dead) {
            const hd = p.dmgMul * a.blastDamage * (a.id === 'bunker' || a.id === 'bomb_pen' || a.id === 'saboteur' ? 1.6 : 0.8) * host.mat.blast * (a.bonus?.[host.matId] ?? 1);
            this.frac.hit(host, { kind: 'charge', x: p.x, y: p.y, dx: 0, dy: 0, e: hd, ammo: a.id });
            this.damageBlock(host, hd);
          }
          this.boom(p, p.x, p.y, a.blastRadius, a.blastDamage, { bonus: a.bonus, push: a.id === 'bunker' ? 1.3 : 1 });
          this.removeProjectile(p);
          continue;
        }
      }
      if (p.inert !== undefined) {
        p.inert -= dt;
        if (p.inert <= 0) { this.removeProjectile(p); continue; }
      }
      // physical projectiles vs infantry
      if ((!p.impacted || p.inert !== undefined) && !p.harmless) {
        const prev = p.prev ?? { x: p.x, y: p.y };
        p.prev = { x: p.x, y: p.y };
        for (const s of this.soldiers) if (!s.dead && this.sweptHit(s, prev.x, prev.y, p.x, p.y, 0.45)) {
          // pellets and penetrators meet shields in stepPenetrator
          if (!p.body && !p.stuck) { if (!s.shield) this.killSoldier(s); continue; }
          const fused = p.enemy || (p.ammo.blastRadius > 0 && !p.inert && !['delayed', 'sticky', 'shell', 'heavy'].includes(p.ammo.id));
          if (!fused) {
            // a shield stops solid shot and inert rounds unless the blow knocks him flat
            const v = p.body?.linvel() ?? { x: p.vx, y: p.vy };
            const down = this.shotSoldier(s, v.x, v.y, p.ammo.kinetic * (Math.hypot(v.x, v.y) / 30) ** 2 * p.dmgMul);
            if (!down) { p.harmless = true; if (p.body) p.body.setLinvel({ x: -v.x * 0.12, y: v.y * 0.2 }, true); break; }
          } else this.killSoldier(s);
          if (!p.body && !p.stuck) continue;
          // solid shot (round shot, heavy shell) ploughs on through the file; fuzed rounds go off
          if (p.ammo.id === 'shell' || p.ammo.id === 'heavy') { const v = p.body?.linvel(); if (v) p.body!.setLinvel({ x: v.x * 0.85, y: v.y * 0.85 }, true); continue; }
          if (p.enemy) {
            // the enemy's own shell going off among its infantry is still an enemy blast (no collateral, gun shield applies)
            this.explode(p.x, p.y, 3.2, 70, { enemy: true });
            this.removeProjectile(p);
            break;
          }
          if (p.ammo.blastRadius > 0 && !p.inert && !['delayed', 'sticky'].includes(p.ammo.id)) {
            // a flak shell striking a man is still a flak burst (thin case, little ground effect)
            this.boom(p, p.x, p.y, p.ammo.blastRadius, p.ammo.blastDamage, p.ammo.id === 'flak' ? { flak: true, visual: 0.8 } : {});
            this.removeProjectile(p);
            break;
          }
        }
      }
      if (p.age > 25 || p.y < -15 || p.x < -200 || p.x > 400) this.removeProjectile(p);
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  updatePending(dt: number) {
    // every queued blast ticks each frame; at most 50 go off per frame so a long chain can't stall it
    // (the old guard counted every visited entry, so anything past the 50th never counted down)
    const due: PendingBlast[] = [];
    this.pending = this.pending.filter((e) => {
      e.delay -= dt;
      if (e.delay <= 0 && due.length < 50) { due.push(e); return false; }
      return true;
    });
    // blasts queued by these (fuel tanks, magazines) start ticking next frame
    for (const e of due) this.explode(e.x, e.y, e.r, e.dmg, e.opts);
  }

  // ───────────────────────── Infantry ─────────────────────────
  spawnSoldier(x: number, shield = false) {
    const rig = new SoldierRig(true, shield ? (this.level.era === 'modern' ? 'ballistic' : 'pavise') : undefined);
    rig.group.position.z = 7.2;
    const s: Soldier = { x, y: this.groundY(x), rig, dead: false, shootT: 1 + Math.random(), stopX: this.level.cannonX + 13 + Math.random() * 7, phase: Math.random() * 6, deadT: 0, shield: shield ? 70 : 0 };
    rig.update(0, x, s.y, 'idle');
    this.root.add(rig.group);
    this.soldiers.push(s);
  }

  // ───────────────────────── Dev sandbox spawns ─────────────────────────
  /**
   * Put `n` enemy units on the field (dev panel). Infantry and vehicles enter at the foot of the fortress
   * and advance on the gun; aircraft appear over the castle at cruise height. These are sprites, not
   * physics bodies; only their shells and bombs are. DEV_CAP bounds how many of each family can be alive
   * at once, a frame-time guard so a held button can't bury the page in rigs and enemy shells.
   */
  devSpawn(kind: DevUnit, n: number) {
    const fb = this.fortressBounds;
    const front = fb.x0 - 1;
    const valley0 = this.level.cannonX + 14;
    let made = 0;
    for (let i = 0; i < n; i++) {
      if (kind === 'infantry' || kind === 'shield') {
        if (this.soldiers.filter((s) => !s.dead).length >= DEV_CAP.infantry) break;
        this.spawnSoldier(Math.max(valley0, front - (i % 12) * 1.4 - Math.random() * 0.8), kind === 'shield');
      } else if (kind === 'car' || kind === 'tank') {
        if (this.motor.alive.length >= DEV_CAP.vehicle) break;
        const len = kind === 'tank' ? 4.8 : 4.1; // hull lengths from the sprites' aspect
        const queued = this.motor.alive.length;
        // queue nose to tail out of the fortress; once the valley is full, anywhere along it
        let x = fb.x0 - 2 - len / 2 - queued * (len + 1.4);
        if (x < valley0 + len) x = valley0 + len + Math.random() * Math.max(1, fb.x0 - valley0 - 2 * len);
        this.motor.launch(kind, null, x);
      } else {
        if (this.air.units.filter((u) => !u.down).length >= DEV_CAP.air) break;
        const alt = kind === 'airship' ? 21 : 13;
        const x = fb.x0 + 4 + i * (kind === 'airship' ? 10 : 3.5);
        this.air.launch(kind, null, { x, y: this.groundY(x) + alt + (Math.random() - 0.5) * 3 });
      }
      made++;
    }
    return made;
  }

  /** remove every enemy unit from the field (dev panel): infantry fall, vehicles and aircraft are simply taken off */
  devClearField() {
    for (const s of this.soldiers) this.killSoldier(s);
    for (const u of this.motor.units) { dropObject(u.mesh); dropObject(u.bar); }
    this.motor.units = [];
    for (const u of this.air.units) { dropObject(u.mesh); u.dead = true; }
    this.air.units = [];
  }

  /** open every concealed room (dev panel) */
  devRevealRooms() {
    let n = 0;
    for (const r of this.garrison.rooms.list) if (r.hidden) { this.garrison.rooms.uncover(r, 'breach'); n++; }
    return n;
  }

  updateSoldiers(dt: number) {
    for (const s of this.soldiers) {
      if (s.eng) continue; // engineers: src/engineers.ts
      if (s.dead) {
        s.deadT += dt;
        s.rig.update(dt, s.x, s.y, 'dead');
        if (s.deadT > 2.2) s.rig.fade(Math.max(0, 1 - (s.deadT - 2.2) / 1.5));
        continue;
      }
      let shooting = false;
      // saboteur engagement
      for (const sb of this.saboteurs) {
        if (!sb.dead && Math.abs(sb.x - s.x) < 13) {
          sb.exposed += dt;
          shooting = true;
          if (Math.random() < dt * 4) { const m = s.rig.muzzle(); s.rig.recoil = 1; this.tracer(m.x, m.y, sb.x, sb.y + 0.8); }
        }
      }
      if (s.x > s.stopX && !shooting) {
        s.x -= (s.shield > 0 ? 1.25 : 1.6) * dt;
        s.y = this.groundY(s.x);
        s.rig.update(dt, s.x, s.y, 'walk');
      } else {
        s.rig.update(dt, s.x, s.y, 'shoot');
        s.shootT -= dt;
        if (!shooting && s.shootT <= 0 && this.running && !this.ended) {
          s.shootT = 0.9 + Math.random() * 0.4;
          const c = this.barrel.position;
          const m = s.rig.muzzle();
          s.rig.recoil = 1;
          this.tracer(m.x, m.y, c.x, c.y);
          this.damageCannon(1.1);
        }
      }
    }
    const before = this.soldiers.length;
    this.soldiers = this.soldiers.filter((s) => { if (s.dead && s.deadT > 3.7) { dropObject(s.rig.group); return false; } return true; });
    void before;
  }

  tracer(x0: number, y0: number, x1: number, y1: number, sound: 'rifle' | 'flak' | null = 'rifle') {
    if (sound) audio.play(sound, x0, sound === 'flak' ? 0.6 : 0.5);
    this.r.lights.add(x0, y0, 2.2, [1, 0.8, 0.45], 1, 0.06);
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy);
    const sp = 60;
    this.r.fire.spawn({ x: x0, y: y0, vx: (dx / d) * sp, vy: (dy / d) * sp, max: Math.min(0.5, d / sp), size0: 0.18, size1: 0.18, c0: [3, 2.4, 1], c1: [3, 1.6, 0.6], a0: 1, a1: 0.6 });
    this.r.fire.spawn({ x: x0, y: y0, max: 0.06, size0: 0.6, size1: 0.3, c0: [3, 2.2, 1], c1: [2, 1, 0.3], a0: 1, a1: 0 });
  }

  // ───────────────────────── Air units ─────────────────────────
  liveTargets(kind: TargetKind) { return this.blocks.filter((b) => !b.dead && b.target === kind); }

  nearestFlak(flak: Block[], x: number, y: number) {
    let best: { t: V2; d: number } | null = null;
    for (const b of flak) {
      const t = b.body.translation();
      const d = Math.hypot(x - t.x, y - t.y);
      if (!best || d < best.d) best = { t: { x: t.x, y: t.y }, d };
    }
    return best;
  }

  updateAir(dt: number) {
    const flak = this.liveTargets('flak');
    for (const pl of this.planes) {
      if (pl.dead) continue;
      if ((this.time * 1000) % 3500 < 17) audio.play('plane', pl.x, 0.9);
      if (!pl.down) {
        const vx = pl.ux * pl.speed, vy = pl.uy * pl.speed;
        pl.s += pl.speed * dt;
        pl.x += vx * dt; pl.y += vy * dt;
        // a bomb-aimer under flak fire is thrown off: bombs released inside a flak gun's reach scatter
        const underFire = pl.releases.length && pl.s >= pl.releases[0] ? this.nearestFlak(flak, pl.x, pl.y) : null;
        const jolt = underFire && underFire.d < 48 ? (2.5 + 3.5 * Math.min(1, pl.exposure)) * (this.stats.ecm ? 0.4 : 1) : 0;
        while (pl.releases.length && pl.s >= pl.releases[0]) {
          // release where the bombsight solution put it, not up to a frame's flight later
          const back = pl.s - pl.releases.shift()!;
          const b = this.spawnProjectile(pl.ammo, pl.x - pl.ux * back, pl.y - pl.uy * back, vx + (Math.random() - 0.5) * 2 * jolt, vy + (Math.random() - 0.5) * jolt, false);
          b.path = undefined;
        }
        // pull out of the dive once the stick is gone
        if (!pl.releases.length) {
          pl.climbing = true;
          const ang = Math.atan2(pl.uy, pl.ux);
          const target = pl.ux >= 0 ? 0.35 : Math.PI - 0.35;
          let d = target - ang;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const na = ang + Math.sign(d) * Math.min(Math.abs(d), dt * 1.6);
          pl.ux = Math.cos(na); pl.uy = Math.sin(na);
        }
        if (pl.y < this.groundY(pl.x) + 0.8) {
          pl.dead = true;
          this.toast('The bomber flew into the ground. Pull out sooner.', 'bad');
          this.explode(pl.x, this.groundY(pl.x) + 0.5, 3.5, 80);
        }
        const fl = this.nearestFlak(flak, pl.x, pl.y);
        if (fl) {
          const f = fl.t, d = fl.d;
          if (d < 48) {
            pl.flakT -= dt;
            if (pl.flakT <= 0) {
              pl.flakT = 0.15;
              const bx = pl.x + (Math.random() - 0.3) * 6, by = pl.y + (Math.random() - 0.5) * 5;
              this.burst(bx, by, 0.3, false);
              this.tracer(f.x, f.y + 0.5, bx, by, 'flak');
            }
            // the whole run inside the gun's reach counts: a bomber that releases short of the flak still flies on over it
            pl.exposure += dt * (d < 30 ? 1.6 : 1);
            if (pl.exposure > (this.stats.ecm ? 5 : 1.6)) { pl.down = true; pl.vy = pl.uy * pl.speed; this.toast('Flak shot down your bomber!', 'bad'); }
          }
        }
        if (Math.abs(pl.x - this.level.cannonX) > 300 || pl.y > 120) pl.dead = true;
        pl.mesh.rotation.z = Math.atan2(pl.uy, Math.abs(pl.ux)) * Math.sign(pl.ux || 1);
      } else {
        pl.vy -= 9.81 * dt;
        pl.x += pl.ux * pl.speed * dt * 0.7;
        pl.y += pl.vy * dt;
        pl.mesh.rotation.z += -Math.sign(pl.ux || 1) * dt * 0.8;
        if (Math.random() < 0.6) this.r.smoke.spawn({ x: pl.x, y: pl.y, vx: -2, vy: 1, max: 2.5, size0: 1, size1: 3, c0: [0.15, 0.14, 0.14], c1: [0.4, 0.4, 0.4], a0: 0.8, a1: 0, drag: 0.5 });
        if (Math.random() < 0.5) this.r.fire.spawn({ x: pl.x, y: pl.y, max: 0.3, size0: 1, size1: 0.2, c0: [2.8, 1.2, 0.3], c1: [1, 0.2, 0], a0: 1, a1: 0 });
        if (pl.y < this.groundY(pl.x) + 0.5) {
          pl.dead = true;
          this.explode(pl.x, this.groundY(pl.x) + 0.5, 3, 60);
        }
      }
      pl.mesh.position.set(pl.x, pl.y, 14);
      if (pl.dead) dropObject(pl.mesh);
    }
    this.planes = this.planes.filter((p) => !p.dead);
    if (!this.planes.length) this.airMarker = null;

    for (const d of this.drones) {
      if (d.dead) continue;
      d.t += dt;
      if ((this.time * 1000) % 2200 < 17) audio.play('drone', d.x, 0.8);
      if (d.state === 'out') {
        const dx = d.tx - d.x, dy = d.ty - d.y, dist = Math.hypot(dx, dy);
        const sp = 18 * dt;
        if (dist < sp) { d.state = 'hover'; d.t = 0; this.reveal(); }
        else { d.x += (dx / dist) * sp; d.y += (dy / dist) * sp; }
      } else if (d.state === 'hover') {
        d.x += Math.sin(d.t * 2) * dt * 2;
        const fl = this.nearestFlak(flak, d.x, d.y);
        if (fl && fl.d < 48 && d.t > (this.stats.droneStealth ? 4 : 1.5)) {
          d.state = 'down'; this.toast('Drone shot down by flak (intel already sent).', 'info');
          const f = fl.t;
          this.tracer(f.x, f.y, d.x, d.y, 'flak');
        } else if (d.t > this.stats.droneTime) d.state = 'back';
      } else if (d.state === 'back') {
        d.x -= 20 * dt; d.y += 4 * dt;
        if (d.x < this.level.cannonX - 40) d.dead = true;
      } else {
        d.vy -= 9.81 * dt; d.y += d.vy * dt; d.mesh.rotation.z += dt * 5;
        let hit = d.y < this.groundY(d.x);
        if (!hit) this.world.intersectionsWithPoint({ x: d.x, y: d.y }, (c) => { if (this.owners.get(c.handle)?.t === 'block') hit = true; return !hit; });
        if (hit) { d.dead = true; this.burst(d.x, d.y, 0.4); }
      }
      // its cameras see into walled-up rooms below and around it (src/rooms.ts)
      if (d.state === 'out' || d.state === 'hover') this.garrison.rooms.scan(d.x, d.y, d.state === 'hover' ? 16 : 9);
      d.mesh.position.set(d.x, d.y + Math.sin(this.time * 9) * 0.05, 14);
      if (d.dead) dropObject(d.mesh);
    }
    this.drones = this.drones.filter((d) => !d.dead);
  }

  reveal() {
    if (this.revealed) { this.toast('Drone overflight: structure re-scanned.', 'info'); }
    this.revealed = true;
    for (const b of this.blocks) {
      if (b.dead) continue;
      const m = MATERIALS[b.matId];
      b.uni.uKind.value = m.kind;
      (b.uni.uColor.value as THREE.Color).setRGB(...m.color);
      if (b.def.disguise) b.flash = 1;
    }
    // load analysis: which blocks carry the most weight relative to their strength
    const live = this.blocks.filter((b) => !b.dead);
    const info = live.map((b) => {
      const t = b.body.translation();
      return { b, x0: t.x - b.w / 2, x1: t.x + b.w / 2, y0: t.y - b.h / 2, y1: t.y + b.h / 2, mass: b.body.mass(), load: 0 };
    }).sort((a, c) => c.y0 - a.y0);
    for (const i of info) {
      i.load += i.mass;
      const below = info.filter((j) => j !== i && Math.abs(j.y1 - i.y0) < 0.12 && j.x1 > i.x0 + 0.05 && j.x0 < i.x1 - 0.05);
      const tot = below.reduce((s, j) => s + (Math.min(i.x1, j.x1) - Math.max(i.x0, j.x0)), 0);
      for (const j of below) j.load += (i.load * (Math.min(i.x1, j.x1) - Math.max(i.x0, j.x0))) / tot;
    }
    const scored = info.filter((i) => !i.b.target).map((i) => ({ b: i.b, s: (i.load - i.mass) / (i.b.hp * i.b.mat.blast + 1) }))
      .filter((i) => i.s > 0).sort((a, c) => c.s - a.s);
    for (const b of this.blocks) b.highlight = 0;
    for (const s of scored.slice(0, Math.max(3, Math.round(scored.length * 0.12)))) s.b.highlight = 1;
    const disg = this.blocks.filter((b) => b.def.disguise && !b.dead).length;
    this.toast(disg ? `Drone intel: ${disg} disguised armor block(s) exposed. Load-bearing members marked.` : 'Drone intel: load-bearing members marked.', 'good');
  }

  updateSaboteurs(dt: number) {
    for (const s of this.saboteurs) {
      if (s.dead) continue;
      s.phase += dt * 12;
      if (s.state === 'run') {
        s.x += 5 * dt;
        s.y = this.groundY(s.x);
        if (s.exposed > 1.0) { this.killSaboteur(s, 'Saboteur was gunned down.'); continue; }
        const hit = this.world.castRay(new RAPIER.Ray({ x: s.x, y: s.y + 0.4 }, { x: 1, y: 0 }), 0.7, true, undefined, undefined, undefined, undefined,
          (c) => this.owners.get(c.handle)?.t === 'block'); // civilian houses stand behind the line: run past them
        let atTarget: { t: 'block'; b: Block } | null = null;
        if (!hit && s.target !== null && s.x >= s.target) {
          this.world.intersectionsWithPoint({ x: s.x + 0.3, y: s.y + 0.4 }, (c) => {
            const o = this.owners.get(c.handle);
            if (o?.t === 'block') { atTarget = o; return false; }
            return true;
          });
        }
        if (hit || (s.target !== null && s.x >= s.target)) {
          const o = hit ? this.owners.get(hit.collider.handle) : atTarget;
          const a = AMMO_BY_ID.saboteur;
          const p = this.spawnProjectile(a, s.x + (hit ? hit.timeOfImpact : 0.3), s.y + 0.4, 0, 0, false);
          p.fuse = a.fuse ?? 3; p.impacted = true; p.dmgMul = this.stats.sabCharge;
          if (o?.t === 'block') {
            const b = o.b; const bt = b.body.translation(), br = b.body.rotation();
            const dx = p.x - bt.x, dy = p.y - bt.y, c = Math.cos(-br), sn = Math.sin(-br);
            p.stuck = { block: b, lx: dx * c - dy * sn, ly: dx * sn + dy * c, rot: 0 };
          } else p.stuck = { lx: p.x, ly: p.y, rot: 0 };
          s.state = 'back'; s.dir = -1;
          this.toast('Charge planted!', 'good');
        }
        if (s.state === 'run' && s.x > this.level.cannonX + 200) { s.dead = true; dropObject(s.mesh); }
      } else {
        s.x -= 5.5 * dt;
        s.y = this.groundY(s.x);
        if (s.x < this.level.cannonX - 5) { s.dead = true; dropObject(s.mesh); }
      }
      s.mesh.scale.x = s.dir;
      s.mesh.position.set(s.x, s.y + 0.62 + Math.abs(Math.sin(s.phase)) * 0.08, 7.5);
    }
    this.saboteurs = this.saboteurs.filter((s) => !s.dead);
  }

  // ───────────────────────── Enemy AI ─────────────────────────
  /**
   * Counter-battery firing solution from gun block `g` onto ground point `tx`. Simulates the shell
   * exactly as the physics will fly it (gravity and wind, 60 Hz), tries elevations from flat to
   * steep and returns the flattest one whose path clears the fortress's own walls, or null if masked.
   */
  solveCounterBattery(g: Block, tx: number) {
    const t = g.body.translation();
    const dir = tx < t.x ? -1 : 1;
    const sx = t.x + dir * 1.2, sy = t.y + g.h / 2 + 0.7;
    const wind = this.wind * AMMO_BY_ID.he.wind * 0.35;
    const fly = (vx: number, vy: number, path?: V2[]) => {
      let x = sx, y = sy, n = 0;
      path?.push({ x, y });
      while (n++ < 1200) {
        vx += wind * DT; vy += PHYS.gravity * DT;
        x += vx * DT; y += vy * DT;
        path?.push({ x, y });
        if (vy < 0 && y <= this.groundY(x)) break;
      }
      return { x, n };
    };
    for (const elev of [0.75, 0.95, 1.15, 1.32]) {
      const cx = Math.cos(elev) * dir, cy = Math.sin(elev);
      let lo = 4, hi = 90;
      for (let i = 0; i < 22; i++) {
        const v = (lo + hi) / 2;
        const x = fly(cx * v, cy * v).x;
        if ((x - tx) * dir < 0) lo = v; else hi = v;
      }
      const v = (lo + hi) / 2;
      const path: V2[] = [];
      const r = fly(cx * v, cy * v, path);
      if (Math.abs(r.x - tx) > 1.5) continue;
      // casemate guns fire through an embrasure: the shell is released where the path leaves the
      // gun's own housing (the first point beyond EMB m that is not inside a block)
      const EMB = 5;
      const isBlock = (q: V2) => {
        let inside = false;
        this.world.intersectionsWithPoint(q, (c) => { const o = this.owners.get(c.handle); if (o?.t === 'block' && !o.b.dead) inside = true; return !inside; });
        return inside;
      };
      let i0 = 0;
      if (isBlock(path[0]) || this.pathBlocked(path, 0, Math.min(path.length - 1, 30), g, tx)) {
        i0 = path.findIndex((q) => Math.hypot(q.x - t.x, q.y - t.y) > EMB && !isBlock(q));
        if (i0 < 1) continue;
      }
      if (!this.pathBlocked(path, i0, path.length - 1, g, tx)) {
        const st = path[i0];
        // velocity after i0 integration steps, so the physics picks the path up exactly
        return { sx: st.x, sy: st.y, vx: cx * v + wind * DT * i0, vy: cy * v + PHYS.gravity * DT * i0, elev, flight: (r.n - i0) * DT, mx: sx, my: sy, aim: Math.atan2(cy, cx) };
      }
    }
    return null;
  }

  /** does the polyline path[i0..i1] run into a block (other than gun g) or a house, before nearing x = tx? */
  pathBlocked(path: V2[], i0: number, i1: number, g: Block, tx: number) {
    for (let i = i0 + 1; i <= i1; i++) {
      const a = path[i - 1], b = path[i];
      if (Math.abs(a.x - tx) < 4) break;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const hit = this.world.castRay(new RAPIER.Ray(a, { x: dx / len, y: dy / len }), len, true, undefined, undefined, undefined, undefined, (c) => {
        const o = this.owners.get(c.handle);
        return (o?.t === 'block' && o.b !== g && !o.b.dead) || o?.t === 'house';
      });
      if (hit) return true;
    }
    return false;
  }

  updateEnemy(dt: number) {
    // counter-battery fire with bracketing
    const guns = this.liveTargets('artillery');
    if (guns.length) {
      for (const g of guns) {
        const gun = this.enemyGuns.get(g);
        if (gun) {
          const t = g.body.translation();
          const ang = this.gunElev.get(g) ?? 0.75;
          gun.position.set(t.x - 0.2, t.y + g.h / 2 + 0.15, 3.9);
          gun.rotation.z = -ang + g.body.rotation();
        }
      }
      if (!this.dev.freeze) this.artT -= dt;
      if (this.artT <= 0) {
        if (this.enemyBlind > 0) {
          // smoke hides the fall of shot: once it clears the gunners have to re-bracket
          this.artT = 1; this.bracket = Math.min(this.bracket, 2);
        } else {
          // bracketing: each shot lands closer (the layers correct for wind from the fall of shot);
          // once bracketed, shots still scatter 1-3 m around the gun
          const errs = [11, 6.5, 3.5];
          const err = (this.bracket < errs.length ? errs[this.bracket] : 1 + Math.random() * 2) * (Math.random() < 0.5 ? -1 : 1);
          const tx = this.level.cannonX + err;
          // guns whose line of fire is masked by their own walls hold fire; try the others
          let shot: ReturnType<Game['solveCounterBattery']> = null;
          let g = guns[0];
          for (let k = 0; k < guns.length && !shot; k++) {
            g = guns[(this.artilleryShots + k) % guns.length];
            shot = this.solveCounterBattery(g, tx);
          }
          if (!shot) { this.artT = 2; } else {
            this.artT = 11;
            this.artilleryShots++; this.bracket++;
            this.gunElev.set(g, shot.elev);
            this.spawnProjectile(AMMO_BY_ID.he, shot.sx, shot.sy, shot.vx, shot.vy, true);
            // mark where it will land (same wind-aware flight model the gunners solved with)
            const imp = this.predictImpact(shot.sx, shot.sy, shot.vx, shot.vy, AMMO_BY_ID.he.wind);
            const mk = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 28), new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.9, depthTest: false }));
            mk.position.set(imp.x, imp.y + 0.15, 12);
            mk.scale.y = 0.35;
            this.root.add(mk);
            this.incoming.push({ x: imp.x, t: shot.flight, mesh: mk });
            this.muzzleBlast(shot.mx, shot.my, shot.aim, 0.8);
            audio.play('enemyGun', shot.mx);
            audio.play('whistle', tx, 1, 1, Math.max(0, shot.flight * 1000 - 1300));
            this.toast(this.artilleryShots === 1 ? 'Enemy gun is ranging on you!' : 'Incoming!', 'bad');
          }
        }
      }
    }
    // reinforcements
    const bar = this.liveTargets('barracks');
    if (bar.length) {
      if (!this.dev.freeze) this.barT -= dt;
      if (this.barT <= 0) {
        this.barT = 16;
        // at most 9 infantry in the field, however many barracks there are
        let room = 9 - this.soldiers.filter((s) => !s.dead && !s.eng).length;
        if (room > 0) {
          const x0 = this.fortressBounds.x0 - 1;
          for (const b of bar) {
            const t = b.body.translation();
            for (let i = 0; i < 2 && room > 0; i++, room--) this.spawnSoldier(Math.min(t.x, x0) - i * (1.8 + Math.random() * 1.6), Math.random() < this.shieldChance);
          }
          const shields = this.soldiers.some((s) => !s.dead && s.shield > 0);
          this.toast(shields && !this.shieldsSeen ? 'Shield infantry advancing! Shields stop canister: burst shells over them or drop HE among them.' : 'Enemy infantry advancing!', 'bad');
          if (shields) this.shieldsSeen = true;
        }
      }
    }
    // engineers: a crew of men from the workshop, one cracked block at a time from the bottom up, from a
    // scaffold they put up beside it; the block mends only while they are at work on it (src/engineers.ts)
    this.updateEngineers(dt);
  }

  /** the block the engineers are mending (null when none) */
  repairing: Block | null = null;
  updateEngineers(dt: number) {
    this.crew.update(dt, this.liveTargets('workshop').length > 0 && !this.dev.freeze && this.repT < 900);
  }
  repairToast = false;

  /** later operations field shield infantry: from difficulty 4, a growing share of each draft */
  get shieldChance() { const d = this.level.difficulty ?? 0; return d >= 4 ? Math.min(0.55, 0.25 + (d - 4) * 0.08) : 0; }
  shieldsSeen = false;

  checkEnd(dt: number) {
    if (!this.running || this.ended) return;
    const obj = this.level.objectives;
    const done = obj.every((k) => (this.targetsDestroyed[k] ?? 0) >= (this.targetsTotal[k] ?? 0));
    if (done) {
      // objectives are down: shells already in the air can no longer turn this into a defeat
      if (this.winT < 0) this.winT = 1.8;
      this.winT -= dt;
      if (this.winT <= 0) this.end(true, 'All objectives destroyed.');
      return;
    }
    const ammoLeft = Object.values(this.inventory).reduce((s, n) => s + (n ?? 0), 0);
    // anything still in motion that can yet bring an objective down: your ordnance and teams, chain
    // explosions, fires and cook-offs, collapsing masonry, and shot-down aircraft about to crash
    const active = this.projectiles.some((p) => !p.enemy) || this.planes.length || this.saboteurs.length || this.drones.length || this.pending.length || this.embers.length || this.air.falling ||
      this.blocks.some((b) => !b.dead && (b.burning > 0 || b.cookoff > 0 || (!b.body.isSleeping() && Math.hypot(b.body.linvel().x, b.body.linvel().y) > 0.3)));
    if (ammoLeft === 0 && !active) {
      this.idleT += dt;
      if (this.idleT > 3) this.end(false, 'Out of ammunition.');
    } else this.idleT = 0;
  }

  end(win: boolean, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.events.push({ type: 'end', win, reason });
  }

  score() {
    const opt = (Object.keys(this.targetsDestroyed) as TargetKind[]).filter((k) => !this.level.objectives.includes(k)).reduce((s, k) => s + (this.targetsDestroyed[k] ?? 0), 0);
    const unused = (Object.keys(this.inventory) as AmmoId[]).reduce((s, k) => s + (this.inventory[k] ?? 0) * AMMO_BY_ID[k].price, 0);
    const parts = {
      base: 3000,
      time: Math.max(0, Math.round((this.level.parTime - this.battleTime) * 60)),
      budget: Math.round((this.moneyLeft + unused * 0.5) * 3),
      optional: opt * 400,
      garrison: this.garrison.casualties * 25,
      // gun condition: 1000 for an undamaged gun whatever its armour research
      cannon: Math.round((this.cannonHp / Math.max(1, this.stats.cannonHp)) * 1000),
      collateral: -Math.round(this.collateral) || 0,
    };
    const total = Math.max(0, Object.values(parts).reduce((a, b) => a + b, 0));
    const stars = this.level.stars.filter((s) => total >= s).length;
    return { parts, total, stars };
  }

  // ───────────────────────── Camera & view ─────────────────────────
  private frameTop = 0;
  private frameKey: LevelDef | null = null;
  private groundFrac = 0.2;
  private hudPoll = 0;
  private hudShown = false;
  /** share of the view below the ground line: lifted so the fire-control plate (bottom left) never hides the gun */
  private viewGroundFrac(force: boolean) {
    const hud = document.getElementById('hud'), fcp = document.getElementById('fcp');
    const shown = !!hud && !hud.classList.contains('hidden');
    // the plate's size is read (a layout query) only every 20 frames, or at once when the HUD appears or hides
    if (!force && shown === this.hudShown && --this.hudPoll > 0) return this.groundFrac;
    this.hudShown = shown;
    this.hudPoll = 20;
    let f = 0.2;
    if (shown && fcp) {
      const rc = fcp.getBoundingClientRect();
      if (rc.height > 0 && rc.left < this.r.width * 0.25) f = Math.min(0.4, Math.max(0.2, (this.r.height - rc.top + 6) / this.r.height));
      // the plate is filled in on the HUD's first frame: measure again next frame rather than 20 frames on with the gun hidden
      if (rc.height < 120) this.hudPoll = 1;
    }
    this.groundFrac = f;
    return f;
  }

  frameCamera(snap = false, dt = 0.016) {
    const r = this.r;
    const gl = this.viewGroundFrac(snap);
    const fb = this.fortressBounds;
    const x0 = this.level.cannonX - 5;
    // big castles: the overview covers the gun and the near works; pan, zoom or use the minimap for the rest
    const x1 = Math.min(x0 + 115, Math.max(fb.x1 + 4, ...this.level.houses.filter((h) => h.x < fb.x1 + 10).map((h) => h.x + h.w + 1)));
    const aspect = r.width / r.height;
    const ground = Math.min(this.groundY(this.level.cannonX), this.groundY(fb.x0));
    let viewH = Math.max(16, (x1 - x0) / aspect, Math.min(40, (fb.y1 - this.groundY(fb.x0)) * 1.7));
    // lifting the ground line must not crop what is in frame: the tallest work in the overview keeps a
    // top-HUD-sized margin, up to the headroom the unlifted framing gave (0.8 of the view)
    if (snap || this.frameKey !== this.level) {
      this.frameKey = this.level;
      this.frameTop = -Infinity;
      for (const b of this.level.blocks) if (b.x + b.w / 2 < x1) this.frameTop = Math.max(this.frameTop, b.y + b.h);
    }
    const head = Math.min(this.frameTop - ground + viewH * 0.18, viewH * 0.8);
    viewH = Math.max(viewH, head / (1 - gl)) / this.zoom;
    this.baseCx = (x0 + x1) / 2;
    // panning (drag or minimap) stops with the view centre between the gun and the far end of the works
    this.pan = Math.max(x0 - this.baseCx, Math.min(Math.max(x1, fb.x1 + 8) - this.baseCx, this.pan));
    let cx = this.baseCx + this.pan;
    // keep the whole battlefield in view, expanding to include whatever is in flight
    if (this.focus) {
      const fx = this.focus.x, fy = this.focus.y;
      const bx0 = Math.min(cx - (viewH * aspect) / 2, fx - 6), bx1 = Math.max(cx + (viewH * aspect) / 2, fx + 6);
      // the view top sits (1 - gl) of the view above the ground line; a high lob must stay under it
      const top = Math.max(ground + viewH * (1 - gl), fy + 5);
      viewH = Math.max((bx1 - bx0) / aspect, (top - ground) / (1 - gl));
      cx = (bx0 + bx1) / 2;
    }
    const cy = ground + viewH * (0.5 - gl) + this.panY;
    const k = snap ? 1 : 1 - Math.exp(-dt * 3);
    r.viewH += (viewH - r.viewH) * k;
    r.cx += (cx - r.cx) * k;
    r.cy += (cy - r.cy) * k;
  }

  syncMeshes() {
    for (const b of this.blocks) {
      if (b.dead) continue;
      // most of a castle is asleep: only re-pose (and rebuild the matrix of) blocks that move
      const mesh = b.mesh;
      const awake = !b.body.isSleeping();
      if (mesh.matrixAutoUpdate || awake || mesh.userData.awake) {
        mesh.userData.awake = awake;
        const t = b.body.translation();
        mesh.position.set(t.x, t.y, 4);
        mesh.rotation.z = b.body.rotation();
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
      }
      b.flash = Math.max(0, b.flash - 0.08);
      b.uni.uFlash.value = b.flash * 0.6;
      b.uni.uDamage.value = Math.max(0, 1 - b.hp / b.maxHp);
      b.uni.uBurn.value = b.burnAmt;
      // live fire under the char: glowing cracks while alight, fading to cold char once out
      const ua = b.uni.uAlight;
      if (ua) ua.value += ((b.burning > 0 ? Math.min(1, 0.4 + b.burning / 3) * Math.min(1, 0.3 + b.fireT / 3) : 0) - ua.value) * 0.05;
      b.uni.uTime.value = this.time;
      b.uni.uHighlight.value = b.highlight;
      if (b.rebuilt < 1) { b.rebuilt = Math.min(1, b.rebuilt + 0.02); b.uni.uFade.value = b.rebuilt; }
    }
    for (const p of this.projectiles) if (!p.dead) p.mesh.position.set(p.x, p.y, 10);
    for (const [b, m] of this.mastSprites) { const t = b.body.translation(); m.position.set(t.x, t.y + b.h * 0.03, 4.2); m.rotation.z = b.body.rotation(); }
    this.barrel.rotation.z = this.angle;
  }

  private tmpM = new THREE.Matrix4();
  /** trajectory preview: only the first stretch, so reading wind & drop remains a skill */
  updatePreview(show: boolean) {
    const a = AMMO_BY_ID[this.selected];
    const m = this.tmpM;
    const ok = show && a.mode !== 'drone' && a.mode !== 'saboteur' && a.mode !== 'airstrike';
    this.previewDots.visible = ok;
    if (!ok) return;
    const s = this.launchSpeed;
    let { x, y } = this.muzzle;
    let vx = Math.cos(this.angle) * s, vy = Math.sin(this.angle) * s;
    let n = Math.min(60, this.stats.previewSteps);
    for (let i = 0; i < 60; i++) {
      if (i < n) {
        for (let k = 0; k < 4; k++) {
          vy += PHYS.gravity * DT; vx += this.wind * a.wind * 0.35 * DT;
          x += vx * DT; y += vy * DT;
        }
        // the arc ends where it meets the ground instead of tunnelling on under the terrain
        if (y < this.groundY(x)) { n = i; m.makeScale(0, 0, 0); this.previewDots.setMatrixAt(i, m); continue; }
        const sc = 1 - (i / n) * 0.7;
        m.makeScale(sc, sc, 1); m.setPosition(x, y, 0);
      } else m.makeScale(0, 0, 0);
      this.previewDots.setMatrixAt(i, m);
    }
    this.previewDots.instanceMatrix.needsUpdate = true;
  }

  /** bomb-run preview: flight path, release points and predicted impacts */
  updateStrikePreview(show: boolean) {
    this.strikeLine.visible = show;
    this.strikeMarks.visible = show;
    if (!show) return;
    const sol = this.planStrike();
    const last = Math.max(...sol.releases);
    // the run is a straight line: two vertices with their dash distances, updated in place every frame
    // (it used to rebuild a fresh geometry of one vertex per metre each frame)
    // level runs: carry the line on over the impacts, so the run still reads when its release end sits under the HUD
    let L = Math.floor(last + 6);
    if (Math.abs(sol.uy) < 0.05 && sol.impacts.length) {
      const far = Math.max(...sol.impacts.map((q) => (q.x - sol.sx) * Math.sign(sol.ux || 1)));
      L = Math.max(L, Math.floor(far / Math.max(0.1, Math.abs(sol.ux)) + 8));
    }
    const geo = this.strikeLine.geometry;
    let pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count !== 2) {
      pos = new THREE.BufferAttribute(new Float32Array(6), 3);
      geo.setAttribute('position', pos);
      geo.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(2), 1));
    }
    const ul = Math.hypot(sol.ux, sol.uy);
    pos.setXYZ(0, sol.sx, sol.sy, 0);
    pos.setXYZ(1, sol.sx + sol.ux * L, sol.sy + sol.uy * L, 0);
    pos.needsUpdate = true;
    const ld = geo.getAttribute('lineDistance') as THREE.BufferAttribute;
    ld.setX(1, L * ul); ld.needsUpdate = true;
    (this.strikeLine.material as THREE.LineDashedMaterial).color.set(sol.ok ? 0xffb347 : 0xff3030);
    const m = this.tmpM;
    for (let i = 0; i < 24; i++) {
      const k = i >> 1;
      if (k < sol.impacts.length) {
        const q = i % 2 === 0 ? sol.impacts[k] : sol.releasePts[k];
        const sc = i % 2 === 0 ? 1.4 : 0.7;
        m.makeScale(sc, sc, 1); m.setPosition(q.x, q.y + (i % 2 === 0 ? 0.3 : 0), 0);
      } else m.makeScale(0, 0, 0);
      this.strikeMarks.setMatrixAt(i, m);
    }
    this.strikeMarks.instanceMatrix.needsUpdate = true;
  }

  pickBlock(x: number, y: number): Block | null {
    let found: Block | null = null;
    this.world.intersectionsWithPoint({ x, y }, (c) => {
      const o = this.owners.get(c.handle);
      if (o?.t === 'block') { found = o.b; return false; }
      return true;
    });
    return found;
  }
}
