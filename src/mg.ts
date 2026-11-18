import * as THREE from 'three';
import { audio } from './audio';
import { MarkType } from './decals';
import type { Game, Soldier } from './game';
import { makeSprite } from './render';

/*
  The machine-gun post: a small emplacement on the lip of the redoubt, in front of the cannon, for the
  infantry that come down into the valley to snipe at the gun. Switch to it (G or Tab, or the button on
  the fire-control panel), point and hold the mouse (or Space) to fire. The cannon keeps reloading
  meanwhile, but while you work the gun you are not laying the cannon: it costs time, not money.

  Era: modern levels mount a water-cooled Vickers-type gun on a tripod behind sandbags: 9 rounds/s, a
  100-round belt and a 5 s belt change, and a jacket that boils after ~7 s of continuous fire (it locks
  until it has cooled to 35%; heat also opens the cone). Medieval levels mount a ribauldequin, the
  14th-15th-century "organ gun" of small iron barrels on one bed, behind gabions and a mantlet: it
  ripples its 8 barrels at 6/s and then takes 6 s to reload them all; no overheating, a wider cone.

  Rounds are cheap straight-line tracers (160 or 120 m/s) stepped against the field each tick: they kill
  men in the open and engineers (Game.shotSoldier); a shield facing the gun stops them (each round costs
  it 2 of its 70 points, so sustained fire wrecks it); they spark off armoured cars and tanks, pockmark
  masonry (decal only), do a little to gyrocopters and next to nothing to airships. Men near a burst may
  drop flat for a moment (they stop firing and present a smaller target). Ammunition is free: the price
  is the time it takes, and the cannon shots you aren't firing; the budget stays about the main gun.
  The post shares the gun's hit points (it is part of the same battery: lose the gun and you lose).
*/

interface Spec { rate: number; mag: number; reload: number; heatPer: number; cool: number; spread: number; speed: number; range: number; len: number; h: number; pivot: number; sprite: string; nest: string; nestH: number; name: string; magName: string }
const SPECS: Record<'modern' | 'medieval', Spec> = {
  modern: { rate: 7, mag: 100, reload: 5, heatPer: 0.02, cool: 0.2, spread: 2.6, speed: 160, range: 75, len: 1.9, h: 0.5, pivot: 0.3, sprite: 'mg_gun', nest: 'mg_nest', nestH: 0.95, name: 'Machine gun', magName: 'Belt' },
  medieval: { rate: 6, mag: 8, reload: 6, heatPer: 0, cool: 1, spread: 3.5, speed: 120, range: 60, len: 1.9, h: 0.6, pivot: 0.42, sprite: 'rib_gun', nest: 'mg_mantlet', nestH: 1.15, name: 'Volley gun', magName: 'Barrels' },
};
/** damage per round to aircraft */
export const MG_AIR = { gyro: 1.5, airship: 0.12 };
/** shield points a round knocks off a shield facing the gun */
export const MG_SHIELD = 2;
const RECOVER = 0.35;
const MIN_DEG = -35, MAX_DEG = 70;

interface Bullet { x: number; y: number; vx: number; vy: number; left: number; bright: boolean }
/** share of rounds striking a man in the open that put him down (the rest graze him and he drops flat) */
export const MG_LETHAL = 0.35;
const MAX_BULLETS = 96;

export class MachineGun {
  /** the player has switched to the MG (mouse and Space work it) */
  active = false;
  /** the trigger is held */
  trigger = false;
  heat = 0;
  overheated = false;
  rounds = 0;
  reloadT = 0;
  angle = -0.15;
  spec: Spec = SPECS.modern;
  bullets: Bullet[] = [];
  /** rounds fired and men hit this battle (for the lab and the after-action numbers) */
  fired = 0; kills = 0;
  private shotT = 0;
  private group: THREE.Group | null = null;
  private gun: THREE.Group | null = null;
  private pin = new Map<Soldier, number>();
  private toldArmour = false;
  private steamT = 0;
  private streaks: THREE.InstancedMesh | null = null;
  private tmp = new THREE.Object3D();

  constructor(private g: Game) {}

