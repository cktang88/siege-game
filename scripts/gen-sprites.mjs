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

const OBJ = 'Composition wider than tall, a group of objects standing on one flat floor line, seen exactly from the side (straight-on elevation, no top-down, no three-quarter view), filling the frame edge to edge, no room walls, no floor, no background scenery.';

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
  carriage: `An EMPTY wooden artillery gun carriage (a split-trail field carriage) with two large spoked wheels: just the wooden cheeks, axle and trail with an empty curved cradle on top. Absolutely NO cannon, NO barrel, NO gun tube, nothing resting in the cradle. ${STYLE}`,
  barrel: `A single long black iron cannon barrel (gun tube) lying perfectly horizontal, muzzle pointing right, no carriage, no wheels. ${STYLE}`,
  armoredcar: `A 1940s four-wheeled military armoured car: a low angular riveted steel hull with a sloped nose plate, a small round turret with a machine gun pointing left, four big black rubber tyres, dark olive-grey steel, full vehicle seen exactly from the side, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  tank: `A 1940s light tank: a long low hull with a very sloped front glacis plate, a small cast turret with a short main gun pointing left, tracks over five road wheels, dark olive-grey steel, full vehicle seen exactly from the side, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  soldier: `A single infantry soldier walking, helmet, grey-green uniform, rifle, full body, facing left. ${STYLE.replace('facing right', 'facing left')}`,
  // armless torsos for the repair crew's rig (src/engrig.ts draws and animates the arms)
  eng_med: `Upper body only (head to belt) of a medieval castle mason / military engineer in strict side profile facing left: a padded leather arming cap, a rough brown wool tunic with a leather work apron, a leather tool satchel on the hip. IMPORTANT: draw NO arms at all (armless torso, the sleeves are cut off at the shoulder, like a paper cut-out doll body without arms). ${STYLE.replace('facing right', 'facing left')}`,
  eng_mod: `Upper body only (head to belt) of a 1940s army combat engineer (sapper) man in strict side profile facing left, his head and face with a stern expression clearly visible under a steel helmet with chin strap, grey-green field jacket with rolled collar, webbing belt with a canvas tool pouch. IMPORTANT: draw NO arms at all (armless torso, like a paper cut-out doll body without arms). ${STYLE.replace('facing right', 'facing left')}`,
  // the machine-gun post on the redoubt (src/mg.ts draws the tripod / trestle and turns the gun on it)
  mg_gun: `A single WW1 Vickers heavy machine gun WITHOUT any tripod, mount or shoulder stock: a rectangular steel receiver box with two spade grips at the back end, a long fat cylindrical ribbed water-cooling jacket around the barrel ending in a conical muzzle booster pointing right, a short canvas cartridge belt hanging below the receiver. Lying perfectly horizontal. Dark gunmetal with brass fittings. ${STYLE}`,
  rib_gun: `A medieval ribauldequin volley gun WITHOUT wheels or cart: five long thin black wrought-iron gun tubes (each about ten times longer than wide, open muzzle at the right end, a small touch-hole and a rounded breech at the left end) stacked one above another on a thick oak plank and bound to it with iron straps, muzzles pointing right, lying perfectly horizontal, seen exactly from the side. ${STYLE}`,
  mg_nest: `A low curved WW1 machine-gun nest wall of stacked hessian sandbags, three courses high, about four sandbags long, khaki and tan, seen exactly from the side, no gun, no people. ${STYLE.replace('side view facing right, ', '')}`,
  mg_mantlet: `A low medieval field fortification: two round wicker gabions filled with earth beside a short slanted wooden mantlet of oak planks, seen exactly from the side, no weapon, no people. ${STYLE.replace('side view facing right, ', '')}`,
  // objective dressings drawn on the objective block's face (src/objgfx.ts): a wide shallow vignette, about 16:10,
  // showing what the block is at the scale of a room's contents (a block is ~1-3 m wide, ~1-1.5 m tall)
  obj_hq_mod: `${OBJ} A 1940s army command post: a wide heavy wooden map table covered with spread-out paper maps and charts with pins, a field telephone in a leather case and a green field radio set with a hand microphone on the table, a hooded green desk lamp lit, a small folding stool. ${STYLE.replace('side view facing right, ', '')}`,
  obj_hq_med: `${OBJ} A medieval castle war council table: a wide heavy oak trestle table with a parchment map unrolled across it, held down by a dagger and an iron candlestick with lit candles, a small wooden chest, and at one end of the table a short pole with a small deep red heraldic war banner, the pole no taller than twice the table. ${STYLE.replace('side view facing right, ', '')}`,
  obj_ammo_mod: `${OBJ} A 1940s munitions store: a low wide stack of olive-green wooden ammunition crates with rope handles and plain yellow stencil stripes (no letters), and beside them a rack of brass artillery shells standing upright, a few shells lying in a cradle on top. ${STYLE.replace('side view facing right, ', '')}`,
  obj_ammo_med: `${OBJ} A medieval castle powder store: several wooden gunpowder kegs with iron hoops stacked two rows high, one keg marked with a plain painted black band, and beside them a neat pyramid of black iron cannonballs on a wooden pallet, a coil of slow match on a hook. ${STYLE.replace('side view facing right, ', '')}`,
  obj_eng_mod: `${OBJ} A compact 1940s army engineers' workshop corner, about 3:2, everything tightly grouped: a heavy wooden workbench with a steel vice and tools on it, behind and above it a wall board of hanging spanners and saws, a tall stack of sawn timber planks leaning on one side, sandbags under the bench, and a small steel A-frame chain hoist with a hook at the other end, as tall as the timber. ${STYLE.replace('side view facing right, ', '')}`,
  obj_eng_med: `${OBJ} A medieval castle carpenters' and masons' workshop: a heavy oak workbench with mallets, chisels, an axe and a bow saw, a stack of squared timber beams and cut stone blocks, burlap sacks, a small wooden hand winch with rope and hook on a timber frame at one end. ${STYLE.replace('side view facing right, ', '')}`,
  obj_bar_mod: `${OBJ} A compact 1940s army barracks corner, about 3:2, everything tightly grouped: one two-tier steel bunk bed with grey-green wool blankets and pillows, canvas kit bags and a steel helmet on the floor beside it, and a wooden rifle rack holding four bolt-action rifles standing upright next to it, as tall as the bunk. ${STYLE.replace('side view facing right, ', '')}`,
  obj_bar_med: `${OBJ} A compact medieval castle barracks corner, about 3:2, everything tightly grouped: one two-tier heavy wooden bunk with straw pallets and rough brown wool blankets, a wooden chest at its foot, and a tall weapon rack with spears and halberds standing upright next to it with a round wooden shield leaning on it. ${STYLE.replace('side view facing right, ', '')}`,
  obj_flak_mod: `${OBJ} A 1940s twin-barrel anti-aircraft gun on a low round steel pedestal mount with hand wheels and a gunner's seat, the two long barrels raised steeply toward the upper left sky, ready racks of clip-loaded shells around the base, a low sandbag ring in front. ${STYLE.replace('side view facing right, ', '')}`,
  obj_flak_med: `${OBJ} A medieval springald (great torsion crossbow) on a heavy timber platform, its long bolt and arms tilted steeply up toward the upper left sky, a rack of long iron-tipped bolts and a windlass beside it. ${STYLE.replace('side view facing right, ', '')}`,
  obj_gun_mod: `${OBJ} The breech end of a heavy 1940s fortress gun on a steel pedestal mount with elevation and traverse hand wheels, its thick barrel running out horizontally to the left and cut off cleanly at the left edge of the image, a riveted steel recoil cradle, a ready rack of brass shells and a rammer staff beside it. ${STYLE.replace('side view facing right, ', '')}`,
  obj_gun_med: `${OBJ} The rear end of a big medieval bombard (wrought-iron siege cannon with iron hoops) lying on a massive oak bed with wooden wedges, its barrel running out horizontally to the left and cut off cleanly at the left edge of the image, a pile of stone cannonballs, a rammer and a powder ladle beside it. ${STYLE.replace('side view facing right, ', '')}`,
  obj_depot: `${OBJ} A military motor pool supply corner: a stack of steel fuel drums, several jerrycans, a stack of spare truck tyres, a spare spoked wheel, a mechanic's tool chest and a small chain hoist frame with an engine block hanging from it. ${STYLE.replace('side view facing right, ', '')}`,
  plane: `A 1940s twin-propeller bomber airplane seen from the side, olive drab. ${STYLE}`,
  saboteur: `A crouching commando saboteur in dark clothes carrying a satchel charge, running, full body. ${STYLE}`,
  drone: `A small quadcopter scout drone, dark grey with a camera, side view. ${STYLE}`,
  house: `A small humble village cottage with a tiled roof, chimney and a window, front view. ${STYLE.replace('side view facing right, ', '')}`,
  background: 'Wide panoramic 2D game background, toon cel-shaded painterly style, NOT comic, a muted dusk sky with soft layered clouds, ' +
    'distant blue-grey mountain silhouettes, rolling hills, no buildings, no characters, no text, flat ground band along the bottom, 16:9.',
};

async function gen(arg) {
  // 'name@tag' generates another candidate of 'name' into raw/name@tag.* (pick one, rename it to name.* before processing)
  const name = arg.split('@')[0];
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content: SPRITES[name] }] }),
  });
  const j = await res.json();
  const url = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`${arg}: no image in response: ${JSON.stringify(j).slice(0, 300)}`);
  const m = url.match(/^data:image\/(\w+);base64,(.*)$/);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  await fs.writeFile(path.join(OUT, `${arg}.${ext}`), Buffer.from(m[2], 'base64'));
  console.log('wrote', arg, ext);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPRITES);
await fs.mkdir(OUT, { recursive: true });
await Promise.all(names.map((n) => gen(n).catch((e) => console.error(e.message))));
