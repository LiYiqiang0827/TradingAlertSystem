// Deterministic async regressions against the actual app.js function bodies.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const pending=new Map(),labels=new Map(),rendered=[],timers=[];
 const state={date:'',dateLoadId:0,stockLoadId:0,indexLoadId:0,review:null};
 const context={state,location:{href:'http://dashboard/?date=old'},content:{innerHTML:''},document:{querySelectorAll:()=>[]},$:s=>{if(!labels.has(s))labels.set(s,{});return labels.get(s)},formatCalendarDate:d=>d,esc:String,renderHome:()=>rendered.push(state.review.date),api:path=>new Promise((resolve,reject)=>pending.set(path,{resolve,reject})),console:{warn:()=>{}},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout:()=>{}};
 vm.createContext(context);vm.runInContext(extract('  function needsReviewDate(', '  async function start('),context);
 return {context,pending,labels,rendered,timers};
}
(async()=>{
 let f=fixture(),c=f.context;
 const older=c.loadDate('20261021'),newer=c.loadDate('20261022');
 f.pending.get('/api/review?date=20261022').resolve({date:'20261022'});assert.equal(await newer,true);
 f.pending.get('/api/review?date=20261021').resolve({date:'20261021'});assert.equal(await older,false);
 assert.equal(c.state.review.date,'20261022');assert.deepEqual(f.rendered,['20261022']);
 const late=c.loadDate('20261020');c.location.href='http://dashboard/?view=ladder';f.pending.get('/api/review?date=20261020').reject(new Error('late failure'));
 assert.equal(await late,false);assert.deepEqual(f.rendered,['20261022']);
 const mismatch=c.loadDate('20261019');f.pending.get('/api/review?date=20261019').resolve({date:'20261018'});assert.equal(await mismatch,false);assert.equal(c.state.review.date,'20261022');
 const failed=c.loadDate('20261019');f.pending.get('/api/review?date=20261019').reject(new Error('network'));assert.equal(await failed,false);
 assert.equal(c.needsReviewDate('20261019'),true);
 // Callers cannot render an older topic after their delayed load returns.
 f=fixture();c=f.context;c.toast=()=>{};c.renderNav=()=>{};const topics=[];c.renderTopic=t=>topics.push(t);c.syncBrowserRoute=()=>{};
 vm.runInContext(extract('  async function openTopic(', '  let ladderRequestId='),c);
 const a=c.openTopic('旧题材','20261021'),b=c.openTopic('新题材','20261022');
 f.pending.get('/api/review?date=20261022').resolve({date:'20261022',topics:[{name:'新题材'}]});await b;
 f.pending.get('/api/review?date=20261021').resolve({date:'20261021',topics:[{name:'旧题材'}]});await a;
 assert.deepEqual(topics,['新题材']);
 // A transient breaks fetch retries; success clears the sticky error and
 // does not duplicate already completed dates or continue a disposed view.
 f=fixture();c=f.context;const view={days:new Set(['20261022']),brokenDates:new Set(),broken:new Map(),dataVersion:'v1'};c.ladderView=view;c.toast=()=>{};let paints=0;c.rebuildVerticalLadder=()=>paints++;
 vm.runInContext(extract('  async function loadLadderBrokenStocks(', '  function mergeLadderPayload('),c);
 const p=c.loadLadderBrokenStocks(view);f.pending.get('/api/ladder-breaks?start=20261022&end=20261022').reject(new Error('transient'));await p;
 assert.equal(view.breakError,true);assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,500);
 const retry=c.loadLadderBrokenStocks(view);f.pending.get('/api/ladder-breaks?start=20261022&end=20261022').resolve({ladderDataVersion:'v1',dates:['20261022'],brokenStocks:[{id:'x'}]});await retry;
 assert.equal(view.breakError,false);assert.equal(view.breakFailures,0);assert.equal(view.broken.size,1);assert.equal(paints,1);
 c.ladderView={};f.timers[0].fn();assert.equal(paints,1);
 // Initial deep links load their review without painting a throwaway home.
 f=fixture();c=f.context;const deep=c.loadDate('20261023',{renderHomePage:false});f.pending.get('/api/review?date=20261023').resolve({date:'20261023'});assert.equal(await deep,true);assert.deepEqual(f.rendered,[]);
 // Leaving an index while its history is in flight must not reopen it.
 f=fixture();c=f.context;c.state.date='20261023';c.renderNav=()=>{};c.goBackInApp=()=>{};const indexRenders=[];c.renderIndex=item=>indexRenders.push(item.code);let finishIndex;c.getIndexHistory=()=>new Promise(resolve=>finishIndex=resolve);
 vm.runInContext(extract('  async function loadIndex(', '  function renderIndex('),c);
 const indexTask=c.loadIndex({code:'000001.SH'});c.location.href='http://dashboard/?view=home';finishIndex({});await indexTask;assert.deepEqual(indexRenders,[]);
 // A stock cache lookup cannot issue a new request after the user leaves.
 f=fixture();c=f.context;c.state.date='20261023';c.state.expandedTopics=new Set();c.renderNav=()=>{};c.applyLadderReturnLink=()=>{};c.requestAnimationFrame=()=>{};c.canonicalStockCode=code=>code;c.goBackInApp=()=>{};const stockRenders=[];c.renderStock=stock=>stockRenders.push(stock.code);c.saveStockCache=()=>{};let finishCache;c.readStockCache=()=>new Promise(resolve=>finishCache=resolve);
 const stockStart=source.indexOf('  async function loadStock(');vm.runInContext(source.slice(stockStart,source.indexOf('\n',stockStart)),c);
 const stockTask=c.loadStock({code:'000001.SZ',name:'股票',topic:'题材'});c.location.href='http://dashboard/?view=ladder';finishCache(null);await stockTask;assert.equal(f.pending.size,0);assert.deepEqual(stockRenders,[]);
 // Hover detail caches must not store a new source revision under an old key.
 f=fixture();c=f.context;vm.runInContext(extract('  const ladderTopicDetailCache=', '  function closeLadderTopicHover('),c);
 const wrong=c.getLadderTopicDetails('20261023','v1');f.pending.get('/api/ladder-topic-details?date=20261023').resolve({ladderDataVersion:'v2'});await assert.rejects(wrong,/行情数据已更新/);
 const valid=c.getLadderTopicDetails('20261023','v1');f.pending.get('/api/ladder-topic-details?date=20261023').resolve({ladderDataVersion:'v1'});assert.equal((await valid).ladderDataVersion,'v1');
 // Peak-theme attribution remains cutoff-aware and never unions restart edges.
 f=fixture();c=f.context;vm.runInContext(extract('  function ladderChainThemes(', '  async function loadLadderBrokenStocks('),c);
 const nodes=[{id:'20261019:A',date:'20261019',code:'A',theme:'早期',board:1,status:'sealed'},{id:'20261021:A',date:'20261021',code:'A',theme:'中期',board:2,status:'sealed'},{id:'20261023:A',date:'20261023',code:'A',theme:'峰值',board:3,status:'sealed'},{id:'20261023:B',date:'20261023',code:'B',theme:'独立',board:1,status:'sealed'}];
 const sealed=new Map(nodes.map(n=>[n.id,n])),links=[{source:nodes[0].id,target:nodes[1].id,status:'promoted',kind:'broken'},{source:nodes[1].id,target:nodes[2].id,status:'promoted',kind:'broken'},{source:nodes[2].id,target:nodes[3].id,status:'relimit'}];
 const before=c.ladderChainThemes(sealed,links,'20261021'),after=c.ladderChainThemes(sealed,links,'20261023');
 assert.equal(before.get(nodes[0].id).theme,'中期');assert.equal(before.has(nodes[2].id),false);assert.equal(after.get(nodes[0].id).theme,'峰值');assert.equal(after.get(nodes[3].id).theme,'独立');assert.equal(after.get(nodes[0].id).originalTheme,'早期');
 console.log('PASS navigation races, route changes, wrong-date response, topic consumers, index/stock navigation, revision guards, deep links, peak-theme attribution and bounded breaks recovery');
})().catch(e=>{console.error(e);process.exitCode=1});
