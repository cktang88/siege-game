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
2. **Research.** War funds come from missions (more for new stars and first clears). Spend them across five branches: Ordnance, Gunnery, Air Wing, Special Ops and Logistics. Research unlocks munitions and upgrades muzzle velocity, reload, elevation, trajectory preview, wind readout, gun armour, bomb loads, dive bombing, bomb types, drone endurance, saboteur teams and budgets. Refunds are free.
3. **Armory.** Buy rounds within the mission budget. Unspent money and unfired rounds count toward your score. **Survey** lets you hover blocks to read their material and HP.
4. **Battle.** Every shot is fully controllable:
   - **Gun:** set elevation (degrees) and muzzle velocity (m/s). Drag on the field like a sling, drag the needles on the quadrant and gauge, type exact values, or step by ±0.1 / ±1. Arrow keys also adjust (hold Shift for fine steps). The delayed fuse and the cluster airburst have their own timers.
   - **Air strike:** set the approach (from west or east), release altitude, dive angle (needs Dive Bombing research), drop interval and ordnance (GP, firebombs or AP bombs). Click the field to set the aim point. The bomb run is solved against gravity and wind, and the preview draws the flight path, release points and predicted impacts. Fly too low or too steep and the bomber hits the ground.
   - **Drone and saboteur:** click the field to choose where the drone loiters or where the team plants its charge.
5. **Win** by destroying every ◆ objective. Stars come from time against par, budget left over, secondary targets, gun condition and collateral damage.

**Dev mode:** the `Dev` button on the map, or `?dev` in the URL, opens every castle and every technology. It also adds 12 procedurally generated proving grounds and an unlimited-budget toggle in the armory.

Keys: `Space` fires (or triggers the in-flight special), `1`–`9` pick a munition, the mouse wheel zooms, right-drag pans, `R` resets the view and `M` mutes.

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

## The enemy fights back

- **Counter-battery gun:** fires at your cannon, with each shot landing closer (bracketing). Silence it or blind it with smoke.
- **Barracks:** sends infantry at your gun. Destroy it to stop reinforcements.
- **Engineers:** repair damaged blocks and rebuild destroyed wall sections, so waiting costs you.
- **Flak:** shoots down bombers and drones.
- **Munitions store:** detonates in a chain reaction when destroyed or burned.

## Structures

Every block is a Rapier rigid body with a material (timber, masonry, reinforced concrete, armor plate, reactive armor, firebrick, munitions). Each material has its own HP, density and modifiers against kinetic, blast, fire and penetration damage. Fortresses stand on real support, so taking out a load-bearing column drops whatever it holds up. Falling debris deals impact damage, explosions are occluded by intervening walls, and some armor is disguised until you scout it.

## Castles

There are 4 hand-built fortresses and a seeded generator (`src/fortgen.ts`). The generator builds stable fortresses from modules: towers, halls, concrete bunkers, firebrick vaults, sheds, front walls with optional disguised reactive skirts, and double walls. It takes a theme (timber, stone, concrete or mixed) and a difficulty.

### Great fortresses

The late campaign (Kestrel Bastille, Castle Ironcrown, Wardenhold, The Black Citadel) uses `src/grandgen.ts`. These castles have 40 to 84 rooms each. Each one has:

- a curtain wall (double at high difficulty, with a disguised reactive skirt)
- a gatehouse and a bailey with barracks and workshops
- an inner curtain
- gun towers
- one or two multi-storey keeps

Every building is a post-and-lintel grid. Each room's floor slab spans from the centre of one column to the centre of the next, so knocking out a column lets the floors above fold down storey by storey. Rooms have cutaway back walls that crumble once their frame fails.

On castles this size the overview covers the gun and the near works. To see the rest, use the minimap (click or drag it), the mouse wheel, or right-drag.

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
