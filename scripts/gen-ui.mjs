// Generates UI art (campaign map, textures, insignia, munition icons) through OpenRouter.
// Icons are requested on flat #00FF00 and keyed out by scripts/process-ui.py (seeded flood fill,
// the same approach as cktang88/card-game scripts/process-ui.py).
// Usage: OPENROUTER_API_KEY=... node scripts/gen-ui.mjs [name ...]
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
const MODEL = process.env.UI_MODEL || 'google/gemini-2.5-flash-image';
const OUT = path.resolve('public/ui/raw');

const ICON = 'Single game UI icon, toon cel-shaded with bold dark ink outline, 2-3 flat shading bands, muted military palette ' +
  '(olive, gunmetal, brass, rust), serious tone, not cartoony, no text, no letters, no numbers, centered with generous margin, ' +
  'on a perfectly flat solid pure green (#00FF00) background, no shadow, no border.';
const shell = (d) => `${ICON} Subject: ${d}, drawn lying diagonally pointing up-right.`;

const JOBS = {
  map: 'Top-down hand-drawn military operations map on aged cream paper, WW1/WW2 staff-officer style: contour lines, ' +
    'a winding river, forests drawn as stippled clusters, hills hatched in sepia ink, faint grid squares, coffee stains, folded creases, ' +
    'muted sepia, olive and faded blue ink, NO text, NO labels, NO letters, NO arrows, wide 16:9 landscape, flat lit, full bleed.',
  paper: 'Seamless tileable texture of aged cream manila paper with subtle fibers and faint stains, flat lit, no text, no objects, full bleed square.',
  metal: 'Seamless tileable texture of worn dark gunmetal painted steel plate, subtle scratches and chipped olive-grey paint, flat even lighting, no rivets, no text, full bleed square.',
  ins_ordnance: `${ICON} Subject: military insignia badge of a crossed pair of artillery shells over a flaming bomb.`,
  ins_gunnery: `${ICON} Subject: military insignia badge of a crossed pair of cannon barrels with a crosshair.`,
  ins_air: `${ICON} Subject: military insignia badge of pilot wings with a falling bomb in the middle.`,
  ins_special: `${ICON} Subject: military insignia badge of a commando dagger with a parachute.`,
  ins_logistics: `${ICON} Subject: military insignia badge of a supply crate and a gear wheel.`,
  am_shell: shell('a plain round black iron cannonball'),
  am_heavy: shell('a huge heavy dark iron artillery slug'),
  am_ap: shell('a long slim armor-piercing artillery shell with a sharp hardened brass tip'),
  am_he: shell('a high-explosive artillery shell painted olive with a red band and a fuze nose'),
  am_incendiary: shell('an incendiary artillery shell with an orange band and a small flame at the nose'),
  am_bunker: shell('a long heavy bunker-buster penetrator bomb with tail fins, dark grey'),
  am_cluster: shell('a cluster shell casing opening and releasing small bomblets'),
  am_delayed: shell('an artillery shell with a clockwork timer fuze on the nose'),
  am_sticky: shell('a sticky grenade charge: a round charge wrapped in tar-black cloth with a handle'),
  am_drill: shell('a drilling projectile with a spiral auger drill bit nose, brass and steel'),
  am_canister: shell('a tin canister shot casing spilling small lead balls'),
  am_smoke: shell('a grey smoke shell trailing white smoke'),
  am_flak: shell('an anti-aircraft flak shell with a brass proximity fuze nose and a black-and-yellow band'),
  am_drone: `${ICON} Subject: a small military quadcopter scout drone with a camera, side view.`,
  am_saboteur: `${ICON} Subject: a satchel demolition charge with a coiled detonator wire and a plunger.`,
  am_airstrike: `${ICON} Subject: a twin-engine bomber silhouette seen from above with bombs falling.`,
};

async function gen(name) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content: JOBS[name] }] }),
  });
  const j = await res.json();
  const url = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`${name}: no image: ${JSON.stringify(j).slice(0, 200)}`);
  const m = url.match(/^data:image\/(\w+);base64,(.*)$/);
  await fs.writeFile(path.join(OUT, `${name}.png`), Buffer.from(m[2], 'base64'));
  await fs.writeFile(path.join(OUT, `${name}.prompt.txt`), JOBS[name]);
  console.log('wrote', name);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(JOBS);
await fs.mkdir(OUT, { recursive: true });
for (let i = 0; i < names.length; i += 6) await Promise.all(names.slice(i, i + 6).map((n) => gen(n).catch((e) => console.error(e.message))));
