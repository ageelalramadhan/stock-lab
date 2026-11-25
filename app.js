/* Stock Lab, version 4: light, friendly, self-explaining.
   Every bubble is a company. Its ring blinks green if the price went up, red if it went down.
   Closer to the edge = a better chance to be worth more next month.
   data/cell.js       : all companies, chances, the day's story, the honesty test
   data/stocks/SYM.js : one company's detail, loaded when you tap it */
(function () {
  "use strict";
  const CELL = window.CELL;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY_NAME = "stocklab_finnhub_key";
  if (!CELL || !CELL.cells || !CELL.odds) { $("#cell-lead").textContent = "No data yet. It arrives with the next nightly run."; return; }

  const O = CELL.odds, TD = CELL.today || {};
  const all = CELL.cells, bySym = Object.fromEntries(all.map((c) => [c.s, c]));
  const cos = all.filter((c) => c.p != null && c.sec !== "Benchmark");
  const details = (window.STOCK_DETAIL = window.STOCK_DETAIL || {});
  const live = {};
  $("#sym-list").innerHTML = all.map((c) => `<option value="${esc(c.s)}">${esc(c.n)}</option>`).join("");
  const UP = css("--up"), DOWN = css("--down"), FLAT = "#a3a8b0", INK = css("--text-primary");
  const SURF = css("--surface-1"), BG = css("--bg"), MUTED = css("--text-muted"), SEC = css("--text-secondary"), LINE = css("--border");

  // ---------- words ----------
  const n100 = (x) => Math.round(x * 100);
  const pct = (x, d = 1) => (x == null ? "n/a" : (x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
  const money = (x) => (x == null ? "n/a" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const went = (x, d = 0) => (x == null ? "did not trade" : Math.abs(x) < 0.0005 ? "stayed the same" : "went " + (x > 0 ? "up " : "down ") + (Math.abs(x) * 100).toFixed(d) + "%");
  const dayName = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "the last day");
  const lean = (p) => (p >= 0.6 ? "Probably more" : p >= 0.55 ? "A little more likely than not" : p > 0.45 ? "About a coin flip" : p > 0.4 ? "A little less likely than not" : "Probably less");
  const price = (c) => (live[c.s] && live[c.s].price) || c.px;
  // the time period the cell and the signal line show. key, button, data field, longest line (as a change), words, short label
  const PERIODS = [
    ["day", "1 day", "d1", 0.06, "on the last trading day", "last day"], ["week", "5 days", "w1", 0.1, "over the last 5 trading days", "last 5 days"],
    ["month", "1 month", "c1m", 0.2, "over the last month", "last month"], ["half", "6 months", "c6m", 0.4, "over the last 6 months", "last 6 months"],
    ["ytd", "This year", "ytd", 0.5, "since 1 January", "this year"], ["year", "1 year", "c1y", 0.6, "over the last year", "last year"],
    ["five", "5 years", "c5y", 2, "over the last 5 years", "last 5 years"], ["max", "Max", "mx", 4, "in all the history we store", "all history"],
  ];
  let PER = PERIODS[0];
  const dayMove = (c) => {   // the company's change for the chosen period. A live price, if one has arrived, replaces last night's price.
    const l = live[c.s];
    if (PER[2] === "d1") return l && l.price && l.prevClose ? l.price / l.prevClose - 1 : c.d1;
    const base = c[PER[2]];
    return base == null || !l || !l.price || !c.px ? base : (1 + base) * (l.price / c.px) - 1;
  };
  // gliding from one time period to the next: every line and ring travels from its old real value to its new real value
  const glide = { t0: -1e9, dur: 700, from: {} };
  const norm = (c) => { const mv = dayMove(c); return mv == null ? null : Math.max(-1, Math.min(1, mv / PER[3])); };
  const shown = (c, now) => {
    const target = norm(c), k = (now - glide.t0) / glide.dur, f = glide.from[c.s];
    if (k >= 1 || f == null || target == null) return target;
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    return f + (target - f) * e;
  };
  const dayCol = (x) => (x == null || Math.abs(x) < 0.002 ? FLAT : x > 0 ? UP : DOWN);
  const chip = (x, label) => `<span class="chip ${x == null || Math.abs(x) < 0.002 ? "flat" : x > 0 ? "up" : "down"}">${x == null || Math.abs(x) < 0.002 ? "=" : x > 0 ? "+" : "−"} ${label || (Math.abs(x || 0) * 100).toFixed(1) + "%"}</span>`;

  // ---------- logos ----------
  const imgs = {};
  function logo(c) {
    if (!c.lg) return null;
    let im = imgs[c.s];
    if (!im) { im = imgs[c.s] = new Image(); im.onerror = () => { im.bad = true; }; im.src = c.lg; }
    return im.complete && !im.bad && im.naturalWidth ? im : null;
  }

  // ---------- where each bubble goes ----------
  const ps = cos.map((c) => c.p).sort((a, b) => a - b);
  const q = (f) => ps[Math.min(ps.length - 1, Math.floor(f * ps.length))];
  const P_LO = Math.min(q(0.02), 0.47), P_HI = Math.max(q(0.98), 0.53), P_MID = q(0.5);
  const span = Math.max(P_HI - 0.5, 0.5 - P_LO);

  const canvas = $("#cell"), ctx = canvas.getContext("2d");
  let W = 0, R = 0, CX = 0, CY = 0, selected = null, hover = null;
  const secs = d3.groups(cos, (c) => c.sec).map(([name, list]) => ({
    name, list: list.slice().sort((a, b) => a.s.localeCompare(b.s)),
    p: d3.mean(list, (c) => c.p), vp: d3.mean(list, (c) => c.vp ?? 0.5),
  })).sort((a, b) => a.name.localeCompare(b.name));
  // Facts only. A bubble's size is the money that changed hands in that company on the last day.
  const moneyDay = (c) => c.dv * (c.tvx || 1);
  secs.forEach((s) => {
    const usual = d3.sum(s.list, (c) => c.dv) || 1;
    s.ratio = d3.sum(s.list, moneyDay) / usual;   // last day's trading compared with a usual day
    s.word = s.ratio >= 1.15 ? "busier than usual" : s.ratio <= 0.87 ? "quieter than usual" : "a usual day";
    s.ups = s.list.filter((c) => (c.d1 || 0) > 0).length;
    s.downs = s.list.filter((c) => (c.d1 || 0) < 0).length;
    s.known = s.list.filter((c) => c.d1 != null).length;
    s.ticks = []; s.pulse = 0; s.dir = 0; s.flip = 0;
  });
  const GAP = 0.035, total = cos.length;
  let a0 = -Math.PI / 2;
  secs.forEach((s) => { s.a0 = a0; s.a1 = a0 + (s.list.length / total) * (Math.PI * 2 - GAP * secs.length); s.mid = (s.a0 + s.a1) / 2; a0 = s.a1 + GAP; });
  const maxDv = d3.max(cos, moneyDay) || 1;
  const nodes = [];
  secs.forEach((s) => s.list.forEach((c, i) => nodes.push({ c, sec: s, ang: s.a0 + ((i + 0.5) / s.list.length) * (s.a1 - s.a0), rr: 0, ph: Math.random() * 6.28 })));
  const nodeOf = Object.fromEntries(nodes.map((n) => [n.c.s, n]));
  const rOf = (p) => R * (0.2 + 0.68 * Math.max(0, Math.min(1, (p - P_LO) / (P_HI - P_LO))));

  const hasKey = () => { try { return !!localStorage.getItem(KEY_NAME); } catch (e) { return false; } };
  let hoverSec = null;
  function layout() {
    const wrap = $("#cell-wrap"), bw = wrap.getBoundingClientRect().width;
    if (!bw) return;
    const dpr = window.devicePixelRatio || 1, box = { width: bw };
    W = bw; CX = bw / 2; CY = bw / 2;      // start square; the height is trimmed to fit at the end
    const half = bw / 2;
    const place = (r) => {
      R = r;
      const rs = d3.scaleSqrt().domain([0, maxDv]).range([3.5, R * 0.1]);   // area grows with the money traded
      nodes.forEach((n) => {
        n.rr = rs(moneyDay(n.c));
        n.tx = CX + Math.cos(n.ang) * rOf(n.c.p); n.ty = CY + Math.sin(n.ang) * rOf(n.c.p);
        n.x = n.tx; n.y = n.ty;
      });
      const sim = d3.forceSimulation(nodes).force("x", d3.forceX((n) => n.tx).strength(0.3)).force("y", d3.forceY((n) => n.ty).strength(0.3))
        .force("hit", d3.forceCollide((n) => n.rr + 1.5).iterations(2)).stop();
      for (let i = 0; i < 200; i++) sim.tick();
      // the edge of each group sits just outside its outermost bubble
      secs.forEach((s) => { s.edge = 0; });
      nodes.forEach((n) => { n.sec.edge = Math.max(n.sec.edge, Math.hypot(n.x - CX, n.y - CY) + n.rr + 8); });
      // beat lines as they will be drawn: sample points along each one
      const pts = [];
      nodes.forEach((n) => {
        const r0 = edgeAt(n.ang, 0) + 4, len = 2 + R * 0.085 + 10;   // the longest a line can get, so names never cover a line in any period   // +10: room for a live flash
        for (let k = 0; k <= 4; k++) pts.push([CX + Math.cos(n.ang) * (r0 + len * k / 4), CY + Math.sin(n.ang) * (r0 + len * k / 4)]);
      });
      let needX = 0, needY = 0;
      const placed = [];
      secs.forEach((s) => {
        s.sub = `${s.ups} of ${s.known} went up`;
        const words = s.name.split(" ");
        s.lines = words.length > 1 && s.name.length > 13 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [s.name];
        ctx.font = "700 13px " + FONT;
        s.lw = Math.max(...s.lines.map((ln) => ctx.measureText(ln).width), ctx.measureText(s.sub).width * 0.93) + 18;
        s.liveLine = hasKey();
        if (s.liveLine) s.lw = Math.max(s.lw, ctx.measureText("00 new this minute").width * 0.93 + 18);
        s.lw = Math.max(s.lw, ctx.measureText(`${s.list.length} of ${s.list.length} went down`).width * 0.93 + 34);
        s.lh = s.lines.length * 15 + 37 + (s.liveLine ? 15 : 0);
        // start just outside the edge and step outward until the box covers nothing
        let lr = s.edge + 10;
        for (let i = 0; i < 120; i++, lr += 3) {
          s.lx = CX + Math.cos(s.mid) * lr; s.ly = CY + Math.sin(s.mid) * lr;
          const x0 = s.lx - s.lw / 2 - 5, x1 = s.lx + s.lw / 2 + 5, y0 = s.ly - s.lh / 2 - 5, y1 = s.ly + s.lh / 2 + 5;
          if (!pts.some((q) => q[0] > x0 && q[0] < x1 && q[1] > y0 && q[1] < y1)
            && !placed.some((o) => x0 < o[1] && x1 > o[0] && y0 < o[3] && y1 > o[2])) break;   // also clear of the other labels
        }
        placed.push([s.lx - s.lw / 2, s.lx + s.lw / 2, s.ly - s.lh / 2, s.ly + s.lh / 2]);
        needX = Math.max(needX, Math.abs(s.lx - CX) + s.lw / 2 + 4);
        needY = Math.max(needY, Math.abs(s.ly - CY) + s.lh / 2 + 4);
      });
      return [needX, needY];   // how far the picture reaches from its middle, labels included
    };
    // size the cell so that the labels just fit inside the picture
    // labels keep their size while the cell grows, so the reach is roughly "a x radius + b": measure twice and solve
    const reach = (r) => Math.max(...place(r));
    const r1 = half * 0.55, r2 = half * 0.75, n1 = reach(r1), n2 = reach(r2);
    const a = Math.max(0.5, (n2 - n1) / (r2 - r1)), b = n2 - a * r2;
    let r = Math.max(60, (half - b) / a);
    for (let i = 0; i < 4 && reach(r) > half; i++) r *= 0.97;
    // trim the empty space above and below, then place everything one last time
    W = Math.min(bw, Math.ceil(place(r)[1] * 2 + 8)); CY = W / 2;
    wrap.style.aspectRatio = "auto"; wrap.style.height = W + "px";
    canvas.width = bw * dpr; canvas.height = W * dpr; canvas.style.height = W + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    place(r);
    nodes.sort((a, b) => a.rr - b.rr); // big bubbles drawn last, on top
  }

  // the wobbly edge: pushed out where a group of companies has a better chance, shakier where prices jump more
  function edgeAt(a, t) {
    let k = secs.length - 1;
    for (let i = 0; i < secs.length; i++) if (a < secs[i].mid) { k = i - 1; break; }
    const s0 = secs[(k + secs.length) % secs.length], s1 = secs[(k + 1) % secs.length];
    let m0 = s0.mid, m1 = s1.mid;
    if (k < 0) m0 -= Math.PI * 2;
    if (k === secs.length - 1) m1 += Math.PI * 2;
    const u = (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, (a - m0) / (m1 - m0))))) / 2;
    const edge = s0.edge + (s1.edge - s0.edge) * u;
    return edge;   // drawn exactly where the data puts it, with no decorative motion
  }

  const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif';
  const pill = (x, y, w, h) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h); ctx.fill(); };
  const t0 = performance.now();
  function draw(now) {
    if (!$("#cell-view").hidden && R > 0) {
      const open = marketOpen(), t = open ? (now - t0) / 1000 : 0;   // nothing moves while the market is closed
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // the cell's body and its moving edge
      ctx.beginPath();
      for (let a = -Math.PI / 2, i = 0; a < Math.PI * 1.5; a += 0.02, i++) {
        const r = edgeAt(a, t), x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = SURF; ctx.fill();

      // the edge: green where most of that group went up, red where most went down
      secs.forEach((s) => {
        ctx.beginPath();
        for (let a = s.a0 - GAP / 2, i = 0; a <= s.a1 + GAP / 2 + 0.001; a += 0.02, i++) {
          const r = edgeAt(a, t), x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        const beat = s.pulse ? Math.max(0, 1 - (now - s.pulse) / 700) : 0, flip = s.flip ? Math.max(0, 1 - (now - s.flip) / 3000) : 0;
        s.beat = beat; s.flipNow = flip;
        ctx.strokeStyle = s.ups * 2 >= s.list.length ? UP : DOWN; ctx.lineWidth = 5 + beat * 4 + flip * 6 + (s === hoverSec ? 3 : 0); ctx.lineCap = "butt"; ctx.lineJoin = "round"; ctx.stroke();
      });

      // the beat: one line for every company, standing on the edge. Longer line = bigger move on the last day.
      const lw = Math.max(1.6, (Math.PI * 2 * R / total) * 0.62);
      nodes.forEach((n) => {
        const sh = shown(n.c, now), l = live[n.c.s];
        if (sh == null) return;
        const mv = sh * PER[3];
        const flash = l && l.pulse ? Math.max(0, 1 - (now - l.pulse) / 900) : 0;
        const r0 = edgeAt(n.ang, t) + 4, len = 2 + Math.abs(sh) * R * 0.085 + flash * 8;
        n.l0 = r0; n.l1 = r0 + len;   // remembered so the line can be hovered and clicked
        const cos = Math.cos(n.ang), sin = Math.sin(n.ang), mine = n === hover || n.c.s === selected;
        ctx.lineCap = "round";
        if (mine) { // a dark outline so you can see which line belongs to the chosen company
          ctx.strokeStyle = INK; ctx.lineWidth = lw + 5;
          ctx.beginPath(); ctx.moveTo(CX + cos * r0, CY + sin * r0); ctx.lineTo(CX + cos * (r0 + len + 3), CY + sin * (r0 + len + 3)); ctx.stroke();
        }
        ctx.strokeStyle = flash > 0 && l.dir ? (l.dir > 0 ? UP : DOWN) : dayCol(mv); ctx.lineWidth = mine ? lw + 1.5 : lw;
        ctx.beginPath(); ctx.moveTo(CX + cos * r0, CY + sin * r0);
        ctx.lineTo(CX + cos * (r0 + len + (mine ? 3 : 0)), CY + sin * (r0 + len + (mine ? 3 : 0))); ctx.stroke();
      });

      // rings: the same chance all the way round
      const ringLabels = [];
      ctx.textAlign = "center";
      for (let v = Math.ceil(P_LO * 20) / 20; v <= P_HI + 1e-9; v += 0.05) {
        const rr = rOf(v), half = Math.abs(v - 0.5) < 0.001;
        ctx.setLineDash(half ? [] : [4, 6]);
        ctx.strokeStyle = half ? MUTED : LINE; ctx.lineWidth = half ? 2 : 1.2;
        ctx.beginPath(); ctx.arc(CX, CY, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ringLabels.push([rr, half, half ? "coin flip: 50 out of 100" : n100(v) + " out of 100"]);
      }

      // slices: one for each kind of company
      secs.forEach((s) => {
        const a = s.a0 - GAP / 2;
        const far = Math.max(s.edge, secs[(secs.indexOf(s) + secs.length - 1) % secs.length].edge) + R * 0.085 + 6;
        ctx.strokeStyle = MUTED; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(CX + Math.cos(a) * R * 0.16, CY + Math.sin(a) * R * 0.16); ctx.lineTo(CX + Math.cos(a) * far, CY + Math.sin(a) * far); ctx.stroke();
        ctx.setLineDash([]);
        const x = s.lx, y = s.ly, w = s.lw, h = s.lh;
        ctx.textAlign = "center";
        const b = s.beat || 0, fl = s.flipNow || 0;
        ctx.fillStyle = SURF; ctx.strokeStyle = b > 0 && s.dir ? (s.dir > 0 ? UP : DOWN) : (s.ups * 2 >= s.list.length ? UP : DOWN);
        ctx.lineWidth = 2 + b * 3 + fl * 4 + (s === hoverSec ? 2 : 0);
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, 10); else ctx.rect(x - w / 2, y - h / 2, w, h); ctx.fill(); ctx.stroke();
        ctx.font = "700 13px " + FONT; ctx.fillStyle = INK;
        s.lines.forEach((ln, i) => ctx.fillText(ln, x, y - h / 2 + 17 + i * 15));
        ctx.font = "600 12px " + FONT; ctx.fillStyle = SEC;
        const yb = y + h / 2 - 8 - (s.liveLine ? 15 : 0);
        [[`${s.ups} of ${s.known} went up`, UP, yb - 15], [`${s.downs} of ${s.known} went down`, DOWN, yb]].forEach(([txt, col, ty]) => {
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x - tw / 2 - 7, ty - 4, 4, 0, Math.PI * 2); ctx.fill();   // a coloured dot in front of each count
          ctx.fillStyle = SEC; ctx.fillText(txt, x + 4, ty);
        });
        if (s.liveLine) {
          const k = s.ticks.length;
          ctx.fillStyle = k ? INK : MUTED;
          ctx.fillText(k ? `${k} new this minute` : "quiet right now", x, y + h / 2 - 8);
        }
      });

      // the companies
      const sel = nodeOf[selected];
      nodes.forEach((n) => {
        const c = n.c, sh = shown(c, now), mv = sh == null ? null : sh * PER[3], col = dayCol(mv), l = live[c.s];
        const fade = hoverSec && n.sec !== hoverSec;
        if (fade) { ctx.globalAlpha = 0.18; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; return; }
        // rings stay still. A ring only flashes when a real new price arrives (market open + live prices on).
        const blink = 1;
        const flash = l && l.pulse ? Math.max(0, 1 - (now - l.pulse) / 900) : 0;
        const ringCol = flash > 0 && l.dir ? (l.dir > 0 ? UP : DOWN) : col;
        const ringW = Math.max(2, n.rr * 0.24) + flash * 3;

        if (Math.abs(c.tz || 0) >= 2.5) { // waves: an unusually big day
          const ph = 0.35;   // a still ring: it marks a fact (a very big day), so it does not animate
          ctx.globalAlpha = (1 - ph) * 0.7; ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.rr + 3 + ph * 14, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr, 0, Math.PI * 2); ctx.fill();
        const big = n.rr >= 6.5, im = big || n === sel || n === hover ? logo(c) : null;
        const inner = n.rr - ringW * 0.5;
        if (im && inner > 3) {
          ctx.save(); ctx.beginPath(); ctx.arc(n.x, n.y, inner, 0, Math.PI * 2); ctx.clip();
          const s = inner * 2 * 0.82, k = Math.min(s / im.naturalWidth, s / im.naturalHeight);
          ctx.drawImage(im, n.x - im.naturalWidth * k / 2, n.y - im.naturalHeight * k / 2, im.naturalWidth * k, im.naturalHeight * k);
          ctx.restore();
        } else if (big) {
          ctx.fillStyle = "#20242a"; ctx.font = `700 ${Math.max(7, Math.min(12, n.rr * 0.62))}px ${FONT}`; ctx.textAlign = "center";
          ctx.fillText(c.s.slice(0, 4), n.x, n.y + n.rr * 0.22);
        } else {
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = Math.min(1, blink + flash); ctx.strokeStyle = ringCol; ctx.lineWidth = ringW;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.rr - ringW / 2 + 0.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        if (n.rr >= 13 && col !== FLAT) { // a little plus or minus badge, so colour is never the only sign
          const bx = n.x + n.rr * 0.72, by = n.y - n.rr * 0.72, br = Math.max(5, n.rr * 0.3);
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.6; ctx.beginPath();
          ctx.moveTo(bx - br * 0.5, by); ctx.lineTo(bx + br * 0.5, by);
          if (mv > 0) { ctx.moveTo(bx, by - br * 0.5); ctx.lineTo(bx, by + br * 0.5); }
          ctx.stroke();
        }
      });
      ringLabels.forEach(([rr, half, label]) => { // on top of the bubbles so they can always be read
        ctx.font = "600 12px " + FONT; ctx.textAlign = "center";
        const tw = ctx.measureText(label).width + 14;
        ctx.fillStyle = SURF; pill(CX - tw / 2, CY - rr - 10, tw, 20);
        ctx.fillStyle = half ? INK : SEC; ctx.fillText(label, CX, CY - rr + 4);
      });
      [hover, sel].forEach((n) => {
        if (!n) return;
        ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr + 3.5, 0, Math.PI * 2); ctx.stroke();
        ctx.font = "700 12px " + FONT; ctx.textAlign = "center";
        const tw = ctx.measureText(n.c.s).width + 12, ty = n.y - n.rr - 16;
        ctx.fillStyle = INK; pill(n.x - tw / 2, ty - 9, tw, 18);
        ctx.fillStyle = BG; ctx.fillText(n.c.s, n.x, ty + 4);
      });

      // the middle
      ctx.textAlign = "center"; ctx.fillStyle = MUTED; ctx.font = "700 11px " + FONT;
      ctx.fillText("MIDDLE", CX, CY - 4);
      ctx.fillStyle = INK; ctx.font = "600 12px " + FONT;
      ctx.fillText("smaller chance", CX, CY + 12);
    }
    requestAnimationFrame(draw);
  }

  function nodeAt(e) {
    const b = canvas.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    let best = null, bd = 1e9;
    nodes.forEach((n) => { const d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.rr + 3, 9) && d - n.rr < bd) { best = n; bd = d - n.rr; } });
    if (best) return best;
    // a line on the edge: the pointer must be at that line's distance from the middle, and nearest to its direction
    const pr = Math.hypot(x - CX, y - CY), pa = Math.atan2(y - CY, x - CX);
    let da = 1e9;
    nodes.forEach((n) => {
      if (n.l0 == null || pr < n.l0 - 5 || pr > n.l1 + 9) return;
      let d = Math.abs(pa - n.ang) % (Math.PI * 2); if (d > Math.PI) d = Math.PI * 2 - d;
      if (d * pr < 7 && d < da) { best = n; da = d; }   // within about 7 pixels sideways
    });
    return best;
  }
  const tipEl = $("#tip");
  canvas.addEventListener("mousemove", (e) => {
    hover = nodeAt(e);
    const cb = canvas.getBoundingClientRect(), px = e.clientX - cb.left, py = e.clientY - cb.top;
    hoverSec = hover ? null : secs.find((s) => Math.abs(px - s.lx) <= s.lw / 2 && Math.abs(py - s.ly) <= s.lh / 2) || null;
    canvas.style.cursor = hover || hoverSec ? "pointer" : "default";
    if (hoverSec) {
      const s = hoverSec, by = s.list.slice().sort((a, b) => (dayMove(b) || 0) - (dayMove(a) || 0)), top = by[0], bot = by[by.length - 1];
      tipEl.innerHTML = `<b>${esc(s.name)}</b>
        <div><span>Went up</span><span>${s.ups} of ${s.list.length}</span></div>
        <div><span>Went down</span><span>${s.downs} of ${s.list.length}</span></div>
        ${s.list.length - s.ups - s.downs ? `<div><span>Did not move</span><span>${s.list.length - s.ups - s.downs}</span></div>` : ""}
        <div><span>Biggest rise</span><span>${esc(top.s)} ${chip(dayMove(top))}</span></div>
        <div><span>Biggest fall</span><span>${esc(bot.s)} ${chip(dayMove(bot))}</span></div>
        <div><span>Money traded</span><span>${s.word}</span></div>
        ${s.liveLine ? `<div><span>New prices this minute</span><span>${s.ticks.length}</span></div>` : ""}`;
      let x = e.clientX + 16; if (x + 290 > window.innerWidth) x -= 310;
      tipEl.style.left = x + "px"; tipEl.style.top = e.clientY + 16 + "px"; tipEl.hidden = false;
      return;
    }
    if (!hover) { tipEl.hidden = true; return; }
    const c = hover.c;
    tipEl.innerHTML = `<div class="tip-row">${c.lg ? `<img src="${esc(c.lg)}" alt="">` : ""}<b>${esc(c.n)}</b></div>
      <div><span>Worth more next month?</span><span>${n100(c.p)} out of 100</span></div>
      <div><span>${PER[5][0].toUpperCase() + PER[5].slice(1)}</span><span>${chip(dayMove(c))}</span></div>`;
    let x = e.clientX + 16; if (x + 270 > window.innerWidth) x -= 290;
    tipEl.style.left = x + "px"; tipEl.style.top = e.clientY + 16 + "px"; tipEl.hidden = false;
  });
  canvas.addEventListener("mouseleave", () => { hover = null; hoverSec = null; tipEl.hidden = true; });
  canvas.addEventListener("click", (e) => { const n = nodeAt(e); if (n) select(n.c.s); });
  window.addEventListener("resize", layout);

  function lead() {
    const vals = cos.map(dayMove).filter((x) => x != null), up = vals.filter((x) => x > 0).length;
    const when = PER[0] === "day" ? "On " + dayName(TD.date) : PER[4][0].toUpperCase() + PER[4].slice(1);
    $("#cell-lead").innerHTML = `There are <b>${cos.length}</b> big companies here. ${when}, <b class="up">${up} went up</b> and <b class="down">${vals.length - up} went down</b>.
      For a normal company, the chance to be worth more next month is <b>${n100(P_MID)} out of 100</b>. Tap any bubble to see why.`;
    $("#updated").textContent = `Updated ${CELL.generated}. Prices up to ${CELL.data_through}. It updates itself every weekday night.`;
  }
  lead();

  // is the New York stock exchange open right now? (Monday to Friday, 9:30 to 16:00 New York time, except holidays)
  // days the New York Stock Exchange is closed (2026 and 2027)
  const HOLIDAYS = ["2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"];
  function marketOpen() {
    const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = ny.getHours() * 60 + ny.getMinutes();
    const day = ny.getFullYear() + "-" + String(ny.getMonth() + 1).padStart(2, "0") + "-" + String(ny.getDate()).padStart(2, "0");
    return ny.getDay() >= 1 && ny.getDay() <= 5 && mins >= 570 && mins < 960 && !HOLIDAYS.includes(day);
  }
  function marketNote() {
    const open = marketOpen(), key = !!getKey();
    const opensAt = new Date(Date.UTC(2026, 0, 5, 14, 30)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#market-note").innerHTML = open
      ? (key ? '<span class="chip up">open</span> The market is open. A ring flashes each time a new price arrives.'
             : '<span class="chip up">open</span> The market is open. Add a key under "Live prices" to see rings flash with each new price.')
      : `<span class="chip flat">closed</span> The market is closed right now. The rings show what happened in the time you picked. ${key ? "Your live connection stays on, so any early or late trading will still flash. " : ""}It opens Monday to Friday at about ${opensAt} your time.`;
  }

  // dark or light: remembered in this browser
  const isDark = document.documentElement.dataset.theme === "dark";
  $("#theme-btn").textContent = isDark ? "Light mode" : "Dark mode";
  $("#theme-btn").addEventListener("click", () => {
    try { localStorage.setItem("stocklab_theme", isDark ? "light" : "dark"); } catch (e) { /* ignore */ }
    location.reload();
  });

  // the picture story can be hidden
  const story = $("#story");
  const setStory = (closed) => { story.classList.toggle("closed", closed); $("#story-toggle").textContent = closed ? "Show" : "Hide"; };
  try { setStory(localStorage.getItem("stocklab_story") === "closed"); } catch (e) { /* ignore */ }
  $("#story-toggle").addEventListener("click", () => {
    const closed = !story.classList.contains("closed");
    setStory(closed);
    try { localStorage.setItem("stocklab_story", closed ? "closed" : "open"); } catch (e) { /* ignore */ }
    layout();
  });

  // ---------- the company card ----------
  const FACT = {
    year: (v) => `Over the last year its price ${went(v[0])}.`,
    month: (v) => `Over the last month its price ${went(v[0])}.`,
    week: (v) => `Over the last week its price ${went(v[0], 1)}.`,
    jumpy: (v) => (v[1] >= 0.6 ? "Its price jumps around a lot." : v[1] <= 0.4 ? "Its price is calm and moves slowly." : "Its price moves a normal amount."),
    trend: (v) => `Its price is ${v[0] >= 0 ? "higher" : "lower"} than its usual price this year.`,
    industry: (v, c) => `Other ${esc(c.sec)} companies ${went(v[0])} lately.`,
    day: (v) => `On the last day its price ${went(v[0], 1)}${Math.abs(v[1] || 0) >= 2.5 ? ", a very big day" : ""}.`,
    market: (v) => `All companies together ${went(v[0], 1)} last month.`,
  };

  function renderWhy(o, c) {
    const rows = o.why.filter((w) => Math.abs(w.d) >= 0.005).slice(0, 4);
    $("#why").innerHTML = `<p class="why-start">For any company, the answer is "yes" about <b>${n100(O.freq.all.rate)} out of 100</b> times. These things change it a little for this one:</p>` +
      (rows.map((w) => `<div class="why-row"><div class="t">${FACT[w.k](w.v, c)}</div>
        <div class="e">${chip(w.d, (w.d > 0 ? "more" : "less") + " likely")}</div></div>`).join("")
        || '<p class="plain">Nothing special. It looks like a normal company right now.</p>');
  }

  function renderTrust() {
    const skill = 1 - O.brier / O.brier_base;
    $("#trust").innerHTML = skill > 0.01
      ? `<b>A little.</b> We tested this on the past. The guesses were slightly better than a coin flip, but still often wrong.`
      : `<b>Not much.</b> We tested this on the past, and the guesses were no better than saying the same number for every company. Looking at old prices cannot tell you the future. See the tab "Does it work?".`;
  }

  const CAUSE = {
    company: ["Probably news about this company.", "The other companies did not move like this. That is our reading of the numbers, not a known fact."],
    sector: ["Probably its whole group.", "Companies that make similar things moved the same way that day."],
    market: ["Probably the whole market.", "Most companies moved the same way that day, so it was likely not about this one."],
    quiet: ["A normal-sized move.", "It was no bigger than this company's usual daily move."],
    earnings: ["It reported how much money it made.", "This company published its results on that day."],
  };
  // the news from the day of a move: the most reported story first, then the full list so readers can judge for themselves
  function newsHtml(news) {
    if (!news || !news.items) return "";
    const items = news.items.filter((x) => x && x.headline);
    if (!items.length) return '<p class="muted small">We found no news for that day.</p>';
    const times = (x) => (x.count ? ` <span class="count">reported about ${x.count} time${x.count === 1 ? "" : "s"}</span>` : "");
    const link = (x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.headline)}</a> <span class="muted">(${esc(x.source)})</span>${times(x)}`;
    const more = items.length > 1 ? `<details class="newslist"><summary>See all ${items.length} stories from that day</summary>
      <ol>${items.map((x) => `<li>${link(x)}</li>`).join("")}</ol>
      <p class="muted small">${news.n ? "From " + news.n + " headlines in our news feed that day. " : ""}Headlines that tell the same story are counted together, so the counts are approximate. We cannot know for sure which story moved the price, so read them and decide.</p></details>` : "";
    return `<p>${items.length > 1 ? "Most reported that day: " : "In the news that day: "}${link(items[0])}</p>${more}`;
  }

  function renderExplain(c) {
    if (c.d1 == null || !c.tc) { $("#explain").innerHTML = "<p>No news yet.</p>"; return; }
    const ct = CAUSE[c.tc] || CAUSE.quiet;
    const mv = (TD.movers || []).find((m) => m.s === c.s);
    const news = mv ? newsHtml(mv.news) : "";
    const l = live[c.s];
    const now = l && l.price && l.prevClose ? `<p>Right now: ${chip(l.price / l.prevClose - 1)} today.</p>` : "";
    $("#explain").innerHTML = `<p>On ${dayName(TD.date)} its price <b>${went(c.d1, 1)}</b>. All companies together ${went(TD.market, 1)}.</p>
      <p><b>${ct[0]}</b> ${ct[1]}</p>${news}${now}`;
  }

  const LC = window.LightweightCharts;
  const chart = LC.createChart($("#chart"), {
    autoSize: true,
    layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, rightOffset: 2 },
    handleScroll: false, handleScale: false,
  });
  const priceLine = chart.addLineSeries({ color: css("--accent"), lineWidth: 3, priceLineVisible: false });
  const coneOpt = { color: css("--text-muted"), lineWidth: 2, lineStyle: LC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const coneLo = chart.addLineSeries(coneOpt), coneHi = chart.addLineSeries(coneOpt);

  function renderCompany() {
    const c = bySym[selected], d = details[selected];
    if (!c) return;
    $("#co-name").textContent = c.n;
    $("#co-sub").textContent = `${c.s}, ${c.sec === "Benchmark" ? "a basket of many companies" : "a " + c.sec + " company"}`;
    const lg = $("#co-logo"), ini = $("#co-initial");
    ini.textContent = c.s.slice(0, 4);
    if (c.lg) { lg.onerror = () => { lg.hidden = true; ini.hidden = false; }; lg.src = c.lg; lg.hidden = false; ini.hidden = true; } else { lg.hidden = true; ini.hidden = false; }
    $("#co-price").textContent = money(price(c));
    $("#co-change").innerHTML = chip(dayMove(c)) + ' <span class="muted small">' + PER[5] + '</span>';
    renderExplain(c);
    if (c.p == null) {
      $("#ch-num").textContent = "?"; $("#ch-word").textContent = ""; $("#ch-mark").style.left = "50%"; $("#ch-range").textContent = "";
      $("#why").innerHTML = '<p class="plain">This one is a basket holding a little of every company, so we use it to compare.</p>'; $("#trust").textContent = "";
    } else {
      $("#ch-num").textContent = n100(c.p);
      $("#ch-mark").style.left = Math.max(2, Math.min(98, c.p * 100)) + "%";
      $("#ch-word").textContent = lean(c.p);
      renderTrust();
    }
    if (!d) return;
    if (d.odds) renderWhy(d.odds, c);
    const path = d.call.path, end = path[path.length - 1], base = path[0].mid;
    if (c.p != null && base) $("#ch-range").innerHTML = `<b>If you put in €100 today:</b> in a month it would usually be worth between <b>€${Math.round(100 * end.low / base)}</b> and <b>€${Math.round(100 * end.high / base)}</b>. Sometimes more, sometimes less.`;
    const cd = d.candles.slice(-126).map((x) => ({ time: x[0], value: x[4] }));
    priceLine.setData(cd);
    coneLo.setData(path.map((x) => ({ time: x.time, value: x.low })));
    coneHi.setData(path.map((x) => ({ time: x.time, value: x.high })));
    const mv = ((d.moves && d.moves.top) || []), first = cd[0].time;
    priceLine.setMarkers(mv.filter((m) => m.date >= first).map((m) => ({ time: m.date, position: m.ret > 0 ? "aboveBar" : "belowBar", color: m.ret > 0 ? UP : DOWN, shape: "circle", text: String(mv.indexOf(m) + 1) })));
    chart.timeScale().fitContent();
    $("#moves").innerHTML = mv.length ? mv.map((m, i) => {
      const ct = CAUSE[m.cause] || CAUSE.company;
      return `<div class="move"><span class="num">${i + 1}</span><span>${m.date}</span><span>${chip(m.ret)}</span><span class="why"><b>${ct[0]}</b>${newsHtml(m.news)}</span></div>`;
    }).join("") : '<p class="plain">No very big days this year.</p>';
  }

  function select(sym) {
    if (!bySym[sym]) return;
    selected = sym;
    renderCompany();
    if (details[sym]) return;
    const s = document.createElement("script");
    s.src = "data/stocks/" + encodeURIComponent(sym) + ".js";
    s.onload = () => { if (selected === sym) renderCompany(); };
    document.body.appendChild(s);
  }
  $("#search").addEventListener("change", (e) => {
    const v = e.target.value.trim().toUpperCase();
    const hit = bySym[v] ? v : (all.find((c) => c.n.toUpperCase() === v) || {}).s;
    if (hit) { show("cell"); select(hit); e.target.value = ""; }
  });

  // ---------- does it work? ----------
  let paperChart = null;
  function renderTrack() {
    const skill = 1 - O.brier / O.brier_base;
    $("#trust-lead").innerHTML = `For ${O.months} months, the computer gave every company a chance, using only what it knew on that day. One month later we looked at what really happened.
      If the computer is honest, companies it gave "60 out of 100" should really go up about 60 times out of 100. In those months, <b>${n100(O.base)} out of 100</b> companies went up.`;
    $("#calib").innerHTML = O.bins.map((b) => `<div class="calib-row"><span>It said ${b.lo} to ${b.hi} out of 100</span>
      <div class="odds"><i style="width:${b.happened * 100}%"></i><em></em><b style="left:${b.said * 100}%" title="what it said"></b></div>
      <span class="r">really: ${n100(b.happened)} out of 100</span></div>`).join("");
    const rising = O.bins.length > 1 && O.bins[O.bins.length - 1].happened > O.bins[0].happened + 0.03;
    $("#calib-note").innerHTML = `Blue bar: what really happened. Gold mark: what the computer said. <b>${
      skill > 0.01 && rising ? "Result: a higher number did mean going up more often. The guesses help a little."
        : "Result: the computer's numbers were no better than giving every company the same chance. Old prices do not tell the future."}</b>
      It guessed up or down correctly ${n100(O.hit)} times out of 100. Always saying "up" was right ${n100(O.hit_base)} times out of 100.`;

    const T = CELL.test || {}, P = T.paper || [];
    if (!P.length) return;
    const eur = (x) => "€" + Math.round(x).toLocaleString("de-DE");
    const last = P[P.length - 1], worst = Math.min(...P.slice(1).map((x) => x.b_ret));
    $("#paper-hero").innerHTML = `<div class="card"><span>The computer's 20 favourites</span><b>${eur(last.brain)}</b><span>after ${T.paper_months} months</span></div>
      <div class="card"><span>A little of every company</span><b>${eur(last.spy)}</b><span>after ${T.paper_months} months</span></div>
      <div class="card"><span>The worst month</span><b>${pct(worst, 0)}</b><span>lost in a single month</span></div>`;
    $("#paper-caveat").innerHTML = `<b>This looks better than it really was.</b> The test only knows companies that are big today. Some got big because their price shot up, and the ones that failed are missing. A real try, with no looking back, started on ${esc((CELL.paper_live || {}).started || "the first run")}.`;
    if (!paperChart) {
      paperChart = LC.createChart($("#paper-chart"), {
        autoSize: true, layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
        grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
        localization: { priceFormatter: eur }, handleScroll: false, handleScale: false,
      });
      [["brain", "#3987e5"], ["spy", "#c98500"]].forEach(([k, col]) => paperChart.addLineSeries({ color: col, lineWidth: 3, priceLineVisible: false }).setData(P.map((x) => ({ time: x.time, value: x[k] }))));
    }
    paperChart.timeScale().fitContent();
  }

  // ---------- views ----------
  function show(v) {
    ["cell", "play", "flow", "track"].forEach((k) => ($("#" + k + "-view").hidden = v !== k));
    document.querySelectorAll("#view-seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    if (v === "cell") { layout(); window.dispatchEvent(new Event("stocklab-cell")); }
    if (v === "track") renderTrack();
    if (v === "play") window.dispatchEvent(new Event("stocklab-play"));
    if (v === "flow") window.dispatchEvent(new Event("stocklab-flow"));
  }
  $("#view-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.view); });
  window.STOCKLAB_OPEN = (sym) => { show("cell"); select(sym); window.scrollTo({ top: 0 }); };

  // ---------- live prices (optional): every new price makes that bubble's ring flash ----------
  const status = (st, text) => { $("#live-status").className = "pill " + st; $("#live-text").textContent = text; };
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch (e) { return ""; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME); } catch (e) { /* ignore */ } };
  const toF = (s) => s.replace("-", "."), fromF = (s) => s.replace(".", "-");
  let ws = null, timer = null, idx = 0, pending = false;
  const fundSyms = (CELL.funds || []).map((f) => f.s);   // the 11 category funds get instant live prices first
  const streamed = [...fundSyms, ...cos.slice().sort((a, b) => b.dv - a.dv).slice(0, 50 - fundSyms.length).map((c) => c.s)];
  const order = [...streamed, ...all.map((c) => c.s).filter((s) => !streamed.includes(s))];
  const refresh = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (selected) renderCompany(); }, 1500); };
  function tick(sym, p, prevClose) {
    const l = live[sym] || (live[sym] = {});
    const before = l.price;   // only compare with an earlier LIVE price, never with last night's stored price
    if (before && p !== before) {
      l.dir = p > before ? 1 : -1; l.pulse = performance.now();
      const n = nodeOf[sym];
      if (n) { n.sec.pulse = l.pulse; n.sec.dir = l.dir; n.sec.ticks.push(Date.now()); }
    }
    l.price = p;
    if (prevClose) l.prevClose = prevClose;
    window.dispatchEvent(new CustomEvent("stocklab-tick", { detail: { s: sym, p: p, pc: l.prevClose || null, changed: !!(before && p !== before) } }));
    if (sym === selected) refresh();
  }

  // Finnhub allows ONE open live connection per key. A second tab, window or device using the same key
  // kicks the first one off, and then they take turns kicking each other. So:
  //  1. only one tab of this site holds the connection (the others wait their turn)
  //  2. if the connection keeps getting cut right after it opens, stop and say why instead of retrying forever
  const TAB = Math.random().toString(36).slice(2), LOCK = "stocklab_live_owner";
  function ownTab() {
    try {
      const o = JSON.parse(localStorage.getItem(LOCK) || "null"), now = Date.now();
      if (!o || o.id === TAB || now - o.ts > 12000) { localStorage.setItem(LOCK, JSON.stringify({ id: TAB, ts: now })); return true; }
      return false;
    } catch (e) { return true; }
  }
  window.addEventListener("pagehide", () => { try { const o = JSON.parse(localStorage.getItem(LOCK) || "null"); if (o && o.id === TAB) localStorage.removeItem(LOCK); } catch (e) { /* ignore */ } });

  let openedAt = 0, quickDrops = 0, fails = 0, nextTry = 0, blockedUntil = 0, keyBad = "", pauseUntil = 0;
  function stop() {
    if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    clearInterval(timer); timer = null;
  }
  async function poll(key) {
    if (Date.now() < pauseUntil) return;
    const sym = order[idx]; idx = (idx + 1) % order.length;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(toF(sym))}&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) { keyBad = key; stop(); manage(); return; }
      if (r.status === 429) { pauseUntil = Date.now() + 60000; return; }   // asked too often: rest for a minute
      if (!r.ok) return;
      const qd = await r.json();
      if (qd && qd.c) tick(sym, qd.c, qd.pc);
    } catch (e) { /* network blip */ }
  }
  function start(key) {
    timer = setInterval(() => poll(key), 1300);   // about 46 a minute, safely under the free limit of 60
    status("warn", "Connecting");
    const sock = ws = new WebSocket("wss://ws.finnhub.io?token=" + encodeURIComponent(key));
    sock.onopen = () => {
      openedAt = Date.now();
      streamed.forEach((s) => sock.send(JSON.stringify({ type: "subscribe", symbol: toF(s) })));
      status("on", marketOpen() ? "Live prices on" : "Live connected (market closed)");
    };
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "trade" && m.data) { fails = 0; quickDrops = 0; m.data.forEach((tr) => tick(fromF(tr.s), tr.p)); }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      const lasted = openedAt ? Date.now() - openedAt : 0;
      quickDrops = lasted < 30000 ? quickDrops + 1 : 0;   // cut off right after connecting
      openedAt = 0; fails++;
      if (quickDrops >= 3 && marketOpen()) { blockedUntil = Date.now() + 5 * 60000; quickDrops = 0; }
      nextTry = Date.now() + Math.min(5 * 60000, 15000 * Math.pow(2, Math.min(fails - 1, 5)));   // wait longer after each failure
      manage();
    };
  }
  function manage() {
    const key = getKey(), now = Date.now();
    if (!key) { stop(); status("", "Live off"); return; }
    if (keyBad === key) { stop(); status("warn", "Key rejected. Check it under Live prices"); return; }
    if (!ownTab()) { stop(); status("warn", "Live prices are running in another tab"); return; }
    if (now < blockedUntil) { stop(); status("warn", "Your key is in use somewhere else. Close other tabs or devices"); return; }
    if (!timer) timer = setInterval(() => poll(key), 1300);
    if (!ws) {
      if (now >= nextTry) { clearInterval(timer); timer = null; start(key); }
      else status("warn", "Live stream paused, retrying in " + Math.ceil((nextTry - now) / 1000) + "s");
    }
  }
  function connect() { stop(); keyBad = ""; blockedUntil = 0; nextTry = 0; fails = 0; quickDrops = 0; manage(); }   // called when the key changes
  setInterval(manage, 5000);
  setInterval(() => {   // keep every group's facts current
    const cut = Date.now() - 60000;
    secs.forEach((s) => {
      while (s.ticks.length && s.ticks[0] < cut) s.ticks.shift();
      const ups = s.list.filter((c) => (dayMove(c) || 0) > 0).length;
      s.downs = s.list.filter((c) => (dayMove(c) || 0) < 0).length;
      s.known = s.list.filter((c) => dayMove(c) != null).length;
      if ((ups * 2 >= s.list.length) !== (s.ups * 2 >= s.list.length)) s.flip = performance.now();   // the group just switched between mostly up and mostly down
      s.ups = ups;
    });
  }, 1000);
  // ---------- one time period for the cell and the signal line, with a play button ----------
  const STEP_MS = 2000, GLIDE_PLAY = 1700, ORDER = ["max", "five", "year", "ytd", "half", "month", "week", "day"];
  let playTimer = null;
  function setPeriod(key, fromPlay) {
    const p = PERIODS.find((x) => x[0] === key); if (!p) return;
    if (!fromPlay) stopPlay();
    const now = performance.now(), from = {};
    cos.forEach((c) => { from[c.s] = shown(c, now); });   // where every line is right now, even in the middle of a glide
    PER = p; glide.from = from; glide.t0 = now; glide.dur = fromPlay ? GLIDE_PLAY : 700;
    secs.forEach((s) => { s.ups = s.list.filter((c) => (dayMove(c) || 0) > 0).length; s.downs = s.list.filter((c) => (dayMove(c) || 0) < 0).length; s.known = s.list.filter((c) => dayMove(c) != null).length; s.flip = 0; });
    lead(); if (selected) refresh();
    paintBars();
    window.dispatchEvent(new CustomEvent("stocklab-period", { detail: { key: key, dur: glide.dur } }));
  }
  function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; } paintBars(); }
  function play() {   // keeps going round (Max down to 1 day, then Max again) until Stop or Live is pressed
    if (playTimer) return;
    let i = PER[0] === "day" ? 0 : Math.max(0, ORDER.indexOf(PER[0]));   // start from Max, or carry on from where it was stopped
    setPeriod(ORDER[i], true);
    playTimer = setInterval(() => { i = (i + 1) % ORDER.length; setPeriod(ORDER[i], true); }, STEP_MS);
    paintBars();
  }
  function paintBars() {
    document.querySelectorAll(".period-bar").forEach((el) => {
      el.querySelectorAll("button[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === PER[0]));
      const on = !!playTimer, q = (c) => el.querySelector(c);
      if (q(".play")) { q(".play").classList.toggle("primary", on); q(".play").disabled = on; q(".play").textContent = on ? "Playing" : "Play"; }
      if (q(".stop")) q(".stop").disabled = !on;
      if (q(".live")) q(".live").classList.toggle("primary", !on && PER[0] === "day");
    });
  }
  function mountBars() {
    document.querySelectorAll(".period-bar").forEach((el) => {
      if (el.dataset.ready) return; el.dataset.ready = "1";
      el.innerHTML = `<div class="seg">${PERIODS.map((p) => `<button data-p="${p[0]}">${p[1]}</button>`).join("")}</div><span class="pb-ctl"><button class="btn play" title="Go round from Max down to 1 day, again and again">Play</button><button class="btn stop" title="Stop on the time shown now">Stop</button><button class="btn live" title="Back to now: the last day, with live prices if they are on">Live</button></span>`;
      el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.classList.contains("play")) play(); else if (b.classList.contains("stop")) stopPlay(); else if (b.classList.contains("live")) setPeriod("day"); else setPeriod(b.dataset.p); });
    });
    paintBars();
  }
  window.STOCKLAB_PERIOD = { get: () => PER[0], set: setPeriod, mount: mountBars, stepMs: STEP_MS };
  mountBars();

  const dlg = $("#key-dialog");
  $("#key-btn").addEventListener("click", () => { $("#key-input").value = getKey(); dlg.showModal(); });
  dlg.addEventListener("close", () => { if (dlg.returnValue === "save") setKey($("#key-input").value.trim()); if (dlg.returnValue === "clear") setKey(""); connect(); });

  // ---------- start ----------
  layout();
  marketNote(); setInterval(marketNote, 60000);
  requestAnimationFrame(draw);
  select(cos.slice().sort((a, b) => b.dv - a.dv)[0].s);
  connect();
})();
