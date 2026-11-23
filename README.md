# Stock Lab

Personal learning dashboard: live prices, performance, and a self-retraining short-term forecast for a watchlist of US stocks. Not financial advice.

## How it works
1. **Every weekday night** (22:15 UTC) a GitHub Action runs `scripts/train.py`.
2. It downloads daily price history, retrains one model per stock on past price patterns, and backtests it on days it never saw.
3. It forecasts the next 5 trading days (middle line plus an 80% range), saves every forecast to `data/predictions_log.csv`, and scores old forecasts once their day has passed.
4. `index.html` shows it all. Live prices come straight from Finnhub using a key stored only in your browser.

## View it
Pull the latest data, then open `index.html` in your browser. Click **Live data key** once to add your Finnhub key.

## Change the watchlist
Edit `config/tickers.json`, then run the workflow from the Actions tab (Run workflow).
