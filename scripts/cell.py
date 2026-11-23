"""
Stock Lab "cell": nightly learner over the whole market.

1. Universe: S&P 500 members (refreshed weekly from Wikipedia) plus extras from config
2. Downloads daily history for every stock in batches
3. Builds features from each stock's own movement AND market and sector context
4. Trains ONE shared model on all stocks at once (the shared brain)
5. Walk-forward backtest: per stock, was the brain right more often than simple guessing?
6. Picks the tentacles: pinned stocks + the stocks with the best proven edge
7. Logs every forecast and scores old ones once their day has passed
8. Writes data/cell.js (map + list) and data/stocks/<SYM>.js (detail, loaded on click)

Run:          python scripts/cell.py
Offline test: DEMO=1 python scripts/cell.py
"""

import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.model_selection import TimeSeriesSplit

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "tickers.json").read_text())
UNIVERSE_FILE = ROOT / "config" / "universe.json"
DATA = ROOT / "data"
STOCK_DIR = DATA / "stocks"
LOG_FILE = DATA / "predictions_log.csv"
H = int(CFG.get("horizon_days", 5))
YEARS = int(CFG.get("history_years", 6))
N_TENTACLES = int(CFG.get("tentacles", 50))
PINNED = CFG.get("pinned", [])
DEMO = os.environ.get("DEMO") == "1"
MARKET = "SPY"

FEATURES = [
    "ret_1", "ret_5", "ret_10", "ret_20", "ret_60",
    "dist_ma20", "dist_ma50", "dist_ma200", "rsi_14", "vol_20", "vol_ratio",
    "range_pos_20", "volume_z",
    "mkt_ret_5", "mkt_ret_20", "mkt_vol_20", "rel_mkt_20", "rel_sector_5", "rel_sector_20",
]
LABELS = {
    "ret_1": "Yesterday's move", "ret_5": "Last week's move", "ret_10": "Last 2 weeks' move",
    "ret_20": "Last month's move", "ret_60": "Last 3 months' move",
    "dist_ma20": "Distance from 20-day average", "dist_ma50": "Distance from 50-day average",
    "dist_ma200": "Distance from 200-day average", "rsi_14": "RSI (overbought / oversold)",
    "vol_20": "Recent volatility", "vol_ratio": "Volatility vs. normal",
    "range_pos_20": "Position in 20-day range", "volume_z": "Unusual trading volume",
    "mkt_ret_5": "Market's last week", "mkt_ret_20": "Market's last month",
    "mkt_vol_20": "Market nervousness", "rel_mkt_20": "Strength vs. market",
    "rel_sector_5": "Strength vs. sector (week)", "rel_sector_20": "Strength vs. sector (month)",
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
        for attempt in range(3):
            try:
                df = yf.download(batch, period=f"{YEARS}y", interval="1d", auto_adjust=True,
                                 progress=False, threads=True, group_by="ticker")
                break
            except Exception as e:
                print(f"  batch {b_i + 1}: attempt {attempt + 1} failed ({e})")
                time.sleep(20 * (attempt + 1))
        else:
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
    rng = np.random.default_rng(7)
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=252 * YEARS)
    mkt = rng.normal(0.0004, 0.010, len(idx))
    sect = {k: rng.normal(0, 0.008, len(idx)) for k in range(8)}
    frames = {}
    for i, s in enumerate(symbols):
        beta = rng.uniform(0.6, 1.5)
        r = beta * mkt + sect[i % 8] + rng.normal(0, 0.014, len(idx))
        if s in ("SPY", "QQQ"):
            r = mkt + rng.normal(0, 0.002, len(idx))
        c = rng.uniform(20, 400) * np.exp(np.cumsum(r))
        o = c * (1 + rng.normal(0, 0.004, len(idx)))
        frames[s] = pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.004, "Low": np.minimum(o, c) * 0.996,
                                  "Close": c, "Volume": rng.integers(1e6, 5e7, len(idx))}, index=idx)
    return frames


# ---------------- features ----------------

