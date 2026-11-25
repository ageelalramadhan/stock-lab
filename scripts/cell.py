"""
Stock Lab "cell", version 2: a monthly RANKER.

Question it answers: over the next month (21 trading days), which stocks will do
better or worse THAN THE OTHER STOCKS? Ranking against each other removes the
market's daily noise, which is what drowned the old 5-day up/down model.

1. Universe: S&P 500 (refreshed weekly) plus extras from config
2. Features with a research track record: 12-1 and 6-1 month momentum, short-term
   reversal, trend, volatility, beta, size, sector strength, earnings surprises
3. One shared model, trained on weekly snapshots of every stock
4. Honest test: walk forward month by month over the last 3 years. Each month,
   rank all stocks, then check: did the top 20% beat the bottom 20%?
   Compared against plain momentum, the classic simple strategy.
5. Live record: once a month the ranking is frozen and scored a month later
6. Tentacles: pinned stocks + the brain's top-ranked stocks (stream live)
7. Writes data/cell.js (map, list, track record) and data/stocks/<SYM>.js (detail)

Run:          python scripts/cell.py
Offline test: DEMO=1 python scripts/cell.py
Needs FINNHUB_KEY (GitHub secret) for earnings data; runs without it, minus earnings.
"""

import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "tickers.json").read_text())
UNIVERSE_FILE = ROOT / "config" / "universe.json"
DATA = ROOT / "data"
STOCK_DIR = DATA / "stocks"
RANK_LOG = DATA / "rank_log.csv"
EARN_FILE = DATA / "earnings.csv"
H = 21                       # one trading month
YEARS = int(CFG.get("history_years", 6))
N_TENTACLES = int(CFG.get("tentacles", 50))
PINNED = CFG.get("pinned", [])
BASKET = 20                  # stocks in the top and bottom basket
DEMO = os.environ.get("DEMO") == "1"
MARKET = "SPY"
NOT_RANKED = {"SPY", "QQQ"}  # benchmarks are shown but not ranked

FEATURES = ["mom_12_1", "mom_6_1", "rev_1m", "ret_3m", "dist_ma200", "vol_3m", "beta_1y",
            "max_day_1m", "size", "sector_3m", "earn_surprise", "earn_days"]
RANKED = ["mom_12_1", "mom_6_1", "rev_1m", "ret_3m", "dist_ma200", "vol_3m", "beta_1y",
          "max_day_1m", "size", "sector_3m"]   # turned into percentiles each day
LABELS = {
    "mom_12_1": "12-month momentum (skip last month)", "mom_6_1": "6-month momentum (skip last month)",
    "rev_1m": "Last month's move", "ret_3m": "Last 3 months' move", "dist_ma200": "Distance above 200-day average",
    "vol_3m": "Volatility", "beta_1y": "Sensitivity to the market (beta)", "max_day_1m": "Biggest single-day jump",
    "size": "Trading size (dollar volume)", "sector_3m": "Its sector's strength",
    "earn_surprise": "Last earnings surprise", "earn_days": "Days since earnings",
}


# ---------------- universe ----------------

