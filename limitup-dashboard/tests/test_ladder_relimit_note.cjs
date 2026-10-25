const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),scope={esc:x=>String(x).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')};vm.createContext(scope);
vm.runInContext(source.slice(source.indexOf('  function ladderRelimitEntryNote('),source.indexOf('  function paintLimitupLadder(')),scope);
const measure=(text,size)=>text.length*size,edge={target:'20261023:A',failureDate:'20261020',sourceBoard:3,sessions:3};
let html=scope.ladderRelimitEntryNote(edge,{board:3,patternDays:3},100,40,measure);
assert(html.includes('aria-label="3板 · 10/20 · 3日"'));assert(html.includes('data-vl-relimit-prior-board="3"'));assert(html.includes('>3</text>'));assert(html.includes('>10/20 · 3日</text>'));assert(!html.includes('<path'));
html=scope.ladderRelimitEntryNote({...edge,sourceBoard:0},{board:0,status:'broken'},100,40,measure);assert(html.includes('>破</text>'));assert(html.includes('aria-label="破 · 10/20 · 3日"'));
html=scope.ladderRelimitEntryNote(edge,{board:6,patternDays:7},100,40,measure);assert(html.includes('aria-label="7天6板 · 10/20 · 3日"'));assert(html.includes('data-vl-relimit-prior-board="6"'));assert(html.includes('data-vl-relimit-prior-days="7"'));assert(html.includes('>6</text>'));assert(html.includes('>7</text>'));assert(html.includes('<path'));
html=scope.ladderRelimitEntryNote({...edge,sessions:10},null,100,40,measure);assert(html.includes('aria-label="3板 · 10/20 · 10日"'));assert(!html.includes('undefined'));assert(!html.includes('NaN'));
// Render actual API edge/source pairs when supplied, without changing path data.
if(process.argv[2]){const payload=JSON.parse(fs.readFileSync(process.argv[2])),by=new Map(['sealedStocks','contextStocks','relimitContextStocks','relimitBrokenStocks','nodes'].flatMap(key=>payload[key]||[]).map(n=>[n.id,n]));let count=0;
 for(const edge of payload.relimitLinks||[]){const node=by.get(edge.source);assert(node,'exact source '+edge.source);const before=JSON.stringify(edge),note=scope.ladderRelimitEntryNote(edge,node,100,40,measure);assert(!note.includes('undefined'));assert(!note.includes('NaN'));assert(note.includes('data-vl-relimit-prior-board="'+edge.sourceBoard+'"'));assert.equal(JSON.stringify(edge),before);count++;}
 console.log('PASS actual API relimit entry notes: '+count+' edge/source pairs');}
console.log('PASS broken/continuous/multi-day board badges, date/session labels and fallback');

// Each interrupted or suspended stock owns its exit and matching continuation inlet.
const group='20261020:2:机器人概念',a={source:'20261020:A',kind:'broken'},b={source:'20261020:B',kind:'broken'};
assert.notEqual(scope.ladderPromotionPortKey(group,a),scope.ladderPromotionPortKey(group,b));
assert.notEqual(scope.ladderPromotionPortKey(group,{...a,kind:'suspension'}),scope.ladderPromotionPortKey(group,{...b,kind:'suspension'}));
assert.equal(scope.ladderPromotionPortKey(group,{...a,kind:'continuous'}),scope.ladderPromotionPortKey(group,{...b,kind:'continuous'}));
const targets=new Set(['target:A']);
// A single-stock continuation keeps its count/ratio; only the original circle adopts the theme color.
let inlet=scope.ladderContinuationInlet([{id:'target:A'}],targets,'1/3','#c58b4b');
assert.equal(inlet.label,'1/3');assert(inlet.continuation);assert.equal(inlet.stroke,'#c58b4b');assert.equal(inlet.ink,'#c58b4b');
inlet=scope.ladderContinuationInlet([{id:'target:A'}],targets,'9','#c58b4b');assert.equal(inlet.label,'9');
inlet=scope.ladderContinuationInlet([{id:'target:A'},{id:'target:B'}],targets,'2/3','#c58b4b');
assert.equal(inlet.label,'2/3');assert(!inlet.continuation);assert.equal(inlet.stroke,'#8c9299');
inlet=scope.ladderContinuationInlet([{id:'target:B'}],targets,'1/3','#c58b4b');
assert.equal(inlet.label,'1/3');assert(!inlet.continuation);assert.equal(inlet.ink,'#747b83');
const recovery={source:'source:A',target:'target:A',name:'凡拓数创',sourceBoard:2,failureDate:'20261021',targetDate:'20261023',sessions:2};
const geometry={sx:100,sy:40,tx:200,ty:70,entryX:205.5,singleEntry:false,inletX:190,inletY:50};
html=scope.ladderContinuationMarkers(recovery,{board:2},{name:'凡拓数创',theme:'机器人概念'},geometry,measure,'恢复');
assert.equal((html.match(/data-vl-relimit-entry="/g)||[]).length,1);
assert(html.includes('cx="205.5" cy="70"'));assert(html.includes('>续</text>'));
assert(html.includes('>10/23 · 2日后 · 凡拓数创</text>'));assert(html.includes('>10/21 · 2日 · 凡拓数创</text>'));
assert(html.includes('data-vl-ids="source:A|target:A"'));assert(!html.includes('undefined'));
html=scope.ladderContinuationMarkers(recovery,{board:2},{name:'凡拓数创',theme:'机器人概念'},{...geometry,singleEntry:true},measure,'恢复');
assert(!html.includes('data-vl-relimit-entry="'));assert(html.includes('data-vl-relimit-entry-note="target:A"'));
console.log('PASS per-stock broken/suspended exits, dedicated continuation inlets and named date/session annotations');
