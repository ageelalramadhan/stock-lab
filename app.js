/* Stock Lab, version 3: everything is built on one number per company,
   the chance that its price is higher one month from now.
   data/cell.js       : all companies, their chances, the day's story, the reliability test
   data/stocks/SYM.js : one company's detail, loaded when you click it */
(function () {
  "use strict";
  const CELL = window.CELL;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY_NAME = "stocklab_finnhub_key";
  if (!CELL || !CELL.cells || !CELL.odds) { $("#cell-lead").textContent = "No data yet. It arrives with the next nightly run."; return; }

  const O = CELL.odds, TD = CELL.today || {}, H = CELL.horizon_days;
  const all = CELL.cells, bySym = Object.fromEntries(all.map((c) => [c.s, c]));
  const cos = all.filter((c) => c.p != null && c.sec !== "Benchmark");
  const details = (window.STOCK_DETAIL = window.STOCK_DETAIL || {});
  const live = {};
  $("#sym-list").innerHTML = all.map((c) => `<option value="${esc(c.s)}">${esc(c.n)}</option>`).join("");

  // ---------- words ----------
  const pc = (x) => Math.round(x * 100) + "%";
  const pct = (x, d = 1) => (x == null ? "n/a" : (x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
  const money = (x) => (x == null ? "n/a" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const moved = (x, d = 0) => (x == null ? "no data" : Math.abs(x) < 0.0005 ? "flat" : (x > 0 ? "rose " : "fell ") + (Math.abs(x) * 100).toFixed(d) + "%");
  const signCls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");
  const dayName = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "the latest day");
  const nyDate = (ms) => new Date(ms).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  const lean = (p) => (p >= 0.6 ? "Leans up" : p >= 0.55 ? "Leans slightly up" : p > 0.45 ? "Close to a coin flip" : p > 0.4 ? "Leans slightly down" : "Leans down");
  const price = (c) => (live[c.s] && live[c.s].price) || c.px;
  const todayMove = (c) => { const l = live[c.s]; return l && l.price && l.prevClose ? l.price / l.prevClose - 1 : c.d1; };

  // ---------- scales shared by the cell and the cards ----------
  const ps = cos.map((c) => c.p).sort((a, b) => a - b);
  const q = (f) => ps[Math.min(ps.length - 1, Math.floor(f * ps.length))];
  const P_LO = Math.min(q(0.02), 0.47), P_HI = Math.max(q(0.98), 0.53), P_MID = q(0.5);
  const span = Math.max(P_HI - 0.5, 0.5 - P_LO);
  const colP = d3.scaleLinear().domain([0.5 - span, 0.5, 0.5 + span]).range(["#e66767", "#6b6a65", "#3987e5"]).clamp(true);

  // ---------- the cell ----------
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
  secs.forEach((s) => s.list.forEach((c, i) => nodes.push({ c, sec: s, ang: s.a0 + ((i + 0.5) / s.list.length) * (s.a1 - s.a0), rr: 0 })));
  const nodeOf = Object.fromEntries(nodes.map((n) => [n.c.s, n]));
  const labelled = new Set(cos.slice().sort((a, b) => b.dv - a.dv).slice(0, 12).map((c) => c.s));
  const rOf = (p) => R * (0.2 + 0.7 * Math.max(0, Math.min(1, (p - P_LO) / (P_HI - P_LO))));

  function layout() {
    const box = $("#cell-wrap").getBoundingClientRect();
    if (!box.width) return;
    const dpr = window.devicePixelRatio || 1;
    W = Math.min(box.width, box.height || box.width);
    canvas.width = box.width * dpr; canvas.height = W * dpr;
    canvas.style.height = W + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = box.width / 2; CY = W / 2; R = Math.min(box.width, W) / 2 - (box.width < 520 ? 46 : 62);
    const rs = d3.scaleSqrt().domain([0, maxDv]).range([R * 0.008 + 1.2, R * 0.034 + 2]);
    nodes.forEach((n) => {
      n.rr = rs(n.c.dv);
      n.tx = CX + Math.cos(n.ang) * rOf(n.c.p); n.ty = CY + Math.sin(n.ang) * rOf(n.c.p);
      n.x = n.tx; n.y = n.ty;
    });
    const sim = d3.forceSimulation(nodes).force("x", d3.forceX((n) => n.tx).strength(0.35)).force("y", d3.forceY((n) => n.ty).strength(0.35))
      .force("hit", d3.forceCollide((n) => n.rr + 0.9).iterations(2)).stop();
    for (let i = 0; i < 160; i++) sim.tick();
  }

  // edge of the cell: pushed out where an industry leans up, pulled in where it leans down
  function edgeAt(a, t) {
    let k = secs.length - 1;
    for (let i = 0; i < secs.length; i++) if (a < secs[i].mid) { k = i - 1; break; }
    const s0 = secs[(k + secs.length) % secs.length], s1 = secs[(k + 1) % secs.length];
    let m0 = s0.mid, m1 = s1.mid;
    if (k < 0) m0 -= Math.PI * 2;
    if (k === secs.length - 1) m1 += Math.PI * 2;
    const u = (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, (a - m0) / (m1 - m0))))) / 2;
    const p = s0.p + (s1.p - s0.p) * u, vp = s0.vp + (s1.vp - s0.vp) * u;
    const bulge = Math.max(-1, Math.min(1, (p - P_MID) / (span * 0.6))) * R * 0.075;
    const amp = R * (0.004 + 0.02 * vp);
    const shake = amp * (Math.sin(a * 9 + t * (0.8 + vp)) * 0.6 + Math.sin(a * 17 - t * (1.3 + vp)) * 0.4);
    return { r: R * 1.0 + bulge + shake, p };
  }

  const t0 = performance.now();
  function draw(now) {
    if (!$("#cell-view").hidden && R > 0) {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // body of the cell
      const pts = [];
      for (let a = -Math.PI / 2; a < Math.PI * 1.5; a += 0.02) { const e = edgeAt(a, t); pts.push([CX + Math.cos(a) * e.r, CY + Math.sin(a) * e.r, e.p]); }
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      const g = ctx.createRadialGradient(CX, CY, R * 0.1, CX, CY, R * 1.05);
      g.addColorStop(0, "rgba(120,125,140,0.10)"); g.addColorStop(1, "rgba(57,135,229,0.04)");
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 3; ctx.lineCap = "round";
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        ctx.strokeStyle = colP(a[2]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }

      // rings of equal chance
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center";
      for (let v = Math.ceil(P_LO * 20) / 20; v <= P_HI + 1e-9; v += 0.05) {
        const rr = rOf(v), half = Math.abs(v - 0.5) < 0.001;
        ctx.setLineDash(half ? [] : [3, 5]);
        ctx.strokeStyle = half ? "rgba(240,239,236,0.45)" : "rgba(195,194,183,0.16)"; ctx.lineWidth = half ? 1.4 : 1;
        ctx.beginPath(); ctx.arc(CX, CY, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        const label = half ? "50/50" : pc(v), tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = css("--surface-1"); ctx.fillRect(CX - tw / 2, CY - rr - 7, tw, 14);
        ctx.fillStyle = half ? "#f0efec" : "rgba(195,194,183,0.8)"; ctx.fillText(label, CX, CY - rr + 4);
      }

      // borders between industries, and their names
      secs.forEach((s) => {
        const a = s.a0 - GAP / 2;
        ctx.strokeStyle = "rgba(195,194,183,0.12)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(CX + Math.cos(a) * R * 0.16, CY + Math.sin(a) * R * 0.16); ctx.lineTo(CX + Math.cos(a) * R * 0.97, CY + Math.sin(a) * R * 0.97); ctx.stroke();
        const lr = R * 1.0 + 30, x = CX + Math.cos(s.mid) * lr, y = CY + Math.sin(s.mid) * lr;
        // name on one or two lines, kept inside the picture
        const words = s.name.split(" "), lines = words.length > 1 && s.name.length > 13 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [s.name];
        lines.push(pc(s.p) + " on average");
        ctx.textAlign = "center";
        ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
        const half = Math.max(...lines.map((ln) => ctx.measureText(ln).width)) / 2 + 4;
        const xx = Math.min(CX * 2 - half, Math.max(half, x)), y0 = y - (lines.length - 1) * 6.5;
        lines.forEach((ln, i) => {
          const last = i === lines.length - 1;
          ctx.font = (last ? "" : "600 ") + "11px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = last ? "rgba(195,194,183,0.85)" : "rgba(240,239,236,0.9)";
          ctx.fillText(ln, xx, y0 + i * 13);
        });
      });

      // companies
      const sel = nodeOf[selected];
      nodes.forEach((n) => {
        const col = colP(n.c.p), big = Math.abs(n.c.tz || 0) >= 2.5;
        ctx.globalAlpha = sel && n !== sel && n !== hover ? 0.8 : 1;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = "rgba(17,17,16,0.9)"; ctx.stroke();
        if (big) {
          const ph = (t * 0.28 + n.ang) % 1;
          ctx.globalAlpha = (1 - ph) * 0.8; ctx.strokeStyle = "#f0efec"; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.rr + 2 + ph * 12, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center";
      nodes.forEach((n) => {
        if (n !== sel && n !== hover && !(labelled.has(n.c.s) && R > 220)) return;
        if (n === sel || n === hover) { ctx.strokeStyle = "#f0efec"; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(n.x, n.y, n.rr + 3, 0, Math.PI * 2); ctx.stroke(); }
        ctx.fillStyle = "#f0efec"; ctx.fillText(n.c.s, n.x, n.y - n.rr - 5);
      });

      // the middle: the typical company
      ctx.textAlign = "center"; ctx.fillStyle = "rgba(195,194,183,0.85)"; ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("TYPICAL COMPANY", CX, CY - 8);
      ctx.fillStyle = "#f0efec"; ctx.font = "600 18px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(pc(P_MID), CX, CY + 12);
    }
    requestAnimationFrame(draw);
  }

  function nodeAt(e) {
    const b = canvas.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    let best = null, bd = 1e9;
    nodes.forEach((n) => { const d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.rr + 4, 8) && d < bd) { best = n; bd = d; } });
    return best;
  }
  const tipEl = $("#tip");
  canvas.addEventListener("mousemove", (e) => {
    hover = nodeAt(e);
    canvas.style.cursor = hover ? "pointer" : "default";
    if (!hover) { tipEl.hidden = true; return; }
    const c = hover.c;
    tipEl.innerHTML = `<b>${esc(c.s)}  ${esc(c.n)}</b>
      <div><span>Chance higher in a month</span><span>${pc(c.p)}</span></div>
      <div><span>${lean(c.p)}</span><span></span></div>
      <div><span>Latest day</span><span>${pct(todayMove(c))}</span></div>`;
    let x = e.clientX + 16; if (x + 250 > window.innerWidth) x -= 270;
    tipEl.style.left = x + "px"; tipEl.style.top = e.clientY + 16 + "px"; tipEl.hidden = false;
  });
  canvas.addEventListener("mouseleave", () => { hover = null; tipEl.hidden = true; });
  canvas.addEventListener("click", (e) => { const n = nodeAt(e); if (n) select(n.c.s); });
  window.addEventListener("resize", layout);

  // headline above the cell
  (function lead() {
    const up = cos.filter((c) => c.p > 0.5).length;
    const s = secs.slice().sort((a, b) => b.p - a.p);
    $("#cell-lead").innerHTML = `Each dot is a company. For the typical one, the chance of being higher a month from now is <b>${pc(P_MID)}</b>.
      <b>${up} of ${cos.length}</b> companies lean up. Most likely to rise: <b>${esc(s[0].name)}</b> (${pc(s[0].p)} on average). Least likely: <b>${esc(s[s.length - 1].name)}</b> (${pc(s[s.length - 1].p)}).`;
    $("#updated").textContent = `Updated ${CELL.generated}, with prices through ${CELL.data_through}. Recalculated every weekday night.`;
  })();

  // ---------- the company card ----------
  const FACT = {
    year: (v) => ["Its past year", `It ${moved(v[0])}, a better year than ${pc(v[1])} of companies.`],
    month: (v) => ["Its last month", `It ${moved(v[0])}, a better month than ${pc(v[1])} of companies.`],
    week: (v) => ["Its last week", `It ${moved(v[0], 1)}, a better week than ${pc(v[1])} of companies.`],
    jumpy: (v) => ["How jumpy it is", `About ${(v[0] / Math.sqrt(252) * 100).toFixed(1)}% up or down on a normal day, jumpier than ${pc(v[1])} of companies.`],
    trend: (v) => ["Its long-run direction", `The price is ${Math.round(Math.abs(v[0]) * 100)}% ${v[0] >= 0 ? "above" : "below"} its average of the last 200 days.`],
    industry: (v) => ["Its industry", `The industry as a group ${moved(v[0])} in 3 months.`],
    day: (v) => ["Its latest day", `It ${moved(v[0], 1)}, which is ${Math.abs(v[1] || 0).toFixed(1)}x a normal day for it.`],
    market: (v) => ["The whole market", `All stocks together ${moved(v[0], 1)} in the last month.`],
  };
  const FREQ = { year: "year", month: "month", week: "week", jumpy: "jumpy", trend: "trend", industry: "industry", day: "day", market: "market" };

  function renderWhy(o) {
    const base = O.freq.all.rate;
    const rows = o.why.filter((w) => Math.abs(w.d) >= 0.005).slice(0, 5);
    const scale = Math.max(0.05, ...rows.map((w) => Math.abs(w.d)));
    const html = rows.map((w) => {
      const [title, text] = FACT[w.k](w.v);
      const wdt = (Math.abs(w.d) / scale) * 50, upw = w.d > 0;
      // what history says about clues like this one
      let hist = "";
      const side = w.k === "day" ? ((w.v[1] || 0) >= 2.5 ? "high" : (w.v[1] || 0) <= -2.5 ? "low" : null)
        : w.k === "market" ? null : (w.v[1] >= 0.8 ? "high" : w.v[1] <= 0.2 ? "low" : null);
      const f = side && O.freq[FREQ[w.k] + "_" + side];
      if (f && (f.rate - base > 0) === (w.d > 0)) hist = ` In the past, companies like that ended the next month higher ${pc(f.rate)} of the time.`;
      return `<div class="why-row"><div class="t"><b>${title}</b><span>${text}${hist}</span></div>
        <div class="push"><em></em><i style="${upw ? "left:50%" : "right:50%"};width:${wdt}%;background:${upw ? "#3987e5" : "#e66767"}"></i></div>
        <div class="e">${upw ? "adds" : "takes off"} ${Math.max(1, Math.round(Math.abs(w.d) * 100))} pt${Math.round(Math.abs(w.d) * 100) > 1 ? "s" : ""}</div></div>`;
    }).join("");
    $("#why").innerHTML = `<p class="why-start">Any company ends a month higher about <b>${pc(base)}</b> of the time. For this one, these clues shift that:</p>
      ${html || '<p class="plain">Nothing stands out. This company looks ordinary right now, so its chance is close to the usual one.</p>'}
      ${rows.length < o.why.length && rows.length ? '<p class="muted small" style="margin:8px 0 0">The other clues barely change anything today.</p>' : ""}`;
  }

  function renderTrust(p) {
    const b = O.bins.find((x) => p * 100 >= x.lo && p * 100 < x.hi);
    const skill = 1 - O.brier / O.brier_base;
    const overall = skill > 0.01 ? "Overall the percentages have been a little better than a plain guess."
      : skill > -0.002 ? "Overall the percentages have been about as good as simply saying the usual chance for every company. Read them as rough odds, not as a signal."
      : "Overall the percentages have done worse than simply saying the usual chance for every company. Read them with caution.";
    $("#trust").innerHTML = (b ? `In the test, when the model said between ${b.lo}% and ${b.hi}%, the company really ended higher <b>${pc(b.happened)}</b> of the time (${b.n.toLocaleString("en-US")} cases). ` : "This percentage is rarer than anything in the test, so there is little evidence for it. ") + overall;
  }

  const CAUSE = {
    company: ["Company news", "Neither the market nor its industry moved like this, so it is about this company itself."],
    sector: ["Its whole industry moved", "The industry moved the same way, which usually means news that affects all of those companies."],
    market: ["The whole market moved", "Most stocks moved the same way, so it says little about this company."],
    quiet: ["A normal day", "A move this size is ordinary for it and carries no message."],
    earnings: ["Earnings report", "The company published its results."],
  };
  function renderExplain(c) {
    if (c.d1 == null || !c.tc) { $("#explain").innerHTML = "<p>No recent trading data.</p>"; return; }
    const ct = CAUSE[c.tc] || CAUSE.quiet, z = Math.abs(c.tz || 0);
    const mv = (TD.movers || []).find((m) => m.s === c.s);
    const news = mv && mv.news && mv.news.headline ? `<p>Headline that day: <a href="${esc(mv.news.url)}" target="_blank" rel="noopener">${esc(mv.news.headline)}</a> (${esc(mv.news.source)})</p>` : "";
    const l = live[c.s];
    const now = l && l.price && l.prevClose ? `<p>Right now (live): it ${moved(l.price / l.prevClose - 1, 1)} today.</p>` : "";
    $("#explain").innerHTML = `<p>On ${dayName(TD.date)} it <b>${moved(c.d1, 1)}</b>, ${z.toFixed(1)}x a normal day for it. The market ${moved(TD.market, 1)}, its industry ${moved(c.tsr, 1)}.</p>
      <p><b>${ct[0]}.</b> ${ct[1]}</p>${news}${now}`;
  }

  const LC = window.LightweightCharts;
  const chart = LC.createChart($("#chart"), {
    autoSize: true,
    layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, rightOffset: 2 },
    handleScroll: false, handleScale: false,
  });
  const priceLine = chart.addLineSeries({ color: "#3987e5", lineWidth: 2, priceLineVisible: false });
  const coneOpt = { color: css("--text-muted"), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const coneLo = chart.addLineSeries(coneOpt), coneHi = chart.addLineSeries(coneOpt);
  const MCOL = { earnings: "#d95926", market: "#c98500", sector: "#9085e9", company: "#3987e5" };

  function renderCompany() {
    const c = bySym[selected], d = details[selected];
    if (!c) return;
    $("#co-name").textContent = `${c.n} (${c.s})`;
    $("#co-sub").textContent = c.sec;
    const t = todayMove(c);
    $("#co-price").textContent = money(price(c));
    $("#co-change").innerHTML = `<span class="${signCls(t)}">${pct(t, 2)} latest day</span>`;
    renderExplain(c);
    if (c.p == null) {
      $("#ch-num").textContent = "n/a"; $("#ch-word").textContent = "Not scored"; $("#ch-fill").style.width = "0%";
      $("#ch-range").textContent = ""; $("#why").innerHTML = '<p class="plain">This one is a fund that tracks the whole market, so it is used as the yardstick.</p>'; $("#trust").textContent = "";
    } else {
      $("#ch-num").textContent = pc(c.p);
      $("#ch-fill").style.width = c.p * 100 + "%"; $("#ch-fill").style.background = colP(c.p);
      $("#ch-word").textContent = lean(c.p);
      renderTrust(c.p);
    }
    if (!d) return;
    if (d.odds) renderWhy(d.odds);
    const path = d.call.path, end = path[path.length - 1];
    if (c.p != null) $("#ch-range").textContent = `In a month it usually lands between ${money(end.low).split(".")[0]} and ${money(end.high).split(".")[0]} (8 times out of 10).`;
    const cd = d.candles.slice(-126).map((x) => ({ time: x[0], value: x[4] }));
    priceLine.setData(cd);
    coneLo.setData(path.map((x) => ({ time: x.time, value: x.low })));
    coneHi.setData(path.map((x) => ({ time: x.time, value: x.high })));
    const mv = ((d.moves && d.moves.top) || []);
    const first = cd[0].time;
    priceLine.setMarkers(mv.filter((m) => m.date >= first).map((m) => ({ time: m.date, position: m.ret > 0 ? "aboveBar" : "belowBar", color: MCOL[m.cause] || "#3987e5", shape: "circle", text: String(mv.indexOf(m) + 1) })));
    chart.timeScale().fitContent();
    $("#moves").innerHTML = mv.length ? mv.map((m, i) => {
      const ct = CAUSE[m.cause] || CAUSE.company;
      const news = m.news && m.news.headline ? `<br>Headline that day: <a href="${esc(m.news.url)}" target="_blank" rel="noopener">${esc(m.news.headline)}</a> (${esc(m.news.source)})` : "";
      return `<div class="move"><span class="num" style="border-color:${MCOL[m.cause] || "#3987e5"}">${i + 1}</span><span>${m.date}</span>
        <span class="${signCls(m.ret)}">${pct(m.ret)}</span><span class="why"><b>${ct[0]}</b>${news}<span class="muted">Market ${pct(m.market)}, its industry ${pct(m.sector)}</span></span></div>`;
    }).join("") : '<p class="plain">No unusually big days in the past year.</p>';
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
    const s = e.target.value.trim().toUpperCase();
    if (bySym[s]) { show("cell"); select(s); e.target.value = ""; }
  });

  // ---------- track record ----------
  let paperChart = null;
  function renderTrack() {
    const skill = 1 - O.brier / O.brier_base;
    $("#trust-lead").innerHTML = `The test: for ${O.months} months in a row, the model gave every company a percentage using only what was known at the time. A month later we checked.
      If the percentages are honest, a group that was given about 60% should end higher about 60% of the time. In those months, <b>${pc(O.base)}</b> of all companies ended higher.`;
    $("#calib").innerHTML = O.bins.map((b) => `<div class="calib-row"><span>When it said ${b.lo}% to ${b.hi}%</span>
      <div class="odds"><i style="width:${b.happened * 100}%"></i><em></em><b style="left:${b.said * 100}%" title="what it said"></b></div>
      <span class="r">higher ${pc(b.happened)} of the time <span class="muted small">(${b.n.toLocaleString("en-US")})</span></span></div>`).join("");
    const rising = O.bins.length > 1 && O.bins[O.bins.length - 1].happened > O.bins[0].happened + 0.03;
    $("#calib-note").innerHTML = `Blue bar: what really happened. Gold mark: what the model said. White line: 50/50. <b>${
      skill > 0.01 && rising ? "Verdict: higher percentages did go with rising more often, so the numbers carry a little real information."
        : rising ? "Verdict: higher percentages went with rising slightly more often, but overall the model was no better than giving every company the same chance. Treat the numbers as rough odds."
        : "Verdict: in this test the percentages did not separate winners from losers. Treat them as rough odds, not as a signal."}</b>
      Calling the direction right: ${pc(O.hit)} of the time, against ${pc(O.hit_base)} for always guessing the more common direction.`;

    const T = CELL.test || {}, P = T.paper || [];
    if (!P.length) return;
    const eur = (x) => "€" + Math.round(x).toLocaleString("de-DE");
    const last = P[P.length - 1], worst = Math.min(...P.slice(1).map((x) => x.b_ret)), worstS = Math.min(...P.slice(1).map((x) => x.s_ret));
    $("#paper-hero").innerHTML = `<div class="card"><span>Model's top 20</span><b>${eur(last.brain)}</b><span>after ${T.paper_months} months</span></div>
      <div class="card"><span>Just holding the market</span><b>${eur(last.spy)}</b><span>after ${T.paper_months} months</span></div>
      <div class="card"><span>Worst single month</span><b>${pct(worst, 0)}</b><span>market's worst: ${pct(worstS, 0)}</span></div>`;
    $("#paper-caveat").innerHTML = `<b>This result is flattered.</b> The test only knows companies that are big today, which includes ones that got big because they soared and leaves out ones that collapsed. Real results would be lower, and the ride was rough. A live version with no hindsight started on ${esc((CELL.paper_live || {}).started || "the first run")}.`;
    if (!paperChart) {
      paperChart = LC.createChart($("#paper-chart"), {
        autoSize: true, layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
        grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
        localization: { priceFormatter: eur }, handleScroll: false, handleScale: false,
      });
      [["brain", "#3987e5"], ["spy", "#c98500"]].forEach(([k, col]) => paperChart.addLineSeries({ color: col, lineWidth: 2, priceLineVisible: false }).setData(P.map((x) => ({ time: x.time, value: x[k] }))));
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

  // ---------- live prices (optional) ----------
  const status = (st, text) => { $("#live-status").className = "pill " + st; $("#live-text").textContent = text; };
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch (e) { return ""; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME); } catch (e) { /* ignore */ } };
  const toF = (s) => s.replace("-", "."), fromF = (s) => s.replace(".", "-");
  let ws = null, timer = null, idx = 0, pending = false;
  const streamed = (CELL.tentacles || []).slice(0, 50), order = [...streamed, ...all.map((c) => c.s).filter((s) => !streamed.includes(s))];
  const refresh = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (selected) renderCompany(); }, 1500); };
  async function poll(key) {
    const sym = order[idx]; idx = (idx + 1) % order.length;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(toF(sym))}&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) { status("warn", "Key rejected"); clearInterval(timer); return; }
      if (!r.ok) return;
      const qd = await r.json();
      if (qd && qd.c) { live[sym] = { price: qd.c, prevClose: qd.pc, day: nyDate(qd.t * 1000) }; if (sym === selected) refresh(); }
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
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== "trade" || !m.data) return;
      m.data.forEach((tr) => { const s = fromF(tr.s); (live[s] = live[s] || {}).price = tr.p; if (!live[s].prevClose && bySym[s]) live[s].prevClose = bySym[s].px; if (s === selected) refresh(); });
    };
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
