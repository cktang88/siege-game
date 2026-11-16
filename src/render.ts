import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ───────────────────────── Shaders ─────────────────────────
const NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for(int i=0;i<4;i++){ s += a*vnoise(p); p *= 2.03; a *= .5; } return s; }
// distance to voronoi cell border
float voronoiEdge(vec2 p){ vec2 n = floor(p); vec2 f = fract(p); float md = 8.; vec2 mr;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g = vec2(i,j); vec2 o = hash22(n+g); vec2 r = g+o-f; float d = dot(r,r); if(d<md){ md=d; mr=r; } }
  md = 8.;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ vec2 g = vec2(i,j); vec2 o = hash22(n+g); vec2 r = g+o-f; if(dot(mr-r,mr-r)>0.00001) md = min(md, dot(0.5*(mr+r), normalize(r-mr))); }
  return md; }
`;

const blockVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ───────────────────────── Light pool ─────────────────────────
/*
  After tinwar's lighting.ts: every bright thing is a light. Blasts, muzzle flashes, tracers and fires
  register short-lived point lights; blocks and terrain add them in their shaders (cel-stepped falloff).
*/
export const MAX_LIGHTS = 16;
export const LIGHTS = {
  uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, 0, 1, 0)) }, // x, y, radius, unused
  uLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
  uLightCount: { value: 0 },
};
interface Light { x: number; y: number; r: number; c: [number, number, number]; i: number; life: number; max: number; flicker: number; key?: string; seen?: boolean }
export class LightPool {
  lights: Light[] = [];
  /** transient light */
  add(x: number, y: number, r: number, c: [number, number, number], i: number, life: number, flicker = 0) {
    this.lights.push({ x, y, r, c, i, life, max: life, flicker });
  }
  /** persistent light: refresh every frame or it goes out */
  set(key: string, x: number, y: number, r: number, c: [number, number, number], i: number, flicker = 0.3) {
    const l = this.lights.find((q) => q.key === key);
    if (l) { l.x = x; l.y = y; l.r = r; l.i = i; l.seen = true; return; }
    this.lights.push({ x, y, r, c, i, life: 1, max: 1, flicker, key, seen: true });
  }
  update(dt: number, time: number) {
    this.lights = this.lights.filter((l) => {
      if (l.key) { const keep = !!l.seen; l.seen = false; return keep; }
      l.life -= dt; return l.life > 0;
    });
    const ranked = [...this.lights].sort((a, b) => b.i * b.r - a.i * a.r).slice(0, MAX_LIGHTS);
    ranked.forEach((l, k) => {
      const fade = l.key ? 1 : (l.life / l.max) ** 1.5;
      const fl = 1 - l.flicker * (0.5 + 0.5 * Math.sin(time * 23 + k * 7.1) * Math.sin(time * 13.7 + k));
      const I = l.i * fade * fl;
      LIGHTS.uLightPos.value[k].set(l.x, l.y, l.r, 0);
      LIGHTS.uLightCol.value[k].set(l.c[0] * I, l.c[1] * I, l.c[2] * I);
    });
    LIGHTS.uLightCount.value = ranked.length;
  }
}
const LIGHT_GLSL = /* glsl */ `
uniform vec4 uLightPos[${MAX_LIGHTS}]; uniform vec3 uLightCol[${MAX_LIGHTS}]; uniform int uLightCount;
vec3 pointLights(vec2 w) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    float d = length(w - uLightPos[i].xy) / uLightPos[i].z;
    float f = clamp(1.0 - d, 0.0, 1.0);
    f = floor(f * f * 4.0 + 0.5) / 4.0; // hard cel steps: light as a toy would see it
    acc += uLightCol[i] * f;
  }
  return acc;
}
`;
const litVert = /* glsl */ `
varying vec2 vUv; varying vec2 vWorld;
attribute vec4 aDA; attribute vec4 aDB; varying vec4 vDA; varying vec4 vDB;
void main(){ vUv = uv; vDA = aDA; vDB = aDB; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }
`;

/**
 * Geometry for a convex block outline (bbox-local points, origin at the bbox centre).
 * Each vertex carries its distance to every edge line (up to 8). Distance to a line is affine,
 * so the interpolated values are exact everywhere inside: the shader gets pixel-true outlines
 * and bevels on slanted edges as well as square ones.
 */
export function blockGeometry(w: number, h: number, poly?: [number, number][]) {
  const pts: [number, number][] = poly ? poly.map(([x, y]) => [x - w / 2, y - h / 2]) : [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const n = pts.length;
  const normals: THREE.Vector2[] = [];
  const lines: { nx: number; ny: number; c: number }[] = [];
  for (let i = 0; i < 8; i++) {
    if (i >= n) { normals.push(new THREE.Vector2(0, 0)); lines.push({ nx: 0, ny: 0, c: 99 }); continue; }
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
    const nx = ey / len, ny = -ex / len; // outward for CCW polygons
    normals.push(new THREE.Vector2(nx, ny));
    lines.push({ nx, ny, c: -(nx * ax + ny * ay) });
  }
  const pos: number[] = [], uv: number[] = [], da: number[] = [], db: number[] = [], idx: number[] = [];
  for (const [x, y] of pts) {
    pos.push(x, y, 0);
    uv.push(x / w + 0.5, y / h + 0.5);
    const d = lines.map((l) => (l.c === 99 ? 99 : -(l.nx * x + l.ny * y + l.c)));
    da.push(d[0], d[1], d[2], d[3]);
    db.push(d[4], d[5], d[6], d[7]);
  }
  for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aDA', new THREE.Float32BufferAttribute(da, 4));
  g.setAttribute('aDB', new THREE.Float32BufferAttribute(db, 4));
  g.setIndex(idx);
  g.userData.normals = normals;
  return g;
}

const blockFrag = /* glsl */ `
uniform vec3 uColor; uniform vec2 uSize; uniform float uKind; uniform float uDamage; uniform float uBurn;
uniform float uFlash; uniform float uHighlight; uniform float uSeed; uniform float uTime; uniform float uTarget; uniform vec3 uTargetColor;
uniform float uFade; uniform vec2 uNorm[8];
varying vec2 vUv; varying vec2 vWorld; varying vec4 vDA; varying vec4 vDB;
${NOISE}
${LIGHT_GLSL}
void main(){
  vec2 p = vUv * uSize;            // meters
  vec2 px = fwidth(p);             // meters per pixel
  vec3 col = uColor;
  float line = 0.0;                // seams (0..1)
  float k = uKind;
  if (k < 0.5) {                   // wood planks
    bool horiz = uSize.x >= uSize.y;
    vec2 q = horiz ? p : p.yx;
    float pw = 0.28; float row = floor(q.y / pw);
    float grain = fbm(vec2(q.x * 1.2, q.y * 14.0 + row * 7.0 + uSeed));
    col *= 0.86 + 0.22 * smoothstep(0.35, 0.75, grain) + 0.08 * (hash12(vec2(row, uSeed)) - .5);
    float seam = abs(fract(q.y / pw) - 0.0); seam = min(seam, 1.0 - seam) * pw;
    line = max(line, 1.0 - smoothstep(0.0, px.y * 1.3 + 0.004, seam));
    float nail = length(vec2(mod(q.x, 1.1) - 0.15, mod(q.y, pw) - pw * .5));
    col *= 1.0 - 0.45 * (1.0 - smoothstep(0.025, 0.04, nail));
  } else if (k < 1.5) {            // masonry bricks
    vec2 bs = vec2(0.5, 0.25); float r = floor(p.y / bs.y);
    vec2 q = vec2(p.x / bs.x + (mod(r, 2.0) * .5), p.y / bs.y);
    vec2 id = floor(q); vec2 f = fract(q);
    col *= 0.88 + 0.2 * hash12(id + uSeed) + 0.1 * (fbm(p * 6.0) - .5);
    vec2 d = min(f, 1.0 - f) * bs;
    float m = min(d.x, d.y);
    line = max(line, 1.0 - smoothstep(0.012, 0.012 + px.x * 1.5, m));
  } else if (k < 2.5) {            // concrete
    col *= 0.92 + 0.12 * fbm(p * 3.0 + uSeed) - 0.08 * step(0.82, hash12(floor(p * 40.0)));
    vec2 f = fract(p / 1.3); vec2 d = min(f, 1.0 - f) * 1.3;
    line = max(line, 0.55 * (1.0 - smoothstep(0.0, px.x * 1.5, min(d.x, d.y))));
    float tie = length(fract(p / 0.65) - 0.5) * 0.65;
    col *= 1.0 - 0.25 * (1.0 - smoothstep(0.03, 0.045, tie));
  } else if (k < 3.5) {            // steel plate
    float sheen = smoothstep(0.0, 1.0, sin((p.x + p.y) * 1.3 + uSeed) * .5 + .5);
    col *= 0.9 + 0.18 * sheen;
    vec2 cs = vec2(1.2, 0.8); vec2 f = fract(p / cs); vec2 d = min(f, 1.0 - f) * cs;
    line = max(line, 1.0 - smoothstep(0.0, px.x * 1.5, min(d.x, d.y)));
    vec2 rv = mod(p, vec2(0.3)) - 0.15; bool nearSeam = min(d.x, d.y) < 0.09;
    float rivet = length(rv);
    if (nearSeam) col = mix(col * 1.25, col, smoothstep(0.03, 0.045, rivet));
  } else if (k < 4.5) {            // reactive armor tiles
    vec2 cs = vec2(0.5, 0.5); vec2 f = fract(p / cs); vec2 d = min(f, 1.0 - f) * cs;
    line = max(line, 1.0 - smoothstep(0.015, 0.015 + px.x * 1.5, min(d.x, d.y)));
    col *= 0.9 + 0.2 * (1.0 - length(f - vec2(0.3, 0.7)));
    float bolt = length(f - 0.5) * 0.5; col = mix(col * 0.5, col, smoothstep(0.03, 0.045, bolt));
  } else if (k < 5.5) {            // firebrick tiles
    vec2 cs = vec2(0.33, 0.22); float r = floor(p.y / cs.y);
    vec2 q = vec2(p.x / cs.x + mod(r, 2.0) * .5, p.y / cs.y); vec2 f = fract(q);
    col *= 0.9 + 0.16 * hash12(floor(q) + uSeed);
    vec2 d = min(f, 1.0 - f) * cs;
    line = max(line, 1.0 - smoothstep(0.01, 0.01 + px.x * 1.5, min(d.x, d.y)));
  } else if (k < 6.5) {            // munitions crates
    float slat = fract(p.y / 0.22); col *= 0.9 + 0.1 * step(0.5, slat);
    vec2 d2 = min(vUv, 1.0 - vUv) * uSize;
    float frame = step(min(d2.x, d2.y), 0.09);
    col = mix(col, col * 0.7, frame);
    // diagonal brace
    vec2 n = normalize(vec2(uSize.y, -uSize.x));
    float diag = abs(dot(p - vec2(0.0), n));
    col = mix(col * 0.75, col, smoothstep(0.05, 0.06, diag));
    // hazard stencil
    vec2 c = p - uSize * .5; float stencil = step(abs(c.x), 0.22) * step(abs(c.y), 0.13);
    col = mix(col, vec3(0.85, 0.65, 0.2), stencil * step(0.5, fract((c.x + c.y) * 6.0)));
  } else if (k < 8.5) {            // earthworks: rammed strata with stones and a turf cap
    col *= 0.86 + 0.22 * fbm(p * 2.5 + uSeed);
    col *= 0.93 + 0.07 * step(0.5, fract(p.y * 2.2 + fbm(p) * 0.6));
    col = mix(col, col * 1.35, step(0.86, vnoise(p * 7.0)));
    if (uSize.y - p.y < 0.22) col = vec3(0.38, 0.47, 0.25) * (0.9 + 0.2 * fbm(p * 8.0));
  } else if (k < 9.5) {            // clay roof tiles: scalloped courses
    float row = floor(p.y / 0.24);
    float fx = fract(p.x / 0.32 + mod(row, 2.0) * 0.5);
    float fy = fract(p.y / 0.24);
    float scallop = fy - 0.25 * (1.0 - pow(2.0 * fx - 1.0, 2.0));
    col *= 0.85 + 0.18 * hash12(vec2(floor(p.x / 0.32 + mod(row, 2.0) * 0.5), row) + uSeed);
    col *= mix(0.7, 1.08, smoothstep(0.0, 0.3, scallop));
  } else if (k < 10.5) {           // plaster over timber framing
    col *= 0.96 + 0.06 * fbm(p * 4.0 + uSeed);
    vec2 d2 = min(vUv, 1.0 - vUv) * uSize;
    float post = step(abs(fract(p.x / 1.4) - 0.5) * 1.4, 0.09);
    float frame = max(post, step(min(d2.y, 9.0), 0.16));
    col = mix(col, vec3(0.24, 0.17, 0.12), frame);
  } else if (k < 11.5) {           // fuel tank: painted steel, weld seams, hazard band
    col *= 0.9 + 0.14 * smoothstep(0.0, 1.0, sin(p.x * 2.0 + uSeed) * 0.5 + 0.5);
    float seam = step(abs(fract(p.y / 1.2) - 0.5) * 1.2, 0.02);
    col *= 1.0 - seam * 0.35;
    float band = step(abs(p.y - uSize.y * 0.6), 0.18);
    col = mix(col, mix(vec3(0.85, 0.65, 0.12), vec3(0.12), step(0.5, fract((p.x + p.y) * 2.5))), band);
  } else {                         // bedrock
    col *= 0.85 + 0.25 * fbm(p * 2.0);
  }
  // target tint band
  if (uTarget > 0.5) {
    vec2 c = p - uSize * .5;
    float band = step(abs(c.y - uSize.y * 0.18), 0.12);
    col = mix(col, uTargetColor, band * 0.85);
  }
  col *= 1.0 - line * 0.45;

  // nearest edge (exact for any convex outline)
  float dmin = 99.0; vec2 nrm = vec2(0.0);
  float ds[8]; ds[0] = vDA.x; ds[1] = vDA.y; ds[2] = vDA.z; ds[3] = vDA.w; ds[4] = vDB.x; ds[5] = vDB.y; ds[6] = vDB.z; ds[7] = vDB.w;
  for (int i = 0; i < 8; i++) { if (ds[i] < dmin) { dmin = ds[i]; nrm = uNorm[i]; } }
  // cel lighting: bevel bands, key light from the top-left
  float bev = 0.07;
  float lit = 1.0;
  if (dmin < bev) { float k = dot(nrm, normalize(vec2(-0.6, 0.8))); lit = k > 0.3 ? 1.18 : k < -0.3 ? 0.72 : 1.0; }
  lit *= mix(0.9, 1.0, step(0.45, vUv.y));
  col *= lit;

  // cracks
  if (uDamage > 0.02) {
    float ve = voronoiEdge(p * 2.2 + uSeed * 3.0);
    float mask = step(fbm(p * 1.7 + uSeed), uDamage * 1.15);
    float crack = (1.0 - smoothstep(0.0, 0.035 + px.x, ve)) * mask;
    col = mix(col, col * 0.25, crack);
    col *= 1.0 - uDamage * 0.18;
  }
  // charring + embers
  if (uBurn > 0.01) {
    float n = fbm(p * 3.0 + vec2(0.0, -uTime * 0.6));
    col = mix(col, col * 0.25, clamp(uBurn * 1.2, 0.0, 0.85));
    float ember = smoothstep(0.62, 0.8, n) * uBurn;
    col += vec3(2.4, 0.9, 0.2) * ember;
  }
  // outline
  float edge = dmin / max(px.x, 1e-4);
  col = mix(uColor * 0.18, col, smoothstep(1.2, 2.2, edge));
  // highlight (load bearing)
  if (uHighlight > 0.0) {
    float rim = 1.0 - smoothstep(2.0, 5.0, edge);
    col = mix(col, vec3(1.6, 1.25, 0.25), rim * (0.6 + 0.4 * sin(uTime * 6.0)) * uHighlight);
  }
  col += col * pointLights(vWorld) * 0.8;
  col = mix(col, vec3(2.0), uFlash);
  gl_FragColor = vec4(col, uFade);
}
`;

export function makeBlockMaterial(color: [number, number, number], w: number, h: number, kind: number, geo?: THREE.BufferGeometry) {
  const normals: THREE.Vector2[] = geo?.userData.normals ?? [new THREE.Vector2(0, -1), new THREE.Vector2(1, 0), new THREE.Vector2(0, 1), new THREE.Vector2(-1, 0), ...Array.from({ length: 4 }, () => new THREE.Vector2())];
  return new THREE.ShaderMaterial({
    vertexShader: litVert,
    fragmentShader: blockFrag,
    transparent: true,
    uniforms: {
      uColor: { value: new THREE.Color(...color) },
      uSize: { value: new THREE.Vector2(w, h) },
      uKind: { value: kind },
      uDamage: { value: 0 },
      uBurn: { value: 0 },
      uFlash: { value: 0 },
      uHighlight: { value: 0 },
      uSeed: { value: Math.random() * 100 },
      uTime: { value: 0 },
      uTarget: { value: 0 },
      uTargetColor: { value: new THREE.Color(1, 0, 0) },
      uFade: { value: 1 },
      uNorm: { value: normals },
      ...LIGHTS,
    },
  });
}

// ───────────────────────── Ground ─────────────────────────
const groundVert = /* glsl */ `
attribute float aDepth; varying float vDepth; varying vec2 vW;
void main(){ vDepth = aDepth; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const groundFrag = /* glsl */ `
varying float vDepth; varying vec2 vW;
${NOISE}
${LIGHT_GLSL}
void main(){
  float px = fwidth(vDepth);
  float n = fbm(vW * 0.8);
  vec3 grass = vec3(0.36, 0.47, 0.24) * (0.9 + 0.2 * step(0.5, fbm(vW * 2.5)));
  vec3 dirt = vec3(0.42, 0.33, 0.24);
  float strata = step(0.5, fract(vDepth * 0.7 + n * 0.8));
  dirt *= 0.86 + 0.1 * strata;
  float pebble = step(0.82, vnoise(vW * 5.0));
  dirt = mix(dirt, dirt * 1.25, pebble);
  dirt *= mix(1.0, 0.55, clamp(vDepth / 14.0, 0.0, 1.0));
  float grassEdge = 0.45 + 0.15 * vnoise(vec2(vW.x * 3.0, 0.0));
  vec3 col = vDepth < grassEdge ? grass : dirt;
  if (vDepth < grassEdge && vDepth > grassEdge - 0.08) col *= 0.7;
  col = mix(vec3(0.1, 0.12, 0.08), col, smoothstep(0.0, px * 2.5, vDepth));
  col += col * pointLights(vW) * 0.7 * (1.0 - clamp(vDepth / 3.0, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeGround(points: [number, number][]) {
  const pos: number[] = [];
  const depth: number[] = [];
  const idx: number[] = [];
  const bottom = -40;
  points.forEach(([x, y], i) => {
    pos.push(x, y, 0, x, bottom, 0);
    depth.push(0, y - bottom);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({ vertexShader: groundVert, fragmentShader: groundFrag, uniforms: { ...LIGHTS } });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 1;
  return mesh;
}

// ───────────────────────── Background ─────────────────────────
const bgFrag = /* glsl */ `
uniform sampler2D uTex; uniform vec2 uCam; uniform vec2 uView; uniform float uTime; uniform float uHasTex;
varying vec2 vUv;
${NOISE}
void main(){
  vec2 w = uCam + (vUv - 0.5) * uView;
  // sky gradient
  float t = clamp((w.y + 10.0) / 70.0, 0.0, 1.0);
  vec3 sky = mix(vec3(0.93, 0.74, 0.55), vec3(0.32, 0.4, 0.55), pow(t, 0.7));
  vec3 col = sky;
  if (uHasTex > 0.5) {
    float S = 55.0;
    float px = uCam.x * 0.45 + (w.x - uCam.x);
    float py = w.y * 0.75 + uCam.y * 0.25;
    vec2 uv = vec2(px / S, 0.33 + py / S);
    uv.x = abs(fract(uv.x * 0.5) * 2.0 - 1.0);
    vec3 top = texture2D(uTex, vec2(uv.x, 0.995)).rgb;
    if (uv.y < 1.0) {
      col = texture2D(uTex, vec2(uv.x, max(uv.y, 0.002))).rgb;
    } else {
      col = mix(top, top * vec3(0.8, 0.85, 0.95), clamp((uv.y - 1.0) * 1.5, 0.0, 1.0));
    }
  }
  // drifting haze
  float haze = fbm(vec2(w.x * 0.02 + uTime * 0.01, w.y * 0.05));
  col = mix(col, vec3(0.95, 0.85, 0.75), smoothstep(0.55, 0.9, haze) * 0.12);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ───────────────────────── Particles ─────────────────────────
const partVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha; attribute float aKind;
uniform float uPx; varying vec3 vColor; varying float vAlpha; varying float vKind;
void main(){ vColor = aColor; vAlpha = aAlpha; vKind = aKind;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx; }
`;
const partFrag = /* glsl */ `
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main(){
  vec2 c = gl_PointCoord - 0.5; float d = length(c) * 2.0;
  if (d > 1.0 || vAlpha <= 0.0) discard;
  vec3 col = vColor;
  if (vKind < 0.5) { // smoke: toon puff with darker rim and lit top
    float lit = step(0.0, -c.y + c.x * 0.3 - 0.05);
    col *= mix(0.82, 1.08, lit);
    col *= mix(1.0, 0.82, step(0.82, d));
  } else {          // fire: hot core
    col = mix(col * 1.8, col, step(0.45, d));
  }
  gl_FragColor = vec4(col, vAlpha);
}
`;

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number;
  size0: number; size1: number;
  c0: [number, number, number]; c1: [number, number, number];
  a0: number; a1: number;
  drag: number; grav: number;
}

export class ParticlePool {
  points: THREE.Points;
  parts: Particle[] = [];
  private geo: THREE.BufferGeometry;
  private pos: Float32Array; private size: Float32Array; private col: Float32Array; private alpha: Float32Array; private kindA: Float32Array;
  material: THREE.ShaderMaterial;
  constructor(public max: number, public additive: boolean, z: number) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.kindA = new Float32Array(max).fill(additive ? 1 : 0);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setAttribute('aKind', new THREE.BufferAttribute(this.kindA, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: partVert, fragmentShader: partFrag, transparent: true, depthWrite: false, depthTest: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, uniforms: { uPx: { value: 10 } },
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.position.z = z;
    this.points.renderOrder = additive ? 20 : 15;
  }
  spawn(p: Partial<Particle> & { x: number; y: number }) {
    if (this.parts.length >= this.max) this.parts.shift();
    const max = p.max ?? 1;
    this.parts.push({
      vx: 0, vy: 0, size0: 1, size1: 1, c0: [1, 1, 1], c1: [1, 1, 1], a0: 1, a1: 0, drag: 0, grav: 0, ...p, life: 0, max,
    } as Particle);
  }
  update(dt: number) {
    const ps = this.parts;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      p.vy += p.grav * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
      ps[w++] = p;
    }
    ps.length = w;
    for (let i = 0; i < this.max; i++) {
      if (i < w) {
        const p = ps[i];
        const t = p.life / p.max;
        this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = 0;
        this.size[i] = p.size0 + (p.size1 - p.size0) * t;
        for (let k = 0; k < 3; k++) this.col[i * 3 + k] = p.c0[k] + (p.c1[k] - p.c0[k]) * t;
        this.alpha[i] = p.a0 + (p.a1 - p.a0) * t;
      } else this.alpha[i] = 0;
    }
    this.geo.setDrawRange(0, Math.max(w, 1));
    for (const n of ['position', 'aSize', 'aColor', 'aAlpha']) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ───────────────────────── Debris ─────────────────────────
interface Chunk { x: number; y: number; vx: number; vy: number; r: number; vr: number; s: number; life: number; color: THREE.Color }
export class DebrisPool {
  mesh: THREE.InstancedMesh;
  chunks: Chunk[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  constructor(public max: number, private groundY: (x: number) => number) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.position.z = 6;
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, new THREE.Color(0, 0, 0));
  }
  spawn(x: number, y: number, vx: number, vy: number, s: number, color: THREE.Color) {
    if (this.chunks.length >= this.max) this.chunks.shift();
    this.chunks.push({ x, y, vx, vy, s, r: Math.random() * 6, vr: (Math.random() - 0.5) * 14, life: 4 + Math.random() * 3, color });
  }
  update(dt: number) {
    let w = 0;
    for (const c of this.chunks) {
      c.life -= dt;
      if (c.life <= 0) continue;
      c.vy -= 9.81 * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.r += c.vr * dt;
      const gy = this.groundY(c.x) + c.s * 0.4;
      if (c.y < gy) { c.y = gy; c.vy *= -0.3; c.vx *= 0.6; c.vr *= 0.6; }
      this.chunks[w++] = c;
    }
    this.chunks.length = w;
    for (let i = 0; i < this.max; i++) {
      if (i < w) {
        const c = this.chunks[i];
        const s = c.s * Math.min(1, c.life);
        this.q.setFromAxisAngle(this.v.set(0, 0, 1), c.r);
        this.m.compose(this.v.set(c.x, c.y, 0), this.q, this.sc.set(s, s * 0.7, 1));
        this.mesh.setMatrixAt(i, this.m);
        this.mesh.setColorAt(i, c.color);
      } else {
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ───────────────────────── Sprites ─────────────────────────
export const textures: Record<string, THREE.Texture> = {};
export async function loadTextures() {
  const loader = new THREE.TextureLoader();
  const names = ['carriage', 'barrel', 'soldier', 'plane', 'saboteur', 'drone', 'house', 'airship', 'gyro', 'mast',
    'p_barrel', 'p_table', 'p_bunk', 'p_rack', 'p_banner', 'p_shells', 'p_radio', 'p_cauldron', 'p_shelf', 'p_cannon'];
  await Promise.all([
    ...names.map((n) => loader.loadAsync(`sprites/${n}.png`).then((t) => { t.anisotropy = 4; textures[n] = t; }).catch(() => {})),
    loader.loadAsync('sprites/background.jpg').then((t) => { t.wrapS = THREE.MirroredRepeatWrapping; textures.background = t; }).catch(() => {}),
  ]);
}

export function makeSprite(name: string, height: number, z = 5, fallback = 0x333333) {
  const tex = textures[name];
  const aspect = tex ? (tex.image as HTMLImageElement).width / (tex.image as HTMLImageElement).height : 1;
  const mat = tex
    ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.05 })
    : new THREE.MeshBasicMaterial({ color: fallback });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height), mat);
  mesh.position.z = z;
  return mesh;
}

// ───────────────────────── Renderer ─────────────────────────
/* final grade, after tinwar's postfx.ts: colour grade, soft vignette, animated grain, chromatic split on big hits */
const vignetteShader = {
  uniforms: { tDiffuse: { value: null }, uFlash: { value: 0 }, uTime: { value: 0 }, uSplit: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uFlash; uniform float uTime; uniform float uSplit; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - .5;
      vec2 off = d * uSplit * 0.012;
      vec4 c = texture2D(tDiffuse, vUv);
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.b = texture2D(tDiffuse, vUv - off).b;
      // grade: cool shadows, warm highlights, a touch of contrast
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb * vec3(0.92, 0.98, 1.06), c.rgb * vec3(1.05, 1.0, 0.92), smoothstep(0.2, 0.8, l));
      c.rgb = (c.rgb - 0.5) * 1.06 + 0.5;
      c.rgb *= 1.0 - dot(d, d) * 0.85;
      c.rgb += (h(vUv * 917.0 + fract(uTime * 7.3)) - 0.5) * 0.035;
      c.rgb = mix(c.rgb, vec3(1.0, 0.95, 0.85), uFlash);
      gl_FragColor = c; }`,
};

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  vignette: ShaderPass;
  bg: THREE.Mesh;
  bgMat: THREE.ShaderMaterial;
  world = new THREE.Group();
  lights = new LightPool();
  split = 0;
  smoke = new ParticlePool(1800, false, 8);
  fire = new ParticlePool(1500, true, 9);
  debris: DebrisPool;
  cx = 40; cy = 10; viewH = 40;
  shake = 0;
  flash = 0;
  width = 1; height = 1;

  constructor(canvas: HTMLCanvasElement, groundY: (x: number) => number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
    this.camera.position.z = 50;
    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: blockVert, fragmentShader: bgFrag, depthWrite: false,
      uniforms: {
        uTex: { value: textures.background ?? null }, uHasTex: { value: textures.background ? 1 : 0 },
        uCam: { value: new THREE.Vector2() }, uView: { value: new THREE.Vector2() }, uTime: { value: 0 },
      },
    });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bgMat);
    this.bg.position.z = -40;
    this.bg.renderOrder = -10;
    this.scene.add(this.bg, this.world);
    this.debris = new DebrisPool(700, groundY);
    this.scene.add(this.smoke.points, this.fire.points, this.debris.mesh);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass(vignetteShader);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  get viewW() { return this.viewH * (this.width / this.height); }
  get pxPerUnit() { return (this.height / this.viewH) * this.renderer.getPixelRatio(); }

  screenToWorld(sx: number, sy: number) {
    return { x: this.cx + (sx / this.width - 0.5) * this.viewW, y: this.cy - (sy / this.height - 0.5) * this.viewH };
  }
  worldToScreen(x: number, y: number) {
    return { x: ((x - this.cx) / this.viewW + 0.5) * this.width, y: (0.5 - (y - this.cy) / this.viewH) * this.height };
  }

  render(dt: number, time: number) {
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.flash = Math.max(0, this.flash - dt * 3);
    const s = this.shake * this.shake * 0.8;
    const ox = (Math.random() - 0.5) * s, oy = (Math.random() - 0.5) * s;
    const hw = this.viewW / 2, hh = this.viewH / 2;
    const c = this.camera;
    c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh;
    c.position.set(this.cx + ox, this.cy + oy, 50);
    c.updateProjectionMatrix();
    this.bg.position.set(this.cx, this.cy, -40);
    this.bg.scale.set(this.viewW * 1.05, this.viewH * 1.05, 1);
    this.bgMat.uniforms.uCam.value.set(this.cx, this.cy);
    this.bgMat.uniforms.uView.value.set(this.viewW * 1.05, this.viewH * 1.05);
    this.bgMat.uniforms.uTime.value = time;
    this.smoke.material.uniforms.uPx.value = this.pxPerUnit;
    this.fire.material.uniforms.uPx.value = this.pxPerUnit;
    this.smoke.update(dt);
    this.fire.update(dt);
    this.debris.update(dt);
    this.vignette.uniforms.uFlash.value = this.flash * 0.35;
    this.split = Math.max(0, this.split - dt * 3);
    this.vignette.uniforms.uSplit.value = this.split;
    this.vignette.uniforms.uTime.value = time;
    this.lights.update(dt, time);
    this.composer.render(dt);
  }
}
