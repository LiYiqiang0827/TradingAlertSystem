"""Active database inventory and checkpoint-only freshness. No business-table scans."""
from __future__ import annotations
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import datetime as dt
import fnmatch
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import threading
import time
import uuid

ZONE = dt.timezone(dt.timedelta(hours=8))
SERVICES = {
 'tbl_cn_basic':'basic', 'tbl_cn_day':'daily', 'tbl_cn_adj_factor':'adj_factor',
 'tbl_cn_tradecal':'tradecal', 'tbl_cn_stk_limit':'stk_limit', 'tbl_cn_suspend':'suspend',
 'tbl_cn_moneyflow':'moneyflow', 'tbl_cn_daily_basic':'daily_basic', 'tbl_cn_margin':'margin',
 'tbl_cn_margin_detail':'margin_detail', 'tbl_cn_cyq_perf':'cyq_perf',
 'tbl_cn_week':'week', 'tbl_cn_week_origin':'week', 'tbl_cn_month':'month', 'tbl_cn_month_origin':'month',
 'tbl_cn_index_basic':'index_basic', 'tbl_cn_index_daily':'index_daily',
 'tbl_cn_index_weekly':'index_daily', 'tbl_cn_index_monthly':'index_daily',
 'tbl_cn_index_minute':'intraday_index', 'tbl_cn_index_minute_ctrl':'intraday_index',
 'tbl_cn_kpl_list':'kpl_list', 'tbl_cn_kpl_concept_cons':'kpl_concept_cons',
 'tbl_cn_kpl_limit_performance':'kpl_limit_performance', 'tbl_cn_top_list':'top_list',
 'tbl_cn_top_inst':'top_inst', 'tbl_cn_block_trade':'block_trade', 'tbl_cn_ggt_daily':'ggt_daily',
 'tbl_cn_hsgt_top10':'hsgt_top10', 'tbl_cn_limit_list':'limit_list',
 'tbl_news':'news', 'tbl_major_news':'major_news', 'tbl_cctv_news':'cctv_news',
}
KINDS = ('snapshot','snapshot_index','limitperformance','zt','break','watchlist','minute','orderbook','auction','anomaly','hot')


def q(name):return '"'+name.replace('"','""')+'"'
def stamp():return dt.datetime.now(ZONE).isoformat(timespec='seconds')
def plain(value):
    if isinstance(value,(dt.datetime,dt.date)):return value.isoformat()
    return value

def temporal(value):
    value=plain(value)
    if value is None:return None
    text=str(value).strip('"')
    if re.match(r'^20\d{6}(?:$|\D)|^20\d{2}-\d{2}-\d{2}',text):return text
    return None

def latest(values):
    values=[temporal(v) for v in values]
    return max((v for v in values if v),key=lambda v:re.sub(r'[^0-9]','',v)[:14],default=None)


class DatabaseBusy(RuntimeError):
    pass


