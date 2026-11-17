# Munition balance

*Is every round worth its price?* This note answers that with measurements from `scripts/value-lab.cjs`, lists the behaviour bugs the measurements turned up, and records the price and stat changes made in response. All "before" numbers are from the code as it stood after the objective rule below was merged; "after" numbers are from the current code.

## The objective rule

Since commit *Objectives die to one direct hit or two near misses*, an objective dies to one direct hit from any real shell (not pellets, smoke or flak, and not rounds slower than 9 m/s), and any blast that reaches it takes at least 55% of its HP. So raw damage against objectives no longer separates the rounds. What separates them now:

- **access:** getting a clean line, or a blast, to the objective through walls, armour and earth;
- **breaching:** removing wall HP, toppling, opening hidden rooms;
- **the field:** infantry, aircraft, counter-battery guns.

The lab measures each of these.

## Method

`scripts/value-lab.cjs` drives the real game headlessly in Chromium (Playwright). The page's frame loop is parked, and each trial runs synchronously inside one `page.evaluate`, stepping `game.update(1/60)`. `Math.random` is seeded per trial, so every run is reproducible. Research is the base tree, except that muzzle velocity is set to the level's planned gun cap + 4 m/s and reload to 1.0 s. No damage upgrades are applied. Enemy timers are off except in the section that measures them.

**The gunner.** For each shot, a solver tries flat and lofted arcs at six charges. It traces each path against the live colliders and picks the arc whose first contact is the target, or the point nearest to it. For AP and bunker busters, it picks the arc that crosses the least armour (`hp / pierce`). It then adds a Gaussian aiming error of 0.35 m at the target, or 0.6 m against aircraft.

Each round has its own delivery:

- **Cluster:** an airburst timed just before impact. Against infantry and gun lines it is lofted and burst early over the target.
- **Drill:** the open patch of ground nearest short of the target that a shell can actually land on.
- **Saboteur:** a run on foot.
- **Air strike:** a 3-bomb level run over the objective.
- **Delayed fuse:** set to 1 s.

The sections are:

| section | what it does |
|---|---|
| `struct` (to the win) | Fires one round type at the nearest live objective of a real campaign level until every objective is down (1400 cr cap). Reports credits to win. Levels: Millford (timber), Bastion Kell (reactive), Kurogane (stone), Greywater (concrete, steel and earth), Kestrel (grand castle with 20 walled-up rooms). 3 seeds. |
| `struct` with `PROTO=spend` | Equal spend: 520 cr of one round. The battle never ends, and once the objectives are down the gunner keeps working on the structure where they stood. Measures block HP removed, garrison killed and hidden rooms opened per 100 cr after a 20 s tail, so fire burns and masonry settles. |
| `niche` | Lab scenes, each fired at until its target is destroyed (8 rounds max): a reactive-skinned blockhouse, a gun pit behind two earth berms, a concrete casemate, a timber blockhouse, a tower-top post, a boxed-in post on a slender tower ("topple"), and an open gun line of three guns ("battery"). |
| `campaign` | Every campaign operation, fought with one round type inside the operation's own budget. Reports credits spent to win. |
| `infantry` | A file of men 2.2 m apart walks in, and one led round is fired at them. Runs with no shields, 25% shields and 55% shields (late campaign), plus a crowd of 8. 9 seeds. |
| `air` | A gyrocopter or airship launches from the Zoo Flak Tower mast. Led rounds are fired until it is down (8 max). 6 seeds. |
| `smoke` | 90 s under live counter-battery fire with no return fire, with no smoke or with a smoke round every 15 s. |
| `drone` | One drone, sent to the default loiter point and to 15 player-chosen points. Counts the walled-up rooms it opens, against the HE rounds needed to breach one hidden room by blasting. |
| `pen` | Penetrators against lab casemates (1–3 m concrete, 2 m stone, 3 m earth), plus where drills land and burst on campaign levels. |

**Score and time.** The score counts unspent money at 3 points per credit, and time under par at 60 points per second. Each shot costs at least one reload (1.6 s base, 96 points, about 32 credits). The to-the-win tables therefore also report "obj/score-cost", which charges each round 3·price + 96 points. Under this measure, expensive one-shot rounds (AP, bunker buster, cluster) look about 1.3–1.5× better than on credits alone, and cheap rounds that need many shots (round shot, flak) look worse. That matches play: a 40-credit round that takes three shots also burns about 5 s of par. Unfired rounds refund half their price in score, so over-buying costs half price.

