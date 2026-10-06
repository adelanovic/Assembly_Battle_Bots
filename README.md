# Battle Bots

Program robots in a small assembly language and watch them fight in a 2D arena.

![Battle Bots: arena, roster and match log](docs/screenshot.png)

## Quick start

There is nothing to install and no build step.

1. Open `index.html` in a modern browser (Chrome, Edge or Firefox). Double-clicking the file works.
2. Four example robots are preloaded. Press **▶ Start**.

If you prefer to serve it, any static server works, for example `python -m http.server` and then http://localhost:8000.

Node.js (v16+) is only needed for the optional command-line tools:

```sh
npm test              # assembler, VM and simulation tests
npm run match         # one headless match between the examples, printed to the terminal
npm run tournament    # 50 seeds, win counts per robot
node tools/headless.js --seed 7 my_bot.asm examples/hunter.asm
node tools/headless.js --rounds 50 --arena random my_bot.asm examples/*.asm   # test across 50 random maps
npm run build         # regenerate examples/*.asm and docs/LANGUAGE.md from the JS sources
```

## Using the sandbox

| Control | What it does |
|---|---|
| **▶ Start / ❚❚ Pause** (Space) | Run or pause the match. |
| **⏭ Step** (`.`) | Advance exactly one tick. The CPU inspector and the yellow gutter marker show the next line each robot will execute. |
| **↺ Reset** (`R`) | Respawn every robot with its *applied* code. The seed decides spawn points and `RAND`, so a seed always replays the same match. |
| **Arena** | **Classic** is the fixed default layout. **Random** generates a mirrored obstacle layout from the seed, so 🎲 gives a new map and the same seed always gives the same map. **Open** has no obstacles, which is useful for testing aim and dodging. |
| **Speed** | 0.1× to 60× (6 to 3600 ticks per second). |
| **+ New robot / 📂 Load .asm files… / + Add example** | Add robots. Loading accepts several files at once, and you can also drag and drop `.asm` files onto the page. **Each file becomes one robot.** |
| **Editor → Apply** (Ctrl+Enter) | Assemble the code and use it. Before the match starts, the arena resets. During a match, the robot hot-swaps to the new program without losing its position or health. |
| **💾 Save .asm** (Ctrl+S) | Download the editor contents as a `.asm` file. |
| **Revert** | Discard edits you have not applied. |

The editor checks your code as you type. Errors appear under the editor and in the line gutter, and clicking an error jumps to that line. Robots with syntax errors stay in the roster but are left out of the arena until fixed. The roster is saved in your browser's `localStorage`.

## Robot files

```asm
Sniper Sam                ; line 1 = robot name
.def RANGE 300            ; optional constants
main:
    SCAN 20               ; look for an enemy in a 20° cone around the turret
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   sweep            ; -1 = nothing found
    GET  R1, SCAN_ANGLE
    AIM  R1
    FIRE
    WAIT                  ; end this tick
    JMP  main
sweep:
    GET  R1, TURRET
    ADD  R1, 15
    AIM  R1
    WAIT
```

The full instruction and sensor reference is on the in-app **Reference** tab and in [docs/LANGUAGE.md](docs/LANGUAGE.md). Both are generated from the same table the assembler uses. In summary:

- **Registers:** R0 to R7. **Memory:** 256 words (`[12]`, `[R1]`, `[R1+4]`). **Stack:** 64 entries, shared by PUSH/POP and CALL/RET.
- **Data and arithmetic:** MOV PUSH POP ADD SUB MUL DIV MOD INC DEC NEG ABS MIN MAX AND OR XOR RAND
- **Math:** ATAN2 SIN COS SQRT NORM
- **Flow:** CMP JMP JE JNE JL JLE JG JGE CALL RET NOP WAIT HALT
- **Robot:** GET (read a sensor), SPEED, TURN, HEAD, AIM, FIRE, SCAN (enemies), RADAR (incoming projectiles)
- **Sensors:** X Y HEADING SPEED HEALTH COOLDOWN TURRET SCAN_* THREAT_* FRONT LAST_HIT TICK ENEMIES ARENA_W ARENA_H

