#!/usr/bin/env node
// Minimal dependency-free test suite: node tests/run-tests.js
'use strict';
const assert = require('assert');
const BB = require('../tools/load-core')();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/** Run a program on a VM with a fake I/O and return the VM. */
function runVM(src, budget = 1000, ioOverrides = {}) {
  const res = BB.assemble(src);
  assert.deepStrictEqual(res.errors, [], 'unexpected assembly errors');
  const calls = [];
  const io = Object.assign({
    sense: () => 7, random: () => 0,
    speed: (v) => calls.push(['speed', v]), turn: (v) => calls.push(['turn', v]),
    head: (v) => calls.push(['head', v]), aim: (v) => calls.push(['aim', v]),
    fire: () => calls.push(['fire']), scan: (w) => calls.push(['scan', w]), radar: () => calls.push(['radar']),
  }, ioOverrides);
  const vm = new BB.VM(res.program, io);
  vm.calls = calls;
  vm.run(budget);
  return vm;
}

const errorsOf = (src) => BB.assemble(src).errors;

console.log('Assembler');
test('name is taken from line 1', () => {
  assert.strictEqual(BB.assemble('Robo Bob\nNOP').name, 'Robo Bob');
});
test('missing name is an error', () => {
  assert.match(errorsOf('\nNOP')[0].message, /Line 1/);
});
test('unknown instruction suggests a fix, with correct line number', () => {
  const e = errorsOf('Bot\nNOP\n  MOOV R0, 1');
  assert.strictEqual(e[0].line, 3);
  assert.match(e[0].message, /Did you mean MOV/);
});
test('wrong operand count', () => {
  assert.match(errorsOf('Bot\nADD R0')[0].message, /takes 2 operands/);
});
test('undefined label', () => {
  assert.match(errorsOf('Bot\nJMP nowhere')[0].message, /Unknown label/);
});
test('duplicate label', () => {
  assert.match(errorsOf('Bot\na:\na: NOP')[0].message, /already defined/);
});
test('immediate cannot be a destination', () => {
  assert.match(errorsOf('Bot\nMOV 5, R0')[0].message, /must be a register or memory/);
});
test('bad register', () => {
  assert.match(errorsOf('Bot\nMOV R9, 1')[0].message, /Registers are R0..R7/);
});
test('sensor used as a value gets a GET hint', () => {
  assert.match(errorsOf('Bot\nMOV R0, HEALTH')[0].message, /GET R0, HEALTH/);
});
test('unknown sensor', () => {
  assert.match(errorsOf('Bot\nGET R0, HELTH')[0].message, /Did you mean HEALTH/);
});
test('empty program', () => {
  assert.match(errorsOf('Bot\n; nothing')[0].message, /no instructions/);
});
test('multiple errors are all reported', () => {
  assert.strictEqual(errorsOf('Bot\nFOO\nBAR\nMOV R0').length, 3);
});
test('every example assembles cleanly', () => {
  for (const ex of BB.EXAMPLES) assert.deepStrictEqual(errorsOf(ex.source), [], ex.file);
});
test('the "+ New robot" template assembles cleanly', () => {
  assert.deepStrictEqual(errorsOf(BB.NEW_ROBOT_TEMPLATE), []);
});
test('a label named after an instruction is one error, not one per jump', () => {
  const e = errorsOf('Bot\nJMP turn\nJL turn\nturn: NOP');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].line, 4);
  assert.match(e[0].message, /is an instruction/);
});

