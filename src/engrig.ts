import * as THREE from 'three';
import { textures } from './render';
import { SoldierRig } from './soldier';

/*
  The enemy repair crew's cut-out rig. Legs and gait come from the infantry rig (src/soldier.ts); the
  upper body is a generated armless torso (public/sprites/eng_med.png: arming cap, wool tunic, leather
  apron and satchel; eng_mod.png: steel helmet, field jacket, webbing and tool pouches), and both arms
  are rigged here as ink-outlined, cel-banded segments in the sprite's sleeve colour, so they can swing a
  hammer, point mortar with a trowel, climb hand over hand and steady a load on the shoulder.
  Arm angles are radians about the shoulder in the rig's own frame (it faces left): 0 hangs straight
  down, negative swings forward, about -2.7 is overhead.
*/

export type Era = 'medieval' | 'modern';
export type Tool = 'hammer' | 'trowel';
export type ArmPose = 'swing' | 'carry' | 'climb' | 'work' | 'build' | 'idle' | 'dead';

const INK = '#1c1f26';
const rgb = (c: number[], k = 1) => `rgb(${c.map((v) => Math.round(Math.min(255, v * k))).join(',')})`;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** an arm segment: rounded capsule, lit band on the left, shade on the right, 3px ink; `hand` adds a fist at the bottom */
function armTex(col: number[], hand: boolean) {
  return canvasTex(36, 96, (g, w, h) => {
    const bottom = hand ? h - 22 : h - 4;
    const path = () => { g.beginPath(); g.roundRect(5, 3, w - 10, bottom - 3, 12); };
    path(); g.fillStyle = rgb(col); g.fill();
    g.save(); path(); g.clip();
    g.fillStyle = rgb(col, 1.22); g.fillRect(5, 0, 8, h);
    g.fillStyle = rgb(col, 0.72); g.fillRect(w - 14, 0, 9, h);
    if (hand) { g.fillStyle = rgb(col, 0.6); g.fillRect(0, bottom - 9, w, 5); } // cuff
    g.restore();
    path(); g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
    if (hand) {
      const skin = [206, 160, 124];
      g.beginPath(); g.ellipse(w / 2, h - 13, 11, 11, 0, 0, Math.PI * 2);
      g.fillStyle = rgb(skin); g.fill();
      g.save(); g.clip(); g.fillStyle = rgb(skin, 0.75); g.fillRect(w / 2 + 3, 0, w, h); g.restore();
      g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
    }
  });
}

/** tools, drawn handle-down from the fist (the fist is at the bottom centre of the canvas) */
function toolTex(kind: 'hammer' | 'maul' | 'trowel') {
  return canvasTex(48, 96, (g, w) => {
    const wood = [132, 96, 60], iron = [92, 96, 104];
    // handle
    g.fillStyle = INK; g.fillRect(w / 2 - 5, kind === 'trowel' ? 54 : 16, 10, 80);
    g.fillStyle = rgb(wood); g.fillRect(w / 2 - 3, kind === 'trowel' ? 56 : 18, 6, 76);
    g.fillStyle = rgb(wood, 1.25); g.fillRect(w / 2 - 3, kind === 'trowel' ? 56 : 18, 2, 76);
    if (kind === 'trowel') {
      // steel blade, a pointed leaf, off a cranked tang
      g.fillStyle = INK; g.fillRect(w / 2 - 2, 38, 4, 20);
      g.beginPath(); g.moveTo(w / 2 - 12, 40); g.lineTo(w / 2 + 12, 40); g.lineTo(w / 2, 4); g.closePath();
      g.fillStyle = rgb([150, 156, 162]); g.fill();
      g.fillStyle = rgb([190, 196, 202]); g.beginPath(); g.moveTo(w / 2 - 10, 39); g.lineTo(w / 2 - 2, 39); g.lineTo(w / 2, 8); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(w / 2 - 12, 40); g.lineTo(w / 2 + 12, 40); g.lineTo(w / 2, 4); g.closePath();
      g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
      return;
    }
    // head across the top of the handle: a mason's hammer (one face, one peen) or a square maul
    const hw = kind === 'maul' ? 40 : 38, hh = kind === 'maul' ? 22 : 16;
    g.beginPath();
    if (kind === 'hammer') { g.moveTo(w / 2 - hw / 2, 6); g.lineTo(w / 2 + 6, 4); g.lineTo(w / 2 + hw / 2, 9); g.lineTo(w / 2 + 6, 4 + hh); g.lineTo(w / 2 - hw / 2, 4 + hh); g.closePath(); }
    else g.rect(w / 2 - hw / 2, 3, hw, hh);
    g.fillStyle = rgb(iron); g.fill();
    g.save(); g.clip(); g.fillStyle = rgb(iron, 1.4); g.fillRect(0, 0, w, 6); g.fillStyle = rgb(iron, 0.7); g.fillRect(0, 2 + hh - 4, w, 6); g.restore();
    g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
  });
}

