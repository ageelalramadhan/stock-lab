# Stock Lab

A personal learning "cell" for the US stock market by Ageel Alramadhan. Not financial advice.

## The question it answers
Over the next month, which stocks will do better or worse **than the other stocks**? Ranking stocks against each other removes the market's daily noise.

## How it works
1. **Every weekday night** (22:15 UTC) GitHub runs `scripts/cell.py` (workflow "Nightly retrain"), then publishes the site (workflow "Publish site").
2. **Universe:** S&P 500 members (refreshed weekly from Wikipedia) plus extras in `config/tickers.json`.
3. **Inputs:** 12-1 and 6-1 month momentum, last month's move (short-term reversal), trend, volatility, beta, size, sector strength, and earnings surprises (Finnhub, builds up nightly).
4. **Honest test:** 36 months walked forward. Each month: rank, then check whether the top 20% beat the bottom 20%. Compared with plain momentum.
5. **Live record:** once a month the ranking is frozen (`data/rank_log.csv`) and scored a month later.
6. **Tentacles:** pinned stocks plus the brain's top-ranked stocks stream live with your Finnhub key.

## Settings (`config/tickers.json`)
- `pinned`: stocks that are always tentacles
- `tentacles`: how many stream live (free Finnhub plan: 50)
- `extras`: stocks added beyond the S&P 500

## Secrets
`FINNHUB_KEY` (Settings, Secrets and variables, Actions) lets the nightly run collect earnings data.