console.log('VM');
test('arithmetic, constants and memory', () => {
  const vm = runVM(`T
.def K 5
MOV R0, K
MUL R0, 3
SUB R0, 1
MOV R1, 2
MOV [R1+3], R0
MOV R2, [5]
DIV R2, 4
MOV R3, -7
MOD R3, 360
HALT`);
  assert.strictEqual(vm.regs[0], 14);
  assert.strictEqual(vm.mem[5], 14);
  assert.strictEqual(vm.regs[2], 3);
  assert.strictEqual(vm.regs[3], 353);
});
test('compare, conditional jumps and loops', () => {
  const vm = runVM(`T
MOV R0, 0
loop:
INC R0
CMP R0, 10
JL loop
HALT`);
  assert.strictEqual(vm.regs[0], 10);
});
test('CALL / RET and the stack', () => {
  const vm = runVM(`T
CALL f
MOV R1, 1
HALT
f: PUSH 42
POP R2
RET`);
  assert.deepStrictEqual([vm.regs[1], vm.regs[2], vm.halted], [1, 42, true]);
});
test('math helpers', () => {
  const vm = runVM(`T
ATAN2 R0, 10, 0
ATAN2 R1, -1, 0
COS R2, 60
SQRT R3, 50
MOV R4, 270
NORM R4
HALT`);
  assert.deepStrictEqual([...vm.regs.slice(0, 5)], [90, 270, 500, 7, -90]);
});
test('instruction budget is enforced (infinite loop)', () => {
  const vm = runVM('T\nloop: JMP loop', 50);
  assert.strictEqual(vm.totalCycles, 50);
  assert.strictEqual(vm.halted, false);
});
test('WAIT yields the rest of the tick', () => {
  const vm = runVM('T\nINC R0\nWAIT', 50);
  assert.strictEqual(vm.regs[0], 1);
});
test('program wraps around at the end', () => {
  const vm = runVM('T\nINC R0', 10);
  assert.strictEqual(vm.regs[0], 10);
});
test('division by zero faults with line number', () => {
  const vm = runVM('T\nMOV R0, 1\nDIV R0, R1');
  assert.ok(vm.halted);
  assert.match(vm.fault, /Line 3: division by zero/);
});
test('stack overflow faults', () => {
  const vm = runVM('T\nf: CALL f');
  assert.match(vm.fault, /stack overflow/);
});
test('out-of-range memory faults', () => {
  const vm = runVM('T\nMOV R0, 300\nMOV [R0], 1');
  assert.match(vm.fault, /out of range/);
});
test('robot actions go through io', () => {
  const vm = runVM('T\nSPEED 5\nAIM 90\nFIRE\nGET R0, HEALTH\nHALT');
  assert.deepStrictEqual(vm.calls, [['speed', 5], ['aim', 90], ['fire']]);
  assert.strictEqual(vm.regs[0], 7);
});

console.log('World');
const compile = (src, id) => { const r = BB.assemble(src); return { id, name: r.name, program: r.program, appearance: r.appearance }; };
test('a faulty / looping robot does not affect others', () => {
  const looper = compile('Looper\nl: JMP l', 0);
  const crasher = compile('Crasher\nDIV R0, 0', 1);
  const mover = compile('Mover\nSPEED 5\nWAIT', 2);
  const w = new BB.World({ entries: [looper, crasher, mover], seed: 3 });
  const start = { x: w.robots[2].x, y: w.robots[2].y };
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(w.robots[1].vm.fault);
  assert.ok(!w.robots[0].vm.fault);
  assert.ok(Math.hypot(w.robots[2].x - start.x, w.robots[2].y - start.y) > 20, 'mover should have moved');
});
test('every robot gets the same budget per tick', () => {
  const a = compile('A\nl: JMP l', 0), b = compile('B\nl: INC R0\nJMP l', 1);
  const w = new BB.World({ entries: [a, b], seed: 1 });
  for (let i = 0; i < 10; i++) w.step();
  assert.strictEqual(w.robots[0].vm.totalCycles, 10 * BB.CONFIG.CYCLES_PER_TICK);
  assert.strictEqual(w.robots[1].vm.totalCycles, 10 * BB.CONFIG.CYCLES_PER_TICK);
});
test('shooting a stationary target destroys it and ends the match', () => {
  const shooter = compile(`Shooter
l: SCAN 90
GET R0, SCAN_DIST
CMP R0, 0
JL spin
GET R1, SCAN_ANGLE
AIM R1
FIRE
WAIT
JMP l
spin: GET R1, TURRET
ADD R1, 45
AIM R1
WAIT
JMP l`, 0);
  const dummy = compile('Dummy\nWAIT', 1);
  // Seed search: ensure the two have line of sight at some point; they are static so pick a seed that works.
  let won = false;
  for (let seed = 1; seed <= 10 && !won; seed++) {
    const w = new BB.World({ entries: [shooter, dummy], seed });
    while (!w.over) w.step();
    won = w.winner && w.winner.name === 'Shooter' && !w.robots[1].alive;
  }
  assert.ok(won);
});
test('simulation is deterministic for a seed', () => {
  const entries = BB.EXAMPLES.map((e, i) => compile(e.source, i));
  const run = () => { const w = new BB.World({ entries, seed: 42 }); for (let i = 0; i < 800; i++) w.step(); return w.robots.map((r) => [r.x, r.y, r.health]); };
  assert.deepStrictEqual(run(), run());
});
test('example free-for-all always terminates with a result', () => {
  const entries = BB.EXAMPLES.map((e, i) => compile(e.source, i));
  for (let seed = 1; seed <= 10; seed++) {
    const w = new BB.World({ entries, seed });
    while (!w.over) w.step();
    assert.ok(w.tick <= BB.CONFIG.MAX_TICKS);
    for (const r of w.robots) assert.strictEqual(r.vm.fault, null, `${r.name} faulted: ${r.vm.fault}`);
  }
});

