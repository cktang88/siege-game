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

## Real structures and sloped armour (third iteration)

"Stormwinds" did not match any game or aircraft. The closest are [Stormworks: Build and Rescue](https://en.wikipedia.com/wiki/Stormworks:_Build_and_Rescue) and a Roblox build-a-plane game ([roblox](https://www.roblox.com/games/112395180136815)). Stormworks builders favour faceted wedge-on-box hulls ([Steam discussion](https://steamcommunity.com/app/573090/discussions/0/2266942281798999360)), which is the look of the convex-polygon blocks here.

The archetype proportions below come from these sources. Where a number has no source it is a game heuristic, and it says so.

- **Talus / batter.** A sloped skirt at the wall foot. It defeated sapping and ladders and kicked dropped objects outward ([Wikipedia](https://en.wikipedia.org/wiki/Talus_(fortification))). Here it covers the bottom ~30% of the wall at ~70° (heuristic).
- **Hoardings and machicolations.** Hoardings are timber galleries projecting from the wall head; machicolations are the stone version on corbels ([Britannica](https://www.britannica.com/technology/battlement), [castlesandmanorhouses](https://www.castlesandmanorhouses.com/architecture_03_walls.htm)). Both are built as inverted-trapezoid "flare" blocks.
- **Concentric castles.** At Beaumaris the inner curtain is ~11 m high and 4.7 m thick ([medievalheritage](https://medievalheritage.eu/en/main-page/heritage/wales/beaumaris-castle/)). The Harlech gatehouse has multiple portcullises and murder holes ([britishcastle](https://britishcastle.co.uk/?p=588)).
- **Vauban fronts.** The 1911 Britannica gives:
  - parapets 18 ft thick of earth
  - a ditch ~18 ft deep
  - a rampart command of 25 ft ([EB1911](https://kwx.liehendr.com/content/wikisource_en_all_maxi_2022-09/A/Page%3AEB1911_-_Volume_10.djvu/709))

  The parapet top falls outward at 1/6 ([American Cyclopaedia](https://chestofbooks.com/reference/American-Cyclopaedia-V7/Fortification-Part-2.html)). The glacis is a gentle earth slope to the covered way ([sites-vauban](https://sites-vauban.org/en/resources/glossary/glacis)).
- **Regelbau casemates.** Walls 1.5–2 m thick ([Wikipedia](https://en.wikipedia.org/wiki/Regelbau)).
- **Flak towers.** Zoo Tower walls are 2.4 m ([Wikipedia](https://en.wikipedia.org/wiki/Zoo_Tower)); the Vienna towers have 2–2.5 m walls and 3.5–4 m roofs ([nonument](https://nonument.org/?p=826)).
- **Dragon's teeth and hedgehogs.** Dragon's teeth are truncated concrete pyramids in staggered rows ([Wikipedia](https://Www.Wikipedia.org/wiki/Dragon%27s_teeth_(fortification))).
- **Ishigaki.** A concave "fan slope" stone base, ~45° at the foot steepening toward the top ([JAANUS](https://projects.mcah.columbia.edu/jaanus/node/1829)). Himeji has 5 roof tiers outside ([nippon.com](https://nippon.com/en/guide-to-japan/gu900254)).
- **Flying buttresses** carry vault thrust over the aisles to outer piers ([Beauvais](https://cathedrale-beauvais.fr/?p=3789)). In-game, the piers carry pinnacles for dead weight, and massive end buttresses take the arcade thrust. Without them the physics pushes the end pier out, just as it would a real one.
- **Arches.** A semicircular masonry arch needs a thickness of at least ~0.11× its radius to stand (Heyman's minimum-thickness result). The first hangar arch broke that rule and Rapier duly collapsed it.
- **Sloped armour.**
  - Line-of-sight thickness is t / cos θ ([Wikipedia](https://en.wikipedia.org/wiki/Sloped_armour)).
  - The Tiger II upper glacis is 150 mm at 50° ≈ 233 mm ([ww2-weapons](https://ww2-weapons.com/panzer-vi-ausf-b)).
  - The critical ricochet angle is not fixed. It rises with velocity, e.g. 62° at 830 m/s to 80° at 1800 m/s ([LS-DYNA study](https://dynalook.com/conferences/15th-international-ls-dyna-conference/modeling/numerical-ricochet-model-of-a-7.62-mm-projectile-penetrating-an-armor-steel-plate)).
  - In-game values: steel ricochets past ~56° and concrete past ~65°, and damage scales with cos θ.
  - Lab check against a 30° steel glacis: flat fire (60° obliquity) glances off for 5–20 damage, while plunging fire (5°) does 38–251.