There is no "dodge" instruction. Robots dodge by calling `RADAR` to find an incoming projectile and its direction, then moving out of its path with `HEAD` and `SPEED`. See `dodge:` in the Sentinel and Dodger examples.

### Example robots (`examples/`)

| Robot | Strategy |
|---|---|
| **Sentinel** | Stationary sniper. Narrow sweeping scan, leads moving targets, sidesteps bullets (and reverses when that needs less turning). |
| **Hunter** | Aggressive chaser. Wide scan, charges straight at the enemy, fires when lined up, never dodges. |
| **Dodger** | Evasive skirmisher. Always moving, bounces off walls, swerves away from every projectile, independent turret. |
| **Orbiter** | Circle-strafer. Locks on, orbits at about 200 units while firing, flips direction near walls. |

## Rules of the arena

- 800×600 arena. Rectangular obstacles block movement, bullets and scans.
- Arena layouts:
  - **Classic:** five fixed obstacles.
  - **Open:** none.
  - **Random:** 4 to 9 obstacles generated from the seed, with these guarantees:
    - **Fair:** every obstacle has a twin mirrored through the arena centre.
    - **Passable:** obstacles keep a 44-unit gap from each other and the walls, wider than a robot, so every open area can be reached.
    - **Solid:** obstacles are at least 20 units thick, so bullets can't pass through.
    - **Open enough:** obstacles cover at most 11% of the arena.
- Each tick, every living robot gets **the same 50-cycle budget** (SCAN and RADAR cost 3, everything else costs 1). The order robots run in rotates every tick, and the world is frozen while programs run, so order gives no advantage.
- Movement is physical. Speed is −3 to 5, acceleration 0.5 per tick, the body turns up to 8° per tick and the turret up to 20° per tick.
- Bullets travel 10 units per tick and deal 10 damage, with a 15-tick cooldown between shots. Hitting a wall at speed deals speed/2 damage. Ramming deals 1 damage to both robots.
- A robot at 0 HP is destroyed. **The last robot standing wins.** After 6000 ticks, the highest health wins, and a tie is a draw. A single robot runs in practice mode with no victory check.

## Safety: bad code can't break the arena

- **Infinite loops:** the VM stops after the robot's cycle budget each tick and resumes on the next tick, so a `loop: JMP loop` only wastes its own robot's time.
- **Runtime errors** (division by zero, stack overflow, memory out of range, SQRT of a negative number): the robot's CPU *faults* and halts with a message such as `Line 12: division by zero`, shown in the inspector and the match log. Its body stays in the arena. Other robots are unaffected.
- **Isolation:** a VM only has its own registers, memory and stack, plus a narrow I/O interface (`sense`, `speed`, `aim`, …). It never touches world objects directly. JavaScript exceptions are trapped per robot.

## Architecture

```
index.html            page layout; loads scripts in order (no bundler, works from file://)
css/style.css
js/core/              pure logic, no DOM: runs in the browser and in Node
  isa.js              instruction set, sensors, constants (single source of truth)
  assembler.js        source -> program, or a list of { line, message } errors
  vm.js               isolated CPU with cycle budget and fault handling
  geometry.js         angles, ray/rect tests, collision push-out, seeded RNG
  world.js            arena simulation: tick loop, physics, sensors, damage, victory
  examples.js         built-in example robots
js/ui/
  renderer.js         canvas drawing and visual effects (read-only view of the world)
  editor.js           textarea editor with highlighting, gutter, error and exec markers
  app.js              roster, controls, editor wiring, inspector, persistence, main loop
tools/                Node CLI: headless matches, doc and example generation
tests/run-tests.js    dependency-free test suite
examples/*.asm        example robots as loadable files
docs/LANGUAGE.md      generated language reference
```

Data flows one way: **source → `assemble()` → program → `VM` (one per robot) → `World.step()` → `Renderer.draw()`**. To add an instruction, add a row to `INSTRUCTIONS` in `isa.js` and a `case` in `VM.exec`. The assembler, the in-app reference and `docs/LANGUAGE.md` (after `npm run build`) pick it up automatically.
