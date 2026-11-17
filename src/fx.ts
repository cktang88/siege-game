import * as THREE from 'three';

/*
  Fire, smoke and sparks (see docs/RESEARCH.md, "Fire & smoke VFX").

  Flames and smoke are not drawn particle by particle. Each particle writes a soft, noise-lumped blob
  into a half-resolution field (heat for flames, density + tone for smoke), additively; a full-view
  composite quad then thresholds the merged field ("2D metaballs") and shades it:
    - flames: the heat is eroded by world-space noise scrolled upward (and sheared by the wind), so the
      merged mass breaks into rising tongues, then mapped through a stepped ramp: pale core, yellow,
      orange, red, deep-red rim. Dense heat makes a core; thin heat only reaches the red bands, so a
      cooling fireball shrinks through the ramp to an ember edge and out.
    - smoke: two-tone cel shading from the density gradient (lit top-left, shadowed underneath; after
      McGuire et al., "Real-Time Cartoon Rendering of Smoke"), two opacity steps, a darker silhouette
      band, noise-eroded edges as it thins, and an orange under-glow where it sits over flames.
  So a dozen overlapping tongues read as one fire with one outline instead of a pile of discs, and the
  ramp tops out at a pale yellow that only grazes the bloom threshold: no white-out.
  Sparks, embers, flashes and shock rings stay additive, as velocity-stretched instanced quads.
  Every pool is one instanced draw; nothing allocates a material per particle.
*/

export const FX_NOISE = /* glsl */ `
float fxHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fxNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(fxHash(i), fxHash(i+vec2(1,0)), u.x), mix(fxHash(i+vec2(0,1)), fxHash(i+vec2(1,1)), u.x), u.y); }
float fxFbm(vec2 p){ float a = .5, s = 0.; for(int i=0;i<3;i++){ s += a*fxNoise(p); p = p * 2.07 + 17.3; a *= .5; } return s / 0.875; }
`;

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number;
  size0: number; size1: number;
  c0: [number, number, number]; c1: [number, number, number];
  a0: number; a1: number;
  drag: number; grav: number;
  /** vertical elongation (flame tongues ~1.6); 1 = round */
  stretch?: number;
  /** how strongly the particle is carried by the wind (0..1); pool default if unset */
  windK?: number;
  /** spark pool: 0 streak/ember, 1 soft flash disc, 2 shock ring */
  kind?: number;
  /** seconds before it appears (it still moves) */
  delay?: number;
  seed?: number;
}
type SpawnArg = Partial<Particle> & { x: number; y: number };

const quad = () => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};

/** heat (r) for flames, colour * density (rgb, a) for smoke, or HDR colour for sparks */
type PoolMode = 'heat' | 'smoke' | 'spark';

export class FxPool {
  mesh: THREE.Mesh;
  parts: Particle[] = [];
  /** wind (m/s) the pool drifts with; the renderer sets it from the level */
  wind = 0;
  private geo: THREE.InstancedBufferGeometry;
  private iPos: Float32Array; private iVel: Float32Array; private iSize: Float32Array; private iCol: Float32Array; private iT: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  private evict = 0;
  /** big "fire" puffs (muzzle blasts, burning wrecks) go to the flame field instead of stacking additively */
  overflow?: FxPool;
  /** effective cap (effects quality): at most `max`, the size the instance buffers were made for */
  limit: number;