console.log('Arenas');
const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const randomMap = (seed) => BB.World.makeObstacles('random', seed);
test('random arenas are reproducible from the seed and vary between seeds', () => {
  assert.deepStrictEqual(randomMap(7), randomMap(7));
  const distinct = new Set(SEEDS.slice(0, 50).map((s) => JSON.stringify(randomMap(s))));
  assert.ok(distinct.size > 45, `only ${distinct.size} distinct maps`);
});
test('random arenas are point-symmetric (every obstacle has a mirrored twin)', () => {
  const { ARENA_W: W, ARENA_H: H } = BB.CONFIG;
  for (const s of SEEDS) {
    const m = randomMap(s);
    assert.ok(m.length >= 4, `seed ${s}: only ${m.length} obstacles`);
    for (const o of m) {
      assert.ok(m.some((t) => t.x === W - o.x - o.w && t.y === H - o.y - o.h && t.w === o.w && t.h === o.h), `seed ${s}: no twin`);
    }
  }
});
test('random arenas respect thickness and coverage limits', () => {
  const { ARENA_W: W, ARENA_H: H } = BB.CONFIG;
  for (const s of SEEDS) {
    const m = randomMap(s);
    for (const o of m) assert.ok(o.w >= 20 && o.h >= 20, `seed ${s}: thin obstacle`);
    const area = m.reduce((a, o) => a + o.w * o.h, 0);
    assert.ok(area / (W * H) <= 0.11, `seed ${s}: coverage ${area / (W * H)}`);
  }
});
test('random arenas have no sealed-off areas (flood fill of robot positions)', () => {
  const { ARENA_W: W, ARENA_H: H, ROBOT_RADIUS: R } = BB.CONFIG;
  const STEP = 4;
  const cols = Math.floor(W / STEP), rows = Math.floor(H / STEP);
  for (const s of SEEDS) {
    const m = randomMap(s);
    const free = new Uint8Array(cols * rows);
    let total = 0, start = -1;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = i * STEP + STEP / 2, y = j * STEP + STEP / 2;
      if (x < R || y < R || x > W - R || y > H - R) continue;
      if (m.some((o) => BB.geo.circleRectPush(x, y, R, o))) continue;
      free[j * cols + i] = 1; total++;
      if (start < 0) start = j * cols + i;
    }
    const seen = new Uint8Array(cols * rows);
    const queue = [start]; seen[start] = 1;
    let reached = 0;
    while (queue.length) {
      const c = queue.pop(); reached++;
      const i = c % cols, j = (c - i) / cols;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, n = nj * cols + ni;
        if (ni >= 0 && nj >= 0 && ni < cols && nj < rows && free[n] && !seen[n]) { seen[n] = 1; queue.push(n); }
      }
    }
    assert.strictEqual(reached, total, `seed ${s}: ${total - reached} unreachable cells`);
  }
});
test('robots spawn clear of obstacles on random arenas', () => {
  const entries = BB.EXAMPLES.map((e, i) => compile(e.source, i));
  for (const s of SEEDS.slice(0, 100)) {
    const w = new BB.World({ entries, seed: s, arena: 'random' });
    for (const r of w.robots) {
      assert.ok(w.obstacles.every((o) => !BB.geo.circleRectPush(r.x, r.y, BB.CONFIG.ROBOT_RADIUS, o)), `seed ${s}: ${r.name} spawned in an obstacle`);
    }
  }
});
test('open arena has no obstacles, classic is unchanged', () => {
  assert.strictEqual(BB.World.makeObstacles('open', 1).length, 0);
  assert.deepStrictEqual(BB.World.makeObstacles('classic', 99), BB.World.DEFAULT_OBSTACLES);
});

