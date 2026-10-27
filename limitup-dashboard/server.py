#!/usr/bin/env python3
"""Local market API and persistent watchlists for the TradingAlert dashboard."""
from __future__ import annotations
import copy, json, os, re, sqlite3, sys, datetime, traceback, calendar, bisect, math, hashlib, threading, gzip
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
import time
from contextlib import closing, ExitStack
from cache_singleflight import KeyedLocks
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse, parse_qs

TDM=Path(os.environ.get("TRADING_DATA_MANAGER_ROOT",str(Path.home()/"TradingDataManager"))).expanduser().resolve()
DBROOT=Path(os.environ.get("TRADING_DATABASE_ROOT",str(Path.home()/"TradingDatabase"))).expanduser().resolve()
KPL_DB=DBROOT/"offline"/"db_cn_kpl.db"
BASIC_DB=DBROOT/"offline"/"db_cn_basic.db"
WEBROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(TDM)); sys.path.insert(0,str(TDM/"offlineDataManager"/"scripts"))
from coreClient.data_provider import get_day,get_oneMin,get_fifteenMin,get_index_daily,get_index_oneMin,get_index_fifteenMin
from coreClient.index_period import IndexPeriodStore, overlay_index_period
from coreClient.limitup_ladder import LimitupLadderStore, LadderNotReady
from limitup_ladder.calculator import (LadderCalculator, is_closed_limit_up, consecutive_board_history,
    ladder_board_pattern, classify_limitup_traits)
from limitup_ladder.live import overlay_live

_chart_read_pool=ThreadPoolExecutor(max_workers=6,thread_name_prefix="stock-chart-read")

from coreClient.watchlist import WatchlistStore, WatchlistConflict
WATCHLISTS=None
_watchlists_init_lock=threading.Lock()

def watchlists_store():
    global WATCHLISTS
    if WATCHLISTS is None:
        with _watchlists_init_lock:
            if WATCHLISTS is None:
                WATCHLISTS=WatchlistStore(os.environ.get("TRADING_WATCHLIST_DB",str(DBROOT/"offline"/"watchlists.db")),redis_client=CACHE.redis)
                WATCHLISTS.refresh()
    return WATCHLISTS

LADDER_STORE=LimitupLadderStore()
_ladder_dates_snapshot=None

def published_ladder_metadata():
    return LADDER_STORE.metadata()



# Trading state follows the exchange calendar and Shanghai wall clock, not review date.
def live_market_status():
    from zoneinfo import ZoneInfo
    now=datetime.datetime.now(ZoneInfo("Asia/Shanghai"))
    day=now.strftime("%Y%m%d")
    calendar_known=False
    is_open=False
    try:
        with closing(sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=2)) as c:
            row=c.execute("SELECT is_open FROM tbl_cn_tradecal WHERE exchange='SSE' AND cal_date=?",(day,)).fetchone()
        calendar_known=row is not None
        is_open=bool(row and row[0]==1)
    except sqlite3.Error:
        pass
    minute=now.hour*60+now.minute
    phase="closed"
    if is_open:
        if 9*60+15<=minute<11*60+30 or 13*60<=minute<15*60:
            phase="trading"
        elif 11*60+30<=minute<13*60:
            phase="recess"
    return {"date":day,"serverTime":now.isoformat(),"phase":phase,
            "label":{"trading":"交易中","recess":"休盘中","closed":"闭市中"}[phase],
            "defaultEnabled":phase in ("trading","recess"),"calendarKnown":calendar_known}


def live_monitor_data():
    # Read the committed full snapshots, including valid zero-stock snapshots.
    # Timeline timestamps identify the snapshot day; yesterday's data is never shown as today.
    import redis
    from zoneinfo import ZoneInfo
    status=live_market_status()
    client=redis.Redis(host="127.0.0.1",port=6380,db=0,decode_responses=True,
                       socket_connect_timeout=1,socket_timeout=2)
    client.ping()
    pools={}
    for kind in ("zt","break"):
        latest=client.zrevrange(f"online:{kind}:timeline",0,0,withscores=True)
        pool={"count":None,"updatedAt":None,"available":False}
        if latest:
            key,stamp=latest[0]
            if stamp>1e12: stamp/=1000
            when=datetime.datetime.fromtimestamp(stamp,ZoneInfo("Asia/Shanghai"))
            pool["updatedAt"]=when.isoformat()
            # Missing archive is unavailable, distinct from a snapshot containing zero stocks.
            if when.strftime("%Y%m%d")==status["date"] and client.exists(key):
                count=client.hlen(key)
                pool.update(count=count,available=True)
        count,at=client.hmget('online:meta',kind+'_last_count',kind+'_last_ts')
        try:
            at=json.loads(at) if at and at.startswith('"') else at
            when=datetime.datetime.fromisoformat(at)
            if int(count)==0 and when.strftime('%Y%m%d')==status['date'] and (not pool['updatedAt'] or when.isoformat()>=pool['updatedAt']):
                pool.update(count=0,available=True,updatedAt=when.isoformat())
        except (TypeError,ValueError):pass
        pools[kind]=pool
    return {"status":status,"pools":pools}

LIVE_INDEX_CATALOG=(("000001.SH","上证指数"),("399001.SZ","深证成指"),
                    ("399006.SZ","创业板指"),("000688.SH","科创50"),
                    ("000300.SH","沪深300"),("000016.SH","上证50"),
                    ("000905.SH","中证500"),("000852.SH","中证1000"))


def fit_live_index_ticks(raw_ticks,day,now):
    from zoneinfo import ZoneInfo
    zone=ZoneInfo("Asia/Shanghai")
    def number(value):
        try:
            result=float(value)
            return result if math.isfinite(result) else None
        except (TypeError,ValueError): return None
    ticks={}
    for raw,score in raw_ticks:
        try:
            row=json.loads(raw)
            stamp=number(row.get("snapshot_index_timestamp") or row.get("snapshot_timestamp"))
            stamp=(stamp/1000 if stamp and stamp>1e12 else stamp) or score
            when=datetime.datetime.fromtimestamp(stamp,zone)
            minute=when.hour*60+when.minute
            price=number(row.get("last_price"))
            if when.strftime("%Y%m%d")!=day or stamp>now.timestamp()+2 or not price or price<=0: continue
            if not (9*60+25<=minute<=11*60+30 or 13*60<=minute<=15*60): continue
            ticks[stamp]=(when,row)
        except (ValueError,TypeError,OverflowError,json.JSONDecodeError): continue
    if not ticks: return {"oneMin":[],"today":None,"quote":None,"tickCount":0}
    bars={};previous_volume=previous_turnover=0;previous_high=previous_low=None
    for stamp,(when,row) in sorted(ticks.items()):
        price=number(row.get("last_price"));high=number(row.get("high_price"));low=number(row.get("low_price"))
        # Opening auction observations join the first 09:30 bar, with no synthetic empty bars.
        bucket=when.replace(second=0,microsecond=0)
        if bucket.hour==9 and bucket.minute<30: bucket=bucket.replace(minute=30)
        key=int(bucket.timestamp()*1000)
        bar=bars.setdefault(key,{"timestamp":key,"open":price,"high":price,"low":price,"close":price,"volume":0,"turnover":0})
        bar["high"]=max(bar["high"],price);bar["low"]=min(bar["low"],price);bar["close"]=price
        # A newly reported daily extreme belongs to this observed minute; unchanged daily
        # extremes must never be copied into every minute's high/low.
        if high is not None and previous_high is not None and high>previous_high: bar["high"]=max(bar["high"],high)
        if low is not None and previous_low is not None and low<previous_low: bar["low"]=min(bar["low"],low)
        for field,previous,target in (("volume",previous_volume,"volume"),("turnover",previous_turnover,"turnover")):
            cumulative=number(row.get(field))
            if cumulative is not None and cumulative>=previous: bar[target]+=cumulative-previous
        previous_volume=max(previous_volume,number(row.get("volume")) or 0)
        previous_turnover=max(previous_turnover,number(row.get("turnover")) or 0)
        previous_high=high if high is not None else previous_high
        previous_low=low if low is not None else previous_low
    stamp,(when,latest)=max(ticks.items())
    close=number(latest.get("last_price"));open_price=number(latest.get("open_price"))
    high=number(latest.get("high_price"));low=number(latest.get("low_price"))
    today=None
    if all(value is not None and value>0 for value in (open_price,high,low,close)):
        today={"timestamp":int(datetime.datetime.strptime(day,"%Y%m%d").replace(tzinfo=datetime.timezone.utc).timestamp()*1000),
               "open":open_price,"high":max(high,open_price,close),"low":min(low,open_price,close),"close":close,
               "volume":number(latest.get("volume")) or 0,"turnover":number(latest.get("turnover")) or 0}
    return {"oneMin":list(bars.values()),"today":today,"tickCount":len(ticks),
            "quote":{"price":close,"prevClose":number(latest.get("prev_price")),"pct":number(latest.get("price_change_ratio_pct")),
                     "time":when.isoformat(),"ageSeconds":max(0,int(now.timestamp()-stamp))}}


def valid_live_ohlc(bar):
    # Index inception/base-point rows can contain only a close (e.g. STAR50 2019-12-31).
    # Such rows are not tradable OHLC bars; never invent their open/high/low.
    return all(isinstance(bar.get(key),(int,float)) and math.isfinite(bar[key]) and bar[key]>0
               for key in ("open","high","low","close"))


