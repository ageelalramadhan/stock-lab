/* The money signal: one straight line, one section per category. Every spike is a real trading day
   (or a real week, in the year view). Nothing moves by itself: the picture changes only when the data does. */
(function () {
  const F = window.FLOWS, box = document.getElementById("signal");
  if (!box || !F || !F.days || !F.days.length) { if (box) box.hidden = true; return; }
  const N = F.names, D = F.days, tip = document.getElementById("tip");
  const SHORT = { "Information Technology": "Technology", "Consumer Discretionary": "Discretionary", "Consumer Staples": "Staples", "Communication Services": "Communication" };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pct = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
  const day = (s, o) => new Date(s + "T12:00:00").toLocaleDateString("en-GB", o || { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const PERIODS = { day: ["Day", 1], week: ["Week", 5], month: ["Month", 21], year: ["Year", D.length] };
  let period = "month", hits = [], hover = null;

  box.innerHTML = `<div class="sig-head"><div><h2>Where is the money going?</h2>
      <p class="lead" id="sig-lead"></p></div>
      <div class="seg" id="sig-seg">${Object.keys(PERIODS).map((k) => `<button data-p="${k}">${PERIODS[k][0]}</button>`).join("")}</div></div>
    <div id="sig-wrap"><canvas id="sig"></canvas></div>
    <div class="sig-key"><span><i class="fl-sw" style="background:var(--up)"></i>prices went up</span><span><i class="fl-sw" style="background:var(--down)"></i>prices went down</span>
      <span><b>Taller</b> = a bigger slice of all the trading than usual.</span><span><b>Strong colour</b> = clearly more than usual (money IN or OUT). Click a spike for the full story of that day.</span></div>`;
  const cv = box.querySelector("#sig"), wrap = box.querySelector("#sig-wrap");

  // the spikes for one category: one per day, or one per week in the year view
  function series(k) {
    const n = PERIODS[period][1], days = D.slice(-n).map((d, j) => ({ i: D.length - Math.min(n, D.length) + j, d: d.d, extra: d.rows[k][0], z: d.rows[k][1], move: d.rows[k][2], st: d.rows[k][5] }));
    if (period !== "year") return days;
    const out = [];
    for (let e = days.length; e > 0; e -= 5) {
      const w = days.slice(Math.max(0, e - 5), e), m = (f) => w.reduce((a, x) => a + f(x), 0) / w.length;
      const z = m((x) => x.z), move = w.reduce((a, x) => a * (1 + x.move), 1) - 1;
      out.unshift({ i: w[w.length - 1].i, d: w[0].d, d2: w[w.length - 1].d, extra: m((x) => x.extra), z, move, st: z >= F.z ? (move > 0 ? 1 : move < 0 ? -1 : 0) : 0, week: true,
        ins: w.filter((x) => x.st === 1).length, outs: w.filter((x) => x.st === -1).length });
    }
    return out;
  }

  function draw() {
    const W = Math.max(880, wrap.clientWidth), AMP = 64, Y = AMP + 10, H = Y + AMP + 58, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const UP = css("--up"), DOWN = css("--down"), INK = css("--text-primary"), MUTED = css("--text-muted"), sw = W / N.length;
    hits = [];
    N.forEach((nm, k) => {
      const s = series(k), x0 = k * sw, pad = 10, step = (sw - pad * 2) / s.length, bw = Math.max(1, Math.min(14, step - (step > 4 ? 2 : 0.4)));
      s.forEach((p, j) => {
        const cx = x0 + pad + step * (j + 0.5), h = p.z > 0 ? Math.max(3, (Math.min(p.z, 4) / 4) * AMP) : 3, up = p.move >= 0;
        g.globalAlpha = p.st !== 0 ? 1 : 0.32; g.fillStyle = up ? UP : DOWN;
        g.fillRect(cx - bw / 2, up ? Y - h : Y, bw, h);
        if (hover && hover.k === k && hover.j === j) { g.globalAlpha = 1; g.strokeStyle = INK; g.lineWidth = 1.5; g.strokeRect(cx - bw / 2 - 1.5, (up ? Y - h : Y) - 1.5, bw + 3, h + 3); }
        hits.push({ k, j, x: cx, half: Math.max(step / 2, 2), p });
      });
      g.globalAlpha = 1;
      // the category's mark on the line, and its name underneath
      g.fillStyle = INK; g.fillRect(x0 + sw / 2 - 1, Y + AMP + 2, 2, 9);
      g.fillStyle = MUTED; if (k > 0) g.fillRect(x0, Y - 6, 1, 12);
      g.fillStyle = INK; g.font = "600 12.5px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "alphabetic";
      g.fillText(SHORT[nm] || nm, x0 + sw / 2, Y + AMP + 26);
      const daysIn = D.slice(-PERIODS[period][1]), ins = daysIn.filter((d) => d.rows[k][5] === 1).length, outs = daysIn.filter((d) => d.rows[k][5] === -1).length;
      g.font = "12px system-ui, sans-serif";
      const a = ins + " in", b = "  " + outs + " out", wa = g.measureText(a).width, wb = g.measureText(b).width, sx = x0 + sw / 2 - (wa + wb) / 2;
      g.textAlign = "left"; g.fillStyle = ins ? UP : MUTED; g.fillText(a, sx, Y + AMP + 43); g.fillStyle = outs ? DOWN : MUTED; g.fillText(b, sx + wa, Y + AMP + 43);
    });
    g.fillStyle = INK; g.fillRect(0, Y - 1, W, 2);   // the one straight line
  }

  function lead() {
    const n = PERIODS[period][1], days = D.slice(-n), last = D[D.length - 1];
    const cnt = N.map((nm, k) => ({ nm, i: days.filter((d) => d.rows[k][5] === 1).length, o: days.filter((d) => d.rows[k][5] === -1).length }));
    const mi = cnt.slice().sort((a, b) => b.i - a.i)[0], mo = cnt.slice().sort((a, b) => b.o - a.o)[0];
    const span = period === "day" ? day(last.d) : `the last ${days.length} trading days (up to ${day(last.d, { day: "numeric", month: "short" })})`;
    const what = period === "year" ? "Each spike is one week." : period === "day" ? "Each spike is that one day." : "Each spike is one day.";
    const names = (v) => N.filter((_, k) => last.rows[k][5] === v).join(", ");
    if (period === "day") {
      box.querySelector("#sig-lead").innerHTML = `${what} Showing ${span}. ` + (names(1) || names(-1)
        ? (names(1) ? `Money came <b class="up">in</b> to <b>${names(1)}</b>. ` : "") + (names(-1) ? `Money went <b class="down">out</b> of <b>${names(-1)}</b>.` : "")
        : "Nothing unusual: every category got about its usual slice of the trading.");
    } else
    box.querySelector("#sig-lead").innerHTML = `${what} Showing ${span}. ` + (mi.i || mo.o
      ? `Money came <b class="up">in</b> most often to <b>${mi.i ? mi.nm : "no category"}</b>${mi.i ? " (" + mi.i + (mi.i === 1 ? " day" : " days") + ")" : ""}. Money went <b class="down">out</b> most often from <b>${mo.o ? mo.nm : "no category"}</b>${mo.o ? " (" + mo.o + (mo.o === 1 ? " day" : " days") + ")" : ""}.`
      : "Nothing unusual: every category got about its usual slice of the trading.");
    box.querySelectorAll("#sig-seg button").forEach((b) => b.classList.toggle("on", b.dataset.p === period));
  }

  function at(e) {
    const b = cv.getBoundingClientRect(), x = e.clientX - b.left; let best = null;
    hits.forEach((h) => { const dx = Math.abs(h.x - x); if (dx <= h.half + 0.5 && (!best || dx < Math.abs(best.x - x))) best = h; });
    return best;
  }
  cv.addEventListener("mousemove", (e) => {
    const h = at(e), was = hover; hover = h ? { k: h.k, j: h.j } : null;
    if (!!was !== !!hover || (was && hover && (was.k !== hover.k || was.j !== hover.j))) draw();
    cv.style.cursor = h ? "pointer" : "default";
    if (!h || !tip) { if (tip) tip.hidden = true; return; }
    const p = h.p, when = p.week ? "Week of " + day(p.d, { day: "numeric", month: "short" }) + " to " + day(p.d2, { day: "numeric", month: "short", year: "numeric" }) : day(p.d);
    tip.innerHTML = `<b>${N[h.k]}</b><div><span>${when}</span><span></span></div>
      <div><span>Slice of the trading</span><span>${p.extra >= 0 ? "+" : ""}${p.extra.toFixed(1)} of 100 vs usual</span></div>
      <div><span>Prices</span><span>${pct(p.move)}</span></div>
      <div><span>Reading</span><span>${p.week ? p.ins + " in days, " + p.outs + " out days" : p.st === 1 ? "money came in" : p.st === -1 ? "money went out" : "a normal day"}</span></div>`;
    tip.hidden = false; tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + "px"; tip.style.top = e.clientY + 14 + "px";
  });
  cv.addEventListener("mouseleave", () => { hover = null; if (tip) tip.hidden = true; draw(); });
  cv.addEventListener("click", (e) => {
    const h = at(e), tab = document.querySelector('#view-seg button[data-view="flow"]');
    if (!h || !tab) return;
    if (tip) tip.hidden = true;
    tab.click(); if (window.STOCKLAB_FLOW_PICK) window.STOCKLAB_FLOW_PICK(h.p.i); window.scrollTo({ top: 0 });
  });
  box.querySelector("#sig-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { period = b.dataset.p; hover = null; lead(); draw(); } });
  window.addEventListener("resize", () => { if (cv.offsetParent) draw(); });
  window.addEventListener("stocklab-cell", () => draw());
  lead(); draw();
})();
