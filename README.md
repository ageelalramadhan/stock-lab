# Stock Lab

A personal learning "cell" for the US stock market: about 510 stocks, one shared brain, and 50 live tentacles. Not financial advice.

## How it works
1. **Every weekday night** (22:15 UTC) a GitHub Action runs `scripts/cell.py`.
2. **Universe:** S&P 500 members (list refreshed weekly from Wikipedia) plus extras in `config/tickers.json`.
3. **Shared brain:** one model learns from every stock at once, using each stock's own movement plus market and sector context.
4. **Honesty check:** a walk-forward backtest scores each stock on days the brain never saw. The "luck score" shows whether its edge is bigger than chance.
5. **Tentacles:** pinned stocks plus the stocks with the strongest edge. These stream live, and the list changes as the brain learns.
6. **Diary:** every forecast is saved to `data/predictions_log.csv` and scored once its day arrives. The live record gradually counts more than the backtest.

## View it
In GitHub Desktop: Fetch origin, then Pull. Open `index.html` in your browser. Add your Finnhub key once with **Live data key**.

## Settings (`config/tickers.json`)
- `pinned`: stocks that are always tentacles
- `tentacles`: how many stream live (free Finnhub plan: 50)
- `extras`: stocks added to the universe beyond the S&P 500
