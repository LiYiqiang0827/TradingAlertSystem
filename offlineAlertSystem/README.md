# offlineAlertSystem

Offline after-close review and watchlist tools. Daily watchlists use `watchlist/watchlist_YYYYMMDD.csv` with stock code, name, alert name, reason and an importance level from 1 to 5. Generated watchlists are local research outputs and are not tracked by Git.

## alert_zt

`alert_zt/generate_report.py` selects the union of (1) stocks with a KPL limit-up record in the latest five exchange sessions and (2) stocks with a KPL status of consecutive two boards or more in the latest 20 sessions. It de-duplicates by stock code, assigns one primary KPL theme, orders themes by same-day market-wide limit-up breadth and stocks by 20-session limit-up frequency, then latest hit and intraday seal time.

Run on the Mac mini after the close:

```bash
cd ~/TradingAlertSystem
PYTHONPATH="$HOME/TradingDataManager:$HOME/TradingAgent" \
  "$HOME/TradingAgent/.venv/bin/python" \
  offlineAlertSystem/alert_zt/generate_report.py
```

The script reads the existing `coreClient.data_provider`, requests database-only daily/weekly/monthly/KPL/calendar data, writes `watchlist/watchlist_YYYYMMDD.csv`, and creates one chart image per stock page under `alert_zt/output/YYYYMMDD/`. The slide-builder source is `alert_zt/build_presentation.mjs`; it uses the Codex bundled `@oai/artifact-tool` runtime to export the PowerPoint.

The importance grade is an explainable rule priority, not a predictive score or trading recommendation. Every report records its actual data cut-off. The five-session chart requires 240 canonical one-minute bars per stock-day where a daily bar exists. If any are missing, the report invokes TradingDataManager's TDX one-minute service for only those stock-days, atomically merges valid results into the existing complete Parquet partitions, then rereads and records the remaining coverage gaps. Fifteen-minute data is shown only as a separate three-month context panel and never fills a missing one-minute session.