  get x() { return this.g.level.cannonX + 3.4; }
  get pivot() { const gy = this.g.groundY(this.x); return { x: this.x - 0.15, y: gy + this.spec.nestH + 0.12 }; }
  get muzzle() { const p = this.pivot, l = this.spec.len * (1 - this.spec.pivot); return { x: p.x + Math.cos(this.angle) * l, y: p.y + Math.sin(this.angle) * l }; }
  get modern() { return this.spec === SPECS.modern; }

  /** build the emplacement for this level (Game.load; the scene root is cleared between levels) */
  build() {
    const g = this.g;
    this.spec = g.level.era === 'medieval' ? SPECS.medieval : SPECS.modern;
    this.active = false; this.trigger = false; this.heat = 0; this.overheated = false;
    this.rounds = this.spec.mag; this.reloadT = 0; this.shotT = 0; this.angle = -0.15;
    this.bullets = []; this.pin.clear(); this.fired = 0; this.kills = 0; this.toldArmour = false;
    const s = this.spec;
    const gy = g.groundY(this.x);
    this.group = new THREE.Group();
    const nest = makeSprite(s.nest, s.nestH, 7.7, 0x8a7a55);
    nest.position.set(this.x + 0.15, gy + s.nestH / 2 - 0.06, 7.7);
    // tripod (modern) or timber trestle (medieval): dark outlined legs, mostly hidden behind the nest
    const legMat = new THREE.MeshBasicMaterial({ color: s === SPECS.modern ? 0x2a2e33 : 0x5a3f25 });
    const p = this.pivot;
    for (const [dx, w] of [[-0.55, 0.07], [0.45, 0.07], [-0.1, 0.06]] as const) {
      const len = Math.hypot(dx, p.y - gy);
      const leg = new THREE.Mesh(new THREE.PlaneGeometry(w, len), legMat);
      leg.position.set(p.x + dx / 2, (p.y + gy) / 2, 7.3);
      leg.rotation.z = Math.atan2(dx, p.y - gy);
      this.group.add(leg);
    }
    this.gun = new THREE.Group();
    const gm = makeSprite(s.sprite, s.h, 0, 0x30343a);
    // the sprite's width is its length; the pivot sits a share of the way back from the muzzle
    gm.position.x = s.len * (0.5 - s.pivot);
    { const k = s.len / ((gm.geometry as THREE.PlaneGeometry).parameters.width || s.len); gm.scale.set(k, k, 1); }
    this.gun.add(gm);
    this.gun.position.set(p.x, p.y, 7.5);
    this.group.add(this.gun, nest);
    // the rounds in flight: streaks drawn where the simulated bullets are (so a tracer stops where it hits)
    this.streaks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), MAX_BULLETS);
    this.streaks.position.z = 12;
    this.streaks.frustumCulled = false;
    this.streaks.count = 0;
    this.streaks.setColorAt(0, new THREE.Color(1, 1, 1));
    this.group.add(this.streaks);
    g.root.add(this.group);
    this.pose();
  }

  /** point at a world position (mouse aim) */
  aimAt(x: number, y: number) {
    const p = this.pivot;
    const dx = x - p.x, dy = y - p.y;
    if (Math.hypot(dx, dy) < 0.5) return;
    const deg = dx >= 0 ? (Math.atan2(dy, dx) * 180) / Math.PI : dy >= 0 ? MAX_DEG : MIN_DEG;
    this.setAngleDeg(deg);
  }
  setAngleDeg(d: number) { this.angle = (Math.max(MIN_DEG, Math.min(MAX_DEG, d)) * Math.PI) / 180; this.pose(); }

  private pose() { if (this.gun) this.gun.rotation.z = this.angle; }

  /** start a belt change / reload now (the rest of the belt is kept: it is a top-up) */
  reload() {
    if (this.reloadT > 0 || this.rounds >= this.spec.mag) return;
    this.reloadT = this.g.dev.instantReload ? 0.01 : this.spec.reload;
    audio.play('mgBelt', this.x, 0.6);
  }

  /** can a round go now (gun alive, battle on, ammo up, not cooling or reloading) */
  get ready() { const g = this.g; return g.running && !g.ended && g.cannonHp > 0 && this.reloadT <= 0 && !this.overheated && this.rounds > 0; }
  get state(): string {
    if (this.reloadT > 0) return `${this.modern ? 'Changing belt' : 'Reloading barrels'} ${this.reloadT.toFixed(1)}s`;
    if (this.overheated) return 'Overheated: cooling';
    if (this.trigger && this.ready) return 'Firing';
    return 'Ready';
  }

  /** is this man pinned down by fire this tick (Game.updateSoldiers asks; he takes cover instead of moving or firing) */
  pinned(s: Soldier, dt: number) {
    const t = this.pin.get(s);
    if (t === undefined) return false;
    if (t <= dt) { this.pin.delete(s); return false; }
    this.pin.set(s, t - dt);
    return true;
  }

  update(dt: number) {
    const g = this.g, s = this.spec;
    if (!this.group) return;
    if (g.dev.instantReload && this.reloadT > 0) this.reloadT = 0;
    if (this.reloadT > 0) { this.reloadT = Math.max(0, this.reloadT - dt); if (this.reloadT === 0) this.rounds = s.mag; }
    const shooting = this.active && this.trigger && this.ready;
    if (shooting) {
      this.shotT -= dt;
      while (this.shotT <= 0 && this.ready) { this.shoot(); this.shotT += 1 / s.rate; }
      if (this.rounds <= 0) this.reload();
    } else {
      this.shotT = Math.max(0, this.shotT - dt);
      this.heat = Math.max(0, this.heat - s.cool * dt);
    }
    if (this.overheated && this.heat <= RECOVER) this.overheated = false;
    // a boiling jacket vents steam
    if (this.heat > 0.6 && this.modern) {
      this.steamT -= dt;
      if (this.steamT <= 0) {
        this.steamT = this.overheated ? 0.08 : 0.25;
        const m = this.muzzle;
        g.r.smoke.spawn({ x: (m.x + this.pivot.x) / 2, y: m.y + 0.15, vx: (Math.random() - 0.5) * 0.4, vy: 1.2, max: 1.2, size0: 0.15, size1: 0.8, c0: [0.85, 0.85, 0.85], c1: [0.9, 0.9, 0.9], a0: 0.5, a1: 0, drag: 1 });
      }
    }
    for (const p of this.pin.keys()) if (p.dead) this.pin.delete(p);
    this.stepBullets(dt);
  }

  private shoot() {
    const g = this.g, s = this.spec;
    const m = this.muzzle;
    const sd = ((s.spread + this.heat * 1.2) * Math.PI) / 180;
    const an = this.angle + (Math.random() + Math.random() + Math.random() - 1.5) * sd;
    const sp = s.speed * (0.96 + Math.random() * 0.08);
    const bright = this.fired % 3 === 0;
    const b = { x: m.x, y: m.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, left: s.range / sp, bright };
    if (this.bullets.length < MAX_BULLETS) this.bullets.push(b);
    this.rounds--;
    this.fired++;
    if (s.heatPer > 0) { this.heat = Math.min(1, this.heat + s.heatPer); if (this.heat >= 1) { this.overheated = true; g.toast('Machine gun overheated! Let it cool.', 'bad'); audio.play('mgHiss', this.x, 0.7); } }
    g.r.fire.spawn({ x: m.x, y: m.y, max: 0.05, size0: 0.35, size1: 0.2, c0: [3, 2.2, 1], c1: [2, 1, 0.3], a0: 1, a1: 0, kind: 1 });
    if (this.fired % 2 === 0) g.r.lights.add(m.x, m.y, 1.6, [1, 0.8, 0.45], 0.8, 0.05);
    // spent cases (modern) or wadding smoke (medieval)
    if (this.modern) g.r.debris.spawn(this.pivot.x, this.pivot.y, -1 - Math.random() * 1.5, 2 + Math.random() * 2, 0.04, new THREE.Color(0.75, 0.6, 0.25));
    else g.r.smoke.spawn({ x: m.x, y: m.y, vx: b.vx * 0.02, vy: 0.4, max: 1.4, size0: 0.2, size1: 1.1, c0: [0.7, 0.68, 0.64], c1: [0.8, 0.78, 0.75], a0: 0.55, a1: 0, drag: 1.2 });
    audio.play(this.modern ? 'mgShot' : 'ribShot', m.x, this.modern ? 0.55 : 0.7);
    if (this.rounds <= 0) this.reload();
  }

  private stepBullets(dt: number) {
    if (!this.bullets.length) { if (this.streaks && this.streaks.count) this.streaks.count = 0; return; }
    const live: Bullet[] = [];
    for (const b of this.bullets) {
      const t = Math.min(dt, b.left);
      if (!this.trace(b, b.x, b.y, b.x + b.vx * t, b.y + b.vy * t)) continue;
      b.x += b.vx * t; b.y += b.vy * t; b.left -= t;
      if (b.left > 1e-4) live.push(b);
    }
    this.bullets = live;
    this.drawStreaks();
  }

  /** every third round is a bright tracer, the rest faint streaks */
  private drawStreaks() {
    const m = this.streaks;
    if (!m) return;
    const c = new THREE.Color();
    let i = 0;
    for (const b of this.bullets) {
      const sp = Math.hypot(b.vx, b.vy), L = b.bright ? 1.4 : 0.9;
      this.tmp.position.set(b.x - (b.vx / sp) * L * 0.5, b.y - (b.vy / sp) * L * 0.5, 0);
      this.tmp.rotation.set(0, 0, Math.atan2(b.vy, b.vx));
      this.tmp.scale.set(L, b.bright ? 0.09 : 0.05, 1);
      this.tmp.updateMatrix();
      m.setMatrixAt(i, this.tmp.matrix);
      m.setColorAt(i, b.bright ? c.setRGB(1, 0.85, 0.45) : c.setRGB(0.55, 0.45, 0.3));
      i++;
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  /** walk one bullet's segment; false when it hit something and is spent */
  private trace(b: Bullet, x0: number, y0: number, x1: number, y1: number) {
    const g = this.g;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 1; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      // men: a prone man presents his head and shoulders only
      for (const s of g.soldiers) {
        if (s.dead || Math.abs(x - s.x) > 1.3) continue;
        const prone = this.pin.has(s);
        const top = s.y + (prone ? 0.75 : 1.4);
        if (Math.abs(x - s.x) < 0.28 && y > s.y - 0.05 && y < top) {
          const had = s.shield > 0;
          // a graze: he drops flat (a shield in the way still takes the round)
          const blocked = had && b.vx > 0 && -b.vy < b.vx * 1.2;
          if (!blocked && Math.random() > MG_LETHAL) { this.pin.set(s, 1.5 + Math.random()); return false; }
          if (g.shotSoldier(s, b.vx, b.vy, MG_SHIELD)) { this.kills++; return false; }
          // a shield took it (the shield's own sparks and clang)
          if (had) return false;
        }
        // a near miss: some men drop flat for a moment
        if (!s.eng && !prone && Math.abs(x - s.x) < 1.1 && y > s.y - 0.3 && y < s.y + 2.2 && Math.random() < 0.06) this.pin.set(s, 1 + Math.random() * 0.8);
      }
      // armour: sparks and ricochets, no damage
      for (const u of g.motor.units) {
        if (u.wreckT >= 0 || Math.abs(x - u.x) > u.len / 2 || y < u.y - 0.1 || y > u.y + u.spec.h * 0.95) continue;
        g.sparks(x, y, 2);
        if (Math.random() < 0.25) audio.play('clang', x, 0.3, 1.7);
        if (!this.toldArmour) { this.toldArmour = true; g.toast('Machine-gun fire glances off armour. Use the cannon on vehicles.', 'info'); }
        return false;
      }
      // aircraft: a little against gyrocopters, nothing much against an airship's armoured gondola
      const a = g.air.at(x, y);
      if (a) { g.air.damage(a, MG_AIR[a.kind]); g.sparks(x, y, 1); return false; }
      // the ground and the works: dust and a pockmark
      if (y < g.groundY(x)) { this.dust(x, g.groundY(x), [0.5, 0.42, 0.32]); return false; }
      if (i % 2 === 0 || i === n) {
        const blk = g.pickBlock(x, y);
        if (blk) {
          if (!blk.mat.indestructible) g.frac.addMark(blk, x, y, 0.03, MarkType.POCK);
          g.sparks(x, y, 1);
          this.dust(x, y, [0.55, 0.52, 0.48]);
          return false;
        }
      }
    }
    return true;
  }

  private dust(x: number, y: number, c: [number, number, number]) {
    if (Math.random() < 0.5) this.g.r.smoke.spawn({ x, y: y + 0.05, vx: (Math.random() - 0.5) * 0.6, vy: 0.5, max: 0.7, size0: 0.08, size1: 0.45, c0: c, c1: c, a0: 0.55, a1: 0, drag: 1.5 });
  }
}