  constructor(public max: number, public mode: PoolMode, public material: THREE.ShaderMaterial, private windDefault = 0) {
    this.limit = max;
    this.geo = quad();
    this.iPos = new Float32Array(max * 4);
    this.iVel = new Float32Array(max * 2);
    this.iSize = new Float32Array(max * 2);
    this.iCol = new Float32Array(max * 4);
    this.iT = new Float32Array(max);
    const mk = (n: string, arr: Float32Array, sz: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, sz);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(n, a);
      return a;
    };
    this.attrs = [mk('iPos', this.iPos, 4), mk('iVel', this.iVel, 2), mk('iSize', this.iSize, 2), mk('iCol', this.iCol, 4), mk('iT', this.iT, 1)];
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
  }

  /** emission throttle for continuous sources: 1 while there is room, falling to 0.15 as the pool fills,
   *  so a castle-wide blaze thins its emitters instead of evicting smoke before it can form a plume */
  get room() { return Math.min(1, Math.max(0.15, (1 - this.parts.length / this.limit) / 0.4)); }

  spawn(p: SpawnArg) {
    if (this.overflow && (p.kind ?? 0) === 0 && (p.size0 ?? 1) >= 0.5) { this.overflow.spawn(p); return; }
    const max = p.max ?? 1;
    const np = {
      vx: 0, vy: 0, size0: 1, size1: 1, c0: [1, 1, 1], c1: [1, 1, 1], a0: 1, a1: 0, drag: 0, grav: 0, ...p,
      life: -(p.delay ?? 0), max, seed: p.seed ?? Math.random(),
    } as Particle;
    if (this.parts.length >= this.limit) this.parts[this.evict++ % this.parts.length] = np;
    else this.parts.push(np);
  }

  update(dt: number) {
    const ps = this.parts;
    const wind = this.wind;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      p.vy += p.grav * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      // carried by the wind: ease the horizontal speed toward it (smoke drifts, tongues lean)
      const wk = p.windK ?? this.windDefault;
      if (wk > 0) p.vx += (wind * wk - p.vx) * Math.min(1, dt * 0.9 * wk);
      p.x += p.vx * dt; p.y += p.vy * dt;
      ps[w++] = p;
    }
    ps.length = w;
    let n = 0;
    const { iPos, iVel, iSize, iCol, iT } = this;
    for (let i = 0; i < w; i++) {
      const p = ps[i];
      if (p.life < 0) continue; // delayed: not yet visible
      const t = p.life / p.max;
      const a = p.a0 + (p.a1 - p.a0) * t;
      if (a <= 0.003) continue;
      const r = p.c0[0] + (p.c1[0] - p.c0[0]) * t;
      const g = p.c0[1] + (p.c1[1] - p.c0[1]) * t;
      const b = p.c0[2] + (p.c1[2] - p.c0[2]) * t;
      iPos[n * 4] = p.x; iPos[n * 4 + 1] = p.y; iPos[n * 4 + 2] = p.seed!; iPos[n * 4 + 3] = p.kind ?? 0;
      iVel[n * 2] = p.vx; iVel[n * 2 + 1] = p.vy;
      iSize[n * 2] = p.size0 + (p.size1 - p.size0) * t; iSize[n * 2 + 1] = p.stretch ?? 1;
      if (this.mode === 'heat') {
        // flame colour -> heat: the callers' yellow -> orange -> ember colour ramps are temperature ramps,
        // so green/red is a fair thermometer; heat = opacity x temperature
        const temp = Math.min(1.15, 0.3 + g / Math.max(r, 0.05));
        iCol[n * 4] = temp; iCol[n * 4 + 1] = 0; iCol[n * 4 + 2] = 0; iCol[n * 4 + 3] = a * temp;
      } else {
        iCol[n * 4] = r; iCol[n * 4 + 1] = g; iCol[n * 4 + 2] = b; iCol[n * 4 + 3] = a;
      }
      iT[n] = t;
      n++;
    }
    this.geo.instanceCount = n;
    const live = Math.max(n, 1);
    for (const at of this.attrs) { at.clearUpdateRanges(); at.addUpdateRange(0, live * at.itemSize); at.needsUpdate = true; }
  }
}

