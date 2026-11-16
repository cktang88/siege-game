# Siege

A 2D side-view physics siege game. You plan an armament within a budget, then bring a fortress down while it fights back.

Built with Vite, TypeScript, Three.js (orthographic camera, custom cel-shading GLSL, bloom) and Rapier2D physics.
The concept notes are in `docs/`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check and production build into dist/
```

## How to play

1. **Operations map.** Each cleared operation opens one or two neighbouring ones, so a few are always available. Some deep operations also need a total star count. Select a node to read its dossier.
2. **Research.** War funds come from missions: a first clear, each new star, and any score above your previous best pay out. Replaying for the same result pays nothing; a failed attempt pays a little salvage for objectives knocked out beyond your best previous attempt. Spend them across five branches: Ordnance, Gunnery, Air Wing, Special Ops and Logistics. Research unlocks munitions and upgrades muzzle velocity, reload, elevation, trajectory preview, wind readout, gun armour, bomb loads, dive bombing, bomb types, drone endurance, saboteur teams and budgets. Click an owned card to refund it (the top of a branch first), or refund everything at once. Refunds are free.
3. **Armory.** Buy rounds within the mission budget. Unspent money and unfired rounds count toward your score. **Survey** lets you hover blocks to read their material and HP.
4. **Battle.** Every shot is fully controllable:
   - **Gun:** set elevation (degrees) and muzzle velocity (m/s). The barrel follows the mouse over the battlefield and a click fires; the mouse wheel sets muzzle velocity (Shift for coarse steps). You can also drag the needles on the quadrant and gauge, type exact values, or step by ±0.1 / ±1. Arrow keys adjust too (hold Shift for fine steps). `T` (or the *Mouse aim* switch) turns mouse aiming off when you want typed values to stay put. The delayed fuse and the cluster airburst have their own timers.
   - **Air strike:** set the approach (from west or east), release altitude, dive angle (needs Dive Bombing research), drop interval and ordnance (GP, firebombs or AP bombs). Click the field to set the aim point. The bomb run is solved against gravity and wind, and the preview draws the flight path, release points and predicted impacts. Fly too low or too steep and the bomber hits the ground.
   - **Drone and saboteur:** click the field to choose where the drone loiters or where the team plants its charge.
5. **Win** by destroying every ◆ objective. Stars come from time against par, budget left over, secondary targets, gun condition and collateral damage.

**Dev mode:** the `Dev` button on the map, or `?dev` in the URL, opens every castle and every technology for the current browser session. Dev mode is never written to the save, and dev battles pay no funds and record no stars. It also adds 12 procedurally generated proving grounds and an unlimited-budget toggle in the armory.

Keys: `Space` fires (or triggers the in-flight special), `1`–`9` pick a munition, the mouse wheel sets velocity (zooms outside battle), `Ctrl`+wheel or `Q`/`E` zoom, any drag pans, `R` resets the view, `T` toggles mouse aim and `M` mutes. Shortcuts are ignored while you type in a number field.

## Munitions (15)

| Round | Use it for | Countered by |
|---|---|---|
| Round Shot | cheap knockdowns | armor |
| Heavy Shell | shoving pillars and towers over | reactive armor |
| Armor-Piercing | punching through several masonry blocks to inner rooms | armor plate, reactive armor |
| High Explosive | masonry, timber, troops | concrete, double walls (blast is occluded by the first wall) |
| Incendiary | timber forts and munitions stores; fire spreads | firebrick vaults |
| Bunker Buster | penetrating concrete, then detonating inside | reactive armor (premature detonation) |
| Cluster Shell | scatters bomblets: tap in flight, or set an airburst timer | single hard points |
| Delayed Fuse | bouncing or rolling into rooms; blows 3 s after impact | — |
| Sticky Charge | gluing onto pillars; too slow to set off reactive armor | wind |
| Burrowing Drill | landing short, tunnelling forward and blowing the foundations from below | high targets |
| Canister Shot | shredding infantry | buildings |
| Smoke Screen | blinding enemy guns for 15 s | — |
| Scout Drone | revealing disguised armor, true HP and load-bearing members | flak |
| Saboteur | running in to plant a charge at the wall base | enemy infantry |
| Air Strike | a planned bomb run: heading, altitude, dive, interval, ordnance | flak |

Castles stand on hills, 3.5–11 m above the plain depending on the operation (star forts hug the ground), so most shots go level or upward; the gun is re-placed per level so every objective stays in range at the muzzle velocity you're expected to have there. Your gun sits on a raised earthen redoubt, about 3.5 m up. Elevation goes down to −30°, so you can fire down on infantry that halt at the foot of the slope. Canister pellets each pass through up to two men, and solid shot (round shot, heavy shell) ploughs through a whole file. In the armory, press and hold + or − to keep buying or selling.

## The enemy fights back

- **Mooring masts:** launch Storm Winds-style air raids: weaving gyrocopter gunships that strafe your gun, and armoured airships that bomb it. Shot-down aircraft fall burning and crash, onto the castle if they're over it. Answer them with **Flak Burst** shells (research *Proximity Fuzes*), which burst when an aircraft comes near or on a timer you set. Canister and other rounds hit them too.
- **Garrison:** soldiers pace the rooms among era-appropriate furniture: banners, bunks, weapon racks, cauldrons, war tables and field radios. They ride their floors, fall when a room fails, and die to blasts, falling masonry, long falls and fire. Casualties are scored.

- **Counter-battery gun:** fires at your cannon, with each shot landing closer (bracketing). Silence it or blind it with smoke.
- **Barracks:** sends infantry at your gun. Destroy it to stop reinforcements.
- **Engineers:** repair damaged blocks and rebuild destroyed wall sections, so waiting costs you.
- **Flak:** shoots down bombers and drones.
- **Munitions store:** detonates in a chain reaction when destroyed or burned.

## Structures

Every block is a Rapier rigid body with a material (timber, masonry, reinforced concrete, armor plate, reactive armor, firebrick, munitions). Each material has its own HP, density and modifiers against kinetic, blast, fire and penetration damage. Fortresses stand on real support, so taking out a load-bearing column drops whatever it holds up. Falling debris deals impact damage, explosions are occluded by intervening walls, and some armor is disguised until you scout it.

## Castles and structures

Blocks can be any convex polygon: wedges, trapezoids, roofs, rotated beams and arch voussoirs. Slope matters:

- Shells and penetrators lose effectiveness as 1/cos(obliquity).
- Past the critical angle they ricochet: steel at ~56°, concrete at ~65°.
- Low, flat shots skip off a sloped glacis. High plunging fire, air-dropped AP bombs or bunker busters get through.

Materials include earthworks (soak up blast), clay roof tiles, plaster over timber (burns) and volatile fuel tanks (chain-explode).

Castles are built tall rather than deep, and each stops at its keep so every objective is in range. The gun is placed per level so every target is reachable, against the worst headwind, by the muzzle velocity the player can have at that point of the campaign: 30 m/s for the open operations, 36 m/s (Double Charge) behind the first star gates, 44 m/s (Cordite Charges) for Ironcrown, Wardenhold and the Black Citadel. `node scripts/level-stability.cjs` (with the dev server on port 5184) loads every level, lets it stand for 10 s and lists anything that moved. Columns thin with height, as bergfried and donjon walls do, and keeps step narrower above about 60% of their height, like butter-churn towers. Slender bergfrieds rise 8–12 storeys under guns or spires.

Real-structure archetypes live in `src/archetypes.ts`. Proportions and sources are in `docs/RESEARCH.md`.

| Operation | Built from |
|---|---|
| Kurogane-jō | ishigaki fan-slope stone base, five-tier tenshu (each tier ~80% of the one below) with flared tile eaves, yagura turrets |
| Saltworks Refinery | fuel tanks, pipe racks, cracking column, brick stack, concrete-arch airship hangar with a cigar-shaped airship |
| Fort Sainte-Barbe | glacis, ditch, masonry escarp, earth rampart and parapet, buried vaulted magazine |
| St. Aldric's Abbey | arcade of arches, end buttresses, flying buttresses on pinnacled piers, bell-tower spire |
| Battery Greywater | dragon's teeth, hedgehogs, Regelbau casemates under earth berms, steel-glacis command bunker |
| Harrowgate Castle | moat, battered curtains with machicolations, twin-towered gatehouse with arch and portcullis, hoarded tower keep |
| Zoo Flak Tower | a squat four-bay, seven-storey concrete frame (the real tower was ~70 m square, ~39 m tall) with cantilevered corner gun tubs |
| Kestrel Bastille | concentric castle with moat, gatehouse, bailey, inner curtain, gun towers and a five-storey great keep (47 rooms) |
| Wardenhold | obstacle belts, casemates, earth rampart, flak tower, armoured bunker and refinery (24 rooms) |

There are also 4 hand-built fortresses and a seeded modular generator (`src/fortgen.ts`).

### Great fortresses

The late campaign (Kestrel Bastille, Castle Ironcrown, Wardenhold, The Black Citadel) uses `src/grandgen.ts`. These castles have 40 to 84 rooms each. Each one has:

- a curtain wall (double at high difficulty, with a disguised reactive skirt)
- a gatehouse and a bailey with barracks and workshops
- an inner curtain
- gun towers
- one or two multi-storey keeps

Every building is a post-and-lintel grid. Each room's floor slab spans from the centre of one column to the centre of the next, so knocking out a column lets the floors above fold down storey by storey. Rooms have cutaway back walls that crumble once their frame fails.

On castles this size the overview covers the gun and the near works. To see the rest, use the minimap (click or drag it), Ctrl+wheel or Q/E to zoom, or drag the field.

## Look and sound

The rendering techniques are ported from [tinwar](https://github.com/cktang88/tinwar) onto three.js:

- every blast, muzzle flash, tracer and fire is a short-lived point light with cel-stepped falloff
- selective bloom, a colour grade, animated grain, and a chromatic split on big hits

Infantry use a cut-out rig: the upper body is segmented from the generated sprite, and the rigged legs follow a gait driven by distance moved.

All sound is procedural WebAudio, in tinwar's recipe style: layered tone and noise sweeps through a glue compressor and limiter, with distance falloff and pan. A small D-minor march score builds with the fighting.

## Art

Sprites, the backdrop, the operations map, textures, branch insignia and munition icons are toon cel-shaded images generated through OpenRouter (`google/gemini-2.5-flash-image`):

```bash
OPENROUTER_API_KEY=... node scripts/gen-sprites.mjs [name ...]   # world sprites → public/sprites/raw/
python3 scripts/process-sprites.py                               # key, trim, downscale → public/sprites/
OPENROUTER_API_KEY=... node scripts/gen-ui.mjs [name ...]        # UI art → public/ui/raw/
python3 scripts/process-ui.py                                    # border-sampled flood-fill key, despill → public/ui/
```

Blocks, terrain, particles, debris and soldier legs are drawn procedurally. Research notes and sources are in `docs/RESEARCH.md`.
