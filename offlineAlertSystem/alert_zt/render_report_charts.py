#!/usr/bin/env python3
"""Render report charts from the temporary local CSV snapshot."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import shutil
import sys
import warnings

import pandas as pd

PROJECT = Path(__file__).resolve().parents[2]
OFFLINE = PROJECT / "offlineAlertSystem"
if str(OFFLINE) not in sys.path:
    sys.path.insert(0, str(OFFLINE))
from plot.KlinePlot import KlinePlot, _prepare


def read_frame(path: Path, *, minute: bool = False) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    # generate_report.py already applies qfq and computes moving averages before
    # persisting this temporary snapshot. Reapplying _prepare(minute=True) here
    # would apply the adjustment factor a second time and scale prices incorrectly.
    frame = pd.read_csv(path, low_memory=False)
    if minute:
        frame["datetime"] = pd.to_datetime(frame["datetime"], errors="coerce")
        frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    else:
        frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    return frame


def grouped(frame: pd.DataFrame) -> dict[str, pd.DataFrame]:
    if frame.empty or "ts_code" not in frame:
        return {}
    return {str(code): part for code, part in frame.groupby("ts_code", sort=False)}


def main(report_dir: Path) -> dict:
    data_dir = report_dir / "_chart_data"
    meta = json.loads((report_dir / "chart_input.json").read_text(encoding="utf-8"))
    summary, records = meta["summary"], meta["candidates"]
    daily_all = grouped(read_frame(data_dir / "daily.csv"))
    weekly_all = grouped(read_frame(data_dir / "weekly.csv"))
    monthly_all = grouped(read_frame(data_dir / "monthly.csv"))
    fifteen_all = grouped(read_frame(data_dir / "fifteen.csv", minute=True))
    kpl_path = data_dir / "kpl_history.csv"
    kpl = pd.read_csv(kpl_path, low_memory=False) if kpl_path.exists() and kpl_path.stat().st_size else pd.DataFrame()
    if not kpl.empty:
        kpl["trade_date"] = kpl.trade_date.astype(str)
        kpl["ts_code"] = kpl.ts_code.astype(str)
        event_map = {str(code): sorted(set(frame.trade_date.astype(str)))
                     for code, frame in kpl.groupby("ts_code", sort=False)}
    else:
        event_map = {}
    anchor = pd.Timestamp(summary["anchor_date"])
    daily_start = anchor - pd.DateOffset(months=18)
    weekly_start = anchor - pd.DateOffset(years=5)
    monthly_start = anchor - pd.DateOffset(years=10)
    fifteen_start = anchor - pd.DateOffset(months=3)
    images_dir = report_dir / "charts"
    images_dir.mkdir(parents=True, exist_ok=True)
    plotter = KlinePlot(qfq=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=FutureWarning)
        for i, item in enumerate(records, 1):
            code = item["ts_code"]
            d = daily_all.get(code, pd.DataFrame())
            w = weekly_all.get(code, pd.DataFrame())
            m = monthly_all.get(code, pd.DataFrame())
            full_f = fifteen_all.get(code, pd.DataFrame())
            d = d[d.date.ge(daily_start)].copy() if not d.empty else d
            w = w[w.date.ge(weekly_start)].copy() if not w.empty else w
            m = m[m.date.ge(monthly_start)].copy() if not m.empty else m
            f = full_f[full_f.date.ge(fifteen_start)].copy() if not full_f.empty else full_f
            stem = code.replace(".", "_")
            overview = images_dir / f"{stem}_overview.jpg"
            intraday = images_dir / f"{stem}_intraday.jpg"
            marks = [dte for dte in event_map.get(code, [])
                     if dte >= daily_start.strftime("%Y%m%d")]
            plotter.plot_overview_page(ts_code=code, name=item["name"], theme=item["theme"],
                end_date=summary["anchor_date"], daily=d, weekly=w, monthly=m,
                limit_dates=marks, save_path=overview)
            plotter.plot_intraday_days(ts_code=code, name=item["name"], end_date=summary["anchor_date"],
                frame=full_f, session_dates=summary["intraday_trading_dates_5"], save_path=intraday)
            item["overview_image"] = str(overview.relative_to(report_dir))
            item["intraday_image"] = str(intraday.relative_to(report_dir))
            item["chart_coverage"] = {
                "daily_bars_18m": int(len(d)), "weekly_bars_5y": int(len(w)),
                "monthly_bars_10y": int(len(m)), "fifteen_min_bars_3m": int(len(f)),
                "intraday_5d_bars": int(full_f.date.isin(pd.to_datetime(summary["intraday_trading_dates_5"])).sum()) if not full_f.empty else 0,
                "limit_up_marks_18m": int(len(marks)),
            }
            if i % 25 == 0 or i == len(records):
                print(f"图表 {i}/{len(records)}", flush=True)
    payload = {"summary": summary, "candidates": records}
    (report_dir / "deck_data.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (report_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(data_dir, ignore_errors=True)
    (report_dir / "chart_input.json").unlink(missing_ok=True)
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", required=True, type=Path)
    args = parser.parse_args()
    main(args.report_dir)
