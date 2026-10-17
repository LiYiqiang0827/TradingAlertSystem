#!/usr/bin/env python3
"""Build the daily limit-up watchlist and chart image package from offline data."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date
import json
from pathlib import Path
import re
import sys
import subprocess
import os

import pandas as pd

PROJECT = Path(__file__).resolve().parents[2]
OFFLINE_ROOT = PROJECT / "offlineAlertSystem"
for candidate in (Path.home() / "TradingDataManager", Path.home() / "TradingAgent"):
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.append(str(candidate))
sys.path.insert(0, str(OFFLINE_ROOT))

from coreClient.data_provider import get_day, get_fifteenMin, get_kpl_list, get_month, get_oneMin, get_oneMin_quality, get_tradecal, get_week
from plot.KlinePlot import _prepare

WATCHLIST_DIR = OFFLINE_ROOT / "watchlist"
OUTPUT_ROOT = OFFLINE_ROOT / "alert_zt" / "output"
TDM_ROOT = Path.home() / "TradingDataManager"
TDM_ONE_MIN_SERVICE = TDM_ROOT / "offlineDataManager" / "scripts" / "service" / "service_oneMinute.py"
TDM_PYTHON = TDM_ROOT / ".venv" / "bin" / "python"
STATUS_RE = re.compile(r"^(\d+)連板$")


def compact_date(value: object) -> str:
    return pd.Timestamp(str(value)).strftime("%Y%m%d")


def theme_parts(value: object) -> list[str]:
    if value is None or pd.isna(value):
        return []
    return [part.strip() for part in re.split(r"[、,，/|]", str(value)) if part.strip()]


def board_count(value: object) -> int:
    match = STATUS_RE.fullmatch(str(value or "").strip())
    return int(match.group(1)) if match else 1


def load_anchor(today: str | None) -> tuple[str, pd.DataFrame]:
    end = compact_date(today) if today else date.today().strftime("%Y%m%d")
    start = (pd.Timestamp(end) - pd.Timedelta(days=120)).strftime("%Y%m%d")
    recent = get_kpl_list(start_date=start, end_date=end, tags="涨停", source="database_only")
    if recent.empty:
        raise RuntimeError(f"本地 KPL 涨停榜 {start}至{end} 没有数据；不改用在线数据")
    recent["trade_date"] = recent.trade_date.astype(str)
    anchor = max(recent.trade_date)
    return anchor, recent[recent.trade_date.le(anchor)].copy()


def market_dates(anchor: str) -> list[str]:
    start = (pd.Timestamp(anchor) - pd.Timedelta(days=100)).strftime("%Y%m%d")
    cal = get_tradecal(start_date=start, end_date=anchor, market="SSE", source="database_only")
    if not cal.empty:
        cal = cal[cal.is_open.astype(str).eq("1")]
        dates = sorted(set(cal.cal_date.astype(str)))
        if len(dates) >= 20:
            return dates[-20:]
    # KPL has a row on each nonzero limit-up day; use it only when the calendar
    # database does not cover a complete 20-session window.
    fallback = get_kpl_list(start_date=start, end_date=anchor, tags="涨停", source="database_only")
    dates = sorted(set(fallback.trade_date.astype(str)))
    if len(dates) < 20:
        raise RuntimeError(f"交易日历和 KPL 均不足 20 个交易日：{len(dates)}")
    return dates[-20:]


def expand_theme_counts(day_frame: pd.DataFrame) -> dict[str, int]:
    counts: dict[str, set[str]] = {}
    for row in day_frame.itertuples(index=False):
        for theme in theme_parts(getattr(row, "theme", "")):
            counts.setdefault(theme, set()).add(str(row.ts_code))
    return {theme: len(codes) for theme, codes in counts.items()}


def make_candidates(kpl: pd.DataFrame, sessions: list[str], anchor: str) -> tuple[list[dict], dict]:
    frame = kpl[kpl.trade_date.astype(str).isin(sessions)].copy()
    frame["ts_code"] = frame.ts_code.astype(str)
    frame["trade_date"] = frame.trade_date.astype(str)
    frame["board_count"] = frame.status.map(board_count)
    date5 = sessions[-5:]
    recent5 = frame[frame.trade_date.isin(date5)]
    recent20_counts = frame.groupby("ts_code").size().to_dict()
    recent5_counts = recent5.groupby("ts_code").size().to_dict()
    max_boards = frame.groupby("ts_code").board_count.max().to_dict()
    consecutive = set(frame.loc[frame.board_count.ge(2), "ts_code"])
    selected_codes = set(recent5_counts) | consecutive

    day = frame[frame.trade_date.eq(anchor)]
    heat = expand_theme_counts(day)
    heat_rank = {k: i for i, (k, _) in enumerate(sorted(heat.items(), key=lambda x: (-x[1], x[0])))}
    records = []
    for code in selected_codes:
        rows = frame[frame.ts_code.eq(code)].sort_values(["trade_date", "lu_time"])
        if rows.empty:
            continue
        anchor_rows = rows[rows.trade_date.eq(anchor)]
        newest = rows.iloc[-1]
        themed = anchor_rows.iloc[0] if not anchor_rows.empty else newest
        themes = theme_parts(themed.get("theme", ""))
        primary_theme = themes[0] if themes else "未标注"
        count5 = int(recent5_counts.get(code, 0))
        count20 = int(recent20_counts.get(code, 0))
        max_board = int(max_boards.get(code, 1))
        latest_date = str(newest.trade_date)
        latest_time = str(newest.get("lu_time", "")) or "未知"
        hit_dates = sorted(set(rows.trade_date.astype(str)))
        matched_status = rows[rows.board_count.ge(2)]
        streak_text = (f"近20交易日最高{max_board}连板（{matched_status.iloc[-1].trade_date}）"
                       if max_board >= 2 else "近20交易日无明确连续2板状态")
        reason_bits = []
        if count5:
            dates_text = "、".join(pd.Timestamp(d).strftime("%m-%d") for d in hit_dates if d in date5)
            reason_bits.append(f"近5个交易日涨停{count5}次（{dates_text}）")
        if max_board >= 2:
            reason_bits.append(streak_text)
        else:
            reason_bits.append(f"近20个交易日涨停{count20}次")
        reason_bits.append(f"题材{primary_theme}在榜单日涨停{heat.get(primary_theme, 0)}只")
        importance = 1 + int(count5 > 0) + int(max_board >= 2)
        importance += int(count5 >= 2 or max_board >= 3)
        importance += int(heat.get(primary_theme, 0) >= 5)
        importance = min(5, importance)
        if count5 and max_board >= 2:
            alert_name = "近5日涨停及连板跟踪"
        elif count5:
            alert_name = "近5日涨停跟踪"
        else:
            alert_name = "近20日连续2板以上观察"
        records.append({
            "ts_code": code, "name": str(themed.get("name", newest.get("name", ""))),
            "alert_name": alert_name, "reason": "；".join(reason_bits),
            "importance": importance, "theme": primary_theme,
            "theme_aliases": themes, "theme_limit_up_count": int(heat.get(primary_theme, 0)),
            "limit_up_count_5d": count5, "limit_up_count_20d": count20,
            "max_consecutive_boards_20d": max_board,
            "latest_limit_up_date": latest_date, "latest_limit_up_time": latest_time,
            "limit_up_dates_20d": hit_dates,
            "anchor_status": (str(anchor_rows.iloc[0].get("status", "")) if not anchor_rows.empty else ""),
            "anchor_date": anchor,
            "theme_rank": int(heat_rank.get(primary_theme, len(heat_rank))),
        })
    records.sort(key=lambda r: (r["theme_rank"], -r["limit_up_count_20d"],
                                -int(r["latest_limit_up_date"] == anchor),
                                r["latest_limit_up_time"], r["ts_code"]))
    return records, {"date5": date5, "theme_heat": heat}


def fetch_code_batches(provider, codes: list[str], **kwargs) -> pd.DataFrame:
    """Keep SQLite IN queries modest; validate the batch path with actual row counts."""
    frames = []
    batch_size = 40
    for start in range(0, len(codes), batch_size):
        batch = codes[start:start + batch_size]
        frame = provider(ts_codes=batch, **kwargs)
        if not frame.empty:
            frames.append(frame)
        print(f"  {provider.__name__}: {min(start + batch_size, len(codes))}/{len(codes)} stocks, {sum(len(x) for x in frames)} rows", flush=True)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def one_minute_coverage_gaps(
    daily: pd.DataFrame, minute: pd.DataFrame, dates: list[str], *, bars_per_session: int = 240,
) -> tuple[dict[str, list[str]], dict]:
    """Find candidate stock-days whose canonical 1-minute bars are incomplete."""
    date_set = set(dates)
    expected: set[tuple[str, str]] = set()
    if not daily.empty and {"date", "ts_code"}.issubset(daily.columns):
        recent = daily[daily.date.dt.strftime("%Y%m%d").isin(date_set)]
        expected = {
            (row.date.strftime("%Y%m%d"), str(row.ts_code).upper())
            for row in recent[["date", "ts_code"]].itertuples(index=False)
        }
    counts: dict[tuple[str, str], int] = {}
    if not minute.empty and {"date", "ts_code"}.issubset(minute.columns):
        recent_minute = minute[minute.date.dt.strftime("%Y%m%d").isin(date_set)]
        counts = {
            (day, str(code).upper()): int(count)
            for (day, code), count in recent_minute.assign(
                _trade_date=recent_minute.date.dt.strftime("%Y%m%d")
            ).groupby(["_trade_date", "ts_code"], sort=False).size().items()
        }
    gaps: dict[str, list[str]] = {}
    missing_details = []
    for day, code in sorted(expected):
        bars = counts.get((day, code), 0)
        if bars < bars_per_session:
            gaps.setdefault(day, []).append(code)
            missing_details.append({"trade_date": day, "ts_code": code, "bars": bars})
    complete_pairs = len(expected) - len(missing_details)
    return gaps, {
        "expected_stock_days": len(expected),
        "complete_stock_days": complete_pairs,
        "missing_stock_days": len(missing_details),
        "required_bars_per_stock_day": bars_per_session,
        "missing_details": missing_details,
    }


def repair_one_minute_gaps(gaps: dict[str, list[str]]) -> dict:
    """Use TradingDataManager's TDX service to repair only missing stocks/dates."""
    if not gaps:
        return {"attempted": False, "status": "not_needed", "dates": []}
    if not TDM_PYTHON.is_file() or not TDM_ONE_MIN_SERVICE.is_file():
        return {
            "attempted": False, "status": "unavailable",
            "error": f"TradingDataManager minute service or Python missing under {TDM_ROOT}",
            "dates": sorted(gaps),
        }
    env = os.environ.copy()
    extra_path = [str(TDM_ROOT), str(TDM_ROOT / "offlineDataManager" / "scripts")]
    env["PYTHONPATH"] = ":".join(extra_path + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    results = []
    for day, codes in sorted(gaps.items()):
        command = [
            str(TDM_PYTHON), str(TDM_ONE_MIN_SERVICE), "--trade-date", day,
            "--ts-codes", ",".join(sorted(set(codes))), "--force", "--merge-existing",
        ]
        try:
            result = subprocess.run(
                command, cwd=TDM_ROOT, env=env, text=True, capture_output=True,
                check=False, timeout=900,
            )
            output = (result.stdout or "") + (result.stderr or "")
            results.append({
                "trade_date": day, "requested_stock_count": len(set(codes)),
                "returncode": result.returncode,
                "status": "command_succeeded" if result.returncode == 0 else "failed",
                "log_tail": output[-2000:],
            })
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            results.append({
                "trade_date": day, "requested_stock_count": len(set(codes)),
                "returncode": None, "status": "timeout", "log_tail": str(output)[-2000:],
            })
        except OSError as exc:
            results.append({
                "trade_date": day, "requested_stock_count": len(set(codes)),
                "returncode": None, "status": "failed", "log_tail": str(exc),
            })
        print(f"  TradingDataManager oneMin {day}: {results[-1]['status']} "
              f"({len(set(codes))} stocks)", flush=True)
    return {
        "attempted": True,
        "status": "command_succeeded" if all(item["status"] == "command_succeeded" for item in results) else "incomplete",
        "dates": results,
    }


def replace_raw_volume(adjusted: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
    if adjusted.empty or raw.empty:
        return adjusted
    keys = ["ts_code", "trade_date"] if "ts_code" in adjusted.columns else ["trade_date"]
    cols = [*keys, "vol", "amount"]
    right = raw[[c for c in cols if c in raw.columns]].drop_duplicates(keys, keep="last")
    right = right.rename(columns={"vol": "_raw_vol", "amount": "_raw_amount"})
    out = adjusted.merge(right, on=keys, how="left")
    if "_raw_vol" in out:
        out["vol"] = out["_raw_vol"].fillna(out["vol"])
        out.drop(columns="_raw_vol", inplace=True)
    if "_raw_amount" in out:
        out["amount"] = out["_raw_amount"].fillna(out["amount"])
        out.drop(columns="_raw_amount", inplace=True)
    return out


def write_watchlist(records: list[dict], anchor: str) -> Path:
    WATCHLIST_DIR.mkdir(parents=True, exist_ok=True)
    columns = ["股票代码", "名称", "alert名称", "原因", "重要等级", "交易日", "题材",
               "近5日涨停次数", "近20日涨停次数", "最高连续板数", "最近涨停日", "最近封板时间"]
    rows = [{
        "股票代码": r["ts_code"], "名称": r["name"], "alert名称": r["alert_name"],
        "原因": r["reason"], "重要等级": r["importance"], "交易日": anchor,
        "题材": r["theme"], "近5日涨停次数": r["limit_up_count_5d"],
        "近20日涨停次数": r["limit_up_count_20d"],
        "最高连续板数": r["max_consecutive_boards_20d"],
        "最近涨停日": r["latest_limit_up_date"], "最近封板时间": r["latest_limit_up_time"],
    } for r in records]
    path = WATCHLIST_DIR / f"watchlist_{anchor}.csv"
    pd.DataFrame(rows, columns=columns).to_csv(path, index=False, encoding="utf-8-sig")
    return path


def generate(anchor_override: str | None = None, output_root: Path = OUTPUT_ROOT) -> dict:
    anchor, recent = load_anchor(anchor_override)
    sessions = market_dates(anchor)
    if anchor not in sessions:
        sessions.append(anchor); sessions = sorted(set(sessions))[-20:]
    start20 = sessions[0]
    kpl20 = get_kpl_list(start_date=start20, end_date=anchor, tags="涨停", source="database_only")
    kpl20["trade_date"] = kpl20.trade_date.astype(str)
    records, rules = make_candidates(kpl20, sessions, anchor)
    if not records:
        raise RuntimeError(f"{anchor} 没有满足近5日涨停或近20日连续2板以上条件的股票")
    watchlist_path = write_watchlist(records, anchor)

    anchor_ts = pd.Timestamp(anchor)
    daily_visible_start = anchor_ts - pd.DateOffset(months=18)
    weekly_visible_start = anchor_ts - pd.DateOffset(years=5)
    monthly_visible_start = anchor_ts - pd.DateOffset(years=10)
    fifteen_visible_start = anchor_ts - pd.DateOffset(months=3)
    daily_fetch_start = (daily_visible_start - pd.DateOffset(years=2)).strftime("%Y%m%d")
    weekly_fetch_start = (weekly_visible_start - pd.DateOffset(years=7)).strftime("%Y%m%d")
    monthly_fetch_start = (monthly_visible_start - pd.DateOffset(years=20)).strftime("%Y%m%d")
    fifteen_fetch_start = (fifteen_visible_start - pd.DateOffset(months=2)).strftime("%Y%m%d")
    codes = sorted({r["ts_code"] for r in records})
    end = anchor
    print(f"查询 {len(codes)} 只股票行情，榜单日 {anchor}，仅 database_only", flush=True)
    daily_adj = fetch_code_batches(get_day, codes, start_date=daily_fetch_start, end_date=end,
                                   qfq=True, source="database_only")
    daily_raw = fetch_code_batches(get_day, codes, start_date=daily_fetch_start, end_date=end,
                                   qfq=False, source="database_only")
    weekly_adj = fetch_code_batches(get_week, codes, start_date=weekly_fetch_start, end_date=end,
                                    qfq=True, source="database_only")
    weekly_raw = fetch_code_batches(get_week, codes, start_date=weekly_fetch_start, end_date=end,
                                    qfq=False, source="database_only")
    monthly_adj = fetch_code_batches(get_month, codes, start_date=monthly_fetch_start, end_date=end,
                                     qfq=True, source="database_only")
    monthly_raw = fetch_code_batches(get_month, codes, start_date=monthly_fetch_start, end_date=end,
                                     qfq=False, source="database_only")
    fifteen_raw = fetch_code_batches(get_fifteenMin, codes, start_date=fifteen_fetch_start, end_date=end)
    minute_recent = fetch_code_batches(get_oneMin, codes, start_date=sessions[-5], end_date=anchor)
    minute_quality = pd.concat([
        get_oneMin_quality(trade_date=day, ts_codes=codes) for day in sessions[-5:]
    ], ignore_index=True)
    daily_adj = _prepare(replace_raw_volume(daily_adj, daily_raw))
    weekly_adj = _prepare(replace_raw_volume(weekly_adj, weekly_raw))
    monthly_adj = _prepare(replace_raw_volume(monthly_adj, monthly_raw))
    fifteen_all = _prepare(fifteen_raw, minute=True)
    minute_all = _prepare(minute_recent, minute=True)
    minute_gaps, minute_coverage = one_minute_coverage_gaps(daily_adj, minute_all, rules["date5"])
    minute_repair = repair_one_minute_gaps(minute_gaps)
    if minute_repair["attempted"]:
        minute_recent = fetch_code_batches(get_oneMin, codes, start_date=sessions[-5], end_date=anchor)
        minute_all = _prepare(minute_recent, minute=True)
        minute_gaps, minute_coverage = one_minute_coverage_gaps(daily_adj, minute_all, rules["date5"])
    minute_quality = pd.concat([
        get_oneMin_quality(trade_date=day, ts_codes=codes) for day in sessions[-5:]
    ], ignore_index=True)
    print("已读取行情：日线%d 周线%d 月线%d 15分钟%d 1分钟%d；1分钟完整覆盖%d/%d股日" %
          (len(daily_adj), len(weekly_adj), len(monthly_adj), len(fifteen_all), len(minute_all),
           minute_coverage["complete_stock_days"], minute_coverage["expected_stock_days"]), flush=True)

    chart_kpl_start = daily_visible_start.strftime("%Y%m%d")
    kpl_history = get_kpl_list(start_date=chart_kpl_start, end_date=anchor,
                               tags="涨停", source="database_only")
    kpl_history["trade_date"] = kpl_history.trade_date.astype(str)
    kpl_history["ts_code"] = kpl_history.ts_code.astype(str)
    event_map = {code: sorted(set(g.trade_date)) for code, g in kpl_history.groupby("ts_code")}
    # Keep the requested exchange sessions visible even when 1-minute bars remain missing.
    actual5 = rules["date5"]
    report_dir = output_root / anchor
    report_dir.mkdir(parents=True, exist_ok=True)
    data_dir = report_dir / "_chart_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    for name, frame in (("daily", daily_adj), ("weekly", weekly_adj),
                        ("monthly", monthly_adj), ("fifteen", fifteen_all),
                        ("one_min", minute_all), ("kpl_history", kpl_history)):
        frame.to_csv(data_dir / f"{name}.csv", index=False)
    minute_stock_coverage = {
        day: int(minute_all.loc[minute_all.date.eq(pd.Timestamp(day)), "ts_code"].nunique())
        for day in rules["date5"]
    }
    theme_rows = sorted(rules["theme_heat"].items(), key=lambda x: (-x[1], x[0]))
    summary = {
        "anchor_date": anchor, "selection_trading_dates_20": sessions,
        "intraday_trading_dates_5": actual5, "candidate_count": len(records),
        "candidate_stocks": len({r["ts_code"] for r in records}),
        "theme_count": len({r["theme"] for r in records}),
        "market_limit_up_count": int(kpl20[kpl20.trade_date.eq(anchor)].ts_code.nunique()),
        "theme_heat": [{"theme": k, "limit_up_stocks": v} for k, v in theme_rows],
        "chart_cutoff": anchor,
        "selection": "近5个上交所交易日内出现过KPL涨停，或近20个交易日KPL status 明确为2连板及以上；取并集并按股票去重",
        "theme_assignment": "按榜单日KPL theme首项归组；榜单日无记录时用最近一次涨停记录theme首项；题材热度按榜单日全市场KPL涨停股票计数",
        "sort_order": "题材当日涨停家数降序；题材内近20交易日涨停次数降序、最近涨停日优先、封板时点升序",
        "importance_rule": "基础1分；近5日有涨停+1；近20日有连续2板+1；近5日涨停至少2次或最高连续3板+1；题材当日涨停不少于5只+1；上限5。仅为可解释的观察优先级，不代表预测或买卖建议。",
        "intraday_source_note": (f"上图：数据库canonical TDX 1分钟OHLC，近5日{len(minute_all):,}根；完整覆盖{minute_coverage['complete_stock_days']}/{minute_coverage['expected_stock_days']}个有日线的股票日，要求每只每天240根。补数状态：{minute_repair['status']}；仍缺{minute_coverage['missing_stock_days']}个股票日，详见manifest。下图：本地近3个月15分钟K线仅作背景参考，不替代缺失的一分钟数据。逐日一分钟股票覆盖：{minute_stock_coverage}。动态MA5/10/20按前N-1个已完成交易日收盘价与当前分钟收盘价计算。质量sidecar含{len(minute_quality)}条成交额非零但成交量为零的软标记，成交量保留库内值。"),
        "data_source": "coreClient.data_provider; get_oneMin reads canonical one-minute OHLC Parquet (TDX source boundary from 2026-05-07); get_fifteenMin reads offline DuckDB; source=database_only for daily/weekly/monthly/KPL/tradecal",
        "one_min_coverage": minute_coverage,
        "one_min_repair": minute_repair,
        "one_min_quality_flags": int(len(minute_quality)),
        "one_min_quality_flags_by_stock": (minute_quality.groupby("ts_code").size().astype(int).to_dict() if not minute_quality.empty and "ts_code" in minute_quality.columns else {}),
        "data_limits": {"kpl_latest_date": anchor,
                        "daily_latest": str(daily_adj.trade_date.astype(str).max()) if not daily_adj.empty else None,
                        "weekly_latest": str(weekly_adj.trade_date.astype(str).max()) if not weekly_adj.empty else None,
                        "monthly_latest": str(monthly_adj.trade_date.astype(str).max()) if not monthly_adj.empty else None,
                        "fifteen_min_latest": str(fifteen_all.trade_date.astype(str).max()) if not fifteen_all.empty else None,
                        "one_min_latest": str(minute_all.trade_date.astype(str).max()) if not minute_all.empty else None,
                        "one_min_recent_days": {"rows": len(minute_all), "stocks": int(minute_all.ts_code.nunique()) if not minute_all.empty else 0, "window": f"{sessions[-5]}-{anchor}", "quality_flags": int(len(minute_quality))}},
        "watchlist_csv": str(watchlist_path), "report_dir": str(report_dir),
    }
    payload = {"summary": summary, "candidates": records}
    (report_dir / "chart_input.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    renderer = Path(__file__).with_name("render_report_charts.py")
    print(f"在系统 Python 中渲染图表：{renderer}", flush=True)
    subprocess.run(["/usr/bin/python3", str(renderer), "--report-dir", str(report_dir)], check=True)
    final_payload = json.loads((report_dir / "deck_data.json").read_text(encoding="utf-8"))
    print(json.dumps({k: summary[k] for k in ("anchor_date", "candidate_count", "theme_count", "market_limit_up_count", "intraday_trading_dates_5", "data_limits")}, ensure_ascii=False, indent=2), flush=True)
    return final_payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", help="Use a fixed available KPL trade date (YYYYMMDD)")
    parser.add_argument("--output-root", type=Path, default=OUTPUT_ROOT)
    args = parser.parse_args()
    generate(args.as_of, args.output_root)