/** loads carried on the shoulder: a wicker mortar hod on its pole (medieval) or a paper cement sack (modern) */
function loadTex(era: Era) {
  return canvasTex(96, 64, (g, w, h) => {
    if (era === 'medieval') {
      // the pole runs down behind the shoulder; the basket sits on top
      g.fillStyle = INK; g.fillRect(14, 30, 8, h - 30);
      g.fillStyle = rgb([132, 96, 60]); g.fillRect(16, 30, 4, h - 30);
      g.beginPath(); g.moveTo(4, 12); g.lineTo(w - 6, 12); g.lineTo(w - 20, 40); g.lineTo(16, 40); g.closePath();
      g.fillStyle = rgb([168, 132, 80]); g.fill();
      g.save(); g.clip();
      g.strokeStyle = rgb([120, 88, 50]); g.lineWidth = 2;
      for (let y = 16; y < 42; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      for (let x = 8; x < w; x += 9) { g.beginPath(); g.moveTo(x, 10); g.lineTo(x - 4, 42); g.stroke(); }
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(w - 34, 0, 40, h);
      g.restore();
      // grey mortar heaped in it
      g.beginPath(); g.moveTo(8, 13); g.quadraticCurveTo(w / 2, -4, w - 10, 13); g.closePath();
      g.fillStyle = rgb([176, 170, 156]); g.fill(); g.strokeStyle = INK; g.lineWidth = 2.5; g.stroke();
      g.beginPath(); g.moveTo(4, 12); g.lineTo(w - 6, 12); g.lineTo(w - 20, 40); g.lineTo(16, 40); g.closePath();
      g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
    } else {
      g.beginPath(); g.roundRect(6, 10, w - 12, h - 22, 14);
      g.fillStyle = rgb([196, 182, 150]); g.fill();
      g.save(); g.clip();
      g.fillStyle = rgb([196, 182, 150], 1.12); g.fillRect(0, 0, w, 20);
      g.fillStyle = rgb([196, 182, 150], 0.75); g.fillRect(0, h - 26, w, 20);
      g.fillStyle = rgb([120, 60, 50], 0.9); g.fillRect(w / 2 - 14, 22, 28, 10); // stencilled band
      g.restore();
      g.beginPath(); g.roundRect(6, 10, w - 12, h - 22, 14); g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
    }
  });
}

const SLEEVE: Record<Era, number[]> = { medieval: [104, 84, 62], modern: [100, 114, 92] };
/** where the sprite's belt line and shoulder stub are, as fractions of the trimmed sprite (from its top-left) */
const SHEET: Record<Era, { name: string; h: number; belt: number; cx: number; sx: number; sy: number }> = {
  medieval: { name: 'eng_med', h: 0.95, belt: 0.65, cx: 0.43, sx: 0.76, sy: 0.35 },
  modern: { name: 'eng_mod', h: 0.74, belt: 0.84, cx: 0.5, sx: 0.73, sy: 0.5 },
};

const cache = new Map<string, THREE.Texture>();
const cached = (k: string, f: () => THREE.Texture) => { let t = cache.get(k); if (!t) { t = f(); cache.set(k, t); } return t; };
const matCache = new Map<string, THREE.MeshBasicMaterial>();
function mat(t: THREE.Texture, shade = 1) {
  const key = `${t.uuid}|${shade}`;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, alphaTest: 0.05, color: new THREE.Color(shade, shade, shade) }); m.userData.shared = true; matCache.set(key, m); }
  return m;
}