console.log('Teams');
const teamEntry = (src, id, team) => ({ ...compile(src, id), team });
test('team B spawns as the mirror image of team A', () => {
  const ex = BB.EXAMPLES.map((e) => e.source);
  for (const arena of ['classic', 'random', 'open']) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const entries = [0, 1, 2, 3, 4, 5].map((i) => teamEntry(ex[i % 4], i, i < 3 ? 0 : 1));
      const w = new BB.World({ entries, seed, arena });
      const a = w.robots.filter((r) => r.team === 0), b = w.robots.filter((r) => r.team === 1);
      a.forEach((r, i) => {
        assert.ok(r.x < BB.CONFIG.ARENA_W / 2, `${arena}/${seed}: team A robot not on the left`);
        assert.ok(Math.abs(b[i].x - (BB.CONFIG.ARENA_W - r.x)) < 1e-9 && Math.abs(b[i].y - (BB.CONFIG.ARENA_H - r.y)) < 1e-9,
          `${arena}/${seed}: robot ${i} not mirrored`);
        assert.strictEqual(b[i].heading, BB.geo.normAngle(r.heading + 180));
      });
    }
  }
});
test('teammates are invisible to SCAN and excluded from ENEMIES; ALLIES counts them', () => {
  const probe = `Probe
SCAN 90
GET R0, SCAN_DIST
GET R1, ENEMIES
GET R2, ALLIES
WAIT`;
  const w = new BB.World({ entries: [teamEntry(probe, 0, 0), teamEntry('Mate\nWAIT', 1, 0), teamEntry('Foe\nWAIT', 2, 1)], seed: 1, arena: 'open' });
  const [me, mate, foe] = w.robots;
  Object.assign(me, { x: 100, y: 300, turret: 0, targetTurret: 0 });
  Object.assign(mate, { x: 200, y: 300 });   // straight ahead
  Object.assign(foe, { x: 100, y: 550 });    // straight down: outside the cone
  w.step();
  assert.deepStrictEqual([me.vm.regs[0], me.vm.regs[1], me.vm.regs[2]], [-1, 1, 1]);
});
test('no friendly fire, and RADAR ignores teammates\' shots', () => {
  const shooter = 'Shooter\nFIRE\nWAIT';
  const watcher = 'Watcher\nRADAR\nGET R0, THREAT_DIST\nMAX R1, R0\nWAIT';
  const w = new BB.World({ entries: [teamEntry(shooter, 0, 0), teamEntry(watcher, 1, 0), teamEntry('Foe\nWAIT', 2, 1)], seed: 1, arena: 'open' });
  const [s, mate, foe] = w.robots;
  Object.assign(s, { x: 100, y: 300, heading: 0, targetHeading: 0, turret: 0, targetTurret: 0 });
  Object.assign(mate, { x: 250, y: 300 });
  Object.assign(foe, { x: 400, y: 300 });    // behind the teammate, same line
  mate.vm.regs[1] = -1;
  for (let i = 0; i < 60; i++) w.step();
  assert.strictEqual(mate.health, BB.CONFIG.MAX_HEALTH, 'teammate took damage');
  assert.strictEqual(mate.vm.regs[1], -1, 'teammate saw its own side\'s bullets on RADAR');
  assert.ok(foe.health < BB.CONFIG.MAX_HEALTH, 'bullets should pass the teammate and hit the enemy');
});
test('last team standing wins, even with a teammate down', () => {
  const ex = BB.EXAMPLES.map((e) => e.source);
  for (const seed of [1, 2, 3]) {
    const entries = [0, 1, 2, 3].map((i) => teamEntry(ex[i], i, i < 2 ? 0 : 1));
    const w = new BB.World({ entries, seed });
    while (!w.over) w.step();
    if (w.winnerTeam === null) continue;
    assert.ok(w.robots.some((r) => r.alive && r.team === w.winnerTeam) || w.tick >= BB.CONFIG.MAX_TICKS);
    assert.ok(w.robots.every((r) => !r.alive || r.team === w.winnerTeam) || w.tick >= BB.CONFIG.MAX_TICKS);
    assert.strictEqual(w.winner, null);
  }
});
test('a team match with only one team is practice mode', () => {
  const w = new BB.World({ entries: [teamEntry('A\nWAIT', 0, 0), teamEntry('B\nWAIT', 1, 0)], seed: 1 });
  assert.strictEqual(w.competitive, false);
  for (let i = 0; i < 20; i++) w.step();
  assert.strictEqual(w.over, false);
});

