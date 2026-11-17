import * as THREE from 'three';
import { textures } from './render';

/*
  Cut-out soldier rig.
  The upper body (helmet, torso, arms, rifle) is segmented from the generated soldier sprite
  (rows 0..UPPER_PX of the 256-px sheet). The legs are rigged chains of thigh → shin → boot,
  drawn here as ink-outlined, cel-banded parts in the sprite's own uniform colours.
  Gait is driven by distance actually moved (after tinwar's stepGait), so feet never skate.
*/

const SHEET_H = 256;
const UPPER_PX = 124;
const H = 1.32; // soldier height in metres
const PX = H / SHEET_H;

const PANTS: [number, number, number] = [112, 130, 118];
const BOOT: [number, number, number] = [92, 90, 64];

function partCanvas(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

const rgb = (c: number[], k = 1) => `rgb(${c.map((v) => Math.round(Math.min(255, v * k))).join(',')})`;

/** a limb segment: rounded capsule, light band on the lit (left/up) side, shade band opposite, 3px ink */
function limbTex(col: [number, number, number], pad = false) {
  return partCanvas(40, 96, (g, w, h) => {
    const r = 15;
    const path = () => { g.beginPath(); g.roundRect(5, 3, w - 10, h - 6, r); };
    path(); g.fillStyle = rgb(col); g.fill();
    g.save(); path(); g.clip();
    g.fillStyle = rgb(col, 1.22); g.fillRect(5, 0, 9, h);
    g.fillStyle = rgb(col, 0.72); g.fillRect(w - 15, 0, 10, h);
    g.strokeStyle = rgb(col, 0.6); g.lineWidth = 2;
    g.beginPath(); g.moveTo(w * 0.55, 14); g.lineTo(w * 0.5, h - 18); g.stroke(); // seam
    if (pad) { g.fillStyle = rgb([70, 78, 60]); g.beginPath(); g.ellipse(w / 2 - 2, 14, 13, 12, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = rgb([70, 78, 60], 1.3); g.fillRect(10, 6, 6, 10); }
    g.restore();
    path(); g.strokeStyle = '#1c1f26'; g.lineWidth = 3.5; g.stroke();
  });
}

function bootTex() {
  return partCanvas(72, 44, (g) => {
    g.beginPath();
    g.moveTo(26, 3); g.lineTo(48, 3); g.lineTo(50, 24); g.lineTo(68, 28); g.lineTo(69, 38); g.lineTo(6, 39); g.lineTo(6, 30); g.lineTo(24, 22); g.closePath();
    g.fillStyle = rgb(BOOT); g.fill();
    g.save(); g.clip();
    g.fillStyle = rgb(BOOT, 1.25); g.fillRect(0, 0, 32, 44);
    g.fillStyle = rgb(BOOT, 0.7); g.fillRect(0, 30, 72, 14);
    g.fillStyle = '#2a2a22'; g.fillRect(0, 34, 72, 10); // sole
    g.strokeStyle = rgb(BOOT, 0.55); g.lineWidth = 2;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(28, 7 + i * 5); g.lineTo(44, 9 + i * 5); g.stroke(); } // laces
    g.restore();
    g.strokeStyle = '#1c1f26'; g.lineWidth = 3.5; g.stroke();
  });
}

/** a big shield carried in front: a painted timber pavise (medieval) or a steel ballistic shield with a viewport (modern) */
export type ShieldKind = 'pavise' | 'ballistic';
const shieldTex = new Map<ShieldKind, THREE.Texture>();
function shieldTexture(kind: ShieldKind) {
  let t = shieldTex.get(kind);
  if (t) return t;
  t = partCanvas(64, 150, (g, w, h) => {
    const path = () => {
      g.beginPath();
      if (kind === 'pavise') { g.moveTo(6, 22); g.quadraticCurveTo(w / 2, 2, w - 6, 22); g.lineTo(w - 8, h - 6); g.lineTo(8, h - 6); g.closePath(); }
      else g.roundRect(5, 4, w - 10, h - 9, 9);
    };
    const base: [number, number, number] = kind === 'pavise' ? [96, 104, 120] : [78, 84, 92];
    path(); g.fillStyle = rgb(base); g.fill();
    g.save(); path(); g.clip();
    if (kind === 'pavise') {
      // painted field: a bone chevron over slate blue, timber showing at the rim
      g.fillStyle = rgb([226, 220, 203]);
      g.beginPath(); g.moveTo(0, 70); g.lineTo(w / 2, 46); g.lineTo(w, 70); g.lineTo(w, 86); g.lineTo(w / 2, 62); g.lineTo(0, 86); g.closePath(); g.fill();
      g.strokeStyle = rgb([150, 110, 70]); g.lineWidth = 6; path(); g.stroke();
    } else {
      // dark viewport near the top, rivets down the edges
      g.fillStyle = '#20262c'; g.fillRect(16, 22, w - 32, 13);
      g.fillStyle = 'rgba(170,200,215,0.55)'; g.fillRect(19, 24, 9, 4);
      g.fillStyle = rgb(base, 0.6);
      for (let y = 50; y < h - 12; y += 22) { g.fillRect(10, y, 4, 4); g.fillRect(w - 14, y, 4, 4); }
    }
    // cel bands: lit left edge, shaded right edge
    g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(0, 0, 13, h);
    g.fillStyle = 'rgba(0,0,0,0.26)'; g.fillRect(w - 16, 0, 16, h);
    g.restore();
    path(); g.strokeStyle = '#1c1f26'; g.lineWidth = 4; g.stroke();
  });
  shieldTex.set(kind, t);
  return t;
}

let cache: { thigh: THREE.Texture; shin: THREE.Texture; boot: THREE.Texture; upper: THREE.BufferGeometry | null } | null = null;
function parts() {
  if (cache) return cache;
  cache = { thigh: limbTex(PANTS), shin: limbTex(PANTS, true), boot: bootTex(), upper: null };
  return cache;
}

/* every rig shares its part materials (a garrison is ~50 rigs x 7 parts); a rig clones its own only when it starts to fade out */
const matCache = new Map<string, THREE.MeshBasicMaterial>();
const mat = (t: THREE.Texture, shade = 1) => {
  const key = `${t.uuid}|${shade}`;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, alphaTest: 0.05, color: new THREE.Color(shade, shade, shade) }); matCache.set(key, m); }
  return m;
};
let upperMat: THREE.MeshBasicMaterial | null = null;

