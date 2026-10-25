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
