# Research notes

These notes come from surveying references for the second iteration (tech tree, campaign map, full shot control, animation and UI).

## Engine: what to take from tinwar (cktang88/tinwar)

Tinwar does not use an engine. It has three layers:

- **Canvas2D world.** The world is drawn from sprites baked once into canvases, with the baking done in workers (`groundworker.ts`, `vehicleworker.ts`) on OffscreenCanvas.
- **Raw WebGL post pass** (`src/client/postfx.ts`):
  - selective bloom (bright-pass on `0.5*(luma+max(r,g,b))`)
  - colour grade per mood
  - vignette
  - animated grain
  - a brief chromatic split on big hits
- **2D light system** (`lighting.ts`, `lightgl.ts`). Every muzzle flash, blast and fire is a short-lived light, and shadows are cast from occluders. The rule is "never an effect without a light or sound".

Decision: keep three.js as a thin WebGL layer, because Rapier and the ortho camera already work, and port those techniques onto it:

- the light pool
- grade, grain and chromatic split
- procedural WebAudio SFX recipes (`sfx.ts`, `audio.ts`)
- the strict palette from tinwar's art bible (`docs/art/STYLE.md`): ink `#1c1f26`, bone `#e2dccb`, gunmetal `#4f5560`, khaki `#b4a07a`, olive `#6c7356`, rust `#a8552e`, signal orange `#ff5a1f` for actionable or danger, gold `#ffd34d` for rewards only
- clipped-corner gunmetal plates with Barlow Condensed type

## Techniques worth reusing from the author's other repos

- **2D support and collapse.**
  - heist-sandbox has a side-on tile support check with incremental local search: `src/game/support.ts`, `collapse.ts`.
  - voxel-castle-defense has a span-limited load-path BFS (`src/world.ts:991`) and a topple-then-shatter step (`src/rigid.ts:743`).
- **AI art pipeline.** card-game's `scripts/gen-ui.ts` and `process-ui.py` generate art on a #00FF00 chroma key and remove it with a seeded flood-fill (so green inside the design survives), then despill. This repo's sprite keying uses the same idea.
- **Character animation without frame art.**
  - dead-air-game's `rig2d.js` and `anim.js`: a skeletal rig of part sprites driven by pure pose functions (walk phase, springs).
  - tinwar's `stepGait` derives the stride phase from distance actually moved.
  - heist-sandbox's `ragdoll.ts` is a Verlet ragdoll for deaths.
- **Feel.**
  - ghost-dreadnought's `feel.ts` (hit-stop, slow-mo).
  - autobattler-2's `shake3d.ts`, `shakeAt` with a distance falloff.
- **Tech trees.**
  - wego-4x's `shared/config/empire.ts`: tiered branches with exclusive forks.
  - ghost-dreadnought's `odTree.ts`: a schematic, path-locked tree screen.
- **UI direction.** dead-air-game's `docs/art/UI_DIRECTION.md` (no gradient cards; diegetic equipment panels, split-flap counters, needle gauges) and ghost-dreadnought's palette semantics.

## Military and wargame UI

- Highfleet puts its UI in the world as physical controls: knobs, levers and analogue screens that flicker under fire, described as "gothic analog". [PC Gamer](https://www.pcgamer.com/unique-action-strategy-game-highfleet-is-coming-to-early-access-this-month), [GosuNoob](https://www.gosunoob.com/?p=185074)
- Carrier Command 2 models its interface on Cold-War CRT naval displays. [speedrun.com](https://www.speedrun.com/Carrier_Command_2/news/r65gklxv), [cassette-futurism HUD trend](https://trends.daisyui.com/trend/fui-hud/)
- Into the Breach's designer would "sacrifice cool ideas for the sake of clarity every time", and the game telegraphs every enemy action in advance. [Game Developer](https://gamedeveloper.com/design/-i-into-the-breach-i-dev-on-ui-design-sacrifice-cool-ideas-for-the-sake-of-clarity-every-time-)
- Worms air strike: the arrow keys choose which side the planes come from, then you click the target. [worms2d.info](https://worms2d.info/Air_Strike), [StrategyWiki](https://strategywiki.org/wiki/Worms_2/Controls)
- Fonts (all OFL):
  - [Black Ops One](https://fontsource.org/fonts/black-ops-one/about) (stencil)
  - [Big Shoulders Stencil](https://www.serbyte.net/fonts/big-shoulders-stencil)
  - [Saira Stencil One](https://www.omnibus-type.com/?p=1507)
  - [Courier Prime](https://fonts.google.com/specimen/Courier+Prime/about) (data readouts)
  - [Special Elite](https://rigorousthemes.com/blog/best-google-fonts-that-look-like-typewriter/) (dossier flavour text)

Applied here:

- no rounded SaaS cards
- clipped corners, riveted gunmetal plates and paper dossiers
- stencil headings with typewriter data
- amber readouts on dark glass
- dial gauges for angle and velocity
- hazard stripes only for danger
- stamped labels

## Progression

- Kingdom Rush awards stars per level and spends them on per-tower upgrade trees; a full reset refunds everything. [Fandom](https://kingdomrushtd.fandom.com/wiki/Upgrades), [wikily](https://wikily.gg/kingdom-rush/upgrades)
- Polytopia raises tech costs as the empire grows, to slow snowballing. [Fandom](https://polytopia.fandom.com/wiki/Technology)
- Angry Birds gates bonus levels behind golden eggs and star totals. [Fandom](https://angrybirds.fandom.com/wiki/Golden_Egg_Levels)
- Advance Wars: Days of Ruin unlocks optional missions alongside its campaign. [Wikipedia](https://wikipedia.com/wiki/Advance_Wars:_Days_of_Ruin)

Applied here:

- a campaign map where each cleared node opens one or two more, so several missions are always open to pick from
- some nodes are gated by total stars
- war funds buy nodes in five tech branches, and researching is reversible
- dev mode unlocks every map and every technology

## 2D skeletal animation

- Spine needs a paid licence to ship ([licence](https://eu.esotericsoftware.com/spine-runtimes-license)).
- Rive's runtimes are MIT-licensed, but authoring needs its browser editor ([Rive runtimes](https://rive.app/runtimes)).
- DragonBones runtimes are MIT-licensed but largely abandoned ([ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2FDragonBones%2FDragonBonesJS)).
- [rembg](https://pypi.org/project/rembg/2.0.74/) does background removal well. SAM alone segments without regard to body structure ([SegAnimeChara](https://graphics.cmlab.csie.ntu.edu.tw/~robin/docs/poster23_tseng.pdf)) and needs pose priors.
- The approach that can be scripted end to end:
  1. generate the character in a clear side pose
  2. chroma-key it out
  3. cut the parts with per-part polygon masks plus pivot JSON
  4. build a bone hierarchy in three.js
  5. animate it with procedural pose functions
