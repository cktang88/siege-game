import * as THREE from 'three';
import { AMMO_BY_ID } from './config';
import type { Block, Game } from './game';
import { makeSprite } from './render';
import { audio } from './audio';

/*
  Enemy air, after the steampunk flash game Storm Winds (Hero Interactive): waves of gyrocopters
  and armoured airships that you aim at by hand. Here they launch from mooring masts inside the
  fortress, attack your gun, and keep coming until the masts are down.
*/

type Kind = 'gyro' | 'airship';
interface Unit {
  kind: Kind;
  mesh: THREE.Mesh;
  x: number; y: number; vx: number; vy: number;
  hp: number; maxHp: number;
  rx: number; ry: number;
  cruise: number;
  dir: number;
  t: number;
  attackT: number;
  dropped: boolean;
  down: boolean;
  dead: boolean;
  phase: number;
  /** hit-flash timer (sim time, not wall clock) */
  flash: number;
  /** where this pass's bomb stick is aimed (the bomb-aimer is good, not perfect) */
  aimX: number;
}

const SPEC: Record<Kind, { hp: number; speed: number; rx: number; ry: number; h: number; alt: number }> = {
  gyro: { hp: 70, speed: 9, rx: 1.3, ry: 0.8, h: 1.9, alt: 13 },
  airship: { hp: 240, speed: 3.2, rx: 4.4, ry: 1.5, h: 3.4, alt: 21 },
};

const CAP: Record<Kind, number> = { gyro: 3, airship: 1 };

export class AirForce {
  units: Unit[] = [];
  spawnT = 14;
  wave = 0;
  kills = 0;
  /** wingmen waiting to take off, timed in simulation seconds (a wall-clock timer would outlive a level reload) */
  queued: { t: number; kind: Kind; mast: Block }[] = [];
  constructor(private g: Game) {}

  clear() { for (const u of this.units) u.mesh.parent?.remove(u.mesh); this.units = []; this.queued = []; this.spawnT = 14; this.wave = 0; this.kills = 0; }

  /** shot-down aircraft still falling: their crash can still destroy objectives */
  get falling() { return this.units.some((u) => u.down && !u.dead); }

  masts(): Block[] { return this.g.liveTargets('mast'); }

  launch(kind: Kind, from: Block) {
    const sp = SPEC[kind];
    const t = from.body.translation();
    const mesh = makeSprite(kind, sp.h, 13);
    this.g.root.add(mesh);
    const gy = this.g.groundY(t.x);
    this.units.push({
      kind, mesh, x: t.x, y: t.y + from.h / 2 + 1, vx: -sp.speed, vy: 2, hp: sp.hp, maxHp: sp.hp, rx: sp.rx, ry: sp.ry,
      cruise: gy + sp.alt + (Math.random() - 0.5) * 4, dir: -1, t: 0, attackT: 1, dropped: false, down: false, dead: false, phase: Math.random() * 6, flash: 0, aimX: 0,
    });
    this.g.toast(kind === 'airship' ? 'Enemy airship launched!' : 'Gyrocopters inbound!', 'bad');
  }

