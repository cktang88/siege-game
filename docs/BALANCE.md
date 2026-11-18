# Damage and difficulty pass

Player report: *materials could use a bit more health, so they don't just explode, or break, or do nothing; it seems very easy, especially on the second and third levels; the high explosive especially.* A later request: *canister seems underpowered: wider spray, more pellets.*

This pass measured how hard the campaign really is and how a block responds to each round, changed the damage model so that response is graded, set every operation's budget and par time from measurements, and widened canister. "Before" is main as of the machine-gun post merge; "after" is this branch.

## How it was measured

New sections in `scripts/value-lab.cjs`:

| section | what it does |
|---|---|
| `difficulty` | The campaign as a player meets it. Operations in map order; start with 300 cr and HE. After each win the war funds (first clear 250, 120 a star, score/25, as `missionReward`) buy research down a fixed sensible plan (`PLAN` in the script: Double Charge, Heavy Shot, drone, AP, Drilled Crew, Incendiary, Commandos, Amatol, …), saving up when the next item is out of reach. Each operation is fought with every round the player owns, one type at a time, 2 seeds, with the live enemy (counter-battery, infantry, aircraft, vehicles, engineers). The gunner: aiming error 0.5 m at the target, 2.5× on the first round at a new target and 1.5× on the second (ranging), 3 s to lay each shot, the machine-gun post for infantry between cannon shots, a led flak (or HE) round at aircraft closing on the gun, smoke when counter-battery fire has hurt the gun, and the nearest enemy gun silenced once the gun is below 60%. Reports shots, credits spent as a share of the budget, time against par, score and stars, and what hurt the gun. The gun is not lost mid-battle (the run measures the structure); "gun lost" marks a battle where it would have been. The best round by score is the player's choice and pays the reward. `DIFF_SIGMA=0.9` gives a casual gunner. |
| `material` | Rounds to break a 1 m course block set in a wall (square hit at 30 m/s × round speed), every material × every round; then one burst at 0–4 m from a free 1 m block: out to what distance it destroys/shatters, cracks (≥30% HP) and marks (≥5%). |
| `shot` | One round into a real structure, at the nearest objective and at six blocks of the outer works: every block the burst reaches is graded (nothing <5% HP, marked 5–30%, cracked ≥30% and standing, burst = destroyed or shattered by the blast itself), plus the collapse in the next 8 s and the share of the structure's HP removed. |
| `group` | One round at 6 men 2.2 m apart standing 20, 30 and 45 m from the gun (none or a third with shields), aiming error 0.6 m. |

## Before: what was wrong

**The campaign was a walk.** The deliberate gunner won every operation, most with a fifth to a third of the budget, and took three stars on 12 of 16 (table below, "before" column). Millford (operation 2) fell to 3 AP rounds for 35% of its budget, Kurogane (Red Hill, operation 4) to 5½ heavy shells for 17%, the Zoo Flak Tower to 3 bunker busters for 13%. Times were a fifth to a half of par, so the time bonus alone was worth thousands. The budgets came from the castle generators (`700 + 230·d + 8·width`, `900 + 300·d + 12·width + 5·blocks`) and had not been revisited after the one-hit objective rule made objectives cheap to kill.

**HE wiped out chunks of castle.** Blast damage fell off linearly to zero at the radius (4.2 m for HE) and a brittle block shattered at 30% of its HP. One HE burst destroyed or shattered every masonry block within 2.0 m and every timber within 3.0 m (`material`, before). On Millford one HE shell burst 81% of the blocks it reached and removed 34% of the whole fort's HP; on Kurogane 51% and 4.3 further blocks collapsed after the blast (`shot`, before). Few blocks were ever left cracked and standing (0–8%): a block either blew apart or barely noticed, which is exactly the report.

**Near misses did not have to be near.** An HE burst counted as a near miss on an objective (55% of its HP) anywhere within 3.15 m in the open, and an AP round that had spent nearly all its penetration boring through two walls still killed the objective behind at full strength.

**Canister.** One volley at a file of six 2.2 m apart killed 3.3–3.4 at 20–30 m, fewer than an HE shell (4.8), and was no weaker at 45 m (4.2) than close in.

## Changes and why

