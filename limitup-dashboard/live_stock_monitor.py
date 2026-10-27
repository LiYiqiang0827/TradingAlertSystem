"""Paged watchlist/recent-limit-up monitor; market data remains read-only."""
from __future__ import annotations

from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import json
import math
import re
import sqlite3
import time
import threading
from collections import OrderedDict
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Asia/Shanghai')
CODE = re.compile(r'\d{6}\.(SH|SZ|BJ)')


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


class LiveStockMonitor:
    def __init__(self, runtime):
        self.r = runtime
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix='monitor-mini')
        self.series_lock = threading.RLock()
        self.series_keys = None
        self.series_index_at = 0

    def _remember_series(self, key, record, write=True):
        """Bound the persistent last-good snapshot cache, including across restarts."""
        r = self.r
        with self.series_lock:
            now = time.time()
            if self.series_keys is None:
                self.series_keys = OrderedDict(r.CACHE.get('live-monitor-series-index:v1') or [])
            new = key not in self.series_keys
            self.series_keys.pop(key, None)
            self.series_keys[key] = now
            if write:r.CACHE.set(key, record, 7*86400)
            while len(self.series_keys)>120:
                old, _ = self.series_keys.popitem(last=False)
                r.CACHE.delete(old)
                new = True
            if new or now-self.series_index_at>30:
                r.CACHE.set('live-monitor-series-index:v1', list(self.series_keys.items()), 7*86400)
                self.series_index_at = now

    def codes(self, value, maximum=30):
        codes = list(dict.fromkeys(value.split(',')))
        if not 1 <= len(codes) <= maximum or any(not CODE.fullmatch(c) for c in codes):
            raise ValueError(f'每批需要1至{maximum}只有效股票')
        return codes

    def _history(self, day, sessions):
        r = self.r
        version = r.database_revision((r.BASIC_DB, r.KPL_DB, r.DBROOT/'offline/limitup_ladder.db'))
        def load():
            with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=3)) as c:
                dates = [row[0] for row in c.execute("SELECT cal_date FROM tbl_cn_tradecal WHERE exchange='SSE' AND is_open=1 AND cal_date<=? ORDER BY cal_date DESC LIMIT ?", (day, sessions))][::-1]
                names = dict(c.execute('SELECT ts_code,name FROM tbl_cn_basic'))
            if not dates:
                raise RuntimeError('交易日历暂无监测日期')
            recent, themes = {}, {}
            graph = r.DBROOT/'offline/limitup_ladder.db'
            ready = set()
            if graph.exists():
                with closing(sqlite3.connect(f'file:{graph}?mode=ro', uri=True, timeout=3)) as c:
                    ready = {v[0] for v in c.execute('SELECT day FROM trade_dates WHERE ready=1 AND day BETWEEN ? AND ?', (dates[0], dates[-1]))}
                    for code, last, theme in c.execute("SELECT code,MAX(day),original_theme FROM nodes WHERE kind='sealed' AND day BETWEEN ? AND ? GROUP BY code", (dates[0], dates[-1])):
                        recent[code] = last
                        if theme:themes[code] = theme
            with closing(sqlite3.connect(f'file:{r.KPL_DB}?mode=ro',uri=True,timeout=3)) as c:
                if c.execute("SELECT 1 FROM sqlite_master WHERE name='tbl_cn_kpl_limit_performance'").fetchone():
                    for code, theme in c.execute('SELECT ts_code,theme FROM tbl_cn_kpl_limit_performance WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date',(dates[0],dates[-1])):
                        if theme and str(theme).strip():themes[code] = str(theme).strip()
            # KPL can publish before the read-optimized ladder has finished updating.
            missing = [d for d in dates if d not in ready]
            if missing:
                with closing(sqlite3.connect(f'file:{r.KPL_DB}?mode=ro', uri=True, timeout=3)) as c:
                    marks = ','.join('?' for _ in missing)
                    for table, condition in [('tbl_cn_kpl_list', "tag='涨停'"), ('tbl_cn_limit_list', '"limit"=\'U\'')]:
                        if not c.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone():
                            continue
                        for code, last in c.execute(f'SELECT ts_code,MAX(trade_date) FROM {table} WHERE trade_date IN ({marks}) AND {condition} GROUP BY ts_code', missing):
                            recent[code] = max(last, recent.get(code, ''))
            return {'dates': dates, 'recent': recent, 'names': names, 'themes':themes}
        return r.cached_series(f'live-monitor-history:v2:{day}:{sessions}:{version}', load, 300)

    def roster(self, sessions=20):
        if not 1 <= sessions <= 60:
            raise ValueError('最近涨停范围支持1至60个交易日')
        r = self.r
        status = r.live_market_status()
        history = self._history(status['date'], sessions)
        watch = r.watchlists_store().snapshot()
        recent = dict(history['recent'])
        names = dict(history['names'])
        themes = dict(history['themes'])
        live = r.live_ladder_snapshot()
        if live.get('available') and live['date'] == history['dates'][-1]:
            # A stock that opened its limit-up board has still hit limit-up today.
            for code, item in {**live.get('pool', {}), **live.get('failed', {})}.items():
                recent[code] = live['date']
                names[code] = item.get('name') or names.get(code, code)
                if item.get('theme') and item['theme'] != '暂无题材':themes[code] = item['theme']
        rows = []
        for code in set(recent) | {c for c, item in watch['stocks'].items() if item['groupIds']}:
            member = watch['stocks'].get(code, {})
            selected = bool(member.get('groupIds'))
            joined = max((v for v in member.get('groupAddedAt', {}).values() if v is not None), default=0)
            rows.append({'code': code, 'name': member.get('name') or names.get(code, code),
                         'sources': (['自选'] if selected else []) + (['涨停'] if code in recent else []),
                         'lastLimitDate': recent.get(code), 'joinedAt': joined, 'theme':themes.get(code) or None})
        rows.sort(key=lambda row: ('自选' not in row['sources'], -row['joinedAt'], -int(row['lastLimitDate'] or 0), row['code']))
        identity = json.dumps([history['dates'], rows], ensure_ascii=False, sort_keys=True)
        roster_id = hashlib.sha256(identity.encode()).hexdigest()[:24]
        payload = {'rosterId': roster_id, 'date': history['dates'][-1], 'status': status,
                   'startDate': history['dates'][0], 'sessions': len(history['dates']), 'items': rows}
        r.CACHE.set('live-monitor-roster:v1:'+roster_id, payload, 1800)
        return payload

    def _quotes(self, codes, day, hydrate=False):
        import redis
        client = redis.Redis(port=6380, decode_responses=True, socket_connect_timeout=.5, socket_timeout=2)
        pipe = client.pipeline(transaction=False)
        for kind in ('snapshot', 'limitperformance'):
            pipe.zrevrange('online:'+kind+':timeline', 0, 0, withscores=True)
        latest = pipe.execute()
        result = {code: {} for code in codes}
        if day == dt.datetime.now(ZONE).strftime('%Y%m%d'):
            # Only requested pages subscribe; expiry drops inactive browser demand.
            key = 'online:dashboard:snapshot-demand:'+day
            client.zadd(key, {code:time.time()+180 for code in codes})
            client.expire(key, 12*3600)
        for kind, records in zip(('snapshot', 'limitperformance'), latest):
            at = self.r.online_stamp(records[0][1]) if records else None
            same_day = at and dt.datetime.fromtimestamp(at, ZONE).strftime('%Y%m%d') == day
            key = records[0][0] if same_day else None
            if key and client.exists(key):
                values = client.hmget(key, codes)
                rows = {code: json.loads(raw) for code, raw in zip(codes, values) if raw}
            else:
                rows, at, _ = self.r.read_online_close(kind, day, client)
            for code in codes:
                row = rows.get(code)
                if not row:
                    continue
                stamp = self.r.online_stamp(row.get('snapshot_timestamp', row.get('limitperformance_timestamp'))) or at
                if not stamp or dt.datetime.fromtimestamp(stamp, ZONE).strftime('%Y%m%d') != day:
                    continue
                result[code][kind] = (row, stamp)
        missing = [code for code in codes if 'snapshot' not in result[code]]
        if missing:
            values = client.mget(['online:dashboard:quote:'+day+':'+code for code in missing])
            for code, raw in zip(missing, values):
                if raw:
                    row = json.loads(raw)
                    result[code]['snapshot'] = (row, self.r.online_stamp(row.get('snapshot_timestamp')))
            missing = [code for code in missing if 'snapshot' not in result[code]]
        # A newly subscribed stock can lack tick archives until the next collector round.
        # Visible chart loads publish native minute facts without issuing another quote request.
        if missing:
            native = client.mget(['online:dashboard:minute-quote:'+day+':'+code for code in missing])
            for code, raw in zip(missing, native):
                if raw:
                    row = json.loads(raw)
                    result[code]['snapshot'] = (row, row['snapshot_timestamp'])
        return result

    def facts(self, codes, day, hydrate=False):
        r = self.r
        version = r.database_revision((r.BASIC_DB,))
        def basics():
            marks = ','.join('?' for _ in codes)
            with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro', uri=True, timeout=3)) as c:
                c.row_factory = sqlite3.Row
                prior = c.execute('SELECT MAX(trade_date) FROM tbl_cn_day WHERE trade_date<?', (day,)).fetchone()[0]
                return {d: {row['ts_code']: dict(row) for row in c.execute(f'SELECT ts_code,trade_date,turnover_rate_f,free_share FROM tbl_cn_daily_basic WHERE trade_date=? AND ts_code IN ({marks})', [d, *codes])} for d in (day, prior) if d}
        basic = r.cached_series(f'live-monitor-basics:v1:{day}:{version}:'+','.join(sorted(codes)), basics, 300)
        prior_day = max((d for d in basic if d < day), default='')
        try:
            quotes = self._quotes(codes, day, hydrate)
            error = None
        except Exception as exc:
            quotes = {}
            error = type(exc).__name__
        items = []
        phase = r.live_market_status()['phase']
        for code in codes:
            observed = quotes.get(code, {})
            q, q_at = observed.get('snapshot', ({}, 0))
            lp, lp_at = observed.get('limitperformance', ({}, 0))
            options = [(q_at, q.get('last_price'), q.get('price_change_ratio_pct')), (lp_at, lp.get('close_price'), lp.get('pct_chg'))]
            options = [v for v in options if v[0] and number(v[1]) is not None]
            at, price, pct = max(options, key=lambda v: v[0]) if options else (None, None, None)
            today = basic.get(day, {}).get(code, {})
            previous = basic.get(prior_day, {}).get(code, {})
            shares = number(today.get('free_share')) or number(previous.get('free_share'))
            shares = shares * 10000 if shares else None
            volume = number(q.get('volume'))
            turnover = volume / shares * 100 if shares and volume is not None else number(lp.get('turnover_rate'))
            official = number(today.get('turnover_rate_f'))
            estimated = official is None and shares is not None and volume is not None
            if official is not None:
                turnover = official
            current_day = dt.datetime.now(ZONE).strftime('%Y%m%d') == day
            stale = bool(at and current_day and phase == 'trading' and time.time()-at > 120)
            items.append({'code': code, 'date': day, 'price': number(price), 'pct': number(pct), 'volume': volume,
                          'prevClose': number(q.get('prev_price')), 'freeShares': shares,
                          'turnover': turnover, 'turnoverEstimated': estimated,
                          'turnoverBasisDate': day if today else prior_day or None,
                          'quoteAt': at, 'quoteSource':q.get('quote_source','redis_snapshot'), 'stale': stale, 'quoteError': error})
        return items

    def page(self, offset=0, limit=30, sessions=20, roster_id=''):
        if offset < 0 or not 1 <= limit <= 30:
            raise ValueError('每页最多30只股票')
        if roster_id and not re.fullmatch(r'[0-9a-f]{24}', roster_id):
            raise ValueError('监测列表版本无效')
        payload = self.r.CACHE.get('live-monitor-roster:v1:'+roster_id) if roster_id else None
        if payload is None:
            payload = self.roster(sessions)
            if roster_id and roster_id != payload['rosterId']:
                return {'resetRequired': True, 'rosterId': payload['rosterId']}
        page = payload['items'][offset:offset+limit]
        facts = {item['code']: item for item in self.facts([v['code'] for v in page], payload['date'])} if page else {}
        return {**{k: v for k, v in payload.items() if k != 'items'}, 'total': len(payload['items']),
                'offset': offset, 'nextOffset': offset+len(page), 'hasMore': offset+len(page)<len(payload['items']),
                'chartBasisVersion':self.r.database_revision((self.r.BASIC_DB,)),
                'items': [{**item, **facts.get(item['code'], {})} for item in page]}

    def _chart(self, code, day, period='all'):
        r = self.r
        basis_version = r.database_revision((r.BASIC_DB,))
        version = basis_version if period=='oneMin' else r.stock_data_version()['stockDataVersion']
        today = dt.datetime.now(ZONE).strftime('%Y%m%d')
        one_only = period == 'oneMin'
        record_key = f'live-monitor-series:v3:{period}:{code}:{day}'
        source_token = None
        if one_only:
            import redis
            client=redis.Redis(port=6380,decode_responses=True,socket_connect_timeout=.5,socket_timeout=2)
            pipe=client.pipeline(transaction=False)
            pipe.zrange('online:snapshot:window:'+code,0,0,withscores=True)
            pipe.zrevrange('online:snapshot:window:'+code,0,0,withscores=True)
            head,tail=pipe.execute()
            opening=dt.datetime.strptime(day+'093200','%Y%m%d%H%M%S').replace(tzinfo=ZONE).timestamp()
            needs_native=day==today and (not head or head[0][1]>opening)
            now=dt.datetime.now(ZONE);phase=r.live_market_status()['phase']
            native_epoch=int(time.time()/60) if needs_native and (phase=='trading' or phase=='closed' and now.strftime('%H%M')<'1505') else 0
            source_token=[basis_version,head[0][1] if head else None,tail[0][1] if tail else None,native_epoch,phase]
            cached=r.CACHE.get(record_key)
            if cached and cached.get('token')==source_token:
                self._remember_series(record_key,cached,write=False)
                return {**cached['payload'],'cacheSource':'redis' if r.CACHE.redis else 'sqlite'}
        def historical():
            if one_only:
                # Same-day minute thumbnails only need the raw previous close.
                # Do not load adjusted daily history or 15-minute data for hidden charts.
                with closing(sqlite3.connect(f'file:{r.BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
                    row=c.execute('SELECT trade_date,open,high,low,close,vol FROM tbl_cn_day WHERE ts_code=? AND trade_date<? ORDER BY trade_date DESC LIMIT 1',(code,day)).fetchone()
                daily=[]
                if row:
                    daily=[{'timestamp':int(dt.datetime.strptime(row[0],'%Y%m%d').replace(tzinfo=dt.timezone.utc).timestamp()*1000),**dict(zip(('open','high','low','close','volume'),row[1:]))}]
                return {'daily':daily,'fifteenMin':[],'errors':{}}
            basis = r.stock_series_latest(code, today)
            daily = [bar for bar in basis['daily'] if dt.datetime.fromtimestamp(bar['timestamp']/1000, dt.timezone.utc).strftime('%Y%m%d') <= day][-20:]
            start = (dt.datetime.strptime(day, '%Y%m%d')-dt.timedelta(days=12)).strftime('%Y%m%d')
            errors = {}
            try:
                frame = r.filter_after_close(r.get_fifteenMin(ts_code=code, start_date=start, end_date=day)).copy()
                if not frame.empty:
                    frame['datetime'] = frame['datetime'].astype(str).str[:19]+'+08:00'
                fifteen = r.adjusted_stock_intraday_bars(r.compact(frame, 'datetime'), basis)[-80:]
            except Exception as exc:
                fifteen = []
                errors['fifteenMin'] = type(exc).__name__
            return {'daily': daily, 'fifteenMin': fifteen, 'errors': errors}
        history = r.cached_series(f'live-monitor-history-chart:v2:{period}:{code}:{day}:{version}', historical, 300)
        def load():
            import redis
            client = redis.Redis(port=6380, decode_responses=True, socket_connect_timeout=.5, socket_timeout=2)
            start = dt.datetime.strptime(day, '%Y%m%d').replace(tzinfo=ZONE).timestamp()
            ticks = client.zrangebyscore('online:snapshot:window:'+code, start, start+86400-1, withscores=True)
            live = r.fit_live_index_ticks(ticks, day, dt.datetime.now(ZONE))
            one = live['oneMin']
            native = []
            errors = dict(history['errors'])
            # Newly requested stocks have no morning ticks. Fill the real 1-minute
            # history once, then let Redis ticks maintain the latest minute.
            if day == today and (not ticks or ticks[0][1] > start+9.5*3600+120):
                def native_history():
                    rows, _ = r.native_stock_minutes(code, day, True, False)
                    result = []
                    for row in rows:
                        when = dt.datetime.fromisoformat(str(row['datetime'])).replace(tzinfo=ZONE)
                        if when.strftime('%Y%m%d') != day or when.strftime('%H:%M') > '15:00':
                            continue
                        bar = {'timestamp':int(when.timestamp()*1000)-60000,
                               **{k:float(row[k]) for k in ('open','high','low','close')},
                               'volume':float(row.get('vol') or 0)}
                        if r.valid_live_ohlc(bar):result.append(bar)
                    return sorted(result,key=lambda b:b['timestamp'])
                try:
                    native = r.cached_series(f'live-monitor-native:v1:{code}:{day}', native_history, 60)
                except Exception as exc:
                    errors['oneMin'] = type(exc).__name__
                if native:
                    boundary = native[-1]['timestamp'];native_volume = sum(b['volume'] for b in native)
                    extra = [dict(b) for b in one if b['timestamp'] > boundary]
                    if extra and ticks and ticks[0][1] > start+9.5*3600+120:
                        extra[0]['volume'] = max(0,extra[0]['volume']-native_volume)
                    one = native+extra
                    if not live['today']:
                        observations = self._quotes([code], day, True).get(code, {}).get('snapshot')
                        q = observations[0] if observations else {}
                        last = native[-1]
                        previous = number(q.get('prev_price'))
                        live['quote'] = {'prevClose':previous,'time':dt.datetime.fromtimestamp(observations[1],ZONE).isoformat() if observations else None}
                        live['today'] = {'timestamp':int(dt.datetime.strptime(day,'%Y%m%d').replace(tzinfo=dt.timezone.utc).timestamp()*1000),
                                         'open':number(q.get('open_price')) or native[0]['open'],
                                         'high':number(q.get('high_price')) or max(b['high'] for b in native),
                                         'low':number(q.get('low_price')) or min(b['low'] for b in native),
                                         'close':number(q.get('last_price')) or last['close'],
                                         'volume':number(q.get('volume')) or native_volume,'turnover':number(q.get('turnover')) or 0}
            daily = list(history['daily'])
            fifteen = list(history['fifteenMin'])
            if live['today']:
                stamp = live['today']['timestamp']
                prior = [v for v in daily if v['timestamp'] < stamp]
                reference = live.get('quote', {}).get('prevClose')
                ratio = reference/prior[-1]['close'] if reference and prior and prior[-1]['close'] else 1
                def rebase(values):
                    return [{**v, **{k:v[k]*ratio for k in ('open','high','low','close')}, 'volume':v.get('volume',0)/ratio} for v in values]
                daily = rebase(prior)+[{**live['today'], 'volume': live['today']['volume']/100, 'amount': live['today']['turnover']/1000}]
                midnight = int(start*1000)
                # Stock volume stays in source shares; index aggregation otherwise prefers turnover.
                if not one_only:
                    stock_one = [{k:v for k,v in bar.items() if k != 'turnover'} for bar in one]
                    fifteen = rebase([v for v in fifteen if v['timestamp'] < midnight])+r.aggregate_live_bars(stock_one, 'fifteenMin')
            previous = live.get('quote', {}).get('prevClose') if live.get('quote') else None
            if not one and day < today:
                # Frozen historical sessions use real one-minute bars, never 15-minute substitution.
                frame = r.filter_after_close(r.get_oneMin(ts_code=code, start_date=day, end_date=day))
                if not frame.empty:
                    frame = frame.copy(); frame['datetime'] = frame['datetime'].astype(str).str[:19]+'+08:00'
                one = r.compact(frame, 'datetime')
            if not previous and len(daily) > 1:
                previous = daily[-2]['close']
            minute_quote = None
            if one and previous:
                last = one[-1]
                minute_quote = {'last_price':last['close'],'prev_price':previous,
                                'price_change_ratio_pct':(last['close']/previous-1)*100,
                                'volume':sum(v.get('volume',0) for v in one),
                                'snapshot_timestamp':last['timestamp']/1000+(60 if native else 0),
                                'quote_source':'native_1min' if native else 'redis_tick_1min'}
                client.setex('online:dashboard:minute-quote:'+day+':'+code,1800,json.dumps(minute_quote))
            limit = 30 if code.endswith('.BJ') else 20 if code.startswith(('300', '301', '688', '689')) else 10
            return {'code': code, 'date': day, 'oneMin': one, 'fifteenMin': fifteen[-80:], 'daily': daily[-20:],
                    'prevClose': previous, 'limit': limit, 'errors': errors, 'quote':minute_quote,
                    'sources': {'oneMin': 'tdx_native_1min+redis_tick' if native else 'redis_tick_1min' if ticks else 'offline_native_1min' if one else 'unavailable',
                                'fifteenMin': 'offline_qfq+live_1min_aggregated_15min' if live['today'] else 'offline_qfq', 'daily': 'offline_qfq+live_tick' if live['today'] else 'offline_qfq'},
                    'updatedAt': live.get('quote', {}).get('time') if live.get('quote') else None}
        if one_only:
            with r._cache_load_locks.hold(record_key):
                cached=r.CACHE.get(record_key)
                if cached and cached.get('token')==source_token:
                    self._remember_series(record_key,cached,write=False)
                    return {**cached['payload'],'cacheSource':'redis' if r.CACHE.redis else 'sqlite'}
                payload={key:value for key,value in load().items() if key not in ('fifteenMin','daily')}
                payload.update(basisVersion=basis_version,cacheSchema=2)
                if payload['errors'].get('oneMin') and cached and cached.get('payload',{}).get('basisVersion')==basis_version:
                    return {**cached['payload'],'cacheSource':'last-good','refreshError':payload['errors']['oneMin']}
                if payload['oneMin'] and not payload['errors'].get('oneMin'):
                    self._remember_series(record_key,{'token':source_token,'payload':payload})
                return {**payload,'cacheSource':'source-load'}
        return r.cached_series(f'live-monitor-chart:v2:{period}:{code}:{day}:{version}', load, 5 if day == today else 300)

    def charts(self, codes, day, period='all'):
        if period not in ('all','oneMin'):
            raise ValueError('监测缩略图周期无效')
        futures = {code: self.pool.submit(self._chart, code, day, period) for code in codes}
        items, errors = {}, {}
        for code, future in futures.items():
            try:
                items[code] = future.result()
            except Exception as exc:
                errors[code] = str(exc)
        return {'date': day, 'items': items, 'errors': errors}
