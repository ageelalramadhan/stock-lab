/* Stock Lab front end (ranker version).
   data/cell.js        : universe, rankings, track record (written nightly)
   data/stocks/SYM.js  : one stock's detail, loaded on click
   Finnhub (your key)  : tentacles stream live, other stocks refresh in rotation */
(function () {
  "use strict";

  const CELL = window.CELL;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const KEY_NAME = "stocklab_finnhub_key";

  if (!CELL || !CELL.cells || !CELL.cells.length) {
    $("#updated").textContent = "No data yet. The nightly run will fill this in.";
    return;
  }

  $("#updated").textContent = "Brain retrained " + CELL.generated + ", prices through " + CELL.data_through;
  document.querySelectorAll(".bsize").forEach((el) => (el.textContent = CELL.basket_size));

  const cells = CELL.cells;
  const bySym = Object.fromEntries(cells.map((c) => [c.s, c]));
  const tentacles = new Set(CELL.tentacles);
  const live = {};
  const details = (window.STOCK_DETAIL = window.STOCK_DETAIL || {});
  const T = CELL.test || {}, B = T.brain || {}, M = T.momentum || {};
  let selected = (cells.find((c) => c.rk === 1) || cells[0]).s;
  let rangeDays = 126, sortKey = "rank", scope = "all", colorKey = "rank";

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
  const topPct = (p) => (p == null ? "n/a" : p >= 0.5 ? "top " + Math.max(1, Math.round((1 - p) * 100)) + "%" : "bottom " + Math.max(1, Math.round(p * 100)) + "%");
  const shortDate = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

  function verdict(s) {
    if (!s || !s.months) return { cls: "warn", text: "Not tested yet" };
    if (s.t >= 2 && s.spread > 0) return { cls: "good", text: "Works, unlikely to be luck" };
    if (s.t >= 1 && s.spread > 0) return { cls: "warn", text: "Promising, could still be luck" };
    if (s.t > -1) return { cls: "warn", text: "No clear effect" };
    return { cls: "bad", text: "Works backwards" };
  }
  const tagHtml = (v) => `<span class="tag ${v.cls}"><i></i>${v.text}</span>`;

  const price = (c) => (live[c.s] && live[c.s].price) || c.px;
  function today(c) {
    const l = live[c.s];
    if (l && l.price) { const prev = l.prevClose || c.px; return prev ? l.price / prev - 1 : c.d1; }
    return c.d1;
  }

  // ---------- header stats ----------
  function renderStats() {
    const liveCount = Object.values(live).filter((l) => l.price).length;
    const scored = (CELL.baskets || []).filter((b) => b.scored);
    const v = verdict(B);
    $("#stats").innerHTML = [
      [cells.length, "stocks in the cell"],
      [CELL.ranked, "ranked each night"],
      [tentacles.size, "tentacles (" + liveCount + " live prices in)"],
      [B.months ? `${B.spread_wins} of ${B.months}` : "n/a", "months the top beat the bottom (test)"],
      [B.months ? pct(B.spread) : "n/a", "avg monthly gap, top vs bottom (test)"],
      [M.months ? pct(M.spread) : "n/a", "same gap, momentum only"],
      [scored.length, "live months scored"],
    ].map(([val, l]) => `<div class="stat"><b>${val}</b><span>${l}</span></div>`).join("") +
      `<div class="stat"><b style="font-size:13px;margin:4px 0">${tagHtml(v)}</b><span>brain's verdict so far</span></div>`;
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
    ["map", "list", "track"].forEach((k) => ($("#" + k + "-view").hidden = v !== k));
    if (v === "list") renderList();
    if (v === "map") resizeMap();
    if (v === "track") renderTrack();
  });
  seg("#color-seg", "color", (v) => {
    colorKey = v;
    $("#scale-lo").textContent = v === "rank" ? "Bottom" : "-4%";
    $("#scale-hi").textContent = v === "rank" ? "Top" : "+4%";
  });
  seg("#scope-seg", "scope", (v) => { scope = v; renderList(); });
  seg("#sort-seg", "sort", (v) => { sortKey = v; renderList(); });
  seg("#range-seg", "days", (v) => { rangeDays = +v; drawChart(true); });
  $("#search").addEventListener("change", (e) => {
    const s = e.target.value.trim().toUpperCase();
    if (bySym[s]) { select(s); e.target.value = ""; }
  });

  // ---------- rankings list ----------
  function renderList() {
    if ($("#list-view").hidden) return;
    const rows = scope === "t" ? cells.filter((c) => tentacles.has(c.s)) : cells.slice();
    const val = {
      symbol: (c) => c.s, today: (c) => -(today(c) ?? -9),
      rank: (c) => c.rk ?? 1e9, mom: (c) => -(c.mom ?? -9),
    }[sortKey];
    rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0));
    $("#watch-table tbody").innerHTML = rows.map((c) => {
      const t = today(c);
      const earn = c.en ? "next " + shortDate(c.en) : c.es != null ? "beat " + pct(c.es, 0) : "";
      return `<tr data-sym="${c.s}" class="${c.s === selected ? "sel" : ""}">
        <td class="r rk">${c.rk ?? "n/a"}</td>
        <td><span class="sym">${c.s}</span>${c.pin ? '<span class="pin">pinned</span>' : ""}<span class="sub">${c.n}</span></td>
        <td class="r" data-price="${c.s}">${money(price(c))}</td>
        <td class="r"><span class="${signCls(t)}">${pct(t)}</span></td>
        <td class="r"><span class="${signCls(c.sc)}">${pct(c.sc)}</span></td>
        <td class="r">${pct(c.mom, 0)}</td>
        <td class="small muted">${earn.replace("beat -", "missed -")}</td></tr>`;
    }).join("");
  }
  $("#watch-table tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-sym]");
    if (tr) select(tr.dataset.sym);
  });

  // ---------- track record ----------
  const LC = window.LightweightCharts;
  let trackChart = null;
  function renderTrack() {
    if (!trackChart) {
      trackChart = LC.createChart($("#track-chart"), {
        autoSize: true,
        layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
        grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
        rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
        localization: { priceFormatter: (p) => (p * 100).toFixed(0) + "%" },
      });
      const s = T.series || [];
      const b = trackChart.addLineSeries({ color: "#3987e5", lineWidth: 2, priceLineVisible: false });
      const m = trackChart.addLineSeries({ color: css("--text-muted"), lineWidth: 2, priceLineVisible: false });
      b.setData(s.map((x) => ({ time: x.time, value: x.brain })));
      m.setData(s.map((x) => ({ time: x.time, value: x.momentum })));
      trackChart.timeScale().fitContent();
    }
    const card = (title, s) => {
      const v = verdict(s);
      return `<div class="card"><h3>${title}</h3>
        <div class="kv"><span>Months tested</span><span>${s.months || 0}</span></div>
        <div class="kv"><span>Top beat bottom</span><span>${s.spread_wins ?? 0} of ${s.months || 0} months</span></div>
        <div class="kv"><span>Average monthly gap</span><span>${pct(s.spread)}</span></div>
        <div class="kv"><span>Ranking accuracy (0 = random)</span><span>${s.ic == null ? "n/a" : s.ic.toFixed(3)}</span></div>
        <div class="kv"><span>Luck score (above 2 = real)</span><span>${s.t == null ? "n/a" : s.t.toFixed(1)}</span></div>
        <div style="margin-top:8px">${tagHtml(v)}</div></div>`;
    };
    $("#track-cards").innerHTML = card("Brain", B) + card("Momentum only", M);

    const bs = (CELL.baskets || []).slice().reverse();
    $("#baskets tbody").innerHTML = bs.length ? bs.map((b) => {
      if (!b.scored) return `<tr><td>${b.formed}</td><td colspan="4" class="muted">scored about one month later</td><td><span class="muted">waiting</span></td></tr>`;
      const gap = b.top_ret - b.bottom_ret;
      return `<tr><td>${b.formed}</td><td class="r">${pct(b.top_ret)}</td><td class="r">${pct(b.bottom_ret)}</td>
        <td class="r"><span class="${signCls(gap)}">${pct(gap)}</span></td><td class="r">${pct(b.spy_ret)}</td>
        <td>${gap > 0 ? '<span class="tag good"><i></i>Top won</span>' : '<span class="tag bad"><i></i>Bottom won</span>'}</td></tr>`;
    }).join("") : '<tr><td colspan="6" class="muted">First ranking freezes on the next nightly run.</td></tr>';
    const cur = bs[0];
    $("#basket-picks").innerHTML = cur ? `<b>Current top ${CELL.basket_size}</b> (frozen ${cur.formed}): ${cur.top.join(", ")}<br><b>Current bottom ${CELL.basket_size}:</b> ${cur.bottom.join(", ")}` : "";
  }

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
    if (!sectors.includes(sec)) return [W / 2, Hh / 2];
    const a = (sectors.indexOf(sec) / sectors.length) * Math.PI * 2 - Math.PI / 2;
    return [W / 2 + Math.cos(a) * W * 0.32, Hh / 2 + Math.sin(a) * Hh * 0.32];
  }
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(28).strength((l) => (l.w - 0.5) * 0.15))
    .force("charge", d3.forceManyBody().strength(-6))
    .force("x", d3.forceX((d) => sectorCenter(d.c.sec)[0]).strength(0.07))
    .force("y", d3.forceY((d) => sectorCenter(d.c.sec)[1]).strength(0.07))
    .force("collide", d3.forceCollide((d) => d.r + 1.5))
    .alphaDecay(0.02).stop();

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

  const colRank = d3.scaleLinear().domain([0, 0.5, 1]).range(["#e66767", "#6b6a65", "#3987e5"]).clamp(true);
  const colD1 = d3.scaleLinear().domain([-0.04, 0, 0.04]).range(["#e66767", "#6b6a65", "#3987e5"]).clamp(true);
  const nodeColor = (n) => (colorKey === "rank" ? (n.c.pct == null ? "#4a4a46" : colRank(n.c.pct)) : colD1(today(n.c) ?? 0));
  const surface = css("--surface-1");
  let hover = null, transform = d3.zoomIdentity;
  const t0 = performance.now();

  function draw(now) {
    if (!$("#map-view").hidden && W) {
      sim.tick();
      nodes.forEach((n) => { n.vx += (Math.random() - 0.5) * 0.05; n.vy += (Math.random() - 0.5) * 0.05; });
      const t = (now - t0) / 1000, k = transform.k, cx = W / 2, cy = Hh / 2;
      ctx.save();
      ctx.clearRect(0, 0, W, Hh);
      ctx.translate(transform.x, transform.y);
      ctx.scale(k, k);
      const focus = hover || nodeById[selected];
      const near = focus ? neighbors[focus.id] || new Set() : new Set();

      ctx.lineWidth = 0.6 / k;
      links.forEach((l) => {
        const hot = focus && (l.source.id === focus.id || l.target.id === focus.id);
        ctx.strokeStyle = hot ? "rgba(240,239,236,0.55)" : "rgba(195,194,183,0.07)";
        ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke();
      });

      let i = 0;
      nodes.forEach((n) => {
        if (!tentacles.has(n.id)) return;
        i++;
        const mx = (cx + n.x) / 2, my = (cy + n.y) / 2, dx = n.x - cx, dy = n.y - cy, len = Math.hypot(dx, dy) || 1;
        const wob = Math.sin(t * 1.3 + i) * 18;
        const l = live[n.id];
        const pulse = l && l.pulse ? Math.max(0, 1 - (now - l.pulse) / 1200) : 0;
        ctx.strokeStyle = `rgba(201,133,0,${0.22 + pulse * 0.6})`;
        ctx.lineWidth = (1.2 + pulse * 1.5) / k;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(mx - (dy / len) * wob, my + (dx / len) * wob, n.x, n.y); ctx.stroke();
      });

      const nr = 16 + Math.sin(t * 2) * 2;
      const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, nr * 2.2);
      g.addColorStop(0, "rgba(201,133,0,0.9)"); g.addColorStop(0.45, "rgba(201,133,0,0.25)"); g.addColorStop(1, "rgba(201,133,0,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, nr * 2.2, 0, Math.PI * 2); ctx.fill();

      nodes.forEach((n) => {
        ctx.globalAlpha = focus && n !== focus && !near.has(n.id) ? 0.45 : 1;
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

      ctx.font = `${11 / k}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      nodes.forEach((n) => {
        if (!(n === focus || n.r > 11 || (k > 1.6 && tentacles.has(n.id)) || k > 2.6)) return;
        ctx.fillStyle = n === focus ? "#f0efec" : "rgba(240,239,236,0.75)";
        ctx.fillText(n.id, n.x, n.y - n.r - 4 / k);
      });
      ctx.restore();

      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(143,142,134,0.9)";
      ctx.textAlign = "center";
      sectors.forEach((s) => {
        const [x, y] = sectorCenter(s);
        const label = s.toUpperCase(), half = ctx.measureText(label).width / 2 + 8;
        const sx = Math.min(W - half, Math.max(half, transform.applyX(x + (x - W / 2) * 0.33)));
        const sy = Math.min(Hh - 8, Math.max(16, transform.applyY(y + (y - Hh / 2) * 0.38)));
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
      <div><span>Brain rank</span><span>${c.rk ? c.rk + " of " + CELL.ranked + " (" + topPct(c.pct) + ")" : "not ranked"}</span></div>
      <div><span>vs. market, next month</span><span>${pct(c.sc)}</span></div>
      <div><span>Price</span><span>${money(price(c))}</span></div>
      <div><span>Today</span><span>${pct(today(c))}</span></div>
      <div><span>12-month momentum</span><span>${pct(c.mom, 0)}</span></div>
      ${c.en ? `<div><span>Next earnings</span><span>${c.en}</span></div>` : ""}`;
    let x = e.clientX + 16;
    if (x + 260 > window.innerWidth) x -= 280;
    mapTip.style.left = x + "px"; mapTip.style.top = e.clientY + 16 + "px"; mapTip.hidden = false;
  });
  canvas.addEventListener("mouseleave", () => { hover = null; mapTip.hidden = true; });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (n) select(n.id);
  });
  d3.select(canvas).call(d3.zoom().scaleExtent([0.6, 6]).on("zoom", (e) => { transform = e.transform; }));

  // ---------- stock chart ----------
  const chart = LC.createChart($("#chart"), {
    autoSize: true,
    layout: { background: { color: surface }, textColor: css("--text-muted"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: { mode: LC.CrosshairMode.Normal },
  });
  const up = css("--up"), down = css("--down");
  const candles = chart.addCandlestickSeries({ upColor: "rgba(0,0,0,0)", downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, priceLineVisible: false });
  const line = (color, extra = {}) => chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
  const ma20 = line(css("--ma20")), ma50 = line(css("--ma50"));
  const fcMid = line(css("--forecast"), { lineStyle: LC.LineStyle.Dashed });
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
    const p = d.call.path;
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
      rows.push(["Brain's tilt", money(fm.value)]);
      if (lo && hi) rows.push(["Typical swing", money(lo.value) + " to " + money(hi.value)]);
    }
    if (!rows.length) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${param.time}</b>` + rows.map((r) => `<div><span>${r[0]}</span><span>${r[1]}</span></div>`).join("");
    const box = $("#chart").getBoundingClientRect();
    let x = box.left + param.point.x + 16;
    if (x + 200 > window.innerWidth) x -= 220;
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
    $("#sel-sub").textContent = c.sec + (tentacles.has(c.s) ? (c.pin ? ", pinned tentacle" : ", tentacle (brain's top pick, streams live)") : ", refreshed in rotation");
    const t = today(c);
    $("#sel-price").textContent = money(price(c));
    $("#sel-change").innerHTML = `<span class="${signCls(t)}">${pct(t, 2)} today</span>`;
  }
  function renderDetail() {
    const d = details[selected];
    if (!d) return;
    renderHeader();
    const p = d.performance, k = d.call, e = d.earnings || {};
    $("#perf").innerHTML = [
      ["1 week", pct(p.change_1w)], ["1 month", pct(p.change_1m)], ["3 months", pct(p.change_3m)],
      ["Year to date", pct(p.change_ytd)], ["1 year", pct(p.change_1y)],
      ["52-week range", money(p.low_52w) + " to " + money(p.high_52w)],
      ["Volatility (yearly)", p.volatility_annual == null ? "n/a" : Math.round(p.volatility_annual * 100) + "%"],
    ].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");

    if (!d.ranked) {
      $("#call").innerHTML = '<p class="note">Benchmarks (SPY, QQQ) are the yardstick, so they are not ranked.</p>';
      $("#why").innerHTML = "";
    } else {
      const end = k.path[k.path.length - 1];
      $("#call").innerHTML = `
        <div class="big-rank">#${k.rank} <span class="muted small">of ${k.of}</span></div>
        <div class="kv"><span>Position</span><span>${topPct(k.pct)}</span></div>
        <div class="kv"><span>Expected vs. typical stock</span><span class="${signCls(k.score)}">${pct(k.score)}</span></div>
        <div class="kv"><span>Typical swing, 1 month</span><span>${money(end.low).split(".")[0]} to ${money(end.high).split(".")[0]}</span></div>
        <p class="note">A ranking, not a price target. The brain's expected edge is small next to how much the stock usually swings, so read the overall verdict in Track record before trusting any single rank.</p>`;
      $("#why").innerHTML = (k.why || []).map((w) => {
        if (w.kind === "pct") {
          const v = w.pct == null ? null : w.pct;
          return `<div class="bar-row"><div class="lbl"><span>${w.label}</span><span>${v == null ? "n/a" : "higher than " + Math.round(v * 100) + "%"}</span></div>
            <div class="bar"><div style="width:${v == null ? 0 : v * 100}%"></div></div></div>`;
        }
        const txt = w.kind === "surprise" ? (w.value == null ? "no recent report" : pct(w.value, 0)) : (w.value == null ? "n/a" : w.value + " days");
        return `<div class="kv"><span>${w.label}</span><span>${txt}</span></div>`;
      }).join("") + `<p class="note">The brain's most important inputs, and where this stock stands against all other stocks today.</p>`;
    }

    $("#earn").innerHTML = `
      <div class="kv"><span>Last report</span><span>${e.last_date || "not in data yet"}</span></div>
      <div class="kv"><span>Surprise vs. estimate</span><span>${e.last_surprise == null ? "n/a" : pct(e.last_surprise, 0)}</span></div>
      <div class="kv"><span>Next report</span><span>${e.next_date || "not announced"}</span></div>
      <p class="note">Earnings data builds up nightly. The brain starts using it once there is enough history.</p>`;

    const rows = (d.diary || []).slice().reverse();
    $("#diary tbody").innerHTML = rows.length ? rows.map((r) => {
      const done = r.end_close != null;
      const ex = r.excess;
      const res = !done ? '<span class="muted">waiting</span>'
        : ((r.pct >= 0.5) === (ex >= 0) ? '<span class="tag good"><i></i>Rank was right</span>' : '<span class="tag bad"><i></i>Rank was wrong</span>');
      return `<tr><td>${r.formed}</td><td class="r">#${r.rank}</td><td class="r">${money(r.base_close)}</td>
        <td class="r">${done ? pct(r.ret) : ""}</td><td class="r">${done ? pct(ex) : ""}</td><td>${res}</td></tr>`;
    }).join("") : '<tr><td colspan="6" class="muted">No frozen rankings yet.</td></tr>';
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
  const toFinnhub = (s) => s.replace("-", ".");
  const fromFinnhub = (s) => s.replace(".", "-");
  let ws = null, rotTimer = null, redraw = false, rotIdx = 0, rotRound = 0;
  const rotation = [...CELL.tentacles, ...cells.map((c) => c.s).filter((s) => !tentacles.has(s))];

  function scheduleRedraw() {
    if (redraw) return;
    redraw = true;
    setTimeout(() => {
      redraw = false;
      renderList(); renderStats();
      if (details[selected]) { renderHeader(); drawChart(false); }
    }, 1500);
  }
  async function rotateOnce(key) {
    const sym = rotation[rotIdx];
    rotIdx = (rotIdx + 1) % rotation.length;
    if (rotIdx === 0) rotRound++;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(toFinnhub(sym))}&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) { status("warn", "Key rejected"); clearInterval(rotTimer); return; }
      if (r.status === 429) return;
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
    if (!key) { status("", "Live off (add a key)"); return; }
    status("warn", "Connecting...");
    rotTimer = setInterval(() => rotateOnce(key), 1100); // ~55 a minute, under the free limit of 60
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
  for (let i = 0; i < 250; i++) sim.tick();
  requestAnimationFrame(draw);
  select(selected);
  connect();
})();
