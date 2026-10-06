/*
 * renderer.js — Draws a World onto a <canvas>. Read-only with respect to
 * the simulation; owns only short-lived visual effects (particles).
 */
(function (BB) {
  'use strict';

  const C = BB.CONFIG;
  const DEG = Math.PI / 180;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.effects = [];
      this.showScans = true;
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = C.ARENA_W * dpr;
      this.canvas.height = C.ARENA_H * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    addEvents(events) {
      for (const e of events) {
        if (e.type === 'hit') this.effects.push({ kind: 'ring', x: e.x, y: e.y, r: 4, max: 18, color: '#fff', life: 12 });
        else if (e.type === 'spark') this.effects.push({ kind: 'ring', x: e.x, y: e.y, r: 2, max: 8, color: '#999', life: 8 });
        else if (e.type === 'explode') this.effects.push({ kind: 'boom', x: e.x, y: e.y, r: 6, max: 60, color: e.color, life: 40 });
        else if (e.type === 'bump') this.effects.push({ kind: 'ring', x: e.x, y: e.y, r: 4, max: 14, color: '#ffcc80', life: 8 });
      }
      if (this.effects.length > 120) this.effects.splice(0, this.effects.length - 120);
    }

    draw(world, selectedEntryId) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, C.ARENA_W, C.ARENA_H);
      this.drawFloor(ctx);
      if (!world) return;

      for (const o of world.obstacles) {
        ctx.fillStyle = '#3a4150';
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = '#5b6578';
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
      }

      for (const r of world.robots) if (!r.alive) this.drawWreck(ctx, r);
      if (this.showScans) for (const r of world.robots) if (r.alive) this.drawScan(ctx, r, world.tick);
      for (const p of world.projectiles) this.drawProjectile(ctx, p);
      for (const r of world.robots) if (r.alive) this.drawRobot(ctx, r, r.entryId === selectedEntryId);
      this.drawEffects(ctx);

      if (world.over) this.drawBanner(ctx, world);
    }

    drawFloor(ctx) {
      ctx.fillStyle = '#161a22';
      ctx.fillRect(0, 0, C.ARENA_W, C.ARENA_H);
      ctx.strokeStyle = '#1f2430';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 50; x < C.ARENA_W; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, C.ARENA_H); }
      for (let y = 50; y < C.ARENA_H; y += 50) { ctx.moveTo(0, y); ctx.lineTo(C.ARENA_W, y); }
      ctx.stroke();
      ctx.strokeStyle = '#e0e6f0';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, C.ARENA_W - 4, C.ARENA_H - 4);
    }

    drawScan(ctx, r, tick) {
      const s = r.lastScanFx;
      if (!s || tick - s.tick > 1) return;
      const reach = 260;
      ctx.fillStyle = s.found ? hexA(r.color, 0.16) : hexA(r.color, 0.07);
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.arc(r.x, r.y, reach, (s.angle - s.width / 2) * DEG, (s.angle + s.width / 2) * DEG);
      ctx.closePath();
      ctx.fill();
    }

    drawRobot(ctx, r, selected) {
      const R = C.ROBOT_RADIUS;
      ctx.save();
      ctx.translate(r.x, r.y);

      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, R + 7, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }

      // body + heading wedge
      ctx.rotate(r.heading * DEG);
      ctx.fillStyle = r.color;
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.moveTo(R - 2, 0); ctx.lineTo(R - 10, -6); ctx.lineTo(R - 10, 6); ctx.closePath(); ctx.fill();
      ctx.rotate(-r.heading * DEG);

      // turret
      ctx.rotate(r.turret * DEG);
      ctx.fillStyle = '#20242e';
      ctx.fillRect(0, -3, R + 6, 6);
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // name + health bar
      const w = 44, hp = Math.max(0, r.health / C.MAX_HEALTH);
      const bx = r.x - w / 2, by = r.y - R - 14;
      ctx.fillStyle = '#000a';
      ctx.fillRect(bx, by, w, 5);
      ctx.fillStyle = hp > 0.5 ? '#66d17a' : hp > 0.25 ? '#ffc94d' : '#ff5a5a';
      ctx.fillRect(bx, by, w * hp, 5);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8ecf3';
      ctx.fillText(r.name + (r.vm.fault ? ' ⚠' : ''), r.x, by - 4);
    }

    drawWreck(ctx, r) {
      const R = C.ROBOT_RADIUS;
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.fillStyle = '#2b2f38';
      ctx.beginPath(); ctx.arc(0, 0, R - 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#555c6b';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-7, -7); ctx.lineTo(7, 7); ctx.moveTo(7, -7); ctx.lineTo(-7, 7); ctx.stroke();
      ctx.restore();
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6b7385';
      ctx.fillText(r.name, r.x, r.y - R - 6);
    }

    drawProjectile(ctx, p) {
      ctx.strokeStyle = hexA(p.color, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x - p.vx * 1.2, p.y - p.vy * 1.2); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }

    drawEffects(ctx) {
      const keep = [];
      for (const e of this.effects) {
        const t = 1 - e.life / (e.total || (e.total = e.life));
        const radius = e.r + (e.max - e.r) * t;
        ctx.globalAlpha = Math.max(0, 1 - t);
        if (e.kind === 'boom') {
          ctx.fillStyle = e.color;
          ctx.beginPath(); ctx.arc(e.x, e.y, radius * 0.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = e.kind === 'boom' ? '#fff' : e.color;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y, radius, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        if (--e.life > 0) keep.push(e);
      }
      this.effects = keep;
    }

    drawBanner(ctx, world) {
      const text = world.winner ? `${world.winner.name} wins!` : 'Draw!';
      ctx.fillStyle = 'rgba(10,12,18,0.72)';
      ctx.fillRect(0, C.ARENA_H / 2 - 44, C.ARENA_W, 88);
      ctx.textAlign = 'center';
      ctx.font = '700 36px system-ui, sans-serif';
      ctx.fillStyle = world.winner ? world.winner.color : '#e8ecf3';
      ctx.fillText(text, C.ARENA_W / 2, C.ARENA_H / 2 + 6);
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = '#aab2c2';
      ctx.fillText(`tick ${world.tick} · press Reset for a rematch`, C.ARENA_W / 2, C.ARENA_H / 2 + 30);
    }
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  BB.Renderer = Renderer;
})(globalThis.BB = globalThis.BB || {});
