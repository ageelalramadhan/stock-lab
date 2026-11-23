"""
Stock Lab nightly trainer.

1. Downloads daily price history for every ticker in config/tickers.json
2. Builds features from past price movement (momentum, trend, RSI, volatility, volume)
3. Walk-forward backtest: how often would the model have been right on unseen days?
4. Trains on all history and forecasts the next N trading days (low / mid / high band)
5. Logs every forecast, then scores old forecasts once their target day has passed
6. Writes data/bundle.js, which index.html reads (works by double-clicking the file)

Run locally:  python scripts/train.py
Offline test: DEMO=1 python scripts/train.py   (random-walk data, no internet)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.model_selection import TimeSeriesSplit

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config" / "tickers.json").read_text())
DATA = ROOT / "data"
TICKER_DIR = DATA / "tickers"
LOG_FILE = DATA / "predictions_log.csv"
H = int(CONFIG.get("horizon_days", 5))
YEARS = int(CONFIG.get("history_years", 6))
DEMO = os.environ.get("DEMO") == "1"

FEATURES = [
    "ret_1", "ret_5", "ret_10", "ret_20", "ret_60",
    "dist_ma20", "dist_ma50", "dist_ma200",
    "rsi_14", "vol_20", "vol_ratio", "range_pos_20", "volume_z",
]
FEATURE_LABELS = {
    "ret_1": "Yesterday's move", "ret_5": "Last week's move", "ret_10": "Last 2 weeks' move",
    "ret_20": "Last month's move", "ret_60": "Last 3 months' move",
    "dist_ma20": "Distance from 20-day average", "dist_ma50": "Distance from 50-day average",
    "dist_ma200": "Distance from 200-day average", "rsi_14": "RSI (overbought / oversold)",
    "vol_20": "Recent volatility", "vol_ratio": "Volatility vs. normal",
    "range_pos_20": "Position in 20-day range", "volume_z": "Unusual trading volume",
}


# ---------- data ----------

def download(symbol: str) -> pd.DataFrame:
    if DEMO:
        return demo_prices(symbol)
    import yfinance as yf
    for attempt in range(4):
        try:
            df = yf.download(symbol, period=f"{YEARS}y", interval="1d",
                             auto_adjust=True, progress=False, threads=False)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            df = df[["Open", "High", "Low", "Close", "Volume"]].dropna()
            if len(df) > 300:
                df.index = pd.to_datetime(df.index).tz_localize(None)
                return df
        except Exception as e:  # network hiccups, rate limits
            print(f"  {symbol}: attempt {attempt + 1} failed ({e})")
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"no data for {symbol}")


def demo_prices(symbol: str) -> pd.DataFrame:
    rng = np.random.default_rng(abs(hash(symbol)) % 2**32)
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=252 * YEARS)
    r = rng.normal(0.0004, 0.018, len(idx))
    close = 100 * np.exp(np.cumsum(r))
    open_ = close * (1 + rng.normal(0, 0.004, len(idx)))
    high = np.maximum(open_, close) * (1 + abs(rng.normal(0, 0.006, len(idx))))
    low = np.minimum(open_, close) * (1 - abs(rng.normal(0, 0.006, len(idx))))
    vol = rng.integers(5e6, 5e7, len(idx))
    return pd.DataFrame({"Open": open_, "High": high, "Low": low, "Close": close, "Volume": vol}, index=idx)


# ---------- features ----------

def build_features(df: pd.DataFrame) -> pd.DataFrame:
    c = df["Close"]
    f = pd.DataFrame(index=df.index)
    for n in (1, 5, 10, 20, 60):
        f[f"ret_{n}"] = c.pct_change(n)
    for n in (20, 50, 200):
        f[f"dist_ma{n}"] = c / c.rolling(n).mean() - 1
    delta = c.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    f["rsi_14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    daily = c.pct_change()
    f["vol_20"] = daily.rolling(20).std() * np.sqrt(252)
    f["vol_ratio"] = daily.rolling(20).std() / daily.rolling(120).std()
    lo, hi = df["Low"].rolling(20).min(), df["High"].rolling(20).max()
    f["range_pos_20"] = (c - lo) / (hi - lo)
    v = np.log1p(df["Volume"])
    f["volume_z"] = (v - v.rolling(60).mean()) / v.rolling(60).std()
    f["target"] = c.shift(-H) / c - 1  # what we try to predict: return over the next H days
    return f


def model(q=None):
    if q is None:
        return HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=3,
                                              min_samples_leaf=40, l2_regularization=1.0)
    return HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=200,
                                         learning_rate=0.05, max_depth=3,
                                         min_samples_leaf=40, l2_regularization=1.0)


def backtest(feat: pd.DataFrame, test_days=250, refit_every=21):
    """Walk-forward: train only on the past, predict the future, step forward."""
    data = feat.dropna(subset=FEATURES + ["target"])
    if len(data) < test_days + 300:
        test_days = max(60, len(data) // 4)
    preds, actuals = [], []
    start = len(data) - test_days
    for i in range(start, len(data), refit_every):
        train = data.iloc[: i - H]  # gap of H days so no future info leaks in
        test = data.iloc[i: i + refit_every]
        m = model(0.5).fit(train[FEATURES], train["target"])
        preds.extend(m.predict(test[FEATURES]))
        actuals.extend(test["target"])
    p, a = np.array(preds), np.array(actuals)
    up_share = float((a > 0).mean())
    return {
        "days_tested": int(len(a)),
        "direction_hit_rate": float((np.sign(p) == np.sign(a)).mean()),
        "baseline_always_up": up_share,
        "baseline_best_guess": max(up_share, 1 - up_share),
        "mean_abs_error": float(np.abs(p - a).mean()),
    }


# ---------- prediction log ----------

def load_log() -> pd.DataFrame:
    cols = ["run_date", "symbol", "base_date", "base_close", "pred_low", "pred_mid", "pred_high",
            "prob_up", "actual_close", "actual_return", "direction_hit", "in_band"]
    if LOG_FILE.exists():
        return pd.read_csv(LOG_FILE)
    return pd.DataFrame(columns=cols)


def score_log(log: pd.DataFrame, symbol: str, df: pd.DataFrame) -> pd.DataFrame:
    dates = df.index.strftime("%Y-%m-%d").tolist()
    pos = {d: i for i, d in enumerate(dates)}
    for i in log.index[(log["symbol"] == symbol) & log["actual_close"].isna()]:
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


def live_stats(log: pd.DataFrame, symbol: str) -> dict:
    done = log[(log["symbol"] == symbol) & log["actual_close"].notna()]
    if done.empty:
        return {"scored": 0}
    return {
        "scored": int(len(done)),
        "direction_hit_rate": float(done["direction_hit"].astype(float).mean()),
        "in_band_rate": float(done["in_band"].astype(float).mean()),
    }


# ---------- per ticker ----------

def r2(x, n=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), n)


def process(t: dict, log: pd.DataFrame, run_date: str):
    sym = t["symbol"]
    df = download(sym)
    feat = build_features(df)
    log = score_log(log, sym, df)

    bt = backtest(feat)
    train = feat.dropna(subset=FEATURES + ["target"])
    X, y = train[FEATURES], train["target"]
    q = {name: model(qq).fit(X, y) for name, qq in (("low", 0.1), ("mid", 0.5), ("high", 0.9))}
    # calibrated on time-ordered folds so 'chance of rising' is not overconfident
    clf = CalibratedClassifierCV(model(), method="sigmoid", cv=TimeSeriesSplit(5)).fit(X, (y > 0).astype(int))

    last = feat[FEATURES].iloc[[-1]]
    low, mid, high = (float(q[k].predict(last)[0]) for k in ("low", "mid", "high"))
    low, high = min(low, mid), max(high, mid)
    prob_up = float(clf.predict_proba(last)[0, 1])

    # which inputs moved the forecast most (permutation-style sensitivity on recent rows)
    recent = X.iloc[-120:]
    base = q["mid"].predict(recent)
    rng = np.random.default_rng(0)
    imp = {}
    for col in FEATURES:
        shuffled = recent.copy()
        shuffled[col] = rng.permutation(shuffled[col].values)
        imp[col] = float(np.abs(q["mid"].predict(shuffled) - base).mean())
    total = sum(imp.values()) or 1
    drivers = sorted(imp.items(), key=lambda kv: -kv[1])[:4]

    base_date = df.index[-1]
    base_close = float(df["Close"].iloc[-1])
    future = pd.bdate_range(base_date, periods=H + 1)[1:]
    path = [{"time": base_date.strftime("%Y-%m-%d"), "low": base_close, "mid": base_close, "high": base_close}]
    for k, d in enumerate(future, start=1):
        s = np.sqrt(k / H)  # uncertainty grows with time
        path.append({"time": d.strftime("%Y-%m-%d"),
                     "low": round(base_close * (1 + low * s), 4),
                     "mid": round(base_close * (1 + mid * k / H), 4),
                     "high": round(base_close * (1 + high * s), 4)})

    key = (log["symbol"] == sym) & (log["base_date"] == base_date.strftime("%Y-%m-%d"))
    row = {"run_date": run_date, "symbol": sym, "base_date": base_date.strftime("%Y-%m-%d"),
           "base_close": base_close, "pred_low": low, "pred_mid": mid, "pred_high": high, "prob_up": prob_up}
    if key.any():
        for k, v in row.items():
            log.loc[key, k] = v
    else:
        log = pd.concat([log, pd.DataFrame([row])], ignore_index=True)

    c = df["Close"]
    def chg(n):
        return r2(c.iloc[-1] / c.iloc[-1 - n] - 1) if len(c) > n else None
    ytd_start = c[c.index.year == base_date.year]
    hist = df.iloc[-500:]
    ma20, ma50 = c.rolling(20).mean().iloc[-500:], c.rolling(50).mean().iloc[-500:]

    out = {
        "symbol": sym, "name": t.get("name", sym), "group": t.get("group", ""),
        "updated": run_date, "horizon_days": H,
        "candles": [{"time": d.strftime("%Y-%m-%d"), "open": r2(o, 4), "high": r2(h, 4),
                     "low": r2(l, 4), "close": r2(cl, 4), "volume": int(v)}
                    for d, o, h, l, cl, v in zip(hist.index, hist["Open"], hist["High"],
                                                 hist["Low"], hist["Close"], hist["Volume"])],
        "ma20": [{"time": d.strftime("%Y-%m-%d"), "value": r2(v, 4)} for d, v in ma20.dropna().items()],
        "ma50": [{"time": d.strftime("%Y-%m-%d"), "value": r2(v, 4)} for d, v in ma50.dropna().items()],
        "performance": {
            "last_close": r2(base_close), "change_1d": chg(1), "change_1w": chg(5),
            "change_1m": chg(21), "change_3m": chg(63), "change_1y": chg(252),
            "change_ytd": r2(c.iloc[-1] / ytd_start.iloc[0] - 1) if len(ytd_start) else None,
            "high_52w": r2(c.iloc[-252:].max()), "low_52w": r2(c.iloc[-252:].min()),
            "volatility_annual": r2(feat["vol_20"].iloc[-1]), "rsi_14": r2(feat["rsi_14"].iloc[-1], 1),
        },
        "forecast": {
            "base_date": base_date.strftime("%Y-%m-%d"), "base_close": base_close,
            "expected_return": r2(mid), "low_return": r2(low), "high_return": r2(high),
            "prob_up": r2(prob_up, 3), "path": path,
            "drivers": [{"feature": FEATURE_LABELS[f], "share": r2(v / total, 3)} for f, v in drivers],
        },
        "backtest": {k: r2(v) if isinstance(v, float) else v for k, v in bt.items()},
        "live": {k: r2(v) if isinstance(v, float) else v for k, v in live_stats(log, sym).items()},
        "history": log[(log["symbol"] == sym)].tail(30).replace({np.nan: None}).to_dict("records"),
    }
    return out, log


def main():
    DATA.mkdir(exist_ok=True)
    TICKER_DIR.mkdir(exist_ok=True)
    run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    log = load_log()
    failed = []
    for t in CONFIG["tickers"]:
        print(f"Training {t['symbol']} ...")
        try:
            out, log = process(t, log, run_date)
            (TICKER_DIR / f"{t['symbol']}.json").write_text(json.dumps(out, allow_nan=False))
        except Exception as e:
            print(f"  skipped {t['symbol']}: {e}")
            failed.append(t["symbol"])  # old file (if any) stays, so the site still shows it

    log.to_csv(LOG_FILE, index=False)
    bundle = {"generated": run_date, "horizon_days": H, "failed": failed, "tickers": []}
    for t in CONFIG["tickers"]:
        p = TICKER_DIR / f"{t['symbol']}.json"
        if p.exists():
            bundle["tickers"].append(json.loads(p.read_text()))
    (DATA / "bundle.js").write_text("window.STOCK_DATA = " + json.dumps(bundle, allow_nan=False) + ";\n")
    print(f"Done. {len(bundle['tickers'])} tickers written, {len(failed)} failed: {failed}")
    if len(failed) == len(CONFIG["tickers"]):
        sys.exit(1)


if __name__ == "__main__":
    main()