console.log('Regression checks');
test('constants enforce signed 32-bit limits for every directive', () => {
  for (const directive of ['.def', '.const', '.equ']) {
    for (const value of ['2147483648', '-2147483649', '0x100000000', '9'.repeat(400)]) {
      const errors = errorsOf(`T\n${directive} K ${value}\nMOV R0, K`);
      assert.ok(errors.some((e) => e.line === 2 && /32 bits/.test(e.message)), `${directive} ${value}`);
    }
    const vm = runVM(`T\n${directive} LOW -2147483648\n${directive} HIGH 2147483647\nMOV R0, LOW\nMOV R1, HIGH\nCMP R1, HIGH\nHALT`);
    assert.deepStrictEqual([...vm.regs.slice(0, 2)], [-2147483648, 2147483647]);
    assert.strictEqual(vm.cmp, 0);
  }
});

test('robot separation keeps bodies inside all four arena walls', () => {
  const R = BB.CONFIG.ROBOT_RADIUS;
  for (const positions of [
    [[R, 300], [R + 24, 300]],
    [[800 - R, 300], [800 - R - 24, 300]],
    [[400, R], [400, R + 24]],
    [[400, 600 - R], [400, 600 - R - 24]],
  ]) {
    const w = new BB.World({ entries: [compile('A\nWAIT', 0), compile('B\nWAIT', 1)], arena: 'open' });
    w.robots.forEach((r, i) => Object.assign(r, { x: positions[i][0], y: positions[i][1] }));
    for (let tick = 0; tick < 10; tick++) {
      w.step();
      for (const r of w.robots) {
        assert.ok(r.x >= R && r.x <= w.width - R, `x=${r.x}`);
        assert.ok(r.y >= R && r.y <= w.height - R, `y=${r.y}`);
      }
    }
  }
});

test('robot separation cannot push a body into an obstacle', () => {
  const obstacle = { x: 100, y: 200, w: 20, h: 100 };
  const w = new BB.World({ entries: [compile('A\nWAIT', 0), compile('B\nWAIT', 1)], obstacles: [obstacle] });
  Object.assign(w.robots[0], { x: 136, y: 250 });
  Object.assign(w.robots[1], { x: 160, y: 250 });
  for (let tick = 0; tick < 10; tick++) {
    w.step();
    for (const r of w.robots) assert.strictEqual(BB.geo.circleRectPush(r.x, r.y, BB.CONFIG.ROBOT_RADIUS, obstacle), null);
  }
});

test('single-robot CLI runs and tournaments terminate with practice results', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  for (const rounds of [1, 2]) {
    const result = spawnSync(process.execPath, ['tools/headless.js', '--rounds', String(rounds), 'examples/sentinel.asm'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    if (rounds === 1) assert.match(result.stdout, /\[\s*6000\] Practice run finished/);
    else assert.match(result.stdout, /\(practice\)\s+2/);
    assert.doesNotMatch(result.stdout, /\(draw\)/);
  }
});

// Exercise UI controller methods with DOM/storage stubs, without rendering.
const fs = require('fs');
const path = require('path');
const scriptVm = require('vm');
const uiBB = { ...BB };
// Capture the controller rather than booting the page and animation loop.
scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui/app.js'), 'utf8').replace('BB.app = new App();', 'BB.App = App;'), {
  BB: uiBB,
  window: { addEventListener(event, callback) { if (event === 'DOMContentLoaded') callback(); } },
  requestAnimationFrame() {},
  performance: { now: () => 0 },
});

function uiHarness(mode = 'ffa') {
  const app = Object.create(uiBB.App.prototype);
  const source = 'A\nINC R0\nWAIT';
  const entry = { id: 0, source, draft: source, compiled: BB.assemble(source), runningSource: source, team: 'A' };
  app.entries = [entry];
  app.selectedId = 0;
  app.mode = mode;
  app.world = new BB.World({ entries: [compile(source, 0), compile('B\nWAIT', 1)], arena: 'open' });
  app.persist = app.checkDraft = app.renderRoster = app.updatePanels = () => {};
  app.flash = (message) => { app.message = message; };
  return app;
}

test('invalid Apply preserves the applied program and reports rejection', () => {
  for (const tick of [0, 1]) {
    const app = uiHarness();
    if (tick) app.world.step();
    const entry = app.selected, source = entry.source, compiled = entry.compiled;
    const robot = app.robotFor(entry.id), cpu = robot.vm;
    entry.draft = 'A\nBOGUS';
    app.applyDraft();
    assert.strictEqual(entry.source, source);
    assert.strictEqual(entry.compiled, compiled);
    assert.strictEqual(entry.runningSource, source);
    assert.strictEqual(robot.vm, cpu);
    assert.strictEqual(entry.draft, 'A\nBOGUS');
    assert.match(app.message, /Not applied.*previously applied code/);
    const previous = cpu.regs[0];
    app.world.step();
    assert.strictEqual(cpu.regs[0], previous + 1);
  }
});