  update(dt: number, active: boolean) {
    const g = this.g;
    const masts = this.masts();
    if (active && masts.length) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        // per-type caps (wingmen still on the mast count): at most 3 gyrocopters and 1 airship up.
        // A wave whose type is at its cap is skipped, so gyros left alive can't starve out the airships.
        const up = (k: Kind) => this.units.filter((u) => !u.down && u.kind === k).length + this.queued.filter((q) => q.kind === k).length;
        const m = masts[this.wave % masts.length];
        const kinds: Kind[] = ['gyro', 'gyro', 'airship'];
        const k = kinds[this.wave % kinds.length];
        this.wave++;
        if (up(k) < CAP[k]) {
          this.spawnT = 20;
          this.launch(k, m);
          if (k === 'gyro' && up('gyro') < CAP.gyro) this.queued.push({ t: 0.9, kind: 'gyro', mast: m });
        } else this.spawnT = 4;
      }
    }
    for (const q of this.queued) {
      q.t -= dt;
      if (q.t <= 0 && active && !q.mast.dead) this.launch(q.kind, q.mast);
    }
    this.queued = this.queued.filter((q) => q.t > 0 && !q.mast.dead);
    const cx = g.level.cannonX, cy = g.groundY(cx) + 1.2;
    const fb = g.fortressBounds;
    for (const u of this.units) {
      if (u.dead) continue;
      u.t += dt;
      if (u.flash > 0) { u.flash -= dt; if (u.flash <= 0) (u.mesh.material as THREE.MeshBasicMaterial).color.setRGB(1, 1, 1); }
      const sp = SPEC[u.kind];
      if (!u.down) {
        // climb to cruise, fly at the gun, attack, overshoot, turn and come back
        u.vy += ((u.cruise - u.y) * 0.8 - u.vy) * dt;
        if (u.kind === 'gyro') u.vy += Math.sin(u.t * 2.3 + u.phase) * 2.2 * dt;
        u.vx += (u.dir * sp.speed - u.vx) * dt * 0.8;
        if (u.dir < 0 && u.x < cx - 14) { u.dir = 1; u.dropped = false; }
        if (u.dir > 0 && u.x > fb.x0 + 6) { u.dir = -1; u.dropped = false; u.aimX = cx + (Math.random() - 0.5) * 7; }
        if (!u.aimX) u.aimX = cx + (Math.random() - 0.5) * 7;
        if (active) {
          if (u.kind === 'gyro') {
            // strafing run: machine-gun bursts while closing on the gun
            const dx = u.x - cx;
            if (u.dir < 0 && dx > 2 && dx < 24) {
              u.attackT -= dt;
              if (u.attackT <= 0) {
                u.attackT = 0.22;
                g.tracer(u.x - 1, u.y - 0.3, cx + (Math.random() - 0.5) * 2, cy + (Math.random() - 0.5), 'rifle');
                g.damageCannon(0.7);
              }
            }
          } else if (!u.dropped && u.dir < 0) {
            // bomb release with lead: the bomb carries the airship's speed
            // bombs leave at 1 m/s downward from 1.6 m under the hull
            const h = Math.max(1, u.y - 1.6 - cy);
            const fall = (-1 + Math.sqrt(1 + 2 * 9.81 * h)) / 9.81;
            if (u.x + u.vx * fall <= u.aimX - 1.6) {
              u.dropped = true;
              // a stick of three, 1.6 m apart, centred on the aim point
              for (let i = 0; i < 3; i++) g.spawnProjectile(AMMO_BY_ID.bomb_he, u.x + i * 1.6, u.y - 1.6, u.vx, -1, true);
            }
          }
        }
      } else {
        // shot down: falls burning, nose over
        u.vy -= 9.81 * dt;
        u.vx *= Math.max(0, 1 - 0.6 * dt); // wreck loses way: it comes down near where it was hit
        u.mesh.rotation.z += (u.dir < 0 ? 1 : -1) * dt * 0.7;
        if (Math.random() < 0.7) g.r.smoke.spawn({ x: u.x, y: u.y, vx: -u.vx * 0.2, vy: 1, max: 2.5, size0: 1.2, size1: 3.5, c0: [0.15, 0.14, 0.14], c1: [0.4, 0.4, 0.4], a0: 0.8, a1: 0, drag: 0.5 });
        if (Math.random() < 0.6) g.r.fire.spawn({ x: u.x + (Math.random() - 0.5) * u.rx, y: u.y, max: 0.35, size0: 1.2, size1: 0.2, c0: [2.8, 1.2, 0.3], c1: [1, 0.2, 0], a0: 1, a1: 0 });
        g.r.lights.set(`air${u.phase}`, u.x, u.y, 6, [1, 0.5, 0.15], 0.8, 0.4);
        // crash into the ground or onto the castle
        let hit = u.y <= g.groundY(u.x) + 0.6;
        if (!hit) g.world.intersectionsWithPoint({ x: u.x, y: u.y - u.ry }, (c) => { if (g.owners.get(c.handle)?.t === 'block') hit = true; return !hit; });
        if (hit) {
          u.dead = true;
          g.explode(u.x, u.y, u.kind === 'airship' ? 5 : 2.8, u.kind === 'airship' ? 220 : 90, { ignite: u.kind === 'airship' ? 5 : 2, visual: u.kind === 'airship' ? 2 : 1 });
        }
      }
      u.x += u.vx * dt; u.y += u.vy * dt;
      u.mesh.position.set(u.x, u.y + (u.kind === 'airship' ? Math.sin(u.t * 0.8) * 0.15 : 0), 13);
      if (!u.down) u.mesh.scale.x = u.dir < 0 ? 1 : -1;
      if (u.kind === 'gyro' && !u.down && Math.random() < dt * 2) audio.play('drone', u.x, 0.6, 0.7);
      if (u.kind === 'airship' && !u.down && Math.random() < dt * 0.4) audio.play('plane', u.x, 0.5, 0.6);
      if (u.dead) u.mesh.parent?.remove(u.mesh);
    }
    this.units = this.units.filter((u) => !u.dead);
  }

  damage(u: Unit, dmg: number) {
    if (u.down || dmg <= 0) return;
    u.hp -= dmg;
    const m = u.mesh.material as THREE.MeshBasicMaterial;
    m.color.setRGB(2, 2, 2);
    u.flash = 0.07;
    if (u.hp <= 0) {
      u.down = true;
      this.kills++;
      this.g.burst(u.x, u.y, u.kind === 'airship' ? 1.2 : 0.6);
      audio.play(u.kind === 'airship' ? 'blastBig' : 'blast', u.x);
      this.g.toast(u.kind === 'airship' ? 'Airship going down!' : 'Gyrocopter down!', 'good');
    }
  }

  /** the aircraft under a point, if any (ellipse hit test) */
  at(x: number, y: number, pad = 0): Unit | undefined {
    return this.units.find((u) => !u.down && ((x - u.x) / (u.rx + pad)) ** 2 + ((y - u.y) / (u.ry + pad)) ** 2 <= 1);
  }

  /** explosion damage to aircraft; flak bursts are made for this */
  blast(x: number, y: number, r: number, dmg: number, flak: boolean) {
    for (const u of this.units) {
      if (u.down) continue;
      const d = Math.max(0, Math.hypot(u.x - x, u.y - y) - Math.max(u.rx, u.ry) * 0.6);
      if (d > r) continue;
      this.damage(u, dmg * (1 - d / r) * (flak ? 2.6 : 1));
    }
  }
}
