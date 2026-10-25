"""Recovery paths use reported nodes, include boundary context and preserve cutoff."""
import ast
import bisect
from contextlib import closing
from decimal import Decimal, InvalidOperation
import datetime
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest

SOURCE=Path(__file__).resolve().parents[1]/'server.py'
DAYS=['20261019','20261020','20261021','20261022','20261023']
CODE='301313.SZ'


def scope_for(folder, reported, sealed, periods=None, halts=()):
    basic=folder/'basic.db';kpl=folder/'kpl.db'
    with sqlite3.connect(basic) as conn:
        conn.executescript('''CREATE TABLE tbl_cn_tradecal(cal_date TEXT,exchange TEXT,is_open INTEGER);
          CREATE TABLE tbl_cn_day(trade_date TEXT,ts_code TEXT,close REAL,pct_chg REAL,open REAL,high REAL,low REAL,pre_close REAL);
          CREATE TABLE tbl_cn_stk_limit(trade_date TEXT,ts_code TEXT,up_limit REAL,down_limit REAL);
          CREATE TABLE tbl_cn_suspend(trade_date TEXT,ts_code TEXT,suspend_type TEXT,suspend_timing TEXT);''')
        for day in DAYS:
            conn.execute("INSERT INTO tbl_cn_tradecal VALUES (?,'SSE',1)",(day,))
            conn.execute('INSERT INTO tbl_cn_stk_limit VALUES (?,?,11,9)',(day,CODE))
            if day in halts:
                conn.execute("INSERT INTO tbl_cn_suspend VALUES (?,?,'S','')",(day,CODE));continue
            conn.execute('INSERT INTO tbl_cn_day VALUES (?,?,?,?,?,?,?,10)',(day,CODE,11 if day in sealed else 10,10 if day in sealed else 0,10,11 if day in sealed else 10.5,9.9))
    conn.close()
    with sqlite3.connect(kpl) as conn:
        conn.executescript('''CREATE TABLE tbl_cn_kpl_limit_performance(trade_date TEXT,ts_code TEXT,name TEXT,theme TEXT,lu_time TEXT,close_price REAL,board_period TEXT);
          CREATE TABLE tbl_cn_kpl_list(trade_date TEXT,ts_code TEXT,name TEXT,theme TEXT,lu_desc TEXT,lu_time TEXT,last_time TEXT,tag TEXT);
          CREATE TABLE tbl_cn_limit_list(trade_date TEXT,ts_code TEXT,name TEXT,first_time TEXT,last_time TEXT,close REAL,open_times INTEGER,"limit" TEXT);''')
        for day in reported:
            conn.execute('INSERT INTO tbl_cn_kpl_limit_performance VALUES (?,?,?,?,?,?,?)',(day,CODE,'凡拓数创','机器人概念' if day==DAYS[-1] else '物理AI','09:35:00',11,(periods or {}).get(day,'')))
    conn.close()
    tree=ast.parse(SOURCE.read_text());names={'ladder_board_pattern','limitup_ladder_data','is_closed_limit_up','consecutive_board_history','classify_limitup_traits'}
    scope=dict(closing=closing,sqlite3=sqlite3,re=re,datetime=datetime,bisect=bisect,Decimal=Decimal,InvalidOperation=InvalidOperation,BASIC_DB=basic,KPL_DB=kpl,market_data_dates=lambda:DAYS)
    exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),str(SOURCE),'exec'),scope)
    return scope


class RecoveryTests(unittest.TestCase):
    def test_fantuo_two_break_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            scope=scope_for(Path(tmp),[DAYS[0],DAYS[1],DAYS[4]],[DAYS[0],DAYS[1],DAYS[4]],{DAYS[4]:'5天3板'})
            data=scope['limitup_ladder_data'](DAYS[4],5)
            edge=next(e for e in data['links'] if e['target']==DAYS[4]+':'+CODE)
            self.assertEqual(edge['source'],DAYS[1]+':'+CODE);self.assertEqual(edge['kind'],'broken');self.assertEqual(edge['gapDates'],DAYS[2:4])
            self.assertEqual((edge['sourceBoard'],edge['targetBoard']),(2,3))
    def test_invisible_daily_row_cannot_consume_reported_predecessor(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Day 21 looks sealed in daily OHLC but all three limit-up sources omit it.
            scope=scope_for(Path(tmp),[DAYS[0],DAYS[1],DAYS[4]],[DAYS[0],DAYS[1],DAYS[2],DAYS[4]],{DAYS[4]:'5天3板'})
            data=scope['limitup_ladder_data'](DAYS[4],5)
            edge=next(e for e in data['links'] if e['target']==DAYS[4]+':'+CODE)
            self.assertEqual(edge['source'],DAYS[1]+':'+CODE)
            self.assertFalse(any(n['date']==DAYS[2] for n in data['sealedStocks']))
    def test_suspension_context_is_complete_at_window_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            scope=scope_for(Path(tmp),[DAYS[0],DAYS[2]],[DAYS[0],DAYS[2]],halts=[DAYS[1]])
            data=scope['limitup_ladder_data'](DAYS[2],1)
            edge=next(e for e in data['links'] if e['target']==DAYS[2]+':'+CODE)
            self.assertEqual(edge['kind'],'suspension')
            ids={n['id'] for n in data['nodes']+data['contextStocks']}
            self.assertIn(edge['source'],ids);self.assertEqual(edge['source'],DAYS[0]+':'+CODE)
            self.assertEqual(data['suspensionCarry'][0]['board'],1)
    def test_cutoff_and_fresh_restart_remain_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            scope=scope_for(Path(tmp),[DAYS[0],DAYS[1],DAYS[4]],[DAYS[0],DAYS[1],DAYS[4]])
            early=scope['limitup_ladder_data'](DAYS[2],5)
            self.assertFalse(any(n['date']>DAYS[2] for n in early['sealedStocks']+early['contextStocks']))
            data=scope['limitup_ladder_data'](DAYS[4],5)
            self.assertFalse(any(e['target']==DAYS[4]+':'+CODE and e['status']=='promoted' for e in data['links']))
            self.assertTrue(any(e['source']==DAYS[1]+':'+CODE and e['target']==DAYS[4]+':'+CODE for e in data['relimitLinks']))
    def test_all_continuation_styles_are_readable(self):
        css=SOURCE.with_name('styles.css').read_text()
        self.assertIn('.vl-edge.vl-continuation,.vl-edge.vl-continuation:hover{opacity:.5;',css)
        self.assertIn('.vl-edge.vl-relimit,.vl-edge.vl-relimit:hover{opacity:.5;',css)
        self.assertNotIn('opacity:.16;stroke-width:.8',css)


if __name__=='__main__':unittest.main()