interface Leg { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group }

export class SoldierRig {
  group = new THREE.Group();
  body = new THREE.Group();
  upper: THREE.Mesh;
  legs: Leg[] = [];
  phase = Math.random() * 6;
  recoil = 0;
  deadT = -1;
  shield: THREE.Mesh | null = null;
  private thighL = 0.33;
  private shinL = 0.3;
  private lastX: number | null = null;
  private lastY = 0;

  constructor(enemy = true, shield?: ShieldKind) {
    const p = parts();
    const tex = textures.soldier;
    const img = tex?.image as HTMLImageElement | undefined;
    const aspect = img ? img.width / img.height : 0.62;
    const w = H * aspect, uh = UPPER_PX * PX;
    const geo = new THREE.PlaneGeometry(w, uh);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (1 - uv.getY(i)) * (UPPER_PX / SHEET_H));
    geo.translate(0, uh / 2, 0);
    upperMat ??= tex ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.05 }) : new THREE.MeshBasicMaterial({ color: 0x556655 });
    this.upper = new THREE.Mesh(geo, upperMat);
    this.upper.position.z = 0.02;
    // hips sit under the belt; the front (left-facing) leg is drawn in front, the back leg shaded behind
    const hipY = 0.02;
    const hipX = [0.04, 0.11];
    for (let i = 0; i < 2; i++) {
      const shade = i === 0 ? 1 : 0.78;
      const hip = new THREE.Group();
      hip.position.set(hipX[i], hipY, i === 0 ? 0.03 : -0.02);
      const thigh = new THREE.Mesh(new THREE.PlaneGeometry(0.17, this.thighL + 0.06), mat(p.thigh, shade));
      thigh.position.y = -this.thighL / 2;
      const knee = new THREE.Group();
      knee.position.y = -this.thighL;
      const shin = new THREE.Mesh(new THREE.PlaneGeometry(0.15, this.shinL + 0.06), mat(p.shin, shade));
      shin.position.set(0, -this.shinL / 2, 0.001);
      const ankle = new THREE.Group();
      ankle.position.y = -this.shinL;
      const boot = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.18), mat(p.boot, shade));
      boot.scale.x = -1; // toes point the way the soldier faces (left)
      boot.position.set(-0.04, -0.04, 0.002);
      ankle.add(boot);
      knee.add(shin, ankle);
      hip.add(thigh, knee);
      this.body.add(hip);
      this.legs.push({ hip, knee, ankle });
    }
    this.body.add(this.upper);
    if (shield) {
      // held out in front (the soldier faces left), from shin height to the chin
      this.shield = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.17), mat(shieldTexture(shield)));
      this.shield.position.set(-0.33, -0.05, 0.05);
      this.body.add(this.shield);
    }
    this.body.position.y = this.thighL + this.shinL + 0.09;
    this.group.add(this.body);
    if (!enemy) this.group.scale.x = -1;
  }

  /** x: world x this frame (stride comes from distance moved); facing: -1 left, 1 right */
  update(dt: number, x: number, y: number, state: 'walk' | 'idle' | 'shoot' | 'dead' | 'stand' | 'sit' | 'climb') {
    // a climber's stride comes from height gained; everyone else's from ground covered
    const moved = this.lastX === null ? 0 : state === 'climb' ? Math.abs(y - this.lastY) : Math.abs(x - this.lastX);
    this.lastX = x;
    this.lastY = y;
    if (moved > 2) this.phase += 0; // teleport, not a stride
    else this.phase += (moved / 0.55) * Math.PI;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    const [front, back] = this.legs;
    if (state === 'dead') {
      if (this.deadT < 0) this.deadT = 0;
      this.deadT += dt;
      const k = Math.min(1, this.deadT * 3);
      // knees buckle, then the body topples backwards
      front.hip.rotation.z = -0.9 * k; front.knee.rotation.z = 1.4 * k;
      back.hip.rotation.z = -0.5 * k; back.knee.rotation.z = 1.2 * k;
      this.body.rotation.z = -Math.min(1.45, Math.max(0, this.deadT * 3 - 0.4) * 1.5);
      this.body.position.y = 0.72 - 0.45 * Math.min(1, this.deadT * 2.2);
      // the shield is let go and falls flat in front of him
      if (this.shield) { this.shield.rotation.z = Math.min(1.5, this.deadT * 2.5) + this.body.rotation.z * -1; this.shield.position.x = -0.33 - Math.min(0.5, this.deadT * 0.8); }
    } else if (state === 'stand' || state === 'sit') {
      // off duty: relaxed and upright (stand), or squatting on the floor at a cot, cask or table (sit)
      const b = Math.sin(this.phase * 0.05 + performance.now() * 0.0017) * 0.008; // breathing
      const sit = state === 'sit';
      front.hip.rotation.z = sit ? -1.25 : -0.05; front.knee.rotation.z = sit ? 2.1 : 0.04; front.ankle.rotation.z = sit ? -0.85 : 0;
      back.hip.rotation.z = sit ? -0.55 : 0.06; back.knee.rotation.z = sit ? 2.35 : 0.02; back.ankle.rotation.z = sit ? -1.3 : 0;
      this.body.position.y = (sit ? 0.36 : 0.72) + b;
      this.body.rotation.z = sit ? 0.06 : -0.015;
      this.upper.position.x = 0;
    } else if (state === 'climb') {
      // hand over hand up a ladder: knees come up in turn, the body rocks a little with each rung
      const s = Math.sin(this.phase), c = Math.cos(this.phase);
      const fl = Math.max(0, s), bl = Math.max(0, -s);
      front.hip.rotation.z = -0.25 - fl * 0.9; front.knee.rotation.z = 0.3 + fl * 1.3; front.ankle.rotation.z = -fl * 0.4;
      back.hip.rotation.z = -0.25 - bl * 0.9; back.knee.rotation.z = 0.3 + bl * 1.3; back.ankle.rotation.z = -bl * 0.4;
      this.body.position.y = 0.7 + Math.abs(c) * 0.04;
      this.body.rotation.z = -0.1 + s * 0.05;
      this.upper.position.x = s * 0.025;
    } else if (state === 'walk') {
      const s = Math.sin(this.phase), c = Math.cos(this.phase);
      // thighs swing in anti-phase; the knee bends while its leg swings forward
      front.hip.rotation.z = -s * 0.5;
      back.hip.rotation.z = s * 0.5;
      front.knee.rotation.z = Math.max(0, c) * 0.9;
      back.knee.rotation.z = Math.max(0, -c) * 0.9;
      front.ankle.rotation.z = -front.hip.rotation.z * 0.5 - front.knee.rotation.z * 0.6;
      back.ankle.rotation.z = -back.hip.rotation.z * 0.5 - back.knee.rotation.z * 0.6;
      this.body.position.y = 0.72 - Math.abs(c) * 0.035;
      this.body.rotation.z = -0.04 + s * 0.015;
      this.upper.position.x = 0;
    } else {
      // braced firing stance: feet apart, slight crouch, recoil kicks the torso back
      front.hip.rotation.z = -0.28; front.knee.rotation.z = 0.35; front.ankle.rotation.z = -0.1;
      back.hip.rotation.z = 0.32; back.knee.rotation.z = 0.15; back.ankle.rotation.z = -0.4;
      this.body.position.y = 0.68;
      this.body.rotation.z = -0.02 - this.recoil * 0.12;
      this.upper.position.x = this.recoil * 0.05;
    }
    this.group.position.set(x, y, this.group.position.z);
  }

  /** a shield shot to pieces */
  dropShield() { if (this.shield) { this.body.remove(this.shield); this.shield = null; } }

  /** muzzle position in world space (rifle tip, rows ~88 of the sheet, facing left) */
  muzzle(): THREE.Vector3 {
    const v = new THREE.Vector3(-0.38, (UPPER_PX - 88) * PX, 0);
    return this.upper.localToWorld(v);
  }

  private ownMats = false;
  fade(a: number) {
    const own = !this.ownMats;
    this.ownMats = true;
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (own) mesh.material = (mesh.material as THREE.MeshBasicMaterial).clone();
      (mesh.material as THREE.MeshBasicMaterial).opacity = a;
    });
  }
}