## Results

### Summary (value per credit in each round's own role)

"Best" means the cheapest per credit of all rounds in that measurement.

| round | price before → after | role | before (role metric) | after (role metric) | verdict before | verdict after |
|---|---|---|---|---|---|---|
| Round Shot | 40 → 40 | baseline; open lines | cheapest win: Millford, Kurogane | cheapest win: Millford 80 cr; tower-top post 40 cr | fair (baseline) | fair |
| High Explosive | 130 → **80** | general demolition | Kestrel HP 552/100 cr (0.73× shot); infantry 2.7 kills/100 cr (0.3× shot); never the cheapest win | Kestrel HP 750/100 cr (best with delayed fuse and incendiary); cheapest win on Ironcrown | overpriced | fair |
| Heavy Shell | 140 → **70** | knocking down timber and masonry | Kurogane HP 0.67× shot; timber lab 140 cr (shot 80) | timber lab 70 cr (best); Millford HP 353/100 cr (best); Kurogane HP 636/100 cr (best) | overpriced | fair |
| Armor-Piercing | 120 → **130** | reaching inner rooms through masonry and earth | cheapest win on 11 of 16 operations | cheapest win on 7 of 16 (Outpost, Bastion, Ironmill, Citadel, Greywater, Abbey, Zoo Flak) | underpriced (dominant) | fair, the premium masonry round |
| Incendiary | 100 → **75** (radius 2.2 → 3) | timber, garrisons, rooms | Kestrel garrison 0.73/100 cr (0.5× shot); HP 0.58× | Kestrel garrison 1.59/100 cr and rooms opened 1.71/100 cr (both best); HP 736 | overpriced | fair |
| Bunker Buster | 260 → **200** | concrete | Greywater HP 2.9× base, but its cheapest win (1040) lost to AP (640) | Greywater HP 485/100 cr (best); casemate 200 cr; cheapest win on Saltworks, Causeway, Warden, Black Citadel | overpriced (dominated by AP) | fair |
| Cluster Shell | 170 → **120** | several exposed targets at once | infantry 1.4 kills/100 cr; cheapest win nowhere | gun line of 3: 120 cr (one round; next best 210); cheapest win on Kurogane (240) | overpriced | fair |
| Delayed Fuse | 110 → **80** | rolling into rooms | Kestrel HP 0.81× shot; cheapest win nowhere | cheapest win on Kestrel (1120); Kurogane win 320 | overpriced | fair |
| Sticky Charge | 120 → **70** (speed 0.75 → 0.9) | reactive armour | out of reach at Kestrel (0 rounds fired) and Greywater; reactive lab 440 cr | reactive lab 187 cr (best of the rounds that need no open landing ground; drill 140) | broken range, overpriced | fair |
| Burrowing Drill | 190 → **140** (behaviour fixed) | ground-floor targets behind walls; earthworks | fizzled on any wall it clipped; 0 objectives on any castle; Clean Cut lost; earth lab 1013 cr | Clean Cut won for 420 (shells cannot win it); lab: reactive, earth and casemate 140 cr each (best) | useless | fair, situational |
| Canister Shot | 35 → **30** | infantry | tied with round shot; flak out-killed it with 25% shields (7.7 vs 6.0/100 cr) | best in every infantry test: 7.0–10.4/100 cr (14.8 in a crowd) | fair, but flak dominated it | best for infantry |
| Flak Burst | 45 → **40** | aircraft | canister out-shot it against aircraft (gyro 24.5 vs 22.2 kills/1000 cr) and nearly matched it against infantry | gyro 25 kills/1000 cr (canister 15); airship 8.3 (canister 6.9); infantry 1.1–1.8 kills a round | dominated | best for aircraft |
| Smoke Screen | 60 → 60 | counter-battery | 6 rounds (360 cr) cut gun damage over 90 s from 96 to 9.5 HP (8 shots to 3) | same | fair | fair |
| Scout Drone | 80 → **100** (default fixed) | finding walled-up rooms | default loiter point opened 1/12, 0/20 and 0/28 hidden rooms on the big castles | default point opens 11/12, 18/20 and 13/28 | broken default; underpriced when placed by hand | underpriced on purpose (see below) |
| Saboteur | 160 → **120** (charge 190 → 260, tamped, concrete ×1.8, earth ×2) | breaching casemates and reactive walls | casemate 320 cr; Bastion HP 0.87× | casemate 120 cr (best); Clean Cut won 600; Bastion HP 369/100 cr | overpriced | fair |
| Air Strike | 340 → **250** (GP bomb 120 → 150 dmg, radius 3.2 → 3.6) | roofs and forts without flak | Bastion HP 226/100 cr; Kurogane 0.49× | Bastion HP 396/100 cr (best); earth lab 250; Clean Cut won 750 | overpriced | fair (useless under flak, by design) |