// ───────────────────────── field writers ─────────────────────────
const fieldVert = /* glsl */ `
attribute vec4 iPos; attribute vec2 iVel; attribute vec2 iSize; attribute vec4 iCol; attribute float iT;
uniform float uWind; uniform float uSpin;
varying vec2 vQ; varying vec4 vCol; varying float vT; varying float vSeed;
void main(){
  vQ = position.xy; vCol = iCol; vT = iT; vSeed = iPos.z;
  float s = iSize.x * 0.5; float st = iSize.y;
  vec2 off = vec2(position.x * s, position.y * s * st);
  if (st > 1.05) {
    // tongue: base stays put, the tip leans with its drift and the wind
    float lean = clamp(iVel.x * 0.16 + uWind * 0.05, -0.8, 0.8);
    off.x += lean * (position.y + 1.0) * 0.5 * s * st;
  } else {
    // puff: a fixed random turn plus a slow roll over its life, so merged puffs billow instead of sliding
    float a = iPos.z * 6.2832 + iT * uSpin * (fract(iPos.z * 7.13) - 0.5);
    off = mat2(cos(a), sin(a), -sin(a), cos(a)) * off;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xy + off, 0.0, 1.0);
}
`;
const heatFrag = /* glsl */ `
uniform float uTime;
varying vec2 vQ; varying vec4 vCol; varying float vT; varying float vSeed;
${FX_NOISE}
void main(){
  vec2 q = vQ;
  // teardrop: narrower toward the top, so even a lone tongue reads as a flame and not a disc
  float taper = 1.0 + 0.75 * clamp(q.y, 0.0, 1.0);
  float r = length(vec2(q.x * taper, q.y * (q.y < 0.0 ? 1.25 : 1.0)));
  float n = fxNoise(q * 1.8 + vec2(vSeed * 37.0, vSeed * 11.0 - uTime * 3.0));
  float m = clamp(1.0 - r - (n - 0.5) * 0.6, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  gl_FragColor = vec4(m * vCol.a * smoothstep(0.0, 0.05, vT), 0.0, 0.0, 1.0);
}
`;
const smokeFrag = /* glsl */ `
uniform float uTime;
varying vec2 vQ; varying vec4 vCol; varying float vT; varying float vSeed;
${FX_NOISE}
void main(){
  // lumpy cauliflower puff: radial falloff broken by noise that churns as the puff ages
  float r = length(vQ);
  if (r > 1.0) discard;
  float n = fxFbm(vQ * 1.5 + vec2(vSeed * 23.0 + vT * 0.9, vSeed * 7.0 - vT * 0.7));
  float m = clamp((1.0 - r) * 1.6 - (n - 0.5) * (0.35 + 0.7 * r) - vT * vT * (n + 0.25) * 1.5, 0.0, 1.0);
  m *= smoothstep(0.0, 0.08, vT); // ease in: no popping (and as it ages, noise eats it into wisps)
  float d = m * vCol.a;
  gl_FragColor = vec4(vCol.rgb * d, d);
}
`;