@lru_cache(maxsize=48)
def live_index_history(code,day,kind,data_version=""):
    # The revision salts the process cache, including repairs to earlier sessions.
    from zoneinfo import ZoneInfo
    if kind=="fifteenMin":
        database=DBROOT/"offline"/"db_cn_index_minute.db"
        with closing(sqlite3.connect(f"file:{database}?mode=ro",uri=True,timeout=3)) as c:
            rows=c.execute("SELECT datetime,open,high,low,close,amount FROM tbl_cn_index_minute "
                "WHERE ts_code=? AND period=15 AND trade_date<? AND substr(datetime,12,8)<='15:00:00' "
                "ORDER BY datetime DESC LIMIT 128",(code,day)).fetchall()
        return [{"timestamp":int(datetime.datetime.fromisoformat(row[0]).replace(tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()*1000),
                 "open":row[1],"high":row[2],"low":row[3],"close":row[4],"volume":float(row[5] or 0)} for row in reversed(rows)]
    database=DBROOT/"offline"/"db_cn_index.db"
    with closing(sqlite3.connect(f"file:{database}?mode=ro",uri=True,timeout=3)) as c:
        rows=c.execute("SELECT trade_date,open,high,low,close,vol FROM tbl_cn_index_daily "
                       "WHERE ts_code=? AND trade_date<? ORDER BY trade_date DESC LIMIT 2400",(code,day)).fetchall()
    return [{"timestamp":int(datetime.datetime.strptime(row[0],"%Y%m%d").replace(tzinfo=datetime.timezone.utc).timestamp()*1000),
             "open":row[1],"high":row[2],"low":row[3],"close":row[4],"volume":float(row[5] or 0)*100} for row in reversed(rows)
            if valid_live_ohlc(dict(zip(("open","high","low","close"),row[1:5])))]


def aggregate_live_bars(bars,period):
    from zoneinfo import ZoneInfo
    result={}
    for bar in bars:
        if not valid_live_ohlc(bar): continue
        stamp=bar["timestamp"]
        date=datetime.datetime.fromtimestamp(stamp/1000,datetime.timezone.utc)
        if period=="fifteenMin":
            local=date.astimezone(ZoneInfo("Asia/Shanghai"));minute=local.hour*60+local.minute
            start=9*60+30 if minute<=11*60+30 else 13*60
            offset=max(0,min(119,minute-start))
            end=start+(offset//15+1)*15
            anchor=local.replace(hour=end//60,minute=end%60,second=0,microsecond=0)
            key=int(anchor.timestamp()*1000)
        elif period=="weekly": key=date.date()-datetime.timedelta(days=date.weekday())
        else: key=(date.year,date.month)
        if key not in result:
            result[key]={**bar,"timestamp":key if period=="fifteenMin" else stamp,"volume":0}
        target=result[key];target["timestamp"]=key if period=="fifteenMin" else stamp
        target["high"]=max(target["high"],bar["high"]);target["low"]=min(target["low"],bar["low"])
        target["close"]=bar["close"];target["volume"]+=float(bar.get("turnover",bar.get("volume",0)) or 0) if period=="fifteenMin" else float(bar.get("volume",0) or 0)
    return list(result.values())


def live_bar_moving_averages(bars):
    # Calculate before trimming the visible window so its first bars have real history.
    sums=[0.0];valid=[0]
    for bar in bars:
        value=bar.get("close")
        okay=isinstance(value,(int,float)) and math.isfinite(value) and value>0
        sums.append(sums[-1]+(value if okay else 0));valid.append(valid[-1]+int(okay))
    result=[]
    for index,bar in enumerate(bars,1):
        averages={str(period):(sums[index]-sums[index-period])/period
                  for period in (5,10,20,30) if index>=period and valid[index]-valid[index-period]==period}
        result.append({**bar,"ma":averages})
    return result


def live_preaggregated_index_bars(code,day,period,today,quote):
    stored=IndexPeriodStore().as_of_rows(code,period,day,limit=100)
    tick=None
    if today:
        tick={"ts_code":code,"trade_date":day,**{key:today[key] for key in ("open","high","low","close")},
              "vol":today["volume"]/100,"amount":today["turnover"]/1000,
              "pre_close":quote.get("prevClose") if quote else None}
    rows=overlay_index_period(stored,tick,period)
    return [{"timestamp":int(datetime.datetime.strptime(row["trade_date"],"%Y%m%d").replace(tzinfo=datetime.timezone.utc).timestamp()*1000),
             **{key:row[key] for key in ("open","high","low","close")},
             "volume":row["vol"]*100,"turnover":row["amount"]*1000} for row in rows]


def index_data_version():
    # SQLite data can still be in WAL, so the main file alone is not a revision.
    files=[]
    for name in ("db_cn_index.db","db_cn_index_minute.db"):
        for suffix in ("","-wal"):
            path=DBROOT/"offline"/(name+suffix)
            try:
                stat=path.stat();files.append((name+suffix,stat.st_size,stat.st_mtime_ns) if not suffix or stat.st_size>32 else (name+suffix,None,None))
            except FileNotFoundError: files.append((name+suffix,None,None))
    revision=hashlib.sha256(json.dumps(files,separators=(",",":")).encode()).hexdigest()[:24]
    return {"indexDataVersion":revision,"indexSeriesVersion":5,
            "indexVersionAt":datetime.datetime.now(datetime.timezone.utc).timestamp()}


def live_indices_data(group=0,period="oneMin"):
    import redis
    from zoneinfo import ZoneInfo
    version=index_data_version()
    status=live_market_status();day=status["date"]
    now=datetime.datetime.fromisoformat(status["serverTime"])
    start=datetime.datetime.strptime(day,"%Y%m%d").replace(tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()
    client=redis.Redis(host="127.0.0.1",port=6380,db=0,decode_responses=True,
                       socket_connect_timeout=1,socket_timeout=2)
    pipe=client.pipeline(transaction=False)
    catalog=LIVE_INDEX_CATALOG[group*4:group*4+4]
    for code,_ in catalog:
        pipe.zrangebyscore(f"online:snapshot_index:window:{code}",start,now.timestamp(),withscores=True)
    raw_series=pipe.execute();items=[]
    for (code,name),raw_ticks in zip(catalog,raw_series):
        data=fit_live_index_ticks(raw_ticks,day,now)
        series=data["oneMin"];series_error=None
        if period!="oneMin":
            try:
                if period in ("weekly","monthly"):
                    series=live_bar_moving_averages(live_preaggregated_index_bars(code,day,period,data["today"],data["quote"]))[-60:]
                else:
                    history=live_index_history(code,day,"fifteenMin" if period=="fifteenMin" else "daily",version["indexDataVersion"])
                    if period=="fifteenMin": series=live_bar_moving_averages(history+aggregate_live_bars(data["oneMin"],period))[-64:]
                    else: series=live_bar_moving_averages(history+([data["today"]] if data["today"] else []))[-60:]
            except (sqlite3.Error,ValueError,TypeError,OverflowError):
                traceback.print_exc()
                series=[];series_error="该周期历史数据暂不可用"
        items.append({"code":code,"name":name,**data,"series":series,"seriesError":series_error})
    return {**version,"status":status,"indices":items,"source":"redis_snapshot_index","samplingSeconds":30,"period":period,"group":group}


class Cache:
    """Use Redis if reachable; keep a persistent SQLite cache as the fallback."""
    def __init__(self):
        self.redis=None
        self.lock=threading.RLock()
        url=os.environ.get("TRADINGALERT_REDIS_URL","redis://127.0.0.1:6379/2")
        try:
            import redis
            client=redis.Redis.from_url(url,decode_responses=True,socket_connect_timeout=.25,socket_timeout=.5)
            client.ping(); self.redis=client; self.backend="redis"; print("cache=redis",url,flush=True)
        except Exception as exc:
            self.backend="sqlite"
            cache_dir=WEBROOT/"cache"; cache_dir.mkdir(exist_ok=True)
            self.db=sqlite3.connect(cache_dir/"dashboard-cache.sqlite3",check_same_thread=False)
            self.db.execute("create table if not exists cache (key text primary key, value text not null, expires integer not null)")
            self.db.commit(); print("cache=sqlite fallback",type(exc).__name__,flush=True)
    def get(self,key):
        now=int(datetime.datetime.now().timestamp())
        if self.redis:
            value=self.redis.get(key)
            return json.loads(value) if value else None
        with self.lock:
            row=self.db.execute("select value,expires from cache where key=?",(key,)).fetchone()
            if not row: return None
            if row[1]<=now:
                self.db.execute("delete from cache where key=?",(key,)); self.db.commit(); return None
            return json.loads(row[0])

    def set(self,key,value,ttl=21600):
        raw=json.dumps(value,ensure_ascii=False,separators=(",",":"),allow_nan=False)
        if self.redis: self.redis.setex(key,ttl,raw)
        else:
            with self.lock:
                self.db.execute("insert or replace into cache values (?,?,?)",(key,raw,int(datetime.datetime.now().timestamp())+ttl)); self.db.commit()

    def get_many(self,keys):
        if not keys:return []
        if self.redis:return [json.loads(raw) if raw else None for raw in self.redis.mget(keys)]
        now=int(time.time())
        with self.lock:
            found={}
            for offset in range(0,len(keys),300):
                chunk=keys[offset:offset+300];marks=','.join('?' for _ in chunk)
                found.update(self.db.execute(f'select key,value from cache where key in ({marks}) and expires>?',[*chunk,now]).fetchall())
            return [json.loads(found[key]) if key in found else None for key in keys]

    def set_many(self,values,ttl=21600):
        raw={key:json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False) for key,value in values.items()}
        if self.redis:
            with self.redis.pipeline(transaction=False) as pipeline:
                for key,value in raw.items():pipeline.setex(key,ttl,value)
                pipeline.execute()
        else:
            with self.lock:
                expires=int(time.time())+ttl
                self.db.executemany('insert or replace into cache values (?,?,?)',[(key,value,expires) for key,value in raw.items()]);self.db.commit()

    def delete(self,key):
        if self.redis:self.redis.delete(key)
        else:
            with self.lock:self.db.execute('delete from cache where key=?',(key,));self.db.commit()

CACHE=None
PUSH_HUB=None

def live_push_event(updates):
    import redis
    now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    client=redis.Redis(host='127.0.0.1',port=6380,decode_responses=True,socket_timeout=2)
    kinds={item['kind'] for item in updates};quotes=[];indices=[]
    for item in updates:
        kind=item['kind'];archive=item.get('archive')
        if kind not in ('snapshot','snapshot_index','limitperformance') or not archive:continue
        if not archive.startswith('online:'+kind+':archive:'):continue
        for code,raw in client.hgetall(archive).items():
            row=json.loads(raw)
            stamp=row.get('snapshot_index_timestamp',row.get('snapshot_timestamp',row.get('limitperformance_timestamp',item['emittedAt'])))
            stamp=float(stamp);stamp=stamp/1000 if stamp>1e12 else stamp
            quote={'code':code,'price':row.get('last_price',row.get('close_price')),
                   'pct':row.get('price_change_ratio_pct',row.get('pct_chg')),'timestamp':stamp,
                   'volume':row.get('volume'),'amount':row.get('turnover',row.get('amount'))}
            (indices if kind=='snapshot_index' else quotes).append(quote)
    if kinds&{'snapshot','limitperformance','zt','break'}:CACHE.delete('ladder-live-snapshot:v5:'+now.strftime('%Y%m%d'))
    if 'snapshot_index' in kinds:CACHE.delete('ladder-live-index-quotes:v1:'+now.strftime('%Y%m%d'))
    live=live_ladder_snapshot()
    return {'updates':updates,'quotes':quotes,'indices':indices,'receivedAt':now.isoformat(),
            'status':live_market_status(),'ladderStatus':{key:live.get(key) for key in ('date','available','updatedAt','revision','structureRevision','status','reason','frozen','sources','mode','offlineReady','sourceKinds')}}

DATE_RE=re.compile(r"^20\d{6}$")
def safe_date(value):
    v=(value or "").replace("-","")
    if not DATE_RE.fullmatch(v): raise ValueError("日期格式应为YYYYMMDD")
    return v

def json_clean(value):
    if value is None: return None
    if hasattr(value,"item"):
        try: value=value.item()
        except Exception: pass
    if isinstance(value,(datetime.datetime,datetime.date)): return value.isoformat()
    if isinstance(value,float):
        import math
        return value if math.isfinite(value) else None
    return value

def frame_rows(df):
    if df is None or df.empty: return []
    return [{str(k):json_clean(v) for k,v in row.items()} for row in df.to_dict("records")]

def neo4j_topic_days(start_date=None,end_date=None,with_stocks=True):
    """Read daily topic summaries and stock attributions from the canonical graph."""
    from coreClient.neo4j_client import ThemeGraphNeo4jStore
    with ThemeGraphNeo4jStore() as graph:
        summaries=graph.list_topic_days(start_date,end_date)
        if not summaries: return []
        attribution_rows=[]
        if with_stocks:
            start=min(row["trade_date"]["trade_date"] for row in summaries)
            end=max(row["trade_date"]["trade_date"] for row in summaries)
            attribution_rows=graph._run("""
                MATCH (td:TopicDate)-[attribution:ATTRIBUTES_LIMITUP]->(s:Stock)
                MATCH (td)-[:ABOUT_TOPIC]->(t:Topic)
                WHERE td.trade_date >= $start AND td.trade_date <= $end
                RETURN properties(t) AS topic, properties(td) AS topic_date,
                       properties(s) AS stock, properties(attribution) AS attribution
                ORDER BY td.trade_date, td.topic_date_id, attribution.row_order
            """,{"start":start,"end":end})
    attributions={}
    for row in attribution_rows:
        topic_date=row.get("topic_date") or {}
        topic_date_id=topic_date.get("topic_date_id")
        if topic_date_id:
            attributions.setdefault(topic_date_id,[]).append(row)
    output=[]
    for row in summaries:
        topic=row.get("topic") or {}; day=row.get("trade_date") or {}; summary=row.get("summary") or {}; topic_date=row.get("topic_date") or {}
        topic_date_id=topic_date.get("topic_date_id") or summary.get("topic_date_id")
        stocks=[]
        for item in sorted(attributions.get(topic_date_id,[]),key=lambda x:(x.get("attribution") or {}).get("row_order",0)):
            stock=item.get("stock") or {}; attribution=item.get("attribution") or {}
            ts_code=str(attribution.get("stock_code") or stock.get("stock_code") or "").strip().upper()
            if not ts_code: continue
            refs=[]
            try: refs=json.loads(attribution.get("source_refs_json") or "[]")
            except (TypeError,ValueError): pass
            stocks.append({
                "code":str(stock.get("raw_code") or ts_code.split(".")[0])[-6:],"ts_code":ts_code,
                "name":stock.get("stock_name") or "","status":attribution.get("limitup_status") or "首板",
                "reason":attribution.get("limitup_reason") or "","bridge":attribution.get("stock_theme_bridge") or "",
                "caveat":attribution.get("realization_or_counterevidence") or "",
                "confidence":attribution.get("confidence_raw") or "","source_refs":refs,
                "lu_time":attribution.get("seal_time") or "","row_order":attribution.get("row_order"),
            })
        catalyst=summary.get("catalyst_reason") or summary.get("summary_source_text") or ""
        catalyst=re.sub(r"^\*\*当日共性消息/题材逻辑：\*\*\s*", "", str(catalyst)).strip()
        output.append({
            "name":topic.get("canonical_name") or topic.get("source_heading") or "",
            "trade_date":day.get("trade_date"),
            "topic_id":topic.get("topic_id"),"summary":catalyst,"stocks":stocks,
            "section_order":topic_date.get("section_order") or 0,
            "highest_consecutive_board":summary.get("highest_consecutive_board"),
            "limitup_breadth":summary.get("limitup_breadth"),
        })
    return sorted(output,key=lambda item:(item["section_order"],item["name"]))

def neo4j_review(date):
    topics=neo4j_topic_days(date,date)
    if not topics: raise LookupError(f"Neo4j 中没有 {date} 的每日题材复盘记录")
    unique_codes={stock["ts_code"] for topic in topics for stock in topic["stocks"] if stock.get("ts_code")}
    return {"date":date,"title":f"{date[:4]}年{int(date[4:6])}月{int(date[6:])}日涨停复盘",
            "conclusion":"","topics":topics,"totalStocks":len(unique_codes),
            "analysisSource":"neo4j"}

def database_revision(paths):
    revision=[]
    for path in paths:
        for candidate in (path,Path(str(path)+"-wal")):
            try: stat=candidate.stat()
            except FileNotFoundError: continue
            if str(candidate).endswith('-wal') and stat.st_size<=32: continue
            revision.append((str(candidate),stat.st_size,stat.st_mtime_ns))
    return hashlib.sha256(repr(revision).encode()).hexdigest()[:16]


def stock_data_version():
    paths=(BASIC_DB,KPL_DB,DBROOT/'offline'/'db_fifteenMinute.db',
           DBROOT/'offline'/'oneMinute'/'catalog.duckdb',DBROOT/'offline'/'oneMinute'/'catalog.duckdb.wal',
           DBROOT/'offline'/'fifteenMinute'/'fifteen_min.duckdb',DBROOT/'offline'/'fifteenMinute'/'fifteen_min.duckdb.wal')
    return {'stockDataVersion':'period-v2:'+database_revision(paths),'stockFactsVersion':database_revision((BASIC_DB,KPL_DB)),
            'dailyDataVersion':stock_daily_revision(),
            'chartSeriesVersion':7,'stockVersionAt':datetime.datetime.now(datetime.timezone.utc).timestamp()}


_stock_response_lru=OrderedDict()
_stock_response_lock=threading.RLock()
_stock_response_bytes=0

def cached_stock_response(key,loader):
    """Read-only full chart payloads: LRU, 64 entries / 64 MiB, 30-minute deadline."""
    global _stock_response_bytes
    def read():
        global _stock_response_bytes
        now=time.monotonic()
        with _stock_response_lock:
            for old,record in list(_stock_response_lru.items()):
                if record['deadline']<=now:
                    _stock_response_bytes-=record['bytes'];del _stock_response_lru[old]
            record=_stock_response_lru.get(key)
            if record is not None:_stock_response_lru.move_to_end(key);return record['payload']
    value=read()
    if value is not None:return value,True
    with _cache_load_locks.hold(key):
        value=read()
        if value is not None:return value,True
        value=loader()
        if not value.get('daily') or value.get('coverage',{}).get('fifteenError') or value.get('latest',{}).get('coverage',{}).get('fifteenError'):return value,False
        size=len(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode())*3
        if size<=64*1024*1024:
            with _stock_response_lock:
                prior=_stock_response_lru.pop(key,None)
                if prior:_stock_response_bytes-=prior['bytes']
                _stock_response_lru[key]={'payload':value,'bytes':size,'deadline':time.monotonic()+1800};_stock_response_bytes+=size
                while len(_stock_response_lru)>64 or _stock_response_bytes>64*1024*1024:
                    _,old=_stock_response_lru.popitem(last=False);_stock_response_bytes-=old['bytes']
        return value,False


_market_dates_lock=threading.RLock()
_market_dates_snapshot=None

def market_data_dates():
    global _ladder_dates_snapshot
    meta=published_ladder_metadata()
    if meta:
        if _ladder_dates_snapshot and _ladder_dates_snapshot[0]==meta['revision']:
            return list(_ladder_dates_snapshot[1])
        dates=LADDER_STORE.dates()
        _ladder_dates_snapshot=(meta['revision'],tuple(dates))
        return dates
    return _legacy_market_data_dates()


def _legacy_market_data_dates():
    global _market_dates_snapshot
    with _market_dates_lock:
        revision=database_revision((KPL_DB,BASIC_DB))
        if _market_dates_snapshot and _market_dates_snapshot[0]==revision:
            return list(_market_dates_snapshot[1])
        dates,complete=_read_market_data_dates()
        if complete and revision==database_revision((KPL_DB,BASIC_DB)):
            _market_dates_snapshot=(revision,tuple(dates))
        return dates


def _read_market_data_dates():
    """Dates are driven by the available limit-up market snapshots, not graph attribution."""
    dates=set();complete=True
    with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as c:
        tables={r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        if "tbl_cn_kpl_list" in tables:
            dates.update(str(r[0]) for r in c.execute("SELECT DISTINCT trade_date FROM tbl_cn_kpl_list WHERE tag='涨停' AND trade_date IS NOT NULL"))
        if "tbl_cn_kpl_limit_performance" in tables:
            dates.update(str(r[0]) for r in c.execute("SELECT DISTINCT trade_date FROM tbl_cn_kpl_limit_performance WHERE trade_date IS NOT NULL"))
        if "tbl_cn_limit_list" in tables:
            dates.update(str(r[0]) for r in c.execute("SELECT DISTINCT trade_date FROM tbl_cn_limit_list WHERE \"limit\"='U' AND trade_date IS NOT NULL"))
    dates={day for day in dates if re.fullmatch(r"\d{8}",day)}
    if BASIC_DB.exists():
        try:
            with closing(sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=3)) as c:
                tables={r[0] for r in c.execute("select name from sqlite_master where type='table'")}
                calendar_table="tbl_cn_stk_limit" if "tbl_cn_stk_limit" in tables else "tbl_cn_day" if "tbl_cn_day" in tables else None
                if calendar_table:
                    # Probe the existing date index once per candidate day. DISTINCT
                    # over the entire stock-limit table visits every stock-day row.
                    candidates=sorted(dates);valid_days=set()
                    for offset in range(0,len(candidates),500):
                        batch=candidates[offset:offset+500]
                        values=','.join('(?)' for _ in batch)
                        valid_days.update(str(row[0]) for row in c.execute(
                            f"WITH candidates(trade_date) AS (VALUES {values}) SELECT trade_date FROM candidates WHERE EXISTS (SELECT 1 FROM {calendar_table} actual WHERE actual.trade_date=candidates.trade_date)",batch))
                    dates.intersection_update(valid_days)
        except Exception as exc:
            complete=False
            print(f"[review] trading-date filter unavailable: {type(exc).__name__}: {exc}",flush=True)
    return sorted(dates),complete

def market_topics(date, report, pool):
    """Assign each limit-up stock to its single KPL performance theme."""
    pool_stocks=pool.get("stocks",[])
    pool_by_code={str(item.get("ts_code") or "").split(".")[0][-6:]:item for item in pool_stocks}
    grouped={}
    seen=set()
    incomplete=set()
    fallback_codes=set()

    def topic_for(stock):
        code=str(stock.get("ts_code") or stock.get("code") or "").split(".")[0][-6:]
        source=pool_by_code.get(code,{})
        name=str(source.get("performance_theme") or "").strip() or "暂无题材"
        topic=grouped.setdefault(name,{
            "name":name,"trade_date":date,
            "summary":"复盘文档未按该KPL题材单独整理催化摘要。",
            "stocks":[],"classificationSource":"tbl_cn_kpl_limit_performance.theme",
            "analysisGroups":[],
        })
        return code,source,topic

    for source_topic in report.get("topics") or []:
        source_name=str(source_topic.get("name") or "").strip()
        for raw_stock in source_topic.get("stocks",[]):
            code,market_stock,topic=topic_for(raw_stock)
            if not code or code in seen:
                continue
            seen.add(code)
            # Preserve a daily summary only for an exact KPL theme match. A compound
            # report heading must not be silently applied to a different market theme.
            if source_name == topic["name"] and source_topic.get("summary"):
                topic["summary"] = str(source_topic["summary"])
            stock=dict(raw_stock)
            missing_reason=not stock.get("reason") or not stock.get("bridge")
            if missing_reason:
                incomplete.add(code); stock["analysisMissing"]=True
            stock["reason"]=stock.get("reason") or "暂无数据"
            stock["bridge"]=stock.get("bridge") or "暂无数据"
            stock["code"]=code
            stock["ts_code"]=stock.get("ts_code") or market_stock.get("ts_code") or code
            stock["performance_theme"]=market_stock.get("performance_theme") or ""
            stock["analysis_group_name"]=source_name
            stock["analysis_group_summary"]=str(source_topic.get("summary") or "")
            if not market_stock.get("performance_theme"):
                stock["analysisMissing"]=True
                incomplete.add(code)
            topic["stocks"].append(stock)
            if source_name and source_name not in topic["analysisGroups"]:
                topic["analysisGroups"].append(source_name)

    for market_stock in pool_stocks:
        code=str(market_stock.get("ts_code") or "").split(".")[0][-6:]
        if not code or code in seen:
            continue
        seen.add(code); fallback_codes.add(code)
        name=str(market_stock.get("performance_theme") or "").strip() or "暂无题材"
        topic=grouped.setdefault(name,{
            "name":name,"trade_date":date,
            "summary":"复盘文档未按该KPL题材单独整理催化摘要。",
            "stocks":[],"classificationSource":"tbl_cn_kpl_limit_performance.theme",
            "analysisGroups":[],
        })
        topic["stocks"].append({
            "code":code,"ts_code":market_stock.get("ts_code"),"name":market_stock.get("name") or code,
            "status":market_stock.get("status") or "首板","reason":"暂无数据","bridge":"暂无数据",
            "source":"market_data","lu_time":market_stock.get("lu_time") or "",
            "performance_theme":market_stock.get("performance_theme") or "",
            "analysisMissing":True,
        })

    topics=sorted(grouped.values(),key=lambda item:(-len(item["stocks"]),item["name"]))
    return topics, len(fallback_codes), len(fallback_codes)+len(incomplete)



def attach_daily_prices(date, stocks, limit_status="U"):
    """Attach same-day unadjusted OHLC and free-float turnover fields."""
    codes=sorted({str(stock.get("ts_code") or "") for stock in stocks if stock.get("ts_code")})
    prices={}
    if codes:
        try:
            daily=get_day(ts_codes=codes,trade_date=date,qfq=False,source="database_only")
            if daily is not None and not daily.empty:
                prices={str(row["ts_code"]):{"daily_open":json_clean(row.get("open")),"daily_high":json_clean(row.get("high")),"daily_low":json_clean(row.get("low")),"daily_close":json_clean(row.get("close"))} for _,row in daily.iterrows()}
        except Exception as exc:
            print(f"[review] daily OHLC unavailable for {date}: {type(exc).__name__}: {exc}",flush=True)
        try:
            placeholders=','.join('?' for _ in codes)
            with closing(sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=3)) as c:
                rows=c.execute(f"SELECT b.ts_code,b.turnover_rate_f,b.total_mv,b.circ_mv,b.volume_ratio,l.up_limit,d.pre_close,d.open,d.high,d.low,d.amount,l.down_limit,d.close FROM tbl_cn_daily_basic b LEFT JOIN tbl_cn_stk_limit l ON l.trade_date=b.trade_date AND l.ts_code=b.ts_code LEFT JOIN tbl_cn_day d ON d.trade_date=b.trade_date AND d.ts_code=b.ts_code WHERE b.trade_date=? AND b.ts_code IN ({placeholders})",[date,*codes]).fetchall()
            for code,turnover_rate_f,total_mv,circ_mv,volume_ratio,up_limit,pre_close,day_open,day_high,day_low,day_amount,down_limit,day_close in rows:
                metrics=prices.setdefault(str(code),{})
                metrics["free_float_turnover_rate"]=json_clean(turnover_rate_f)
                metrics["daily_basic_total_mv"]=json_clean(total_mv)
                metrics["daily_basic_float_mv"]=json_clean(circ_mv)
                metrics["volume_ratio"]=json_clean(volume_ratio)
                metrics["pre_close"]=json_clean(pre_close)
                for key,value in (("daily_open",day_open),("daily_high",day_high),("daily_low",day_low)):
                    if value is not None:
                        metrics[key]=json_clean(value)
                metrics["up_limit"]=json_clean(up_limit)
                metrics["down_limit"]=json_clean(down_limit)
                if day_close is not None: metrics["daily_close"]=json_clean(day_close)
                if day_amount is not None:
                    metrics["daily_amount"]=json_clean(float(day_amount)*1000)  # tbl_cn_day.amount is in 1,000 CNY
        except Exception as exc:
            print(f"[review] free-float turnover unavailable for {date}: {type(exc).__name__}: {exc}",flush=True)
        try:
            placeholders=','.join('?' for _ in codes)
            with closing(sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=3)) as c:
                rows=c.execute(f"""SELECT ts_code,buy_sm_amount,sell_sm_amount,buy_md_amount,sell_md_amount,
                    buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount,net_mf_amount
                    FROM tbl_cn_moneyflow WHERE trade_date=? AND ts_code IN ({placeholders})""",[date,*codes]).fetchall()
            for code,buy_sm,sell_sm,buy_md,sell_md,buy_lg,sell_lg,buy_elg,sell_elg,net_mf_amount in rows:
                metrics=prices.setdefault(str(code),{})
                if net_mf_amount is not None:
                    metrics["moneyflow_net_amount"]=json_clean(net_mf_amount)  # source-provided net flow, 10,000 CNY
                main_components=(buy_lg,sell_lg,buy_elg,sell_elg)
                if any(value is not None for value in main_components):
                    main_net=sum(float(value or 0) for value in (buy_lg,buy_elg))-sum(float(value or 0) for value in (sell_lg,sell_elg))
                    metrics["main_net_flow_amount"]=json_clean(main_net)  # large + extra-large net flow, 10,000 CNY
        except Exception as exc:
            print(f"[review] moneyflow unavailable for {date}: {type(exc).__name__}: {exc}",flush=True)
        try:
            placeholders=','.join('?' for _ in codes)
            with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as c:
                rows=c.execute(f'''SELECT ts_code,first_time,last_time,fd_amount,amount,turnover_ratio,open_times,float_mv,total_mv
                    FROM tbl_cn_limit_list WHERE trade_date=? AND "limit"=? AND ts_code IN ({placeholders})''',[date,limit_status,*codes]).fetchall()
            for code,first_time,last_time,fd_amount,amount,turnover_ratio,open_times,float_mv,total_mv in rows:
                metrics=prices.setdefault(str(code),{})
                for key,value in (("first_limit_time",first_time),("last_time",last_time)):
                    clock=str(value or "").strip()
                    if re.fullmatch(r"\d{1,6}",clock):
                        clock=clock.zfill(6)
                        clock=f"{clock[:2]}:{clock[2:4]}:{clock[4:6]}"
                    metrics[f"ths_{key}"]=clock
                metrics["ths_fd_amount"]=json_clean(fd_amount)
                metrics["ths_amount"]=json_clean(amount)
                metrics["ths_turnover_rate"]=json_clean(turnover_ratio)
                metrics["open_times"]=json_clean(open_times)
                if float_mv is not None:
                    metrics["float_mv"]=json_clean(float_mv)
                if total_mv is not None:
                    metrics["total_mv"]=json_clean(total_mv)
        except Exception as exc:
            print(f"[review] Tushare limit-list details unavailable for {date}: {type(exc).__name__}: {exc}",flush=True)
    enriched=[]
    for stock in stocks:
        extra=prices.get(str(stock.get("ts_code") or ""),{})
        # daily_basic is the primary market-value source and stores values in 10,000 CNY.
        if extra.get("daily_basic_total_mv") is not None:
            extra["total_mv"]=float(extra["daily_basic_total_mv"])*10000
        if extra.get("float_mv") is None and extra.get("daily_basic_float_mv") is not None:
            extra["float_mv"]=float(extra["daily_basic_float_mv"])*10000
        item={**stock,**extra}
        if extra.get("ths_last_time"):
            item["last_time"]=extra["ths_last_time"]
        if extra.get("ths_first_limit_time"):
            item["lu_time"]=extra["ths_first_limit_time"]
        if item.get("limit_order") in (None,"",0) and extra.get("ths_fd_amount") is not None:
            item["limit_order"]=extra["ths_fd_amount"]
        if item.get("amount") in (None,"",0) and extra.get("ths_amount") is not None:
            item["amount"]=extra["ths_amount"]
        if item.get("turnover_rate") in (None,"",0) and extra.get("ths_turnover_rate") is not None:
            item["turnover_rate"]=extra["ths_turnover_rate"]
        try:
            upper=float(extra.get("up_limit")); high=float(extra.get("daily_high")); low=float(extra.get("daily_low"))
            same=lambda value: abs(float(value)-upper)<0.005
            if same(high) and same(low):
                item["board_shape"]="one_word"
            elif same(extra.get("daily_open")) and same(high) and same(extra.get("daily_close")) and not same(low):
                item["board_shape"]="t_shape"
        except (TypeError,ValueError):
            pass
        item.update(classify_limitup_traits(item))
        enriched.append(item)
    return enriched

def filter_unsealed_breaks(date, stocks):
    """Keep only stocks that touched limit-up intraday and closed below the limit."""
    codes=sorted({str(stock.get("ts_code") or "") for stock in stocks if stock.get("ts_code")})
    if not codes or not BASIC_DB.exists(): return []
    placeholders=','.join('?' for _ in codes)
    try:
        with closing(sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=3)) as c:
            rows=c.execute(f"""SELECT d.ts_code,d.high,d.close,l.up_limit FROM tbl_cn_day d
                JOIN tbl_cn_stk_limit l ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code
                WHERE d.trade_date=? AND d.ts_code IN ({placeholders})""",[date,*codes]).fetchall()
        verified={}
        for code,high,close,up_limit in rows:
            if high is None or close is None or up_limit is None: continue
            high,close,up_limit=map(float,(high,close,up_limit))
            if high >= up_limit-0.005 and close < up_limit-0.005:
                verified[code]=True
        return [stock for stock in stocks if verified.get(str(stock.get("ts_code") or ""))]
    except Exception as exc:
        print(f"[review] break-stock verification unavailable for {date}: {type(exc).__name__}: {exc}",flush=True)
        return []

def _limitup_gap_from_history(date,sessions,indexes,limit_dates,periods,up_stats):
    value=None
    historical_first=False
    if date in indexes and limit_dates:
        event_index=indexes[date]
        # Failed promotion still belongs to the previous trading day's board period.
        if date not in limit_dates and event_index>0 and sessions[event_index-1] in limit_dates:
            event_index-=1
        event_day=sessions[event_index]
        anchor_index=event_index
        if event_day in limit_dates:
            status=periods.get(event_day,"")
            period_match=re.search(r"(\d+)\s*天\s*(\d+)\s*板",status)
            period_days=None
            if period_match:
                days,boards=map(int,period_match.groups())
                if 1<=boards<=days:
                    period_days=days
            elif not status:
                # limit_list up_stat stores board count / trading-day window.
                fallback=re.fullmatch(r"(\d+)\s*/\s*(\d+)",up_stats.get(event_day,""))
                if fallback:
                    boards,days=map(int,fallback.groups())
                    if 1<=boards<=days:
                        period_days=days
            if period_days is not None:
                # Internal unsealed sessions remain part of N-day/M-board periods.
                anchor_index=max(0,event_index-period_days+1)
            else:
                while anchor_index>0 and sessions[anchor_index-1] in limit_dates:
                    anchor_index-=1
        prior_indexes=[indexes[day] for day in limit_dates if indexes[day]<anchor_index]
        value=anchor_index-max(prior_indexes) if prior_indexes else None
        historical_first=event_day in limit_dates and not prior_indexes
    result={"days":value,"historicalFirst":historical_first}
    return result