| change | before → after | why |
|---|---|---|
| blast falloff (`explode`) | `1 − d/r` → `(1 − d/r)²` | A burst now wrecks what it touches, cracks what is a metre off, and only scorches what is further: HE kills masonry only at contact (was within 2.0 m) and timber within 1.5 m (was 3.0 m); it still marks masonry out to 2.5 m. |
| blast order | arbitrary → nearest block first | A block the burst destroys no longer shields the ones behind it (a breached wall lets the blast through), so charges still reach a room through the wall they break. |
| occlusion | ×0.35 → ×0.3 | Walls in front protect a little better. |
| near-miss rule on objectives | burst within f > 0.25 of the radius (3.15 m for HE) → within half the radius in the open (2.1 m for HE); behind a wall within a quarter (1.05 m), doing 25% (was 30%) | Kept the user's rule (one direct hit, or two near HE misses), but a near miss has to be near, and a wall in front protects. |
| penetrator objective hit | full punch → the punch left after the walls bored through; a round that spent more than half arrives with a share of a kill (≥ 34%) | AP straight through two walls into the command post was the cheapest win on most operations. |
| materials HP | timber 60 → 75, masonry 140 → 170, concrete 220 → 260, reactive 90 → 105, firebrick 160 → 190, munitions 70 → 80, clay roof 45 → 55, plaster 70 → 85 (steel, earth, fuel unchanged) | "Slightly more health": +15–25%, so walls take a round or two more and break in stages. |
| brittle fracture under blast (`fracture.ts`) | shatter at ≥30% of HP → shatter at ≥60% (or worn ≥85%); 35–60% on a big block (≥1.1 m², ≥0.5 m thick) cracks it in two; below that marks | Fewer instant explode-outs: the graded marks → crack → break. |
| timber under blast | splinters at ≥40% → ≥50% | Same. |
| solid shot on masonry | cracks at ≥50% → ≥40% | Heavy shell keeps its job (splitting masonry) on the sturdier stone. |
| faint scorch | from 4% of HP → from 1.5% | Distant bursts leave a readable mark instead of nothing. |
| sticky charge | 150 → 185 blast | Contact charges keep their niche under the steeper falloff. |
| saboteur | 260 → 300 charge | Same (breaching casemates). |
| GP bomb (air strike) | 150 → 175 | Same. |
| shell bursts against infantry | kill radius 1.15·r → 0.9·r | HE killed every man within 5.1 m; canister is the round for a crowd. |
| canister | 14 balls in an 8° cone → 26 in a 13° cone; a ball is sure to drop a man inside 0.8 s of flight (~25 m), even odds at ~1.2 s (~37 m), spent by 1.6 s (~50 m) | The user asked for a wider, denser spray. The trajectory stays plain ballistic, so the aiming preview is unchanged. Shields still stop it from the front. |
| campaign budgets and par (`campaign.ts`, `TUNE`) | generator values → set per operation from the difficulty run | The first operation is won with about half its budget, the second and third with 60–75%, later ones with 40–65% (research multiplies the budget by up to 1.38). Par is roughly 1.5–1.8× the deliberate gunner's time. Dev castles keep the generator budgets. |
| star thresholds | per-level constants → `starsFor(budget, par)`: three stars = a win spending at most 60% (50% on the first operation) with 30% of par to spare and the gun nearly whole; two stars halfway from one star | Thresholds have to follow the budgets: the score counts 3 a credit unspent. |

## After

### Campaign difficulty (deliberate gunner, aiming error 0.5 m; budgets as displayed, including research)

