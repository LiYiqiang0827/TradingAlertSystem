const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),scope={};vm.createContext(scope);
vm.runInContext(source.slice(source.indexOf('  function ladderStockHoverRecord('),source.indexOf('  async function showLadderStockHover(')),scope);
const older={id:'20261015:A',code:'A',date:'20261015',name:'甲',board:3,boardPeriod:'5天3板',status:'sealed'},current={...older,id:'20261023:A',date:'20261023',status:'unpromoted',previousBoard:4,previousBoardPeriod:'6天4板'},chartVersion={...current,status:'failed'};
const context={stocks:new Map([[older.id,older],[current.id,chartVersion]]),view:{legendStockRecords:new Map([[current.id,current]])}};
const anchor=(id,legend=true)=>({dataset:{vlStockPreview:id},closest:selector=>legend&&selector==='#ladderLegend'?{}:null,textContent:' 甲 '});
// Prefer the exact legend status/period, including dates outside the loaded chart window.
assert.equal(scope.ladderStockHoverRecord(context,anchor(current.id)),current);
context.stocks.delete(current.id);assert.equal(scope.ladderStockHoverRecord(context,anchor(current.id)),current);
assert.equal(scope.ladderStockHoverRecord(context,anchor(older.id,false)),older);
const failed=scope.ladderStockHoverRecord(context,anchor('20261016:A:unpromoted',false));assert.equal(failed.date,'20261016');assert.equal(failed.status,'unpromoted');assert.equal(failed.previousBoardPeriod,'5天3板');assert.equal(failed.name,'甲');
assert.equal(scope.ladderStockHoverRecord(context,anchor('20261014:A',false)),null);assert.equal(scope.ladderStockHoverRecord(context,anchor('20261023:B')),null);
assert(source.includes('#ladderLegend .vl-legend-stock-name[data-vl-stock-preview]'));
assert(source.includes('<span data-vl-stock-preview="${esc(stock.id)}" class="vl-legend-stock-name'));
assert(source.includes('const stock=ladderStockHoverRecord(context,anchor)'));
assert(source.includes("chartDayKey(bar)<=stock.date"));
console.log('PASS legend stock hover binding, exact date/status lookup, historical fallback and cutoff');
