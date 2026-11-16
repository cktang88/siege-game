import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { AMMO_BY_ID, MATERIALS, PHYS, TARGETS, type AmmoDef, type AmmoId, type MatId, type MaterialDef, type TargetKind } from './config';
import type { BlockDef, HouseDef, LevelDef } from './levels';
import { Renderer, makeBlockMaterial, makeGround, makeSprite } from './render';
import { baseStats, type Stats } from './progress';
import { SoldierRig } from './soldier';

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
  burning: number;
  burnAmt: number;
  flash: number;
  lastVel: V2;
  cookoff: number;
  highlight: number;
  spreadT: number;
  rebuilt: number;
}

interface House { def: HouseDef; hp: number; maxHp: number; mesh: THREE.Mesh; collider: RAPIER.Collider; body: RAPIER.RigidBody; dead: boolean }

interface Projectile {
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
  burrow?: { dir: number; dist: number };
  dead: boolean;
  trail: number;
  inert?: number;
  path?: V2[];
  pellet?: boolean;
  blastScale: number;
  dmgMul: number;
  radMul: number;
  fuseSetting?: number;
  airburst?: number;
}

interface Soldier { x: number; y: number; rig: SoldierRig; dead: boolean; shootT: number; stopX: number; phase: number; deadT: number }

interface Plane {
  mesh: THREE.Mesh; x: number; y: number; ux: number; uy: number; speed: number; s: number;
  releases: number[]; ammo: AmmoDef; down: boolean; dead: boolean; flakT: number; exposure: number; vy: number; climbing: boolean;
}

export interface StrikePlan { x: number; dir: 1 | -1; alt: number; dive: number; spacing: number; ordnance: 'he' | 'incendiary' | 'penetrator' }
export interface StrikeSolution { sx: number; sy: number; ux: number; uy: number; speed: number; releases: number[]; impacts: V2[]; releasePts: V2[]; ok: boolean }
interface Drone { mesh: THREE.Mesh; x: number; y: number; tx: number; ty: number; state: 'out' | 'hover' | 'back' | 'down'; t: number; vy: number; dead: boolean }
interface Saboteur { mesh: THREE.Mesh; x: number; y: number; state: 'run' | 'back'; exposed: number; dead: boolean; dir: number; phase: number; target: number | null }

interface PendingBlast { x: number; y: number; r: number; dmg: number; delay: number; opts: BlastOpts }
interface BlastOpts { bonus?: Partial<Record<MatId, number>>; ignite?: number; enemy?: boolean; under?: boolean; push?: number; visual?: number; smoke?: boolean; source?: string }

export type GameEvent =
  | { type: 'toast'; text: string; tone?: 'good' | 'bad' | 'info' }
  | { type: 'target'; kind: TargetKind }
  | { type: 'end'; win: boolean; reason: string }
  | { type: 'fired' };

