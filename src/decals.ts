import * as THREE from 'three';

/*
  Block marks: a short per-block list of decals (craters, scorch, punched holes, bores, dents,
  pockmarks) drawn by the block shader, so they ride the block as it tumbles. Each mark is one vec4
  uniform: x, y in the block's pattern space (metres from the bottom-left of the ORIGINAL block's
  bounding box, so a fractured piece keeps the marks and texture of the area it came from), radius,
  and type + seed (type in the integer part, a 0..1 seed in the fraction).

  A bore (an armour-piercing round's channel through the block) takes two slots: BORE at the entry
  holds the width, BORE_END holds the exit point. A gouge (a glancing or oblique round's scrape along
  the face) is a pair the same way: GOUGE at the start, BORE_END at the hit.

  Cracks radiate from marks on brittle materials and reach further as the block loses HP (uDamage);
  timber cracks run along the grain; steel does not crack, it dents.
*/

export const MAX_MARKS = 10;

export const MarkType = { CRATER: 1, SCORCH: 2, HOLE: 3, DENT: 4, POCK: 5, BORE: 6, BORE_END: 7, GOUGE: 8 } as const;
export type MarkType = (typeof MarkType)[keyof typeof MarkType];

export interface Mark { x: number; y: number; r: number; type: MarkType; seed: number }

/** crack style by shader pattern kind (MaterialDef.kind): 0 none (steel, reactive, earth, fuel), 1 brittle web + radial spokes, 2 along the grain (timber, crates) */
const CRACK_BY_KIND = [2, 1, 1, 0, 0, 1, 2, 1, 0, 1, 1, 0];

export function markUniforms(kind: number) {
  return {
    uMarks: { value: Array.from({ length: MAX_MARKS }, () => new THREE.Vector4()) },
    uMarkN: { value: 0 },
    uCrackK: { value: CRACK_BY_KIND[kind] ?? 1 },
  };
}

export function writeMarks(uni: Record<string, THREE.IUniform>, marks: Mark[]) {
  const arr = uni.uMarks?.value as THREE.Vector4[] | undefined;
  if (!arr) return;
  const n = Math.min(MAX_MARKS, marks.length);
  for (let i = 0; i < n; i++) {
    const m = marks[i];
    arr[i].set(m.x, m.y, m.r, m.type + Math.min(0.99, Math.max(0, m.seed)) * 0.99);
  }
  uni.uMarkN.value = n;
}

