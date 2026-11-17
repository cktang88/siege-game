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

## Tall towers and air raids (fourth iteration)

- **Bergfried proportions.** Bergfrieds averaged 20–30 m tall, a few reached ~50 m, and their walls are thickest at the base, thinning markedly at the upper floors ([Wikipedia: Bergfried](https://en.wikipedia.org/wiki/Bergfried)). A butter-churn tower (*Butterfassturm*) has an upper section narrower than the lower one ([Wikipedia](https://en.wikipedia.com/wiki/Butterfassturm)). The Dover keep is ~25 m tall with walls up to 6.4 m thick (same Bergfried article).
- **How these are used in-game:**
  - columns taper from ~1.6–1.9 m to ~0.8 m
  - keeps step inward at ~60% of their height
  - bergfrieds are 8–12 storeys
  - curtain walls step back in their upper third
- **Storm Winds** is a steampunk browser game by Hero Interactive. Waves of gyrocopters and airships attack, and you aim the turrets yourself between upgrades ([JayIsGames](https://games.jayisgames.com/review/storm-winds.php), [TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/Stormwinds)). That is the model for the mooring masts, the gyrocopter strafing runs, the airship bomb runs, and hand-aimed proximity-fuzed flak.

## Fire & smoke VFX

The old fire was stacks of round cel discs and the smoke was overlapping translucent circles; under bloom the
fireballs became white blobs. What the references agree on:

- **Shape and value carry the read, not brightness.** Riot's League of Legends VFX style guide ranks effects by
  gameplay weight and asks for hand-drawn shapes that mix hard and soft forms, avoiding stacked shapes that go
  muddy ([Riot Nexus post](https://nexus.leagueoflegends.com/en-us/2017/10/dev-leagues-vfx-style-guide/),
  [guide PDF](https://nexus.leagueoflegends.com/wp-content/uploads/2017/10/VFX_Styleguide_final_public_hidpjqwx7lqyx0pjj3ss.pdf),
  [realtimevfx thread](https://realtimevfx.com/t/official-league-of-legends-vfx-style-guide/3392)).
  Value range is what draws the eye ([VFX Apprentice](https://www.vfxapprentice.com/blog/five-artistic-principles-gaming-vfx)).
- **Stylised fire is a noise-eroded mask through a stepped ramp.** Alpha erosion moves a threshold through a
  mask (step for hard toon edges, smoothstep for a feathered one)
  ([vfxdoc: alpha erosion](https://vfxdoc.readthedocs.io/en/latest/shaders/alpha-erosion/)). Toon fire shaders
  subtract scrolling noise from a flame mask, then band the result into two to five flat colours
  ([Duck in Town devlog](https://papaya-games.itch.io/duck-in-town/devlog/95149/how-to-make-an-stylized-fire-shader),
  [Godot stylised fire after Minionsart](https://godotshaders.com/shader/stylized-fire-3d/),
  [Zelda campfire breakdown](https://realtimevfx.com/t/stylized-zelda-camp-fire-breakdown/9613),
  [Vel'Koz fire erosion thread](https://realtimevfx.com/t/about-fire-from-infernal-velkoz/13491)).
  Stepped interpolation between colour stops is what makes a ramp read as toon
  ([Maxon toon material](https://help.maxon.net/r3d/houdini/en-us/Content/html/Material+Toon.html)).
- **Many particles, one silhouette: 2D metaballs.** Draw soft falloff sprites additively into a render target,
  then colour only the pixels above a threshold; lowering the field fades and shrinks the shape
  ([2D metaballs](https://captainproton42.github.io/2DMetaballs/), [Defold fluid thread](https://forum.defold.com/t/fluid-simulation-2d-metaballs/47371),
  [gamedev.net isosurfaces](https://www.gamedev.net/articles/programming/graphics/exploring-metaballs-and-isosurfaces-in-2d-r2556/)).
- **Cartoon smoke is two-tone shaded with a silhouette.** McGuire, Fein and Hartnett shade billboard puffs with
  normal maps quantised to two tones, add self-shadowing and black outlines
  ([Real-Time Cartoon Rendering of Smoke, SIGGRAPH 2004 poster](https://history.siggraph.org/wp-content/uploads/2023/01/2004-Poster-026-Mcguire_Real-Time-Cartoon-Rendering-of-Smoke.pdf)).
- **Hand-made look over a 3D (or particle) base.** Guilty Gear Xrd hand-tunes shading so 3D reads as drawn and
  animates on keyframes for a limited-animation feel ([GDC 2015 talk](https://gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The),
  [Arc System Works](https://www.arcsystemworks.com/guilty-gear-xrd-art-talk-at-game-developers-conference-2015/)).
- **Simulation games.** Noita spreads fire pixel by pixel: a burning cell tries a random neighbour each step
  ([80.lv](https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation/), [GDC 2019](https://gdcvault.com/play/1025695/Exploring-the-Tech-and-Design)).
  Teardown renders smoke and other particles after its deferred pass ([frame teardown](https://acko.net/blog/teardown-frame-teardown/),
  [Gustafsson's smoke experiments](https://80.lv/articles/simulating-light-smoke-for-games/)). Our spread stays rule-based; only the look changed.
- **Hades, Broforce:** no first-party technical breakdown of their fire turned up (the [80.lv Hades piece](https://80.lv/articles/a-behind-the-scenes-look-at-the-effects-in-hades)
  only shows clips), so nothing here is taken from them.
- **Free assets.** Kenney's [Smoke Particles](https://kenney.nl/assets/smoke-particles) and
  [Particle Pack](https://kenney.nl/assets/particle-pack) are CC0, and OpenGameArt has CC0 fire/smoke sheets
  ([fire-smoke animations](https://opengameart.org/content/fire-smoke-animations)). Painted puffs would fight the cel
  look and could not be re-thresholded per frame, so **no third-party art is shipped**: every fire and smoke shape is
  generated in shaders (`src/fx.ts`), so no licence applies.

Applied here (`src/fx.ts`, the burn/char block of `blockFrag` in `src/render.ts`):

- **Fields, not sprites.** Flame particles write a teardrop of heat (opacity × temperature, where temperature is the
  callers' yellow→ember colour read as green/red) into a half-resolution float target; smoke writes colour × density
  and density into another. Overlapping tongues merge into one body with one outline.
- **Flames.** The composite erodes the heat with fbm noise stretched vertically, scrolled upward and sheared downwind,
  plus a finer flicker noise, then bands it: deep-red rim, red, orange, yellow, pale core. The core sits at luma ~0.9,
  so it only grazes the bloom threshold (0.92); a fireball can no longer white out. As heat cools the ball shrinks
  through the bands to an ember rim and is gone.
- **Smoke.** Two-tone (lit / shadow, plus a mid tone in flat interiors) from the density gradient taken over ~0.5 m in
  world space, lit from the top-left like the blocks; a darker silhouette band; two opacity steps (wisps see-through,
  body near-solid); noise erosion that grows with age so old smoke frays into wisps; an orange belly where it sits over
  flames. Smoke eases toward the wind speed, so plumes stream downwind.
- **Sparks and embers** are additive instanced quads stretched along their velocity (about 1/40 s of travel), with a
  hot pinched core and a twinkle; explosions add a brief flat flash disc and a thinning shock ring.
- **Explosions:** flash + ring, a core blob and a ring of heat blobs thrown out and braked hard (fast punch, then
  stall), sparks under gravity, and smoke that appears 0.1–0.3 s later as the ball cools, with a rising column; fuel
  and ammunition cook-offs get a taller, longer fireball and black smoke.
- **Burning blocks:** a bed of tongues hugging the (rotated) block, embers drifting downwind, a dark smoke column, and in
  the block shader a patchy char front eating in, scorch ahead of it, alligatored charcoal behind it whose cracks pulse
  with ember glow while alight (`uAlight`) and go cold with a little ash after.
- **Light:** fires keep their flickering point light; the flicker phase now comes from the light's position (not its
  pool slot, which reshuffles) with a slow swell, so fires gutter instead of strobing.
- **Budget.** One instanced draw per pool (smoke 2400, flame 2600, sparks 1600), two half-res targets, two view-sized
  composite quads. Continuous emitters throttle as a pool passes 60% full, so 128 burning blocks still form plumes
  instead of evicting smoke before it rises. Heat haze was left out: it needs a scene copy and a distortion pass for
  little gain at gameplay zoom.
