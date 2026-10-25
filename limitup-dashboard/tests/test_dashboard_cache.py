"""Isolated cache regressions; no production DB, Redis or Neo4j is required."""
from contextlib import closing
import gzip
import io
import ast
import copy
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

SOURCE=Path(__file__).resolve().parents[1]/'server.py'
NAMES={'Cache','database_revision','market_data_dates','_read_market_data_dates','cached_series','review_data','review_cache_key','Handler'}
ASSIGNMENTS={'_market_dates_lock','_market_dates_snapshot','_cache_load_locks'}

def isolated():
    tree=ast.parse(SOURCE.read_text())
    body=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in NAMES or isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ASSIGNMENTS for t in node.targets)]
    scope=dict(DBROOT=Path("/missing"),closing=closing,gzip=gzip,SimpleHTTPRequestHandler=object,Path=Path,sqlite3=sqlite3,threading=threading,hashlib=hashlib,json=json,re=re)
    import datetime
    scope.update(datetime=datetime,os=__import__('os'))
    exec(compile(ast.Module(body=body,type_ignores=[]),str(SOURCE),'exec'),scope)
    return scope

class MemoryCache:
    backend='test'
    def __init__(self):self.rows={}
    def get(self,key):return copy.deepcopy(self.rows.get(key))
    def set(self,key,value,ttl=0):self.rows[key]=copy.deepcopy(value)

class CacheTests(unittest.TestCase):
    def test_dates_snapshot_invalidates_and_is_not_mutable(self):
        scope=isolated()
        with tempfile.TemporaryDirectory() as folder:
            kpl=Path(folder)/'kpl.db';basic=Path(folder)/'basic.db'
            with closing(sqlite3.connect(kpl)) as c:
                c.execute('CREATE TABLE tbl_cn_kpl_limit_performance(trade_date TEXT)')
                c.execute("INSERT INTO tbl_cn_kpl_limit_performance VALUES ('20261022')");c.commit()
            with closing(sqlite3.connect(basic)) as c:
                c.execute('CREATE TABLE tbl_cn_day(trade_date TEXT)')
                c.execute("INSERT INTO tbl_cn_day VALUES ('20261022')");c.commit()
            scope.update(KPL_DB=kpl,BASIC_DB=basic)
            reader=scope['_read_market_data_dates'];calls=[]
            def read():calls.append(1);return reader()
            scope['_read_market_data_dates']=read
            dates=scope['market_data_dates']();dates.clear()
            self.assertEqual(scope['market_data_dates'](),['20261022']);self.assertEqual(len(calls),1)
            # A committed WAL update must invalidate even before checkpoint.
            c=sqlite3.connect(kpl);c.execute('PRAGMA journal_mode=WAL');c.execute("INSERT INTO tbl_cn_kpl_limit_performance VALUES ('20261023')");c.commit()
            self.assertEqual(scope['market_data_dates'](),['20261022'])
            with closing(sqlite3.connect(basic)) as b:b.execute("INSERT INTO tbl_cn_day VALUES ('20261023')");b.commit()
            self.assertEqual(scope['market_data_dates'](),['20261022','20261023'])
            self.assertEqual(len(calls),3);c.close()

    def test_degraded_dates_are_not_cached(self):
        scope=isolated();scope.update(KPL_DB=Path('/missing/a'),BASIC_DB=Path('/missing/b'))
        calls=[]
        def read():calls.append(1);return ['20261023'],False
        scope['_read_market_data_dates']=read
        scope['market_data_dates']();scope['market_data_dates']();self.assertEqual(len(calls),2)

    def test_same_key_cold_requests_compute_once(self):
        scope=isolated();scope['CACHE']=MemoryCache();calls=[]
        def load():calls.append(1);time.sleep(.02);return {'rows':[1]}
        with ThreadPoolExecutor(max_workers=12) as pool:
            results=list(pool.map(lambda _:scope['cached_series']('same',load),range(24)))
        self.assertEqual(len(calls),1);self.assertEqual(results,[{'rows':[1]}]*24)

    def test_sqlite_fallback_concurrent_transactions(self):
        scope=isolated();cache=scope['Cache'].__new__(scope['Cache']);cache.redis=None;cache.lock=threading.RLock()
        with tempfile.TemporaryDirectory() as folder:
            cache.db=sqlite3.connect(Path(folder)/'cache.db',check_same_thread=False)
            cache.db.execute('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT,expires INTEGER)');cache.db.commit()
            def run(i):
                cache.set(str(i),{'i':i});self.assertEqual(cache.get(str(i)),{'i':i})
                cache.set('expired'+str(i),{},-1);self.assertIsNone(cache.get('expired'+str(i)))
            with ThreadPoolExecutor(max_workers=12) as pool:list(pool.map(run,range(120)))
            cache.db.close()

    def test_json_compression_negotiation(self):
        scope=isolated();payload={'rows':['测试']*3000}
        for accepted,compressed in [('gzip, deflate',True),('gzip;q=0, *;q=1',False),('',False),('gzip;q=0.5',True)]:
            handler=scope['Handler'].__new__(scope['Handler']);handler.headers={'Accept-Encoding':accepted};handler.wfile=io.BytesIO();headers={}
            handler.send_response=lambda status:None;handler.send_header=lambda key,value:headers.update({key:value});handler.end_headers=lambda:None
            handler.send_json(payload);body=handler.wfile.getvalue()
            self.assertEqual(int(headers['Content-Length']),len(body));self.assertEqual(headers.get('Content-Encoding')=='gzip',compressed)
            self.assertEqual(json.loads(gzip.decompress(body) if compressed else body),payload)

    def test_finished_review_invalidates_on_source_change(self):
        scope=isolated();scope['CACHE']=MemoryCache();revision=['old'];calls=[]
        scope.update(KPL_DB=None,BASIC_DB=None,database_revision=lambda paths:revision[0])
        scope.update(kpl_pool=lambda day:{'stocks':[]},neo4j_review=lambda day:{'date':day,'topics':[]},market_topics=lambda *a:([],[],0),indices=lambda day:[],stock_concepts=lambda day:{})
        def stats(*a):calls.append(1);return {'sealed':0,'allBreakStocks':[],'firstBoardBreakStocks':[]}
        scope['market_stats']=stats
        first=scope['review_data']('20261023');first['topics'].append('mutation')
        self.assertEqual(scope['review_data']('20261023')['topics'],[]);self.assertEqual(len(calls),1)
        revision[0]='updated';scope['review_data']('20261023');self.assertEqual(len(calls),2)

if __name__=='__main__':unittest.main()
