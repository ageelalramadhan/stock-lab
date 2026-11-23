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
            p = pd.merge_asof(p.drop(columns=["earn_surprise", "earn_days"]), e[["symbol", "edate", "surprise"]],
                              left_on="date", right_on="edate", by="symbol", direction="backward",
                              tolerance=pd.Timedelta(days=90))
            p["earn_surprise"] = p["surprise"]
            p["earn_days"] = (p["date"] - p["edate"]).dt.days
            p = p.drop(columns=["surprise", "edate"])

    ranked = p[~p["symbol"].isin(NOT_RANKED)].copy()
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

def walk_forward(panel, dates, months=36):
    """Each month: train only on what was known, rank everyone, see what happened a month later."""
    weekly = set(dates[::-5])
    train_pool = panel[panel["date"].isin(weekly)].dropna(subset=["target"])
    test_idx = list(range(len(dates) - 1 - H, H * 13, -H))[:months][::-1]
    rows, series = [], []
    cum_b, cum_m = 0.0, 0.0
    for i in test_idx:
        d, cutoff = dates[i], dates[i - H]
        train = train_pool[train_pool["date"] <= cutoff]
        test = panel[(panel["date"] == d)].dropna(subset=["target", "mom_12_1"])
        if len(train) < 5000 or len(test) < 50:
            continue
        cols = usable(train)
        pred = model().fit(train[cols], train["target"]).predict(test[cols])
        t = test.assign(pred=pred)
        q = max(len(t) // 5, 1)
        ic = t["pred"].rank().corr(t["target"].rank())
        top = t.nlargest(q, "pred")["target"].mean()
        bot = t.nsmallest(q, "pred")["target"].mean()
        m_ic = t["mom_12_1"].rank().corr(t["target"].rank())
        m_top = t.nlargest(q, "mom_12_1")["target"].mean()
        m_bot = t.nsmallest(q, "mom_12_1")["target"].mean()
        cum_b += top - bot
        cum_m += m_top - m_bot
        rows.append({"date": d, "ic": ic, "spread": top - bot, "m_ic": m_ic, "m_spread": m_top - m_bot})
        series.append({"time": pd.Timestamp(d).strftime("%Y-%m-%d"), "brain": round(cum_b, 4), "momentum": round(cum_m, 4)})
        print(f"  tested {pd.Timestamp(d).date()}: rank accuracy {ic:+.3f}, top minus bottom {top - bot:+.2%}")
    r = pd.DataFrame(rows)

    def summary(ic, spread):
        n = len(spread)
        return {"months": int(n), "ic": float(ic.mean()), "ic_positive": float((ic > 0).mean()),
                "spread": float(spread.mean()), "spread_wins": int((spread > 0).sum()),
                "t": float(spread.mean() / (spread.std(ddof=1) / np.sqrt(n))) if n > 2 and spread.std() > 0 else 0.0}
    return {"brain": summary(r["ic"], r["spread"]), "momentum": summary(r["m_ic"], r["m_spread"]), "series": series}


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
    return log, baskets


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

    panel, full = build_panel(frames, {s: meta[s]["sector"] for s in frames}, earnings)
    dates = np.sort(panel["date"].unique())
    dates = pd.DatetimeIndex(dates)

    test = walk_forward(panel, dates)
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

    log, baskets = update_rank_log(latest.reset_index(), frames, dates, run_date)
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
    today = dates[-1]
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
            return r(c.iloc[-1] / c.iloc[-1 - n] - 1) if len(c) > n else None
        ytd = c[c.index.year == today.year]
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
        }
        write_js(STOCK_DIR / f"{s}.js", f"window.STOCK_DETAIL=window.STOCK_DETAIL||{{}};window.STOCK_DETAIL[{json.dumps(s)}]=", detail)
        cells.append({"s": s, "n": m["name"], "sec": m["sector"], "px": r(last_close, 2), "d1": chg(1),
                      "m1": chg(21), "dv": round(float((c * df["Volume"]).iloc[-60:].mean()) / 1e6, 1),
                      "rk": int(L["rank"]) if L is not None else None, "pct": r(L["pct"], 3) if L is not None else None,
                      "sc": r(score), "mom": r(mom_now.get(s)),
                      "en": next_e, "es": r(last_e["surprise"]) if last_e is not None else None,
                      "t": 1 if s in tent else 0, "pin": 1 if s in PINNED else 0})

    keep = {f"{s}.js" for s in frames}
    for f in STOCK_DIR.glob("*.js"):
        if f.name not in keep:
            f.unlink()

    out = {"generated": run_date, "horizon_days": H, "data_through": today.strftime("%Y-%m-%d"),
           "universe_size": len(cells), "ranked": int(len(latest)), "tentacles": tentacles,
           "snapshots": int(len(train)), "inputs": [LABELS[c] for c in cols], "test": test, "importance": importance, "baskets": baskets,
           "basket_size": BASKET, "earnings_rows": int(len(earn)), "cells": cells, "links": links,
           "runtime_min": round((time.time() - t0) / 60, 1)}
    write_js(DATA / "cell.js", "window.CELL=", out)
    print(f"Done in {out['runtime_min']} min: {len(cells)} stocks, {len(latest)} ranked, {len(tentacles)} tentacles")


if __name__ == "__main__":
    main()
