"""Read-only limit-up follow-through screens; no ladder attribution is rewritten."""
from collections import defaultdict
from contextlib import closing
import datetime as dt
import json
import math
import re
import sqlite3
import time

TOP = [('continuous', '连板'), ('fresh_break', '2板以上刚断板'),
       ('return5', '5日内再次涨停'), ('return10', '6–10日再次涨停'),
       ('return20', '11–20日再次涨停'), ('return30', '21–30日再次涨停')]
BOTTOM = [('ma5', '回调到5日线'), ('origin', '回调到涨停起涨位置'),
          ('ma10', '回调到10日线'), ('ma20', '回调到20日线'), ('ma30', '回调到30日线'), ('ma60', '回调到60日线')]


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):return None


class LimitupTracking:
    def __init__(self, runtime):self.r = runtime

    def data(self, requested):
        r = self.r
        with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=3)) as c:
            dates = [v[0] for v in c.execute("SELECT cal_date FROM tbl_cn_tradecal WHERE exchange='SSE' AND is_open=1 AND cal_date<=? ORDER BY cal_date DESC LIMIT 100", (requested,))][::-1]
        if not dates:raise ValueError('该日期之前暂无交易日')
        day = dates[-1]
        live = r.live_ladder_snapshot() if day == r.live_market_status()['date'] else {}
        live = live if live.get('available') and live.get('date') == day else {}
        revision = r.database_revision((r.BASIC_DB, r.KPL_DB, r.DBROOT/'offline/limitup_ladder.db'))
        signature = live.get('revision', '')
        return r.cached_series(f'limitup-tracking:v5:{day}:{revision}:{signature}',
                               lambda:self._calculate(day, dates, live, revision), 10 if live else 300)

    def _events(self, dates, live):
        r = self.r
        graph = r.DBROOT/'offline/limitup_ladder.db'
        events = defaultdict(list)
        ready = set()
        if graph.exists():
            with closing(sqlite3.connect(f'file:{graph}?mode=ro', uri=True, timeout=3)) as c:
                ready = {v[0] for v in c.execute('SELECT day FROM trade_dates WHERE ready=1 AND day>=? AND day<=?', (dates[-62], dates[-1]))}
                for day, code, theme, chain, payload in c.execute("SELECT day,code,original_theme,chain_id,payload FROM nodes WHERE kind='sealed' AND day>=? AND day<=? ORDER BY day", (dates[-62], dates[-1])):
                    event = json.loads(payload)
                    event.update(date=day, code=code, theme=theme, chainId=chain)
                    events[code].append(event)
        # Read only the missing daily slices, including the current online overlay.
        for day in dates[-31:]:
            if day in ready and not (live and day == live['date']):continue
            if day == dates[-1] and live:
                payload = r.limitup_ladder_data(day, 1, live)
            else:payload = r.limitup_ladder_data(day, 1)
            for code in events:events[code]=[e for e in events[code] if e['date']!=day]
            seen = set()
            for event in [*payload.get('sealedStocks', []), *payload.get('nodes', [])]:
                if event.get('date') != day or event.get('status') != 'sealed':continue
                code = event['code']
                if code in seen:continue
                seen.add(code)
                history = [e for e in events[code] if e['date'] < day]
                previous = history[-1] if history else None
                chain = previous.get('chainId') if previous and event.get('board', 1)>1 else event['id']
                events[code].append({**event, 'theme':event.get('originalTheme') or event.get('theme') or '暂无题材', 'chainId':chain})
                events[code].sort(key=lambda e:e['date'])
        return events

    def _daily(self, codes, dates, live):
        r = self.r
        rows = defaultdict(list)
        with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=4)) as c:
            for i in range(0, len(codes), 400):
                chunk = codes[i:i+400]
                marks = ','.join('?' for _ in chunk)
                for code, date, op, high, low, close, vol, previous, pct, factor in c.execute(
                    'SELECT d.ts_code,d.trade_date,d.open,d.high,d.low,d.close,d.vol,d.pre_close,d.pct_chg, f.adj_factor '
                    'FROM tbl_cn_day d LEFT JOIN tbl_cn_adj_factor f ON f.ts_code=d.ts_code AND f.trade_date=d.trade_date '
                    f'WHERE d.ts_code IN ({marks}) AND d.trade_date BETWEEN ? AND ? ORDER BY d.ts_code,d.trade_date',
                    [*chunk, dates[0], dates[-1]]):
                    values = [number(v) for v in (op, high, low, close, vol, previous, pct, factor)]
                    if any(v is None for v in values[:4]):continue
                    rows[code].append({'date':date, 'open':values[0], 'high':values[1], 'low':values[2], 'close':values[3],
                                       'volume':values[4] or 0, 'previous':values[5], 'pct':values[6], 'factor':values[7]})
        if live:
            with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
                today_factors=dict(c.execute('SELECT ts_code,adj_factor FROM tbl_cn_adj_factor WHERE trade_date=?',(dates[-1],)))
            # No per-stock network calls: reuse the already-collected current daily quote.
            for code in codes:
                quote = live.get('rows', {}).get(code, {})
                values = [number(quote.get(k)) for k in ('daily_open','daily_high','daily_low','daily_close')]
                if any(v is None or v<=0 for v in values):continue
                prior = rows[code][-1] if rows[code] else None
                bar = {'date':dates[-1], **dict(zip(('open','high','low','close'), values)),
                       'volume':(number(quote.get('volume')) or 0)/100, 'previous':number(quote.get('pre_close')) or (prior['close'] if prior and prior['date']<dates[-1] else None),
                       'pct':number(quote.get('pct_chg')), 'factor':number(today_factors.get(code)) or (prior.get('factor') if prior else 1.0)}
                rows[code] = [v for v in rows[code] if v['date']<dates[-1]] + [bar]
        for code, bars in rows.items():
            factor = 1.0
            for bar in bars:
                if bar['factor'] and bar['factor']>0:factor = bar['factor']
                bar['factor'] = factor
            base = factor
            for bar in bars:
                scale = bar['factor']/base
                for key in ('open','high','low','close','previous'):
                    if bar[key] is not None:bar[key] *= scale
                bar['volume'] /= scale
        return rows

    def _calculate(self, day, dates, live, revision):
        began = time.perf_counter()
        events = self._events(dates, live) if len(dates)>=62 else self._short_events(dates, live)
        index = {date:i for i,date in enumerate(dates)}
        recent_start = dates[max(0,len(dates)-30)]
        codes = sorted(code for code, history in events.items() if history and history[-1]['date']>=recent_start)
        daily = self._daily(codes, dates, live)
        groups = {key:[] for key,_ in [*TOP,*BOTTOM]}
        stocks = {}
        previous_day = dates[-2] if len(dates)>1 else None
        with closing(sqlite3.connect(f'file:{self.r.BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
            halted = {row[0] for row in c.execute("SELECT ts_code FROM tbl_cn_suspend WHERE trade_date=? AND suspend_type='S' AND coalesce(suspend_timing,'')=''",(day,))}
        missing = []
        for code in codes:
            history = events[code]
            event = history[-1]
            bars = daily.get(code, [])
            current = bars[-1] if bars and bars[-1]['date']==day else None
            sealed = event['date']==day
            board = int(event.get('board') or 1)
            # Ladder continuation chains can span separate runs. Board count,
            # including an N-days/M-boards pattern, defines this run's first seal.
            chain = history[-board:]
            start = chain[0]
            pattern = re.fullmatch(r'(\d+)天(\d+)板',str(event.get('boardPeriod') or ''))
            origin_day = dates[max(0,index[event['date']]-int(pattern[1])+1)] if pattern else start['date']
            current_run = int(event.get('consecutiveBoard') or board)
            member = {'code':code, 'name':event.get('name') or code, 'theme':event.get('theme') or '暂无题材',
                      'board':board, 'boardPeriod':event.get('boardPeriod') or str(board)+'板', 'currentBoard':sealed,
                      'limitDate':event['date'], 'pct':current.get('pct') if current else None, 'sortHeight':board,
                      'daily':[[bar[k] for k in ('open','high','low','close','volume')] for bar in bars[-20:]],
                      'quoteDate':bars[-1]['date'] if bars else None, 'signals':{}, 'originDate':origin_day}
            stocks[code] = member
            if event['date'] in (day, previous_day):
                if sealed and current_run>=2:groups['continuous'].append(code)
                if not sealed and code not in halted and event['date']==previous_day and board>=2:groups['fresh_break'].append(code)
                # A return event can itself be a multi-day/multi-board pattern.
                # Consecutive sessions belong to continuous, never to relimit buckets.
                before = history[-2] if len(history)>1 else None
                if before and index.get(event['date'],0)-index.get(before['date'],0)>1 and current_run<=1:
                    gap = index[event['date']]-index[before['date']]-1
                    key = 'return5' if gap<=5 else 'return10' if gap<=10 else 'return20' if gap<=20 else 'return30' if gap<=30 else None
                    if key:
                        groups[key].append(code)
                        member.update(returnGap=gap, priorBoard=int(before.get('board') or 1), priorBoardPeriod=before.get('boardPeriod'), priorTheme=before.get('theme'), priorLimitDate=before['date'])
            if sealed or code in halted:continue
            if not current:
                missing.append(code)
                continue
            # Use the exchange's current daily range, never a carried-forward close.
            for period in (5,10,20,30,60):
                if len(bars)<period:continue
                target = sum(b['close'] for b in bars[-period:])/period
                member['signals']['ma'+str(period)] = target
                if current['low']<=target<=current['high']:groups['ma'+str(period)].append(code)
            first = next((b for b in bars if b['date']==origin_day), None)
            target = (first['close'] if len(chain)>1 or board>=2 else first['previous']) if first else None
            member['signals']['origin'] = target
            if target is not None and current['low']<=target<=current['high']:groups['origin'].append(code)
        used = set(code for values in groups.values() for code in values)
        for key, values in groups.items():
            values.sort(key=lambda code:(-(stocks[code].get('priorBoard',stocks[code]['board']) if key.startswith('return') else stocks[code]['board']), -int(stocks[code]['limitDate']), stocks[code]['name']))
        return {'date':day, 'previousDate':previous_day, 'lookback':30, 'startDate':recent_start,
                'top':[{'key':key,'title':title,'codes':groups[key]} for key,title in TOP],
                'bottom':[{'key':key,'title':title,'codes':groups[key]} for key,title in BOTTOM],
                'stocks':{code:stocks[code] for code in used}, 'screenedCount':len(codes), 'missingDailyCount':len(missing),
                'source':'online+offline' if live else 'offline', 'updatedAt':live.get('updatedAt'),
                'dataVersion':revision, **self.r.stock_data_version(), 'calculationMs':round((time.perf_counter()-began)*1000,1),
                'rules':{'touch':'low <= target <= high', 'relimitGap':'intervening exchange sessions, buckets 1-5/6-10/11-20/21-30', 'origin':'multi-board first limit close; single-board preceding close'}}

    def _short_events(self, dates, live):
        payload = self.r.limitup_ladder_data(dates[-1], min(62,len(dates)), live or None)
        result = defaultdict(list)
        seen = set()
        for event in [*payload.get('sealedStocks',[]),*payload.get('nodes',[])]:
            if event.get('status')!='sealed' or event.get('id') in seen:continue
            seen.add(event['id']);result[event['code']].append(event)
        for values in result.values():values.sort(key=lambda e:e['date'])
        return result
