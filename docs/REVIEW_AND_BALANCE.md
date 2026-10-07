# Second review and balance exploration

Reviewed on 2026-10-07. The five fixes from the previous review pass the full suite: 49 tests, zero failures. This pass examines source and runs headless simulations; it does not verify browser layout or assistive technology behavior.

Follow-up: findings 1–4 below have now been fixed. FRONT uses swept-circle terrain clearance, playback uses elapsed time with bounded catch-up, collision contacts are resolved iteratively, and CLI integer options are validated before reading files. The suite now passes 55 tests. Empty-roster behavior is intentionally unchanged. The balance measurements below were collected before these follow-up physics/sensor fixes and remain a historical baseline; rerun the experiment for current balance figures.

## Remaining correctness issues

1. **Medium: FRONT misses obstacles that the robot's body will hit.** `World.freeDistance()` casts a ray from the center and subtracts the radius from the result, rather than testing the swept body. With obstacle `{x:100,y:200,w:20,h:100}`, a robot at `(84,190)` facing east reads FRONT=700. One tick at speed 5 hits the corner and reduces health to 98. See `js/core/world.js:310`. A swept-circle query would make the sensor useful for body clearance and wall avoidance.
2. **Medium: playback speed depends on screen refresh rate.** `App.frame()` advances a fixed number of ticks per animation frame. At the displayed 1x speed, 60 frames produce 60 ticks and 120 frames produce 120 ticks. See `js/ui/app.js:204`. Accumulate elapsed time with a fixed tick duration, with an explicit catch-up limit after suspension. Simulation outcomes at a given tick remain deterministic; wall-clock pacing changes.
3. **Medium: collision separation can leave bodies overlapping.** The previous fix correctly restores walls and obstacles, but does not resolve overlap again after that correction. Robots at x=16 and x=40, y=300, end a tick at x=16 and x=44: distance 28, below their 32-unit diameter. See `js/core/world.js:455`. Use a bounded iterative contact solver to enforce both terrain clearance and robot separation when space permits.
4. **Low: invalid CLI numeric options silently succeed.** `--rounds nope` produces no match and exits successfully because `NaN` skips the loop. Negative and zero round counts also run nothing. See `tools/headless.js:17`. Validate complete integer inputs, missing values, and allowed ranges before reading robots or running matches.
5. **Low: clearing the roster does not survive reload.** `restore()` only accepts a saved roster when its length is nonzero, so an intentionally empty roster is replaced with examples. See `js/ui/app.js:502`. Accept an empty saved array as valid state. This issue was already identified in the first review and was outside the requested five fixes.

These findings are reported for follow-up; this pass does not change gameplay rules or controller behavior.

## What users can adjust today

| Parameter | Where | Balance consequence |
|---|---|---|
| Arena: Classic / Random / Open | Toolbar | Changes sight lines, available cover, wall contacts, and space to dodge. Compare strategies across all three. |
| Seed | Toolbar | Changes spawns, random decisions, and Random terrain. A single seed is a replay, not a useful estimate of strength. |
| FFA / 2v2 / 3v3 and team picks | Toolbar and roster | Focus fire, target selection, mirrored spawns, friendly collision blocking, and summed-health time limits alter strategy value. |
| Robot code and `.def` constants | Editor | Main balance controls available to players; Apply rejects invalid drafts. |
| SPEED / TURN / HEAD / AIM / SCAN arguments | Robot program | Physical limits clamp commands. Wider scans cost the same 3 cycles as narrow scans; narrow scans are a targeting choice, not a cheaper sensor. |
| Playback speed, Step, scan visuals | Toolbar | Inspection/presentation controls; they do not change physics per tick. Playback currently has the refresh-rate issue above. |

There are no UI sliders for health, damage, fire cooldown, bullet speed, turning rate, acceleration, CPU budget, or match duration. These are source-level `CONFIG` values in `js/core/isa.js`. Map generation gaps, thickness, and coverage are separate `GEN` values in `js/core/world.js`.

## Parameter interactions