def own_features(df):
    c = df["Close"]
    f = pd.DataFrame(index=df.index)
    for n in (1, 5, 10, 20, 60):
        f[f"ret_{n}"] = c.pct_change(n)
    for n in (20, 50, 200):
        f[f"dist_ma{n}"] = c / c.rolling(n).mean() - 1
    d = c.diff()
    gain = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-d.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    f["rsi_14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    daily = c.pct_change()
    f["vol_20"] = daily.rolling(20).std() * np.sqrt(252)
    f["vol_ratio"] = daily.rolling(20).std() / daily.rolling(120).std()
    lo, hi = df["Low"].rolling(20).min(), df["High"].rolling(20).max()
    f["range_pos_20"] = (c - lo) / (hi - lo)
    v = np.log1p(df["Volume"])
    f["volume_z"] = (v - v.rolling(60).mean()) / v.rolling(60).std()
    f["target"] = c.shift(-H) / c - 1
    return f


def build_panel(frames, sector_of):
    mkt = frames[MARKET]["Close"]
    m = pd.DataFrame({"mkt_ret_5": mkt.pct_change(5), "mkt_ret_20": mkt.pct_change(20),
                      "mkt_vol_20": mkt.pct_change().rolling(20).std() * np.sqrt(252)})
    parts = []
    for s, df in frames.items():
        f = own_features(df).join(m, how="left")
        f["rel_mkt_20"] = f["ret_20"] - f["mkt_ret_20"]
        f["symbol"] = s
        f["sector"] = sector_of.get(s, "Other")
        parts.append(f)
    panel = pd.concat(parts)
    panel.index.name = "date"
    panel = panel.reset_index()
    for n in (5, 20):
        sec_mean = panel.groupby(["date", "sector"])[f"ret_{n}"].transform("mean")
        panel[f"rel_sector_{n}"] = panel[f"ret_{n}"] - sec_mean
    return panel.sort_values(["date", "symbol"]).reset_index(drop=True)


def reg(q):
    return HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=250, learning_rate=0.05,
                                         max_depth=4, min_samples_leaf=200, l2_regularization=1.0)


def clf():
    return HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=4,
                                          min_samples_leaf=200, l2_regularization=1.0)


# ---------------- learning ----------------

def walk_forward(panel, test_days=250, refit_every=21):
    """Train only on the past, predict the next block of days, step forward. No peeking."""
    dates = np.sort(panel["date"].unique())
    labeled = panel.dropna(subset=FEATURES + ["target"])
    start = len(dates) - H - test_days
    out = []
    for i in range(start, len(dates) - H, refit_every):
        cutoff, block = dates[i - H], dates[i:i + refit_every]
        train = labeled[labeled["date"] <= cutoff]
        test = labeled[labeled["date"].isin(block)]
        if test.empty:
            continue
        m = reg(0.5).fit(train[FEATURES], train["target"])
        out.append(pd.DataFrame({"symbol": test["symbol"].values, "pred": m.predict(test[FEATURES]),
                                 "actual": test["target"].values}))
        print(f"  backtest block {len(out)} done")
    bt = pd.concat(out)
    stats = {}
    for s, g in bt.groupby("symbol"):
        up = (g["actual"] > 0).mean()
        hit = (np.sign(g["pred"]) == np.sign(g["actual"])).mean()
        base = max(up, 1 - up)
        # overlapping 5-day windows are not independent: about len/H real samples
        n_eff = max(len(g) / H, 1)
        se = np.sqrt(max(base * (1 - base), 0.01) / n_eff)
        stats[s] = {"days_tested": int(len(g)), "direction_hit_rate": float(hit),
                    "baseline_best_guess": float(base), "edge": float(hit - base),
                    "z": float((hit - base) / se)}
    overall = {"direction_hit_rate": float((np.sign(bt["pred"]) == np.sign(bt["actual"])).mean()),
               "baseline_best_guess": float(max((bt["actual"] > 0).mean(), (bt["actual"] <= 0).mean()))}
    return stats, overall


def load_log():
    if LOG_FILE.exists():
        return pd.read_csv(LOG_FILE)
    return pd.DataFrame(columns=["run_date", "symbol", "base_date", "base_close", "pred_low", "pred_mid",
                                 "pred_high", "prob_up", "actual_close", "actual_return", "direction_hit", "in_band"])


def score_log(log, frames):
    log = log.copy()
    pending = log["actual_close"].isna()
    for s, idxs in log[pending].groupby("symbol").groups.items():
        df = frames.get(s)
        if df is None:
            continue
        pos = {d: i for i, d in enumerate(df.index.strftime("%Y-%m-%d"))}
        for i in idxs:
            b = pos.get(log.at[i, "base_date"])
            if b is None or b + H >= len(df):
                continue
            actual = float(df["Close"].iloc[b + H])
            r = actual / log.at[i, "base_close"] - 1
            log.at[i, "actual_close"] = actual
            log.at[i, "actual_return"] = r
            log.at[i, "direction_hit"] = int(np.sign(r) == np.sign(log.at[i, "pred_mid"]))
            log.at[i, "in_band"] = int(log.at[i, "pred_low"] <= r <= log.at[i, "pred_high"])
    return log


def r(x, n=4):
    if x is None:
        return None
    x = float(x)
    return None if np.isnan(x) or np.isinf(x) else round(x, n)


