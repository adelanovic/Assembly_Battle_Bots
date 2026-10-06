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
const compile = (src, id) => { const r = BB.assemble(src); return { id, name: r.name, program: r.program }; };
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
