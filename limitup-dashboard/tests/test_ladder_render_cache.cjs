const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
class Element {
 constructor(name='g',attrs={}){this.nodeType=1;this.nodeName=name;this.attrs={...attrs};this.childNodes=[];}
 get attributes(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));}
 get firstChild(){return this.childNodes[0]||null;}
 get lastChild(){return this.childNodes.at(-1)||null;}
 get dataset(){return {vlCardKey:this.attrs['data-vl-card-key'],vlCardToken:this.attrs['data-vl-card-token']};}
 hasAttribute(k){return k in this.attrs;}getAttribute(k){return this.attrs[k]??null;}setAttribute(k,v){this.attrs[k]=String(v);}removeAttribute(k){delete this.attrs[k];}
 hasChildNodes(){return !!this.childNodes.length;}
 appendChild(c){if(c.parent){const index=c.parent.childNodes.indexOf(c);c.parent.childNodes.splice(index,1);}if(c.nodeType===11){for(const item of [...c.childNodes])this.appendChild(item);return c;}this.childNodes.push(c);c.parent=this;return c;}
 cloneNode(deep){const copy=new Element(this.nodeName,this.attrs);if(deep)for(const c of this.childNodes)copy.appendChild(c.cloneNode(true));return copy;}
 querySelectorAll(){return this.childNodes.flatMap(c=>[...(c.hasAttribute('data-vl-card-key')?[c]:[]),...c.querySelectorAll()]);}
 set innerHTML(body){this.childNodes=[];this.appendChild(new Element('body',{content:body}));}
}
const scope={esc:String,ladderView:{cardMarkupCache:new Map(),cardDOMCache:new Map()},Node:{TEXT_NODE:3,COMMENT_NODE:8},document:{createDocumentFragment:()=>Object.assign(new Element('#fragment'),{nodeType:11})}};vm.createContext(scope);
vm.runInContext(source.slice(source.indexOf('  function ladderCardFragment('),source.indexOf('  function patchLadderLegend(')),scope);
vm.runInContext(source.slice(source.indexOf('  function viewCardCache('),source.indexOf('  function paintLimitupLadder(')),scope);
const view={reuseCardDOM:false},data={};let previous=scope.viewCardCache(view,data),next=new Map(),chips=['<rect/>'];
scope.retainLadderCard(chips,0,'A',20,previous,next,view);const token=next.get('A')[0].token;
assert(chips[0].includes('<rect/>'));assert(chips[0].includes('translate(0 20)'));
view.reuseCardDOM=true;previous=next;next=new Map();chips=['<rect/>'];scope.retainLadderCard(chips,0,'A',50,previous,next,view);
assert.equal(next.get('A')[0].token,token);assert(!chips[0].includes('<rect/>'));assert(chips[0].includes('translate(0 50)'));
previous=next;next=new Map();chips=['<rect/><text>展开</text>'];scope.retainLadderCard(chips,0,'A',50,previous,next,view);const expandedToken=next.get('A')[0].token;assert.notEqual(expandedToken,token);
previous=next;next=new Map();chips=['<rect/>'];scope.retainLadderCard(chips,0,'A',50,previous,next,view);assert.equal(next.get('A')[0].token,token);assert.equal(next.get('A').length,2);
const old=new Element('g',{'data-vl-card-key':'A','data-vl-card-token':'1',transform:'translate(0 20)'}),body=new Element('text');old.appendChild(body);
const same=new Element('g',{'data-vl-card-key':'A','data-vl-card-token':'1',transform:'translate(0 60)'});scope.patchLadderDOM(old,same);assert.equal(old.firstChild,body);assert.equal(old.getAttribute('transform'),'translate(0 60)');
const expanded=new Element('g',{'data-vl-card-key':'A','data-vl-card-token':'2'}),expandedBody=new Element('rect');expanded.appendChild(expandedBody);scope.patchLadderDOM(old,expanded);assert.equal(old.firstChild,expandedBody);assert.equal(scope.ladderView.cardDOMCache.get('1').firstChild,body);
const collapsed=new Element('g',{'data-vl-card-key':'A','data-vl-card-token':'1'});scope.patchLadderDOM(old,collapsed);assert.equal(old.firstChild,body);assert.equal(scope.ladderView.cardDOMCache.get('2').firstChild,expandedBody);
scope.ladderView.cardMarkupCache.set('A',[{token:3,body:'correct body'}]);const hydrated=scope.ladderCardFragment(new Element('g',{'data-vl-card-key':'A','data-vl-card-token':'3'}));assert.equal(hydrated.firstChild.getAttribute('content'),'correct body');
view.cardMarkupCache=next;view.cardDOMCache.set('1',body);scope.viewCardCache(view,{});assert.equal(view.cardMarkupCache.size,0);assert.equal(view.cardDOMCache.size,0);
console.log('PASS stable local geometry, untouched-node reuse, exact-content tokens, bounded state variants, DOM fragment restoration and payload invalidation');
