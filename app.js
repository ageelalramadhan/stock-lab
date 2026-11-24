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

  // ---------- words ----------
  const n100 = (x) => Math.round(x * 100);
  const pct = (x, d = 1) => (x == null ? "n/a" : (x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
  const money = (x) => (x == null ? "n/a" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const went = (x, d = 0) => (x == null ? "did not trade" : Math.abs(x) < 0.0005 ? "stayed the same" : "went " + (x > 0 ? "up " : "down ") + (Math.abs(x) * 100).toFixed(d) + "%");
  const dayName = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "the last day");
  const lean = (p) => (p >= 0.6 ? "Probably more" : p >= 0.55 ? "A little more likely than not" : p > 0.45 ? "About a coin flip" : p > 0.4 ? "A little less likely than not" : "Probably less");
  const price = (c) => (live[c.s] && live[c.s].price) || c.px;
  const dayMove = (c) => { const l = live[c.s]; return l && l.price && l.prevClose ? l.price / l.prevClose - 1 : c.d1; };
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
  const GAP = 0.035, total = cos.length;
  let a0 = -Math.PI / 2;
  secs.forEach((s) => { s.a0 = a0; s.a1 = a0 + (s.list.length / total) * (Math.PI * 2 - GAP * secs.length); s.mid = (s.a0 + s.a1) / 2; a0 = s.a1 + GAP; });
  const maxDv = d3.max(cos, (c) => c.dv) || 1;
  const nodes = [];
  secs.forEach((s) => s.list.forEach((c, i) => nodes.push({ c, sec: s, ang: s.a0 + ((i + 0.5) / s.list.length) * (s.a1 - s.a0), rr: 0, ph: Math.random() * 6.28 })));
  const nodeOf = Object.fromEntries(nodes.map((n) => [n.c.s, n]));
  const rOf = (p) => R * (0.2 + 0.68 * Math.max(0, Math.min(1, (p - P_LO) / (P_HI - P_LO))));

  function layout() {
    const box = $("#cell-wrap").getBoundingClientRect();
    if (!box.width) return;
    const dpr = window.devicePixelRatio || 1;
    W = Math.min(box.width, box.height || box.width);
    canvas.width = box.width * dpr; canvas.height = W * dpr;
    canvas.style.height = W + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = box.width / 2; CY = W / 2; R = Math.min(box.width, W) / 2 - (box.width < 520 ? 46 : 64);
    const rs = d3.scaleSqrt().domain([0, maxDv]).range([R * 0.011 + 2, R * 0.062 + 3]);
    nodes.forEach((n) => {
      n.rr = rs(n.c.dv);
      n.tx = CX + Math.cos(n.ang) * rOf(n.c.p); n.ty = CY + Math.sin(n.ang) * rOf(n.c.p);
      n.x = n.tx; n.y = n.ty;
    });
    const sim = d3.forceSimulation(nodes).force("x", d3.forceX((n) => n.tx).strength(0.3)).force("y", d3.forceY((n) => n.ty).strength(0.3))
      .force("hit", d3.forceCollide((n) => n.rr + 1.5).iterations(2)).stop();
    for (let i = 0; i < 200; i++) sim.tick();
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
    const p = s0.p + (s1.p - s0.p) * u, vp = s0.vp + (s1.vp - s0.vp) * u;
    const bulge = Math.max(-1, Math.min(1, (p - P_MID) / (span * 0.6))) * R * 0.06;
    const amp = R * (0.004 + 0.018 * vp);
    return R + bulge + amp * (Math.sin(a * 9 + t * (0.8 + vp)) * 0.6 + Math.sin(a * 17 - t * (1.3 + vp)) * 0.4);
  }

  const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif';
  const pill = (x, y, w, h) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h); ctx.fill(); };
  const t0 = performance.now();
  function draw(now) {
    if (!$("#cell-view").hidden && R > 0) {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // the cell's body and its moving edge
      ctx.beginPath();
      for (let a = -Math.PI / 2, i = 0; a < Math.PI * 1.5; a += 0.02, i++) {
        const r = edgeAt(a, t), x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(CX, CY, R * 0.1, CX, CY, R);
      g.addColorStop(0, "#fdf3d7"); g.addColorStop(1, "#f3f8ff");
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = "#8fb3ee"; ctx.lineWidth = 5; ctx.lineJoin = "round"; ctx.stroke();

      // rings: the same chance all the way round
      const ringLabels = [];
      ctx.textAlign = "center";
      for (let v = Math.ceil(P_LO * 20) / 20; v <= P_HI + 1e-9; v += 0.05) {
        const rr = rOf(v), half = Math.abs(v - 0.5) < 0.001;
        ctx.setLineDash(half ? [] : [4, 6]);
        ctx.strokeStyle = half ? "#9aa0a8" : "#d9d0bd"; ctx.lineWidth = half ? 2 : 1.2;
        ctx.beginPath(); ctx.arc(CX, CY, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ringLabels.push([rr, half, half ? "coin flip: 50 out of 100" : n100(v) + " out of 100"]);
      }

      // slices: one for each kind of company
      secs.forEach((s) => {
        const a = s.a0 - GAP / 2;
        ctx.strokeStyle = "#e3dccb"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(CX + Math.cos(a) * R * 0.16, CY + Math.sin(a) * R * 0.16); ctx.lineTo(CX + Math.cos(a) * R * 0.95, CY + Math.sin(a) * R * 0.95); ctx.stroke();
        const lr = R + 32, x = CX + Math.cos(s.mid) * lr, y = CY + Math.sin(s.mid) * lr;
        const words = s.name.split(" "), lines = words.length > 1 && s.name.length > 13 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [s.name];
        ctx.font = "700 12px " + FONT; ctx.textAlign = "center";
        const half = Math.max(...lines.map((ln) => ctx.measureText(ln).width)) / 2 + 4;
        const xx = Math.min(CX * 2 - half, Math.max(half, x)), y0 = y - (lines.length - 1) * 7 + 4;
        ctx.fillStyle = INK;
        lines.forEach((ln, i) => ctx.fillText(ln, xx, y0 + i * 14));
      });

      // the companies
      const sel = nodeOf[selected];
      nodes.forEach((n) => {
        const c = n.c, mv = dayMove(c), col = dayCol(mv), l = live[c.s];
        // every ring blinks: faster and stronger for bigger moves, and a bright flash when a live price arrives
        const size = Math.min(1, Math.abs(mv || 0) / 0.04);
        const blink = col === FLAT ? 0.6 : 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * (2.2 + 4 * size) + n.ph));
        const flash = l && l.pulse ? Math.max(0, 1 - (now - l.pulse) / 900) : 0;
        const ringCol = flash > 0 && l.dir ? (l.dir > 0 ? UP : DOWN) : col;
        const ringW = Math.max(1.5, n.rr * 0.2) + flash * 3;

        if (Math.abs(c.tz || 0) >= 2.5) { // waves: an unusually big day
          const ph = (((t * 0.3 + n.ph) % 1) + 1) % 1;
          ctx.globalAlpha = (1 - ph) * 0.7; ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.rr + 3 + ph * 14, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr, 0, Math.PI * 2); ctx.fill();
        const big = n.rr >= 9, im = big || n === sel || n === hover ? logo(c) : null;
        const inner = n.rr - ringW * 0.5;
        if (im && inner > 3) {
          ctx.save(); ctx.beginPath(); ctx.arc(n.x, n.y, inner, 0, Math.PI * 2); ctx.clip();
          const s = inner * 2 * 0.82, k = Math.min(s / im.naturalWidth, s / im.naturalHeight);
          ctx.drawImage(im, n.x - im.naturalWidth * k / 2, n.y - im.naturalHeight * k / 2, im.naturalWidth * k, im.naturalHeight * k);
          ctx.restore();
        } else if (big) {
          ctx.fillStyle = INK; ctx.font = `700 ${Math.max(7, Math.min(12, n.rr * 0.62))}px ${FONT}`; ctx.textAlign = "center";
          ctx.fillText(c.s.slice(0, 4), n.x, n.y + n.rr * 0.22);
        } else {
          ctx.globalAlpha = 0.3 + 0.35 * blink; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
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
        ctx.fillStyle = "rgba(255,255,255,0.94)"; pill(CX - tw / 2, CY - rr - 10, tw, 20);
        ctx.fillStyle = half ? INK : "#5d626b"; ctx.fillText(label, CX, CY - rr + 4);
      });
      [hover, sel].forEach((n) => {
        if (!n) return;
        ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr + 3.5, 0, Math.PI * 2); ctx.stroke();
        ctx.font = "700 12px " + FONT; ctx.textAlign = "center";
        const tw = ctx.measureText(n.c.s).width + 12, ty = n.y - n.rr - 16;
        ctx.fillStyle = INK; pill(n.x - tw / 2, ty - 9, tw, 18);
        ctx.fillStyle = "#fff"; ctx.fillText(n.c.s, n.x, ty + 4);
      });

      // the middle
      ctx.textAlign = "center"; ctx.fillStyle = "#7b808a"; ctx.font = "700 11px " + FONT;
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
    return best;
  }
  const tipEl = $("#tip");
  canvas.addEventListener("mousemove", (e) => {
    hover = nodeAt(e);
    canvas.style.cursor = hover ? "pointer" : "default";
    if (!hover) { tipEl.hidden = true; return; }
    const c = hover.c;
    tipEl.innerHTML = `<div class="tip-row">${c.lg ? `<img src="${esc(c.lg)}" alt="">` : ""}<b>${esc(c.n)}</b></div>
      <div><span>Worth more next month?</span><span>${n100(c.p)} out of 100</span></div>
      <div><span>Last day</span><span>${chip(dayMove(c))}</span></div>`;
    let x = e.clientX + 16; if (x + 270 > window.innerWidth) x -= 290;
    tipEl.style.left = x + "px"; tipEl.style.top = e.clientY + 16 + "px"; tipEl.hidden = false;
  });
  canvas.addEventListener("mouseleave", () => { hover = null; tipEl.hidden = true; });
  canvas.addEventListener("click", (e) => { const n = nodeAt(e); if (n) select(n.c.s); });
  window.addEventListener("resize", layout);

  (function lead() {
    const up = cos.filter((c) => (c.d1 || 0) > 0).length;
    $("#cell-lead").innerHTML = `There are <b>${cos.length}</b> big companies here. On ${dayName(TD.date)}, <b class="up">${up} went up</b> and <b class="down">${cos.length - up} went down</b>.
      For a normal company, the chance to be worth more next month is <b>${n100(P_MID)} out of 100</b>. Tap any bubble to see why.`;
    $("#updated").textContent = `Updated ${CELL.generated}. Prices up to ${CELL.data_through}. It updates itself every weekday night.`;
  })();

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
    company: ["News about this company.", "Other companies did not move like this, so something happened to this one."],
    sector: ["Its whole group moved.", "Companies that make similar things all moved the same way."],
    market: ["Almost every company moved.", "This was not about this company. The whole market moved."],
    quiet: ["Nothing special.", "A small move like this happens all the time and means nothing."],
    earnings: ["It told everyone how much money it made.", "Companies do this four times a year, and prices often jump after."],
  };
  function renderExplain(c) {
    if (c.d1 == null || !c.tc) { $("#explain").innerHTML = "<p>No news yet.</p>"; return; }
    const ct = CAUSE[c.tc] || CAUSE.quiet;
    const mv = (TD.movers || []).find((m) => m.s === c.s);
    const news = mv && mv.news && mv.news.headline ? `<p>In the news that day: <a href="${esc(mv.news.url)}" target="_blank" rel="noopener">${esc(mv.news.headline)}</a> (${esc(mv.news.source)})</p>` : "";
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
    $("#co-change").innerHTML = chip(dayMove(c)) + ' <span class="muted small">last day</span>';
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
      const news = m.news && m.news.headline ? `<br>In the news: <a href="${esc(m.news.url)}" target="_blank" rel="noopener">${esc(m.news.headline)}</a> (${esc(m.news.source)})` : "";
      return `<div class="move"><span class="num">${i + 1}</span><span>${m.date}</span><span>${chip(m.ret)}</span><span class="why"><b>${ct[0]}</b>${news}</span></div>`;
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
    ["cell", "play", "track"].forEach((k) => ($("#" + k + "-view").hidden = v !== k));
    document.querySelectorAll("#view-seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    if (v === "cell") layout();
    if (v === "track") renderTrack();
    if (v === "play") window.dispatchEvent(new Event("stocklab-play"));
  }
  $("#view-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.view); });
  window.STOCKLAB_OPEN = (sym) => { show("cell"); select(sym); window.scrollTo({ top: 0 }); };

  // ---------- live prices (optional): every new price makes that bubble's ring flash ----------
  const status = (st, text) => { $("#live-status").className = "pill " + st; $("#live-text").textContent = text; };
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch (e) { return ""; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME); } catch (e) { /* ignore */ } };
  const toF = (s) => s.replace("-", "."), fromF = (s) => s.replace(".", "-");
  let ws = null, timer = null, idx = 0, pending = false;
  const streamed = cos.slice().sort((a, b) => b.dv - a.dv).slice(0, 50).map((c) => c.s);
  const order = [...streamed, ...all.map((c) => c.s).filter((s) => !streamed.includes(s))];
  const refresh = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (selected) renderCompany(); }, 1500); };
  function tick(sym, p, prevClose) {
    const l = live[sym] || (live[sym] = {});
    const before = l.price || (bySym[sym] && bySym[sym].px);
    if (before && p !== before) { l.dir = p > before ? 1 : -1; l.pulse = performance.now(); }
    l.price = p;
    if (prevClose) l.prevClose = prevClose;
    if (sym === selected) refresh();
  }
  async function poll(key) {
    const sym = order[idx]; idx = (idx + 1) % order.length;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(toF(sym))}&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) { status("warn", "Key rejected"); clearInterval(timer); return; }
      if (!r.ok) return;
      const qd = await r.json();
      if (qd && qd.c) tick(sym, qd.c, qd.pc);
    } catch (e) { /* network blip */ }
  }
  function connect() {
    const key = getKey();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearInterval(timer);
    if (!key) { status("", "Live off"); return; }
    status("warn", "Connecting");
    timer = setInterval(() => poll(key), 1100);
    ws = new WebSocket("wss://ws.finnhub.io?token=" + encodeURIComponent(key));
    ws.onopen = () => { streamed.forEach((s) => ws.send(JSON.stringify({ type: "subscribe", symbol: toF(s) }))); status("on", "Live prices on"); };
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === "trade" && m.data) m.data.forEach((tr) => tick(fromF(tr.s), tr.p)); };
    ws.onclose = () => { status("warn", "Reconnecting"); setTimeout(() => { if (getKey()) connect(); }, 15000); };
  }
  const dlg = $("#key-dialog");
  $("#key-btn").addEventListener("click", () => { $("#key-input").value = getKey(); dlg.showModal(); });
  dlg.addEventListener("close", () => { if (dlg.returnValue === "save") setKey($("#key-input").value.trim()); if (dlg.returnValue === "clear") setKey(""); connect(); });

  // ---------- start ----------
  layout();
  requestAnimationFrame(draw);
  select(cos.slice().sort((a, b) => b.dv - a.dv)[0].s);
  connect();
})();