Every round now has at least one measurement in which it is the cheapest per credit (or, for smoke and the drone, the only round that does the job), and no round is strictly dominated.

### Campaign: each operation with a single round type inside its budget (credits spent to win)

Base research, the lab gunner, seed 1. × means not won inside the budget.

| operation | budget | shell | HE | AP | bunker | cluster | delayed | cheapest before | cheapest after |
|---|---|---|---|---|---|---|---|---|---|
| outpost | 900 | 600 | 480 | 260 | 400 | 480 | 320 | AP 240 | AP 260 |
| millford | 1100 | 80 | 160 | 130 | 200 | 120 | 320 | shell 80 | shell 80 |
| cleancut | 1000 | × | × | × | × | × | × | saboteur 480, air strike 680 | drill 420, saboteur 600, air strike 750 |
| redhill | 2300 | 320 | 480 | 390 | 800 | 240 | 320 | shell 200 | cluster 240 |
| saltworks | 2650 | 1360 | 960 | 650 | 600 | 720 | 720 | bunker 780 | bunker 600 |
| bastion | 1300 | 720 | 640 | 390 | 400 | 480 | 640 | AP 360 | AP 390 |
| causeway | 2900 | 640 | 480 | 520 | 400 | 600 | 480 | AP 480 | bunker 400 |
| ironmill | 4100 | 1520 | 1360 | 910 | 1400 | 1440 | 1520 | bunker 1040 | AP 910 |
| citadel | 1800 | 720 | 960 | 390 | 600 | 600 | 960 | AP 360 | AP 390 |
| greywater | 3450 | 1200 | 1600 | 780 | 800 | 1320 | 2960 | AP 720 | AP 780 |
| hollowcrown | 3050 | 1040 | 1200 | 780 | 1600 | 1440 | 1200 | AP 720 | AP 780 |
| thronefall | 4100 | 2040 | 1600 | 1170 | 1200 | 1440 | 2320 | AP 840 | AP 1170 |
| kestrel | 5050 | 2360 | 1440 | 1430 | 2000 | 1440 | 1120 | AP 1440 | delayed 1120 |
| ironcrown | 5600 | 3160 | 1760 | 2080 | 2200 | 1920 | 2240 | AP 1560 | HE 1760 |
| warden | 5500 | 3320 | 4080 | 1690 | 1400 | 3120 | 3280 | AP 1800 | bunker 1400 |
| blackcitadel | 7250 | 4200 | 3120 | 2860 | 2000 | 2160 | 2960 | AP 2880 | bunker 2000 |

Every operation is won with a single round type for at most 42% of its budget. Clean Cut is built for a specialist: it is a steel-roofed concrete bunker that no shell can reach. Before the changes, only the saboteur and the air strike won it (the drill, the round built for it, did not). Now the drill wins it too, and most cheaply. Prices fell on average, so budgets buy more than before. The one-hit objective rule had already made the campaign easier than the budgets assumed, so no budget was changed.

### Niche scenes (credits to destroy the target)

× means not destroyed in 8 rounds; (k/3) means destroyed in only k of 3 trials. The "battery" scene (an open gun line of three guns) was added after the before run.