/** GLSL: needs NOISE (hash12, vnoise, fbm, voronoiEdge) above it; uniforms uDamage, uSeed declared by the block shader */
export const DECAL_GLSL = /* glsl */ `
#define MAXM ${MAX_MARKS}
uniform vec4 uMarks[MAXM]; uniform float uMarkN; uniform float uCrackK;
float segDist(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0); return length(p - a - ab * t); }
/* marks and cracks over the block's own pattern; px = metres per pixel; horiz = grain runs along x */
vec3 blockMarks(vec3 col, vec2 p, float px, bool horiz){
  int n = int(uMarkN + 0.5);
  float crackReach = 0.0;   // 0..1: how strongly cracks show here (from nearby impacts)
  float spokes = 0.0;
  for (int i = 0; i < MAXM; i++) {
    if (i >= n) break;
    vec4 m = uMarks[i];
    float t = floor(m.w + 0.001); float sd = fract(m.w) * 97.0;
    float r = m.z;
    vec2 d = p - m.xy; float dist = length(d);
    float ang = atan(d.y, d.x);
    // ragged outline: radius wobbles with angle
    float rag = 0.78 + 0.44 * vnoise(vec2(ang * 2.2 + sd, sd));
    if (t < 1.5) {                        // crater / chip: dark broken pit, pale fresh rim
      float rr = r * rag;
      if (dist < rr) col *= 0.42 + 0.3 * smoothstep(0.0, rr, dist) + 0.12 * vnoise(p * 30.0 + sd);
      else if (dist < rr + 0.035 + px) col *= 1.18;
      col *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, px * 1.5, abs(dist - rr)));
      crackReach = max(crackReach, 1.0 - smoothstep(rr, rr * (1.8 + 5.0 * uDamage), dist));
      // radial cracks from the pit
      float u = ang * 1.114 + sd + 0.3 * vnoise(vec2(dist * 5.0, sd));
      float fu = fract(u);
      float sdist = min(fu, 1.0 - fu) * 0.8976 * dist;
      spokes = max(spokes, (1.0 - smoothstep(0.0, px * 1.2 + 0.004, sdist)) * step(rr * 0.9, dist) * (1.0 - smoothstep(rr * 1.2, rr * (1.6 + 4.0 * uDamage), dist)));
    } else if (t < 2.5) {                 // scorch: soot blot, ragged and soft
      float e = dist / r + (fbm(p * 4.0 + sd) - 0.5) * 0.7;
      float s = 1.0 - smoothstep(0.35, 1.0, e);
      col = mix(col, col * 0.2 + vec3(0.025, 0.022, 0.02), s * 0.88);
      crackReach = max(crackReach, 0.6 * (1.0 - smoothstep(r * 0.4, r * (0.9 + 2.0 * uDamage), dist)));
    } else if (t < 3.5) {                 // punched hole: clean dark core, a ring of spall
      float rr = r * (0.9 + 0.2 * vnoise(vec2(ang * 3.0 + sd, sd)));
      if (dist < rr * 0.62) col = vec3(0.045, 0.04, 0.038) + col * 0.05;
      else if (dist < rr) col *= 0.58;
      col *= 1.0 - 0.7 * (1.0 - smoothstep(0.0, px * 1.4, abs(dist - rr * 0.62)));
      crackReach = max(crackReach, 0.8 * (1.0 - smoothstep(rr, rr * (2.0 + 5.0 * uDamage), dist)));
    } else if (t < 4.5) {                 // dent: a dish lit from the top-left (dark upper-left wall, bright lower-right), bright scuff in the middle
      if (dist < r) {
        float k = dot(d / max(dist, 1e-4), normalize(vec2(-0.6, 0.8)));
        float q = dist / r;
        col *= 1.0 - 0.38 * k * smoothstep(0.15, 0.9, q);
        if (dist < r * 0.28) col = mix(col, col * 1.45 + 0.05, 0.7);
      }
      col *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, px * 1.4, abs(dist - r)));
    } else if (t < 5.5) {                 // pockmark
      float rr = r * rag;
      if (dist < rr) col *= 0.45;
      else if (dist < rr + 0.02) col *= 1.12;
    } else if (t < 6.5) {                 // bore: the channel a penetrator cut, entry to exit (next slot)
      vec2 b = (i + 1 < MAXM) ? uMarks[i + 1].xy : m.xy;
      float sd2 = segDist(p, m.xy, b);
      float w = r * (0.85 + 0.3 * vnoise(p * 9.0 + sd));
      if (sd2 < w * 0.55) col = vec3(0.05, 0.045, 0.04) + col * 0.06;
      else if (sd2 < w) col *= 0.6;
      col *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, px * 1.4, abs(sd2 - w * 0.55)));
      crackReach = max(crackReach, 0.7 * (1.0 - smoothstep(w, w * (2.2 + 4.0 * uDamage), sd2)));
    } else if (t > 7.5 && t < 8.5) {      // gouge: a glancing round's scrape along the face (to the next slot), tapering in
      vec2 b = (i + 1 < MAXM) ? uMarks[i + 1].xy : m.xy;
      vec2 ab = b - m.xy; float tt = clamp(dot(p - m.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      float sd2 = length(p - m.xy - ab * tt);
      float w = r * (0.35 + 0.65 * tt) * (0.8 + 0.4 * vnoise(p * 14.0 + sd));
      if (sd2 < w) col = mix(col * 1.3 + 0.04, col * 0.55, smoothstep(w * 0.3, w, sd2));
      col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, px * 1.3, abs(sd2 - w))) * step(0.02, tt);
    }
  }
  // cracks: a web (along the grain for timber) that spreads from the impacts as HP drops; blocks
  // without marks (fire, falls) keep the old all-over crazing
  if (uCrackK > 0.5 && (crackReach > 0.01 || uDamage > 0.02 || spokes > 0.0)) {
    vec2 cp = uCrackK > 1.5 ? (horiz ? vec2(p.x * 0.35, p.y * 4.5) : vec2(p.x * 4.5, p.y * 0.35)) : p * 2.2;
    float ve = voronoiEdge(cp + uSeed * 3.0);
    float generic = n > 0 ? step(fbm(p * 1.7 + uSeed), uDamage * 0.85 - 0.15) * 0.6 : step(fbm(p * 1.7 + uSeed), uDamage * 1.15);
    float local = crackReach * step(0.25, fbm(p * 3.1 + uSeed * 1.7) + crackReach * 0.6);
    float mask = max(generic, local);
    float crack = (1.0 - smoothstep(0.0, 0.03 + px, ve)) * mask;
    if (uCrackK < 1.5) crack = max(crack, spokes);
    col = mix(col, col * 0.25, crack);
  }
  col *= 1.0 - uDamage * 0.18;
  return col;
}
`;
