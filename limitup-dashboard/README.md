# TradingAlert 涨停研究台

与 `offlineAlertSystem/` 同级的本地 HTML 原型，默认只读访问 Mac mini 上 TradingDataManager / TradingDataBase 的现有数据。

## 启动

在 Mac mini 项目目录运行：

```bash
cd ~/TradingAlertSystem/limitup-dashboard
PYTHONPATH="$HOME/TradingDataManager:$HOME/TradingDataManager/offlineDataManager/scripts" \
  .venv/bin/python server.py
```

如果 TradingDataManager 虚拟环境位置不同，可使用已安装有 pandas、SQLite 和数据 provider 依赖的 Python。默认监听 `127.0.0.1:8765`。浏览器打开 `http://127.0.0.1:8765/`。

## 数据与缓存

- 题材、个股涨停原因：`~/TradingDatabase/theme_graph/每日涨停原因/YYYYMMDD.md`
- 涨停池：优先 `tbl_cn_kpl_list`，当日没有数据则使用 `tbl_cn_kpl_limit_performance`
- 日线预载 2 年、周线预载 5 年、月线载入当前数据库中的全部历史，1 分钟预载最近 5 个交易日，15 分钟载入最近 3 个月
- 每个周期独立缓存到 Redis DB 2，键按股票、周期、截止日期区分，复盘日数据缓存 7 天，最新行情缓存 5 分钟；缓存命中后不重复读取 data provider
- 选中个股时同时预载复盘日与数据库最新行情并写入 Redis，图表一次载入两段数据；“最新K线”按钮只滚动显示范围，不请求接口、不重取数据；最新行情缓存 5 分钟
- 1 分钟图只使用 1 分钟表，15 分钟图只使用 15 分钟表；15 分钟表覆盖不足时显示实际覆盖区间，不用 1 分钟数据拼接替代
- 浏览器用内存 + IndexedDB 双层缓存行情：内存命中最快，页面刷新后可从 IndexedDB 恢复；两层各按先进先出保留最多 30 只不同股票，每份缓存 24 小时过期；新增第 31 只时淘汰最早写入的股票，复盘日期变更时同一股票重新读取并更新缓存
- 服务端优先使用本机 Redis `127.0.0.1:6379/2`；Redis 不可用时仍回退到项目内 SQLite 持久缓存 `cache/dashboard-cache.sqlite3`
- Redis 服务不可用时原型仍可启动。Redis 不会由本项目自动安装或启动

## 图表

内置 [KLineChart](https://github.com/klinecharts/KLineChart) 10.1.0 UMD 构建和 Apache-2.0 许可文件；本地运行无需 CDN。日线、周线、月线和 15 分钟图将 MA(5/10/20/30/60/120/250) 叠加在 K 线上；所有周期的成交量副图显示 VOL 及 5/10/20/60 均量。

选中文字后点击“分析这段”，当前原型会从对应日报提取题材催化与个股逻辑字段。它尚未调用生成式模型。
