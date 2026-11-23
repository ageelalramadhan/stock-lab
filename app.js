/* Stock Lab front end: reads data/bundle.js (written by the nightly trainer)
   and adds live prices from Finnhub using a key stored only in this browser. */
(function () {
  "use strict";

  const DATA = window.STOCK_DATA;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const KEY_NAME = "stocklab_finnhub_key";

  if (!DATA || !DATA.tickers || !DATA.tickers.length) {
    $("#updated").textContent = "No data yet. Run the 'Nightly retrain' workflow once on GitHub, then pull.";
    return;
  }

  const H = DATA.horizon_days;
  document.querySelectorAll(".h-days").forEach((el) => (el.textContent = H));
  $("#updated").textContent = "Model retrained " + DATA.generated;

  const bySym = Object.fromEntries(DATA.tickers.map((t) => [t.symbol, t]));
  const live = {}; // symbol: {price, prevClose, open, high, low, day}
  let selected = DATA.tickers[0].symbol;
  let rangeDays = 126;
  let sortKey = "symbol";

  // ---------- formatting ----------
  const pct = (x, d = 1) => {
    if (x == null) return "n/a";
    const v = +(x * 100).toFixed(d);
    return (v > 0 ? "+" : v < 0 ? "" : "") + (v === 0 ? (0).toFixed(d) : v.toFixed(d)) + "%";
  };
  const money = (x) => (x == null ? "n/a" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const signCls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");
  const todayISO = () => {
    const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    return ny.getFullYear() + "-" + String(ny.getMonth() + 1).padStart(2, "0") + "-" + String(ny.getDate()).padStart(2, "0");
  };

  function edge(t) {
    const b = t.backtest || {};
    if (b.direction_hit_rate == null) return null;
    return b.direction_hit_rate - b.baseline_best_guess;
  }
  function reliabilityTag(t, short) {
    const e = edge(t);
    if (e == null) return '<span class="tag warn"><i></i>Unknown</span>';
    if (e >= 0.03) return `<span class="tag good"><i></i>${short ? "Has edge" : "Beats guessing"}</span>`;
    if (e >= -0.01) return '<span class="tag warn"><i></i>Coin flip</span>';
    return `<span class="tag bad"><i></i>${short ? "No edge" : "Worse than guessing"}</span>`;
  }
  function currentPrice(t) {
    const l = live[t.symbol];
    return l && l.price ? l.price : t.performance.last_close;
  }
  function todayChange(t) {
    const l = live[t.symbol];
    if (l && l.price && l.prevClose) return l.price / l.prevClose - 1;
    return t.performance.change_1d;
  }

  // ---------- watchlist ----------
  function renderWatch() {
    const rows = DATA.tickers.slice();
    const val = {
      symbol: (t) => t.symbol,
      today: (t) => -(todayChange(t) ?? 0),
      lean: (t) => -(t.forecast.expected_return ?? 0),
      edge: (t) => -(edge(t) ?? -1),
    }[sortKey];
    rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0));
    $("#watch-table tbody").innerHTML = rows
      .map((t) => {
        const ch = todayChange(t);
        const f = t.forecast;
        return `<tr data-sym="${t.symbol}" class="${t.symbol === selected ? "sel" : ""}">
          <td><span class="sym">${t.symbol}</span><span class="sub">${t.name}</span></td>
          <td class="r" data-price="${t.symbol}">${money(currentPrice(t))}</td>
          <td class="r"><span class="${signCls(ch)}">${pct(ch)}</span></td>
          <td class="r"><span class="${signCls(f.expected_return)}">${pct(f.expected_return)}</span></td>
          <td class="r">${f.prob_up == null ? "n/a" : Math.round(f.prob_up * 100) + "%"}</td>
          <td>${reliabilityTag(t, true)}</td>
        </tr>`;
      })
      .join("");
  }
  $("#watch-table tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-sym]");
    if (tr) select(tr.dataset.sym);
  });
  $("#sort-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    sortKey = b.dataset.sort;
    document.querySelectorAll("#sort-seg button").forEach((x) => x.classList.toggle("on", x === b));
    renderWatch();
  });

  // ---------- chart ----------
  const LC = window.LightweightCharts;
  const chart = LC.createChart($("#chart"), {
    autoSize: true,
    layout: { background: { color: css("--surface-1") }, textColor: css("--text-muted"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: { mode: LC.CrosshairMode.Normal },
  });
  const up = css("--up"), down = css("--down");
  const candles = chart.addCandlestickSeries({
    upColor: "rgba(0,0,0,0)", downColor: down, borderUpColor: up, borderDownColor: down,
    wickUpColor: up, wickDownColor: down, priceLineVisible: false,
  });
  const line = (color, extra = {}) =>
    chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
  const ma20 = line(css("--ma20"));
  const ma50 = line(css("--ma50"));
  const fcMid = line(css("--forecast"), { lineStyle: LC.LineStyle.Dashed, lastValueVisible: true });
  const fcLow = line(css("--text-muted"), { lineStyle: LC.LineStyle.Dashed, lineWidth: 1 });
  const fcHigh = line(css("--text-muted"), { lineStyle: LC.LineStyle.Dashed, lineWidth: 1 });

  function candleData(t) {
    const c = t.candles.slice();
    const l = live[t.symbol];
    if (l && l.price && l.day) {
      const last = c[c.length - 1];
      if (l.day > last.time) {
        c.push({ time: l.day, open: l.open || l.price, high: Math.max(l.high || l.price, l.price), low: Math.min(l.low || l.price, l.price), close: l.price });
      } else if (l.day === last.time) {
        c[c.length - 1] = { ...last, close: l.price, high: Math.max(last.high, l.price), low: Math.min(last.low, l.price) };
      }
    }
    return c;
  }

  function drawChart(fit) {
    const t = bySym[selected];
    const c = candleData(t);
    candles.setData(c);
    ma20.setData(t.ma20);
    ma50.setData(t.ma50);
    const p = t.forecast.path;
    fcMid.setData(p.map((x) => ({ time: x.time, value: x.mid })));
    fcLow.setData(p.map((x) => ({ time: x.time, value: x.low })));
    fcHigh.setData(p.map((x) => ({ time: x.time, value: x.high })));
    if (fit) {
      const from = c[Math.max(0, c.length - rangeDays)].time;
      chart.timeScale().setVisibleRange({ from, to: p[p.length - 1].time });
    }
  }

  const tip = $("#tooltip");
  chart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.point) { tip.hidden = true; return; }
    const cd = param.seriesData.get(candles);
    const fm = param.seriesData.get(fcMid);
    const rows = [];
    if (cd && cd.open != null) {
      rows.push(["Open", money(cd.open)], ["High", money(cd.high)], ["Low", money(cd.low)], ["Close", money(cd.close)]);
    }
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
    let x = box.left + param.point.x + 16, y = box.top + param.point.y + 16;
    if (x + 190 > window.innerWidth) x -= 210;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
    tip.hidden = false;
  });
  $("#chart").addEventListener("mouseleave", () => (tip.hidden = true));

  $("#range-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    rangeDays = +b.dataset.days;
    document.querySelectorAll("#range-seg button").forEach((x) => x.classList.toggle("on", x === b));
    drawChart(true);
  });

  // ---------- detail cards ----------
  function renderDetail() {
    const t = bySym[selected];
    const p = t.performance, f = t.forecast, b = t.backtest, lv = t.live;
    $("#sel-title").textContent = `${t.symbol}  ${t.name}`;
    const ch = todayChange(t);
    $("#sel-price").textContent = money(currentPrice(t));
    $("#sel-change").innerHTML = `<span class="${signCls(ch)}">${pct(ch, 2)} today</span>`;

    const perf = [
      ["1 week", pct(p.change_1w)], ["1 month", pct(p.change_1m)], ["3 months", pct(p.change_3m)],
      ["Year to date", pct(p.change_ytd)], ["1 year", pct(p.change_1y)],
      ["52-week range", money(p.low_52w) + " to " + money(p.high_52w)],
      ["Volatility (yearly)", p.volatility_annual == null ? "n/a" : Math.round(p.volatility_annual * 100) + "%"],
      ["RSI (14 days)", p.rsi_14 == null ? "n/a" : p.rsi_14 + (p.rsi_14 > 70 ? " (overbought)" : p.rsi_14 < 30 ? " (oversold)" : "")],
    ];
    $("#perf").innerHTML = perf.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

    const end = f.path[f.path.length - 1];
    const lean = f.expected_return > 0.005 ? "leans up" : f.expected_return < -0.005 ? "leans down" : "sees no clear direction";
    $("#forecast").innerHTML = `
      <div class="kv"><span>Expected move</span><span class="${signCls(f.expected_return)}">${pct(f.expected_return)}</span></div>
      <div class="kv"><span>Target price (middle)</span><span>${money(end.mid)}</span></div>
      <div class="kv"><span>Likely range (80%)</span><span>${money(end.low)} to ${money(end.high)}</span></div>
      <div class="kv"><span>Chance it is higher</span><span>${Math.round(f.prob_up * 100)}%</span></div>
      <div class="kv"><span>Based on close of</span><span>${f.base_date}</span></div>
      <p class="note">From the ${f.base_date} close, the model ${lean} by ${end.time}. In 8 out of 10 similar past situations the price ended inside the range.</p>`;

    const e = edge(t);
    const liveLine = lv && lv.scored
      ? `<div class="kv"><span>Live record (${lv.scored} scored)</span><span>${Math.round(lv.direction_hit_rate * 100)}% right</span></div>
         <div class="kv"><span>Landed inside range</span><span>${Math.round(lv.in_band_rate * 100)}%</span></div>`
      : `<div class="kv"><span>Live record</span><span class="muted">starts after ${H} trading days</span></div>`;
    $("#quality").innerHTML = `
      <div class="kv"><span>Direction right (backtest)</span><span>${Math.round(b.direction_hit_rate * 100)}%</span></div>
      <div class="kv"><span>Simple guess would get</span><span>${Math.round(b.baseline_best_guess * 100)}%</span></div>
      <div class="kv"><span>Edge over guessing</span><span>${e == null ? "n/a" : (e >= 0 ? "+" : "") + Math.round(e * 100) + " pts"}</span></div>
      ${liveLine}
      <div style="margin-top:8px">${reliabilityTag(t)}</div>
      <p class="note">Backtest: ${b.days_tested} past days the model never saw while training. "Simple guess" means always betting on whichever direction happened more often.</p>`;

    $("#drivers").innerHTML = f.drivers
      .map((d) => `<div class="bar-row"><div class="lbl"><span>${d.feature}</span><span>${Math.round(d.share * 100)}%</span></div>
        <div class="bar"><div style="width:${Math.min(100, d.share * 250)}%"></div></div></div>`)
      .join("") + `<p class="note">Share of the forecast's sensitivity. These are patterns, not reasons.</p>`;

    const hist = (t.history || []).slice().reverse();
    $("#diary tbody").innerHTML = hist.length
      ? hist.map((r) => {
          const done = r.actual_close != null;
          const res = !done ? '<span class="muted">waiting</span>'
            : (+r.direction_hit ? '<span class="tag good"><i></i>Direction right</span>' : '<span class="tag bad"><i></i>Direction wrong</span>')
              + (+r.in_band ? ' <span class="muted small">in range</span>' : ' <span class="muted small">outside range</span>');
          return `<tr><td>${r.base_date}</td><td class="r">${money(r.base_close)}</td>
            <td class="r">${pct(r.pred_mid)}</td><td class="r">${pct(r.pred_low)} to ${pct(r.pred_high)}</td>
            <td class="r">${done ? pct(r.actual_return) : ""}</td><td>${res}</td></tr>`;
        }).join("")
      : '<tr><td colspan="6" class="muted">No predictions logged yet.</td></tr>';
  }

  function select(sym) {
    selected = sym;
    renderWatch();
    renderDetail();
    drawChart(true);
  }

  // ---------- live data (Finnhub) ----------
  const status = (state, text) => {
    $("#live-status").className = "pill " + state;
    $("#live-text").textContent = text;
  };
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch { return ""; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME); } catch {} };

  let ws = null, pollTimer = null, redrawPending = false;

  function scheduleRedraw() {
    if (redrawPending) return;
    redrawPending = true;
    setTimeout(() => {
      redrawPending = false;
      renderWatch();
      renderDetail();
      drawChart(false);
    }, 1000);
  }

  async function pollQuotes(key) {
    let ok = 0;
    for (const t of DATA.tickers) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t.symbol)}&token=${encodeURIComponent(key)}`);
        if (r.status === 401 || r.status === 403) { status("warn", "Key rejected"); return; }
        const q = await r.json();
        if (q && q.c) {
          const d = new Date(q.t * 1000).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
          live[t.symbol] = { ...(live[t.symbol] || {}), price: q.c, prevClose: q.pc, open: q.o, high: q.h, low: q.l, day: d };
          ok++;
        }
      } catch (e) { /* network blip, keep last values */ }
    }
    if (ok && !(ws && ws.readyState === 1)) status("on", "Quotes updated " + new Date().toLocaleTimeString());
    scheduleRedraw();
  }

  function connect() {
    const key = getKey();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearInterval(pollTimer);
    if (!key) { status("", "Live off"); return; }
    status("warn", "Connecting...");
    pollQuotes(key);
    pollTimer = setInterval(() => pollQuotes(key), 60000); // 18 calls a minute, under the free limit of 60

    ws = new WebSocket("wss://ws.finnhub.io?token=" + encodeURIComponent(key));
    ws.onopen = () => {
      DATA.tickers.forEach((t) => ws.send(JSON.stringify({ type: "subscribe", symbol: t.symbol })));
      status("on", "Live stream on");
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== "trade" || !m.data) return;
      const day = todayISO();
      for (const tr of m.data) {
        const l = live[tr.s] || (live[tr.s] = {});
        l.price = tr.p;
        if (l.day !== day) { l.day = day; l.open = tr.p; l.high = tr.p; l.low = tr.p; }
        l.high = Math.max(l.high, tr.p);
        l.low = Math.min(l.low, tr.p);
        const cell = document.querySelector(`[data-price="${tr.s}"]`);
        if (cell) { cell.textContent = money(tr.p); cell.classList.remove("flash"); void cell.offsetWidth; cell.classList.add("flash"); }
      }
      scheduleRedraw();
    };
    ws.onclose = () => {
      status("warn", "Stream paused, retrying");
      setTimeout(() => { if (getKey()) connect(); }, 15000);
    };
  }

  const dlg = $("#key-dialog");
  $("#key-btn").addEventListener("click", () => { $("#key-input").value = getKey(); dlg.showModal(); });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save") setKey($("#key-input").value.trim());
    if (dlg.returnValue === "clear") setKey("");
    connect();
  });

  // ---------- start ----------
  select(selected);
  connect();
})();