def previous_limitup_trading_infos(codes, date):
    """Read one calendar and batched histories for all requested stocks."""
    codes=sorted(set(codes))
    if not codes:return {}
    revision=database_revision((BASIC_DB,KPL_DB))
    keys={code:f'previous-limitup-gap:v5:{code}:{date}:{revision}' for code in codes}
    cached=CACHE.get_many(list(keys.values())) if CACHE is not None else [None]*len(codes)
    result={code:value for code,value in zip(codes,cached) if value is not None}
    missing=[code for code in codes if code not in result]
    if not missing:return result
    with _cache_load_locks.hold(f'limitup-gap-batch:{date}:{revision}'):
        cached=CACHE.get_many([keys[code] for code in missing]) if CACHE is not None else [None]*len(missing)
        result.update({code:value for code,value in zip(missing,cached) if value is not None})
        missing=[code for code in missing if code not in result]
        if not missing:return result
        try:
            with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
                sessions=[str(row[0]) for row in c.execute("SELECT cal_date FROM tbl_cn_tradecal WHERE exchange='SSE' AND is_open=1 AND cal_date<=? GROUP BY cal_date ORDER BY cal_date",(date,))]
            indexes={day:i for i,day in enumerate(sessions)}
            history={code:{'dates':set(),'periods':{},'up_stats':{}} for code in missing}
            with closing(sqlite3.connect(f'file:{KPL_DB}?mode=ro',uri=True,timeout=3)) as c:
                tables={row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                for offset in range(0,len(missing),300):
                    chunk=missing[offset:offset+300];marks=','.join('?' for _ in chunk)
                    for day,code,stat in c.execute(f'''SELECT trade_date,ts_code,up_stat FROM tbl_cn_limit_list WHERE ts_code IN ({marks}) AND "limit"='U' AND trade_date<=? ORDER BY trade_date''',[*chunk,date]):
                        info=history[code];info['dates'].add(str(day));info['up_stats'][str(day)]=str(stat or '')
                    if 'tbl_cn_kpl_list' in tables:
                        for day,code,status in c.execute(f"SELECT trade_date,ts_code,status FROM tbl_cn_kpl_list WHERE ts_code IN ({marks}) AND tag='涨停' AND trade_date<=? ORDER BY trade_date",[*chunk,date]):
                            info=history[code];info['dates'].add(str(day));info['periods'][str(day)]=str(status or '')
                    if 'tbl_cn_kpl_limit_performance' in tables:
                        for day,code,status in c.execute(f'SELECT trade_date,ts_code,board_period FROM tbl_cn_kpl_limit_performance WHERE ts_code IN ({marks}) AND trade_date<=? ORDER BY trade_date',[*chunk,date]):
                            info=history[code]
                            if status and not info['periods'].get(str(day)):info['periods'][str(day)]=str(status)
            fresh={}
            for code,info in history.items():
                info['dates'].intersection_update(indexes)
                fresh[code]=_limitup_gap_from_history(date,sessions,indexes,info['dates'],info['periods'],info['up_stats'])
            if CACHE is not None and database_revision((BASIC_DB,KPL_DB))==revision:
                CACHE.set_many({keys[code]:value for code,value in fresh.items()},30*86400)
            result.update(fresh)
        except Exception as exc:
            print(f'[stock] batch prior limit-up intervals unavailable for {date}: {type(exc).__name__}: {exc}',flush=True)
            result.update({code:{'days':None,'historicalFirst':False} for code in missing})
    return result


def previous_limitup_trading_info(code,date):
    return previous_limitup_trading_infos([code],date)[code]


def kpl_pool(date):
    """Merge the three local limit-up snapshots; prefer KPL rows, then fill missing symbols."""
    with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as c:
        c.row_factory=sqlite3.Row
        tables={r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        performance={}
        if "tbl_cn_kpl_limit_performance" in tables:
            performance={str(r["ts_code"]):dict(r) for r in c.execute("SELECT * FROM tbl_cn_kpl_limit_performance WHERE trade_date=?",(date,)).fetchall()}
        broken=[]
        if "tbl_cn_kpl_list" in tables:
            break_rows=c.execute("SELECT ts_code,name,lu_time,open_time,theme,lu_desc FROM tbl_cn_kpl_list WHERE trade_date=? AND tag='炸板' ORDER BY lu_time",(date,)).fetchall()
            for row in break_rows:
                d=dict(row); perf=performance.get(str(d["ts_code"]),{}); count=int(perf.get("board_count") or 1) if perf else None
                d["performance_theme"]=str(perf.get("theme") or "").strip()
                d["performance_limit_reason"]=str(perf.get("limit_reason") or "").strip()
                if d["performance_theme"]:
                    d["theme"]=d["performance_theme"]; d["lu_desc"]=d["performance_theme"]
                d["status"]=("首板" if count==1 else f"{count}板") if count else ""
                d["first_limit_time"]=d.pop("lu_time") or ""; d["break_time"]=d.pop("open_time") or ""
                broken.append(d)
        stocks={}
        if "tbl_cn_kpl_list" in tables:
            rows=c.execute("SELECT ts_code,name,trade_date,lu_time,last_time,lu_desc,theme,status,amount,turnover_rate,free_float,limit_order,lu_limit_order,open_time FROM tbl_cn_kpl_list WHERE trade_date=? AND tag='涨停' ORDER BY lu_time",(date,)).fetchall()
            for r in rows:
                d=dict(r); d.pop("open_time",None)
                perf=performance.get(str(d["ts_code"]),{})
                d["performance_theme"]=str(perf.get("theme") or "").strip()
                d["performance_limit_reason"]=str(perf.get("limit_reason") or "").strip()
                stocks[str(d["ts_code"])]=d
        for code,r in performance.items():
            if code in stocks: continue
            d=dict(r); raw=d.get("lu_time")
            try:
                d["lu_time"]=datetime.datetime.fromtimestamp(int(raw),datetime.timezone.utc).astimezone(datetime.timezone(datetime.timedelta(hours=8))).strftime("%H:%M:%S")
            except (TypeError,ValueError,OverflowError):
                d["lu_time"]=str(raw or "")
            d["last_time"]=""
            d["performance_theme"]=str(d.get("theme") or "").strip()
            d["performance_limit_reason"]=str(d.get("limit_reason") or "").strip()
            d["lu_desc"]=d.get("performance_theme") or ""
            d["theme"]=d.get("limit_reason") or d.get("performance_theme") or ""
            count=int(d.get("board_count") or 1)
            d["status"]=d.get("board_period") or ("首板" if count==1 else f"{count}连板")
            stocks[code]=d
            # performance.is_break records an opened board, including resealed winners.
            # Final failures are verified against the daily close below.
        if "tbl_cn_limit_list" in tables:
            rows=c.execute("SELECT ts_code,name,industry,close,pct_chg,amount,limit_amount,float_mv,total_mv,turnover_ratio,fd_amount,first_time,last_time,open_times,up_stat,limit_times FROM tbl_cn_limit_list WHERE trade_date=? AND \"limit\"='U' ORDER BY first_time",(date,)).fetchall()
            for r in rows:
                d=dict(r); code=str(d["ts_code"])
                if code in stocks: continue
                first=str(d.get("first_time") or "")
                d["lu_time"]=f"{first[:2]}:{first[2:4]}:{first[4:6]}" if len(first)==6 else first
                d["last_time"]=str(d.get("last_time") or "")
                if len(d["last_time"])==6: d["last_time"]=f"{d['last_time'][:2]}:{d['last_time'][2:4]}:{d['last_time'][4:6]}"
                d["lu_desc"]=d.get("industry") or ""; d["theme"]=d.get("industry") or ""
                d["status"]=d.get("up_stat") or "暂无数据"; d["turnover_rate"]=d.get("turnover_ratio")
                d["limit_order"]=d.get("fd_amount"); d["free_float"]=d.get("float_mv"); d["amount"]=d.get("amount")
                d["open_time"]=""; stocks[code]=d
        # KPL list can lag a day. The independent Z snapshot must still be read.
        by_code={str(item["ts_code"]):item for item in broken}
        if "tbl_cn_limit_list" in tables:
            for row in c.execute("""SELECT ts_code,name,industry,first_time,last_time,open_times
                FROM tbl_cn_limit_list WHERE trade_date=? AND "limit"='Z'""",(date,)):
                raw=dict(row); code=str(raw["ts_code"])
                item=by_code.setdefault(code,{"ts_code":code,"name":raw["name"],"theme":"","lu_desc":"","break_time":""})
                perf=performance.get(code,{})
                if perf.get("theme"): item["performance_theme"]=str(perf["theme"]).strip()
                if perf.get("limit_reason"): item["performance_limit_reason"]=str(perf["limit_reason"]).strip()
                item["industry"]=raw.get("industry") or ""
                item["open_times"]=raw.get("open_times")
                clock=str(raw.get("first_time") or "").strip()
                if re.fullmatch(r"\d{1,6}",clock):
                    clock=clock.zfill(6); clock=f"{clock[:2]}:{clock[2:4]}:{clock[4:6]}"
                if not item.get("first_limit_time"): item["first_limit_time"]=clock
        values=list(stocks.values())
        breaks=filter_unsealed_breaks(date,list(by_code.values()))
        return {"source":"KPL涨停名单 / 涨停表现 / 涨停列表","stocks":attach_daily_prices(date,values),
                "break_stocks":attach_daily_prices(date,breaks,limit_status="Z")}

def topic_market_dates(topic):
    """Calendar membership follows the same daily performance label as the pages."""
    revision=database_revision((KPL_DB,BASIC_DB));key=f'topic-dates:v4:{topic}:{revision}'
    def load():
        with closing(sqlite3.connect(f'file:{KPL_DB}?mode=ro',uri=True,timeout=3)) as c:
            tables={row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            c.execute('ATTACH DATABASE ? AS basic',(f'file:{BASIC_DB}?mode=ro',))
            dates=set()
            if 'tbl_cn_kpl_limit_performance' in tables:
                dates.update(row[0] for row in c.execute('''
                    SELECT DISTINCT p.trade_date FROM tbl_cn_kpl_limit_performance p
                    LEFT JOIN basic.tbl_cn_day d ON d.trade_date=p.trade_date AND d.ts_code=p.ts_code
                    LEFT JOIN basic.tbl_cn_stk_limit l ON l.trade_date=p.trade_date AND l.ts_code=p.ts_code
                    WHERE COALESCE(NULLIF(TRIM(p.theme),''),'暂无题材')=?
                    AND (d.close IS NULL OR l.up_limit IS NULL OR abs(d.close-l.up_limit)<.005)
                    AND p.trade_date IS NOT NULL''',(topic,)))
            if topic=='暂无题材':
                for table,condition in (('tbl_cn_kpl_list',"tag='涨停'"),('tbl_cn_limit_list',"\"limit\"='U'")):
                    if table not in tables:continue
                    missing=("AND NOT EXISTS (SELECT 1 FROM tbl_cn_kpl_limit_performance p WHERE p.trade_date=x.trade_date AND p.ts_code=x.ts_code AND trim(coalesce(p.theme,''))<>'')" if 'tbl_cn_kpl_limit_performance' in tables else '')
                    dates.update(row[0] for row in c.execute(f'SELECT DISTINCT x.trade_date FROM {table} x WHERE {condition} {missing} AND x.trade_date IS NOT NULL'))
            trading_days={row[0] for row in c.execute("SELECT cal_date FROM basic.tbl_cn_tradecal WHERE exchange='SSE' AND is_open=1")}
        return sorted(safe_date(str(day)) for day in dates if str(day) in trading_days)
    dates=set(cached_series(key,load,3600))
    live=live_ladder_snapshot()
    if live.get('available'):
        day=live['date'];dates.discard(day)
        if any(stock.get('isSealed') and str(live.get('pool',{}).get(code,{}).get('theme') or '暂无题材').strip()==topic
               for code,stock in live.get('stocks',{}).items()):dates.add(day)
    return sorted(dates)


def stock_concepts(date):
    """Return each stock's OpenKPL concept labels for the selected trade date."""
    key=f"kpl-concepts:v1:{date}"
    cached=CACHE.get(key)
    if cached is not None: return cached
    result={}
    try:
        with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as c:
            rows=c.execute("SELECT con_code,name FROM tbl_cn_kpl_concept_cons WHERE trade_date=? AND con_code IS NOT NULL AND name IS NOT NULL ORDER BY con_code,name",(date,)).fetchall()
        for code,name in rows:
            normalized=str(code).split(".")[0][-6:]
            label=str(name).strip()
            if not normalized or not label: continue
            labels=result.setdefault(normalized,[])
            if label not in labels: labels.append(label)
    except Exception as exc:
        print(f"[review] KPL stock concepts unavailable for {date}: {type(exc).__name__}: {exc}",flush=True)
    CACHE.set(key,result,3600)
    return result

def indices(date):
    items=[]
    for code,name in (("000001.SH","上证指数"),("399001.SZ","深证成指"),("399006.SZ","创业板指"),("000688.SH","科创50"),("000300.SH","沪深300"),("000016.SH","上证50"),("000905.SH","中证500"),("000852.SH","中证1000")):
        try:
            df=get_index_daily(ts_code=code,trade_date=date,source="database_only")
            if not df.empty:
                row=df.iloc[-1].to_dict(); items.append({"code":code,"name":name,"close":json_clean(row.get("close")),"pct_chg":json_clean(row.get("pct_chg")),"amount":json_clean(row.get("amount"))})
        except Exception: pass
    return items

def compact(df,datecol):
    result=[]
    if df is None or df.empty: return result
    cols=set(df.columns)
    for r in df.to_dict("records"):
        dt=r.get(datecol) or r.get("trade_date") or r.get("datetime")
        if isinstance(dt,(datetime.datetime,datetime.date)): dt=dt.isoformat()
        try:
            if re.fullmatch(r"\d{8}",str(dt)): ts=int(datetime.datetime.strptime(str(dt),"%Y%m%d").replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
            else: ts=int(datetime.datetime.fromisoformat(str(dt).replace("Z","+00:00")).timestamp()*1000)
        except Exception: continue
        item={"timestamp":ts}
        for key in ("open","high","low","close","vol","volume","amount","pct_chg","pre_close","turnover_rate_f","free_float_market_cap"):
            if key in cols:
                v=json_clean(r.get(key))
                if v is not None:
                    try: item["volume" if key=="vol" else key]=float(v)
                    except Exception: pass
        result.append(item)
    return result

def aggregate_index_daily(frame, period):
    """Aggregate exchange index daily bars to weekly or monthly OHLCV bars."""
    import pandas as pd
    if frame is None or frame.empty: return []
    data=frame.copy()
    data["trade_date"]=pd.to_datetime(data["trade_date"],format="%Y%m%d",errors="coerce")
    data=data.dropna(subset=["trade_date"]).sort_values("trade_date")
    if data.empty: return []
    data["_period"]=data["trade_date"].dt.to_period(period)
    rows=[]
    for _,group in data.groupby("_period",sort=True):
        row={"trade_date":group["trade_date"].iloc[-1]}
        for key,how in (("open","first"),("high","max"),("low","min"),("close","last"),("vol","sum"),("amount","sum")):
            if key in group.columns:
                row[key]=group[key].iloc[0] if how=="first" else group[key].iloc[-1] if how=="last" else group[key].agg(how)
        rows.append(row)
    return compact(pd.DataFrame(rows),"trade_date")

def aggregate_stock_daily(frame, period):
    """Build complete and in-progress stock periods from the supplied daily cutoff."""
    import pandas as pd
    if frame.empty: return []
    data=frame.copy().sort_values("trade_date")
    data["_period"]=pd.to_datetime(data["trade_date"],format="%Y%m%d").dt.to_period(period)
    rows=[]
    for _,group in data.groupby("_period",sort=True):
        row={"trade_date":str(group["trade_date"].iloc[-1])}
        for field,operation in (("open","first"),("high","max"),("low","min"),("close","last"),("vol","sum"),("amount","sum")):
            if field in group.columns:
                row[field]=group[field].iloc[0] if operation=="first" else group[field].iloc[-1] if operation=="last" else group[field].agg(operation)
        rows.append(row)
    return compact(pd.DataFrame(rows),"trade_date")

def stock_daily_revision():
    return "period-v2:"+database_revision((BASIC_DB,))


def _load_stock_daily_basis(code, cutoff, review_month=None):
    """Read bounded daily windows and the existing forward-adjusted period tables."""
    from stock_period_basis import load_basis
    return load_basis(BASIC_DB,code,cutoff,review_month or cutoff[:6],compact)


# Daily bases depend only on daily/fundamental/adjustment source data, not minute files.
_daily_preload_pool = None
_daily_hot_lock = threading.RLock()
_daily_hot = OrderedDict()
_daily_warm_status = {'running':False, 'warmed':0, 'errors':0}


def register_daily_hot(code):
    now=time.time()
    with _daily_hot_lock:
        _daily_hot.pop(code,None);_daily_hot[code]=now
        while len(_daily_hot)>120:_daily_hot.popitem(last=False)
    if CACHE.redis:
        pipe=CACHE.redis.pipeline(transaction=False)
        pipe.zadd('stock-daily-hot:v1',{code:now})
        pipe.zremrangebyscore('stock-daily-hot:v1','-inf',now-7*86400)
        pipe.zremrangebyrank('stock-daily-hot:v1',0,-121)
        pipe.expire('stock-daily-hot:v1',7*86400);pipe.execute()


def stock_series_latest(code,cutoff,register=True,review_date=None):
    from daily_basis_cache import read_basis
    if register:register_daily_hot(code)
    month=min(review_date or cutoff,cutoff)[:6]
    return read_basis(CACHE,code,cutoff,stock_daily_revision,
                      lambda c,d:_load_stock_daily_basis(c,d,month),window=month)


def stock_daily_payload(code,date,basis=None):
    today=live_market_status()['date']
    if basis is None:basis=stock_series_latest(code,today,review_date=date)
    end=datetime.datetime.strptime(date,'%Y%m%d').date();start=end-datetime.timedelta(days=2*366)
    bars=[bar for bar in basis['daily'] if start<=datetime.datetime.fromtimestamp(bar['timestamp']/1000,datetime.timezone.utc).date()<=end]
    return {'code':code,'date':date,'daily':bars,'dailyDataVersion':basis['dailyDataVersion'],
            'latestDate':basis['latestDate'],'seriesReferenceDate':today,'preloadVersion':1}


def stock_preview(code,date):
    """Read the three hover series concurrently; share cache keys with full pages."""
    version=stock_data_version()
    def load():
        from stock_period_basis import latest_anchor
        end=datetime.datetime.strptime(date,'%Y%m%d').date();today=live_market_status()['date']
        basis_future=_chart_read_pool.submit(stock_series_latest,code,today,True,date)
        base=latest_anchor(BASIC_DB,code,today)[1]
        basis_tag=f"{today}:{base}:{version['stockDataVersion']}"
        one_key=f'series:v7:{code}:minute:5d:qfq:{basis_tag}:{date}'
        fifteen_key=f'series:v6:{code}:fifteen-minute:3m:qfq:{basis_tag}:{date}'
        keys=[one_key,fifteen_key];cached=dict(zip(keys,CACHE.get_many(keys)))
        one_future=_chart_read_pool.submit(cached_intraday_windows,code,'oneMin',{
            one_key:((end-datetime.timedelta(days=14)).strftime('%Y%m%d'),date,7*86400)},basis_future,cached)
        fifteen_future=_chart_read_pool.submit(cached_intraday_windows,code,'fifteenMin',{
            fifteen_key:(shift_months(end,3).strftime('%Y%m%d'),date,7*86400)},basis_future,cached)
        basis=basis_future.result();one=one_future.result()[0][one_key]
        fifteen_windows,errors=fifteen_future.result()
        if errors:raise RuntimeError(next(iter(errors.values())))
        fifteen=fifteen_windows[fifteen_key];daily=stock_daily_payload(code,date,basis)
        if stock_data_version()['stockDataVersion']!=version['stockDataVersion']:raise RuntimeError('Chart source changing; temporarily unavailable')
        return {**daily,'oneMin':one['bars'],'fifteenMin':fifteen['bars'],'suspendedDays':one['suspendedDays'],
                'coverage':{'oneMinBars':len(one['bars']),'fifteenBars':len(fifteen['bars']),'fifteenError':None},
                'previewVersion':1,'chartSeriesVersion':7}
    payload,hit=cached_stock_response('stock-preview:v1:'+code+':'+date+':'+version['stockDataVersion'],load)
    return {**payload,**version},hit


def start_daily_warmer():
    """Warm recently visited stocks after daily DB updates settle; no browser needs to stay open."""
    from concurrent.futures import ThreadPoolExecutor
    global _daily_preload_pool
    _daily_preload_pool=ThreadPoolExecutor(max_workers=2,thread_name_prefix='daily-preload')
    def run():
        last=None;candidate=None
        while True:
            try:
                revision=database_revision((BASIC_DB,))
                if revision!=candidate:candidate=revision
                elif revision!=last:
                    with _daily_hot_lock:codes=list(_daily_hot)[-48:]
                    if CACHE.redis:codes=list(dict.fromkeys(codes+CACHE.redis.zrevrangebyscore('stock-daily-hot:v1','+inf',time.time()-7*86400,start=0,num=48)))[:48]
                    cutoff=live_market_status()['date'];_daily_warm_status.update(running=True,warmed=0,errors=0)
                    # The same bounded pool also serves browser preload requests.
                    for code in codes:
                        future=_daily_preload_pool.submit(stock_series_latest,code,cutoff,False)
                        try:future.result();_daily_warm_status['warmed']+=1
                        except Exception:_daily_warm_status['errors']+=1
                    _daily_warm_status.update(running=False,sourceRevision=revision,finishedAt=time.time())
                    last=revision
            except Exception as exc:
                _daily_warm_status.update(running=False,lastError=type(exc).__name__)
            time.sleep(20)
    threading.Thread(target=run,name='daily-cache-warmer',daemon=True).start()


_online_batch_lru=OrderedDict()
_online_batch_lock=threading.RLock()
_online_batch_load_locks=tuple(threading.RLock() for _ in range(8))


def _online_batch_token(kind,day,client):
    last=client.zrevrange('online:'+kind+':timeline',0,0,withscores=True)
    count,stamp=client.hmget('online:meta',kind+'_last_count',kind+'_last_ts')
    # Source metadata changes on every committed batch. File revision covers the
    # durable fallback after Redis history expires or an offline catch-up writes it.
    database=DBROOT/'online'/('online_data_'+day[:6]+'.db')
    token=hashlib.sha256(repr((last,count,stamp,database_revision((database,)))).encode()).hexdigest()[:16]
    return token


def read_online_close(kind,day,client=None):
    import redis
    client=client or redis.Redis(host='127.0.0.1',port=6380,decode_responses=True,socket_connect_timeout=.5,socket_timeout=2)
    try:token=_online_batch_token(kind,day,client)
    except redis.RedisError:token='sqlite-'+database_revision((DBROOT/'online'/('online_data_'+day[:6]+'.db'),))
    key=f'online-close-batch:v1:{kind}:{day}:{token}'
    phase=live_market_status()['phase'];ttl=3 if phase=='trading' else 60 if phase=='recess' else 1800
    with _online_batch_load_locks[hash(kind)%len(_online_batch_load_locks)]:
        with _online_batch_lock:
            item=_online_batch_lru.get(key)
            if item and item[0]>time.monotonic():_online_batch_lru.move_to_end(key);return item[1]
        storage_key=f'online-close-batch:v2:{kind}:{day}'
        record=CACHE.get(storage_key)
        payload=record['payload'] if record and record.get('token')==token else None
        if payload is None:
            payload=_read_online_close_uncached(kind,day,client)
            if payload[2]!='unavailable':CACHE.set(storage_key,{'token':token,'payload':payload},ttl)
        if payload[2]!='unavailable':
            size=len(json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode())*3
            if size<=32*1024*1024:
                with _online_batch_lock:
                    _online_batch_lru[key]=(time.monotonic()+ttl,payload,size)
                    while len(_online_batch_lru)>12 or sum(item[2] for item in _online_batch_lru.values())>48*1024*1024:_online_batch_lru.popitem(last=False)
        return payload


def online_stock_observations(code,day):
    """HGET the requested stock when source archives exist, otherwise share frozen batches."""
    import redis
    client=redis.Redis(host='127.0.0.1',port=6380,decode_responses=True,socket_connect_timeout=.5,socket_timeout=2)
    kinds=('snapshot','limitperformance','zt');pipe=client.pipeline(transaction=False)
    for kind in kinds:pipe.zrevrange('online:'+kind+':timeline',0,0,withscores=True)
    try:
        latest=pipe.execute();pipe=client.pipeline(transaction=False)
        for records in latest:
            key=records[0][0] if records else '__missing_archive__'
            pipe.hget(key,code);pipe.exists(key)
        raw=pipe.execute()
    except redis.RedisError:
        fallback={}
        for kind in kinds:
            rows,at,source=read_online_close(kind,day,client);fallback[kind]=(rows.get(code,{}),at,source)
        return fallback
    result={};zone=datetime.timezone(datetime.timedelta(hours=8))
    for index,kind in enumerate(kinds):
        records=latest[index];stamp=online_stamp(records[0][1]) if records else 0
        same=stamp and datetime.datetime.fromtimestamp(stamp,zone).strftime('%Y%m%d')==day
        if same and raw[index*2+1]:result[kind]=(json.loads(raw[index*2]) if raw[index*2] else {},stamp,'redis-stock')
        else:
            rows,at,source=read_online_close(kind,day,client);result[kind]=(rows.get(code,{}),at,source)
    return result


_tdx_idle=[]
_tdx_pool_lock=threading.Lock()
_tdx_slots=threading.BoundedSemaphore(3)


def native_stock_minutes(code,day,need_one=True,need_fifteen=True):
    from coreClient.tdx_client import TdxClient
    if not _tdx_slots.acquire(timeout=3):raise RuntimeError('Native minute source busy; temporarily unavailable')
    try:
        for attempt in range(2):
            client=None
            try:
                with _tdx_pool_lock:
                    while _tdx_idle:
                        at,candidate=_tdx_idle.pop()
                        if time.monotonic()-at<45:client=candidate;break
                        candidate.disconnect()
                if client is None:client=TdxClient()
                one=client.download_one_minute(code,trade_date=day,max_pages=2) if need_one else []
                fifteen=client.download_fifteen_minute(code,trade_date=day,max_pages=2) if need_fifteen else []
                with _tdx_pool_lock:_tdx_idle.append((time.monotonic(),client))
                return one,fifteen
            except Exception:
                if client:client.disconnect()
                if attempt:raise
    finally:_tdx_slots.release()


def offline_native_minutes(code,day):
    """Use complete post-close native periods independently; never substitute resolutions."""
    status=live_market_status()
    if status['phase']!='closed' or datetime.datetime.now().strftime('%H%M')<'1505':return [],[]
    result=[]
    for reader,count in ((get_oneMin,240),(get_fifteenMin,16)):
        try:
            frame=filter_after_close(reader(ts_code=code,start_date=day,end_date=day))
            frame=frame[frame['datetime'].astype(str).str[:10].str.replace('-','')==day] if not frame.empty else frame
            times=frame['datetime'].astype(str).str[11:16] if not frame.empty else []
            expected=({'09:45','10:00','10:15','10:30','10:45','11:00','11:15','11:30','13:15','13:30','13:45','14:00','14:15','14:30','14:45','15:00'} if count==16 else {f'{minute//60:02d}:{minute%60:02d}' for minute in [*range(571,691),*range(781,901)]})
            rows=frame_rows(frame) if len(frame)==count and set(times)==expected else []
            for row in rows:
                row['datetime']=str(row['datetime']);row['vol']=float(row.get('vol') or 0)
            result.append(rows)
        except Exception:result.append([])
    return result


def stock_series_for_date(series, cutoff):
    """Reuse completed periods; rebuild only the selected week and month from shared daily bars."""
    if not series["daily"]: return {"daily":[],"weekly":[],"monthly":[]}
    end=datetime.datetime.strptime(min(cutoff,series["latestDate"]),"%Y%m%d").date()
    day_key=lambda bar:datetime.datetime.fromtimestamp(bar["timestamp"]/1000,datetime.timezone.utc).date()
    available=[bar for bar in series["daily"] if day_key(bar)<=end]
    if not available:return {"daily":[],"weekly":[],"monthly":[]}
    # A prior calendar day may be a weekend; retain the traded-day window.
    end=day_key(available[-1])
    day_start=end-datetime.timedelta(days=2*366)
    week_start=end-datetime.timedelta(days=end.weekday())
    month_start=end.replace(day=1)
    def partial_period(start):
        bars=[bar for bar in available if day_key(bar)>=start]
        if not bars: return None
        return {"timestamp":bars[-1]["timestamp"],"open":bars[0]["open"],
                "high":max(bar["high"] for bar in bars),"low":min(bar["low"] for bar in bars),
                "close":bars[-1]["close"],"volume":sum(bar.get("volume",0) for bar in bars),
                "amount":sum(bar.get("amount",0) for bar in bars)}
    weekly_start=end-datetime.timedelta(days=5*366)
    weekly=[bar for bar in series["weekly"] if weekly_start<=day_key(bar)<week_start]
    monthly_start=end-datetime.timedelta(days=25*366)
    monthly=[bar for bar in series["monthly"] if monthly_start<=day_key(bar)<month_start]
    for target,start in ((weekly,week_start),(monthly,month_start)):
        current=partial_period(start)
        if current: target.append(current)
    return {"daily":[bar for bar in available if day_key(bar)>=day_start],
            "weekly":weekly,"monthly":monthly}

def stock_intraday_adjustment(day, basis):
    """Use the same latest daily adjustment base for historical intraday bars."""
    factors=basis.get("adjustmentFactors") or []
    if not factors: return 1.0
    dates=[row[0] for row in factors]
    index=bisect.bisect_right(dates,day)-1
    factor=float(factors[index][1]) if index>=0 else 1.0
    return factor/float(basis["adjustmentBase"])

def adjusted_stock_intraday_bars(bars, basis):
    shanghai=datetime.timezone(datetime.timedelta(hours=8))
    adjusted=[]
    ratios={}
    for original in bars:
        day=datetime.datetime.fromtimestamp(original["timestamp"]/1000,shanghai).strftime("%Y%m%d")
        if day not in ratios: ratios[day]=stock_intraday_adjustment(day,basis)
        ratio=ratios[day]
        bar=original.copy()
        for field in ("open","high","low","close"):
            if bar.get(field) is not None: bar[field]=float(bar[field])*ratio
        if bar.get("volume") is not None: bar["volume"]=float(bar["volume"])/ratio
        adjusted.append(bar)
    return adjusted

def adjusted_one_min_payload(payload, basis):
    result={**payload,"bars":adjusted_stock_intraday_bars(payload["bars"],basis)}
    result["suspendedDays"]=[{**item,"prevClose":float(item["prevClose"])*stock_intraday_adjustment(item["date"],basis)
                              if item.get("prevClose") is not None else None} for item in payload["suspendedDays"]]
    return result

def filter_after_close(df):
    """Keep intraday bars through 15:00 Shanghai time."""
    if df is None or df.empty or "datetime" not in df.columns: return df
    cutoff=datetime.time(15,0,0); shanghai=datetime.timezone(datetime.timedelta(hours=8)); keep=[]
    for value in df["datetime"]:
        try:
            stamp=value if isinstance(value,datetime.datetime) else datetime.datetime.fromisoformat(str(value).strip().replace("Z","+00:00"))
            if stamp.tzinfo is not None: stamp=stamp.astimezone(shanghai)
            keep.append(stamp.time().replace(tzinfo=None)<=cutoff)
        except (TypeError,ValueError,OverflowError): keep.append(False)
    return df.loc[keep].copy()

def full_day_suspensions(code, start_date, end_date):
    """Return full-day suspension dates; intraday trading halts remain real sessions."""
    conn=sqlite3.connect(BASIC_DB)
    try:
        rows=conn.execute(
            "select trade_date from tbl_cn_suspend where ts_code=? and trade_date between ? and ? "
            "and suspend_type=? and (suspend_timing is null or trim(suspend_timing)=?) order by trade_date",
            (code,start_date,end_date,"S",""),
        ).fetchall()
        return [str(row[0]).replace("-","") for row in rows]
    finally:
        conn.close()

def intraday_with_suspensions(code, start_date, end_date, *, frame=None):
    """Return five recent one-minute sessions, filling full-day suspensions at prior close."""
    if frame is None:
        frame=get_oneMin(ts_code=code,start_date=start_date,end_date=end_date)
    if frame is None:
        return {"bars":[],"days":[],"suspendedDays":[]}
    frame=filter_after_close(frame)
    suspension_dates=full_day_suspensions(code,start_date.replace("-", ""),end_date.replace("-", ""))
    real_days=sorted(frame["datetime"].astype(str).str[:10].str.replace("-", "", regex=False).unique()) if not frame.empty else []
    sessions=sorted(set(real_days).union(suspension_dates))[-5:]
    if not suspension_dates:
        frame=frame[frame["datetime"].astype(str).str[:10].str.replace("-", "", regex=False).isin(sessions)] if not frame.empty else frame
        return {"bars":compact(frame,"datetime"),"days":sessions,"suspendedDays":[]}

    conn=sqlite3.connect(BASIC_DB)
    try:
        raw_daily=conn.execute(
            "select trade_date,close from tbl_cn_day where ts_code=? and trade_date between ? and ? order by trade_date",
            (code,start_date.replace("-", ""),end_date.replace("-", "")),
        ).fetchall()
        raw_daily=[(str(day).replace("-", ""),float(close)) for day,close in raw_daily if close is not None]
        previous_daily=conn.execute(
            "select close from tbl_cn_day where ts_code=? and trade_date<? and close is not null order by trade_date desc limit 1",
            (code, min(suspension_dates)),
        ).fetchone()
    finally:
        conn.close()

    suspended=[]; synthetic=[]
    shanghai=datetime.timezone(datetime.timedelta(hours=8))
    for day in suspension_dates:
        if day not in sessions: continue
        previous=[close for trade_day,close in raw_daily if trade_day<day]
        close=previous[-1] if previous else (float(previous_daily[0]) if previous_daily and previous_daily[0] is not None else None)
        suspended.append({"date":day,"prevClose":close})
        if close is None or close<=0: continue
        day_date=datetime.datetime.strptime(day,"%Y%m%d").date()
        for start_h,start_m,count in ((9,31,120),(13,1,120)):
            start=datetime.datetime.combine(day_date,datetime.time(start_h,start_m),tzinfo=shanghai)
            for minute in range(count):
                stamp=start+datetime.timedelta(minutes=minute)
                synthetic.append({"timestamp":int(stamp.timestamp()*1000),"open":close,"high":close,"low":close,"close":close,"volume":0.0,"amount":0.0,"suspended":True})
    if not frame.empty:
        frame=frame[frame["datetime"].astype(str).str[:10].str.replace("-", "", regex=False).isin(sessions)]
    bars=compact(frame,"datetime")
    bars.extend(synthetic)
    bars.sort(key=lambda bar:bar["timestamp"])
    return {"bars":bars,"days":sessions,"suspendedDays":suspended}

def drop_full_day_suspended_bars(frame, code, start_date, end_date):
    if frame is None or frame.empty or "datetime" not in frame.columns: return frame
    dates=set(full_day_suspensions(code,start_date.replace("-", ""),end_date.replace("-", "")))
    if not dates: return frame
    day=frame["datetime"].astype(str).str[:10].str.replace("-", "", regex=False)
    return frame.loc[~day.isin(dates)].copy()

def shift_months(day, months):
    month_index=day.year*12+(day.month-1)-months
    year,month=divmod(month_index,12); month+=1
    return day.replace(year=year,month=month,day=min(day.day,calendar.monthrange(year,month)[1]))

_cache_load_locks=KeyedLocks()

def cached_series(key, loader, ttl=7*24*3600):
    value=CACHE.get(key)
    if value is None:
        # Collapse simultaneous cold requests without retaining one lock per key.
        with _cache_load_locks.hold(key):
            value=CACHE.get(key)
            if value is None:
                value=loader()
                CACHE.set(key,value,ttl)
    return value






def cached_intraday_windows(code, period, windows, basis, initial_values=None):
    """Read missing selected/latest windows once per period, then slice locally.

    Keys retain the preview cache contract. Lock in sorted order so simultaneous
    full-page/preview requests share loads without nested lock-order cycles.
    Failed fifteen-minute reads are never cached as successful empty data.
    """
    keys=sorted(windows)
    values={key:initial_values.get(key) for key in keys} if initial_values is not None else dict(zip(keys,CACHE.get_many(keys)))
    missing=[key for key in keys if values[key] is None]
    errors={}
    with ExitStack() as locks:
        for key in missing:
            locks.enter_context(_cache_load_locks.hold(key))
        if missing:
            values.update(zip(missing,CACHE.get_many(missing)))
        missing=[key for key in missing if values[key] is None]
        if missing:
            try:
                ranges=[windows[key][:2] for key in missing]
                reader=get_oneMin if period=="oneMin" else get_fifteenMin
                frame=reader(ts_code=code,date_ranges=ranges)
                # Storage returns normalized YYYYMMDD trade_date values. A union
                # query keeps distant review/latest windows from reading the gap.
                days=frame["trade_date"].astype(str).str.replace("-","",regex=False)
                resolved_basis=basis.result() if hasattr(basis,"result") else basis
                converted={}
                for key in missing:
                    start,end,ttl=windows[key]
                    identity=(start,end)
                    if identity not in converted:
                        native=frame.loc[days.between(start,end)].copy()
                        if period=="oneMin":
                            data=adjusted_one_min_payload(intraday_with_suspensions(code,start,end,frame=native),resolved_basis)
                        else:
                            native=drop_full_day_suspended_bars(filter_after_close(native),code,start,end)
                            data={"bars":adjusted_stock_intraday_bars(compact(native,"datetime"),resolved_basis),
                                  "days":sorted(native["datetime"].astype(str).str[:10].unique()) if not native.empty else []}
                        converted[identity]=data
                    values[key]=converted[identity]
                    CACHE.set(key,values[key],ttl)
            except Exception as exc:
                if period=="oneMin":
                    raise
                for key in missing:
                    if values[key] is None:
                        values[key]={"bars":[],"days":[]}
                        errors[key]=str(exc)
                print("15-minute data unavailable:",str(exc),flush=True)
    return values,errors


def market_stats(date,topics,pool=None):
    """Cache deterministic market computations separately from graph attribution text."""
    revision=database_revision((BASIC_DB,KPL_DB))
    membership=sorted((str(topic.get('name') or ''),sorted(str(stock.get('ts_code') or stock.get('code') or '') for stock in topic.get('stocks',[]))) for topic in topics)
    signature=hashlib.sha256(json.dumps(membership,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()[:16]
    key=f'market-stats:v2:{date}:{signature}'
    record=CACHE.get(key)
    value=record['payload'] if record and record.get('revision')==revision else None
    if value is None:
        with _cache_load_locks.hold(key):
            record=CACHE.get(key)
            value=record['payload'] if record and record.get('revision')==revision else None
            if value is None:
                value=_compute_market_stats(date,topics,pool)
                if value.get('sealed') is not None and database_revision((BASIC_DB,KPL_DB))==revision:
                    CACHE.set(key,{'revision':revision,'payload':value},7*86400)
                    if CACHE.redis:
                        CACHE.redis.eval("""redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2])
                            redis.call('EXPIRE',KEYS[1],604800)
                            local old=redis.call('ZRANGE',KEYS[1],0,-129)
                            for _,key in ipairs(old) do
                                if string.sub(key,1,string.len('market-stats:v2:'))=='market-stats:v2:' then redis.call('DEL',key) end
                                redis.call('ZREM',KEYS[1],key)
                            end
                            return #old""",1,'market-stats-entries:v1',time.time(),key)
    # Review assembly pops break lists and annotates stock rows with spans.
    # Never let those edits mutate a cached snapshot shared with another caller.
    return copy.deepcopy(value)


def _compute_market_stats(date, topics, pool=None):
    """Compute daily rates and their yesterday-theme/today-theme/board breakdowns."""
    empty={"date":date,"previousDate":None,"touched":None,"sealed":None,"sealingRate":None,"returnDistributions":[],
           "limitUpHistory":[],
           "topicLimitUpHistory":{},
           "promoted":None,"previousFirstBoards":None,"promotionNumerator":None,"promotionDenominator":None,"promotionRate":None,"nonPromotedStocks":[],
           "promotionThemes":[],"sealingThemes":[],"topicPromotionRates":{},"promotionBoards":[],"sealingBoards":[],"consecutiveBoardCounts":{},"previousConsecutiveBoardCounts":{},"firstBoardBreakStocks":[],"allBreakStocks":[],"earthSkyStocks":[],
           "limitDownCount":None,"limitDownTouched":None,"limitDownSealed":None,"limitDownSealingRate":None,"yesterdayLimitUpTodayDown":None,"limitDownThemes":[]}
    if not BASIC_DB.exists(): return empty
    conn=None
    try:
        conn=sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=3); conn.row_factory=sqlite3.Row
        recent_dates=[r[0] for r in conn.execute("SELECT DISTINCT trade_date FROM tbl_cn_day WHERE trade_date<=? ORDER BY trade_date DESC LIMIT 60",(date,)).fetchall()]
        counts_by_day={}; prior_traded_counts={}
        if recent_dates:
            placeholders=','.join('?' for _ in recent_dates)
            history_rows=conn.execute(f"""SELECT d.trade_date,d.ts_code,d.close,l.up_limit FROM tbl_cn_day d
                LEFT JOIN tbl_cn_stk_limit l ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code
                WHERE d.trade_date IN ({placeholders}) ORDER BY d.trade_date,d.ts_code""",recent_dates).fetchall()
            history_days={day:{"date":day,"first":0,"secondThird":0,"fourPlus":0,"highest":0} for day in recent_dates[:30]}
            topic_names=[str(topic.get("name") or "") for topic in topics if topic.get("name")]
            topic_history_days={name:{day:{"date":day,"count":0,"highest":0} for day in recent_dates[:30]} for name in topic_names}
            topic_by_day_code={}
            graph_topics_by_date={}
            try:
                placeholders=','.join('?' for _ in recent_dates[:30])
                with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as kc:
                    theme_rows=kc.execute(f"""SELECT trade_date,ts_code,name,theme,board_count,board_period
                        FROM tbl_cn_kpl_limit_performance WHERE trade_date IN ({placeholders})""",recent_dates[:30]).fetchall()
                daily_groups={}
                for history_date,code,stock_name,theme,board_count,board_period in theme_rows:
                    day=str(history_date); topic_name=str(theme or "").strip()
                    normalized=str(code or "").split(".")[0][-6:]
                    if not topic_name or not normalized: continue
                    if topic_name in topic_history_days:
                        topic_by_day_code[(day,normalized)]=topic_name
                    count=int(board_count or 1)
                    status=str(board_period or "").strip() or ("首板" if count==1 else f"{count}连板")
                    group=daily_groups.setdefault((day,topic_name),{"name":topic_name,"trade_date":day,"summary":"","stocks":[]})
                    group["stocks"].append({"code":normalized,"ts_code":code,"name":stock_name or normalized,"status":status})
                for (day,_),group in daily_groups.items():
                    graph_topics_by_date.setdefault(day,[]).append(group)
            except Exception as theme_exc:
                print(f"[review] KPL performance theme history unavailable: {type(theme_exc).__name__}: {theme_exc}",flush=True)
            # Seed runs crossing the chart's 60-session window without truncating them.
            initial_counts={}
            first_seen=set()
            for row in history_rows:
                if row["ts_code"] in first_seen: continue
                first_seen.add(row["ts_code"])
                if not is_closed_limit_up(row): continue
                count=0
                cursor=conn.execute("""SELECT d.close,l.up_limit FROM tbl_cn_day d
                    LEFT JOIN tbl_cn_stk_limit l ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code
                    WHERE d.ts_code=? AND d.trade_date<? ORDER BY d.trade_date DESC""",(row["ts_code"],row["trade_date"]))
                for prior_row in cursor:
                    if not is_closed_limit_up(prior_row): break
                    count+=1
                cursor.close()
                initial_counts[row["ts_code"]]=count
            prior_traded_counts=dict(initial_counts)
            counts_by_day=consecutive_board_history(history_rows,initial_counts)
            current_board_counts={code.split(".")[0][-6:]:count for code,count in counts_by_day.get(date,{}).items()}
            for row in history_rows:
                code=row["ts_code"]; day=str(row["trade_date"])
                board=counts_by_day.get(day,{}).get(code,0)
                if day<date: prior_traded_counts[code]=board
                if day in history_days and board:
                    item=history_days[day]
                    if board==1: item["first"]+=1
                    elif board<=3: item["secondThird"]+=1
                    else: item["fourPlus"]+=1
                    item["highest"]=max(item["highest"],board)
                    normalized_code=str(code).split(".")[0][-6:]
                    topic_name=topic_by_day_code.get((str(day),normalized_code))
                    if topic_name:
                        topic_item=topic_history_days[topic_name][day]
                        topic_item["count"]+=1
                        topic_item["highest"]=max(topic_item["highest"],board)
            empty["limitUpHistory"]=[history_days[d] for d in sorted(history_days)]
            empty["topicLimitUpHistory"]={name:[topic_history_days[name][d] for d in sorted(topic_history_days[name])] for name in topic_names}
            empty["consecutiveBoardCounts"]=current_board_counts
        current=conn.execute("""SELECT d.ts_code,d.open,d.high,d.low,d.close,d.pre_close,d.pct_chg,l.up_limit,l.down_limit FROM tbl_cn_day d JOIN tbl_cn_stk_limit l
            ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code WHERE d.trade_date=?""",(date,)).fetchall()
        if not current: return empty
        dist_rows=conn.execute("""SELECT d.pct_chg,b.circ_mv FROM tbl_cn_day d LEFT JOIN tbl_cn_daily_basic b
            ON b.trade_date=d.trade_date AND b.ts_code=d.ts_code WHERE d.trade_date=? AND d.pct_chg IS NOT NULL""",(date,)).fetchall()
        edges=[float("-inf"),-7,-5,-3,-1,1,3,5,7,float("inf")]
        labels=["≤-7","-7~-5","-5~-3","-3~-1","-1~1","1~3","3~5","5~7","≥7"]
        groups={"总体":[],"微盘":[],"小盘":[],"中盘":[],"大盘":[]}
        for row in dist_rows:
            change=float(row["pct_chg"]); cap=None if row["circ_mv"] is None else float(row["circ_mv"])
            groups["总体"].append(change)
            if cap is not None:
                category="微盘" if cap<500000 else "小盘" if cap<2000000 else "中盘" if cap<10000000 else "大盘"
                groups[category].append(change)
        cap_desc={"微盘":"流通市值 < 50亿元","小盘":"50–200亿元","中盘":"200–1000亿元","大盘":"≥ 1000亿元"}
        distributions=[]
        for name,values in groups.items():
            bins=[]
            for i,label in enumerate(labels):
                count=sum(1 for value in values if edges[i]<=value<edges[i+1])
                bins.append({"label":label,"count":count,"fraction":count/len(values) if values else None})
            distributions.append({"name":name,"count":len(values),"description":cap_desc.get(name,"全部个股"),"bins":bins})
        hit=lambda r: r["high"] is not None and r["up_limit"] is not None and abs(float(r["high"])-float(r["up_limit"]))<0.005
        close_limit=is_closed_limit_up
        down_hit=lambda r: r["low"] is not None and r["down_limit"] is not None and abs(float(r["low"])-float(r["down_limit"]))<0.005
        close_down=lambda r: r["close"] is not None and r["down_limit"] is not None and abs(float(r["close"])-float(r["down_limit"]))<0.005
        current_by_code={r["ts_code"]:r for r in current}; hit_codes={c for c,r in current_by_code.items() if hit(r)}
        sealed_codes={c for c,r in current_by_code.items() if close_limit(r)}
        down_hit_codes={c for c,r in current_by_code.items() if down_hit(r)}
        down_sealed_codes={c for c,r in current_by_code.items() if close_down(r)}
        prev=conn.execute("SELECT MAX(trade_date) FROM tbl_cn_day WHERE trade_date<?",(date,)).fetchone()[0]
        result={**empty,"previousDate":prev,"touched":len(hit_codes),"sealed":len(sealed_codes),"sealingRate":len(sealed_codes)/len(hit_codes) if hit_codes else None}
        result["returnDistributions"]=distributions
        result.update(limitDownCount=len(down_sealed_codes),limitDownTouched=len(down_hit_codes),limitDownSealed=len(down_sealed_codes),limitDownSealingRate=len(down_sealed_codes)/len(down_hit_codes) if down_hit_codes else None)
        def streak(code,day):
            return counts_by_day.get(str(day),{}).get(code,0)
        result["previousConsecutiveBoardCounts"]={code.split(".")[0][-6:]:count for code,count in counts_by_day.get(str(prev),{}).items()}
        buckets={2:"二板",3:"三板",4:"四板",5:"高板"}
        # Board-level promotion cohorts are grouped by the board they would advance into.
        promo_den={k:0 for k in buckets}; promo_num={k:0 for k in buckets}
        if prev:
            previous=conn.execute("""SELECT d.ts_code,d.close,l.up_limit FROM tbl_cn_day d JOIN tbl_cn_stk_limit l
                ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code WHERE d.trade_date=?""",(prev,)).fetchall()
            prior_sealed={r["ts_code"] for r in previous if is_closed_limit_up(r)}
            result["yesterdayLimitUpTodayDown"]=len(prior_sealed & down_sealed_codes)
            prior_meta={}
            try:
                with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as kc:
                    kc.row_factory=sqlite3.Row
                    prior_meta={r["ts_code"]:dict(r) for r in kc.execute("""SELECT l.ts_code,l.name,
                        COALESCE(NULLIF(p.theme,''),NULLIF(l.lu_desc,''),'') AS theme,l.status
                        FROM tbl_cn_kpl_list l LEFT JOIN tbl_cn_kpl_limit_performance p
                        ON p.trade_date=l.trade_date AND p.ts_code=l.ts_code
                        WHERE l.trade_date=? AND l.tag='涨停'""",(prev,)).fetchall()}
                    for row in kc.execute("SELECT ts_code,name,theme,board_period FROM tbl_cn_kpl_limit_performance WHERE trade_date=?",(prev,)):
                        metadata=prior_meta.setdefault(row["ts_code"],{})
                        for key,column in (("name","name"),("theme","theme"),("status","board_period")):
                            if row[column]: metadata[key]=row[column]
            except Exception: pass
            non_promoted=[]
            for code in prior_sealed-sealed_codes:
                bar=current_by_code.get(code) or {key:None for key in ("open","high","pre_close","up_limit","pct_chg")}
                prior_board=streak(code,prev); metadata=prior_meta.get(code,{})
                pre_close=bar["pre_close"]
                high_pct=(float(bar["high"])/float(pre_close)-1)*100 if bar["high"] is not None and pre_close not in (None,0) else None
                opened_at_limit=bar["open"] is not None and bar["up_limit"] is not None and abs(float(bar["open"])-float(bar["up_limit"]))<0.005
                non_promoted.append({"ts_code":code,"name":metadata.get("name") or code.split(".")[0],"theme":metadata.get("theme") or "","board_count":prior_board,"previousConsecutiveBoardCount":prior_board,"promotionTarget":min(prior_board+1,5),"previous_status":metadata.get("status") or "","touched_limit_today":code in hit_codes,"opened_at_limit":opened_at_limit,"close_pct":float(bar["pct_chg"]) if bar["pct_chg"] is not None else None,"high_pct":high_pct})
            result["nonPromotedStocks"]=sorted(non_promoted,key=lambda item:(-item["board_count"],item["name"]))
            for code in prior_sealed:
                target=min(streak(code,prev)+1,5)
                if target in promo_den:
                    promo_den[target]+=1
                    if code in sealed_codes: promo_num[target]+=1
            total_promotion_den=sum(promo_den.values()); total_promotion_num=sum(promo_num.values())
            result.update(promoted=total_promotion_num,previousFirstBoards=promo_den[2],promotionNumerator=total_promotion_num,promotionDenominator=total_promotion_den,promotionRate=total_promotion_num/total_promotion_den if total_promotion_den else None)
        # Today's final board cohorts for sealing rate. A touched-but-broken name is
        # assigned the board it attempted based on the prior consecutive sealed streak.
        seal_buckets={1:"首板",**buckets}; seal_den={k:0 for k in seal_buckets}; seal_num={k:0 for k in seal_buckets}
        for code in hit_codes:
            # Resumption preserves its traded-session run, but promotion still
            # requires membership in the actual previous market day's cohort.
            board=streak(code,date) if code in sealed_codes else prior_traded_counts.get(code,0)+1
            target=min(board,5)
            if target in seal_den:
                seal_den[target]+=1
                if code in sealed_codes: seal_num[target]+=1
        result["promotionBoards"]=[{"label":buckets[k],"numerator":promo_num[k],"denominator":promo_den[k],"rate":promo_num[k]/promo_den[k] if promo_den[k] else None} for k in buckets]
        result["sealingBoards"]=[{"label":seal_buckets[k],"numerator":seal_num[k],"denominator":seal_den[k],"rate":seal_num[k]/seal_den[k] if seal_den[k] else None} for k in seal_buckets]
        # Daily OHLC is the complete final-outcome universe. A source flag such as
        # performance.is_break does not prove that the stock stayed unsealed.
        source_pool=pool if pool is not None else kpl_pool(date)
        source_breaks=source_pool.get("all_break_stocks") or source_pool.get("break_stocks",[])
        break_metadata={str(stock.get("ts_code")):stock for stock in source_breaks}
        names={str(row[0]):str(row[1] or "") for row in conn.execute("SELECT ts_code,name FROM tbl_cn_basic")}
        failures=[]
        for code in sorted(hit_codes-sealed_codes):
            bar=current_by_code[code]
            if bar["close"] is None or float(bar["close"])>=float(bar["up_limit"])-0.005: continue
            item=dict(break_metadata.get(code,{}))
            explicit=str(item.get("performance_theme") or "").strip()
            # With no performance row, use the first explicit KPL list label;
            # industry is not a same-day theme and cannot supply attribution.
            fallback=re.split(r"[、,，;；]",str(item.get("theme") or item.get("lu_desc") or ""))[0].strip()
            if fallback in ("暂无题材","暂无数据","未分类"): fallback=""
            theme=explicit or fallback or "暂无题材"
            before=prior_traded_counts.get(code,0)
            item.update(ts_code=code,name=item.get("name") or names.get(code) or code.split(".")[0],
                        theme=theme,classification_theme=theme,classification_source="kpl_performance" if explicit else "kpl_list" if fallback else "unavailable",
                        previousConsecutiveBoardCount=before,attemptedBoardCount=before+1,
                        close_pct=float(bar["pct_chg"]) if bar["pct_chg"] is not None else None,
                        daily_close=float(bar["close"]),first_limit_time=item.get("first_limit_time") or "",break_time=item.get("break_time") or "")
            failures.append(item)
        failures=attach_daily_prices(date,failures,limit_status="Z")
        for item in failures:
            if not item.get("first_limit_time"): item["first_limit_time"]=item.get("ths_first_limit_time") or ""
        result["allBreakStocks"]=failures
        result["firstBoardBreakStocks"]=[item for item in failures if item["attemptedBoardCount"]==1]
        def score(topic,day):
            pts={1:1,2:3,3:6,4:8,5:10}; boards=[]
            normalized={code.split(".")[0][-6:]:count for code,count in counts_by_day.get(str(day),{}).items()}
            for stock in topic.get("stocks",[]):
                code=str(stock.get("ts_code") or stock.get("code") or "").split(".")[0][-6:]
                boards.append(normalized.get(code,0))
            value=sum(pts.get(min(n,5),0) for n in boards)
            return value-(5 if len(boards)<2 else 1 if len(boards)<3 else 0)
        top_today=sorted(topics,key=lambda t:(-score(t,date),-len(t.get("stocks",[])),t["name"]))[:5]
        # Daily KPL tags provide attribution for exploded boards; raw OHLC/limit-price
        # rows remain the source of touched/sealed counts and rates.
        def theme_map(day):
            try:
                with closing(sqlite3.connect(f"file:{KPL_DB}?mode=ro",uri=True,timeout=3)) as kc:
                    result={r[0]:str(r[1] or "") for r in kc.execute("SELECT ts_code,lu_desc FROM tbl_cn_kpl_list WHERE trade_date=? AND tag IN ('涨停','炸板')",(day,))}
                    result.update({r[0]:str(r[1] or "") for r in kc.execute("SELECT ts_code,theme FROM tbl_cn_kpl_limit_performance WHERE trade_date=?",(day,)) if r[1]})
                    return result
            except Exception: return {}
        today_tags=theme_map(date); today_topic_rows=[]
        # A close at the upper limit is later than the session's lower-limit low.
        # Compare unadjusted prices with that day's actual exchange limit prices.
        winners={str(stock.get("ts_code")):stock for stock in source_pool.get("stocks",[])}
        report_themes={str(stock.get("code") or stock.get("ts_code") or "").split(".")[0][-6:]:topic["name"]
                       for topic in topics for stock in topic.get("stocks",[])}
        for code in sorted(down_hit_codes & sealed_codes):
            bar=current_by_code[code]
            if not (float(bar["up_limit"])>float(bar["down_limit"])>0): continue
            source=winners.get(code,{})
            theme=str(source.get("performance_theme") or today_tags.get(code) or report_themes.get(code.split(".")[0]) or "暂无题材").strip()
            result["earthSkyStocks"].append({"ts_code":code,"code":code.split(".")[0],
                "name":source.get("name") or names.get(code) or code.split(".")[0],"theme":theme,
                "low":float(bar["low"]),"down_limit":float(bar["down_limit"]),
                "close":float(bar["close"]),"up_limit":float(bar["up_limit"])})
        for topic in top_today:
            name=topic["name"]
            report_codes={str(s.get("code", ""))[-6:] for s in topic.get("stocks",[])}
            members={c for c in hit_codes if name.strip()==today_tags.get(c,"").strip() or c.split(".")[0] in report_codes}
            num=len(members & sealed_codes); den=len(members)
            today_topic_rows.append({"name":name,"numerator":num,"denominator":den,"rate":num/den if den else None})
        result["sealingThemes"]=today_topic_rows
        if prev:
            prior_topics=graph_topics_by_date.get(prev,[]) if recent_dates else []
            topic_promotion_rates={}
            prior_streaks={}
            for prior_topic in prior_topics:
                topic_name=prior_topic["name"]
                den={k:0 for k in buckets}; num={k:0 for k in buckets}
                for stock in prior_topic.get("stocks",[]):
                    code=str(stock.get("ts_code") or "").upper()
                    if code not in prior_sealed: continue
                    if code not in prior_streaks: prior_streaks[code]=streak(code,prev)
                    target=min(prior_streaks[code]+1,5)
                    if target in den:
                        den[target]+=1
                        if code in sealed_codes: num[target]+=1
                topic_promotion_rates[topic_name]=[
                    {"label":buckets[k],"numerator":num[k],"denominator":den[k],"rate":num[k]/den[k] if den[k] else None}
                    for k in buckets
                ]
            result["topicPromotionRates"]=topic_promotion_rates
            top_prior=sorted(prior_topics,key=lambda t:(-score(t,prev),-len(t.get("stocks",[])),t["name"]))[:5]
            rows=[]
            for topic in top_prior:
                name=topic["name"]
                report_codes={str(s.get("code", ""))[-6:] for s in topic.get("stocks",[])}
                members={c for c in prior_sealed if c.split(".")[0] in report_codes}
                num=len(members & sealed_codes); den=len(members)
                rows.append({"name":name,"numerator":num,"denominator":den,"rate":num/den if den else None})
            result["promotionThemes"]=rows
            today_tags=theme_map(date); down_rows=[]
            for topic in top_prior:
                name=topic["name"]
                report_codes={str(s.get("code", ""))[-6:] for s in topic.get("stocks",[])}
                members={c for c in down_sealed_codes if name.strip()==today_tags.get(c,"").strip() or c.split(".")[0] in report_codes}
                down_rows.append({"name":name,"count":len(members)})
            result["limitDownThemes"]=down_rows
        # Add same-day market facts for all non-promoted names, including those
        # that did not touch limit-up, so stock detail can render its information row.
        result["nonPromotedStocks"]=attach_daily_prices(date,result.get("nonPromotedStocks",[]))
        return result
    except Exception as exc:
        print("market stats unavailable",date,type(exc).__name__,str(exc),flush=True); return empty
    finally:
        if conn is not None:conn.close()



def ladder_data_version():
    meta=published_ladder_metadata()
    revision='ladder-db-v1:'+meta['revision'] if meta else database_revision((KPL_DB,BASIC_DB))
    return {"ladderDataVersion":revision,"ladderSeriesVersion":15,"cacheBackend":CACHE.backend}


def live_ladder_index_quotes(day):
    import redis
    zone=datetime.timezone(datetime.timedelta(hours=8));now=datetime.datetime.now(zone)
    key='ladder-live-index-quotes:v1:'+day
    def load():
        client=redis.Redis(host='127.0.0.1',port=6380,decode_responses=True,socket_timeout=2)
        if live_market_status()['phase']=='closed':
            records,at,_=read_online_close('snapshot_index',day,client)
            return [{'code':code,'name':name,'close':records[code].get('last_price'),'pct_chg':records[code].get('price_change_ratio_pct'),'amount':float(records[code]['turnover'])/1000 if records[code].get('turnover') is not None else None,'quoteTime':datetime.datetime.fromtimestamp(at,zone).isoformat()} for code,name in LIVE_INDEX_CATALOG if code in records]
        pipe=client.pipeline(transaction=False)
        recess=live_market_status()['phase']=='recess'
        end=datetime.datetime.strptime(day+'113059','%Y%m%d%H%M%S').replace(tzinfo=zone).timestamp() if recess else now.timestamp()
        for code,_ in LIVE_INDEX_CATALOG:pipe.zrevrangebyscore('online:snapshot_index:window:'+code,end,'-inf',start=0,num=1,withscores=True)
        quotes=[]
        for (code,name),ticks in zip(LIVE_INDEX_CATALOG,pipe.execute()):
            data=fit_live_index_ticks(ticks,day,now);quote=data['quote'];bar=data['today']
            if not quote or not recess and quote['ageSeconds']>120:continue
            quotes.append({'code':code,'name':name,'close':quote['price'],'pct_chg':quote['pct'],'amount':bar['turnover']/1000 if bar else None,'quoteTime':quote['time']})
        return quotes
    return cached_series(key,load,10)


def live_stock_chart(code,day):
    """Historical adjusted bars plus current native TDX bars, with a short live cache."""
    from zoneinfo import ZoneInfo
    from coreClient.tdx_client import TdxClient
    import redis
    zone=ZoneInfo('Asia/Shanghai');now=datetime.datetime.now(zone)
    if day!=now.strftime('%Y%m%d'):raise ValueError('实时接口仅支持当天，历史日期请读取离线行情')
    version=stock_data_version();revision=version['stockDataVersion'];phase=live_market_status()['phase']
    def load():
        saved_one,saved_fifteen=offline_native_minutes(code,day)
        fresh_one,fresh_fifteen=native_stock_minutes(code,day,not bool(saved_one),not bool(saved_fifteen)) if not saved_one or not saved_fifteen else ([],[])
        raw_one=saved_one or fresh_one;raw_fifteen=saved_fifteen or fresh_fifteen
        def native_bars(rows,span):
            result=[]
            for row in rows:
                local=datetime.datetime.fromisoformat(str(row['datetime'])).replace(tzinfo=zone)
                minute=local.hour*60+local.minute
                if local.strftime('%Y%m%d')!=day or not(9*60+30<=minute<=11*60+30 or 13*60<=minute<=15*60):continue
                # TDX labels an unfinished bar by its period-end time.
                if local.timestamp()>now.timestamp()+span*60:continue
                bar={'timestamp':int(local.timestamp()*1000),**{field:float(row[field]) for field in ('open','high','low','close')},'volume':float(row.get('vol') or 0),'amount':float(row.get('amount') or 0),'partial':local.timestamp()>now.timestamp()}
                if valid_live_ohlc(bar):result.append(bar)
            return sorted(result,key=lambda bar:bar['timestamp'])
        current_one=native_bars(raw_one,1);current_fifteen=native_bars(raw_fifteen,15)
        if not current_one:raise ValueError('当天原生1分钟行情暂不可用，未用15分钟数据替代')
        r=redis.Redis(host='127.0.0.1',port=6380,decode_responses=True,socket_timeout=2)
        quote={};keys=r.zrevrange('online:snapshot:timeline',0,0)
        if phase in ('closed','recess'):
            quote,_,_=online_stock_observations(code,day)['snapshot']
        elif keys:
            raw=r.hget(keys[0],code)
            if raw:quote=json.loads(raw)
        def quote_valid(q):
            try:
                stamp=online_stamp(q.get('snapshot_timestamp'));local=datetime.datetime.fromtimestamp(stamp,zone)
                return local.strftime('%Y%m%d')==day and (phase in ('closed','recess') or -5<=now.timestamp()-stamp<=60)
            except (TypeError,ValueError):return False
        if phase=='trading' and not quote_valid(quote):
            try:
                from coreClient.ths_client import fetch_snapshots
                quote=next((item for item in fetch_snapshots([code]) if item.get('ts_code')==code),{})
            except Exception:quote={}
        if not quote_valid(quote):quote={}
        date=datetime.datetime.strptime(day,'%Y%m%d').date();prior=(date-datetime.timedelta(days=1)).strftime('%Y%m%d')
        basis=stock_series_latest(code,day)
        history=stock_series_for_date(basis,prior)
        start=(date-datetime.timedelta(days=14)).strftime('%Y%m%d')
        old_one=cached_series(f'live-hover-minute-history:v1:{code}:{prior}:{revision}',lambda:adjusted_one_min_payload(intraday_with_suspensions(code,start,prior),basis),300)
        def old_fifteen():
            frame=filter_after_close(get_fifteenMin(ts_code=code,start_date=shift_months(date,3).strftime('%Y%m%d'),end_date=prior)).copy()
            if not frame.empty:frame['datetime']=frame['datetime'].astype(str).str[:19]+'+08:00'
            return adjusted_stock_intraday_bars(compact(frame,'datetime'),basis)
        past_fifteen=cached_series(f'live-hover-fifteen-history:v1:{code}:{prior}:{revision}',old_fifteen,300)
        previous=history['daily'][-1]['close'] if history['daily'] else None
        prior_close=quote.get('prev_price') or previous
        # Rebase earlier adjusted prices when today's ex-rights previous close changes.
        scale=float(prior_close)/float(previous) if previous and prior_close else 1
        def rebase(bars):
            return [{**bar,**{key:bar[key]*scale for key in ('open','high','low','close')},'volume':bar.get('volume',0)/scale} for bar in bars]
        historical_daily=rebase(history['daily']);historical_one=rebase(old_one['bars']);historical_fifteen=rebase(past_fifteen)
        close=float(current_one[-1]['close']);opening=float(quote.get('open_price') or current_one[0]['open'])
        high=max(float(quote.get('high_price') or 0),max(bar['high'] for bar in current_one),close);low=min(float(quote.get('low_price') or high),min(bar['low'] for bar in current_one),close)
        amount=max(float(quote.get('turnover') or 0),sum(bar['amount'] for bar in current_one));volume=max(float(quote.get('volume') or 0),sum(bar['volume'] for bar in current_one))
        pct=(close/float(prior_close)-1)*100 if prior_close else None
        daily=historical_daily+[{'timestamp':int(datetime.datetime.strptime(day,'%Y%m%d').replace(tzinfo=datetime.timezone.utc).timestamp()*1000),'open':opening,'high':high,'low':low,'close':close,'amount':amount/1000,'volume':volume/100,'pct_chg':pct}]
        bars=historical_one+current_one;days=sorted({datetime.datetime.fromtimestamp(bar['timestamp']/1000,zone).strftime('%Y%m%d') for bar in bars})[-5:]
        bars=[bar for bar in bars if datetime.datetime.fromtimestamp(bar['timestamp']/1000,zone).strftime('%Y%m%d') in days]
        facts={'code':code,'date':day,'close':close,'pct':pct,'openPct':(opening/float(prior_close)-1)*100 if prior_close else None,'amplitude':(high-low)/float(prior_close)*100 if prior_close else None,'amount':amount,'volume':volume,'floatMarketCap':None,'totalMarketCap':None,'freeFloatTurnover':None,'limitTime':None}
        live=live_ladder_snapshot();facts['limitTime']=live.get('stocks',{}).get(code,{}).get('time')
        return {'code':code,'date':day,'isLive':True,'updatedAt':now.isoformat(),'daily':daily,'oneMin':bars,'fifteenMin':historical_fifteen+current_fifteen,'suspendedDays':old_one['suspendedDays'],'previewFacts':facts,'sources':{'oneMin':'offline_native_1min' if saved_one else 'tdx_native_1min','fifteenMin':'offline_native_15min' if saved_fifteen else 'tdx_native_15min','daily':'live_quote+native_minute'},'liveCoverage':{'oneMinBars':len(current_one),'fifteenMinBars':len(current_fifteen)}}
    payload=cached_series(f'live-stock-hover:v10:{code}:{day}:{revision}',load,3 if phase=='trading' or phase=='closed' and datetime.datetime.now(zone).strftime('%H%M')<'1505' else 60 if phase=='recess' else 1800)
    # Quote/fundamentals are cheap and refresh independently of the native-bar cache.
    facts=live_stock_preview_facts(code,day,payload.get('previewFacts'))
    daily=[{**bar,'turnover_rate_f':facts.get('freeFloatTurnover'),'free_float_market_cap':facts.get('freeFloatMarketCap'),'free_float_market_cap_date':facts.get('freeFloatMarketCapDate')} if datetime.datetime.fromtimestamp(bar['timestamp']/1000,datetime.timezone.utc).strftime('%Y%m%d')==day else bar for bar in payload['daily']]
    return {**payload,**version,'previewFacts':facts,'daily':daily,'livePhase':phase}


def live_stock_preview_facts(code,day,fallback=None):
    """Use today's quote and official basics, or explicitly estimated prior-day shares."""
    def number(value):
        try:
            value=float(value)
            return value if math.isfinite(value) else None
        except (TypeError,ValueError):return None
    facts={'code':code,'date':day,'close':None,'pct':None,'openPct':None,'amplitude':None,'amount':None,'floatMarketCap':None,'totalMarketCap':None,'freeFloatTurnover':None,**(fallback or {}),'estimates':{},'isSealed':False,'sealAmount':None,'sealUpdatedAt':None,'sealSource':None}
    live=live_ladder_snapshot();row=live.get('rows',{}).get(code,{}) if live.get('date')==day else {};detail=live.get('stocks',{}).get(code,{}) if row else {}
    # Offline readiness can retire the ladder overlay while current seal facts
    # are still needed. Reuse the same-day online observations independently.
    if not row:
        observations=online_stock_observations(code,day)
        q,quote_at,_=observations['snapshot'];lp,lp_at,_=observations['limitperformance'];z,zt_at,_=observations['zt']
        now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)));status=live_market_status()
        def valid(at):
            if not at:return False
            local=datetime.datetime.fromtimestamp(at,now.tzinfo)
            return local.strftime('%Y%m%d')==day and (status['phase']=='closed' or status['phase']=='recess' and local.hour>=11 or -5<=now.timestamp()-at<=120)
        q=q if valid(quote_at) else {};lp=lp if valid(lp_at) else {};z=z if valid(zt_at) else {}
        options=[(at,value) for at,value in ((online_stamp(q.get('snapshot_timestamp')),number(q.get('last_price'))),(lp_at,number(lp.get('close_price'))),(zt_at,number(z.get('last_price')))) if at and value and value>0]
        if options:
            _,close=max(options,key=lambda item:item[0])
            with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:limit=c.execute('SELECT up_limit FROM tbl_cn_stk_limit WHERE trade_date=? AND ts_code=?',(day,code)).fetchone()
            sealed=bool(limit and limit[0] and abs(close-float(limit[0]))<.005)
            seal_options=[(at,value,source) for at,value,source in ((lp_at,number(lp.get('limit_order')),'kpl_performance'),(zt_at,number(z.get('seal_money')),'kpl_zt')) if at and value is not None]
            seal_at,seal_value,seal_source=max(seal_options,key=lambda item:item[0]) if seal_options else (None,None,None)
            row={'close':close,'pct_chg':q.get('price_change_ratio_pct',lp.get('pct_chg')),'pre_close':q.get('prev_price'),'daily_open':q.get('open_price'),'daily_high':q.get('high_price'),'daily_low':q.get('low_price'),'volume':q.get('volume'),'amount':q.get('turnover',lp.get('amount'))}
            detail={'isSealed':sealed,'sealAmount':seal_value if sealed else None,'sealSource':seal_source if sealed else None,'sealUpdatedAt':datetime.datetime.fromtimestamp(seal_at,now.tzinfo).isoformat() if sealed and seal_at else None}
    volume=number(row.get('volume')) if number(row.get('volume')) is not None else number(facts.get('volume'));price=number(row.get('close')) or number(facts.get('close'))
    if row:
        for target,source in (('close','close'),('pct','pct_chg'),('amount','amount')):
            value=number(row.get(source))
            if value is not None:facts[target]=value
        base=number(row.get('pre_close'));opening=number(row.get('daily_open'));high=number(row.get('daily_high'));low=number(row.get('daily_low'))
        if base and base>0:
            if opening is not None:facts['openPct']=(opening/base-1)*100
            if high is not None and low is not None:facts['amplitude']=(high-low)/base*100
        facts.update(limitTime=detail.get('time') or facts.get('limitTime'),isSealed=bool(detail.get('isSealed')),sealAmount=number(detail.get('sealAmount')),sealUpdatedAt=detail.get('sealUpdatedAt'),sealSource=detail.get('sealSource'))
    def load_basics():
        with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
            c.row_factory=sqlite3.Row
            today=c.execute('SELECT * FROM tbl_cn_daily_basic WHERE trade_date=? AND ts_code=?',(day,code)).fetchone()
            previous=c.execute('SELECT MAX(trade_date) FROM tbl_cn_day WHERE trade_date<?',(day,)).fetchone()[0]
            prior=c.execute('SELECT b.*,d.vol AS prior_vol FROM tbl_cn_daily_basic b LEFT JOIN tbl_cn_day d ON d.trade_date=b.trade_date AND d.ts_code=b.ts_code WHERE b.trade_date=? AND b.ts_code=?',(previous,code)).fetchone() if previous else None
        return {'today':dict(today) if today else {},'prior':dict(prior) if prior else {}}
    basics=cached_series('live-stock-fundamentals:v1:'+day+':'+code+':'+database_revision((BASIC_DB,)),load_basics,300)
    today=basics['today'];prior=basics['prior'];basis_date=prior.get('trade_date')
    # The minute cursor uses raw turnover yuan / raw free-float cap yuan.
    # Keep each day's official denominator; if today's is absent, reuse yesterday's.
    facts['freeFloatMarketCap']=None;facts['freeFloatMarketCapDate']=None
    for basic in (today,prior):
        shares=number(basic.get('free_share'));close=number(basic.get('close'))
        if shares and shares>0 and close and close>0:
            facts['freeFloatMarketCap']=shares*close*10000
            facts['freeFloatMarketCapDate']=basic.get('trade_date')
            break
    for field,column in (('floatMarketCap','circ_mv'),('totalMarketCap','total_mv'),('freeFloatTurnover','turnover_rate_f')):
        exact=number(today.get(column))
        if exact is not None:facts[field]=exact*(1 if field=='freeFloatTurnover' else 10000)
    if price and price>0 and prior:
        for field,share_column,mv_column in (('floatMarketCap','float_share','circ_mv'),('totalMarketCap','total_share','total_mv')):
            if number(today.get(mv_column)) is not None:continue
            shares=number(prior.get(share_column));old_cap=number(prior.get(mv_column));old_close=number(prior.get('close'))
            if (shares is None or shares<=0) and old_cap is not None and old_close and old_close>0:shares=old_cap/old_close
            if shares and shares>0:
                facts[field]=price*shares*10000
                facts['estimates'][field]={'basisDate':basis_date,'method':'previous_trading_day_shares_x_current_price'}
    if number(today.get('turnover_rate_f')) is None and prior and volume is not None and volume>=0:
        free_shares=number(prior.get('free_share'));denominator=free_shares*10000 if free_shares and free_shares>0 else None
        if denominator is None:
            prior_volume=number(prior.get('prior_vol'));prior_turnover=number(prior.get('turnover_rate_f'))
            if prior_volume and prior_volume>0 and prior_turnover and prior_turnover>0:denominator=prior_volume*100/(prior_turnover/100)
        if denominator and denominator>0:
            facts['freeFloatTurnover']=volume/denominator*100
            facts['estimates']['freeFloatTurnover']={'basisDate':basis_date,'method':'current_cumulative_shares_over_previous_free_shares'}
    return facts


def offline_ladder_ready(day):
    """Only hand over when daily prices cover today's pool and yesterday's promotion cohort."""
    if published_ladder_metadata():
        return LADDER_STORE.contains(day)
    version=database_revision((BASIC_DB,KPL_DB));key='ladder-offline-ready:v2:'+day+':'+version
    cached=CACHE.get(key)
    if cached is not None:return cached
    ready=False
    try:
        if day in market_data_dates():
            with closing(sqlite3.connect(f'file:{KPL_DB}?mode=ro',uri=True,timeout=3)) as c:
                expected=set()
                for table,condition in [('tbl_cn_kpl_limit_performance',''),('tbl_cn_kpl_list'," AND tag='涨停'"),('tbl_cn_limit_list'," AND \"limit\"='U'")]:
                    if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():expected.update(row[0] for row in c.execute(f'SELECT ts_code FROM {table} WHERE trade_date=?'+condition,(day,)))
            with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
                previous=c.execute('SELECT MAX(trade_date) FROM tbl_cn_day WHERE trade_date<?',(day,)).fetchone()[0]
                expected.update(row[0] for row in c.execute('SELECT d.ts_code FROM tbl_cn_day d JOIN tbl_cn_stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date WHERE d.trade_date=? AND l.up_limit>0 AND abs(d.close-l.up_limit)<.005',(previous,)))
                actual={row[0] for row in c.execute('SELECT d.ts_code FROM tbl_cn_day d JOIN tbl_cn_stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date WHERE d.trade_date=? AND d.close IS NOT NULL',(day,))}
                suspended={row[0] for row in c.execute("SELECT ts_code FROM tbl_cn_suspend WHERE trade_date=? AND suspend_type='S' AND coalesce(suspend_timing,'')=''",(day,))}
                ready=bool(actual) and expected.issubset(actual|suspended)
    except sqlite3.Error:pass
    CACHE.set(key,ready,86400 if ready else 60);return ready


def online_stamp(value):
    try:
        result=float(value);return result/1000 if result>1e12 else result
    except (TypeError,ValueError):
        try:
            result=datetime.datetime.fromisoformat(str(value));zone=datetime.timezone(datetime.timedelta(hours=8))
            return (result if result.tzinfo else result.replace(tzinfo=zone)).timestamp()
        except (ValueError,TypeError):return 0


def _read_online_close_uncached(kind,day,client=None):
    """Redis last batch first, with durable online SQLite fallback after archive expiry."""
    zone=datetime.timezone(datetime.timedelta(hours=8));field=kind+'_timestamp'
    def same_day(value):return value and datetime.datetime.fromtimestamp(value,zone).strftime('%Y%m%d')==day
    try:
        if client is not None:
            last=client.zrevrange('online:'+kind+':timeline',0,0,withscores=True)
            latest=online_stamp(last[0][1]) if last else 0
            count,at=client.hmget('online:meta',kind+'_last_count',kind+'_last_ts')
            if at and at.startswith('"'):at=json.loads(at)
            zero=online_stamp(at)
            if count is not None and int(count)==0 and same_day(zero) and zero>=latest:return {},zero,'redis-empty'
            if last and same_day(latest):
                archive=client.hgetall(last[0][0])
                if archive:return {code:json.loads(raw) for code,raw in archive.items()},latest,'redis-archive'
                entries=client.xrevrange('online:'+kind+':stream',count=5000)
                if entries:
                    latest=online_stamp(entries[0][1].get(field));rows={}
                    if same_day(latest):
                        for _,row in entries:
                            if online_stamp(row.get(field))<latest-(60 if kind in ('snapshot','snapshot_index') else 0):break
                            if row.get('ts_code'):rows.setdefault(row['ts_code'],dict(row))
                        if rows:return rows,latest,'redis-stream'
    except Exception:pass
    database=DBROOT/'online'/('online_data_'+day[:6]+'.db');table=kind+'_'+day
    if not database.exists():return {},None,'unavailable'
    try:
        with closing(sqlite3.connect(f'file:{database}?mode=ro',uri=True,timeout=3)) as c:
            c.row_factory=sqlite3.Row
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():return {},None,'unavailable'
            actual_field='snapshot_timestamp' if kind=='snapshot_index' else field
            latest=c.execute(f'SELECT MAX({actual_field}) FROM {table} WHERE trade_date=?',(day,)).fetchone()[0]
            stamp=online_stamp(latest)
            if not same_day(stamp):return {},None,'unavailable'
            if kind in ('snapshot','snapshot_index'):
                lower=datetime.datetime.fromtimestamp(stamp-60,zone).isoformat(timespec='milliseconds')
                records=c.execute(f'SELECT * FROM {table} WHERE trade_date=? AND {actual_field}>=? AND {actual_field}<=? ORDER BY {actual_field}',(day,lower,latest))
            else:records=c.execute(f'SELECT * FROM {table} WHERE {actual_field}=?',(latest,))
            rows={}
            for record in records:
                row=dict(record);row[field]=online_stamp(row[actual_field]);rows[row['ts_code']]=row
            return rows,stamp,'online-sqlite'
    except sqlite3.Error:return {},None,'unavailable'


def live_ladder_snapshot():
    """Read-only intraday overlay. Never write live observations to the offline graph."""
    status=live_market_status();day=status['date'];now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).timestamp()
    empty={'date':day,'available':False,'status':status,'reason':'当前不在盘中或没有新鲜快照'}
    closed=status['phase']=='closed' and datetime.datetime.fromtimestamp(now,datetime.timezone(datetime.timedelta(hours=8))).hour>=15
    ready=offline_ladder_ready(day) if closed else False
    empty.update(offlineReady=ready,mode='offline' if ready else 'close' if closed else 'live')
    if ready:return {**empty,'reason':'当日离线行情已就绪'}
    if status['phase'] not in ('trading','recess') and not closed:return empty
    cache_key='ladder-live-snapshot:v5:'+day+(':'+database_revision((BASIC_DB,KPL_DB)) if closed else '')
    cached=CACHE.get(cache_key)
    if cached is not None:return cached
    try:
        import redis
        r=redis.Redis(host='127.0.0.1',port=6380,decode_responses=True,socket_connect_timeout=.5,socket_timeout=2)
        stamp=online_stamp
        source_kinds={}
        def read(kind,age):
            if closed:
                rows,at,source=read_online_close(kind,day,r);source_kinds[kind]=source;return rows,at
            last=r.zrevrange('online:'+kind+':timeline',0,0,withscores=True)
            if not last:return {},None
            key,t=last[0];t=stamp(t)
            # Writers may omit an empty archive. A newer zero-count round must
            # not resurrect the preceding non-empty pool.
            count,at=r.hmget('online:meta',kind+'_last_count',kind+'_last_ts')
            try:
                at=json.loads(at) if at and at.startswith('"') else at
                meta_time=datetime.datetime.fromisoformat(at)
                if meta_time.tzinfo is None:meta_time=meta_time.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
                if int(count)==0 and meta_time.timestamp()>=t:return {},None
            except (TypeError,ValueError):pass
            allowed_age=max(age,now-datetime.datetime.strptime(day+'110000','%Y%m%d%H%M%S').replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()) if status['phase']=='recess' else age
            if datetime.datetime.fromtimestamp(t,datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d')!=day or not -5<=now-t<=allowed_age:return {},None
            if not r.exists(key):
                if status['phase']!='recess':return {},None
                # Pool archives expire after 5 minutes. The independent source
                # stream retains the complete last morning batch across lunch.
                entries=r.xrevrange('online:'+kind+':stream',count=5000)
                if not entries:return {},None
                field=kind+'_timestamp';latest_stamp=stamp(entries[0][1].get(field));result={}
                if not latest_stamp or datetime.datetime.fromtimestamp(latest_stamp,datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d')!=day:return {},None
                for _,fields in entries:
                    if stamp(fields.get(field))!=latest_stamp:break
                    code=fields.get('ts_code')
                    if code:result[code]=dict(fields)
                return result,latest_stamp
            result={}
            for code,raw in r.hgetall(key).items():
                try:result[code]=json.loads(raw)
                except (ValueError,TypeError):pass
            return result,t
        zt,zt_time=read('zt',180);broken,break_time=read('break',180);performance,lp_time=read('limitperformance',120);quotes,quote_time=read('snapshot',45)
        if zt_time is None and lp_time is None:
            previous=CACHE.get('ladder-live-last:v1:'+day) if status['phase']=='recess' or closed else None
            return {**previous,'status':status,'frozen':True,'mode':'close' if closed else 'live','offlineReady':False} if previous else empty
        with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
            limits={code:(up,down) for code,up,down in c.execute('SELECT ts_code,up_limit,down_limit FROM tbl_cn_stk_limit WHERE trade_date=?',(day,))}
            names=dict(c.execute('SELECT ts_code,name FROM tbl_cn_basic'))
            previous=c.execute('SELECT MAX(trade_date) FROM tbl_cn_day WHERE trade_date<?',(day,)).fetchone()[0]
            prior_sealed={row[0] for row in c.execute('SELECT d.ts_code FROM tbl_cn_day d JOIN tbl_cn_stk_limit l ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code WHERE d.trade_date=? AND l.up_limit>0 AND abs(d.close-l.up_limit)<.005',(previous,))}
        if not limits:return empty
        rows={};sealed={};failed={};details={}
        for code in set(zt)|set(broken)|set(performance)|set(quotes):
            lp=performance.get(code,{});z=zt.get(code,{});b=broken.get(code,{});q=quotes.get(code,{})
            options=[]
            for item,field,t in ((z,'last_price',zt_time),(b,'last_price',break_time),(lp,'close_price',lp_time),(q,'last_price',stamp(q.get('snapshot_timestamp')))):
                try:
                    price=float(item.get(field));t=stamp(t)
                    if price>0 and t and datetime.datetime.fromtimestamp(t,datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d')==day and (closed or -5<=now-t<=(max(180,now-datetime.datetime.strptime(day+'110000','%Y%m%d%H%M%S').replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()) if status['phase']=='recess' else 180)):options.append((t,price,item))
                except (TypeError,ValueError):pass
            if not options:continue
            t,price,item=max(options,key=lambda v:v[0]);up,down=limits.get(code,(None,None))
            if not up or up<=0:continue
            is_sealed=abs(price-float(up))<.005
            high=q.get('high_price');touched=is_sealed or bool(z or b or lp) or high is not None and float(high)>=float(up)-.005
            pct=item.get('price_change_ratio_pct',item.get('pct_chg'));pct=float(pct) if pct is not None else None
            name=lp.get('name') or z.get('name') or b.get('name') or names.get(code,code)
            pattern=lp.get('board_period') or z.get('continue_day_text') or '';count=int(lp.get('board_count') or z.get('continue_day_cnt') or 1)
            if not re.fullmatch(r'\d+天\d+板',pattern):pattern=''
            theme=str(lp.get('theme') or '').strip() or '暂无题材'
            time=lp.get('lu_time') or z.get('limit_up_time') or ''
            if online_stamp(time):time=datetime.datetime.fromtimestamp(online_stamp(time),datetime.timezone(datetime.timedelta(hours=8))).strftime('%H:%M:%S')
            if str(time).isdigit() and len(str(time))>=10:time=datetime.datetime.fromtimestamp(float(time),datetime.timezone(datetime.timedelta(hours=8))).strftime('%H:%M:%S')
            if re.fullmatch(r'\d{2}:\d{2}',str(time)):time=str(time)+':00'
            record={'trade_date':day,'ts_code':code,'name':name,'theme':theme,'lu_time':time,'close_price':price,'board_period':pattern}
            rows[code]={'trade_date':day,'ts_code':code,'close':price,'pct_chg':pct,'up_limit':up,'daily_open':q.get('open_price'),'daily_high':high if high is not None else up if touched else price,'daily_low':q.get('low_price'),'daily_close':price,'pre_close':q.get('prev_price'),'down_limit':down,'volume':q.get('volume'),'amount':q.get('turnover') if q.get('turnover') is not None else lp.get('amount')}
            seal_candidates=[(at,value,source) for at,value,source in ((lp_time,lp.get('limit_order'),'kpl_performance'),(zt_time,z.get('seal_money'),'kpl_zt')) if at and value is not None]
            seal_at,seal_money,seal_source=max(seal_candidates,key=lambda item:item[0]) if seal_candidates else (None,None,None)
            details[code]={'pct':pct,'isSealed':is_sealed,'sealAmount':seal_money if is_sealed else None,'sealUpdatedAt':datetime.datetime.fromtimestamp(seal_at,datetime.timezone(datetime.timedelta(hours=8))).isoformat() if is_sealed and seal_at else None,'sealSource':seal_source if is_sealed else None,'time':str(time),'reason':lp.get('limit_reason') or z.get('limit_up_reason') or '', 'reasons':{},'marketReason':lp.get('limit_reason') or '', 'catalysts':{}}
            if is_sealed:sealed[code]=record
            elif touched:failed[code]={**record,'pct':pct}
        latest=max(t for t in [zt_time,break_time,lp_time,quote_time] if t)
        broken_stocks=[{'id':day+':'+code+':broken','date':day,'code':code,'name':v['name'],'theme':v['theme'],'originalTheme':v['theme'],'status':'broken','board':0,'pct':v['pct'],'time':str(v['lu_time']),'isLive':True} for code,v in failed.items() if code not in prior_sealed]
        result={**empty,'reason':'','brokenStocks':broken_stocks,'available':True,'rows':rows,'pool':sealed,'failed':failed,'stocks':details,'updatedAt':datetime.datetime.fromtimestamp(latest,datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'revision':hashlib.sha256(json.dumps([zt_time,break_time,lp_time,quote_time],sort_keys=True).encode()).hexdigest()[:16], 'sources':{'zt':zt_time,'break':break_time,'performance':lp_time,'quotes':quote_time},'ttlSeconds':10,'catalysts':{},'freeFloatTurnoverByCode':{},'indices':[],'reasonAvailable':False,'reasonSource':'kpl_realtime'}
        structure={'sealed':[(code,item['theme'],item['board_period'],item['lu_time']) for code,item in sorted(sealed.items())],
                   'failed':[(code,item['theme']) for code,item in sorted(failed.items())], 'known':sorted(rows),
                   'unpromotedOrder':sorted((code for code in prior_sealed if code in rows and code not in sealed),key=lambda code:(-(rows[code]['pct_chg'] if rows[code]['pct_chg'] is not None else -float('inf')),code))}
        result.update(structureRevision=hashlib.sha256(json.dumps(structure,sort_keys=True).encode()).hexdigest()[:16],frozen=status['phase']=='recess' or closed,mode='close' if closed else 'live',offlineReady=False,sourceKinds=source_kinds)
        CACHE.set(cache_key,result,60 if closed else 10)
        CACHE.set('ladder-live-last:v1:'+day,result,12*3600)
        return result
    except Exception as exc:
        print('live ladder unavailable',type(exc).__name__,str(exc),flush=True);return empty


def limitup_ladder_data(end_date,sessions=5,live=None):
    if published_ladder_metadata():
        try:
            if live and live.get('available'):
                days=[day for day in LADDER_STORE.dates() if day<live['date']]
                base=LADDER_STORE.read(days[-1],max(1,sessions-1)) if days and sessions>1 else {}
                calculator=LadderCalculator(BASIC_DB,KPL_DB)
                calculator._dates=LADDER_STORE.dates()
                current=calculator.calculate(end_date,1,live)
                with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=2)) as c:
                    halted={r[0] for r in c.execute("SELECT ts_code FROM tbl_cn_suspend WHERE trade_date=? AND suspend_type='S' AND coalesce(suspend_timing,'')=''",(end_date,))}
                return overlay_live(base,current,sessions,live['rows'],halted)
            return LADDER_STORE.read(end_date,sessions)
        except (LadderNotReady,sqlite3.Error) as exc:
            print('[ladder] materialized read unavailable; keeping raw-source fallback:',type(exc).__name__,flush=True)
    return _legacy_limitup_ladder_data(end_date,sessions,live)


def ladder_response_data(date,sessions,meta,live=None):
    payload=limitup_ladder_data(date,sessions,live)
    # A generation can commit after the request's initial metadata read.
    # Label the payload with the revision read inside its SQLite snapshot.
    if payload.get('storeRevision'):
        meta={**meta,'ladderDataVersion':'ladder-db-v1:'+payload['storeRevision']}
    return {**payload,**meta}


def _legacy_limitup_ladder_data(end_date,sessions=5,live=None):
    return LadderCalculator(BASIC_DB,KPL_DB).calculate(end_date,sessions,live)


def ladder_stock_facts(date,code):
    """Same-day raw prices and valuation fields for a lazily opened stock preview."""
    def number(value):
        try:
            value=float(value)
            return value if math.isfinite(value) else None
        except (TypeError,ValueError):return None
    def clock(value):
        text=str(value or '').strip()
        if re.fullmatch(r'\d{1,6}',text):
            text=text.zfill(6);text=f'{text[:2]}:{text[2:4]}:{text[4:6]}'
        elif re.fullmatch(r'\d{10,13}',text):
            stamp=int(text)/(1000 if len(text)==13 else 1)
            text=datetime.datetime.fromtimestamp(stamp,datetime.timezone(datetime.timedelta(hours=8))).strftime('%H:%M:%S')
        return text if re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d',text) and text!='00:00:00' else None
    facts={'code':code,'date':date,'priceBasis':'unadjusted','close':None,'pct':None,'amplitude':None,'openPct':None,'limitTime':None,'amount':None,'floatMarketCap':None,'totalMarketCap':None,'freeFloatTurnover':None,'breakTime':None,'breakCount':None,'factsVersion':2}
    with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as c:
        row=c.execute('''SELECT d.close,d.pre_close,d.open,d.high,d.low,d.amount,d.pct_chg,b.circ_mv,b.turnover_rate_f,b.total_mv
            FROM tbl_cn_day d LEFT JOIN tbl_cn_daily_basic b ON b.trade_date=d.trade_date AND b.ts_code=d.ts_code
            WHERE d.trade_date=? AND d.ts_code=?''',(date,code)).fetchone()
    if row:
        close,base,opening,high,low,amount,pct,circ_mv,turnover,total_mv=map(number,row)
        facts.update(close=close,pct=pct,amount=None if amount is None else amount*1000,floatMarketCap=None if circ_mv is None else circ_mv*10000,freeFloatTurnover=turnover,totalMarketCap=None if total_mv is None else total_mv*10000)
        if base and base>0:
            if facts['pct'] is None and close is not None:facts['pct']=(close/base-1)*100
            if opening is not None:facts['openPct']=(opening/base-1)*100
            if high is not None and low is not None:facts['amplitude']=(high-low)/base*100
    with closing(sqlite3.connect(f'file:{KPL_DB}?mode=ro',uri=True,timeout=3)) as c:
        rows=c.execute('''SELECT lu_time,open_time FROM tbl_cn_kpl_list
            WHERE trade_date=? AND ts_code=? AND tag IN ('涨停','炸板')
            ORDER BY CASE tag WHEN '涨停' THEN 0 ELSE 1 END''',(date,code)).fetchall()
        for first,broken in rows:
            facts['limitTime']=facts['limitTime'] or clock(first)
            facts['breakTime']=facts['breakTime'] or clock(broken)
        row=c.execute('''SELECT first_time,open_times FROM tbl_cn_limit_list
            WHERE trade_date=? AND ts_code=? AND "limit" IN ('U','Z')
            ORDER BY CASE "limit" WHEN 'U' THEN 0 ELSE 1 END LIMIT 1''',(date,code)).fetchone()
        if row:
            facts['limitTime']=facts['limitTime'] or clock(row[0]);count=number(row[1])
            if count is not None and count>=0:facts['breakCount']=int(count)
        if not facts['limitTime']:
            row=c.execute('SELECT lu_time FROM tbl_cn_kpl_limit_performance WHERE trade_date=? AND ts_code=?',(date,code)).fetchone()
            if row:facts['limitTime']=clock(row[0])
    return facts


def ladder_topic_stock_details(date):
    """Small on-demand daily facts; ladder membership/boards remain in the loaded graph."""
    stocks={};catalysts={}
    def item(code):
        return stocks.setdefault(str(code),{"sealAmount":None,"pct":None,"reason":"","reasons":{},"catalysts":{}})
    def amount(value):
        try:
            number=float(value)
            return number if math.isfinite(number) and number>=0 else None
        except (TypeError,ValueError):return None
    with closing(sqlite3.connect(f'file:{KPL_DB}?mode=ro',uri=True,timeout=3)) as connection:
        for code,value in connection.execute('SELECT ts_code,limit_order FROM tbl_cn_kpl_limit_performance WHERE trade_date=?',(date,)):
            item(code)['sealAmount']=amount(value)
        for code,value in connection.execute("SELECT ts_code,limit_order FROM tbl_cn_kpl_list WHERE trade_date=? AND tag='涨停'",(date,)):
            parsed=amount(value);stock=item(code)
            if parsed is not None and (parsed>0 or stock['sealAmount'] is None):stock['sealAmount']=parsed
        for code,value in connection.execute('''SELECT ts_code,fd_amount FROM tbl_cn_limit_list WHERE trade_date=? AND "limit"='U' ''',(date,)):
            stock=item(code)
            if stock['sealAmount'] in (None,0) and amount(value) is not None:stock['sealAmount']=amount(value)
    codes=sorted(stocks)
    if codes:
        marks=','.join('?' for _ in codes)
        with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as connection:
            for code,value in connection.execute(f'SELECT ts_code,pct_chg FROM tbl_cn_day WHERE trade_date=? AND ts_code IN ({marks})',[date,*codes]):
                try:
                    number=float(value)
                    if math.isfinite(number):item(code)['pct']=number
                except (TypeError,ValueError):pass
    # One date-level read also covers failed promotions absent from today's KPL pool.
    turnover_rates={}
    with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as connection:
        for code,value in connection.execute('SELECT ts_code,turnover_rate_f FROM tbl_cn_daily_basic WHERE trade_date=?',(date,)):
            parsed=amount(value)
            if parsed is not None:turnover_rates[code]=parsed
    def add_reason(code,theme,bridge,reason):
        theme=str(theme or '').strip();code=str(code or '').strip().upper()
        text=next((str(value).strip() for value in (bridge,reason) if str(value or '').strip() not in ('','—','-','暂无数据','没有数据','暂无分析')),'')
        if code and text:
            stock=item(code)
            if not stock['reason']:stock['reason']=text
            if theme:stock['reasons'].setdefault(theme,text)
    def add_catalyst(theme,value,code=None):
        theme=str(theme or '').strip()
        text=re.sub(r"^\*\*当日共性消息/题材逻辑：\*\*\s*", "", str(value or '')).strip()
        if not theme or text in ('','—','-','暂无数据','没有数据','暂无分析','复盘文档未按该KPL题材单独整理催化摘要。'):return
        catalysts.setdefault(theme,text)
        if code:item(code)['catalysts'].setdefault(theme,text)
    available=True
    review=CACHE.get(review_cache_key(date))
    if review is not None:
        for topic in review.get('topics',[]):
            add_catalyst(topic.get('name'),topic.get('summary'))
            for stock in topic.get('stocks',[]):
                add_reason(stock.get('ts_code'),topic.get('name'),stock.get('bridge'),stock.get('reason'))
                add_catalyst(stock.get('analysis_group_name') or topic.get('name'),stock.get('analysis_group_summary') or topic.get('summary'),stock.get('ts_code'))
    else:
        try:
            from coreClient.neo4j_client import ThemeGraphNeo4jStore
            with ThemeGraphNeo4jStore() as graph:
                for row in graph.list_topic_days(date,date):
                    topic=row.get('topic') or {};summary=row.get('summary') or {}
                    add_catalyst(topic.get('canonical_name') or topic.get('source_heading'),summary.get('catalyst_reason') or summary.get('summary_source_text'))
                rows=graph._run('''MATCH (td:TopicDate)-[a:ATTRIBUTES_LIMITUP]->(s:Stock)
                    MATCH (td)-[:ABOUT_TOPIC]->(t:Topic)
                    WHERE td.trade_date=$date
                    RETURN properties(t) AS topic, properties(s) AS stock, properties(a) AS attribution
                    ORDER BY a.row_order''',{'date':date})
            for row in rows:
                topic=row.get('topic') or {};stock=row.get('stock') or {};attribution=row.get('attribution') or {}
                add_reason(attribution.get('stock_code') or stock.get('stock_code'),topic.get('canonical_name') or topic.get('source_heading'),attribution.get('stock_theme_bridge'),attribution.get('limitup_reason'))
                source_theme=topic.get('canonical_name') or topic.get('source_heading')
                add_catalyst(source_theme,catalysts.get(source_theme),attribution.get('stock_code') or stock.get('stock_code'))
        except Exception as exc:
            available=False
            print('ladder topic attribution unavailable',date,type(exc).__name__,flush=True)
    return {'date':date,'stocks':stocks,'catalysts':catalysts,'freeFloatTurnoverByCode':turnover_rates,'reasonSource':'neo4j','reasonAvailable':available,'ttlSeconds':300 if available else 30}


def ladder_date_stock_details(date, include_details=True):
    """Lazy date-hover supplement; verify broken first boards against raw daily prices."""
    meta=ladder_data_version();key=f"ladder-topic-details:v5:{date}:{meta['ladderDataVersion']}"
    details=CACHE.get(key) if include_details else {'stocks':{},'ttlSeconds':300,**meta}
    if details is None:
        details={**ladder_topic_stock_details(date),**meta};CACHE.set(key,details,details['ttlSeconds'])
    details={**details,'stocks':{code:dict(stock) for code,stock in details['stocks'].items()}}
    with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as connection:
        connection.row_factory=sqlite3.Row
        failures=[]
        for row in connection.execute('''SELECT d.ts_code,d.pct_chg FROM tbl_cn_day d
            JOIN tbl_cn_stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date
            WHERE d.trade_date=? AND l.up_limit>0 AND d.high>=l.up_limit-0.005 AND d.close<l.up_limit-0.005''',(date,)):
            code=row['ts_code']
            prior=connection.execute('''SELECT d.close,l.up_limit FROM tbl_cn_day d
                LEFT JOIN tbl_cn_stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date
                WHERE d.ts_code=? AND d.trade_date<? AND d.vol>0 ORDER BY d.trade_date DESC LIMIT 1''',(code,date)).fetchone()
            failures.append({'code':code,'pct':json_clean(row['pct_chg']),'isPromotionFailure':prior is not None and is_closed_limit_up(prior)})
        names={row[0]:row[1] for row in connection.execute('SELECT ts_code,name FROM tbl_cn_basic')}
    market={}
    def clock(raw):
        value=str(raw or '').strip()
        if re.fullmatch(r'\d{10,13}',value):
            stamp=int(value)/(1000 if len(value)==13 else 1)
            return datetime.datetime.fromtimestamp(stamp,datetime.timezone(datetime.timedelta(hours=8))).strftime('%H:%M:%S')
        if re.fullmatch(r'\d{1,6}',value):
            value=value.zfill(6);return f'{value[:2]}:{value[2:4]}:{value[4:]}'
        return value
    with closing(sqlite3.connect(f'file:{KPL_DB}?mode=ro',uri=True,timeout=3)) as connection:
        for code,name,time,theme,description in connection.execute("SELECT ts_code,name,lu_time,theme,lu_desc FROM tbl_cn_kpl_list WHERE trade_date=? AND tag IN ('涨停','炸板')",(date,)):
            raw=str(description or theme or '').strip()
            market[code]={'name':name or names.get(code) or code[:6],'time':clock(time),'theme':re.split(r'[、,，;；]',raw)[0].strip() or '暂无题材','marketReason':''}
        for code,name,time in connection.execute('''SELECT ts_code,name,first_time FROM tbl_cn_limit_list WHERE trade_date=? AND "limit" IN ('U','Z')''',(date,)):
            value=market.setdefault(code,{'name':name or names.get(code) or code[:6],'time':'','theme':'暂无题材','marketReason':''})
            if not value['time']:value['time']=clock(time)
        for code,name,time,theme,reason in connection.execute('SELECT ts_code,name,lu_time,theme,limit_reason FROM tbl_cn_kpl_limit_performance WHERE trade_date=?',(date,)):
            value=market.setdefault(code,{'name':name or names.get(code) or code[:6],'time':'','theme':'暂无题材','marketReason':''})
            if theme:value['theme']=str(theme).strip()
            if not value['time']:value['time']=clock(time)
            value['marketReason']=str(reason or '').strip()
    for code,extra in market.items():
        stock=details['stocks'].setdefault(code,{'reason':'','reasons':{}})
        stock.update(marketReason=extra['marketReason'],time=extra['time'])
    broken=[];promotion_failures=[]
    for row in failures:
        code=row['code'];extra=market.get(code,{})
        target=promotion_failures if row['isPromotionFailure'] else broken
        target.append({'id':date+':'+code+':broken','date':date,'status':'broken','code':code,'name':extra.get('name') or names.get(code) or code[:6],'theme':extra.get('theme') or '暂无题材','originalTheme':extra.get('theme') or '暂无题材','board':0,'pct':row['pct'],'time':extra.get('time') or ''})
    if include_details:
        details.update(indices=indices(date),marketSummary=ladder_market_summary(date))
    return {**details,'brokenStocks':broken,'promotionFailures':promotion_failures}


def ladder_market_summary(date):
    """Same market-wide cohorts as market_stats; read only today and yesterday."""
    with closing(sqlite3.connect(f'file:{BASIC_DB}?mode=ro',uri=True,timeout=3)) as connection:
        connection.row_factory=sqlite3.Row
        previous=connection.execute('SELECT MAX(trade_date) FROM tbl_cn_day WHERE trade_date<?',(date,)).fetchone()[0]
        rows=connection.execute("""SELECT d.trade_date,d.ts_code,d.close,d.high,l.up_limit
            FROM tbl_cn_day d JOIN tbl_cn_stk_limit l
            ON l.trade_date=d.trade_date AND l.ts_code=d.ts_code
            WHERE d.trade_date IN (?,?)""",(date,previous)).fetchall()
    today=[row for row in rows if row['trade_date']==date]
    sealed={row['ts_code'] for row in today if is_closed_limit_up(row)}
    touched={row['ts_code'] for row in today if row['high'] is not None and row['up_limit'] is not None and float(row['up_limit'])>0 and abs(float(row['high'])-float(row['up_limit']))<0.005}
    prior={row['ts_code'] for row in rows if row['trade_date']==previous and is_closed_limit_up(row)}
    promoted=len(prior & sealed);broken=len(touched-sealed)
    return {'previousDate':previous,'promotionNumerator':promoted,'promotionDenominator':len(prior),
            'promotionRate':promoted/len(prior) if prior else None,'sealed':len(sealed) if today else None,
            'touched':len(touched) if today else None,'broken':broken if today else None,
            'breakRate':broken/len(touched) if touched else None}


def review_cache_key(date):
    revision=database_revision((KPL_DB,BASIC_DB,DBROOT/"offline"/"db_cn_index.db"))
    return f"review:v31:{date}:{revision}"


def review_data(date):
    key=review_cache_key(date)
    complete_key="complete:v4:"+key
    def load():
        report=CACHE.get(key)
        if report is None:
            pool=kpl_pool(date)
            try:
                report=neo4j_review(date)
            except LookupError:
                report={"date":date,"title":f"{date[:4]}年{int(date[4:6])}月{int(date[6:])}日涨停复盘",
                        "conclusion":"暂无数据","topics":[],"totalStocks":0,"analysisSource":"unavailable"}
            report["pool"]=pool
            report["topics"],fallback_topics,unattributed=market_topics(date,report,pool)
            report["totalStocks"]=len({str(stock.get("ts_code") or "").split(".")[0][-6:] for stock in pool.get("stocks",[])})
            report["analysisStatus"]="待补充" if unattributed else "已完成"
            report["unattributedStocks"]=unattributed
            report["indices"]=indices(date)
            CACHE.set(key,report,300)
        if any("amount" not in item for item in report.get("indices",[])):
            report["indices"]=indices(date)
            CACHE.set(key,report,300)
        report["marketStats"]=market_stats(date,report.get("topics",[]),report.get("pool",{}))
        if report["marketStats"].get("sealed") is not None:
            report["pool"]["all_break_stocks"]=report["marketStats"].pop("allBreakStocks")
            report["pool"]["break_stocks"]=report["marketStats"].pop("firstBoardBreakStocks")
        span_stocks=[*report.get("pool",{}).get("stocks",[]),*report.get("pool",{}).get("break_stocks",[]),*report.get("pool",{}).get("all_break_stocks",[]),*report.get("marketStats",{}).get("nonPromotedStocks",[]),*[stock for topic in report.get("topics",[]) for stock in topic.get("stocks",[])]]
        span_cache=previous_limitup_trading_infos([str(stock.get("ts_code") or stock.get("code") or "") for stock in span_stocks if re.fullmatch(r"\d{6}\.(SH|SZ|BJ)",str(stock.get("ts_code") or stock.get("code") or ""))],date)
        for stock in span_stocks:
            info=span_cache.get(str(stock.get("ts_code") or stock.get("code") or ""))
            if info is not None:
                stock["previousLimitUpTradingDays"]=info["days"]
                stock["previousLimitUpHistoricalFirst"]=info["historicalFirst"]
        report["stockConcepts"]=stock_concepts(date)
        return report
    return cached_series(complete_key,load,60)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(WEBROOT),**kw)
    def log_message(self,fmt,*args): print("[http]",fmt%args)
    def send_json(self,obj,status=200,headers=None):
        body=json.dumps(obj,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode()
        encodings={}
        for item in self.headers.get("Accept-Encoding","").lower().split(','):
            parts=item.strip().split(';');quality=1.0
            for parameter in parts[1:]:
                if parameter.strip().startswith('q='):
                    try: quality=float(parameter.strip()[2:])
                    except ValueError: quality=0
            encodings[parts[0].strip()]=quality
        compressed=len(body)>=4096 and encodings.get('gzip',encodings.get('*',0))>0
        if compressed: body=gzip.compress(body,compresslevel=1,mtime=0)
        self.send_response(status)
        self.send_header("Content-Type","application/json; charset=utf-8")
        if not urlparse(self.path).path.startswith("/api/watchlists"):
            self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Vary","Accept-Encoding")
        self.send_header("Cache-Control","no-store")
        for key,value in (headers or {}).items():self.send_header(key,value)
        if compressed: self.send_header("Content-Encoding","gzip")
        self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
    def live_events(self):
        import queue
        token,mailbox=PUSH_HUB.subscribe()
        self.send_response(200);self.send_header('Content-Type','text/event-stream; charset=utf-8')
        self.send_header('Cache-Control','no-cache, no-transform');self.send_header('X-Accel-Buffering','no')
        self.send_header('Connection','keep-alive');self.end_headers();self.connection.settimeout(8)
        def send(kind,payload,identifier=None):
            frame=('id: '+identifier+'\n' if identifier else '')+'event: '+kind+'\ndata: '+json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n\n'
            self.wfile.write(frame.encode());self.wfile.flush()
        try:
            self.wfile.write(b'retry: 3000\n\n');self.wfile.flush()
            send('ready',{'status':live_market_status(),'resync':True,'transport':'sse','ladderStatus':{key:value for key,value in live_ladder_snapshot().items() if key in ('date','available','mode','offlineReady','revision','structureRevision','updatedAt')}})
            while True:
                try:event=mailbox.get(timeout=15)
                except queue.Empty:
                    send('heartbeat',{'status':live_market_status(),'health':PUSH_HUB.status(),'ladderStatus':{key:value for key,value in live_ladder_snapshot().items() if key in ('date','available','mode','offlineReady','revision','structureRevision','updatedAt')}});continue
                send('market',event,event['id'])
        except (BrokenPipeError,ConnectionResetError,TimeoutError,OSError):pass
        finally:PUSH_HUB.unsubscribe(token);self.close_connection=True

    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query)
        try:
            if u.path=='/api/watchlists':return self.send_json(watchlists_store().snapshot())
            if u.path=='/api/live-events':return self.live_events()
            if u.path=='/api/live-push-status':return self.send_json(PUSH_HUB.status())
            if u.path=="/api/ladder-live-status":
                live=live_ladder_snapshot()
                return self.send_json({key:live.get(key) for key in ('date','available','updatedAt','revision','structureRevision','frozen','sources','status','reason','mode','offlineReady','sourceKinds')})
            if u.path=="/api/ladder-version":
                return self.send_json(ladder_data_version())
            if u.path=="/api/index-version":
                return self.send_json(index_data_version())
            if u.path=="/api/live-status":
                return self.send_json(live_market_status())
            if u.path=="/api/live-indices":
                try:
                    group=q.get("group",["0"])[0];period=q.get("period",["oneMin"])[0]
                    if group not in ("0","1") or period not in ("oneMin","fifteenMin","daily","weekly","monthly"):
                        return self.send_json({"error":"指数分组或周期无效"},400)
                    return self.send_json(live_indices_data(int(group),period))
                except Exception:
                    traceback.print_exc()
                    return self.send_json({"error":"指数实时数据暂不可用，请稍后重试"},503)
            if u.path=="/api/live":
                try:
                    return self.send_json(live_monitor_data())
                except Exception:
                    return self.send_json({"error":"实时数据暂不可用，请稍后重试"},503)
            if u.path=="/api/dates":
                live=live_ladder_snapshot()
                return self.send_json({"dates":market_data_dates(),"onlineLadderDate":live['date'] if live.get('available') else None})
            if u.path=="/api/topic-dates":
                topic=(q.get("topic",[""])[0] or "").strip()
                if not topic: return self.send_json({"error":"topic is required"},400)
                return self.send_json({"topic":topic,"dates":topic_market_dates(topic),**ladder_data_version()})
            if u.path=="/api/ladder-breaks":
                start=safe_date(q.get("start",[""])[0]);end=safe_date(q.get("end",[""])[0]);meta=ladder_data_version()
                dates=[day for day in market_data_dates() if start<=day<=end]
                if len(dates)>30:raise ValueError("单次破板窗口最多30个交易日")
                if published_ladder_metadata():
                    try:
                        stored=LADDER_STORE.broken(start,end)
                        return self.send_json({**stored,**meta,'ladderDataVersion':'ladder-db-v1:'+stored['storeRevision']})
                    except (LadderNotReady,sqlite3.Error):pass
                rows=[]
                for day in dates:
                    key=f"ladder-breaks:v1:{day}:{meta['ladderDataVersion']}"
                    items=cached_series(key,lambda:ladder_date_stock_details(day,include_details=False)['brokenStocks'],300)
                    rows.extend(items)
                return self.send_json({'dates':dates,'brokenStocks':rows,**meta})
            if u.path=="/api/ladder-date-details":
                live=live_ladder_snapshot()
                if safe_date(q.get('date',[''])[0])==live['date'] and live.get('available'):
                    info={key:live[key] for key in ('date','stocks','catalysts','freeFloatTurnoverByCode','indices','reasonAvailable','reasonSource','ttlSeconds','brokenStocks')}
                    return self.send_json({**info,**ladder_data_version(),'indices':live_ladder_index_quotes(live['date']),'promotionFailures':[]})
                date=safe_date(q.get("date",[""])[0]);meta=ladder_data_version()
                key=f"ladder-date-details:v3:{date}:{meta['ladderDataVersion']}:{database_revision((DBROOT / 'offline' / 'db_cn_index.db',))}"
                payload=CACHE.get(key)
                if payload is None:
                    payload=ladder_date_stock_details(date)
                    CACHE.set(key,payload,payload['ttlSeconds'])
                return self.send_json(payload)
            if u.path=="/api/ladder-topic-details":
                live=live_ladder_snapshot()
                if safe_date(q.get('date',[''])[0])==live['date'] and live.get('available'):
                    info={key:live[key] for key in ('date','stocks','catalysts','freeFloatTurnoverByCode','indices','reasonAvailable','reasonSource','ttlSeconds','brokenStocks')}
                    return self.send_json({**info,**ladder_data_version(),'indices':live_ladder_index_quotes(live['date']),'promotionFailures':[]})
                date=safe_date(q.get("date",[""])[0]);meta=ladder_data_version()
                key=f"ladder-topic-details:v5:{date}:{meta['ladderDataVersion']}"
                payload=CACHE.get(key)
                if payload is None:
                    payload={**ladder_topic_stock_details(date),**meta}
                    CACHE.set(key,payload,payload['ttlSeconds'])
                return self.send_json(payload)
            if u.path=="/api/limitup-ladder":
                date=safe_date(q.get("date",[""])[0]);sessions=int(q.get("sessions",["5"])[0])
                if not 1<=sessions<=30:raise ValueError("天梯窗口支持1至30个交易日")
                meta=ladder_data_version();live=live_ladder_snapshot()
                if date==live['date'] and live.get('available'):
                    key=f"limitup-ladder-live:v7:{date}:{sessions}:{live['revision']}:{meta['ladderDataVersion']}"
                    payload=cached_series(key,lambda:{**ladder_response_data(date,sessions,meta,live),'cacheTtlSeconds':10},10)
                    return self.send_json(payload)
                key=f"limitup-ladder:v17:{date}:{sessions}:{meta['ladderDataVersion']}"
                today=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d")
                ttl=24*3600 if published_ladder_metadata() else (300 if date>=today else 24*3600)
                payload=CACHE.get(key);hit=payload is not None
                if payload is None:
                    payload=cached_series(key,lambda:{**ladder_response_data(date,sessions,meta),"cacheTtlSeconds":ttl},ttl)
                return self.send_json({**payload,"cacheBackend":CACHE.backend,"cacheHit":hit})
            if u.path=="/api/review":
                date=safe_date(q.get("date",[""])[0])
                return self.send_json(review_data(date))
            if u.path=="/api/topic_daily_kline":
                date=safe_date(q.get("date",[""])[0])
                codes=list(dict.fromkeys(code for code in q.get("codes",[""])[0].split(",") if re.fullmatch(r"\d{6}\.(SH|SZ|BJ)",code)))
                if len(codes)>100: raise ValueError("单次日K缩略图查询最多支持100只股票")
                cache_key=f"topic-daily-kline-v3:{date}:{'|'.join(codes)}:{stock_data_version()['stockDataVersion']}"
                def load_topic_daily_kline():
                    if not codes: return {"date":date,"series":{}}
                    end=datetime.datetime.strptime(date,"%Y%m%d").date()
                    start=(end-datetime.timedelta(days=90)).strftime("%Y%m%d")
                    frame=get_day(ts_codes=codes,start_date=start,end_date=date,qfq=True,source="database_only")
                    series={}
                    if frame is None or frame.empty: return {"date":date,"series":series}
                    frame=frame.sort_values("trade_date").groupby("ts_code",sort=False).tail(20)
                    for code,group in frame.groupby("ts_code",sort=False):
                        bars=[]
                        for row in group.itertuples(index=False):
                            try: bar=[float(row.open),float(row.high),float(row.low),float(row.close),float(row.vol)]
                            except (TypeError,ValueError,AttributeError): continue
                            if all(__import__("math").isfinite(value) for value in bar): bars.append(bar)
                        if bars: series[str(code)]=bars[-20:]
                    return {"date":date,"series":series}
                return self.send_json(cached_series(cache_key,load_topic_daily_kline,7*24*3600))
            if u.path=="/api/topic_intraday":
                date=safe_date(q.get("date",[""])[0])
                codes=list(dict.fromkeys(code for code in q.get("codes",[""])[0].split(",") if re.fullmatch(r"\d{6}\.(SH|SZ|BJ)",code)))
                if len(codes)>100: raise ValueError("单次分时查询最多支持100只股票")
                cache_key=f"topic-minute-v5:{date}:{'|'.join(codes)}:{stock_data_version()['stockDataVersion']}"
                def load_topic_intraday():
                    if not codes: return {"date":date,"series":{}}
                    placeholders=','.join('?' for _ in codes)
                    with closing(sqlite3.connect(f"file:{BASIC_DB}?mode=ro",uri=True,timeout=3)) as c:
                        limits={str(code):(float(preclose),float(down),float(up)) for code,preclose,down,up in c.execute(f"SELECT d.ts_code,d.pre_close,l.down_limit,l.up_limit FROM tbl_cn_day d JOIN tbl_cn_stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date WHERE d.trade_date=? AND d.ts_code IN ({placeholders}) AND d.pre_close>0 AND l.down_limit>0 AND l.up_limit>0",[date,*codes]).fetchall()}
                    frame=get_oneMin(ts_codes=codes,trade_date=date,columns=["ts_code","datetime","close","vol"])
                    frame=filter_after_close(frame)
                    series={}
                    if frame is None or frame.empty: return {"date":date,"series":series}
                    for code,group in frame.sort_values("datetime").groupby("ts_code",sort=False):
                        code=str(code); bounds=limits.get(code)
                        if not bounds: continue
                        base,down_limit,up_limit=bounds
                        lower=(down_limit/base-1)*100; upper=(up_limit/base-1)*100
                        points=[]; volumes=[]
                        for close,volume in zip(group["close"],group["vol"]):
                            try: close=float(close)
                            except (TypeError,ValueError): continue
                            try: volume=float(volume)
                            except (TypeError,ValueError): volume=0.0
                            points.append(round((close/base-1)*100,4)); volumes.append(max(0.0,volume))
                        if points: series[code]={"points":points,"volumes":volumes,"lower":round(lower,4),"upper":round(upper,4)}
                    return {"date":date,"series":series}
                return self.send_json(cached_series(cache_key,load_topic_intraday,300))
            if u.path=="/api/market_turnover":
                date=safe_date(q.get("date",[""])[0])
                def load_market_turnover():
                    import math
                    start=(datetime.datetime.strptime(date,"%Y%m%d").date()-datetime.timedelta(days=370)).strftime("%Y%m%d")
                    def amounts(code):
                        frame=get_index_daily(ts_code=code,start_date=start,end_date=date,source="database_only")
                        if frame is None or frame.empty: return {}
                        result={}
                        for row in frame.itertuples(index=False):
                            day=str(row.trade_date).replace("-","")
                            try: amount=float(row.amount)
                            except (AttributeError,TypeError,ValueError): continue
                            if re.fullmatch(r"20\d{6}",day) and day<=date and math.isfinite(amount) and amount>=0:
                                result[day]=amount
                        return result
                    sh=amounts("000001.SH"); sz=amounts("399106.SZ")
                    dates=sorted(sh.keys() & sz.keys())[-120:]
                    # Index daily amount uses thousands of yuan, matching the index cards.
                    days=[{"date":day,"amount":round((sh[day]+sz[day])*1000)} for day in dates]
                    return {"date":date,"basis":"000001.SH+399106.SZ","days":days}
                ttl=300 if date==datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d") else 7*24*3600
                return self.send_json(cached_series(f"market-turnover:v4:{date}:{index_data_version()['indexDataVersion']}",load_market_turnover,ttl))
            if u.path=="/api/indices_overview":
                date=safe_date(q.get("date",[""])[0])
                codes=("000001.SH","399001.SZ","399006.SZ","000688.SH","000300.SH","000016.SH","000905.SH","000852.SH")
                def load_indices_overview():
                    import math
                    start=(datetime.datetime.strptime(date,"%Y%m%d").date()-datetime.timedelta(days=65)).strftime("%Y%m%d")
                    series={}
                    for code in codes:
                        result={"daily":[],"intraday":None}
                        try:
                            daily=get_index_daily(ts_code=code,start_date=start,end_date=date,source="database_only")
                            if daily is not None and not daily.empty:
                                daily=daily.sort_values("trade_date")
                                for row in daily.tail(20).itertuples(index=False):
                                    try: bar=[float(row.open),float(row.high),float(row.low),float(row.close),float(row.vol)]
                                    except (AttributeError,TypeError,ValueError): continue
                                    if all(math.isfinite(value) for value in bar): result["daily"].append(bar)
                                previous=daily[daily["trade_date"].astype(str)<date]
                                base=float(previous.iloc[-1]["close"]) if not previous.empty else None
                                if base is not None and (not math.isfinite(base) or base<=0): base=None
                            else: base=None
                            if base:
                                minute=get_index_oneMin(ts_code=code,trade_date=date,source="database_only")
                                minute=filter_after_close(minute)
                                if minute is not None and not minute.empty:
                                    points=[]; volumes=[]
                                    for row in minute.sort_values("datetime").itertuples(index=False):
                                        try: close=float(row.close); amount=float(row.amount)
                                        except (AttributeError,TypeError,ValueError): continue
                                        if math.isfinite(close) and math.isfinite(amount):
                                            points.append(round((close/base-1)*100,4))
                                            volumes.append(max(0,amount))
                                    if points: result["intraday"]={"points":points,"volumes":volumes}
                        except Exception as exc:
                            print(f"index overview unavailable {code} {date}: {type(exc).__name__}: {exc}",flush=True)
                        series[code]=result
                    return {"date":date,"series":series}
                ttl=300 if date==datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d") else 7*24*3600
                return self.send_json(cached_series(f"indices-overview:v2:{date}:{index_data_version()['indexDataVersion']}",load_indices_overview,ttl))
            if u.path=="/api/index":
                code=q.get("code",[""])[0].upper(); date=safe_date(q.get("date",[""])[0])
                index_names={"000001.SH":"上证指数","399001.SZ":"深证成指","399006.SZ":"创业板指","000688.SH":"科创50","000300.SH":"沪深300","000016.SH":"上证50","000905.SH":"中证500","000852.SH":"中证1000"}
                if code not in index_names: raise ValueError("指数代码无效")
                version=index_data_version()
                key=f"index-series:v5:{version['indexDataVersion']}:{code}:{date}"
                def load_index():
                    import pandas as pd
                    end=datetime.datetime.strptime(date,"%Y%m%d").date()
                    try:
                        source=get_index_daily(ts_code=code,start_date="19900101",end_date=date,source="database_only")
                    except Exception as exc:
                        print(f"index daily unavailable {code} {date}: {type(exc).__name__}: {exc}",flush=True)
                        source=pd.DataFrame()
                    if source is None or source.empty:
                        daily_frame=pd.DataFrame()
                    else:
                        daily_frame=source.copy().sort_values("trade_date")
                    daily_start=(end-datetime.timedelta(days=2*366)).strftime("%Y%m%d")
                    weekly_start=(end-datetime.timedelta(days=5*366)).strftime("%Y%m%d")
                    daily_rows=daily_frame[daily_frame["trade_date"].astype(str)>=daily_start] if not daily_frame.empty else daily_frame
                    weekly_rows=daily_frame[daily_frame["trade_date"].astype(str)>=weekly_start] if not daily_frame.empty else daily_frame
                    daily=compact(daily_rows,"trade_date")
                    period_store=IndexPeriodStore()
                    weekly=compact(pd.DataFrame(period_store.as_of_rows(code,"weekly",date,start_date=weekly_start)),"trade_date")
                    monthly=compact(pd.DataFrame(period_store.as_of_rows(code,"monthly",date)),"trade_date")
                    minute_start=(end-datetime.timedelta(days=14)).strftime("%Y%m%d")
                    minute_frame=pd.DataFrame()
                    minute_error=None
                    try:
                        minute_frame=get_index_oneMin(ts_code=code,start_date=minute_start,end_date=date,source="database_only")
                        if minute_frame is not None and not minute_frame.empty:
                            minute_frame=filter_after_close(minute_frame.copy())
                            minute_frame=minute_frame.dropna(subset=["close"])
                            if "trade_date" in minute_frame.columns:
                                minute_days=sorted(minute_frame["trade_date"].astype(str).unique())
                                minute_frame=minute_frame[minute_frame["trade_date"].astype(str).isin(minute_days[-5:])]
                            # Native index raw vol is not shares. Display source
                            # turnover in yuan in the minute charts' lower pane.
                            minute_frame["volume"]=minute_frame["amount"]
                            minute_frame["datetime"]=minute_frame["datetime"].astype(str)+"+08:00"
                    except Exception as exc:
                        print(f"index minute unavailable {code} {date}: {type(exc).__name__}: {exc}",flush=True)
                        minute_error=f"{type(exc).__name__}: {exc}"
                        minute_frame=pd.DataFrame()
                    one_min=compact(minute_frame,"datetime") if not minute_frame.empty else []
                    fifteen_frame=pd.DataFrame()
                    fifteen_error=None
                    try:
                        fifteen_frame=get_index_fifteenMin(ts_code=code,start_date=shift_months(end,3).strftime("%Y%m%d"),end_date=date,source="database_only")
                        if fifteen_frame is not None and not fifteen_frame.empty:
                            fifteen_frame=filter_after_close(fifteen_frame.copy())
                            fifteen_frame["volume"]=fifteen_frame["amount"]
                            fifteen_frame["datetime"]=fifteen_frame["datetime"].astype(str)+"+08:00"
                    except Exception as exc:
                        print(f"index native 15-minute unavailable {code} {date}: {type(exc).__name__}: {exc}",flush=True)
                        fifteen_error=f"{type(exc).__name__}: {exc}"
                        fifteen_frame=pd.DataFrame()
                    fifteen=compact(fifteen_frame,"datetime") if not fifteen_frame.empty else []
                    minute_dates=sorted(minute_frame["trade_date"].astype(str).unique()) if not minute_frame.empty and "trade_date" in minute_frame.columns else []
                    fifteen_dates=sorted(fifteen_frame["trade_date"].astype(str).unique()) if not fifteen_frame.empty else []
                    return {"code":code,"name":index_names[code],"date":date,"daily":daily,"weekly":weekly,"monthly":monthly,"oneMin":one_min,"fifteenMin":fifteen,"coverage":{"oneMinBars":len(one_min),"oneMinDays":len(minute_dates),"oneMinStart":minute_dates[0] if minute_dates else None,"oneMinEnd":minute_dates[-1] if minute_dates else None,"fifteenDays":len(fifteen_dates),"fifteenStart":fifteen_dates[0] if fifteen_dates else None,"fifteenEnd":fifteen_dates[-1] if fifteen_dates else None,"oneMinError":minute_error,"fifteenError":fifteen_error},"sources":{"daily":"index_daily_database","weekly":"index_weekly_database","monthly":"index_monthly_database","minute":"tdx_native_index_1min","fifteenMin":"tdx_native_index_15min","minuteVolumeMetric":"source_turnover_yuan"}}
                payload=cached_series(key,load_index,300 if date==datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d") else 7*24*3600)
                return self.send_json({**payload,**version})
            if u.path=="/api/stock-version":
                return self.send_json(stock_data_version())
            if u.path=="/api/live-stock-chart":
                code=q.get('code',[''])[0];date=safe_date(q.get('date',[''])[0])
                if not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)',code):raise ValueError('股票代码无效')
                return self.send_json(live_stock_chart(code,date))
            if u.path=="/api/stock-facts":
                code=q.get("code",[""])[0];date=safe_date(q.get("date",[""])[0])
                if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)",code):raise ValueError("股票代码无效")
                meta=ladder_data_version()
                if date==live_market_status()['date']:
                    return self.send_json({**live_stock_preview_facts(code,date,ladder_stock_facts(date,code)),**meta,**stock_data_version()})
                key=f"ladder-stock-facts:v2:{date}:{code}:{meta['ladderDataVersion']}"
                payload=CACHE.get(key)
                if payload is None:
                    payload={**ladder_stock_facts(date,code),**meta};CACHE.set(key,payload,300)
                return self.send_json({**payload,**stock_data_version()})
            if u.path=="/api/stock-preview":
                code=q.get('code',[''])[0];date=safe_date(q.get('date',[''])[0])
                if not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)',code):raise ValueError('股票代码无效')
                payload,hit=stock_preview(code,date)
                return self.send_json(payload,headers={'X-Chart-Cache':'process-memory' if hit else 'source-load'})
            if u.path=="/api/stock-daily-preload":
                date=safe_date(q.get('date',[''])[0]);codes=list(dict.fromkeys(q.get('codes',[''])[0].split(',')))
                if not 1<=len(codes)<=6 or any(not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)',code) for code in codes):raise ValueError('每批预加载1到6只股票')
                from concurrent.futures import ThreadPoolExecutor
                pool=_daily_preload_pool
                if pool is None:raise RuntimeError('Daily preload pool unavailable')
                futures={code:pool.submit(stock_daily_payload,code,date) for code in codes};items=[];errors=[]
                for code,future in futures.items():
                    try:items.append(future.result())
                    except Exception as exc:errors.append({'code':code,'error':type(exc).__name__})
                return self.send_json({'items':items,'errors':errors,**stock_data_version()})
            if u.path=="/api/chart-cache-status":
                return self.send_json({'backend':CACHE.backend,'dailyWarm':dict(_daily_warm_status),'registeredStocks':CACHE.redis.zcard('stock-daily-hot:v1') if CACHE.redis else len(_daily_hot),'activeCacheLoads':_cache_load_locks.active_keys})
            if u.path=="/api/stock":
                code=q.get("code",[""])[0]; date=safe_date(q.get("date",[""])[0]); latest=False
                if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)",code): raise ValueError("股票代码无效")
                if latest:
                    date=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d")
                version=stock_data_version()
                def load_stock():
                    end=datetime.datetime.strptime(date,"%Y%m%d").date(); start_1m=(end-datetime.timedelta(days=14)).strftime("%Y%m%d"); start_15m=shift_months(end,3).strftime("%Y%m%d")
                    freshness="latest:" if latest else ""
                    ttl=300 if latest else 7*24*3600
                    latest_day=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
                    latest_end=latest_day.strftime("%Y%m%d")
                    from stock_period_basis import latest_anchor
                    basis_future=_chart_read_pool.submit(stock_series_latest,code,latest_end,True,date)
                    adjustment_base=latest_anchor(BASIC_DB,code,latest_end)[1]
                    basis_tag=f"{latest_end}:{adjustment_base}:{version['stockDataVersion']}"
                    one_key=f"series:v7:{code}:minute:5d:qfq:{basis_tag}:{freshness}{date}"
                    fifteen_key=f"series:v6:{code}:fifteen-minute:3m:qfq:{basis_tag}:{freshness}{date}"
                    latest_start_1m=(latest_day-datetime.timedelta(days=14)).strftime("%Y%m%d")
                    latest_start_15m=shift_months(latest_day,3).strftime("%Y%m%d")
                    latest_one_key=f"series:v7:{code}:minute:5d:qfq:latest:{basis_tag}"
                    latest_fifteen_key=f"series:v6:{code}:fifteen-minute:3m:qfq:latest:{basis_tag}"
                    keys=[one_key,fifteen_key,latest_one_key,latest_fifteen_key]
                    cached=dict(zip(keys,CACHE.get_many(keys)))
                    one_future=_chart_read_pool.submit(cached_intraday_windows,code,"oneMin",{
                        one_key:(start_1m,date,ttl),latest_one_key:(latest_start_1m,latest_end,300),
                    },basis_future,cached)
                    fifteen_future=_chart_read_pool.submit(cached_intraday_windows,code,"fifteenMin",{
                        fifteen_key:(start_15m,date,ttl),latest_fifteen_key:(latest_start_15m,latest_end,300),
                    },basis_future,cached)
                    span_future=_chart_read_pool.submit(previous_limitup_trading_info,code,date)
                    latest_basis=basis_future.result()
                    review_series=stock_series_for_date(latest_basis,date)
                    daily=review_series["daily"];weekly=review_series["weekly"];monthly=review_series["monthly"]
                    one_windows,_=one_future.result()
                    fifteen_windows,fifteen_errors=fifteen_future.result()
                    one_data=one_windows[one_key]; latest_one=one_windows[latest_one_key]
                    fifteen_data=fifteen_windows[fifteen_key]; latest_fifteen=fifteen_windows[latest_fifteen_key]
                    fifteen_error=fifteen_errors.get(fifteen_key)
                    latest_fifteen_error=fifteen_errors.get(latest_fifteen_key)
                    latest_series_data=stock_series_for_date(latest_basis,latest_end)
                    latest_daily=latest_series_data["daily"]; latest_weekly=latest_series_data["weekly"]; latest_monthly=latest_series_data["monthly"]
                    latest_actual_date=latest_basis["latestDate"] or latest_end
                    latest_series={"daily":latest_daily,"weekly":latest_weekly,"monthly":latest_monthly,"oneMin":latest_one["bars"],"fifteenMin":latest_fifteen["bars"],"suspendedDays":latest_one["suspendedDays"],"latestDate":latest_actual_date,"coverage":{"oneMinSuspendedDays":len(latest_one["suspendedDays"]),"oneMinDays":len(latest_one["days"]),"oneMinBars":len(latest_one["bars"]),"oneMinStart":latest_one["days"][0] if latest_one["days"] else None,"oneMinEnd":latest_one["days"][-1] if latest_one["days"] else None,"fifteenDays":len(latest_fifteen["days"]),"fifteenBars":len(latest_fifteen["bars"]),"fifteenStart":latest_fifteen["days"][0] if latest_fifteen["days"] else None,"fifteenEnd":latest_fifteen["days"][-1] if latest_fifteen["days"] else None,"fifteenError":latest_fifteen_error}}
                    latest_date=latest_actual_date
                    result={"code":code,"date":date,"latestMode":False,"latestDate":latest_date,"seriesReferenceDate":latest_end,"cacheBackend":CACHE.backend,"daily":daily,"weekly":weekly,"monthly":monthly,"oneMin":one_data["bars"],"fifteenMin":fifteen_data["bars"],"suspendedDays":one_data["suspendedDays"],"fifteenSource":"fifteen_minute_database","oneMinSource":"one_minute_database","coverage":{"oneMinSuspendedDays":len(one_data["suspendedDays"]),"oneMinDays":len(one_data["days"]),"oneMinBars":len(one_data["bars"]),"oneMinStart":one_data["days"][0] if one_data["days"] else None,"oneMinEnd":one_data["days"][-1] if one_data["days"] else None,"fifteenDays":len(fifteen_data["days"]),"fifteenBars":len(fifteen_data["bars"]),"fifteenStart":fifteen_data["days"][0] if fifteen_data["days"] else None,"fifteenEnd":fifteen_data["days"][-1] if fifteen_data["days"] else None,"fifteenError":fifteen_error},"latest":latest_series}
                    limitup_info=span_future.result()
                    result["previousLimitUpTradingDays"]=limitup_info["days"]
                    result["previousLimitUpHistoricalFirst"]=limitup_info["historicalFirst"]
                    result["limitUpSpanVersion"]=4
                    result["chartSeriesVersion"]=7
                    if stock_data_version()['stockDataVersion']!=version['stockDataVersion']:raise RuntimeError('Chart source changing; temporarily unavailable')
                    return {**result,**version}
                payload,hit=cached_stock_response('stock-full:v1:'+code+':'+date+':'+version['stockDataVersion'],load_stock)
                return self.send_json({**payload,**version},headers={'X-Chart-Cache':'process-memory' if hit else 'source-load'})
            if u.path.startswith("/api/"):
                self.send_error(404)
            else:
                super().do_GET()
        except Exception as e:
            traceback.print_exc(); self.send_json({"error":str(e)},500)
    def do_POST(self):
        try:
            u=urlparse(self.path)
            if u.path in ("/api/watchlists/groups","/api/watchlists/stocks"):
                origin=self.headers.get("Origin")
                if (origin and urlparse(origin).netloc!=self.headers.get("Host")) or self.headers.get("Sec-Fetch-Site")=="cross-site":
                    return self.send_json({"error":"请求来源无效"},403)
                if self.headers.get("Content-Type","").split(";",1)[0].strip().lower()!="application/json":
                    return self.send_json({"error":"请使用JSON请求"},415)
                size=int(self.headers.get("Content-Length","0"))
                if not 0<size<=100_000:return self.send_json({"error":"请求内容无效"},413)
                body=json.loads(self.rfile.read(size))
                if not isinstance(body,dict):raise ValueError("请求内容无效")
                store=watchlists_store()
                try:
                    payload=(store.create_group(body.get("name"),body.get("stock")) if u.path.endswith("/groups")
                             else store.set_groups(body.get("code"),body.get("name"),body.get("groupIds"),body.get("expectedVersion")))
                except WatchlistConflict as exc:return self.send_json({**store.snapshot(),"error":str(exc)},409)
                return self.send_json(payload)
            if u.path!="/api/analyze": return self.send_error(404)
            size=int(self.headers.get("Content-Length","0"))
            if size>100_000: return self.send_json({"error":"选中文字过长"},413)
            body=json.loads(self.rfile.read(size) or b"{}")
            date=safe_date(body.get("date")); code=body.get("code",""); selected=str(body.get("selection","")).strip()
            if not selected: raise ValueError("请先选择一段文字")
            if code and not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)",code): raise ValueError("股票代码无效")
            report=neo4j_review(date); topic=next((t for t in report["topics"] if t["name"]==body.get("topic")),None)
            candidate_stocks=topic["stocks"] if topic else [s for t in report["topics"] for s in t["stocks"]]
            stock=next((s for s in candidate_stocks if s["ts_code"]==code.upper()),None) if code else None
            return self.send_json({"mode":"neo4j-grounded","selected":selected,"question":str(body.get("question","")).strip(),"date":date,"topic":topic["name"] if topic else "","catalyst":topic["summary"] if topic else "","stock":stock,"stocks":topic["stocks"] if topic and not stock else [],"disclaimer":"依据 Neo4j 中已保存的每日题材摘要与个股归因整理，尚未调用生成式模型。"})
        except Exception as e:
            self.send_json({"error":str(e)},400)

if __name__=="__main__":
    CACHE=Cache()
    watchlists_store()
    start_daily_warmer()
    from live_push import LivePushHub
    PUSH_HUB=LivePushHub(live_push_event);PUSH_HUB.start()
    port=int(os.environ.get("TRADINGALERT_PORT","8765")); host=os.environ.get("TRADINGALERT_HOST","127.0.0.1")
    print(f"TradingAlert dashboard on http://{host}:{port} (market data read-only; watchlists writable)",flush=True)
    ThreadingHTTPServer((host,port),Handler).serve_forever()
