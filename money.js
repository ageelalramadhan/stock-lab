/* Where the money moves: each category's slice of all money traded, compared with its usual slice.
   Everything shown is counted from daily prices and trading amounts. Nothing here is invented. */
(function () {
  const F = window.FLOWS, root = document.getElementById("flow-view");
  if (!root) return;
  const $ = (q) => root.querySelector(q);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  if (!F || !F.days || !F.days.length) {
    root.innerHTML = '<div class="g-wrap"><h2>Where did the money go?</h2><p class="lead">This report is built every night after the US market closes. It will appear after the next update.</p></div>';
    return;
  }
  const N = F.names, D = F.days;
  let sel = D.length - 1, built = false;
  const pct = (x, d) => (x >= 0 ? "+" : "") + (x * 100).toFixed(d == null ? 1 : d) + "%";
  const share = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const longDate = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const list = (a) => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  const row = (d, i) => ({ name: N[i], extra: d.rows[i][0], z: d.rows[i][1], move: d.rows[i][2], up: d.rows[i][3], n: d.rows[i][4], st: d.rows[i][5], sh: d.rows[i][6] });

  function build() {
    built = true;
    root.innerHTML = `<div class="g-wrap">
      <h2>Where did the money go?</h2>
      <p class="lead">Every day people trade these companies for hundreds of billions of dollars. Each category normally gets about the same slice of that trading.
      When a category gets a <b>bigger slice than usual</b> and its <b>prices go up</b>, we say money came <b class="up">IN</b>.
      Bigger slice than usual and <b>prices go down</b>: money went <b class="down">OUT</b>. "Usual" means the ${F.usual_days} trading days before.</p>

      <div class="fl-nav">
        <button class="btn" id="fl-prev">Earlier day</button>
        <b id="fl-date"></b>
        <button class="btn" id="fl-next">Later day</button>
        <button class="btn" id="fl-last">Newest day</button>
      </div>
      <div class="fl-say" id="fl-say"></div>
      <div id="fl-pot"></div>
      <div class="legend fl-legend">
        <span><i class="fl-sw" style="background:var(--up)"></i>money came in</span>
        <span><i class="fl-sw" style="background:var(--down)"></i>money went out</span>
        <span><i class="fl-sw" style="background:var(--fl-plain)"></i>a normal day for this category</span>
        <span>The long bar is all the money traded that day. Each piece is one category. The thin bar on top shows the usual split.</span>
      </div>
      <details class="newslist"><summary>See the numbers for each category</summary>
      <div class="fl-bars" id="fl-bars"></div>
      <p class="note">Bar to the right: bigger slice of the trading than usual. Bar to the left: smaller. Green: prices went up. Red: prices went down. Pale: inside its normal range.</p>
      </details>
      <div id="fl-clues"></div>

      <h2 style="margin-top:30px">The past year, day by day</h2>
      <p class="lead">Each small square is one day. <b class="up">Green</b>: money came in. <b class="down">Red</b>: money went out. Empty: a normal day. Click a day to see it above.</p>
      <div id="fl-strip-wrap"><canvas id="fl-strip"></canvas></div>
      <p class="lead" id="fl-month"></p>

      <h2 style="margin-top:30px">What happened afterwards?</h2>
      <p class="lead">We counted every "money in" and "money out" day since ${new Date(F.history_from + "T12:00:00").getFullYear()} and looked at where that category's prices were later.</p>
      <div id="fl-out"></div>
      <p class="note">How to read this honestly: days close together share the same weeks, so the counts overlap. The companies are today's list, so companies that were removed are missing.
      Who traded (large funds or private people) is not in this data. Large US funds only have to report what they own every 3 months. This page counts what happened. It does not say what to buy.</p>
    </div>`;
    $("#fl-prev").onclick = () => pick(sel - 1);
    $("#fl-next").onclick = () => pick(sel + 1);
    $("#fl-last").onclick = () => pick(D.length - 1);
    root.addEventListener("click", (e) => { const a = e.target.closest("[data-sym]"); if (a && window.STOCKLAB_OPEN) { e.preventDefault(); window.STOCKLAB_OPEN(a.dataset.sym); } });
    stripEvents();
    renderOutcomes();
    renderMonth();
  }

  function pick(i) { sel = Math.max(0, Math.min(D.length - 1, i)); renderDay(); drawStrip(); }

  // ---------- one day ----------
  function renderDay() {
    const d = D[sel], rows = N.map((_, i) => row(d, i));
    $("#fl-date").textContent = longDate(d.d);
    $("#fl-prev").disabled = sel === 0; $("#fl-next").disabled = $("#fl-last").disabled = sel === D.length - 1;
    const ins = rows.filter((x) => x.st === 1).sort((a, b) => b.extra - a.extra), outs = rows.filter((x) => x.st === -1).sort((a, b) => b.extra - a.extra);
    const gainers = rows.filter((x) => x.extra > 0).sort((a, b) => b.extra - a.extra);
    let say = "";
    if (!ins.length && !outs.length) say += `<p class="big">Nothing unusual. Every category got about its usual slice of the trading.</p>`;
    if (ins.length) say += `<p class="big"><span class="chip up">IN</span> Money came in to <b>${esc(list(ins.map((x) => x.name)))}</b>.</p>`;
    if (outs.length) say += `<p class="big"><span class="chip down">OUT</span> Money went out of <b>${esc(list(outs.map((x) => x.name)))}</b>.</p>`;
    if (gainers.length && d.lead != null) {
      say += d.lead >= 0.6
        ? `<p>All at once or spread? <b>Mostly one place.</b> ${Math.round(d.lead * 100)} out of every 100 extra dollars of trading went to ${esc(gainers[0].name)}.</p>`
        : `<p>All at once or spread? <b>Spread out.</b> The extra trading was shared by ${gainers.length} categories. The biggest part (${Math.round(d.lead * 100)} out of 100) went to ${esc(gainers[0].name)}.</p>`;
    }
    say += `<p class="muted">Traded that day: about $${Math.round(d.tot)} billion (usual: $${Math.round(d.tot_usual)} billion). The typical company moved ${pct(d.mk)}.
      ${d.shift.toFixed(1)} out of every 100 dollars traded sat in a different category than usual (a normal day: ${F.typical_shift.toFixed(1)}).</p>`;
    $("#fl-say").innerHTML = say;

    lastRows = rows; drawPot();
    const max = Math.max(2, ...rows.map((x) => Math.abs(x.extra)));
    $("#fl-bars").innerHTML = rows.slice().sort((a, b) => b.extra - a.extra).map((x) => {
      const w = (Math.abs(x.extra) / max) * 50, dir = x.move >= 0 ? "up" : "down", strong = x.st !== 0;
      const bar = `<i class="${dir}${strong ? "" : " pale"}" style="${x.extra >= 0 ? "left:50%" : "right:50%"};width:${w.toFixed(1)}%"></i>`;
      const tag = x.st === 1 ? '<span class="chip up">IN</span>' : x.st === -1 ? '<span class="chip down">OUT</span>' : "";
      return `<div class="fl-row${strong ? " strong" : ""}" title="${esc(x.name)}: ${x.extra >= 0 ? "+" : ""}${x.extra.toFixed(1)} of every 100 dollars traded, compared with usual. Prices ${pct(x.move)}. ${x.up} of ${x.n} companies went up.">
        <span class="nm">${esc(x.name)}</span>
        <span class="track">${bar}<em></em></span>
        <span class="val">${x.extra >= 0 ? "+" : ""}${x.extra.toFixed(1)}</span>
        <span class="mv"><b class="${dir}">${pct(x.move)}</b> ${tag}</span>
      </div>`;
    }).join("") + `<div class="fl-row head"><span class="nm"></span><span class="track"><small>smaller slice than usual</small><small>bigger slice than usual</small></span><span class="val">slice</span><span class="mv">prices</span></div>`;

    const flagged = ins.concat(outs);
    $("#fl-clues").innerHTML = flagged.length ? `<h3 class="fl-h3">Clues about each one (clues, not proof)</h3>` + flagged.map((x) => {
      const c = d.clues[x.name] || {}, same = x.st === 1 ? x.up : x.n - x.up, part = share(same, x.n), word = x.st === 1 ? "went up" : "went down";
      const li = [];
      li.push(`<b>${same} of ${x.n}</b> companies ${word}. ` + (part >= 75 ? "Almost the whole category moved together. That looks like a move of the category, not of one company."
        : part >= 55 ? "Most moved the same way, but not all." : "The companies did not move together. A few of them carried it."));
      if (c.top) li.push(c.top_share >= 0.5
        ? `Most of the extra trading (${Math.round(c.top_share * 100)} out of 100) was in one company: <a href="#" data-sym="${esc(c.top)}">${esc(c.top)}</a> (price ${pct(c.top_move)}). So this is mostly a one company story.`
        : `The extra trading was shared by many companies. The biggest part (${Math.round(c.top_share * 100)} out of 100) was <a href="#" data-sym="${esc(c.top)}">${esc(c.top)}</a> (price ${pct(c.top_move)}).`);
      if (c.big_now != null && c.big_usual != null) {
        const diff = Math.round((c.big_now - c.big_usual) * 100);
        li.push(`The 5 biggest companies got ${Math.round(c.big_now * 100)} of every 100 dollars traded in this category. Usual: ${Math.round(c.big_usual * 100)}. ` +
          (diff >= 5 ? "Heavier than usual in the giants. That would fit very large investors, but it does not prove it." : diff <= -5 ? "Lighter than usual in the giants. The smaller companies were busier." : "About the same as usual."));
      }
      return `<div class="fl-clue"><h4><span class="chip ${x.st === 1 ? "up" : "down"}">${x.st === 1 ? "IN" : "OUT"}</span> ${esc(x.name)}</h4><ul>${li.map((t) => `<li>${t}</li>`).join("")}</ul></div>`;
    }).join("") : "";
  }

  // ---------- one pot of money, cut into categories ----------
  let lastRows = null;
  const ORDER = N.map((_, i) => i).sort((a, b) => (D[D.length - 1].rows[b][6] || 0) - (D[D.length - 1].rows[a][6] || 0));
  function drawPot() {
    const box = $("#fl-pot"), rows = lastRows; if (!rows || rows[0].sh == null) { box.innerHTML = ""; return; }
    const W = Math.max(300, box.clientWidth), GAPX = 2, UH = 10, BH = 54, BY = 30, cx = document.createElement("canvas").getContext("2d");
    const seq = ORDER.map((i) => rows[i]), tot = seq.reduce((a, x) => a + x.sh, 0), utot = seq.reduce((a, x) => a + (x.sh - x.extra), 0);
    cx.font = "600 13px system-ui, sans-serif";
    const SHORT = { "Information Technology": "Technology", "Consumer Discretionary": "Discretionary", "Consumer Staples": "Staples", "Communication Services": "Communication" };
    let x0 = 0, u0 = 0; const outside = [];
        let segs = "", usual = "";
    seq.forEach((s, k) => {
      const w = (s.sh / tot) * W, uw = ((s.sh - s.extra) / utot) * W, cls = s.st === 1 ? "in" : s.st === -1 ? "out" : "plain";
      const nm = SHORT[s.name] || s.name, num = String(Math.round(s.sh));
      usual += `<rect x="${u0.toFixed(1)}" y="14" width="${Math.max(0.5, uw - GAPX).toFixed(1)}" height="${UH}" rx="2" class="u"/>`;
      segs += `<rect data-k="${k}" x="${x0.toFixed(1)}" y="${BY}" width="${Math.max(1, w - GAPX).toFixed(1)}" height="${BH}" rx="4" class="s ${cls}"/>`;
      cx.font = "600 12px system-ui, sans-serif";
      const tw = cx.measureText(nm).width, c = x0 + (w - GAPX) / 2;
      cx.font = "600 13px system-ui, sans-serif";
      if (tw + 4 <= w - GAPX) segs += `<text x="${c.toFixed(1)}" y="${BY + 21}" text-anchor="middle" class="t in-lab ${cls}">${esc(nm)}</text><text x="${c.toFixed(1)}" y="${BY + 41}" text-anchor="middle" class="t n ${cls}">${num}</text>`;
      else outside.push({ nm, num, cls, mid: c, tw: cx.measureText(nm + " " + num).width + 4 });
      x0 += w; u0 += uw;
    });
    // names that do not fit inside go underneath as a staircase, so no line crosses a name
    let H = BY + BH + 8, lv = 0, prev = -1e9;
    outside.forEach((o) => {
      const ex = Math.max(o.tw, o.mid);
      lv = ex - o.tw > prev + 10 ? 0 : lv + 1; prev = ex;
      const ty = BY + BH + 22 + lv * 19;
      segs += `<line x1="${o.mid.toFixed(1)}" y1="${BY + BH}" x2="${o.mid.toFixed(1)}" y2="${ty + 4}" class="ld"/><text x="${(ex - 4).toFixed(1)}" y="${ty}" text-anchor="end" class="t out-lab ${o.cls}">${esc(o.nm)} <tspan class="n">${o.num}</tspan></text>`;
      H = Math.max(H, ty + 10);
    });
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="All money traded that day, cut into categories"><text x="0" y="9" class="cap">The usual split</text>${usual}${segs}</svg><p class="note" style="margin-top:2px">The number after each name: how many of every 100 dollars traded went to that category. Point at a piece to see more.</p>`;
    const tip = document.getElementById("tip");
    box.querySelectorAll("rect.s").forEach((el) => {
      const s = seq[+el.dataset.k];
      el.addEventListener("mousemove", (e) => {
        if (!tip) return;
        tip.innerHTML = `<b>${esc(s.name)}</b><div><span>Slice that day</span><span>${s.sh.toFixed(1)} of 100</span></div><div><span>Usual slice</span><span>${(s.sh - s.extra).toFixed(1)} of 100</span></div><div><span>Prices</span><span>${pct(s.move)}</span></div><div><span>Companies up</span><span>${s.up} of ${s.n}</span></div><div><span>Reading</span><span>${s.st === 1 ? "money came in" : s.st === -1 ? "money went out" : "normal day"}</span></div>`;
        tip.hidden = false; tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + "px"; tip.style.top = e.clientY + 14 + "px";
      });
      el.addEventListener("mouseleave", () => { if (tip) tip.hidden = true; });
    });
  }

  // ---------- the year strip ----------
  const LAB = 176, RH = 20, GAP = 3, TOP = 6, BOT = 22;
  let cw = 3, W = 0;
  function drawStrip() {
    const cv = $("#fl-strip"), wrap = $("#fl-strip-wrap");
    W = Math.max(520, wrap.clientWidth);
    const H = TOP + N.length * RH + BOT, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    cw = (W - LAB) / D.length;
    const UP = css("--up"), DOWN = css("--down"), INK = css("--text-primary"), MUTED = css("--text-muted"), GRID = css("--grid");
    g.font = "13px system-ui, sans-serif"; g.textBaseline = "middle";
    N.forEach((nm, r) => {
      const y = TOP + r * RH;
      g.fillStyle = INK; g.textAlign = "left"; g.fillText(nm, 0, y + (RH - GAP) / 2);
      g.fillStyle = GRID; g.fillRect(LAB, y, W - LAB, RH - GAP);
      D.forEach((d, i) => { const st = d.rows[r][5]; if (!st) return; g.fillStyle = st === 1 ? UP : DOWN; g.fillRect(LAB + i * cw, y, Math.max(1.5, cw - 0.6), RH - GAP); });
    });
    g.fillStyle = MUTED; g.font = "12px system-ui, sans-serif"; g.textAlign = "left";
    let last = "";
    D.forEach((d, i) => { const m = d.d.slice(0, 7); if (m !== last) { last = m; if (i > 0 || d.d.slice(8) < "08") { const x = LAB + i * cw; g.fillRect(x, TOP + N.length * RH, 1, 5); if (x < W - 30) g.fillText(new Date(d.d + "T12:00:00").toLocaleDateString("en-GB", { month: "short" }), x + 3, TOP + N.length * RH + 12); } } });
    g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(LAB + sel * cw - 1, TOP - 3, Math.max(3, cw) + 1.4, N.length * RH + 3);
  }
  function stripEvents() {
    const cv = $("#fl-strip"), tip = document.getElementById("tip");
    const at = (e) => { const b = cv.getBoundingClientRect(), i = Math.floor((e.clientX - b.left - LAB) / cw); return i >= 0 && i < D.length ? i : -1; };
    cv.addEventListener("click", (e) => { const i = at(e); if (i >= 0) pick(i); });
    cv.addEventListener("mousemove", (e) => {
      const i = at(e); if (i < 0 || !tip) { if (tip) tip.hidden = true; cv.style.cursor = "default"; return; }
      const d = D[i], ins = N.filter((_, k) => d.rows[k][5] === 1), outs = N.filter((_, k) => d.rows[k][5] === -1);
      tip.innerHTML = `<b>${esc(longDate(d.d))}</b>` + (ins.length ? `<div><span>In</span><span>${esc(ins.join(", "))}</span></div>` : "") + (outs.length ? `<div><span>Out</span><span>${esc(outs.join(", "))}</span></div>` : "") + (!ins.length && !outs.length ? "<div><span>A normal day</span><span></span></div>" : "");
      tip.hidden = false; cv.style.cursor = "pointer";
      const tw = tip.offsetWidth; tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + "px"; tip.style.top = e.clientY + 14 + "px";
    });
    cv.addEventListener("mouseleave", () => { if (tip) tip.hidden = true; });
    window.addEventListener("resize", () => { if (!root.hidden && built) { drawStrip(); drawPot(); } });
  }
  function renderMonth() {
    const recent = D.slice(-21), cnt = N.map((nm, k) => ({ nm, i: recent.filter((d) => d.rows[k][5] === 1).length, o: recent.filter((d) => d.rows[k][5] === -1).length }));
    const mi = cnt.slice().sort((a, b) => b.i - a.i)[0], mo = cnt.slice().sort((a, b) => b.o - a.o)[0];
    $("#fl-month").innerHTML = `In the last ${recent.length} trading days: money came in most often to <b>${esc(mi.nm)}</b> (${mi.i} days). Money went out most often from <b>${esc(mo.nm)}</b> (${mo.o} days).`;
  }

  // ---------- what happened afterwards ----------
  function renderOutcomes() {
    const w = F.outcomes["5"], m = F.outcomes["21"];
    const cell = (o) => (o.n ? `<b>${share(o.higher, o.n)} out of 100</b><small>${o.higher.toLocaleString("en-US")} of ${o.n.toLocaleString("en-US")} times</small>` : "<small>no cases yet</small>");
    const line = (label, k, cls) => `<tr class="${cls || ""}"><th>${label}</th><td>${cell(w[k])}</td><td>${cell(m[k])}</td><td><b>${m[k].n ? pct(m[k].avg) : ""}</b></td></tr>`;
    const head = `<thead><tr><th></th><th>Higher one week later</th><th>Higher one month later</th><th>Average change after a month</th></tr></thead>`;
    const base = share(m.any.higher, m.any.n), di = share(m.in.higher, m.in.n) - base, dout = share(m.out.higher, m.out.n) - base;
    const verdict = (x, what) => Math.abs(x) < 3 ? `After a "${what}" day, prices were higher a month later about as often as after any other day.` : `After a "${what}" day, prices were higher a month later ${x > 0 ? "more" : "less"} often than after any other day (${Math.abs(x)} more or fewer times out of 100).`;
    $("#fl-out").innerHTML = `<table class="fl-table">${head}<tbody>
        ${line('<span class="chip up">IN</span> After money came in', "in")}
        ${line('<span class="chip down">OUT</span> After money went out', "out")}
        ${line("After any day at all", "any", "base")}
      </tbody></table>
      <p class="lead"><b>What this says:</b> ${verdict(di, "money in")} ${verdict(dout, "money out")}
      ${Math.abs(di) < 3 && Math.abs(dout) < 3 ? "So far, knowing where the money went did not tell us where prices would go next." : ""}</p>
      <details class="newslist"><summary>See each category on its own</summary>
        <table class="fl-table small"><thead><tr><th></th><th>After money came in: higher a month later</th><th>After money went out: higher a month later</th><th>After any day</th></tr></thead><tbody>
        ${N.map((nm) => { const p = m.per[nm]; return `<tr><th>${esc(nm)}</th><td>${cell(p.in)}</td><td>${cell(p.out)}</td><td>${cell(p.any)}</td></tr>`; }).join("")}
        </tbody></table>
      </details>`;
  }

  window.addEventListener("stocklab-flow", () => { if (!built) build(); renderDay(); drawStrip(); });
  window.STOCKLAB_FLOW_PICK = (i) => { if (!built) build(); pick(i); };
})();
