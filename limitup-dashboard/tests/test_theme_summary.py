"""A KPL regroup must retain only an exact matching Neo4j catalyst summary."""
import ast
from pathlib import Path
import unittest

source=Path(__file__).resolve().parents[1]/'server.py'
tree=ast.parse(source.read_text());scope={}
exec(compile(ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='market_topics'],type_ignores=[]),str(source),'exec'),scope)

class SummaryTests(unittest.TestCase):
    def test_exact_match_preserves_summary_and_reason(self):
        report={'topics':[{'name':'机器人','summary':'同名催化','stocks':[{'code':'600000','ts_code':'600000.SH','reason':'原因','bridge':'桥梁'}]}]}
        pool={'stocks':[{'ts_code':'600000.SH','performance_theme':'机器人'}]}
        topics,_,_=scope['market_topics']('20261016',report,pool)
        self.assertEqual(topics[0]['summary'],'同名催化');self.assertEqual(topics[0]['stocks'][0]['reason'],'原因')
    def test_compound_heading_is_not_assumed_same_theme(self):
        report={'topics':[{'name':'机器人、AI','summary':'复合章节','stocks':[{'code':'600000','ts_code':'600000.SH','reason':'原因','bridge':'桥梁'}]}]}
        pool={'stocks':[{'ts_code':'600000.SH','performance_theme':'机器人'}]}
        topics,_,_=scope['market_topics']('20261016',report,pool)
        self.assertIn('未按该KPL题材',topics[0]['summary']);self.assertEqual(topics[0]['stocks'][0]['analysis_group_summary'],'复合章节')

if __name__=='__main__':unittest.main()
