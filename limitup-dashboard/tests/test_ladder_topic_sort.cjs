const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),scope={esc:String,fmtDate:String,ladderHoverThemeTitle:()=>'',ladderHoverBoardBadge:()=>'',ladderHoverOutcomeBadge:()=>'',isLadderGrowthStock:()=>false,compactBoardAmount:String};vm.createContext(scope);
vm.runInContext(source.slice(source.indexOf('  function ladderTopicSortValue('),source.indexOf('  function ladderLegendStockMembers(')),scope);
const stocks=[
 {code:'A',id:'A',name:'A',status:'sealed',hoverTier:1,board:1,time:'10:30:00',pct:10},
 {code:'B',id:'B',name:'B',status:'sealed',hoverTier:1,board:1,time:'09:31:00',pct:20},
 {code:'C',id:'C',name:'C',status:'sealed',hoverTier:1,board:1,time:'9:35:00',pct:5},
 {code:'D',id:'D',name:'D',status:'unpromoted',hoverTier:1,previousBoard:1,pct:-2,time:'09:00:00'},
 {code:'E',id:'E',name:'E',status:'broken',hoverTier:0,pct:0},
 {code:'F',id:'F',name:'F',status:'sealed',hoverTier:5,board:6,time:'09:30:00',pct:9}
],details={stocks:{A:{sealAmount:90000000},B:{sealAmount:120000000},C:{sealAmount:0},D:{sealAmount:900000000,pct:-5}}};
const sorted=key=>Array.from(scope.ladderSortTopicStocks(stocks.slice(0,4),details,key),x=>x.code),before=JSON.stringify({stocks,details});
assert.deepEqual(sorted('time'),['B','C','A','D']);
assert.deepEqual(sorted('sealAmount'),['B','A','C','D']);
assert.deepEqual(sorted('pct'),['B','A','C','D']);
assert.equal(scope.ladderTopicSortValue(stocks[3],details,'time'),null);
assert.equal(scope.ladderTopicSortValue({...stocks[3],touchedLimit:true},{stocks:{D:{time:'11:00:00'}}},'time'),39600);
assert.equal(scope.ladderTopicSortValue({...stocks[0],time:'99:00:00'},details,'time'),null);
assert.equal(scope.ladderTopicSortValue({...stocks[0],pct:''},{},'pct'),null);
assert.equal(scope.ladderTopicSortValue(stocks[2],details,'sealAmount'),0);
assert.equal(JSON.stringify({stocks,details}),before);
const html=scope.renderLadderTopicHover('机器人概念','20261023',stocks,details,false,false,false,'sealAmount');
assert(html.includes('aria-sort="descending"'));assert(html.includes('data-vl-hover-sort="sealAmount"'));assert(html.includes('封板金额<span aria-hidden="true">↓'));
const order=Array.from(html.matchAll(/data-vl-hover-stock="([^"]+)"/g),m=>m[1]);
assert.deepEqual(order,['F','B','A','C','D','E']); // Board sections stay intact; sort within each section.
let called,focused=false;const state={key:'',details,loading:true,error:false},hover={card:{querySelector:()=>({focus:()=>{focused=true;}})}};
assert(scope.sortLadderTopicHover({target:{closest:()=>({dataset:{vlHoverSort:'time'}})},preventDefault(){},stopPropagation(){}},hover,state,(...args)=>{called=args;}));
assert.equal(state.key,'time');assert.equal(called[0],details);assert.equal(called[1],true);assert(focused);
console.log('PASS fixed-direction topic hover sorting, board groups, amount units, missing values, zeroes, immutable data and loading-state retention');