test('valid Apply still hot-swaps the CPU and preserves the body', () => {
  const app = uiHarness();
  app.world.step();
  const robot = app.robotFor(0), oldCpu = robot.vm;
  const body = [robot.x, robot.y, robot.health];
  app.selected.draft = 'A\nMOV R0, 42\nWAIT';
  app.applyDraft();
  assert.notStrictEqual(robot.vm, oldCpu);
  assert.deepStrictEqual([robot.x, robot.y, robot.health], body);
  app.world.step();
  assert.strictEqual(robot.vm.regs[0], 42);
});

test('Step rejects incomplete teams and allows ready teams and solo practice', () => {
  for (const mode of ['2v2', '3v3']) {
    const app = uiHarness(mode);
    app.stepOnce();
    assert.strictEqual(app.world.tick, 0);
    assert.match(app.message, /working robots on each team/);
    app.entries = Array.from({ length: 2 * app.teamSize }, (_, i) => ({
      ...app.entries[0], id: i, team: i < app.teamSize ? 'A' : 'B',
    }));
    app.stepOnce();
    assert.strictEqual(app.world.tick, 1);
  }
  const app = uiHarness();
  app.world = new BB.World({ entries: [compile('Solo\nWAIT', 0)] });
  app.stepOnce();
  assert.strictEqual(app.world.tick, 1);
  assert.strictEqual(app.world.over, false);
});

test('FRONT measures body clearance at rounded obstacle corners and diagonal walls', () => {
  const obstacle = { x: 100, y: 200, w: 20, h: 100 };
  const w = new BB.World({ entries: [compile('A\nWAIT', 0)], obstacles: [obstacle] });
  const r = w.robots[0];
  for (const [x, y, heading, expected] of [
    [84, 190, 0, 16 - Math.sqrt(156)],
    [136, 190, 180, 16 - Math.sqrt(156)],
    [84, 310, 0, 16 - Math.sqrt(156)],
    [136, 310, 180, 16 - Math.sqrt(156)],
    [80, 250, 0, 4],
  ]) {
    Object.assign(r, { x, y, heading });
    const distance = w.freeDistance(r);
    assert.ok(Math.abs(distance - expected) < 1e-8, `clearance=${distance}, expected=${expected}`);
    const dx = Math.cos(heading * BB.geo.DEG), dy = Math.sin(heading * BB.geo.DEG);
    assert.strictEqual(BB.geo.circleRectPush(x + dx * (distance - 1e-4), y + dy * (distance - 1e-4), 16, obstacle), null);
    assert.ok(BB.geo.circleRectPush(x + dx * (distance + 1e-4), y + dy * (distance + 1e-4), 16, obstacle));
  }
  // A bounding-box expansion would incorrectly report a nearby corner here.
  Object.assign(r, { x: 84, y: 180, heading: 0 });
  assert.strictEqual(w.freeDistance(r), 700);
  Object.assign(r, { x: 84, y: 250, heading: 180 });
  assert.strictEqual(w.freeDistance(r), 68, 'touching an obstacle behind us should allow driving away');
  w.obstacles = [];
  Object.assign(r, { x: 100, y: 100, heading: 225 });
  assert.ok(Math.abs(w.freeDistance(r) - 84 * Math.sqrt(2)) < 1e-8);
});

test('collision solver separates crowds at walls, obstacles and coincident positions', () => {
  const obstacle = { x: 100, y: 200, w: 20, h: 100 };
  for (const setup of [
    { positions: [[16, 300], [40, 300]], obstacles: [] },
    { positions: Array.from({ length: 6 }, (_, i) => [16 + i * 24, 300]), obstacles: [] },
    { positions: [[136, 250], [160, 250], [184, 250]], obstacles: [obstacle] },
    { positions: [[300, 300], [300, 300], [300, 300]], obstacles: [] },
    { positions: [[16, 16], [35, 35], [50, 16]], obstacles: [] },
  ]) {
    const w = new BB.World({ entries: setup.positions.map((_, i) => compile(`Bot${i}\nWAIT`, i)), obstacles: setup.obstacles });
    w.robots.forEach((r, i) => Object.assign(r, { x: setup.positions[i][0], y: setup.positions[i][1] }));
    w.step();
    for (const r of w.robots) {
      assert.ok(r.x >= 16 && r.x <= 784 && r.y >= 16 && r.y <= 584);
      for (const o of w.obstacles) {
        const overlap = BB.geo.circleRectPush(r.x, r.y, 16, o);
        assert.ok(!overlap || overlap.depth < 1e-6);
      }
      for (const other of w.robots) if (other !== r) {
        assert.ok(Math.hypot(r.x - other.x, r.y - other.y) >= 32 - 1e-6, 'robot overlap remains');
      }
    }
  }
});

