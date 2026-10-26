"""Bounded stock chart windows backed by the offline forward-adjusted period tables."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import calendar
import datetime as dt
import sqlite3

import pandas as pd

# Separate from chart request workers: a request must never wait on children in
# the same saturated executor. Each SQLite task opens its own read-only connection.
_SQL_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix='stock-sql')


def _connect(path):
    return sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True, timeout=5)


def latest_anchor(path, code, cutoff):
    with closing(_connect(path)) as conn:
        day=conn.execute('SELECT trade_date FROM tbl_cn_day WHERE ts_code=? AND trade_date<=? ORDER BY trade_date DESC LIMIT 1',(code,cutoff)).fetchone()
        if not day:return None,1.0
        factor=conn.execute('SELECT adj_factor FROM tbl_cn_adj_factor WHERE ts_code=? AND trade_date<=? AND adj_factor>0 ORDER BY trade_date DESC LIMIT 1',(code,day[0])).fetchone()
    return str(day[0]),float(factor[0]) if factor else 1.0


def _ranges(last_day, review_month, years):
    last=dt.datetime.strptime(last_day,'%Y%m%d').date()
    anchor=min(dt.datetime.strptime(review_month+'01','%Y%m%d').date(),last).replace(day=1)
    latest=last.replace(day=1)
    ranges=[]
    for start in sorted({anchor,latest}):
        lo=(start-dt.timedelta(days=years*366)).strftime('%Y%m%d')
        end=min(last,start.replace(day=calendar.monthrange(start.year,start.month)[1]))
        hi=end.strftime('%Y%m%d')
        if ranges and lo<=ranges[-1][1]:ranges[-1]=(ranges[-1][0],max(hi,ranges[-1][1]))
        else:ranges.append((lo,hi))
    return ranges


def _where(ranges, prefix=''):
    return '('+' OR '.join(prefix+'trade_date BETWEEN ? AND ?' for _ in ranges)+')',[day for pair in ranges for day in pair]


def _daily(path,code,ranges):
    where,params=_where(ranges,'d.')
    with closing(_connect(path)) as conn:
        return pd.read_sql_query(
            'SELECT d.trade_date,d.open,d.high,d.low,d.close,d.vol,d.amount,d.pre_close,d.pct_chg,'
            'b.turnover_rate_f,b.free_share*b.close*10000 AS free_float_market_cap '
            'FROM tbl_cn_day d LEFT JOIN tbl_cn_daily_basic b ON b.ts_code=d.ts_code AND b.trade_date=d.trade_date '
            'WHERE d.ts_code=? AND '+where+' ORDER BY d.trade_date',conn,params=[code,*params])


def _factors(path,code,ranges):
    where,params=_where(ranges)
    # Seed each disjoint window with the immediately preceding factor, then fill
    # forward locally. No full-history factor query is needed for minute charts.
    with closing(_connect(path)) as conn:
        frame=pd.read_sql_query('SELECT trade_date,adj_factor FROM tbl_cn_adj_factor WHERE ts_code=? AND '+where+' ORDER BY trade_date',conn,params=[code,*params])
        seeds=[]
        for start,_ in ranges:
            row=conn.execute('SELECT trade_date,adj_factor FROM tbl_cn_adj_factor WHERE ts_code=? AND trade_date<? AND adj_factor>0 ORDER BY trade_date DESC LIMIT 1',(code,start)).fetchone()
            if row:seeds.append(row)
    if seeds:frame=pd.concat([pd.DataFrame(seeds,columns=['trade_date','adj_factor']),frame],ignore_index=True)
    return frame.drop_duplicates('trade_date').sort_values('trade_date').reset_index(drop=True)


def _periods(path,code,table,ranges,base):
    assert table in ('tbl_cn_week','tbl_cn_month')
    where,params=_where(ranges)
    with closing(_connect(path)) as conn:
        frame=pd.read_sql_query('SELECT trade_date,open,high,low,close,vol,amount FROM '+table+' WHERE ts_code=? AND '+where+' ORDER BY trade_date',conn,params=[code,*params])
        scale=1.0
        if not frame.empty:
            last=frame.iloc[-1]
            ref=conn.execute('SELECT d.close,(SELECT f.adj_factor FROM tbl_cn_adj_factor f WHERE f.ts_code=d.ts_code AND f.trade_date<=d.trade_date AND f.adj_factor>0 ORDER BY f.trade_date DESC LIMIT 1) FROM tbl_cn_day d WHERE d.ts_code=? AND d.trade_date=?',(code,str(last['trade_date']))).fetchone()
            if ref and ref[0] and last['close']:
                scale=float(ref[0])*float(ref[1] or 1.0)/base/float(last['close'])
    if abs(scale-1)>1e-10:
        for field in ('open','high','low','close'):frame[field]=frame[field]*scale
        frame['vol']=frame['vol']/scale
    return frame,scale


def _date(bar):return dt.datetime.fromtimestamp(bar['timestamp']/1000,dt.timezone.utc).date()
def _bucket(day,kind):return day-dt.timedelta(days=day.weekday()) if kind=='weekly' else day.replace(day=1)


def _summary(bars):
    return {'timestamp':bars[-1]['timestamp'],'open':bars[0]['open'],
            'high':max(bar['high'] for bar in bars),'low':min(bar['low'] for bar in bars),
            'close':bars[-1]['close'],'volume':sum(bar.get('volume',0) for bar in bars),
            'amount':sum(bar.get('amount',0) for bar in bars)}


def _repair_periods(periods,daily,ranges,kind,factor_changes=()):
    """Keep stored periods. Only repair stale tails or detected price-basis changes.

    Periods crossing the start of a bounded daily window are never reconstructed
    from incomplete daily data. Review-date partial weeks/months are cut by the
    caller using this same latest adjusted daily window.
    """
    by_day={_date(bar):bar for bar in daily}
    existing={_bucket(_date(bar),kind):bar for bar in periods}
    groups={}
    for bar in daily:groups.setdefault(_bucket(_date(bar),kind),[]).append(bar)
    coverage=[(dt.datetime.strptime(lo,'%Y%m%d').date(),dt.datetime.strptime(hi,'%Y%m%d').date()) for lo,hi in ranges]
    changed_periods={_bucket(day,kind) for day in factor_changes}
    repaired=0
    for key,bars in groups.items():
        if not any(lo<=key<=hi for lo,hi in coverage):continue
        old=existing.get(key)
        close_ref=by_day.get(_date(old)) if old else None
        rebased=bool(old and close_ref and abs(old['close']-close_ref['close'])>max(1e-7,abs(close_ref['close'])*1e-8))
        if old is None or _date(bars[-1])>_date(old) or rebased or key in changed_periods:
            existing[key]=_summary(bars);repaired+=1
    return sorted(existing.values(),key=lambda bar:bar['timestamp']),repaired


def load_basis(path,code,cutoff,review_month,compact):
    last_day,base=latest_anchor(path,code,cutoff)
    if not last_day:return {'daily':[],'weekly':[],'monthly':[],'latestDate':None,'adjustmentBase':base,'adjustmentFactors':[],'aggregation':{'mode':'offline-periods'}}
    ranges=_ranges(last_day,review_month,2)
    day_future=_SQL_POOL.submit(_daily,path,code,ranges)
    factor_future=_SQL_POOL.submit(_factors,path,code,ranges)
    week_future=_SQL_POOL.submit(_periods,path,code,'tbl_cn_week',_ranges(last_day,review_month,5),base)
    month_future=_SQL_POOL.submit(_periods,path,code,'tbl_cn_month',_ranges(last_day,review_month,25),base)
    daily=day_future.result();factors=factor_future.result()
    factors['adj_factor']=pd.to_numeric(factors['adj_factor'],errors='coerce')
    factors=factors[factors['adj_factor']>0]
    if not daily.empty and not factors.empty:
        factor_by_day=factors.set_index('trade_date')['adj_factor']
        aligned=factor_by_day.reindex(sorted(set(factor_by_day.index)|set(daily['trade_date']))).ffill()
        scale=daily['trade_date'].map(aligned).fillna(1.0)/base
        for field in ('open','high','low','close','pre_close'):daily[field]=pd.to_numeric(daily[field],errors='coerce')*scale
        daily['vol']=pd.to_numeric(daily['vol'],errors='coerce')/scale
    changes=[];previous=None
    for day,factor in factors[['trade_date','adj_factor']].itertuples(index=False,name=None):
        if previous is not None and abs(float(factor)-previous)>1e-10:
            changes.append(dt.datetime.strptime(str(day),'%Y%m%d').date())
        previous=float(factor)
    bars=compact(daily,'trade_date')
    result={'daily':bars,'latestDate':last_day,'adjustmentBase':base,
            'adjustmentFactors':[[str(day),float(value)] for day,value in factors[['trade_date','adj_factor']].itertuples(index=False,name=None)],
            'dailyRanges':ranges,'aggregation':{'mode':'offline-periods','dailyRows':len(daily)}}
    for kind,future in (('weekly',week_future),('monthly',month_future)):
        frame,scale=future.result()
        result[kind],repaired=_repair_periods(compact(frame,'trade_date'),bars,ranges,kind,changes)
        result['aggregation'][kind+'Source']='tbl_cn_week' if kind=='weekly' else 'tbl_cn_month'
        result['aggregation'][kind+'Rebased']=abs(scale-1)>1e-10
        result['aggregation'][kind+'Repaired']=repaired
    return result
