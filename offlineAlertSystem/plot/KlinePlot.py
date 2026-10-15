"""K-line plotting interfaces shared by offline alert strategies.

The chart styling follows TradingAgent/MrLi/plot and reads only the existing
coreClient data providers. Candles use adjusted prices; volume remains raw.
"""
from __future__ import annotations

from pathlib import Path
import sys
from typing import Iterable, Sequence

import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
for candidate in (Path.home() / "TradingAgent", Path.home() / "TradingDataManager"):
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))


PRICE_MAS = (5, 10, 20, 30, 60, 120, 250)
VOLUME_MAS = (5, 20, 60)
MA_COLORS = {
    5: "#f4c430", 10: "#3182bd", 20: "#a05eb5", 30: "#f28e2b",
    60: "#3366aa", 120: "#8c6d31", 250: "#303030",
}
UP_COLOR = "#d94b45"
DOWN_COLOR = "#27936f"


def _matplotlib():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def _configure_font() -> None:
    plt = _matplotlib()
    plt.rcParams["font.sans-serif"] = [
        "Arial Unicode MS", "PingFang SC", "Heiti SC", "Microsoft YaHei", "SimHei", "DejaVu Sans"
    ]
    plt.rcParams["axes.unicode_minus"] = False
    plt.rcParams["figure.facecolor"] = "white"
    plt.rcParams["axes.facecolor"] = "white"


def _date_text(value: object) -> str:
    return pd.Timestamp(value).strftime("%Y%m%d")


def _prepare(frame: pd.DataFrame, *, minute: bool = False) -> pd.DataFrame:
    if frame is None or frame.empty:
        return pd.DataFrame()
    df = frame.copy()
    if minute:
        df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce")
        df["date"] = df["datetime"].dt.normalize()
        if "adj_factor" in df:
            factor = pd.to_numeric(df["adj_factor"], errors="coerce")
            if "ts_code" in df.columns:
                last_factor = factor.groupby(df["ts_code"], sort=False).transform("last")
            else:
                valid = factor.dropna()
                last_factor = pd.Series(valid.iloc[-1] if len(valid) else np.nan, index=df.index)
            scale = factor.fillna(last_factor).div(last_factor.where(last_factor.ne(0)))
            for col in ("open", "high", "low", "close"):
                df[col] = pd.to_numeric(df[col], errors="coerce") * scale
    else:
        df["date"] = pd.to_datetime(df["trade_date"].astype(str), format="%Y%m%d", errors="coerce")
    for col in ("open", "high", "low", "close", "vol", "amount"):
        if col in df:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    time_key = "datetime" if minute else "date"
    keys = (["ts_code", time_key] if "ts_code" in df.columns else [time_key])
    df = (df.dropna(subset=[*keys, "open", "high", "low", "close", "vol"])
          .drop_duplicates(subset=keys, keep="last").sort_values(keys).reset_index(drop=True))
    group = df.groupby("ts_code", sort=False) if "ts_code" in df.columns else None
    for n in PRICE_MAS:
        if group is None:
            df[f"ma{n}"] = df.close.rolling(n, min_periods=n).mean()
        else:
            df[f"ma{n}"] = group.close.transform(lambda values: values.rolling(n, min_periods=n).mean())
    for n in VOLUME_MAS:
        if group is None:
            df[f"vol_ma{n}"] = df.vol.rolling(n, min_periods=n).mean()
        else:
            df[f"vol_ma{n}"] = group.vol.transform(lambda values: values.rolling(n, min_periods=n).mean())
    return df


def _draw_candles(ax, frame: pd.DataFrame, *, width: float = 0.62) -> None:
    from matplotlib.patches import Rectangle
    x = np.arange(len(frame), dtype=float)
    for pos, row in zip(x, frame.itertuples(index=False)):
        color = UP_COLOR if row.close >= row.open else DOWN_COLOR
        ax.vlines(pos, row.low, row.high, color=color, linewidth=0.75, zorder=2)
        bottom = min(row.open, row.close)
        height = max(abs(row.close - row.open), max(abs(row.close), 1.0) * 0.0007)
        ax.add_patch(Rectangle((pos - width / 2, bottom), width, height,
                               facecolor=color, edgecolor=color, linewidth=0.55, zorder=3))


