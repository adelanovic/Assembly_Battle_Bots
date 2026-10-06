#!/usr/bin/env node
// Run matches without a browser.
//
//   node tools/headless.js examples/*.asm            one match, seed 1
//   node tools/headless.js --seed 7 a.asm b.asm      pick a seed
//   node tools/headless.js --rounds 20 examples/*.asm  tournament over seeds 1..20
//   node tools/headless.js --arena random ...          classic (default) | random | open
'use strict';
const fs = require('fs');
const BB = require('./load-core')();

const args = process.argv.slice(2);
let seed = 1, rounds = 1, verbose = false, arena = 'classic';
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') seed = parseInt(args[++i], 10);
  else if (args[i] === '--rounds') rounds = parseInt(args[++i], 10);
  else if (args[i] === '--arena') arena = args[++i];
  else if (args[i] === '-v') verbose = true;
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node tools/headless.js [--seed N] [--rounds N] [--arena classic|random|open] [-v] robot.asm ...');
  process.exit(2);
}

const entries = [];
let bad = false;
files.forEach((f, i) => {
  const res = BB.assemble(fs.readFileSync(f, 'utf8'));
  if (res.errors.length) {
    bad = true;
    for (const e of res.errors) console.error(`${f}:${e.line}: ${e.message}`);
  } else {
    entries.push({ id: i, name: res.name, program: res.program });
  }
});
if (bad) process.exit(1);
if (!BB.World.ARENAS[arena]) {
  console.error(`unknown arena "${arena}" (use ${Object.keys(BB.World.ARENAS).join(', ')})`);
  process.exit(2);
}

const wins = new Map();
for (let r = 0; r < rounds; r++) {
  const world = new BB.World({ entries, seed: seed + r, arena });
  while (!world.over) world.step();
  const key = world.winner ? world.winner.name : '(draw)';
  wins.set(key, (wins.get(key) || 0) + 1);
  if (rounds === 1 || verbose) {
    if (rounds === 1) for (const l of world.log) console.log(`[${String(l.tick).padStart(5)}] ${l.text}`);
    else console.log(`seed ${seed + r}: ${key} @ tick ${world.tick}`);
    if (rounds === 1) {
      for (const b of world.robots) {
        console.log(`  ${b.name.padEnd(14)} hp=${String(Math.ceil(b.health)).padStart(3)} shots=${b.stats.shots} hits=${b.stats.hits}` +
          (b.vm.fault ? ` FAULT: ${b.vm.fault}` : ''));
      }
    }
  }
}
if (rounds > 1) {
  console.log(`\nResults over ${rounds} rounds (${arena} arena):`);
  for (const [k, v] of [...wins].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
}
