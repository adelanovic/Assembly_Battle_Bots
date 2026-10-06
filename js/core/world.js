/*
 * world.js — The arena simulation.
 *
 * One call to step() advances the match by one tick:
 *   1. Every living robot's VM runs for exactly CYCLES_PER_TICK cycles (the
 *      order rotates each tick). Programs only *request* actions here; the
 *      world itself stays frozen, so execution order gives no advantage.
 *   2. Bodies and turrets turn, speeds change, robots move and collide.
 *   3. Requested shots are spawned.
 *   4. Projectiles move and deal damage.
 *   5. Eliminations and the victory condition are checked.
 *
 * The UI never mutates robots directly. It reads world state and drains
 * `events` for visual effects.
 */
(function (BB) {
  'use strict';

  const C = BB.CONFIG;
  const G = BB.geo;

  const COLORS = ['#ff5c5c', '#4fc3f7', '#ffd54f', '#81c784', '#ba68c8', '#ff9f43', '#4dd0e1', '#f06292'];

  const DEFAULT_OBSTACLES = [
    { x: 360, y: 260, w: 80, h: 80 },
    { x: 150, y: 140, w: 140, h: 20 },
    { x: 510, y: 440, w: 140, h: 20 },
    { x: 600, y: 90, w: 20, h: 120 },
    { x: 180, y: 390, w: 20, h: 120 },
  ];

  const blankScan = () => ({ dist: -1, angle: 0, x: 0, y: 0, heading: 0, speed: 0 });
  const blankThreat = () => ({ dist: -1, angle: 0, heading: 0 });

  class Robot {
    constructor(id, entry, color) {
      this.id = id;
      this.entryId = entry.id;
      this.name = entry.name;
      this.color = color;
      this.x = 0; this.y = 0;
      this.heading = 0; this.targetHeading = 0;
      this.turret = 0; this.targetTurret = 0;
      this.speed = 0; this.targetSpeed = 0;
      this.health = C.MAX_HEALTH;
      this.cooldown = 0;
      this.alive = true;
      this.wantFire = false;
      this.scan = blankScan();
      this.threat = blankThreat();
      this.lastHitTick = -1;
      this.lastScanFx = null;   // { tick, angle, width, found } for rendering
      this.cyclesLastTick = 0;
      this.stats = { shots: 0, hits: 0, damageDealt: 0 };
      this.vm = null;
    }
  }

  class World {
    /**
     * @param {object} opts
     *   entries:   [{ id, name, program }] valid compiled robots
     *   seed:      integer RNG seed (spawn positions, RAND)
     *   obstacles: optional array of rects
     */
    constructor({ entries, seed = 1, obstacles = DEFAULT_OBSTACLES }) {
      this.width = C.ARENA_W;
      this.height = C.ARENA_H;
      this.obstacles = obstacles.map((o) => ({ ...o }));
      this.seed = seed;
      this.rng = G.makeRng(seed);
      this.tick = 0;
      this.robots = [];
      this.projectiles = [];
      this.events = [];
      this.log = [];
      this.over = false;
      this.winner = null;      // Robot, or null for a draw
      this.nextProjectileId = 1;

      const used = new Map();
      entries.forEach((entry, i) => {
        const r = new Robot(i, entry, COLORS[i % COLORS.length]);
        const n = (used.get(entry.name) || 0) + 1;
        used.set(entry.name, n);
        if (n > 1) r.name = `${entry.name} (${n})`;
        r.vm = new BB.VM(entry.program, this.makeIO(r));
        this.robots.push(r);
      });
      this.competitive = this.robots.length >= 2;
      this.spawnRobots();
      this.addLog(this.competitive
        ? `Match started with ${this.robots.length} robots (seed ${seed}).`
        : 'Practice mode: add a second robot for a real match.');
    }

    addLog(text, kind = 'info') {
      this.log.push({ tick: this.tick, text, kind });
      if (this.log.length > 500) this.log.shift();
    }

    emit(ev) { this.events.push(ev); }

    drainEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    // ------------------------------------------------------------------ setup

    spawnRobots() {
      const R = C.ROBOT_RADIUS;
      const margin = 50;
      for (const r of this.robots) {
        let placed = false;
        for (let attempt = 0; attempt < 500 && !placed; attempt++) {
          const x = margin + this.rng() * (this.width - 2 * margin);
          const y = margin + this.rng() * (this.height - 2 * margin);
          const minSep = attempt < 300 ? 150 : 3 * R;
          const clearObs = this.obstacles.every((o) => !G.circleRectPush(x, y, R + 12, o));
          const clearBots = this.robots.every((b) => b === r || !b._placed || Math.hypot(b.x - x, b.y - y) > minSep);
          if (clearObs && clearBots) { r.x = x; r.y = y; placed = true; }
        }
        if (!placed) { r.x = this.width / 2; r.y = 30; }
        r._placed = true;
        r.heading = r.targetHeading = Math.floor(this.rng() * 360);
        r.turret = r.targetTurret = r.heading;
      }
      for (const r of this.robots) delete r._placed;
    }

    // ---------------------------------------------------------------- VM I/O

    /** Build the only interface a robot's program has to the world. */
    makeIO(robot) {
      const world = this;
      const num = (v) => (Number.isFinite(v) ? v : 0);
      return {
        sense: (id) => world.sense(robot, id),
        random: (n) => Math.floor(world.rng() * n),
        speed: (v) => { robot.targetSpeed = Math.max(C.MAX_REVERSE, Math.min(C.MAX_SPEED, num(v))); },
        turn: (v) => { robot.targetHeading = G.normAngle(robot.heading + num(v)); },
        head: (v) => { robot.targetHeading = G.normAngle(num(v)); },
        aim: (v) => { robot.targetTurret = G.normAngle(num(v)); },
        fire: () => { robot.wantFire = true; },
        scan: (w) => world.doScan(robot, w),
        radar: () => world.doRadar(robot),
      };
    }

    sense(r, id) {
      const round = Math.round;
      switch (BB.ISA.SENSORS[id] && BB.ISA.SENSORS[id].name) {
        case 'X': return round(r.x);
        case 'Y': return round(r.y);
        case 'HEADING': return round(r.heading) % 360;
        case 'SPEED': return round(r.speed);
        case 'HEALTH': return Math.ceil(r.health);
        case 'COOLDOWN': return r.cooldown;
        case 'TURRET': return round(r.turret) % 360;
        case 'SCAN_DIST': return r.scan.dist;
        case 'SCAN_ANGLE': return r.scan.angle;
        case 'SCAN_X': return r.scan.x;
        case 'SCAN_Y': return r.scan.y;
        case 'SCAN_HEADING': return r.scan.heading;
        case 'SCAN_SPEED': return r.scan.speed;
        case 'THREAT_DIST': return r.threat.dist;
        case 'THREAT_ANGLE': return r.threat.angle;
        case 'THREAT_HEADING': return r.threat.heading;
        case 'FRONT': return round(this.freeDistance(r));
        case 'LAST_HIT': return r.lastHitTick < 0 ? -1 : this.tick - r.lastHitTick;
        case 'TICK': return this.tick;
        case 'ENEMIES': return this.robots.filter((o) => o.alive && o !== r).length;
        case 'ARENA_W': return this.width;
        case 'ARENA_H': return this.height;
        default: return 0;
      }
    }

    /** Distance from the robot's edge to the first wall/obstacle along its heading. */
    freeDistance(r) {
      const dx = Math.cos(r.heading * G.DEG), dy = Math.sin(r.heading * G.DEG);
      let t = Infinity;
      if (dx > 1e-9) t = Math.min(t, (this.width - r.x) / dx);
      if (dx < -1e-9) t = Math.min(t, -r.x / dx);
      if (dy > 1e-9) t = Math.min(t, (this.height - r.y) / dy);
      if (dy < -1e-9) t = Math.min(t, -r.y / dy);
      for (const o of this.obstacles) t = Math.min(t, G.rayRect(r.x, r.y, dx, dy, o));
      return Math.max(0, t - C.ROBOT_RADIUS);
    }

    lineOfSight(x1, y1, x2, y2) {
      return this.obstacles.every((o) => !G.segmentHitsRect(x1, y1, x2, y2, o));
    }

    doScan(r, width) {
      const w = Math.max(1, Math.min(C.SCAN_MAX_WIDTH, width | 0));
      let best = null, bestD = Infinity;
      for (const o of this.robots) {
        if (o === r || !o.alive) continue;
        const d = Math.hypot(o.x - r.x, o.y - r.y);
        const ang = G.angleTo(r.x, r.y, o.x, o.y);
        // The cone hits if any part of the target's body is inside it.
        const slack = d > C.ROBOT_RADIUS ? Math.asin(C.ROBOT_RADIUS / d) / G.DEG : 90;
        if (Math.abs(G.angleDiff(ang, r.turret)) > w / 2 + slack) continue;
        if (d >= bestD || !this.lineOfSight(r.x, r.y, o.x, o.y)) continue;
        best = o; bestD = d;
      }
      if (best) {
        r.scan = {
          dist: Math.round(bestD),
          angle: Math.round(G.angleTo(r.x, r.y, best.x, best.y)) % 360,
          x: Math.round(best.x), y: Math.round(best.y),
          heading: Math.round(best.heading) % 360,
          speed: Math.round(best.speed),
        };
      } else {
        r.scan = blankScan();
      }
      r.lastScanFx = { tick: this.tick, angle: r.turret, width: w, found: !!best };
    }

    doRadar(r) {
      let best = null, bestD = C.RADAR_RANGE;
      for (const p of this.projectiles) {
        if (p.owner === r.id) continue;
        const d = Math.hypot(p.x - r.x, p.y - r.y);
        if (d > bestD) continue;
        // Approaching: velocity points toward us.
        if (p.vx * (r.x - p.x) + p.vy * (r.y - p.y) <= 0) continue;
        best = p; bestD = d;
      }
      r.threat = best
        ? {
          dist: Math.round(bestD),
          angle: Math.round(G.angleTo(r.x, r.y, best.x, best.y)) % 360,
          heading: Math.round(G.angleTo(0, 0, best.vx, best.vy)) % 360,
        }
        : blankThreat();
    }

    // ------------------------------------------------------------- the tick

    step() {
      if (this.over) return;
      this.tick++;

      const alive = this.robots.filter((r) => r.alive);
      const n = alive.length;
      for (let i = 0; i < n; i++) this.runCpu(alive[(i + this.tick) % n]);

      for (const r of alive) this.moveRobot(r);
      this.resolveRobotCollisions(alive);
      for (const r of alive) {
        if (r.alive) this.tryFire(r);
        if (r.cooldown > 0) r.cooldown--;
      }
      this.moveProjectiles();
      this.checkVictory();
    }

    runCpu(r) {
      const vm = r.vm;
      if (vm.halted) { r.cyclesLastTick = 0; return; }
      try {
        r.cyclesLastTick = vm.run(C.CYCLES_PER_TICK);
      } catch (e) {
        // VM.run already traps faults; this is a last line of defence.
        vm.halted = true;
        vm.fault = `internal error: ${e.message}`;
      }
      if (vm.fault && !r.faultReported) {
        r.faultReported = true;
        this.addLog(`${r.name} crashed: ${vm.fault}`, 'fault');
      }
    }

    moveRobot(r) {
      r.heading = G.rotateToward(r.heading, r.targetHeading, C.BODY_TURN_RATE);
      r.turret = G.rotateToward(r.turret, r.targetTurret, C.TURRET_TURN_RATE);

      const dv = r.targetSpeed - r.speed;
      r.speed += Math.sign(dv) * Math.min(Math.abs(dv), C.ACCELERATION);

      r.x += Math.cos(r.heading * G.DEG) * r.speed;
      r.y += Math.sin(r.heading * G.DEG) * r.speed;

      const R = C.ROBOT_RADIUS;
      let bumped = false;
      if (r.x < R) { r.x = R; bumped = true; }
      if (r.x > this.width - R) { r.x = this.width - R; bumped = true; }
      if (r.y < R) { r.y = R; bumped = true; }
      if (r.y > this.height - R) { r.y = this.height - R; bumped = true; }
      for (const o of this.obstacles) {
        const p = G.circleRectPush(r.x, r.y, R, o);
        if (p) { r.x += p.x * p.depth; r.y += p.y * p.depth; bumped = true; }
      }
      if (bumped) {
        const dmg = Math.floor(Math.abs(r.speed) / 2);
        if (dmg > 0) this.damage(r, dmg, null, 'wall');
        r.speed = 0;
      }
    }

    resolveRobotCollisions(list) {
      const R2 = C.ROBOT_RADIUS * 2;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (!a.alive || !b.alive) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d >= R2) continue;
          if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
          const nx = dx / d, ny = dy / d;
          // Closing speed along the contact normal.
          const avx = Math.cos(a.heading * G.DEG) * a.speed, avy = Math.sin(a.heading * G.DEG) * a.speed;
          const bvx = Math.cos(b.heading * G.DEG) * b.speed, bvy = Math.sin(b.heading * G.DEG) * b.speed;
          const closing = (avx - bvx) * nx + (avy - bvy) * ny;
          const push = (R2 - d) / 2;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          if (closing > 1) {
            this.damage(a, 1, b, 'ram');
            this.damage(b, 1, a, 'ram');
            this.emit({ type: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          }
          a.speed *= 0.5; b.speed *= 0.5;
        }
      }
    }

    tryFire(r) {
      if (!r.wantFire) return;
      r.wantFire = false;
      if (r.cooldown > 0) return;
      r.cooldown = C.FIRE_COOLDOWN;
      r.stats.shots++;
      const dx = Math.cos(r.turret * G.DEG), dy = Math.sin(r.turret * G.DEG);
      const muzzle = C.ROBOT_RADIUS + 4;
      this.projectiles.push({
        id: this.nextProjectileId++,
        owner: r.id,
        color: r.color,
        x: r.x + dx * muzzle, y: r.y + dy * muzzle,
        px: r.x, py: r.y,
        vx: dx * C.BULLET_SPEED, vy: dy * C.BULLET_SPEED,
      });
      this.emit({ type: 'fire', x: r.x + dx * muzzle, y: r.y + dy * muzzle, robot: r.id });
    }

    moveProjectiles() {
      const SUB = 4;
      const R = C.ROBOT_RADIUS;
      const survivors = [];
      outer: for (const p of this.projectiles) {
        p.px = p.x; p.py = p.y;
        for (let s = 0; s < SUB; s++) {
          p.x += p.vx / SUB; p.y += p.vy / SUB;
          if (p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height ||
              this.obstacles.some((o) => G.pointInRect(p.x, p.y, o))) {
            this.emit({ type: 'spark', x: p.x, y: p.y });
            continue outer;
          }
          for (const r of this.robots) {
            if (!r.alive || r.id === p.owner) continue;
            if ((r.x - p.x) ** 2 + (r.y - p.y) ** 2 <= R * R) {
              const shooter = this.robots[p.owner];
              shooter.stats.hits++;
              this.damage(r, C.BULLET_DAMAGE, shooter, 'shot');
              this.emit({ type: 'hit', x: p.x, y: p.y, color: r.color });
              continue outer;
            }
          }
        }
        survivors.push(p);
      }
      this.projectiles = survivors;
    }

    damage(r, amount, source, cause) {
      if (!r.alive) return;
      r.health = Math.max(0, r.health - amount);
      if (cause === 'shot') r.lastHitTick = this.tick;
      if (source && source !== r) source.stats.damageDealt += amount;
      if (r.health <= 0) {
        r.alive = false;
        r.speed = r.targetSpeed = 0;
        const by = source ? ` by ${source.name}` : cause === 'wall' ? ' by crashing into a wall' : '';
        this.addLog(`${r.name} was destroyed${by}.`, 'death');
        this.emit({ type: 'explode', x: r.x, y: r.y, color: r.color });
      }
    }

    checkVictory() {
      if (!this.competitive) return;
      const alive = this.robots.filter((r) => r.alive);
      if (alive.length <= 1) {
        this.finish(alive[0] || null, alive.length ? 'last robot standing' : 'everyone was destroyed');
      } else if (this.tick >= C.MAX_TICKS) {
        alive.sort((a, b) => b.health - a.health);
        const tie = alive[0].health === alive[1].health;
        this.finish(tie ? null : alive[0], 'time limit reached, highest health wins');
      }
    }

    finish(winner, reason) {
      this.over = true;
      this.winner = winner;
      this.addLog(winner ? `🏆 ${winner.name} wins (${reason}).` : `Draw (${reason}).`, 'win');
    }
  }

  World.DEFAULT_OBSTACLES = DEFAULT_OBSTACLES;
  World.COLORS = COLORS;
  BB.World = World;
})(globalThis.BB = globalThis.BB || {});
