// Generates toon cel-shaded sprites via OpenRouter image models.
// Usage: OPENROUTER_API_KEY=... node scripts/gen-sprites.mjs [name ...]
// Sprites are requested on a flat magenta background; the game chroma-keys it at load time.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
const MODEL = process.env.SPRITE_MODEL || 'google/gemini-2.5-flash-image';
const OUT = path.resolve('public/sprites/raw');

const STYLE = 'Toon cel-shaded game art, clean bold dark outlines, 2-3 flat shading bands, muted grounded military palette, ' +
  'serious tone, NOT comic, NOT cartoony-goofy, no text, no watermark, single isolated object centered, ' +
  'side view facing right, on a perfectly flat solid pure magenta (#FF00FF) background with no shadow on the ground.';

const SPRITES = {
  airship: `A steampunk military airship (rigid zeppelin) with a riveted gondola, propellers and gun turrets, seen from the side, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  gyro: `A small steampunk gyrocopter gunship with a single rotor, pilot and machine gun, seen from the side, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  mast: `A tall steel lattice airship mooring mast with a small winch house at the base and a mooring cone at the top, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_barrel: `A single wooden powder barrel with iron hoops, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_table: `A heavy wooden war-room table with a map and a lantern on it, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_bunk: `A simple military wooden bunk bed with grey blankets, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_rack: `A wooden weapon rack holding rifles and a sword, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_banner: `A hanging heraldic war banner, deep navy blue with a golden eagle, on a pole. ${STYLE.replace('side view facing right, ', '')}`,
  p_shells: `A stack of artillery shells in a wooden cradle, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_radio: `A WW2 field radio set on a small table with a headset, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_cauldron: `An iron cooking cauldron on a tripod over a small fire, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_shelf: `A tall wooden shelf with sacks, jars and crates of supplies, side view. ${STYLE.replace('side view facing right, ', '')}`,
  p_cannon: `A small bronze fortress cannon on a wooden garrison carriage, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  carriage: `An empty wooden siege-cannon carriage with two large spoked wheels and a trail, WITHOUT any barrel or gun tube. ${STYLE}`,
  barrel: `A single long black iron cannon barrel (gun tube) lying perfectly horizontal, muzzle pointing right, no carriage, no wheels. ${STYLE}`,
  soldier: `A single infantry soldier walking, helmet, grey-green uniform, rifle, full body, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  plane: `A 1940s twin-propeller bomber airplane seen from the side, olive drab. ${STYLE}`,
  saboteur: `A crouching commando saboteur in dark clothes carrying a satchel charge, running, full body. ${STYLE}`,
  drone: `A small quadcopter scout drone, dark grey with a camera, side view. ${STYLE}`,
  house: `A small humble village cottage with a tiled roof, chimney and a window, front view. ${STYLE.replace('side view facing right, ', '')}`,
  background: 'Wide panoramic 2D game background, toon cel-shaded painterly style, NOT comic, a muted dusk sky with soft layered clouds, ' +
    'distant blue-grey mountain silhouettes, rolling hills, no buildings, no characters, no text, flat ground band along the bottom, 16:9.',
};

async function gen(name) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content: SPRITES[name] }] }),
  });
  const j = await res.json();
  const url = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`${name}: no image in response: ${JSON.stringify(j).slice(0, 300)}`);
  const m = url.match(/^data:image\/(\w+);base64,(.*)$/);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  await fs.writeFile(path.join(OUT, `${name}.${ext}`), Buffer.from(m[2], 'base64'));
  console.log('wrote', name, ext);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPRITES);
await fs.mkdir(OUT, { recursive: true });
await Promise.all(names.map((n) => gen(n).catch((e) => console.error(e.message))));