test('iterative collision correction charges ram damage once and preserves friendly safety', () => {
  for (const friendly of [false, true]) {
    const entries = [0, 1].map((id) => ({ ...compile(`Bot${id}\nWAIT`, id), team: friendly ? 0 : undefined }));
    const w = new BB.World({ entries, arena: 'open' });
    Object.assign(w.robots[0], { x: 16, y: 300, heading: 0, targetHeading: 0 });
    Object.assign(w.robots[1], { x: 43, y: 300, heading: 180, targetHeading: 180, speed: 2, targetSpeed: 2 });
    w.step();
    assert.deepStrictEqual(w.robots.map((r) => r.health), friendly ? [100, 100] : [99, 99]);
    assert.strictEqual(w.events.filter((e) => e.type === 'bump').length, friendly ? 0 : 1);
  }
});

function playbackHarness(speedIndex = 3) {
  const app = uiHarness();
  app.world = new BB.World({ entries: [compile('Solo\nWAIT', 0)], arena: 'open' });
  Object.assign(app, { running: true, acc: 0, lastFrameTime: null, lastPanelUpdate: 0, speedIndex,
    renderer: { addEvents() {}, draw() {} } });
  return app;
}

test('playback advances equally at 30, 60, 120 and 144 Hz for fractional and fast speeds', () => {
  for (const [speedIndex, ticks] of [[0, 6], [3, 60], [8, 3600]]) {
    for (const hz of [30, 60, 120, 144]) {
      const app = playbackHarness(speedIndex);
      app.frame(0);
      for (let frame = 1; frame <= hz; frame++) app.frame(frame * 1000 / hz);
      assert.strictEqual(app.world.tick, ticks, `speed index ${speedIndex}, ${hz}Hz`);
    }
  }
});

test('playback pause/resume ignores suspended time and bounds stall catch-up', () => {
  const app = playbackHarness();
  app.frame(0);
  app.frame(1000 / 60);
  assert.strictEqual(app.world.tick, 1);
  app.toggleRun();
  app.frame(60000);
  assert.strictEqual(app.world.tick, 1);
  app.toggleRun();
  app.frame(60010);
  app.frame(60010 + 1000 / 60);
  assert.strictEqual(app.world.tick, 2);
  const fast = playbackHarness(8);
  fast.frame(0);
  fast.frame(60000);
  assert.strictEqual(fast.world.tick, 200);
  fast.frame(60000 + 1000 / 60);
  assert.strictEqual(fast.world.tick, 260, 'stall backlog should be discarded');
});