- **Aim tolerance depends on range.** A radius-16 target subtends roughly 11.5 degrees at distance 80, 4.6 degrees at 200, and 3.1 degrees at 300. Hunter's ALIGN=8 can work nearby but waste shots farther away. Movement, firing after turret rotation, and imperfect interception change these estimates.
- **Dodging needs time and room.** DODGE_RANGE=200 gives roughly 20 ticks before a speed-10 projectile reaches a stationary robot. A quarter-turn at body turn rate 8 takes about 12 ticks; reaching speed 5 from rest takes 10 ticks, concurrently. Earlier detection can help, but unnecessary evasions cause wall contacts and interrupt targeting. RADAR_RANGE=250 caps the effective detection threshold.
- **Wall clearance needs body-aware sensing.** Dodger's WALL_GAP=60 is approximately 12 ticks of travel at full speed; increasing it can reduce collisions but can also produce excessive steering in narrow corridors. The FRONT bug confounds tuning this parameter.
- **Sweep rate saturates.** Turrets rotate at most 20 degrees per tick, so commanding a search step greater than 20 does not increase physical rotation. Hunter already asks for 45; Sentinel asks for 9. Faster searching trades target acquisition against maintaining narrow-cone locks.
- **Orbit range competes with terrain and accuracy.** Orbiter's RANGE=200 and LOCK_WIDTH=16 control its preferred orbit and reacquisition. A wider cone has the same CPU cost, but may switch to a nearer opponent in FFA. A smaller orbit improves target angular size while increasing collision and pursuit pressure.
- **CPU budget changes action timing.** The examples contain paths longer than 50 cycles, especially Sentinel's lead/dodge routines. Execution resumes next tick, so reducing the budget affects advanced bots differently from short loops. The same budget for everyone does not imply the same strategy impact.
- **Bullet speed is coupled to robot code.** Sentinel's lead calculation hard-codes a divisor of 10000: trig scale 1000 times bullet speed 10 (`js/core/examples.js:72` and `:75`). Changing BULLET_SPEED without updating this formula miscalibrates its aim. The sensitivity experiment deliberately retains stock robot code to show the current consequence.
- **Avoid arbitrary radius or map-size changes.** Map spacing, renderer hull sizes, classic terrain, mirrored coordinates, and spawn margins assume the current geometry. Changing these constants is broader than a simple balance adjustment.

## Reproducing the experiments

Run `node tools/balance.js 20 > docs/balance-results.json`. Increase the seed count for more confidence; the script accepts 1..1000. It changes parameters only in its own process and restores defaults between scenarios.

The study runs stock four-robot FFA, eight single-constant robot variants, seven single-rule variants, and homogeneous 2v2 pairings. Each FFA seed is replayed with four cyclic roster orders so every robot occupies each spawn slot. Team pairings swap both sides for each seed and arena. Cyclic order and side variants are correlated observations, not additional independent seeds. Mixed teams, 3v3, custom robots, and interactions between multiple changed parameters are outside this study.

Metrics include wins, draws, time-limit finishes, runtime faults, mean match ticks, and aggregate projectile hit rate. The JSON is the complete measured output; the summary below is a comparison of these particular example programs, not a guarantee about all possible robots.

## Measured results

The 20-seed run completed **4560 matches**, with **zero runtime faults**. Each FFA scenario contains 240 games: 80 per arena. The stock team study contains 720 games; each robot composition participates in 360 of those games against the other three compositions.

| Stock FFA arena | Sentinel wins | Hunter wins | Dodger wins | Orbiter wins | Time-limit finishes | Mean ticks |
|---|---:|---:|---:|---:|---:|---:|
| Classic (80 games) | 5 | 0 | 15 | 60 | 2 | 1657 |
| Random (80 games) | 14 | 0 | 18 | 48 | 2 | 1585 |
| Open (80 games) | 11 | 0 | 29 | 40 | 4 | 1449 |
| All (240 games) | 30 | 0 | 62 | 148 | 8 | 1564 |

Orbiter wins 61.7% of stock FFA games overall, including 75% on Classic. Dodger wins 25.8%, Sentinel 12.5%, and Hunter 0%. Open terrain reduces Orbiter's advantage to 50% and improves Dodger to 36.3%. No stock FFA matches draw. Only 8 of 240 hit the time limit, so the default 6000-tick limit is not the main cause of the measured imbalance.

| Homogeneous 2v2 composition | Wins / games entered | Win rate |
|---|---:|---:|
| Two Sentinels | 136 / 360 | 37.8% |
| Two Hunters | 9 / 360 | 2.5% |
| Two Dodgers | 244 / 360 | 67.8% |
| Two Orbiters | 331 / 360 | 91.9% |

Both sides are swapped on every seed. Orbiter's team advantage persists on all arenas: 119/120 on Classic, 117/120 on Random, and 95/120 on Open. This result applies to homogeneous teams and these three opponents, not mixed compositions or 3v3.

