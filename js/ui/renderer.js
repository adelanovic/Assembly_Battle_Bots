/*
 * renderer.js — Draws a World onto a <canvas>. Read-only with respect to
 * the simulation; owns only cosmetic state (particles, flashes, a cached
 * floor). Visual randomness uses Math.random and never touches the world RNG.
 */
(function (BB) {
  'use strict';

  const C = BB.CONFIG;
  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const MAX_PARTICLES = 350;
  const MAX_SCARS = 400;      // oldest scars fade out past this
  const MAX_IGNITED = 30;     // fires that shots can start per match
  const MAX_TRACKS = 900;     // mud track segments kept at once
  const TRACK_LIFE = 900;     // ticks for a mud track to fade out
  const FIRE_LIGHT = 80;      // how far a fire lights robots, in units

  // Robot body geometry (robot-local units, +x = heading). The collision
  // circle has radius C.ROBOT_RADIUS (16); the hull fits just inside it.
  const HULL = { x: -12, y: -9, w: 24, h: 18, r: 4 };
  const TREAD = { x: -14, len: 28, inner: 8, outer: 14 };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.showScans = true;
      this.particles = [];
      this.robotFx = new Map();   // robot id -> { flash, muzzle } frame counters
      this.floor = null;          // offscreen canvas: floor + obstacles
      this.decals = null;         // offscreen canvas: battle scars, rebuilt from `scars`
      this.scars = [];            // { kind: 'crater' | 'char', x, y, r, seed }
      this.ignited = [];          // fires started by shots this match
      this.tracks = [];           // mud track segments { x1, y1, x2, y2, heading, drive, tick }
      this.world = null;
      this.resize();
    }

    /**
     * Size the canvas to `cssWidth` CSS pixels (height follows the arena's
     * aspect ratio). The backing store matches the physical pixels so the
     * arena stays sharp at any size; drawing still uses arena units.
     */
    resize(cssWidth = C.ARENA_W) {
      const dpr = window.devicePixelRatio || 1;
      const cssHeight = cssWidth * C.ARENA_H / C.ARENA_W;
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      this.scale = (cssWidth / C.ARENA_W) * dpr;
      this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      this.floor = null;
      this.decals = null;
    }

    /** Forget all cosmetic state (called when a new match starts). */
    clearEffects() {
      this.particles = [];
      this.robotFx.clear();
      this.scars = [];
      this.ignited = [];
      this.tracks = [];
      this.decals = null;
    }

    fx(id) {
      let f = this.robotFx.get(id);
      if (!f) { f = { flash: 0, muzzle: 0 }; this.robotFx.set(id, f); }
      return f;
    }

    addEvents(events) {
      for (const e of events) {
        switch (e.type) {
          case 'fire': this.fx(e.robot).muzzle = 4; break;
          case 'hit':
            if (e.robot !== undefined) this.fx(e.robot).flash = 6;
            this.burst(e.x, e.y, 7, ['#fff6d5', '#ffb347', e.color], 1.5, 3.5, 10, 2);
            this.particles.push({ kind: 'flash', x: e.x, y: e.y, size: 9, life: 5, max: 5, color: '#fff3c4' });
            break;
          case 'spark':
            this.burst(e.x, e.y, 3, ['#ffd27f', '#c9d0dc'], 1, 2.5, 6, 1.3);
            this.shotHitTerrain(e.x, e.y);
            break;
          case 'bump':
            this.burst(e.x, e.y, 4, ['#ffcc80', '#ffffff'], 1, 2, 7, 1.5);
            break;
          case 'explode':
            this.particles.push({ kind: 'flash', x: e.x, y: e.y, size: 34, life: 12, max: 12, color: '#ffe2a8' });
            this.particles.push({ kind: 'ring', x: e.x, y: e.y, size: 70, life: 22, max: 22, color: '#ffffff' });
            this.burst(e.x, e.y, 22, ['#ffb347', '#ff6a3d', '#fff1c1', e.color], 1.5, 5.5, 28, 2.6);
            for (let i = 0; i < 8; i++) this.smoke(e.x, e.y, 1.6);
            this.addScar({ kind: 'crater', x: e.x, y: e.y, r: 15 + Math.random() * 5 });
            break;
        }
      }
      if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }

    burst(x, y, n, colors, vmin, vmax, life, size) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, v = vmin + Math.random() * (vmax - vmin);
        this.particles.push({
          kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          life: life * (0.6 + Math.random() * 0.4), max: life,
          color: colors[i % colors.length], size: size * (0.6 + Math.random() * 0.6),
        });
      }
    }

    /** A shot stopped at x, y. If it hit a stand of trees, char it and maybe set it alight. */
    shotHitTerrain(x, y) {
      const world = this.world;
      if (!world || !world.obstacles.some((o) => BB.geo.pointInRect(x, y, { x: o.x - 1, y: o.y - 1, w: o.w + 2, h: o.h + 2 }))) return;
      this.addScar({ kind: 'char', x, y, r: 4 + Math.random() * 3 });
      const burning = (this.fires || []).concat(this.ignited);
      if (Math.random() < 0.12 && this.ignited.length < MAX_IGNITED && !burning.some((f) => Math.hypot(f.x - x, f.y - y) < 14)) {
        this.ignited.push({ x, y, r: 8 + Math.random() * 5, phase: Math.random() * TAU, born: performance.now() });
      }
    }

    addScar(scar) {
      scar.seed = Math.floor(Math.random() * 4294967296);
      this.scars.push(scar);
      if (this.scars.length > MAX_SCARS) { this.scars.shift(); this.decals = null; }
      else if (this.decals) drawScar(this.decals.getContext('2d'), scar);
    }

    renderDecals() {
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      for (const scar of this.scars) drawScar(g, scar);
      return c;
    }

    smoke(x, y, spread = 0.4) {
      this.particles.push({
        kind: 'smoke', x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 6,
        vx: (Math.random() - 0.5) * spread, vy: (Math.random() - 0.5) * spread - 0.15,
        size: 3 + Math.random() * 3, life: 40, max: 40,
      });
    }

    // ------------------------------------------------------------ frame

    draw(world, selectedEntryId) {
      const ctx = this.ctx;
      if (world !== this.world) { this.world = world; this.floor = null; this.clearEffects(); }
      if (!this.floor) this.floor = this.renderFloor(world);
      ctx.drawImage(this.floor, 0, 0, C.ARENA_W, C.ARENA_H);
      if (!world) return;
      if (!this.decals) this.decals = this.renderDecals();
      ctx.drawImage(this.decals, 0, 0, C.ARENA_W, C.ARENA_H);

      const now = performance.now();
      this.updateMud(world);
      this.drawTracks(ctx, world.tick);
      this.drawFires(ctx, now);
      for (const r of world.robots) if (!r.alive) this.drawWreck(ctx, r);
      if (this.showScans) for (const r of world.robots) if (r.alive) this.drawScan(ctx, r, world.tick);
      for (const p of world.projectiles) this.drawProjectile(ctx, p);
      for (const r of world.robots) if (r.alive) this.drawRobot(ctx, r, r.entryId === selectedEntryId, now);
      this.drawFireLight(ctx, world, now);
      this.emitAmbientSmoke(world);
      this.drawParticles(ctx);
      for (const r of world.robots) if (r.alive) this.drawLabel(ctx, r, now);

      if (world.over) this.drawBanner(ctx, world);
      for (const f of this.robotFx.values()) { if (f.flash > 0) f.flash--; if (f.muzzle > 0) f.muzzle--; }
    }

    // ------------------------------------------------------------ static layer

    renderFloor(world) {
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const W = C.ARENA_W, H = C.ARENA_H;

      drawGround(g, world, W, H);

      // vignette: darker toward the edges so the centre reads as the stage
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.62);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.46)');
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
      const haze = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
      haze.addColorStop(0, 'rgba(0,0,0,0)');
      haze.addColorStop(1, 'rgba(90,30,10,0.07)');
      g.fillStyle = haze;
      g.fillRect(0, 0, W, H);

      if (world) for (const m of world.mud) drawMud(g, m);
      this.fires = [];
      if (world) for (const o of world.obstacles) drawObstacle(g, o, this.fires);

      // border: weathered steel rim with a dull inner glow
      g.strokeStyle = 'rgba(170,150,120,0.07)';
      g.lineWidth = 10;
      g.strokeRect(7, 7, W - 14, H - 14);
      g.strokeStyle = '#4c4f50';
      g.lineWidth = 4;
      g.strokeRect(2, 2, W - 4, H - 4);
      g.strokeStyle = '#7a7568';
      g.lineWidth = 1;
      g.strokeRect(4.5, 4.5, W - 9, H - 9);
      return c;
    }

    // ------------------------------------------------------------ robots

    drawScan(ctx, r, tick) {
      const s = r.lastScanFx;
      if (!s || tick - s.tick > 1) return;
      const reach = s.range;
      const grad = ctx.createRadialGradient(r.x, r.y, C.ROBOT_RADIUS, r.x, r.y, reach);
      grad.addColorStop(0, hexA(r.color, s.found ? 0.24 : 0.12));
      grad.addColorStop(1, hexA(r.color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.arc(r.x, r.y, reach, (s.angle - s.width / 2) * DEG, (s.angle + s.width / 2) * DEG);
      ctx.closePath();
      ctx.fill();
    }

    drawRobot(ctx, r, selected, now) {
      const R = C.ROBOT_RADIUS;
      const f = this.fx(r.id);
      const hp = r.health / C.MAX_HEALTH;
      const dim = r.vm.halted && !r.vm.fault;

      if (selected) {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(now / 1500);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, R + 8, 0, TAU); ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      if (dim) ctx.globalAlpha = 0.5;
      ctx.translate(r.x, r.y);

      // ground shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(2, 3, R + 1, R - 2, 0, 0, TAU); ctx.fill();

      ctx.rotate(r.heading * DEG);

      // motion streaks behind the direction of travel
      if (Math.abs(r.speed) > 1.5) {
        const dir = Math.sign(r.speed);
        const x0 = -dir * (R - 1), x1 = -dir * (R - 1 + Math.abs(r.speed) * 2.5);
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, hexA(r.color, 0.3));
        g.addColorStop(1, hexA(r.color, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = TREAD.outer - TREAD.inner - 1;
        ctx.beginPath();
        for (const y of [-11, 11]) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
        ctx.stroke();
      }

      // treads, with tread marks that scroll as the robot drives
      this.drawDrive(ctx, r);
      this.drawDriveMud(ctx, r, f);

      // hull
      const grad = ctx.createLinearGradient(0, HULL.y, 0, HULL.y + HULL.h);
      const paint = weathered(r.color);
      grad.addColorStop(0, shade(paint, 0.22));
      grad.addColorStop(1, shade(paint, -0.28));
      ctx.fillStyle = grad;
      this.hullPath(ctx, r);
      ctx.fill();
      this.drawWear(ctx, r, f);
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 1.5;
      this.hullPath(ctx, r);
      ctx.stroke();

      // Headlights mark the front for every hull shape.
      ctx.fillStyle = '#fff7d1';
      const shape = r.appearance ? r.appearance.shape : 'tank';
      const lightX = shape === 'tank' ? 9 : shape === 'wedge' ? 6 : 8;
      const lightY = shape === 'tank' ? [-7, 4] : shape === 'wedge' ? [-2.5, 1] : [-5, 2];
      for (const y of lightY) ctx.fillRect(lightX, y, 2, shape === 'wedge' ? 1.5 : 3);

      // battle damage
      if (hp < 0.5) {
        ctx.save();
        this.hullPath(ctx, r);
        ctx.clip();
        ctx.fillStyle = 'rgba(15,10,8,0.55)';
        const n = hp < 0.25 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const a = (r.id * 2.3 + i * 2.1), d = 4 + (i * 3) % 6;
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * d - 2, Math.sin(a) * d * 0.7, 3.5, 2.5, a, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }

      // hit flash
      if (f.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(f.flash / 6) * 0.75})`;
        this.hullPath(ctx, r);
        ctx.fill();
      }

      // turret: light barrel and dome, independent of the hull
      ctx.rotate((r.turret - r.heading) * DEG);
      if (f.muzzle > 0) {
        const s = 4 + f.muzzle * 2;
        ctx.fillStyle = `rgba(255,236,170,${f.muzzle / 4})`;
        ctx.beginPath();
        ctx.moveTo(R + 5, 0);
        ctx.lineTo(R + 7 + s, -s * 0.55); ctx.lineTo(R + 9 + s * 1.4, 0); ctx.lineTo(R + 7 + s, s * 0.55);
        ctx.closePath(); ctx.fill();
      }
      this.drawBarrels(ctx, r);
      const dome = ctx.createRadialGradient(-1.5, -1.5, 0.5, 0, 0, 6.5);
      dome.addColorStop(0, shade(r.color, 0.7));
      dome.addColorStop(1, shade(r.color, 0.15));
      ctx.fillStyle = dome;
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(11,13,18,0.55)'; // hatch
      ctx.beginPath(); ctx.arc(-1, 0, 1.8, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(30,25,20,0.45)'; // scuff
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(0, 0, 4.2, 0.6 + (r.id % 3), 1.5 + (r.id % 3)); ctx.stroke();

      ctx.restore();
    }

    hullPath(ctx, r) {
      const shape = r.appearance ? r.appearance.shape : 'tank';
      if (shape === 'circle') {
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU);
      } else if (shape === 'hexagon' || shape === 'wedge') {
        const points = shape === 'hexagon'
          ? [[12, 0], [6, 11], [-6, 11], [-12, 0], [-6, -11], [6, -11]]
          : [[14, 0], [-9, 11], [-13, 7], [-13, -7], [-9, -11]];
        ctx.beginPath();
        points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.closePath();
      } else roundRect(ctx, HULL.x, HULL.y, HULL.w, HULL.h, HULL.r);
    }

    /**
     * Weathering on the hull, seeded from the robot's name so each robot
     * keeps the same scratches and chips: rear grime, panel seams, rivets,
     * scratches, chipped paint, a rust streak and any mud it picked up.
     */
    drawWear(ctx, r, f) {
      const rnd = BB.geo.makeRng(nameSeed(r.name));
      ctx.save();
      this.hullPath(ctx, r);
      ctx.clip();
      const grime = ctx.createLinearGradient(-14, 0, 4, 0);
      grime.addColorStop(0, 'rgba(35,26,16,0.45)');
      grime.addColorStop(1, 'rgba(35,26,16,0)');
      ctx.fillStyle = grime;
      ctx.fillRect(-15, -15, 30, 30);
      // Panel seams with rivets.
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-4, -12); ctx.lineTo(-4, 12); ctx.moveTo(-4, 0); ctx.lineTo(-13, 0); ctx.stroke();
      for (const [x, y] of [[-6, -6], [-6, 6], [-10, -3], [-10, 3]]) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath(); ctx.arc(x, y, 0.7, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath(); ctx.arc(x - 0.3, y - 0.3, 0.35, 0, TAU); ctx.fill();
      }
      // Rust streak running back from one rivet.
      const ry = rnd() < 0.5 ? -6 : 6;
      const rust = ctx.createLinearGradient(-6, 0, -13, 0);
      rust.addColorStop(0, 'rgba(130,65,25,0.45)');
      rust.addColorStop(1, 'rgba(130,65,25,0)');
      ctx.fillStyle = rust;
      ctx.fillRect(-13, ry - 0.8, 7, 1.6);
      // Scratches.
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const x = -10 + rnd() * 20, y = -9 + rnd() * 18, a = rnd() * Math.PI, len = 2.5 + rnd() * 4;
        ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      }
      ctx.stroke();
      // Chipped paint showing bare metal.
      for (let i = 0; i < 4; i++) {
        const x = -11 + rnd() * 22, y = -10 + rnd() * 20, rad = 0.7 + rnd() * 0.9;
        ctx.fillStyle = 'rgba(70,72,78,0.7)';
        ctx.beginPath(); ctx.ellipse(x, y, rad * 1.3, rad, rnd() * Math.PI, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(200,200,205,0.25)';
        ctx.beginPath(); ctx.arc(x - rad * 0.4, y - rad * 0.4, rad * 0.4, 0, TAU); ctx.fill();
      }
      // Mud splatter, mostly low on the hull and towards the back.
      if (f.mud > 0.03) {
        ctx.fillStyle = 'rgba(84,64,42,' + (0.6 * Math.min(1, f.mud * 1.5)).toFixed(3) + ')';
        const n = Math.ceil(9 * f.mud);
        for (let i = 0; i < 9; i++) {
          const x = -13 + rnd() * 18, y = (rnd() < 0.5 ? -1 : 1) * (6 + rnd() * 6), rad = 0.8 + rnd() * 1.8;
          if (i >= n) continue;
          ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    /** Mud caked on the treads or wheels after driving through mud. */
    drawDriveMud(ctx, r, f) {
      if (!(f.mud > 0.03) || (r.appearance && r.appearance.drive === 'hover')) return;
      const rnd = BB.geo.makeRng(nameSeed(r.name) ^ 0x5EED);
      ctx.fillStyle = 'rgba(80,60,38,' + (0.85 * Math.min(1, f.mud * 1.5)).toFixed(3) + ')';
      const n = Math.ceil(16 * f.mud);
      for (let i = 0; i < 16; i++) {
        const side = i % 2 ? 1 : -1;
        const x = TREAD.x + rnd() * TREAD.len, y = side * (TREAD.inner + rnd() * (TREAD.outer - TREAD.inner)), rad = 0.9 + rnd() * 1.6;
        if (i >= n) continue;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
      }
    }

    drawDrive(ctx, r, wreck = false) {
      const drive = r.appearance ? r.appearance.drive : 'tracks';
      if (drive === 'hover') {
        ctx.fillStyle = wreck ? '#16191f' : hexA(r.color, 0.2);
        ctx.strokeStyle = wreck ? '#3a414e' : hexA(r.color, 0.65);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(0, 0, 15, 12, 0, 0, TAU); ctx.fill(); ctx.stroke();
        return;
      }
      if (drive === 'wheels') {
        for (const x of [-8, 8]) for (const y of [-12, 12]) {
          ctx.fillStyle = wreck ? '#16191f' : '#1a1e26';
          roundRect(ctx, x - 3, y - 2.5, 6, 5, 1.5); ctx.fill();
          ctx.strokeStyle = '#59677c'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x, y + 2); ctx.stroke();
        }
        return;
      }
      const odo = r.x * Math.cos(r.heading * DEG) + r.y * Math.sin(r.heading * DEG);
      const phase = ((odo % 5) + 5) % 5;
      for (const side of [-1, 1]) {
        const y0 = side < 0 ? -TREAD.outer : TREAD.inner;
        ctx.fillStyle = wreck ? '#16191f' : '#1a1e26';
        roundRect(ctx, TREAD.x, y0, TREAD.len, TREAD.outer - TREAD.inner, 2.5);
        ctx.fill();
        ctx.strokeStyle = '#3a414e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = TREAD.x + 2 - phase + 5; x < TREAD.x + TREAD.len - 1; x += 5) {
          ctx.moveTo(x, y0 + 1); ctx.lineTo(x, y0 + TREAD.outer - TREAD.inner - 1);
        }
        ctx.stroke();
      }

    }

    drawBarrels(ctx, r, wreck = false) {
      const turret = r.appearance ? r.appearance.turret : 'standard';
      const end = turret === 'short' ? 13 : C.ROBOT_RADIUS + 5;
      const width = turret === 'twin' ? 3 : 4;
      ctx.strokeStyle = '#0b0d12'; ctx.lineWidth = 1.2;
      for (const y of turret === 'twin' ? [-3.5, 3.5] : [0]) {
        ctx.fillStyle = wreck ? '#3a3f49' : '#cdd4df';
        roundRect(ctx, 2, y - width / 2, end - 2, width, 1.5);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = wreck ? '#3a3f49' : '#8e97a6';
        ctx.fillRect(end - 4, y - width / 2 - 0.5, 4, width + 1);
        if (!wreck) { ctx.fillStyle = 'rgba(20,15,10,0.6)'; ctx.fillRect(end - 2.5, y - width / 2 - 0.5, 2.5, width + 1); }
      }
    }

    drawLabel(ctx, r, now) {
      const R = C.ROBOT_RADIUS;
      const hp = Math.max(0, r.health / C.MAX_HEALTH);
      // Label above the robot, or below it when hugging the top wall.
      const above = r.y - R - 15 >= 18;
      const w = 40, bx = r.x - w / 2, by = above ? r.y - R - 15 : r.y + R + 8;
      const ty = above ? by - 4 : by + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      roundRect(ctx, bx - 1, by - 1, w + 2, 6, 2);
      ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#66d17a' : hp > 0.25 ? '#ffc94d' : '#ff5a5a';
      if (hp > 0) { roundRect(ctx, bx, by, w * hp, 4, 1.5); ctx.fill(); }

      let label = r.team === null ? r.name : `${BB.World.TEAM_NAMES[r.team]} · ${r.name}`;
      if (r.vm.fault) label += Math.floor(now / 400) % 2 ? '  ⚠' : '   ';
      else if (r.vm.halted) label += ' (halted)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10,12,18,0.85)';
      ctx.strokeText(label, r.x, ty);
      ctx.fillStyle = r.vm.fault ? '#ffd27f' : '#eef1f6';
      ctx.fillText(label, r.x, ty);
    }

    drawWreck(ctx, r) {
      ctx.save();
      ctx.translate(r.x, r.y);
      // scorch mark on the floor
      const s = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
      s.addColorStop(0, 'rgba(0,0,0,0.6)');
      s.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = s;
      ctx.beginPath(); ctx.arc(0, 0, 34, 0, TAU); ctx.fill();

      ctx.rotate(r.heading * DEG);
      ctx.fillStyle = '#16191f';
      this.drawDrive(ctx, r, true);
      ctx.fillStyle = '#2a2e36';
      this.hullPath(ctx, r);
      ctx.fill();
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = hexA(r.color, 0.35);         // a hint of the old paint
      ctx.fillRect(HULL.x + 3, HULL.y + 3, 6, 4);
      ctx.rotate((r.turret - r.heading + 35) * DEG); // turret knocked askew
      ctx.fillStyle = '#3a3f49';
      this.drawBarrels(ctx, r, true);
      ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, TAU); ctx.fill();
      ctx.restore();

      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6b7385';
      ctx.fillText(r.name, r.x, r.y - C.ROBOT_RADIUS - 8);
    }

    /** Flickering flames on burning trees, with rising sparks and smoke. */
    drawFires(ctx, now) {
      const fires = (this.fires || []).concat(this.ignited);
      if (!fires.length) return;
      const t = now / 1000;
      const tongue = (x, y, s) => {
        ctx.beginPath();
        ctx.moveTo(x, y - s * 1.7);
        ctx.quadraticCurveTo(x + s, y - s * 0.2, x, y + s * 0.6);
        ctx.quadraticCurveTo(x - s, y - s * 0.2, x, y - s * 1.7);
        ctx.fill();
      };
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of fires) {
        const flick = fireFlicker(f, now);
        const reach = Math.max(14, f.r) * 2 * flick;
        const glow = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, reach);
        glow.addColorStop(0, 'rgba(255,120,30,0.3)');
        glow.addColorStop(1, 'rgba(255,60,10,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(f.x, f.y, reach, 0, TAU); ctx.fill();
        for (let k = 0; k < 5; k++) {
          const a = f.phase + k * TAU / 5 + t * 0.3;
          const d = f.r * (0.2 + 0.18 * Math.sin(k * 2.3 + f.phase));
          const x = f.x + Math.cos(a) * d, y = f.y + Math.sin(a) * d;
          const s = Math.max(4, f.r * 0.42) * (0.7 + 0.3 * Math.sin(t * 11 + k * 1.7 + f.phase)) * flick;
          ctx.fillStyle = 'rgba(255,80,20,0.55)';
          tongue(x, y, s);
          ctx.fillStyle = 'rgba(255,180,60,0.6)';
          tongue(x, y + s * 0.15, s * 0.6);
          ctx.fillStyle = 'rgba(255,240,190,0.7)';
          tongue(x, y + s * 0.25, s * 0.28);
        }
      }
      ctx.restore();
      if (this.particles.length >= MAX_PARTICLES) return;
      for (const f of fires) {
        if (Math.random() < 0.05) this.smoke(f.x, f.y - f.r * 0.4, 0.3);
        if (Math.random() < 0.06) {
          this.particles.push({
            kind: 'ember', x: f.x + (Math.random() - 0.5) * f.r, y: f.y - f.r * 0.3,
            vx: (Math.random() - 0.5) * 0.3, vy: -0.4 - Math.random() * 0.4,
            life: 45, max: 45, color: Math.random() < 0.5 ? '#ffb347' : '#ff7a2f', size: 1.1,
          });
        }
      }
    }

    /** Lay mud tracks and throw droplets for robots driving through mud. */
    updateMud(world) {
      for (const r of world.robots) {
        const f = this.fx(r.id);
        // Capped so a respawn or teleport never counts as a huge move.
        const moved = f.px === undefined ? 0 : Math.min(6, Math.hypot(r.x - f.px, r.y - f.py));
        f.px = r.x; f.py = r.y;
        f.mud = (f.mud || 0) * 0.9985;
        if (!r.alive || !world.inMud(r)) { f.trackX = undefined; continue; }
        f.mud = Math.min(1, f.mud + moved * 0.015);
        if (f.trackX === undefined) { f.trackX = r.x; f.trackY = r.y; }
        if (Math.hypot(r.x - f.trackX, r.y - f.trackY) >= 3) {
          this.tracks.push({ x1: f.trackX, y1: f.trackY, x2: r.x, y2: r.y, heading: r.heading,
            drive: r.appearance ? r.appearance.drive : 'tracks', tick: world.tick });
          if (this.tracks.length > MAX_TRACKS) this.tracks.shift();
          f.trackX = r.x; f.trackY = r.y;
        }
        // Droplets flick off the back of the treads while actually moving.
        if (moved < 0.05 || this.particles.length >= MAX_PARTICLES) continue;
        const dx = Math.cos(r.heading * DEG), dy = Math.sin(r.heading * DEG), back = r.speed >= 0 ? -1 : 1;
        for (let i = 0, n = Math.random() < Math.min(0.9, moved * 0.4) ? 1 + (Math.random() < 0.3 ? 1 : 0) : 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const sx = r.x + back * dx * 12 - side * dy * 11, sy = r.y + back * dy * 12 + side * dx * 11;
          const v = 0.6 + Math.random();
          this.particles.push({
            kind: 'drop', x: sx, y: sy,
            vx: back * dx * v - side * dy * (0.3 + Math.random() * 0.7), vy: back * dy * v + side * dx * (0.3 + Math.random() * 0.7),
            life: 16 + Math.random() * 8, max: 24, size: 1 + Math.random() * 1.3,
            color: ['#5a4430', '#3e2e1f', '#6e5638'][Math.floor(Math.random() * 3)],
          });
        }
      }
    }

    /** Fading tread marks, ruts or hover wakes left in mud. */
    drawTracks(ctx, tick) {
      if (!this.tracks.length) return;
      this.tracks = this.tracks.filter((t) => tick - t.tick < TRACK_LIFE && tick >= t.tick);
      ctx.save();
      ctx.lineCap = 'round';
      for (const t of this.tracks) {
        const a = 1 - (tick - t.tick) / TRACK_LIFE;
        const nx = -Math.sin(t.heading * DEG), ny = Math.cos(t.heading * DEG);
        const line = (off, width, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(t.x1 + nx * off, t.y1 + ny * off);
          ctx.lineTo(t.x2 + nx * off, t.y2 + ny * off);
          ctx.stroke();
        };
        if (t.drive === 'hover') {
          line(0, 22, 'rgba(30,22,14,' + (0.22 * a).toFixed(3) + ')');
          continue;
        }
        const off = t.drive === 'wheels' ? 12 : 11, width = t.drive === 'wheels' ? 3.5 : 5;
        for (const side of [-1, 1]) {
          line(side * off, width, 'rgba(22,15,9,' + (0.5 * a).toFixed(3) + ')');
          line(side * off - 1.5, 1, 'rgba(130,105,70,' + (0.18 * a).toFixed(3) + ')'); // lit ridge
        }
      }
      ctx.restore();
    }

    /** Robots and wrecks near burning trees pick up a flickering orange glow on the side facing the fire. */
    drawFireLight(ctx, world, now) {
      const fires = (this.fires || []).concat(this.ignited);
      if (!fires.length) return;
      const R = C.ROBOT_RADIUS;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const r of world.robots) {
        let sum = 0, dx = 0, dy = 0;
        for (const f of fires) {
          const d = Math.hypot(f.x - r.x, f.y - r.y);
          if (d >= FIRE_LIGHT || d < 1e-6) continue;
          const w = (1 - d / FIRE_LIGHT) ** 2 * fireFlicker(f, now);
          sum += w; dx += (f.x - r.x) / d * w; dy += (f.y - r.y) / d * w;
        }
        if (sum < 0.02) continue;
        const k = Math.min(1, sum), len = Math.hypot(dx, dy) || 1;
        const lx = r.x + dx / len * R * 0.45, ly = r.y + dy / len * R * 0.45;
        const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, R * 1.7);
        glow.addColorStop(0, 'rgba(255,135,45,' + (0.55 * k).toFixed(3) + ')');
        glow.addColorStop(0.5, 'rgba(255,110,30,' + (0.22 * k).toFixed(3) + ')');
        glow.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(lx, ly, R * 1.7, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    emitAmbientSmoke(world) {
      for (const r of world.robots) {
        if (r.alive && r.health / C.MAX_HEALTH < 0.25 && Math.random() < 0.35) this.smoke(r.x, r.y);
        else if (!r.alive && Math.random() < 0.08) this.smoke(r.x, r.y, 0.25);
      }
    }

    drawProjectile(ctx, p) {
      const tx = p.x - p.vx * 1.6, ty = p.y - p.vy * 1.6;
      const g = ctx.createLinearGradient(tx, ty, p.x, p.y);
      g.addColorStop(0, hexA(p.color, 0));
      g.addColorStop(1, hexA(p.color, 0.85));
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = hexA(p.color, 0.35);
      ctx.beginPath(); ctx.arc(p.x, p.y, 5.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, TAU); ctx.fill();
    }

    drawParticles(ctx) {
      const keep = [];
      for (const p of this.particles) {
        const t = 1 - p.life / p.max; // 0 -> 1 over the particle's life
        switch (p.kind) {
          case 'spark':
            p.x += p.vx; p.y += p.vy; p.vx *= 0.88; p.vy *= 0.88;
            ctx.globalAlpha = 1 - t;
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, TAU); ctx.fill();
            break;
          case 'drop':
            p.x += p.vx; p.y += p.vy; p.vx *= 0.86; p.vy *= 0.86;
            ctx.globalAlpha = Math.min(1, 1.6 * (1 - t));
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
            break;
          case 'ember':
            p.x += p.vx + Math.sin(p.life * 0.4) * 0.15; p.y += p.vy; p.vy *= 0.985;
            ctx.globalAlpha = 1 - t;
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.6), 0, TAU); ctx.fill();
            break;
          case 'smoke':
            p.x += p.vx; p.y += p.vy;
            ctx.globalAlpha = 0.45 * (1 - t);
            ctx.fillStyle = '#8b93a1';
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size + t * 9, 0, TAU); ctx.fill();
            break;
          case 'flash': {
            const rad = p.size * (0.6 + t * 0.6);
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
            g.addColorStop(0, '#ffffff');
            g.addColorStop(0.35, p.color);
            g.addColorStop(0.7, 'rgba(255,120,40,0.55)');
            g.addColorStop(1, 'rgba(255,80,20,0)');
            ctx.globalAlpha = 1 - t * t;
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, TAU); ctx.fill();
            break;
          }
          case 'ring':
            ctx.globalAlpha = 0.7 * (1 - t);
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(p.x, p.y, 8 + p.size * t, 0, TAU); ctx.stroke();
            break;
        }
        if (--p.life > 0) keep.push(p);
      }
      ctx.globalAlpha = 1;
      this.particles = keep;
    }

    drawBanner(ctx, world) {
      let text = world.winner ? `${world.winner.name} wins!` : 'Draw!';
      let color = world.winner ? world.winner.color : '#e8ecf3';
      if (world.teamMode && world.winnerTeam !== null) {
        text = `Team ${BB.World.TEAM_NAMES[world.winnerTeam]} wins!`;
        color = BB.World.TEAM_COLORS[world.winnerTeam][0];
      }
      ctx.fillStyle = 'rgba(10,12,18,0.72)';
      ctx.fillRect(0, C.ARENA_H / 2 - 44, C.ARENA_W, 88);
      ctx.textAlign = 'center';
      ctx.font = '700 36px system-ui, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(text, C.ARENA_W / 2, C.ARENA_H / 2 + 6);
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = '#aab2c2';
      ctx.fillText(`tick ${world.tick} · press Rematch to play again`, C.ARENA_W / 2, C.ARENA_H / 2 + 30);
    }
  }

  // ------------------------------------------------------------ helpers

  /** Fixed pseudo-random sequence per rect, so decorations look the same on every redraw. */
  function rectRng(o) {
    let h = (o.x * 73856093) ^ (o.y * 19349663) ^ (o.w * 83492791) ^ (o.h * 2654435761);
    return () => { h = Math.imul(h ^ (h >>> 13), 0x5BD1E995); h ^= h >>> 15; return (h >>> 0) / 4294967296; };
  }

  /**
   * War-torn countryside covering the open ground: muted grass scarred by
   * burns, craters and scrap. Everything here is flat and low contrast so it
   * never reads as an obstacle or mud; details skip the terrain rects.
   * Varies with the seed, fixed for a given world.
   */
  function drawGround(g, world, W, H) {
    const seed = world ? world.seed : 1;
    const rnd = rectRng({ x: seed, y: 7, w: 13, h: 29 });
    const blocked = world ? world.obstacles.concat(world.mud) : [];
    const clear = (x, y, pad) => blocked.every((o) => x < o.x - pad || x > o.x + o.w + pad || y < o.y - pad || y > o.y + o.h + pad);
    const glow = (x, y, r, color) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    };

    g.fillStyle = '#18201a';
    g.fillRect(0, 0, W, H);
    // Patches of lighter grass, darker grass and pale ash.
    for (let i = 0; i < 28; i++) {
      const roll = rnd();
      glow(rnd() * W, rnd() * H, 40 + rnd() * 90,
        roll < 0.4 ? 'rgba(70,100,55,0.1)' : roll < 0.75 ? 'rgba(5,12,6,0.18)' : 'rgba(120,110,100,0.06)');
    }
    // Faint grid, so positions are still easy to judge.
    g.lineWidth = 1;
    for (const [step, color] of [[50, 'rgba(190,190,160,0.03)'], [100, 'rgba(190,190,160,0.05)']]) {
      g.strokeStyle = color;
      g.beginPath();
      for (let x = step; x < W; x += step) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
      for (let y = step; y < H; y += step) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
      g.stroke();
    }
    // Burnt patches: scorched earth where the grass is gone.
    const burns = [];
    for (let i = 0; i < 7; i++) {
      const x = rnd() * W, y = rnd() * H, r = 25 + rnd() * 35;
      if (!clear(x, y, 10)) continue;
      burns.push({ x, y, r });
      glow(x, y, r, 'rgba(20,14,10,0.5)');
      glow(x, y, r * 0.55, 'rgba(10,8,6,0.35)');
    }
    const burnt = (x, y) => burns.some((b) => Math.hypot(b.x - x, b.y - y) < b.r * 0.7);
    // Cracks radiating through the burnt patches.
    g.lineCap = 'round';
    const crack = (x, y, a, steps, width) => {
      for (let k = 0; k < steps; k++) {
        const len = 4 + rnd() * 8;
        const nx = x + Math.cos(a) * len, ny = y + Math.sin(a) * len;
        if (!clear(nx, ny, 2)) return;
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        g.lineWidth = width;
        g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
        if (rnd() < 0.25 && width > 0.7) crack(nx, ny, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6), steps - k - 1, width * 0.7);
        x = nx; y = ny; a += (rnd() - 0.5) * 0.9;
      }
    };
    for (const b of burns) {
      for (let k = 0, n = 2 + Math.floor(rnd() * 3); k < n; k++) crack(b.x, b.y, rnd() * Math.PI * 2, 2 + Math.floor(rnd() * 4), 1.1 + rnd() * 0.5);
    }
    // A few shallow craters, kept flat and dim.
    for (let i = 0; i < 5; i++) {
      const r = 9 + rnd() * 12, x = rnd() * W, y = rnd() * H;
      if (!clear(x, y, r + 6)) continue;
      glow(x, y, r * 1.4, 'rgba(0,0,0,0.14)');
      g.fillStyle = 'rgba(20,14,10,0.2)';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(150,140,110,0.1)';
      g.beginPath(); g.arc(x, y, r, Math.PI * 0.75, Math.PI * 1.75); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.2)';
      g.beginPath(); g.arc(x, y, r, Math.PI * 1.75, Math.PI * 2.75); g.stroke();
    }
    // Grass tufts: green on living ground, dry and brown on burnt ground.
    for (let i = 0; i < 460; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (!clear(x, y, 4)) continue;
      const dry = burnt(x, y) || rnd() < 0.25;
      g.strokeStyle = dry ? (rnd() < 0.6 ? 'rgba(120,105,80,0.22)' : 'rgba(60,50,40,0.35)')
        : (rnd() < 0.6 ? 'rgba(85,125,65,0.3)' : 'rgba(40,65,35,0.42)');
      g.lineWidth = 1;
      g.beginPath();
      for (let k = 0, n = 3 + Math.floor(rnd() * 3); k < n; k++) {
        const a = -Math.PI / 2 + (rnd() - 0.5) * (dry ? 1.8 : 1.3), len = 2.5 + rnd() * 4;
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      }
      g.stroke();
    }
    g.lineCap = 'butt';
    // Scrap: small rotated shards of steel and rust.
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (!clear(x, y, 4)) continue;
      g.save();
      g.translate(x, y);
      g.rotate(rnd() * Math.PI);
      g.fillStyle = rnd() < 0.6 ? 'rgba(115,120,125,0.3)' : 'rgba(125,65,35,0.35)';
      const w = 1.5 + rnd() * 4, h = 1 + rnd() * 2;
      if (rnd() < 0.5) g.fillRect(-w / 2, -h / 2, w, h);
      else { g.beginPath(); g.moveTo(-w / 2, h / 2); g.lineTo(w / 2, h / 2); g.lineTo(0, -h); g.closePath(); g.fill(); }
      g.restore();
    }
    // Pebbles and ash.
    for (let i = 0; i < 60; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (!clear(x, y, 3)) continue;
      g.fillStyle = 'rgba(150,150,140,0.14)';
      g.beginPath();
      g.ellipse(x, y, 1 + rnd() * 1.6, 0.8 + rnd() * 1.1, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    // A few hardy flowers, away from the burns.
    const petals = ['rgba(225,215,140,0.45)', 'rgba(220,220,230,0.4)', 'rgba(180,150,215,0.4)'];
    for (let i = 0; i < 8; i++) {
      const cx = rnd() * W, cy = rnd() * H, color = petals[Math.floor(rnd() * petals.length)];
      for (let k = 0, n = 2 + Math.floor(rnd() * 4); k < n; k++) {
        const x = cx + (rnd() - 0.5) * 16, y = cy + (rnd() - 0.5) * 12;
        if (!clear(x, y, 3) || burnt(x, y)) continue;
        g.fillStyle = color;
        g.beginPath();
        g.arc(x, y, 0.9 + rnd() * 0.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Embers still glowing in some of the burns.
    for (const b of burns) {
      if (rnd() < 0.4) continue;
      const x = b.x + (rnd() - 0.5) * b.r * 0.6, y = b.y + (rnd() - 0.5) * b.r * 0.6;
      glow(x, y, 4 + rnd() * 4, 'rgba(255,110,30,0.3)');
      g.fillStyle = 'rgba(255,170,80,0.65)';
      g.beginPath(); g.arc(x, y, 0.8, 0, Math.PI * 2); g.fill();
    }
  }

  /**
   * An organic closed outline around (cx, cy) with half-extents (a, b), its
   * edge pushed in and out by smooth looping noise of up to `wobble` units.
   * `square` is the corner exponent: 1 gives an ellipse, smaller values hug
   * a rectangle more tightly.
   */
  function blobPath(rnd, cx, cy, a, b, wobble, square = 1) {
    const waves = [[3 + Math.floor(rnd() * 3), 0.6], [7 + Math.floor(rnd() * 5), 0.3], [15 + Math.floor(rnd() * 9), 0.12]]
      .map(([k, amp]) => ({ k, amp, phase: rnd() * Math.PI * 2 }));
    const n = Math.max(24, Math.round((a + b) * 1.2));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const off = wobble * waves.reduce((sum, w) => sum + w.amp * Math.sin(w.k * t + w.phase), 0);
      const x = cx + Math.sign(c) * Math.abs(c) ** square * (a + off), y = cy + Math.sign(s) * Math.abs(s) ** square * (b + off);
      pts.push([x, y]);
    }
    const p = new Path2D();
    const mid = (i) => [(pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2];
    p.moveTo(...mid(n - 1));
    for (let i = 0; i < n; i++) p.quadraticCurveTo(pts[i][0], pts[i][1], ...mid(i));
    p.closePath();
    return p;
  }

  /** Flame strength for a fire right now: flickers around 0.8..1 and grows in over 1.5 s once lit. */
  function fireFlicker(f, now) {
    const t = now / 1000;
    const grow = f.born ? Math.min(1, (now - f.born) / 1500) : 1;
    return (0.8 + 0.2 * Math.sin(t * 9 + f.phase) * Math.sin(t * 13.7 + f.phase * 2)) * grow;
  }

  /** A battle scar on the decal layer: a blast crater or a small char mark. */
  function drawScar(g, s) {
    const rnd = BB.geo.makeRng(s.seed);
    const glow = (r, color) => {
      const grad = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(s.x, s.y, r, 0, Math.PI * 2); g.fill();
    };
    if (s.kind === 'char') {
      glow(s.r * 1.6, 'rgba(8,6,4,0.55)');
      g.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.arc(s.x + (rnd() - 0.5) * s.r * 1.6, s.y + (rnd() - 0.5) * s.r * 1.6, 0.6 + rnd() * 1.2, 0, Math.PI * 2);
        g.fill();
      }
      return;
    }
    // Scorched blast area with streaks thrown outward.
    glow(s.r * 2.6, 'rgba(10,7,5,0.5)');
    g.lineCap = 'round';
    for (let i = 0, n = 9 + Math.floor(rnd() * 5); i < n; i++) {
      const a = rnd() * Math.PI * 2, from = s.r * 0.8, to = s.r * (1.6 + rnd() * 1.1);
      g.strokeStyle = 'rgba(5,4,3,' + (0.25 + rnd() * 0.25).toFixed(2) + ')';
      g.lineWidth = 1 + rnd() * 2.5;
      g.beginPath();
      g.moveTo(s.x + Math.cos(a) * from, s.y + Math.sin(a) * from);
      g.lineTo(s.x + Math.cos(a) * to, s.y + Math.sin(a) * to);
      g.stroke();
    }
    g.lineCap = 'butt';
    // The crater bowl: ragged edge, dark floor, lit rim on the top left.
    const bowl = blobPath(rnd, s.x, s.y, s.r, s.r * 0.9, s.r * 0.15);
    g.fillStyle = 'rgba(12,9,7,0.75)';
    g.fill(bowl);
    g.save();
    g.clip(bowl);
    glow(s.r * 0.7, 'rgba(0,0,0,0.5)');
    g.restore();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(150,130,105,0.22)';
    g.save();
    g.beginPath(); g.rect(s.x - s.r * 2, s.y - s.r * 2, s.r * 2, s.r * 2); g.clip();
    g.stroke(bowl);
    g.restore();
    // Debris and a few embers left in the crater.
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2, d = s.r * (0.9 + rnd() * 1.4);
      g.fillStyle = rnd() < 0.6 ? 'rgba(110,112,115,0.4)' : 'rgba(40,32,26,0.7)';
      g.fillRect(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, 1 + rnd() * 2.5, 1 + rnd() * 1.5);
    }
    for (let i = 0; i < 3; i++) {
      g.fillStyle = 'rgba(255,130,50,0.6)';
      g.beginPath();
      g.arc(s.x + (rnd() - 0.5) * s.r, s.y + (rnd() - 0.5) * s.r, 0.8, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** Mud: a wobbly patch whose edge stays within a few units of the slowing rect. */
  function drawMud(g, m) {
    const rnd = rectRng(m);
    const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
    // Rounded corners fall at most ~16% inside the rect; robots are judged by their centre anyway.
    const outline = blobPath(rnd, cx, cy, m.w / 2 + 2, m.h / 2 + 2, 7, 0.5);

    // Dried rim, slightly wider than the wet mud, then the mud itself.
    g.save();
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(105,85,55,0.55)';
    g.lineWidth = 5;
    g.stroke(outline);
    const grad = g.createRadialGradient(cx, cy, 4, cx, cy, Math.max(m.w, m.h) * 0.65);
    grad.addColorStop(0, '#3b2c1d');
    grad.addColorStop(1, '#4d3a26');
    g.fillStyle = grad;
    g.fill(outline);

    g.clip(outline);
    // Darker wet hollows, each an irregular blob of its own.
    for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
      const w = m.w * (0.18 + rnd() * 0.22), h = m.h * (0.18 + rnd() * 0.22);
      const x = m.x + w + rnd() * (m.w - 2 * w), y = m.y + h + rnd() * (m.h - 2 * h);
      g.fillStyle = 'rgba(25,17,10,0.45)';
      g.fill(blobPath(rnd, x, y, w, h, Math.min(w, h) * 0.3));
    }
    // Speckles: clods and grit.
    for (let i = 0, n = Math.round(m.w * m.h / 110); i < n; i++) {
      g.fillStyle = rnd() < 0.55 ? 'rgba(20,13,7,0.35)' : 'rgba(130,105,70,0.2)';
      g.beginPath();
      g.arc(m.x + rnd() * m.w, m.y + rnd() * m.h, 0.8 + rnd() * 2.2, 0, Math.PI * 2);
      g.fill();
    }
    // Glossy puddles catching the light, with a small highlight.
    for (let i = 0, n = 1 + Math.floor(rnd() * 3); i < n; i++) {
      const w = 6 + rnd() * 12, h = 3 + rnd() * 6;
      const x = m.x + w + rnd() * (m.w - 2 * w), y = m.y + h + rnd() * (m.h - 2 * h);
      g.fillStyle = 'rgba(120,140,160,0.16)';
      g.fill(blobPath(rnd, x, y, w, h, Math.min(w, h) * 0.3));
      g.fillStyle = 'rgba(220,230,240,0.18)';
      g.beginPath();
      g.ellipse(x - w * 0.35, y - h * 0.3, w * 0.25, h * 0.2, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    // Soft inner edge where the mud meets the rim.
    g.strokeStyle = 'rgba(20,13,7,0.5)';
    g.lineWidth = 1.2;
    g.stroke(outline);
  }

  const CANOPY = [
    ['#1f4228', '#2d5f35', '#46803f'],   // pine green
    ['#24462a', '#386b39', '#558d47'],   // leafy green
    ['#2a4226', '#43622e', '#647f3a'],   // olive
  ];

  /** A living tree seen from above: a lobed canopy, lit from the top left. */
  function drawLivingTree(g, t) {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.arc(t.x + t.r * 0.18, t.y + t.r * 0.25, t.r, 0, Math.PI * 2);
    g.fill();
    const [dark, mid, light] = t.palette;
    const puffs = (scale, offX, offY, color) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(t.x + offX, t.y + offY, t.r * 0.62 * scale, 0, Math.PI * 2);
      for (let k = 0; k < t.lobes; k++) {
        const a = t.spin + k * Math.PI * 2 / t.lobes;
        const px = t.x + offX + Math.cos(a) * t.r * 0.5 * scale, py = t.y + offY + Math.sin(a) * t.r * 0.5 * scale;
        g.moveTo(px + t.r * 0.45 * scale, py);
        g.arc(px, py, t.r * 0.45 * scale, 0, Math.PI * 2);
      }
      g.fill();
    };
    puffs(1, 0, 0, dark);
    puffs(0.8, -t.r * 0.08, -t.r * 0.1, mid);
    if (t.shrub) return; // low bushes: no bright crown or glint
    puffs(0.45, -t.r * 0.22, -t.r * 0.26, light);
    g.fillStyle = 'rgba(255,255,220,0.08)';
    g.beginPath();
    g.arc(t.x - t.r * 0.3, t.y - t.r * 0.35, t.r * 0.18, 0, Math.PI * 2);
    g.fill();
  }

  /** A charred, leafless tree seen from above: bare branches around a burnt trunk. */
  function drawDeadTree(g, t) {
    if (t.shrub) {
      // Burnt stump.
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.arc(t.x + 1.5, t.y + 2, t.r * 0.7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#211b17';
      g.beginPath(); g.arc(t.x, t.y, t.r * 0.6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3d332b';
      g.lineWidth = 1;
      g.beginPath(); g.arc(t.x, t.y, t.r * 0.6, 0, Math.PI * 2); g.stroke();
      return;
    }
    const branch = (rnd, x, y, a, len, width, depth, dx, dy) => {
      const bend = (rnd() - 0.5) * 0.5;
      const mx = x + Math.cos(a + bend) * len * 0.5, my = y + Math.sin(a + bend) * len * 0.5;
      const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      g.lineWidth = width;
      g.beginPath(); g.moveTo(x + dx, y + dy); g.quadraticCurveTo(mx + dx, my + dy, ex + dx, ey + dy); g.stroke();
      if (depth > 0) {
        for (const side of [-1, 1]) branch(rnd, ex, ey, a + side * (0.35 + rnd() * 0.45), len * (0.5 + rnd() * 0.2), width * 0.62, depth - 1, dx, dy);
      }
    };
    const width = Math.max(1.8, t.r * 0.2);
    g.lineCap = 'round';
    // Replay the same branch shapes three times: shadow, wood, then a thin lit edge.
    for (const [color, dx, dy, wmul] of [['rgba(0,0,0,0.45)', 2, 3, 1], ['#2b241f', 0, 0, 1], ['rgba(110,95,80,0.35)', -0.5, -0.5, 0.35]]) {
      const rnd = BB.geo.makeRng(t.shape);
      g.strokeStyle = color;
      const n = 5 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const a = t.spin + k * Math.PI * 2 / n + (rnd() - 0.5) * 0.5;
        branch(rnd, t.x, t.y, a, t.r * (0.42 + rnd() * 0.14), width * wmul, 2, dx, dy);
      }
    }
    g.lineCap = 'butt';
    // Trunk: a charred cross-section, sometimes still smouldering.
    g.fillStyle = '#1a1512';
    g.beginPath(); g.arc(t.x, t.y, t.r * 0.2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3a302a';
    g.lineWidth = 1;
    g.beginPath(); g.arc(t.x, t.y, t.r * 0.2, 0, Math.PI * 2); g.stroke();
    if (t.smoulder) {
      const gl = g.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.r * 0.45);
      gl.addColorStop(0, 'rgba(255,110,30,0.45)');
      gl.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gl;
      g.beginPath(); g.arc(t.x, t.y, t.r * 0.45, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,170,80,0.8)';
      g.beginPath(); g.arc(t.x, t.y, 1, 0, Math.PI * 2); g.fill();
    }
  }

  /**
   * Obstacles are drawn as stands of trees seen from above, some living and
   * some burnt; each stand has its own share of damage. Undergrowth covers
   * the collision rect so the blocked area always reads, and canopies
   * overhang it by only a few units.
   */
  function drawObstacle(g, o, fires) {
    const rnd = rectRng(o);
    const thin = Math.min(o.w, o.h);
    const isBar = thin <= 30 && Math.max(o.w, o.h) >= 2 * thin;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const damage = 0.1 + rnd() * 0.55; // share of trees burnt in this stand
    const tree = (x, y, r, shrub = false) => {
      const dead = rnd() < damage;
      return { x, y, r, shrub, dead, smoulder: dead && !shrub && rnd() < 0.25,
        palette: CANOPY[Math.floor(rnd() * CANOPY.length)], lobes: (shrub ? 4 : 5) + Math.floor(rnd() * (shrub ? 2 : 3)),
        spin: rnd() * Math.PI * 2, shape: Math.floor(rnd() * 4294967296) };
    };
    const trees = [];

    // Soft ground shadow, then undergrowth with a ragged edge that still
    // covers the collision rect, scattered with burnt rubble.
    const footprint = blobPath(rnd, cx, cy, o.w / 2 + 3, o.h / 2 + 3, 2.5, 0.3);
    g.save();
    g.translate(4, 6);
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.fill(footprint);
    g.restore();
    g.fillStyle = '#10180f';
    g.fill(footprint);
    g.save();
    g.clip(footprint);
    for (let i = 0, n = Math.round(o.w * o.h * damage / 30); i < n; i++) {
      const roll = rnd();
      g.fillStyle = roll < 0.6 ? 'rgba(55,48,42,0.55)' : roll < 0.96 ? 'rgba(130,120,110,0.12)' : 'rgba(255,120,40,0.5)';
      g.beginPath();
      g.arc(o.x + rnd() * o.w, o.y + rnd() * o.h, roll < 0.96 ? 0.8 + rnd() * 1.6 : 0.8, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    if (isBar) {
      // A natural row: mixed sizes, uneven spacing, drifting side to side.
      const horiz = o.w >= o.h, len = horiz ? o.w : o.h;
      const slack = 5; // max overhang across the row
      const along = (t, side, r) => {
        const mid = thin / 2, drift = Math.max(0, mid + slack - r);
        const off = mid + (side * 2 - 1) * drift;
        return horiz ? tree(o.x + t, o.y + off, r) : tree(o.x + off, o.y + t, r);
      };
      let t = 0, edge = 0; // edge: far side of the last canopy
      for (;;) {
        const r = Math.min(thin / 2 + slack, (thin / 2 + 2) * (0.65 + rnd() * 0.6));
        const pos = Math.max(r - 2, t + r * (0.6 + rnd() * 0.5));
        if (pos > len - r + 2) {
          // Close the row with one tree flush to the end, unless it's already covered.
          if (len - edge > r * 0.5) trees.push(along(len - r + 2, rnd(), r));
          break;
        }
        trees.push(along(pos, rnd(), r));
        edge = pos + r;
        t = pos + r * (0.35 + rnd() * 0.5);
      }
    } else {
      // Groves: a dense jittered grid so there are no bare gaps...
      const base = Math.max(11, Math.min(22, thin / 2 + 2));
      const nx = Math.max(1, Math.round(o.w / (base * 1.45)));
      const ny = Math.max(1, Math.round(o.h / (base * 1.45)));
      const slack = 2; // max overhang beyond the collision rect
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const r = Math.min(base * (0.75 + rnd() * 0.45), o.w / 2 + slack, o.h / 2 + slack);
        const x = o.x + (i + 0.5) * o.w / nx + (rnd() - 0.5) * base * 0.6;
        const y = o.y + (j + 0.5) * o.h / ny + (rnd() - 0.5) * base * 0.6;
        trees.push(tree(Math.max(o.x + r - slack, Math.min(o.x + o.w - r + slack, x)),
          Math.max(o.y + r - slack, Math.min(o.y + o.h - r + slack, y)), r));
      }
      // ...then smaller trees scattered into whatever space is left.
      for (let i = 0, n = 10 + Math.round(o.w * o.h / 150); i < n; i++) {
        const r = base * (0.45 + rnd() * 0.3);
        const x = o.x + r - slack + rnd() * (o.w - 2 * (r - slack)), y = o.y + r - slack + rnd() * (o.h - 2 * (r - slack));
        if (trees.some((q) => Math.hypot(q.x - x, q.y - y) < 0.7 * (q.r + r))) continue;
        trees.push(tree(x, y, r));
      }
    }
    // A few low shrubs or stumps tucked into gaps.
    for (let i = 0, n = 2 + Math.round((o.w + o.h) / 30); i < n; i++) {
      const r = 4.5 + rnd() * 3;
      const x = o.x + rnd() * o.w, y = o.y + rnd() * o.h;
      if (trees.some((q) => Math.hypot(q.x - x, q.y - y) < (q.shrub ? q.r + r : q.r * 0.8))) continue;
      trees.push(tree(x, y, r, true));
    }
    trees.sort((a, b) => a.y - b.y); // lower trees overlap the ones behind them
    for (const t of trees) (t.dead ? drawDeadTree : drawLivingTree)(g, t);
    // Some dead trees are still burning; their flames are animated each frame.
    for (const t of trees) if (t.dead && !t.shrub && rnd() < 0.4) fires.push({ x: t.x, y: t.y, r: t.r, phase: rnd() * Math.PI * 2 });
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hexA(hex, a) {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** Sun-faded paint: the team colour mixed 15% toward dusty grey, as hex. */
  function weathered(hex) {
    const dust = [119, 115, 106];
    return '#' + rgb(hex).map((v, i) => Math.round(v * 0.85 + dust[i] * 0.15).toString(16).padStart(2, '0')).join('');
  }

  /** Stable 32-bit seed from a robot's name, so its wear looks the same every match. */
  function nameSeed(name) {
    let h = 2166136261;
    for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  /** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
  function shade(hex, amt) {
    const c = rgb(hex).map((v) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  BB.Renderer = Renderer;
})(globalThis.BB = globalThis.BB || {});
