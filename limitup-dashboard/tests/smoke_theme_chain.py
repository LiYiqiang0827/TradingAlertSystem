"""Check a running dashboard against TradingDataManager's isolated synthetic demo."""
import argparse
import json
from urllib.request import urlopen,Request


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8765')
    args=parser.parse_args();base=args.url.rstrip('/')
    def get(route):
        with urlopen(base+route,timeout=60) as response:return json.load(response)
    assert get('/api/dates')['dates']==['20261015','20261016']
    report=get('/api/review?date=20261016')
    topic=next(item for item in report['topics'] if item['name']=='示例题材A')
    assert '演示催化摘要' in topic['summary']
    stock=next(item for item in topic['stocks'] if item['ts_code']=='600000.SH')
    assert '演示甲涨停原因' in stock['reason']
    details=get('/api/ladder-topic-details?date=20261016')
    assert details['reasonAvailable'] is True
    assert '合成桥梁甲' in details['stocks']['600000.SH']['reason']
    assert '演示催化摘要' in details['catalysts']['示例题材A']
    assert get('/api/topic-dates?topic=%E7%A4%BA%E4%BE%8B%E9%A2%98%E6%9D%90A')['dates']==['20261015','20261016']
    series=get('/api/stock?code=600000.SH&date=20261016')
    assert len(series['daily'])==3 and series['oneMin']==[]
    print('PASS real Neo4j summaries/reasons -> review/topic-calendar/hover endpoints')


if __name__=='__main__':main()