class DatabaseStatus:
    def __init__(self,runtime):
        self.r=runtime
        self.lock=threading.RLock()
        self.cache=OrderedDict()
        self.jobs=OrderedDict()
        self.process_snapshot=(0,[])
        self.description_path=self.r.DBROOT/'database_table_descriptions.json'
        self.description_cache=None
        if self.r.DBROOT.is_dir() and not self.description_path.exists():
            template=self.r.WEBROOT/'database_table_descriptions.example.json'
            try:
                content=template.read_text(encoding='utf-8')
                with self.description_path.open('x',encoding='utf-8') as output:output.write(content)
            except (OSError,UnicodeError):pass
        self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='database-update')
        self.logs=Path.home()/'Library/Logs/TradingAlertSystem/database-updates'
        if self.logs.is_dir():
            for path in sorted(self.logs.glob('*.json'),key=lambda p:p.stat().st_mtime)[-100:]:
                try:
                    job=json.loads(path.read_text(encoding='utf-8'))
                    if job.get('state') in ('queued','running'):
                        job.update(state='interrupted',message='页面服务已重启，请重新读取控制表确认任务状态')
                    self.jobs[job['id']]=job
                except (OSError,ValueError,KeyError):pass

    def catalog(self):
        r=self.r
        items=[
          ('basic','基础行情','offline/db_cn_basic.db','sqlite'),
          ('kpl','开盘啦','offline/db_cn_kpl.db','sqlite'),
          ('index','指数日周月','offline/db_cn_index.db','sqlite'),
          ('index-minute','指数分钟','offline/db_cn_index_minute.db','sqlite'),
          ('one-minute','个股1分钟','offline/oneMinute/catalog.duckdb','duckdb'),
          ('fifteen-minute','个股15分钟','offline/db_fifteenMinute.db','duckdb'),
          ('news','原始新闻','offline/db_cn_news.db','sqlite'),
          ('theme','题材研究','offline/db_theme_graph.duckdb','duckdb'),
          ('major-news','新闻分析','offline/db_major_news_events.duckdb','duckdb'),
          ('ladder','涨停天梯','offline/limitup_ladder.db','sqlite'),
          ('attribution','每日涨停归因','theme_graph/topic_limitup_graph.sqlite3','sqlite'),
          ('watchlists','自选股','offline/watchlists.db','sqlite'),
          ('index-fallback','历史指数回退','offline/policy_minute.db','sqlite'),
        ]
        result=[]
        for key,label,relative,engine in items:
            path=r.DBROOT/relative
            if path.is_file():result.append({'id':key,'label':label,'path':relative,'engine':engine})
        # Only canonical monthly files, never archived/repaired copies.
        for path in sorted((r.DBROOT/'online').glob('online_data_20????.db'),reverse=True):
            result.append({'id':'online-'+path.stem[-6:],'label':'在线落盘 '+path.stem[-6:],
                           'path':str(path.relative_to(r.DBROOT)),'engine':'sqlite'})
        result.append({'id':'neo4j','label':'Neo4j题材归因','engine':'neo4j','path':'Neo4j / neo4j'})
        result.append({'id':'redis-online','label':'Redis实时行情','engine':'redis','path':'127.0.0.1:6380 / 0'})
        if r.CACHE and r.CACHE.redis:
            result.append({'id':'redis-cache','label':'Redis页面缓存','engine':'redis-cache','path':'当前页面Redis缓存'})
        return {'databases':result,'checkedAt':stamp(),'source':'ctrl/checkpoints'}

    def spec(self,identity):
        found=next((item for item in self.catalog()['databases'] if item['id']==identity),None)
        if not found:raise ValueError('该数据库不在实际使用的库清单内')
        return found

    def descriptions(self):
        try:
            stat=self.description_path.stat()
            version=(stat.st_mtime_ns,stat.st_size)
            with self.lock:
                if self.description_cache and self.description_cache[0]==version:return self.description_cache[1],None
                data=json.loads(self.description_path.read_text(encoding='utf-8'))
                if not isinstance(data,dict) or not isinstance(data.get('databases'),dict):raise ValueError('invalid description structure')
                self.description_cache=(version,data)
                return data,None
        except (OSError,UnicodeError,ValueError):return {},'内容简介文件缺失或格式无效，请检查 database_table_descriptions.json'

    def detail(self,identity,force=False):
        result=self._detail(identity,force)
        descriptions,error=self.descriptions()
        family='online' if identity.startswith('online-') else identity
        spec=descriptions.get('databases',{}).get(family,{})
        tables=spec.get('tables',{}) if isinstance(spec,dict) else {}
        patterns=spec.get('patterns',{}) if isinstance(spec,dict) else {}
        if not isinstance(tables,dict):tables={}
        if not isinstance(patterns,dict):patterns={}
        rows=[]
        for row in result['tables']:
            text=tables.get(row['name'])
            if not isinstance(text,str):text=next((value for pattern,value in patterns.items() if isinstance(value,str) and fnmatch.fnmatchcase(row['name'],pattern)),None)
            rows.append({**row,'description':text or '待补充说明'})
        payload={**result,'tables':rows,'descriptionFile':self.description_path.name}
        if error:payload['notice']='；'.join(filter(None,(payload.get('notice'),error)))
        return payload

    def collector_running(self,identity):
        names={'one-minute':('oneMinute',),'fifteen-minute':('fifteenMinute',),
               'theme':('theme_graph',),'major-news':('news_events','daily_major_news_analysis')}.get(identity)
        if not names:return False
        with self.lock:
            at,commands=self.process_snapshot
            if time.monotonic()-at>.5:
                commands=subprocess.check_output(['ps','-axo','command='],text=True).splitlines()
                self.process_snapshot=(time.monotonic(),commands)
        modules={'service.service_'+name for name in names}
        scripts={'service_'+name+'.py' for name in names}
        return any(modules.intersection(line.split()) or any(Path(part).name in scripts for part in line.split()) for line in commands)

    def busy_result(self,identity):
        with self.lock:
            previous=next((entry[1] for entry in reversed(self.cache.values()) if entry[1]['id']==identity),None)
        notice='数据库正在写入，暂时无法读取控制表'
        if previous:return {**previous,'busy':True,'notice':notice+'；显示上次读取的记录','jobs':self.job_list(identity)}
        raise DatabaseBusy(notice+'，请稍后刷新状态')

    def _detail(self,identity,force=False):
        spec=self.spec(identity)
        if self.collector_running(identity):return self.busy_result(identity)
        revision=self.r.database_revision((self.r.DBROOT/spec['path'],Path(str(self.r.DBROOT/spec['path'])+'.wal'))) if spec['engine'] in ('sqlite','duckdb') else identity
        key=identity+':'+revision
        with self.lock:
            entry=self.cache.get(key)
            if entry and not force and time.monotonic()-entry[0]<10:
                self.cache.move_to_end(key);return {**entry[1],'jobs':self.job_list(identity)}
        try:
            if spec['engine']=='sqlite':rows=self.sqlite_rows(spec)
            elif spec['engine']=='duckdb':rows=self.duck_rows(spec)
            elif spec['engine']=='neo4j':rows=self.neo4j_rows()
            elif spec['engine']=='redis':rows=self.redis_rows()
            else:rows=[self.row('key_value_cache',None,'缓存没有独立更新时间控制表',None,'按源数据版本自动刷新')]
        except Exception as exc:
            if 'lock' not in str(exc).lower():raise
            return self.busy_result(identity)
        result={**spec,'tables':rows,'checkedAt':stamp(),'source':'ctrl/checkpoints'}
        with self.lock:
            self.cache[key]=(time.monotonic(),result)
            while len(self.cache)>40:self.cache.popitem(last=False)
        return {**result,'jobs':self.job_list(identity)}

    def row(self,name,value,source,action=None,reason='',updated=None,checkpoints=None):
        return {'name':name,'latest':temporal(value),'source':source,'updatedAt':plain(updated),
                'canUpdate':bool(action),'action':action,'updateReason':reason or ('' if action else '未配置自动更新任务'),
                'checkpoints':checkpoints or []}

    def sqlite_rows(self,spec):
        identity=spec['id']
        path=self.r.DBROOT/spec['path']
        with closing(sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=2)) as c:
            c.row_factory=sqlite3.Row
            c.execute('PRAGMA query_only=ON')
            tables=[v[0] for v in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            ctl={}
            for table in ('tbl_basic_ctrl','tbl_kpl_ctrl','tbl_news_ctrl','tbl_index_ctrl'):
                if table in tables:
                    ctl[table]=[dict(row) for row in c.execute('SELECT * FROM '+q(table))]
            result=[]
            if identity=='ladder':
                metadata={row['key']:json.loads(row['value']) for row in c.execute('SELECT key,value FROM metadata WHERE key IN (?,?)',('latest_date','updated_at'))}
                return [self.row(t,metadata.get('latest_date'),'metadata.latest_date','offline:limitup_ladder',updated=metadata.get('updated_at')) for t in tables]
            if identity=='attribution':
                # import_runs is the existing write-control ledger, not the attribution table.
                run=c.execute("SELECT MAX(trade_date) AS trade_date,MAX(completed_at) AS completed_at FROM import_runs WHERE status='completed' AND completed_at IS NOT NULL").fetchone()
                return [self.row(t,run['trade_date'] if run else None,'import_runs（最近导入批次）',reason='由每日涨停分析技能生成并入库',updated=run['completed_at'] if run else None) for t in tables]
            if identity=='index-minute':
                control=c.execute('SELECT MAX(trade_date),MAX(fetched_at) FROM tbl_cn_index_minute_ctrl').fetchone()
                return [self.row(t,control[0],'tbl_cn_index_minute_ctrl.trade_date','offline:intraday_index',updated=control[1]) for t in tables]
            if identity=='index-fallback':
                for t in tables:
                    control='tbl_minute_index_ctrl' if 'index' in t else 'tbl_minute_ctrl'
                    value=c.execute('SELECT MAX(trade_date) FROM '+q(control)).fetchone()[0] if control in tables else None
                    result.append(self.row(t,value,control+'.trade_date',reason='历史回退库只读；新数据进入正式分钟库'))
                return result
            if identity.startswith('online-'):
                records=[dict(row) for row in c.execute('SELECT * FROM online_stream_cursor')] if 'online_stream_cursor' in tables else []
                for t in sorted(tables,key=lambda name:(-(int(name[-8:]) if re.search(r'_20\d{6}$',name) else 0),name)):
                    if t=='online_stream_cursor':
                        result.append(self.row(t,latest(row.get('last_persist_ts') or row.get('updated_at') for row in records),'online_stream_cursor.last_persist_ts',reason='由在线持久化任务维护'));continue
                    match=re.fullmatch(r'(.+)_(20\d{6})',t)
                    kind,date=match.groups() if match else ('','')
                    current=[row for row in records if kind and kind in str(row.get('stream_key','')).split(':') and str(row.get('last_trade_date'))==date]
                    value=latest(row.get('last_persist_ts') or row.get('updated_at') for row in current)
                    result.append(self.row(t,value,'online_stream_cursor.last_persist_ts',reason='由Redis消费落盘；历史分表未保留独立断点' if not current else '由在线持久化任务持续更新'))
                return result
            for t in tables:
                service=SERVICES.get(t)
                source=''
                points=[]
                if identity=='news':
                    points=ctl.get('tbl_news_ctrl',[])
                    if t=='tbl_news':points=[row for row in points if row.get('src') not in ('major_news','cctv_news')]
                    elif t=='tbl_major_news':points=[row for row in points if row.get('src')=='major_news']
                    elif t=='tbl_cctv_news':points=[row for row in points if row.get('src')=='cctv_news']
                    source='tbl_news_ctrl.max_date'
                else:
                    control='tbl_basic_ctrl' if identity=='basic' else 'tbl_kpl_ctrl' if identity=='kpl' else 'tbl_index_ctrl' if identity=='index' else ''
                    candidates=ctl.get(control,[])
                    control_key='cn_daily' if t=='tbl_cn_day' else t.removeprefix('tbl_')
                    points=[row for row in candidates if t==control or row.get('key')==control_key or (t=='tbl_cn_tradecal' and str(row.get('key','')).startswith('cn_tradecal_'))]
                    source=control+'.max_date' if control else '未配置独立控制表'
                value=latest(row.get('max_date') for row in points)
                # Metadata refreshes can deliberately use "all" rather than a date.
                if not value and points and all(row.get('max_date')=='all' for row in points):value=latest(row.get('updated_at') for row in points)
                if not points and (t in ('tbl_cn_week','tbl_cn_week_origin','tbl_cn_month','tbl_cn_month_origin','tbl_cn_index_weekly','tbl_cn_index_monthly')):
                    source='未独立记录；由日线与复权断点派生'
                result.append(self.row(t,value,source,'offline:'+service if service else None,
                    '控制表随对应业务任务更新' if t in ctl else '',updated=latest(row.get('updated_at') for row in points),
                    checkpoints=[{'key':row.get('key',row.get('src')),'date':row.get('max_date'),'updatedAt':row.get('updated_at')} for row in points]))
            return result

    def duck_rows(self,spec):
        import duckdb
        identity=spec['id']
        with duckdb.connect(str(self.r.DBROOT/spec['path']),read_only=True) as c:
            tables=[row[0] for row in c.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name").fetchall()]
            if identity in ('one-minute','fifteen-minute'):
                control='tbl_one_minute_ctrl' if identity=='one-minute' else 'tbl_fifteen_minute_ctrl'
                key='one_min_bars' if identity=='one-minute' else 'fifteen_min_bars'
                row=c.execute('SELECT max_date,updated_at FROM '+q(control)+' WHERE key=?',[key]).fetchone() if control in tables else None
                action='offline:oneMinute' if identity=='one-minute' else 'offline:fifteenMinute'
                names=(['one_min_bars（Parquet主数据）'] if identity=='one-minute' else [])+tables
                # The downloaded staging/source scan tables are not published data.
                return [self.row(t,row[0] if row else None,control+'.max_date（正式落库）',action,
                    updated=row[1] if row else None) if t in (key,'one_min_bars（Parquet主数据）',control,'one_min_ingest_catalog','fifteen_min_days')
                    else self.row(t,None,'下载/目录维护元数据；不代表正式行情更新',action) for t in names]
            if identity=='theme':
                points=[{'key':row[0],'date':row[1],'updatedAt':plain(row[2])} for row in c.execute('SELECT source_name,last_complete_date,updated_at FROM source_checkpoint').fetchall()]
                run=c.execute("SELECT as_of_date,completed_at FROM graph_build_run WHERE status='success' ORDER BY completed_at DESC LIMIT 1").fetchone()
                rows=[]
                for t in tables:
                    if t=='llm_analysis':rows.append(self.row(t,None,'无独立模型分析断点',reason='由题材分析任务生成'));continue
                    if t in ('source_checkpoint','source_conflict','source_day_manifest','fact_limit_event','fact_membership_snapshot','rel_limit_theme'):
                        rows.append(self.row(t,latest(p['date'] for p in points),'source_checkpoint.last_complete_date','offline:theme_graph',updated=latest(p['updatedAt'] for p in points),checkpoints=points))
                    else:rows.append(self.row(t,run[0] if run else None,'graph_build_run（最近成功构建）','offline:theme_graph',updated=run[1] if run else None))
                return rows
            if identity=='major-news':
                value=c.execute("SELECT value,updated_at FROM pipeline_state WHERE key='major_news_max_datetime'").fetchone()
                raw=('fact_news_event','rel_news_event_member','pipeline_state')
                return [self.row(t,temporal(value[0]) if value and t in raw else None,
                    'pipeline_state.major_news_max_datetime' if t in raw else '无独立模型分析断点',
                    'offline:news_events' if t in raw else None,
                    '由每日新闻分析任务生成' if t not in raw else '',updated=plain(value[1]) if value and t in raw else None) for t in tables]
        return []

    def neo4j_rows(self):
        from coreClient.neo4j_client import ThemeGraphNeo4jStore
        with ThemeGraphNeo4jStore() as graph:
            labels=[row['label'] for row in graph._run('CALL db.labels() YIELD label RETURN label ORDER BY label')]
            types=[row['relationshipType'] for row in graph._run('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType')]
            runs=graph._run("MATCH (n:ImportRun) WHERE n.status='completed' RETURN max(n.trade_date) AS trade_date, max(n.completed_at) AS completed_at")
        run=runs[0] if runs else {}
        return [self.row(t,run.get('trade_date'),'ImportRun（最近导入批次）',reason='由每日涨停分析技能审核后入库',updated=run.get('completed_at')) for t in labels+[f'关系 · {t}' for t in types]]

    def redis_rows(self):
        import redis
        c=redis.Redis(port=6380,decode_responses=True,socket_connect_timeout=.5,socket_timeout=2)
        meta=c.hgetall('online:meta')
        rows=[]
        for kind in KINDS:
            raw=meta.get(kind+'_last_ts')
            if raw:
                try:raw=json.loads(raw)
                except (ValueError,TypeError):pass
            module=self.r.TDM/'onlineDataManager/scripts/service'/('service_writeredis_'+kind+'.py')
            supported=module.is_file() and '--once' in module.read_text(encoding='utf-8')
            rows.append(self.row(kind,raw,'online:meta.'+kind+'_last_ts','online:'+kind if supported else None))
        return rows

    def plan(self,action,row):
        mode,name=action.split(':',1)
        if mode=='online':return [('online','service_writeredis_'+name,['--once'])]
        if name in ('week','month'):
            return [('offline','service_daily',[]),('offline','service_adj_factor',[]),('offline','service_'+name,[])]
        args=[]
        if name=='theme_graph':args=['--mode','incremental']
        if name=='tradecal':args=['--trade-date',dt.datetime.now(ZONE).strftime('%Y%m%d')]
        if name=='index_daily':
            start=temporal(row.get('latest'))
            if start:args=['--start-date',re.sub(r'\D','',start)[:8]]
            else:
                # Derived tables have no independent checkpoint: use the daily
                # control ledger, never start a 1993-to-present backfill here.
                with closing(sqlite3.connect(str(self.r.DBROOT/'offline/db_cn_index.db'))) as c:
                    value=c.execute("SELECT max_date FROM tbl_index_ctrl WHERE key='cn_index_daily'").fetchone()
                if not value or not temporal(value[0]):raise ValueError('指数日线尚无断点，请先初始化数据')
                args=['--start-date',re.sub(r'\D','',value[0])[:8]]
        return [('offline','service_'+name,args)]

    def job_list(self,database=None):
        with self.lock:return [dict(v) for v in self.jobs.values() if database is None or v['databaseId']==database][-50:]

    def start_update(self,database,table):
        detail=self.detail(database,force=True)
        row=next((row for row in detail['tables'] if row['name']==table),None)
        if not row:raise ValueError('数据表不存在')
        if not row['canUpdate']:raise ValueError(row['updateReason'])
        plan=self.plan(row['action'],row)
        # Fixed service allow-list only. Never accept shell/SQL/module arguments
        # or database paths from a browser request.
        for mode,module,args in plan:
            path=self.r.TDM/('onlineDataManager' if mode=='online' else 'offlineDataManager')/'scripts/service'/(module+'.py')
            if not path.is_file():raise ValueError('当前安装缺少对应更新脚本')
        module_set={'service.'+module for _,module,_ in plan}
        processes=subprocess.check_output(['ps','-axo','command='],text=True)
        if any(module_set.intersection(line.split()) for line in processes.splitlines()):
            raise ValueError('已有相同采集任务在运行，请等待该任务完成')
        with self.lock:
            for job in self.jobs.values():
                if job['state'] in ('queued','running'):
                    # One manual update chain at a time; avoid overlapping daily,
                    # factor, and derived-period writers from repeated clicks.
                    raise ValueError('已有手动更新任务在运行：'+job['table'])
            identity=uuid.uuid4().hex
            job={'id':identity,'databaseId':database,'table':table,'state':'queued','startedAt':stamp(),
                 'finishedAt':None,'message':'等待执行','before':row['latest'],'after':None}
            self.jobs[identity]=job
            while len(self.jobs)>100:self.jobs.popitem(last=False)
            self.logs.mkdir(parents=True,exist_ok=True)
            (self.logs/(identity+'.json')).write_text(json.dumps(job,ensure_ascii=False),encoding='utf-8')
            self.pool.submit(self._run_job,identity,plan)
        return {'job':dict(job)}

    def _run_job(self,identity,plan):
        job=self.jobs[identity]
        self.logs.mkdir(parents=True,exist_ok=True)
        logfile=self.logs/(identity+'.log')
        job.update(state='running',message='正在调用现有更新任务')
        env=dict(os.environ)
        env.update(TRADING_DATA_MANAGER_ROOT=str(self.r.TDM),TRADING_DATABASE_ROOT=str(self.r.DBROOT),TZ='Asia/Shanghai')
        # Match the canonical scheduler's environment-file setting without ever
        # sending credentials, raw environments or command output to the UI.
        env_file=Path(env.get('TRADING_AGENT_ENV_FILE',str(self.r.TDM/'.env'))).expanduser()
        for p in (Path.home()/'Library/LaunchAgents').glob('com.tradingdatamanager.scheduler.*.plist'):
            try:
                settings=plistlib.loads(p.read_bytes()).get('EnvironmentVariables',{})
                if settings.get('TRADING_AGENT_ENV_FILE'):env_file=Path(settings['TRADING_AGENT_ENV_FILE']).expanduser();break
            except (OSError,ValueError):pass
        runner='set -e; if [[ -f "$1" ]]; then set -a; source "$1"; set +a; fi; export TRADING_DATA_MANAGER_ROOT="$2"; export TRADING_DATABASE_ROOT="$3"; export PYTHONPATH="$2${PYTHONPATH:+:$PYTHONPATH}"; export PATH="$HOME/.local/bin:$PATH"; shift 3; exec "$@"'
        try:
            with logfile.open('ab',buffering=0) as output:
                for mode,module,args in plan:
                    cwd=self.r.TDM/('onlineDataManager' if mode=='online' else 'offlineDataManager')/'scripts'
                    command=['/bin/zsh','-c',runner,'database-update',str(env_file),str(self.r.TDM),str(self.r.DBROOT),str(self.r.TDM/'.venv/bin/python'),'-m','service.'+module,*args]
                    process=subprocess.Popen(command,cwd=cwd,env=env,stdout=output,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,start_new_session=True)
                    job.update(pid=process.pid,message='正在执行 '+module)
                    try:code=process.wait(timeout=7200)
                    except subprocess.TimeoutExpired:
                        import signal
                        os.killpg(process.pid,signal.SIGTERM)
                        try:process.wait(timeout=10)
                        except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
                        raise RuntimeError('任务超时')
                    if code:raise RuntimeError('更新任务未成功，退出码 '+str(code))
            detail=self.detail(job['databaseId'],force=True)
            row=next((r for r in detail['tables'] if r['name']==job['table']),{})
            job.update(state='completed',after=row.get('latest'),message='更新完成' if row.get('latest')!=job['before'] else '任务完成，断点未变化')
        except Exception as exc:
            job.update(state='failed',message=str(exc) if isinstance(exc,RuntimeError) else '任务执行失败，请查看本机更新日志')
        finally:
            job.update(finishedAt=stamp(),logFile=str(logfile))
            (self.logs/(identity+'.json')).write_text(json.dumps(dict(job),ensure_ascii=False,indent=2),encoding='utf-8')