| # | operation | budget | before: best round | after: best round | HE only (won, spent, stars) | casual gunner after (0.9 m) |
|---|---|---|---|---|---|---|
| 1 | Outpost Varn | 900 → 1200 | HE, 6.5 shots, 58%, 67/60 s, 1★ | HE, 7 shots, 47%, 74/110 s, 3★ | 2/2, 58%, 1★ → 2/2, 47%, 3★ | shell, 2/2, 65% |
| 2 | Millford | 1100 → 500 | AP, 3 shots, 35%, 24/70 s, 3★ | HE, 4.5 shots, 72%, 43/60 s, 2★ | 2/2, 33%, 2.5★ → 2/2, 72%, 2.5★ | AP, 2/2, 65% |
| 3 | Clean Cut | 1000 → 900 | saboteur, 4.5, 54%, 78/50 s, 0★ | saboteur, 4.5, 60%, 79/140 s, 2★ | × → × | saboteur, 2/2, 60% |
| 4 | Kurogane (Red Hill) | 2300 → 750 | heavy, 5.5, 17%, 63/137 s, 3★ | AP, 4, 69%, 38/60 s, 3★ | 2/2, 26%, 3★ → 2/2, 80%, 2★ | HE, 2/2, 69% |
| 5 | Saltworks | 2650 → 3400 | AP, 7.5, 49%, 96/167 s, 3★ | cluster, 9.5, 50%, 122/230 s, 3★ | 2/2, 85%, 1★ → 1/2, 91% | AP, 2/2, 73% |
| 6 | Bastion Kell | 1495 → 920 | cluster, 4, 29%, 42/90 s, 2★ | cluster, 5, 60%, 57/90 s, 3★ | 2/2, 48%, 1★ → 1/2, 91% | AP, 2/2, 64% |
| 7 | Causeway | 3335 → 1380 | cluster, 5.5, 18%, 58/194 s, 3★ | cluster, 6.5, 52%, 66/115 s, 3★ | 2/2, 23%, 3★ → 2/2, 59%, 2★ | AP, 1/2, 86%\* |
| 8 | Ironmill | 4715 → 3450 | AP, 7.5, 21%, 104/218 s, 3★ | AP, 8, 31%, 113/260 s, 3★ | 2/2, 27%, 2.5★ → 2/2, 52%, 2★ | bunker, 2/2, 96% |
| 9 | Citadel Ostrava | 2070 → 1323 | bunker, 2.5, 29%, 22/130 s, 3★ | bunker, 3.5, 63%, 36/60 s, 3★ | 2/2, 36%, 2★ → 2/2, 79%, 2★ | sticky, 2/2, 77% |
| 10 | Greywater | 3967 → 1897 | bunker, 4, 24%, 49/231 s, 3★ | AP, 6.5, 48%, 83/100 s, 2★ | 2/2, 72%, 1★ → × | AP, 1/2, 73%\* |
| 11 | Hollow Crown | 4209 → 3680 | bunker, 5, 29%, 63/168 s, 3★ | bunker, 8.5, 55%, 109/200 s, 3★ | 2/2, 26%, 3★ → 2/2, 45%, 2★ | bunker, 2/2, 49% |
| 12 | Thronefall | 5658 → 1794 | bunker, 3, 13%, 24/240 s, 3★ | bunker, 3.5, 47%, 26/60 s, 3★ | 2/2, 38%, 3★ → × | bunker, 1/2, 85%\* |
| 13 | Kestrel | 6969 → 4278 | AP, 9, 22%, 139/256 s, 3★ (gun lost) | bunker, 9.5, 64%, 153/240 s, 3★ (gun lost) | 2/2, 34%, 3★ → 2/2, 68%, 1.5★ | HE, 2/2, 84% |
| 14 | Ironcrown | 7728 → 6762 | cluster, 13, 23%, 188/283 s, 3★ (gun lost) | bunker, 12.5, 54%, 203/385 s, 3★ (gun lost) | 2/2, 24%, 3★ → 2/2, 47%, 2★ | cluster, 2/2, 50% |
| 15 | Warden | 7590 → 7176 | AP, 15, 30%, 189/342 s, 3★ (gun lost) | bunker, 17, 61%, 212/340 s, 3★ (gun lost) | × → × | AP, 2/2, 65% |
| 16 | Black Citadel | 10005 → 8418 | bunker, 13, 36%, 190/366 s, 3★ (gun lost) | bunker, 12.5, 41%, 182/440 s, 3★ (gun lost) | × → × | bunker, 2/2, 63% |

\* The casual run was made before Causeway, Greywater and Thronefall got about 15% more money for this reason; the deliberate column is with the final budgets.

What this says:

- **Operation 1 is easy** (47% of the budget, three stars for the deliberate gunner; a casual one wins with 65%).
- **Operations 2–4 now take deliberate aiming and a choice of round**: 60–80% of the budget, two to three stars, par times tight but met. HE alone still wins them, at 72–80%.
- **Later operations** take 30–65% (Ironmill and the Black Citadel at the low end), and HE alone no longer wins Greywater, Thronefall or the last two fortresses: they need AP, bunker busters or cluster. Every operation is still won inside its budget by the casual gunner.
- **"Gun lost"** on the great fortresses is the lab gunner's thin defence (it buys armour and the gun shield late in its plan), not the structure; a player answering the tower guns and aircraft keeps the gun. It was the same before.
- Spread of best rounds after: bunker 7, AP 3, cluster 3, HE 2, saboteur 1. Before: bunker 5, AP 5, cluster 3, HE 1, heavy 1, saboteur 1. No round became the only answer.

### Rounds to break a 1 m course block set in a wall (square hit at 30 m/s)

| material | HP before → after | shell | heavy | HE | AP | delayed | sticky | bunker / saboteur |
|---|---|---|---|---|---|---|---|---|
| timber, plaster, clay, munitions, reactive | 45–90 → 55–105 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| masonry | 140 → 170 | 2 → 3 | 1 | 1 | 1 | 1 → 3 | 1 | 1 |
| firebrick | 160 → 190 | 3 | 1 | 1 → 4 | 1 | 1 → 3 | 1 | 1 |
| concrete | 220 → 260 | 7 | 2 → 3 | 1 → 10 | 1 | 7 | 1 → 10 | 1 |
| steel | 260 | 11 → >12 | 4 | 11 → >12 | 2 | 7 → >12 | 8 | 1 |
| earth | 260 | 1 | 1 | 8 → 9 | 1 | 9 → 11 | 3 | 1 |

