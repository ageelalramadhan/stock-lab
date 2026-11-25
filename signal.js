/* The signal line: one straight line, one section per category, one thin bar per company.
   Each bar is that company's real price change in percent. With live prices on, a bar moves only when a real new price arrives. */
(function () {
  const C = window.CELL, F = window.FLOWS, box = document.getElementById("signal");
  if (!box || !C || !C.cells) { if (box) box.hidden = true; return; }
  const tip = document.getElementById("tip");
  const SHORT = { "Information Technology": "Technology", "Consumer Discretionary": "Discretionary", "Consumer Staples": "Staples", "Communication Services": "Communication" };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pct = (x, d) => (x >= 0 ? "+" : "") + (x * 100).toFixed(d == null ? 1 : d) + "%";
  const eur = (x) => "\u20ac" + x.toFixed(2);
  const FD = F && F.days ? F.days : [], lastDay = C.data_through || "", yr = lastDay.slice(0, 4);
  const since = C.history_from ? new Date(C.history_from + "T12:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "the start of our data";
  // [button, data field, words, trading days of the money record to count]
  const ago = (months) => { const d = new Date(lastDay + "T12:00:00"); d.setMonth(d.getMonth() - months); return d.toISOString().slice(0, 10); };
  const daysSince = (start) => FD.filter((d) => d.d > start).length || 1;
  const PERIODS = {
    day: ["1 day", "d1", "on the last trading day", 1], week: ["5 days", "w1", "over the last 5 trading days", 5],
    month: ["1 month", "c1m", "over the last month", daysSince(ago(1))], half: ["6 months", "c6m", "over the last 6 months", daysSince(ago(6))],
    ytd: ["This year", "ytd", "since 1 January " + yr + " (YTD, year to date)", FD.filter((d) => d.d.slice(0, 4) === yr).length || 1],
    year: ["1 year", "c1y", "over the last year", daysSince(ago(12))], five: ["5 years", "c5y", "over the last 5 years", 99999],
    max: ["Max", "mx", "since " + since + " (all the history we store)", 99999],
  };
  const cells = C.cells.filter((c) => c.sec !== "Benchmark" && c.p != null);   // the same companies as the cell below
  const names = Array.from(new Set(cells.map((c) => c.sec))).sort();
  const groups = names.map((nm) => ({ nm, list: cells.filter((c) => c.sec === nm).sort((a, b) => (b.dv || 0) - (a.dv || 0)) }));
  const live = {};
  let GLIDE = 700, fromSt = null, shownSt = null;
  let period = "day", hits = [], hover = null, pending = false, from = {}, glide = -1e9;

  box.innerHTML = `<div class="sig-head"><div><h2>The signal: how every company moved</h2>
      <p class="lead" id="sig-lead"></p></div>
      <div class="period-bar" id="sig-period"></div></div>
    <div id="sig-wrap"><canvas id="sig"></canvas></div>
    <div class="sig-key"><span><b>Each thin bar is one company.</b> Up and green: its price rose. Down and red: it fell. Longer: a bigger change in percent.</span>
      <span>Every number here is counted from real closing prices (Yahoo Finance). Nothing on this line is a forecast.</span>
      <span><b>Thick line</b>: the middle company of that category.</span><span>Inside a category the most traded companies are on the left. Click a bar to open that company.</span>
      <span><b>5 years and Max</b> use today's list of companies. Companies that were removed are missing, and newer companies without the full history are left out, so long periods look better than they really were.</span>
      <span><b>Category funds</b> (second line): each one is a real US fund holding that category's companies, with big companies counting more. When a fund and the line above disagree, a few giants moved differently from the rest. These US funds are not sold to private investors in Germany. Similar funds are (see your research report).</span>
      <span><b>\u20ac100 became</b>: 100 euros shared equally between all companies of that category at the start, and what they would be worth at the end. Counted from prices that include paid dividends (as if they were put back in). No fees, and no change between euro and dollar.</span></div>
    <p class="lead" id="sig-money" style="margin-top:8px"></p>`;
  const cv = box.querySelector("#sig"), wrap = box.querySelector("#sig-wrap");

  // a company's change for the chosen period. A live price (if one has arrived) replaces last night's price.
  function val(c) {
    const base = c[PERIODS[period][1]], l = live[c.s];
    if (!l) return base;
    if (period === "day") return l.pc ? l.p / l.pc - 1 : base;   // live day change needs the real previous close
    return base == null || !c.px ? base : (1 + base) * (l.p / c.px) - 1;
  }
  const funds = C.funds || [], fundOf = {}; funds.forEach((f) => { fundOf[f.sec] = f; });
  let fundHits = [], fromFund = {}, shownFund = {};
  const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  const nice = (x) => { const steps = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10]; return steps.find((s) => s >= x) || 15; };

  function stats() {
    return groups.map((g) => { const v = g.list.map(val).filter((x) => x != null); return { nm: g.nm, med: median(v), up: v.filter((x) => x > 0).length, n: v.length, eur: v.length ? 100 * (1 + v.reduce((a, x) => a + x, 0) / v.length) : null }; });
  }

  function draw() {
    pending = false;
    const W = Math.max(900, wrap.clientWidth), AX = 46, AMP = 96, Y = AMP + 14, FUND = funds.length ? 218 : 0, H = Y + AMP + 92 + FUND, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const UP = css("--up"), DOWN = css("--down"), INK = css("--text-primary"), MUTED = css("--text-muted"), GRID = css("--grid");
    const all = cells.map(val).filter((x) => x != null).map(Math.abs).sort((a, b) => a - b);
    const cap = nice(all[Math.floor(all.length * 0.97)] || 0.02), sy = AMP / cap, sw = (W - AX) / groups.length, st = stats(), now = performance.now();
    // percent grid
    g.font = "12px system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "right";
    [-1, -0.5, 0.5, 1].forEach((f) => { if (f * cap < -1) return; const y = Y - f * AMP; g.fillStyle = GRID; g.fillRect(AX, y, W - AX, 1); g.fillStyle = MUTED; g.fillText(pct(f * cap, cap < 0.1 ? 1 : 0), AX - 6, y); });
    g.fillStyle = MUTED; g.fillText("0%", AX - 6, Y);
    hits = [];
    const k01 = Math.min(1, (now - glide) / GLIDE), ease = k01 < 0.5 ? 4 * k01 * k01 * k01 : 1 - Math.pow(-2 * k01 + 2, 3) / 2;
    const mix = (a, b) => (a == null || b == null ? b : a + (b - a) * ease);
    shownSt = [];
    groups.forEach((grp, k) => {
      const x0 = AX + k * sw, pad = 7, step = (sw - pad * 2) / grp.list.length, bw = Math.max(1, step - (step > 3 ? 1 : 0.3));
      grp.list.forEach((c, j) => {
        const v = val(c); if (v == null) return;
        const cx = x0 + pad + step * (j + 0.5), over = Math.abs(v) > cap && k01 >= 1;
        const target = Math.max(-cap, Math.min(cap, v)) * sy, start = from[c.s] == null ? target : from[c.s], px = start + (target - start) * ease;   // signed height in pixels
        const h = Math.max(1.5, Math.abs(px)), up = px >= 0, top = up ? Y - h : Y;
        g.fillStyle = up ? UP : DOWN; g.fillRect(cx - bw / 2, top, bw, h);
        if (over) { g.fillStyle = INK; g.fillRect(cx - bw / 2, up ? top - 3 : top + h + 1, bw, 2); }   // goes beyond the picture
        const l = live[c.s], fresh = l && l.flash && now - l.flash < 900, hov = hover === c.s;
        if (fresh || hov) { g.strokeStyle = INK; g.lineWidth = 1.5; g.strokeRect(cx - bw / 2 - 1.5, top - 1.5, bw + 3, h + 3); }
        hits.push({ x: cx, half: Math.max(step / 2, 1.5), c, v, px });
      });
      const s0 = st[k], f0 = fromSt && fromSt[k];
      const medPx = s0.med == null ? null : mix(f0 ? f0.medPx : null, Math.max(-cap, Math.min(cap, s0.med)) * sy);
      const s = { up: s0.up, n: s0.n, med: mix(f0 ? f0.med : null, s0.med), eur: mix(f0 ? f0.eur : null, s0.eur) };   // numbers count smoothly to the new real value
      shownSt.push({ med: s.med, eur: s.eur, medPx });
      if (s.med != null) {   // the middle company of the category
        const y = Y - medPx;
        g.fillStyle = css("--surface-1"); g.fillRect(x0 + pad - 2, y - 3, sw - pad * 2 + 4, 6);
        g.fillStyle = INK; g.fillRect(x0 + pad - 2, y - 1.5, sw - pad * 2 + 4, 3);
      }
      g.fillStyle = MUTED; if (k > 0) g.fillRect(x0, Y - AMP, 1, AMP * 2);
      g.fillStyle = INK; g.fillRect(x0 + sw / 2 - 1, Y + AMP + 4, 2, 8);
      g.textAlign = "center"; g.textBaseline = "alphabetic";
      g.font = "600 12.5px system-ui, sans-serif"; g.fillStyle = INK; g.fillText(SHORT[grp.nm] || grp.nm, x0 + sw / 2, Y + AMP + 27);
      if (s.med != null) { g.font = "800 15px system-ui, sans-serif"; g.fillStyle = s.med >= 0 ? UP : DOWN; g.fillText(pct(s.med), x0 + sw / 2, Y + AMP + 45); }
      g.font = "12px system-ui, sans-serif"; g.fillStyle = MUTED; g.fillText(s.up + " of " + s.n + " up", x0 + sw / 2, Y + AMP + 61);
      if (s.eur != null) {   // 100 euros split equally over every company of the category at the start of the period
        g.fillStyle = MUTED; g.fillText("\u20ac100 became", x0 + sw / 2, Y + AMP + 76);
        g.font = "800 14px system-ui, sans-serif"; g.fillStyle = s.eur >= 100 ? UP : DOWN; g.fillText(eur(s.eur), x0 + sw / 2, Y + AMP + 91 - 1);
      }
    });
    g.fillStyle = INK; g.fillRect(AX, Y - 1, W - AX, 2);   // the one straight line
    if (FUND) {   // second line: one bar per category fund, same colours, same percent scale
      const A2 = 50, T = Y + AMP + 92 + 6, Y2 = T + 34 + A2;
      const fmax = Math.max(0.005, ...funds.map((f) => Math.abs(val(f) || 0))), cap2 = nice(fmax), s2 = A2 / cap2;   // the funds get their own percent scale, so their bars are easy to see
      g.textAlign = "left"; g.textBaseline = "alphabetic"; g.font = "700 14px system-ui, sans-serif"; g.fillStyle = INK;
      g.fillText("Category funds: each category bought as one basket (big companies count more)", AX, T + 18);
      g.font = "12px system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "right";
      [-1, 1].forEach((f) => { if (f * cap2 < -1) return; const y = Y2 - f * A2; g.fillStyle = GRID; g.fillRect(AX, y, W - AX, 1); g.fillStyle = MUTED; g.fillText(pct(f * cap2, cap2 < 0.1 ? 1 : 0), AX - 6, y); });
      g.fillStyle = MUTED; g.fillText("0%", AX - 6, Y2);
      fundHits = []; shownFund = {};
      groups.forEach((grp, k) => {
        const f = fundOf[grp.nm], x0 = AX + k * sw, cx = x0 + sw / 2;
        g.fillStyle = MUTED; if (k > 0) g.fillRect(x0, Y2 - A2, 1, A2 * 2);
        if (!f) return;
        const v = val(f); if (v == null) return;
        const target = Math.max(-cap2, Math.min(cap2, v)) * s2, start = fromFund[f.s] == null ? target : fromFund[f.s].px, px = start + (target - start) * ease;
        const shownV = mix(fromFund[f.s] ? fromFund[f.s].v : null, v), bw = Math.min(46, sw * 0.42), h = Math.max(2, Math.abs(px)), up = px >= 0, top = up ? Y2 - h : Y2;
        shownFund[f.s] = { px, v: shownV };
        g.fillStyle = up ? UP : DOWN; g.fillRect(cx - bw / 2, top, bw, h);
        if (Math.abs(v) > cap2 && k01 >= 1) { g.fillStyle = INK; g.fillRect(cx - bw / 2, up ? top - 3 : top + h + 1, bw, 2); }
        const l = live[f.s], fresh = l && l.flash && now - l.flash < 900;
        if (fresh || hover === f.s) { g.strokeStyle = INK; g.lineWidth = 1.5; g.strokeRect(cx - bw / 2 - 1.5, top - 1.5, bw + 3, h + 3); }
        fundHits.push({ x: cx, half: bw / 2 + 4, y0: Y2 - A2, y1: Y2 + A2, f, v });
        g.textAlign = "center"; g.textBaseline = "alphabetic";
        g.font = "600 12.5px system-ui, sans-serif"; g.fillStyle = INK; g.fillText(f.s, cx, Y2 + A2 + 18);
        g.font = "800 15px system-ui, sans-serif"; g.fillStyle = shownV >= 0 ? UP : DOWN; g.fillText(pct(shownV), cx, Y2 + A2 + 36);
        g.font = "12px system-ui, sans-serif"; g.fillStyle = MUTED; g.fillText("\u20ac100 became", cx, Y2 + A2 + 51);
        g.font = "800 14px system-ui, sans-serif"; g.fillStyle = shownV >= 0 ? UP : DOWN; g.fillText(eur(100 * (1 + shownV)), cx, Y2 + A2 + 66);
      });
      g.fillStyle = INK; g.fillRect(AX, Y2 - 1, W - AX, 2);
    }
    lead(st);
  }

  function lead(st) {
    const P = PERIODS[period], up = st.reduce((a, s) => a + s.up, 0), n = st.reduce((a, s) => a + s.n, 0);
    const allV = cells.map(val).filter((x) => x != null), allEur = 100 * (1 + allV.reduce((a, x) => a + x, 0) / allV.length);
    const ok = st.filter((s) => s.med != null).sort((a, b) => b.med - a.med), liveN = Object.keys(live).length;
    box.querySelector("#sig-lead").innerHTML = `<b>${up} of ${n}</b> companies went up ${P[2]}. Strongest category: <b>${ok[0].nm}</b> (<b class="${ok[0].med >= 0 ? "up" : "down"}">${pct(ok[0].med)}</b>). Weakest: <b>${ok[ok.length - 1].nm}</b> (<b class="${ok[ok.length - 1].med >= 0 ? "up" : "down"}">${pct(ok[ok.length - 1].med)}</b>).`
      + ` \u20ac100 split over all ${n} companies became <b class="${allEur >= 100 ? "up" : "down"}">${eur(allEur)}</b>.`
      + (liveN ? ` <span class="count">live prices in ${liveN} companies</span>` : "");
  }

  // where the trading went in the same period (counted from the nightly money report)
  function money() {
    const el = box.querySelector("#sig-money");
    if (!F || !F.days || !F.days.length) { el.textContent = ""; return; }
    const want = PERIODS[period][3], days = F.days.slice(-want), short = want > F.days.length + 5, cnt = F.names.map((nm, k) => ({ nm, i: days.filter((d) => d.rows[k][5] === 1).length, o: days.filter((d) => d.rows[k][5] === -1).length }));
    const ins = cnt.filter((x) => x.i).sort((a, b) => b.i - a.i).slice(0, 3), outs = cnt.filter((x) => x.o).sort((a, b) => b.o - a.o).slice(0, 3);
    const fmt = (a, key) => a.map((x) => `<b>${x.nm}</b>` + (days.length > 1 ? ` (${x[key]} ${x[key] === 1 ? "day" : "days"})` : "")).join(", ");
    el.innerHTML = `<b>Where the trading went${short ? " (the daily money record covers the last year only)" : ""}:</b> ` + (ins.length || outs.length
      ? (ins.length ? `money came <b class="up">in</b> to ${fmt(ins, "i")}. ` : "") + (outs.length ? `Money went <b class="down">out</b> of ${fmt(outs, "o")}. ` : "")
      : "nothing unusual, every category got about its usual slice. ") + `<a href="#" id="sig-more">See the money report</a>`;
    el.querySelector("#sig-more").onclick = (e) => { e.preventDefault(); const t = document.querySelector('#view-seg button[data-view="flow"]'); if (t) { t.click(); window.scrollTo({ top: 0 }); } };
  }

  function at(e) {
    const b = cv.getBoundingClientRect(), x = e.clientX - b.left; let best = null;
    const y = e.clientY - b.top, fh = fundHits.find((h) => y >= h.y0 && y <= h.y1 && Math.abs(h.x - x) <= h.half);
    if (fh) return { fund: true, c: fh.f, v: fh.v, x: fh.x, half: fh.half };
    if (fundHits.length && y > fundHits[0].y0 - 40) return null;
    hits.forEach((h) => { const dx = Math.abs(h.x - x); if (dx <= h.half + 0.5 && (!best || dx < Math.abs(best.x - x))) best = h; });
    return best;
  }
  cv.addEventListener("mousemove", (e) => {
    const h = at(e), was = hover; hover = h ? h.c.s : null;
    if (was !== hover) draw();
    cv.style.cursor = h ? "pointer" : "default";
    if (!h || !tip) { if (tip) tip.hidden = true; return; }
    if (h.fund) tip.innerHTML = `<b>${h.c.s}: ${h.c.sec} fund</b><div><span>A US fund that holds this category's S&P 500 companies</span><span></span></div><div><span>Change, ${PERIODS[period][0].toLowerCase()}</span><span>${pct(h.v)}</span></div><div><span>Last close</span><span>$${h.c.px.toFixed(2)}</span></div>` + (live[h.c.s] ? `<div><span>Live price</span><span>$${live[h.c.s].p.toFixed(2)}</span></div>` : "");
    else tip.innerHTML = `<b>${h.c.n} (${h.c.s})</b><div><span>${h.c.sec}</span><span></span></div><div><span>Price change, ${PERIODS[period][0].toLowerCase()}</span><span>${pct(h.v)}</span></div>` + (live[h.c.s] ? `<div><span>Live price</span><span>$${live[h.c.s].p.toFixed(2)}</span></div>` : "");
    tip.hidden = false; tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + "px"; tip.style.top = e.clientY + 14 + "px";
  });
  cv.addEventListener("mouseleave", () => { hover = null; if (tip) tip.hidden = true; draw(); });
  cv.addEventListener("click", (e) => { const h = at(e); if (h && !h.fund && window.STOCKLAB_OPEN) { if (tip) tip.hidden = true; window.STOCKLAB_OPEN(h.c.s); } });
  if (window.STOCKLAB_PERIOD) window.STOCKLAB_PERIOD.mount();
  window.addEventListener("stocklab-period", (e) => {   // the cell and the line always show the same period
    if (!PERIODS[e.detail.key]) return;
    from = {}; hits.forEach((h) => { from[h.c.s] = h.px; });   // glide from the old picture to the new one
    fromSt = shownSt; fromFund = shownFund; GLIDE = e.detail.dur || 700;
    period = e.detail.key; hover = null; glide = performance.now(); money(); tween();
  });
  function tween() { draw(); if (performance.now() - glide < GLIDE) requestAnimationFrame(tween); }
  window.addEventListener("resize", () => { if (cv.offsetParent) draw(); });
  window.addEventListener("stocklab-cell", () => draw());
  const later = (ms) => { if (!pending) { pending = true; setTimeout(draw, ms); } };
  window.addEventListener("stocklab-tick", (e) => {
    const d = e.detail; if (!d || !d.p) return;
    const l = live[d.s] || (live[d.s] = {}); l.p = d.p; if (d.pc) l.pc = d.pc;
    if (d.changed) { l.flash = performance.now(); setTimeout(() => later(0), 950); }
    if (cv.offsetParent) later(200);
  });
  draw(); money();
})();
