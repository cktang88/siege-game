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

1. **Armory.** Each mission has a budget. Read the briefing and intel, survey the fortress (hover blocks to see their material and HP), then buy rounds. Unspent money and unfired rounds count toward your score.
2. **Battle.** Drag anywhere and release to fire, pulling back like a slingshot. Use the arrow keys to fine-tune (hold Shift for small steps) and Space to fire. Keys 1–9 pick ammo. In flight, tap or press Space to trigger a round's special ability. The mouse wheel zooms, right-drag pans and R resets the view.
3. **Win** by destroying every objective target (marked ◆). You lose if your cannon is destroyed or you run out of ammo. Stars come from time against par, budget left over, optional targets destroyed, your cannon's condition, and collateral damage.

The preview shows only the start of the trajectory. Wind and drop are left for you to read, and a dashed line shows your last shot.

## Munitions (15)

| Round | Use it for | Countered by |
|---|---|---|
| Round Shot | cheap knockdowns | armor |
| Heavy Shell | shoving pillars and towers over | reactive armor |
| Armor-Piercing | punching through several masonry blocks to inner rooms | armor plate, reactive armor |
| High Explosive | masonry, timber, troops | concrete, double walls (blast is occluded by the first wall) |
| Incendiary | timber forts and munitions stores; fire spreads | firebrick vaults |
| Bunker Buster | penetrating concrete, then detonating inside | reactive armor (premature detonation) |
| Cluster Shell | tap in flight to scatter 8 bomblets | single hard points |
| Delayed Fuse | bouncing or rolling into rooms; blows 3 s after impact | — |
| Sticky Charge | gluing onto pillars; too slow to set off reactive armor | wind |
| Burrowing Drill | landing short, tunnelling forward and blowing the foundations from below | high targets |
| Canister Shot | shredding infantry | buildings |
| Smoke Screen | blinding enemy guns for 15 s | — |
| Scout Drone | revealing disguised armor, true HP and load-bearing members | flak |
| Saboteur | running in to plant a charge at the wall base | enemy infantry |
| Air Strike | a stick of 5 bombs on the spot you click | flak |

## The enemy fights back

- **Counter-battery gun:** fires at your cannon, with each shot landing closer (bracketing). Silence it or blind it with smoke.
- **Barracks:** sends infantry at your gun. Destroy it to stop reinforcements.
- **Engineers:** repair damaged blocks and rebuild destroyed wall sections, so waiting costs you.
- **Flak:** shoots down bombers and drones.
- **Munitions store:** detonates in a chain reaction when destroyed or burned.

## Structures

Every block is a Rapier rigid body with a material (timber, masonry, reinforced concrete, armor plate, reactive armor, firebrick, munitions). Each material has its own HP, density and modifiers against kinetic, blast, fire and penetration damage. Fortresses stand on real support, so taking out a load-bearing column drops whatever it holds up. Falling debris deals impact damage, explosions are occluded by intervening walls, and some armor is disguised until you scout it.

## Art

Sprites and the backdrop are toon cel-shaded images generated through OpenRouter (`google/gemini-2.5-flash-image`):

```bash
OPENROUTER_API_KEY=... node scripts/gen-sprites.mjs [name ...]   # writes public/sprites/raw/
python3 scripts/process-sprites.py                               # chroma-key, trim, downscale into public/sprites/
```

Blocks, terrain, particles and debris are drawn procedurally in shaders.