def _plot_price(ax, frame: pd.DataFrame, *, ma_font: float = 7.0) -> None:
    if frame.empty:
        ax.text(0.5, 0.5, "无可用行情", transform=ax.transAxes, ha="center", va="center")
        return
    _draw_candles(ax, frame)
    x = np.arange(len(frame))
    for n in PRICE_MAS:
        col = f"ma{n}"
        if frame[col].notna().any():
            ax.plot(x, frame[col], color=MA_COLORS[n], linewidth=0.85, label=f"MA{n}")
    ax.grid(axis="y", color="#d9dfe5", linewidth=0.45, alpha=0.8)
    ax.tick_params(axis="both", labelsize=ma_font, length=2, pad=1)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(loc="upper left", ncol=7, fontsize=ma_font, frameon=False,
              handlelength=1.2, columnspacing=0.7, borderaxespad=0.15)
    step = max(1, len(frame) // 12)
    ticks = list(range(0, len(frame), step))
    ax.set_xticks(ticks)
    ax.set_xticklabels([frame.date.iloc[i].strftime("%Y-%m") for i in ticks], fontsize=ma_font)


def _plot_volume(ax, frame: pd.DataFrame, *, compact: bool = False) -> None:
    if frame.empty:
        return
    x = np.arange(len(frame))
    colors = [UP_COLOR if c >= o else DOWN_COLOR for o, c in zip(frame.open, frame.close)]
    ax.bar(x, frame.vol, color=colors, width=0.62, linewidth=0)
    for n in VOLUME_MAS:
        col = f"vol_ma{n}"
        if frame[col].notna().any():
            ax.plot(x, frame[col], linewidth=0.7 if compact else 0.85,
                    color=MA_COLORS[n], label=f"量MA{n}")
    ax.grid(axis="y", color="#e2e7eb", linewidth=0.4)
    ax.tick_params(axis="both", labelsize=5.5 if compact else 7, length=1, pad=1)
    ax.spines[["top", "right"]].set_visible(False)
    ax.set_ylabel("成交量", fontsize=6 if compact else 8, labelpad=1)
    if not compact:
        ax.legend(loc="upper left", ncol=3, fontsize=6.5, frameon=False, handlelength=1.2)


def _limit_runs(frame: pd.DataFrame, limit_dates: Iterable[str]) -> list[tuple[int, int, str]]:
    if frame.empty:
        return []
    date_to_idx = {pd.Timestamp(d).normalize(): i for i, d in enumerate(frame.date)}
    indices = sorted({date_to_idx[pd.Timestamp(str(d)).normalize()]
                      for d in limit_dates if pd.Timestamp(str(d)).normalize() in date_to_idx})
    if not indices:
        return []
    runs = []
    start = previous = indices[0]
    for idx in indices[1:]:
        if idx == previous + 1:
            previous = idx
        else:
            runs.append((start, previous, frame.date.iloc[start].strftime("%m%d") if start == previous
                         else f"{frame.date.iloc[start]:%m%d}-{frame.date.iloc[previous]:%m%d}"))
            start = previous = idx
    runs.append((start, previous, frame.date.iloc[start].strftime("%m%d") if start == previous
                 else f"{frame.date.iloc[start]:%m%d}-{frame.date.iloc[previous]:%m%d}"))
    return runs


class KlinePlot:
    """Shared database-backed charts for daily, weekly, monthly and intraday use."""

    def __init__(self, *, qfq: bool = True):
        self.qfq = qfq

    @staticmethod
    def _restore_volume(adjusted: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
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

    def load_daily(self, ts_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        from coreClient.data_provider import get_day
        query = dict(ts_code=ts_code, start_date=_date_text(start_date), end_date=_date_text(end_date))
        adjusted = get_day(**query, qfq=self.qfq, source="database_only")
        if self.qfq:
            adjusted = self._restore_volume(adjusted, get_day(**query, qfq=False, source="database_only"))
        return _prepare(adjusted)

    def load_weekly(self, ts_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        from coreClient.data_provider import get_week
        query = dict(ts_code=ts_code, start_date=_date_text(start_date), end_date=_date_text(end_date))
        adjusted = get_week(**query, qfq=self.qfq, source="database_only")
        if self.qfq:
            adjusted = self._restore_volume(adjusted, get_week(**query, qfq=False, source="database_only"))
        return _prepare(adjusted)

    def load_monthly(self, ts_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        from coreClient.data_provider import get_month
        query = dict(ts_code=ts_code, start_date=_date_text(start_date), end_date=_date_text(end_date))
        adjusted = get_month(**query, qfq=self.qfq, source="database_only")
        if self.qfq:
            adjusted = self._restore_volume(adjusted, get_month(**query, qfq=False, source="database_only"))
        return _prepare(adjusted)

    def load_fifteen_min(self, ts_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        from coreClient.data_provider import get_fifteenMin
        raw = get_fifteenMin(ts_code=ts_code, start_date=_date_text(start_date), end_date=_date_text(end_date))
        return _prepare(raw, minute=True)

    def _save_single(self, frame: pd.DataFrame, title: str, save_path: str | Path,
                     *, limit_dates: Iterable[str] = ()) -> Path:
        plt = _matplotlib(); _configure_font()
        path = Path(save_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        fig = plt.figure(figsize=(14, 8), dpi=110)
        gs = fig.add_gridspec(4, 1, height_ratios=[3.4, 0.9, 0.1, 0.01], hspace=0.03)
        ax = fig.add_subplot(gs[0]); vol = fig.add_subplot(gs[1], sharex=ax)
        _plot_price(ax, frame, ma_font=8)
        _plot_volume(vol, frame)
        ax.set_title(title, loc="left", fontsize=13, pad=5)
        for start, end, label in _limit_runs(frame, limit_dates):
            ax.axvspan(start - 0.45, end + 0.45, color="#ffbf47", alpha=0.16, zorder=0)
            ax.text((start + end) / 2, 0.98 - 0.08 * (len(label) % 3), label,
                    transform=ax.get_xaxis_transform(), ha="center", va="top", fontsize=6.5,
                    rotation=90, color="#8a4d00", clip_on=True)
        fig.subplots_adjust(left=0.07, right=0.99, top=0.94, bottom=0.08)
        fig.savefig(path, format="jpeg", dpi=110, pil_kwargs={"quality": 86, "optimize": True})
        plt.close(fig)
        return path

    def plot_daily_kline(self, ts_code: str, start_date: str, end_date: str,
                         save_path: str | Path, *, limit_dates: Iterable[str] = ()) -> Path:
        return self._save_single(self.load_daily(ts_code, start_date, end_date),
                                 f"{ts_code} 日K线", save_path, limit_dates=limit_dates)

    def plot_weekly_kline(self, ts_code: str, start_date: str, end_date: str,
                          save_path: str | Path) -> Path:
        return self._save_single(self.load_weekly(ts_code, start_date, end_date),
                                 f"{ts_code} 周K线", save_path)

    def plot_monthly_kline(self, ts_code: str, start_date: str, end_date: str,
                           save_path: str | Path) -> Path:
        return self._save_single(self.load_monthly(ts_code, start_date, end_date),
                                 f"{ts_code} 月K线", save_path)

    def plot_fifteen_min_kline(self, ts_code: str, start_date: str, end_date: str,
                               save_path: str | Path) -> Path:
        frame = self.load_fifteen_min(ts_code, start_date, end_date)
        return self._save_minute_single(frame, f"{ts_code} 15分钟K线", save_path)

    def _save_minute_single(self, frame: pd.DataFrame, title: str, save_path: str | Path) -> Path:
        plt = _matplotlib(); _configure_font()
        path = Path(save_path); path.parent.mkdir(parents=True, exist_ok=True)
        fig, (ax, vol) = plt.subplots(2, 1, figsize=(14, 8), sharex=True,
                                      gridspec_kw={"height_ratios": [3.2, 1], "hspace": 0.04})
        if frame.empty:
            ax.text(0.5, 0.5, "无可用15分钟行情", transform=ax.transAxes, ha="center", va="center")
        else:
            _draw_candles(ax, frame, width=0.7)
            x = np.arange(len(frame))
            for n in PRICE_MAS:
                if frame[f"ma{n}"].notna().any():
                    ax.plot(x, frame[f"ma{n}"], color=MA_COLORS[n], lw=0.8, label=f"MA{n}")
            _plot_volume(vol, frame)
            step = max(1, len(frame) // 10)
            ticks = list(range(0, len(frame), step))
            ax.set_xticks(ticks); ax.set_xticklabels([frame.datetime.iloc[i].strftime("%m-%d") for i in ticks])
        ax.legend(loc="upper left", ncol=7, fontsize=7, frameon=False)
        ax.set_title(title, loc="left", fontsize=13)
        ax.grid(axis="y", color="#d9dfe5", lw=0.45)
        fig.savefig(path, format="jpeg", dpi=110, pil_kwargs={"quality": 86, "optimize": True})
        plt.close(fig)
        return path

    def plot_overview_page(self, *, ts_code: str, name: str, theme: str, end_date: str,
                           daily: pd.DataFrame, weekly: pd.DataFrame, monthly: pd.DataFrame,
                           limit_dates: Iterable[str], save_path: str | Path) -> Path:
        """Compose 18-month daily, 5-year weekly and 10-year monthly panels."""
        plt = _matplotlib(); _configure_font()
        path = Path(save_path); path.parent.mkdir(parents=True, exist_ok=True)
        fig = plt.figure(figsize=(16, 8), dpi=100)
        outer = fig.add_gridspec(2, 2, height_ratios=[1.62, 1], hspace=0.19, wspace=0.10)
        daily_gs = outer[0, :].subgridspec(2, 1, height_ratios=[3.3, 0.85], hspace=0.025)
        week_gs = outer[1, 0].subgridspec(2, 1, height_ratios=[3.0, 0.8], hspace=0.02)
        month_gs = outer[1, 1].subgridspec(2, 1, height_ratios=[3.0, 0.8], hspace=0.02)
        ad = fig.add_subplot(daily_gs[0]); av = fig.add_subplot(daily_gs[1], sharex=ad)
        aw = fig.add_subplot(week_gs[0]); awv = fig.add_subplot(week_gs[1], sharex=aw)
        am = fig.add_subplot(month_gs[0]); amv = fig.add_subplot(month_gs[1], sharex=am)
        _plot_price(ad, daily, ma_font=6.7); _plot_volume(av, daily, compact=True)
        _plot_price(aw, weekly, ma_font=5.8); _plot_volume(awv, weekly, compact=True)
        _plot_price(am, monthly, ma_font=5.8); _plot_volume(amv, monthly, compact=True)
        def span(frame):
            if frame.empty:
                return "无可用数据"
            return f"{frame.date.min():%Y-%m}至{frame.date.max():%Y-%m}"
        ad.set_title(f"{ts_code} {name}   日K线（近18个月：{span(daily)}）", loc="left", fontsize=11, pad=3)
        aw.set_title(f"周K线（库内可用：{span(weekly)}）", loc="left", fontsize=8, pad=2)
        am.set_title(f"月K线（库内可用：{span(monthly)}）", loc="left", fontsize=8, pad=2)
        for start, end, label in _limit_runs(daily, limit_dates):
            ad.axvspan(start - 0.45, end + 0.45, color="#ffbf47", alpha=0.20, zorder=0)
            ad.text((start + end) / 2, 0.99 - 0.10 * (len(label) % 4), label,
                    transform=ad.get_xaxis_transform(), ha="center", va="top", fontsize=5.4,
                    rotation=90, color="#854d00", clip_on=True)
        footer = f"题材：{theme}   图表截止：{end_date}   涨停日期标记：黄色区间（连续涨停合并）"
        fig.suptitle(footer, x=0.5, y=0.995, fontsize=8.5, color="#34495e")
        fig.subplots_adjust(left=0.052, right=0.993, top=0.962, bottom=0.055)
        fig.savefig(path, format="jpeg", dpi=100, pil_kwargs={"quality": 86, "optimize": True})
        plt.close(fig)
        return path

    def plot_intraday_days(self, *, ts_code: str, name: str, end_date: str,
                           frame: pd.DataFrame, session_dates: Sequence[str],
                           save_path: str | Path) -> Path:
        """Plot five 15-minute intraday sessions with daily VWAP and dynamic MA5/10/20."""
        path = Path(save_path); path.parent.mkdir(parents=True, exist_ok=True)
        plt = _matplotlib(); _configure_font()
        fig, (ax, vol_ax) = plt.subplots(2, 1, figsize=(16, 8), sharex=True,
            gridspec_kw={"height_ratios": [3.2, 1], "hspace": 0.035})
        if frame.empty:
            ax.text(0.5, 0.5, "无可用15分钟分时数据", transform=ax.transAxes, ha="center", va="center")
            vol_ax.axis("off")
        else:
            df = frame.copy()
            df["date"] = pd.to_datetime(df["date"]).dt.normalize()
            df = df[df.date.isin(pd.to_datetime(list(session_dates)))].copy()
            df["time_idx"] = pd.to_numeric(df.get("time_idx", 0), errors="coerce").fillna(0).astype(int)
            daily_close = frame.groupby("date").apply(lambda x: float(x.sort_values("datetime").close.iloc[-1])).to_dict()
            slot = 19
            session_x = {}
            palette = ["#7f8c8d", "#5587a5", "#9575a8", "#6a9d75", "#e06b43"]
            for di, date_text in enumerate(session_dates):
                date = pd.Timestamp(date_text).normalize()
                day = df[df.date.eq(date)].sort_values("datetime").copy()
                if day.empty:
                    continue
                x = di * slot + day.time_idx.to_numpy()
                session_x[date] = x
                color = palette[di % len(palette)]
                ax.plot(x, day.close, color=color, lw=1.05, marker=".", ms=2.5,
                        label=f"{date:%m-%d} 分时")
                vol = day.vol.to_numpy(dtype=float)
                amount = pd.to_numeric(day.amount, errors="coerce").fillna(0).to_numpy(dtype=float)
                cumvol = np.cumsum(vol)
                vwap = np.divide(np.cumsum(amount), cumvol, out=np.full_like(cumvol, np.nan), where=cumvol != 0)
                ax.plot(x, vwap, color=color, lw=0.75, ls="--", alpha=0.85,
                        label="日内均价" if di == len(session_dates)-1 else None)
                vol_ax.bar(x, vol, width=0.72, color=color, alpha=0.56)
                # A dynamic N-day average combines the previous N-1 session closes with
                # the current session's moving 15-minute close.
                for n in (5, 10, 20):
                    previous_dates = sorted(pd.Timestamp(d).normalize() for d in daily_close
                                            if pd.Timestamp(d).normalize() < date)
                    prior_values = [daily_close[d] for d in previous_dates[-(n - 1):]
                                    if daily_close.get(d) is not None]
                    if len(prior_values) == n - 1:
                        dynamic = (sum(prior_values) + day.close.to_numpy(dtype=float)) / n
                        ax.plot(x, dynamic, color=MA_COLORS[n], lw=1.0,
                                label=f"动态MA{n}日" if di == len(session_dates)-1 else None,
                                alpha=0.92 if di == len(session_dates)-1 else 0.45)
                for n in VOLUME_MAS:
                    if len(vol) >= n:
                        vma = pd.Series(vol).rolling(n, min_periods=n).mean().to_numpy()
                        vol_ax.plot(x, vma, color=MA_COLORS[n], lw=0.8,
                                    label=f"量MA{n}" if di == len(session_dates)-1 else None)
            for di, date_text in enumerate(session_dates):
                left, right = di * slot - 0.25, di * slot + 15.25
                ax.axvline(left, color="#c7cfd5", lw=0.55, ls=":")
                ax.text((left + right) / 2, -0.13, str(date_text)[4:6] + "/" + str(date_text)[6:8],
                        transform=ax.get_xaxis_transform(), ha="center", va="top", fontsize=8)
            ax.set_xticks([di * slot + i for di in range(len(session_dates)) for i in (0, 4, 8, 12, 15)])
            ax.set_xticklabels([label for _ in session_dates for label in ("09:45", "10:45", "13:15", "14:15", "15:00")], fontsize=6.5)
            ax.legend(loc="upper left", ncol=7, fontsize=7.0, frameon=False, handlelength=1.3)
            vol_ax.legend(loc="upper left", ncol=3, fontsize=6.5, frameon=False, handlelength=1.2)
        ax.grid(axis="y", color="#d9dfe5", lw=0.45)
        ax.spines[["top", "right"]].set_visible(False); vol_ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(axis="y", labelsize=7); vol_ax.tick_params(axis="y", labelsize=6)
        vol_ax.set_ylabel("成交量", fontsize=8)
        fig.suptitle(f"{ts_code} {name}   最近5个交易日分时（15分钟数据）   截止 {end_date}",
                     x=0.5, y=0.995, fontsize=11)
        fig.subplots_adjust(left=0.055, right=0.99, top=0.92, bottom=0.10)
        fig.savefig(path, format="jpeg", dpi=100, pil_kwargs={"quality": 86, "optimize": True})
        plt.close(fig)
        return path