test('CLI rejects malformed and missing integer options before reading robot files', () => {
  const { spawnSync } = require('child_process');
  for (const option of ['--rounds', '--seed', '--teams']) {
    for (const value of ['nope', '0', '-1', '1.5', '2junk', '9007199254740992', undefined]) {
      const args = ['tools/headless.js', option];
      if (value !== undefined) args.push(value, 'missing-robot.asm');
      const result = spawnSync(process.execPath, args, { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 2, `${option} ${value}: ${result.stderr}`);
      assert.match(result.stderr, /requires a positive integer/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
      assert.strictEqual(result.stdout, '');
    }
  }
  const overflow = spawnSync(process.execPath, ['tools/headless.js', '--seed', '4294967295', '--rounds', '2', 'missing-robot.asm'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(overflow.status, 2);
  assert.match(overflow.stderr, /seed range/);
});

test('appearance presets are optional, case-insensitive metadata with unchanged instruction indices', () => {
  assert.deepStrictEqual(BB.assemble('A\nWAIT').appearance, { shape: 'tank', drive: 'tracks', turret: 'standard' });
  const code = 'main: INC R0\nWAIT\nJMP main';
  const baseline = BB.assemble(`A\n${code}`).program.map(({ op, args, cost }) => ({ op, args, cost }));
  for (const shape of BB.ISA.APPEARANCE.shape.choices) for (const drive of BB.ISA.APPEARANCE.drive.choices) for (const turret of BB.ISA.APPEARANCE.turret.choices) {
    const result = BB.assemble(`A\n.SHAPE ${shape.toUpperCase()} ; hull\n\n# comment\n.drive ${drive}\n.turret ${turret}\n${code}`);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.appearance, { shape, drive, turret });
    assert.deepStrictEqual(result.program.map(({ op, args, cost }) => ({ op, args, cost })), baseline);
    assert.strictEqual(result.program[0].line, 7);
  }
});

test('appearance errors preserve source lines and reject invalid, repeated and late headers', () => {
  for (const [source, line] of [
    ['A\n.shape triangle\nWAIT', 2], ['A\n.drive\nWAIT', 2], ['A\n.turret twin extra\nWAIT', 2],
    ['A\n.shape circle\n.shape wedge\nWAIT', 3], ['A\nWAIT\n.drive hover', 3],
    ['A\n.def K 1\n.shape circle\nWAIT', 3], ['A\nmain:\n.turret twin\nWAIT', 3],
    ['A\nmain: .shape circle\nWAIT', 2], ['A\n.constructor whatever\nWAIT', 2],
    ['A\n.__proto__ whatever\nWAIT', 2],
  ]) {
    const result = BB.assemble(source);
    assert.ok(result.errors.some((error) => error.line === line), source);
    assert.deepStrictEqual(result.program, []);
  }
  assert.match(errorsOf('A\n.shape circle')[0].message, /no instructions/);
});

test('cosmetic presets leave complete seeded match outcomes and physics unchanged', () => {
  for (const arena of ['classic', 'random', 'open']) for (const seed of [1, 7, 42]) {
    const run = (customize) => {
      const entries = BB.EXAMPLES.map((ex, id) => {
        let source = ex.source;
        if (customize) source = source
          .replace(/^\.shape .*$/m, `.shape ${['circle', 'hexagon', 'wedge', 'tank'][id]}`)
          .replace(/^\.drive .*$/m, `.drive ${['hover', 'wheels', 'tracks', 'wheels'][id]}`)
          .replace(/^\.turret .*$/m, '.turret twin');
        return compile(source, id);
      });
      const world = new BB.World({ entries, seed, arena });
      while (!world.over) world.step();
      return { tick: world.tick, winner: world.winner && world.winner.entryId,
        robots: world.robots.map((r) => ({ x: r.x, y: r.y, health: r.health, stats: r.stats, regs: [...r.vm.regs], cooldown: r.cooldown, fault: r.vm.fault })) };
    };
    assert.deepStrictEqual(run(true), run(false), `${arena}/${seed}`);
  }
});

test('appearance hot-swaps and survives duplication without changing the robot body', () => {
  const app = uiHarness();
  app.world.step();
  const robot = app.robotFor(0), body = [robot.x, robot.y, robot.health];
  app.selected.draft = 'A\n.shape wedge\n.drive hover\n.turret twin\nWAIT';
  app.applyDraft();
  assert.deepStrictEqual({ ...robot.appearance }, { shape: 'wedge', drive: 'hover', turret: 'twin' });
  assert.deepStrictEqual([robot.x, robot.y, robot.health], body);
  app.nextId = 2;
  app.resetMatch = () => {};
  app.duplicateEntry(0);
  assert.strictEqual(app.entries.length, 2);
  assert.deepStrictEqual(app.entries[1].compiled.appearance, { ...robot.appearance });
  assert.strictEqual(app.entries[1].source, app.entries[0].source);
});

test('all appearance combinations render normal, damaged, flashing and wreck states', () => {
  const renderingBB = { ...BB };
  scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui/renderer.js'), 'utf8'), { BB: renderingBB });
  const renderer = Object.create(renderingBB.Renderer.prototype);
  renderer.robotFx = new Map();
  let calls = 0;
  const context = new Proxy({}, { get(target, key) {
    if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
    return (...args) => { calls++; for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value)); };
  } });
  for (const shape of BB.ISA.APPEARANCE.shape.choices) for (const drive of BB.ISA.APPEARANCE.drive.choices) for (const turret of BB.ISA.APPEARANCE.turret.choices) {
    const source = `A\n.shape ${shape}\n.drive ${drive}\n.turret ${turret}\nWAIT`;
    const world = new BB.World({ entries: [compile(source, 0)] });
    const robot = world.robots[0];
    for (const health of [100, 20]) {
      robot.health = health;
      renderer.fx(robot.id).flash = 4;
      renderer.fx(robot.id).muzzle = 3;
      renderer.drawRobot(context, robot, true, 1000);
    }
    renderer.drawWreck(context, robot);
  }
  assert.ok(calls > 1000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
