/* Stock Lab prediction game.
   data/game.js (written nightly) holds:
     rounds  : real past situations from the brain's honest test, with what happened next
     live    : today's 5 picks, answered a month from now
     lessons : how often each kind of clue really led to beating the market
   Your score is saved only in this browser. */
(function () {
  "use strict";
  const G = window.GAME;
  const root = document.getElementById("play-view");
  if (!root) return;
  if (!G || !G.rounds || !G.rounds.length) {
    root.innerHTML = '<p class="note">The game data is not ready yet. It is created by the next nightly run.</p>';
    return;
  }

  const LC = window.LightweightCharts;
  const H = G.horizon, LB = G.lookback;
  const STORE = "stocklab_game_v1";
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (id) => document.getElementById(id);

  // ---------- saved progress ----------
  let state = { results: [], live: {}, seenIntro: false };
  try { state = Object.assign(state, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (e) { /* private mode */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ } };

  // ---------- wording helpers (everyday language, no jargon) ----------
  const p0 = (x) => Math.round(Math.abs(x) * 100) + "%";
  const moved = (x) => (Math.abs(x) < 0.005 ? "barely moved" : (x > 0 ? "rose " : "fell ") + p0(x));
  const signed = (x) => (x >= 0 ? "+" : "-") + (Math.abs(x) * 100).toFixed(1) + "%";
  const niceDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const beatWord = (b) => (b ? "beat most stocks" : "trailed most stocks");

  const CLUES = {
    mom: {
      title: "The past year",
      text: (c) => `It ${moved(c[0])} over the past year (not counting the last month).`,
      rank: (c) => `A better year than ${Math.round(c[1] * 100)}% of other stocks.`,
      means: "A stock that has climbed for many months is said to have momentum. People often expect it to keep going for a while.",
      high: "a very strong past year", low: "a very weak past year",
    },
    rev: {
      title: "The last month",
      text: (c) => `It ${moved(c[0])} in the last month.`,
      rank: (c) => `A better month than ${Math.round(c[1] * 100)}% of other stocks.`,
      means: "A sharp move in one month sometimes partly reverses the next month, as early buyers or sellers step back.",
      high: "a big jump in the last month", low: "a big drop in the last month",
    },
    vol: {
      title: "How jumpy it is",
      text: (c) => `On a normal day it moves about ${(c[0] / Math.sqrt(252) * 100).toFixed(1)}% up or down.`,
      rank: (c) => `Jumpier than ${Math.round(c[1] * 100)}% of other stocks.`,
      means: "Jumpy stocks can win big or lose big. Calm stocks rarely surprise in either direction.",
      high: "a very jumpy price", low: "a very calm price",
    },
    sec: {
      title: "Its industry",
      text: (c, sec) => `${esc(sec)} companies as a group ${moved(c[0])} in the last 3 months.`,
      rank: (c) => `A stronger industry than ${Math.round(c[1] * 100)}% of stocks sit in.`,
      means: "Companies in the same industry often rise and fall together, because the same news affects all of them.",
      high: "a booming industry", low: "a struggling industry",
    },
  };

  function clueCards(item) {
    return Object.keys(CLUES).map((k) => {
      const c = item.clues[k], d = CLUES[k];
      if (!c || c[0] == null) return "";
      return `<div class="clue"><h4>${d.title}</h4>
        <p>${d.text(c, item.sec)}</p>
        <div class="meter" title="Compared with all other stocks"><i style="left:${Math.min(98, Math.max(2, c[1] * 100))}%"></i></div>
        <div class="meter-lbl"><span>lower than most</span><span>higher than most</span></div>
        <p class="muted small">${d.rank(c)}</p>
        <details><summary>What does this tell me?</summary><p class="muted small">${d.means}</p></details></div>`;
    }).join("");
  }

  // the clue that stands out most, and how often such stocks really beat the market
  function standout(item) {
    let best = null;
    Object.keys(CLUES).forEach((k) => {
      const c = item.clues[k];
      if (!c || c[1] == null) return;
      const d = Math.abs(c[1] - 0.5);
      if (d >= 0.3 && (!best || d > best.d)) best = { k, d, side: c[1] >= 0.5 ? "high" : "low" };
    });
    if (!best) return null;
    const stat = G.lessons[best.k + "_" + best.side];
    return stat && stat.rate != null ? { label: CLUES[best.k][best.side], rate: stat.rate, n: stat.n } : null;
  }
  function tiltWord(rate) {
    const d = Math.abs(rate - 0.5);
    return d < 0.02 ? "no real effect" : d < 0.05 ? "a small tilt" : "a clear tilt";
  }
  function lessonHtml(item, beat) {
    const s = standout(item);
    if (!s) return `<p><b>Lesson:</b> no clue stood out here. Most stocks look like this most of the time: ordinary, and close to a 50/50 call. Knowing when you have no real information is a skill too.</p>`;
    const held = (s.rate >= 0.5) === beat;
    return `<p><b>Lesson:</b> the standout clue was <b>${s.label}</b>. In the last 3 years, stocks like that beat most others
      <b>${Math.round(s.rate * 100)}%</b> of the time (${s.n.toLocaleString("en-US")} cases). That is ${tiltWord(s.rate)}, where 50% would mean the clue tells you nothing.
      This time the usual pattern <b>${held ? "held" : "did not hold"}</b>.</p>
      <p class="muted small">Even a real pattern only tilts the odds a little. Single rounds feel random; skill only shows over many rounds.</p>`;
  }

  // ---------- chart ----------
  const T0 = Date.UTC(2000, 0, 3) / 1000;
  const pts = (arr, n) => arr.slice(0, n).map((v, i) => ({ time: T0 + i * 86400, value: v }));
  function makeChart(node) {
    const ch = LC.createChart(node, {
      autoSize: true,
      layout: { background: { color: css("--surface-2") }, textColor: css("--text-muted"), fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { visible: false, borderVisible: false, rightOffset: 2 },
      handleScroll: false, handleScale: false,
      crosshair: { vertLine: { labelVisible: false } },
      localization: { priceFormatter: (p) => "€" + Math.round(p) },
    });
    const opt = { lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false };
    const mkt = ch.addLineSeries({ ...opt, color: css("--text-muted"), lastValueVisible: true });
    const stk = ch.addLineSeries({ ...opt, color: "#3987e5", lastValueVisible: true });
    return { ch, stk, mkt };
  }
  function fillChart(c, stockPx, marketPx, n, mark) {
    c.stk.setData(pts(stockPx, n));
    c.mkt.setData(pts(marketPx, n));
    c.stk.setMarkers(mark ? [{ time: T0 + LB * 86400, position: "aboveBar", shape: "circle", color: "#f0efec", text: "Your guess" }] : []);
    c.ch.timeScale().fitContent();
  }
  const chartLegend = (name) => `<div class="legend"><span><i class="sw ln brainc"></i>${name}</span><span><i class="sw ln momc"></i>The market (500 big US companies)</span>
    <span class="muted">Both lines start at €100, six months before your guess</span></div>`;

  // ---------- scoreboard ----------
  function scoreHtml() {
    const r = state.results, n = r.length;
    const you = r.filter((x) => x.ok).length, brain = r.filter((x) => x.brainOk).length;
    const pc = (k) => (n ? Math.round((k / n) * 100) + "%" : "0%");
    let verdict = "Play a few rounds to see how you compare.";
    if (n >= 20) {
      const se = Math.sqrt(0.25 / n), z = (you / n - 0.5) / se;
      verdict = z >= 2 ? "You are clearly ahead of a coin flip. That is rare, keep going."
        : z <= -2 ? "You are doing worse than a coin flip. Look at which clues you have been trusting."
        : "So far your result is within what pure luck would give. That is normal, and it is the main lesson of this game.";
    } else if (n >= 5) verdict = "Too few rounds to tell skill from luck. It takes at least 20.";
    return `<div class="score">
      <div class="stat"><b>${you} of ${n}</b><span>you (${pc(you)})</span></div>
      <div class="stat"><b>${brain} of ${n}</b><span>the brain, same rounds (${pc(brain)})</span></div>
      <div class="stat"><b>50%</b><span>a coin flip</span></div>
      <p class="note">${verdict}</p></div>`;
  }

  // ---------- practice mode ----------
  let current = null, chart = null, curGuess = null;
  function nextRound() {
    const done = new Set(state.results.map((x) => x.id));
    const fresh = G.rounds.filter((x) => !done.has(x.id));
    const pool = fresh.length ? fresh : G.rounds;
    current = pool[Math.floor(Math.random() * pool.length)];
    curGuess = null;
    renderRound(false);
  }
  function renderRound(answered, guess) {
    const it = current, mk = G.market[it.d];
    const n = state.results.length + (answered ? 0 : 1);
    let body = `${scoreHtml()}
      <div class="card round">
        <div class="round-head"><h3>Round ${n}: ${answered ? esc(it.n) + " (" + esc(it.s) + ")" : "a mystery company"}</h3>
          <span class="muted small">${esc(it.sec)}${answered ? ", " + niceDate(it.d) : ", a hidden day in the last 3 years"}</span></div>
        ${chartLegend(answered ? esc(it.s) : "The mystery company")}
        <div id="g-chart" class="g-chart"></div>
        <h4 class="q">${answered ? "The clues you had" : "Your clues"}</h4>
        <div class="clues">${clueCards(it)}</div>`;
    if (!answered) {
      body += `<h4 class="q">Over the next month, will this company do better or worse than most other stocks?</h4>
        <div class="choices"><button class="btn big" data-guess="beat">Better than most</button>
        <button class="btn big" data-guess="trail">Worse than most</button></div>
        <p class="muted small">"Most other stocks" means the typical one out of about 500 big US companies. If the whole market falls and this company falls less, it still counts as better.</p>`;
    } else {
      const ok = (guess === "beat") === it.beat;
      const bGuess = it.bp >= 0.5, bOk = bGuess === it.beat;
      body += `<div class="reveal ${ok ? "ok" : "no"}">
          <div class="verdict"><span class="tag ${ok ? "good" : "bad"}"><i></i>${ok ? "You were right" : "Not this time"}</span></div>
          <p>This was <b>${esc(it.n)}</b> on ${niceDate(it.d)}. Over the next month it <b>${moved(it.ret)}</b>, while the typical stock ${moved(it.mkt)}.
            So it <b>${beatWord(it.beat)}</b>.</p>
          <p>The brain ranked it #${it.br} of ${it.of} and guessed <b>${bGuess ? "better" : "worse"} than most</b>. ${bOk ? "It was right." : "It was wrong."}</p>
          ${lessonHtml(it, it.beat)}
          <div class="choices"><button class="btn primary big" id="g-next">Next round</button>
            <button class="btn" id="g-open" data-sym="${esc(it.s)}">See this company today</button></div>
        </div>`;
    }
    body += "</div>";
    el("g-body").innerHTML = body;
    chart = makeChart(el("g-chart"));
    fillChart(chart, it.px, mk, answered ? it.px.length : LB + 1, answered);
  }
  function answer(guess) {
    const it = current;
    state.results.push({ id: it.id, ok: (guess === "beat") === it.beat, brainOk: (it.bp >= 0.5) === it.beat, g: guess, t: Date.now() });
    if (state.results.length > 3000) state.results = state.results.slice(-3000);
    save();
    curGuess = guess;
    renderRound(true, guess);
  }

  // ---------- live mode ----------
  function scoreLive(p) {
    const D = G.closes.dates, i = D.indexOf(p.date);
    if (i < 0) return p.date < D[0] ? { state: "expired" } : { state: "waiting", left: H };
    if (i + H >= D.length) return { state: "waiting", left: i + H - (D.length - 1) };
    const rets = [];
    let mine = null;
    Object.keys(G.closes.px).forEach((s) => {
      const a = G.closes.px[s][i], b = G.closes.px[s][i + H];
      if (a && b) { const x = b / a - 1; rets.push(x); if (s === p.s) mine = x; }
    });
    if (mine == null || rets.length < 20) return { state: "expired" };
    rets.sort((a, b) => a - b);
    const med = rets[Math.floor(rets.length / 2)];
    return { state: "done", ret: mine, mkt: med, beat: mine > med, on: D[i + H] };
  }
  function renderLive() {
    const L = G.live;
    const cards = L.picks.map((it, idx) => {
      const key = L.date + "|" + it.s, mine = state.live[key];
      const after = mine ? `<div class="reveal"><p><span class="tag warn"><i></i>Saved</span> You said <b>${mine.g === "beat" ? "better" : "worse"} than most</b>.
          The brain ranks it #${it.br} of ${it.of} and says <b>${it.bp >= 0.5 ? "better" : "worse"} than most</b>.
          The answer arrives in about a month.</p></div>`
        : `<div class="choices"><button class="btn big" data-live="${idx}" data-guess="beat">Better than most</button>
           <button class="btn big" data-live="${idx}" data-guess="trail">Worse than most</button></div>`;
      return `<div class="card round"><div class="round-head"><h3>${esc(it.n)} (${esc(it.s)})</h3>
          <span class="muted small">${esc(it.sec)}, price $${it.close}</span></div>
        ${chartLegend(esc(it.s))}<div class="g-chart" id="l-chart-${idx}"></div>
        <div class="clues">${clueCards(it)}</div>
        <h4 class="q">Over the next month, will ${esc(it.s)} do better or worse than most other stocks?</h4>${after}</div>`;
    }).join("");

    const mine = Object.keys(state.live).map((k) => state.live[k]).sort((a, b) => (a.date < b.date ? 1 : -1));
    let you = 0, brain = 0, done = 0;
    const rows = mine.map((p) => {
      const s = scoreLive(p);
      let res = '<span class="muted">expired (not opened in time)</span>', what = "";
      if (s.state === "waiting") res = `<span class="muted">about ${s.left} trading day${s.left === 1 ? "" : "s"} to go</span>`;
      if (s.state === "done") {
        const ok = (p.g === "beat") === s.beat, bOk = (p.bp >= 0.5) === s.beat;
        done++; if (ok) you++; if (bOk) brain++;
        what = `${signed(s.ret)} vs ${signed(s.mkt)} typical`;
        res = `<span class="tag ${ok ? "good" : "bad"}"><i></i>${ok ? "You were right" : "You were wrong"}</span> <span class="muted small">brain ${bOk ? "right" : "wrong"}</span>`;
      }
      return `<tr><td>${p.date}</td><td><span class="sym">${esc(p.s)}</span></td><td>${p.g === "beat" ? "Better" : "Worse"}</td>
        <td>${p.bp >= 0.5 ? "Better" : "Worse"}</td><td class="r">${what}</td><td>${res}</td></tr>`;
    }).join("");

    el("g-body").innerHTML = `
      <p class="note">These are <b>today's real stocks</b> (${niceDate(L.date)}). Nobody knows the answer yet, not even the brain. Guess now, then come back in a month.
        Five new stocks appear every trading day.</p>
      ${cards}
      <div class="card"><h3>Your live guesses${done ? `: you ${you} of ${done}, the brain ${brain} of ${done}` : ""}</h3>
        <table class="tbl small"><thead><tr><th>Guessed on</th><th>Stock</th><th>You said</th><th>Brain said</th><th class="r">What happened</th><th>Result</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No live guesses yet.</td></tr>'}</tbody></table></div>`;
    L.picks.forEach((it, idx) => fillChart(makeChart(el("l-chart-" + idx)), it.px, L.market, it.px.length, false));
  }

  // ---------- what the data says ----------
  function renderLearned() {
    const Ls = G.lessons;
    const row = (label, k) => {
      const s = Ls[k];
      if (!s || s.rate == null) return "";
      const pc = Math.round(s.rate * 100);
      return `<div class="lesson"><div class="lbl"><span>${label}</span><span><b>${pc}%</b> <span class="muted small">${tiltWord(s.rate)}</span></span></div>
        <div class="odds"><i style="width:${pc}%"></i><em></em></div></div>`;
    };
    el("g-body").innerHTML = `${scoreHtml()}
      <div class="card"><h3>How often did each clue really work?</h3>
        <p class="note" style="margin-top:0">Every month for the last 3 years, for about 500 companies: did the stock do better than most over the following month?
          <b>50% means the clue tells you nothing.</b> The white line marks 50%.</p>
        ${row("A very strong past year", "mom_high")}${row("A very weak past year", "mom_low")}
        ${row("A big jump in the last month", "rev_high")}${row("A big drop in the last month", "rev_low")}
        ${row("A very jumpy price", "vol_high")}${row("A very calm price", "vol_low")}
        ${row("A booming industry", "sec_high")}${row("A struggling industry", "sec_low")}
        ${row("The brain's top fifth", "brain_top")}${row("The brain's bottom fifth", "brain_bottom")}
        ${row("The brain's guess, all stocks", "brain_all")}
        <p class="note">${["mom_high", "mom_low", "rev_high", "rev_low", "vol_high", "vol_low", "sec_high", "sec_low"].every((k) => !Ls[k] || Ls[k].rate == null || Math.abs(Ls[k].rate - 0.5) < 0.06)
          ? "What to take from this: no single clue gets far from 50%. Markets are hard because every obvious clue is already known to millions of other people."
          : "What to take from this: a few clues tilted the odds in this period, but none comes close to certainty, and tilts like these come and go."}
          Small tilts can still add up over hundreds of decisions, which is the only way anyone has an edge. These numbers also look a little better than reality, because the list only contains companies that are still big today.</p>
      </div>`;
  }

  // ---------- shell ----------
  let mode = "practice";
  root.innerHTML = `
    <div class="g-wrap">
      <div class="g-intro">
        <h2>Can you read a stock?</h2>
        <p class="note">You get a real company's price chart and four plain clues. Guess whether it will do <b>better or worse than most other stocks</b> over the next month.
          Then see what really happened, what the brain guessed, and what the round teaches. No money involved.</p>
      </div>
      <div class="seg" id="g-mode">
        <button data-mode="practice" class="on">Practice (answer right away)</button>
        <button data-mode="live">Today's live picks</button>
        <button data-mode="learned">What the data says</button>
      </div>
      <div id="g-body"></div>
    </div>`;
  function show() {
    if (mode === "practice") { if (current) renderRound(!!curGuess, curGuess); else nextRound(); }
    if (mode === "live") renderLive();
    if (mode === "learned") renderLearned();
  }
  el("g-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    mode = b.dataset.mode;
    document.querySelectorAll("#g-mode button").forEach((x) => x.classList.toggle("on", x === b));
    show();
  });
  el("g-body").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "g-next") { nextRound(); root.scrollIntoView({ block: "start" }); return; }
    if (b.id === "g-open") { if (window.STOCKLAB_OPEN) window.STOCKLAB_OPEN(b.dataset.sym); return; }
    if (b.dataset.live != null) {
      const it = G.live.picks[+b.dataset.live];
      state.live[G.live.date + "|" + it.s] = { date: G.live.date, s: it.s, g: b.dataset.guess, bp: it.bp, close: it.close };
      save(); renderLive(); return;
    }
    if (b.dataset.guess) answer(b.dataset.guess);
  });
  show();
})();
