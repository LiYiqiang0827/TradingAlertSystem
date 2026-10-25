# TradingAlertSystem

A-share after-close alert and review project.

- `offlineAlertSystem/` holds database-backed daily reviews, watchlists, and shared offline charting interfaces.
- `onlineAlertSystem/` is reserved for online alert workflows.

The offline watchlist and generated reports stay on the Mac mini and are excluded from Git. Strategy code and documentation are versioned here.

## Dashboard 与 Neo4j 依赖

`limitup-dashboard/server.py` 使用独立仓库 [TradeDataManager](https://github.com/LiYiqiang0827/TradeDataManager) 的 `coreClient.neo4j_client.ThemeGraphNeo4jStore`。两边的配套版本为 `theme-graph-chain-v1` 标签。完整安装、配置、生成/入库和最小示例见 [TradeDataManager 部署说明](https://github.com/LiYiqiang0827/TradeDataManager/blob/theme-graph-chain-v1/theme_graph/PORTABLE_SETUP.md)。本仓库不包含正式数据库、密码或模型账号。