(A "1" for timber against round shot, and earth against shell, heavy and AP, is the block being knocked out or dug through, not its HP.) HE on concrete went from one round (shattered at 30%) to ten; concrete is what HE is "bad" against.

### One burst at distance d from a free 1 m block: out to what distance it is destroyed | cracked ≥30% | marked ≥5% (m)

| material | HE before | HE after | heavy before → after | GP bomb before → after |
|---|---|---|---|---|
| timber | 3.0 \| 3.5 \| 4.0 | 1.5 \| 2.0 \| 3.0 | 1.0 \| 1.5 \| 2.0 → 0.0 \| 0.5 \| 1.5 | 3.0 \| 3.0 \| 3.5 → 1.5 \| 2.0 \| 3.0 |
| masonry | 2.0 \| 2.0 \| 3.5 | – \| 1.0 \| 2.5 | 0.0 \| 0.0 \| 1.5 → – \| – \| 1.0 | 2.0 \| 2.0 \| 3.0 → 0.5 \| 1.0 \| 2.5 |
| firebrick | 1.5 \| 1.5 \| 3.5 | – \| 0.5 \| 2.5 | – \| – \| 1.5 → – \| – \| 1.0 | 2.0 \| 2.0 \| 3.0 → 0.0 \| 1.0 \| 2.5 |
| concrete | – \| – \| 3.0 | – \| – \| 2.0 | – \| – \| 1.0 → – \| – \| 0.5 | 0.0 \| 0.0 \| 3.0 → – \| 0.0 \| 2.0 |
| reactive | – \| 2.5 \| 3.5 | – \| 1.0 \| 3.0 | – \| 0.0 \| 1.5 → – \| 0.0 \| 1.0 | – \| 2.5 \| 3.0 → – \| 1.5 \| 2.5 |

Before, the three bands nearly coincided (a block in reach was either destroyed or untouched); after, they are a metre or more apart.

### One round into a real structure (mean of 7 aim points)

| level | round | blocks reached: burst before → after | cracked and standing | marked | collapse after the blast | structure HP removed |
|---|---|---|---|---|---|---|
| Millford (timber) | HE | 81% → 54% | 7% → 12% | 7% → 33% | 1.7 → 1.0 | 34% → 25% |
| Millford | delayed | 72% → 56% | 6% → 0% | 11% → 17% | 2.7 → 1.0 | 40% → 20% |
| Kurogane (stone) | HE | 51% → 33% | 8% → 3% | 25% → 33% | 4.3 → 2.3 | 8.8% → 5.4% |
| Kurogane | heavy | 46% → 44% | 8% → 0% | 26% → 16% | 5.9 → 3.1 | 9.4% → 5.2% |
| Kurogane | delayed | 62% → 31% | 0% → 10% | 27% → 31% | 5.0 → 2.7 | 9.5% → 5.8% |
| Outpost Varn | HE | 35% → 26% | 0% → 5% | 44% → 21% | 1.7 → 1.0 | 10.7% → 7.3% |
| Kestrel | HE | 23% → 6% | 0% → 9% | 45% → 20% | 1.3 → 0.1 | 1.1% → 0.6% |

An HE shell now takes about a quarter of a small timber fort (was a third) and half the collapse that followed on stone; on the great castles it bursts one block in sixteen it reaches and cracks one in eleven.

### Canister against a group (6 men 2.2 m apart, kills per round)

| round | 20 m | 30 m | 45 m | 20 m, ⅓ shields | 30 m, ⅓ shields | 45 m, ⅓ shields |
|---|---|---|---|---|---|---|
| canister before | 3.3 | 3.4 | 4.2 | 2.6 | 2.7 | 3.4 |
| canister after | **4.1** | **3.9** | 2.9 | **3.2** | 3.3 | 1.9 |
| HE before | 4.8 | 4.8 | 5.0 | 4.3 | 4.7 | 4.8 |
| HE after | 3.1 | 3.2 | 3.1 | 3.0 | 3.6 | 3.7 |
| cluster after | 3.2 | 0 | 0 | 2.7 | 0 | 0 |

