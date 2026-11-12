// @ts-check
/* One pixel tree per plan. 100 leaf slots: 1 leaf = 1% of quota left.
 * Used quota lies on the ground as a leaf pile. When usage rises, leaves fall into the pile;
 * when a window resets, the pile clears and leaves grow back. */
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const W = 112, H = 112, GROUND = H - 16, CX = W / 2, LEAVES = 100, FPS = 12;

  const PALETTES = {
    claude: { leaf: ['#ffd2ad', '#f0895a', '#c25a32', '#7c3318'], bark: ['#a87650', '#7f5434', '#55361f'] },
    codex: { leaf: ['#c9f7a6', '#6fca4f', '#379440', '#1c5a29'], bark: ['#938676', '#6e6458', '#473f37'] },
    other: { leaf: ['#bfe3ff', '#5aa7e8', '#2f6fb3', '#1a3f6e'], bark: ['#8a7f9e', '#665d78', '#433d50'] },
  };
  const WILT = ['#f3d98a', '#c9a347', '#8f6f2a', '#5a4418'];
  const FLASH = '#fffbe0';
  const pal = (id) => PALETTES[id] || PALETTES.other;

  // ---------- deterministic randomness ----------
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rngFor = (k) => mulberry(hash(k));
  /** @param {CanvasRenderingContext2D} c */
  function px(c, x, y, color) {
    c.fillStyle = color;
    c.fillRect(Math.round(x), Math.round(y), 1, 1);
  }
  function offscreen() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return { canvas: c, ctx: /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')) };
  }

  // ---------- tree + slots ----------
  function buildTree(seed, palette) {
    const { canvas, ctx: c } = offscreen();
    /** @type {{x:number,y:number}[]} */
    const tips = [];
    const maxDepth = 4;
    const bark = palette.bark;

    function branch(path, x, y, ang, len, w, depth) {
      const r = rngFor(seed + path);
      const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
      const w1 = Math.max(1, w * 0.66);
      const steps = Math.ceil(Math.max(Math.abs(ex - x), Math.abs(ey - y))) * 2 + 1;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const cx = x + (ex - x) * t, cy = y + (ey - y) * t;
        const rad = (w + (w1 - w) * t) / 2;
        const ir = Math.max(0, Math.ceil(rad) - 1);
        for (let oy = -ir; oy <= ir; oy++)
          for (let ox = -ir; ox <= ir; ox++) {
            if (ox * ox + oy * oy > rad * rad + 0.5) continue;
            const f = (ox + ir + 0.5) / (2 * ir + 1);
            px(c, cx + ox, cy + oy, bark[ir === 0 ? 1 : f < 0.3 ? 0 : f > 0.7 ? 2 : 1]);
          }
      }
      if (depth >= maxDepth) {
        tips.push({ x: ex, y: ey });
        return;
      }
      if (depth >= 2) tips.push({ x: ex, y: ey });
      const n = 2 + (r() < 0.35 ? 1 : 0);
      const spread = 0.45 + r() * 0.2;
      for (let i = 0; i < n; i++) {
        let a = ang + (i - (n - 1) / 2) * spread + (r() - 0.5) * 0.3;
        a = a * 0.8 + (-Math.PI / 2) * 0.2;
        a = Math.max(-Math.PI + 0.3, Math.min(-0.3, a));
        branch(path + i, ex, ey, a, len * (0.64 + r() * 0.1), w1, depth + 1);
      }
    }
    // roots
    for (let s = -1; s <= 1; s += 2)
      for (let i = 0; i < 7; i++) {
        px(c, CX + s * (2 + i), GROUND - 1 + (i > 4 ? 1 : 0), bark[i % 3 ? 1 : 0]);
        if (i < 5) px(c, CX + s * (2 + i), GROUND, bark[2]);
      }
    branch('t', CX, GROUND, -Math.PI / 2 + (rngFor(seed + 'lean')() - 0.5) * 0.1, 26, 6, 0);

    // Exactly LEAVES slots on a 3px grid around the tips; widen the radius until they fit.
    /** @type {Map<string,{x:number,y:number}>} */
    const slots = new Map();
    const r = rngFor(seed + 'slots');
    let radius = 6;
    for (let tries = 0; slots.size < LEAVES && tries < 20000; tries++) {
      if (tries > 0 && tries % 2000 === 0) radius += 1.5;
      const tip = tips[tries % tips.length];
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius;
      const x = Math.round((tip.x + Math.cos(a) * d) / 3) * 3;
      const y = Math.round((tip.y + Math.sin(a) * d * 0.8) / 3) * 3;
      if (x < 1 || x > W - 4 || y < 2 || y > GROUND - 8) continue;
      slots.set(x + ',' + y, { x, y });
    }
    const arr = [...slots.values()];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return { layer: canvas, slots: arr };
  }

  /** Leaf-pile positions: a mound on either side of the trunk, filled bottom-up, centre-out. */
  function buildPile(seed) {
    const r = rngFor(seed + 'pile');
    /** @type {{x:number,y:number}[]} */
    const out = [];
    for (let row = 0; out.length < LEAVES && row < 20; row++) {
      const half = Math.max(5, 30 - row * 4);
      const row_ = [];
      for (let dx = 5; dx <= half; dx += 2) {
        row_.push({ x: CX - dx - 1, y: GROUND - 1 - row * 2 });
        row_.push({ x: CX + dx, y: GROUND - 1 - row * 2 });
      }
      row_.sort((a, b) => Math.abs(a.x - CX) - Math.abs(b.x - CX) + (r() - 0.5) * 6);
      out.push(...row_);
    }
    return out.slice(0, LEAVES);
  }

  // ---------- background ----------
  /** @type {Record<number, HTMLCanvasElement>} */
  const bgCache = {};
  function skyFor(hour) {
    if (hour >= 7 && hour < 17) return { bands: ['#5fb6f0', '#74c3f4', '#8cd0f7', '#a6dcf9', '#c3e8fb'], night: false };
    if ((hour >= 17 && hour < 19) || (hour >= 5 && hour < 7))
      return { bands: ['#3b3f78', '#6b4f8f', '#b0618b', '#e8846f', '#f7b779'], night: false };
    return { bands: ['#0d1330', '#141c42', '#1b2552', '#233063', '#2c3b72'], night: true };
  }
  function background(hour) {
    if (bgCache[hour]) return bgCache[hour];
    const { canvas, ctx: c } = offscreen();
    const sky = skyFor(hour);
    const bandH = Math.ceil(GROUND / sky.bands.length);
    sky.bands.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect(0, i * bandH, W, bandH + 1);
      if (i > 0) {
        c.fillStyle = sky.bands[i - 1];
        for (let x = i % 2; x < W; x += 2) c.fillRect(x, i * bandH, 1, 1);
      }
    });
    const r = rngFor('stars');
    if (sky.night) for (let i = 0; i < 30; i++) px(c, r() * W, r() * (GROUND - 25), r() < 0.2 ? '#fff6c8' : '#9aa6d8');
    for (let y = -5; y <= 5; y++)
      for (let x = -5; x <= 5; x++) {
        const d = x * x + y * y;
        if (d > 25) continue;
        if (!sky.night) px(c, 92 + x, 16 + y, d > 16 ? '#ffd76a' : '#fff1a8');
        else if ((x - 3) * (x - 3) + (y + 2) * (y + 2) >= 20) px(c, 92 + x, 16 + y, d > 16 ? '#c9cfe8' : '#eef0ff');
      }
    const hill = sky.night ? '#1c2a3a' : '#7fb38a';
    c.fillStyle = hill;
    for (let x = 0; x < W; x++) {
      const h = Math.round(5 + Math.sin(x / 11 + 1) * 2.5 + Math.sin(x / 4) * 1);
      c.fillRect(x, GROUND - h, 1, h);
    }
    const grass = sky.night ? ['#2d5a32', '#234a29', '#1b3a20'] : ['#79c850', '#5aa83c', '#3f8a2e'];
    const dirt = sky.night ? ['#3a2a1e', '#2e2117'] : ['#8a5f3b', '#6e4a2d'];
    c.fillStyle = grass[1];
    c.fillRect(0, GROUND + 1, W, 3);
    c.fillStyle = grass[2];
    c.fillRect(0, GROUND + 3, W, 1);
    c.fillStyle = dirt[0];
    c.fillRect(0, GROUND + 4, W, H);
    for (let x = 0; x < W; x++) {
      if (r() < 0.45) px(c, x, GROUND, grass[0]);
      if (r() < 0.12) px(c, x, GROUND - 1, grass[0]);
    }
    for (let i = 0; i < 40; i++) px(c, r() * W, GROUND + 5 + r() * 10, dirt[1]);
    return (bgCache[hour] = canvas);
  }

  // ---------- sprites ----------
  function drawLeaf(c, x, y, col, flash) {
    if (flash >= 1) {
      px(c, x + 1, y + 1, FLASH);
      return;
    }
    const f = flash > 0;
    px(c, x + 1, y, f ? FLASH : col[0]);
    px(c, x + 2, y, col[1]);
    px(c, x, y + 1, f ? FLASH : col[0]);
    px(c, x + 1, y + 1, col[1]);
    px(c, x + 2, y + 1, col[2]);
    px(c, x, y + 2, col[1]);
    px(c, x + 1, y + 2, col[2]);
    px(c, x + 2, y + 2, col[3]);
  }
  function drawPileLeaf(c, x, y, col, i) {
    px(c, x, y, col[i % 3 === 0 ? 0 : 1]);
    px(c, x + 1, y, col[1]);
    px(c, x, y + 1, col[2]);
    px(c, x + 1, y + 1, col[i % 2 ? 2 : 3]);
  }

  // ---------- per-plan tree state ----------
  /** @type {Map<string, any>} */
  const trees = new Map();

  function makeTree(plan, container) {
    const p = pal(plan.id);
    const t = {
      id: plan.id,
      palette: p,
      ...buildTree(plan.id, p),
      pile: buildPile(plan.id),
      canvas: /** @type {HTMLCanvasElement} */ (document.createElement('canvas')),
      /** born time per leaf index, or 0 when absent */
      born: new Array(LEAVES).fill(0),
      count: -1, // leaves currently on the tree
      settled: 0, // leaves resting in the pile
      falling: /** @type {any[]} */ ([]),
      left: null,
      el: container,
    };
    t.canvas.width = W;
    t.canvas.height = H;
    t.ctx = t.canvas.getContext('2d');
    t.canvas.title = 'Click to refresh';
    t.canvas.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    return t;
  }

  function setLeft(t, leftPercent) {
    const now = performance.now();
    const n = leftPercent === null ? 0 : Math.max(0, Math.min(LEAVES, Math.round(leftPercent)));
    t.left = leftPercent;
    if (t.count < 0) {
      // first paint: grow leaves in, pile already there
      for (let k = 0; k < n; k++) t.born[k] = now + k * 12;
      t.count = n;
      t.settled = leftPercent === null ? 0 : LEAVES - n;
      return;
    }
    if (n < t.count) {
      for (let k = n; k < t.count; k++) {
        const s = t.slots[k];
        const target = t.pile[LEAVES - 1 - k] || { x: CX, y: GROUND };
        t.falling.push({ x: s.x + 1, y: s.y + 1, tx: target.x, ty: target.y, phase: Math.random() * 6, delay: now + (t.count - k) * 40 });
        t.born[k] = 0;
      }
    } else if (n > t.count) {
      // window reset (or usage dropped): pile clears, leaves grow back
      t.falling = [];
      t.settled = LEAVES - n;
      for (let k = t.count; k < n; k++) t.born[k] = now + (k - t.count) * 25;
    }
    t.count = n;
  }

  function drawTree(t, now, sec, dt) {
    const c = t.ctx;
    c.drawImage(background(new Date().getHours()), 0, 0);
    c.drawImage(t.layer, 0, 0);
    const wilt = t.left !== null && t.left <= 20;
    const col = wilt ? WILT : t.palette.leaf;

    for (let i = 0; i < Math.min(t.settled, t.pile.length); i++) drawPileLeaf(c, t.pile[i].x, t.pile[i].y, t.palette.leaf, i);

    const gust = Math.sin(sec * 0.7) > 0.6;
    for (let k = 0; k < t.count; k++) {
      const b = t.born[k];
      if (!b || now < b) continue;
      const s = t.slots[k];
      const age = (now - b) / 1000;
      const flash = age < 0.3 ? 1 : age < 1.5 && Math.floor(age * 4) % 2 === 0 ? 0.5 : 0;
      const sway = gust && Math.sin(sec * 3 + s.y * 0.3 + s.x * 0.1) > 0.3 ? 1 : 0;
      drawLeaf(c, s.x + sway, s.y, col, flash);
    }

    t.falling = t.falling.filter((f) => {
      if (now < f.delay) {
        // still attached: keep drawing it on the branch until it lets go
        drawLeaf(c, f.x - 1, f.y - 1, col, 0);
        return true;
      }
      f.phase += 0.35 * dt;
      f.y += 1.4 * dt;
      f.x += (f.tx - f.x) * Math.min(1, 0.07 * dt) + Math.sin(f.phase) * 0.6;
      if (f.y >= f.ty) {
        t.settled++;
        return false;
      }
      px(c, f.x, f.y, col[1]);
      px(c, f.x + 1, f.y, col[2]);
      return true;
    });
  }

  // ---------- DOM ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'style') Object.assign(el.style, v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  function until(ms) {
    const d = Math.max(0, ms - Date.now());
    const hh = Math.floor(d / 3600000), mm = Math.floor((d % 3600000) / 60000);
    if (hh >= 48) return Math.round(hh / 24) + 'd';
    return hh ? `${hh}h ${mm}m` : `${mm}m`;
  }
  function bar(leftPct) {
    const segs = 20, filled = Math.round((leftPct / 100) * segs);
    const color = leftPct <= 10 ? 'var(--q-red)' : leftPct <= 30 ? 'var(--q-yellow)' : 'var(--q-green)';
    return h('div', { class: 'bar' }, Array.from({ length: segs }, (_, i) => h('i', i < filled ? { style: { background: color } } : {})));
  }

  const root = /** @type {HTMLElement} */ (document.getElementById('plans'));

  function render(plans) {
    if (!plans.length) {
      root.replaceChildren(h('div', { class: 'empty' }, 'No logged-in Claude Code or Codex account found. Log in to either CLI and refresh.'));
      trees.clear();
      return;
    }
    const seen = new Set();
    const cards = plans.map((plan) => {
      seen.add(plan.id);
      let t = trees.get(plan.id);
      if (!t) {
        t = makeTree(plan, null);
        trees.set(plan.id, t);
      }
      setLeft(t, plan.leftPercent);
      const binding = plan.limits.find((l) => l.id === plan.bindingId);
      const badge = plan.state === 'ok' ? 'LIVE' : plan.state === 'stale' ? 'STALE' : 'ERROR';
      return h('section', { class: 'plan' },
        h('div', { class: 'hdr' },
          h('span', { class: 'sw', style: { background: t.palette.leaf[1], boxShadow: `2px 2px 0 ${t.palette.leaf[3]}` } }),
          `${plan.provider} · ${plan.plan}`,
          h('span', { class: 'badge ' + plan.state }, badge)),
        h('div', { class: 'stage' }, t.canvas),
        h('div', { class: 'big' },
          plan.leftPercent === null
            ? 'No quota data'
            : [h('b', {}, String(Math.round(plan.leftPercent))), ' leaves left'],
          binding ? h('span', { class: 'dim' }, ` · ${binding.label} limit${binding.resetsAt ? ', regrows in ' + until(binding.resetsAt) : ''}`) : ''),
        plan.limits.map((l) => {
          const left = 100 - l.usedPercent;
          return h('div', { class: 'limit' + (l.id === plan.bindingId ? ' binding' : '') },
            h('div', { class: 'row' }, h('span', {}, l.label.toUpperCase()), h('b', {}, `${Math.round(left)}% left`)),
            bar(left),
            l.resetsAt ? h('div', { class: 'dim small' }, 'resets in ' + until(l.resetsAt)) : null);
        }),
        plan.message ? h('div', { class: 'msg small' }, plan.message) : null);
    });
    for (const id of [...trees.keys()]) if (!seen.has(id)) trees.delete(id);
    root.replaceChildren(...cards);
    fit();
    const up = document.getElementById('updated');
    if (up) up.textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  function fit() {
    for (const t of trees.values()) {
      const stage = t.canvas.parentElement;
      if (!stage) continue;
      const scale = Math.max(1, Math.floor(stage.clientWidth / W));
      t.canvas.style.width = W * scale + 'px';
      t.canvas.style.height = H * scale + 'px';
    }
  }
  new ResizeObserver(fit).observe(document.body);

  let last = 0;
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    if (now - last < 1000 / FPS) return;
    const dt = last ? Math.min(30, (now - last) / (1000 / FPS)) : 1; // frames elapsed, so motion is time-based
    last = now;
    for (const t of trees.values()) drawTree(t, now, now / 1000, dt);
  }
  requestAnimationFrame(frame);

  document.getElementById('refresh')?.addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'refresh' });
  });
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'update') render(e.data.plans);
  });
  vscode.postMessage({ type: 'ready' });
})();
