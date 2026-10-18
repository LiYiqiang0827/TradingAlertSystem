import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Presentation, PresentationFile, FileBlob} from '@oai/artifact-tool';

const required=['SKILL_DIR','BUILD_DIR','FINAL_PPTX','DECK_DATA','RESEARCH_DATA','RUNTIME_PYTHON'];
for(const key of required){if(!process.env[key]||!path.isAbsolute(process.env[key]))throw new Error(`Set absolute ${key}`)}
const skill=process.env.SKILL_DIR, build=process.env.BUILD_DIR, target=process.env.FINAL_PPTX;
const {finalizePresentation,resolvePresentationFont}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const font=resolvePresentationFont({fontFamily:'Arial Unicode MS'});
const data=JSON.parse(await fs.readFile(process.env.DECK_DATA,'utf8'));
const {summary,candidates}=data;
if(!candidates.length||summary.candidate_count!==candidates.length)throw new Error('候选表为空或数量不匹配');
const research=JSON.parse(await fs.readFile(process.env.RESEARCH_DATA,'utf8'));
const researchStocks=new Map();
for(const r of research.stocks){researchStocks.set(r.ts_code,r);researchStocks.set(String(r.ts_code).replace(/\.(SH|SZ|BJ)$/,''),r);}
const outDir=path.dirname(process.env.DECK_DATA);
const relationScores=new Map();
for(const file of ['theme_ranking_lowaltitude.json','theme_ranking_other.json']){
  const ranking=JSON.parse(await fs.readFile(path.join(outDir,file),'utf8'));
  for(const stock of ranking.stocks||[])for(const link of stock.topic_links||[]){
    const key=`${stock.ts_code}|${link.topic}`;
    relationScores.set(key,link);
    relationScores.set(`${String(stock.ts_code).replace(/\.(SH|SZ|BJ)$/,'')}|${link.topic}`,link);
  }
}
const postAnalysis=JSON.parse(await fs.readFile(path.join(outDir,'post_limitup_analysis.json'),'utf8'));
const patternByCode=new Map();
for(const row of postAnalysis.stocks||[]){patternByCode.set(row.ts_code,row);patternByCode.set(String(row.ts_code).replace(/\.(SH|SZ|BJ)$/,''),row);}
const kplByCode=new Map((data.market_limitups||[]).map(r=>[r.ts_code,r]));
const tagsFor=row=>String(row.theme||'未标注').split('、').map(x=>x.trim()).filter(Boolean);
const topicCounts=new Map();
for(const row of data.market_limitups||[])for(const tag of tagsFor(row))topicCounts.set(tag,(topicCounts.get(tag)||0)+1);
const topics=[...topicCounts.keys()].sort((a,b)=>(topicCounts.get(b)-topicCounts.get(a))||a.localeCompare(b,'zh-CN'));
const topicSlides=topics.reduce((n,topic)=>n+Math.max(1,Math.ceil((data.market_limitups||[]).filter(r=>tagsFor(r).includes(topic)).length/7)),0);
const total=1+topicSlides+1+2*candidates.length;
const deck=Presentation.create({slideSize:{width:1600,height:900}});
const manifest=[];
const ink='#183043',muted='#536b7c',accent='#a33b2f',line='#d6e0e6';
const fmt=d=>`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
function text(slide,value,position,size,color=ink,bold=false){
  const box=slide.shapes.add({geometry:'textbox',position,fill:'none',line:{fill:'none',width:0}});
  box.text=String(value);
  box.text.style={typeface:font,fontSize:size,color,bold,autoFit:'shrinkText',wrap:'square',
    verticalAlignment:'middle',insets:{top:0,right:2,bottom:0,left:2}};
  return box;
}
function newSlide(title,kind,notes=''){
  const slide=deck.slides.add();slide.background.fill='#ffffff';
  const page=deck.slides.items.length;
  if(title)text(slide,title,{left:36,top:18,width:1528,height:54},42,ink,true);
  text(slide,String(page),{left:1510,top:868,width:48,height:22},15,muted);
  slide.speakerNotes.textFrame.setText(notes);
  manifest.push({page,title,kind});
  return slide;
}
async function addChart(slide,filename,alt,position){
  const bytes=await fs.readFile(filename);
  if(bytes.length<1000)throw new Error(`图表文件缺失或损坏: ${filename}`);
  slide.images.add({blob:new Uint8Array(bytes),contentType:'image/jpeg',fit:'contain',alt,
    position});
  manifest.at(-1).images=[...(manifest.at(-1).images||[]),path.basename(filename)];
}
function boardSort(status=''){
  if(String(status).includes('首板'))return [1,1];
  const nums=String(status).match(/\d+/g)?.map(Number)||[0];
  const d=String(status).includes('天')?nums[0]:(nums[0]||1), b=String(status).includes('天')?(nums[1]||1):d;
  return [b,d];
}
function displayStatus(row){
  const status=row.status||'连板状态未核实';
  return row.ts_code==='600825.SH'?`${status}（10月13—15日停牌，10月16日复牌）`:status;
}
function codeShort(code){return String(code).replace(/\.(SH|SZ|BJ)$/,'');}
function linkFor(row,topic){return relationScores.get(`${row.ts_code}|${topic}`)||relationScores.get(`${codeShort(row.ts_code)}|${topic}`);}
function patternFor(row){return patternByCode.get(row.ts_code)||patternByCode.get(codeShort(row.ts_code))||null;}
function patternSummary(row){
  if(!row)return '形态数据待核';
  if(row.status==='event_day_only')return '当日刚涨停，涨停后样本不足';
  const tags=row.tags||[],m=row.metrics||[],chunks=[];
  if(tags.includes('涨停价附近强势盘整'))chunks.push('涨停价附近强势盘整');
  const touches=m.support_touches||[];
  if(touches.length){
    const chosen=touches.slice(0,2).map(x=>`${x.level}${x.recovered_by_close?'收复':'未收复'}`).join('、');
    chunks.push(`回踩${chosen}`);
  }
  if(tags.includes('连续高量能'))chunks.push(`连续高量${m.post_volume_days_ge_1_5x||0}日（均量${m.post_volume_avg_vs_pre5}倍）`);
  if(tags.includes('一分钟波动率收缩'))chunks.push(`1分钟波动率收缩至${Math.round(m.latest_vs_first_one_minute_vol*100)}%`);
  return chunks.length?chunks.join('；'):'未达到既定形态阈值';
}
function refsText(refs=[]){return refs.map(x=>`${x.title||'来源'}（${x.date||'日期未标'}）：${x.url||''}`).join('\n');}
function topicInfo(topic){
  const info=research.topics?.[topic]||{};
  if(info.catalyst)return info.catalyst;
  if(['低空经济','飞行汽车'].includes(topic))return research.topic_catalyst||{text:'板块层面的情绪催化包括特斯拉Roadster发布会（其为使用SpaceX推进器的跑车，不是获认证eVTOL，也不构成A股公司订单）；10月16日09:42发布的香港低空产品出海示范区消息属于盘中扩散信息。不能用较晚消息解释开盘即封板。',refs:[]};
  if(['军工','军贸','航空发动机','大飞机','无人机'].includes(topic))return {text:'10月13日公布的珠海航展安排（12月7日至13日，新增无人装备展示区）构成板块层面催化；10月16日午间长征八号甲转运发射工位是较晚的商业航天增量，不能解释早盘全部涨停。未证实所有公司存在共同新增订单。',refs:[{title:'新华社：第十五届中国航展新闻发布会',date:'2026-10-14',url:'https://www.xinhuanet.com/tech/20261014/be4baf5dddcc4f19a4b1a534c4d205ed/c.html'},{title:'长征八号甲转运发射工位',date:'2026-10-16',url:'https://m.nbd.com.cn/articles/2026-10-16/4606450.html'}]};
  if(['并购重组','文化传媒','版权','教育'].includes(topic))return {text:'该标签内存在个股事件差异，不能视为统一板块催化：粤宏远A于10月15日签署收购金旺达100%股权意向；新华传媒为既有重组停牌后复牌；其余公司须按个股公告判断，未找到共同新增催化。',refs:[{title:'粤宏远A收购金旺达意向公告',date:'2026-10-15',url:'https://stock.stockstar.com/notice/SN2026101600000907.shtml'},{title:'新华传媒复牌核查公告',date:'2026-10-16',url:'https://paper.cnstock.com/html/2026-10/16/content_2277920.htm'}]};
  if(['汽车零部件','汽车整车','汽车类','特斯拉概念'].includes(topic))return {text:'特斯拉Roadster发布会提供了汽车与飞行汽车交叉方向的市场话题；它不是A股公司订单或产业认证。对该组股票的涨停解释以各公司业务和直接公告为准，未确认共同新增利好。',refs:[{title:'Reuters：Roadster发布会安排',date:'2026-10-15',url:'https://www.investing.com/news/stock-market-news/tesla-set-to-unveil-next-generation-roadster-sports-ev-after-years-of-delay-4951021'},{title:'Reuters：Roadster使用SpaceX推进器及量产时间',date:'2026-10-16',url:'https://www.investing.com/news/stock-market-news/teslas-new-roadster-turns-in-air-with-spacex-thrusters-wont-land-until-2028-4884724'}]};
  return {text:'截至本次复盘检索，未找到足以解释该题材当日集体涨停的共同新增消息。以下按涨停榜题材标签列示；个股关系、公司公告和未核实之处分别写在对应股票行及备注中。',refs:[]};
}
async function addTopicPages(){
  let topicPage=0;
  for(const topic of topics){
    const rows=(data.market_limitups||[]).filter(r=>tagsFor(r).includes(topic)).sort((a,b)=>{
      const aa=boardSort(a.status),bb=boardSort(b.status),ra=linkFor(a,topic),rb=linkFor(b,topic);
      return bb[0]-aa[0]||bb[1]-aa[1]||((ra?.rank_in_topic||999)-(rb?.rank_in_topic||999))||String(a.lu_time).localeCompare(String(b.lu_time))||a.ts_code.localeCompare(b.ts_code);
    });
    const info=topicInfo(topic), pages=Math.max(1,Math.ceil(rows.length/7));
    for(let part=0;part<pages;part++){
      topicPage++;
      const pageRows=rows.slice(part*7,(part+1)*7);
      const title=`题材 ${String(topicPage).padStart(2,'0')}  ${topic}${part?`（续 ${part+1}/${pages}）`:''}`;
      const allRefs=[...(info.refs||[])];
      for(const r of pageRows){const sr=researchStocks.get(r.ts_code);allRefs.push(...(sr?.refs||[]));}
      const notes=[`榜单日：${summary.anchor_date}`,`KPL快照：${data.kpl_snapshot_as_of||rows[0]?.snap_ts||'未知'}`,
        `题材：${topic}；涨停榜标签数：${rows.length}。KPL题材为多标签，同一股票可重复出现在多个主题。`,
        `催化/原因：${info.text}`,`来源：\n${refsText(allRefs)}`,
        '题材映射说明：股票与主题的关系按公开业务资料、公司公告和已披露项目区分；未核实直接业务关系时会明确标注。'].join('\n');
      const s=newSlide(title,'theme-recap',notes);
      text(s,`${rows.length} 只涨停标签 · 第 ${part+1}/${pages} 页 · 多标签统计，题材家数不可相加`,{left:42,top:76,width:1510,height:32},20,accent,true);
      text(s,info.text,{left:44,top:112,width:1508,height:82},18,muted);
      text(s,'涨停梯队 / 题材内相关度排名（按5分相关度、3分业务阶段、2分稀缺性评分）',{left:44,top:198,width:1508,height:28},17,ink,true);
      const clickableStocks=[];
      pageRows.forEach((r,i)=>{
        const y=225+i*89, sr=researchStocks.get(r.ts_code)||researchStocks.get(codeShort(r.ts_code));
        const score=linkFor(r,topic);
        const status=displayStatus(r);
        const dispName=String(r.name||'').replace(/Ａ/g,'A');
        const rankText=score?`题材排名 ${score.rank_in_topic} · ${score.score_0_10}/10（相关${score.relatedness_0_5}/5 阶段${score.stage_0_3}/3 稀缺${score.scarcity_0_2}/2）`:'题材排名待核';
        const stockText=`${dispName}（${codeShort(r.ts_code)}） ↗`;
        const why=score?.why||sr?.relation||sr?.company_event||'未找到可核实的公司业务关系资料。';
        const role=score?.chain_role||sr?.classification||'关系待核实';
        const limitation=score?.limitation||'题材标签本身不能证明公司已形成收入或订单。';
        text(s,`${String(i+part*7+1).padStart(2,'0')}  ${status}  ${r.lu_time||''}`,{left:48,top:y,width:440,height:24},18,accent,true);
        text(s,stockText,{left:495,top:y,width:385,height:24},18,'#1b66a5',true);
        text(s,rankText,{left:900,top:y,width:650,height:24},14,ink,true);
        text(s,`产业链位置：${role}`,{left:72,top:y+24,width:1468,height:19},14,muted,true);
        text(s,`关联逻辑：${why}`,{left:72,top:y+43,width:1468,height:22},14,ink);
        text(s,`证据边界：${limitation}`,{left:72,top:y+65,width:1468,height:19},13,muted);
        clickableStocks.push({ts_code:r.ts_code,text:stockText});
      });
      if(topic==='低空经济'||topic==='飞行汽车')text(s,'注意：Roadster为火箭推进器跑车，不是合规eVTOL；香港低空示范区报道发表于09:42，不能解释开盘封板。',{left:44,top:850,width:1480,height:20},13,muted);
      manifest.at(-1).topic=topic;manifest.at(-1).stockCodes=pageRows.map(r=>r.ts_code);manifest.at(-1).clickableStocks=clickableStocks;
    }
  }
}
async function addPostLimitupSummary(){
  const counts=postAnalysis.counts||{};
  const byCode=new Map((postAnalysis.stocks||[]).map(x=>[x.ts_code,x]));
  const nameByCode=new Map(candidates.map(x=>[x.ts_code,x.name]));
  const examples=(tag,n=8)=>{
    const rows=(postAnalysis.stocks||[]).filter(x=>(x.tags||[]).includes(tag));
    return rows.slice(0,n).map(x=>`${x.name}（${codeShort(x.ts_code)}）`).join('、')||'无';
  };
  const s=newSlide('涨停后形态观察：截至10月16日','post-limitup-summary',
    [`统计截止：${postAnalysis.as_of}`,`1分钟来源：${postAnalysis.data.minute_source}`,
     `覆盖：${postAnalysis.data.minute_complete_stock_days}/${postAnalysis.data.minute_expected_stock_days}个股票日完整，每日240根；缺失${postAnalysis.data.minute_missing_stock_days}个。`,
     `规则：${JSON.stringify(postAnalysis.method)}`,
     `形态逐股记录在个股页：${(postAnalysis.stocks||[]).length}只候选。分钟波动率采用涨停时间后1分钟收益标准差；分时之外的15分钟数据没有用于补缺或计算。`].join('\n'));
  text(s,`${postAnalysis.post_event_candidate_count} 只在10月16日之前涨停、且已有至少一个涨停后交易日观察`,{left:58,top:92,width:1470,height:36},22,ink,true);
  text(s,'判定结果',{left:58,top:151,width:1470,height:34},24,ink,true);
  text(s,`涨停价附近强势盘整：${counts['涨停价附近强势盘整']||0}只\n${examples('涨停价附近强势盘整',12)}`,{left:70,top:197,width:1455,height:105},18,accent,true);
  text(s,`回踩涨停启动位或MA5/10/20/30：${counts['回踩涨停启动位/均线']||0}只\n均线按各自触及日计算；个股页标注具体位置、日期及触及日收盘是否收复。`,{left:70,top:318,width:1455,height:88},18,ink,true);
  text(s,`连续高量能：${counts['连续高量能']||0}只\n定义为连续至少2日达到涨停前5日均量1.5倍，涨停后日均量至少1.3倍；高量只代表成交活跃，不代表方向。`,{left:70,top:420,width:1455,height:95},18,ink,true);
  text(s,`一分钟波动率收缩：${counts['一分钟波动率收缩']||0}只\n比较涨停时间后第一个有效交易日与最后一个有效日的单分钟收益标准差；需至少2日且下降20%以上。`,{left:70,top:529,width:1455,height:90},18,ink,true);
  text(s,'一分钟波动率收缩样本：',{left:70,top:641,width:245,height:27},17,muted,true);
  text(s,examples('一分钟波动率收缩',12),{left:316,top:641,width:1208,height:55},16,muted);
  text(s,'前复权日线按触及日计算MA；回踩按当日日线最低价距关键位±1.5%判定。涨停当天不计入涨停后日线观察。',{left:70,top:782,width:1450,height:47},16,muted);
  text(s,`分析口径：${postAnalysis.data.minute_complete_stock_days}/${postAnalysis.data.minute_expected_stock_days}个候选股票日一分钟数据完整，无缺口。`,{left:70,top:832,width:1450,height:26},15,muted);
}
const dataDir=path.dirname(process.env.DECK_DATA);
const topThemes=summary.theme_heat.slice(0,8).map(x=>`${x.theme} ${x.limit_up_stocks}只`).join('  |  ');
const dataUpdate=`KPL ${fmt(summary.data_limits.kpl_latest_date)}  日线 ${fmt(summary.data_limits.daily_latest)}  周线 ${fmt(summary.data_limits.weekly_latest)}  月线 ${fmt(summary.data_limits.monthly_latest)}  15分钟 ${fmt(summary.data_limits.fifteen_min_latest)}  1分钟 ${fmt(summary.data_limits.one_min_latest)}`;
{
  const notes=[
    `榜单日：${summary.anchor_date}`,
    `数据来源：${summary.data_source}`,
    `选股口径：${summary.selection}`,
    `题材归属：${summary.theme_assignment}`,
    `排序：${summary.sort_order}`,
    `重要等级：${summary.importance_rule}`,
    `分时数据限制：${summary.intraday_source_note}`,
    `数据截止：${JSON.stringify(summary.data_limits)}`,
    `涨停题材页：${topics.length}个KPL主题标签，按涨停状态分梯队；同一股票可能出现在多个主题。`,
    `KPL快照时间：${data.kpl_snapshot_as_of||'未知'}。该快照为10月16日最终记录，不代表10月16日盘中已经可见。`,
    '图表为离线数据回顾，不构成买卖建议。',
  ].join('\n');
  const s=newSlide(`${fmt(summary.anchor_date)} 涨停题材复盘`,'cover',notes);
  text(s,`${summary.market_limit_up_count} 只当日涨停  ·  ${summary.candidate_count} 只关注标的`,
    {left:56,top:116,width:1480,height:58},40,accent,true);
  text(s,`近5日涨停与近20日连续2板以上并集；当日题材汇总按${topics.length}个KPL标签分组`,
    {left:58,top:194,width:1480,height:44},27,ink);
  text(s,'题材热度（全市场当日涨停家数）',
    {left:58,top:286,width:1480,height:40},25,ink,true);
  text(s,topThemes||'无题材标签',
    {left:60,top:333,width:1480,height:110},23,muted);
  text(s,'报告口径', {left:58,top:492,width:1480,height:38},25,ink,true);
  text(s,`行情数据截止：${dataUpdate}`,
    {left:60,top:538,width:1480,height:42},22,muted);
  text(s,summary.intraday_source_note,
    {left:60,top:584,width:1480,height:82},17,muted);
  text(s,'均线：价格MA5/10/20/30/60/120/250；成交量MA5/20/60。历史不足的周期不显示。',
    {left:60,top:657,width:1480,height:40},21,muted);
  text(s,'重要等级是规则化观察优先级，不是预测分数。具体规则见演示备注。',
    {left:60,top:700,width:1480,height:45},22,muted);
  text(s,'每只股票两页：日线、周线、月线；5日1分钟分时与3个月15分钟K线。',
    {left:60,top:780,width:1480,height:44},24,ink,true);
  text(s,'连板状态来自10月16日最终涨停榜（10月17日21:14归档），不代表10月16日盘中已可见。题材标签为多标签。',
    {left:60,top:828,width:1480,height:28},17,muted);
}
await addTopicPages();
await addPostLimitupSummary();
for(let i=0;i<candidates.length;i++){
  const r=candidates[i];
  const kpl=kplByCode.get(r.ts_code);
  const latestDate=r.latest_limit_up_date||summary.anchor_date;
  const latestStatus=displayStatus({ts_code:r.ts_code,status:r.latest_limit_up_status||kpl?.status||r.anchor_status||'连板状态未核实'});
  const header=`${r.name}（${r.ts_code.replace(/\.(SH|SZ|BJ)$/,'')}）  最近涨停 ${fmt(latestDate)} · ${latestStatus}`;
  const details=`${r.name}  ${r.ts_code}   ${r.anchor_status||r.alert_name}   观察等级 ${r.importance}/5`;
  const companyResearch=researchStocks.get(r.ts_code)||researchStocks.get(r.ts_code.replace(/\.(SH|SZ|BJ)$/,''));
  const shape=patternFor(r),shapeSummary=patternSummary(shape);
  const companyRefs=refsText(companyResearch?.refs||[]);
  const notes=[`股票：${r.name} ${r.ts_code}`,`题材：${r.theme}`,`提醒：${r.alert_name}`,
    `原因：${r.reason}`,`近5日涨停次数：${r.limit_up_count_5d}`,
    `近20日涨停次数：${r.limit_up_count_20d}`,`近20日最高连续板：${r.max_consecutive_boards_20d}`,
    `数据来源：${summary.data_source}`,`数据截止：${summary.chart_cutoff}`,
    `分时：${summary.intraday_source_note}`,
    `最近一次涨停：${latestDate}，KPL状态：${latestStatus}`,`业务关系判断：${companyResearch?.classification||'未整理'}`,
    `业务关系说明：${companyResearch?.relation||companyResearch?.company_event||'暂无可核实说明'}`,
    `涨停后形态观察：${JSON.stringify(shape)}`,
    `形态摘要：${shapeSummary}`,
    `公司来源：\n${companyRefs}`,`图表覆盖：${JSON.stringify(r.chart_coverage)}`,
    '图表是历史行情和事件标注，不构成买卖建议。'].join('\n');
  const s1=newSlide(`${String(i+1).padStart(3,'0')}  ${header}`,'stock-overview',notes);
  text(s1,details,{left:40,top:73,width:1518,height:36},24,accent,true);
  text(s1,`涨停后形态：${shapeSummary}`,{left:42,top:108,width:1510,height:38},16,muted);
  await addChart(s1,path.join(dataDir,r.overview_image),`${r.name}日线周线月线图`,
    {left:32,top:151,width:1536,height:700});
  manifest.at(-1).ts_code=r.ts_code;manifest.at(-1).theme=r.theme;

  const s2=newSlide(`${String(i+1).padStart(3,'0')}  ${header}`,'stock-intraday',notes);
  text(s2,details,{left:40,top:73,width:1518,height:36},24,accent,true);
  text(s2,`涨停后形态：${shapeSummary}。上图为1分钟分时；下方15分钟图只作背景参考。`,
    {left:42,top:108,width:1510,height:38},16,muted);
  await addChart(s2,path.join(dataDir,r.intraday_image),`${r.name}最近5日分时与成交量`,
    {left:32,top:151,width:1536,height:700});
  manifest.at(-1).ts_code=r.ts_code;manifest.at(-1).theme=r.theme;
  if((i+1)%25===0)console.log(`已编排 ${i+1}/${candidates.length} 只股票`);
}

await fs.mkdir(build,{recursive:true});await fs.mkdir(path.dirname(target),{recursive:true});
const candidatePath=path.join(build,'candidate.pptx');
await (await PresentationFile.exportPptx(deck)).save(candidatePath);
const manifestPath=path.join(build,'slide_manifest.json');
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
execFileSync(process.env.RUNTIME_PYTHON,[path.join(path.dirname(new URL(import.meta.url).pathname),'patch_internal_links.py'),candidatePath,manifestPath],{stdio:'inherit'});
const result=await finalizePresentation({workspaceDir:process.env.WORKSPACE_DIR,
  candidatePath,finalPath:target,explicitTotalSlideCount:total,
  requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
  pythonExecutable:process.env.RUNTIME_PYTHON,
  integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','15240000,8572500','--validate-heading-fit'],
  fontPolicy:{basis:'design',families:[font]},verifyArtifactToolImport:true,
  receiptPath:path.join(build,'validation.json')});
console.log(JSON.stringify(result,null,2));
const previewDir=path.join(build,'contact_sheets');await fs.mkdir(previewDir,{recursive:true});
const finalDeck=await PresentationFile.importPptx(await FileBlob.load(target));
if(finalDeck.slides.items.length!==total)throw new Error(`Final PPTX slide count mismatch: ${finalDeck.slides.items.length} vs ${total}`);
const sharp=(await import('sharp')).default;
let tiles=[];
async function flushTiles(pageNo){
  if(!tiles.length)return;
  const columns=5,rows=Math.ceil(tiles.length/columns),width=320,height=180;
  const composites=tiles.map((input,index)=>({input,left:(index%columns)*width,top:Math.floor(index/columns)*height}));
  await sharp({create:{width:columns*width,height:rows*height,channels:3,background:'#f0f2f4'}})
    .composite(composites).jpeg({quality:82}).toFile(path.join(previewDir,`contact-${String(pageNo).padStart(3,'0')}.jpg`));
  tiles=[];
}
for(let i=0;i<finalDeck.slides.items.length;i++){
  const blob=await finalDeck.export({slide:finalDeck.slides.items[i],format:'png',scale:0.2});
  const bytes=Buffer.from(await blob.arrayBuffer());
  const thumb=await sharp(bytes).resize(320,180,{fit:'fill'}).jpeg({quality:78}).toBuffer();
  tiles.push(thumb);
  if(tiles.length===40||i===finalDeck.slides.items.length-1)await flushTiles(Math.floor(i/40)+1);
  if((i+1)%50===0)console.log(`已渲染预览 ${i+1}/${finalDeck.slides.items.length} 页`);
}
console.log(`完成 ${target}，共${finalDeck.slides.items.length}页`);
