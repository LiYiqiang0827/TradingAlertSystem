# Shared offline chart interfaces

`KlinePlot.py` contains the shared chart and data access class used by offline alerts. It exposes loaders and plot interfaces for daily, weekly, monthly, 15-minute K-lines, a five-session intraday line chart, and the two alert report page layouts. Styles follow `TradingAgent/MrLi/plot` (red for up days, green for down days, candlesticks plus volume).

Prices use forward-adjusted data; volume and amount are restored from the unadjusted local provider. The module reads `coreClient.data_provider`; all daily, weekly and monthly requests explicitly use `source="database_only"`. The 15-minute provider is a fixed local DuckDB interface.