### Player-editable robot constants

Only the listed robot's one constant changes; opponents keep stock programs. Win counts compare that robot with its own baseline across the same seeds, maps, and cyclic roster orders.

| Change | Robot's stock wins / 240 | Variant wins / 240 | Interpretation |
|---|---:|---:|---|
| Sentinel SWEEP_STEP 9 -> 18 | 30 | 55 | Strongest tested improvement; improves on every arena (Classic 5 -> 17, Random 14 -> 19, Open 11 -> 19). |
| Sentinel DODGE_RANGE 200 -> 120 | 30 | 28 | No improvement; late detection is not a promising first adjustment. |
| Hunter CLOSE 80 -> 140 | 0 | 0 | Does not address the main weakness. |
| Hunter ALIGN 8 -> 4 | 0 | 1 | Negligible improvement in this sample. |
| Dodger WALL_GAP 60 -> 100 | 62 | 63 | Essentially unchanged; revisit after fixing FRONT. |
| Dodger DODGE_RANGE 220 -> 140 | 62 | 56 | Weaker overall, despite small gains on obstacle maps. |
| Orbiter RANGE 200 -> 120 | 148 | 132 | Reduces dominance on obstacle maps; Open stays at 40 wins. |
| Orbiter LOCK_WIDTH 16 -> 32 | 148 | 155 | Wider same-cost scans slightly improve overall wins; not a balancing nerf. |

With Sentinel SWEEP_STEP=18, Orbiter falls to 125/240 wins (52.1%) and Sentinel rises to 22.9%. This is a useful candidate for another seed set, not proof that 18 is optimal. Hunter remains weak even in that scenario.

### Source-level rule sensitivity

All stock robot programs remain unchanged. Mean ticks are averaged across equally sized arena samples; durations vary with both engagement rate and the strategies that win.

| Rule change | Sentinel wins | Hunter wins | Dodger wins | Orbiter wins | Draws | Mean ticks |
|---|---:|---:|---:|---:|---:|---:|
| Defaults | 30 | 0 | 62 | 148 | 0 | 1564 |
| CPU budget 50 -> 35 | 23 | 0 | 82 | 135 | 0 | 1958 |
| CPU budget 50 -> 65 | 22 | 1 | 58 | 157 | 2 | 1630 |
| Fire cooldown 15 -> 10 | 32 | 1 | 61 | 146 | 0 | 1216 |
| Fire cooldown 15 -> 20 | 28 | 1 | 68 | 143 | 0 | 1801 |
| Bullet speed 10 -> 8 | 35 | 0 | 48 | 156 | 1 | 1710 |
| Bullet speed 10 -> 12 | 35 | 2 | 71 | 132 | 0 | 1573 |
| Maximum forward speed 5 -> 4 | 28 | 2 | 71 | 139 | 0 | 1622 |

Shortening cooldown changes match pace much more than relative strength: average duration falls about 22%, while Orbiter still wins 60.8%. Reducing the CPU budget slows matches about 25% and favors Dodger at Sentinel's expense. Faster bullets reduce Orbiter's wins to 55%, but the hard-coded Sentinel lead formula makes this a coupled rule/code change rather than a clean setting to expose immediately. None of the tested rule changes rescues Hunter.

## Suggested order of work

1. Fix FRONT and refresh-rate pacing first. Use bounded iterative collision resolution for the remaining crowded-contact problem; validate CLI numeric inputs separately.
2. Keep the current global defaults while tuning the examples. Try Sentinel SWEEP_STEP=18 on a fresh seed range, and improve Hunter's targeting/evasion strategy rather than relying on CLOSE or ALIGN alone. Smaller Orbiter RANGE is a possible example-level nerf if the aim is more evenly matched demos.
3. Preserve Open as a player-selectable alternative and test all arenas before claiming a robot improvement. For a competition, rotate FFA spawn slots and swap team sides, as this experiment does.
4. If exposing new rule controls, start with integer fire cooldown, match length, and health/damage presets with documented bounds and a reset-to-default action. Cooldown has a measured pacing effect here; health/damage and match-length alternatives were not swept in this experiment. Persist the full ruleset and include it in replay/CLI output so seed-based replays remain meaningful.
5. Expose bullet speed only after making interception calculations use the selected rule, and validate collision detection at any supported upper speed. Treat geometry and CPU-budget controls as advanced settings because they interact with map passability and program execution semantics.

No gameplay defaults or example programs were changed by this analysis.