| round | reactive (before → after) | earth berms | concrete casemate | timber blockhouse | tower-top post | gun line of 3 |
|---|---|---|---|---|---|---|
| shell | × → 120 (1/3) | × | × | 80 → 80 | 40 → 40 | 173 |
| HE | 477 → 293 | × | 780 → 480 | 130 → 80 | 130 → 80 | 267 |
| heavy | 490 (2/3) → 210 | × | 630 (2/3) → 257 | 140 → **70** | 140 → 70 | 280 |
| AP | 240 → 260 | **280** → 303 | 240 → 260 | 120 → 130 | 120 → 130 | 520 |
| incendiary | × | × | × | 200 → 150 | 167 → 125 | 275 |
| bunker | 520 → 400 | 607 → 467 | 260 → 200 | 260 → 200 | 260 → 200 | 800 |
| cluster | 1360 (1/3) → 960 (1/3) | 680 → 520 | × | 850 → 780 (2/3) | 170 → 120 | **120** |
| delayed | 697 → 400 (2/3) | × | × | 147 → 107 | 110 → 80 | 320 |
| sticky | 440 → 187 | × | 680 → 350 | 160 → 70 | 120 → 70 | 210 |
| drill | **190** → **140** | 1013 → **140** | **190** → 140 | 190 → 140 | 887 → 700 | 420 |
| saboteur | 320 → 240 | × → 600 | 320 → **120** | 160 → 120 | 747 → 440 | 480 |
| air strike | 680 → 500 | 680 → 250 | 1020 → 750 | 340 → 250 | 510 (2/3) → 333 | 583 |

The drill wins the lab scenes only when it has open ground within its 12 m run. On the campaign hills it lands on open ground in only about half of its shots (7 of 15 in the `pen` section), so its campaign niche is narrower than the lab suggests.

### Infantry (kills per 100 credits, one led round at a file of men)

| test | canister | shell | HE | cluster | flak | incendiary |
|---|---|---|---|---|---|---|
| 4 men, no shields: before | 9.2 | 8.9 | 2.7 | 1.4 | 8.2 | 2.4 |
| 4 men, no shields: after | **10.4** | 8.9 | 4.7 | 3.0 | 4.4 | 4.2 |
| 4 men, 25% shields: before | 6.0 | 4.2 | 2.7 | 1.4 | **7.7** | 2.3 |
| 4 men, 25% shields: after | **7.0** | 4.2 | 4.4 | 2.2 | 3.6 | 3.7 |
| 4 men, 55% shields: before | 6.7 | 3.1 | 2.5 | 1.1 | 6.2 | 2.1 |
| 4 men, 55% shields: after | **7.8** | 3.1 | 3.5 | 1.8 | 2.8 | 3.4 |
| crowd of 8, 25% shields: after | **14.8** | 4.4 | 5.4 | 3.2 | 4.4 | 4.7 |

### Aircraft (kills per 1000 credits)

| | flak | HE | shell | canister | cluster |
|---|---|---|---|---|---|
| gyro: before | 22.2 | 4.6 | 15.0 | **24.5** | 3.9 |
| gyro: after | **25.0** | 7.5 | 15.0 | 15.4 | 5.6 |
| airship: before | 7.4 | 2.4 | 6.0 | **9.0** | 2.7 |
| airship: after | **8.3** | 4.0 | 6.0 | 6.9 | 3.9 |

### Drone against blasting the wall

| castle | hidden rooms (with an objective) | 1 drone, default point: before → after | 1 drone, best point chosen by hand | HE rounds to breach one hidden room |
|---|---|---|---|---|
| Kurogane | 3 (1) | 2 → 3 | 3 | 1.8 |
| Zoo Flak Tower | 12 (1) | 1 → 11 | 12 | 6.3 |
| Kestrel | 20 (0) | 0 → 18 | 20 | 5.2 |
| Black Citadel | 28 (3) | 0 → 13 | 24 | 5.5 |

Breaching one walled-up room costs 2 to 6 HE rounds, or 150 to 500 cr at the new HE price. A player who does not know which room holds the objective must, on average, search (N+1)/(k+1) rooms, where N is the number of hidden rooms and k the number with an objective. On the Black Citadel that is (28+1)/(3+1) ≈ 7 rooms, or about 40 HE (3200 cr). One drone, now opening 13 rooms from its default point, replaces almost all of that.

The drone is therefore underpriced even at 100. It is kept cheap on purpose: it is information, the level design assumes you take one, and raising its price would only tax a purchase every player must make. Fire and incidental breaches also open rooms (0.4–1.7 rooms per 100 cr of shelling, from the equal-spend tables), so the drone's value shrinks once a castle is already being shelled.

### Equal spend, block HP removed per 100 cr (after)