interface Arm { shoulder: THREE.Group; elbow: THREE.Group; hand: THREE.Group; tool: THREE.Mesh | null }

const UPPER = 0.25, FORE = 0.23;
const ease = (t: number) => t * t * (3 - 2 * t);

export class EngineerRig extends SoldierRig {
  arms: Arm[] = [];
  load: THREE.Mesh;
  /** hammer cycle 0..1; `struck` is true on the frame the blow lands */
  swing = Math.random();
  struck = false;
  private armK = 0;
  private sh = { x: 0, y: 0 };

  constructor(public era: Era, public tool: Tool) {
    super(true);
    // the infantry torso (with its rifle) is replaced by the engineer's armless one
    this.upper.visible = false;
    const sh = SHEET[era];
    const tex = textures[sh.name];
    const img = tex?.image as HTMLImageElement | undefined;
    const w = sh.h * (img ? img.width / img.height : 0.4);
    const geo = new THREE.PlaneGeometry(w, sh.h);
    const top = 0.02 + sh.belt * sh.h;
    const left = 0.07 - sh.cx * w;
    geo.translate(left + w / 2, top - sh.h / 2, 0);
    const torso = new THREE.Mesh(geo, tex ? mat(tex) : new THREE.MeshBasicMaterial({ color: 0x6a5a48 }));
    torso.position.z = 0.035;
    this.body.add(torso);
    this.sh = { x: left + sh.sx * w, y: top - sh.sy * sh.h };
    const sleeve = SLEEVE[era];
    const upTex = cached(`up${era}`, () => armTex(sleeve, false)), foreTex = cached(`fo${era}`, () => armTex(sleeve, true));
    for (let i = 0; i < 2; i++) {
      const near = i === 0;
      const shade = near ? 1 : 0.74;
      const shoulder = new THREE.Group();
      shoulder.position.set(this.sh.x + (near ? 0 : 0.03), this.sh.y, near ? 0.05 : -0.03);
      const upper = new THREE.Mesh(new THREE.PlaneGeometry(0.11, UPPER + 0.05), mat(upTex, shade));
      upper.position.y = -UPPER / 2;
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER;
      const fore = new THREE.Mesh(new THREE.PlaneGeometry(0.1, FORE + 0.09), mat(foreTex, shade));
      fore.position.set(0, -FORE / 2 - 0.02, 0.001);
      const hand = new THREE.Group();
      hand.position.y = -FORE - 0.02;
      let toolMesh: THREE.Mesh | null = null;
      if (near) {
        const kind = tool === 'trowel' ? 'trowel' : era === 'medieval' ? 'hammer' : 'maul';
        toolMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.4), mat(cached(`t${kind}`, () => toolTex(kind))));
        // the fist grips the handle near its end; the head is 0.36 m out along the handle
        toolMesh.geometry.translate(0, 0.17, 0);
        toolMesh.position.z = -0.002;
        hand.add(toolMesh);
      }
      elbow.add(fore, hand);
      shoulder.add(upper, elbow);
      this.body.add(shoulder);
      this.arms.push({ shoulder, elbow, hand, tool: toolMesh });
    }
    this.load = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.33), mat(cached(`l${era}`, () => loadTex(era))));
    this.load.position.set(this.sh.x - 0.02, this.sh.y + 0.12, 0.045);
    this.load.visible = false;
    this.body.add(this.load);
  }

  /** legs (from the infantry rig) then arms. `carrying` shows the load on the shoulder */
  pose(dt: number, x: number, y: number, legs: 'walk' | 'stand' | 'climb' | 'dead' | 'shoot' | 'sit', arms: ArmPose, carrying: boolean) {
    this.update(dt, x, y, legs);
    this.struck = false;
    const [near, far] = this.arms;
    const s = Math.sin(this.phase);
    let a0 = 0, e0 = 0, a1 = 0, e1 = 0, tool = -0.5;
    this.load.visible = carrying && arms !== 'dead';
    if (arms === 'dead') {
      this.armK = Math.min(1, this.armK + dt * 3);
      a0 = 0.6 * this.armK; e0 = -0.3; a1 = 0.9 * this.armK; e1 = -0.2;
    } else if (arms === 'climb') {
      // hand over hand: each arm reaches for the next rung as the opposite knee comes up
      a0 = -2.75 + s * 0.35; e0 = -0.25 - Math.max(0, -s) * 0.9;
      a1 = -2.75 - s * 0.35; e1 = -0.25 - Math.max(0, s) * 0.9;
      tool = -1.4;
    } else if (arms === 'work' && this.tool === 'hammer') {
      // wind up slowly over the shoulder, then a quick blow; the hammer rings on the stone at 0.72
      const prev = this.swing;
      this.swing = (this.swing + dt * 1.25) % 1;
      if (prev < 0.72 && (this.swing >= 0.72 || this.swing < prev)) this.struck = true;
      const h = this.swing;
      const k = h < 0.55 ? ease(h / 0.55) : h < 0.72 ? 1 - ease((h - 0.55) / 0.17) : 0;
      a0 = -1.25 - k * 1.45; e0 = -0.25 - k * 1.25; tool = -0.35 - k * 0.5;
      a1 = -0.9; e1 = -0.9; // the other hand steadies the chisel or the stone
    } else if (arms === 'work' || arms === 'build') {
      // trowelling (or lashing and setting poles): short strokes along the joint
      const prev = this.swing;
      this.swing = (this.swing + dt * (arms === 'build' ? 1.1 : 0.9)) % 1;
      if (prev < 0.5 && this.swing >= 0.5) this.struck = true;
      const c = Math.sin(this.swing * Math.PI * 2);
      a0 = (arms === 'build' ? -1.9 : -1.15) + c * 0.22; e0 = -0.55 - c * 0.35; tool = -0.9;
      a1 = (arms === 'build' ? -2.1 : -0.7) - c * 0.15; e1 = -0.8;
    } else if (arms === 'idle') {
      const b = Math.sin(performance.now() * 0.0017 + this.phase) * 0.03;
      a0 = -0.15 + b; e0 = -0.35; a1 = 0.08; e1 = -0.2;
    } else {
      // walking: arms swing against the legs
      a0 = s * 0.45 - 0.05; e0 = -0.3 - Math.max(0, s) * 0.3;
      a1 = -s * 0.45 - 0.05; e1 = -0.3 - Math.max(0, -s) * 0.3;
    }
    if (carrying && arms !== 'dead' && arms !== 'climb') {
      // the near hand steadies the load on the shoulder
      a0 = -2.35; e0 = -2.15;
    } else if (carrying && arms === 'climb') {
      a0 = -2.35; e0 = -2.15;
    }
    if (arms !== 'dead') this.armK = 0;
    near.shoulder.rotation.z = a0; near.elbow.rotation.z = e0;
    far.shoulder.rotation.z = a1; far.elbow.rotation.z = e1;
    if (near.tool) { near.tool.rotation.z = tool; near.tool.visible = !carrying; }
  }

  /** world position of the tool head (where a blow lands) */
  toolHead(out = new THREE.Vector3()) {
    const t = this.arms[0].tool;
    if (!t) return this.arms[0].hand.getWorldPosition(out);
    this.group.updateMatrixWorld(true);
    return t.localToWorld(out.set(0, 0.34, 0));
  }
}