Canister (30 cr) is now the best cannon round against a group out to ~30 m, per round as well as per credit, and falls off past 40 m. It complements the machine-gun post: canister clears a group in one shot, the MG does sustained work for free but takes seconds per man. In the older walking-file test (men 34–41 m out, i.e. long range for canister) it kills 3.6 per round on Kurogane (4.0 before) and 2.1–2.7 against shielded files on Greywater (1.7–2.3 before). Against aircraft it is unchanged in role (gyro 16.7 kills/1000 cr against flak's 25).

### Niche scenes after (credits to destroy the target, 3 trials)

| round | reactive | earth | casemate | timber | tower | topple | battery |
|---|---|---|---|---|---|---|---|
| shell | × | × | × | 187 | **40** | **80** | **187** |
| HE | 347 | × | × | 213 | 80 | 160 | 240 |
| heavy | 315 (2/3) | × | 280 (1/3) | **70** | 70 | 163 | 233 |
| AP | 260 | 607 | 260 | 130 | 130 | 390 | 477 |
| incendiary | 600 (1/3) | × | × | 300 | 100 | 338 (2/3) | 300 |
| bunker | 480 | 480 | 480 | 240 | 240 | 720 | 800 |
| cluster | × | 183 | × | 623 | 110 | 293 | 257 |
| delayed | 373 | × | × | 80 | 80 | 293 | 240 |
| sticky | 373 | × | × | 140 | 70 | 420 (2/3) | 233 |
| drill | **140** | **140** | **140** | 140 | 560 | 490 (2/3) | 560 |
| saboteur | 280 | 600 | 240 | 120 | 240 | 280 | 480 |
| air strike | 500 | 500 | 750 | 250 | 500 | 500 | 750 |

Against the previous pass: HE no longer kills the concrete casemate (concrete is its weakness); the saboteur needs two charges on the casemate (240, was 120) and the air strike costs more everywhere (it lost most to the steeper falloff, partly made up by the GP bomb's 175). Each round keeps a job: the campaign table shows AP, bunker, cluster, HE and the saboteur each as the best choice somewhere, and the scenes show shell, heavy, delayed, sticky and drill each cheapest or tied somewhere.

### Tests

- `scripts/fracture-lab.cjs`: 21/21. Changed on purpose: `he_shatter_stone` (one HE now cracks a big masonry block into 2–3 pieces; a second shatters it; it used to shatter at once) and `break_hits` (new ranges: masonry 3–4, firebrick 3–5, concrete 6–9, from 3–5 / 3–5 / 6–8; measured 3 / 4 / 7). `break_hits` has once returned concrete >10 inside a full run under heavy load (rerun: 7); the max was raised to 12 hits.
- `scripts/munition-lab.cjs`: 72/73, the one soft fail (`fire_spread`, random) as before. Changed on purpose: `he_masonry` (masonry 1.5 m from an HE burst takes >10%, was >25%: measured 16%) and `sticky_reactive` (the masonry behind a reactive plate takes >3%, was >10%). New: `canister_spread` (6 men at 30 m: canister 6, HE 3; at 62 m canister 2.3; every other man shielded: 3).
- `scripts/level-stability.cjs all 10`: 0 bad levels.
- `scripts/soak.cjs outpost,millford,cleancut,kestrel 60 1` (WORKERS=1, GEN=1): 0 violations; the frame-time spikes it lists were taken while three other lab runs shared the machine.

### Reproduce

```bash
npx vite --port 5202 --host 127.0.0.1 --strictPort &
BASE=http://127.0.0.1:5202 NODE_PATH=$(npm root -g) DIFF_ALL=1 node scripts/value-lab.cjs difficulty          # ~40 min, 2 pages
DIFF_SIGMA=0.9 BASE=... node scripts/value-lab.cjs difficulty                                                  # casual gunner
BASE=... node scripts/value-lab.cjs material,shot,group,niche 3
```

`DIFF_OPS=millford,redhill` limits the operations (research then starts from scratch unless `DIFF_TECH=ord_he,gun_charge,…` is given), `DIFF_SEEDS` sets seeds per round.

# Munition balance

*(The previous pass, kept for reference; its numbers predate the damage and difficulty pass above.)* *Is every round worth its price?* This note answers that with measurements from `scripts/value-lab.cjs`, lists the behaviour bugs the measurements turned up, and records the price and stat changes made in response. All "before" numbers are from the code as it stood after the first objective rule below was merged. "After" numbers are from the current code, which also carries main's later velocity-scaled objective hits and its bunker-buster fracture.

## The objective rule

Since commit *Objectives die to one direct hit or two near misses*, an objective dies to one square, hard direct hit from any real shell (not pellets, smoke or flak). A later commit on main scaled this: the kill speed along the face normal depends on how hard the round punches, and a slower hit does a share. Any blast that reaches an objective takes up to 55% of its HP, in proportion to the blast's damage. So raw damage against objectives no longer separates the rounds. What separates them now:

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
| Round Shot | 40 → 40 | baseline; open lines | cheapest win: Millford, Kurogane | lab: cheapest sure kill on the tower-top post (40), the toppling tower (80) and the open gun line (187) | fair (baseline) | fair |
| High Explosive | 130 → **80** | general demolition | Kestrel HP 552/100 cr (0.73× shot); infantry 2.7 kills/100 cr (0.3× shot); never the cheapest win | Kestrel HP 847/100 cr (best); cheapest win on Kestrel (1280) | overpriced | fair |
| Heavy Shell | 140 → **70** | knocking down timber and masonry | Kurogane HP 0.67× shot; timber lab 140 cr (shot 80) | timber blockhouse 70 cr (best); Kurogane won for 257 cr (best of all rounds) | overpriced | fair |
| Armor-Piercing | 120 → **130** | reaching inner rooms through masonry and earth | cheapest win on 11 of 16 operations | cheapest win on 6 of 16 (Kurogane, Causeway, Ironmill, Citadel, Zoo Flak, Warden) | underpriced (dominant) | fair, the premium masonry round |
| Incendiary | 100 → **75** (radius 2.2 → 3) | timber, garrisons, rooms | Kestrel garrison 0.73/100 cr (0.5× shot); HP 0.58× | Kestrel: rooms opened 1.65/100 cr (best), garrison 1.71 (second to the bunker buster), HP 824 | overpriced | fair |
| Bunker Buster | 260 → **240** | concrete | Greywater HP 2.9× base, but its cheapest win (1040) lost to AP (640) | Greywater HP 548/100 cr (best); cheapest win on Greywater (720) and the Abbey (960) | overpriced (dominated by AP) | fair |
| Cluster Shell | 170 → **110** (bomblets 30 → 40 dmg, radius 1.6 → 2) | several targets at once; forts with exposed objectives | infantry 1.4 kills/100 cr; cheapest win nowhere | cheapest win on 6 of 16 (Outpost, Millford, Saltworks, Bastion, Ironcrown, Black Citadel) | overpriced | fair (the strongest after AP; watch it) |
| Delayed Fuse | 110 → **80** | rolling into rooms | Kestrel HP 0.81× shot; cheapest win nowhere | Millford HP 278/100 cr (best); Kestrel HP 817 (≈ HE) | overpriced | fair, marginal |
| Sticky Charge | 120 → **70** (speed 0.75 → 0.9) | reactive armour | out of reach at Kestrel (0 rounds fired) and Greywater; reactive lab 440 cr | Bastion won for 397 cr (best); reactive lab 187 cr (best except the drill, which needs open ground); Kurogane HP 772/100 cr (best) | broken range, overpriced | fair |
| Burrowing Drill | 190 → **140** (behaviour fixed) | ground-floor targets behind walls; earthworks | fizzled on any wall it clipped; 0 objectives on any castle; Clean Cut lost; earth lab 1013 cr | Clean Cut won for 560 (no shell can win it); lab: reactive, earth and casemate 140 cr each (best) | useless | fair, situational |
| Canister Shot | 35 → **30** | infantry | tied with round shot; flak out-killed it with 25% shields (7.7 vs 6.0/100 cr) | best in every infantry test: 7.0–10.4/100 cr (14.8 in a crowd) | fair, but flak dominated it | best for infantry |
| Flak Burst | 45 → **40** | aircraft | canister out-shot it against aircraft (gyro 24.5 vs 22.2 kills/1000 cr) and nearly matched it against infantry | gyro 25 kills/1000 cr (canister 15); airship 8.3 (canister 6.9); infantry 1.1–1.8 kills a round | dominated | best for aircraft |
| Smoke Screen | 60 → 60 | counter-battery | 6 rounds (360 cr) cut gun damage over 90 s from 96 to 9.5 HP (8 shots to 3) | same (100 → 9.6) | fair | fair |
| Scout Drone | 80 → **100** (default fixed) | finding walled-up rooms | default loiter point opened 1/12, 0/20 and 0/28 hidden rooms on the big castles | default point opens 11/12, 18/20 and 13/28 | broken default; underpriced when placed by hand | underpriced on purpose (see below) |
| Saboteur | 160 → **120** (charge 190 → 260, tamped, concrete ×1.8, earth ×2) | breaching casemates and reactive walls | casemate 320 cr; Bastion HP 0.87× | casemate 120 cr (best); Clean Cut won for 600; Bastion HP 352/100 cr | overpriced | fair |
| Air Strike | 340 → **250** (GP bomb 120 → 150 dmg, radius 3.2 → 3.6) | roofs and forts without flak | Bastion HP 226/100 cr; Kurogane 0.49× | Bastion HP 401/100 cr (best); earth lab 250; Clean Cut won for 750 | overpriced | fair (useless under flak, by design) |

Every round now has at least one measurement in which it is the cheapest per credit (or, for smoke and the drone, the only round that does the job), and no round is strictly dominated.

### Campaign: each operation with a single round type inside its budget (credits spent to win)

Base research, the lab gunner, seed 1. × means not won inside the budget.

| operation | budget | shell | HE | AP | bunker | cluster | delayed | cheapest before | cheapest after |
|---|---|---|---|---|---|---|---|---|---|
| outpost | 900 | 480 | 400 | 520 | 480 | 330 | 720 | AP 240 | cluster 330 |
| millford | 1100 | 120 | 160 | 130 | 240 | 110 | 160 | shell 80 | cluster 110 |
| cleancut | 1000 | × | × | × | × | × | × | saboteur 480, air strike 680 | drill 560, saboteur 600, air strike 750 |
| redhill | 2300 | 480 | 560 | 390 | 960 | 550 | 480 | shell 200 | AP 390 |
| saltworks | 2650 | 920 | 1200 | 780 | 720 | 660 | 1840 | bunker 780 | cluster 660 |
| bastion | 1300 | 640 | 640 | 650 | 480 | 440 | 640 | AP 360 | cluster 440 |
| causeway | 2900 | 720 | 720 | 260 | 480 | 550 | 720 | AP 480 | AP 260 |
| ironmill | 4100 | 1720 | 1520 | 1300 | 1440 | 1540 | 2080 | bunker 1040 | AP 1300 |
| citadel | 1800 | 880 | 960 | 390 | 480 | 660 | 880 | AP 360 | AP 390 |
| greywater | 3450 | 1440 | 1760 | 1040 | 720 | 880 | 2960 | AP 720 | bunker 720 |
| hollowcrown | 3050 | 2160 | 1840 | 1170 | 960 | 1320 | 2480 | AP 720 | bunker 960 |
| thronefall | 4100 | 2240 | 1680 | 650 | 720 | 990 | 1920 | AP 840 | AP 650 |
| kestrel | 5050 | 2040 | 1280 | 1560 | 2400 | 1430 | 2720 | AP 1440 | HE 1280 |
| ironcrown | 5600 | 4560 | 1680 | 2470 | 2880 | 1650 | 2640 | AP 1560 | cluster 1650 |
| warden | 5500 | 3440 | 5360 | 1430 | 2400 | 2970 | 3840 | AP 1800 | AP 1430 |
| blackcitadel | 7250 | 5080 | 3360 | 2990 | 3120 | 1980 | 4080 | AP 2880 | cluster 1980 |

Every operation is won with a single round type for at most 56% of its budget (Clean Cut, with the drill), and every other operation for at most 37%. Clean Cut is built for a specialist: it is a steel-roofed concrete bunker that no shell can reach. Before the changes, only the saboteur and the air strike won it (the drill, the round built for it, did not). Now the drill wins it too, and most cheaply. Prices fell on average, so budgets buy more than before. The one-hit objective rule had already made the campaign easier than the budgets assumed, so no budget was changed. Before, AP was the cheapest win on 11 of 16 operations. Now the cheapest wins are spread over AP (6), cluster (6), the bunker buster (2), HE (1) and the specialists (Clean Cut).

### Niche scenes (credits to destroy the target)

× means not destroyed in 8 rounds; (k/3) means destroyed in only k of 3 trials. The "topple" scene (a boxed-in post on a slender tower) and the "battery" scene (an open gun line of three guns) were added after the before run.

| round | reactive (before → after) | earth berms | concrete casemate | timber blockhouse | tower-top post | topple | gun line of 3 |
|---|---|---|---|---|---|---|---|
| shell | × → × | × | × | 80 → 147 | 40 → **40** | **80** | **187** |
| HE | 477 → 293 | × | 780 → 480 | 130 → 80 | 130 → 80 | 213 | 347 |
| heavy | 490 (2/3) → 373 | × | 630 (2/3) → 233 | 140 → **70** | 140 → 70 | 210 | 257 |
| AP | 240 → 260 | **280** → 260 | 240 → 260 | 120 → 130 | 120 → 130 | 390 | 607 |
| incendiary | × → 600 (1/3) | × | × | 200 → 275 | 167 → 125 | 338 (2/3) | 350 |
| bunker | 520 → 480 | 607 → 480 | 260 → 240 | 260 → 240 | 260 → 240 | 720 | 800 |
| cluster | 1360 (1/3) → × | 680 → 330 | × | 850 → 367 | 170 → 110 | 220 | 367 |
| delayed | 697 → 360 (2/3) | × | × | 147 → 107 | 110 → 80 | 213 | 293 |
| sticky | 440 → 187 | × | 680 → 420 (1/3) | 160 → 93 | 120 → 70 | 140 | 233 |
| drill | **190** → **140** | 1013 → **140** | **190** → 140 | 190 → 140 | 887 → 513 | 513 | 420 |
| saboteur | 320 → 280 | × → 600 | 320 → **120** | 160 → 120 | 747 → 160 | 200 | 480 |
| air strike | 680 → 333 | 680 → 250 | 1020 → 500 | 340 → 250 | 510 (2/3) → 333 | 417 | 583 |

The drill wins the lab scenes only when it has open ground within its 12 m run. On the campaign hills it lands on open ground in only about half of its shots (7 of 15 in the `pen` section), so its campaign niche is narrower than the lab suggests.

Under main's velocity-scaled hits, cluster bomblets are slow and light, so each does only a share of a direct hit. A single cluster round therefore no longer clears an open gun line (it did, for 120 cr, before that change). Cluster's campaign wins come from bomblets raining onto exposed objectives.

### Infantry (kills per 100 credits, one led round at a file of men)

| test | canister | shell | HE | cluster | flak | incendiary |
|---|---|---|---|---|---|---|
| 4 men, no shields: before | 9.2 | 8.9 | 2.7 | 1.4 | 8.2 | 2.4 |
| 4 men, no shields: after | **10.4** | 8.9 | 4.7 | 3.3 | 4.4 | 4.2 |
| 4 men, 25% shields: before | 6.0 | 4.2 | 2.7 | 1.4 | **7.7** | 2.3 |
| 4 men, 25% shields: after | **7.0** | 4.2 | 4.4 | 2.2 | 3.6 | 3.7 |
| 4 men, 55% shields: before | 6.7 | 3.1 | 2.5 | 1.1 | 6.2 | 2.1 |
| 4 men, 55% shields: after | **7.8** | 3.1 | 3.5 | 2.0 | 2.8 | 3.4 |
| crowd of 8, 25% shields: after | **14.8** | 4.4 | 5.4 | 3.9 | 4.4 | 4.7 |

### Aircraft (kills per 1000 credits)

| | flak | HE | shell | canister | cluster |
|---|---|---|---|---|---|
| gyro: before | 22.2 | 4.6 | 15.0 | **24.5** | 3.9 |
| gyro: after | **25.0** | 7.5 | 15.0 | 15.4 | 6.8 |
| airship: before | 7.4 | 2.4 | 6.0 | **9.0** | 2.7 |
| airship: after | **8.3** | 4.0 | 6.0 | 6.9 | 4.6 |

### Drone against blasting the wall

| castle | hidden rooms (with an objective) | 1 drone, default point: before → after | 1 drone, best point chosen by hand | HE rounds to breach one hidden room |
|---|---|---|---|---|
| Kurogane | 3 (1) | 2 → 3 | 3 | 1.7 |
| Zoo Flak Tower | 12 (1) | 1 → 11 | 12 | 5.8 |
| Kestrel | 20 (0) | 0 → 18 | 20 | 4.3 |
| Black Citadel | 28 (3) | 0 → 13 | 24 | 5.2 |

Breaching one walled-up room costs 2 to 6 HE rounds, or 130 to 470 cr at the new HE price. A player who does not know which room holds the objective must, on average, search (N+1)/(k+1) rooms, where N is the number of hidden rooms and k the number with an objective. On the Black Citadel that is (28+1)/(3+1) ≈ 7 rooms, or about 38 HE (3000 cr). One drone, now opening 13 rooms from its default point, replaces almost all of that.

The drone is therefore underpriced even at 100. It is kept cheap on purpose: it is information, the level design assumes you take one, and raising its price would only tax a purchase every player must make. Fire and incidental breaches also open rooms (0.4–1.7 rooms per 100 cr of shelling, from the equal-spend tables), so the drone's value shrinks once a castle is already being shelled.

### Equal spend, block HP removed per 100 cr (after)

| round | Millford | Bastion | Kurogane | Greywater | Kestrel |
|---|---|---|---|---|---|
| shell | 256 | 178 | 589 | 143 | 386 |
| HE | 247 | 217 | 659 | 138 | **847** |
| heavy | 262 | 228 | 631 | 176 | 517 |
| AP | 179 | 201 | 568 | 288 | 477 |
| incendiary | 226 | 108 | 490 | 45 | 824 |
| bunker | 161 | 372 | 585 | **548** | 796 |
| cluster | 228 | 292 | 595 | 299 | 721 |
| delayed | **278** | 223 | 618 | 70 | 817 |
| sticky | 246 | 351 | **772** | 213 | 794 |
| drill | 211 | 187 | 425 | 324 | 347 |
| saboteur | 243 | 352 | 272 | 269 | 377 |
| air strike | 148 | **401** | 510 | 202 | 35 (flak) |

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
- **Engineers' demolition charges** are tamped against the target, so they beat a shell of the same weight against concrete. That is why the saboteur now beats the bunker buster against a casemate it can walk up to (120 cr against 240).
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