const DT = 1 / 60;

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
  artT = 9; barT = 12; repT = 5; rebT = 14;
  destroyedSlots: { def: BlockDef; t: number }[] = [];
  carriage!: THREE.Mesh;
  barrel!: THREE.Group;
  enemyGuns = new Map<Block, THREE.Mesh>();
  previewDots!: THREE.InstancedMesh;
  ghost!: THREE.Line;
  lastPath: V2[] = [];
  focus: V2 | null = null;
  idleT = 0;
  winT = -1;
  nextId = 1;
  zoom = 1;
  pan = 0;
  aimMarker!: THREE.Mesh;
  strikeLine!: THREE.Line;
  strikeMarks!: THREE.InstancedMesh;
  airMarker: number | null = null;
  lastCollateralToast = -10;

  constructor(r: Renderer) {
    this.r = r;
  }

  // ───────────────────────── Setup ─────────────────────────
  load(level: LevelDef) {
    this.dispose();
    this.level = level;
    this.world = new RAPIER.World({ x: 0, y: PHYS.gravity });
    this.world.numSolverIterations = 10;
    this.eq = new RAPIER.EventQueue(true);
    this.r.world.add(this.root);
    this.wind = +(level.wind[0] + Math.random() * (level.wind[1] - level.wind[0])).toFixed(1);
    this.cannonHp = 100;
    this.time = 0; this.battleTime = 0;
    this.ended = false; this.running = false; this.revealed = false;
    this.artilleryShots = 0; this.artT = 10; this.barT = 12; this.repT = 5; this.rebT = 14;
    this.collateral = 0; this.enemyBlind = 0; this.winT = -1; this.idleT = 0;
    this.targetsDestroyed = {}; this.targetsTotal = {};
    this.lastPath = [];
    this.zoom = 1; this.pan = 0;

    // ground
    this.groundPts = level.ground;
    const verts = new Float32Array(level.ground.flat());
    const gb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const gc = this.world.createCollider(RAPIER.ColliderDesc.polyline(verts).setFriction(1), gb);
    this.owners.set(gc.handle, { t: 'ground' });
    // thick ground slab so things can't tunnel
    const slab = this.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 5).setTranslation(60, -5 + Math.min(...level.ground.map((p) => p[1]))), gb);
    this.owners.set(slab.handle, { t: 'ground' });
    this.root.add(makeGround(level.ground));

    for (const d of level.blocks) this.addBlock(d);
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
    this.syncMeshes();
    this.frameCamera(true);
  }

  dispose() {
    for (const b of this.blocks) b.mesh.geometry.dispose();
    this.root.clear();
    this.r.world.remove(this.root);
    this.root = new THREE.Group();
    this.blocks = []; this.houses = []; this.projectiles = []; this.soldiers = []; this.planes = []; this.drones = []; this.saboteurs = [];
    this.pending = []; this.owners.clear(); this.destroyedSlots = []; this.enemyGuns.clear(); this.events = [];
    if (this.world) { this.world.free(); this.eq.free(); }
    this.r.smoke.parts.length = 0; this.r.fire.parts.length = 0; this.r.debris.chunks.length = 0;
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
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(d.w / 2 - 0.005, d.h / 2 - 0.005).setDensity(mat.density).setFriction(mat.friction).setRestitution(0.05),
      body,
    );
    const shown = MATERIALS[!this.revealed && d.disguise ? d.disguise : d.mat];
    const sm = makeBlockMaterial(shown.color, d.w, d.h, shown.kind);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), sm);
    mesh.position.z = 4;
    if (d.target) {
      sm.uniforms.uTarget.value = 1;
      sm.uniforms.uTargetColor.value = new THREE.Color(TARGETS[d.target].color);
    }
    this.root.add(mesh);
    const hp = mat.hp * (d.target ? 1.2 : 1) * Math.min(2, Math.sqrt(Math.max(0.3, d.w * d.h)));
    const b: Block = {
      id: this.nextId++, def: d, body, collider: col, mesh, uni: sm.uniforms, matId: d.mat, mat, hp, maxHp: hp, w: d.w, h: d.h,
      target: d.target, dead: false, burning: 0, burnAmt: 0, flash: 0, lastVel: { x: 0, y: 0 }, cookoff: -1, highlight: 0, spreadT: 0,
      rebuilt: fadeIn ? 0 : 1,
    };
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
  start(inventory: Partial<Record<AmmoId, number>>, spent: number, budget = this.level.budget) {
    this.inventory = { ...inventory };
    this.cannonHp = this.stats.cannonHp;
    this.speed = Math.min(this.speed, this.stats.maxSpeed);
    const fb = this.fortressBounds;
    this.strike.x = (fb.x0 + fb.x1) / 2;
    this.droneTarget = { x: (fb.x0 + fb.x1) / 2, y: fb.y1 + 6 };
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
        for (let i = 0; i < 10; i++) {
          const an = this.angle + (Math.random() - 0.5) * 0.14;
          const sp = s * (0.92 + Math.random() * 0.12);
          this.spawnProjectile(a, m.x, m.y, Math.cos(an) * sp, Math.sin(an) * sp, false, { pellet: true });
        }
      } else {
        const p = this.spawnProjectile(a, m.x, m.y, Math.cos(this.angle) * s, Math.sin(this.angle) * s, false);
        p.path = [{ x: m.x, y: m.y }];
        if (a.id === 'delayed') p.fuseSetting = this.fuseSetting;
        if (a.id === 'cluster' && this.airburst > 0) p.airburst = this.airburst;
      }
      this.muzzleBlast(m.x, m.y, this.angle, 1);
      this.r.shake = Math.max(this.r.shake, 0.5);
    }
    this.inventory[this.selected] = (this.inventory[this.selected] ?? 0) - 1;
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

  spawnProjectile(a: AmmoDef, x: number, y: number, vx: number, vy: number, enemy: boolean, extra: Partial<Projectile> = {}): Projectile {
    const r = extra.pellet ? 0.09 : extra.bomblet ? 0.16 : a.radius;
    const g = new THREE.Group();
    const outline = new THREE.Mesh(new THREE.CircleGeometry(r * 1.25, 18), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    const core = new THREE.Mesh(new THREE.CircleGeometry(r, 18), new THREE.MeshBasicMaterial({ color: new THREE.Color(...a.color) }));
    const hl = new THREE.Mesh(new THREE.CircleGeometry(r * 0.4, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(...a.color).multiplyScalar(1.8) }));
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
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
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
    this.root.remove(p.mesh);
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
    return { sx, sy, ux, uy, speed, releases: releases.map((r) => r - (first - back)), impacts, releasePts, ok: lowest > 4 };
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

  launchDrone() {
    const fb = this.fortressBounds;
    const tgt = this.droneTarget ?? { x: (fb.x0 + fb.x1) / 2, y: fb.y1 + 6 };
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

  damageBlock(b: Block, dmg: number, cause = '') {
    if (b.dead || b.mat.indestructible || dmg <= 0) return;
    b.hp -= dmg;
    b.flash = Math.min(1, b.flash + Math.min(0.8, dmg / 60));
    if (b.hp <= 0) this.destroyBlock(b, cause);
  }

  destroyBlock(b: Block, _cause = '') {
    if (b.dead) return;
    b.dead = true;
    const t = b.body.translation();
    const rot = b.body.rotation();
    const v = b.body.linvel();
    this.owners.delete(b.collider.handle);
    this.world.removeRigidBody(b.body);
    this.root.remove(b.mesh);
    const gun = this.enemyGuns.get(b);
    if (gun) { this.root.remove(gun); this.enemyGuns.delete(b); }
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
    if (b.target) {
      this.targetsDestroyed[b.target] = (this.targetsDestroyed[b.target] ?? 0) + 1;
      this.events.push({ type: 'target', kind: b.target });
      const remaining = (this.targetsTotal[b.target] ?? 0) - (this.targetsDestroyed[b.target] ?? 0);
      const names: Record<TargetKind, string> = {
        command: 'Command post destroyed!', ammo: 'Munitions store detonated!', barracks: 'Barracks destroyed. No more reinforcements.',
        artillery: 'Enemy gun silenced!', workshop: 'Engineers eliminated. No more repairs.', flak: 'Flak gun destroyed. Skies are clear.',
      };
      this.toast(remaining > 0 && b.target === 'ammo' ? 'Munitions detonated! One store remains.' : names[b.target], 'good');
      if (b.target === 'ammo') {
        this.pending.push({ x: t.x, y: t.y, r: 5, dmg: 200, delay: 0.05, opts: { ignite: 6, visual: 1.8, source: 'ammo' } });
      }
    } else if (!b.def.target && b.rebuilt >= 1) {
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
    // visuals
    this.burst(x, y, vis, opts.smoke);
    this.r.shake = Math.min(2.2, this.r.shake + vis * 0.7);
    if (vis > 1.2) this.r.flash = Math.min(1, this.r.flash + 0.5);
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
      const d = Math.max(0, dist - Math.min(b.w, b.h) * 0.5);
      let f = Math.max(0, 1 - d / radius);
      if (f <= 0) continue;
      // occlusion: blast spends itself on the first wall
      if (dist > 0.4) {
        const dir = { x: dx / dist, y: dy / dist };
        const hit = this.world.castRay(new RAPIER.Ray({ x, y }, dir), dist, true, undefined, undefined, undefined, undefined, (c) => {
          const o = this.owners.get(c.handle);
          return o?.t === 'block' && o.b !== b && !o.b.dead;
        });
        if (hit && hit.timeOfImpact > 0.15) f *= 0.35;
      }
      const bonus = opts.bonus?.[b.matId] ?? 1;
      this.damageBlock(b, dmg * f * b.mat.blast * bonus, opts.source);
      if (opts.ignite && b.mat.flammable && f > 0.25) this.ignite(b, opts.ignite * 2.5);
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
    // infantry
    for (const s of this.soldiers) if (!s.dead && Math.hypot(s.x - x, s.y + 0.6 - y) < radius * 1.15 + 0.3) this.killSoldier(s);
    for (const s of this.saboteurs) if (!s.dead && Math.hypot(s.x - x, s.y + 0.6 - y) < radius * 0.9) this.killSaboteur(s, 'Saboteur caught in the blast.');
    // player cannon
    const cx = this.level.cannonX, cy = this.groundY(cx) + 1;
    const cd = Math.hypot(cx - x, cy - y);
    if (cd < radius + 1.2) this.damageCannon((dmg * 0.32 * (1 - cd / (radius + 1.2)) + (opts.enemy ? 6 : 0)) * (opts.enemy && this.stats.shieldedGun ? 0.5 : 1));
  }

  burst(x: number, y: number, s: number, smokeOnly = false) {
    const nearGround = y - this.groundY(x) < 1.5;
    if (!smokeOnly) {
      this.r.fire.spawn({ x, y, max: 0.12, size0: 4 * s + 1, size1: 6 * s + 1, c0: [3, 2.6, 2], c1: [2, 1, 0.3], a0: 1, a1: 0 });
      for (let i = 0; i < 26 * s + 6; i++) {
        const a = Math.random() * Math.PI * 2, sp = (2 + Math.random() * 7) * s + 1;
        this.r.fire.spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 1, max: 0.35 + Math.random() * 0.35, size0: (0.8 + Math.random()) * s + 0.3, size1: 0.2,
          c0: [2.8, 1.5, 0.45], c1: [1.2, 0.25, 0.05], a0: 1, a1: 0, drag: 3.5, grav: 2 });
      }
      for (let i = 0; i < 18 * s + 3; i++) {
        const a = Math.random() * Math.PI * 2, sp = (8 + Math.random() * 16) * s;
        this.r.fire.spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, max: 0.4 + Math.random() * 0.4, size0: 0.18, size1: 0.08,
          c0: [3, 2.2, 1], c1: [2, 0.6, 0.1], a0: 1, a1: 0, drag: 1.5, grav: -12 });
      }
    }
    for (let i = 0; i < (smokeOnly ? 70 : 22 * s + 6); i++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * (smokeOnly ? 5 : 3.5 * s + 1);
      const g = 0.25 + Math.random() * 0.15;
      this.r.smoke.spawn({ x: x + Math.cos(a) * 0.3, y: y + Math.sin(a) * 0.3, vx: Math.cos(a) * sp + this.wind * 0.3, vy: Math.sin(a) * sp * 0.7 + 0.8,
        max: (smokeOnly ? 9 : 2.2) + Math.random() * 1.5, size0: (smokeOnly ? 2 : 1.2 * s + 0.5), size1: (smokeOnly ? 7 : 4 * s + 1.5),
        c0: smokeOnly ? [0.85, 0.85, 0.82] : [g + 0.15, g + 0.12, g + 0.1], c1: smokeOnly ? [0.75, 0.75, 0.74] : [0.55, 0.53, 0.5], a0: 0.85, a1: 0, drag: 1.8, grav: 0.4 });
    }
    if (nearGround && !smokeOnly) {
      const c = new THREE.Color(0.4, 0.31, 0.22);
      for (let i = 0; i < 10 * s + 2; i++) this.r.debris.spawn(x, this.groundY(x) + 0.1, (Math.random() - 0.5) * 10 * s, 3 + Math.random() * 8 * s, 0.1 + Math.random() * 0.2, c.clone().multiplyScalar(0.7 + Math.random() * 0.5));
    }
  }

  ignite(b: Block, secs: number) {
    if (b.dead || !b.mat.flammable) return;
    if (b.burning <= 0 && b.target === 'ammo') {
      b.cookoff = 2.5;
      this.toast('Munitions store is burning…', 'good');
    }
    b.burning = Math.max(b.burning, secs);
  }

  damageCannon(d: number) {
    if (d <= 0 || this.ended) return;
    this.cannonHp = Math.max(0, this.cannonHp - d);
    if (this.cannonHp <= 0) this.end(false, 'Your cannon was destroyed.');
  }

  killSoldier(s: Soldier) {
    if (s.dead) return;
    s.dead = true;
    s.deadT = 0;
    const c = new THREE.Color(0.35, 0.4, 0.3);
    for (let i = 0; i < 4; i++) this.r.debris.spawn(s.x, s.y + 0.6, (Math.random() - 0.5) * 4, Math.random() * 4, 0.12, c);
  }

  killSaboteur(s: Saboteur, msg: string) {
    if (s.dead) return;
    s.dead = true;
    this.root.remove(s.mesh);
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

    const kin = a.kinetic * (speed / 30) ** 2;
    if (block && !p.impacted) this.damageBlock(block, kin * block.mat.kinetic);
    if (house && !p.impacted) this.damageHouse(house, kin * 0.6);

    if (p.bomblet) {
      this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage);
      this.removeProjectile(p);
      return;
    }
    switch (a.id) {
      case 'shell':
      case 'heavy':
        if (!p.impacted) this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage, { push: a.id === 'heavy' ? 1.6 : 1 });
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
          if (block) {
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
        if (ground && !p.impacted) {
          p.impacted = true;
          p.burrow = { dir: Math.sign(v.x) || 1, dist: 0 };
          this.owners.delete(p.collider!.handle);
          this.world.removeRigidBody(p.body);
          p.body = undefined;
          p.x = t.x; p.y = this.groundY(t.x) - 0.9;
          this.burst(t.x, this.groundY(t.x), 0.4, false);
          this.toast('Drill is burrowing…', 'info');
        } else if (!ground) {
          this.explode(t.x, t.y, 2.2, 70);
          this.removeProjectile(p);
        }
        break;
      default:
        this.boom(p, t.x, t.y, a.blastRadius, a.blastDamage);
        this.removeProjectile(p);
    }
  }

  reactiveDetonate(b: Block, x: number, y: number) {
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
    p.vy += PHYS.gravity * dt;
    p.vx += this.wind * a.wind * 0.35 * dt;
    let remaining = Math.hypot(p.vx, p.vy) * dt;
    const exclude = new Set<number>();
    let guard = 0;
    while (remaining > 1e-4 && guard++ < 12 && !p.dead) {
      const sp = Math.hypot(p.vx, p.vy);
      const dir = { x: p.vx / sp, y: p.vy / sp };
      const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y }, dir), remaining, true, undefined, undefined, undefined, undefined, (c) => {
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
        if (o?.t === 'block') this.damageBlock(o.b, a.kinetic * o.b.mat.kinetic);
        if (o?.t === 'house') this.damageHouse(o.h, 3);
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
        const eff = b.hp / b.mat.pierce;
        b.body.applyImpulse({ x: dir.x * 4, y: dir.y * 4 }, true);
        this.sparks(p.x, p.y, 8);
        if (p.pen >= eff && !b.mat.indestructible) {
          p.pen -= eff;
          this.destroyBlock(b, 'ap');
          exclude.add(hit.collider.handle);
          p.vx *= 0.88; p.vy *= 0.88;
          p.x += dir.x * 0.01; p.y += dir.y * 0.01;
          continue;
        }
        this.damageBlock(b, p.pen * b.mat.pierce);
        if (b.matId === 'steel' && a.id === 'ap') this.toast('Armor plate stopped the AP round.', 'info');
        this.penetratorStop(p, dir, b);
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
    if (p.pellet || a.id === 'ap') {
      for (const s of this.soldiers) if (!s.dead && Math.abs(s.x - p.x) < 0.5 && p.y > s.y && p.y < s.y + 1.4) this.killSoldier(s);
    }
  }

  penetratorStop(p: Projectile, dir: V2, b?: Block) {
    const a = p.ammo;
    if (a.fuse) {
      // bunker buster: embed and arm
      p.impacted = true;
      p.fuse = a.fuse;
      p.vx = 0; p.vy = 0;
      if (b) {
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
    this.reload = Math.max(0, this.reload - dt);
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
    this.updateProjectiles(dt);
    this.updatePending(dt);
    this.updateSoldiers(dt);
    this.updateAir(dt);
    this.updateSaboteurs(dt);
    if (this.running && !this.ended) this.updateEnemy(dt);
    this.checkEnd(dt);
    this.syncMeshes();
  }

  updateBlocks(dt: number) {
    const settle = this.running;
    for (const b of this.blocks) {
      if (b.dead) continue;
      const v = b.body.linvel();
      if (settle && !b.body.isSleeping()) {
        const dv = Math.hypot(v.x - b.lastVel.x, v.y - b.lastVel.y);
        if (dv > 4.5) this.damageBlock(b, Math.pow(dv - 4.5, 1.5) * 3 * b.mat.kinetic, 'impact');
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
        b.burning -= dt;
        b.burnAmt = Math.min(1, b.burnAmt + dt * 0.25);
        this.damageBlock(b, b.mat.fire * 9 * dt, 'fire');
        if (b.dead) continue;
        if (Math.random() < dt * 30 * Math.min(1.5, b.w * b.h)) {
          const lx = (Math.random() - 0.5) * b.w, ly = (Math.random() - 0.3) * b.h;
          this.r.fire.spawn({ x: t.x + lx, y: t.y + ly, vx: this.wind * 0.3, vy: 1.5 + Math.random() * 2, max: 0.6 + Math.random() * 0.5, size0: 0.7 + Math.random() * 0.5, size1: 0.1,
            c0: [2.6, 1.1, 0.25], c1: [1.4, 0.2, 0.02], a0: 0.95, a1: 0, drag: 1 });
          if (Math.random() < 0.3) this.r.smoke.spawn({ x: t.x + lx, y: t.y + b.h / 2, vx: this.wind * 0.6, vy: 1.6, max: 3, size0: 0.8, size1: 3, c0: [0.25, 0.23, 0.22], c1: [0.45, 0.44, 0.43], a0: 0.6, a1: 0, drag: 0.4 });
        }
        b.spreadT -= dt;
        if (b.spreadT <= 0) {
          b.spreadT = 0.5;
          const shape = new RAPIER.Cuboid(b.w / 2 + 0.3, b.h / 2 + 0.3);
          this.world.intersectionsWithShape(t, b.body.rotation(), shape, (c) => {
            const o = this.owners.get(c.handle);
            if (o?.t === 'block' && o.b !== b && o.b.mat.flammable && o.b.burning <= 0 && Math.random() < 0.3) this.ignite(o.b, 7 + Math.random() * 3);
            return true;
          });
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
        // is there a structure above?
        const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: this.groundY(p.x) + 0.05 }, { x: 0, y: 1 }), 1.2, true, undefined, undefined, undefined, undefined,
          (c) => this.owners.get(c.handle)?.t === 'block');
        if (hit || p.burrow.dist > this.stats.drillRange) {
          const gy = this.groundY(p.x);
          this.boom(p, p.x, gy - 0.4, p.ammo.blastRadius, p.ammo.blastDamage, { under: true, push: 1.4 });
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
          if (host && !host.dead) this.damageBlock(host, p.dmgMul * a.blastDamage * (a.id === 'bunker' || a.id === 'bomb_pen' ? 1.6 : 0.8) * host.mat.blast * (a.bonus?.[host.matId] ?? 1));
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
      if (!p.impacted || p.inert !== undefined) {
        for (const s of this.soldiers) if (!s.dead && Math.abs(s.x - p.x) < 0.6 && p.y > s.y - 0.2 && p.y < s.y + 1.5) {
          this.killSoldier(s);
          if (!p.body && !p.stuck) continue;
          if (p.ammo.blastRadius > 0 && !p.inert && !['delayed', 'sticky'].includes(p.ammo.id)) {
            this.boom(p, p.x, p.y, p.ammo.blastRadius, p.ammo.blastDamage);
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
    let guard = 0;
    for (let i = 0; i < this.pending.length && guard++ < 50; i++) {
      const e = this.pending[i];
      e.delay -= dt;
      if (e.delay <= 0) {
        this.pending.splice(i--, 1);
        this.explode(e.x, e.y, e.r, e.dmg, e.opts);
      }
    }
  }

  // ───────────────────────── Infantry ─────────────────────────
  spawnSoldier(x: number) {
    const rig = new SoldierRig(true);
    rig.group.position.z = 7.2;
    const s: Soldier = { x, y: this.groundY(x), rig, dead: false, shootT: 1 + Math.random(), stopX: this.level.cannonX + 6 + Math.random() * 4, phase: Math.random() * 6, deadT: 0 };
    rig.update(0, x, s.y, 'idle');
    this.root.add(rig.group);
    this.soldiers.push(s);
  }

  updateSoldiers(dt: number) {
    for (const s of this.soldiers) {
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
        s.x -= 1.6 * dt;
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
    this.soldiers = this.soldiers.filter((s) => { if (s.dead && s.deadT > 3.7) { this.root.remove(s.rig.group); return false; } return true; });
    void before;
  }

  tracer(x0: number, y0: number, x1: number, y1: number) {
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy);
    const sp = 60;
    this.r.fire.spawn({ x: x0, y: y0, vx: (dx / d) * sp, vy: (dy / d) * sp, max: Math.min(0.5, d / sp), size0: 0.18, size1: 0.18, c0: [3, 2.4, 1], c1: [3, 1.6, 0.6], a0: 1, a1: 0.6 });
    this.r.fire.spawn({ x: x0, y: y0, max: 0.06, size0: 0.6, size1: 0.3, c0: [3, 2.2, 1], c1: [2, 1, 0.3], a0: 1, a1: 0 });
  }

  // ───────────────────────── Air units ─────────────────────────
  liveTargets(kind: TargetKind) { return this.blocks.filter((b) => !b.dead && b.target === kind); }

  updateAir(dt: number) {
    const flak = this.liveTargets('flak');
    for (const pl of this.planes) {
      if (pl.dead) continue;
      if (!pl.down) {
        const vx = pl.ux * pl.speed, vy = pl.uy * pl.speed;
        pl.s += pl.speed * dt;
        pl.x += vx * dt; pl.y += vy * dt;
        while (pl.releases.length && pl.s >= pl.releases[0]) {
          pl.releases.shift();
          const b = this.spawnProjectile(pl.ammo, pl.x, pl.y - 0.5, vx, vy, false);
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
        if (flak.length) {
          const f = flak[0].body.translation();
          const d = Math.hypot(pl.x - f.x, pl.y - f.y);
          if (d < 48) {
            pl.flakT -= dt;
            if (pl.flakT <= 0) {
              pl.flakT = 0.15;
              const bx = pl.x + (Math.random() - 0.3) * 6, by = pl.y + (Math.random() - 0.5) * 5;
              this.burst(bx, by, 0.3, false);
              this.tracer(f.x, f.y + 0.5, bx, by);
            }
            pl.exposure += dt * (d < 30 ? 1 : 0.4);
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
      if (pl.dead) this.root.remove(pl.mesh);
    }
    this.planes = this.planes.filter((p) => !p.dead);
    if (!this.planes.length) this.airMarker = null;

    for (const d of this.drones) {
      if (d.dead) continue;
      d.t += dt;
      if (d.state === 'out') {
        const dx = d.tx - d.x, dy = d.ty - d.y, dist = Math.hypot(dx, dy);
        const sp = 18 * dt;
        if (dist < sp) { d.state = 'hover'; d.t = 0; this.reveal(); }
        else { d.x += (dx / dist) * sp; d.y += (dy / dist) * sp; }
      } else if (d.state === 'hover') {
        d.x += Math.sin(d.t * 2) * dt * 2;
        if (flak.length && d.t > (this.stats.droneStealth ? 4 : 1.5)) {
          d.state = 'down'; this.toast('Drone shot down by flak (intel already sent).', 'info');
          const f = flak[0].body.translation();
          this.tracer(f.x, f.y, d.x, d.y);
        } else if (d.t > this.stats.droneTime) d.state = 'back';
      } else if (d.state === 'back') {
        d.x -= 20 * dt; d.y += 4 * dt;
        if (d.x < this.level.cannonX - 40) d.dead = true;
      } else {
        d.vy -= 9.81 * dt; d.y += d.vy * dt; d.mesh.rotation.z += dt * 5;
        if (d.y < this.groundY(d.x)) { d.dead = true; this.burst(d.x, d.y, 0.4); }
      }
      d.mesh.position.set(d.x, d.y + Math.sin(this.time * 9) * 0.05, 14);
      if (d.dead) this.root.remove(d.mesh);
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
          (c) => { const o = this.owners.get(c.handle); return o?.t === 'block' || o?.t === 'house'; });
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
        if (s.x > this.level.cannonX + 200) s.dead = true;
      } else {
        s.x -= 5.5 * dt;
        s.y = this.groundY(s.x);
        if (s.x < this.level.cannonX - 5) { s.dead = true; this.root.remove(s.mesh); }
      }
      s.mesh.scale.x = s.dir;
      s.mesh.position.set(s.x, s.y + 0.62 + Math.abs(Math.sin(s.phase)) * 0.08, 7.5);
    }
    this.saboteurs = this.saboteurs.filter((s) => !s.dead);
  }

  // ───────────────────────── Enemy AI ─────────────────────────
  updateEnemy(dt: number) {
    // counter-battery fire with bracketing
    const guns = this.liveTargets('artillery');
    if (guns.length) {
      for (const g of guns) {
        const gun = this.enemyGuns.get(g);
        if (gun) {
          const t = g.body.translation();
          const ang = 0.75;
          gun.position.set(t.x - 0.2, t.y + g.h / 2 + 0.15, 3.9);
          gun.rotation.z = -ang + g.body.rotation();
        }
      }
      this.artT -= dt;
      if (this.artT <= 0) {
        if (this.enemyBlind > 0) { this.artT = 1; } else {
          this.artT = 8.5;
          const g = guns[this.artilleryShots % guns.length];
          const t = g.body.translation();
          const errs = [11, 6.5, 3, 1.2, 0.5];
          const err = errs[Math.min(this.artilleryShots, errs.length - 1)] * (Math.random() < 0.5 ? -1 : 1);
          this.artilleryShots++;
          const tx = this.level.cannonX + err, ty = this.groundY(tx);
          const sx = t.x - 1.2, sy = t.y + g.h / 2 + 0.7;
          const th = Math.PI - 0.75;
          const dx = tx - sx, dy = ty - sy;
          const c = Math.cos(th), s = Math.sin(th);
          const denom = 2 * c * c * (dx * Math.tan(th) - dy);
          const v = Math.sqrt(Math.max(1, (-PHYS.gravity * dx * dx) / Math.max(0.01, denom)));
          this.spawnProjectile(AMMO_BY_ID.he, sx, sy, c * v, s * v, true);
          this.muzzleBlast(sx, sy, th, 0.8);
          this.toast(this.artilleryShots === 1 ? 'Enemy gun is ranging on you!' : 'Incoming!', 'bad');
        }
      }
    }
    // reinforcements
    const bar = this.liveTargets('barracks');
    if (bar.length) {
      this.barT -= dt;
      if (this.barT <= 0) {
        this.barT = 16;
        const alive = this.soldiers.filter((s) => !s.dead).length;
        if (alive < 9) {
          for (const b of bar) {
            const t = b.body.translation();
            for (let i = 0; i < 2; i++) this.spawnSoldier(Math.min(t.x, this.fortressBounds.x0 - 1) - i * 1.2);
          }
          this.toast('Enemy infantry advancing!', 'bad');
        }
      }
    }
    // engineers
    if (this.liveTargets('workshop').length) {
      this.repT -= dt;
      if (this.repT <= 0) {
        this.repT = 5;
        const dmg = this.blocks.filter((b) => !b.dead && b.hp < b.maxHp * 0.98 && !b.mat.indestructible).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp).slice(0, 3);
        for (const b of dmg) {
          b.hp = Math.min(b.maxHp, b.hp + 40);
          if (b.burning > 0) b.burning = Math.max(0, b.burning - 3);
          const t = b.body.translation();
          for (let i = 0; i < 8; i++) this.r.fire.spawn({ x: t.x + (Math.random() - 0.5) * b.w, y: t.y + (Math.random() - 0.5) * b.h, vy: 1.5, max: 0.8, size0: 0.25, size1: 0.05, c0: [0.4, 1.6, 2.4], c1: [0.2, 0.6, 1.2], a0: 1, a1: 0 });
        }
        if (dmg.length && Math.random() < 0.35) this.toast('Enemy engineers are repairing.', 'info');
      }
      this.rebT -= dt;
      if (this.rebT <= 0) {
        this.rebT = 13;
        for (let i = 0; i < this.destroyedSlots.length; i++) {
          const s = this.destroyedSlots[i];
          if (this.battleTime - s.t < 6) continue;
          const d = s.def;
          let blocked = false;
          this.world.intersectionsWithShape({ x: d.x + d.w / 2, y: d.y + d.h / 2 }, 0, new RAPIER.Cuboid(d.w / 2 - 0.02, d.h / 2 - 0.02), () => { blocked = true; return false; });
          if (blocked) continue;
          // needs support directly below
          let supported = d.y - this.groundY(d.x + d.w / 2) < 0.1;
          if (!supported) this.world.intersectionsWithShape({ x: d.x + d.w / 2, y: d.y - 0.05 }, 0, new RAPIER.Cuboid(d.w / 2 - 0.05, 0.04), (c) => { if (this.owners.get(c.handle)?.t === 'block') supported = true; return !supported; });
          if (!supported) continue;
          this.destroyedSlots.splice(i, 1);
          const nb = this.addBlock(d, true);
          nb.hp = nb.maxHp * 0.6;
          this.toast('Enemy engineers rebuilt a wall section.', 'bad');
          break;
        }
      }
    }
  }

  checkEnd(dt: number) {
    if (!this.running || this.ended) return;
    const obj = this.level.objectives;
    const done = obj.every((k) => (this.targetsDestroyed[k] ?? 0) >= (this.targetsTotal[k] ?? 0));
    if (done) {
      if (this.winT < 0) this.winT = 1.8;
      this.winT -= dt;
      if (this.winT <= 0) this.end(true, 'All objectives destroyed.');
      return;
    }
    const ammoLeft = Object.values(this.inventory).reduce((s, n) => s + (n ?? 0), 0);
    const active = this.projectiles.some((p) => !p.enemy) || this.planes.length || this.saboteurs.length || this.drones.length || this.pending.length ||
      this.blocks.some((b) => !b.dead && (b.burning > 0 || (!b.body.isSleeping() && Math.hypot(b.body.linvel().x, b.body.linvel().y) > 0.3)));
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
      cannon: Math.round(this.cannonHp * 10),
      collateral: -Math.round(this.collateral),
    };
    const total = Math.max(0, Object.values(parts).reduce((a, b) => a + b, 0));
    const stars = this.level.stars.filter((s) => total >= s).length;
    return { parts, total, stars };
  }

  // ───────────────────────── Camera & view ─────────────────────────
  frameCamera(snap = false, dt = 0.016) {
    const r = this.r;
    const fb = this.fortressBounds;
    const x0 = this.level.cannonX - 5;
    const x1 = Math.max(fb.x1 + 4, ...this.level.houses.filter((h) => h.x < fb.x1 + 10).map((h) => h.x + h.w + 1));
    const aspect = r.width / r.height;
    let viewH = Math.max(16, (x1 - x0) / aspect, (fb.y1 - this.groundY(fb.x0)) * 2.2) / this.zoom;
    let cx = (x0 + x1) / 2 + this.pan;
    let cy = Math.min(this.groundY(this.level.cannonX), this.groundY(fb.x0)) + viewH * 0.3;
    // keep the whole battlefield in view, expanding to include whatever is in flight
    if (this.focus) {
      const fx = this.focus.x, fy = this.focus.y;
      const bx0 = Math.min(cx - (viewH * aspect) / 2, fx - 6), bx1 = Math.max(cx + (viewH * aspect) / 2, fx + 6);
      const by0 = cy - viewH * 0.3, by1 = Math.max(cy + viewH * 0.7, fy + 5);
      viewH = Math.max((bx1 - bx0) / aspect, (by1 - by0));
      cx = (bx0 + bx1) / 2;
      cy = by0 + viewH * 0.3;
    }
    const k = snap ? 1 : 1 - Math.exp(-dt * 3);
    r.viewH += (viewH - r.viewH) * k;
    r.cx += (cx - r.cx) * k;
    r.cy += (cy - r.cy) * k;
  }

  syncMeshes() {
    for (const b of this.blocks) {
      if (b.dead) continue;
      const t = b.body.translation();
      b.mesh.position.set(t.x, t.y, 4);
      b.mesh.rotation.z = b.body.rotation();
      b.flash = Math.max(0, b.flash - 0.08);
      b.uni.uFlash.value = b.flash * 0.6;
      b.uni.uDamage.value = Math.max(0, 1 - b.hp / b.maxHp);
      b.uni.uBurn.value = b.burnAmt;
      b.uni.uTime.value = this.time;
      b.uni.uHighlight.value = b.highlight;
      if (b.rebuilt < 1) { b.rebuilt = Math.min(1, b.rebuilt + 0.02); b.uni.uFade.value = b.rebuilt; }
    }
    for (const p of this.projectiles) if (!p.dead) p.mesh.position.set(p.x, p.y, 10);
    this.barrel.rotation.z = this.angle;
  }

  /** trajectory preview: only the first stretch, so reading wind & drop remains a skill */
  updatePreview(show: boolean) {
    const a = AMMO_BY_ID[this.selected];
    const m = new THREE.Matrix4();
    const ok = show && a.mode !== 'drone' && a.mode !== 'saboteur' && a.mode !== 'airstrike';
    this.previewDots.visible = ok;
    if (!ok) return;
    const s = this.launchSpeed;
    let { x, y } = this.muzzle;
    let vx = Math.cos(this.angle) * s, vy = Math.sin(this.angle) * s;
    const n = Math.min(60, this.stats.previewSteps);
    for (let i = 0; i < 60; i++) {
      if (i < n) {
        for (let k = 0; k < 4; k++) {
          vy += PHYS.gravity * DT; vx += this.wind * a.wind * 0.35 * DT;
          x += vx * DT; y += vy * DT;
        }
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
    const pts: THREE.Vector3[] = [];
    for (let sp = 0; sp <= last + 6; sp += 1) pts.push(new THREE.Vector3(sol.sx + sol.ux * sp, sol.sy + sol.uy * sp, 0));
    this.strikeLine.geometry.dispose();
    this.strikeLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.strikeLine.computeLineDistances();
    (this.strikeLine.material as THREE.LineDashedMaterial).color.set(sol.ok ? 0xffb347 : 0xff3030);
    const m = new THREE.Matrix4();
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
