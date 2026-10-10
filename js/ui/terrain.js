/*
 * terrain.js — Static arena art: the ground, mud, tree stands and battle
 * scars, all drawn once onto offscreen layers by the renderer. Purely
 * cosmetic: shapes come from fixed hashes of each rect or seed, so a map
 * always looks the same, and nothing here touches the simulation.
 */
(function (BB) {
  'use strict';

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

  BB.terrain = { drawGround, drawMud, drawObstacle, drawScar, fireFlicker };
})(globalThis.BB = globalThis.BB || {});
