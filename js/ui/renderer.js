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
    }

    /** Forget all cosmetic state (called when a new match starts). */
    clearEffects() {
      this.particles = [];
      this.robotFx.clear();
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
            break;
          case 'bump':
            this.burst(e.x, e.y, 4, ['#ffcc80', '#ffffff'], 1, 2, 7, 1.5);
            break;
          case 'explode':
            this.particles.push({ kind: 'flash', x: e.x, y: e.y, size: 34, life: 12, max: 12, color: '#ffe2a8' });
            this.particles.push({ kind: 'ring', x: e.x, y: e.y, size: 70, life: 22, max: 22, color: '#ffffff' });
            this.burst(e.x, e.y, 22, ['#ffb347', '#ff6a3d', '#fff1c1', e.color], 1.5, 5.5, 28, 2.6);
            for (let i = 0; i < 8; i++) this.smoke(e.x, e.y, 1.6);
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

      const now = performance.now();
      for (const r of world.robots) if (!r.alive) this.drawWreck(ctx, r);
      if (this.showScans) for (const r of world.robots) if (r.alive) this.drawScan(ctx, r, world.tick);
      for (const p of world.projectiles) this.drawProjectile(ctx, p);
      for (const r of world.robots) if (r.alive) this.drawRobot(ctx, r, r.entryId === selectedEntryId, now);
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
      v.addColorStop(1, 'rgba(0,0,0,0.38)');
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);

      if (world) for (const m of world.mud) drawMud(g, m);
      if (world) for (const o of world.obstacles) drawObstacle(g, o);

      // border: steel rim with a soft inner glow
      g.strokeStyle = 'rgba(110,150,210,0.14)';
      g.lineWidth = 10;
      g.strokeRect(7, 7, W - 14, H - 14);
      g.strokeStyle = '#59677c';
      g.lineWidth = 4;
      g.strokeRect(2, 2, W - 4, H - 4);
      g.strokeStyle = '#8796ad';
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

      // hull
      const grad = ctx.createLinearGradient(0, HULL.y, 0, HULL.y + HULL.h);
      grad.addColorStop(0, shade(r.color, 0.25));
      grad.addColorStop(1, shade(r.color, -0.25));
      ctx.fillStyle = grad;
      this.hullPath(ctx, r);
      ctx.fill();
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 1.5;
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
   * Cosmetic grass covering the open ground. Everything here is flat and low
   * contrast so it never reads as an obstacle or mud; decorations skip the
   * terrain rects. Varies with the seed, fixed for a given world.
   */
  function drawGround(g, world, W, H) {
    const seed = world ? world.seed : 1;
    const rnd = rectRng({ x: seed, y: 7, w: 13, h: 29 });
    const blocked = world ? world.obstacles.concat(world.mud) : [];
    const clear = (x, y, pad) => blocked.every((o) => x < o.x - pad || x > o.x + o.w + pad || y < o.y - pad || y > o.y + o.h + pad);

    g.fillStyle = '#16231a';
    g.fillRect(0, 0, W, H);
    // Mowing stripes, 50 units wide, aligned with the old grid.
    for (let x = 0; x < W; x += 100) { g.fillStyle = 'rgba(255,255,255,0.018)'; g.fillRect(x, 0, 50, H); }
    // Large soft blotches of lighter and darker grass.
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W, y = rnd() * H, r = 40 + rnd() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rnd() < 0.5 ? 'rgba(70,110,60,0.10)' : 'rgba(5,15,8,0.16)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // Faint grid, so positions are still easy to judge.
    g.lineWidth = 1;
    for (const [step, color] of [[50, 'rgba(160,200,150,0.035)'], [100, 'rgba(160,200,150,0.06)']]) {
      g.strokeStyle = color;
      g.beginPath();
      for (let x = step; x < W; x += step) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
      for (let y = step; y < H; y += step) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
      g.stroke();
    }
    // Grass tufts: small fans of blades.
    g.lineCap = 'round';
    for (let i = 0; i < 520; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (!clear(x, y, 4)) continue;
      g.strokeStyle = rnd() < 0.6 ? 'rgba(90,140,70,0.32)' : 'rgba(40,70,35,0.45)';
      g.lineWidth = 1;
      g.beginPath();
      for (let k = 0, n = 3 + Math.floor(rnd() * 3); k < n; k++) {
        const a = -Math.PI / 2 + (rnd() - 0.5) * 1.3, len = 3 + rnd() * 4;
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      }
      g.stroke();
    }
    g.lineCap = 'butt';
    // Pebbles: tiny, flat and dim.
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (!clear(x, y, 3)) continue;
      g.fillStyle = 'rgba(150,155,145,0.16)';
      g.beginPath();
      g.ellipse(x, y, 1 + rnd() * 1.8, 0.8 + rnd() * 1.2, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    // A few small flower clusters.
    const petals = ['rgba(235,225,150,0.55)', 'rgba(230,230,240,0.5)', 'rgba(190,160,230,0.5)'];
    for (let i = 0; i < 14; i++) {
      const cx = rnd() * W, cy = rnd() * H, color = petals[Math.floor(rnd() * petals.length)];
      for (let k = 0, n = 3 + Math.floor(rnd() * 4); k < n; k++) {
        const x = cx + (rnd() - 0.5) * 18, y = cy + (rnd() - 0.5) * 14;
        if (!clear(x, y, 3)) continue;
        g.fillStyle = color;
        g.beginPath();
        g.arc(x, y, 0.9 + rnd() * 0.7, 0, Math.PI * 2);
        g.fill();
      }
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
    ['#1f4a2a', '#2f6b38', '#4c8f45'],   // pine green
    ['#24502c', '#3a7a3c', '#5c9e4c'],   // leafy green
    ['#2a4a26', '#456d2f', '#6b8f3c'],   // olive
  ];

  /**
   * Obstacles are drawn as a stand of trees seen from above. The dark
   * undergrowth fills the exact collision rect, so every solid pixel reads
   * as blocked; canopies overhang it by only a couple of units.
   */
  function drawObstacle(g, o) {
    const rnd = rectRng(o);
    // Ground shadow cast down-right, then undergrowth on the collision footprint.
    g.fillStyle = 'rgba(0,0,0,0.38)';
    roundRect(g, o.x + 4, o.y + 6, o.w, o.h, 8);
    g.fill();
    g.fillStyle = '#0a110c';
    roundRect(g, o.x, o.y, o.w, o.h, 6);
    g.fill();

    // Pack canopies on a jittered grid that covers the rect.
    const base = Math.max(11, Math.min(22, Math.min(o.w, o.h) / 2 + 2));
    const nx = Math.max(1, Math.round(o.w / (base * 1.45)));
    const ny = Math.max(1, Math.round(o.h / (base * 1.45)));
    const trees = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const r = base * (0.82 + rnd() * 0.3);
      const slack = 2; // max overhang beyond the collision rect
      const cx = o.x + (i + 0.5) * o.w / nx + (rnd() - 0.5) * base * 0.5;
      const cy = o.y + (j + 0.5) * o.h / ny + (rnd() - 0.5) * base * 0.5;
      trees.push({
        x: Math.max(o.x + r - slack, Math.min(o.x + o.w - r + slack, cx)),
        y: Math.max(o.y + r - slack, Math.min(o.y + o.h - r + slack, cy)),
        r: Math.min(r, o.w / 2 + slack, o.h / 2 + slack),
        palette: CANOPY[Math.floor(rnd() * CANOPY.length)],
        lobes: 5 + Math.floor(rnd() * 3),
        spin: rnd() * Math.PI * 2,
      });
    }
    trees.sort((a, b) => a.y - b.y); // lower trees overlap the ones behind them

    for (const t of trees) {
      // Soft shadow on the undergrowth.
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(t.x + t.r * 0.18, t.y + t.r * 0.25, t.r, 0, Math.PI * 2);
      g.fill();
      // Lobed canopy: a ring of overlapping puffs around a core.
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
      puffs(0.45, -t.r * 0.22, -t.r * 0.26, light);
      // Highlight glint.
      g.fillStyle = 'rgba(255,255,220,0.10)';
      g.beginPath();
      g.arc(t.x - t.r * 0.3, t.y - t.r * 0.35, t.r * 0.18, 0, Math.PI * 2);
      g.fill();
    }
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

  /** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
  function shade(hex, amt) {
    const c = rgb(hex).map((v) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  BB.Renderer = Renderer;
})(globalThis.BB = globalThis.BB || {});