// ───────────────────────── composites ─────────────────────────
const compVert = /* glsl */ `
varying vec2 vUv; varying vec2 vWorld;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }
`;
/** pale core → yellow → orange → red → deep-red rim; values kept so only the core grazes the bloom threshold */
const flameComp = /* glsl */ `
uniform sampler2D uHeat; uniform float uTime; uniform float uWind;
varying vec2 vUv; varying vec2 vWorld;
${FX_NOISE}
void main(){
  float h = texture2D(uHeat, vUv).r;
  if (h < 0.04) discard;
  vec2 w = vWorld;
  // licks: noise stretched vertically, scrolled upward, sheared and carried by the wind
  float t = uTime;
  vec2 nw = vec2((w.x - uWind * (0.05 * w.y + 0.3 * t)) * 1.7, w.y * 0.75 - t * 2.3);
  float n = fxFbm(nw);
  float n2 = fxNoise(w * vec2(4.0, 2.5) + vec2(0.0, -t * 5.5));
  float hc = 1.0 - exp(-h * 1.05);
  float e = hc - (n - 0.5) * 0.62 - (n2 - 0.5) * (0.16 + 0.3 * hc);
  float aa = max(fwidth(e) * 0.8, 1e-3);
  #define BAND(th) smoothstep(th - aa, th + aa, e)
  float a = BAND(0.11);
  if (a <= 0.0) discard;
  vec3 col = vec3(0.36, 0.05, 0.035);                    // deep-red rim
  col = mix(col, vec3(0.74, 0.15, 0.05), BAND(0.18));    // red
  col = mix(col, vec3(0.98, 0.42, 0.08), BAND(0.29));    // orange
  col = mix(col, vec3(1.04, 0.7, 0.18), BAND(0.45));     // yellow
  col = mix(col, vec3(1.04, 0.92, 0.6), BAND(0.68));     // pale core (luma ~0.9: grazes the bloom, never whites out)
  gl_FragColor = vec4(col, a);
}
`;
const smokeComp = /* glsl */ `
uniform sampler2D uSmoke; uniform sampler2D uHeat; uniform vec2 uTexel; uniform vec2 uUvPerM; uniform float uTime; uniform float uWind;
varying vec2 vUv; varying vec2 vWorld;
${FX_NOISE}
void main(){
  vec4 s = texture2D(uSmoke, vUv);
  float d = s.a;
  if (d < 0.03) discard;
  vec3 tone = s.rgb / d;
  // erosion: thin smoke frays at the edges with drifting noise
  float n = fxFbm(vWorld * 0.8 + vec2(-uWind * uTime * 0.2, -uTime * 0.35));
  float de = d * (0.75 + 0.5 * n) - 0.04;
  float aa = max(fwidth(de) * 0.8, 1e-3);
  float a = smoothstep(0.16 - aa, 0.16 + aa, de);
  if (a <= 0.0) discard;
  // two-tone (three with the rim) shading from the density gradient, lit from the top-left; the gradient
  // is taken across ~0.5 m (not pixels) so it follows the big billows at any zoom, not every lump
  vec2 o = max(uUvPerM * 0.5, uTexel * 2.0);
  float dl = texture2D(uSmoke, vUv - vec2(o.x, 0.0)).a, dr = texture2D(uSmoke, vUv + vec2(o.x, 0.0)).a;
  float dd = texture2D(uSmoke, vUv - vec2(0.0, o.y)).a, du = texture2D(uSmoke, vUv + vec2(0.0, o.y)).a;
  vec2 g = vec2(dr - dl, du - dd);
  float sh = dot(-g, normalize(vec2(-0.55, 0.85))) / (length(g) + 0.12);
  // lit side lifts dark smoke too (additive part), shadow side sinks
  tone = sh > 0.3 ? tone * 1.12 + 0.07 : sh < -0.3 ? tone * 0.7 : tone * 0.94;
  tone *= mix(1.0, 0.88, smoothstep(0.5, 1.4, d));
  // silhouette band: a darker edge, the cel outline
  tone *= mix(0.8, 1.0, smoothstep(0.16 + aa, 0.21 + aa, de));
  // fire under the smoke lights its belly
  float hg = texture2D(uHeat, vUv - vec2(0.0, uTexel.y * 7.0)).r + 0.5 * texture2D(uHeat, vUv).r;
  tone += vec3(0.95, 0.38, 0.08) * step(0.12, hg) * min(1.0, hg) * 0.5;
  tone = min(tone, vec3(0.9));
  // two opacity steps: wisps are see-through, the body is solid
  float op = mix(0.55, 0.95, smoothstep(0.24 - aa, 0.24 + aa, de));
  gl_FragColor = vec4(tone, a * op);
}
`;

