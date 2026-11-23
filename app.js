/* Stock Lab front end.
   data/cell.js        : the whole universe (map + list), written nightly
   data/stocks/SYM.js  : one stock's detail, loaded when you click it
   Finnhub (your key)  : tentacles stream live, every other stock is refreshed in rotation */
(function () {
  "use strict";

  const CELL = window.CELL;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const KEY_NAME = "stocklab_finnhub_key";

  if (!CELL || !CELL.cells || !CELL.cells.length) {
    $("#updated").textContent = "No data yet. Run the 'Nightly retrain' workflow on GitHub, then pull.";
    return;
  }

  const H = CELL.horizon_days;
  document.querySelectorAll(".h-days").forEach((el) => (el.textContent = H));
  $("#updated").textContent = "Brain retrained " + CELL.generated + ", prices through " + CELL.data_through;

  const cells = CELL.cells;
  const bySym = Object.fromEntries(cells.map((c) => [c.s, c]));
  const tentacles = new Set(CELL.tentacles);
  const live = {}; // sym: {price, prevClose, open, high, low, day, pulse}
  const details = (window.STOCK_DETAIL = window.STOCK_DETAIL || {});
  let selected = CELL.tentacles[0] || cells[0].s;
  let rangeDays = 126, sortKey = "edge", scope = "t", colorKey = "d1";

  $("#sym-list").innerHTML = cells.map((c) => `<option value="${c.s}">${c.n}</option>`).join("");

  // ---------- formatting ----------
  const pct = (x, d = 1) => {
    if (x == null) return "n/a";
    const v = +(x * 100).toFixed(d);
    return (v > 0 ? "+" : "") + (v === 0 ? (0).toFixed(d) : v.toFixed(d)) + "%";
  };
  const money = (x) => (x == null ? "n/a" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const signCls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");
  const nyDate = (ms) => new Date(ms).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

  // z = edge measured in units of luck. Above 2: unlikely to be luck. 1 to 2: maybe. Below: noise.
  function tag(z, short) {
    if (z == null) return '<span class="tag warn"><i></i>Unknown</span>';
    if (z >= 2) return `<span class="tag good"><i></i>${short ? "Has edge" : "Beats guessing (unlikely luck)"}</span>`;
    if (z >= 1) return `<span class="tag warn"><i></i>${short ? "Maybe" : "Slight edge, could be luck"}</span>`;
    if (z >= -1) return '<span class="tag warn"><i></i>Coin flip</span>';
    return `<span class="tag bad"><i></i>${short ? "No edge" : "Worse than guessing"}</span>`;
  }
  const price = (c) => (live[c.s] && live[c.s].price) || c.px;
  function today(c) {
    const l = live[c.s];
    if (l && l.price) {
      const prev = l.prevClose || c.px;
      return prev ? l.price / prev - 1 : c.d1;
    }
    return c.d1;
  }

  // ---------- header stats ----------
  function renderStats() {
    const withEdge = cells.filter((c) => c.z != null && c.z >= 2).length;
    const liveCount = Object.values(live).filter((l) => l.price).length;
    const scored = cells.reduce((a, c) => a + (c.lvn || 0), 0);
    const o = CELL.overall || {};
    $("#stats").innerHTML = [
      [cells.length, "stocks in the cell"],
      [tentacles.size, "tentacles streaming"],
      [liveCount, "live prices received"],
      [(CELL.examples / 1e6).toFixed(2) + "M", "examples the brain learned from"],
      [o.direction_hit_rate != null ? Math.round(o.direction_hit_rate * 100) + "% vs " + Math.round(o.baseline_best_guess * 100) + "%" : "n/a", "brain vs. simple guessing (backtest)"],
      [withEdge, "stocks with an edge unlikely to be luck"],
      [scored, "live forecasts scored so far"],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  }

  // ---------- controls ----------
  function seg(id, attr, fn) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      document.querySelectorAll(id + " button").forEach((x) => x.classList.toggle("on", x === b));
      fn(b.dataset[attr]);
    });
  }
  seg("#view-seg", "view", (v) => {
    $("#map-view").hidden = v !== "map";
    $("#list-view").hidden = v !== "list";
    if (v === "list") renderList();
    else resizeMap();
  });
  seg("#color-seg", "color", (v) => {
    colorKey = v;
    $("#scale-lo").textContent = v === "d1" ? "-4%" : "-3%";
    $("#scale-hi").textContent = v === "d1" ? "+4%" : "+3%";
  });
  seg("#scope-seg", "scope", (v) => { scope = v; renderList(); });
  seg("#sort-seg", "sort", (v) => { sortKey = v; renderList(); });
  seg("#range-seg", "days", (v) => { rangeDays = +v; drawChart(true); });
  $("#search").addEventListener("change", (e) => {
    const s = e.target.value.trim().toUpperCase();
    if (bySym[s]) { select(s); e.target.value = ""; }
  });

  // ---------- list ----------
  function renderList() {
    if ($("#list-view").hidden) return;
    const rows = scope === "t" ? cells.filter((c) => tentacles.has(c.s)) : cells.slice();
    const val = {
      symbol: (c) => c.s, today: (c) => -(today(c) ?? 0),
      lean: (c) => -(c.exp ?? 0), edge: (c) => -(c.z ?? -9),
    }[sortKey];
    rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0));
    $("#watch-table tbody").innerHTML = rows.map((c) => {
      const t = today(c);
      return `<tr data-sym="${c.s}" class="${c.s === selected ? "sel" : ""}">
        <td><span class="sym">${c.s}</span>${c.pin ? '<span class="pin">pinned</span>' : ""}<span class="sub">${c.n}</span></td>
        <td class="r" data-price="${c.s}">${money(price(c))}</td>
        <td class="r"><span class="${signCls(t)}">${pct(t)}</span></td>
        <td class="r"><span class="${signCls(c.exp)}">${pct(c.exp)}</span></td>
        <td class="r">${c.pu == null ? "n/a" : Math.round(c.pu * 100) + "%"}</td>
        <td>${tag(c.z, true)}</td></tr>`;
    }).join("");
  }
  $("#watch-table tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-sym]");
    if (tr) select(tr.dataset.sym);
  });

  // ---------- cell map ----------
  const canvas = $("#map"), ctx = canvas.getContext("2d");
  let W = 0, Hh = 0;
  const sectors = [...new Set(cells.map((c) => c.sec))].filter((s) => s !== "Benchmark").sort();
  const maxDv = d3.max(cells, (c) => c.dv) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxDv]).range([2.5, 15]);
  const nodes = cells.map((c) => ({ id: c.s, c, r: rScale(c.dv) + (tentacles.has(c.s) ? 1.5 : 0) }));
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const links = CELL.links.filter((l) => nodeById[l[0]] && nodeById[l[1]]).map((l) => ({ source: l[0], target: l[1], w: l[2] }));
  const neighbors = {};
  links.forEach((l) => {
    (neighbors[l.source] = neighbors[l.source] || new Set()).add(l.target);
    (neighbors[l.target] = neighbors[l.target] || new Set()).add(l.source);
  });

  function sectorCenter(sec) {
    if (sec === "Benchmark" || !sectors.includes(sec)) return [W / 2, Hh / 2];
    const a = (sectors.indexOf(sec) / sectors.length) * Math.PI * 2 - Math.PI / 2;
    return [W / 2 + Math.cos(a) * W * 0.33, Hh / 2 + Math.sin(a) * Hh * 0.33];
  }

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(28).strength((l) => (l.w - 0.5) * 0.15))
    .force("charge", d3.forceManyBody().strength(-6))
    .force("x", d3.forceX((d) => sectorCenter(d.c.sec)[0]).strength(0.07))
    .force("y", d3.forceY((d) => sectorCenter(d.c.sec)[1]).strength(0.07))
    .force("collide", d3.forceCollide((d) => d.r + 1.5))
    .alphaDecay(0.02)
    .stop();

  function resizeMap() {
    const box = $("#map-wrap").getBoundingClientRect();
    if (!box.width) return;
    const dpr = window.devicePixelRatio || 1;
    W = box.width; Hh = box.height;
    canvas.width = W * dpr; canvas.height = Hh * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sim.force("x").x((d) => sectorCenter(d.c.sec)[0]);
    sim.force("y").y((d) => sectorCenter(d.c.sec)[1]);
    sim.alpha(0.6);
  }
  window.addEventListener("resize", resizeMap);

  const diverge = (lim) => d3.scaleLinear().domain([-lim, 0, lim]).range(["#e66767", "#6b6a65", "#3987e5"]).clamp(true);
  const colD1 = diverge(0.04), colExp = diverge(0.03);
  const nodeColor = (n) => (colorKey === "d1" ? colD1(today(n.c) ?? 0) : colExp(n.c.exp ?? 0));
  const surface = css("--surface-1");

  let hover = null, transform = d3.zoomIdentity;
  const t0 = performance.now();

  function draw(now) {
    if (!$("#map-view").hidden && W) {
      sim.tick();
      nodes.forEach((n) => { n.vx += (Math.random() - 0.5) * 0.05; n.vy += (Math.random() - 0.5) * 0.05; }); // breathing
      const t = (now - t0) / 1000;
      const k = transform.k;
      ctx.save();
      ctx.clearRect(0, 0, W, Hh);
      ctx.translate(transform.x, transform.y);
      ctx.scale(k, k);
      const cx = W / 2, cy = Hh / 2;
      const focus = hover || nodeById[selected];
      const near = focus ? neighbors[focus.id] || new Set() : new Set();

      // threads between stocks that move together
      ctx.lineWidth = 0.6 / k;
      links.forEach((l) => {
        const hot = focus && (l.source.id === focus.id || l.target.id === focus.id);
        ctx.strokeStyle = hot ? "rgba(240,239,236,0.55)" : "rgba(195,194,183,0.07)";
        ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke();
      });

      // tentacles: wavy curves from the brain to each tentacle stock, brighter when a price arrives
      let i = 0;
      nodes.forEach((n) => {
        if (!tentacles.has(n.id)) return;
        i++;
        const mx = (cx + n.x) / 2, my = (cy + n.y) / 2;
        const dx = n.x - cx, dy = n.y - cy, len = Math.hypot(dx, dy) || 1;
        const wob = Math.sin(t * 1.3 + i) * 18;
        const px = mx - (dy / len) * wob, py = my + (dx / len) * wob;
        const l = live[n.id];
        const pulse = l && l.pulse ? Math.max(0, 1 - (now - l.pulse) / 1200) : 0;
        ctx.strokeStyle = `rgba(201,133,0,${0.22 + pulse * 0.6})`;
        ctx.lineWidth = (1.2 + pulse * 1.5) / k;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(px, py, n.x, n.y); ctx.stroke();
      });

      // the shared brain (nucleus)
      const nr = 16 + Math.sin(t * 2) * 2;
      const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, nr * 2.2);
      g.addColorStop(0, "rgba(201,133,0,0.9)"); g.addColorStop(0.45, "rgba(201,133,0,0.25)"); g.addColorStop(1, "rgba(201,133,0,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, nr * 2.2, 0, Math.PI * 2); ctx.fill();

      // stocks
      nodes.forEach((n) => {
        ctx.globalAlpha = focus && n !== focus && !near.has(n.id) ? 0.4 : 1;
        ctx.fillStyle = nodeColor(n);
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 1.5 / k; ctx.strokeStyle = surface; ctx.stroke();
        if (tentacles.has(n.id) || n === focus) {
          ctx.strokeStyle = "#f0efec"; ctx.lineWidth = (n === focus ? 2.4 : 1.6) / k;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2, 0, Math.PI * 2); ctx.stroke();
        }
        const l = live[n.id];
        if (l && l.pulse) {
          const p = (now - l.pulse) / 1000;
          if (p < 1) {
            ctx.strokeStyle = `rgba(240,239,236,${1 - p})`; ctx.lineWidth = 1.2 / k;
            ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2 + p * 10, 0, Math.PI * 2); ctx.stroke();
          }
        }
      });
      ctx.globalAlpha = 1;

      // labels
      ctx.font = `${11 / k}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      nodes.forEach((n) => {
        const show = n === focus || n.r > 11 || (k > 1.6 && tentacles.has(n.id)) || k > 2.6;
        if (!show) return;
        ctx.fillStyle = n === focus ? "#f0efec" : "rgba(240,239,236,0.75)";
        ctx.fillText(n.id, n.x, n.y - n.r - 4 / k);
      });
      ctx.restore();

      // sector names
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(143,142,134,0.9)";
      ctx.textAlign = "center";
      sectors.forEach((s) => {
        const [x, y] = sectorCenter(s);
        const ox = x + (x - W / 2) * 0.33, oy = y + (y - Hh / 2) * 0.38;
        const label = s.toUpperCase(), half = ctx.measureText(label).width / 2 + 8;
        const sx = Math.min(W - half, Math.max(half, transform.applyX(ox)));
        const sy = Math.min(Hh - 8, Math.max(16, transform.applyY(oy)));
        ctx.fillText(label, sx, sy);
      });
    }
    requestAnimationFrame(draw);
  }

  function nodeAt(mx, my) {
    const [x, y] = transform.invert([mx, my]);
    let best = null, bd = Infinity;
    nodes.forEach((n) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < Math.max(n.r + 4, 8 / transform.k) && d < bd) { best = n; bd = d; }
    });
    return best;
  }
  const mapTip = $("#map-tip");
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    hover = nodeAt(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = hover ? "pointer" : "grab";
    if (!hover) { mapTip.hidden = true; return; }
    const c = hover.c;
    mapTip.innerHTML = `<b>${c.s}  ${c.n}</b>
      <div><span>Sector</span><span>${c.sec}</span></div>
      <div><span>Price</span><span>${money(price(c))}</span></div>
      <div><span>Today</span><span>${pct(today(c))}</span></div>
      <div><span>Next ${H} days</span><span>${pct(c.exp)}</span></div>
      <div><span>Chance up</span><span>${c.pu == null ? "n/a" : Math.round(c.pu * 100) + "%"}</span></div>
      <div><span>Reliability</span><span>${tag(c.z, true)}</span></div>
      ${tentacles.has(c.s) ? "<div><span>Tentacle</span><span>streams live</span></div>" : ""}`;
    let x = e.clientX + 16;
    if (x + 240 > window.innerWidth) x -= 260;
    mapTip.style.left = x + "px"; mapTip.style.top = e.clientY + 16 + "px"; mapTip.hidden = false;
  });
  canvas.addEventListener("mouseleave", () => { hover = null; mapTip.hidden = true; });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (n) select(n.id);
  });
  d3.select(canvas).call(d3.zoom().scaleExtent([0.6, 6]).on("zoom", (e) => { transform = e.transform; }));

  // ---------- chart ----------
  const LC = window.LightweightCharts;
  const chart = LC.createChart($("#chart"), {
    autoSize: true,
    layout: { background: { color: surface }, textColor: css("--text-muted"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: { mode: LC.CrosshairMode.Normal },
  });
  const up = css("--up"), down = css("--down");
  const candles = chart.addCandlestickSeries({ upColor: "rgba(0,0,0,0)", downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, priceLineVisible: false });
  const line = (color, extra = {}) => chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
  const ma20 = line(css("--ma20")), ma50 = line(css("--ma50"));
  const fcMid = line(css("--forecast"), { lineStyle: LC.LineStyle.Dashed, lastValueVisible: true });
  const fcLow = line(css("--text-muted"), { lineStyle: LC.LineStyle.Dashed, lineWidth: 1 });
  const fcHigh = line(css("--text-muted"), { lineStyle: LC.LineStyle.Dashed, lineWidth: 1 });

  function candleData(d) {
    const c = d.candles.map((x) => ({ time: x[0], open: x[1], high: x[2], low: x[3], close: x[4] }));
    const l = live[d.symbol];
    if (l && l.price && l.day) {
      const last = c[c.length - 1];
      if (l.day > last.time) c.push({ time: l.day, open: l.open || l.price, high: Math.max(l.high || l.price, l.price), low: Math.min(l.low || l.price, l.price), close: l.price });
      else if (l.day === last.time) c[c.length - 1] = { ...last, close: l.price, high: Math.max(last.high, l.price), low: Math.min(last.low, l.price) };
    }
    return c;
  }
  function movingAvg(c, n) {
    const out = [];
    let sum = 0;
    c.forEach((x, i) => {
      sum += x.close;
      if (i >= n) sum -= c[i - n].close;
      if (i >= n - 1) out.push({ time: x.time, value: sum / n });
    });
    return out;
  }

  function drawChart(fit) {
    const d = details[selected];
    if (!d) return;
    const c = candleData(d);
    candles.setData(c);
    ma20.setData(movingAvg(c, 20));
    ma50.setData(movingAvg(c, 50));
    const p = d.forecast.path;
    fcMid.setData(p.map((x) => ({ time: x.time, value: x.mid })));
    fcLow.setData(p.map((x) => ({ time: x.time, value: x.low })));
    fcHigh.setData(p.map((x) => ({ time: x.time, value: x.high })));
    if (fit) chart.timeScale().setVisibleRange({ from: c[Math.max(0, c.length - rangeDays)].time, to: p[p.length - 1].time });
  }

  const tip = $("#tooltip");
  chart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.point) { tip.hidden = true; return; }
    const cd = param.seriesData.get(candles), fm = param.seriesData.get(fcMid);
    const rows = [];
    if (cd && cd.open != null) rows.push(["Open", money(cd.open)], ["High", money(cd.high)], ["Low", money(cd.low)], ["Close", money(cd.close)]);
    const a20 = param.seriesData.get(ma20), a50 = param.seriesData.get(ma50);
    if (a20) rows.push(["20-day avg", money(a20.value)]);
    if (a50) rows.push(["50-day avg", money(a50.value)]);
    if (fm && (!cd || cd.open == null)) {
      const lo = param.seriesData.get(fcLow), hi = param.seriesData.get(fcHigh);
      rows.push(["Forecast", money(fm.value)]);
      if (lo && hi) rows.push(["Range", money(lo.value) + " to " + money(hi.value)]);
    }
    if (!rows.length) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${param.time}</b>` + rows.map((r) => `<div><span>${r[0]}</span><span>${r[1]}</span></div>`).join("");
    const box = $("#chart").getBoundingClientRect();
    let x = box.left + param.point.x + 16;
    if (x + 190 > window.innerWidth) x -= 210;
    tip.style.left = x + "px"; tip.style.top = box.top + param.point.y + 16 + "px"; tip.hidden = false;
  });
  $("#chart").addEventListener("mouseleave", () => (tip.hidden = true));

  // ---------- detail ----------
  function loadDetail(sym, cb) {
    if (details[sym]) return cb();
    const s = document.createElement("script");
    s.src = "data/stocks/" + encodeURIComponent(sym) + ".js";
    s.onload = cb;
    s.onerror = () => { $("#sel-sub").textContent = "Detail file missing for " + sym; };
    document.body.appendChild(s);
  }

  function renderHeader() {
    const c = bySym[selected];
    $("#sel-title").textContent = `${c.s}  ${c.n}`;
    $("#sel-sub").textContent = c.sec + (tentacles.has(c.s) ? (c.pin ? ", pinned tentacle" : ", tentacle (streams live)") : ", refreshed in rotation");
    const t = today(c);
    $("#sel-price").textContent = money(price(c));
    $("#sel-change").innerHTML = `<span class="${signCls(t)}">${pct(t, 2)} today</span>`;
  }

  function renderDetail() {
    const d = details[selected];
    if (!d) return;
    renderHeader();
    const p = d.performance, f = d.forecast, b = d.backtest || {}, lv = d.live || {};
    $("#perf").innerHTML = [
      ["1 week", pct(p.change_1w)], ["1 month", pct(p.change_1m)], ["3 months", pct(p.change_3m)],
      ["Year to date", pct(p.change_ytd)], ["1 year", pct(p.change_1y)],
      ["52-week range", money(p.low_52w) + " to " + money(p.high_52w)],
      ["Volatility (yearly)", p.volatility_annual == null ? "n/a" : Math.round(p.volatility_annual * 100) + "%"],
      ["RSI (14 days)", p.rsi_14 == null ? "n/a" : p.rsi_14 + (p.rsi_14 > 70 ? " (overbought)" : p.rsi_14 < 30 ? " (oversold)" : "")],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

    const end = f.path[f.path.length - 1];
    const lean = f.expected_return > 0.005 ? "leans up" : f.expected_return < -0.005 ? "leans down" : "sees no clear direction";
    $("#forecast").innerHTML = `
      <div class="kv"><span>Expected move</span><span class="${signCls(f.expected_return)}">${pct(f.expected_return)}</span></div>
      <div class="kv"><span>Target price (middle)</span><span>${money(end.mid)}</span></div>
      <div class="kv"><span>Likely range (80%)</span><span>${money(end.low)} to ${money(end.high)}</span></div>
      <div class="kv"><span>Chance it is higher</span><span>${Math.round(f.prob_up * 100)}%</span></div>
      <p class="note">From the ${f.base_date} close, the brain ${lean} by ${end.time}.</p>`;

    const liveLine = lv.scored
      ? `<div class="kv"><span>Live record (${lv.scored} scored)</span><span>${Math.round(lv.direction_hit_rate * 100)}% right</span></div>
         <div class="kv"><span>Landed inside range</span><span>${Math.round(lv.in_band_rate * 100)}%</span></div>`
      : `<div class="kv"><span>Live record</span><span class="muted">starts after ${H} trading days</span></div>`;
    $("#quality").innerHTML = b.direction_hit_rate == null ? '<p class="note">Not enough history to test.</p>' : `
      <div class="kv"><span>Direction right (backtest)</span><span>${Math.round(b.direction_hit_rate * 100)}%</span></div>
      <div class="kv"><span>Simple guess would get</span><span>${Math.round(b.baseline_best_guess * 100)}%</span></div>
      <div class="kv"><span>Edge over guessing</span><span>${(b.edge >= 0 ? "+" : "") + Math.round(b.edge * 100)} pts</span></div>
      ${liveLine}
      <div style="margin-top:8px">${tag(b.z)}</div>
      <p class="note">Tested on ${b.days_tested} past days the brain never saw. Luck score ${b.z == null ? "n/a" : b.z.toFixed(1)}: above 2 means the edge is unlikely to be luck.</p>`;

    $("#drivers").innerHTML = (f.drivers || []).map((x) => `<div class="bar-row"><div class="lbl"><span>${x.feature}</span><span>${Math.round(x.share * 100)}%</span></div>
      <div class="bar"><div style="width:${Math.min(100, x.share * 250)}%"></div></div></div>`).join("") +
      `<p class="note">Share of the forecast's sensitivity for this stock. Patterns, not reasons.</p>`;

    const hist = (d.history || []).slice().reverse();
    $("#diary tbody").innerHTML = hist.length ? hist.map((r) => {
      const done = r.actual_close != null;
      const res = !done ? '<span class="muted">waiting</span>'
        : (+r.direction_hit ? '<span class="tag good"><i></i>Direction right</span>' : '<span class="tag bad"><i></i>Direction wrong</span>')
          + (+r.in_band ? ' <span class="muted small">in range</span>' : ' <span class="muted small">outside range</span>');
      return `<tr><td>${r.base_date}</td><td class="r">${money(r.base_close)}</td><td class="r">${pct(r.pred_mid)}</td>
        <td class="r">${pct(r.pred_low)} to ${pct(r.pred_high)}</td><td class="r">${done ? pct(r.actual_return) : ""}</td><td>${res}</td></tr>`;
    }).join("") : '<tr><td colspan="6" class="muted">No predictions logged yet.</td></tr>';
  }

  function select(sym) {
    selected = sym;
    renderList();
    loadDetail(sym, () => { if (selected === sym) { renderDetail(); drawChart(true); } });
  }

  // ---------- live data ----------
  const status = (state, text) => { $("#live-status").className = "pill " + state; $("#live-text").textContent = text; };
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch { return ""; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME); } catch {} };
  const toFinnhub = (s) => s.replace("-", ".");   // BRK-B is BRK.B on Finnhub
  const fromFinnhub = (s) => s.replace(".", "-");

  let ws = null, rotTimer = null, redraw = false, rotIdx = 0, rotRound = 0;
  const rotation = [...CELL.tentacles, ...cells.map((c) => c.s).filter((s) => !tentacles.has(s))];

  function scheduleRedraw() {
    if (redraw) return;
    redraw = true;
    setTimeout(() => {
      redraw = false;
      renderList(); renderStats();
      if (details[selected]) { renderDetail(); drawChart(false); }
    }, 1500);
  }

  async function rotateOnce(key) {
    const sym = rotation[rotIdx];
    rotIdx = (rotIdx + 1) % rotation.length;
    if (rotIdx === 0) rotRound++;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(toFinnhub(sym))}&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) { status("warn", "Key rejected"); clearInterval(rotTimer); return; }
      if (r.status === 429) return; // over the limit, skip this beat
      const q = await r.json();
      if (q && q.c) {
        const l = live[sym] || (live[sym] = {});
        Object.assign(l, { price: q.c, prevClose: q.pc, open: q.o, high: q.h, low: q.l, day: nyDate(q.t * 1000), pulse: performance.now() });
        if (!(ws && ws.readyState === 1)) status("on", `Rotating quotes (round ${rotRound + 1})`);
        scheduleRedraw();
      }
    } catch (e) { /* network blip */ }
  }

  function connect() {
    const key = getKey();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearInterval(rotTimer);
    if (!key) { status("", "Live off"); return; }
    status("warn", "Connecting...");
    rotTimer = setInterval(() => rotateOnce(key), 1100); // about 55 a minute, under the free limit of 60

    ws = new WebSocket("wss://ws.finnhub.io?token=" + encodeURIComponent(key));
    ws.onopen = () => {
      CELL.tentacles.forEach((s) => ws.send(JSON.stringify({ type: "subscribe", symbol: toFinnhub(s) })));
      status("on", `Live: ${tentacles.size} streaming, ${cells.length - tentacles.size} rotating`);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== "trade" || !m.data) return;
      for (const tr of m.data) {
        const sym = fromFinnhub(tr.s);
        const l = live[sym] || (live[sym] = {});
        const day = nyDate(tr.t);
        if (l.day !== day) { l.day = day; l.open = tr.p; l.high = tr.p; l.low = tr.p; }
        l.price = tr.p; l.high = Math.max(l.high, tr.p); l.low = Math.min(l.low, tr.p); l.pulse = performance.now();
        const cell = document.querySelector(`[data-price="${sym}"]`);
        if (cell) { cell.textContent = money(tr.p); cell.classList.remove("flash"); void cell.offsetWidth; cell.classList.add("flash"); }
      }
      scheduleRedraw();
    };
    ws.onclose = () => { status("warn", "Stream paused, retrying"); setTimeout(() => { if (getKey()) connect(); }, 15000); };
  }

  const dlg = $("#key-dialog");
  $("#key-btn").addEventListener("click", () => { $("#key-input").value = getKey(); dlg.showModal(); });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save") setKey($("#key-input").value.trim());
    if (dlg.returnValue === "clear") setKey("");
    connect();
  });

  // ---------- start ----------
  renderStats();
  resizeMap();
  nodes.forEach((n) => { const [x, y] = sectorCenter(n.c.sec); n.x = x + (Math.random() - 0.5) * 60; n.y = y + (Math.random() - 0.5) * 60; });
  for (let i = 0; i < 250; i++) sim.tick(); // settle before first frame
  requestAnimationFrame(draw);
  select(selected);
  connect();
})();
