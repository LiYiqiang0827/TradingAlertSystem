"""Read-only opening-auction observation pools for the dashboard."""
from __future__ import annotations

import datetime as dt
import json
import math
import sqlite3
import time
from contextlib import closing
from zoneinfo import ZoneInfo


class ConditionMonitor:
    def __init__(self, runtime):
        self.r = runtime
        self.zone = ZoneInfo('Asia/Shanghai')

    def _sessions(self, today):
        r = self.r
        with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=3)) as c:
            return [row[0] for row in c.execute(
                "SELECT cal_date FROM tbl_cn_tradecal WHERE exchange='SSE' AND is_open=1 AND cal_date<? ORDER BY cal_date DESC LIMIT 2",
                (today,))][::-1]

    def _candidates(self, dates):
        r = self.r
        out = {}
        if not dates:
            return out, '交易日历没有可用的前序交易日'
        marks = ','.join('?' for _ in dates)
        list_rows = []
        available_dates = set()
        with closing(sqlite3.connect(f'file:{r.KPL_DB}?mode=ro', uri=True, timeout=3)) as c:
            exists = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tbl_cn_kpl_list'").fetchone()
            if exists:
                list_rows = c.execute(
                    f"SELECT ts_code,name,trade_date,theme,status FROM tbl_cn_kpl_list WHERE tag='涨停' AND trade_date IN ({marks}) ORDER BY trade_date DESC",
                    dates).fetchall()
                available_dates.update(row[0] for row in c.execute(
                    f"SELECT DISTINCT trade_date FROM tbl_cn_kpl_list WHERE tag='涨停' AND trade_date IN ({marks})", dates))
            for code, name, day, theme, status in list_rows:
                row = out.setdefault(code, {'code': code, 'name': name or code, 'dates': [], 'themes': [], 'boards': []})
                row['name'] = name or row['name']
                if day not in row['dates']: row['dates'].append(day)
                if theme and theme.strip() and theme.strip() not in row['themes']: row['themes'].append(theme.strip())
                if status and status not in row['boards']: row['boards'].append(status)
            # If KPL list has no records for a date yet, use the exact-day limit list
            # before the KPL performance table.
            missing_dates = [d for d in dates if not any(row[2] == d for row in list_rows)]
            if missing_dates and c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tbl_cn_limit_list'").fetchone():
                m = ','.join('?' for _ in missing_dates)
                limit_rows = c.execute(
                    f'SELECT ts_code,name,trade_date FROM tbl_cn_limit_list WHERE trade_date IN ({m}) AND "limit"=\'U\'', missing_dates).fetchall()
                for code, name, day in limit_rows:
                    available_dates.add(day)
                    row = out.setdefault(code, {'code': code, 'name': name or code, 'dates': [], 'themes': [], 'boards': []})
                    row['name'] = name or row['name']
                    if day not in row['dates']: row['dates'].append(day)
                    row['boards'].append('涨停')
                missing_dates = [d for d in missing_dates if d not in available_dates]
            if missing_dates and c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tbl_cn_kpl_limit_performance'").fetchone():
                m = ','.join('?' for _ in missing_dates)
                for code, name, day, theme, board in c.execute(
                    f'SELECT ts_code,name,trade_date,theme,board_count FROM tbl_cn_kpl_limit_performance WHERE trade_date IN ({m}) ORDER BY trade_date DESC', missing_dates):
                    available_dates.add(day)
                    row = out.setdefault(code, {'code': code, 'name': name or code, 'dates': [], 'themes': [], 'boards': []})
                    row['name'] = name or row['name']
                    if day not in row['dates']: row['dates'].append(day)
                    if theme and theme.strip() and theme.strip() not in row['themes']: row['themes'].append(theme.strip())
                    if board: row['boards'].append(f'{board}板')
        missing = [day for day in dates if day not in available_dates]
        return out, (f"KPL 涨停数据尚未覆盖 {', '.join(missing)}" if missing else None)

    @staticmethod
    def _number(value):
        try:
            n = float(value)
            return n if math.isfinite(n) else None
        except (TypeError, ValueError):
            return None

    def data(self):
        import redis
        r = self.r
        status = r.live_market_status()
        today = status['date']
        dates = self._sessions(today)
        candidates, source_error = self._candidates(dates)
        # The exchange calendar query is the authority; do not infer a session from KPL freshness.
        try:
            with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=2)) as c:
                row = c.execute("SELECT is_open FROM tbl_cn_tradecal WHERE exchange='SSE' AND cal_date=?", (today,)).fetchone()
            current_session = bool(row and row[0] == 1)
        except sqlite3.Error:
            current_session = False
        redis_client = redis.Redis(host='127.0.0.1', port=6380, db=0, decode_responses=True,
                                   socket_connect_timeout=1, socket_timeout=3)
        redis_client.ping()
        codes = list(candidates)
        pipe = redis_client.pipeline(transaction=False)
        for code in codes:
            pipe.zrangebyscore(f'online:auction:window:{code}', '-inf', '+inf', withscores=True)
        raw_windows = pipe.execute() if codes else []
        prior_close = {}
        marks = ','.join('?' for _ in codes)
        # A limit-price record is not the previous close. Resolve the reference close from the
        # official daily bar and prefer auction pre_close only when it agrees with that bar.
        try:
            if not codes:
                raise sqlite3.OperationalError('no candidate codes')
            with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=2)) as c:
                for code, day, close in c.execute(f'SELECT ts_code,trade_date,close FROM tbl_cn_day WHERE ts_code IN ({marks}) AND trade_date=(SELECT MAX(d.trade_date) FROM tbl_cn_day d WHERE d.ts_code=tbl_cn_day.ts_code AND d.trade_date<?)', [*codes, today]):
                    prior_close[code] = self._number(close)
        except sqlite3.Error:
            pass
        samples = {}
        earliest = latest_stamp = None
        for code, entries in zip(codes, raw_windows):
            rows = []
            for raw, score in entries:
                try:
                    item = json.loads(raw)
                    stamp = self._number(item.get('auction_timestamp')) or self._number(score)
                    if stamp and stamp > 1e12: stamp /= 1000
                    if not stamp: continue
                    when = dt.datetime.fromtimestamp(stamp, self.zone)
                    if when.strftime('%Y%m%d') != today or not (9*60+15 <= when.hour*60+when.minute <= 9*60+27): continue
                    price = self._number(item.get('auction_price'))
                    if price is None: price = self._number(item.get('last_price') or item.get('match_price'))
                    ref = self._number(item.get('pre_close_price'))
                    official = self._number(prior_close.get(code))
                    # Accept the auction's reference when no daily bar is available, or when it
                    # agrees within 0.5%; otherwise avoid silently comparing incompatible prices.
                    if official and ref and abs(ref-official)/official <= .005: ref = official
                    elif official: ref = official
                    if price is None or ref is None or ref <= 0: continue
                    rows.append({'stamp': stamp, 'time': when.strftime('%H:%M:%S'), 'price': price, 'reference': ref,
                                 'stage': item.get('auction_request_stage') or '',
                                 'source': item.get('auction_timestamp_source') or ''})
                except (ValueError, TypeError, OverflowError, json.JSONDecodeError):
                    continue
            rows.sort(key=lambda row: row['stamp'])
            if rows:
                samples[code] = rows
                earliest = rows[0]['stamp'] if earliest is None else min(earliest, rows[0]['stamp'])
                latest_stamp = rows[-1]['stamp'] if latest_stamp is None else max(latest_stamp, rows[-1]['stamp'])
        matched = []
        evaluated = 0
        for code, rows in samples.items():
            early = [x for x in rows if 9*60+15 <= int(x['time'][:2])*60+int(x['time'][3:5]) <= 9*60+20]
            late = [x for x in rows if 9*60+23 <= int(x['time'][:2])*60+int(x['time'][3:5]) <= (9*60+27 if x['stage'] == 'final' else 9*60+25)]
            if not early or not late: continue
            evaluated += 1
            first = early[0]
            last = late[-1]
            if first['price'] < first['reference'] and last['price'] > last['reference']:
                item = candidates[code]
                matched.append({**item, 'earlyPrice': first['price'], 'earlyTime': first['time'],
                                'latePrice': last['price'], 'lateTime': last['time'],
                                'referencePrice': last['reference'],
                                'earlyPct': (first['price']/first['reference']-1)*100,
                                'latePct': (last['price']/last['reference']-1)*100,
                                'observations': len(rows)})
        phase = status['phase']
        now = dt.datetime.now(self.zone)
        minute = now.hour * 60 + now.minute
        covered = len(samples)
        hasEarly = any(9*60+15 <= int(x['time'][:2])*60+int(x['time'][3:5]) <= 9*60+20 for rows in samples.values() for x in rows)
        hasLate = any(9*60+23 <= int(x['time'][:2])*60+int(x['time'][3:5]) <= (9*60+27 if x['stage'] == 'final' else 9*60+25) for rows in samples.values() for x in rows)
        enough = hasEarly and hasLate
        rule_ready = enough and evaluated == len(candidates) and bool(candidates)
        if source_error:
            message = source_error
        elif not current_session:
            message = '当前不是交易日；竞价数据只展示当日，历史观察不回填为实时结果'
        elif minute < 9*60+15:
            message = '竞价尚未开始；09:15 后等待早段样本'
        elif phase == 'closed' and not samples:
            message = '竞价窗口已结束，当前 Redis 观察数据已过期或未采集'
        elif not candidates:
            message = '前两交易日涨停名单暂无数据'
        elif not hasEarly:
            message = '等待 09:15–09:20 的早段竞价样本'
        elif not hasLate:
            message = '早段样本已到，等待 09:23–09:25 尾段或 09:26 最终样本'
        elif evaluated < len(candidates):
            message = f'竞价样本覆盖不完整：{evaluated}/{len(candidates)} 只有完整早段与尾段样本，匹配结果暂供观察'
        else:
            message = '已核验全部候选：早段首个有效样本低于前收盘、尾段最新样本高于前收盘'
        return {'date': today, 'sessions': dates, 'status': status,
                'level0': list(candidates.values()), 'level1': matched,
                'candidateCount': len(candidates), 'coveredCount': covered,
                'evaluatedCount': evaluated, 'matchedCount': len(matched),
                'coverageComplete': covered == len(candidates), 'ruleReady': rule_ready,
                'message': message, 'sourceError': source_error,
                'updatedAt': dt.datetime.fromtimestamp(latest_stamp, self.zone).isoformat() if latest_stamp else None,
                'earlySampleAvailable': hasEarly, 'lateSampleAvailable': hasLate,
                'timestampSemantics': '采集端 auction_timestamp（接口响应组装时刻），仅作为观察采样时刻',
                'rows': matched}