const sparkVert = /* glsl */ `
attribute vec4 iPos; attribute vec2 iVel; attribute vec2 iSize; attribute vec4 iCol; attribute float iT;
varying vec2 vQ; varying vec4 vCol; varying float vKind; varying float vSeed; varying float vT;
void main(){
  vQ = position.xy; vCol = iCol; vKind = iPos.w; vSeed = iPos.z; vT = iT;
  float s = iSize.x * 0.5;
  vec2 off;
  if (iPos.w < 0.5) {
    // streak: stretched along the velocity (about 1/40 s of travel), so fast sparks read as tracers
    float sp = length(iVel);
    vec2 dir = sp > 0.01 ? iVel / sp : vec2(0.0, 1.0);
    float len = s + sp * 0.022;
    off = dir * position.x * len + vec2(-dir.y, dir.x) * position.y * s;
  } else off = position.xy * s;
  gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xy + off, 0.0, 1.0);
}
`;
const sparkFrag = /* glsl */ `
uniform float uTime;
varying vec2 vQ; varying vec4 vCol; varying float vKind; varying float vSeed; varying float vT;
void main(){
  float a; vec3 col = vCol.rgb;
  if (vKind < 0.5) {
    // ember / spark: hot pinched core, twinkling
    float across = 1.0 - smoothstep(0.15, 1.0, abs(vQ.y));
    float along = 1.0 - smoothstep(0.35, 1.0, abs(vQ.x));
    a = across * along;
    col = mix(col, vec3(1.5, 1.2, 0.7), step(0.7, a) * 0.35);
    a *= 0.65 + 0.35 * sin(uTime * 31.0 + vSeed * 60.0);
  } else if (vKind < 1.5) {
    // flash: flat disc with a softer halo, stepped (one bright step, one glow step)
    float r = length(vQ);
    a = step(r, 0.55) * 0.7 + (1.0 - smoothstep(0.4, 1.0, r)) * 0.4;
  } else {
    // shock ring: thin annulus thinning as it grows
    float r = length(vQ);
    float th = mix(0.16, 0.05, vT);
    a = 1.0 - smoothstep(th * 0.4, th, abs(r - 0.88));
  }
  if (a <= 0.003) discard;
  gl_FragColor = vec4(col, a * vCol.a);
}
`;