def write_js(path, var, obj):
    path.write_text(f"{var}" + json.dumps(obj, allow_nan=False, separators=(",", ":")) + ";\n")


# ---------------- main ----------------

def main():
    t0 = time.time()
    DATA.mkdir(exist_ok=True)
    STOCK_DIR.mkdir(exist_ok=True)
    run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    universe = load_universe()
    meta = {m["symbol"]: m for m in universe}
    print(f"Universe: {len(universe)} stocks")
    frames = download_all([m["symbol"] for m in universe])
    if MARKET not in frames:
        sys.exit("Market benchmark SPY missing, stopping")
    print(f"Prices loaded for {len(frames)} stocks")

    panel = build_panel(frames, {s: meta[s]["sector"] for s in frames})
    labeled = panel.dropna(subset=FEATURES + ["target"])
    print(f"Shared brain training on {len(labeled):,} examples")

    stats, overall = walk_forward(panel)
    X, y = labeled[FEATURES], labeled["target"]
    q = {k: reg(v).fit(X, y) for k, v in (("low", 0.1), ("mid", 0.5), ("high", 0.9))}
    cl = CalibratedClassifierCV(clf(), method="sigmoid", cv=TimeSeriesSplit(4)).fit(X, (y > 0).astype(int))

    last_date = panel["date"].max()
    latest = panel.groupby("symbol").tail(1).dropna(subset=FEATURES)
    latest = latest[latest["date"] >= last_date - pd.Timedelta(days=7)]
    preds = pd.DataFrame({"symbol": latest["symbol"].values, "base_date": latest["date"].values,
                          "low": q["low"].predict(latest[FEATURES]), "mid": q["mid"].predict(latest[FEATURES]),
                          "high": q["high"].predict(latest[FEATURES]),
                          "prob_up": cl.predict_proba(latest[FEATURES])[:, 1]}).set_index("symbol")
    preds["low"] = preds[["low", "mid"]].min(axis=1)
    preds["high"] = preds[["high", "mid"]].max(axis=1)

    # log today's forecasts, score old ones
    log = score_log(load_log(), frames)
    new_rows = []
    for s, p in preds.iterrows():
        bd = pd.Timestamp(p["base_date"]).strftime("%Y-%m-%d")
        if ((log["symbol"] == s) & (log["base_date"] == bd)).any():
            continue
        new_rows.append({"run_date": run_date, "symbol": s, "base_date": bd,
                         "base_close": float(frames[s]["Close"].iloc[-1]), "pred_low": p["low"],
                         "pred_mid": p["mid"], "pred_high": p["high"], "prob_up": p["prob_up"]})
    if new_rows:
        log = pd.concat([log, pd.DataFrame(new_rows)], ignore_index=True)
    log.to_csv(LOG_FILE, index=False)

    live = {}
    for s, g in log[log["actual_close"].notna()].groupby("symbol"):
        live[s] = {"scored": int(len(g)), "direction_hit_rate": float(g["direction_hit"].astype(float).mean()),
                   "in_band_rate": float(g["in_band"].astype(float).mean())}

    # choose tentacles: pinned first, then best proven edge (live record counts more once it exists)
    def score(s):
        # confidence-weighted edge: backtest z-score, blended with the live record as it grows
        z = stats.get(s, {}).get("z", -9)
        lv = live.get(s)
        if lv and lv["scored"] >= 20:
            n = lv["scored"] / H
            lz = (lv["direction_hit_rate"] - 0.5) / np.sqrt(0.25 / max(n, 1))
            w = min(lv["scored"] / 100, 0.7)
            z = (1 - w) * z + w * lz
        return z
    ranked = sorted([s for s in preds.index if s not in PINNED], key=score, reverse=True)
    tentacles = [s for s in PINNED if s in preds.index] + ranked[: max(0, N_TENTACLES - len(PINNED))]
    tent_set = set(tentacles)

    # links: who moves with whom (last 60 trading days)
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

    # per-stock detail files + cell summary
    cells = []
    rng = np.random.default_rng(0)
    for s in preds.index:
        df, p, m = frames[s], preds.loc[s], meta[s]
        c = df["Close"]
        base_date = pd.Timestamp(p["base_date"])
        base_close = float(c.iloc[-1])
        dollar_vol = float((c * df["Volume"]).iloc[-60:].mean())
        sym_rows = latest[latest["symbol"] == s]
        sym_hist = labeled[labeled["symbol"] == s].iloc[-120:]

        drivers = []
        if len(sym_hist) > 20:
            base = q["mid"].predict(sym_hist[FEATURES])
            imp = {}
            for col in FEATURES:
                sh = sym_hist[FEATURES].copy()
                sh[col] = rng.permutation(sh[col].values)
                imp[col] = float(np.abs(q["mid"].predict(sh) - base).mean())
            tot = sum(imp.values()) or 1
            drivers = [{"feature": LABELS[k], "share": r(v / tot, 3)}
                       for k, v in sorted(imp.items(), key=lambda kv: -kv[1])[:4]]

        future = pd.bdate_range(base_date, periods=H + 1)[1:]
        path = [{"time": base_date.strftime("%Y-%m-%d"), "low": base_close, "mid": base_close, "high": base_close}]
        for k, d in enumerate(future, 1):
            sq = np.sqrt(k / H)
            path.append({"time": d.strftime("%Y-%m-%d"), "low": r(base_close * (1 + p["low"] * sq)),
                         "mid": r(base_close * (1 + p["mid"] * k / H)), "high": r(base_close * (1 + p["high"] * sq))})

        def chg(n):
            return r(c.iloc[-1] / c.iloc[-1 - n] - 1) if len(c) > n else None
        ytd = c[c.index.year == base_date.year]
        f_last = sym_rows.iloc[0]
        bt = stats.get(s, {})
        hist = df.iloc[-300:]
        detail = {
            "symbol": s, "name": m["name"], "sector": m["sector"], "updated": run_date, "horizon_days": H,
            "tentacle": s in tent_set, "pinned": s in PINNED,
            "candles": [[d.strftime("%Y-%m-%d"), r(o, 2), r(h, 2), r(l, 2), r(cl, 2)]
                        for d, o, h, l, cl in zip(hist.index, hist["Open"], hist["High"], hist["Low"], hist["Close"])],
            "performance": {"last_close": r(base_close, 2), "change_1d": chg(1), "change_1w": chg(5),
                            "change_1m": chg(21), "change_3m": chg(63), "change_1y": chg(252),
                            "change_ytd": r(c.iloc[-1] / ytd.iloc[0] - 1) if len(ytd) else None,
                            "high_52w": r(c.iloc[-252:].max(), 2), "low_52w": r(c.iloc[-252:].min(), 2),
                            "volatility_annual": r(f_last["vol_20"]), "rsi_14": r(f_last["rsi_14"], 1)},
            "forecast": {"base_date": base_date.strftime("%Y-%m-%d"), "base_close": base_close,
                         "expected_return": r(p["mid"]), "low_return": r(p["low"]), "high_return": r(p["high"]),
                         "prob_up": r(p["prob_up"], 3), "path": path, "drivers": drivers},
            "backtest": {k: (r(v) if isinstance(v, float) else v) for k, v in bt.items()},
            "live": {k: (r(v) if isinstance(v, float) else v) for k, v in live.get(s, {"scored": 0}).items()},
            "history": log[log["symbol"] == s].tail(30).replace({np.nan: None}).to_dict("records"),
        }
        write_js(STOCK_DIR / f"{s}.js", f"window.STOCK_DETAIL=window.STOCK_DETAIL||{{}};window.STOCK_DETAIL[{json.dumps(s)}]=", detail)
        cells.append({"s": s, "n": m["name"], "sec": m["sector"], "px": r(base_close, 2),
                      "d1": chg(1), "m1": chg(21), "exp": r(p["mid"]), "pu": r(p["prob_up"], 3),
                      "edge": r(bt.get("edge")), "z": r(bt.get("z"), 2), "hit": r(bt.get("direction_hit_rate")),
                      "base": r(bt.get("baseline_best_guess")), "dv": round(dollar_vol / 1e6, 1),
                      "t": 1 if s in tent_set else 0, "pin": 1 if s in PINNED else 0,
                      "lv": r(live[s]["direction_hit_rate"]) if s in live else None,
                      "lvn": live[s]["scored"] if s in live else 0})

    # remove detail files for stocks that left the universe
    keep = {f"{s}.js" for s in preds.index}
    for f in STOCK_DIR.glob("*.js"):
        if f.name not in keep:
            f.unlink()

    out = {"generated": run_date, "horizon_days": H, "data_through": last_date.strftime("%Y-%m-%d"),
           "universe_size": len(cells), "tentacles": tentacles, "examples": int(len(labeled)),
           "overall": {k: r(v) for k, v in overall.items()}, "cells": cells, "links": links,
           "runtime_min": round((time.time() - t0) / 60, 1)}
    write_js(DATA / "cell.js", "window.CELL=", out)
    print(f"Done in {out['runtime_min']} min: {len(cells)} cells, {len(tentacles)} tentacles, {len(links)} links")


if __name__ == "__main__":
    main()