| round | Millford | Bastion | Kurogane | Greywater | Kestrel |
|---|---|---|---|---|---|
| shell | 270 | 184 | 547 | 144 | 570 |
| HE | 234 | 222 | 635 | 150 | **750** |
| heavy | **353** | 258 | **636** | 219 | 597 |
| AP | 167 | 233 | 535 | 328 | 544 |
| incendiary | 229 | 123 | 512 | 46 | 736 |
| bunker | 180 | 377 | 538 | **485** | 484 |
| cluster | 248 | 267 | 558 | 208 | 569 |
| delayed | 278 | 230 | 613 | 77 | 718 |
| sticky | 257 | 309 | 655 | 229 | 690 |
| drill | 200 | 229 | 434 | 296 | 404 |
| saboteur | 233 | 369 | 283 | 270 | 361 |
| air strike | 188 | **396** | 463 | 216 | 41 (flak) |

## Behaviour bugs found and fixed

1. **The drill fizzled on walls.** A drill that struck anything but earth or ground went off as a 70-damage pop, which is less than a round shot. With 0.35 m of aiming error on a lofted shot, that happened to about half of all drill shots. Now it grinds into the block and its charge goes off inside it, the same damage to that block as the drill's tamped charge underground.
2. **The drill could never get past the first wall.** Underground, it stopped beneath the first block it met, which is always the outer wall or the glacis, so it could not reach anything behind them. It killed no objective on any castle, and it lost Clean Cut, the level built for it. Now it runs its full 12 m under the walls. It blows beneath the first target it reaches, which counts as a direct hit under the objective rule, or else beneath the last structure it passed under, so it still undermines a wall's foundations.
3. **Flak mowed down infantry.** The infantry kill test ignored damage, so any blast killed every man within 1.15 × its radius. Flak's 4.4 m radius killed whole files, out-killing canister at 45 credits. A flak shell that struck a man directly also burst as a full HE-type blast, because the flak flag was not passed. Now flak kills men only within 0.35 × its radius on the ground, and a contact burst is a flak burst.
4. **Canister out-shot flak against aircraft.** Each pellet did 18 damage to aircraft, so a volley of 14 could deal 250, more than an airship's HP. Now each pellet does 9.
5. **The drone's default loiter point was out of camera range.** It sat 6 m above the highest block, which on spired grand castles is 30 m or more up, above the camera range of every walled-up room. On Kestrel and the Black Citadel, a drone sent to the default point opened none of the 48 hidden rooms. Now it loiters 10 m above the ground, 70% of the way across the fortress, and sweeps the rooms on its way in.
6. **Sticky charges could not reach the castles.** At 0.75 of muzzle velocity, the planned gun could not reach any block of Kestrel with a sticky charge, nor anything at Greywater past the first earthworks. Now its speed is 0.9.
7. **Saboteur charges were not tamped.** A charge planted against a wall hit it at 0.8× focus, less than a bunker buster's 1.6×. Now it is tamped like a bunker buster, with bonuses against concrete and earth.

All these fixes are in `src/game.ts` (drill, flak, canister against aircraft, drone default, saboteur tamping) and `src/config.ts` (prices and stats). `scripts/munition-lab.cjs` gained `drill_under`, `drill_wall` and `flak_infantry`. Its `air_flak_aim` test now reads the GP bomb's stats from config.

## Real-world notes (brief)

- **Bunker busters** are a hardened case with a delay fuze: they penetrate first and detonate inside. That is the game's "embed, then 0.35 s fuse".
- **Engineers' demolition charges** are tamped against the target, so they beat a shell of the same weight against concrete. That is why the saboteur now beats the bunker buster against a casemate it can walk up to.
- **Canister** (case shot) is a close-range anti-personnel load, and poor against masonry.
- **Proximity-fuzed AA shells** are thin-cased for fragmentation in the air. Their ground effect is modest compared with HE.

## Reproduce

```bash
npx vite --port 5193 --host 127.0.0.1 --strictPort &
BASE=http://127.0.0.1:5193 NODE_PATH=$(npm root -g) node scripts/value-lab.cjs            # all sections, 3 seeds (~4 min)
PROTO=spend BASE=... node scripts/value-lab.cjs struct 3                                   # equal-spend tables
BASE=... node scripts/value-lab.cjs campaign 1                                             # campaign budget check
```

`ONLY=he,ap` limits the structure rounds, `LEVELS=redhill,kestrel` limits the levels, and `VALUE_JSON=out.json` writes the raw rows.