/** a view-filling quad that composites a field into the main scene at its depth */
function compositeQuad(frag: string, uniforms: Record<string, THREE.IUniform>, z: number, order: number) {
  const mat = new THREE.ShaderMaterial({ vertexShader: compVert, fragmentShader: frag, uniforms, transparent: true, depthWrite: false, depthTest: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.position.z = z;
  m.renderOrder = order;
  return m;
}

export class FireFX {
  smoke: FxPool;
  flame: FxPool;
  sparks: FxPool;
  heatRT: THREE.WebGLRenderTarget;
  smokeRT: THREE.WebGLRenderTarget;
  private heatScene = new THREE.Scene();
  private smokeScene = new THREE.Scene();
  flameQuad: THREE.Mesh;
  smokeQuad: THREE.Mesh;
  private shared = { uTime: { value: 0 }, uWind: { value: 0 } };
  private clear = new THREE.Color(0, 0, 0);
  /** fire and smoke field resolution relative to the drawing buffer (effects quality) */
  fieldScale = 0.5;
  private size = { w: 4, h: 4 };

  constructor() {
    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.heatRT = new THREE.WebGLRenderTarget(4, 4, rtOpts);
    this.smokeRT = new THREE.WebGLRenderTarget(4, 4, rtOpts);
    const add = { transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending };
    const heatMat = new THREE.ShaderMaterial({ vertexShader: fieldVert, fragmentShader: heatFrag, ...add,
      uniforms: { ...this.shared, uSpin: { value: 0 } } });
    // smoke: plain sum of colour * density and density (the composite divides them back out)
    const smokeMat = new THREE.ShaderMaterial({ vertexShader: fieldVert, fragmentShader: smokeFrag, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { ...this.shared, uSpin: { value: 2.5 } } });
    const sparkMat = new THREE.ShaderMaterial({ vertexShader: sparkVert, fragmentShader: sparkFrag, ...add, uniforms: { uTime: this.shared.uTime } });
    this.smoke = new FxPool(2400, 'smoke', smokeMat, 0.55);
    this.flame = new FxPool(2600, 'heat', heatMat, 0.12);
    this.sparks = new FxPool(1600, 'spark', sparkMat, 0.25);
    this.sparks.overflow = this.flame;
    this.heatScene.add(this.flame.mesh);
    this.smokeScene.add(this.smoke.mesh);
    this.sparks.mesh.position.z = 9;
    this.sparks.mesh.renderOrder = 20;
    this.smokeQuad = compositeQuad(smokeComp, { uSmoke: { value: this.smokeRT.texture }, uHeat: { value: this.heatRT.texture }, uTexel: { value: new THREE.Vector2() },
      uUvPerM: { value: new THREE.Vector2() }, ...this.shared }, 8, 15);
    this.flameQuad = compositeQuad(flameComp, { uHeat: { value: this.heatRT.texture }, ...this.shared }, 8.5, 17);
  }

  /** meshes that belong in the main scene */
  get sceneObjects() { return [this.smokeQuad, this.flameQuad, this.sparks.mesh]; }

  resize(w: number, h: number) {
    // half resolution: the fields are soft anyway, and the composites threshold them with screen-space AA
    this.size = { w, h };
    const fw = Math.max(4, Math.round(w * this.fieldScale)), fh = Math.max(4, Math.round(h * this.fieldScale));
    this.heatRT.setSize(fw, fh);
    this.smokeRT.setSize(fw, fh);
    ((this.smokeQuad.material as THREE.ShaderMaterial).uniforms.uTexel.value as THREE.Vector2).set(1 / fw, 1 / fh);
  }

  /** effects quality: particle caps (fraction of each pool) and field resolution */
  setQuality(poolFrac: number, fieldScale: number) {
    for (const p of [this.smoke, this.flame, this.sparks]) p.limit = Math.max(64, Math.round(p.max * poolFrac));
    this.fieldScale = fieldScale;
    this.resize(this.size.w, this.size.h);
  }

  set wind(v: number) { this.smoke.wind = v; this.flame.wind = v; this.sparks.wind = v; this.shared.uWind.value = v; }

  update(dt: number, time: number) {
    this.shared.uTime.value = time;
    this.smoke.update(dt);
    this.flame.update(dt);
    this.sparks.update(dt);
  }

  /** draw the fields (before the main pass), and fit the composite quads to the camera */
  renderFields(renderer: THREE.WebGLRenderer, camera: THREE.OrthographicCamera) {
    const vw = camera.right - camera.left, vh = camera.top - camera.bottom;
    ((this.smokeQuad.material as THREE.ShaderMaterial).uniforms.uUvPerM.value as THREE.Vector2).set(1 / vw, 1 / vh);
    for (const q of [this.smokeQuad, this.flameQuad]) {
      q.position.x = camera.position.x; q.position.y = camera.position.y;
      q.scale.set(vw, vh, 1);
    }
    this.smokeQuad.visible = this.smoke.parts.length > 0;
    this.flameQuad.visible = this.flame.parts.length > 0;
    const prev = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(this.clear, 0);
    if (this.flameQuad.visible || this.smokeQuad.visible) {
      // the smoke's under-glow samples the heat field, so clear it even when only smoke is up
      renderer.setRenderTarget(this.heatRT); renderer.clear(true, false, false);
      if (this.flameQuad.visible) renderer.render(this.heatScene, camera);
    }
    if (this.smokeQuad.visible) { renderer.setRenderTarget(this.smokeRT); renderer.clear(true, false, false); renderer.render(this.smokeScene, camera); }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  clearAll() { this.smoke.parts.length = 0; this.flame.parts.length = 0; this.sparks.parts.length = 0; }
}

// ───────────────────────── recipes ─────────────────────────
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Explosion: flash and shock ring (frame 1), a fireball that punches out fast, stalls and cools through the
 * ramp (0.1-0.5 s), sparks, then a smoke cloud that takes over as the fire dies and rolls up and downwind.
 * `fuel` makes it oilier: a taller, longer fireball and black smoke.
 */
export function fxExplosion(fx: FireFX, x: number, y: number, s: number, fuel = false) {
  const sp = fx.sparks, fl = fx.flame, sm = fx.smoke;
  // flash + ring
  sp.spawn({ x, y, kind: 1, max: 0.07, size0: 1.8 * s + 0.8, size1: 2.6 * s + 1, c0: [1.0, 0.8, 0.5], c1: [0.9, 0.45, 0.2], a0: 0.55, a1: 0, windK: 0 });
  sp.spawn({ x, y, kind: 2, max: 0.24, size0: 1.2 * s + 0.5, size1: 8 * s + 2.5, c0: [0.85, 0.75, 0.6], c1: [0.6, 0.45, 0.35], a0: 0.45, a1: 0, windK: 0 });
  // fireball: a hot core blob, then a ring of blobs thrown out and braked hard
  const fb = fuel ? 1.35 : 1;
  fl.spawn({ x, y: y + 0.2 * s, vy: 2, max: 0.26 * fb, size0: 1.6 * s + 0.6, size1: 2.4 * s + 0.6, c0: [1.4, 1.2, 0.6], c1: [1.2, 0.3, 0.1], a0: 0.9, a1: 0.1, drag: 4, windK: 0 });
  const n = Math.round((16 * s + 6) * fb);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = rnd(4, 11) * s + 2;
    fl.spawn({ x: x + Math.cos(a) * 0.2, y: y + Math.sin(a) * 0.2, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8 + 1.5, max: rnd(0.28, 0.55) * fb,
      size0: rnd(0.7, 1.2) * s + 0.3, size1: rnd(1.0, 1.6) * s + 0.3, c0: [1.4, rnd(0.95, 1.2), 0.4], c1: [0.9, 0.15, 0.05], a0: 1.0, a1: 0, drag: 6.5, grav: 4, windK: 0.1 });
  }
  if (fuel) for (let i = 0; i < 6 * s + 3; i++) {
    // burning fuel carried up in a column
    fl.spawn({ x: x + rnd(-0.8, 0.8) * s, y: y + rnd(0, 1) * s, vx: rnd(-1, 1), vy: rnd(4, 8) * s, max: rnd(0.5, 0.9), size0: rnd(0.9, 1.4) * s, size1: 0.4 * s, stretch: 1.4,
      c0: [1.4, 1.0, 0.3], c1: [0.8, 0.15, 0.04], a0: 1, a1: 0, drag: 2.5, delay: rnd(0.02, 0.15) });
  }
  // sparks
  for (let i = 0; i < 16 * s + 4; i++) {
    const a = Math.random() * Math.PI * 2, v = rnd(9, 24) * s + 3;
    sp.spawn({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 3, max: rnd(0.35, 0.8), size0: rnd(0.1, 0.18), size1: 0.06,
      c0: [2.0, 1.15, 0.4], c1: [1.4, 0.35, 0.06], a0: 1, a1: 0.2, drag: 1.6, grav: -14 });
  }
  // smoke takes over as the fireball cools: dark at the heart, rolling up
  const ns = Math.round((12 * s + 6) * (fuel ? 1.3 : 1));
  for (let i = 0; i < ns; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * s * 1.1, v = rnd(0.8, 2.6) * s;
    const g = fuel ? rnd(0.1, 0.16) : rnd(0.22, 0.32);
    sm.spawn({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * 0.8 + 0.3 * s, vx: Math.cos(a) * v, vy: Math.abs(Math.sin(a)) * v + 0.6 * s, delay: rnd(0.12, 0.3),
      max: rnd(2.4, 3.8) * (fuel ? 1.3 : 1), size0: rnd(1.0, 1.6) * s + 0.5, size1: rnd(2.8, 3.8) * s + 1.2, c0: [g + 0.04, g + 0.02, g], c1: [g + 0.24, g + 0.23, g + 0.22],
      a0: 0.95, a1: 0, drag: 1.4, grav: 0.9 });
  }
  // a column rising from the fireball
  for (let i = 0; i < 4 * s + 2; i++) {
    const g = fuel ? 0.1 : 0.24;
    sm.spawn({ x: x + rnd(-0.4, 0.4) * s, y: y + s, vx: rnd(-0.5, 0.5), vy: rnd(2.5, 4) * Math.sqrt(s), delay: rnd(0.25, 0.6), max: rnd(3, 4.2),
      size0: 1.2 * s + 0.4, size1: 3.6 * s + 1.4, c0: [g + 0.04, g + 0.02, g], c1: [g + 0.26, g + 0.25, g + 0.24], a0: 0.85, a1: 0, drag: 0.9, grav: 0.5 });
  }
}

/** smoke-screen / dust cloud (no fire) */
export function fxSmokeCloud(fx: FireFX, x: number, y: number) {
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2, v = Math.random() * 5;
    const g = rnd(0.8, 0.9);
    fx.smoke.spawn({ x: x + Math.cos(a) * 0.3, y: y + Math.sin(a) * 0.3, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 + 0.8,
      max: rnd(9, 10.5), size0: 2, size1: 7, c0: [g, g, g - 0.03], c1: [g - 0.08, g - 0.08, g - 0.09], a0: 0.85, a1: 0, drag: 1.8, grav: 0.3, windK: 0.35 });
  }
}

/**
 * One frame of a burning block (centre x,y, size w,h, rotation-free footprint): tongues licking up from it,
 * the odd ember, and a dark smoke column. `grow` 0..1 is the fire's strength.
 */
export function fxBurning(fx: FireFX, x: number, y: number, w: number, h: number, grow: number, dt: number, rot = 0) {
  const area = Math.min(1.6, w * h);
  const c = Math.cos(rot), sn = Math.sin(rot);
  // a random point on the (rotated) block; lx, ly are block-local
  const at = (lx: number, ly: number): [number, number] => [x + lx * c - ly * sn, y + lx * sn + ly * c];
  // bed of flame hugging the block, and tongues rising off it
  if (Math.random() < dt * 34 * grow * Math.max(0.35, area) * fx.flame.room) {
    const [px, py] = at(rnd(-0.5, 0.5) * w, rnd(-0.35, 0.4) * h);
    const big = Math.min(1.3, 0.55 + 0.35 * Math.sqrt(area));
    fx.flame.spawn({ x: px, y: py, vx: rnd(-0.3, 0.3), vy: rnd(1.2, 2.4), max: rnd(0.5, 0.9), size0: rnd(0.85, 1.25) * big, size1: 0.25, stretch: rnd(1.4, 1.9),
      c0: [1.4, rnd(0.85, 1.15), 0.2], c1: [0.8, 0.18, 0.03], a0: 1.0 * (0.6 + 0.4 * grow), a1: 0, drag: 0.8 });
  }
  if (Math.random() < dt * 4 * grow * Math.max(0.5, area) * fx.sparks.room) {
    // embers: wander up on the heat, drift downwind, twinkle out
    const [px, py] = at(rnd(-0.5, 0.5) * w, h * 0.4);
    fx.sparks.spawn({ x: px, y: py, vx: rnd(-1, 1), vy: rnd(2, 4.5), max: rnd(1.2, 2.4), size0: rnd(0.07, 0.12), size1: 0.03,
      c0: [2.4, 1.2, 0.3], c1: [1.4, 0.3, 0.05], a0: 1, a1: 0, drag: 0.7, grav: -0.6, windK: 0.6 });
  }
  if (Math.random() < dt * 9 * grow * Math.max(0.4, area) * fx.smoke.room) {
    const g = rnd(0.13, 0.2);
    const [px, py] = at(rnd(-0.4, 0.4) * w, h * 0.5);
    fx.smoke.spawn({ x: px, y: py + 0.4, vx: rnd(-0.3, 0.3), vy: rnd(1.4, 2.2), delay: 0.1, max: rnd(4.5, 6), size0: 0.9, size1: rnd(3.6, 4.6),
      c0: [g + 0.03, g + 0.01, g], c1: [g + 0.32, g + 0.31, g + 0.3], a0: 0.8, a1: 0, drag: 0.35, grav: 0.2, windK: 0.8 });
  }
}
