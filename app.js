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
  let rangeDays = 126, sortKey = "rank", scope = "all", colorKey = "d1";

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
    ["play", "paper", "map", "list", "track"].forEach((k) => ($("#" + k + "-view").hidden = v !== k));
    document.body.classList.toggle("playing", v === "play");
    document.body.classList.toggle("cellview", v === "map");
    if (v === "list") renderList();
    if (v === "map") { resizeMap(); if (!settled) { settle(); } }
    if (v === "track") renderTrack();
    if (v === "paper") renderPaper();
  });
  seg("#color-seg", "color", (v) => {
    colorKey = v;
    $("#scale-lo").textContent = v === "rank" ? "expected to trail" : "fell 4%";
    $("#scale-hi").textContent = v === "rank" ? "expected to lead" : "rose 4%";
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

  // ---------- paper portfolio ----------
  const eur = (x) => (x == null ? "n/a" : "\u20ac" + Math.round(x).toLocaleString("de-DE"));
  let paperChart = null;
  function renderPaper() {
    const P = T.paper || [];
    $("#cost").textContent = ((T.cost || 0) * 100).toFixed(1) + "%";
    if (P.length) {
      const last = P[P.length - 1], first = P[0];
      const card = (label, v, sub) => `<div class="card"><span>${label}</span><b>${eur(v)}</b><span>${sub}</span></div>`;
      $("#paper-hero").innerHTML =
        card("Brain's top " + CELL.basket_size, last.brain, pct(last.brain / first.brain - 1, 0) + " in " + T.paper_months + " months") +
        card("Just holding the S&P 500", last.spy, pct(last.spy / first.spy - 1, 0) + " in " + T.paper_months + " months") +
        card("Momentum rule", last.momentum, pct(last.momentum / first.momentum - 1, 0) + " in " + T.paper_months + " months");
      $("#paper-caveat").innerHTML = `Starting with ${eur(first.brain)} on ${first.time}. The brain's picks beat the S&amp;P 500 in <b>${T.paper_beat_spy} of ${T.paper_months}</b> months.
        <b>This number is inflated, read it as a best case.</b> The test uses today's S&amp;P 500 list, which includes companies that only joined <i>because</i> they had already soared, and leaves out ones that crashed and were removed. A momentum strategy benefits hugely from that hindsight.
        It was also a rough ride: the worst single month lost <b>${pct(Math.min(...P.slice(1).map((x) => x.b_ret)), 0)}</b>, against ${pct(Math.min(...P.slice(1).map((x) => x.s_ret)), 0)} for the S&amp;P 500. The live portfolio below has no hindsight, so it is the honest test.`;
      if (!paperChart) {
        paperChart = LC.createChart($("#paper-chart"), {
          autoSize: true,
          layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
          grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
          rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
          localization: { priceFormatter: (p) => eur(p) },
        });
        [["brain", "#3987e5"], ["spy", "#c98500"], ["momentum", css("--text-muted")]].forEach(([k, col]) => {
          trackLine(paperChart, col).setData(P.map((x) => ({ time: x.time, value: x[k] })));
        });
      }
      paperChart.timeScale().fitContent();
    }
    const L = CELL.paper_live || {};
    const hold = L.holdings || [];
    let worth = 0;
    const rows = hold.map((h) => {
      const c = bySym[h.symbol];
      const now = c ? price(c) : null;
      const chg = now && h.base_close ? now / h.base_close - 1 : 0;
      const slice = (L.value_before_current || L.start) / (hold.length || 1);
      worth += slice * (1 + chg);
      return `<tr data-sym="${h.symbol}"><td><span class="sym">${h.symbol}</span><span class="sub">${c ? c.n : ""}</span></td><td class="r">#${h.rank}</td>
        <td class="r">${money(h.base_close)}</td><td class="r">${money(now)}</td><td class="r"><span class="${signCls(chg)}">${pct(chg)}</span></td><td class="r">${eur(slice * (1 + chg))}</td></tr>`;
    });
    $("#holdings tbody").innerHTML = rows.join("") || '<tr><td colspan="6" class="muted">The first picks freeze on the next nightly run.</td></tr>';
    const done = L.months || [];
    const total = hold.length ? worth : L.value_before_current;
    $("#live-paper").innerHTML = L.started ? `
      <div class="kv"><span>Started</span><span>${eur(L.start)} on ${L.started}</span></div>
      <div class="kv"><span>Worth now (with live prices if your key is set)</span><span><b>${eur(total)}</b> (${pct(total / L.start - 1)})</span></div>
      <div class="kv"><span>Months completed</span><span>${done.length}${done.length ? ", beat the S&P 500 in " + done.filter((m) => m.ret > m.spy).length : ""}</span></div>
      <div class="kv"><span>Current picks frozen on</span><span>${L.current_formed || "n/a"}, swapped about a month later</span></div>` : "";
  }
  $("#holdings tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-sym]");
    if (tr) select(tr.dataset.sym);
  });
  function trackLine(ch, color) {
    return ch.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  }

  // ---------- today's story ----------
  const TD = CELL.today || { sectors: [], movers: [] };
  const secMove = Object.fromEntries((TD.sectors || []).map((x) => [x.name, x.move]));
  const LESS = (window.GAME && window.GAME.lessons) || {};
  const wordMove = (x) => (x == null ? "did not trade" : Math.abs(x) < 0.0005 ? "was flat" : (x > 0 ? "rose " : "fell ") + (Math.abs(x) * 100).toFixed(1) + "%");
  const dayName = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "the latest day");
  const CAUSE_TXT = {
    company: ["Company news", "Neither the market nor its industry moved like this, so the cause is something about this company itself."],
    sector: ["Its whole industry moved", "Its industry moved the same way, which usually means news that affects all of those companies at once."],
    market: ["The whole market moved", "Most stocks moved the same way that day, so this says little about the company itself."],
    quiet: ["A normal day", "A move this size is ordinary for this stock. Small daily moves are mostly noise and carry no message."],
  };
  function renderStory() {
    if (!TD.date) { $("#story").innerHTML = ""; $("#movers").innerHTML = '<p class="note">Arrives with the next nightly run.</p>'; return; }
    const S = TD.sectors, best = S[0], worst = S[S.length - 1];
    const share = TD.total ? TD.up / TD.total : 0.5;
    const mood = share >= 0.65 ? "A broad up day: most companies rose together." : share <= 0.35 ? "A broad down day: most companies fell together."
      : "A mixed day: about as many companies rose as fell, so company and industry news mattered more than the overall mood.";
    $("#story").innerHTML = `<h2>The cell on ${dayName(TD.date)}</h2>
      <p>The market as a whole <b>${wordMove(TD.market)}</b>. <b>${TD.up} of ${TD.total}</b> companies went up. ${mood}
      ${best && worst ? `Strongest industry: <b>${esc(best.name)}</b> (${pct(best.move)}). Weakest: <b>${esc(worst.name)}</b> (${pct(worst.move)}).` : ""}</p>`;
    $("#movers").innerHTML = (TD.movers || []).map((m) => {
      const ct = CAUSE_TXT[m.cause] || CAUSE_TXT.company;
      const news = m.news && m.news.headline ? `<br><span class="muted" style="display:inline">Headline that day:</span> <a href="${esc(m.news.url)}" target="_blank" rel="noopener">${esc(m.news.headline)}</a> <span class="muted" style="display:inline">(${esc(m.news.source)})</span>` : "";
      return `<div class="move" data-sym="${esc(m.s)}"><span class="num">${m.ret > 0 ? "+" : "-"}</span><span><b>${esc(m.s)}</b><span class="sub">${esc(m.n)}</span></span>
        <span class="${signCls(m.ret)}">${pct(m.ret)}</span>
        <span class="why"><b>${ct[0]}</b>${news}<span class="muted">${Math.abs(m.z).toFixed(1)}x its normal daily move. Its industry ${wordMove(m.sector)}${m.vx ? ", trading was " + m.vx + "x the usual amount" : ""}.</span></span></div>`;
    }).join("") || '<p class="note">No unusually big moves on this day.</p>';
  }
  $("#movers").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const row = e.target.closest("[data-sym]");
    if (row) { select(row.dataset.sym); $("#map-wrap").scrollIntoView({ block: "center", behavior: "smooth" }); }
  });

  // one plain-language card: what did this stock just do, and what does that tell you
  function renderExplain() {
    const c = bySym[selected];
    if (!c || c.d1 == null || c.tc == null) { $("#explain").innerHTML = ""; return; }
    const ct = CAUSE_TXT[c.tc] || CAUSE_TXT.quiet, z = Math.abs(c.tz || 0);
    const mv = (TD.movers || []).find((m) => m.s === c.s);
    const news = mv && mv.news && mv.news.headline ? `<p><span class="muted">Headline that day:</span> <a href="${esc(mv.news.url)}" target="_blank" rel="noopener">${esc(mv.news.headline)}</a> <span class="muted">(${esc(mv.news.source)})</span></p>` : "";
    let next = "";
    const k = c.d1 > 0 ? "rev_high" : "rev_low", L = LESS[k];
    if (c.tc !== "quiet" && L && L.rate != null) {
      next = `<p><b>What it says about what comes next:</b> less than it feels like. Over the last 3 years, stocks coming off a big ${c.d1 > 0 ? "rise" : "fall"} did better than most others in the following month <b>${Math.round(L.rate * 100)}%</b> of the time, where 50% is a coin flip.
        A big move tells you investors changed their minds today. It does not tell you they will keep changing them in the same direction.</p>`;
    }
    const l = live[c.s];
    const now = l && l.price && l.prevClose ? `<p class="muted small">Right now (live): ${wordMove(l.price / l.prevClose - 1)} today.</p>` : "";
    $("#explain").innerHTML = `<h3>What just happened, in plain words</h3>
      <p>On ${dayName(TD.date)}, ${esc(c.s)} <b>${wordMove(c.d1)}</b>. That is <b>${z.toFixed(1)}x</b> its normal daily move${z >= 2.5 ? ", which is unusually big" : z >= 1.5 ? ", bigger than usual" : ""}.
        The market ${wordMove(TD.market)} and its industry ${wordMove(c.tsr)}.</p>
      <p><span class="tag ${c.tc === "quiet" ? "warn" : "good"}"><i style="background:var(--accent)"></i>${ct[0]}</span> ${ct[1]}</p>${news}${next}${now}`;
  }

  // ---------- cell map ----------
  const canvas = $("#map"), ctx = canvas.getContext("2d");
  let W = 0, Hh = 0;
  const sectors = [...new Set(cells.map((c) => c.sec))].filter((s) => s !== "Benchmark").sort();
  const maxDv = d3.max(cells, (c) => c.dv) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxDv]).range([2.5, 15]);
  const nodes = cells.filter((c) => c.sec !== "Benchmark").map((c) => ({ id: c.s, c, r: rScale(c.dv) + (tentacles.has(c.s) ? 1.5 : 0) }));
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
  let settled = false;
  function settle() {
    nodes.forEach((n) => { const [x, y] = sectorCenter(n.c.sec); n.x = x + (Math.random() - 0.5) * 60; n.y = y + (Math.random() - 0.5) * 60; });
    for (let i = 0; i < 250; i++) sim.tick();
    settled = true;
  }

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

      // the cell's membrane: a soft, slowly breathing outline
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
        const wob = 1 + 0.025 * Math.sin(3 * a + t * 0.5) + 0.018 * Math.sin(5 * a - t * 0.35) + 0.012 * Math.sin(8 * a + t * 0.8);
        const x = cx + Math.cos(a) * W * 0.485 * wob, y = cy + Math.sin(a) * Hh * 0.485 * wob;
        if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const mg = ctx.createRadialGradient(cx, cy, 20, cx, cy, Math.max(W, Hh) * 0.5);
      mg.addColorStop(0, "rgba(57,135,229,0.06)"); mg.addColorStop(0.5, "rgba(57,135,229,0.05)"); mg.addColorStop(1, "rgba(57,135,229,0.015)");
      ctx.fillStyle = mg; ctx.fill();
      ctx.strokeStyle = "rgba(240,239,236,0.14)"; ctx.lineWidth = 1.5 / k; ctx.stroke();

      ctx.lineWidth = 0.6 / k;
      links.forEach((l) => {
        const hot = focus && (l.source.id === focus.id || l.target.id === focus.id);
        ctx.strokeStyle = hot ? "rgba(240,239,236,0.55)" : "rgba(195,194,183,0.07)";
        ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke();
      });

      // the middle of the cell: a calm glow in the colour of the whole market's day
      const core = d3.color(colD1(TD.market ?? 0));
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 90);
      g.addColorStop(0, `rgba(${core.r},${core.g},${core.b},0.55)`); g.addColorStop(1, `rgba(${core.r},${core.g},${core.b},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 90, 0, Math.PI * 2); ctx.fill();

      nodes.forEach((n) => {
        ctx.globalAlpha = focus && n !== focus && !near.has(n.id) ? 0.45 : 1;
        const col = nodeColor(n), big = colorKey === "d1" ? Math.abs(n.c.tz || 0) : 0;
        if (big >= 2) { ctx.shadowColor = col; ctx.shadowBlur = Math.min(26, 6 * big); }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5 / k; ctx.strokeStyle = surface; ctx.stroke();
        if (big >= 2.5) { // ripples: an unusually big day for this company
          for (let w = 0; w < 1; w++) {
            const ph = (t * 0.3 + n.index * 0.37) % 1;
            ctx.globalAlpha = (1 - ph) * 0.7; ctx.strokeStyle = col; ctx.lineWidth = 1.4 / k;
            ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + ph * 16, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.globalAlpha = focus && n !== focus && !near.has(n.id) ? 0.45 : 1;
        }
        if (n === focus) {
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
        if (!(n === focus || n.r > 11 || Math.abs(n.c.tz || 0) >= 3 || k > 2.2)) return;
        ctx.fillStyle = n === focus ? "#f0efec" : "rgba(240,239,236,0.75)";
        ctx.fillText(n.id, n.x, n.y - n.r - 4 / k);
      });
      ctx.restore();

      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(143,142,134,0.9)";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(240,239,236,0.95)";
      ctx.fillText("WHOLE MARKET  " + (TD.market != null ? pct(TD.market) : ""), transform.applyX(W / 2), transform.applyY(Hh / 2) + 4);
      ctx.fillStyle = "rgba(143,142,134,0.9)";
      sectors.forEach((s) => {
        const [x, y] = sectorCenter(s);
        const label = s.toUpperCase() + (secMove[s] != null ? "  " + pct(secMove[s]) : ""), half = ctx.measureText(label).width / 2 + 8;
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
    const mv = (d.moves && d.moves.top) || [];
    candles.setMarkers(mv.map((m, i) => ({ time: m.date, position: m.ret > 0 ? "aboveBar" : "belowBar",
      color: CAUSE[m.cause].color, shape: "circle", text: String(i + 1) })));
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

  // ---------- why did it move ----------
  const esc = (t) => String(t || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const CAUSE = {
    earnings: { color: "#d95926", label: "Earnings report" },
    market: { color: "#c98500", label: "Whole market moved" },
    sector: { color: "#9085e9", label: "Its sector moved" },
    company: { color: "#3987e5", label: "Company-specific news" },
  };
  function renderMoves(d) {
    const M = d.moves || { top: [], counts: {}, total: 0 };
    const tot = M.total || 0;
    if (!tot) {
      $("#drives").innerHTML = '<p class="note">No unusually big days in the past year. This stock mostly moves calmly with the market.</p>';
      $("#moves").innerHTML = "";
      return;
    }
    const parts = Object.keys(CAUSE).map((k) => [k, M.counts[k] || 0]).filter((x) => x[1]);
    const main = parts.slice().sort((a, b) => b[1] - a[1])[0];
    $("#drives").innerHTML = `<p class="note" style="margin-top:0">${tot} unusually big days in the past year (moves well beyond its normal daily swing).
        Most often: <b>${CAUSE[main[0]].label.toLowerCase()}</b> (${main[1]} of ${tot}).</p>
      <div class="drive-bar">${parts.map(([k, n]) => `<i style="width:${(n / tot) * 100}%;background:${CAUSE[k].color}" title="${CAUSE[k].label}: ${n}"></i>`).join("")}</div>
      <div class="drive-key">${parts.map(([k, n]) => `<span><i style="background:${CAUSE[k].color}"></i>${CAUSE[k].label}: ${n}</span>`).join("")}</div>`;
    $("#moves").innerHTML = M.top.map((m, i) => {
      const ctx = `Market ${pct(m.market)}, its sector ${pct(m.sector)}, trading volume ${m.volume_x ?? "?"}x normal`;
      let why = `<b>${CAUSE[m.cause].label}</b>`;
      if (m.cause === "earnings" && m.surprise != null) why += `: profit ${m.surprise >= 0 ? "beat" : "missed"} estimates by ${pct(Math.abs(m.surprise), 0).replace("+", "")}`;
      if (m.news && m.news.headline) why += `<br><span class="muted" style="display:inline">Headline that day:</span> <a href="${esc(m.news.url)}" target="_blank" rel="noopener">${esc(m.news.headline)}</a> <span class="muted" style="display:inline">(${esc(m.news.source)})</span>`;
      else if (m.cause === "company" || m.cause === "earnings") why += ' <span class="muted" style="display:inline">(headline lookup pending)</span>';
      return `<div class="move"><span class="num" style="border-color:${CAUSE[m.cause].color}">${i + 1}</span><span>${m.date}</span>
        <span class="${signCls(m.ret)}">${pct(m.ret)}</span><span class="why">${why}<span class="muted">${ctx}</span></span></div>`;
    }).join("");
  }

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
    renderExplain();
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
        <p class="note">A ranking, not a price target. The brain's expected edge is small next to how much the stock usually swings, so check the Paper portfolio and Test details before trusting any single rank.</p>`;
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

    renderMoves(d);
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

  // lets the game open a company's page
  window.STOCKLAB_OPEN = (sym) => {
    if (!bySym[sym]) return;
    $('#view-seg button[data-view="list"]').click();
    select(sym);
    window.scrollTo({ top: 0 });
  };

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
      if (!$("#paper-view").hidden) renderPaper();
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
  renderStory();
  renderPaper();
  requestAnimationFrame(draw);
  select(selected);
  connect();
})();