def fetch_sp500():
    req = urllib.request.Request("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
                                 headers={"User-Agent": "Mozilla/5.0 (stock-lab personal project)"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    for t in pd.read_html(io.StringIO(html)):
        if "Symbol" in t.columns and "GICS Sector" in t.columns:
            name_col = "Security" if "Security" in t.columns else t.columns[1]
            return [{"symbol": str(r["Symbol"]).strip().replace(".", "-"), "name": str(r[name_col]),
                     "sector": str(r["GICS Sector"])} for _, r in t.iterrows()]
    raise RuntimeError("S&P 500 table not found")


def load_universe():
    cached = json.loads(UNIVERSE_FILE.read_text()) if UNIVERSE_FILE.exists() else None
    fresh = cached and (time.time() - cached.get("fetched_ts", 0) < 7 * 86400)
    members = cached["members"] if cached else []
    if DEMO:
        members = demo_universe()
    elif not fresh:
        try:
            members = fetch_sp500()
            UNIVERSE_FILE.write_text(json.dumps({"fetched_ts": time.time(),
                                                 "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                                 "members": members}, indent=1))
            print(f"Universe refreshed: {len(members)} S&P 500 members")
        except Exception as e:
            print(f"Universe refresh failed, using cached list ({e})")
    seen, out = set(), []
    for m in CFG.get("extras", []) + members:
        if m["symbol"] not in seen:
            seen.add(m["symbol"])
            out.append(m)
    return out


# ---------------- prices ----------------

def download_all(symbols):
    if DEMO:
        return demo_prices(symbols)
    import yfinance as yf
    frames = {}
    batches = [symbols[i:i + 80] for i in range(0, len(symbols), 80)]
    for b_i, batch in enumerate(batches):
        df = None
        for attempt in range(3):
            try:
                df = yf.download(batch, period=f"{YEARS}y", interval="1d", auto_adjust=True,
                                 progress=False, threads=True, group_by="ticker")
                break
            except Exception as e:
                print(f"  batch {b_i + 1}: attempt {attempt + 1} failed ({e})")
                time.sleep(20 * (attempt + 1))
        if df is None:
            continue
        for s in batch:
            try:
                d = df[s] if isinstance(df.columns, pd.MultiIndex) else df
                d = d[["Open", "High", "Low", "Close", "Volume"]].dropna()
                if len(d) > 300:
                    d.index = pd.to_datetime(d.index).tz_localize(None)
                    frames[s] = d
            except KeyError:
                pass
        print(f"  downloaded batch {b_i + 1}/{len(batches)} ({len(frames)} stocks so far)")
        time.sleep(3)
    return frames


def demo_universe():
    sectors = ["Information Technology", "Health Care", "Financials", "Energy", "Industrials",
               "Consumer Discretionary", "Utilities", "Communication Services"]
    out = [{"symbol": s, "name": s, "sector": "Information Technology"} for s in ("AAPL", "NVDA", "TSLA")]
    for i in range(117):
        out.append({"symbol": f"S{i:03d}", "name": f"Demo {i}", "sector": sectors[i % len(sectors)]})
    return out


def demo_prices(symbols):
    """Random walks with a small planted momentum effect, so the test can find something."""
    rng = np.random.default_rng(7)
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=252 * YEARS)
    mkt = rng.normal(0.0004, 0.010, len(idx))
    sect = {k: rng.normal(0, 0.007, len(idx)) for k in range(8)}
    frames = {}
    for i, s in enumerate(symbols):
        drift = np.cumsum(rng.normal(0, 0.00004, len(idx)))  # slow-moving trend = momentum
        r = rng.uniform(0.6, 1.5) * mkt + sect[i % 8] + drift + rng.normal(0, 0.015, len(idx))
        if s in ("SPY", "QQQ"):
            r = mkt + rng.normal(0, 0.002, len(idx))
        c = rng.uniform(20, 400) * np.exp(np.cumsum(r))
        o = c * (1 + rng.normal(0, 0.004, len(idx)))
        frames[s] = pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.004, "Low": np.minimum(o, c) * 0.996,
                                  "Close": c, "Volume": rng.integers(1e6, 5e7, len(idx))}, index=idx)
    return frames


# ---------------- earnings (Finnhub, accumulates over time) ----------------

def update_earnings():
    key = os.environ.get("FINNHUB_KEY", "")
    old = pd.read_csv(EARN_FILE) if EARN_FILE.exists() else pd.DataFrame(
        columns=["symbol", "date", "hour", "eps_actual", "eps_estimate", "surprise"])
    if DEMO or not key:
        print("Earnings: no FINNHUB_KEY, skipping update")
        return old
    today = datetime.now(timezone.utc).date()
    url = (f"https://finnhub.io/api/v1/calendar/earnings?from={today - timedelta(days=35)}"
           f"&to={today + timedelta(days=45)}&token={key}")
    try:
        rows = json.loads(urllib.request.urlopen(url, timeout=30).read()).get("earningsCalendar", [])
    except Exception as e:
        print(f"Earnings update failed ({e})")
        return old
    new = pd.DataFrame([{
        "symbol": str(r.get("symbol", "")).replace(".", "-"), "date": r.get("date"), "hour": r.get("hour", ""),
        "eps_actual": r.get("epsActual"), "eps_estimate": r.get("epsEstimate")} for r in rows])
    if new.empty:
        return old
    est = pd.to_numeric(new["eps_estimate"], errors="coerce")
    act = pd.to_numeric(new["eps_actual"], errors="coerce")
    new["surprise"] = ((act - est) / est.abs().clip(lower=0.05)).clip(-1, 1)
    both = pd.concat([old, new]).drop_duplicates(["symbol", "date"], keep="last").sort_values(["symbol", "date"])
    both.to_csv(EARN_FILE, index=False)
    print(f"Earnings: {len(new)} calendar rows fetched, {len(both)} stored")
    return both


# ---------------- company logos (Finnhub, looked up once and remembered) ----------------

LOGO_FILE = DATA / "logos.json"


def update_logos(symbols):
    cache = json.loads(LOGO_FILE.read_text()) if LOGO_FILE.exists() else {}
    key = os.environ.get("FINNHUB_KEY", "")
    if DEMO or not key:
        return cache
    todo = [s for s in symbols if s not in cache][:700]
    for s in todo:
        try:
            url = f"https://finnhub.io/api/v1/stock/profile2?symbol={s.replace('-', '.')}&token={key}"
            cache[s] = json.loads(urllib.request.urlopen(url, timeout=20).read()).get("logo") or ""
        except Exception:
            pass
        time.sleep(1.1)
    if todo:
        LOGO_FILE.write_text(json.dumps(cache, separators=(",", ":")))
    print(f"Logos: {len(todo)} looked up, {sum(1 for v in cache.values() if v)} known")
    return cache


# ---------------- features ----------------

def stock_features(df, mkt_ret):
    c = df["Close"]
    r = c.pct_change()
    f = pd.DataFrame(index=df.index)
    f["mom_12_1"] = c.shift(21) / c.shift(252) - 1
    f["mom_6_1"] = c.shift(21) / c.shift(126) - 1
    f["rev_1m"] = c / c.shift(21) - 1
    f["ret_3m"] = c / c.shift(63) - 1
    f["dist_ma200"] = c / c.rolling(200).mean() - 1
    f["vol_3m"] = r.rolling(63).std() * np.sqrt(252)
    m = mkt_ret.reindex(df.index)
    f["beta_1y"] = r.rolling(252).cov(m) / m.rolling(252).var()
    f["max_day_1m"] = r.rolling(21).max()
    f["size"] = np.log((c * df["Volume"]).rolling(63).mean())
    f["ret_1w"] = c / c.shift(5) - 1
    f["day_ret"] = r
    f["day_z"] = r / r.rolling(63).std().shift(1)   # today's move in multiples of a normal day
    f["fwd"] = c.shift(-H) / c - 1           # what happens next month
    f["close"] = c
    return f


def build_panel(frames, sector_of, earnings):
    mkt_ret = frames[MARKET]["Close"].pct_change()
    parts = []
    for s, df in frames.items():
        f = stock_features(df, mkt_ret)
        f["symbol"], f["sector"] = s, sector_of.get(s, "Other")
        parts.append(f)
    p = pd.concat(parts)
    p.index.name = "date"
    p = p.reset_index()
    p["sector_3m"] = p.groupby(["date", "sector"])["ret_3m"].transform("mean")

    # earnings surprise known as of each date (only what was public by then)
    p["earn_surprise"], p["earn_days"] = np.nan, np.nan
    if earnings is not None and len(earnings):
        e = earnings.dropna(subset=["surprise"]).copy()
        e["edate"] = pd.to_datetime(e["date"])
        e = e[e["symbol"].isin(frames.keys())].sort_values("edate")
        if len(e):
            p = p.sort_values("date")
            p["symbol"] = p["symbol"].astype(object)
            e["symbol"] = e["symbol"].astype(str).astype(object)
            p["date"] = pd.to_datetime(p["date"]).astype("datetime64[ns]")
            e["edate"] = e["edate"].astype("datetime64[ns]")
            p = pd.merge_asof(p.drop(columns=["earn_surprise", "earn_days"]), e[["symbol", "edate", "surprise"]],
                              left_on="date", right_on="edate", by="symbol", direction="backward",
                              tolerance=pd.Timedelta(days=90))
            p["earn_surprise"] = p["surprise"]
            p["earn_days"] = (p["date"] - p["edate"]).dt.days
            p = p.drop(columns=["surprise", "edate"])

    spy_c = frames[MARKET]["Close"]
    mk = pd.DataFrame({"date": pd.to_datetime(spy_c.index).astype("datetime64[ns]"), "mkt_1m": spy_c.pct_change(21).values,
                       "mkt_vol": (spy_c.pct_change().rolling(21).std() * np.sqrt(252)).values})
    p["date"] = pd.to_datetime(p["date"]).astype("datetime64[ns]")
    p = p.merge(mk, on="date", how="left")
    ranked = p[~p["symbol"].isin(NOT_RANKED)].copy()
    ranked["ret_1w_pct"] = ranked.groupby("date")["ret_1w"].rank(pct=True)
    for col in RANKED:  # percentile vs. all other stocks that same day (0 = lowest, 1 = highest)
        ranked[col] = ranked.groupby("date")[col].rank(pct=True)
    ranked["target"] = ranked["fwd"] - ranked.groupby("date")["fwd"].transform("median")
    ranked["target"] = ranked["target"].clip(-0.5, 0.5)
    return ranked.sort_values(["date", "symbol"]).reset_index(drop=True), p


def usable(train):
    """Inputs with enough history to learn from (earnings data starts thin and grows nightly)."""
    return [f for f in FEATURES if train[f].notna().sum() >= 2000]


def model():
    return HistGradientBoostingRegressor(max_iter=200, learning_rate=0.04, max_depth=3,
                                         min_samples_leaf=300, l2_regularization=2.0)


# ---------------- honest test ----------------

START_EUR = 10000
COST = 0.002   # rough cost of swapping the picks each month (fees + spread), taken off every month


def walk_forward(panel, dates, spy, months=36):
    """Each month: train only on what was known, rank everyone, see what happened a month later."""
    weekly = set(dates[::-5])
    train_pool = panel[panel["date"].isin(weekly)].dropna(subset=["target"])
    test_idx = list(range(len(dates) - 1 - H, H * 13, -H))[:months][::-1]
    rows, series, obs = [], [], []
    cum_b, cum_m = 0.0, 0.0
    paper = []
    val = {"brain": START_EUR, "momentum": START_EUR, "spy": START_EUR}
    for i in test_idx:
        d, cutoff = dates[i], dates[i - H]
        train = train_pool[train_pool["date"] <= cutoff]
        test = panel[(panel["date"] == d)].dropna(subset=["target", "mom_12_1"])
        if len(train) < 5000 or len(test) < 50:
            continue
        cols = usable(train)
        pred = model().fit(train[cols], train["target"]).predict(test[cols])
        t = test.assign(pred=pred)
        t = t.assign(pred_pct=t["pred"].rank(pct=True), brain_rank=t["pred"].rank(ascending=False, method="first"))
        obs.append(t[["date", "symbol", "pred_pct", "brain_rank", "target", "fwd", "mom_12_1", "rev_1m", "vol_3m", "sector_3m"]])
        q = max(len(t) // 5, 1)
        ic = t["pred"].rank().corr(t["target"].rank())
        top = t.nlargest(q, "pred")["target"].mean()
        bot = t.nsmallest(q, "pred")["target"].mean()
        m_ic = t["mom_12_1"].rank().corr(t["target"].rank())
        m_top = t.nlargest(q, "mom_12_1")["target"].mean()
        m_bot = t.nsmallest(q, "mom_12_1")["target"].mean()
        cum_b += top - bot
        cum_m += m_top - m_bot
        # paper portfolio: put the money equally into the top 20, hold one month, repeat
        b_ret = t.nlargest(BASKET, "pred")["fwd"].mean() - COST
        m_ret = t.nlargest(BASKET, "mom_12_1")["fwd"].mean() - COST
        si = spy.index.get_indexer([pd.Timestamp(d)])[0]
        s_ret = float(spy.iloc[si + H] / spy.iloc[si] - 1) if si >= 0 and si + H < len(spy) else 0.0
        if not paper:
            paper.append({"time": pd.Timestamp(d).strftime("%Y-%m-%d"), **{k: START_EUR for k in val}})
        val["brain"] *= 1 + b_ret
        val["momentum"] *= 1 + m_ret
        val["spy"] *= 1 + s_ret
        end = spy.index[min(si + H, len(spy) - 1)]
        paper.append({"time": end.strftime("%Y-%m-%d"), **{k: round(v, 2) for k, v in val.items()},
                      "b_ret": round(float(b_ret), 4), "s_ret": round(s_ret, 4)})
        rows.append({"date": d, "ic": ic, "spread": top - bot, "m_ic": m_ic, "m_spread": m_top - m_bot})
        series.append({"time": pd.Timestamp(d).strftime("%Y-%m-%d"), "brain": round(cum_b, 4), "momentum": round(cum_m, 4)})
        print(f"  tested {pd.Timestamp(d).date()}: rank accuracy {ic:+.3f}, top minus bottom {top - bot:+.2%}")
    r = pd.DataFrame(rows)

    def summary(ic, spread):
        n = len(spread)
        return {"months": int(n), "ic": float(ic.mean()), "ic_positive": float((ic > 0).mean()),
                "spread": float(spread.mean()), "spread_wins": int((spread > 0).sum()),
                "t": float(spread.mean() / (spread.std(ddof=1) / np.sqrt(n))) if n > 2 and spread.std() > 0 else 0.0}
    beat = sum(1 for x in paper[1:] if x["b_ret"] > x["s_ret"])
    return {"brain": summary(r["ic"], r["spread"]), "momentum": summary(r["m_ic"], r["m_spread"]), "series": series,
            "paper": paper, "paper_beat_spy": beat, "paper_months": len(paper) - 1, "cost": COST,
            "_obs": pd.concat(obs, ignore_index=True)}


# ---------------- likelihoods: chance a stock is higher in a month ----------------

ODDS_PCT = {"year": "mom_12_1", "month": "rev_1m", "week": "ret_1w_pct", "jumpy": "vol_3m",
            "trend": "dist_ma200", "industry": "sector_3m"}          # already percentiles (0 to 1)
ODDS_KEYS = list(ODDS_PCT) + ["day", "mkt_1m", "mkt_vol"]


def odds_x(df, stats, keys=None):
    X = pd.DataFrame({k: df[c] - 0.5 for k, c in ODDS_PCT.items()}, index=df.index)
    X["day"] = df["day_z"].clip(-4, 4) / 4
    for k in ("mkt_1m", "mkt_vol"):
        X[k] = (df[k] - stats[k][0]) / (stats[k][1] or 1)
    return X[keys or ODDS_KEYS].fillna(0).clip(-3, 3)


def odds_fit(train, keys=None):
    stats = {k: (float(train[k].mean()), float(train[k].std())) for k in ("mkt_1m", "mkt_vol")}
    m = LogisticRegression(C=0.05, max_iter=300).fit(odds_x(train, stats, keys), (train["fwd"] > 0).astype(int))
    return m, stats


def build_odds(panel, full, dates, months=36):
    """A simple, explainable model: start from how often stocks rise in a month, then nudge that
    chance up or down for each clue. Tested by walking forward month by month, never peeking."""
    weekly = set(dates[::-5])
    pool = panel[panel["date"].isin(weekly)].dropna(subset=["fwd", "mom_12_1"])
    test_idx = list(range(len(dates) - 1 - H, H * 13, -H))[:months][::-1]
    def walk(keys):
        got = []
        for i in test_idx:
            d, cutoff = dates[i], dates[i - H]
            train = pool[pool["date"] <= cutoff]
            test = panel[panel["date"] == d].dropna(subset=["fwd", "mom_12_1"])
            if len(train) < 5000 or len(test) < 50:
                continue
            m, st = odds_fit(train, keys)
            got.append(pd.DataFrame({"p": m.predict_proba(odds_x(test, st, keys))[:, 1], "up": (test["fwd"] > 0).values}))
        return got

    # two honest candidates: with and without trying to read the whole market's mood.
    # Market timing is notoriously unreliable, so keep it only if it tested better.
    tried = {}
    for name, keys in (("company clues only", ODDS_KEYS[:7]), ("company clues + market mood", ODDS_KEYS)):
        g = walk(keys)
        oo = pd.concat(g, ignore_index=True)
        tried[name] = (float(((oo["p"] - oo["up"]) ** 2).mean()), keys, g, oo)
        print(f"  odds variant '{name}': brier {tried[name][0]:.4f}")
    best = min(tried, key=lambda k: tried[k][0])
    _, KEYS, got, o = tried[best]
    base = float(o["up"].mean())
    bins = []
    for lo in range(30, 85, 5):
        g = o[(o["p"] >= lo / 100) & (o["p"] < (lo + 5) / 100)]
        if len(g) >= 40:
            bins.append({"lo": lo, "hi": lo + 5, "said": r(g["p"].mean(), 3), "happened": r(g["up"].mean(), 3), "n": int(len(g))})
    summary = {"months": len(got), "n": int(len(o)), "base": r(base, 3),
               "hit": r(((o["p"] >= 0.5) == o["up"]).mean(), 3), "hit_base": r(max(base, 1 - base), 3),
               "brier": r(((o["p"] - o["up"]) ** 2).mean(), 4), "brier_base": r(((base - o["up"]) ** 2).mean(), 4),
               "spread": [r(o["p"].quantile(0.05), 3), r(o["p"].quantile(0.95), 3)], "bins": bins, "variant": best}

    # plain history for each clue: how often did such stocks end the month higher?
    up = pool["fwd"] > 0

    def rate(mask):
        return {"rate": r(up[mask].mean(), 3), "n": int(mask.sum())} if mask.sum() >= 50 else None
    freq = {"all": {"rate": r(up.mean(), 3), "n": int(len(pool))}}
    for k, c in ODDS_PCT.items():
        freq[k + "_high"], freq[k + "_low"] = rate(pool[c] >= 0.8), rate(pool[c] <= 0.2)
    freq["day_high"], freq["day_low"] = rate(pool["day_z"] >= 2.5), rate(pool["day_z"] <= -2.5)
    ms = pool.groupby("date")["mkt_1m"].first()
    freq["market_high"] = rate(pool["mkt_1m"] >= ms.quantile(0.8))
    freq["market_low"] = rate(pool["mkt_1m"] <= ms.quantile(0.2))
    summary["freq"] = freq

    # today's chances, and what moves each one
    m, st = odds_fit(pool, KEYS)
    today = panel[panel["date"] == dates[-1]].dropna(subset=["mom_12_1"])
    X = odds_x(today, st, KEYS)
    w, b = m.coef_[0], float(m.intercept_[0])
    sig = lambda z: 1 / (1 + np.exp(-z))
    z = b + X.values @ w
    raw = full[full["date"] == dates[-1]].set_index("symbol")
    per = {}
    for n_, (sym, zi) in enumerate(zip(today["symbol"], z)):
        x = X.iloc[n_].values
        pf = float(sig(zi))
        why = {k: float(pf - sig(zi - w[j] * x[j])) for j, k in enumerate(KEYS[:7])}
        why["market"] = float(pf - sig(zi - w[7] * x[7] - w[8] * x[8])) if len(KEYS) > 7 else 0.0
        rw, t = raw.loc[sym], today.iloc[n_]
        vals = {"year": [r(rw["mom_12_1"], 3), r(t["mom_12_1"], 2)], "month": [r(rw["rev_1m"], 3), r(t["rev_1m"], 2)],
                "week": [r(rw["ret_1w"], 3), r(t["ret_1w_pct"], 2)], "jumpy": [r(rw["vol_3m"], 3), r(t["vol_3m"], 2)],
                "trend": [r(rw["dist_ma200"], 3), r(t["dist_ma200"], 2)], "industry": [r(rw["sector_3m"], 3), r(t["sector_3m"], 2)],
                "day": [r(rw["day_ret"], 4), r(rw["day_z"], 1)], "market": [r(rw["mkt_1m"], 3), None]}
        per[sym] = {"p": r(pf, 3), "vp": r(t["vol_3m"], 2),
                    "why": sorted(({"k": k, "d": r(v, 3), "v": vals[k]} for k, v in why.items()), key=lambda q: -abs(q["d"]))}
    summary["neutral"] = r(float(sig(b)), 3)
    print(f"Odds model: base {base:.3f}, hit {summary['hit']} vs {summary['hit_base']}, brier {summary['brier']} vs {summary['brier_base']}, spread {summary['spread']}")
    return summary, per


# ---------------- today's story (for the living cell) ----------------

def today_summary(frames, sector_of):
    """What happened on the latest trading day: market, industries, and each stock's move with its likely cause."""
    rets = pd.DataFrame({s: df["Close"].pct_change().iloc[-70:] for s, df in frames.items()})
    last, typical = rets.iloc[-1], rets.iloc[-64:-1].std()
    sec = pd.Series({s: sector_of.get(s, "Other") for s in rets.columns})
    sector_med = last.groupby(sec).median()
    m = float(last.get(MARKET, 0) or 0)
    per = {}
    for s in rets.columns:
        ret = last[s]
        if pd.isna(ret) or pd.isna(typical[s]) or typical[s] == 0:
            continue
        z, sr = float(ret / typical[s]), float(sector_med[sec[s]])
        same = lambda x: np.sign(x) == np.sign(ret) and abs(x) >= 0.5 * abs(ret)
        if abs(z) < 1.5 or abs(ret) < 0.01:
            cause = "quiet"
        elif s in NOT_RANKED or same(m):
            cause = "market"
        elif same(sr):
            cause = "sector"
        else:
            cause = "company"
        v = frames[s]["Volume"]
        vx = float(v.iloc[-1] / v.iloc[-51:-1].mean()) if len(v) > 51 and v.iloc[-51:-1].mean() > 0 else None
        per[s] = {"ret": float(ret), "z": z, "cause": cause, "sector": sr, "vx": vx}
    stocks = [s for s in per if s not in NOT_RANKED]
    sectors = [{"name": k, "move": r(v), "n": int((sec == k).sum()),
                "up": r(float((last[sec[sec == k].index] > 0).mean()), 2)}
               for k, v in sector_med.items() if k != "Benchmark"]
    movers = sorted([s for s in stocks if abs(per[s]["ret"]) >= 0.02], key=lambda s: -abs(per[s]["z"]))[:12]
    return {"date": rets.index[-1].strftime("%Y-%m-%d"), "market": r(m), "per": per,
            "up": int(sum(per[s]["ret"] > 0 for s in stocks)), "total": len(stocks),
            "sectors": sorted(sectors, key=lambda x: -(x["move"] or 0)), "movers": movers}


# ---------------- category funds: one fund per category, holding that category's S&P 500 companies ----------------

FUNDS = {"XLK": "Information Technology", "XLF": "Financials", "XLV": "Health Care", "XLY": "Consumer Discretionary",
         "XLP": "Consumer Staples", "XLE": "Energy", "XLI": "Industrials", "XLB": "Materials", "XLU": "Utilities",
         "XLRE": "Real Estate", "XLC": "Communication Services"}


def fund_rows(fund_frames, today, first_day):
    """The same time periods as for the companies, counted from each fund's own closing prices."""
    rows = []
    for sym, sector in FUNDS.items():
        df = fund_frames.get(sym)
        if df is None:
            continue
        c = df["Close"][df.index <= today]
        if len(c) < 3:
            continue

        def back(n):
            return r(c.iloc[-1] / c.iloc[-1 - n] - 1, 6) if len(c) > n else None

        def cal(**ago):
            before = c[c.index <= today - pd.DateOffset(**ago)]
            return r(c.iloc[-1] / before.iloc[-1] - 1, 6) if len(before) else None

        before_year = c[c.index.year < today.year]
        rows.append({"s": sym, "sec": sector, "px": r(c.iloc[-1], 2), "d1": back(1), "w1": back(5),
                     "c1m": cal(months=1), "c6m": cal(months=6), "c1y": cal(years=1), "c5y": cal(years=5),
                     "ytd": r(c.iloc[-1] / before_year.iloc[-1] - 1, 6) if len(before_year) else None,
                     "mx": r(c.iloc[-1] / c.iloc[0] - 1, 6) if c.index[0] <= first_day + pd.Timedelta(days=7) else None})
    return rows


# ---------------- where the trading goes (category money report) ----------------

FLOW_DAYS = 252     # days kept in the daily record (about one year)
FLOW_USUAL = 60     # "usual" = the 60 trading days before
FLOW_Z = 1.0        # "more than usual" = above the usual share by more than its normal daily wobble


def build_flows(frames, sector_of):
    """Each day: every category's share of all money traded, compared with its usual share, plus price direction.
    IN = bigger share than usual and prices rose. OUT = bigger share than usual and prices fell.
    Everything here is counted from daily prices and volumes. Who traded is not in the data."""
    syms = [s for s in frames if s not in NOT_RANKED and sector_of.get(s, "Other") != "Benchmark"]
    close = pd.DataFrame({s: frames[s]["Close"] for s in syms}).sort_index()
    dv = (close * pd.DataFrame({s: frames[s]["Volume"] for s in syms}).sort_index()).fillna(0.0)
    ret = close.pct_change(fill_method=None)
    sec = pd.Series({s: sector_of.get(s, "Other") for s in syms})
    names = sorted(sec.unique())
    cols = {k: list(sec[sec == k].index) for k in names}

    sec_dv = pd.DataFrame({k: dv[cols[k]].sum(axis=1) for k in names})
    total = sec_dv.sum(axis=1)
    share = sec_dv.div(total, axis=0)
    usual = share.rolling(FLOW_USUAL).mean().shift(1)
    wobble = share.rolling(FLOW_USUAL).std().shift(1)
    z = (share - usual) / wobble
    move = pd.DataFrame({k: ret[cols[k]].median(axis=1) for k in names})
    ups = pd.DataFrame({k: (ret[cols[k]] > 0).sum(axis=1) for k in names})
    cnt = pd.DataFrame({k: ret[cols[k]].notna().sum(axis=1) for k in names})
    mkt = ret.median(axis=1)
    state = pd.DataFrame(0, index=share.index, columns=names)
    state[(z >= FLOW_Z) & (move > 0)] = 1
    state[(z >= FLOW_Z) & (move < 0)] = -1
    usual_dv = dv.rolling(FLOW_USUAL).mean().shift(1)
    usual_total = total.rolling(FLOW_USUAL).mean().shift(1)

    # what happened afterwards (all history we have), compared with the typical company
    idx = (1 + move.fillna(0)).cumprod()
    midx = (1 + mkt.fillna(0)).cumprod()
    valid = z.notna()
    outcomes = {}
    for h in (5, 21):
        fwd = idx.shift(-h) / idx - 1
        rel = fwd.sub(midx.shift(-h) / midx - 1, axis=0)
        ok = valid & fwd.notna()

        def stat(mask):
            m = mask.to_numpy()
            f, rl = pd.Series(fwd.to_numpy()[m]), pd.Series(rel.to_numpy()[m])
            n = int(len(f))
            return {"n": n, "higher": int((f > 0).sum()), "beat": int((rl > 0).sum()),
                    "avg": r(f.mean()) if n else None, "rel": r(rl.mean()) if n else None}

        per = {}
        for k in names:
            def one(mask, k=k):
                f, rl = fwd[k][mask], rel[k][mask]
                return {"n": int(len(f)), "higher": int((f > 0).sum()), "beat": int((rl > 0).sum()),
                        "avg": r(f.mean()) if len(f) else None, "rel": r(rl.mean()) if len(f) else None}
            per[k] = {"in": one(ok[k] & (state[k] == 1)), "out": one(ok[k] & (state[k] == -1)), "any": one(ok[k])}
        outcomes[str(h)] = {"in": stat(ok & (state == 1)), "out": stat(ok & (state == -1)), "any": stat(ok), "per": per}

    days = []
    for d in share.index[valid.all(axis=1)][-FLOW_DAYS:]:
        extra = (share.loc[d] - usual.loc[d]) * 100          # percentage points of all money traded
        gain = extra[extra > 0]
        rows, clues = [], {}
        for k in names:
            st = int(state.at[d, k])
            rows.append([r(extra[k], 2), r(z.at[d, k], 1), r(move.at[d, k]), int(ups.at[d, k]), int(cnt.at[d, k]), st, r(share.at[d, k] * 100, 1)])
            if st == 0:
                continue
            c = cols[k]
            today_dv, base = dv.loc[d, c], usual_dv.loc[d, c]
            big = list(base.sort_values(ascending=False).index[:5])
            more = (today_dv - base).clip(lower=0)
            top = more.idxmax() if more.sum() > 0 else None
            clues[k] = {"big_now": r(today_dv[big].sum() / today_dv.sum(), 3) if today_dv.sum() > 0 else None,
                        "big_usual": r(base[big].sum() / base.sum(), 3) if base.sum() > 0 else None,
                        "top": top, "top_share": r(more[top] / more.sum(), 3) if top else None,
                        "top_move": r(ret.at[d, top]) if top else None}
        days.append({"d": d.strftime("%Y-%m-%d"), "mk": r(mkt[d]), "tot": r(total[d] / 1e9, 1),
                     "tot_usual": r(usual_total[d] / 1e9, 1),
                     "shift": r(gain.sum(), 2), "lead": r(gain.max() / gain.sum(), 2) if gain.sum() > 0 else None,
                     "rows": rows, "clues": clues})
    return {"names": names, "usual_days": FLOW_USUAL, "z": FLOW_Z, "days": days, "outcomes": outcomes,
            "history_from": share.index[valid.all(axis=1)][0].strftime("%Y-%m-%d") if valid.all(axis=1).any() else None,
            "typical_shift": r(float(np.median([x["shift"] for x in days])), 2) if days else None}


# ---------------- prediction game ----------------

GAME_ROUNDS = 300
LOOKBACK = 126   # about 6 months of chart before the decision


def build_game(obs, full, frames, meta, latest, dates):
    """Replay rounds from the honest test (the brain never saw the answer), today's live picks,
    and real hit rates for each kind of clue."""
    raw = full[["date", "symbol", "mom_12_1", "rev_1m", "vol_3m", "sector_3m"]].rename(
        columns={c: "raw_" + c for c in ("mom_12_1", "rev_1m", "vol_3m", "sector_3m")})
    o = obs.merge(raw, on=["date", "symbol"], how="left")
    o["beat"] = o["target"] > 0
    o["mkt"] = o.groupby("date")["fwd"].transform("median")
    o["n"] = o.groupby("date")["symbol"].transform("count")

    def rate(mask):
        g = o[mask]
        return {"rate": r(g["beat"].mean(), 3), "n": int(len(g))} if len(g) else {"rate": None, "n": 0}
    lessons = {
        "mom_high": rate(o["mom_12_1"] >= 0.8), "mom_low": rate(o["mom_12_1"] <= 0.2),
        "rev_high": rate(o["rev_1m"] >= 0.8), "rev_low": rate(o["rev_1m"] <= 0.2),
        "vol_high": rate(o["vol_3m"] >= 0.8), "vol_low": rate(o["vol_3m"] <= 0.2),
        "sec_high": rate(o["sector_3m"] >= 0.8), "sec_low": rate(o["sector_3m"] <= 0.2),
        "brain_top": rate(o["pred_pct"] >= 0.8), "brain_bottom": rate(o["pred_pct"] <= 0.2),
        "brain_all": {"rate": r(((o["pred_pct"] >= 0.5) == o["beat"]).mean(), 3), "n": int(len(o))},
    }

    spy = frames[MARKET]["Close"]

    def series(c, i, after):
        w = c.iloc[i - LOOKBACK: i + after + 1]
        return [round(float(v), 1) for v in (w / w.iloc[0] * 100)]

    def clues(x):
        return {"mom": [r(x["raw_mom_12_1"], 3), r(x["mom_12_1"], 2)], "rev": [r(x["raw_rev_1m"], 3), r(x["rev_1m"], 2)],
                "vol": [r(x["raw_vol_3m"], 3), r(x["vol_3m"], 2)], "sec": [r(x["raw_sector_3m"], 3), r(x["sector_3m"], 2)]}

    pool = o[(o["target"].abs() > 0.005)].sample(frac=1, random_state=42)
    rounds, market = [], {}
    for _, x in pool.iterrows():
        if len(rounds) >= GAME_ROUNDS:
            break
        s, d = x["symbol"], pd.Timestamp(x["date"])
        c = frames[s]["Close"]
        i, j = c.index.get_indexer([d])[0], spy.index.get_indexer([d])[0]
        if i < LOOKBACK or j < LOOKBACK or i + H >= len(c) or j + H >= len(spy) or pd.isna(x["raw_vol_3m"]):
            continue
        ds = d.strftime("%Y-%m-%d")
        market.setdefault(ds, series(spy, j, H))
        rounds.append({"id": f"{s}|{ds}", "s": s, "n": meta[s]["name"], "sec": meta[s]["sector"], "d": ds,
                       "px": series(c, i, H), "clues": clues(x), "ret": r(x["fwd"], 3), "mkt": r(x["mkt"], 3),
                       "beat": bool(x["beat"]), "bp": r(x["pred_pct"], 2), "br": int(x["brain_rank"]), "of": int(x["n"])})

    # today's live picks: 5 well-known (heavily traded) stocks, a new set each day
    today = dates[-1]
    L = latest.reset_index().merge(raw[raw["date"] == today].drop(columns="date"), on="symbol", how="left")
    big = L[L["size"] >= 0.7].dropna(subset=["raw_vol_3m"])
    picks = big.sample(n=min(5, len(big)), random_state=int(today.strftime("%Y%m%d")))
    j = len(spy) - 1
    live = {"date": today.strftime("%Y-%m-%d"), "market": series(spy, j, 0), "picks": []}
    for _, x in picks.iterrows():
        c = frames[x["symbol"]]["Close"]
        if len(c) <= LOOKBACK:
            continue
        live["picks"].append({"s": x["symbol"], "n": meta[x["symbol"]]["name"], "sec": meta[x["symbol"]]["sector"],
                              "px": series(c, len(c) - 1, 0), "clues": clues(x), "close": r(c.iloc[-1], 2),
                              "bp": r(x["pct"], 2), "br": int(x["rank"]), "of": int(len(latest))})

    # recent closing prices, so the browser can score live guesses a month later
    recent = dates[-60:]
    closes = pd.DataFrame({s: frames[s]["Close"].reindex(recent) for s in latest.index})
    px = {s: [None if pd.isna(v) else round(float(v), 2) for v in closes[s]] for s in closes.columns}
    return {"horizon": H, "lookback": LOOKBACK, "lessons": lessons, "rounds": rounds, "market": market, "live": live,
            "closes": {"dates": [d.strftime("%Y-%m-%d") for d in recent], "px": px}}


# ---------------- why did it move ----------------

NEWS_CACHE = DATA / "news_cache.json"
NEWS_PER_RUN = int(os.environ.get("NEWS_PER_RUN", "300"))


def find_moves(frames, sector_of, earnings, days=300):
    """For every stock: its unusually big days, and what most likely caused each one."""
    rets = pd.DataFrame({s: df["Close"].pct_change() for s, df in frames.items()})
    vols = pd.DataFrame({s: df["Volume"] / df["Volume"].rolling(50).mean().shift(1) for s, df in frames.items()})
    typical = rets.rolling(63).std().shift(1)
    sec_cols = pd.Series({s: sector_of.get(s, "Other") for s in rets.columns})
    sector_ret = rets.T.groupby(sec_cols).median().T
    mkt = rets[MARKET]
    trading_days = rets.index
    window = trading_days[-days:]

    # which trading day did each earnings report hit? (after close: the next day)
    hit = {}
    if earnings is not None and len(earnings):
        for _, e in earnings.iterrows():
            try:
                d = pd.Timestamp(e["date"])
            except Exception:
                continue
            j = trading_days.searchsorted(d)
            if j >= len(trading_days):
                continue
            day = trading_days[j]
            if str(e.get("hour", "")).lower() == "amc" and trading_days[j] == d and j + 1 < len(trading_days):
                day = trading_days[j + 1]
            hit[(e["symbol"], day)] = e.get("surprise")

    out = {}
    for s in rets.columns:
        r_ = rets[s].reindex(window)
        z = (r_ / typical[s].reindex(window)).abs()
        big = r_[(z >= 2.5) & (r_.abs() >= 0.03)]
        sec = sector_of.get(s, "Other")
        moves = []
        for day, ret in big.items():
            m, sr = float(mkt.get(day, 0) or 0), float(sector_ret.at[day, sec]) if sec in sector_ret else 0.0
            same = lambda x: np.sign(x) == np.sign(ret) and abs(x) >= 0.5 * abs(ret)
            if (s, day) in hit:
                cause, sur = "earnings", hit[(s, day)]
            elif s in NOT_RANKED or same(m):
                cause, sur = "market", None
            elif same(sr):
                cause, sur = "sector", None
            else:
                cause, sur = "company", None
            moves.append({"date": day.strftime("%Y-%m-%d"), "ret": r(ret), "market": r(m), "sector": r(sr),
                          "volume_x": r(vols.at[day, s], 1), "cause": cause,
                          "surprise": r(sur) if sur is not None and not pd.isna(sur) else None})
        counts = {k: sum(1 for x in moves if x["cause"] == k) for k in ("earnings", "market", "sector", "company")}
        top = sorted(moves, key=lambda x: -abs(x["ret"]))[:8]
        out[s] = {"top": sorted(top, key=lambda x: x["date"]), "counts": counts, "total": len(moves)}
    return out


STOP = set("""the a an and or of to in on for with from by at as is are was were be been its it this that after before
over under into than then says said say will would could should may might has have had not new stock stocks shares share
company inc corp what why how here amid about just more most year week today monday tuesday wednesday thursday friday""".split())


def rank_headlines(items, sym, name):
    """Group a day's headlines into stories and count how many headlines told each story.
    Two headlines are the same story when they share enough of their distinctive words.
    Returns the stories, most reported first. Counting only, no guessing about what moved the price."""
    own = {w for w in "".join(ch.lower() if ch.isalnum() else " " for ch in f"{sym} {name}").split()}
    seen, rows = set(), []
    for it in items:
        h = (it.get("headline") or "").strip()
        k = "".join(ch.lower() for ch in h if ch.isalnum())[:60]
        if not h or k in seen:
            continue
        seen.add(k)
        words = {w[:6] for w in "".join(ch.lower() if ch.isalnum() else " " for ch in h).split()
                 if len(w) > 3 and w not in STOP and w not in own}      # first 6 letters: "reinstates" = "reinstated"
        rows.append((h, it, words))
    freq = {}
    for _, _, words in rows:
        for w in words:
            freq[w] = freq.get(w, 0) + 1
    scored = []
    for h, it, words in rows:
        score = sum(freq[w] - 1 for w in words) / (len(words) ** 0.5 or 1)
        if any(w in h.lower() for w in own if len(w) > 2):
            score *= 1.5          # the headline names this company
        scored.append((score, it.get("datetime", 0), h, it, words))
    scored.sort(key=lambda x: (-x[0], x[1]))
    stories = []   # each: {"words": words of its first headline, "members": [(headline, item, words)]}
    for _, _, h, it, words in scored:
        for st in stories:
            both = words & st["words"]
            if len(both) >= 2 and len(both) / max(1, min(len(words), len(st["words"]))) >= 0.4:
                st["members"].append((h, it, words))
                break
        else:
            stories.append({"words": words, "members": [(h, it, words)]})
    out = []
    for st in stories:
        # show the plainest headline of the story: the one whose words the others share most; questions rank lower
        wf = {}
        for _, _, words in st["members"]:
            for w in words:
                wf[w] = wf.get(w, 0) + 1
        best = max(st["members"], key=lambda m: sum(wf[w] for w in m[2]) / (len(m[2]) or 1) * (0.5 if "?" in m[0] else 1))
        out.append({"headline": best[0][:170], "source": best[1].get("source", ""), "url": best[1].get("url", ""), "count": len(st["members"])})
    out.sort(key=lambda x: -x["count"])
    return out, len(rows)


def attach_news(moves, priority, names):
    """For each big move, collect the news from that day (Finnhub, remembered between runs).
    Window: from the previous close to the close of the day the price moved."""
    cache = json.loads(NEWS_CACHE.read_text()) if NEWS_CACHE.exists() else {}
    key = os.environ.get("FINNHUB_KEY", "")
    todo = []
    for s, m in moves.items():
        for mv in m["top"]:
            c = cache.get(f"{s}|{mv['date']}")
            fresh = isinstance(c, dict) and c.get("v") == 2 and c.get("f", "") > mv["date"]   # counted, and fetched after that day ended
            if mv["cause"] in ("company", "earnings") and not fresh:
                todo.append((0 if s in priority else 1, -pd.Timestamp(mv["date"]).toordinal(), -abs(mv["ret"]), s, mv["date"]))
    todo.sort()
    fetched = 0
    if key and not DEMO:
        for _, _, _, s, d in todo[:NEWS_PER_RUN]:
            day = pd.Timestamp(d)
            prev = day - timedelta(days=3 if day.weekday() == 0 else 1)   # Monday: include the weekend
            url = (f"https://finnhub.io/api/v1/company-news?symbol={s.replace('-', '.')}"
                   f"&from={prev.date()}&to={day.date()}&token={key}")
            try:
                items = json.loads(urllib.request.urlopen(url, timeout=20).read()) or []
            except Exception:
                time.sleep(1.1)
                continue
            lo, hi = (prev + timedelta(hours=20)).timestamp(), (day + timedelta(hours=21, minutes=30)).timestamp()
            ranked, n = rank_headlines([it for it in items if lo <= it.get("datetime", 0) <= hi], s, names.get(s, ""))
            cache[f"{s}|{d}"] = {"v": 2, "f": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "n": n, "items": ranked[:8]}
            fetched += 1
            time.sleep(1.1)  # stay under 60 calls a minute
        NEWS_CACHE.write_text(json.dumps(cache, separators=(",", ":")))
    for s, m in moves.items():
        for mv in m["top"]:
            c = cache.get(f"{s}|{mv['date']}")
            mv["news"] = c if isinstance(c, dict) and "items" in c else ({"n": 1, "items": [c]} if c else None)
    print(f"News: {fetched} days of news fetched this run, {len(todo) - fetched} still to look up")


# ---------------- live record ----------------

def update_rank_log(panel_latest, frames, dates, run_date):
    log = pd.read_csv(RANK_LOG) if RANK_LOG.exists() else pd.DataFrame(
        columns=["formed", "symbol", "rank", "pct", "score", "base_close", "end_close", "ret", "excess"])
    spy = frames[MARKET]["Close"]
    pos = {d.strftime("%Y-%m-%d"): i for i, d in enumerate(spy.index)}

    # score finished months
    pending = log["end_close"].isna()
    for formed in log.loc[pending, "formed"].unique():
        b = pos.get(formed)
        if b is None or b + H >= len(spy):
            continue
        end_date = spy.index[b + H]
        idx = log.index[(log["formed"] == formed)]
        for i in idx:
            df = frames.get(log.at[i, "symbol"])
            if df is None or end_date not in df.index:
                continue
            log.at[i, "end_close"] = float(df.at[end_date, "Close"])
            log.at[i, "ret"] = log.at[i, "end_close"] / log.at[i, "base_close"] - 1
        sub = log.loc[idx, "ret"].astype(float)
        log.loc[idx, "excess"] = sub - sub.median()

    # freeze a new ranking once a month
    last = log["formed"].max() if len(log) else None
    today = dates[-1].strftime("%Y-%m-%d")
    due = last is None or (pos.get(last) is not None and len(spy) - 1 - pos[last] >= H)
    if due and today not in set(log["formed"]):
        new = panel_latest[["symbol", "rank", "pct", "score", "close"]].rename(columns={"close": "base_close"})
        new.insert(0, "formed", today)
        log = pd.concat([log, new], ignore_index=True)
        print(f"Froze a new monthly ranking on {today}")
    log.to_csv(RANK_LOG, index=False)

    baskets = []
    for formed, g in log.groupby("formed"):
        g = g.sort_values("rank")
        top, bot = g.head(BASKET), g.tail(BASKET)
        done = g["end_close"].notna().all() and len(g)
        b = pos.get(formed)
        spy_ret = None
        if done and b is not None and b + H < len(spy):
            spy_ret = float(spy.iloc[b + H] / spy.iloc[b] - 1)
        baskets.append({"formed": formed, "scored": bool(done),
                        "top": [s for s in top["symbol"]], "bottom": [s for s in bot["symbol"]],
                        "top_ret": r(top["ret"].astype(float).mean()) if done else None,
                        "bottom_ret": r(bot["ret"].astype(float).mean()) if done else None,
                        "all_ret": r(g["ret"].astype(float).median()) if done else None,
                        "spy_ret": r(spy_ret)})
    # live paper portfolio: 10,000 EUR into each month's frozen top 20
    value, months_done = START_EUR, []
    for b in baskets:
        if b["scored"] and b["top_ret"] is not None:
            value *= 1 + b["top_ret"] - COST
            spy_v = b["spy_ret"]
            months_done.append({"formed": b["formed"], "ret": b["top_ret"], "spy": spy_v, "value": round(value, 2)})
    cur = next((b for b in reversed(baskets) if not b["scored"]), None)
    holdings = []
    if cur:
        g = log[(log["formed"] == cur["formed"])].sort_values("rank").head(BASKET)
        holdings = [{"symbol": x["symbol"], "rank": int(x["rank"]), "base_close": r(x["base_close"], 2)} for _, x in g.iterrows()]
    live_paper = {"start": START_EUR, "started": baskets[0]["formed"] if baskets else None, "months": months_done,
                  "value_before_current": round(value, 2), "current_formed": cur["formed"] if cur else None,
                  "holdings": holdings}
    return log, baskets, live_paper


# ---------------- helpers ----------------

def r(x, n=4):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(x) or np.isinf(x) else round(x, n)


def write_js(path, prefix, obj):
    path.write_text(prefix + json.dumps(obj, allow_nan=False, separators=(",", ":")) + ";\n")


# ---------------- main ----------------

def main():
    t0 = time.time()
    DATA.mkdir(exist_ok=True)
    STOCK_DIR.mkdir(exist_ok=True)
    run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    universe = load_universe()
    meta = {m["symbol"]: m for m in universe}
    frames = download_all([m["symbol"] for m in universe])
    if MARKET not in frames:
        sys.exit("Market benchmark SPY missing, stopping")
    print(f"Prices loaded for {len(frames)} of {len(universe)} stocks")
    earnings = update_earnings()
    logos = update_logos(list(frames))

    panel, full = build_panel(frames, {s: meta[s]["sector"] for s in frames}, earnings)
    dates = np.sort(panel["date"].unique())
    dates = pd.DatetimeIndex(dates)

    test = walk_forward(panel, dates, frames[MARKET]["Close"])
    obs = test.pop("_obs")
    odds, odds_per = build_odds(panel, full, dates)
    print("Backtest brain:", test["brain"])
    print("Backtest momentum:", test["momentum"])

    weekly = set(dates[::-5])
    train = panel[panel["date"].isin(weekly)].dropna(subset=["target"])
    cols = usable(train)
    brain = model().fit(train[cols], train["target"])
    print(f"Final brain trained on {len(train):,} snapshots using {len(cols)} inputs: {cols}")

    # global importance: how much shuffling each input hurts the ranking (recent year)
    recent = train[train["date"] >= dates[-260]]
    base = brain.predict(recent[cols])
    rng = np.random.default_rng(0)
    imp = {}
    for col in cols:
        sh = recent[cols].copy()
        sh[col] = rng.permutation(sh[col].values)
        imp[col] = float(np.abs(brain.predict(sh) - base).mean())
    tot = sum(imp.values()) or 1
    importance = sorted(({"key": k, "label": LABELS[k], "share": round(v / tot, 3)} for k, v in imp.items()),
                        key=lambda x: -x["share"])

    latest = panel[panel["date"] == dates[-1]].dropna(subset=["mom_12_1"]).copy()
    latest["score"] = brain.predict(latest[cols])
    latest["rank"] = latest["score"].rank(ascending=False, method="first").astype(int)
    latest["pct"] = 1 - (latest["rank"] - 1) / max(len(latest) - 1, 1)
    latest = latest.set_index("symbol")

    log, baskets, live_paper = update_rank_log(latest.reset_index(), frames, dates, run_date)
    ranked_order = latest.sort_values("rank").index.tolist()
    tentacles = [s for s in PINNED if s in frames] + [s for s in ranked_order if s not in PINNED]
    tentacles = tentacles[:N_TENTACLES]
    tent = set(tentacles)

    # threads: stocks that moved together over the last 60 days
    rets = pd.DataFrame({s: df["Close"].pct_change() for s, df in frames.items()}).iloc[-60:]
    corr = rets.corr().fillna(0).values
    syms = list(rets.columns)
    links, seen = [], set()
    for i, s in enumerate(syms):
        row = corr[i].copy()
        row[i] = -1
        for j in np.argsort(row)[::-1][:3]:
            if row[j] < 0.55:
                break
            key = tuple(sorted((s, syms[j])))
            if key not in seen:
                seen.add(key)
                links.append([key[0], key[1], round(float(row[j]), 2)])

    earn = earnings if earnings is not None else pd.DataFrame()
    moves = find_moves(frames, {s: meta[s]["sector"] for s in frames}, earn)
    names = {k: v["name"] for k, v in meta.items()}
    attach_news(moves, tent, names)
    tday = today_summary(frames, {s: meta[s]["sector"] for s in frames})
    tnews = {s: {"top": [{"date": tday["date"], "ret": tday["per"][s]["ret"], "cause": "company"}]} for s in tday["movers"]}
    attach_news(tnews, set(tday["movers"]), names)
    per = tday.pop("per")
    tday["movers"] = [{"s": s, "n": meta[s]["name"], "sec": meta[s]["sector"], "ret": r(per[s]["ret"]), "z": r(per[s]["z"], 1),
                       "cause": per[s]["cause"], "sector": r(per[s]["sector"]), "vx": r(per[s]["vx"], 1),
                       "news": tnews[s]["top"][0].get("news")} for s in tday["movers"]]
    today = dates[-1]
    first_day = min(df.index[0] for df in frames.values())
    try:
        funds = fund_rows(download_all(list(FUNDS)), today, first_day)
    except Exception as e:   # the funds are an extra: never let them stop the nightly run
        print("Category funds skipped:", e); funds = []
    print(f"Category funds: {len(funds)} of {len(FUNDS)}")
    mom_now = full.sort_values("date").groupby("symbol")["mom_12_1"].last()
    cells = []
    for s, df in frames.items():
        m, c = meta[s], df["Close"]
        L = latest.loc[s] if s in latest.index else None
        last_close = float(c.iloc[-1])
        vol = float(c.pct_change().iloc[-63:].std() * np.sqrt(252))
        es = earn[earn["symbol"] == s] if len(earn) else earn
        past = es[(pd.to_datetime(es["date"]) <= today) & es["surprise"].notna()] if len(es) else es
        nxt = es[pd.to_datetime(es["date"]) > today] if len(es) else es
        last_e = past.iloc[-1] if len(past) else None
        next_e = nxt.iloc[0]["date"] if len(nxt) else None

        def chg(n):
            return r(c.iloc[-1] / c.iloc[-1 - n] - 1, 6) if len(c) > n else None
        def cal(**ago):   # change since the last close on or before the same calendar date, e.g. one month ago
            start = today - pd.DateOffset(**ago)
            before = c[c.index <= start]
            return r(c.iloc[-1] / before.iloc[-1] - 1, 6) if len(before) else None
        ytd = c[c.index.year == today.year]
        before_year = c[c.index.year < today.year]
        ytd_chg = r(c.iloc[-1] / before_year.iloc[-1] - 1, 6) if len(before_year) and len(ytd) else None
        max_chg = r(c.iloc[-1] / c.iloc[0] - 1, 6) if c.index[0] <= first_day + pd.Timedelta(days=7) else None   # only companies with the full history
        score = float(L["score"]) if L is not None else None

        # band: brain's expected edge vs. the market, plus the stock's own typical swing
        base_date = c.index[-1]
        future = pd.bdate_range(base_date, periods=H + 1)[1:]
        path = [{"time": base_date.strftime("%Y-%m-%d"), "low": last_close, "mid": last_close, "high": last_close}]
        for k, d in enumerate(future, 1):
            sw = 1.28 * vol * np.sqrt(k / 252)
            mid = (score or 0) * k / H
            path.append({"time": d.strftime("%Y-%m-%d"), "mid": r(last_close * (1 + mid), 2),
                         "low": r(last_close * (1 + mid - sw), 2), "high": r(last_close * (1 + mid + sw), 2)})

        why = []
        if L is not None:
            for it in importance[:6]:
                v = L[it["key"]]
                if it["key"] in RANKED:
                    why.append({"label": it["label"], "pct": r(v, 3), "kind": "pct"})
                elif it["key"] == "earn_surprise":
                    why.append({"label": it["label"], "value": r(v, 3), "kind": "surprise"})
                else:
                    why.append({"label": it["label"], "value": r(v, 0), "kind": "days"})

        diary = log[log["symbol"] == s].tail(24).replace({np.nan: None}).to_dict("records")
        hist = df.iloc[-300:]
        detail = {
            "symbol": s, "name": m["name"], "sector": m["sector"], "updated": run_date, "horizon_days": H,
            "tentacle": s in tent, "pinned": s in PINNED, "ranked": L is not None,
            "candles": [[d.strftime("%Y-%m-%d"), r(o, 2), r(h, 2), r(l, 2), r(cl, 2)]
                        for d, o, h, l, cl in zip(hist.index, hist["Open"], hist["High"], hist["Low"], hist["Close"])],
            "performance": {"last_close": r(last_close, 2), "change_1w": chg(5), "change_1m": chg(21),
                            "change_3m": chg(63), "change_1y": chg(252),
                            "change_ytd": r(c.iloc[-1] / ytd.iloc[0] - 1) if len(ytd) else None,
                            "high_52w": r(c.iloc[-252:].max(), 2), "low_52w": r(c.iloc[-252:].min(), 2),
                            "volatility_annual": r(vol)},
            "call": {"rank": int(L["rank"]) if L is not None else None, "of": int(len(latest)),
                     "pct": r(L["pct"], 3) if L is not None else None, "score": r(score),
                     "base_date": base_date.strftime("%Y-%m-%d"), "path": path, "why": why},
            "earnings": {"last_date": last_e["date"] if last_e is not None else None,
                         "last_surprise": r(last_e["surprise"]) if last_e is not None else None,
                         "next_date": next_e},
            "diary": diary,
            "moves": moves.get(s, {"top": [], "counts": {}, "total": 0}),
            "odds": odds_per.get(s),
        }
        write_js(STOCK_DIR / f"{s}.js", f"window.STOCK_DETAIL=window.STOCK_DETAIL||{{}};window.STOCK_DETAIL[{json.dumps(s)}]=", detail)
        cells.append({"s": s, "n": m["name"], "sec": m["sector"], "px": r(last_close, 2), "d1": chg(1),
                      "m1": chg(21), "w1": chg(5), "h1": chg(126), "ytd": ytd_chg, "y1": chg(252), "y5": chg(1260), "mx": max_chg,
                      "c1m": cal(months=1), "c6m": cal(months=6), "c1y": cal(years=1), "c5y": cal(years=5), "dv": round(float((c * df["Volume"]).iloc[-60:].mean()) / 1e6, 1),
                      "rk": int(L["rank"]) if L is not None else None, "pct": r(L["pct"], 3) if L is not None else None,
                      "sc": r(score), "mom": r(mom_now.get(s)),
                      "en": next_e, "es": r(last_e["surprise"]) if last_e is not None else None,
                      "lg": logos.get(s) or None,
                      "p": odds_per[s]["p"] if s in odds_per else None, "vp": odds_per[s]["vp"] if s in odds_per else None,
                      "tz": r(per[s]["z"], 1) if s in per else None, "tc": per[s]["cause"] if s in per else None,
                      "tsr": r(per[s]["sector"]) if s in per else None, "tvx": r(per[s]["vx"], 1) if s in per else None,
                      "t": 1 if s in tent else 0, "pin": 1 if s in PINNED else 0})

    keep = {f"{s}.js" for s in frames}
    for f in STOCK_DIR.glob("*.js"):
        if f.name not in keep:
            f.unlink()

    out = {"generated": run_date, "horizon_days": H, "data_through": today.strftime("%Y-%m-%d"),
           "universe_size": len(cells), "history_from": first_day.strftime("%Y-%m-%d"), "funds": funds, "ranked": int(len(latest)), "tentacles": tentacles,
           "snapshots": int(len(train)), "inputs": [LABELS[c] for c in cols], "test": test, "importance": importance, "baskets": baskets,
           "basket_size": BASKET, "today": tday, "odds": odds, "paper_live": live_paper, "earnings_rows": int(len(earn)), "cells": cells, "links": links,
           "runtime_min": round((time.time() - t0) / 60, 1)}
    write_js(DATA / "cell.js", "window.CELL=", out)
    flows = build_flows(frames, {s: meta[s]["sector"] for s in frames})
    flows["generated"] = run_date
    write_js(DATA / "flows.js", "window.FLOWS=", flows)
    print(f"Flows: {len(flows['days'])} days, {flows['outcomes']['21']['in']['n']} in-days and {flows['outcomes']['21']['out']['n']} out-days with a known month after")
    game = build_game(obs, full, frames, meta, latest, dates)
    game["generated"] = run_date
    write_js(DATA / "game.js", "window.GAME=", game)
    print(f"Game: {len(game['rounds'])} replay rounds, {len(game['live']['picks'])} live picks")
    print(f"Done in {out['runtime_min']} min: {len(cells)} stocks, {len(latest)} ranked, {len(tentacles)} tentacles")


if __name__ == "__main__":
    main()
