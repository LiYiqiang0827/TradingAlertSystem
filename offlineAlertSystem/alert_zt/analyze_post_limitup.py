#!/usr/bin/env python3
"""Measure post-limit-up shape using daily and canonical one-minute bars."""
from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

PROJECT = Path(__file__).resolve().parents[2]
for candidate in (Path.home() / "TradingDataManager", Path.home() / "TradingAgent"):
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
from coreClient.data_provider import get_day, get_oneMin


def batched(provider, codes: list[str], **kwargs) -> pd.DataFrame:
    pieces = []
    for start in range(0, len(codes), 40):
        part = provider(ts_codes=codes[start:start + 40], **kwargs)
        if not part.empty:
            pieces.append(part)
    return pd.concat(pieces, ignore_index=True) if pieces else pd.DataFrame()


def day_key(value) -> str:
    return pd.Timestamp(str(value)).strftime("%Y%m%d")


def analyze(daily: pd.DataFrame, minute: pd.DataFrame, candidate: dict, anchor: str) -> dict:
    code = candidate["ts_code"]
    event_date = str(candidate["latest_limit_up_date"])
    lu_time = str(candidate.get("latest_limit_up_time", ""))
    d = daily[daily.ts_code.eq(code)].copy()
    d["trade_date"] = d.trade_date.map(day_key)
    d = d.sort_values("trade_date").reset_index(drop=True)
    event_matches = d.index[d.trade_date.eq(event_date)].tolist()
    anchor_matches = d.index[d.trade_date.eq(anchor)].tolist()
    if not event_matches or not anchor_matches:
        return {"ts_code": code, "event_date": event_date, "status": "daily_data_missing", "tags": []}
    ei, ai = event_matches[-1], anchor_matches[-1]
    event = d.iloc[ei]
    post = d.iloc[ei + 1:ai + 1].copy()
    event_close = float(event.close)
    result = {
        "ts_code": code, "name": candidate["name"], "event_date": event_date,
        "event_time": lu_time, "event_close": event_close,
        "event_open": float(event.open), "event_low": float(event.low),
        "post_dates": post.trade_date.tolist(), "post_sessions": len(post),
        "tags": [], "metrics": {}, "status": "ok" if len(post) else "event_day_only",
    }
    if len(post):
        closes = post.close.astype(float)
        low_ratio = float(closes.min() / event_close)
        high_ratio = float(closes.max() / event_close)
        latest_ratio = float(closes.iloc[-1] / event_close)
        close_range = float((closes.max() - closes.min()) / event_close)
        result["metrics"].update({
            "post_close_min_vs_lu": low_ratio,
            "post_close_max_vs_lu": high_ratio,
            "latest_close_vs_lu": latest_ratio,
            "post_close_range_vs_lu": close_range,
        })
        if len(post) >= 2 and low_ratio >= .95 and latest_ratio >= .97 and high_ratio <= 1.03 and close_range <= .05:
            result["tags"].append("涨停价附近强势盘整")

        # Pullback tests use adjusted daily OHLC. The launch area is represented
        # by the limit-up session's open and low; moving averages are as of 10/16.
        static_levels = {"涨停启动开盘位": float(event.open), "涨停启动低点": float(event.low)}
        levels = []
        for post_index, touch in post.iterrows():
            support_levels = dict(static_levels)
            hist = d.iloc[:post_index + 1]
            for n in (5, 10, 20, 30):
                if len(hist) >= n:
                    support_levels[f"MA{n}"] = float(hist.close.tail(n).mean())
            for name, level in support_levels.items():
                if level <= 0:
                    continue
                # The session low itself must be within 1.5% of the support;
                # a wide daily range that only crosses the level is not a touch.
                distance_pct = (float(touch.low) / level - 1) * 100
                if abs(distance_pct) <= 1.5:
                    levels.append({"level": name, "price": level,
                                   "touch_date": touch.trade_date,
                                   "distance_pct": round(distance_pct, 2),
                                   "recovered_by_close": float(touch.close) >= level})
        # Keep one earliest observed pullback per support level.
        levels = list({item["level"]: item for item in reversed(levels)}.values())
        if levels:
            result["metrics"]["support_touches"] = levels
            result["tags"].append("回踩涨停启动位/均线")
        anchor_hist = d.iloc[:ai + 1].copy()
        result["metrics"]["anchor_mas"] = {
            f"MA{n}": round(float(anchor_hist.close.tail(n).mean()), 4)
            for n in (5, 10, 20, 30) if len(anchor_hist) >= n
        }

        prev = d.iloc[max(0, ei - 5):ei]
        base_vol = float(prev.vol.mean()) if len(prev) else 0.0
        ratios = []
        if base_vol > 0:
            ratios = [float(v / base_vol) for v in post.vol.astype(float)]
        elevated = [r >= 1.5 for r in ratios]
        consecutive = any(elevated[i] and elevated[i + 1] for i in range(len(elevated) - 1))
        avg_ratio = float(np.mean(ratios)) if ratios else None
        result["metrics"].update({"pre_limitup_5d_avg_volume": base_vol,
                                  "post_volume_vs_pre5": [round(x, 2) for x in ratios],
                                  "post_volume_avg_vs_pre5": round(avg_ratio, 2) if avg_ratio is not None else None,
                                  "post_volume_days_ge_1_5x": sum(elevated)})
        if consecutive and avg_ratio is not None and avg_ratio >= 1.3:
            result["tags"].append("连续高量能")

    # Volatility uses the canonical one-minute bars, never 15-minute bars.
    m = minute[minute.ts_code.eq(code)].copy()
    if not m.empty:
        m["trade_date"] = m.trade_date.map(day_key)
        m["datetime"] = pd.to_datetime(m.datetime)
        m = m.sort_values("datetime")
    post_seal = m[m.trade_date.ge(event_date)].copy() if not m.empty else m
    if not post_seal.empty and lu_time and lu_time != "未知":
        event_mask = post_seal.trade_date.eq(event_date)
        cutoff = pd.to_datetime(event_date + " " + lu_time, format="%Y%m%d %H:%M:%S", errors="coerce")
        if pd.notna(cutoff):
            post_seal = post_seal[~event_mask | post_seal.datetime.ge(cutoff)]
    session_vols = []
    for day, g in post_seal.groupby("trade_date", sort=True):
        prices = g.close.astype(float).replace(0, np.nan).dropna()
        returns = np.log(prices).diff().replace([np.inf, -np.inf], np.nan).dropna()
        if len(returns) >= 10:
            # Standard deviation of one-minute log returns, in basis points.
            session_vols.append({"date": day, "bars": int(len(g)),
                                 "vol_bps": float(returns.std(ddof=1) * 10000)})
    result["metrics"]["one_minute_session_volatility"] = [
        {**x, "vol_bps": round(x["vol_bps"], 2)} for x in session_vols
    ]
    if len(session_vols) >= 2:
        first, latest = session_vols[0]["vol_bps"], session_vols[-1]["vol_bps"]
        ratio = latest / first if first > 0 else None
        result["metrics"]["latest_vs_first_one_minute_vol"] = round(ratio, 3) if ratio is not None else None
        if ratio is not None and ratio <= .80:
            result["tags"].append("一分钟波动率收缩")
    return result


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: analyze_post_limitup.py DECK_DATA OUTPUT_JSON")
    source, target = map(Path, sys.argv[1:])
    deck = json.loads(source.read_text())
    summary = deck["summary"]
    anchor = summary["anchor_date"]
    candidates = deck["candidates"]
    codes = sorted({r["ts_code"] for r in candidates})
    sessions = summary["intraday_trading_dates_5"]
    start = (pd.Timestamp(min(sessions)) - pd.Timedelta(days=420)).strftime("%Y%m%d")
    daily = batched(get_day, codes, start_date=start, end_date=anchor,
                    qfq=True, source="database_only")
    minute = batched(get_oneMin, codes, start_date=min(sessions), end_date=anchor)
    # Validate every available candidate trading day in the 5-day minute window.
    day_codes = set(zip(daily.trade_date.astype(str), daily.ts_code.astype(str)))
    minute_counts = minute.groupby([minute.trade_date.astype(str), minute.ts_code.astype(str)]).size().to_dict()
    expected = {(day, code) for day, code in day_codes if day in set(sessions)}
    missing = [(day, code, int(minute_counts.get((day, code), 0))) for day, code in sorted(expected)
               if int(minute_counts.get((day, code), 0)) != 240]
    if missing:
        raise RuntimeError(f"canonical one-minute coverage gap; repair with TradingDataManager before analysis: {missing[:20]} (total {len(missing)})")
    rows = [analyze(daily, minute, c, anchor) for c in candidates]
    counts = Counter(tag for row in rows for tag in row.get("tags", []))
    eligible = [r for r in rows if r.get("post_sessions", 0) > 0]
    result = {
        "as_of": anchor,
        "data": {"daily_source": "TradingDataManager get_day qfq database_only",
                 "minute_source": "TradingDataManager get_oneMin canonical TDX Parquet",
                 "minute_window": sessions,
                 "minute_expected_stock_days": len(expected),
                 "minute_complete_stock_days": len(expected) - len(missing),
                 "minute_missing_stock_days": len(missing),
                 "minute_bars_per_complete_stock_day": 240},
        "method": {"strong_consolidation": "至少2个涨停后交易日；收盘价低点≥涨停收盘价95%，最新收盘≥97%，高点≤103%，区间≤5%（均按涨停收盘价归一）",
                   "one_min_volatility_contraction": "涨停时间之后的一分钟bar按交易日计算单分钟对数收益标准差；至少2个有效交易日，最后一日≤首个有效日的80%",
                   "pullback": "涨停后任一日线最低价距涨停日开盘/低点，或该日当时的MA5/10/20/30，在±1.5%内；记录触及日收盘是否站回价位",
                   "persistent_volume": "至少连续2个涨停后交易日成交量≥涨停前5个交易日日均量1.5倍，且涨停后平均量≥前5日均量1.3倍",
                   "volume_caveat": "高量能表示成交活跃，不单独判定方向；所有均线和日线价采用截至10/16的前复权日线。"},
        "counts": dict(counts), "candidate_count": len(rows),
        "post_event_candidate_count": len(eligible), "stocks": rows,
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"candidates": len(rows), "eligible": len(eligible),
                      "counts": dict(counts), "minute_coverage": result["data"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
