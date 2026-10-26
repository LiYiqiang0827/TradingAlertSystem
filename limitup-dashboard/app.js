(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const initialDevicePixelRatio = window.devicePixelRatio || 1;
  const state = { date: '', dateLoadId: 0, dates: [], topicDates: {}, review: null, topic: null, stock: null, index: null, indexData: null, indexLoadId: 0, indicesPage: false, expandedTopics: new Set(), indicesExpanded: false, topicsCollapsed: false, navDisplayMode: localStorage.getItem('navDisplayMode') === 'board' ? 'board' : 'theme', collapsedBoardTiers: new Set([0,1,2,3,4,5]), charts: [], chartInstances: [], search: '', chartLayout: localStorage.getItem('chartLayout') || 'standard', uiScalePreference: localStorage.getItem('uiScalePreference') || 'auto', stockDatePreference: localStorage.getItem('stockDatePreference') || 'latest', latestMode: false, stockData: null, stockLoadId: 0 };
  const content = $('#content'), nav = $('#topicNav'), datePicker = $('#datePicker'), appShell = $('.app-shell'), navToggle = $('.collapse');
  function setNavigationCollapsed(collapsed,persist=true){appShell.classList.toggle('nav-collapsed',collapsed);navToggle.textContent=collapsed?'›':'‹';navToggle.setAttribute('aria-label',collapsed?'显示导航栏':'隐藏导航栏');navToggle.title=collapsed?'显示导航栏':'隐藏导航栏';navToggle.setAttribute('aria-expanded',String(!collapsed));if(persist)localStorage.setItem('navigationCollapsed',String(collapsed));}
  setNavigationCollapsed(localStorage.getItem('navigationCollapsed')==='true',false);
  let activeDatePickerTrigger=null,activeChartZoom=null;
  function resizeZoomedChart(host){const chart=state.chartInstances[state.charts.indexOf(host.id)];try{chart?.resize?.()}catch{}}
  function disposeZoomHost(host){if(!host)return;try{window.klinecharts.dispose(host.id)}catch{}const index=state.charts.indexOf(host.id);if(index>=0){state.charts.splice(index,1);state.chartInstances.splice(index,1);}host.remove();}
  function closeChartZoom(){if(!activeChartZoom)return;const {host,parent,nextSibling,disposeOnClose,returnFocus,pendingHost}=activeChartZoom;if(pendingHost&&pendingHost!==host)disposeZoomHost(pendingHost);if(disposeOnClose&&host){disposeZoomHost(host);}else if(host&&parent?.isConnected)parent.insertBefore(host,nextSibling?.parentNode===parent?nextSibling:null);$('#chartZoomOverlay').hidden=true;document.body.classList.remove('chart-zoom-open');activeChartZoom=null;$('#chartZoomControls').hidden=true;$('#chartZoomControls').replaceChildren();$('.chart-zoom-dialog>header').classList.remove('has-index-controls');$('#chartZoomHint').textContent='双击图表或按 Esc 关闭';if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});if(host&&!disposeOnClose)requestAnimationFrame(()=>resizeZoomedChart(host));}
  async function openTopicFullChart(row,key){const code=row?.dataset.stockRow||row?.dataset.unpromotedCode||row?.dataset.brokenCode;if(!code)return;const topic=state.topic,date=state.date,name=row.querySelector('.stock-name')?.textContent?.trim()||code;if(activeChartZoom)closeChartZoom();const mount=$('#chartZoomContent'),overlay=$('#chartZoomOverlay'),host=document.createElement('div');host.id='topic-zoom-chart-'+Date.now();host.className='chart-mount '+(key==='oneMin'?'intraday':'');mount.replaceChildren(host);activeChartZoom={host,parent:mount,nextSibling:null,disposeOnClose:true};$('#chartZoomTitle').textContent=name+' · '+(key==='oneMin'?'1 分钟':'日线');host.innerHTML='<div class="loading"><span class="spinner"></span><p>正在加载完整行情图…</p></div>';overlay.hidden=false;document.body.classList.add('chart-zoom-open');try{const canonicalCode=canonicalStockCode(code),cached=stockMemoryCache.get(canonicalCode);let data=cached&&cached.date===date&&Date.now()-cached.savedAt<STOCK_CACHE_TTL?cached.payload:null;if(!data||data.code&&data.code!==canonicalCode||data.chartSeriesVersion!==6||data.seriesReferenceDate!==shanghaiDateKey()||!Array.isArray(data.suspendedDays))data=await api('/api/stock?code='+encodeURIComponent(canonicalCode)+'&date='+date);if(activeChartZoom?.host!==host||state.topic!==topic||state.date!==date)return;saveStockCache(canonicalCode,date,data);const chartData=state.stockDatePreference==='latest'?mergeChartData(data,data.latest):data;host.replaceChildren();drawChart(host.id,chartData[key]||[],key,code,date,chartData.daily||[],chartData.suspendedDays||[]);host.title='双击图表查看完整K线';host.addEventListener('dblclick',closeChartZoom);}catch(error){if(activeChartZoom?.host!==host)return;host.innerHTML='<div class="empty-state">行情图读取失败：'+esc(error.message)+'</div>';}}function toggleChartZoom(host,title){if(activeChartZoom?.host===host){closeChartZoom();return;}if(activeChartZoom||!host?.isConnected)return;const parent=host.parentElement,mount=$('#chartZoomContent'),overlay=$('#chartZoomOverlay');if(!parent||!mount||!overlay)return;activeChartZoom={host,parent,nextSibling:host.nextSibling};$('#chartZoomTitle').textContent=`${state.stock?.name||''} · ${title}`;overlay.hidden=false;document.body.classList.add('chart-zoom-open');mount.appendChild(host);requestAnimationFrame(()=>resizeZoomedChart(host));}
  content.addEventListener('dblclick',event=>{const liveSource=event.target.closest('[data-live-index-code]');if(liveSource&&isLivePage()){event.preventDefault();event.stopPropagation();openLiveIndexFullChart(liveSource.dataset.liveIndexCode,liveSource.dataset.liveIndexPeriod);return;}const source=event.target.closest('.intraday-mini,.daily-kline-mini');if(!source||!state.topic)return;event.preventDefault();event.stopPropagation();const row=source.closest('tr');openTopicFullChart(row,source.classList.contains('intraday-mini')?'oneMin':'daily');});$('#closeChartZoom').onclick=closeChartZoom;$('#chartZoomOverlay').addEventListener('click',event=>{if(event.target.id==='chartZoomOverlay')closeChartZoom();});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#chartZoomOverlay').hidden)closeChartZoom();});
  // Capture before chart and background page shortcuts; only a focused live-index dialog owns these keys.
  window.addEventListener('keydown',event=>{
    const zoom=activeChartZoom?.requestedLiveIndex||activeChartZoom?.liveIndex,dialog=$('.chart-zoom-dialog');
    if(!zoom||$('#chartZoomOverlay').hidden||!dialog.contains(document.activeElement)||event.altKey||event.ctrlKey||event.metaKey)return;
    const target=event.target;if(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable=true]'))return;
    if(event.key==='Tab'){
      const items=[...dialog.querySelectorAll('button:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(item=>!item.hidden&&item.getClientRects().length);
      const first=items[0],last=items.at(-1),focused=document.activeElement;
      if(first&&(focused===dialog||(!event.shiftKey&&focused===last)||(event.shiftKey&&focused===first))){event.preventDefault();event.stopImmediatePropagation();(event.shiftKey?last:first).focus();}
      return;
    }
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();event.stopImmediatePropagation();if(event.repeat)return;
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      const index=INDEX_CATALOG.findIndex(item=>item.code===zoom.code),item=INDEX_CATALOG[index+(event.key==='ArrowLeft'?-1:1)];
      if(item)openLiveIndexFullChart(item.code,zoom.period);
    }else{
      const periods=['oneMin','fifteenMin','daily','weekly','monthly'],index=periods.indexOf(zoom.period),next=(index+(event.key==='ArrowUp'?-1:1)+periods.length)%periods.length;
      openLiveIndexFullChart(zoom.code,periods[next]);
    }
  },true);
  $('.chart-zoom-dialog').addEventListener('pointerdown',event=>{
    if(activeChartZoom?.liveIndex&&!event.target.closest('button,input,textarea,select,[contenteditable=true]'))$('.chart-zoom-dialog').focus({preventScroll:true});
  },true);
  const INDEX_CATALOG = [{code:'000001.SH',name:'上证指数'},{code:'399001.SZ',name:'深证成指'},{code:'399006.SZ',name:'创业板指'},{code:'000688.SH',name:'科创50'},{code:'000300.SH',name:'沪深300'},{code:'000016.SH',name:'上证50'},{code:'000905.SH',name:'中证500'},{code:'000852.SH',name:'中证1000'}];
  const indexPageCache = new Map();
  const indicesOverviewCache = new Map();
  const marketTurnoverCache = new Map();
  let renderedNavMarkup = null;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDate = d => `${d.slice(0,4)}年${Number(d.slice(4,6))}月${Number(d.slice(6,8))}日`;
  const boardLabel = (value, withSealTime=false) => { const text=String(value??'').trim(); const daysBoard=text.match(/(\d+)天(\d+)板/); const match=text.match(/首板|(?:\d+|[一二三四五六七八九十]+)(?:连板|板)/); const raw=match?.[0]||''; const count=raw?boardNumber(raw):0; const label=daysBoard?`${daysBoard[1]}天${daysBoard[2]}板`:raw?boardCountLabel(count):(text.split(/[；;|/]/)[0].trim()||text); const time=text.match(/(?:封板\s*)?([0-2]\d:[0-5]\d(?::[0-5]\d)?)/)?.[1]; return withSealTime&&time?`${label}：${time}`:label; };
  const topicAliases={'AI短剧':['AI视频','互动影游','影视IP','游戏'],'影视IP':['版权','互动影游','游戏','文化传媒'],'出版传媒':['版权','文化传媒','文创产品'],'文化用品':['文创产品','文化传媒','版权'],'AI软件':['AI应用','AI安全'],'医疗服务':['创新药','医药','流感'],'抗感染':['病毒防治','流感','抗病毒面料'],'化工材料':['染料','氯化亚砜','化工'],'原材料':['有色金属','稀土永磁','非金属材料'],'冰雪':['冰雪产业','热力','温控'],'温控':['热力','深冷装备','天然气'],'低空经济':['飞行汽车','航空发动机','碳纤维'],'军贸':['军工'],'航天装备':['商业航天','卫星导航','航空发动机'],'汽车整车':['汽车零部件','汽车类'],'供应链':['物流','中欧概念','跨境电商'],'物流':['中欧概念','跨境电商'],'固态电池':['电池','先进材料'],'信息安全':['AI安全','网络安全']};
  function themeKeywords(value){const parts=String(value||'').toLowerCase().split(/[、,，;；|/\s与和及&+：:]/).map(x=>x.trim()).filter(x=>x.length>=2&&!/^(其他|概念|题材|公司事件|涨停股完整名单|归因覆盖)$/.test(x));const keys=new Set(parts);for(const part of parts){for(const run of part.match(/[\u4e00-\u9fff]+/g)||[]){for(const n of [2,3])for(let i=0;i<=run.length-n;i++)keys.add(run.slice(i,i+n));}}return keys;}
  function topicThemeMatch(topic,tags){const topicKeys=themeKeywords(topic),tagKeys=themeKeywords(tags);for(const key of topicKeys)for(const alias of topicAliases[key]||[])topicKeys.add(alias.toLowerCase());for(const key of topicKeys)if(tagKeys.has(key))return true;return false;}
  const topicBreakStocks = topic => (state.review.pool?.break_stocks||[]).filter(stock=>String(stock.classification_theme||stock.performance_theme||stock.theme||stock.lu_desc||'暂无题材').trim()===String(topic).trim());
  const topicUnpromotedStocks = topic => (state.review.marketStats?.nonPromotedStocks||[]).filter(stock=>(String(stock.theme||'').trim()||'未分类')===String(topic).trim());
  const topicLadderChart = stocks => { const groups=[{key:5,label:'高板',color:'five',count:0},{key:4,label:'四板',color:'four',count:0},{key:3,label:'三板',color:'three',count:0},{key:2,label:'二板',color:'two',count:0},{key:1,label:'首板',color:'first',count:0}]; (stocks||[]).forEach(stock=>{const level=stockBoardNumber(stock),group=groups.find(item=>item.key===Math.min(level,5));if(group)group.count++;}); return `<div class="topic-ladder-chart" aria-label="题材涨停天梯，柱长按10只封顶">${groups.map(group=>`<div class="topic-ladder-row"><strong>${group.count}</strong><i><b class="${group.color}" style="width:${Math.min(group.count,10)/10*100}%"></b></i><span>${group.label}</span></div>`).join('')}</div>`; };
  const topicLadderCountSummary = stocks => {const groups=[{key:1,label:'首板',count:0},{key:2,label:'二板',count:0},{key:3,label:'三板',count:0},{key:4,label:'四板',count:0},{key:5,label:'高板',count:0}];let highest=0;(stocks||[]).forEach(stock=>{const level=stockBoardNumber(stock);highest=Math.max(highest,level);const group=groups.find(item=>item.key===Math.min(level,5));if(group)group.count++;});return `<small class="topic-ladder-count-summary">最高${highest||0}板 · ${groups.map(group=>`${group.label} ${group.count}`).join(' · ')}</small>`;};

  const num = v => v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('zh-CN', {maximumFractionDigits:2});
  const compactYuan = v => {const n=Number(v);if(v==null||!Number.isFinite(n))return '—';return n>=1e8?`${(n/1e8).toFixed(2)}亿`:n>=1e4?`${(n/1e4).toFixed(2)}万`:n.toFixed(0);};
  const compactBoardAmount = v => {const n=Number(v);if(v==null||!Number.isFinite(n))return '—';return n>=1e8?`${(n/1e8).toFixed(1)}亿`:n>=1e4?`${(n/1e4).toFixed(0)}万`:n.toFixed(0);};
  const moneyFlowAmount = v => {const n=Number(v);if(v==null||!Number.isFinite(n))return '—';const amount=compactYuan(Math.abs(n)*10000);return n>0?`+${amount}`:n<0?`−${amount}`:'0';};
  const moneyFlowTone = v => v==null||!Number.isFinite(Number(v))||Number(v)===0?'':Number(v)>0?'moneyflow-inflow':'moneyflow-outflow';
  const moneyFlowFacts = stock => [['净流入额',moneyFlowAmount(stock.moneyflow_net_amount),moneyFlowTone(stock.moneyflow_net_amount)],['主力净流入',moneyFlowAmount(stock.main_net_flow_amount),moneyFlowTone(stock.main_net_flow_amount)]];
  const topicTradingHeaders = '<th>主力净流入</th><th>量比</th><th>成交额</th>';
  const topicLimitUpSpanHeader = '<th>跨度</th>';
  const topicLimitUpSpanCell = stock => `<td class="amount-cell topic-limitup-span">${stock?.previousLimitUpHistoricalFirst?'历史首板':stock?.previousLimitUpTradingDays==null?'—':`${Number(stock.previousLimitUpTradingDays)}日`}</td>`;
  const topicMinuteCache = new Map();
  const topicIntradayPlaceholder = label => `<span class="intraday-placeholder">${label}</span>`;
  const topicIntradaySvg = (chart,code) => {
    if(!chart||!Array.isArray(chart.points)||chart.points.length<2)return topicIntradayPlaceholder('无数据');
    const samples=chart.points.map((point,index)=>({point:Number(point),volume:Number(chart.volumes?.[index]??0)})).filter(item=>Number.isFinite(item.point));
    const lower=Number(chart.lower),upper=Number(chart.upper);
    if(samples.length<2||!Number.isFinite(lower)||!Number.isFinite(upper)||upper<=lower)return topicIntradayPlaceholder('无数据');
    const span=upper-lower,y=value=>27-Math.max(0,Math.min(1,(value-lower)/span))*23;
    const path=samples.map((item,i)=>`${(i/(samples.length-1)*88+2).toFixed(1)},${y(item.point).toFixed(1)}`).join(' ');
    const zeroY=y(0).toFixed(1),topY=y(upper).toFixed(1),bottomY=y(lower).toFixed(1),maxVol=Math.max(...samples.map(item=>Math.max(0,item.volume)),1);
    const volumeLines=samples.map((item,i)=>{const x=i/(samples.length-1)*88+2,prev=samples[i-1]?.point??item.point,color=item.point>=prev?'#c6534d':'#20a37a',height=Math.max(.5,Math.max(0,item.volume)/maxVol*11);return `<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${(46-height).toFixed(2)}" y2="46" stroke="${color}" stroke-width=".55"/>`;}).join('');
    return `<div class="intraday-mini" title="${esc(code)}：上方为每分钟收盘涨幅，下方为每分钟成交量；涨幅纵轴范围为跌停至涨停"><svg viewBox="0 0 92 48" role="img" aria-label="${esc(code)}当日每分钟收盘涨幅与成交量，纵轴从跌停幅度到涨停幅度"><line x1="2" x2="90" y1="${topY}" y2="${topY}" stroke="#d9dedb" stroke-width=".5"/><line x1="2" x2="90" y1="${zeroY}" y2="${zeroY}" stroke="#c9cfcb" stroke-width=".6" stroke-dasharray="2 2"/><line x1="2" x2="90" y1="${bottomY}" y2="${bottomY}" stroke="#d9dedb" stroke-width=".5"/><polyline points="${path}" fill="none" stroke="#c6534d" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="1" x2="91" y1="32" y2="32" stroke="#59636a" stroke-width=".55"/>${volumeLines}</svg></div>`;
  };
  const topicDailyKlineCache = new Map();
  const topicDailyKlineSvg = (bars,code,asOf='') => {
    if(!Array.isArray(bars)||!bars.length)return topicIntradayPlaceholder('无数据');
    const valid=bars.slice(-20).map(bar=>Array.isArray(bar)?bar.map(Number):[]).filter(bar=>bar.length>=5&&bar.slice(0,5).every(Number.isFinite));
    if(!valid.length)return topicIntradayPlaceholder('无数据');
    const lo=Math.min(...valid.map(bar=>bar[2])),hi=Math.max(...valid.map(bar=>bar[1])),span=hi-lo||Math.max(Math.abs(hi)*.01,.01);
    const maxVol=Math.max(...valid.map(bar=>Math.max(0,bar[4])),1),priceTop=2,priceBottom=29,volumeTop=34,volumeBottom=46;
    const y=value=>priceBottom-(value-lo)/span*(priceBottom-priceTop),slot=88/valid.length,bodyWidth=Math.min(2.6,slot*.55);
    const candles=valid.map((bar,i)=>{const x=2+slot*(i+.5),[open,high,low,close,volume]=bar,color=close>=open?'#d9534f':'#20a37a',bodyTop=Math.min(y(open),y(close)),bodyHeight=Math.max(1,Math.abs(y(open)-y(close))),volumeHeight=Math.max(.7,Math.max(0,volume)/maxVol*(volumeBottom-volumeTop));return `<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${y(high).toFixed(2)}" y2="${y(low).toFixed(2)}" stroke="${color}" stroke-width=".9"/><rect x="${(x-bodyWidth/2).toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" fill="${color}"/><line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${(volumeBottom-volumeHeight).toFixed(2)}" y2="${volumeBottom}" stroke="${color}" stroke-width=".7"/>`;}).join('');
    return `<div class="daily-kline-mini" title="${esc(code)}：${asOf?`截至${fmtDate(asOf)}，`:''}最近${valid.length}个交易日日K及成交量"><svg viewBox="0 0 92 48" role="img" aria-label="${esc(code)}${asOf?`截至${fmtDate(asOf)}，`:''}最近${valid.length}个交易日日K和成交量"><line x1="1" x2="91" y1="31.5" y2="31.5" stroke="#59636a" stroke-width=".6"/>${candles}</svg></div>`;
  };
  async function loadTopicDailyKline(name,stocks){
    const date=state.date,key=`${date}:${name}`,codes=stocks.map(stock=>stock.ts_code).filter(Boolean);
    const paint=series=>{const shortCodes=Object.fromEntries(Object.entries(series||{}).map(([code,bars])=>[code.slice(0,6),bars]));content.querySelectorAll('tr[data-stock-row],tr[data-unpromoted-code],tr[data-broken-code]').forEach(row=>{const code=row.dataset.stockRow||row.dataset.unpromotedCode||row.dataset.brokenCode,cell=row.querySelector('.daily-kline-cell');if(cell)cell.innerHTML=topicDailyKlineSvg(shortCodes[code],code);});};
    if(topicDailyKlineCache.has(key)){paint(topicDailyKlineCache.get(key));return;}
    try{
      const data=await api(`/api/topic_daily_kline?date=${encodeURIComponent(date)}&codes=${encodeURIComponent(codes.join(','))}`);
      if(state.date!==date||state.topic!==name)return;
      topicDailyKlineCache.set(key,data.series||{});paint(data.series||{});
    }catch(error){if(state.date!==date||state.topic!==name)return;content.querySelectorAll('.daily-kline-cell').forEach(cell=>cell.innerHTML=topicIntradayPlaceholder('读取失败'));}
  }
  async function loadTopicIntraday(name,stocks){
    const date=state.date,key=`${date}:${name}`,codes=stocks.map(stock=>stock.ts_code).filter(Boolean);
    const paint=series=>{const shortCodes=Object.fromEntries(Object.entries(series||{}).map(([code,chart])=>[code.slice(0,6),chart]));content.querySelectorAll('tr[data-stock-row],tr[data-unpromoted-code],tr[data-broken-code]').forEach(row=>{const code=row.dataset.stockRow||row.dataset.unpromotedCode||row.dataset.brokenCode,cell=row.querySelector('.intraday-cell');if(cell)cell.innerHTML=topicIntradaySvg(shortCodes[code],code);});};
    if(topicMinuteCache.has(key)){paint(topicMinuteCache.get(key));return;}
    try{
      const data=await api(`/api/topic_intraday?date=${encodeURIComponent(date)}&codes=${encodeURIComponent(codes.join(','))}`);
      if(state.date!==date||state.topic!==name)return;
      topicMinuteCache.set(key,data.series||{});paint(data.series||{});
    }catch(error){if(state.date!==date||state.topic!==name)return;content.querySelectorAll('.intraday-cell').forEach(cell=>cell.innerHTML=topicIntradayPlaceholder('读取失败'));}
  }
  const topicTradingCells = stock => `<td class="amount-cell topic-main-flow ${moneyFlowTone(stock?.main_net_flow_amount)}">${moneyFlowAmount(stock?.main_net_flow_amount)}</td><td class="amount-cell topic-volume-ratio">${stock?.volume_ratio==null||!Number.isFinite(Number(stock.volume_ratio))?'—':Number(stock.volume_ratio).toFixed(2)}</td><td class="amount-cell topic-daily-amount">${compactYuan(stock?.daily_amount)}</td>`;
  const topicValuationHeaders = '<th>总市值</th><th>流通市值</th><th>自由换手率</th>';
  const topicValuationCells = stock => `<td class="amount-cell topic-total-mv">${compactMarketCap(stock?.total_mv)}</td><td class="amount-cell topic-float-mv">${compactMarketCap(stock?.float_mv)}</td><td class="amount-cell topic-free-turnover">${stock?.free_float_turnover_rate==null||!Number.isFinite(Number(stock.free_float_turnover_rate))?'—':`${Number(stock.free_float_turnover_rate).toFixed(2)}%`}</td>`;
  const topicHighChangeCell = stock => {const value=priceChangePct(stock?.daily_high,stock?.pre_close);return `<td class="amount-cell ${value==='—'?'pct-muted':Number(stock.daily_high)>=Number(stock.pre_close)?'pct-up':'pct-down'}">${value}</td>`;};
  const topicCloseChangeCell = stock => {const value=priceChangePct(stock?.daily_close,stock?.pre_close);return `<td class="amount-cell ${value==='—'?'pct-muted':Number(stock.daily_close)>=Number(stock.pre_close)?'pct-up':'pct-down'}">${value}</td>`;};



  const compactMarketCap = v => {const n=Number(v);if(v==null||!Number.isFinite(n))return '—';return n>=1e12?`${(n/1e12).toFixed(2)}万亿`:n>=1e8?`${(n/1e8).toFixed(2)}亿`:n>=1e4?`${(n/1e4).toFixed(2)}万`:n.toFixed(0);};
  const marketCapBadge = v => {const n=Number(v);if(v==null||!Number.isFinite(n))return '<span class="market-cap-badge unknown" title="总市值缺失">—</span>';const [label,tier]=n<5e9?['微','micro']:n<2e10?['小','small']:n<1e11?['中','mid']:['大','large'];return `<span class="market-cap-badge ${tier}" title="总市值 ${compactMarketCap(n)}">${label}</span>`;};
  const openingDuration = (first,last) => {const toSeconds=value=>{const text=String(value||'').trim(),match=text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);if(match)return Number(match[1])*3600+Number(match[2])*60+Number(match[3]||0);const digits=text.match(/^\d{1,6}$/)?.[0];if(!digits)return null;const padded=digits.padStart(6,'0');return Number(padded.slice(0,2))*3600+Number(padded.slice(2,4))*60+Number(padded.slice(4,6));};const start=toSeconds(first),end=toSeconds(last);if(start==null||end==null||end<start)return '—';let seconds=end-start;if(start<13*3600&&end>=13*3600)seconds-=90*60;const minutes=Math.max(0,Math.floor(seconds/60));return String(minutes);};
  const sealedAmountRatio = stock => {const amount=Number(stock.amount),order=Number(stock.limit_order);return amount>0&&Number.isFinite(order)?`${(order/amount*100).toFixed(1)}%`:'—';};
  const priceChangePct = (price,base) => {const p=Number(price),b=Number(base);return price!=null&&base!=null&&Number.isFinite(p)&&Number.isFinite(b)&&b!==0?`${(p/b-1>=0?'+':'')}${((p/b-1)*100).toFixed(2)}%`:'—';};
  const dailyAmplitudePct = stock => {const high=Number(stock.daily_high),low=Number(stock.daily_low),base=Number(stock.pre_close);return stock.daily_high!=null&&stock.daily_low!=null&&stock.pre_close!=null&&Number.isFinite(high)&&Number.isFinite(low)&&Number.isFinite(base)&&base!==0?`${((high-low)/base*100).toFixed(2)}%`:'—';};
  function canonicalStockCode(value){const raw=String(value||'').trim().toUpperCase(),code=raw.slice(0,6);if(/^\d{6}$/.test(code)){const sources=[...(state.review?.pool?.stocks||[]),...(state.review?.pool?.break_stocks||[]),...(state.review?.marketStats?.nonPromotedStocks||[]),...(state.review?.topics||[]).flatMap(topic=>topic.stocks||[])];const match=sources.find(stock=>String(stock.ts_code||'').slice(0,6)===code)?.ts_code;if(match)return String(match).toUpperCase();}return raw;}
  const tushareCode = value => canonicalStockCode(value);
  async function api(path, opts) { const r=await fetch(path,opts); const data=await r.json(); if(!r.ok || data.error) throw new Error(data.error || `请求失败 ${r.status}`); return data; }

  let liveStatus=null,liveEnabled=false,liveRequestId=0,liveBusy=false,liveClockOffset=0;
  const liveClockFormat=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  function updateMarketClock(){const now=new Date(Date.now()+liveClockOffset),clock=$('#marketClock'),parts=liveClockFormat.format(now).split(' ');clock.dateTime=now.toISOString();clock.querySelector('span').textContent=parts[0];clock.querySelector('strong').textContent=parts[1];if(ladderView?.live)updateLiveLadderLabel(ladderView,liveEnabled?'':'实时已暂停 · '+ladderView.live.updatedAt.slice(11,19));}
  const isLivePage=()=>history.state?.view==='live';
  function applyLiveControls(){
    const status=$('#marketStatus'),toggle=$('#liveDataToggle');
    if(liveStatus){status.textContent=liveStatus.label;status.dataset.phase=liveStatus.phase;status.title=liveStatus.calendarKnown?'北京时间 · 含开盘集合竞价':'交易日历暂不可用';}
    toggle.disabled=!liveStatus;toggle.setAttribute('aria-checked',String(liveEnabled));
    $('#liveNav').hidden=!liveEnabled;$('#liveMonitorLink').classList.toggle('active',isLivePage());
    if(!liveEnabled&&activeChartZoom?.liveIndex)closeChartZoom();
    if(!liveEnabled&&isLivePage()&&state.review)openHome(state.date,'replace');
    syncLivePushConnection();if(ladderView?.live)updateLiveLadderLabel(ladderView,liveEnabled?'':'实时已暂停 · '+ladderView.live.updatedAt.slice(11,19));
  }
  async function refreshMarketStatus(){
    try{
      const data=await api('/api/live-status',{cache:'no-store'});
      receiveLiveMarketStatus(data);
    }catch{const label=$('#marketStatus');label.textContent='状态不可用';label.title='暂时无法连接交易状态服务';}
  }
  function livePageShell(){
    disposeLiveIndexCharts();
    content.classList.remove('six-grid-page');state.stockLoadId++;state.indexLoadId++;
    state.topic=null;state.stock=null;state.index=null;state.indicesPage=false;
    $('#crumbCurrent').textContent='实时监控';$('#crumbCurrent').hidden=false;
    $('#crumbBack').hidden=true;$('#crumbWorkspace').hidden=true;$('#crumbSeparator').hidden=true;
    $('#topbarActions').innerHTML='<button id="refreshLive" class="light-button" type="button">刷新</button>';
    $('#refreshLive').onclick=()=>refreshLivePage();
    content.innerHTML='<div class="live-page-heading"><div class="live-heading-copy"><span class="eyebrow">LIVE MONITOR</span><h1>实时监控</h1><div id="liveMonitorMeta" class="live-monitor-meta"></div></div><div class="live-header-indices"><div class="live-indices-group"><div class="live-period-switch" role="group" aria-label="指数图表周期"><button type="button" data-live-period="oneMin" title="1分钟分时">1</button><button type="button" data-live-period="fifteenMin" title="15分钟K线">15</button><button type="button" data-live-period="daily" title="日K线">日</button><button type="button" data-live-period="weekly" title="周K线">周</button><button type="button" data-live-period="monthly" title="月K线">月</button></div><div class="live-indices-scroll"><div id="liveIndicesGrid" class="live-indices-grid"></div></div><button id="liveIndexGroupToggle" class="live-index-group-toggle" type="button" aria-label="切换指数分组">›</button></div></div></div><div id="liveMonitorBody" class="live-monitor-body" aria-live="polite">正在连接实时数据…</div>';
    setupLiveIndexSwitches();if(state.review)renderNav();applyLiveControls();
  }
  function liveIndexZoomSeries(zoom,live){
    const key=zoom.period,day=zoom.date,base=zoom.baseData;
    const today=live.today?{...live.today,volume:live.today.volume/100,amount:live.today.turnover/1000}:null;
    const dailyMap=new Map((base.daily||[]).map(bar=>[bar.timestamp,bar]));if(today)dailyMap.set(today.timestamp,today);
    const daily=[...dailyMap.values()].sort((a,b)=>a.timestamp-b.timestamp);
    const incoming=(live.series||[]).map(bar=>{
      if(key==='oneMin')return {...bar,volume:bar.turnover||0,amount:bar.turnover||0};
      if(key==='fifteenMin')return {...bar,amount:bar.volume};
      return {...bar,volume:bar.volume/100,...(bar.turnover!=null?{amount:bar.turnover/1000}:{})};
    });
    let bars;
    if(key==='oneMin'||key==='fifteenMin'){
      bars=[...(base[key]||[]).filter(bar=>chartDayKey(bar)<day),...incoming.filter(bar=>chartDayKey(bar)===day)].sort((a,b)=>a.timestamp-b.timestamp);
      if(key==='oneMin'){const days=[...new Set(bars.map(chartDayKey))].sort().slice(-5);bars=bars.filter(bar=>days.includes(chartDayKey(bar)));}
    }else{
      const byPeriod=new Map((base[key]||[]).map(bar=>[chartPeriodKey(bar,key),bar]));
      incoming.forEach(bar=>byPeriod.set(chartPeriodKey(bar,key),bar));bars=[...byPeriod.values()].sort((a,b)=>a.timestamp-b.timestamp);
    }
    return {bars,daily};
  }
  function updateLiveIndexZoom(data){
    const active=activeChartZoom,zoom=active?.liveIndex;
    if(!zoom||!zoom.baseData||data.period!==zoom.period||data.group!==zoom.group||data.status.date!==zoom.date)return;
    if(!observeIndexDataVersion(data))return;
    if(zoom.baseData.indexDataVersion!==data.indexDataVersion){
      if(!zoom.revalidating){zoom.revalidating=true;getIndexHistory(zoom.code,zoom.date).then(base=>{if(activeChartZoom===active&&active.liveIndex===zoom){zoom.baseData=base;updateLiveIndexZoom(data);}}).catch(error=>console.warn('指数历史缓存更新失败，将在下次刷新重试',error)).finally(()=>{zoom.revalidating=false;});}
      return;
    }
    const live=data.indices.find(item=>item.code===zoom.code);if(!live||live.seriesError)return;
    const next=liveIndexZoomSeries(zoom,live);if(!next.bars.length)return;
    const old=zoom.bars;zoom.bars=next.bars;
    const samePrefix=old.length<=next.bars.length&&old.slice(0,-1).every((bar,i)=>JSON.stringify(bar)===JSON.stringify(next.bars[i]));
    if(samePrefix&&zoom.push){for(const bar of next.bars.slice(Math.max(0,old.length-1)))zoom.push(bar);}
    else zoom.chart?.resetData();
    const last=next.bars.at(-1);
    zoom.chart?.overrideOverlay?.({id:'selected-limitup-close-'+zoom.period,points:[{timestamp:last.timestamp,value:last.close}]});
  }
  function renderLiveIndexZoomControls(zoom){
    const controls=$('#chartZoomControls'),position=INDEX_CATALOG.findIndex(item=>item.code===zoom.code),periods=[['oneMin','1'],['fifteenMin','15'],['daily','日'],['weekly','周'],['monthly','月']];
    controls.hidden=false;$('.chart-zoom-dialog>header').classList.add('has-index-controls');
    controls.innerHTML=`<div class="zoom-index-nav"><button type="button" data-zoom-step="-1" ${position<=0?'disabled':''}>← 上一个</button><span class="zoom-index-position">${position+1}/${INDEX_CATALOG.length}</span><button type="button" data-zoom-step="1" ${position>=INDEX_CATALOG.length-1?'disabled':''}>下一个 →</button></div><div class="zoom-index-periods" role="tablist" aria-label="指数大图周期">${periods.map(([key,label])=>`<button type="button" role="tab" data-zoom-period="${key}" aria-selected="${key===zoom.period}" tabindex="${key===zoom.period?0:-1}" class="${key===zoom.period?'active':''}">${label}</button>`).join('')}</div>`;
    controls.querySelectorAll('[data-zoom-step]').forEach(button=>button.onclick=()=>{const item=INDEX_CATALOG[position+Number(button.dataset.zoomStep)];if(item)openLiveIndexFullChart(item.code,zoom.period);});
    controls.querySelectorAll('[data-zoom-period]').forEach(button=>button.onclick=()=>{if(button.dataset.zoomPeriod!==zoom.period)openLiveIndexFullChart(zoom.code,button.dataset.zoomPeriod);});
    controls.onkeydown=event=>{
      if(!event.target.closest('[data-zoom-period]'))return;
      const index=periods.findIndex(([key])=>key===zoom.period);let next=index;
      if(event.key==='Home')next=0;else if(event.key==='End')next=periods.length-1;else return;
      event.preventDefault();const period=periods[next][0];if(period!==zoom.period)openLiveIndexFullChart(zoom.code,period);controls.querySelector(`[data-zoom-period="${period}"]`)?.focus();
    };
  }
  let liveZoomHostId=0;
  async function openLiveIndexFullChart(code,period){
    if(!liveEnabled||!isLivePage())return;
    const item=INDEX_CATALOG.find(entry=>entry.code===code),labels={oneMin:'1 分钟',fifteenMin:'15 分钟',daily:'日线',weekly:'周线',monthly:'月线'};
    if(!item||!labels[period])return;
    const returnFocus=activeChartZoom?.returnFocus||document.querySelector(`[data-live-index-code="${code}"]`)||document.activeElement;
    if(activeChartZoom&&!activeChartZoom.liveIndex)closeChartZoom();
    const mount=$('#chartZoomContent'),group=Math.floor(INDEX_CATALOG.indexOf(item)/4),date=liveStatus?.date||shanghaiDateKey();
    const zoom={code,period,group,date,baseData:null,bars:[],push:null,chart:null};
    const existing=activeChartZoom,active=existing||{host:null,parent:mount,nextSibling:null,disposeOnClose:true,returnFocus};
    if(existing?.liveIndex?.code===code&&existing.liveIndex.period===period&&!existing.requestedLiveIndex)return;
    if(active.pendingHost)disposeZoomHost(active.pendingHost);
    active.pendingHost=null;active.requestedLiveIndex=zoom;const switchId=active.switchId=(active.switchId||0)+1;
    activeChartZoom=active;renderLiveIndexZoomControls(zoom);
    const dialog=$('.chart-zoom-dialog');
    // Replacing focused controls must not send keyboard focus back to the page.
    if(!dialog.contains(document.activeElement))dialog.focus({preventScroll:true});
    if(!existing){
      const placeholder=document.createElement('div');placeholder.className='chart-mount';
      placeholder.innerHTML='<div class="loading"><span class="spinner"></span><p>正在加载完整指数行情…</p></div>';
      mount.replaceChildren(placeholder);active.host=placeholder;active.liveIndex=zoom;$('#chartZoomTitle').textContent=item.name;
      $('#chartZoomOverlay').hidden=false;document.body.classList.add('chart-zoom-open');dialog.focus({preventScroll:true});
    }
    $('#chartZoomHint').textContent=existing?'正在切换… · ↑↓ 周期 · ←→ 指数':'↑↓ 周期 · ←→ 指数 · Esc 关闭';
    const current=()=>activeChartZoom===active&&active.switchId===switchId&&liveEnabled&&isLivePage();
    let host=null;
    try{
      const [base,data]=await Promise.all([getIndexHistory(code,date),getLiveIndexSnapshot(group,period,date)]);
      if(!current())return;
      const live=data.indices.find(entry=>entry.code===code);if(!live||live.seriesError)throw new Error(live?.seriesError||'没有找到实时指数行情');
      observeIndexDataVersion(data);zoom.baseData=base;const next=liveIndexZoomSeries(zoom,live);zoom.bars=next.bars;
      if(!zoom.bars.length)throw new Error('该周期暂无行情数据');
      // Paint a connected, full-size staging chart while the previous canvas stays visible.
      host=document.createElement('div');host.id='live-index-zoom-'+(++liveZoomHostId);host.className='chart-mount '+(['oneMin','fifteenMin'].includes(period)?'intraday':'');
      const previous=active.host;mount.style.position='relative';host.style.position='absolute';host.style.left=previous.offsetLeft+'px';host.style.top=previous.offsetTop+'px';host.style.width=previous.clientWidth+'px';host.style.setProperty('height',previous.clientHeight+'px','important');host.style.visibility='hidden';
      mount.append(host);active.pendingHost=host;
      host.addEventListener('dblclick',closeChartZoom);
      drawChart(host.id,zoom.bars,period,code,date,next.daily,[],{isIndex:true,stream:{getBars:()=>zoom.bars,subscribe:callback=>{zoom.push=callback;},unsubscribe:()=>{zoom.push=null;}}});
      zoom.chart=state.chartInstances[state.charts.indexOf(host.id)];if(!zoom.chart)throw new Error('图表初始化失败');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(!current()){disposeZoomHost(host);return;}
      active.host=host;active.pendingHost=null;active.liveIndex=zoom;active.requestedLiveIndex=null;
      disposeZoomHost(previous);['position','left','top','width','height','visibility'].forEach(key=>host.style.removeProperty(key));
      $('#chartZoomTitle').textContent=item.name;$('#chartZoomHint').textContent='↑↓ 周期 · ←→ 指数 · Esc 关闭';
      zoom.chart.resize();if(base.indexDataVersion!==data.indexDataVersion)updateLiveIndexZoom(data);
    }catch(error){
      if(host)disposeZoomHost(host);if(!current())return;active.pendingHost=null;active.requestedLiveIndex=null;
      if(active.liveIndex?.chart){renderLiveIndexZoomControls(active.liveIndex);if(!dialog.contains(document.activeElement))dialog.focus({preventScroll:true});$('#chartZoomHint').textContent='切换失败，保留原图：'+error.message;}
      else active.host.innerHTML='<div class="empty-state">指数行情读取失败：'+esc(error.message)+'</div>';
    }
  }
  function openLiveMonitor(historyMode='push'){
    if(!liveEnabled)return;
    syncBrowserRoute('live',state.date,'','',historyMode);livePageShell();refreshLivePage();
  }
  const liveIndexCharts=new Map();
  let liveIndexGroup=0,liveIndexPeriod='oneMin';
  function syncLiveIndexSwitches(){
    document.querySelectorAll('[data-live-period]').forEach(button=>{const active=button.dataset.livePeriod===liveIndexPeriod;button.setAttribute('aria-pressed',String(active));button.classList.toggle('active',active);});
    const button=$('#liveIndexGroupToggle');if(button){button.textContent=liveIndexGroup?'‹':'›';button.title=liveIndexGroup?'切换至上证、深成指、创业板、科创50':'切换至沪深300、上证50、中证500、中证1000';button.setAttribute('aria-label',button.title);}
  }
  function changeLiveIndexSelection(){
    liveRequestId++;syncLiveIndexSwitches();
    const cached=readLiveIndexSnapshot(liveIndexGroup,liveIndexPeriod);if(cached)renderLiveIndices(cached);
    refreshLivePage(true);
  }
  function setupLiveIndexSwitches(){
    document.querySelectorAll('[data-live-period]').forEach(button=>button.onclick=()=>{if(liveIndexPeriod===button.dataset.livePeriod)return;liveIndexPeriod=button.dataset.livePeriod;changeLiveIndexSelection();});
    $('#liveIndexGroupToggle').onclick=()=>{liveIndexGroup=1-liveIndexGroup;changeLiveIndexSelection();};syncLiveIndexSwitches();
  }
  function disposeLiveIndexCharts(){for(const entry of liveIndexCharts.values())entry.observer?.disconnect();liveIndexCharts.clear();}
  function ensureLiveMonitorLayout(){
    const body=$('#liveMonitorBody');if(!body)return false;
    if(!$('#livePoolGrid'))body.innerHTML='<p id="liveIndicesError" class="live-data-error" hidden></p><div id="livePoolGrid" class="live-monitor-grid"></div>';
    return true;
  }
  function liveSessionMinute(timestamp){const d=new Date(timestamp+8*3600000),minute=d.getUTCHours()*60+d.getUTCMinutes();return minute>=780?120+minute-780:minute-570;}
  function drawLivePercentChart(entry){
    if(entry.period!=='oneMin'){drawLiveIndexCandles(entry);return;}
    const {host,bars,prevClose,limit}=entry;
    if(!bars.length||!Number.isFinite(prevClose)||prevClose<=0){host.innerHTML='<div class="empty-state">'+(bars.length?'暂无昨收价':'暂无当日 tick 数据')+'</div>';return;}
    const width=Math.max(100,host.clientWidth),height=host.clientHeight||60,left=3,right=3,top=3,bottom=height-13,volumeTop=height-10,volumeBottom=height-2,plotWidth=width-left-right;
    const points=bars.map(bar=>({bar,x:left+Math.max(0,Math.min(240,liveSessionMinute(bar.timestamp)))/240*plotWidth,pct:(Number(bar.close)/prevClose-1)*100}));
    const y=pct=>top+(limit-pct)/(2*limit)*(bottom-top),zero=y(0),maxVolume=Math.max(1,...bars.map(bar=>Number(bar.volume)||0));
    const path=points.map((point,i)=>`${i?'L':'M'}${point.x.toFixed(2)},${y(point.pct).toFixed(2)}`).join(' '),id=host.id;
    const grid=[limit,0,-limit].map(value=>{const yy=y(value);return `<line x1="${left}" x2="${width-right}" y1="${yy}" y2="${yy}" stroke="${value===0?'#77817f':'#28312f'}" stroke-dasharray="${value===0?'4 3':'2 3'}"/>`;}).join('');
    const volume=points.map((point,i)=>{const previous=i?points[i-1].bar.close:prevClose,color=point.bar.close>=previous?'#d45555':'#148a69',yy=volumeBottom-(Number(point.bar.volume)||0)/maxVolume*(volumeBottom-volumeTop);return `<line x1="${point.x}" x2="${point.x}" y1="${volumeBottom}" y2="${yy}" stroke="${color}" stroke-width=".7"/>`;}).join('');
    const last=points.at(-1);
    host.innerHTML=`<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="${esc(entry.name)}当日分时涨跌幅，最新${last.pct.toFixed(2)}%"><defs><clipPath id="${id}-up"><rect x="${left}" y="${top}" width="${plotWidth}" height="${zero-top}"/></clipPath><clipPath id="${id}-down"><rect x="${left}" y="${zero}" width="${plotWidth}" height="${bottom-zero}"/></clipPath></defs><g font-family="Arial,sans-serif" font-size="9">${grid}<line x1="${left+plotWidth/2}" x2="${left+plotWidth/2}" y1="${top}" y2="${volumeBottom}" stroke="#34413c" stroke-dasharray="3 4"/><path d="${path}" fill="none" stroke="#e16c65" stroke-width="1.3" clip-path="url(#${id}-up)"/><path d="${path}" fill="none" stroke="#44ad8e" stroke-width="1.3" clip-path="url(#${id}-down)"/><circle cx="${last.x}" cy="${y(last.pct)}" r="2" fill="${last.pct>=0?'#e16c65':'#44ad8e'}"/>${volume}</g></svg>`;
  }
  function drawLiveIndexCandles(entry){
    const {host,bars}=entry;if(!bars.length){host.innerHTML='<div class="empty-state">'+esc(entry.error||'暂无该周期行情')+'</div>';return;}
    const width=Math.max(100,host.clientWidth),height=host.clientHeight||60,left=3,right=3,top=3,bottom=height-13,volumeBottom=height-2;
    const maValues=bars.flatMap(bar=>Object.values(bar.ma||{})).filter(Number.isFinite);
    const min=Math.min(...bars.map(bar=>Number(bar.low)),...maValues),max=Math.max(...bars.map(bar=>Number(bar.high)),...maValues),range=Math.max(max-min,Math.abs(max)*.002,.01),gap=(width-left-right)/bars.length,bodyWidth=Math.max(.7,Math.min(5,gap*.7)),maxVolume=Math.max(1,...bars.map(bar=>Number(bar.volume)||0));
    const y=value=>top+(max+range*.05-value)/(range*1.1)*(bottom-top);
    const candles=bars.map((bar,i)=>{const x=left+(i+.5)*gap,color=bar.close>=bar.open?'#e16c65':'#44ad8e',yy=Math.min(y(bar.open),y(bar.close)),hh=Math.max(.7,Math.abs(y(bar.open)-y(bar.close))),volumeHeight=(Number(bar.volume)||0)/maxVolume*8;return `<line x1="${x}" x2="${x}" y1="${y(bar.high)}" y2="${y(bar.low)}" stroke="${color}" stroke-width=".7"/><rect x="${x-bodyWidth/2}" y="${yy}" width="${bodyWidth}" height="${hh}" fill="${color}"/><line x1="${x}" x2="${x}" y1="${volumeBottom}" y2="${volumeBottom-volumeHeight}" stroke="${color}" stroke-width=".7"/>`;}).join('');
    const movingAverages=[[5,'#f5b841'],[10,'#a97ed7'],[20,'#4879d4'],[30,'#d15091']].map(([period,color])=>{
      let connected=false;
      const path=bars.map((bar,i)=>{const value=bar.ma?.[period];if(!Number.isFinite(value)){connected=false;return '';}const command=connected?'L':'M';connected=true;return `${command}${(left+(i+.5)*gap).toFixed(2)},${y(value).toFixed(2)}`;}).join(' ');
      return path?`<path class="live-mini-ma-line" data-ma-period="${period}" d="${path}" fill="none" stroke="${color}" stroke-width=".8"/>`:'';
    }).join('');
    const label=({fifteenMin:'15分钟',daily:'日',weekly:'周',monthly:'月'})[entry.period];
    host.innerHTML=`<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="${esc(entry.name)}${label}K线"><line x1="${left}" x2="${width-right}" y1="${(top+bottom)/2}" y2="${(top+bottom)/2}" stroke="#34413c" stroke-dasharray="3 4"/>${candles}${movingAverages}</svg>`;
  }
  function updateLivePercentChart(id,item,limit,period){
    const host=document.getElementById(id);if(!host)return;
    let entry=liveIndexCharts.get(id);
    if(entry&&entry.host!==host){entry.observer?.disconnect();liveIndexCharts.delete(id);entry=null;}
    if(!entry){entry={host};liveIndexCharts.set(id,entry);entry.observer=new ResizeObserver(()=>drawLivePercentChart(entry));entry.observer.observe(host);}
    Object.assign(entry,{bars:item.series||item.oneMin,prevClose:Number(item.quote?.prevClose),name:item.name,limit,period,error:item.seriesError});drawLivePercentChart(entry);
  }
  function renderLiveIndices(data){
    const grid=$('#liveIndicesGrid');if(!grid)return;
    const identity=data.status.date+':'+data.period+':'+data.group+':'+data.indices.map(item=>item.code).join(',');
    if(grid.dataset.identity!==identity){
      disposeLiveIndexCharts();grid.dataset.identity=identity;
      grid.innerHTML=data.indices.map((item,i)=>`<article class="live-index-card"><header><strong>${esc(item.name)}</strong><span id="live-index-quote-${i}"></span></header><div id="live-index-minute-${i}" class="live-index-chart live-percent-chart" tabindex="0" data-live-index-code="${esc(item.code)}" data-live-index-period="${esc(data.period)}" title="双击放大图表"></div></article>`).join('');
    }
    const magnitudes=data.indices.flatMap(item=>{const base=Number(item.quote?.prevClose);return base>0?item.oneMin.map(bar=>Math.abs((Number(bar.close)/base-1)*100)):[];}),limit=Math.max(1,Math.ceil(Math.max(0,...magnitudes)*2)/2);
    data.indices.forEach((item,i)=>{
      const quote=item.quote,pct=quote?.prevClose>0?(quote.price/quote.prevClose-1)*100:null,validPct=pct!=null&&Number.isFinite(pct),color=validPct?(pct>0?'up':pct<0?'down':'flat'):'flat';
      $(`#live-index-quote-${i}`).innerHTML=quote?`<b class="${color}">${Number(quote.price).toFixed(2)}</b><em class="${color}">${validPct?(pct>0?'+':'')+pct.toFixed(2)+'%':'—'}</em>`:'—';
      updateLivePercentChart(`live-index-minute-${i}`,item,limit,data.period);
    });
  }

  // Shared by compact cards and the full chart: 10-second memory snapshots and one request per key.
  const LIVE_INDEX_CACHE_TTL=10000,liveIndexSnapshots=new Map(),liveIndexSnapshotRequests=new Map();
  function readLiveIndexSnapshot(group,period,date=liveStatus?.date||shanghaiDateKey()){
    const key=`${date}:${group}:${period}`,record=liveIndexSnapshots.get(key);
    if(record&&Date.now()-record.savedAt<LIVE_INDEX_CACHE_TTL&&record.payload.indexDataVersion===indexCacheRevision)return record.payload;
    if(record)liveIndexSnapshots.delete(key);return null;
  }
  function getLiveIndexSnapshot(group,period,date=liveStatus?.date||shanghaiDateKey(),force=false){
    const cached=!force&&readLiveIndexSnapshot(group,period,date);if(cached)return Promise.resolve(cached);
    const key=`${date}:${group}:${period}`;if(liveIndexSnapshotRequests.has(key))return liveIndexSnapshotRequests.get(key);
    const task=api(`/api/live-indices?group=${group}&period=${period}`,{cache:'no-store'}).then(data=>{
      if(data.status.date!==date)throw new Error('行情日期已变化，请重新打开图表');
      if(observeIndexDataVersion(data)){
        for(const [oldKey,record] of liveIndexSnapshots)if(Date.now()-record.savedAt>=LIVE_INDEX_CACHE_TTL||record.payload.indexDataVersion!==indexCacheRevision)liveIndexSnapshots.delete(oldKey);
        liveIndexSnapshots.set(key,{savedAt:Date.now(),payload:data});
      }
      return data;
    }).finally(()=>{if(liveIndexSnapshotRequests.get(key)===task)liveIndexSnapshotRequests.delete(key);});
    liveIndexSnapshotRequests.set(key,task);return task;
  }
  async function refreshLivePage(reuseIndexCache=false){
    if(!liveEnabled||!isLivePage()||liveBusy)return;
    liveBusy=true;const requestId=++liveRequestId;
    try{
      const zoom=activeChartZoom?.liveIndex,needsZoomData=zoom&&(zoom.group!==liveIndexGroup||zoom.period!==liveIndexPeriod);
      const [indices,pools,zoomData]=await Promise.allSettled([getLiveIndexSnapshot(liveIndexGroup,liveIndexPeriod,undefined,!reuseIndexCache),api('/api/live',{cache:'no-store'}),needsZoomData?getLiveIndexSnapshot(zoom.group,zoom.period,zoom.date,!reuseIndexCache):Promise.resolve(null)]);
      if(requestId!==liveRequestId||!liveEnabled||!isLivePage()||!ensureLiveMonitorLayout())return;
      const status=indices.status==='fulfilled'?indices.value.status:pools.status==='fulfilled'?pools.value.status:liveStatus;
      $('#liveMonitorMeta').textContent=status?`${fmtDate(status.date)} · ${status.label} · 主动推送`:'';
      const error=$('#liveIndicesError');error.hidden=indices.status==='fulfilled';
      if(indices.status==='fulfilled'){observeIndexDataVersion(indices.value);renderLiveIndices(indices.value);updateLiveIndexZoom(indices.value);}
      else{error.textContent=indices.reason.message+'；图中保留上次快照。';document.querySelectorAll('.live-index-time').forEach(label=>label.textContent='连接中断 · 保留上次快照');}
      if(zoomData.status==='fulfilled'&&zoomData.value)updateLiveIndexZoom(zoomData.value);
      const updated=pool=>pool.updatedAt?new Date(pool.updatedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
      $('#livePoolGrid').innerHTML=pools.status==='fulfilled'?[['zt','涨停监测'],['break','开板监测']].map(([key,label])=>{const pool=pools.value.pools[key];return `<section class="panel"><h2>${label}</h2><strong class="live-pool-count">${pool.available?pool.count:'—'}</strong><small>${pool.available?`更新于 ${updated(pool)}`:'暂无当日实时快照'}</small></section>`}).join(''):`<div class="empty-state">${esc(pools.reason.message)}</div>`;
    }catch(error){if(isLivePage()){const target=$('#liveIndicesError');if(target){target.hidden=false;target.textContent='图表更新失败：'+error.message;}}}
    finally{liveBusy=false;if(requestId!==liveRequestId&&liveEnabled&&isLivePage())refreshLivePage(true);}
  }
  let liveEventSource=null,livePushTimer=0,livePushPending=null,livePushRunning=false;
  const livePushedQuotes=new Map();
  function receiveLiveMarketStatus(data){
    const previous=liveStatus?.phase;liveStatus=data;liveClockOffset=Date.parse(data.serverTime)-Date.now();updateMarketClock();
    const choice=sessionStorage.getItem(`liveData:${data.date}`);liveEnabled=choice===null?data.defaultEnabled:choice==='true';applyLiveControls();
    if(previous!==data.phase&&ladderView?.live){ladderView.live.frozen=data.phase==='recess';updateLiveLadderLabel(ladderView);}
  }
  function patchPushedStockQuotes(event){
    const date=event.status?.date;if(!date)return;
    for(const row of event.quotes||[]){
      const key=date+':'+row.code,prior=livePushedQuotes.get(key);if(prior&&prior.timestamp>row.timestamp)continue;
      const value=Number(row.pct);if(row.pct==null||!Number.isFinite(value))continue;
      const quote={...row,pct:value,date};livePushedQuotes.set(key,quote);
    }
    for(const quote of event.indices||[]){
      for(const name of document.querySelectorAll(`#ladderTopicHover .vl-date-index [data-index-preview="${quote.code}"][data-index-date="${date}"]`)){
        const box=name.parentElement,pct=Number(quote.pct),span=box.querySelector('span'),price=box.querySelector('b'),amount=box.querySelector('small');
        if(span&&quote.pct!=null&&Number.isFinite(pct)){span.textContent=(pct>0?'+':'')+pct.toFixed(2)+'%';span.classList.toggle('pct-up',pct>0);span.classList.toggle('pct-down',pct<0);}
        if(price&&quote.price!=null)price.textContent=num(quote.price);
        if(amount&&quote.amount!=null)amount.textContent=compactYuan(Number(quote.amount));
      }
    }
    const view=ladderView;if(!view?.data||view.endDay!==date)return;
    let changed=false;
    const patch=stock=>{if(stock.date===date){const quote=livePushedQuotes.get(date+':'+stock.code);if(quote&&stock.pct!==quote.pct){stock.pct=quote.pct;changed=true;}}};
    for(const map of [view.sealed,view.unpromoted,view.broken])for(const stock of map.values())patch(stock);
    for(const data of [view.data,view.liveLegendPayload,view.specifiedLegendPayload])if(data)for(const list of [data.nodes,data.sealedStocks,data.unpromotedStocks,data.brokenStocks])for(const stock of list||[])patch(stock);
    if(!changed)return;
    for(const el of document.querySelectorAll(`#ladderChart [data-vl-pct-date="${date}"],#ladderLegend [data-vl-pct-date="${date}"]`)){
      const quote=livePushedQuotes.get(date+':'+el.dataset.vlStockPct);if(!quote)continue;
      const text=(quote.pct>0?'+':'')+quote.pct.toFixed(2)+'%',row=el.closest('[data-vl-legend-stock]');
      if(row)row.title=row.title.replace(' · 涨幅 '+el.textContent+' · ',' · 涨幅 '+text+' · ');
      if(el.textContent!==text)el.textContent=text;
      const legend=Boolean(row);el.classList.toggle(legend?'pct-up':'vl-live-up',quote.pct>0);el.classList.toggle(legend?'pct-down':'vl-live-down',quote.pct<0);
    }
    // Quotes update text in place; rebuilding the legend cannot change its membership.
    for(const key of view.cardMarkupCache?.keys()||[])if(key.startsWith(date+':'))view.cardMarkupCache.delete(key);view.cardDOMCache?.clear();
  }
  function queueLivePush(event){
    if(event.status)receiveLiveMarketStatus(event.status);
    if(!liveEnabled||document.hidden)return;
    if(ladderView&&event.receivedAt)ladderView.lastPushReceivedAt=event.receivedAt;
    patchPushedStockQuotes(event);
    livePushPending||={kinds:new Set(),codes:new Set(),resync:false,ladderStatus:null};
    for(const item of event.updates||[]){livePushPending.kinds.add(item.kind);for(const code of item.codes||[])livePushPending.codes.add(code);}
    for(const quote of event.quotes||[])livePushPending.codes.add(quote.code);
    livePushPending.resync||=Boolean(event.resync);if(event.ladderStatus)livePushPending.ladderStatus=event.ladderStatus;
    if(!livePushTimer&&!livePushRunning)livePushTimer=setTimeout(flushLivePush,100);
  }
  async function refreshPushedHover(hover){
    if(!hover||hover.card.hidden||!hover.liveRefresh||hover.card.dataset.date!==shanghaiDateKey())return;
    if(hover.liveRefreshBusy){hover.liveRefreshPending=true;return;}
    hover.liveRefreshBusy=true;const requestId=hover.requestId;
    try{await hover.liveRefresh();}
    catch(error){if(requestId===hover.requestId&&!hover.card.hidden){hover.card.dataset.refreshError=error.message;hover.card.title='更新暂不可用，保留上一快照：'+error.message;}}
    finally{hover.liveRefreshBusy=false;if(hover.liveRefreshPending){hover.liveRefreshPending=false;if(requestId===hover.requestId)refreshPushedHover(hover);}}
  }
  async function flushLivePush(){
    livePushTimer=0;const pending=livePushPending;livePushPending=null;if(!pending||!liveEnabled||document.hidden)return;
    livePushRunning=true;
    try{
      const {kinds,resync,codes}=pending,jobs=[];
      if(resync){liveIndexSnapshots.clear();jobs.push(refreshMarketStatus());}
      if(kinds.has('snapshot_index'))liveIndexSnapshots.clear();
      if(resync||['snapshot','limitperformance','zt','break'].some(kind=>kinds.has(kind))){
        for(const cache of [ladderDateDetailCache,ladderTopicDetailCache])for(const key of cache.keys())if(key.startsWith((liveStatus?.date||shanghaiDateKey())+':'))cache.delete(key);
      }
      if(ladderView&&history.state?.view==='ladder'&&(resync||['snapshot','limitperformance','zt','break'].some(kind=>kinds.has(kind))))jobs.push(refreshLiveLadder(pending.ladderStatus,resync));
      if(isLivePage()&&(resync||['snapshot_index','zt','break'].some(kind=>kinds.has(kind))))jobs.push(refreshLivePage());
      if(resync||kinds.has('snapshot_index'))jobs.push(refreshPushedHover(indexHover));
      if(resync||codes.has(ladderStockHover?.card.dataset.stock)||kinds.has('minute'))jobs.push(refreshPushedHover(ladderStockHover));
      await Promise.allSettled(jobs);
      // Refresh seal amounts only for visible stock rows, after the source cache is invalidated.
      if((resync||['limitperformance','zt','break'].some(kind=>kinds.has(kind)))&&document.querySelector('#ladderLegend .vl-legend-stock-row'))ladderView?.refreshLegendStocks?.();
    }finally{livePushRunning=false;if(livePushPending&&!livePushTimer)livePushTimer=setTimeout(flushLivePush,100);}
  }
  function syncLivePushConnection(){
    const closeSnapshot=history.state?.view==='ladder'&&ladderView?.live?.mode==='close';
    if((!liveEnabled&&!closeSnapshot)||document.hidden){if(liveEventSource)liveEventSource.close();liveEventSource=null;document.documentElement.dataset.liveTransport='paused';$('#liveDataToggle').title=liveEnabled?'页面在后台，推送暂停':'实时推送已暂停';return;}
    if(liveEventSource)return;
    if(!window.EventSource){document.documentElement.dataset.liveTransport='unsupported';return;}
    const source=liveEventSource=new EventSource('/api/live-events');document.documentElement.dataset.liveTransport='connecting';$('#liveDataToggle').title='正在连接主动推送';
    source.addEventListener('ready',event=>{if(source!==liveEventSource)return;document.documentElement.dataset.liveTransport='sse';$('#liveDataToggle').title=closeSnapshot?'收盘快照同步中（SSE）':'主动推送已连接（SSE）';const data=JSON.parse(event.data);queueLivePush(data);if(closeSnapshot&&data.ladderStatus)refreshLiveLadder(data.ladderStatus);});
    source.addEventListener('market',event=>{if(source!==liveEventSource)return;const data=JSON.parse(event.data);document.documentElement.dataset.liveEventId=event.lastEventId;document.documentElement.dataset.liveEventAt=data.receivedAt;queueLivePush(data);});
    source.addEventListener('heartbeat',event=>{if(source!==liveEventSource)return;const data=JSON.parse(event.data);if(data.status)receiveLiveMarketStatus(data.status);document.documentElement.dataset.liveHeartbeatAt=data.status?.serverTime||'';if(ladderView?.live?.mode==='close'&&data.ladderStatus)refreshLiveLadder(data.ladderStatus);});
    source.onerror=()=>{if(source===liveEventSource){document.documentElement.dataset.liveTransport='reconnecting';$('#liveDataToggle').title='主动推送重连中';const label=$('#ladderLiveStatus');if(label)label.textContent='推送重连中 · 保留上一快照';}};
  }
  function setupLiveNavigation(){
    updateMarketClock();setInterval(updateMarketClock,1000);
    $('#liveMonitorLink').onclick=()=>openLiveMonitor();
    $('#liveDataToggle').onclick=()=>{if(!liveStatus)return;liveEnabled=!liveEnabled;sessionStorage.setItem(`liveData:${liveStatus.date}`,String(liveEnabled));liveRequestId++;applyLiveControls();};
    refreshMarketStatus();
    document.addEventListener('visibilitychange',()=>{syncLivePushConnection();if(!document.hidden&&!liveEventSource)refreshMarketStatus();});
  }

  function routeUrl(route){const params=new URLSearchParams();params.set('date',route.date);if(route.view&&route.view!=='home')params.set('view',route.view);if(route.topic)params.set('topic',route.topic);if(route.stock)params.set('stock',route.stock);if(route.index)params.set('index',route.index);if(route.outcome)params.set('outcome',route.outcome);if(route.view==='ladder'&&route.ladderEnd)params.set('ladderEnd',route.ladderEnd);return `${location.pathname}?${params.toString()}`;}
  function syncBrowserRoute(view='home',date=state.date,topic='',stock='',mode='push',outcome='',index='',ladderEnd=''){closeLadderStockHover();closeIndexHover();const previous=history.state,parent=mode==='push'&&previous?.tradingAlert,ladderReturn=['home','topic','stock','index'].includes(view)?(previous?.view==='ladder'?captureLadderReturn():previous?.ladderReturn||null):null;const route={tradingAlert:true,view,date,topic,stock,index,outcome,ladderEnd,ladderReturn,indexCutoff:view==='index'&&(['ladder','indices'].includes(previous?.view)||Boolean(previous?.indexCutoff)),hasAppParent:Boolean(parent)};const url=routeUrl(route);if(mode==='push'&&history.state?.tradingAlert&&routeUrl(history.state)===url)return route;history[`${mode}State`](route,'',url);return route;}
  function routeFromLocation(){if(history.state?.tradingAlert)return history.state;const params=new URLSearchParams(location.search),date=params.get('date')||'',view=params.get('view')||'home';return {tradingAlert:true,date,view,topic:params.get('topic')||'',stock:params.get('stock')||'',index:params.get('index')||'',outcome:params.get('outcome')||'',ladderEnd:params.get('ladderEnd')||params.get('ladderStart')||''};}
  function captureLadderReturn(){
    const view=ladderView,chart=$('#ladderChart');if(!chart&&view?.returnSnapshot)return view.returnSnapshot;
    return {date:history.state?.date||state.date,endDay:view?.endDay||history.state?.ladderEnd||state.date,lowDay:state.dates[view?.low]||'',visibleDays:[...(view?.visibleDays||[])],left:chart?.scrollLeft||0,top:chart?.scrollTop||0,focusedTheme:view?.focusedTheme||'',focusedStock:view?.focusedStock||'',stockOnly:view?.stockOnly??false,legendStocksAll:view?.legendStocksAll??false,legendStockOverrides:[...(view?.legendStockOverrides||[])],compactTheme:view?.compactTheme||'',compactThemes:[...(view?.compactThemes||[])],specifiedDayEnabled:view?.specifiedDayEnabled??true,legendCollapsed:view?.legendCollapsed??true,specifiedDay:view?.specifiedDay||'',minBoard:view?.minBoard||0,hiddenLevels:[...(view?.hiddenLevels||[])],expandedUnpromoted:[...(view?.expandedUnpromoted||[])],aggregateInitialized:[...(view?.aggregateInitialized||[])],liveSummaryFolded:{...(view?.liveSummaryFolded||{})},foldOtherThemes:view?.foldOtherThemes??true,foldBreakThemes:view?.foldBreakThemes??true,foldSecondFailed:view?.foldSecondFailed??true,foldHigherFailed:view?.foldHigherFailed??true,normalViewport:view?.normalViewport||null,themeColors:[...(view?.themeColors||new Map())]};
  }
  function applyLadderReturnLink(){
    const route=history.state,home=route?.view==='home',origin=route?.ladderReturn;
    if(!home&&(!origin||!['topic','stock','index'].includes(route?.view)))return;
    const back=$('#crumbBack');back.hidden=false;back.textContent='← 返回涨停天梯';
    back.onclick=()=>returnToLadderForDate();
    $('#crumbCurrent').hidden=true;$('#crumbWorkspace').hidden=true;$('#crumbSeparator').hidden=true;
  }
  async function returnToLadderForDate(){
    const origin=history.state?.ladderReturn||ladderView?.returnSnapshot;
    const days=(origin?.visibleDays?.length?origin.visibleDays:[origin?.lowDay,origin?.endDay]).filter(Boolean).sort();
    if(origin&&days.length&&state.date>=days[0]&&state.date<=days.at(-1))return returnToLadder(origin);
    await openLadderDate(state.date);
  }
  async function returnToLadder(origin){
    const date=state.dates.includes(origin.date)?origin.date:origin.endDay,endDay=state.dates.includes(origin.endDay)?origin.endDay:date;
    syncBrowserRoute('ladder',date,'','','push','', '',endDay);if(needsReviewDate(date)&&!await loadDate(date))return;await renderLimitupLadder();
    const view=ladderView;if(!view?.data||history.state?.view!=='ladder')return;const low=state.dates.indexOf(origin.lowDay);
    while(low>=0&&view.low>low&&ladderView===view&&history.state?.view==='ladder'){const before=view.low;await loadVerticalLadder('older');if(view.low>=before)break;}
    if(ladderView!==view||history.state?.view!=='ladder')return;
    view.specifiedDayEnabled=origin.specifiedDayEnabled??true;view.legendCollapsed=origin.legendCollapsed??true;view.specifiedDay=origin.specifiedDay||view.endDay;view.compactTheme=origin.compactTheme||'';view.compactThemes=origin.compactThemes||[origin.compactTheme].filter(Boolean);view.minBoard=origin.minBoard||0;view.hiddenLevels=new Set(origin.hiddenLevels||[]);view.focusedTheme=origin.focusedTheme||'';view.focusedStock=origin.focusedStock||'';view.stockOnly=origin.stockOnly??false;view.legendStocksAll=origin.legendStocksAll??false;view.legendStockOverrides=new Map(origin.legendStockOverrides||[]);view.normalViewport=origin.normalViewport;view.expandedUnpromoted=new Set(origin.expandedUnpromoted||[]);view.aggregateInitialized=new Set(origin.aggregateInitialized||[]);view.liveSummaryFolded={...(origin.liveSummaryFolded||{})};view.foldOtherThemes=origin.foldOtherThemes??true;view.foldBreakThemes=origin.foldBreakThemes??true;view.foldSecondFailed=origin.foldSecondFailed??true;view.foldHigherFailed=origin.foldHigherFailed??true;for(const [theme,color] of origin.themeColors||[])if(!ladderThemeColors.has(theme))ladderThemeColors.set(theme,color);view.themeColors=new Map(ladderThemeColors);paintLimitupLadder(view.data);
    const chart=$('#ladderChart');chart.scrollLeft=origin.left||0;chart.scrollTop=origin.top||0;view.updateLegend?.();
  }
  const STOCK_CACHE_TTL=24*60*60*1000, STOCK_CACHE_LIMIT=30;
  function shanghaiDateKey(){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return parts.year+parts.month+parts.day;}
  const stockMemoryCache=new Map();let stockCacheDbPromise=null;let stockNavigationTimer=null,pendingStockTarget=null;
  function saveMemoryStock(code,date,payload,savedAt=Date.now()){const now=Date.now();for(const [key,value] of stockMemoryCache){if(now-value.savedAt>=STOCK_CACHE_TTL)stockMemoryCache.delete(key);}stockMemoryCache.delete(code);stockMemoryCache.set(code,{date,payload,savedAt});while(stockMemoryCache.size>STOCK_CACHE_LIMIT)stockMemoryCache.delete(stockMemoryCache.keys().next().value);}
  function openStockCache(){if(!('indexedDB' in window))return Promise.reject(new Error('IndexedDB unavailable'));if(!stockCacheDbPromise)stockCacheDbPromise=new Promise((resolve,reject)=>{const request=indexedDB.open('tradingalert-stock-cache',1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('stocks'))request.result.createObjectStore('stocks',{keyPath:'code'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return stockCacheDbPromise;}
  async function readStockCache(code,date){const mem=stockMemoryCache.get(code);if(mem&&Date.now()-mem.savedAt<STOCK_CACHE_TTL&&mem.date===date)return mem.payload;if(mem&&Date.now()-mem.savedAt>=STOCK_CACHE_TTL)stockMemoryCache.delete(code);try{const db=await openStockCache(),record=await new Promise((resolve,reject)=>{const request=db.transaction('stocks','readonly').objectStore('stocks').get(code);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});if(!record)return null;if(Date.now()-record.savedAt>=STOCK_CACHE_TTL){deleteBrowserStock(code);return null;}if(record.date!==date)return null;saveMemoryStock(code,date,record.payload,record.savedAt);return record.payload;}catch(error){console.warn('浏览器持久缓存读取失败，改从服务器读取',error);return null;}}
  function deleteBrowserStock(code){openStockCache().then(db=>new Promise(resolve=>{const tx=db.transaction('stocks','readwrite');tx.objectStore('stocks').delete(code);tx.oncomplete=resolve;tx.onerror=resolve;})).catch(()=>{});}
  async function writeBrowserStock(code,date,payload){const db=await openStockCache();await new Promise((resolve,reject)=>{const tx=db.transaction('stocks','readwrite'),store=tx.objectStore('stocks');const all=store.getAll();all.onsuccess=()=>{const now=Date.now(),records=all.result||[],savedAt=Math.max(now,...records.map(x=>x.savedAt+1));store.put({code,date,payload,savedAt});const live=records.filter(x=>now-x.savedAt<STOCK_CACHE_TTL&&x.code!==code).concat([{code,savedAt}]).sort((a,b)=>a.savedAt-b.savedAt);const expired=records.filter(x=>now-x.savedAt>=STOCK_CACHE_TTL).map(x=>x.code),overflow=live.slice(0,Math.max(0,live.length-STOCK_CACHE_LIMIT)).map(x=>x.code);new Set([...expired,...overflow]).forEach(key=>store.delete(key));};all.onerror=()=>reject(all.error);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  function saveStockCache(code,date,payload){const now=Date.now();saveMemoryStock(code,date,payload,now);writeBrowserStock(code,date,payload).catch(error=>console.warn('浏览器持久缓存写入失败',error));}
  // Same two-layer policy as stock charts; a separate DB avoids blocking existing stock tabs on schema upgrades.
  const INDEX_CACHE_TTL=STOCK_CACHE_TTL,INDEX_CACHE_LIMIT=STOCK_CACHE_LIMIT,INDEX_CACHE_SCHEMA=1,INDEX_PAYLOAD_VERSION=5;
  const indexHistoryRequests=new Map();let indexCacheDbPromise=null,indexRevisionRequest=null,indexCacheRevision='',indexRevisionAt=0,indexRevisionCheckedAt=0;
  function observeIndexDataVersion(meta){
    if(!meta?.indexDataVersion||meta.indexSeriesVersion!==INDEX_PAYLOAD_VERSION)return false;
    const stamp=Number(meta.indexVersionAt)||0;
    if(stamp<indexRevisionAt&&meta.indexDataVersion!==indexCacheRevision)return false;
    if(meta.indexDataVersion!==indexCacheRevision){indexPageCache.clear();indexCacheRevision=meta.indexDataVersion;}
    indexRevisionAt=Math.max(indexRevisionAt,stamp);indexRevisionCheckedAt=Date.now();return true;
  }
  async function currentIndexDataVersion(){
    if(indexCacheRevision&&Date.now()-indexRevisionCheckedAt<30000)return indexCacheRevision;
    if(!indexRevisionRequest){indexRevisionRequest=api('/api/index-version',{cache:'no-store'}).then(meta=>{if(!observeIndexDataVersion(meta))throw new Error('指数数据版本暂不可用');return indexCacheRevision;}).finally(()=>{indexRevisionRequest=null;});}
    return indexRevisionRequest;
  }
  function validIndexCacheRecord(record,key){
    return record?.key===key&&record.schema===INDEX_CACHE_SCHEMA&&record.revision===indexCacheRevision&&Date.now()-record.savedAt<INDEX_CACHE_TTL&&record.payload?.indexSeriesVersion===INDEX_PAYLOAD_VERSION;
  }
  function rememberIndexCache(record){
    for(const [key,value] of indexPageCache){if(Date.now()-value.savedAt>=INDEX_CACHE_TTL||value.revision!==indexCacheRevision)indexPageCache.delete(key);}
    indexPageCache.delete(record.key);indexPageCache.set(record.key,record);while(indexPageCache.size>INDEX_CACHE_LIMIT)indexPageCache.delete(indexPageCache.keys().next().value);
  }
  function openIndexCache(){
    if(!('indexedDB' in window))return Promise.reject(new Error('IndexedDB unavailable'));
    if(!indexCacheDbPromise)indexCacheDbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open('tradingalert-index-cache',1);let settled=false;
      const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);indexCacheDbPromise=null;reject(error);};
      const timer=setTimeout(()=>fail(new Error('指数本地缓存连接超时')),1500);
      request.onupgradeneeded=()=>{const store=request.result.objectStoreNames.contains('indices')?request.transaction.objectStore('indices'):request.result.createObjectStore('indices',{keyPath:'key'});if(!store.indexNames.contains('savedAt'))store.createIndex('savedAt','savedAt');};
      request.onerror=()=>fail(request.error);request.onblocked=()=>fail(new Error('指数本地缓存被占用'));
      request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}settled=true;clearTimeout(timer);db.onversionchange=()=>{db.close();indexCacheDbPromise=null;};resolve(db);};
    });
    return indexCacheDbPromise;
  }
  async function readIndexCache(key){
    const memory=indexPageCache.get(key);
    if(validIndexCacheRecord(memory,key)){rememberIndexCache(memory);return memory.payload;}
    indexPageCache.delete(key);
    try{
      const db=await openIndexCache(),record=await new Promise((resolve,reject)=>{const request=db.transaction('indices','readonly').objectStore('indices').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      if(validIndexCacheRecord(record,key)){rememberIndexCache(record);return record.payload;}
    }catch(error){console.warn('指数持久缓存读取失败，改从服务器读取',error);}
    return null;
  }
  async function writeIndexCache(record){
    const db=await openIndexCache();await new Promise((resolve,reject)=>{
      const tx=db.transaction('indices','readwrite'),store=tx.objectStore('indices');store.put(record);
      // Evict using scalar metadata rather than cloning every cached chart payload.
      const cursor=store.index('savedAt').openKeyCursor(),live=[];cursor.onsuccess=()=>{const item=cursor.result;if(item){if(Date.now()-Number(item.key)>=INDEX_CACHE_TTL)store.delete(item.primaryKey);else live.push(item.primaryKey);item.continue();}else live.slice(0,Math.max(0,live.length-INDEX_CACHE_LIMIT)).forEach(key=>store.delete(key));};
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  async function getIndexHistory(code,date){
    if(!INDEX_CATALOG.some(item=>item.code===code))throw new Error('指数代码无效');
    const revision=await currentIndexDataVersion(),key=`${date}:${code}`,requestKey=`${key}:${revision}`;
    if(indexHistoryRequests.has(requestKey))return indexHistoryRequests.get(requestKey);
    const task=(async()=>{
      const cached=await readIndexCache(key);if(cached)return cached;
      const data=await api(`/api/index?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}`,{cache:'no-store'});
      observeIndexDataVersion(data);
      const complete=data.code===code&&data.date===date&&data.indexSeriesVersion===INDEX_PAYLOAD_VERSION&&data.indexDataVersion===indexCacheRevision&&['daily','weekly','monthly','oneMin','fifteenMin'].every(key=>Array.isArray(data[key]))&&!data.coverage?.oneMinError&&!data.coverage?.fifteenError;
      if(complete){
        const record={key,schema:INDEX_CACHE_SCHEMA,revision:data.indexDataVersion,savedAt:Date.now(),payload:data};rememberIndexCache(record);
        try{await writeIndexCache(record);}catch(error){console.warn('指数持久缓存写入失败，继续使用内存缓存',error);}
      }
      return data;
    })();
    indexHistoryRequests.set(requestKey,task);
    return task.finally(()=>{if(indexHistoryRequests.get(requestKey)===task)indexHistoryRequests.delete(requestKey);});
  }

  function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
  function allStocks(){return (state.review?.topics||[]).flatMap(t=>t.stocks.map(s=>({...s,topic:t.name,summary:t.summary})));}
  function chartPeriodKey(bar,series){
    if(series!=='weekly'&&series!=='monthly')return bar.timestamp;
    const date=new Date(bar.timestamp);
    if(series==='monthly')return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
    const monday=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
    return monday.toISOString().slice(0,10);
  }
  function mergeChartData(review,latest){if(!latest)return review;const merged={...review,latest:latest};for(const key of ['daily','weekly','monthly'])merged[key]=latest[key]||review[key]||[];for(const key of ['oneMin','fifteenMin']){const byPeriod=new Map();for(const bar of [...(review[key]||[]),...(latest[key]||[])])byPeriod.set(chartPeriodKey(bar,key),bar);merged[key]=[...byPeriod.values()].sort((a,b)=>a.timestamp-b.timestamp);}merged.suspendedDays=[...(review.suspendedDays||[]),...(latest.suspendedDays||[])].filter((item,index,all)=>all.findIndex(other=>other.date===item.date)===index);merged.coverage={...(review.coverage||{}),...(latest.coverage||{}),fifteenError:latest.coverage?.fifteenError||review.coverage?.fifteenError||null};return merged;}
  function scrollChartsToMode(latest){for(const chart of state.chartInstances){if(latest){chart.scrollToRealTime(250);continue;}const bars=chart.getDataList?.()||[];let target=-1;bars.forEach((bar,index)=>{if(chartDayKey(bar)<=state.date)target=index;});if(target>=0)chart.scrollToDataIndex(target,250);}}
  function unpromotedForTopic(topic){return topicUnpromotedStocks(topic.name);}
  function isDaysBoard(value){return /\d+天\d+板/.test(String(value??''));}
  function ladderColorClass(value){const count=stockBoardNumber(value);return count>=5?'five':count===4?'four':count===3?'three':count===2?'two':count===1?'first':'first';}
  function compareBoardPriority(a,b,getStatus,tieBreak=()=>0){const aStatus=getStatus(a),bStatus=getStatus(b),countDiff=stockBoardNumber(b,bStatus)-stockBoardNumber(a,aStatus);if(countDiff)return countDiff;const daysDiff=Number(isDaysBoard(bStatus))-Number(isDaysBoard(aStatus));return daysDiff||tieBreak(a,b);}
  function unpromotedNavStock(topic,stock){const code=String(stock.ts_code||'').slice(0,6),yesterdayBoard=Number(stock.board_count)||0,board=boardLabel(stock.previous_status||boardCountLabel(yesterdayBoard)),event=(state.review.pool?.all_break_stocks||state.review.pool?.break_stocks||[]).find(item=>String(item.ts_code||'').slice(0,6)===code);return {name:stock.name,code,topic:topic.name,summary:topic.summary,status:`未晋级 昨${board}`,navLabel:`未晋级 昨${board}`,badgeStatus:stock.previous_status||boardCountLabel(yesterdayBoard),previousConsecutiveBoardCount:yesterdayBoard,promotionTarget:Number(stock.promotionTarget)||Math.min(yesterdayBoard+1,5),isUnpromoted:true,touchedLimitToday:Boolean(stock.touched_limit_today),closePct:stock.close_pct,firstLimitTime:event?.first_limit_time||'',breakTime:event?.break_time||'',reason:`昨日${board}，今日未能连板；收盘涨幅${stock.close_pct==null?'—':`${Number(stock.close_pct)>0?'+':''}${Number(stock.close_pct).toFixed(2)}%`}，盘中${stock.touched_limit_today?'曾触及涨停':'未触及涨停'}。`,bridge:topic.summary||''};}
  function resolvedBoardStatus(stock,poolStock){const reportStatus=String(stock.status||''),poolStatus=String(poolStock?.status||'');if(/\d+天\d+板/.test(poolStatus))return poolStatus;if(/\d+天\d+板/.test(reportStatus))return reportStatus;return poolStatus||reportStatus;}
  function topicNavStocks(topic){const pool=new Map((state.review.pool?.stocks||[]).map(stock=>[String(stock.ts_code||'').slice(0,6),stock]));const promoted=[...topic.stocks].map(stock=>({...stock,status:resolvedBoardStatus(stock,pool.get(stock.code)),consecutiveBoardCount:stockBoardNumber(stock),topic:topic.name})).sort((a,b)=>compareBoardPriority(a,b,x=>x.status, (x,y)=>x.name.localeCompare(y.name,'zh-CN')));const unpromoted=[...unpromotedForTopic(topic)].sort((a,b)=>compareBoardPriority(a,b,x=>x.previous_status||boardCountLabel(x.board_count), (x,y)=>String(x.name||'').localeCompare(String(y.name||''),'zh-CN'))).map(stock=>unpromotedNavStock(topic,stock));return [...promoted,...unpromoted];}
  function visibleTopics(){const q=state.search.trim().toLowerCase();return (state.review?.topics||[]).map(t=>({...t,score:themeScore(t),navStocks:topicNavStocks(t).filter(s=>!q||`${t.name} ${s.name} ${s.code} ${s.navLabel||''}`.toLowerCase().includes(q))})).filter(t=>t.navStocks.length||!q&&t.name.toLowerCase().includes(q)).sort((a,b)=>b.score-a.score||b.stocks.length-a.stocks.length||a.name.localeCompare(b.name,'zh-CN'));}
  function topicCountBadge(topic,className){
    const stocks=topic.stocks||[],pool=new Map((state.review?.pool?.stocks||[]).map(stock=>[String(stock.ts_code||'').slice(0,6),stock]));
    const highest=stocks.reduce((value,stock)=>Math.max(value,stockBoardNumber({...stock,status:resolvedBoardStatus(stock,pool.get(String(stock.code||stock.ts_code||'').slice(0,6)))})),0);
    const label=`涨停${stocks.length}只，最高${highest}连板`;
    return `<span class="${className} topic-dual-badge" role="img" title="${label}" aria-label="${label}"><span class="topic-badge-count" aria-hidden="true">${stocks.length}</span><span class="topic-badge-highest" aria-hidden="true">${highest}</span></span>`;
  }
  function boardNavigationTiers(topics,firstLimitTimes){
    const tiers=[{key:5,label:'高板',stocks:[]},{key:4,label:'四板',stocks:[]},{key:3,label:'三板',stocks:[]},{key:2,label:'二板',stocks:[]},{key:1,label:'首板',stocks:[]},{key:0,label:'破板',stocks:[],isBroken:true}],seen=new Set(),pool=new Map((state.review.pool?.stocks||[]).map(item=>[String(item.ts_code||'').slice(0,6),item]));
    for(const topic of topics){
      const visibleCodes=new Set((topic.navStocks||[]).filter(item=>!item.isUnpromoted).map(item=>String(item.code||'').slice(0,6)));
      for(const stock of topic.stocks||[]){
        const code=String(stock.code||stock.ts_code||'').slice(0,6);
        if(!code||seen.has(code)||!visibleCodes.has(code))continue;
        seen.add(code);
        const poolStock=pool.get(code),status=resolvedBoardStatus(stock,poolStock),level=stockBoardNumber(stock,status);
        if(level<1)continue;
        tiers.find(tier=>tier.key===Math.min(level,5))?.stocks.push({stock:{...stock,status,consecutiveBoardCount:level,topic:topic.name,summary:topic.summary},code,topic:topic.name,time:firstLimitTimes.get(code)||'',amount:poolStock?.amount??stock.amount,badge:navBadgeLabel({status}),isUnpromoted:false});
      }
    }
    const query=state.search.trim().toLowerCase();
    for(const source of state.review.marketStats?.nonPromotedStocks||[]){
      const code=String(source.ts_code||'').slice(0,6),name=String(source.theme||'').trim()||'未分类';
      if(!code||seen.has(code)||query&&!`${name} ${source.name} ${code}`.toLowerCase().includes(query))continue;
      const topic=state.review.topics.find(item=>item.name===name)||{name,summary:'',stocks:[]},stock=unpromotedNavStock(topic,source),target=stock.promotionTarget;
      if(target<2)continue;
      seen.add(code);
      tiers.find(tier=>tier.key===target)?.stocks.push({stock,code,topic:name,isUnpromoted:true});
    }
    const seenBroken=new Set();
    for(const broken of state.review.pool?.break_stocks||[]){
      const code=String(broken.ts_code||'').slice(0,6),name=String(broken.classification_theme||broken.performance_theme||broken.theme||'暂无题材').trim();
      if(!code||seenBroken.has(code)||query&&!`${name} ${broken.name} ${code}`.toLowerCase().includes(query))continue;
      seenBroken.add(code);
      const topic=state.review.topics.find(item=>item.name===name)||{name,summary:'',stocks:[]},stock=makeBrokenStock(topic,broken,code);
      tiers.find(tier=>tier.isBroken)?.stocks.push({stock,code,topic:name,isBroken:true});
    }
    return tiers;
  }
  function boardNavigationMarkup(topics,firstLimitTimes){
    return boardNavigationTiers(topics,firstLimitTimes).map(tier=>{
      const promotedGroups=new Map(),unpromotedGroups=new Map(),brokenGroups=new Map();
      for(const item of tier.stocks){const groups=item.isUnpromoted?unpromotedGroups:item.isBroken?brokenGroups:promotedGroups;if(!groups.has(item.topic))groups.set(item.topic,[]);groups.get(item.topic).push(item);}
      const renderThemeGroups=(groups,isUnpromoted,isBroken=false)=>[...groups].map(([theme,stocks])=>{
        if(isUnpromoted||isBroken)return '<div class="board-theme-group unpromoted-inline-group">'+stocks.sort((a,b)=>String(a.stock.name||'').localeCompare(String(b.stock.name||''),'zh-CN')).map(item=>{const rawPct=item.stock.closePct,pct=Number(rawPct),hasPct=rawPct!=null&&rawPct!==''&&Number.isFinite(pct),pctText=hasPct?(pct>0?'+':'')+pct.toFixed(2)+'%':'—',pctClass=!hasPct||pct===0?'flat':pct>0?'up':'down',badge=stockOutcomeBadgeText(item.stock,isBroken),kind=isBroken?'broken':'unpromoted';return '<button class="board-stock-link nav-stock-row unpromoted-board-stock '+kind+'-board-stock" type="button" data-board-stock="'+esc(item.code)+'" data-board-topic="'+esc(item.topic)+'" data-board-outcome="'+kind+'" title="'+esc(item.stock.name+' · '+theme+' · '+(isBroken?'破板':'未晋级'))+'"><span class="nav-board-badge '+(isBroken||item.stock.touchedLimitToday?'broken':'unpromoted')+'-board-badge">'+badge+'</span><span class="unpromoted-board-name">'+esc(item.stock.name)+'</span><span class="unpromoted-board-theme">'+esc(theme)+'</span><span class="unpromoted-board-change '+pctClass+'">'+esc(pctText)+'</span></button>';}).join('')+'</div>';
        return '<div class="board-theme-group"><button class="board-theme-label" type="button" data-board-theme="'+esc(theme)+'" title="打开题材：'+esc(theme)+'">'+esc(theme)+'</button>'+stocks.sort((a,b)=>(a.time||'99:99:99').localeCompare(b.time||'99:99:99')||String(a.stock.name||'').localeCompare(String(b.stock.name||''),'zh-CN')).map(item=>'<button class="board-stock-link nav-stock-row" type="button" data-board-stock="'+esc(item.code)+'" data-board-topic="'+esc(item.topic)+'" title="'+esc(item.stock.name+' · '+(item.time||'—')+' · 成交额 '+compactBoardAmount(item.amount))+'"><span class="nav-board-badge">'+esc(item.badge)+'</span><span class="nav-stock-name">'+esc(item.stock.name)+'</span><time>'+esc(item.time||'—')+'</time><em>'+esc(compactBoardAmount(item.amount))+'</em></button>').join('')+'</div>';
      }).join('');
      const groups=renderThemeGroups(promotedGroups,false)+(unpromotedGroups.size?`<div class="board-unpromoted-divider">未晋级</div>${renderThemeGroups(unpromotedGroups,true)}`:'')+renderThemeGroups(brokenGroups,false,true);
      const targetLabel=({2:'二板',3:'三板',4:'四板',5:'高板'})[tier.key],promotionRow=targetLabel&&(state.review.marketStats?.promotionBoards||[]).find(row=>row.label===targetLabel),promotionRate=promotionRow?.rate,promotionText=targetLabel?(promotionRate==null?'晋级率 —':`晋级率 ${(Number(promotionRate)*100).toFixed(1)}%`):'',promotionMarkup=targetLabel?`<span class="board-tier-promotion-rate" title="昨日该组涨停股今日继续封板：${promotionRow?.numerator??0}/${promotionRow?.denominator??0}">${promotionText}</span>`:'';
      const collapsed=state.collapsedBoardTiers.has(tier.key);
      return `<section class="board-tier-group${collapsed?' collapsed':''}"><button class="board-tier-heading" type="button" data-board-tier-toggle="${tier.key}" aria-expanded="${String(!collapsed)}"><span class="board-tier-count">${tier.stocks.filter(item=>!item.isUnpromoted).length}</span><span>${tier.label}</span>${promotionMarkup}<span class="board-tier-toggle-icon" aria-hidden="true">${collapsed?'+':'−'}</span></button><div class="board-tier-content">${groups}</div></section>`;
    }).join('');
  }
  function renderNav(){
    if(!isLivePage())disposeLiveIndexCharts();
    const dailyCount=state.review?.topics?.length||0;
    const markup=`<div class="topic-group ladder-nav-group"><button class="topic-button overview-nav-button" type="button" data-ladder><span class="overview-nav-icon">梯</span><span class="topic-label">涨停天梯</span></button></div><div class="topic-group overview-nav-group"><button class="topic-button overview-nav-button" type="button" data-overview><span class="overview-nav-icon">${dailyCount}</span><span class="topic-label">每日总览</span></button></div><div class="topic-group index-nav-group"><button class="topic-button index-nav-button" type="button" data-indices><span class="index-nav-icon">指</span><span class="topic-label">重要指数</span></button></div>`;
    if(markup!==renderedNavMarkup){
      nav.innerHTML=markup;renderedNavMarkup=markup;
      nav.querySelector('[data-overview]').addEventListener('click',()=>openHome());
      nav.querySelector('[data-ladder]').addEventListener('click',()=>openLimitupLadder());
      nav.querySelector('[data-indices]').addEventListener('click',event=>{if(event.detail<2)openIndicesOverview();});
    }
    nav.querySelector('[data-overview]').classList.toggle('active',!state.topic&&!state.stock&&!state.index&&!state.indicesPage&&!isLivePage()&&history.state?.view!=='ladder');
    nav.querySelector('[data-ladder]').classList.toggle('active',history.state?.view==='ladder');
    nav.querySelector('[data-indices]').classList.toggle('active',state.indicesPage||Boolean(state.index));
    $('#liveMonitorLink').classList.toggle('active',isLivePage());
  }
  function stockBoardNumber(stock,fallbackStatus=stock?.status){const code=String(stock?.ts_code||stock?.code||'').split('.')[0].slice(-6),isPrior=stock?.isUnpromoted||stock?.previousConsecutiveBoardCount!=null,mapped=(isPrior?state.review?.marketStats?.previousConsecutiveBoardCounts:state.review?.marketStats?.consecutiveBoardCounts)?.[code];for(const value of [stock?.previousConsecutiveBoardCount,stock?.consecutiveBoardCount,mapped,stock?.board_count]){const count=Number(value);if(Number.isInteger(count)&&count>0)return count;}return boardNumber(fallbackStatus);}
  function boardNumber(value){const text=String(value??'').trim();if(/首板/.test(text))return 1;const daysBoard=text.match(/(\d+)天(\d+)板/);if(daysBoard&&Number(daysBoard[1])>Number(daysBoard[2]))return 0;const match=text.match(/(?:\d+天)?(\d+|[一二三四五六七八九十]+)(?:连板|板)/);if(!match)return 0;const raw=match[1];if(/^\d+$/.test(raw))return Number(raw);const digits={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};return raw==='十'?10:raw.startsWith('十')?10+(digits[raw[1]]||0):raw.endsWith('十')?(digits[raw[0]]||0)*10:raw.includes('十')?(digits[raw[0]]||0)*10+(digits[raw[2]]||0):(digits[raw]||0);}
  function navBoardLabel(stock){if(stock.isUnpromoted)return stock.navLabel||boardLabel(stock.status);const status=String(stock.status||'');return status.match(/\d+天\d+板/)?.[0]||boardLabel(status);}
  function navBadgeLabel(stock){const status=String(stock.badgeStatus||stock.status||'').trim(),daysBoard=status.match(/(\d+)天(\d+)板/);if(daysBoard)return `${Number(daysBoard[2])}/${Number(daysBoard[1])}`;const count=boardNumber(status);return count?String(count):'—';}
  function navYesterdayBoardLabel(stock){const status=String(stock.badgeStatus||stock.status||'').trim(),daysBoard=status.match(/\d+天\d+板/);if(daysBoard)return `昨${daysBoard[0]}`;const count=boardNumber(status);return count?`昨${count}板`:'昨—';}
  function boardCountLabel(count){const n=Number(count)||0;return n===1?'首板':n>1?`${n}连板`:'—';}
  function themeScore(topic){const points={1:1,2:3,3:6,4:8,5:10},boards=topic.stocks.map(stock=>stockBoardNumber(stock));let score=boards.reduce((sum,board)=>sum+(points[Math.min(board,5)]||0),0);if(boards.length<2)score-=5;else if(boards.length<3)score-=1;return score;}
  function metrics(){const stocks=allStocks(), pool=state.review.pool?.stocks||[]; const sealedStocks=pool.filter(s=>s.daily_high!=null&&s.daily_low!=null&&Number.isFinite(Number(s.daily_high))&&Number.isFinite(Number(s.daily_low))&&Number(s.daily_high)===Number(s.daily_low));const sealed=sealedStocks.length;const sealedCodes=new Set(sealedStocks.map(s=>String(s.ts_code||'').slice(0,6)));const sealedThemes=state.review.topics.map(topic=>({name:topic.name,count:topic.stocks.filter(stock=>sealedCodes.has(String(stock.code||'').slice(-6))).length})).filter(topic=>topic.count>0).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN')).slice(0,3); const themes=state.review.topics.length;const boards=stocks.map(s=>stockBoardNumber(s));const ladder={2:0,3:0,4:0,5:0},ladderThemeCounts={2:new Map(),3:new Map(),4:new Map(),5:new Map()};for(const topic of state.review.topics)for(const stock of topic.stocks){const board=stockBoardNumber(stock);if(board>=2){const key=Math.min(board,5);ladder[key]++;ladderThemeCounts[key].set(topic.name,(ladderThemeCounts[key].get(topic.name)||0)+1);}}const ladderThemes=Object.fromEntries(Object.entries(ladderThemeCounts).map(([key,counts])=>[key,[...counts].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN')).slice(0,3)]));const maxBoard=Math.max(0,...boards);const rankedThemes=state.review.topics.map(topic=>{const topicBoards=topic.stocks.map(stock=>stockBoardNumber(stock));const count=topic.stocks.length,highest=Math.max(0,...topicBoards),score=themeScore(topic);return {name:topic.name,summary:topic.summary,count,highest,score,stocks:topic.stocks};}).sort((a,b)=>b.score-a.score||b.count-a.count||b.highest-a.highest);const activeThemes=rankedThemes.slice(0,5),topicHighlights=rankedThemes.filter(topic=>topic.count>=3);return {stocks:state.review.totalStocks||stocks.length,themes,sealed,sealedThemes,ladder,ladderThemes,maxBoard,activeThemes,topicHighlights,marketStats:state.review.marketStats||{}};}
  function distributionCharts(groups){return `<div class="return-distributions">${(groups||[]).map(group=>{const bins=group.bins||[],peak=Math.max(0,...bins.map(bin=>bin.fraction||0));return `<article class="distribution-card"><header><strong>${esc(group.name)}涨幅分布</strong><span>${group.count} 只</span></header><small>${esc(group.description||'')}</small><div class="histogram" role="img" aria-label="${esc(group.name)}股票涨幅分布">${bins.map((bin,index)=>{const pct=bin.fraction==null?0:bin.fraction*100,height=peak&&bin.fraction!=null?Math.max(pct?3:0,Math.min(72,bin.fraction/peak*72)):0;return `<div class="hist-column"><div class="hist-value" title="${esc(bin.label)}%：${bin.count}只，占${pct.toFixed(1)}%"><i class="${index<4?'down':'up'}" style="height:${height}px"></i></div><span>${esc(bin.label)}</span></div>`}).join('')}</div></article>`}).join('')}</div>`;}
  function limitUpTrendChart(history){const rows=history||[];if(!rows.length)return '<div class="limitup-trend-empty">暂无近30个交易日的涨停数据</div>';const width=680,height=154,left=34,right=34,top=9,bottom=25,plotH=height-top-bottom,plotW=width-left-right,step=plotW/rows.length,barW=Math.min(12,step*.62),maxCount=Math.max(1,...rows.map(d=>d.first+d.secondThird+d.fourPlus)),maxBoard=Math.max(1,...rows.map(d=>d.highest));const yCount=value=>top+plotH-(value/maxCount)*plotH,yBoard=value=>top+plotH-(value/maxBoard)*plotH;let bars='',labels='',grid='';for(let tick=0;tick<=2;tick++){const value=Math.round(maxCount*tick/2),y=yCount(value);grid+=`<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}" class="trend-gridline"/><text x="${left-7}" y="${y+3}" text-anchor="end" class="trend-axis-label">${value}</text>`;}for(let tick=0;tick<=2;tick++){const value=Math.round(maxBoard*tick/2),y=yBoard(value);grid+=`<text x="${width-right+7}" y="${y+3}" class="trend-axis-label">${value}</text>`;}const points=[];rows.forEach((d,index)=>{const x=left+step*(index+.5),base=top+plotH;let y=base;for(const [key,cls] of [['first','first'],['secondThird','second-third'],['fourPlus','four-plus']]){const segment=Number(d[key]||0),segmentH=segment/maxCount*plotH;y-=segmentH;if(segment)bars+=`<rect x="${x-barW/2}" y="${y}" width="${barW}" height="${segmentH}" rx="1.5" class="trend-bar ${cls}"><title>${d.date}: ${key==='first'?'首板':key==='secondThird'?'二板+三板':'四板及以上'} ${segment}只</title></rect>`;}points.push(`${x},${yBoard(Number(d.highest||0))}`);if(index%5===0||index===rows.length-1)labels+=`<text x="${x}" y="${height-5}" text-anchor="middle" class="trend-date-label">${String(d.date).slice(4,6)}/${String(d.date).slice(6,8)}</text>`;});const circles=rows.map((d,index)=>{const x=left+step*(index+.5),y=yBoard(Number(d.highest||0));return `<circle cx="${x}" cy="${y}" r="2.3" class="trend-point"><title>${d.date}: 最高${d.highest}板</title></circle>`}).join('');return `<div class="limitup-trend-legend"><span><i class="first"></i>首板</span><span><i class="second-third"></i>二板+三板</span><span><i class="four-plus"></i>四板及以上</span><span><i class="highest"></i>最高板数</span></div><svg class="limitup-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="近30个交易日涨停家数分板统计和最高板数"><text x="2" y="13" class="trend-axis-title">家数</text><text x="${width-1}" y="13" text-anchor="end" class="trend-axis-title">板数</text>${grid}${bars}<polyline points="${points.join(' ')}" class="trend-highest-line"/>${circles}${labels}</svg>`;}
  function topicTrendChart(history){const rows=history||[];if(!rows.length)return '<div class="limitup-trend-empty">暂无该题材近30个交易日数据</div>';const width=680,height=108,left=34,right=34,top=4,bottom=8,plotH=height-top-bottom,plotW=width-left-right,step=plotW/rows.length,barW=Math.min(12,step*.62),maxCount=Math.max(1,...rows.map(d=>Number(d.count||0))),maxBoard=Math.max(1,...rows.map(d=>Number(d.highest||0)));const yCount=value=>top+plotH-(value/maxCount)*plotH,yBoard=value=>top+plotH-(value/maxBoard)*plotH;let bars='',labels='',grid='';for(let tick=0;tick<=2;tick++){const value=Math.round(maxCount*tick/2),y=yCount(value);grid+=`<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}" class="trend-gridline"/><text x="${left-7}" y="${y+3}" text-anchor="end" class="trend-axis-label">${value}</text>`;}for(let tick=0;tick<=2;tick++){const value=Math.round(maxBoard*tick/2),y=yBoard(value);grid+=`<text x="${width-right+7}" y="${y+3}" class="trend-axis-label">${value}</text>`;}const points=[];rows.forEach((d,index)=>{const x=left+step*(index+.5),base=top+plotH,count=Number(d.count||0),barH=count/maxCount*plotH;if(count)bars+=`<rect x="${x-barW/2}" y="${base-barH}" width="${barW}" height="${barH}" rx="1.5" class="topic-trend-bar"><title>${d.date}: ${count}只</title></rect>`;points.push(`${x},${yBoard(Number(d.highest||0))}`);if(index%5===0||index===rows.length-1)labels+=`<text x="${x}" y="${height-5}" text-anchor="middle" class="trend-date-label">${String(d.date).slice(4,6)}/${String(d.date).slice(6,8)}</text>`;});const circles=rows.map((d,index)=>{const x=left+step*(index+.5),y=yBoard(Number(d.highest||0));return `<circle cx="${x}" cy="${y}" r="2.3" class="trend-point"><title>${d.date}: 题材最高${d.highest}板</title></circle>`}).join('');return `<svg class="limitup-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="题材近30个交易日涨停股数与最高板数">${grid}${bars}<polyline points="${points.join(' ')}" class="trend-highest-line"/>${circles}${labels}</svg>`;}
  function indexCards(){return (state.review.indices||[]).map(x=>`<button type="button" class="index-card" data-open-index="${esc(x.code)}" aria-label="打开${esc(x.name)}详情"><span class="index-name">${esc(x.name)}</span><span class="index-change ${Number(x.pct_chg)>=0?'positive':'negative'}">${Number(x.pct_chg)>=0?'+':''}${num(x.pct_chg)}%</span><strong>${num(x.close)}</strong><small class="index-amount">${compactYuan(Number(x.amount)*1000)}</small></button>`).join('')||'<div class="empty-state">指数数据暂不可用</div>'}
  function statChip(label,value,detail){return `<div class="rate-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`;}
  function rateTable(rows,date=state.date){return `<div class="rate-table rate-positive">${(rows||[]).map(row=>`<div class="rate-row"><strong>${row.name?themeLink(row.name,date):esc(row.label)}</strong><b>${row.rate==null?'—':`${(row.rate*100).toFixed(1)}%`}</b><span>${row.numerator??'—'} / ${row.denominator??'—'}</span></div>`).join('')||'<div class="metric-foot">暂无可计算数据</div>'}</div>`;}
  function countTable(rows,date=state.date){return `<div class="rate-table">${(rows||[]).map(row=>`<div class="rate-row"><strong>${themeLink(row.name,date)}</strong><b>${row.count}</b></div>`).join('')||'<div class="metric-foot">暂无数据</div>'}</div>`;}
  function themeLink(name,date=state.date){return `<button type="button" class="theme-link" data-theme-link="${esc(name)}" data-theme-date="${esc(date)}">${esc(name)}</button>`;}
  function outcomeRateSummary(topicName,sealedStocks,brokenStocks){const stats=state.review.marketStats||{},promotionRows=stats.topicPromotionRates?.[topicName]||[],denominator=(sealedStocks||[]).filter(stock=>stockBoardNumber(stock)===1).length+(brokenStocks?.length||0),breakRate=denominator?(brokenStocks?.length||0)/denominator:null,items=[{label:'破板率',rate:breakRate},{label:'二板晋级率',rate:promotionRows.find(row=>row.label==='二板')?.rate},{label:'三板晋级率',rate:promotionRows.find(row=>row.label==='三板')?.rate},{label:'四板晋级率',rate:promotionRows.find(row=>row.label==='四板')?.rate},{label:'高板晋级率',rate:promotionRows.find(row=>row.label==='高板')?.rate}];return '<div class="outcome-rate-summary" title="破板率按当前题材冲击首板失败数 / 今日冲击首板总数计算；分板晋级率按前一交易日该题材各板涨停股在今日是否继续封板计算">'+items.map(item=>'<span>'+item.label+' <b>'+(item.rate==null?'—':(Number(item.rate)*100).toFixed(1)+'%')+'</b></span>').join('')+'</div>'; }
  function earthSkyCard(){
    const stats=state.review.marketStats||{},stocks=stats.earthSkyStocks||[],known=new Map(allStocks().map(stock=>[stock.code,stock]));
    const rows=stocks.map(stock=>{const target=known.get(stock.code),name=target?`<button type="button" class="earth-sky-name" data-earth-sky-stock="${esc(stock.code)}" data-earth-sky-topic="${esc(target.topic)}" title="${esc(stock.name)}">${esc(stock.name)}</button>`:`<strong class="earth-sky-name" title="${esc(stock.name)}">${esc(stock.name)}</strong>`;return `<div class="earth-sky-row">${name}<span class="earth-sky-theme" title="${esc(stock.theme||'暂无题材')}">${esc(stock.theme||'暂无题材')}</span></div>`;}).join('');
    return `<div class="metric-card earth-sky-card"><div class="metric-label">地天</div><div class="metric-value">${stats.sealed==null?'—':stocks.length}</div><div class="earth-sky-list">${rows||`<span class="metric-foot">${stats.sealed==null?'暂无数据':'暂无'}</span>`}</div></div>`;
  }
  function renderHome(){content.classList.remove('six-grid-page');state.indicesPage=false;state.topic=null;state.stock=null;state.index=null;state.indexData=null;$('#crumbCurrent').textContent='每日总览';$('#crumbBack').hidden=true;$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=false;$('#crumbSeparator').hidden=true;renderNav();const m=metrics(),dateIndex=state.dates.indexOf(state.date);$('#topbarActions').innerHTML=`<div class="review-date-controls topbar-date-controls"><button id="prevReviewDate" class="date-nav-button" ${dateIndex<=0?'disabled':''}>← 前一日</button>${datePickerTriggerMarkup('reviewDatePickerTrigger','date-nav-button')}<button id="nextReviewDate" class="date-nav-button" ${dateIndex<0||dateIndex>=state.dates.length-1?'disabled':''}>后一日 →</button></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button>`;$('#openSettings').onclick=openSettings;content.innerHTML=`<div class="page-title"><div><span class="eyebrow">MARKET REVIEW / ${esc(state.date)}</span><h1>${esc(state.review.title)}</h1></div></div><div class="metric-grid"><div class="metric-card limitup-trend-card"><div class="metric-label">涨停家数 · 近30个交易日</div><div class="metric-value accent">${m.stocks}</div>${limitUpTrendChart(m.marketStats.limitUpHistory)}</div><div class="metric-card theme-rank-card"><div class="metric-label">活跃题材 · 评分前五</div><div class="metric-value">${m.themes} 个</div><div class="theme-score-list">${m.activeThemes.map((topic,index)=>`<div class="theme-score-row"><span class="theme-rank">${index+1}</span><strong title="${esc(topic.name)}">${themeLink(topic.name)}</strong><span>${topic.count} 只 · 最高 ${topic.highest||'—'} 板</span><b>${topic.score}分</b></div>`).join('')||'<span class="metric-foot">暂无题材数据</span>'}</div></div><div class="metric-card ladder-card"><div class="metric-label">连板梯队</div><div class="metric-value">最高 ${m.maxBoard||'—'} 板</div><div class="ladder-list">${[{key:2,label:'二板'},{key:3,label:'三板'},{key:4,label:'四板'},{key:5,label:'高板'}].map(({key,label})=>{const topicText=m.ladderThemes[key].map(topic=>`${topic.name} ${topic.count}`).join(' · '),topicLinks=m.ladderThemes[key].map(topic=>`${themeLink(topic.name)} ${topic.count}`).join(' · ');return `<div class="ladder-row"><b>${label}</b><strong>${m.ladder[key]}只</strong><span title="${esc(topicText)}">${topicLinks||'—'}</span></div>`}).join('')}</div></div><div class="special-board-cards"><div class="metric-card oneword-card"><div class="metric-label">一字板 · 题材前三</div><div class="metric-value">${m.sealed}</div><div class="oneword-theme-list">${m.sealedThemes.map((topic,index)=>`<div class="oneword-theme-row"><span>${index+1}</span><strong title="${esc(topic.name)}">${themeLink(topic.name)}</strong><b>${topic.count}</b></div>`).join('')||'<span class="metric-foot">暂无匹配题材</span>'}</div></div>${earthSkyCard()}</div></div><div class="rates-layout"><div class="rate-panels"><section class="rate-section"><header class="rate-section-head"><h2>晋级率</h2><span class="overall-chip rate-up">总体 ${m.marketStats.promotionRate==null?'—':`${(m.marketStats.promotionRate*100).toFixed(1)}%`}</span></header><div class="rate-section-grid"><div class="rate-subsection"><h3>昨日评分前五题材</h3>${rateTable(m.marketStats.promotionThemes,m.marketStats.previousDate||state.date)}</div><div class="rate-subsection"><h3>按晋级目标板数</h3>${rateTable(m.marketStats.promotionBoards)}</div></div></section><section class="rate-section"><header class="rate-section-head"><h2>封板率</h2><span class="overall-chip rate-up">总体 ${m.marketStats.sealingRate==null?'—':`${(m.marketStats.sealingRate*100).toFixed(1)}%`}</span></header><div class="rate-section-grid"><div class="rate-subsection"><h3>今日评分前五题材</h3>${rateTable(m.marketStats.sealingThemes,state.date)}</div><div class="rate-subsection"><h3>按今日连板数</h3>${rateTable(m.marketStats.sealingBoards)}</div></div></section><section class="rate-section down-section"><header class="rate-section-head"><h2>跌停统计</h2></header><div class="down-stats">${statChip('跌停数',m.marketStats.limitDownCount??'—',`触及 ${m.marketStats.limitDownTouched??'—'} · 封住 ${m.marketStats.limitDownSealed??'—'}`)}${statChip('跌停封板率',m.marketStats.limitDownSealingRate==null?'—':`${(m.marketStats.limitDownSealingRate*100).toFixed(1)}%`,'触及跌停后收盘仍封住')}${statChip('昨日涨停 · 今日跌停',m.marketStats.yesterdayLimitUpTodayDown??'—','昨日收盘涨停且今日收盘跌停')}</div><div class="rate-subsection down-theme-list"><h3>昨日评分前五题材 · 今日跌停数</h3>${countTable(m.marketStats.limitDownThemes,m.marketStats.previousDate||state.date)}</div></section></div><section class="rate-section index-section"><header class="rate-section-head"><h2><button type="button" id="homeIndicesTitle" class="index-heading-link" aria-label="打开重要指数">指数</button></h2><span class="turnover-current-value" id="homeMarketTurnover" aria-label="当日两市成交额">两市成交额 读取中…</span></header><div class="index-list">${indexCards()}</div></section></div><section class="topic-hero selectable"><span class="eyebrow">DAILY READ</span><h2>今日情绪与复盘结论</h2><p>${esc(state.review.conclusion||'题材摘要与个股归因来自 Neo4j；全局市场结论尚未存入图谱。')}</p><div class="hero-tags"><span class="tag">${fmtDate(state.date)}</span><span class="tag">${m.themes} 个题材</span><span class="tag">${m.stocks} 只涨停股</span><span class="tag">题材分析：${esc(state.review.analysisStatus||'已更新')} · 行情：${esc(state.review.pool?.source||'离线库')}</span></div></section><div class="section-heading"><h3>题材速览</h3><span>仅显示涨停股 3 只及以上的题材，按评分排序</span></div><div class="topic-stock-list">${m.topicHighlights.map(t=>`<article class="stock-card selectable" data-topic-card="${esc(t.name)}"><div class="stock-card-top"><strong>${esc(t.name)}</strong><span class="board-badge">${t.stocks.length} 只</span></div><p>${esc(t.summary||'Neo4j 未提供题材总述')}</p><p class="stock-card-bridge">涨停梯队：${t.stocks.slice(0,5).map(s=>esc(s.name)+' '+esc(boardLabel(s.status))).join(' · ')}${t.stocks.length>5?' …':''}</p></article>`).join('')}</div>`;
    content.querySelectorAll('[data-earth-sky-stock]').forEach(button=>button.addEventListener('click',()=>selectStock(button.dataset.earthSkyTopic,button.dataset.earthSkyStock)));
    $('#homeIndicesTitle').onclick=()=>openIndicesOverview(state.date);
    loadHomeMarketTurnover(state.date);content.querySelectorAll('[data-theme-link]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openTopic(b.dataset.themeLink,b.dataset.themeDate||state.date)}));content.querySelectorAll('[data-open-index]').forEach(b=>b.addEventListener('click',()=>openIndex(b.dataset.openIndex)));content.querySelectorAll('[data-topic-card]').forEach(c=>c.addEventListener('click',()=>openTopic(c.dataset.topicCard)));$('#prevReviewDate').onclick=()=>navigateReviewDate(-1);$('#nextReviewDate').onclick=()=>navigateReviewDate(1);
  applyLadderReturnLink();}
  function navigateReviewDate(step){const index=state.dates.indexOf(state.date),target=state.dates[index+step];if(target){syncBrowserRoute('home',target);loadDate(target);}}
  function indexSequence(){return INDEX_CATALOG;}
  function marketTurnoverChart(days){
    const rows=(days||[]).filter(row=>/^20\d{6}$/.test(String(row.date))&&Number.isFinite(Number(row.amount))&&Number(row.amount)>=0);
    if(!rows.length)return '<div class="empty-state">暂无两市成交额数据</div>';
    const width=960,height=150,left=58,right=14,top=12,bottom=22,plotW=width-left-right,plotH=height-top-bottom;
    const maximum=Math.max(1,...rows.map(row=>Number(row.amount))),ceiling=Math.ceil(maximum/4e11)*4e11,slot=plotW/rows.length,barW=Math.max(2,Math.min(7,slot*.7));
    const y=value=>top+plotH-(value/ceiling)*plotH;
    const grid=Array.from({length:5},(_,i)=>{const value=ceiling*i/4,position=y(value);return `<line x1="${left}" x2="${width-right}" y1="${position.toFixed(2)}" y2="${position.toFixed(2)}" stroke="#e8eeea" stroke-width="1"/><text x="${left-9}" y="${(position+3).toFixed(2)}" text-anchor="end" class="turnover-axis-label">${(value/1e12).toFixed(1)}</text>`;}).join('');
    const labels=rows.map((row,i)=>{if(i&&i!==rows.length-1&&i%20!==0)return '';const x=left+slot*(i+.5),label=`${row.date.slice(4,6)}/${row.date.slice(6,8)}`;return `<text x="${x.toFixed(2)}" y="${height-9}" text-anchor="${i===0?'start':i===rows.length-1?'end':'middle'}" class="turnover-axis-label">${label}</text>`;}).join('');
    const bars=rows.map((row,i)=>{const amount=Number(row.amount),x=left+slot*(i+.5)-barW/2,barHeight=Math.max(.5,amount/ceiling*plotH);return `<rect x="${x.toFixed(2)}" y="${(top+plotH-barHeight).toFixed(2)}" width="${barW.toFixed(2)}" height="${barHeight.toFixed(2)}" rx=".8" fill="${i===rows.length-1?'#bf9550':'#6e9f89'}"><title>${fmtDate(row.date)}：${compactYuan(amount)}</title></rect>`;}).join('');
    return `<div class="market-turnover-scroll"><svg class="market-turnover-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="截至${fmtDate(rows.at(-1).date)}最近${rows.length}个交易日的上证指数与深证综指成交额之和，单位万亿元"><text x="${left}" y="11" class="turnover-axis-title">万亿元</text>${grid}${bars}${labels}</svg></div>`;
  }
  async function loadMarketTurnover(date){
    const paint=days=>{if(!state.indicesPage||state.date!==date)return;const host=$('#marketTurnoverChart');if(host)host.innerHTML=marketTurnoverChart(days);const value=$('#marketTurnoverCurrentValue');if(value){const current=(days||[]).find(row=>String(row.date)===String(date));value.textContent=current?compactYuan(current.amount):'—';}};
    if(marketTurnoverCache.has(date)){paint(marketTurnoverCache.get(date));return;}
    try{const data=await api(`/api/market_turnover?date=${encodeURIComponent(date)}`);marketTurnoverCache.set(date,data.days||[]);while(marketTurnoverCache.size>10)marketTurnoverCache.delete(marketTurnoverCache.keys().next().value);paint(data.days||[]);}
    catch(error){if(!state.indicesPage||state.date!==date)return;const host=$('#marketTurnoverChart');if(host)host.innerHTML='<div class="empty-state">两市成交额读取失败</div>';}
  }
  async function loadHomeMarketTurnover(date){
    const paint=days=>{if(state.date!==date||state.topic||state.stock||state.index||state.indicesPage)return;const value=$("#homeMarketTurnover");if(!value)return;const current=(days||[]).find(row=>String(row.date)===String(date));value.textContent=current?"两市成交额 "+compactYuan(current.amount):"两市成交额 —";};
    if(marketTurnoverCache.has(date)){paint(marketTurnoverCache.get(date));return;}
    try{const data=await api("/api/market_turnover?date="+encodeURIComponent(date)),days=data.days||[];marketTurnoverCache.set(date,days);while(marketTurnoverCache.size>10)marketTurnoverCache.delete(marketTurnoverCache.keys().next().value);paint(days);}
    catch(error){if(state.date===date&&!state.topic&&!state.stock&&!state.index&&!state.indicesPage){const value=$("#homeMarketTurnover");if(value)value.textContent="两市成交额 —";}}
  }
  function indexIntradaySvg(chart,code,date){
    const points=chart?.points||[],volumes=chart?.volumes||[];
    if(!points.length)return topicIntradayPlaceholder('无数据');
    const valid=points.map(Number).filter(Number.isFinite),extent=Math.max(.35,...valid.map(Math.abs))*1.12;
    const y=value=>2+(extent-Number(value))/(2*extent)*28;
    const path=points.map((value,i)=>`${(2+i*88/Math.max(1,points.length-1)).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
    const maxVolume=Math.max(1,...volumes.map(value=>Number(value)||0));
    const strokes=volumes.map((value,i)=>{const x=2+i*88/Math.max(1,volumes.length-1),height=Math.max(.5,(Number(value)||0)/maxVolume*12);return `<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${(46-height).toFixed(2)}" y2="46" stroke="#879c92" stroke-width=".55"/>`;}).join('');
    return `<div class="intraday-mini" title="${esc(code)}：${fmtDate(date)}每分钟涨幅及成交额"><svg viewBox="0 0 92 48" role="img" aria-label="${esc(code)}${fmtDate(date)}每分钟涨幅及成交额"><line x1="2" x2="90" y1="${y(0).toFixed(2)}" y2="${y(0).toFixed(2)}" stroke="#c9cfcb" stroke-width=".6" stroke-dasharray="2 2"/><polyline points="${path}" fill="none" stroke="${valid.at(-1)>=0?'#c6534d':'#20a37a'}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="1" x2="91" y1="32" y2="32" stroke="#59636a" stroke-width=".55"/>${strokes}</svg></div>`;
  }
  async function loadIndicesOverviewCharts(date){
    const paint=series=>{if(!state.indicesPage||state.date!==date)return;content.querySelectorAll('[data-overview-index]').forEach(row=>{const item=series[row.dataset.overviewIndex]||{};row.querySelector('.intraday-cell').innerHTML=indexIntradaySvg(item.intraday,row.dataset.overviewIndex,date);row.querySelector('.daily-kline-cell').innerHTML=topicDailyKlineSvg(item.daily,row.dataset.overviewIndex,date);});};
    if(indicesOverviewCache.has(date)){paint(indicesOverviewCache.get(date));return;}
    try{const data=await api(`/api/indices_overview?date=${encodeURIComponent(date)}`);indicesOverviewCache.set(date,data.series||{});while(indicesOverviewCache.size>10)indicesOverviewCache.delete(indicesOverviewCache.keys().next().value);paint(data.series||{});}
    catch(error){if(!state.indicesPage||state.date!==date)return;content.querySelectorAll('[data-overview-index] .intraday-cell,[data-overview-index] .daily-kline-cell').forEach(cell=>cell.innerHTML=topicIntradayPlaceholder('读取失败'));}
  }
  function renderIndicesOverview(){
    state.charts.forEach(id=>{try{window.klinecharts.dispose(id)}catch{}});state.charts=[];state.chartInstances=[];
    state.indicesPage=true;state.topic=null;state.stock=null;state.index=null;state.indexData=null;state.indexLoadId++;content.classList.remove('six-grid-page');renderNav();
    $('#crumbBack').hidden=false;$('#crumbBack').textContent='← 返回每日总览';$('#crumbBack').onclick=()=>openHome();$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=true;$('#crumbSeparator').hidden=true;
    const dateIndex=state.dates.indexOf(state.date),quotes=new Map((state.review.indices||[]).map(item=>[item.code,item]));
    $('#topbarActions').innerHTML=`<div class="review-date-controls topbar-date-controls"><button id="prevIndexDate" class="date-nav-button" ${dateIndex<=0?'disabled':''}>← 前一日</button>${datePickerTriggerMarkup('indexDatePickerTrigger','date-nav-button')}<button id="nextIndexDate" class="date-nav-button" ${dateIndex<0||dateIndex>=state.dates.length-1?'disabled':''}>后一日 →</button></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button>`;
    $('#openSettings').onclick=openSettings;
    const rows=INDEX_CATALOG.map(item=>{const quote=quotes.get(item.code),pct=quote?.pct_chg==null?null:Number(quote.pct_chg),tone=pct==null?'':pct>=0?'pct-up':'pct-down';return `<tr data-overview-index="${esc(item.code)}" tabindex="0" aria-label="打开${esc(item.name)}详情"><td><div class="index-overview-identity"><button type="button" class="index-name-link" data-index-preview="${esc(item.code)}" data-index-date="${state.date}">${esc(item.name)}</button><small>${esc(item.code)}</small></div></td><td class="intraday-cell">${topicIntradayPlaceholder('读取中')}</td><td class="daily-kline-cell">${topicIntradayPlaceholder('读取中')}</td><td class="index-overview-value">${quote?.close==null?'—':num(quote.close)}</td><td class="index-overview-value ${tone}">${pct==null?'—':`${pct>=0?'+':''}${pct.toFixed(2)}%`}</td><td class="index-overview-value">${quote?.amount==null?'—':compactYuan(Number(quote.amount)*1000)}</td></tr>`;}).join('');
    content.innerHTML=`<div class="page-title topic-page-title index-overview-title"><div class="topic-title-copy"><span class="eyebrow">INDEX / ${fmtDate(state.date)}</span><div class="topic-title-main"><span class="index-overview-icon">指</span><h1>重要指数</h1></div></div></div><section class="topic-hero index-overview-hero"><span class="eyebrow">当日指数分析</span></section><div class="section-heading"><h3>指数表现</h3></div><div class="panel index-overview-panel"><table class="stock-table index-overview-table"><thead><tr><th>指数</th><th>分时图</th><th>日K</th><th>收盘点位</th><th>涨幅</th><th>成交额</th></tr></thead><tbody>${rows}</tbody></table></div><div class="section-heading"><h3 title="上证指数成交额＋深证综指成交额">两市成交额 <span class="turnover-current-value" id="marketTurnoverCurrentValue" aria-label="当日两市成交额">读取中…</span></h3></div><div class="panel market-turnover-panel" id="marketTurnoverChart"><div class="market-turnover-loading">正在读取成交额…</div></div><div class="section-heading"><h3>涨幅分布</h3></div>${distributionCharts(state.review.marketStats?.returnDistributions)}`;
    content.querySelectorAll('[data-overview-index]').forEach(row=>{const open=()=>openIndex(row.dataset.overviewIndex);row.addEventListener('click',event=>{if(!event.target.closest('[data-index-preview]'))open();});row.addEventListener('keydown',event=>{if(event.target.closest('[data-index-preview]'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});});
    $('#prevIndexDate').onclick=()=>navigateIndicesDate(-1);$('#nextIndexDate').onclick=()=>navigateIndicesDate(1);
    loadMarketTurnover(state.date);
    loadIndicesOverviewCharts(state.date);
  }
  async function openIndicesOverview(date=state.date,historyMode='push'){if(needsReviewDate(date)&&!await loadDate(date))return;syncBrowserRoute('indices',date,'','',historyMode);renderIndicesOverview();}
  async function navigateIndicesDate(step){const target=state.dates[state.dates.indexOf(state.date)+step];if(!target)return;syncBrowserRoute('indices',target);if(!await loadDate(target))return;renderIndicesOverview();}
  function moveIndex(step){if(!state.index)return;const list=indexSequence(),i=list.findIndex(item=>item.code===state.index.code),next=list[i+step];if(next)openIndex(next.code);}
  async function openIndex(code,date=state.date,historyMode='push'){
    if(history.state?.view==='ladder'&&ladderView)ladderView.returnSnapshot=captureLadderReturn();
    closeIndexHover();closeLadderTopicHover();
    if(needsReviewDate(date)&&!await loadDate(date))return;
    const item=indexSequence().find(index=>index.code===String(code||'').toUpperCase());
    if(!item){toast('没有找到这个指数');return;}
    syncBrowserRoute('index',date,'','',historyMode,'',item.code);
    state.indicesPage=false;state.topic=null;state.stock=null;state.index=item;state.indexData=null;state.latestMode=indexUsesLatestDate();state.indicesExpanded=true;
    renderNav();loadIndex(item);
  }
  function indexUsesLatestDate(){return state.stockDatePreference==='latest'&&!history.state?.indexCutoff;}
  async function loadIndex(item){
    const requestId=++state.indexLoadId,route=location.href,latest=indexUsesLatestDate(),dataDate=latest?(state.dates[state.dates.length-1]||state.date):state.date;state.index=item;state.latestMode=latest;
    $('#crumbBack').hidden=false;$('#crumbBack').textContent='← 返回重要指数';$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=true;$('#crumbSeparator').hidden=true;$('#crumbBack').onclick=()=>goBackInApp('indices');applyLadderReturnLink();
    content.innerHTML='<div class="loading"><span class="spinner"></span><p>正在读取指数行情…</p></div>';
    try{const data=await getIndexHistory(item.code,dataDate);if(requestId!==state.indexLoadId||route!==location.href)return;state.indexData=data;renderIndex(item,data);}
    catch(error){if(requestId!==state.indexLoadId||route!==location.href)return;content.innerHTML=`<div class="empty-state">指数行情读取失败：${esc(error.message)}<br><button class="light-button" id="retryIndex">重试</button></div>`;$('#retryIndex').onclick=()=>loadIndex(item);}
  }
  function renderIndex(item,data){
    state.charts.forEach(id=>{try{window.klinecharts.dispose(id)}catch{}});state.charts=[];state.chartInstances=[];content.classList.toggle('six-grid-page',state.chartLayout==='grid');
    const daily=data.daily||[],latest=daily[daily.length-1],previous=daily[daily.length-2],close=latest?.close==null?null:Number(latest.close),pct=latest?.pct_chg!=null?Number(latest.pct_chg):close!=null&&Number(previous?.close)>0?(close/Number(previous.close)-1)*100:null,pctText=pct==null?'—':`${pct>=0?'+':''}${pct.toFixed(2)}%`,sequence=indexSequence(),index=indexSequence().findIndex(x=>x.code===item.code);
    const specs=[['oneMin','1 分钟','指数分钟数据库'],['daily','日线','指数日线数据库'],['fifteenMin','15 分钟','指数15分钟数据库'],['monthly','月线','指数月线数据库'],['weekly','周线','指数周线数据库']];
    $('#topbarActions').innerHTML=`<div class="stock-nav-controls"><button class="date-nav-button" id="prevIndex" ${index>0?'':'disabled'}>← 上一指数</button><span class="stock-position" aria-label="指数序号">${index+1} / ${sequence.length}</span><button class="date-nav-button" id="nextIndex" ${index<sequence.length-1?'':'disabled'}>下一指数 →</button></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button>`;
    $('#openSettings').onclick=openSettings;$('#prevIndex').onclick=()=>moveIndex(-1);$('#nextIndex').onclick=()=>moveIndex(1);
    const quoteDate=latest?.timestamp?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}).format(new Date(latest.timestamp)):state.date.slice(4,6)+'/'+state.date.slice(6,8);
    const summaryCard=`<section class="chart-card reason-card index-summary-card"><div class="chart-head"><div class="chart-title"><strong>${esc(item.name)} · ${esc(quoteDate)}</strong></div></div><div class="reason-copy">收盘 ${close==null?'—':num(close)}　涨幅 <span class="${pct==null?'':pct>=0?'pct-up':'pct-down'}">${esc(pctText)}</span>　成交额 ${latest?.amount==null?'—':compactYuan(Number(latest.amount)*1000)}<br>日线 ${daily.length} 根 · 分钟 ${data.coverage?.oneMinBars||0} 根 · 分钟覆盖 ${esc(data.coverage?.oneMinStart||'—')} — ${esc(data.coverage?.oneMinEnd||'—')}</div></section>`;
    const stackClass=`chart-stack${state.chartLayout==='grid'?' six-grid':''}`;
    const chartDateLabel=key=>{const bar=(data[key]||[]).at(-1),day=bar?chartDayKey(bar):'';return day?day.slice(4,6)+'/'+day.slice(6,8):'—';};
    content.innerHTML=`<div class="stock-head index-detail-head"><div class="stock-title"><div class="stock-monogram index-monogram">指</div><div class="stock-info-row"><div class="stock-info-copy"><span class="eyebrow">INDEX / ${fmtDate(state.date)}</span><div class="stock-name-row"><h1>${esc(item.name)}</h1><div class="stock-latest-quote"><span><i>收盘</i><b>${close==null?'—':num(close)}</b></span><span class="${pct==null?'':pct>=0?'pct-up':'pct-down'}"><i>涨幅</i><b>${esc(pctText)}</b></span></div></div><div class="stock-code">${esc(item.code)} · 指数 · 行情日期 ${esc(quoteDate)}</div></div></div></div></div><section class="stock-overview index-overview"><div class="overview-grid"><div class="overview-item"><span class="eyebrow">指数概况</span><p>1 分钟、15 分钟均读取原生指数行情；分钟副图显示成交额。</p></div><div class="overview-item"><span class="eyebrow">当日成交额</span><p class="index-detail-amount">${latest?.amount==null?'—':compactYuan(Number(latest.amount)*1000)}</p></div></div><div class="stock-mini-metrics"><div class="mini-metric"><span>日线覆盖</span><strong>${daily.length} 根</strong></div><div class="mini-metric"><span>分钟覆盖</span><strong>${data.coverage?.oneMinBars||0} 根</strong></div><div class="mini-metric"><span>分钟数据日期</span><strong>${esc(data.coverage?.oneMinStart||'—')} — ${esc(data.coverage?.oneMinEnd||'—')}</strong></div></div></section><div class="${stackClass}">${state.chartLayout==='grid'?summaryCard:''}${specs.map(([key,title,source],i)=>`<section class="chart-card"><div class="chart-head"><div class="chart-title"><strong>${title}</strong><span class="index-chart-date">截至 ${esc(chartDateLabel(key))}</span></div><div class="chart-meta">${source} · ${(data[key]||[]).length} 根</div></div><div id="index-chart-${i}" class="chart-mount ${key==='oneMin'||key==='fifteenMin'?'intraday':''}"></div>${key==='oneMin'&&!data.coverage?.oneMinBars?'<div class="chart-note">该指数没有可用的分钟数据</div>':''}${key==='fifteenMin'&&!(data.fifteenMin||[]).length?'<div class="chart-note">该指数没有可用的15分钟数据</div>':''}</section>`).join('')}</div>`;
    const latestDailyDate=latest?chartDayKey(latest):data.date||state.date;
    specs.forEach(([key],i)=>{const bars=data[key]||[],isIntraday=key==='oneMin'||key==='fifteenMin',anchorDate=!state.latestMode?state.date:isIntraday&&bars.length?chartDayKey(bars.at(-1)):latestDailyDate;drawChart(`index-chart-${i}`,bars,key,item.code,anchorDate,daily,[]);});
  }
  async function openTopic(name,date=state.date,historyMode='push'){if(needsReviewDate(date)&&!await loadDate(date))return;if(!state.review.topics.some(t=>t.name===name)){toast(`该日没有「${name}」题材页面`);return;}syncBrowserRoute('topic',date,name,'',historyMode);renderTopic(name);renderNav();}
  let ladderRequestId=0,ladderResizeObserver=null,ladderView=null;
  const ladderCache=new Map(),ladderThemeColors=new Map();
  const LADDER_PRELOAD_SESSIONS=20,LADDER_CACHE_LIMIT=24,LADDER_CACHE_SCHEMA=15;
  const ladderRequests=new Map();let ladderCacheDbPromise=null,ladderRevision='',ladderRevisionAt=0,ladderRevisionRequest=null;
  async function currentLadderVersion(){
    if(ladderRevision&&Date.now()-ladderRevisionAt<30000)return ladderRevision;
    if(!ladderRevisionRequest)ladderRevisionRequest=api('/api/ladder-version',{cache:'no-store'}).then(meta=>{
      if(!meta.ladderDataVersion||meta.ladderSeriesVersion!==LADDER_CACHE_SCHEMA)throw new Error('天梯数据版本不可用');
      if(ladderRevision!==meta.ladderDataVersion)ladderCache.clear();ladderRevision=meta.ladderDataVersion;ladderRevisionAt=Date.now();return ladderRevision;
    }).finally(()=>{ladderRevisionRequest=null;});return ladderRevisionRequest;
  }
  function validLadderCache(record,revision){return record?.revision===revision&&record.payload?.ladderSeriesVersion===LADDER_CACHE_SCHEMA&&Date.now()-record.savedAt<record.ttl;}
  function rememberLadderCache(record){ladderCache.delete(record.key);ladderCache.set(record.key,record);while(ladderCache.size>LADDER_CACHE_LIMIT)ladderCache.delete(ladderCache.keys().next().value);}
  function openLadderCache(){
    if(!('indexedDB' in window))return Promise.reject(new Error('IndexedDB unavailable'));
    if(!ladderCacheDbPromise)ladderCacheDbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open('tradingalert-ladder-cache',1);let settled=false;
      const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);ladderCacheDbPromise=null;reject(error);},timer=setTimeout(()=>fail(new Error('天梯缓存连接超时')),1500);
      request.onupgradeneeded=()=>{const store=request.result.createObjectStore('blocks',{keyPath:'key'});store.createIndex('savedAt','savedAt');};
      request.onerror=()=>fail(request.error);request.onblocked=()=>fail(new Error('天梯缓存被占用'));
      request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}settled=true;clearTimeout(timer);db.onversionchange=()=>{db.close();ladderCacheDbPromise=null;};resolve(db);};
    });return ladderCacheDbPromise;
  }
  async function readLadderCache(key,revision){
    const memory=ladderCache.get(key);if(validLadderCache(memory,revision)){rememberLadderCache(memory);return {payload:memory.payload,source:'memory'};}ladderCache.delete(key);
    try{const db=await openLadderCache(),record=await new Promise((resolve,reject)=>{const req=db.transaction('blocks','readonly').objectStore('blocks').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});if(validLadderCache(record,revision)){rememberLadderCache(record);return {payload:record.payload,source:'indexeddb'};}}catch(error){console.warn('天梯持久缓存读取失败，使用服务器',error);}return null;
  }
  async function writeLadderCache(record){
    const db=await openLadderCache();await new Promise((resolve,reject)=>{const tx=db.transaction('blocks','readwrite'),store=tx.objectStore('blocks');store.put(record);const live=[],request=store.index('savedAt').openKeyCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor){live.slice(0,Math.max(0,live.length-LADDER_CACHE_LIMIT)).forEach(key=>store.delete(key));return;}if(Date.now()-Number(cursor.key)>=86400000)store.delete(cursor.primaryKey);else live.push(cursor.primaryKey);cursor.continue();};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
  }
  let liveLadderStatus=null;
  async function readLiveLadderStatus(){
    try{liveLadderStatus=await api('/api/ladder-live-status',{cache:'no-store'});if(liveLadderStatus.available&&!state.dates.includes(liveLadderStatus.date)){state.dates.push(liveLadderStatus.date);state.dates.sort();}}catch(error){console.warn('实时天梯状态暂不可用',error);}
    return liveLadderStatus;
  }
  function ladderStockPct(stock){
    const raw=stock?.pct,value=Number(raw);return raw!=null&&raw!==''&&Number.isFinite(value)?value:null;
  }
  function ladderStockPctText(stock){const pct=ladderStockPct(stock);return pct==null?'—':(pct>0?'+':'')+pct.toFixed(2)+'%';}
  function compareLadderFailedPct(a,b){
    const ap=ladderStockPct(a),bp=ladderStockPct(b);
    return (ap==null?1:0)-(bp==null?1:0)||(ap!=null&&bp!=null?bp-ap:0)||Number(b.previousBoard||0)-Number(a.previousBoard||0)||a.name.localeCompare(b.name,'zh-CN');
  }
  function ladderStockName(stock){
    const pct=ladderStockPct(stock);return esc(stock.name)+`<tspan dx="3" class="vl-live-pct ${pct==null?'':pct>0?'vl-live-up':pct<0?'vl-live-down':''}" data-vl-stock-pct="${esc(stock.code)}" data-vl-pct-date="${esc(stock.date)}">${ladderStockPctText(stock)}</tspan>`;
  }
  function updateLiveLadderLabel(view,message=''){
    const label=$('#ladderLiveStatus');if(!label)return;label.hidden=!view.live&&!message;
    const age=view.live?Math.max(0,Math.floor((Date.now()+liveClockOffset-Date.parse(view.live.updatedAt))/1000)):0;
    if(view.live?.mode==='close')message='';
    const text=message||(view.live?(view.live.mode==='close'?'收盘快照 · '+view.live.updatedAt.slice(11,19):(view.live.frozen?'午间行情 · ':'行情更新 · ')+view.live.updatedAt.slice(11,19)+' · '+age+'秒前'):'');
    if(label.textContent!==text)label.textContent=text;
    label.title='左侧为当前北京时间；此处为行情批次时间。行情时间：'+(view.live?.updatedAt||'—')+'；浏览器最近收到推送：'+(view.lastPushReceivedAt||'—');
  }
  async function refreshLiveLadder(pushedStatus=null,force=false){
    const view=ladderView;if(!view||view.liveLoading||view.loading||view.dragging||document.hidden||history.state?.view!=='ladder')return;
    if(!liveEnabled&&view.live?.mode!=='close'){if(view.live)updateLiveLadderLabel(view,'实时已暂停 · '+view.live.updatedAt.slice(11,19));return;}
    view.liveLoading=true;
    try{
      const status=pushedStatus||await readLiveLadderStatus();if(ladderView!==view||history.state?.view!=='ladder')return;
      if(status?.offlineReady&&view.live?.mode==='close'&&view.endDay===status.date){
        liveLadderStatus=status;ladderRevisionAt=0;
        const result=await getLadderPayload(status.date,Math.min(20,view.end+1));if(ladderView!==view||view.dragging)return;
        for(const name of ['sealed','outcomes','unpromoted','broken'])for(const [key,stock] of view[name])if(stock.date===status.date)view[name].delete(key);
        for(const name of ['links','relimitLinks'])for(const [key,edge] of view[name]||[])if(edge.source.startsWith(status.date+':')||edge.target.startsWith(status.date+':'))view[name].delete(key);
        for(const [key,carry] of view.suspensionCarry)if(carry.targetDate===status.date)view.suspensionCarry.delete(key);
        view.brokenDates.delete(status.date);view.live=null;view.specifiedLegendCache?.clear();view.specifiedLegendPayload=null;
        mergeLadderPayload(view,result.payload,result.source);view.patchPaint=true;rebuildVerticalLadder(view);syncLivePushConnection();return;
      }
      if(!status?.available){if(view.live)updateLiveLadderLabel(view,(status?.status?.phase==='closed'?'收盘快照 · ':'实时数据待更新 · ')+view.live.updatedAt.slice(11,19));return;}
      if(view.endDay!==status.date){if(!view.live&&!history.state?.ladderEnd&&view.end===state.dates.length-2){await openLadderDate(status.date,true);}return;}
      if(!force&&view.live?.revision===status.revision)return;
      if(!force&&status.structureRevision&&view.live?.structureRevision===status.structureRevision){
        view.live={...view.live,...status};updateLiveLadderLabel(view);return;
      }
      const result=await getLadderPayload(status.date,Math.min(20,view.end+1));if(ladderView!==view||history.state?.view!=='ladder'||view.dragging||view.endDay!==status.date)return;
      mergeLadderPayload(view,result.payload,result.source);
      for(const key of ladderDateDetailCache.keys())if(key.startsWith(status.date+':'))ladderDateDetailCache.delete(key);
      for(const key of ladderTopicDetailCache.keys())if(key.startsWith(status.date+':'))ladderTopicDetailCache.delete(key);
      // mergeLadderPayload already seeded the new live legend; keep it visible during updates.
      if(ladderStockHover&&!ladderStockHover.card.hidden||ladderTopicHover&&!ladderTopicHover.card.hidden||indexHover&&!indexHover.card.hidden){view.pendingPaint=true;updateLiveLadderLabel(view);return;}
      closeLadderTopicHover();rebuildVerticalLadder(view);updateLiveLadderLabel(view);
    }catch(error){if(ladderView===view)updateLiveLadderLabel(view,'实时更新失败，保留上一快照');console.warn('实时天梯更新失败',error);}finally{view.liveLoading=false;}
  }
  async function getLadderPayload(date,sessions){
    if(date===liveLadderStatus?.date&&liveLadderStatus.available){
      const payload=await api(`/api/limitup-ladder?date=${date}&sessions=${sessions}`,{cache:'no-store'});
      if(!payload.live)throw new Error('当天实时快照暂不可用');return {payload,source:payload.live.mode==='close'?'online-close':'redis-live'};
    }
    const revision=await currentLadderVersion(),key=`v${LADDER_CACHE_SCHEMA}:${date}:${sessions}`,requestKey=key+':'+revision;
    if(ladderRequests.has(requestKey))return ladderRequests.get(requestKey);
    const task=(async()=>{
      const cached=await readLadderCache(key,revision);if(cached)return cached;
      const payload=await api(`/api/limitup-ladder?date=${date}&sessions=${sessions}`,{cache:'no-store'});
      if(payload.ladderSeriesVersion!==LADDER_CACHE_SCHEMA||!payload.ladderDataVersion)throw new Error('天梯数据版本不匹配');
      if(ladderRevision!==payload.ladderDataVersion){ladderCache.clear();ladderRevision=payload.ladderDataVersion;ladderRevisionAt=Date.now();}
      const record={key,revision:payload.ladderDataVersion,savedAt:Date.now(),ttl:Math.min(86400000,(payload.cacheTtlSeconds||300)*1000),payload};rememberLadderCache(record);writeLadderCache(record).catch(error=>console.warn('天梯持久缓存写入失败，继续使用内存缓存',error));
      return {payload,source:payload.cacheHit?payload.cacheBackend:'database'};
    })();ladderRequests.set(requestKey,task);return task.finally(()=>{if(ladderRequests.get(requestKey)===task)ladderRequests.delete(requestKey);});
  }
  const ladderTopicDetailCache=new Map(),ladderTopicDetailRequests=new Map(),ladderDateDetailCache=new Map(),ladderDateDetailRequests=new Map();let ladderTopicHover=null;
  async function getLadderTopicDetails(date,revision){
    const key=date+':'+revision,cached=ladderTopicDetailCache.get(key);
    if(cached&&Date.now()-cached.savedAt<cached.ttl)return cached.payload;
    if(ladderTopicDetailRequests.has(key))return ladderTopicDetailRequests.get(key);
    const task=api('/api/ladder-topic-details?date='+date,{cache:'no-store'}).then(payload=>{
      if(payload.ladderDataVersion!==revision)throw new Error('行情数据已更新，请刷新天梯后查看详情');
      ladderTopicDetailCache.delete(key);ladderTopicDetailCache.set(key,{payload,savedAt:Date.now(),ttl:(payload.ttlSeconds||300)*1000});
      while(ladderTopicDetailCache.size>32)ladderTopicDetailCache.delete(ladderTopicDetailCache.keys().next().value);return payload;
    });ladderTopicDetailRequests.set(key,task);return task.finally(()=>{if(ladderTopicDetailRequests.get(key)===task)ladderTopicDetailRequests.delete(key);});
  }
  async function getLadderDateDetails(date,revision){
    const key=date+':'+revision,cached=ladderDateDetailCache.get(key);
    if(cached&&Date.now()-cached.savedAt<cached.ttl)return cached.payload;
    if(ladderDateDetailRequests.has(key))return ladderDateDetailRequests.get(key);
    const task=api('/api/ladder-date-details?date='+date,{cache:'no-store'}).then(payload=>{
      if(payload.ladderDataVersion!==revision)throw new Error('行情数据已更新，请刷新天梯后查看详情');
      ladderDateDetailCache.delete(key);ladderDateDetailCache.set(key,{payload,savedAt:Date.now(),ttl:(payload.ttlSeconds||300)*1000});
      while(ladderDateDetailCache.size>32)ladderDateDetailCache.delete(ladderDateDetailCache.keys().next().value);return payload;
    });ladderDateDetailRequests.set(key,task);return task.finally(()=>{if(ladderDateDetailRequests.get(key)===task)ladderDateDetailRequests.delete(key);});
  }
  function closeLadderTopicHover(){
    closeLadderNestedThemeHover();closeLadderStockHover();closeIndexHover();
    const hover=ladderTopicHover;if(!hover)return;
    clearTimeout(hover.showTimer);clearTimeout(hover.hideTimer);hover.requestId++;hover.anchor=null;hover.card.hidden=true;hover.card.onclick=null;flushPendingLiveLadder();
  }
  function ensureLadderTopicHover(){
    if(ladderTopicHover)return ladderTopicHover;
    const card=document.createElement('section');card.id='ladderTopicHover';card.className='vl-topic-hover';card.hidden=true;card.setAttribute('role','dialog');card.setAttribute('aria-label','题材当日涨停列表');card.setAttribute('tabindex','-1');document.body.append(card);
    const hover=ladderTopicHover={card,requestId:0,showTimer:0,hideTimer:0,anchor:null};
    card.addEventListener('pointerenter',()=>clearTimeout(hover.hideTimer));
    card.addEventListener('pointerleave',event=>{if(ladderStockHover?.card.contains(event.relatedTarget)||indexHover?.card.contains(event.relatedTarget)||ladderNestedThemeHover?.card.contains(event.relatedTarget))return;hover.hideTimer=setTimeout(closeLadderTopicHover,140);});
    card.addEventListener('focusin',()=>clearTimeout(hover.hideTimer));
    card.addEventListener('focusout',event=>{if(!card.contains(event.relatedTarget)&&!ladderNestedThemeHover?.card.contains(event.relatedTarget)&&!ladderStockHover?.card.contains(event.relatedTarget)&&!indexHover?.card.contains(event.relatedTarget))hover.hideTimer=setTimeout(closeLadderTopicHover,140);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!card.hidden){event.preventDefault();event.stopPropagation();closeLadderTopicHover();}},true);
    window.addEventListener('resize',closeLadderTopicHover);
    document.addEventListener('scroll',event=>{if(!card.hidden&&!card.contains(event.target)&&!ladderStockHover?.card.contains(event.target)&&!ladderNestedThemeHover?.card.contains(event.target)&&!indexHover?.card.contains(event.target))closeLadderTopicHover();},true);
    return hover;
  }
  function positionLadderTopicHover(anchor,card){
    const zoom=parseFloat(getComputedStyle(document.documentElement).zoom)||1,margin=10;
    card.style.width=Math.min(card.dataset.hoverMode==='range'?Math.min(1080,32+76*Number(card.dataset.rangeDays||1)):card.dataset.hoverMode==='date'?720:620,(window.innerWidth-margin*2)/zoom)+'px';card.style.maxHeight=Math.min(600,(window.innerHeight-margin*2)/zoom)+'px';
    const box=anchor.getBoundingClientRect(),size=card.getBoundingClientRect();let x=box.right+12;
    if(x+size.width>window.innerWidth-margin)x=box.left-size.width-12;
    x=Math.max(margin,Math.min(x,window.innerWidth-size.width-margin));
    const y=Math.max(margin,Math.min(box.top-12,window.innerHeight-size.height-margin));
    card.style.left=x/zoom+'px';card.style.top=y/zoom+'px';
  }
  function isLadderGrowthStock(code){return /^(?:300|301|688|689)\d{3}(?:\.(?:SZ|SH))?$/.test(String(code||''));}
  function ladderHoverBoardBadge(node){
    const badge=ladderBoardBadgeStyle(node),multi=Number(node.patternDays)>Number(node.board),font=Number(node.board)>99?6:7.5;
    const number=multi?`<path d="M7 17 L17 7" stroke="currentColor" stroke-width=".65"/><text x="8.5" y="10" font-size="${font}" text-anchor="middle">${node.board}</text><text x="15.5" y="19" font-size="${Number(node.patternDays)>99?6:7.5}" text-anchor="middle">${node.patternDays}</text>`:`<text x="12" y="15.4" font-size="10" text-anchor="middle">${node.board}</text>`;
    return `<svg class="vl-hover-board" viewBox="0 0 24 24" aria-label="${esc(node.boardPeriod||node.board+'板')}" data-board-style="${badge.kind}" style="color:${badge.color}"><circle cx="12" cy="12" r="10" fill="${ladderThemeColor(node.theme)}" fill-opacity=".22" stroke="currentColor" stroke-width="1.2"${badge.dashed?' stroke-dasharray="2.5 1.8"':''}/><g fill="${ladderThemeColor(node.theme)}" style="color:${ladderThemeColor(node.theme)}" font-family="var(--mono)">${number}</g></svg>`;
  }
  function stockTouchedLimit(stock){return Boolean(stock.touchedLimit||stock.touchedLimitToday||stock.touched_limit_today||stock.isBroken||stock.status==='broken');}
  function stockOutcomeBadgeText(stock,broken=false){return broken||stockTouchedLimit(stock)?'破':'未';}
  function ladderHoverOutcomeBadge(stock){
    const broken=stockTouchedLimit(stock),stroke=broken?'#b28766':'#9caaa4',ink=ladderThemeColor(stock.theme),label=stockOutcomeBadgeText(stock),description=stock.status==='unpromoted'?'未晋级 · 昨'+(stock.previousBoardPeriod||stock.previousBoard+'板'):'冲击首板未封住';
    return `<svg class="vl-hover-board vl-hover-outcome" viewBox="0 0 24 24" data-hover-outcome="${stock.status}" aria-label="${esc(description)}"><title>${esc(description)}</title><circle cx="12" cy="12" r="10" fill="${ladderThemeColor(stock.theme)}" fill-opacity=".22" stroke="${stroke}" stroke-width="1.2"/><text x="12" y="15.4" text-anchor="middle" font-family="var(--sans)" font-size="10" fill="${ink}">${label}</text></svg>`;
  }
  function ladderHoverThemeTitle(theme,date,linked=false){
    return linked?`<button type="button" class="vl-hover-theme-link" data-vl-hover-theme="${esc(theme)}" data-vl-hover-theme-date="${date}" aria-label="查看${esc(theme)}题材页面，${esc(fmtDate(date))}">${esc(theme)}</button>`:`<strong>${esc(theme)}</strong>`;
  }
  function ladderTopicSortValue(stock,details,key){
    const facts=details?.stocks?.[stock.code];
    if(key==='time'){
      const time=stock.status==='unpromoted'?(stock.touchedLimit?facts?.time:''):stock.time||facts?.time;
      const match=/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time||''));
      if(!match)return null;const [hour,minute,second]=match.slice(1).map(value=>Number(value||0));
      return hour<24&&minute<60&&second<60?hour*3600+minute*60+second:null;
    }
    const value=key==='pct'?facts?.pct??stock.pct:stock.status==='sealed'?facts?.sealAmount:null;
    return value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
  }
  function ladderSortTopicStocks(stocks,details,key=''){
    return [...stocks].sort((a,b)=>{
      if(['time','sealAmount','pct'].includes(key)){
        const left=ladderTopicSortValue(a,details,key),right=ladderTopicSortValue(b,details,key);
        if(left==null&&right!=null)return 1;if(right==null&&left!=null)return -1;
        if(left!=null&&right!=null&&left!==right)return key==='time'?left-right:right-left;
      }
      return (a.status==='sealed'?0:1)-(b.status==='sealed'?0:1)||Number(b.board||b.previousBoard||0)-Number(a.board||a.previousBoard||0)||(a.time||details?.stocks?.[a.code]?.time||'99:99:99').localeCompare(b.time||details?.stocks?.[b.code]?.time||'99:99:99')||a.name.localeCompare(b.name,'zh-CN');
    });
  }
  function ladderTopicSortHeading(key,label,sortKey){
    const active=key===sortKey,ascending=key==='time',direction=ascending?'从早到晚':key==='sealAmount'?'从大到小':'从高到低';
    return `<th aria-sort="${active?(ascending?'ascending':'descending'):'none'}"><button type="button" class="vl-hover-sort" data-vl-hover-sort="${key}" aria-label="${label}，${direction}" title="组内按${label}${direction}排列">${label}${active?`<span aria-hidden="true">${ascending?'↑':'↓'}</span>`:''}</button></th>`;
  }
  function sortLadderTopicHover(event,hover,sort,render){
    const button=event.target.closest('[data-vl-hover-sort]');if(!button)return false;
    const key=button.dataset.vlHoverSort;if(!['time','sealAmount','pct'].includes(key))return false;
    event.preventDefault();event.stopPropagation();sort.key=key;render(sort.details,sort.loading,sort.error);
    hover.card.querySelector(`[data-vl-hover-sort="${key}"]`)?.focus({preventScroll:true});return true;
  }
  function ladderFreeTurnoverCell(stock,details){
    const raw=details?.freeFloatTurnoverByCode?.[stock.code],value=Number(raw);
    return `<td class="vl-hover-mono vl-hover-turnover">${raw!=null&&raw!==''&&Number.isFinite(value)&&value>=0?value.toFixed(2)+'%':'—'}</td>`;
  }
  function renderLadderTopicHover(theme,date,stocks,details,loading=false,error=false,linkedTitle=false,sortKey=''){
    const tiers=[{level:5,label:'高板'},{level:4,label:'四板'},{level:3,label:'三板'},{level:2,label:'二板'},{level:1,label:'首板'},{level:0,label:'破板'}],sealed=stocks.filter(stock=>stock.status==='sealed');
    const exactCatalyst=details?.catalysts?.[theme],relatedCatalysts=sealed.flatMap(stock=>{const byTheme=details?.stocks?.[stock.code]?.catalysts||{};return byTheme[stock.originalTheme]?[byTheme[stock.originalTheme]]:Object.values(byTheme);}),catalyst=String(exactCatalyst||[...new Set(relatedCatalysts.filter(Boolean))].join('；')).replace(/\s+/g,' ').trim();
    return `<header class="vl-hover-head"><div>${ladderHoverThemeTitle(theme,date,linkedTitle)}<span>${esc(fmtDate(date))}</span><span class="vl-hover-catalyst" title="${esc(catalyst)}">${esc(catalyst||'—')}</span></div><span class="vl-hover-count">涨停 ${sealed.length} · 未 ${stocks.filter(stock=>stock.status==='unpromoted').length}${loading?'':' · 破 '+stocks.filter(stock=>stock.status==='broken').length}</span></header><div class="vl-hover-scroll"><table><colgroup><col class="vl-hover-stock-col"/><col class="vl-hover-pct-col"/><col class="vl-hover-turnover-col"/><col class="vl-hover-time-col"/><col class="vl-hover-amount-col"/><col/></colgroup><thead><tr><th>股票</th>${ladderTopicSortHeading('pct','涨幅',sortKey)}<th>自由换手率</th>${ladderTopicSortHeading('time','涨停时间',sortKey)}${ladderTopicSortHeading('sealAmount','封板金额',sortKey)}<th>题材简因</th></tr></thead><tbody>${tiers.map(tier=>{
      const members=ladderSortTopicStocks(stocks.filter(stock=>stock.hoverTier===tier.level),details,sortKey),failedCount=members.filter(stock=>stock.status==='unpromoted').length;
      return `<tr class="vl-hover-tier"><th colspan="6">${tier.label}<span>${tier.level===0?members.length:members.filter(stock=>stock.status==='sealed').length}${failedCount?' · 未 '+failedCount:''}</span></th></tr>`+(members.length?members.map(stock=>{
        const facts=details?.stocks?.[stock.code],rawReason=String(facts?.reasons?.[theme]||facts?.reasons?.[stock.originalTheme]||facts?.reason||'').replace(/\s+/g,' ').trim(),rawPct=facts?.pct??stock.pct,pct=Number(rawPct),hasPct=rawPct!=null&&Number.isFinite(pct),pctClass=hasPct?(pct>0?'pct-up':pct<0?'pct-down':''):'',time=stock.status==='unpromoted'?(stock.touchedLimit?facts?.time:''):stock.time||facts?.time,label=stock.status==='unpromoted'?'未晋级 · 昨'+(stock.previousBoardPeriod||stock.previousBoard+'板'):stock.status==='broken'?'破板':stock.boardPeriod,badge=stock.status==='sealed'?ladderHoverBoardBadge(stock):ladderHoverOutcomeBadge(stock);
        return `<tr><td><button type="button" class="vl-hover-stock" data-vl-hover-stock="${esc(stock.id)}" aria-label="${esc(stock.name+' · '+label+' · 查看个股')}" title="${esc(stock.name+' '+stock.code+' · '+label)}">${badge}<span data-vl-stock-preview="${esc(stock.id)}"${isLadderGrowthStock(stock.code)?' class="vl-hover-growth-name"':''}>${esc(stock.name)}</span></button></td><td class="vl-hover-mono ${pctClass}">${hasPct?(pct>0?'+':'')+pct.toFixed(2)+'%':'—'}</td>${ladderFreeTurnoverCell(stock,details)}<td class="vl-hover-mono">${esc(time||'—')}</td><td class="vl-hover-mono">${stock.status==='sealed'&&facts?compactBoardAmount(facts.sealAmount):'—'}</td><td class="vl-hover-reason"><span class="vl-hover-reason-text" title="${esc(rawReason)}">${esc(rawReason||'—')}</span></td></tr>`;
      }).join(''):'<tr class="vl-hover-empty"><td colspan="6">—</td></tr>');
    }).join('')}</tbody></table></div>${loading?'<footer aria-live="polite">正在读取封板金额、原因与破板数据…</footer>':error?'<footer aria-live="polite">暂未取得补充数据</footer>':''}`;
  }
  function ladderLegendStockMembers(stocks){
    const members=new Map(),rank={sealed:0,unpromoted:1,broken:2};
    for(const stock of stocks){const prior=members.get(stock.code);if(!prior||stock.date>prior.date||stock.date===prior.date&&(rank[stock.status]??3)<(rank[prior.status]??3))members.set(stock.code,stock);}
    return [...members.values()].sort((a,b)=>Number(b.board||b.previousBoard||0)-Number(a.board||a.previousBoard||0)||(a.time||'99:99:99').localeCompare(b.time||'99:99:99')||a.name.localeCompare(b.name,'zh-CN'));
  }
  function ladderLegendStockVisible(view,theme){return view.legendStockOverrides?.get(theme)??Boolean(view.legendStocksAll);}
  function ladderLegendStockRow(stock,facts){
    const pushed=liveEnabled&&stock.date===liveStatus?.date?livePushedQuotes.get(stock.date+':'+stock.code):null,raw=pushed?.pct??facts?.pct??stock.pct,pct=Number(raw),hasPct=raw!=null&&raw!==''&&Number.isFinite(pct),pctText=hasPct?(pct>0?'+':'')+pct.toFixed(2)+'%':'—',tone=hasPct?(pct>0?'pct-up':pct<0?'pct-down':''):'',time=stock.status==='unpromoted'&&!stock.touchedLimit?'':stock.time||facts?.time||'',amount=stock.status==='sealed'?compactBoardAmount(facts?.sealAmount):'—',badge=stock.status==='sealed'?ladderHoverBoardBadge(stock):ladderHoverOutcomeBadge(stock),label=stock.status==='unpromoted'?'未晋级 · 昨'+(stock.previousBoardPeriod||stock.previousBoard+'板'):stock.status==='broken'?'破板':stock.boardPeriod;
    return `<button type="button" class="vl-legend-stock-row" data-vl-legend-stock="${esc(stock.id)}" aria-label="${esc(stock.name+' · '+label+' · '+fmtDate(stock.date))}" title="${esc(fmtDate(stock.date)+' · '+stock.name+' · '+label+' · 涨幅 '+pctText+' · 涨停时间 '+(time||'—')+' · 封板金额 '+amount+' · 单击显示题材内的单股紧凑脉络，双击查看个股')}" style="--ladder-theme-color:${ladderThemeColor(stock.theme)}">${badge}<span data-vl-stock-preview="${esc(stock.id)}" class="vl-legend-stock-name${isLadderGrowthStock(stock.code)?' vl-hover-growth-name':''}">${esc(stock.name)}</span><span class="vl-legend-stock-pct ${tone}" data-vl-stock-pct="${esc(stock.code)}" data-vl-pct-date="${esc(stock.date)}">${esc(pctText)}</span><time>${esc(time||'—')}</time><span class="vl-legend-stock-amount">${esc(amount)}</span></button>`;
  }
  function ladderSelectStockPath(view,stock,fullData){
    const canonical=[...(fullData.sealedStocks||[]),...(fullData.unpromotedStocks||[]),...(fullData.brokenStocks||[])].find(node=>node.id===stock.id)||stock,theme=canonical.theme||stock.theme;
    view.minBoard=0;view.compactThemes=[theme];view.compactTheme=theme;view.focusedTheme='';view.focusedStock=stock.code;view.stockOnly=true;view.expandOnCompact=true;view.hiddenLevels?.clear();
  }
  function ladderStockPathData(fullData,code,days){
    const visible=new Set(days),keep=node=>node.code===code&&visible.has(node.date),sealed=(fullData.sealedStocks||[]).filter(keep).map(node=>({...node,representative:false,firstCount:0,members:[]})),nodes=new Map(fullData.nodes.filter(keep).map(node=>[node.id,node]));
    // Full sealed records include first boards omitted by the representative view.
    for(const node of sealed)nodes.set(node.id,node);
    const brokenStocks=(fullData.brokenStocks||[]).filter(keep),unpromotedStocks=(fullData.unpromotedStocks||[]).filter(keep),ids=new Set([...nodes.keys(),...brokenStocks.map(node=>node.id)]),themes=[...new Set([...nodes.values(),...brokenStocks,...unpromotedStocks].map(node=>node.theme))].map(name=>({name}));
    return {...fullData,nodes:[...nodes.values()],sealedStocks:sealed,brokenStocks,unpromotedStocks,themes,links:fullData.links.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),relimitLinks:(fullData.relimitLinks||[]).filter(edge=>ids.has(edge.source)&&ids.has(edge.target))};
  }
  function ladderFailedLevel(stock){
    const previous=Number(stock?.previousBoard);
    return Number.isInteger(previous)&&previous>=1?Math.min(previous+1,5):1;
  }
  function ladderDateHoverStocks(fullData,date,details){
    const sealed=[...new Map((fullData.sealedStocks||[]).filter(stock=>stock.status==='sealed'&&stock.date===date).map(stock=>[stock.code,{...stock,hoverTier:Math.min(Number(stock.board),5)}])).values()],winners=new Set(sealed.map(stock=>stock.code));
    const failed=[...new Map((fullData.unpromotedStocks||[]).filter(stock=>stock.date===date&&!winners.has(stock.code)).map(stock=>[stock.code,{...stock,status:'unpromoted',hoverTier:ladderFailedLevel(stock)}])).values()];
    const priorByCode=new Map();for(const node of fullData.sealedStocks||[]){if(node.date>=date)continue;const prior=priorByCode.get(node.code);if(!prior||prior.date<node.date)priorByCode.set(node.code,node);}
    const failedCodes=new Set(failed.map(stock=>stock.code));for(const extra of details?.promotionFailures||[]){if(failedCodes.has(extra.code)||winners.has(extra.code))continue;const prior=priorByCode.get(extra.code);if(!prior)continue;failed.push({...extra,id:date+':'+extra.code+':unpromoted',status:'unpromoted',theme:prior.theme,originalTheme:prior.originalTheme||prior.theme,sourceId:prior.id,previousBoard:prior.board,previousBoardPeriod:prior.boardPeriod,touchedLimit:true,hoverTier:ladderFailedLevel({previousBoard:prior.board})});}
    const attempted=new Set(failed.map(stock=>stock.code)),broken=(details?.brokenStocks||[]).filter(stock=>!winners.has(stock.code)&&!attempted.has(stock.code)).map(stock=>({...stock,hoverTier:0}));
    return [...sealed,...failed,...broken];
  }
  function ladderDateMarketOverview(date,stocks,themeStats,details,loading){
    const quotes=new Map((details?.indices||[]).map(quote=>[quote.code,quote]));
    const indices=INDEX_CATALOG.map(index=>{
      const quote=quotes.get(index.code),pct=quote?.pct_chg==null?null:Number(quote.pct_chg),tone=pct==null?'':pct>=0?'pct-up':'pct-down';
      return `<div class="vl-date-index"><button type="button" class="index-name-link" data-index-preview="${esc(index.code)}" data-index-date="${date}">${esc(index.name)}</button><span class="${tone}">${pct==null?'—':(pct>=0?'+':'')+pct.toFixed(2)+'%'}</span><b>${quote?.close==null?'—':num(quote.close)}</b><small title="成交额">${quote?.amount==null?'—':compactYuan(Number(quote.amount)*1000)}</small></div>`;
    }).join('');
    const themes=[...themeStats].map(([name,stats])=>({name,...stats})),highest=Math.max(0,...themes.map(theme=>theme.peak)),widest=Math.max(0,...themes.map(theme=>theme.count));
    const leaders=themes.filter(theme=>theme.peak===highest).map(theme=>theme.name).join('、'),broadest=themes.filter(theme=>theme.count===widest).map(theme=>theme.name).join('、'),market=details?.marketSummary;
    const rate=value=>value==null?'—':(Number(value)*100).toFixed(1)+'%';
    return `<section class="vl-date-market" aria-label="当日指数汇总"><div class="vl-date-indices">${indices}</div><p class="vl-date-market-summary" aria-label="当日题材概况"><span>${themes.length}题材 · ${stocks.filter(stock=>stock.status==='sealed').length}涨停</span><span title="${esc(leaders)}">最高 ${highest||'—'}板 ${esc(leaders||'—')}</span><span title="${esc(broadest)}">涨停最多 ${esc(broadest||'—')} ${widest||'—'}股</span><span title="昨日涨停、今日再次涨停：${market?.promotionNumerator??'—'}/${market?.promotionDenominator??'—'}">晋级率 ${rate(market?.promotionRate)}</span><span title="当日触板未封住 / 当日全部触板：${market?.broken??'—'}/${market?.touched??'—'}">破板率 ${rate(market?.breakRate)}</span></p></section>`;
  }
  function renderLadderDateHover(date,stocks,details,loading=false,error=false){
    const tiers=[{level:5,label:'高板'},{level:4,label:'四板'},{level:3,label:'三板'},{level:2,label:'二板'},{level:1,label:'首板'},{level:0,label:'破板'}],themeStats=new Map();
    for(const stock of stocks){if(stock.status!=='sealed')continue;const stats=themeStats.get(stock.theme)||{peak:0,count:0};stats.peak=Math.max(stats.peak,Number(stock.board));stats.count++;themeStats.set(stock.theme,stats);}
    return `<header class="vl-hover-head"><div><strong>${esc(fmtDate(date))}</strong><span>当日天梯</span></div><span class="vl-hover-count">涨停 ${stocks.filter(stock=>stock.status==='sealed').length} · 未 ${stocks.filter(stock=>stock.status==='unpromoted').length}${loading?'':' · 破 '+stocks.filter(stock=>stock.status==='broken').length}</span></header><div class="vl-hover-scroll">${ladderDateMarketOverview(date,stocks,themeStats,details,loading)}<table><colgroup><col class="vl-date-hover-theme-col"/><col class="vl-hover-stock-col"/><col class="vl-hover-pct-col"/><col class="vl-hover-turnover-col"/><col class="vl-hover-time-col"/><col/></colgroup><thead><tr><th>题材</th><th>股票</th><th>涨幅</th><th>自由换手率</th><th>涨停时间</th><th>简单原因</th></tr></thead><tbody>${tiers.map(tier=>{
      const groups=new Map();for(const stock of stocks.filter(stock=>stock.hoverTier===tier.level)){if(!groups.has(stock.theme))groups.set(stock.theme,[]);groups.get(stock.theme).push(stock);}
      const ordered=[...groups].map(([theme,members])=>({theme,members,wins:members.filter(stock=>stock.status==='sealed').length,peak:themeStats.get(theme)?.peak||0,total:themeStats.get(theme)?.count||0,time:members.filter(stock=>stock.status==='sealed').map(stock=>stock.time||'99:99:99').sort()[0]||members.map(stock=>details?.stocks?.[stock.code]?.time||stock.time||'99:99:99').sort()[0]})).sort((a,b)=>b.peak-a.peak||b.wins-a.wins||b.total-a.total||a.time.localeCompare(b.time)||a.theme.localeCompare(b.theme,'zh-CN'));
      return `<tr class="vl-hover-tier"><th colspan="6">${tier.label}<span>${tier.level===0?stocks.filter(stock=>stock.hoverTier===0).length:stocks.filter(stock=>stock.hoverTier===tier.level&&stock.status==='sealed').length}</span></th></tr>`+(ordered.length?ordered.map(group=>{
        const members=group.members.sort((a,b)=>(a.status==='sealed'?0:1)-(b.status==='sealed'?0:1)||(a.time||details?.stocks?.[a.code]?.time||'99:99:99').localeCompare(b.time||details?.stocks?.[b.code]?.time||'99:99:99')||a.name.localeCompare(b.name,'zh-CN')),color=ladderThemeColor(group.theme);
        return members.map((stock,index)=>{
          const facts=details?.stocks?.[stock.code],rawReason=String(facts?.reasons?.[stock.theme]||facts?.reasons?.[stock.originalTheme]||facts?.reason||facts?.marketReason||'').replace(/\s+/g,' ').trim(),rawPct=facts?.pct??stock.pct,pct=Number(rawPct),hasPct=rawPct!=null&&Number.isFinite(pct),time=stock.status==='unpromoted'?(stock.touchedLimit?facts?.time:''):stock.time||facts?.time,badge=stock.status==='sealed'?ladderHoverBoardBadge(stock):ladderHoverOutcomeBadge(stock);
          return `<tr style="--ladder-theme-color:${color}">${index===0?`<td class="vl-date-hover-theme" rowspan="${members.length}"><span class="vl-date-hover-ratio" title="${esc('该档封板 '+group.wins+' / 封板与未晋级 '+members.length)}">${group.wins}/${members.length}</span><span class="vl-date-hover-theme-name" data-vl-nested-theme="${esc(group.theme)}" data-vl-nested-date="${date}" tabindex="0" title="${esc(group.theme)}">${esc(group.theme)}</span></td>`:''}<td><button type="button" class="vl-hover-stock" data-vl-date-hover-stock="${esc(stock.id)}" title="${esc(stock.name+' '+stock.code)}">${badge}<span data-vl-stock-preview="${esc(stock.id)}"${isLadderGrowthStock(stock.code)?' class="vl-hover-growth-name"':''}>${esc(stock.name)}</span></button></td><td class="vl-hover-mono ${hasPct?(pct>0?'pct-up':pct<0?'pct-down':''):''}">${hasPct?(pct>0?'+':'')+pct.toFixed(2)+'%':'—'}</td>${ladderFreeTurnoverCell(stock,details)}<td class="vl-hover-mono">${esc(time||'—')}</td><td class="vl-hover-reason"><span class="vl-hover-reason-text" title="${esc(rawReason)}">${esc(rawReason||'—')}</span></td></tr>`;
        }).join('');
      }).join(''):'<tr class="vl-hover-empty"><td colspan="6">—</td></tr>');
    }).join('')}</tbody></table></div>${loading?'<footer aria-live="polite">正在读取当日指数、涨幅、原因与破板数据…</footer>':error?'<footer aria-live="polite">暂未取得补充数据</footer>':''}`;
  }
  function renderLadderLegendRange(theme,days,stocks){
    const tiers=[{level:5,label:'高板'},{level:4,label:'四板'},{level:3,label:'三板'},{level:2,label:'二板'},{level:1,label:'首板'},{level:0,label:'破板'}],cells=new Map();
    for(const stock of stocks){const key=stock.date+':'+stock.hoverTier;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(stock);}
    return `<header class="vl-hover-head"><div>${ladderHoverThemeTitle(theme,days.at(-1),true)}<span>${esc(fmtDate(days[0]))}—${esc(fmtDate(days.at(-1)))} · ${days.length}日</span></div></header><div class="vl-hover-scroll"><table><colgroup><col style="width:30px"/>${days.map(()=>'<col/>').join('')}</colgroup><thead><tr><th>板数</th>${days.map(day=>`<th>${day.slice(4,6)}/${day.slice(6)}</th>`).join('')}</tr></thead><tbody>${tiers.map(tier=>`<tr><th scope="row">${tier.label}</th>${days.map(day=>{const members=(cells.get(day+':'+tier.level)||[]).sort((a,b)=>(a.status==='sealed'?0:1)-(b.status==='sealed'?0:1)||Number(b.board||b.previousBoard||0)-Number(a.board||a.previousBoard||0)||(a.time||'99:99:99').localeCompare(b.time||'99:99:99')||a.name.localeCompare(b.name,'zh-CN'));return `<td>${members.length?members.map(stock=>`<button type="button" class="vl-hover-stock" data-vl-range-hover-stock="${esc(stock.id)}" title="${esc(stock.name+' · '+fmtDate(stock.date)+' · '+(stock.status==='sealed'?stock.boardPeriod:stock.status==='unpromoted'?'未晋级':'破板'))}">${stock.status==='sealed'?ladderHoverBoardBadge(stock):ladderHoverOutcomeBadge(stock)}<span data-vl-stock-preview="${esc(stock.id)}"${isLadderGrowthStock(stock.code)?' class="vl-hover-growth-name"':''}>${esc(stock.name)}</span></button>`).join(''):'<span class="vl-range-empty">—</span>'}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  let ladderStockHover=null,ladderStockHoverContext=null;
  const ladderStockHoverRequests=new Map();
  const ladderStockPreviewSelector='#ladderLegend .vl-legend-stock-name[data-vl-stock-preview],#ladderChart [data-vl-stock-link],#ladderChart [data-vl-unpromoted-link],#ladderChart [data-vl-broken-link],#ladderTopicHover [data-vl-stock-preview],#ladderNestedThemeHover [data-vl-stock-preview]';
  function flushPendingLiveLadder(){
    const view=ladderView;if(!view?.live||!view.pendingPaint)return;
    requestAnimationFrame(()=>{if(ladderView===view&&view.pendingPaint&&!view.dragging&&history.state?.view==='ladder'&&(!ladderStockHover||ladderStockHover.card.hidden)&&(!ladderTopicHover||ladderTopicHover.card.hidden)&&(!indexHover||indexHover.card.hidden))rebuildVerticalLadder(view);});
  }
  function scheduleLiveHoverRefresh(hover,refresh){
    clearTimeout(hover.liveTimer);hover.liveRefresh=hover.card.dataset.date===shanghaiDateKey()?refresh:null;
  }

  function hoverChartSeries(payload,date){
    const daily=(payload.daily||[]).filter(bar=>chartDayKey(bar)<=date),minute=(payload.oneMin||[]).filter(bar=>chartDayKey(bar)<=date),days=[...new Set(minute.map(chartDayKey))].sort().slice(-5);
    return {daily,days,specs:[['oneMin','5日分时',minute.filter(bar=>days.includes(chartDayKey(bar)))],['daily','日K',daily],['fifteenMin','15分钟K线',(payload.fifteenMin||[]).filter(bar=>chartDayKey(bar)<=date)]]};
  }
  function updateHoverCharts(hover,payload,date){
    const series=hoverChartSeries(payload,date);
    for(const [key,title,bars] of series.specs){
      const entry=hover.entries?.get(key);if(!entry)continue;
      // Keep the existing canvas and window open while replacing its data.
      const plotted=key==='oneMin'?completeLiveSessionAxis(bars,date):bars;
      entry.chart.setDataLoader({getBars:({callback})=>callback(plotted,false)});
      const mount=document.getElementById(entry.id);if(mount)configureChartFacts(entry.chart,mount,key,plotted,series.daily,date,{detached:true});if(mount){mount.dataset.previewBars=String(bars.length);mount.dataset.previewLastDay=bars.length?chartDayKey(bars.at(-1)):'';mount.dataset.previewLastTime=String(bars.at(-1)?.timestamp||'');if(key==='oneMin'){mount.dataset.lastQuoteTime=String(bars.at(-1)?.timestamp||'');mount.dataset.sessionEnd=String(plotted.at(-1)?.timestamp||'');}}
      const last=bars.filter(bar=>chartDayKey(bar)===date).at(-1);if(last)entry.chart.overrideOverlay({id:'selected-limitup-close-'+key,points:[{timestamp:last.timestamp,value:last.close}]});
      const heading=mount?.previousElementSibling;if(heading){if(key==='daily'&&hover.stock)heading.innerHTML=title+ladderStockDailyQuote(hover.stock,payload,bars);else heading.innerHTML=title+'<span>'+(key==='oneMin'?series.days.length+'日':bars.length+'根')+'</span>';}
    }
    delete hover.card.dataset.refreshError;hover.card.title='';hover.card.dataset.updatedAt=payload.updatedAt||new Date().toISOString();hover.card.dataset.refreshCount=String(Number(hover.card.dataset.refreshCount||0)+1);
    return series;
  }
  function closeLadderStockHover(){
    const hover=ladderStockHover;if(!hover)return;clearTimeout(hover.showTimer);clearTimeout(hover.hideTimer);clearTimeout(hover.liveTimer);hover.liveRefresh=null;hover.liveRefreshPending=false;hover.entries=null;hover.stock=null;hover.requestId++;hover.anchor=null;hover.card.hidden=true;hover.resizeObserver?.disconnect();hover.resizeObserver=null;
    for(const id of hover.chartIds){try{window.klinecharts.dispose(id);}catch{}}hover.chartIds=[];hover.charts=[];hover.card.replaceChildren();flushPendingLiveLadder();
  }
  function positionLadderStockHover(anchor,card){
    const zoom=parseFloat(getComputedStyle(document.documentElement).zoom)||1,margin=10;
    card.style.width=Math.min(960,(window.innerWidth-margin*2)/zoom)+'px';card.style.maxHeight=Math.min(680,(window.innerHeight-margin*2)/zoom)+'px';
    const box=anchor.getBoundingClientRect(),size=card.getBoundingClientRect(),fitsRight=box.right+margin+size.width<=window.innerWidth-margin,fitsLeft=box.left-margin-size.width>=margin;
    let x=fitsRight?box.right+margin:box.left-size.width-margin,y;
    if(!fitsRight&&!fitsLeft){
      // Keep the hovered name clickable when a wide preview cannot fit beside it.
      x=Math.max(margin,Math.min(box.left,window.innerWidth-size.width-margin));
      const below=window.innerHeight-box.bottom-margin*2,above=box.top-margin*2,placeBelow=below>=above,available=Math.max(0,placeBelow?below:above);
      card.style.maxHeight=Math.min(680,available/zoom)+'px';
      const height=card.getBoundingClientRect().height;y=placeBelow?box.bottom+margin:box.top-margin-height;
    }else y=Math.max(margin,Math.min(box.top-margin,window.innerHeight-size.height-margin));
    card.style.left=x/zoom+'px';card.style.top=Math.max(margin,y)/zoom+'px';
  }
  async function getLadderStockChartData(stock){
    const code=canonicalStockCode(stock.code),date=stock.date,key=code+':'+date;
    if(ladderStockHoverRequests.has(key))return ladderStockHoverRequests.get(key);
    const task=(async()=>{if(date===shanghaiDateKey())return api('/api/live-stock-chart?code='+encodeURIComponent(code)+'&date='+date,{cache:'no-store'});let payload=await readStockCache(code,date);if(!payload||payload.code!==code||payload.chartSeriesVersion!==6||payload.seriesReferenceDate!==shanghaiDateKey()||!Array.isArray(payload.suspendedDays))payload=await api('/api/stock?code='+encodeURIComponent(code)+'&date='+date);saveStockCache(code,date,payload);return payload;})();
    ladderStockHoverRequests.set(key,task);try{return await task;}finally{if(ladderStockHoverRequests.get(key)===task)ladderStockHoverRequests.delete(key);}
  }
  const ladderStockFactsCache=new Map(),ladderStockFactsRequests=new Map();
  async function getLadderStockFacts(stock,version){
    const key=stock.date+':'+stock.code+':'+version,cached=ladderStockFactsCache.get(key);if(cached&&Date.now()-cached.at<300000)return cached.payload;
    if(ladderStockFactsRequests.has(key))return ladderStockFactsRequests.get(key);
    const task=api('/api/stock-facts?code='+encodeURIComponent(canonicalStockCode(stock.code))+'&date='+stock.date).then(payload=>{if(payload.ladderDataVersion!==version)throw new Error('行情数据已更新，请刷新天梯后查看详情');ladderStockFactsCache.delete(key);ladderStockFactsCache.set(key,{payload,at:Date.now()});while(ladderStockFactsCache.size>100)ladderStockFactsCache.delete(ladderStockFactsCache.keys().next().value);return payload;});
    ladderStockFactsRequests.set(key,task);try{return await task;}finally{if(ladderStockFactsRequests.get(key)===task)ladderStockFactsRequests.delete(key);}
  }
  function ladderStockPreviewBoardLabel(stock){
    const previous=stock.status==='unpromoted',raw=previous?stock.previousBoardPeriod:stock.boardPeriod,count=Number(previous?stock.previousBoard:stock.board);
    let period=typeof raw==='string'&&!/undefined|null|NaN/.test(raw)?raw.trim():'';
    if(period==='首板')period='1板';period=period.replace(/连板$/, '板');
    if(!period)period=Number.isFinite(count)&&count>0?count+'板':'—板';
    return previous?'未晋级 · 昨'+period:stock.status==='broken'?'破板':period;
  }
  function ladderStockPreviewTraits(stock){
    if(stock.status!=='sealed')return '';
    const tags=[];if(stock.board_shape==='one_word')tags.push(['一字','one-word']);else if(stock.board_shape==='t_shape')tags.push(['T字','t-shape']);
    if(stock.board_shape!=='one_word'&&stock.board_strength==='strong')tags.push(['强板','strong']);else if(stock.board_shape!=='one_word'&&stock.board_strength==='weak')tags.push(['弱板','weak']);
    return tags.map(([label,kind])=>`<span class="vl-stock-preview-trait ${kind}">${label}</span>`).join('');
  }
  function ladderStockPreviewInfo(stock,payload){
    const data=payload?.previewFacts,price=value=>value==null||!Number.isFinite(Number(value))?'—':Number(value).toFixed(2),percent=(value,signed=false)=>value==null||!Number.isFinite(Number(value))?'—':(signed&&Number(value)>0?'+':'')+Number(value).toFixed(2)+'%',tone=value=>value==null?'':Number(value)>0?'pct-up':Number(value)<0?'pct-down':'',label=ladderStockPreviewBoardLabel(stock);
    const facts=[['收盘价格',price(data?.close),tone(data?.pct)],['涨幅',percent(data?.pct,true),tone(data?.pct)],['振幅',percent(data?.amplitude)],['开盘涨幅',percent(data?.openPct,true),tone(data?.openPct)],['涨停时间',data?.limitTime||stock.time||'—'],['成交额',compactYuan(data?.amount)],['流通市值'+(data?.estimates?.floatMarketCap?'（估）':''),compactMarketCap(data?.floatMarketCap),'',data?.estimates?.floatMarketCap?'按 '+fmtDate(data.estimates.floatMarketCap.basisDate)+' 流通股本 × 今日价格估算':''],['自由换手率'+(data?.estimates?.freeFloatTurnover?'（估）':''),percent(data?.freeFloatTurnover),'',data?.estimates?.freeFloatTurnover?'按今日累计成交股数 ÷ '+fmtDate(data.estimates.freeFloatTurnover.basisDate)+' 自由流通股数估算':'']];
    if(data?.isSealed)facts.push(['实时封板资金',compactYuan(data.sealAmount),'pct-up',(data.sealUpdatedAt?'行情时间 '+new Date(data.sealUpdatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · ':'')+(data.sealSource==='kpl_zt'?'开盘啦涨停池':'开盘啦 performance')]);
    if(data?.breakTime)facts.push(['破板时间',data.breakTime]);
    if(data?.breakCount!=null)facts.push(['破板次数',String(data.breakCount)]);
    return `<header class="vl-stock-preview-head">${marketCapBadge(data?.totalMarketCap)}<strong${isLadderGrowthStock(stock.code)?' class="vl-hover-growth-name"':''}>${esc(stock.name)}</strong><span>${esc(stock.code)}</span><span>${esc(stock.theme)}</span><span>${esc(label)}</span>${ladderStockPreviewTraits(stock)}<time>${esc(fmtDate(stock.date))}</time></header><div class="vl-stock-preview-facts">${facts.map(([name,value,tone,title])=>`<div${title?` title="${esc(title)}"`:''}><span>${name}</span><b${tone?` class="${tone}"`:''}>${esc(value)}</b></div>`).join('')}</div>`;
  }
  function ladderStockDailyQuote(stock,payload,bars){
    const bar=bars.find(bar=>chartDayKey(bar)===stock.date)||bars.at(-1),day=bar?chartDayKey(bar):stock.date,data=day===stock.date?payload.previewFacts:null,price=value=>value==null||!Number.isFinite(Number(value))?'—':Number(value).toFixed(2),percent=value=>value==null||!Number.isFinite(Number(value))?'—':(Number(value)>0?'+':'')+Number(value).toFixed(2)+'%',volume=value=>value==null||!Number.isFinite(Number(value))?'—':Number(value)>=1e4?(Number(value)/1e4).toFixed(1)+'万':Math.round(Number(value)).toString();
    const pct=data?.pct??bar?.pct_chg,turnover=data?.freeFloatTurnover,amount=bar?.amount==null?data?.amount:Number(bar.amount)*1000,items=[['日期',day.slice(4,6)+'/'+day.slice(6),fmtDate(day)],['收',price(bar?.close),'收盘（前复权）'],['开',price(bar?.open),'开盘（前复权）'],['高',price(bar?.high),'最高（前复权）'],['低',price(bar?.low),'最低（前复权）'],['额',compactYuan(amount),'成交额'],['换',turnover==null?'—':Number(turnover).toFixed(2)+'%','自由换手率'],['幅',percent(pct),'涨跌幅']];
    return `<span class="vl-daily-quote" aria-label="日K行情">${items.map(([label,value,title])=>`<span class="vl-daily-stat" title="${esc(title+'：'+value)}">${label==='日期'?'':`<i>${label}</i>`}<b${label==='幅'&&pct!=null?` class="${Number(pct)>0?'pct-up':Number(pct)<0?'pct-down':''}"`:''}>${esc(value)}</b></span>`).join('')}</span>`;
  }
  function ladderStockHoverRecord(context,anchor){
    const id=anchor.dataset.vlStockLink||anchor.dataset.vlUnpromotedLink||anchor.dataset.vlBrokenLink||anchor.dataset.vlStockPreview;
    // The selected-day legend may contain a date outside the loaded chart window.
    const stock=(anchor.closest('#ladderLegend')?context.view.legendStockRecords?.get(id):null)||context.stocks.get(id);if(stock)return stock;
    const [date,code]=String(id||'').split(':'),prior=[...context.stocks.values()].filter(stock=>stock.code===code&&stock.date<=date).sort((a,b)=>b.date.localeCompare(a.date))[0];
    if(!prior)return null;const failed=/:(?:unpromoted|failed)$/.test(id);
    return {...prior,id,date,name:anchor.textContent.trim(),status:failed?'unpromoted':prior.status,...(failed?{previousBoard:prior.board,previousBoardPeriod:prior.boardPeriod}:{})};
  }
  async function showLadderStockHover(anchor){
    const context=ladderStockHoverContext;if(!context||ladderView!==context.view||context.view.dragging||context.view.data!==context.fullData||history.state?.view!=='ladder'||!anchor.isConnected)return;
    const stock=ladderStockHoverRecord(context,anchor);
    if(!stock)return;const fromRoster=Boolean(anchor.closest('#ladderTopicHover,#ladderNestedThemeHover'));
    if(!fromRoster)closeLadderTopicHover();else{if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);if(ladderNestedThemeHover)clearTimeout(ladderNestedThemeHover.hideTimer);}
    const hover=ensureLadderStockHover();closeLadderStockHover();hover.anchor=anchor;const requestId=++hover.requestId;
    hover.card.setAttribute('aria-label',stock.name+' · 基本信息与行情');hover.card.dataset.stock=stock.code;hover.card.dataset.date=stock.date;hover.card.innerHTML=ladderStockPreviewInfo(stock,null)+'<div class="vl-stock-preview-loading" aria-live="polite">正在读取行情…</div>';hover.card.hidden=false;positionLadderStockHover(anchor,hover.card);
    try{
      const [chartData,facts]=await Promise.all([getLadderStockChartData(stock),(stock.date===shanghaiDateKey()?Promise.resolve(null):getLadderStockFacts(stock,context.view.dataVersion)).catch(error=>{console.warn('个股基本信息读取失败',error);return null;})]),payload={...chartData,previewFacts:chartData.isLive?chartData.previewFacts:facts};if(requestId!==hover.requestId||hover.anchor!==anchor||ladderView!==context.view||!anchor.isConnected||history.state?.view!=='ladder')return;
      // Keep the historical cutoff even when full-page charts are in latest-date mode.
      const daily=(payload.daily||[]).filter(bar=>chartDayKey(bar)<=stock.date),minute=(payload.oneMin||[]).filter(bar=>chartDayKey(bar)<=stock.date),days=[...new Set(minute.map(chartDayKey))].sort().slice(-5),oneMin=minute.filter(bar=>days.includes(chartDayKey(bar))),fifteen=(payload.fifteenMin||[]).filter(bar=>chartDayKey(bar)<=stock.date),specs=[['oneMin','5日分时',oneMin],['daily','日K',daily],['fifteenMin','15分钟K线',fifteen]],prefix='ladder-stock-preview-'+requestId+'-';
      hover.stock=stock;hover.card.innerHTML='<div class="vl-stock-preview-info">'+ladderStockPreviewInfo(stock,payload)+'</div>'+`<div class="vl-stock-preview-charts">${specs.map(([key,title,bars])=>`<section class="vl-stock-preview-chart ${key==='oneMin'?'vl-stock-preview-wide':''}"><h4${key==='daily'?' class="vl-stock-preview-daily-heading"':''}>${title}${key==='daily'?ladderStockDailyQuote(stock,payload,bars):`<span>${key==='oneMin'?days.length+'日':bars.length+'根'}</span>`}</h4><div id="${prefix+key}" class="vl-stock-preview-mount" data-preview-period="${key}" data-preview-bars="${bars.length}" data-preview-last-day="${bars.length?chartDayKey(bars.at(-1)):''}"></div></section>`).join('')}</div>`;
      positionLadderStockHover(anchor,hover.card);
      hover.entries=new Map();
      for(const [key,,bars] of specs){const id=prefix+key;hover.chartIds.push(id);const chart=drawChart(id,bars,key,stock.code,stock.date,daily,payload.suspendedDays||[],{compact:true,detached:true,line:key==='oneMin',minBarSpace:.1,endAtLatest:true,liveSession:payload.isLive&&key==='oneMin'});if(chart){hover.charts.push(chart);hover.entries.set(key,{id,chart});}}
      hover.card.dataset.updatedAt=payload.updatedAt||'';hover.card.dataset.refreshCount='0';
      if(payload.isLive)scheduleLiveHoverRefresh(hover,async()=>{
        const next=await getLadderStockChartData(stock);
        if(requestId!==hover.requestId||hover.anchor!==anchor||!anchor.isConnected||ladderView!==context.view||history.state?.view!=='ladder')return;
        if(!next.isLive)return;
        hover.card.querySelector('.vl-stock-preview-info').innerHTML=ladderStockPreviewInfo(stock,next);updateHoverCharts(hover,next,stock.date);
      });
      hover.resizeObserver=new ResizeObserver(()=>{if(!hover.card.hidden)for(const chart of hover.charts)chart.resize();});hover.resizeObserver.observe(hover.card);
    }catch(error){if(requestId!==hover.requestId||hover.anchor!==anchor)return;hover.card.innerHTML=ladderStockPreviewInfo(stock,null)+'<div class="vl-stock-preview-loading">行情读取失败：'+esc(error.message)+'</div>';positionLadderStockHover(anchor,hover.card);}
  }
  function ensureLadderStockHover(){
    if(ladderStockHover)return ladderStockHover;
    const card=document.createElement('section');card.id='ladderStockHover';card.className='vl-stock-preview';card.hidden=true;card.setAttribute('role','dialog');card.tabIndex=-1;document.body.append(card);
    const hover=ladderStockHover={card,requestId:0,showTimer:0,hideTimer:0,anchor:null,chartIds:[],charts:[]};
    const scheduleHide=()=>{clearTimeout(hover.hideTimer);hover.hideTimer=setTimeout(closeLadderStockHover,180);};
    card.addEventListener('pointerenter',()=>{clearTimeout(hover.hideTimer);if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);if(ladderNestedThemeHover)clearTimeout(ladderNestedThemeHover.hideTimer);});
    card.addEventListener('pointerleave',event=>{if(hover.anchor?.contains(event.relatedTarget))return;scheduleHide();if(ladderTopicHover&&!ladderTopicHover.card.contains(event.relatedTarget)&&!ladderNestedThemeHover?.card.contains(event.relatedTarget))ladderTopicHover.hideTimer=setTimeout(closeLadderTopicHover,200);});
    document.addEventListener('pointerover',event=>{const anchor=event.target.closest(ladderStockPreviewSelector);if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.showTimer);clearTimeout(hover.hideTimer);if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);if(ladderNestedThemeHover)clearTimeout(ladderNestedThemeHover.hideTimer);if(hover.anchor===anchor&&!card.hidden)return;hover.showTimer=setTimeout(()=>showLadderStockHover(anchor),320);});
    document.addEventListener('pointerout',event=>{const anchor=event.target.closest(ladderStockPreviewSelector);if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.showTimer);if(card.contains(event.relatedTarget))return;scheduleHide();});
    document.addEventListener('focusin',event=>{const anchor=event.target.closest(ladderStockPreviewSelector);if(anchor)showLadderStockHover(anchor);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!card.hidden){event.preventDefault();closeLadderStockHover();}},true);
    document.addEventListener('scroll',event=>{if(!card.hidden&&!card.contains(event.target)&&!event.target.closest?.('#ladderTopicHover,#ladderNestedThemeHover'))closeLadderStockHover();},true);
    window.addEventListener('resize',closeLadderStockHover);return hover;
  }
  function setupLadderStockHover(fullData,view){
    const stocks=new Map([...(fullData.sealedStocks||[]),...fullData.nodes].map(stock=>[stock.id,{...stock,status:stock.status==='failed'?'unpromoted':stock.status}]));
    for(const stock of fullData.unpromotedStocks||[]){const source=stocks.get(stock.sourceId);stocks.set(stock.id,{...stock,status:'unpromoted',previousBoard:stock.previousBoard??source?.board,previousBoardPeriod:stock.previousBoardPeriod||source?.boardPeriod});}
    for(const stock of fullData.brokenStocks||[])stocks.set(stock.id,{...stock,status:'broken'});
    ladderStockHoverContext={fullData,view,stocks};ensureLadderStockHover();
  }

  async function getIndexHoverPayload(item,date){
    if(date!==shanghaiDateKey()||!liveEnabled)return getIndexHistory(item.code,date);
    const group=Math.floor(INDEX_CATALOG.indexOf(item)/4),[base,one,fifteen]=await Promise.all([getIndexHistory(item.code,date),getLiveIndexSnapshot(group,'oneMin',date),getLiveIndexSnapshot(group,'fifteenMin',date)]);
    const minute=one.indices.find(row=>row.code===item.code),quarter=fifteen.indices.find(row=>row.code===item.code);
    if(!minute||minute.seriesError||!quarter||quarter.seriesError)throw new Error(minute?.seriesError||quarter?.seriesError||'实时指数行情暂不可用');
    const first=liveIndexZoomSeries({period:'oneMin',date,baseData:base},minute),second=liveIndexZoomSeries({period:'fifteenMin',date,baseData:base},quarter);
    return {...base,isLive:true,oneMin:first.bars,fifteenMin:second.bars,daily:first.daily,updatedAt:one.updatedAt||new Date().toISOString()};
  }
  let indexHover=null;
  function closeIndexHover(){
    const hover=indexHover;if(!hover)return;clearTimeout(hover.showTimer);clearTimeout(hover.hideTimer);clearTimeout(hover.liveTimer);hover.liveRefresh=null;hover.liveRefreshPending=false;hover.entries=null;hover.requestId++;hover.anchor=null;hover.card.hidden=true;hover.resizeObserver?.disconnect();hover.resizeObserver=null;
    for(const id of hover.chartIds){try{window.klinecharts.dispose(id);}catch{}}hover.chartIds=[];hover.charts=[];hover.card.replaceChildren();flushPendingLiveLadder();
  }
  function indexPreviewInfo(item,date,daily=[]){
    const bar=daily.find(bar=>chartDayKey(bar)===date),previous=daily.filter(bar=>chartDayKey(bar)<date).at(-1),prior=Number(previous?.close),close=Number(bar?.close),pct=bar?.pct_chg??(bar&&prior>0?(close/prior-1)*100:null),percent=value=>value==null||!Number.isFinite(Number(value))?'—':(Number(value)>0?'+':'')+Number(value).toFixed(2)+'%',price=value=>value==null?'—':num(value),tone=pct==null?'':Number(pct)>=0?'pct-up':'pct-down';
    const facts=[['收盘点位',price(bar?.close),tone],['涨幅',percent(pct),tone],['振幅',bar&&prior>0?((Number(bar.high)-Number(bar.low))/prior*100).toFixed(2)+'%':'—'],['开盘涨幅',bar&&prior>0?percent((Number(bar.open)/prior-1)*100):'—'],['开盘',price(bar?.open)],['最高',price(bar?.high)],['最低',price(bar?.low)],['成交额',bar?.amount==null?'—':compactYuan(Number(bar.amount)*1000)]];
    return `<header class="vl-stock-preview-head"><span class="vl-index-preview-badge">指</span><button type="button" class="index-name-link" data-preview-open-index="${item.code}" data-index-date="${date}">${esc(item.name)}</button><span>${esc(item.code)}</span><time>${esc(fmtDate(date))}</time></header><div class="vl-stock-preview-facts">${facts.map(([label,value,tone])=>`<div><span>${label}</span><b${tone?` class="${tone}"`:''}>${esc(value)}</b></div>`).join('')}</div>`;
  }
  async function showIndexHover(anchor){
    const item=INDEX_CATALOG.find(item=>item.code===anchor.dataset.indexPreview),date=anchor.dataset.indexDate;
    if(!item||(!state.dates.includes(date)&&date!==shanghaiDateKey())||!anchor.isConnected)return;
    const hover=indexHover,route=location.href;closeIndexHover();closeLadderStockHover();if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);
    hover.anchor=anchor;const requestId=++hover.requestId,current=()=>requestId===hover.requestId&&hover.anchor===anchor&&anchor.isConnected&&location.href===route;
    hover.card.dataset.index=item.code;hover.card.dataset.date=date;hover.card.setAttribute('aria-label',item.name+' · 基本信息与行情');hover.card.innerHTML=indexPreviewInfo(item,date)+'<div class="vl-stock-preview-loading" aria-live="polite">正在读取指数行情…</div>';hover.card.hidden=false;positionLadderStockHover(anchor,hover.card);
    try{
      const payload=await getIndexHoverPayload(item,date);if(!current()){if(requestId===hover.requestId)closeIndexHover();return;}
      const daily=(payload.daily||[]).filter(bar=>chartDayKey(bar)<=date),minute=(payload.oneMin||[]).filter(bar=>chartDayKey(bar)<=date),days=[...new Set(minute.map(chartDayKey))].sort().slice(-5),oneMin=minute.filter(bar=>days.includes(chartDayKey(bar))),fifteen=(payload.fifteenMin||[]).filter(bar=>chartDayKey(bar)<=date),specs=[['oneMin','5日分时',oneMin],['daily','日K',daily],['fifteenMin','15分钟K线',fifteen]],prefix='index-preview-'+requestId+'-';
      hover.card.innerHTML='<div class="vl-stock-preview-info">'+indexPreviewInfo(item,date,daily)+'</div>'+`<div class="vl-stock-preview-charts">${specs.map(([key,title,bars])=>`<section class="vl-stock-preview-chart ${key==='oneMin'?'vl-stock-preview-wide':''}"><h4>${title}<span>${key==='oneMin'?days.length+'日':bars.length+'根'} · 截至 ${date.slice(4,6)}/${date.slice(6)}</span></h4><div id="${prefix+key}" class="vl-stock-preview-mount" data-preview-period="${key}" data-preview-bars="${bars.length}" data-preview-last-day="${bars.length?chartDayKey(bars.at(-1)):''}"></div></section>`).join('')}</div>`;
      positionLadderStockHover(anchor,hover.card);
      hover.entries=new Map();
      for(const [key,,bars] of specs){const id=prefix+key;hover.chartIds.push(id);const chart=drawChart(id,bars,key,item.code,date,daily,[],{compact:true,detached:true,line:key==='oneMin',minBarSpace:.1,endAtLatest:true,isIndex:true,liveSession:payload.isLive&&key==='oneMin'});if(chart){hover.charts.push(chart);hover.entries.set(key,{id,chart});}}
      hover.card.dataset.updatedAt=payload.updatedAt||'';hover.card.dataset.refreshCount='0';
      if(payload.isLive)scheduleLiveHoverRefresh(hover,async()=>{
        const next=await getIndexHoverPayload(item,date);if(!current()||!next.isLive)return;
        const series=updateHoverCharts(hover,next,date);hover.card.querySelector('.vl-stock-preview-info').innerHTML=indexPreviewInfo(item,date,series.daily);
      });
      hover.resizeObserver=new ResizeObserver(()=>{if(!hover.card.hidden)for(const chart of hover.charts)chart.resize();});hover.resizeObserver.observe(hover.card);
    }catch(error){if(!current())return;hover.card.innerHTML=indexPreviewInfo(item,date)+'<div class="vl-stock-preview-loading">行情读取失败：'+esc(error.message)+'</div>';positionLadderStockHover(anchor,hover.card);}
  }
  function setupIndexHover(){
    const card=document.createElement('section');card.id='indexHover';card.className='vl-stock-preview vl-index-preview';card.hidden=true;card.setAttribute('role','dialog');card.tabIndex=-1;document.body.append(card);
    const hover=indexHover={card,requestId:0,showTimer:0,hideTimer:0,anchor:null,chartIds:[],charts:[]},selector='[data-index-preview][data-index-date]';
    const scheduleHide=()=>{clearTimeout(hover.hideTimer);hover.hideTimer=setTimeout(closeIndexHover,180);};
    card.addEventListener('pointerenter',()=>{clearTimeout(hover.hideTimer);if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);});
    card.addEventListener('pointerleave',event=>{if(hover.anchor?.contains(event.relatedTarget))return;scheduleHide();if(ladderTopicHover&&!ladderTopicHover.card.contains(event.relatedTarget))ladderTopicHover.hideTimer=setTimeout(closeLadderTopicHover,220);});
    document.addEventListener('pointerover',event=>{const anchor=event.target.closest(selector);if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.showTimer);clearTimeout(hover.hideTimer);if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);if(hover.anchor===anchor&&!card.hidden)return;hover.showTimer=setTimeout(()=>showIndexHover(anchor),320);});
    document.addEventListener('pointerout',event=>{const anchor=event.target.closest(selector);if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.showTimer);if(card.contains(event.relatedTarget))return;scheduleHide();});
    document.addEventListener('focusin',event=>{const anchor=event.target.closest(selector);if(anchor)requestAnimationFrame(()=>{if(document.activeElement===anchor&&anchor.isConnected)showIndexHover(anchor);});});
    document.addEventListener('focusout',event=>{if(event.target.closest(selector)&&!card.contains(event.relatedTarget))scheduleHide();});
    document.addEventListener('click',event=>{const anchor=event.target.closest(selector+',[data-preview-open-index]');if(!anchor)return;event.preventDefault();event.stopPropagation();openIndex(anchor.dataset.indexPreview||anchor.dataset.previewOpenIndex,anchor.dataset.indexDate);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!card.hidden){event.preventDefault();event.stopPropagation();closeIndexHover();}},true);
    document.addEventListener('scroll',event=>{if(!card.hidden&&!card.contains(event.target)&&!event.target.closest?.('#ladderTopicHover'))closeIndexHover();},true);
    window.addEventListener('resize',closeIndexHover);
  }

  let ladderNestedThemeHover=null;
  function closeLadderNestedThemeHover(){
    const hover=ladderNestedThemeHover;if(!hover)return;
    if(hover.card.contains(ladderStockHover?.anchor))closeLadderStockHover();
    clearTimeout(hover.showTimer);clearTimeout(hover.hideTimer);hover.requestId++;hover.anchor=null;hover.card.hidden=true;hover.card.onclick=null;
  }
  function ensureLadderNestedThemeHover(){
    if(ladderNestedThemeHover)return ladderNestedThemeHover;
    const card=document.createElement('section');card.id='ladderNestedThemeHover';card.className='vl-topic-hover vl-nested-theme-hover';card.hidden=true;card.setAttribute('role','dialog');card.setAttribute('aria-label','题材当日涨停列表');card.tabIndex=-1;document.body.append(card);
    const hover=ladderNestedThemeHover={card,requestId:0,showTimer:0,hideTimer:0,anchor:null};
    card.addEventListener('pointerenter',()=>{clearTimeout(hover.hideTimer);if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);});
    card.addEventListener('pointerleave',event=>{if(ladderStockHover?.card.contains(event.relatedTarget))return;hover.hideTimer=setTimeout(closeLadderNestedThemeHover,180);if(ladderTopicHover&&!ladderTopicHover.card.contains(event.relatedTarget))ladderTopicHover.hideTimer=setTimeout(closeLadderTopicHover,220);});
    card.addEventListener('focusin',()=>{clearTimeout(hover.hideTimer);if(ladderTopicHover)clearTimeout(ladderTopicHover.hideTimer);});
    return hover;
  }
  function setupLadderNestedThemeHover(fullData,view,navigateStock,navigateUnpromoted,navigateBroken){
    const parent=ensureLadderTopicHover(),hover=ensureLadderNestedThemeHover(),selector='[data-vl-nested-theme][data-vl-nested-date]';
    async function show(anchor){
      if(ladderView!==view||view.data!==fullData||view.dragging||history.state?.view!=='ladder'||parent.card.hidden||!anchor.isConnected)return;
      closeLadderNestedThemeHover();clearTimeout(parent.hideTimer);hover.anchor=anchor;const requestId=++hover.requestId,theme=anchor.dataset.vlNestedTheme,date=anchor.dataset.vlNestedDate,key=date+':'+view.dataVersion,record=ladderDateDetailCache.get(key),cached=record&&Date.now()-record.savedAt<record.ttl?record.payload:null;
      let stocks=[];const sort={key:''};hover.card.style.setProperty('--ladder-theme-color',ladderThemeColor(theme));
      const render=(details,loading=false,error=false)=>{Object.assign(sort,{details,loading,error});stocks=ladderDateHoverStocks(fullData,date,details||{brokenStocks:(fullData.brokenStocks||[]).filter(stock=>stock.date===date)}).filter(stock=>stock.theme===theme);hover.card.innerHTML=renderLadderTopicHover(theme,date,stocks,details,loading,error,false,sort.key);positionLadderTopicHover(anchor,hover.card);};
      render(cached,!cached);hover.card.hidden=false;positionLadderTopicHover(anchor,hover.card);
      hover.card.onclick=event=>{if(sortLadderTopicHover(event,hover,sort,render))return;const row=event.target.closest('[data-vl-hover-stock]');if(!row)return;event.preventDefault();const stock=stocks.find(item=>item.id===row.dataset.vlHoverStock);closeLadderTopicHover();if(stock?.status==='unpromoted')navigateUnpromoted(stock.id,stock);else if(stock?.status==='broken')navigateBroken(stock);else if(stock)navigateStock(stock.id,stock);};
      if(cached)return;
      try{const details=await getLadderDateDetails(date,view.dataVersion);if(requestId!==hover.requestId||hover.anchor!==anchor||ladderView!==view||view.data!==fullData||!anchor.isConnected||parent.card.hidden)return;render(details);}
      catch(error){if(requestId===hover.requestId&&hover.anchor===anchor&&anchor.isConnected)render(null,false,true);}
    }
    parent.card.onpointerover=event=>{const anchor=event.target.closest(selector);if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(parent.hideTimer);clearTimeout(hover.hideTimer);clearTimeout(hover.showTimer);if(hover.anchor===anchor&&!hover.card.hidden)return;closeLadderNestedThemeHover();hover.showTimer=setTimeout(()=>show(anchor),220);};
    parent.card.onpointerout=event=>{const anchor=event.target.closest(selector);if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.showTimer);if(hover.card.contains(event.relatedTarget)||ladderStockHover?.card.contains(event.relatedTarget))return;hover.hideTimer=setTimeout(closeLadderNestedThemeHover,180);};
    parent.card.onfocusin=event=>{const anchor=event.target.closest(selector);if(anchor)show(anchor);};
    parent.card.onfocusout=event=>{if(!hover.card.contains(event.relatedTarget)&&!ladderStockHover?.card.contains(event.relatedTarget))hover.hideTimer=setTimeout(closeLadderNestedThemeHover,180);};
  }

  function setupLadderTopicHover(host,fullData,view,navigateStock,navigateUnpromoted,navigateBroken,navigateTheme){
    const hover=ensureLadderTopicHover();setupLadderNestedThemeHover(fullData,view,navigateStock,navigateUnpromoted,navigateBroken);
    const navigateTitle=event=>{const title=event.target.closest('[data-vl-hover-theme]');if(!title)return false;event.preventDefault();event.stopPropagation();const theme=title.dataset.vlHoverTheme,date=title.dataset.vlHoverThemeDate;closeLadderTopicHover();navigateTheme(theme,date);return true;};
    async function show(anchor){
      if(ladderView!==view||view.data!==fullData||view.dragging||history.state?.view!=='ladder'||!anchor.isConnected)return;
      const isDate=anchor.hasAttribute('data-vl-date'),theme=anchor.dataset.vlTopic,date=isDate?anchor.dataset.vlDate:anchor.dataset.vlTopicDate;
      if(!date||!isDate&&!theme)return;clearTimeout(hover.hideTimer);hover.anchor=anchor;const requestId=++hover.requestId;
      if(anchor.hasAttribute('data-vl-topic-dates')){
        const days=JSON.parse(anchor.dataset.vlTopicDates||'[]').filter(day=>day<=view.endDay).sort();if(!days.length)return;
        const stocks=days.flatMap(day=>ladderDateHoverStocks(fullData,day,{brokenStocks:(fullData.brokenStocks||[]).filter(stock=>stock.date===day)})).filter(stock=>stock.theme===theme);
        hover.card.dataset.hoverMode='range';hover.card.dataset.rangeDays=String(days.length);hover.card.classList.remove('vl-date-hover');hover.card.classList.add('vl-range-hover');hover.card.setAttribute('aria-label','题材区间天梯表');hover.card.style.setProperty('--ladder-theme-color',ladderThemeColor(theme));hover.card.innerHTML=renderLadderLegendRange(theme,days,stocks);hover.card.hidden=false;positionLadderTopicHover(anchor,hover.card);
        hover.card.onclick=event=>{if(navigateTitle(event))return;const row=event.target.closest('[data-vl-range-hover-stock]');if(!row)return;event.preventDefault();const stock=stocks.find(stock=>stock.id===row.dataset.vlRangeHoverStock);closeLadderTopicHover();if(stock?.status==='unpromoted')navigateUnpromoted(stock.id,stock);else if(stock?.status==='broken')navigateBroken(stock);else if(stock)navigateStock(stock.id,stock);};return;
      }
      hover.card.classList.remove('vl-range-hover');
      const key=date+':'+view.dataVersion,cache=ladderDateDetailCache,record=cache.get(key),cached=record&&Date.now()-record.savedAt<record.ttl?record.payload:null;
      const hoverData=anchor.hasAttribute('data-vl-specified-legend')&&view.specifiedLegendPayload?.date===date?{...fullData,...view.specifiedLegendPayload}:fullData;
      const roster=details=>ladderDateHoverStocks(hoverData,date,details||{brokenStocks:hoverData.brokenStocks||[]}).filter(stock=>isDate||stock.theme===theme);
      let stocks=roster(cached);const sort={key:''};
      hover.card.dataset.hoverMode=isDate?'date':'topic';hover.card.classList.toggle('vl-date-hover',isDate);hover.card.setAttribute('aria-label',isDate?'当日天梯列表':'题材当日涨停列表');
      hover.card.style.setProperty('--ladder-theme-color',isDate?'var(--green)':ladderThemeColor(theme));
      const render=(details,loading=false,error=false)=>{Object.assign(sort,{details,loading,error});closeLadderNestedThemeHover();stocks=roster(details);hover.card.innerHTML=isDate?renderLadderDateHover(date,stocks,details,loading,error):renderLadderTopicHover(theme,date,stocks,details,loading,error,Boolean(anchor.closest('#ladderLegend')),sort.key);positionLadderTopicHover(anchor,hover.card);};
      render(cached,!cached);hover.card.hidden=false;positionLadderTopicHover(anchor,hover.card);
      hover.card.onclick=event=>{if(!isDate&&sortLadderTopicHover(event,hover,sort,render))return;if(navigateTitle(event))return;const row=event.target.closest(isDate?'[data-vl-date-hover-stock]':'[data-vl-hover-stock]');if(!row)return;event.preventDefault();const id=isDate?row.dataset.vlDateHoverStock:row.dataset.vlHoverStock,stock=stocks.find(item=>item.id===id);closeLadderTopicHover();if(stock?.status==='unpromoted')navigateUnpromoted(id,stock);else if(stock?.status==='broken')navigateBroken(stock);else navigateStock(id,stock);};
      if(cached)return;
      try{const details=await getLadderDateDetails(date,view.dataVersion);if(requestId!==hover.requestId||hover.anchor!==anchor||ladderView!==view||view.data!==fullData||history.state?.view!=='ladder')return;render(details);}
      catch(error){if(requestId!==hover.requestId||hover.anchor!==anchor)return;render(null,false,true);}
    }
    for(const surface of [host,$('#ladderLegend')].filter(Boolean)){
    surface.onpointerover=event=>{const anchor=event.target.closest('[data-vl-topic][data-vl-topic-date],[data-vl-date]');if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.hideTimer);clearTimeout(hover.showTimer);if(hover.anchor===anchor&&!hover.card.hidden)return;closeLadderTopicHover();hover.showTimer=setTimeout(()=>show(anchor),220);};
    surface.onpointerout=event=>{const anchor=event.target.closest('[data-vl-topic][data-vl-topic-date],[data-vl-date]');if(!anchor||anchor.contains(event.relatedTarget))return;clearTimeout(hover.showTimer);if(hover.card.contains(event.relatedTarget))return;hover.hideTimer=setTimeout(closeLadderTopicHover,140);};
    surface.onfocusin=event=>{const anchor=event.target.closest('[data-vl-topic][data-vl-topic-date],[data-vl-date]');if(anchor){clearTimeout(hover.showTimer);show(anchor);}};
    surface.onfocusout=event=>{if(!hover.card.contains(event.relatedTarget))hover.hideTimer=setTimeout(closeLadderTopicHover,140);};
    }
  }
  function ladderThemeColor(name){
    if(ladderThemeColors.has(name))return ladderThemeColors.get(name);
    let hash=0;for(const char of name)hash=((hash*31)+char.charCodeAt(0))>>>0;
    const color=name==='暂无题材'?'#87918a':`hsl(${hash%360} 47% 43%)`;ladderThemeColors.set(name,color);return color;
  }
  function ladderDistinctThemeColors(nodes,visibleDays){
    const peaks=new Map();for(const node of nodes){if(node.status==='sealed'&&node.board>=4&&visibleDays.has(node.date))peaks.set(node.theme,Math.max(peaks.get(node.theme)||0,node.board));}
    // Existing assignments survive panning, ranking changes and calendar navigation.
    // Only new leaders choose a swatch far from the leaders already on screen.
    const palette=['#306bb0','#d17720','#39864c','#8852ad','#c04655','#218c94','#a38c19','#b85c94','#865c38','#536b78','#378bbe','#758c35'];
    function lab(color){
      let rgb;
      if(color.startsWith('#'))rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
      else{const [hue,saturation,lightness]=color.match(/[\d.]+/g).map(Number),h=hue/360,s=saturation/100,l=lightness/100,a=s*Math.min(l,1-l),channel=n=>{const k=(n+h*12)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1));};rgb=[channel(0),channel(8),channel(4)];}
      const [r,g,b]=rgb.map(v=>v>.04045?((v+.055)/1.055)**2.4:v/12.92),f=v=>v>.008856?Math.cbrt(v):7.787*v+16/116,x=f((r*.4124+g*.3576+b*.1805)/.95047),y=f(r*.2126+g*.7152+b*.0722),z=f((r*.0193+g*.1192+b*.9505)/1.08883);return [116*y-16,500*(x-y),200*(y-z)];
    }
    const used=new Set(ladderThemeColors.values()),chosen=[...peaks.keys()].filter(theme=>ladderThemeColors.has(theme)).map(theme=>lab(ladderThemeColors.get(theme)));
    for(const [theme] of [...peaks].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh-CN'))){
      if(ladderThemeColors.has(theme))continue;
      let candidates=palette.filter(color=>!used.has(color));
      if(!candidates.length)candidates=Array.from({length:24},(_,i)=>`hsl(${((ladderThemeColors.size+i)*137.508)%360} 54% 40%)`).filter(color=>!used.has(color));
      let best=candidates[0],score=-1;for(const color of candidates){const candidate=lab(color),distance=chosen.length?Math.min(...chosen.map(other=>candidate.reduce((sum,v,i)=>sum+(v-other[i])**2,0))):color===palette[0]?Infinity:0;if(distance>score){score=distance;best=color;}}
      ladderThemeColors.set(theme,best);used.add(best);chosen.push(lab(best));
    }
    for(const node of nodes)if(visibleDays.has(node.date))ladderThemeColor(node.theme);
    return new Map(ladderThemeColors);
  }
  async function updateLadderReview(date,view){
    if(state.date===date)return;
    try{const review=await api(`/api/review?date=${date}`);if(ladderView!==view||history.state?.view!=='ladder'||view.endDay!==date)return;state.date=date;state.review=review;renderNav();}catch(error){console.warn('导航复盘数据稍后更新',error);}
  }
  async function openLadderDate(date,reuse=false){
    if(!state.dates.includes(date))return;
    const view=ladderView,nav=(view?.navigationId||0)+1;if(view)view.navigationId=nav;
    syncBrowserRoute('ladder',date,'','','push','','',date);
    if(reuse&&view?.data&&$('#ladderChart')){
      try{
        const revision=await currentLadderVersion();if(ladderView!==view||view.navigationId!==nav||history.state?.view!=='ladder')return;
        if(view.dataVersion!==revision){await renderLimitupLadder();updateLadderReview(date,ladderView);return;}
        if(!view.days.has(date)){const end=state.dates.indexOf(date),sessions=Math.min(LADDER_PRELOAD_SESSIONS,end+1),result=await getLadderPayload(date,sessions);if(ladderView!==view||view.navigationId!==nav||history.state?.view!=='ladder')return;if(result.payload.ladderDataVersion!==view.dataVersion){await renderLimitupLadder();updateLadderReview(date,ladderView);return;}mergeLadderPayload(view,result.payload,result.source);}
        view.end=state.dates.indexOf(date);view.endDay=date;view.visibleDays=null;view.returnSnapshot=null;
        rebuildVerticalLadder(view,'end');updateLadderDateControls(date);
        updateLadderReview(date,view);prefetchLadderEdge($('#ladderChart'),view);return;
      }catch(error){if(ladderView===view&&view.navigationId===nav)toast('天梯数据读取失败：'+error.message);return;}
    }
    await renderLimitupLadder();updateLadderReview(date,ladderView);
  }
  function moveLadderDate(step){const current=ladderView?.endDay||history.state?.ladderEnd||state.dates.at(-1),index=state.dates.indexOf(current),date=state.dates[index+step];if(index>=0&&date)openLadderDate(date,true);}
  function updateLadderDateControls(date){
    const calendar=$('#ladderDatePickerTrigger .date-trigger-label');if(calendar)calendar.textContent=formatCalendarDate(date);
    const index=state.dates.indexOf(date),previous=$('#prevLadderDate'),next=$('#nextLadderDate');if(previous)previous.disabled=index<=0;if(next)next.disabled=index<0||index>=state.dates.length-1;
  }
  function ladderSearchEntries(data,cutoff){
    if(!data)return [];const days=new Set(data.dates||[]),stocks=new Map(),themes=new Map(),priority={sealed:0,unpromoted:1,broken:2};
    const records=[...(data.nodes||[]).filter(stock=>stock.status==='sealed'),...(data.sealedStocks||[]),...(data.unpromotedStocks||[]).map(stock=>({...stock,status:'unpromoted'})),...(data.brokenStocks||[]).map(stock=>({...stock,status:'broken'}))];
    for(const stock of records){
      if(!stock.code||!stock.name||stock.date>cutoff||!days.has(stock.date))continue;
      if(stock.theme)themes.set(stock.theme,stock.date>(themes.get(stock.theme)||'')?stock.date:themes.get(stock.theme));
      const prior=stocks.get(stock.code);if(!prior||stock.date>prior.date||stock.date===prior.date&&(priority[stock.status]??3)<(priority[prior.status]??3))stocks.set(stock.code,stock);
    }
    const normalize=text=>String(text||'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    return [...themes].map(([theme,date])=>({kind:'theme',label:theme,theme,date,key:'theme:'+theme,match:normalize(theme)})).concat([...stocks.values()].map(stock=>({kind:'stock',label:stock.name,theme:stock.theme,date:stock.date,key:'stock:'+stock.code,match:normalize(stock.name+' '+stock.code),stock})));
  }
  function matchLadderSearch(entries,text){
    const query=String(text||'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();if(!query)return [];
    const rank=item=>item.label.normalize('NFKC').replace(/\s+/g,'').toLowerCase()===query||item.stock?.code.split('.')[0]===query?0:item.match.startsWith(query)?1:2;
    return entries.filter(item=>item.match.includes(query)).sort((a,b)=>rank(a)-rank(b)||(a.kind==='theme'?0:1)-(b.kind==='theme'?0:1)||a.label.localeCompare(b.label,'zh-CN')).slice(0,30);
  }
  function setupLadderSearch(view){
    const root=$('#ladderSearch'),toggle=$('#ladderSearchToggle'),panel=$('#ladderSearchPanel'),input=$('#ladderSearchInput'),list=$('#ladderSearchResults'),controller=new AbortController();
    view.searchAbort=controller;let entries=[],indexedData=null,indexedCutoff='',results=[],active=0,composing=false;
    const syncActive=(scroll=false)=>{const buttons=[...list.querySelectorAll('[data-ladder-search-result]')];buttons.forEach((button,index)=>button.setAttribute('aria-selected',String(index===active)));const selected=buttons[active];if(selected){input.setAttribute('aria-activedescendant',selected.id);if(scroll)selected.scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');};
    const render=()=>{
      if(indexedData!==view.data||indexedCutoff!==view.endDay){entries=ladderSearchEntries(view.data,view.endDay);indexedData=view.data;indexedCutoff=view.endDay;}
      results=matchLadderSearch(entries,input.value);active=0;
      list.innerHTML=results.length?results.map((item,index)=>`<button type="button" role="option" id="ladderSearchOption${index}" data-ladder-search-result="${index}" aria-selected="${index===0}" title="${esc(item.label+' · '+(item.kind==='theme'?'题材':item.stock.code+' · '+item.theme))}"><span class="vl-search-kind">${item.kind==='theme'?'题':'股'}</span><span class="vl-search-copy"><strong>${esc(item.label)}</strong><small>${esc(item.kind==='theme'?fmtDate(item.date):item.stock.code.split('.')[0]+' · '+item.theme+' · '+item.date.slice(4,6)+'/'+item.date.slice(6))}</small></span></button>`).join(''):`<div class="vl-search-empty" role="status">${view.data?(input.value.trim()?'当前已加载区间没有匹配结果':'输入股票名或题材名'):'正在读取天梯数据…'}</div>`;
      syncActive();
    };
    const setOpen=(open,focus=false)=>{panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));input.setAttribute('aria-expanded',String(open));if(open){closeLadderTopicHover();render();input.focus();}else{input.removeAttribute('aria-activedescendant');if(focus)toggle.focus();}};
    const select=index=>{const result=results[index];if(!result||ladderView!==view||!view.searchSelect)return;setOpen(false);view.searchSelect(result);};
    toggle.onclick=()=>setOpen(panel.hidden);input.oninput=()=>{if(!composing)render();};input.oncompositionstart=()=>{composing=true;};input.oncompositionend=()=>{composing=false;render();};
    input.onkeydown=event=>{if(composing||event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false,true);}else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();select(active);}else if(['ArrowDown','ArrowUp'].includes(event.key)&&results.length){event.preventDefault();event.stopPropagation();active=(active+(event.key==='ArrowDown'?1:-1)+results.length)%results.length;syncActive(true);}};
    list.onclick=event=>{const button=event.target.closest('[data-ladder-search-result]');if(button)select(Number(button.dataset.ladderSearchResult));};
    document.addEventListener('pointerdown',event=>{if(!panel.hidden&&!root.contains(event.target))setOpen(false);},{signal:controller.signal});
    root.addEventListener('focusout',event=>{if(!root.contains(event.relatedTarget))setOpen(false);},{signal:controller.signal});
    view.refreshSearch=()=>{if(!panel.hidden)render();};
  }

  async function renderLimitupLadder(){
    await readLiveLadderStatus();
    const retainedStockFocus=$('#ladderChart')?ladderView?.focusedStock||'':'',retainedStockOnly=Boolean($('#ladderChart')&&ladderView?.stockOnly),retainedStockTheme=retainedStockOnly?ladderView?.compactTheme||'':'',retainedLegendStocks=$('#ladderChart')?{all:ladderView?.legendStocksAll??false,overrides:new Map(ladderView?.legendStockOverrides||[])}:null;
    closeLadderTopicHover();const id=++ladderRequestId;ladderResizeObserver?.disconnect();ladderView?.observer?.disconnect();ladderView?.searchAbort?.abort();
    if(activeChartZoom)closeChartZoom();state.charts.forEach(key=>{try{window.klinecharts.dispose(key)}catch{}});state.charts=[];state.chartInstances=[];
    content.classList.remove('six-grid-page');state.stockLoadId++;state.indexLoadId++;state.topic=null;state.stock=null;state.index=null;state.indexData=null;state.indicesPage=false;
    $('#crumbCurrent').textContent='涨停天梯';$('#crumbCurrent').hidden=false;$('#crumbBack').hidden=true;$('#crumbWorkspace').hidden=true;$('#crumbSeparator').hidden=true;
    const requested=history.state?.ladderEnd||new URL(location.href).searchParams.get('ladderEnd')||new URL(location.href).searchParams.get('ladderStart'),end=state.dates.includes(requested)?state.dates.indexOf(requested):state.dates.length-1,endDay=state.dates[end];
    $('#topbarActions').replaceChildren();
    content.innerHTML=`<div class="ladder-page ladder-vertical"><aside class="vl-controls"><div class="vl-toolbar"><div class="ladder-heading"><h1>涨停天梯</h1></div><span id="ladderLoadStatus" class="vl-load-status" aria-live="polite" hidden></span></div><div id="ladderDetail" class="ladder-detail" aria-live="polite" hidden></div><div class="vl-specified-day-controls"><label><input id="ladderSpecifiedDayEnabled" type="checkbox" checked/><span>指定日</span></label>${datePickerTriggerMarkup('ladderSpecifiedDay','date-nav-button',endDay)}</div><div id="ladderLegend" class="ladder-legend" aria-label="题材图例"></div></aside><section class="vl-plot"><div class="vl-plot-toolbar" role="toolbar" aria-label="天梯控制工具栏"><div class="vl-plot-toolbar-leading"><div id="ladderSearch" class="vl-ladder-search"><button id="ladderSearchToggle" class="vl-search-toggle" type="button" title="搜索股票或题材" aria-label="搜索股票或题材" aria-expanded="false" aria-controls="ladderSearchPanel"><svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="8.2" cy="8.2" r="5.1"/><path d="m12 12 4.8 4.8"/></svg></button><div id="ladderSearchPanel" class="vl-search-panel" role="dialog" aria-label="天梯搜索" hidden><input id="ladderSearchInput" type="search" role="combobox" aria-label="股票名或题材名" aria-autocomplete="list" aria-expanded="false" aria-controls="ladderSearchResults" autocomplete="off" placeholder="股票名或题材名"/><div id="ladderSearchResults" class="vl-search-results" role="listbox" aria-label="搜索结果"></div></div></div><span id="ladderToolbarRange" class="vl-toolbar-range" aria-live="polite"></span><span id="ladderLiveStatus" class="vl-live-status" hidden></span><button id="ladderShowAll" class="vl-calendar-show-all" type="button" title="显示全部题材并展开列表" aria-label="显示全部题材并展开列表">全</button><button id="ladderToggleSummaries" class="vl-summary-toggle" type="button" aria-label="展开未晋级和其他题材">展开</button></div><div class="vl-plot-toolbar-actions"><div class="review-date-controls topbar-date-controls"><button id="prevLadderDate" class="date-nav-button" type="button">← 前一日</button>${datePickerTriggerMarkup('ladderDatePickerTrigger','date-nav-button',endDay)}<button id="nextLadderDate" class="date-nav-button" type="button">后一日 →</button></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button></div></div><div id="ladderChart" class="ladder-chart" aria-busy="true"><div class="loading"><span class="spinner"></span><p>正在读取晋级路径…</p></div></div></section></div>`;
    $('#prevLadderDate').onclick=()=>moveLadderDate(-1);$('#nextLadderDate').onclick=()=>moveLadderDate(1);$('#openSettings').onclick=openSettings;updateLadderDateControls(endDay);renderNav();window.scrollTo(0,0);
    const view=ladderView={id,end,endDay,focusedStock:retainedStockFocus,stockOnly:retainedStockOnly,compactTheme:retainedStockTheme,compactThemes:retainedStockTheme?[retainedStockTheme]:[],legendStocksAll:retainedLegendStocks?.all??false,legendStockOverrides:retainedLegendStocks?.overrides||new Map(),low:end,high:end,loading:false,specifiedDayEnabled:true,specifiedDay:endDay,legendCollapsed:true,sealed:new Map(),outcomes:new Map(),links:new Map(),relimitLinks:new Map(),suspensionCarry:new Map(),unpromoted:new Map(),expandedUnpromoted:new Set(),aggregateInitialized:new Set(),hiddenLevels:new Set(),foldOtherThemes:true,foldBreakThemes:true,foldSecondFailed:true,foldHigherFailed:true,broken:new Map(),brokenDates:new Set(),previousDates:{},days:new Set(),data:null};
    setupLadderSearch(view);
    await loadVerticalLadder('initial');if(ladderView!==view)return;
    const chart=$('#ladderChart');setupLadderCanvasPan(chart,view);chart.addEventListener('scroll',()=>{if(ladderView!==view)return;if(!view.dragging)view.updateLegend?.();prefetchLadderEdge(chart,view);},{passive:true});
    let oldWidth=$('#ladderChart').clientWidth;ladderResizeObserver=new ResizeObserver(()=>{if(ladderView!==view||!$('#ladderChart'))return;const width=$('#ladderChart').clientWidth;if(width!==oldWidth){oldWidth=width;paintLimitupLadder(view.data);if(!view.loading&&view.low>0&&view.days.size<ladderViewportSessions())loadVerticalLadder('older');}});ladderResizeObserver.observe($('#ladderChart'));
  }
  function setupLadderCanvasPan(host,view){
    let pan=null;
    const finish=event=>{if(!pan||event.pointerId!==pan.id)return;const moved=pan.moved;pan=null;view.dragging=false;host.classList.remove('vl-panning');if(host.hasPointerCapture(event.pointerId))host.releasePointerCapture(event.pointerId);if(view.pendingPaint){view.pendingPaint=false;rebuildVerticalLadder(view);}view.updateLegend?.();if(moved)prefetchLadderEdge(host,view);};
    host.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('.vl-board-header,.vl-date-rail,.vl-stock,.vl-inlet,.vl-edge,.vl-group-box,.vl-inline-theme,[data-vl-outcome]'))return;pan={id:event.pointerId,x:event.clientX,y:event.clientY,left:host.scrollLeft,top:host.scrollTop,moved:false};view.dragging=true;host.setPointerCapture(event.pointerId);event.preventDefault();});
    host.addEventListener('pointermove',event=>{if(!pan||event.pointerId!==pan.id)return;const dx=event.clientX-pan.x,dy=event.clientY-pan.y;if(!pan.moved&&Math.hypot(dx,dy)<3)return;pan.moved=true;host.classList.add('vl-panning');host.scrollLeft=pan.left-dx;host.scrollTop=pan.top-dy;event.preventDefault();});
    host.addEventListener('pointerup',finish);host.addEventListener('pointercancel',finish);host.addEventListener('lostpointercapture',()=>{pan=null;view.dragging=false;host.classList.remove('vl-panning');});
  }
  function setupLadderDateSlider(header,columns){
    const view=ladderView;if(!header||!view)return;const last=state.dates.length-1,step=columns[0]?.width||188;let drag=null,preview=view.end;
    header.setAttribute('role','slider');header.tabIndex=0;header.setAttribute('aria-label','拖动日期滑条选择天梯截止日');header.setAttribute('aria-orientation','horizontal');header.setAttribute('aria-valuemin','0');header.setAttribute('aria-valuemax',String(last));header.title='单击日期查看每日总览；按住左右拖动切换截止日';
    const paintPreview=index=>{preview=Math.max(0,Math.min(last,index));const delta=preview-view.end;header.setAttribute('aria-valuenow',String(preview));header.setAttribute('aria-valuetext',formatCalendarDate(state.dates[preview]));for(const label of header.querySelectorAll('[data-vl-date]')){const day=state.dates[state.dates.indexOf(label.dataset.vlDate)+delta];label.textContent=day?day.slice(4,6)+'/'+day.slice(6):'';label.classList.toggle('vl-date-selected',day===state.dates[preview]);}updateLadderDateControls(state.dates[preview]);};
    const finish=event=>{if(!drag||event.pointerId!==drag.id)return;const finished=drag;drag=null;view.dragging=false;header.classList.remove('vl-ruler-dragging');if(header.hasPointerCapture(event.pointerId))header.releasePointerCapture(event.pointerId);if(event.type==='pointercancel'){paintPreview(view.end);if(view.pendingPaint){view.pendingPaint=false;rebuildVerticalLadder(view);}}else if(finished.moved){if(preview!==view.end)openLadderDate(state.dates[preview],true);else if(view.pendingPaint){view.pendingPaint=false;rebuildVerticalLadder(view);}}else if(finished.day)openHome(finished.day);};
    header.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('.vl-date-corner'))return;closeDatePicker();closeLadderTopicHover();drag={id:event.pointerId,x:event.clientX,y:event.clientY,day:event.target.closest('[data-vl-date]')?.dataset.vlDate||'',moved:false};view.dragging=true;header.setPointerCapture(event.pointerId);header.classList.add('vl-ruler-dragging');event.preventDefault();event.stopPropagation();});
    header.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;if(Math.hypot(drag.x-event.clientX,drag.y-event.clientY)>4)drag.moved=true;paintPreview(view.end+Math.round((drag.x-event.clientX)/step));if(view.rulerWarmTimer)clearTimeout(view.rulerWarmTimer);const warmIndex=preview;view.rulerWarmTimer=setTimeout(()=>{view.rulerWarmTimer=0;if(ladderView!==view||!view.dragging)return;if(!view.days.has(state.dates[warmIndex]))getLadderPayload(state.dates[warmIndex],Math.min(LADDER_PRELOAD_SESSIONS,warmIndex+1)).catch(error=>console.warn('天梯范围预取稍后重试',error));else if(warmIndex-view.low<ladderViewportSessions()+5)loadVerticalLadder('older');},120);event.preventDefault();});
    header.addEventListener('pointerup',finish);header.addEventListener('pointercancel',finish);header.addEventListener('lostpointercapture',()=>{drag=null;view.dragging=false;header.classList.remove('vl-ruler-dragging');});
    header.addEventListener('keydown',event=>{const date=event.target.closest('[data-vl-date]')?.dataset.vlDate;if(date&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();openHome(date);return;}const deltas={ArrowLeft:-1,ArrowRight:1,PageUp:-ladderViewportSessions(),PageDown:ladderViewportSessions()};let target;if(event.key==='Home')target=0;else if(event.key==='End')target=last;else if(event.key in deltas)target=view.end+deltas[event.key];else return;event.preventDefault();target=Math.max(0,Math.min(last,target));if(target!==view.end)openLadderDate(state.dates[target],true);});
    paintPreview(view.end);
  }
  function deferLadderNavigation(event,action){
    const view=ladderView;if(history.state?.view!=='ladder'||!view){if(event.detail<2)action();return;}
    if(view.navClickTimer)clearTimeout(view.navClickTimer);if(event.detail<2)view.navClickTimer=setTimeout(()=>{view.navClickTimer=0;if(ladderView===view&&history.state?.view==='ladder')action();},500);
  }
  function compactLadderNavigation(event){
    if(history.state?.view!=='ladder'||!ladderView?.compactFocus||event.target.closest('.arrow'))return false;
    const element=event.target.closest('[data-topic],[data-board-topic],[data-board-theme]'),theme=element?.dataset.topic||element?.dataset.boardTopic||element?.dataset.boardTheme;if(!theme)return false;
    event.preventDefault();event.stopPropagation();if(ladderView.navClickTimer){clearTimeout(ladderView.navClickTimer);ladderView.navClickTimer=0;}ladderView.compactFocus(theme);return true;
  }
  function ladderViewportSessions(){return Math.min(30,Math.max(2,Math.ceil((($('#ladderChart')?.clientWidth||window.innerWidth)-50)/188)));}
  function ladderChainThemes(sealed,links,cutoff){
    const raw=new Map([...sealed].filter(([,node])=>node.date<=cutoff)),parent=new Map([...raw.keys()].map(id=>[id,id]));
    const find=id=>{let root=id;while(parent.get(root)!==root)root=parent.get(root);while(id!==root){const next=parent.get(id);parent.set(id,root);id=next;}return root;};
    // Actual promotion edges keep a multi-session pattern together across breaks or pauses.
    for(const edge of links){if(edge.status!=='promoted')continue;const source=raw.get(edge.source),target=raw.get(edge.target);if(!source||!target||source.code!==target.code||target.date<=source.date||target.board!==source.board+1)continue;parent.set(find(source.id),find(target.id));}
    const peaks=new Map();for(const node of raw.values()){const root=find(node.id),peak=peaks.get(root);if(!peak||node.board>peak.board||(node.board===peak.board&&((node.status==='sealed'&&peak.status!=='sealed')||(node.status===peak.status&&node.date>peak.date))))peaks.set(root,node);}
    return new Map([...raw].map(([id,node])=>{const peak=peaks.get(find(id));return [id,{...node,originalTheme:node.theme,theme:peak.theme,themePeakDate:peak.sourceDate||peak.date,themePeakBoard:peak.board}];}));
  }
  async function loadLadderBrokenStocks(view){
    if(view.breakLoading||ladderView!==view)return;
    const dates=[...view.days].filter(day=>!view.brokenDates.has(day)).sort().slice(0,30);if(!dates.length)return;
    if(view.breakRetryTimer){clearTimeout(view.breakRetryTimer);view.breakRetryTimer=0;}view.breakLoading=true;
    try{const payload=await api(`/api/ladder-breaks?start=${dates[0]}&end=${dates.at(-1)}`,{cache:'no-store'});if(ladderView!==view||payload.ladderDataVersion!==view.dataVersion)return;
      view.breakError=false;view.breakFailures=0;for(const day of payload.dates)view.brokenDates.add(day);for(const stock of payload.brokenStocks)view.broken.set(stock.id,stock);
      if(view.dragging)view.pendingPaint=true;else rebuildVerticalLadder(view);
    }catch(error){
      if(ladderView!==view)return;
      console.warn('天梯破板数据读取失败',error);view.breakError=true;view.breakFailures=(view.breakFailures||0)+1;
      if(view.breakFailures<=2)view.breakRetryTimer=setTimeout(()=>{view.breakRetryTimer=0;if(ladderView===view)loadLadderBrokenStocks(view);},500*2**(view.breakFailures-1));
      else toast('破板数据暂未读到，请重新选择日期重试');
    }
    finally{view.breakLoading=false;}
    if(ladderView===view&&!view.breakError&&[...view.days].some(day=>!view.brokenDates.has(day)))loadLadderBrokenStocks(view);
  }
  function mergeLadderPayload(view,payload,source){
      if(payload.live){
        const day=payload.live.date;
        for(const map of [view.sealed,view.outcomes,view.broken,view.unpromoted])for(const [key,stock] of map)if(stock.date===day)map.delete(key);
        for(const map of [view.links,view.relimitLinks||new Map()])for(const [key,edge] of map)if(edge.target.startsWith(day+':'))map.delete(key);
        view.live=payload.live;view.brokenDates.add(day);for(const stock of payload.brokenStocks||[])view.broken.set(stock.id,stock);
      }
      for(const day of payload.dates)view.days.add(day);
      for(const node of payload.sealedStocks||[])view.sealed.set(node.id,node);
      for(const node of payload.contextStocks||[])view.sealed.set(node.id,node);
      for(const node of payload.relimitContextStocks||[])view.sealed.set(node.id,node);
      for(const stock of payload.relimitBrokenStocks||[])view.broken.set(stock.id,stock);
      view.relimitLinks||=new Map();for(const edge of payload.relimitLinks||[])view.relimitLinks.set(edge.source+'|'+edge.target,edge);
      Object.assign(view.previousDates,payload.previousDates||{});
      for(const carry of payload.suspensionCarry||[])view.suspensionCarry.set(carry.targetDate+':'+carry.code,carry);
      for(const stock of payload.unpromotedStocks||[])view.unpromoted.set(stock.id,stock);
      for(const node of payload.nodes)if(node.status!=='sealed')view.outcomes.set(node.id,node);
      for(const edge of payload.links)view.links.set(edge.source+'|'+edge.target,edge);
    const indices=[...view.days].map(day=>state.dates.indexOf(day)).filter(index=>index>=0);view.low=Math.min(...indices);view.high=Math.max(...indices);view.dataVersion=payload.ladderDataVersion;view.cacheSource=source;
    if(payload.live){
      const date=payload.live.date,legend={date,sealedStocks:[...(payload.contextStocks||[]),...(payload.sealedStocks||[])].filter(stock=>stock.date===date),unpromotedStocks:(payload.unpromotedStocks||[]).filter(stock=>stock.date===date).map(stock=>({...stock,status:'unpromoted'})),brokenStocks:(payload.brokenStocks||[]).filter(stock=>stock.date===date).map(stock=>({...stock,status:'broken'}))};
      // The live ladder response already contains the complete current-day membership.
      view.liveLegendPayload=legend;(view.specifiedLegendCache||=new Map()).set(date+':'+view.dataVersion,legend);
      if(view.specifiedDay===date){view.specifiedLegendPayload=legend;view.specifiedLegendRequestId=(view.specifiedLegendRequestId||0)+1;}
    }
    loadLadderBrokenStocks(view);
  }
  function rebuildVerticalLadder(view,anchor='preserve'){
    if(ladderView!==view||history.state?.view!=='ladder'||!$('#ladderChart'))return;view.pendingPaint=false;
      const promotionFrom=new Map();for(const edge of view.links.values()){if(edge.status!=='promoted'||!view.sealed.has(edge.source)||!view.sealed.has(edge.target)||view.sealed.get(edge.target).date>view.endDay)continue;const prior=promotionFrom.get(edge.source);if(!prior||edge.target<prior.target)promotionFrom.set(edge.source,edge);}
      const days=[...view.days].filter(day=>day<=view.endDay).sort(),latest=days.at(-1),chainNodes=ladderChainThemes(view.sealed,view.links.values(),view.endDay),byDay=new Map(days.map(day=>[day,[]]));for(const node of chainNodes.values())byDay.get(node.date)?.push(node);
      const nodes=[];
      for(let i=0;i<days.length;i++){
        const day=days[i],all=byDay.get(day),first=new Map();for(const n of all)if(n.status==='sealed'&&n.board===1){if(!first.has(n.theme))first.set(n.theme,[]);first.get(n.theme).push(n);}
        for(const list of first.values())list.sort((a,b)=>(a.time||'99').localeCompare(b.time||'99')||a.code.localeCompare(b.code));
        const selected=new Set([...first].sort((a,b)=>b[1].length-a[1].length||(a[1][0].time||'99').localeCompare(b[1][0].time||'99')||a[0].localeCompare(b[0],'zh-CN')).slice(0,3).map(x=>x[0]));for(const n of all)if(n.status==='sealed'&&n.board>=2)selected.add(n.theme);
        const retainedFirstThemes=day===latest?selected:new Set([...first].filter(([,stocks])=>stocks.some(stock=>promotionFrom.has(stock.id))).map(([theme])=>theme));
        for(const node of all)if(node.board>1||retainedFirstThemes.has(node.theme))nodes.push({...node,representative:false,firstCount:0,members:[]});
      }
      const ids=new Set(nodes.map(n=>n.id)),links=[];for(const edge of view.links.values()){if(!ids.has(edge.source))continue;if(edge.status==='promoted'){if(promotionFrom.get(edge.source)?.target===edge.target&&ids.has(edge.target))links.push(edge);}else{if(promotionFrom.has(edge.source))continue;const target=view.outcomes.get(edge.target);if(target&&target.date<=view.endDay&&view.days.has(target.date)){if(!ids.has(target.id)){const source=chainNodes.get(edge.source);nodes.push({...target,originalTheme:target.theme,theme:source?.theme||target.theme,themePeakDate:source?.themePeakDate,themePeakBoard:source?.themePeakBoard});ids.add(target.id);}links.push(edge);}}}
      const themes=[...new Set(nodes.map(n=>n.theme))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(name=>({name}));
      const oldChart=$('#ladderChart'),oldSvg=oldChart.querySelector('svg'),oldLeft=oldChart.scrollLeft,oldScroll=oldChart.scrollTop,oldFirst=view.data?.dates[0],oldCount=view.data?.dates.length||0;
      view.data={live:view.live,dates:days,nodes,links,themes,relimitLinks:[...(view.relimitLinks||new Map()).values()].filter(edge=>edge.targetDate<=view.endDay),brokenStocks:[...view.broken.values()].filter(stock=>stock.date<=view.endDay),previousDates:{...view.previousDates},sealedStocks:[...chainNodes.values()],unpromotedStocks:[...view.unpromoted.values()].filter(stock=>stock.date<=view.endDay).map(stock=>({...stock,originalTheme:stock.theme,theme:chainNodes.get(stock.sourceId)?.theme||stock.theme})),suspensionCarry:[...view.suspensionCarry.values()].filter(carry=>carry.targetDate<=view.endDay).map(carry=>({...carry,theme:chainNodes.get(carry.targetId)?.theme||chainNodes.get(carry.sourceId)?.theme||carry.theme}))};if(anchor==='end')view.visibleDays=days.slice(-ladderViewportSessions());paintLimitupLadder(view.data);
      const chart=$('#ladderChart');if(anchor==='end')chart.scrollLeft=chart.scrollWidth-chart.clientWidth;else if(oldSvg){const added=days.indexOf(oldFirst),column=(Number(chart.querySelector('svg').getAttribute('width'))-50)/days.length;chart.scrollLeft=oldLeft+(added>0&&days.length>oldCount?added*column:0);chart.scrollTop=oldScroll;}chart.dataset.loadedSessions=String(view.days.size);chart.dataset.renderedSessions=String(days.length);chart.dataset.cacheSource=view.cacheSource||'';chart.dataset.dataVersion=view.dataVersion||'';view.updateLegend?.();updateLiveLadderLabel(view);syncLivePushConnection();
  }
  function prefetchLadderEdge(host,view){
    if(!host||ladderView!==view||view.loading||!view.data||view.low<=0||history.state?.view!=='ladder')return;
    const endIndex=state.dates.indexOf(view.endDay),remaining=endIndex-view.low+1;
    if(host.scrollLeft<Math.max(752,host.clientWidth*.75)||remaining<Math.min(LADDER_PRELOAD_SESSIONS,ladderViewportSessions()+5))loadVerticalLadder('older');
  }
  async function loadVerticalLadder(direction){
    const view=ladderView;if(!view||view.loading||history.state?.view!=='ladder')return;
    let low,high;
    if(direction==='initial'){high=view.end;low=Math.max(0,high-LADDER_PRELOAD_SESSIONS+1);}
    else if(direction==='older'){if(view.low===0)return;high=view.low;low=Math.max(0,high-LADDER_PRELOAD_SESSIONS+1);}
    else return;
    view.loading=true;const status=$('#ladderLoadStatus');if(status&&direction==='initial'){status.hidden=false;status.textContent='正在加载…';}
    try{
      const result=await getLadderPayload(state.dates[high],high-low+1);
      if(ladderView!==view||history.state?.view!=='ladder'||!$('#ladderChart'))return;
      // A source repair invalidates the whole in-memory range, just like persistent blocks.
      if(view.dataVersion&&view.dataVersion!==result.payload.ladderDataVersion){view.loading=false;await renderLimitupLadder();return;}
      mergeLadderPayload(view,result.payload,result.source);
      if(view.dragging)view.pendingPaint=true;else rebuildVerticalLadder(view,direction==='initial'?'end':'preserve');
      $('#ladderChart').setAttribute('aria-busy','false');if(status)status.hidden=true;
    }catch(error){if(ladderView===view){if(status){status.hidden=false;status.textContent='加载失败：'+error.message;}if(!view.data)$('#ladderChart').innerHTML='<div class="empty-state">'+esc(error.message)+'</div>';}}
    finally{view.loading=false;}
  }
  function ladderBoardBadgeStyle(node){
    if(node.board_shape==='one_word')return {kind:'one-word',label:'一字板',color:'#dc3f40',dashed:false};
    if(node.board_shape==='t_shape')return {kind:'t-shape',label:'T字板',color:'#dc3f40',dashed:false};
    if(node.board_strength==='strong')return {kind:'strong',label:'强板',color:'#dc3f40',dashed:true};
    if(node.board_strength==='weak')return {kind:'weak',label:'弱板',color:'var(--ladder-theme-color)',dashed:true};
    return {kind:'normal',label:'',color:'var(--ladder-theme-color)',dashed:false};
  }
  function ladderCardFragment(fresh){
    const clone=fresh.cloneNode(true),cards=[...(clone.nodeType===1&&clone.hasAttribute('data-vl-card-key')?[clone]:[]),...clone.querySelectorAll?.('[data-vl-card-key]')||[]];
    for(const card of cards)if(!card.hasChildNodes()){
      const record=ladderView.cardMarkupCache?.get(card.dataset.vlCardKey)?.find(item=>String(item.token)===card.dataset.vlCardToken);
      if(record)card.innerHTML=record.body;
    }
    return clone;
  }
  function ladderDOMKey(node){
    if(node.nodeType!==Node.ELEMENT_NODE)return '';
    const d=node.dataset;
    if(d.vlCardKey)return 'card:'+d.vlCardKey;
    if(node.classList.contains('vl-edge'))return 'edge:'+(d.vlPromotionKind||'relimit')+':'+(d.vlIds||'').split('|').sort().join('|');
    if(d.vlRelimitNotes)return 'notes:'+d.vlRelimitNotes;
    if(d.vlRelimitEntry)return 'entry:'+d.vlRelimitEntry;
    if(d.vlOutcome)return 'outcome:'+d.vlOutcome+':'+(d.vlIds||d.vlNode||d.vlFirstFailedGroup||'');
    if(d.vlNode)return 'stock:'+d.vlNode;
    if(d.vlStockLink||d.vlUnpromotedLink||d.vlBrokenLink)return 'name:'+(d.vlStockLink||d.vlUnpromotedLink||d.vlBrokenLink);
    if(node.nodeName==='g'&&node.hasAttribute('clip-path'))return 'row:'+node.getAttribute('clip-path');
    return node.id?'id:'+node.id:'';
  }
  function syncLadderAttributes(existing,fresh){
    // Keep current emphasis while patching geometry; dropping these classes starts opacity fades.
    const stateClasses=[...existing.classList].filter(name=>name==='ladder-dim'||name==='vl-theme-emphasis'||name.startsWith('vl-stock-focus-'));
    for(const attribute of [...existing.attributes])if(!fresh.hasAttribute(attribute.name)&&attribute.name!=='class')existing.removeAttribute(attribute.name);
    for(const attribute of fresh.attributes)if(attribute.name!=='class'&&existing.getAttribute(attribute.name)!==attribute.value)existing.setAttribute(attribute.name,attribute.value);
    const classes=[...new Set([...(fresh.getAttribute('class')||'').split(/\s+/).filter(Boolean),...stateClasses])].join(' ');
    if(classes){if(existing.getAttribute('class')!==classes)existing.setAttribute('class',classes);}else existing.removeAttribute('class');
  }
  function patchLadderChildren(existing,fresh){
    const old=[...existing.childNodes],keyed=new Map(old.map(node=>[ladderDOMKey(node),node]).filter(([key])=>key)),used=new Set();
    for(const [index,newChild] of [...fresh.childNodes].entries()){
      const key=ladderDOMKey(newChild);let child=key?keyed.get(key):old.find(node=>!used.has(node)&&!ladderDOMKey(node)&&node.nodeType===newChild.nodeType&&node.nodeName===newChild.nodeName);
      if(!child){child=ladderCardFragment(newChild);existing.insertBefore(child,existing.childNodes[index]||null);}
      else{if(existing.childNodes[index]!==child)existing.insertBefore(child,existing.childNodes[index]||null);patchLadderDOM(child,newChild);}
      used.add(child);
    }
    for(const child of old)if(!used.has(child))child.remove();
  }
  function patchLadderDOM(existing,fresh){
    if(existing.nodeType===1&&fresh.nodeType===1&&fresh.hasAttribute('data-vl-card-token')&&existing.getAttribute('data-vl-card-key')===fresh.getAttribute('data-vl-card-key')){
      const oldToken=existing.getAttribute('data-vl-card-token'),token=fresh.getAttribute('data-vl-card-token');syncLadderAttributes(existing,fresh);
      if(oldToken===token)return;
      if(!ladderView.live){
        // Historical expand/collapse retains the fast fragment cache.
        const cache=ladderView.cardDOMCache,saved=cache.get(token),fragment=document.createDocumentFragment();
        while(existing.firstChild)fragment.appendChild(existing.firstChild);cache.set(oldToken,fragment);
        if(saved){cache.delete(token);existing.appendChild(saved);}else{const content=fresh.hasChildNodes()?fresh:ladderCardFragment(fresh);while(content.firstChild)existing.appendChild(content.firstChild);}return;
      }
      // Live prices/membership patch existing rows without detaching the card.
      patchLadderChildren(existing,fresh.hasChildNodes()?fresh:ladderCardFragment(fresh));return;
    }
    if(existing.isEqualNode(fresh))return;
    if(existing.nodeType!==fresh.nodeType||existing.nodeName!==fresh.nodeName){existing.replaceWith(ladderCardFragment(fresh));return;}
    if(existing.nodeType!==Node.ELEMENT_NODE){existing.nodeValue=fresh.nodeValue;return;}
    syncLadderAttributes(existing,fresh);patchLadderChildren(existing,fresh);
  }
  function patchLadderLegend(existing,fresh){
    if(existing.isEqualNode(fresh)){if(existing.nodeName==='INPUT'&&existing.type==='checkbox')existing.checked=fresh.checked;return;}
    if(existing.nodeType!==fresh.nodeType||existing.nodeName!==fresh.nodeName){existing.replaceWith(fresh.cloneNode(true));return;}
    if(existing.nodeType!==Node.ELEMENT_NODE){existing.nodeValue=fresh.nodeValue;return;}
    for(const attribute of [...existing.attributes])if(!fresh.hasAttribute(attribute.name))existing.removeAttribute(attribute.name);
    for(const attribute of fresh.attributes)if(existing.getAttribute(attribute.name)!==attribute.value)existing.setAttribute(attribute.name,attribute.value);
    const key=node=>node.nodeType!==Node.ELEMENT_NODE?'':node.hasAttribute('data-vl-legend-entry')?'entry:'+node.dataset.vlLegendEntry:node.hasAttribute('data-vl-legend-stock')?'stock:'+node.dataset.vlLegendStock:node.hasAttribute('data-vl-theme')?'theme:'+node.dataset.vlTheme:node.tagName==='SECTION'?'tier:'+node.getAttribute('aria-label'):node.hasAttribute('data-vl-row-level')?'row:'+node.dataset.vlRowLevel:'',old=[...existing.childNodes],keyed=new Map(old.map(node=>[key(node),node]).filter(([key])=>key)),used=new Set();
    for(const [index,newChild] of [...fresh.childNodes].entries()){
      const newKey=key(newChild);let child=newKey?keyed.get(newKey):old.find(node=>!used.has(node)&&!key(node)&&node.nodeType===newChild.nodeType&&node.nodeName===newChild.nodeName);
      if(!child){child=newChild.cloneNode(true);existing.insertBefore(child,existing.childNodes[index]||null);}else{if(existing.childNodes[index]!==child)existing.insertBefore(child,existing.childNodes[index]||null);patchLadderLegend(child,newChild);}used.add(child);
    }
    for(const child of old)if(!used.has(child))child.remove();
    if(existing.nodeName==='INPUT'&&existing.type==='checkbox')existing.checked=fresh.checked;
  }
  const ladderLegendMarkup=new WeakMap();
  function updateLadderLegend(legend,markup){
    if(ladderLegendMarkup.get(legend)===markup){legend.dataset.skippedPatches=String(Number(legend.dataset.skippedPatches||0)+1);return;}
    const before=new Map([...legend.querySelectorAll('[data-vl-legend-entry]')].map(node=>[node.dataset.vlLegendEntry,node]));
    const fresh=legend.cloneNode(false);fresh.innerHTML=markup;patchLadderLegend(legend,fresh);ladderLegendMarkup.set(legend,markup);
    const after=[...legend.querySelectorAll('[data-vl-legend-entry]')],retained=after.filter(node=>before.get(node.dataset.vlLegendEntry)===node).length;
    legend.dataset.patchCount=String(Number(legend.dataset.patchCount||0)+1);legend.dataset.retainedEntries=String(retained);legend.dataset.createdEntries=String(after.length-retained);legend.dataset.removedEntries=String(before.size-retained);
    if(before.size&&!after.length)legend.dataset.resetCount=String(Number(legend.dataset.resetCount||0)+1);
  }

  async function getLadderSpecifiedDay(view,date){
    const cache=view.specifiedLegendCache||=new Map(),requests=view.specifiedLegendRequests||=new Map(),key=date+':'+view.dataVersion;
    if(date===view.live?.date&&view.liveLegendPayload?.date===date)return view.liveLegendPayload;
    if(cache.has(key))return cache.get(key);if(requests.has(key))return requests.get(key);
    const task=(async()=>{const [result,breaks]=await Promise.all([getLadderPayload(date,1),api('/api/ladder-breaks?start='+date+'&end='+date)]),payload=result.payload;
      if(payload.ladderDataVersion!==view.dataVersion||breaks.ladderDataVersion!==view.dataVersion)throw new Error('行情数据已更新，请刷新天梯后查看图例');
      const data={date,sealedStocks:[...(payload.contextStocks||[]),...(payload.sealedStocks||[])],unpromotedStocks:(payload.unpromotedStocks||[]).map(stock=>({...stock,status:'unpromoted'})),brokenStocks:(payload.live?payload.brokenStocks||[]:breaks.brokenStocks||[]).map(stock=>({...stock,status:'broken'}))};cache.set(key,data);while(cache.size>16)cache.delete(cache.keys().next().value);return data;
    })();requests.set(key,task);try{return await task;}finally{requests.delete(key);}
  }
  function ladderLegendFraction(count,total,theme){
    const font=Math.max(count,total)>99?5.4:6.5;
    return `<svg class="vl-legend-fraction" viewBox="0 0 28 28" aria-label="${count}/${total}" style="color:${ladderThemeColor(theme)}"><circle cx="14" cy="14" r="12" fill="var(--paper)" stroke="currentColor" stroke-width=".9"/><path d="M7 21 L21 7" fill="none" stroke="currentColor" stroke-width=".65"/><g fill="currentColor" font-family="var(--mono)" font-size="${font}" text-anchor="middle"><text x="10" y="11.3">${count}</text><text x="18.5" y="22">${total}</text></g></svg>`;
  }

  function ladderRelimitEntryNote(edge,source,noteRight,y,measure){
    const board=Number(source?.board??edge.sourceBoard),days=Number(source?.patternDays)||board,broken=board===0,multi=!broken&&days>board,label=broken?'破':multi?`${days}天${board}板`:`${board}板`,text=edge.failureDate.slice(4,6)+'/'+edge.failureDate.slice(6)+' · '+edge.sessions+'日'+(edge.name?' · '+edge.name:''),cx=noteRight-6-measure(text,5.2),cy=y-2;
    const badge=multi?`<path d="M${cx-2.8},${cy+2.8} L${cx+2.8},${cy-2.8}" fill="none" stroke="#82796d" stroke-width=".45"/><text x="${cx-1.7}" y="${cy-.5}" text-anchor="middle" style="font:3.7px var(--mono);stroke-width:.6px">${board}</text><text x="${cx+1.7}" y="${cy+3.4}" text-anchor="middle" style="font:3.7px var(--mono);stroke-width:.6px">${days}</text>`:`<text x="${cx}" y="${cy+1.9}" text-anchor="middle" style="font-size:5.2px;stroke-width:.8px">${broken?'破':board}</text>`;
    return `<g data-vl-relimit-entry-note="${esc(edge.target)}" data-vl-relimit-prior-board="${board}" data-vl-relimit-prior-days="${days}" aria-label="${esc(label+' · '+text)}"><circle data-vl-relimit-days="${edge.sessions}" cx="${cx}" cy="${cy}" r="4.6" fill="var(--paper)" stroke="#82796d" stroke-width=".5"/>${badge}<text x="${cx+6}" y="${y}">${esc(text)}</text></g>`;
  }

  function ladderPromotionPortKey(group,edge){
    const kind=edge.kind||'continuous';
    return group+'|'+kind+(kind!=='continuous'?'|'+edge.source:'');
  }
  function ladderContinuationInlet(items,targets,ratio,color){
    const continuation=items.length===1&&targets.has(items[0].id);
    return {label:ratio,continuation,stroke:continuation?color:'#8c9299',ink:continuation?color:'#747b83'};
  }
  function ladderContinuationMarkers(edge,sourceNode,targetNode,geometry,measure,description){
    const {sx,sy,tx,ty,entryX,singleEntry,inletX,inletY}=geometry,ids=esc(edge.source+'|'+edge.target),theme=esc(targetNode.theme),short=day=>day.slice(4,6)+'/'+day.slice(6),exitText=short(edge.targetDate)+' · '+edge.sessions+'日后 · '+targetNode.name;
    const entry=singleEntry?'':`<g data-vl-relimit-entry="${esc(edge.target)}" data-vl-ids="${ids}" data-vl-outcome="relimit-entry" data-vl-focus-theme="${theme}" role="img" aria-label="${esc(targetNode.name)}专属续接入口"><title>${esc(targetNode.name)} · 续接入口</title><circle cx="${entryX}" cy="${ty}" r="5.5" fill="#b66b43" fill-opacity=".12" stroke="#b66b43" stroke-width=".9"/><text x="${entryX}" y="${ty+2.5}" text-anchor="middle" fill="#b66b43" style="font:7px var(--sans)">续</text></g>`;
    const y=ty+11,noteRight=Math.abs(y-2-inletY)<15?Math.min(tx-2,inletX-12):tx-2;
    return entry+`<g class="vl-relimit-notes" data-vl-ids="${ids}" data-vl-focus-theme="${theme}" data-vl-relimit-notes="${esc(edge.target)}" aria-label="${esc(description)}"><title>${esc(description)}</title><text x="${sx+2}" y="${sy-7}" text-anchor="start">${esc(exitText)}</text>${ladderRelimitEntryNote(edge,sourceNode,noteRight,y,measure)}</g>`;
  }

  function viewCardCache(view,data){
    if(view.cardCacheData!==data){const reuse=Boolean(view.live&&view.cardCacheVersion===view.dataVersion);view.cardCacheData=data;view.cardCacheVersion=view.dataVersion;if(!reuse){view.cardMarkupCache=new Map();view.cardDOMCache=new Map();}}
    view.cardToken||=0;return view.cardMarkupCache||new Map();
  }
  function retainLadderCard(chips,start,key,y,previous,next,view){
    const body=chips.splice(start).join(''),variants=previous.get(key)||[],cached=variants.find(record=>record.body===body),record=cached||{body,token:++view.cardToken};
    // Retain at most the current and previous content states, scoped to this payload.
    next.set(key,[record,...variants.filter(item=>item!==record)].slice(0,2));
    const reuse=view.reuseCardDOM&&(record===variants[0]||view.cardDOMCache.has(String(record.token)));
    chips.push(`<g data-vl-card-key="${esc(key)}" data-vl-card-token="${record.token}" transform="translate(0 ${y})">${reuse?'':body}</g>`);
  }

  function initializeLadderSummary(view,key,day,scope,folded,compact){
    if(view.aggregateInitialized.has(key))return;
    view.aggregateInitialized.add(key);
    // Defaults apply once per group; live refreshes preserve a user's fold choice.
    const liveDefault=view.live?.date===day&&!view.liveSummaryFolded?.[scope];
    if(compact||!folded||liveDefault)view.expandedUnpromoted.add(key);
  }
  function paintLimitupLadder(data){
    const host=$('#ladderChart');if(!host||!data)return;if(ladderView.focusedStock)host.dataset.stockFocus=ladderView.focusedStock;if(ladderView.stockOnly&&ladderView.focusedStock)host.dataset.stockOnly=ladderView.focusedStock;else delete host.dataset.stockOnly;const paintStarted=performance.now(),patchPaint=Boolean((ladderView.patchPaint||ladderView.live)&&host.querySelector('svg'));ladderView.patchPaint=false;closeLadderTopicHover();
    const previousCards=viewCardCache(ladderView,data),nextCards=new Map();ladderView.reuseCardDOM=patchPaint;
    const paintProfile={},markPaint=name=>{paintProfile[name]=Number((performance.now()-paintStarted).toFixed(1));};
    const fullData=data,view=ladderView,hiddenLevels=view.hiddenLevels||=new Set(),compactThemes=new Set(view.compactThemes||[view.compactTheme].filter(Boolean)),compactTheme=[...compactThemes][0]||'',minBoard=view.minBoard||0,compactLayout=Boolean(compactThemes.size||minBoard);if(view.singleClickTimer){clearTimeout(view.singleClickTimer);view.singleClickTimer=0;}if(view.legendClickTimer){clearTimeout(view.legendClickTimer);view.legendClickTimer=0;}
    const days=[...data.dates].sort(),left=44,measureContext=view.measureContext||=document.createElement('canvas').getContext('2d'),labelFont=getComputedStyle(document.documentElement).getPropertyValue('--sans'),measureSignature=labelFont+document.fonts.status;if(view.measureSignature!==measureSignature){view.measureSignature=measureSignature;view.textWidths=new Map();}const textWidth=(text,size)=>{if(!measureContext)return String(text).length*size;const key=size+':'+text;if(view.textWidths.has(key))return view.textWidths.get(key);measureContext.font=`${size}px ${labelFont}`;const width=measureContext.measureText(String(text)).width;view.textWidths.set(key,width);return width;};
    const stockLabelWidth=node=>19+textWidth(node.name,8)+textWidth(ladderStockPctText(node),7.2),allSealed=fullData.nodes.filter(node=>node.status==='sealed'),allFirstGroups=new Set(allSealed.filter(node=>node.board===1).map(node=>node.date+':'+node.theme)),allHigherGroups=new Set(allSealed.filter(node=>node.board>=2).map(node=>node.date+':'+Math.min(node.board,5)+':'+node.theme)),allFoldouts=(fullData.unpromotedStocks||[]).filter(stock=>ladderFailedLevel(stock)===1&&allFirstGroups.has(stock.date+':'+stock.theme)||allHigherGroups.has(stock.date+':'+ladderFailedLevel(stock)+':'+stock.theme)),fullLabelWidth=Math.ceil(Math.max(0,...allSealed.map(node=>textWidth(node.theme,7.2)))+3+Math.max(32,...allSealed.map(stockLabelWidth),...allFoldouts.map(stockLabelWidth))+2);
    // Filters compress rows only; date columns retain the full-chart width.
    const column=Math.max(188,fullLabelWidth+58,Math.min(200,(host.clientWidth-left-6)/days.length)),width=left+column*days.length+6,columns=days.map((day,i)=>({day,x:left+i*column,width:column}));
    const initialLeft=host.querySelector('svg')?host.scrollLeft:Math.max(0,width-host.clientWidth),filterDays=new Set(view.visibleDays||columns.filter(col=>col.x+col.width>initialLeft+left&&col.x<initialLeft+host.clientWidth-3).map(col=>col.day)),themePeaks=new Map();
    for(const node of fullData.sealedStocks||allSealed)if(node.status==='sealed'&&filterDays.has(node.date))themePeaks.set(node.theme,Math.max(themePeaks.get(node.theme)||0,node.board));
    const boardThemes=new Set([...themePeaks].filter(([,peak])=>peak>=minBoard).map(([theme])=>theme));
    if(compactLayout){const keepTheme=theme=>compactThemes.size?compactThemes.has(theme):boardThemes.has(theme);let nodes=data.nodes.filter(node=>keepTheme(node.theme));if(compactThemes.size){const present=new Set(nodes.map(node=>node.id));nodes.push(...(data.sealedStocks||[]).filter(node=>keepTheme(node.theme)&&!present.has(node.id)&&days.includes(node.date)));}const ids=new Set(nodes.map(node=>node.id));data={...data,brokenStocks:(data.brokenStocks||[]).filter(stock=>keepTheme(stock.theme)),nodes,links:data.links.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),themes:data.themes.filter(theme=>keepTheme(theme.name)),sealedStocks:(data.sealedStocks||[]).filter(node=>keepTheme(node.theme)),unpromotedStocks:(data.unpromotedStocks||[]).filter(node=>keepTheme(node.theme)),suspensionCarry:(data.suspensionCarry||[]).filter(node=>keepTheme(node.theme))};}
    if(view.stockOnly&&view.focusedStock)data=ladderStockPathData(fullData,view.focusedStock,days);
    // Only focused/compacted views show restart links. Pull in the exact stock
    // endpoints, including a first board previously hidden by representative rules.
    if(compactLayout){
      const keepTheme=theme=>compactThemes.size?compactThemes.has(theme):boardThemes.has(theme),byId=new Map((fullData.sealedStocks||[]).map(node=>[node.id,node])),present=new Set(data.nodes.map(node=>node.id)),restartIds=new Set();
      const brokenById=new Map((fullData.brokenStocks||[]).map(stock=>[stock.id,stock]));
      const restarts=(fullData.relimitLinks||[]).filter(edge=>edge.sessions>=1&&edge.sessions<=10).filter(edge=>{const source=byId.get(edge.source)||brokenById.get(edge.source),target=byId.get(edge.target);return source&&target&&days.includes(source.date)&&days.includes(target.date)&&(view.stockOnly?source.code===view.focusedStock&&target.code===view.focusedStock:keepTheme(source.theme)||keepTheme(target.theme));});
      for(const edge of restarts)if(brokenById.has(edge.source)&&!data.brokenStocks.some(stock=>stock.id===edge.source))data.brokenStocks.push(brokenById.get(edge.source));
      for(const edge of restarts)for(const id of [edge.source,edge.target]){if(!byId.has(id))continue;restartIds.add(id);if(!present.has(id)){data.nodes.push({...byId.get(id),representative:false,firstCount:0,members:[]});present.add(id);}}
      const sealedIds=new Set((data.sealedStocks||[]).map(node=>node.id));for(const id of restartIds)if(!sealedIds.has(id))data.sealedStocks.push(byId.get(id));
      data.relimitLinks=restarts;for(const node of data.nodes)if(!data.themes.some(theme=>theme.name===node.theme))data.themes.push({name:node.theme});
    }else data={...data,relimitLinks:[]};
    const levels=[5,4,3,2,1,0].filter(level=>!compactLayout||level>=2&&(data.unpromotedStocks||[]).some(stock=>days.includes(stock.date)&&ladderFailedLevel(stock)===level)||level===1&&(data.unpromotedStocks||[]).some(stock=>days.includes(stock.date)&&ladderFailedLevel(stock)===1)||level===0&&(data.brokenStocks||[]).some(stock=>days.includes(stock.date))||data.nodes.some(node=>node.status==='sealed'&&Math.min(node.board,5)===level)).filter(level=>!hiddenLevels.has(level)),sealedNodes=data.nodes.filter(node=>node.status==='sealed');
    let themeColors=ladderDistinctThemeColors(fullData.sealedStocks||allSealed,filterDays);view.themeColors=new Map(themeColors);const themeColor=name=>themeColors.get(name)||ladderThemeColor(name);
    const restartTargets=new Set((fullData.relimitLinks||[]).map(edge=>edge.target)),restartBrokenSources=new Set((data.relimitLinks||[]).filter(edge=>edge.sourceBoard===0).map(edge=>edge.source));
    const firstGroups=new Set(sealedNodes.filter(node=>node.board===1).map(node=>node.date+':'+node.theme)),higherGroups=new Set(sealedNodes.filter(node=>node.board>=2).map(node=>node.date+':'+Math.min(node.board,5)+':'+node.theme)),foldoutStocks=(data.unpromotedStocks||[]).filter(stock=>ladderFailedLevel(stock)===1&&firstGroups.has(stock.date+':'+stock.theme)||higherGroups.has(stock.date+':'+ladderFailedLevel(stock)+':'+stock.theme));
    const themeSlot=Math.max(0,...sealedNodes.map(node=>textWidth(node.theme,7.2))),stockSlot=Math.max(32,...sealedNodes.map(stockLabelWidth),...foldoutStocks.map(stockLabelWidth),...(data.brokenStocks||[]).map(stockLabelWidth)),labelWidth=Math.ceil(themeSlot+3+stockSlot+2);
    const sealedByTier=new Map();
    for(const node of sealedNodes){const key=node.date+':'+Math.min(node.board,5);let byTheme=sealedByTier.get(key);if(!byTheme)sealedByTier.set(key,byTheme=new Map());if(!byTheme.has(node.theme))byTheme.set(node.theme,[]);byTheme.get(node.theme).push(node);}
    const continuationTargets=new Set([...(data.relimitLinks||[]),...data.links.filter(edge=>edge.status==='promoted'&&edge.kind&&edge.kind!=='continuous')].map(edge=>edge.target));
    const rank=new Map(data.themes.map((t,i)=>[t.name,i])),groups=new Map(),positions=new Map(),nodeGroup=new Map(),points=new Map(),rows=[],background=[],chips=[],markers=[],paths=[];
    const groupExtras=new WeakMap(),firstPartitions=new WeakMap(),unpromotedGroups=new Map();view.expandedUnpromoted||=new Set();
    for(const stock of data.unpromotedStocks||[]){if(!days.includes(stock.date)||compactThemes.size&&!compactThemes.has(stock.theme))continue;const target=ladderFailedLevel(stock);for(const level of [target]){const key=stock.date+':'+level+':'+stock.theme;if(!unpromotedGroups.has(key))unpromotedGroups.set(key,[]);unpromotedGroups.get(key).push(stock);}}
    for(const list of unpromotedGroups.values())list.sort(compareLadderFailedPct);
    const groupHeight=list=>{const extra=groupExtras.get(list);return Math.max(25,list.length*20+6)+(firstPartitions.get(list)?.gap||0)+(extra?(extra.direct?extra.stocks.length*18:18+(view.expandedUnpromoted.has(extra.key)?extra.stocks.length*18:0)):0);};
    // A failed stock has one owner: its attempted board tier. First-board
    // fallback is only for records whose previous board is unknown.
    const advancingThemes=new Set((fullData.sealedStocks||allSealed).filter(node=>node.status==='sealed'&&node.board>1).map(node=>node.date+':'+node.theme)),failedByDay=new Map();
    for(const stock of (view.stockOnly?data:fullData).unpromotedStocks||[]){if(ladderFailedLevel(stock)!==1)continue;if(compactThemes.size&&!compactThemes.has(stock.theme))continue;if(!days.includes(stock.date)||minBoard&&!boardThemes.has(stock.theme)||advancingThemes.has(stock.date+':'+stock.theme)||firstGroups.has(stock.date+':'+stock.theme))continue;if(!failedByDay.has(stock.date))failedByDay.set(stock.date,new Map());const topics=failedByDay.get(stock.date);if(!topics.has(stock.theme))topics.set(stock.theme,new Map());topics.get(stock.theme).set(stock.code,stock);}
    const failedTopicLists=new Map([...failedByDay].map(([day,topics])=>[day,[...topics].map(([theme,stocks])=>({theme,stocks:[...stocks.values()].sort(compareLadderFailedPct)})).sort((a,b)=>b.stocks.length-a.stocks.length||a.theme.localeCompare(b.theme,'zh-CN'))]));
    const brokenTopicLists=new Map();for(const stock of data.brokenStocks||[]){if(!days.includes(stock.date))continue;if(!brokenTopicLists.has(stock.date))brokenTopicLists.set(stock.date,new Map());const groups=brokenTopicLists.get(stock.date);if(!groups.has(stock.theme))groups.set(stock.theme,[]);groups.get(stock.theme).push(stock);}
    for(const [day,groups] of brokenTopicLists)brokenTopicLists.set(day,[...groups].map(([theme,stocks])=>({theme,stocks:stocks.sort((a,b)=>(a.time||'99').localeCompare(b.time||'99'))})).sort((a,b)=>b.stocks.length-a.stocks.length||a.theme.localeCompare(b.theme,'zh-CN')));
    const sealedThemeDays=new Set((fullData.sealedStocks||[]).filter(stock=>stock.status==='sealed'&&!['','暂无题材','暂无数据','未分类'].includes(stock.theme)).map(stock=>stock.date+':'+stock.theme)),brokenStandaloneTopics=new Map();
    for(const [day,topics] of brokenTopicLists){const standalone=topic=>sealedThemeDays.has(day+':'+topic.theme)||topic.stocks.some(stock=>restartBrokenSources.has(stock.id));brokenStandaloneTopics.set(day,topics.filter(standalone));brokenTopicLists.set(day,topics.filter(topic=>!standalone(topic)));}
    const brokenCardHeight=topic=>Math.max(25,topic.stocks.length*20+6);
    function appendBrokenTopic(col,cardY,topic){
      const y=0,cardStart=chips.length;
      const color=themeColor(topic.theme),x=col.x+col.width-18-labelWidth,h=brokenCardHeight(topic),contentLeft=x+(labelWidth-themeSlot-3-stockSlot)/2,circleX=contentLeft+themeSlot+10,groupId=col.day+':0:broken:'+topic.theme;positions.set(groupId,{x,y:cardY,row:rows.find(row=>row.level===0),width:labelWidth,height:h,day:col.day,theme:topic.theme,inletX:x-10,inletY:cardY+h/2});
      chips.push(`<g data-vl-broken-theme-card="${esc(col.day+':'+topic.theme)}" data-vl-colored-theme="${esc(topic.theme)}" data-vl-focus-theme="${esc(topic.theme)}" style="--ladder-theme-color:${color}"><rect class="vl-group-box" data-vl-box-theme="${esc(topic.theme)}" x="${x}" y="${y}" width="${labelWidth}" height="${h}" rx="5" fill="var(--paper)" stroke="var(--ladder-theme-color)" stroke-opacity=".4" stroke-width=".65"/><g class="vl-inlet" data-vl-focus-theme="${esc(topic.theme)}"><title>${esc(topic.theme)} · ${topic.stocks.length}只首板破板股</title><circle cx="${x-10}" cy="${y+h/2}" r="10" fill="var(--paper)" stroke="#8c9299" stroke-width=".8"/><text x="${x-10}" y="${y+h/2+2}" text-anchor="middle" fill="#747b83" style="font:6.5px var(--mono)">${topic.stocks.length}</text></g><text x="${contentLeft+themeSlot}" y="${y+h/2+2.8}" text-anchor="end" class="vl-inline-theme" role="link" tabindex="0" data-vl-topic="${esc(topic.theme)}" data-vl-topic-date="${col.day}" aria-label="${esc(topic.theme)} · ${fmtDate(col.day)} · 单击聚焦题材，双击或回车进入题材页面" fill="var(--ladder-theme-color)">${esc(topic.theme)}</text>`);
      topic.stocks.forEach((stock,index)=>{const rowY=y+3+index*20;points.set(stock.id,{x:circleX-7,y:cardY+rowY+9,group:groupId,row:rows.find(row=>row.level===0)});const label=stock.name+' '+stock.code+' · '+fmtDate(stock.date)+' · '+topic.theme+' · 破板';chips.push(`<g class="vl-stock" data-vl-node="${esc(stock.id)}"><title>${esc(label)}</title><rect x="${circleX-8}" y="${rowY}" width="${x+labelWidth-circleX+6}" height="18" rx="3" fill="transparent"/><circle cx="${circleX}" cy="${rowY+9}" r="7" fill="var(--ladder-theme-color)" fill-opacity=".22" stroke="#b28766" stroke-width="1.1"/><text x="${circleX}" y="${rowY+11.5}" text-anchor="middle" fill="var(--ladder-theme-color)" style="font:7px var(--sans)">破</text><text x="${circleX+9}" y="${rowY+12}" class="vl-name${isLadderGrowthStock(stock.code)?' vl-growth-name':''}" role="link" tabindex="0" data-vl-broken-link="${esc(stock.id)}" aria-label="${esc(label)} · 单击聚焦该股（保持布局），双击或回车进入个股页面">${ladderStockName(stock)}</text></g>`);});chips.push('</g>');retainLadderCard(chips,cardStart,groupId,cardY,previousCards,nextCards,view);
    }
    const higherFailedTopics=new Map();
    for(const stock of data.unpromotedStocks||[]){const level=ladderFailedLevel(stock);if(level<2||!days.includes(stock.date)||higherGroups.has(stock.date+':'+level+':'+stock.theme))continue;const key=stock.date+':'+level;if(!higherFailedTopics.has(key))higherFailedTopics.set(key,new Map());const topics=higherFailedTopics.get(key);if(!topics.has(stock.theme))topics.set(stock.theme,[]);topics.get(stock.theme).push(stock);}
    for(const [key,groups] of higherFailedTopics)higherFailedTopics.set(key,[...groups].map(([theme,stocks])=>({theme,stocks:stocks.sort(compareLadderFailedPct)})).sort((a,b)=>b.stocks.length-a.stocks.length||a.theme.localeCompare(b.theme,'zh-CN')));
    const failedKey=(day,broken=false,level=1)=>day+(level>=2?':'+level+':failed-themes':broken?':broken-themes':':failed-themes');
    const failedTopics=(day,broken,level)=>(level>=2?higherFailedTopics.get(day+':'+level):(broken?brokenTopicLists:failedTopicLists).get(day))||[];
    view.aggregateInitialized||=new Set();for(const [broken,lists] of [[false,failedTopicLists],[true,brokenTopicLists]])for(const day of lists.keys())initializeLadderSummary(view,failedKey(day,broken),day,broken?'broken':'other',broken?view.foldBreakThemes:view.foldOtherThemes,compactLayout);
    for(const key of higherFailedTopics.keys()){const [day,rawLevel]=key.split(':'),level=Number(rawLevel);initializeLadderSummary(view,failedKey(day,false,level),day,level===2?'second':'higher',level===2?view.foldSecondFailed:view.foldHigherFailed,compactLayout);}
    const failedHeight=(day,broken=false,level=1)=>{const topics=failedTopics(day,broken,level);return topics.length?26+(view.expandedUnpromoted.has(failedKey(day,broken,level))?4+topics.reduce((sum,topic)=>sum+Math.max(18,topic.stocks.length*18)+6,0):0):0;};
    function appendFailedTopics(col,cardY,broken=false,level=1){
      const y=0,cardStart=chips.length;
      const topics=failedTopics(col.day,broken,level);if(!topics.length)return;
      const expanded=view.expandedUnpromoted.has(failedKey(col.day,broken,level)),stockWidth=Math.max(32,...topics.flatMap(topic=>topic.stocks.map(stockLabelWidth))),themeWidth=Math.max(0,...topics.map(topic=>textWidth(topic.theme,7.2)))+17,w=expanded?Math.min(column-48,Math.max(labelWidth,themeWidth+3+stockWidth+8)):labelWidth,h=failedHeight(col.day,broken,level),x=col.x+col.width-18-w,headerY=y+13,count=topics.length,stockCount=topics.reduce((sum,topic)=>sum+topic.stocks.length,0),color='#8c9299',headerCircle=x+(w-(level>=2?44:52))/2+8,title=`${fmtDate(col.day)} · ${stockCount}只股票 / ${count}个${level>=2?'未晋级题材':broken?'破板题材':'其他题材'} · ${expanded?'收起':'展开'}`;
      chips.push(`<g data-vl-aggregate-themes="${esc(JSON.stringify(topics.map(topic=>topic.theme)))}" data-vl-failed-summary="${col.day}" data-vl-aggregate-level="${level}" data-vl-aggregate-kind="${broken?'broken':'other'}"><rect class="vl-group-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="var(--paper)" stroke="${color}" stroke-opacity=".5" stroke-width=".65"/><g class="vl-stock" role="button" tabindex="0" aria-label="${esc(title)}" aria-expanded="${expanded}" data-vl-unpromoted-toggle="${failedKey(col.day,broken,level)}"><title>${esc(title)}</title><rect x="${x+2}" y="${y+2}" width="${w-4}" height="22" rx="3" fill="transparent"/><circle cx="${headerCircle}" cy="${headerY}" r="8.5" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width=".7"/><line x1="${headerCircle-5}" y1="${headerY+5}" x2="${headerCircle+5}" y2="${headerY-5}" stroke="#747b83" stroke-width=".6"/><text x="${headerCircle-3.3}" y="${headerY-1}" text-anchor="middle" fill="#747b83" style="font:${stockCount>99?4.7:5.5}px var(--mono)">${stockCount}</text><text x="${headerCircle+3.3}" y="${headerY+5}" text-anchor="middle" fill="#747b83" style="font:${count>99?4.7:5.5}px var(--mono)">${count}</text><text x="${headerCircle+11}" y="${headerY+2.8}" fill="var(--ink)" style="font:8px var(--sans)">${level>=2?'未晋级':'其他题材'}</text></g>`);
      if(expanded){
        chips.push(`<line x1="${x+4}" x2="${x+w-4}" y1="${y+26}" y2="${y+26}" stroke="${color}" stroke-opacity=".25" stroke-width=".5"/>`);
        const themeArea=Math.max(30,w-stockWidth-8),nameWidth=Math.max(8,themeArea-17),nameX=x+18,stockCircle=x+themeArea+8;let rowY=y+30;
        for(const topic of topics){const topicHeight=Math.max(18,topic.stocks.length*18),mid=rowY+topicHeight/2,themeColorValue=themeColor(topic.theme);let name=topic.theme;while(name.length>1&&textWidth(name,7.2)>nameWidth)name=name.slice(0,-1);if(name!==topic.theme)name=name.slice(0,-1)+'…';
          chips.push(`<g data-vl-aggregate-theme="${esc(topic.theme)}"><title>${esc(topic.theme)} · ${broken?'冲击首板失败':'昨日涨停、今日未晋级'}${topic.stocks.length}</title><circle cx="${x+9}" cy="${mid}" r="6.5" fill="${themeColorValue}" fill-opacity=".22" stroke="${themeColorValue}" stroke-width=".6"/><text x="${x+9}" y="${mid+2.5}" text-anchor="middle" fill="${themeColorValue}" style="font:7px var(--mono)">${topic.stocks.length}</text><text x="${nameX}" y="${mid+2.6}" class="vl-inline-theme" role="link" tabindex="0" data-vl-topic="${esc(topic.theme)}" data-vl-topic-date="${col.day}" aria-label="${esc(topic.theme)} · ${fmtDate(col.day)} · 单击聚焦题材，双击或回车进入题材页面" fill="${themeColorValue}">${esc(name)}</text>`);
          topic.stocks.forEach((stock,index)=>{const sy=rowY+index*18,shade=broken||stock.touchedLimit?'#b28766':'#9caaa4',label=`${stock.name} ${stock.code} · ${fmtDate(stock.date)} · ${topic.theme} · ${broken?'破板':'未晋级'}`;
            chips.push(`<g class="vl-stock" data-vl-node="${esc(stock.id)}"><title>${esc(label)}</title><rect x="${stockCircle-7}" y="${sy}" width="${x+w-stockCircle+5}" height="18" rx="3" fill="transparent"/><circle data-vl-unpromoted-badge="${esc(stock.id)}" cx="${stockCircle}" cy="${sy+9}" r="6" fill="${themeColorValue}" fill-opacity=".22" stroke="${shade}" stroke-width=".6"/><text x="${stockCircle}" y="${sy+11.4}" text-anchor="middle" fill="${themeColorValue}" style="font:7px var(--sans)">${stockOutcomeBadgeText(stock,broken)}</text><text x="${stockCircle+8}" y="${sy+12}" class="vl-name${isLadderGrowthStock(stock.code)?' vl-growth-name':''}" role="link" tabindex="0" ${broken?'data-vl-broken-link':'data-vl-unpromoted-link'}="${esc(stock.id)}" aria-label="${esc(label)} · 单击聚焦该股（保持布局），双击或回车进入个股页面">${ladderStockName(stock)}</text></g>`);
          });chips.push(`</g>`);rowY+=topicHeight+6;
        }
      }
      chips.push(`</g>`);retainLadderCard(chips,cardStart,failedKey(col.day,broken,level),cardY,previousCards,nextCards,view);
    }

    const countSealed=(view.stockOnly?fullData.sealedStocks:data.sealedStocks)||sealedNodes;const groupCounts=new Map();for(const node of countSealed){if(node.status!=='sealed')continue;const key=node.date+':'+Math.min(node.board,5)+':'+node.theme;groupCounts.set(key,(groupCounts.get(key)||0)+1);}
    const actualCountIds=new Set(countSealed.map(node=>node.date+':'+node.code));
    const carriedCountIds=new Set(),suspensionCounts=new Map();
    for(const carry of data.suspensionCarry||[]){const identity=carry.date+':'+carry.code;if(actualCountIds.has(identity)||carriedCountIds.has(identity))continue;carriedCountIds.add(identity);const key=carry.date+':'+Math.min(carry.board,5)+':'+carry.theme;suspensionCounts.set(key,(suspensionCounts.get(key)||0)+1);}
    const promotedTargets=new Map(data.links.filter(edge=>edge.status==='promoted').map(edge=>[edge.source,edge.target])),nodesById=new Map([...data.nodes,...(data.brokenStocks||[])].map(node=>[node.id,node]));
    const nextDayByDate=new Map(days.map(day=>[day,state.dates[state.dates.indexOf(day)+1]])),allSealedById=new Map((fullData.sealedStocks||[]).map(node=>[node.id,node])),nextFailedBySource=new Map((fullData.unpromotedStocks||[]).map(stock=>[stock.sourceId,stock]));
    const firstOutcome=node=>{
      const next=nextDayByDate.get(node.date);if(!next||next>view.endDay||!days.includes(next))return 'unknown';
      const target=allSealedById.get(next+':'+node.code);if(target&&target.board>=2)return 'promoted';
      return nextFailedBySource.get(node.id)?.date===next?'failed':'unknown';
    };
    const hasPromotion=items=>items.some(node=>promotedTargets.has(node.id)),nextOrder=new Map();
    const outgoingKind=new Map(data.links.filter(edge=>edge.status==='promoted').map(edge=>[edge.source,({continuous:0,suspension:1,broken:2})[edge.kind||'continuous']]));
    const targetOrder=node=>nextOrder.get(promotedTargets.get(node.id))??Number.MAX_SAFE_INTEGER;
    // Work backwards so every source uses its destination's final visual order.
    for(const day of [...days].reverse()){
      for(const level of levels){
        const byTheme=sealedByTier.get(day+':'+level)||new Map();
        const list=[...byTheme],destination=items=>Math.min(...items.map(targetOrder));
        const highestBoard=items=>Math.max(...items.map(node=>node.board));
        list.sort((a,b)=>(level===5?highestBoard(b[1])-highestBoard(a[1]):0)||Number(hasPromotion(b[1]))-Number(hasPromotion(a[1]))||destination(a[1])-destination(b[1])||(rank.get(a[0])??999)-(rank.get(b[0])??999));
        for(const [,items] of list){
          items.sort((a,b)=>{
            if(level===1){const af=firstOutcome(a)==='failed',bf=firstOutcome(b)==='failed';if(af!==bf)return Number(af)-Number(bf);if(af&&bf)return compareLadderFailedPct(a,b);}
            return Number(promotedTargets.has(b.id))-Number(promotedTargets.has(a.id))||(outgoingKind.get(a.id)??3)-(outgoingKind.get(b.id)??3)||targetOrder(a)-targetOrder(b)||b.board-a.board||(a.time||'99').localeCompare(b.time||'99')||a.name.localeCompare(b.name,'zh-CN');
          });
          if(level===1){const start=items.findIndex(node=>firstOutcome(node)==='failed');if(start>=0)firstPartitions.set(items,{start,gap:14,failed:items.slice(start)});}
        }
        if(level>=1)for(const [theme,items] of list){const key=day+':'+level+':'+theme,stocks=unpromotedGroups.get(key);if(stocks?.length){groupExtras.set(items,{key,stocks,direct:false});initializeLadderSummary(view,key,day,level>=3?'higher':level===2?'second':'other',level>=3?view.foldHigherFailed:level===2?view.foldSecondFailed:view.foldOtherThemes,compactLayout);}}
        groups.set(day+':'+level,list);
      }
      let order=0;for(const level of levels)for(const [,items] of groups.get(day+':'+level))for(const node of items)nextOrder.set(node.id,order++);
    }
    if(view.expandOnCompact){for(const key of view.aggregateInitialized)view.expandedUnpromoted.add(key);for(const key of unpromotedGroups.keys())view.expandedUnpromoted.add(key);view.foldOtherThemes=false;view.foldBreakThemes=false;view.foldSecondFailed=false;view.foldHigherFailed=false;view.expandOnCompact=false;}
    const rowPadding=compactLayout?6:12,groupGap=compactLayout?5:9;let yy=compactLayout?4:8;
    for(const level of levels){let rowHeight=compactLayout?36:70;for(const col of columns.filter(col=>filterDays.has(col.day))){const list=groups.get(col.day+':'+level),lanes=1;let h=rowPadding;for(let i=0;i<list.length;i+=lanes)h+=Math.max(...list.slice(i,i+lanes).map(g=>groupHeight(g[1])))+groupGap;if(level>=2&&failedHeight(col.day,false,level))h+=failedHeight(col.day,false,level)+groupGap;if(level===0)h+=(brokenStandaloneTopics.get(col.day)||[]).reduce((sum,topic)=>sum+brokenCardHeight(topic)+groupGap,0);if((level===1||level===0)&&failedHeight(col.day,level===0))h+=failedHeight(col.day,level===0)+groupGap;rowHeight=Math.max(rowHeight,h+(compactLayout?8:24));}rows.push({level,y:yy,height:rowHeight});yy+=rowHeight;}
    markPaint('data');
    const rowClip=level=>`url(#vl-row-clip-${view.id}-${level})`;
    for(const row of rows){chips.push(`<g clip-path="${rowClip(row.level)}">`);background.push(`<line x1="${left}" x2="${width}" y1="${row.y}" y2="${row.y}" class="ladder-grid"/>`);
      for(const col of columns){const list=groups.get(col.day+':'+row.level),lanes=1;let y=row.y+rowPadding;
        for(let i=0;i<list.length;i+=lanes){const pair=list.slice(i,i+lanes),height=Math.max(...pair.map(g=>groupHeight(g[1])));
          const cardY=y;pair.forEach(([theme,items])=>{const y=0,cardStart=chips.length,x=col.x+col.width-18-labelWidth,h=groupHeight(items),baseHeight=Math.max(25,items.length*20+6)+(firstPartitions.get(items)?.gap||0),partition=firstPartitions.get(items),extra=groupExtras.get(items),color=themeColor(theme),id=col.day+':'+row.level+':'+theme,contentLeft=x+(labelWidth-themeSlot-3-stockSlot)/2;
            const hasContinuation=items.length>1&&items.some(node=>continuationTargets.has(node.id)),cardInset=hasContinuation?15:0,cardX=x-cardInset,cardWidth=labelWidth+cardInset,inletX=cardX-10,inletY=y+baseHeight/2,count=groupCounts.get(id)??0,previousDay=data.previousDates?.[col.day]||state.dates[state.dates.indexOf(col.day)-1],previousLevel=row.level-1;
            const previousCount=level=>{const key=previousDay+':'+level+':'+theme;return (groupCounts.get(key)||0)+(suspensionCounts.get(key)||0);},denominator=row.level===1?null:row.level===5?previousCount(4)+previousCount(5):previousCount(previousLevel),ratio=row.level===1?String(count):count+'/'+denominator,countLabel=row.level===1?`${fmtDate(col.day)} · ${theme} · 首板 ${count}`:`${fmtDate(col.day)} · ${theme} · ${row.level===5?'高板':row.level+'板'} ${count} / ${fmtDate(previousDay)} ${row.level===5?'四板及以上':previousLevel+'板'} ${denominator}`;

            const suspendedCount=row.level===1?0:row.level===5?(suspensionCounts.get(previousDay+':4:'+theme)||0)+(suspensionCounts.get(previousDay+':5:'+theme)||0):(suspensionCounts.get(previousDay+':'+previousLevel+':'+theme)||0),inletLabel=countLabel+(suspendedCount?'（含停牌保留'+suspendedCount+'）':'');
            positions.set(id,{x:cardX,y:cardY,row,width:cardWidth,height:h,day:col.day,theme,items,col,inletX,inletY:cardY+inletY});
            chips.push(`<g data-vl-colored-theme="${esc(theme)}" data-vl-focus-theme="${esc(theme)}" style="--ladder-theme-color:${color}"><rect class="vl-group-box" data-vl-box-theme="${esc(theme)}" data-vl-ids="${items.map(node=>esc(node.id)).join('|')}" x="${cardX}" y="${y}" width="${cardWidth}" height="${h}" rx="5" fill="var(--paper)" stroke="var(--ladder-theme-color)" stroke-opacity=".4" stroke-width=".65"/>`);
            const inlet=ladderContinuationInlet(items,continuationTargets,ratio,color),isContinuation=inlet.continuation,inletTitle=inletLabel+(isContinuation?' · 续接入口':'');
            chips.push(`<g class="vl-inlet"${isContinuation?` data-vl-relimit-entry="${esc(items[0].id)}" data-vl-ids="${esc(items[0].id)}" data-vl-outcome="relimit-entry"`:''} data-vl-focus-theme="${esc(theme)}" role="button" tabindex="0" aria-label="${esc(inletTitle)}"><title>${esc(inletTitle)}</title><circle cx="${inletX}" cy="${inletY}" r="10" fill="var(--paper)" stroke="${inlet.stroke}" stroke-width=".8"/><text x="${inletX}" y="${inletY+2}" text-anchor="middle" fill="${inlet.ink}" style="font:${ratio.length>5?4.7:ratio.length>4?5.8:6.5}px var(--mono)">${esc(inlet.label)}</text></g>`);

            chips.push(`<text x="${contentLeft+themeSlot}" y="${y+baseHeight/2+2.8}" text-anchor="end" class="vl-inline-theme" role="link" tabindex="0" data-vl-topic="${esc(theme)}" data-vl-topic-date="${col.day}" aria-label="${esc(theme)} · ${fmtDate(col.day)} · 单击聚焦题材，双击或回车进入题材页面" fill="var(--ladder-theme-color)">${esc(theme)}</text>`);
            items.forEach((node,j)=>{const badgeStyle=ladderBoardBadgeStyle(node),ny=y+3+j*20+(partition&&j>=partition.start?partition.gap:0),badgeX=contentLeft+themeSlot+3+7,label=`${node.name} ${node.code} · ${fmtDate(node.date)} · ${theme} · ${esc(node.boardPeriod||node.board+'板')}${badgeStyle.label?' · '+badgeStyle.label:''}${node.representative?' · 首板 '+node.firstCount+'：'+node.members.map(m=>m.name).join('、'):''}`;
              nodeGroup.set(node.id,id);points.set(node.id,{x:badgeX-7,y:cardY+ny+9,width:x+labelWidth-badgeX+3,group:id,row});
              const multi=node.patternDays>node.board,badge=multi?`<path d="M${badgeX-3.8},${ny+12.8} L${badgeX+3.8},${ny+5.2}" stroke="var(--ladder-theme-color)" stroke-width=".5"/><text x="${badgeX-2.6}" y="${ny+7.7}" text-anchor="middle" fill="var(--ladder-theme-color)" style="font:5.4px var(--mono)">${node.board}</text><text x="${badgeX+2.6}" y="${ny+13}" text-anchor="middle" fill="var(--ladder-theme-color)" style="font:5.4px var(--mono)">${node.patternDays}</text>`:`<text x="${badgeX}" y="${ny+11.6}" text-anchor="middle" class="vl-board" fill="var(--ladder-theme-color)">${node.board}</text>`;
              const text=`<g class="vl-stock-board-badge" data-board-style="${badgeStyle.kind}" style="--ladder-badge-color:${badgeStyle.color}">${node.board===1&&restartTargets.has(node.id)?`<rect data-vl-relimit-badge="${esc(node.id)}" x="${badgeX-7}" y="${ny+2}" width="14" height="14" rx=".5"`:`<circle cx="${badgeX}" cy="${ny+9}" r="7"`} fill="var(--ladder-theme-color)" fill-opacity=".22" stroke="var(--ladder-badge-color)" stroke-width="${badgeStyle.kind==='normal'?.6:1.1}"${badgeStyle.dashed?' stroke-dasharray="2 1.4"':''}/>${badge}</g><text x="${badgeX+9}" y="${ny+12}" class="vl-name${isLadderGrowthStock(node.code)?' vl-growth-name':''}" role="link" tabindex="0" data-vl-stock-link="${esc(node.id)}" aria-label="${esc(label)} · 单击聚焦该股（保持布局），双击或回车进入个股页面">${ladderStockName(node)}</text>`;

              chips.push(`<g class="vl-stock" data-vl-node="${esc(node.id)}"${node.board===1?` data-vl-next-outcome="${firstOutcome(node)}"`:''} aria-label="${esc(label)}"><title>${esc(label)}</title><rect x="${badgeX-8}" y="${ny}" width="${x+labelWidth-badgeX+6}" height="18" rx="3" fill="transparent"/>${text}</g>`);
            });
            if(partition){
              const splitY=y+3+partition.start*20+partition.gap/2,ids=partition.failed.map(node=>node.id).join('|'),next=nextDayByDate.get(col.day),description=`${theme} · ${fmtDate(col.day)}首板 · ${fmtDate(next)}${view.live?.date===next?'暂未晋级':'未晋级'} ${partition.failed.length}只`;
              if(partition.start>0)chips.push(`<line data-vl-first-divider="${esc(id)}" x1="${contentLeft+themeSlot+2}" x2="${cardX+cardWidth-4}" y1="${splitY}" y2="${splitY}" stroke="var(--ladder-theme-color)" stroke-opacity=".5" stroke-width=".7"/>`);
              const crossX=cardX+cardWidth+5.5,crossY=cardY+splitY;
              markers.push(`<g clip-path="${rowClip(row.level)}" role="img" data-vl-first-failed-group="${esc(id)}" data-vl-outcome="first-failed" data-vl-ids="${esc(ids)}" data-vl-focus-theme="${esc(theme)}" aria-label="${esc(description)}"><title>${esc(description)}</title><circle cx="${crossX}" cy="${crossY}" r="5.5" fill="#c44f49" fill-opacity=".12" stroke="#c44f49" stroke-width="1"/><text x="${crossX}" y="${crossY+2.5}" text-anchor="middle" fill="#c44f49" style="font:10px var(--sans)">×</text></g>`);
            }
            if(extra){
              const footerY=y+baseHeight,badgeX=contentLeft+themeSlot+3+7,expanded=view.expandedUnpromoted.has(extra.key),summary=`${fmtDate(col.day)} · ${theme} · ${extra.stocks.length}只未晋级 · ${expanded?'收起':'展开'}`;
              if(!extra.direct)chips.push(`<line x1="${x+4}" x2="${x+labelWidth-4}" y1="${footerY}" y2="${footerY}" stroke="var(--ladder-theme-color)" stroke-opacity=".18" stroke-width=".5"/><g class="vl-stock vl-unpromoted-toggle" role="button" tabindex="0" aria-label="${esc(summary)}" aria-expanded="${expanded}" data-vl-unpromoted-toggle="${esc(extra.key)}"><title>${esc(summary)}</title><rect x="${badgeX-8}" y="${footerY}" width="${x+labelWidth-badgeX+6}" height="18" rx="3" fill="transparent"/><circle cx="${badgeX}" cy="${footerY+9}" r="6.5" fill="var(--ladder-theme-color)" fill-opacity=".22" stroke="#9caaa4" stroke-width=".7"/><text x="${badgeX}" y="${footerY+11.7}" text-anchor="middle" fill="var(--ladder-theme-color)" style="font:${extra.stocks.length>99?6:7.5}px var(--mono)">${extra.stocks.length}</text><text x="${badgeX+9}" y="${footerY+12}" fill="var(--muted)" style="font:8px var(--sans)">未晋级</text></g>`);
              if(extra.direct||expanded)extra.stocks.forEach((stock,index)=>{const rowY=footerY+(extra.direct?0:18)+index*18,circleX=badgeX,color=stock.touchedLimit?'#b28766':'#9caaa4',label=`${stock.name} ${stock.code} · ${fmtDate(stock.date)} · 未晋级 · 昨日${stock.previousBoardPeriod||stock.previousBoard+'板'}`;
                chips.push(`<g class="vl-stock" data-vl-node="${esc(stock.id)}" aria-label="${esc(label)}"><title>${esc(label)}</title><rect x="${circleX-8}" y="${rowY}" width="${x+labelWidth-circleX+6}" height="18" rx="3" fill="transparent"/><circle data-vl-unpromoted-badge="${esc(stock.id)}" cx="${circleX}" cy="${rowY+9}" r="6" fill="var(--ladder-theme-color)" fill-opacity=".22" stroke="${color}" stroke-width=".6"/><text x="${circleX}" y="${rowY+11.5}" text-anchor="middle" fill="var(--ladder-theme-color)" style="font:7px var(--sans)">${stockOutcomeBadgeText(stock)}</text><text x="${circleX+9}" y="${rowY+12}" class="vl-name${isLadderGrowthStock(stock.code)?' vl-growth-name':''}" role="link" tabindex="0" data-vl-unpromoted-link="${esc(stock.id)}" aria-label="${esc(label)} · 单击聚焦该股（保持布局），双击或回车进入个股页面">${ladderStockName(stock)}</text></g>`);
              });
            }
            chips.push(`</g>`);retainLadderCard(chips,cardStart,id,cardY,previousCards,nextCards,view);
          });y+=height+groupGap;
        }
        if(row.level>=2)appendFailedTopics(col,y,false,row.level);
        if(row.level===0)for(const topic of brokenStandaloneTopics.get(col.day)||[]){appendBrokenTopic(col,y,topic);y+=brokenCardHeight(topic)+groupGap;}
        if(row.level===1||row.level===0)appendFailedTopics(col,y,row.level===0);
      }
      chips.push('</g>');
    }
    const bundles=new Map(),outcomes=[],exits=new Map();
    for(const edge of data.links){if(!points.has(edge.source))continue;if(edge.status!=='promoted'){outcomes.push(edge);continue;}const a=nodeGroup.get(edge.source),b=nodeGroup.get(edge.target);if(!b)continue;const kind=edge.kind||'continuous',portKey=ladderPromotionPortKey(a,edge),key=portKey+'|'+b;if(!bundles.has(key))bundles.set(key,{a,b,kind,portKey,edges:[]});bundles.get(key).edges.push(edge);if(!exits.has(portKey))exits.set(portKey,{group:a,kind,edges:[]});exits.get(portKey).edges.push(edge);}
    for(const [key,exit] of exits){const group=positions.get(exit.group),ys=exit.edges.map(edge=>points.get(edge.source).y),x=group.x+group.width+5.5,y=(Math.min(...ys)+Math.max(...ys))/2,color=exit.kind==='continuous'?'#3b956a':exit.kind==='suspension'?'#b18c49':'#b66b43',names=exit.edges.map(edge=>nodesById.get(edge.source).name).join('、'),description=`${group.theme} · ${exit.kind==='continuous'?'晋级':exit.kind==='suspension'?'停牌跨日晋级':'断板后晋级'}${exit.edges.length}：${names}`,ids=exit.edges.flatMap(edge=>[edge.source,edge.target]).join('|');exit.x=x;exit.y=y;
      const symbol=exit.kind==='continuous'?`<path d="M${x-2.8},${y} L${x-.7},${y+2.1} L${x+2.9},${y-2.5}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`:`<text x="${x}" y="${y+2.5}" text-anchor="middle" fill="${color}" style="font:7px var(--sans)">${exit.kind==='suspension'?'停':'断'}</text>`;
      markers.push(`<g clip-path="${rowClip(group.row.level)}" role="img" data-vl-colored-theme="${esc(group.theme)}" style="--ladder-theme-color:${themeColor(group.theme)}" data-vl-ids="${ids}" data-vl-outcome="${exit.kind}" data-vl-focus-theme="${esc(group.theme)}" tabindex="0" aria-label="${esc(description)}"><title>${esc(description)}</title><circle cx="${x}" cy="${y}" r="5.5" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="1"/>${symbol}</g>`);
    }
    for(const edge of outcomes){const point=points.get(edge.source),group=positions.get(point.group),x=group.x+group.width+5.5,y=point.y,target=nodesById.get(edge.target),color=edge.status==='failed'?'#c44f49':'#b18c49',description=edge.status==='failed'?'未晋级，路径终止':edge.status==='paused'?'停牌中，等待复牌':'待确认';markers.push(`<g clip-path="${rowClip(point.row.level)}" role="button" tabindex="0" class="vl-stock" data-vl-colored-theme="${esc(group.theme)}" style="--ladder-theme-color:${themeColor(group.theme)}" data-vl-node="${edge.target}" data-vl-outcome="${edge.status}" data-vl-focus-theme="${esc(group.theme)}" aria-label="${esc(target?.name)} ${target?.date} · ${description}"><title>${esc(target?.name)} · ${description}</title><circle cx="${x}" cy="${y}" r="5.5" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="1"/><text x="${x}" y="${y+2.5}" text-anchor="middle" fill="${color}" style="font:${edge.status==='paused'?7:10}px var(--sans)">${edge.status==='failed'?'×':edge.status==='paused'?'停':'·'}</text></g>`);}
    for(const bundle of bundles.values()){
      const a=positions.get(bundle.a),b=positions.get(bundle.b),exit=exits.get(bundle.portKey),edge=bundle.edges[0],recovery=bundle.kind!=='continuous',target=points.get(edge.target),singleEntry=b.items?.length===1,entryX=singleEntry?b.inletX:b.x+5.5,sx=exit.x+5.5,sy=exit.y,tx=recovery?entryX-(singleEntry?10:5.5):b.inletX-10,ty=recovery?(singleEntry?b.inletY:target.y):b.inletY,color=themeColor(a.theme),ids=bundle.edges.flatMap(e=>[e.source,e.target]).join('|'),description=bundle.kind==='suspension'?'停牌后复牌晋级':recovery?'断板后晋级':'晋级'+bundle.edges.length,title=`${esc(a.theme)} → ${esc(b.theme)} · ${description}：${bundle.edges.map(e=>esc(nodesById.get(e.source).name)).join('、')}`,bend=Math.max(8,Math.min(70,(tx-sx)*.45));
      paths.push(`<path class="vl-edge vl-promotion${bundle.kind!=='continuous'?' vl-continuation':''}" data-vl-promotion-kind="${bundle.kind}" data-vl-line-theme="${esc(a.theme)}" data-vl-focus-theme="${esc(a.theme)}" role="button" tabindex="0" data-vl-ids="${ids}" d="M${sx},${sy} C${sx+bend},${sy} ${tx-bend},${ty} ${tx},${ty}" stroke="${color}" fill="none"${bundle.kind!=='continuous'?' stroke-dasharray="2 3"':''}><title>${title}</title></path>`);
      if(recovery)markers.push(ladderContinuationMarkers(edge,nodesById.get(edge.source),nodesById.get(edge.target),{sx,sy,tx,ty,entryX,singleEntry,inletX:b.inletX,inletY:b.inletY},textWidth,`${edge.name}：${fmtDate(edge.failureDate)}${bundle.kind==='suspension'?'停牌':'断板'}，${edge.sessions}个交易日后于${fmtDate(edge.targetDate)}续板涨停`));
    }
    for(const edge of data.relimitLinks||[]){
      const source=points.get(edge.source),target=points.get(edge.target);if(!source||!target)continue;
      const a=positions.get(source.group),b=positions.get(target.group),sx=a.x+a.width+11,sy=source.y,singleEntry=b.items?.length===1,entryX=singleEntry?b.inletX:b.x+5.5,tx=entryX-(singleEntry?10:5.5),ty=singleEntry?b.inletY:target.y,bend=Math.max(16,Math.min(90,(tx-sx)*.35)),node=nodesById.get(edge.target),color=themeColor(node.theme),description=`${edge.name}：${fmtDate(edge.failureDate)}${edge.sourceBoard===0?'破板':'断板'}，${edge.sessions}个交易日后于${fmtDate(edge.targetDate)}再次首板涨停`;
      paths.push(`<path class="vl-edge vl-relimit vl-continuation" data-vl-relimit-source="${esc(edge.source)}" data-vl-relimit-target="${esc(edge.target)}" data-vl-line-theme="${esc(node.theme)}" data-vl-focus-theme="${esc(node.theme)}" data-vl-ids="${esc(edge.source+'|'+edge.target)}" d="M${sx},${sy} C${sx+bend},${sy} ${tx-bend},${ty} ${tx},${ty}" stroke="${color}" stroke-width=".8" stroke-dasharray="2 3" fill="none" role="img" aria-label="${esc(description)}"><title>${esc(description)}</title></path>`);
      if(!data.links.some(link=>link.source===edge.source))markers.push(`<g data-vl-ids="${esc(edge.source+'|'+edge.target)}" data-vl-outcome="relimit" data-vl-focus-theme="${esc(a.theme)}" aria-label="${esc(description)}"><circle cx="${sx-5.5}" cy="${sy}" r="5.5" fill="#c44f49" fill-opacity=".12" stroke="#c44f49" stroke-width="1"/><text x="${sx-5.5}" y="${sy+2.5}" text-anchor="middle" fill="#c44f49" style="font:7px var(--sans)">续</text></g>`);
      markers.push(ladderContinuationMarkers(edge,nodesById.get(edge.source),node,{sx,sy,tx,ty,entryX,singleEntry,inletX:b.inletX,inletY:b.inletY},textWidth,description));
    }
    view.cardMarkupCache=nextCards;
    const painted=Boolean(host.querySelector('svg')),oldLeft=host.scrollLeft;
    const markup=`<div class="vl-board-header" style="width:${width}px"><span class="vl-date-corner">板数</span>${columns.map(c=>`<span class="vl-date-day" role="link" tabindex="0" aria-label="${fmtDate(c.day)} · 每日总览" data-vl-date="${c.day}" style="left:${c.x}px;width:${c.width}px">${c.day.slice(4,6)}/${c.day.slice(6)}</span>`).join('')}</div><div class="vl-date-rail">${rows.map(row=>`<span style="top:${row.y}px;height:${row.height}px">${row.level===5?'高板':row.level===1?'首板':row.level===0?'破板':row.level+'板'}</span>`).join('')}</div><svg role="group" aria-label="${view.stockOnly?'单股紧凑天梯 · '+esc(view.focusedStock):compactThemes.size?esc([...compactThemes].join('、'))+'题材紧凑天梯':'日期横轴、板数纵轴的涨停天梯'}" width="${width}" height="${yy+8}" data-vl-height-days="${esc(JSON.stringify([...filterDays].sort()))}"><defs>${rows.map(row=>`<clipPath id="vl-row-clip-${view.id}-${row.level}"><rect x="0" y="${row.y}" width="${width}" height="${row.height}"/></clipPath>`).join('')}</defs>${background.join('')}${columns.map(c=>`<line x1="${c.x}" x2="${c.x}" y1="0" y2="${yy}" class="ladder-date-grid"/>`).join('')}${paths.join('')}${chips.join('')}${markers.join('')}</svg>`;
    markPaint('markup');
    const previousEdges=new Map([...host.querySelectorAll('.vl-edge')].map(node=>[ladderDOMKey(node),node]));
    if(patchPaint){const template=document.createElement('template');template.innerHTML=markup;const shell=document.createElement('div');shell.append(template.content);for(let i=0;i<shell.childNodes.length;i++){if(host.childNodes[i])patchLadderDOM(host.childNodes[i],shell.childNodes[i]);else host.appendChild(shell.childNodes[i].cloneNode(true));}while(host.childNodes.length>shell.childNodes.length)host.lastChild.remove();}else host.innerHTML=markup;
    const currentEdges=[...host.querySelectorAll('.vl-edge')],retainedEdges=currentEdges.filter(node=>previousEdges.get(ladderDOMKey(node))===node).length;
    host.dataset.svgBuilds=String(Number(host.dataset.svgBuilds||0)+(patchPaint?0:1));host.dataset.retainedEdges=String(retainedEdges);host.dataset.createdEdges=String(currentEdges.length-retainedEdges);host.dataset.removedEdges=String(previousEdges.size-retainedEdges);
    const liveCardTokens=new Set([...nextCards.values()].flatMap(records=>records.map(record=>String(record.token))));for(const token of view.cardDOMCache.keys())if(!liveCardTokens.has(token))view.cardDOMCache.delete(token);
    host.dataset.cardCacheBodies=String([...nextCards.values()].reduce((sum,records)=>sum+records.length,0));host.dataset.cardDomCacheSize=String(view.cardDOMCache.size);
    markPaint('dom');
    host.scrollLeft=painted?oldLeft:host.scrollWidth-host.clientWidth;
    if(view.rowViewportAnchor){const anchor=view.rowViewportAnchor,row=rows.find(row=>row.level===anchor.level);view.rowViewportAnchor=null;if(row)host.scrollTop=28+row.y+Math.min(anchor.offset,Math.max(0,row.height-1));}
    if(!patchPaint)setupLadderDateSlider(host.querySelector('.vl-board-header'),columns);
    markPaint('layout');
    const legend=$('#ladderLegend'),selectedThemes=new Set(compactThemes.size?compactThemes:[view.focusedTheme].filter(Boolean));let navigating=false;
    let stockFocusIndex=null;
    const stockCodeFromId=id=>String(id||'').split(':')[1]||'';
    function stockCodes(element){
      const codes=new Set();
      for(const name of element.querySelectorAll('[data-vl-stock-link],[data-vl-unpromoted-link],[data-vl-broken-link]'))codes.add(stockCodeFromId(name.dataset.vlStockLink||name.dataset.vlUnpromotedLink||name.dataset.vlBrokenLink));
      return codes;
    }
    function applyStockFocus(){
      host.querySelectorAll('.vl-stock-focus-muted,.vl-stock-focus-active,.vl-stock-focus-card,.vl-stock-focus-line').forEach(element=>element.classList.remove('vl-stock-focus-muted','vl-stock-focus-active','vl-stock-focus-card','vl-stock-focus-line'));
      const code=view.focusedStock;if(!code){delete host.dataset.stockFocus;return;}
      if(!stockFocusIndex){
        const names=[...host.querySelectorAll('[data-vl-stock-link],[data-vl-unpromoted-link],[data-vl-broken-link]')],rows=[...new Set(names.map(name=>name.closest('.vl-stock')).filter(Boolean))],cards=[...new Set([...host.querySelectorAll('.vl-group-box')].map(box=>box.parentElement))],topics=[...host.querySelectorAll('[data-vl-aggregate-theme]')];
        const traces=[...host.querySelectorAll('.vl-edge,[data-vl-outcome],[data-vl-relimit-notes]')].map(element=>({element,codes:new Set([...(element.dataset.vlIds||'').split('|'),element.dataset.vlNode,element.dataset.vlRelimitNotes].filter(Boolean).map(stockCodeFromId))}));
        stockFocusIndex={rows:rows.map(element=>({element,codes:stockCodes(element)})),cards:cards.map(element=>({element,codes:stockCodes(element)})),topics:topics.map(element=>({element,codes:stockCodes(element)})),traces};
      }
      // An empty date window does not cancel the user's stock selection.
      host.dataset.stockFocus=code;
      const reveal=element=>{for(let parent=element;parent&&parent!==host;parent=parent.parentElement)parent.classList.remove('ladder-dim');};
      for(const item of stockFocusIndex.cards){const active=item.codes.has(code);item.element.classList.add(active?'vl-stock-focus-card':'vl-stock-focus-muted');if(active)reveal(item.element);}
      for(const item of stockFocusIndex.topics){const active=item.codes.has(code);if(!active)item.element.classList.add('vl-stock-focus-muted');else reveal(item.element);}
      for(const item of stockFocusIndex.rows){const active=item.codes.has(code);item.element.classList.add(active?'vl-stock-focus-active':'vl-stock-focus-muted');if(active)reveal(item.element);}
      for(const item of stockFocusIndex.traces){const active=item.codes.has(code);item.element.classList.add(active?(item.element.classList.contains('vl-edge')?'vl-stock-focus-line':'vl-stock-focus-active'):'vl-stock-focus-muted');if(active)reveal(item.element);}
    }
    function focusStock(code){
      const started=performance.now(),wasStockOnly=view.stockOnly;view.stockOnly=false;view.focusedStock=view.focusedStock===code?'':code;
      if(wasStockOnly){paintLimitupLadder(fullData);view.updateLegend?.();}else applyThemeFocus();host.dataset.stockFocusMs=(performance.now()-started).toFixed(1);
    }
    function focusLegendStock(stock){
      if(view.singleClickTimer){clearTimeout(view.singleClickTimer);view.singleClickTimer=0;}
      if(!compactLayout)view.normalViewport={left:host.scrollLeft,top:host.scrollTop};
      ladderSelectStockPath(view,stock,fullData);paintLimitupLadder(fullData);host.scrollTop=0;view.updateLegend?.();
    }
    function applyThemeFocus(){
      host.querySelectorAll('[data-vl-colored-theme]').forEach(element=>element.classList.toggle('ladder-dim',Boolean(selectedThemes.size&&!selectedThemes.has(element.dataset.vlColoredTheme))));
      host.querySelectorAll('[data-vl-failed-summary]').forEach(element=>element.classList.toggle('ladder-dim',Boolean(selectedThemes.size&&!JSON.parse(element.dataset.vlAggregateThemes||'[]').some(theme=>selectedThemes.has(theme)))));host.querySelectorAll('[data-vl-aggregate-theme]').forEach(element=>element.classList.toggle('ladder-dim',Boolean(selectedThemes.size&&!selectedThemes.has(element.dataset.vlAggregateTheme))));
      host.querySelectorAll('[data-vl-line-theme],[data-vl-outcome]').forEach(element=>element.classList.toggle('ladder-dim',Boolean(selectedThemes.size&&!selectedThemes.has(element.dataset.vlFocusTheme))));
      legend.querySelectorAll('[data-vl-theme]').forEach(button=>button.setAttribute('aria-pressed',String(selectedThemes.has(button.dataset.vlTheme))));
      const detail=$('#ladderDetail');detail.hidden=true;detail.replaceChildren();
      const showAll=$('#ladderShowAll');if(showAll){showAll.hidden=false;showAll.onclick=showAllExpanded;}
      const summaryButton=$('#ladderToggleSummaries'),toggles=[...host.querySelectorAll('[data-vl-unpromoted-toggle]')],allOpen=toggles.length>0&&toggles.every(toggle=>toggle.getAttribute('aria-expanded')==='true');
      if(summaryButton){summaryButton.textContent=allOpen?'收缩':'展开';summaryButton.disabled=!toggles.length;summaryButton.setAttribute('aria-expanded',String(allOpen));summaryButton.setAttribute('aria-label',(allOpen?'收起':'展开')+'全部未晋级和其他题材');summaryButton.onclick=toggleAllSummaries;}
      applyStockFocus();
    }
    function toggleAllSummaries(){
      const toolbarStarted=performance.now();
      const toggles=[...host.querySelectorAll('[data-vl-unpromoted-toggle]')],keys=new Set(toggles.map(toggle=>toggle.dataset.vlUnpromotedToggle)),collapse=toggles.length>0&&toggles.every(toggle=>toggle.getAttribute('aria-expanded')==='true'),top=host.scrollTop;
      view.foldOtherThemes=collapse;view.foldBreakThemes=collapse;view.foldSecondFailed=collapse;view.foldHigherFailed=collapse;view.liveSummaryFolded={other:collapse,broken:collapse,second:collapse,higher:collapse};view.expandOnCompact=false;
      for(const key of keys){if(collapse)view.expandedUnpromoted.delete(key);else view.expandedUnpromoted.add(key);}
      view.patchPaint=true;paintLimitupLadder(fullData);host.scrollTop=top;view.updateLegend?.();host.dataset.toolbarMs=(performance.now()-toolbarStarted).toFixed(1);
    }
    function showAllExpanded(){
      const toolbarStarted=performance.now();
      if(!compactLayout&&!view.focusedStock&&!view.stockOnly&&!view.focusedTheme&&!hiddenLevels.size&&!view.foldOtherThemes&&!view.foldBreakThemes&&!view.foldSecondFailed&&!view.foldHigherFailed&&[...host.querySelectorAll('[data-vl-unpromoted-toggle]')].every(toggle=>toggle.getAttribute('aria-expanded')==='true')){host.dataset.toolbarMs=(performance.now()-toolbarStarted).toFixed(1);return;}
      if(!compactLayout)view.patchPaint=true;
      view.focusedStock='';view.stockOnly=false;
      const left=host.scrollLeft,top=host.scrollTop;
      view.minBoard=0;view.compactTheme='';view.compactThemes=[];view.focusedTheme='';hiddenLevels.clear();view.expandOnCompact=true;
      paintLimitupLadder(fullData);host.scrollLeft=left;host.scrollTop=compactLayout?0:top;view.updateLegend?.();host.dataset.toolbarMs=(performance.now()-toolbarStarted).toFixed(1);
    }
    function restoreAll(){
      view.focusedStock='';view.stockOnly=false;
      view.minBoard=0;view.compactTheme='';view.compactThemes=[];view.focusedTheme='';paintLimitupLadder(fullData);
      if(view.normalViewport){host.scrollLeft=view.normalViewport.left;host.scrollTop=view.normalViewport.top;}view.updateLegend?.();
    }
    function filterBoard(level){
      view.focusedStock='';view.stockOnly=false;
      if(view.minBoard===level&&!view.compactTheme){restoreAll();return;}
      if(!compactLayout)view.normalViewport={left:host.scrollLeft,top:host.scrollTop};
      view.minBoard=level;view.compactTheme='';view.compactThemes=[];view.focusedTheme='';view.expandOnCompact=true;paintLimitupLadder(fullData);host.scrollTop=0;view.updateLegend?.();
    }
    function compactFocus(theme,additive=false,exclusive=false){
      view.focusedStock='';view.stockOnly=false;
      if(view.singleClickTimer){clearTimeout(view.singleClickTimer);view.singleClickTimer=0;}
      const next=new Set(view.compactThemes||[view.compactTheme].filter(Boolean));
      if(exclusive){next.clear();next.add(theme);}
      else if(additive){if(next.has(theme))next.delete(theme);else next.add(theme);}
      else if(next.size===1&&next.has(theme))next.clear();else{next.clear();next.add(theme);}
      if(!compactLayout)view.normalViewport={left:host.scrollLeft,top:host.scrollTop};
      view.minBoard=0;view.compactThemes=[...next];view.compactTheme=view.compactThemes[0]||'';view.focusedTheme='';view.expandOnCompact=Boolean(next.size);
      paintLimitupLadder(fullData);
      if(!next.size&&view.normalViewport){host.scrollLeft=view.normalViewport.left;host.scrollTop=view.normalViewport.top;}
      else host.scrollTop=0;
      view.updateLegend?.();
    }
    async function navigateStock(id,fallback=null){const node=data.nodes.find(item=>item.id===id)||(fullData.sealedStocks||[]).find(item=>item.id===id)||fallback;if(!node||navigating)return;view.returnSnapshot=captureLadderReturn();navigating=true;try{if(needsReviewDate(node.date)&&!await loadDate(node.date))return;await selectStock(node.originalTheme||node.theme,node.code.split('.')[0]);}catch(error){toast(error.message);}finally{navigating=false;}}
    async function navigateTheme(theme,day){if(navigating)return;view.returnSnapshot=captureLadderReturn();navigating=true;try{if(needsReviewDate(day)&&!await loadDate(day))return;if(state.review.topics.some(topic=>topic.name===theme)){await openTopic(theme,day);return;}
      // A promotion chain may have been reassigned to its eventual peak theme.
      const matching=(data.sealedStocks||sealedNodes).filter(node=>(node.originalTheme||node.theme)===theme&&node.date<=view.endDay).sort((a,b)=>Math.abs(Number(a.date)-Number(day))-Math.abs(Number(b.date)-Number(day))||b.date.localeCompare(a.date));
      const fallback=matching[0]?.date;if(fallback&&fallback!==day){await openTopic(theme,fallback);return;}
      syncBrowserRoute('topic',day,theme);renderTopicNoData(theme);renderNav();
    }catch(error){toast(error.message);}finally{navigating=false;}}
    function toggleUnpromoted(key){const top=host.scrollTop;view.patchPaint=true;if(view.expandedUnpromoted.has(key))view.expandedUnpromoted.delete(key);else view.expandedUnpromoted.add(key);paintLimitupLadder(fullData);host.scrollTop=top;view.updateLegend?.();}
    async function navigateUnpromoted(id,fallback=null){const stock=(fullData.unpromotedStocks||[]).find(item=>item.id===id)||fallback;if(!stock||navigating)return;view.returnSnapshot=captureLadderReturn();navigating=true;try{if(needsReviewDate(stock.date)&&!await loadDate(stock.date))return;await selectStock(stock.originalTheme||stock.theme,stock.code.split('.')[0],{outcome:'unpromoted'});}catch(error){toast(error.message);}finally{navigating=false;}}
    async function navigateBroken(stock){if(!stock||navigating)return;view.returnSnapshot=captureLadderReturn();navigating=true;try{if(needsReviewDate(stock.date)&&!await loadDate(stock.date))return;await selectStock(stock.originalTheme||stock.theme,stock.code.split('.')[0],{outcome:'broken'});}catch(error){toast(error.message);}finally{navigating=false;}}
    function toggleAllAggregates(broken,level=1,collapseOverride){
      const keys=[...view.aggregateInitialized].filter(key=>level>=3?/^\d{8}:[345]:/.test(key):level===2?/^\d{8}:2:/.test(key):broken?key.endsWith(':broken-themes'):key.endsWith(':failed-themes')&&key.split(':').length===2),collapse=collapseOverride??keys.some(key=>view.expandedUnpromoted.has(key));
      if(level>=3)view.foldHigherFailed=collapse;else if(level===2)view.foldSecondFailed=collapse;else if(broken)view.foldBreakThemes=collapse;else view.foldOtherThemes=collapse;view.liveSummaryFolded||={};view.liveSummaryFolded[level>=3?'higher':level===2?'second':broken?'broken':'other']=collapse;
      for(const key of keys){if(collapse)view.expandedUnpromoted.delete(key);else view.expandedUnpromoted.add(key);}const top=host.scrollTop;view.patchPaint=true;paintLimitupLadder(fullData);host.scrollTop=top;view.updateLegend?.();
    }
    function failedToggleScope(key){return /^\d{8}:2:/.test(key)?'second':/^\d{8}:[345]:/.test(key)?'higher':key.endsWith(':broken-themes')?'broken':key.endsWith(':failed-themes')?'first':null;}
    function aggregateCollapseIntent(broken,level){const scope=level>=3?'higher':level===2?'second':broken?'broken':'first',intent=view.aggregateIntent;return intent&&intent.scope===scope&&performance.now()-intent.at<900?intent.wasAnyOpen:undefined;}
    function canvasNameAction(target){
      const broken=target.closest('[data-vl-broken-link]'),stock=target.closest('[data-vl-stock-link]'),unpromoted=target.closest('[data-vl-unpromoted-link]'),topic=target.closest('[data-vl-topic]');
      if(!broken&&!stock&&!unpromoted&&!topic)return null;
      const id=broken?.dataset.vlBrokenLink||stock?.dataset.vlStockLink||unpromoted?.dataset.vlUnpromotedLink,node=id?((fullData.sealedStocks||[]).find(item=>item.id===id)||(fullData.unpromotedStocks||[]).find(item=>item.id===id)||(fullData.brokenStocks||[]).find(item=>item.id===id)||fullData.nodes.find(item=>item.id===id)):null,theme=topic?.dataset.vlTopic||target.closest('[data-vl-focus-theme]')?.dataset.vlFocusTheme||target.closest('[data-vl-aggregate-theme]')?.dataset.vlAggregateTheme||node?.theme;
      const navigate=()=>{if(broken&&node)navigateBroken(node);else if(stock)navigateStock(id,node);else if(unpromoted)navigateUnpromoted(id,node);else if(topic)navigateTheme(topic.dataset.vlTopic,topic.dataset.vlTopicDate);};
      return {theme,code:node?.code||(id?.split(':')[1]||''),navigate};
    }
    function activate(event){
      if(event.type==='keydown'&&event.key==='Escape'&&view.focusedStock){event.preventDefault();event.stopPropagation();focusStock(view.focusedStock);return;}
      if(event.type==='click'||['Enter',' '].includes(event.key))closeLadderTopicHover();
      if(event.type==='click'&&event.detail<2&&view.singleClickTimer){clearTimeout(view.singleClickTimer);view.singleClickTimer=0;}
      const toggle=event.target.closest('[data-vl-unpromoted-toggle]');if(toggle){if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;event.preventDefault();event.stopPropagation();if(event.type==='click'&&event.detail>=2)return;const key=toggle.dataset.vlUnpromotedToggle,scope=failedToggleScope(key);if(scope&&event.type==='click'){view.aggregateIntent={scope,at:performance.now(),wasAnyOpen:[...view.aggregateInitialized].some(candidate=>failedToggleScope(candidate)===scope&&view.expandedUnpromoted.has(candidate))};}host.dataset.aggregateWaitMs='0';const began=performance.now();toggleUnpromoted(key);host.dataset.expandWorkMs=(performance.now()-began).toFixed(1);return;}
      if(event.type==='keydown'&&event.key==='Escape'&&compactLayout){event.preventDefault();event.stopPropagation();restoreAll();return;}
      if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;
      const name=canvasNameAction(event.target),focus=event.target.closest('[data-vl-focus-theme]');if(!name&&!focus)return;
      event.preventDefault();event.stopPropagation();
      if(name){
        if(event.type==='keydown'){name.navigate();return;}
        if(event.detail>1)return;
        if(name.code){focusStock(name.code);return;}
        // Leave the name in place until the browser can distinguish a double-click.
        view.singleClickTimer=setTimeout(()=>{view.singleClickTimer=0;if(ladderView===view&&host.isConnected&&view.data===fullData&&name.theme)compactFocus(name.theme,false,true);},500);
        return;
      }
      if(event.type==='click'&&event.detail>1)return;
      compactFocus(focus.dataset.vlFocusTheme);
    }
    setupLadderStockHover(fullData,view);setupLadderTopicHover(host,fullData,view,navigateStock,navigateUnpromoted,navigateBroken,navigateTheme);host.onclick=activate;host.onkeydown=activate;
    // Summary double-click controls its own cohort; ordinary theme cards use single-click focus.
    host.ondblclick=event=>{
      const name=canvasNameAction(event.target);
      if(name){event.preventDefault();event.stopPropagation();if(view.singleClickTimer){clearTimeout(view.singleClickTimer);view.singleClickTimer=0;}closeLadderTopicHover();if(name.code)view.focusedStock=name.code;name.navigate();return;}
      const toggle=event.target.closest('[data-vl-unpromoted-toggle]');if(!toggle)return;
      const scope=failedToggleScope(toggle.dataset.vlUnpromotedToggle);if(!scope)return;
      event.preventDefault();event.stopPropagation();
      const broken=scope==='broken',level=scope==='higher'?3:scope==='second'?2:1;
      toggleAllAggregates(broken,level,aggregateCollapseIntent(broken,level));
    };
    applyThemeFocus();
    view.legendStockOverrides||=new Map();view.legendStockPending||=new Set();view.legendStockErrors||=new Set();
    let legendFactDates=new Set();
    function legendStockControl(){return `<label class="vl-legend-stock-all"><input type="checkbox" data-vl-legend-stock-all aria-label="显示全部题材股票" ${view.legendStocksAll?'checked':''}/><span>显示股票</span></label>`;}
    function legendThemeEntry(level,theme,countMarkup,topicMarkup,title,stocks){
      const key=JSON.stringify([level,theme]),open=ladderLegendStockVisible(view,key),members=ladderLegendStockMembers(stocks);
      let list='';
      if(open){list=members.map(stock=>{view.legendStockRecords.set(stock.id,stock);legendFactDates.add(stock.date);const key=stock.date+':'+view.dataVersion,record=ladderTopicDetailCache.get(key),details=record&&Date.now()-record.savedAt<record.ttl?record.payload:null;return ladderLegendStockRow(stock,details?.stocks?.[stock.code]);}).join('');}
      return `<div class="vl-legend-entry" data-vl-legend-entry="${esc(key)}"><div class="vl-legend-theme-row"><button type="button" class="vl-legend-count-toggle" data-vl-legend-stocks="${esc(key)}" aria-expanded="${open}" aria-label="${esc((open?'收起':'展开')+theme+'股票列表')}" title="${esc((open?'收起':'展开')+'股票列表')}"><span class="vl-legend-count-slot">${countMarkup}</span></button><button type="button" class="vl-legend-theme-button" data-vl-theme="${esc(theme)}" aria-pressed="${selectedThemes.has(theme)}" title="${esc(title)}">${topicMarkup}</button></div>${open?`<div class="vl-legend-stocks" aria-label="${esc(theme+'股票列表')}">${list||'<span class="vl-specified-legend-empty">—</span>'}</div>`:''}</div>`;
    }
    function finishLegendStocks(){
      const toggles=[...legend.querySelectorAll('[data-vl-legend-stocks]')],any=toggles.some(button=>button.getAttribute('aria-expanded')==='true'),all=toggles.length>0&&toggles.every(button=>button.getAttribute('aria-expanded')==='true'),input=legend.querySelector('[data-vl-legend-stock-all]');
      if(input){input.checked=toggles.length?all:Boolean(view.legendStocksAll);input.indeterminate=any&&!all;}
      const page=legend.closest('.ladder-vertical'),wide=Boolean(legend.querySelector('.vl-legend-stock-row'));
      if(page&&page.classList.contains('vl-has-legend-stocks')!==wide){const atEnd=host.scrollWidth-host.clientWidth-host.scrollLeft<2;page.classList.toggle('vl-has-legend-stocks',wide);if(atEnd)host.scrollLeft=host.scrollWidth-host.clientWidth;}
      for(const date of legendFactDates){
        if(view.legendStockPending.size>=4)break;
        const key=date+':'+view.dataVersion,record=ladderTopicDetailCache.get(key);
        if(record&&Date.now()-record.savedAt<record.ttl||view.legendStockPending.has(date)||view.legendStockErrors.has(date))continue;
        view.legendStockPending.add(date);
        getLadderTopicDetails(date,view.dataVersion).catch(error=>{view.legendStockErrors.add(date);console.warn('图例股票补充数据读取失败',error);}).finally(()=>{view.legendStockPending.delete(date);if(ladderView===view&&host.isConnected)view.refreshLegendStocks?.();});
      }
    }
    view.refreshLegendStocks=()=>{if(ladderView!==view||!host.isConnected)return;if(view.specifiedDayEnabled)renderSpecifiedLegend();else renderVisibleLegend();};
    function legendGroupingToggle(){
      return `<button type="button" class="vl-legend-grouping-toggle" data-vl-legend-grouping aria-expanded="${!view.legendCollapsed}" aria-label="${view.legendCollapsed?'展开题材图例，按各板数分别列出':'收缩题材图例，按题材最高板归类'}" title="${view.legendCollapsed?'按各板数分别列出题材':'同题材合并到最高板，显示全部涨停数'}">${view.legendCollapsed?'展开':'收缩'}</button>${legendStockControl()}`;
    }
    function renderSpecifiedLegend(message='正在读取指定日…'){
      legendFactDates=new Set();view.legendStockRecords=new Map();
      const date=view.specifiedDay,data=view.specifiedLegendPayload?.date===date?view.specifiedLegendPayload:null,collapsed=view.legendCollapsed;
      legend.setAttribute('aria-label','指定日 '+(date?fmtDate(date):'未选择')+(collapsed?'，按题材最高板归类，数量为题材全部涨停数':'，按板数列出题材，数量为该板涨停数/该题材涨停总数'));
      let legendMarkup='';
      if(!data)legendMarkup=`<div class="vl-specified-legend-status" role="status">${esc(message)}</div>`;
      else{
        const sealed=[...new Map(data.sealedStocks.filter(stock=>stock.date===date&&stock.status==='sealed').map(stock=>[stock.code,stock])).values()],totals=new Map(),groups=new Map(),themeStocks=new Map();
        for(const stock of sealed){totals.set(stock.theme,(totals.get(stock.theme)||0)+1);if(!themeStocks.has(stock.theme))themeStocks.set(stock.theme,[]);themeStocks.get(stock.theme).push(stock);}
        const addGroup=(level,theme,stocks)=>{if(!groups.has(level))groups.set(level,new Map());groups.get(level).set(theme,stocks);};
        if(collapsed){for(const [theme,stocks] of themeStocks)addGroup(Math.min(Math.max(...stocks.map(stock=>Number(stock.board))),5),theme,stocks);}
        else for(const stock of sealed){const level=Math.min(Number(stock.board),5),stocks=groups.get(level)?.get(stock.theme)||[];stocks.push(stock);addGroup(level,stock.theme,stocks);}
        const tierMarkup=(level,label,items)=>`<section class="vl-legend-tier" aria-label="${label}"><h4><input type="checkbox" class="vl-tier-visibility" data-vl-row-level="${level}" aria-label="显示${label}行" ${hiddenLevels.has(level)?'':'checked'}/><button type="button" class="vl-tier-filter" ${level===0?'data-vl-break-toggle':`data-vl-min-board="${level}"`}>${label}</button>${level===5?legendGroupingToggle():''}</h4><div class="vl-legend-items">${items.map(([theme,stocks])=>{const count=stocks.length,total=totals.get(theme)||0,title=fmtDate(date)+' · '+theme+' · '+label+(level===0?'破板数 '+count:collapsed?' · 全部涨停 '+total:'涨停 '+count+' / 题材涨停总数 '+total);const countMarkup=level===0||collapsed?`<span class="vl-legend-count" style="--theme-color:${ladderThemeColor(theme)};--legend-count-size:${Math.min(26,12+2*Math.sqrt(Math.max(0,count-1))).toFixed(1)}px">${count}</span>`:ladderLegendFraction(count,total,theme),topicMarkup=`<span class="vl-legend-topic-name" data-vl-specified-legend="true" data-vl-topic="${esc(theme)}" data-vl-topic-date="${date}">${esc(theme)}</span>`;return legendThemeEntry(level,theme,countMarkup,topicMarkup,title,stocks);}).join('')||'<span class="vl-specified-legend-empty">—</span>'}</div></section>`;
        legendMarkup=[{level:5,label:'高板'},{level:4,label:'四板'},{level:3,label:'三板'},{level:2,label:'二板'},{level:1,label:'首板'}].map(({level,label})=>{const items=[...(groups.get(level)||[])].sort((a,b)=>(collapsed||level===5?Math.max(...b[1].map(stock=>stock.board))-Math.max(...a[1].map(stock=>stock.board)):0)||b[1].length-a[1].length||(totals.get(b[0])||0)-(totals.get(a[0])||0)||a[0].localeCompare(b[0],'zh-CN'));return tierMarkup(level,label,items);}).join('');
        const classified=new Set([...themeStocks.keys(),...data.unpromotedStocks.filter(stock=>stock.date===date).map(stock=>stock.theme)]),broken=new Map();for(const stock of data.brokenStocks.filter(stock=>stock.date===date&&(!collapsed||!classified.has(stock.theme)))){if(!broken.has(stock.theme))broken.set(stock.theme,[]);broken.get(stock.theme).push(stock);}legendMarkup+=tierMarkup(0,'破板',[...broken].sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0],'zh-CN')));
      }
      updateLadderLegend(legend,legendMarkup);finishLegendStocks();
    }
    async function refreshSpecifiedLegend(){
      const date=view.specifiedDay,request=++view.specifiedLegendRequestId;
      if(!view.specifiedDayEnabled)return;
      if(!/^[0-9]{8}$/.test(date||'')){renderSpecifiedLegend('请选择指定日');return;}
      if(!state.dates.includes(date)){view.specifiedLegendPayload=null;renderSpecifiedLegend('该日暂无涨停数据');return;}
      renderSpecifiedLegend();
      try{const data=await getLadderSpecifiedDay(view,date);if(ladderView!==view||view.data!==fullData||!view.specifiedDayEnabled||view.specifiedDay!==date||view.specifiedLegendRequestId!==request)return;view.specifiedLegendPayload=data;
        if(ladderStockHoverContext?.view===view)for(const stock of [...data.sealedStocks,...data.unpromotedStocks,...data.brokenStocks])ladderStockHoverContext.stocks.set(stock.id,stock);
        renderSpecifiedLegend();
      }catch(error){if(ladderView===view&&view.specifiedDayEnabled&&view.specifiedDay===date&&view.specifiedLegendRequestId===request){if(view.specifiedLegendPayload?.date!==date)view.specifiedLegendPayload=null;renderSpecifiedLegend('指定日读取失败，请重新选择');}}
    }

    function renderVisibleLegend(){
      const legendStarted=performance.now();
      if(ladderView!==view||view.data!==fullData||!host.isConnected||view.dragging)return;
      const svg=host.querySelector('svg');if(!svg)return;const bounds=host.getBoundingClientRect(),svgBounds=svg.getBoundingClientRect(),scale=svgBounds.width/Number(svg.getAttribute('width')),header=host.querySelector('.vl-board-header').getBoundingClientRect(),rail=host.querySelector('.vl-date-rail').getBoundingClientRect(),clip={left:Math.max(bounds.left,rail.right),right:bounds.right-3,top:Math.max(bounds.top,header.bottom),bottom:bounds.bottom-3};
      const visibleDays=new Set(columns.filter(col=>svgBounds.left+(col.x+col.width)*scale>clip.left&&svgBounds.left+col.x*scale<clip.right).map(col=>col.day)),visibleThemes=new Set();
      view.visibleDays=[...visibleDays];
      const heightRangeChanged=visibleDays.size!==filterDays.size||[...visibleDays].some(day=>!filterDays.has(day));
      if(view.rowHeightTimer){clearTimeout(view.rowHeightTimer);view.rowHeightTimer=0;}
      if(heightRangeChanged&&visibleDays.size){
        // Wait for horizontal scrolling to settle. Canvas dragging reaches here only after release.
        view.rowHeightTimer=setTimeout(()=>{
          view.rowHeightTimer=0;if(ladderView!==view||view.data!==fullData||view.dragging||!host.isConnected)return;
          const top=host.scrollTop,anchor=rows.find(row=>28+row.y+row.height>top);
          if(anchor)view.rowViewportAnchor={level:anchor.level,offset:top-28-anchor.y};
          view.patchPaint=true;paintLimitupLadder(fullData);
        },120);
      }
      if(minBoard){const nextPeaks=new Map();for(const node of fullData.sealedStocks||allSealed)if(node.status==='sealed'&&visibleDays.has(node.date))nextPeaks.set(node.theme,Math.max(nextPeaks.get(node.theme)||0,node.board));const nextThemes=new Set([...nextPeaks].filter(([,peak])=>peak>=minBoard).map(([theme])=>theme));if(nextThemes.size!==boardThemes.size||[...nextThemes].some(theme=>!boardThemes.has(theme))){const top=host.scrollTop;paintLimitupLadder(fullData);host.scrollTop=top;return;}}
      if(compactLayout){
        // Keep the full date-range theme index available while only the plot is filtered.
        for(const node of fullData.nodes)if(node.status==='sealed'&&visibleDays.has(node.date))visibleThemes.add(node.theme);
      }else for(const group of positions.values()){const x=svgBounds.left+group.x*scale,y=svgBounds.top+group.y*scale;if(x+group.width*scale>clip.left&&x<clip.right&&y+group.height*scale>clip.top&&y<clip.bottom)visibleThemes.add(group.theme);}
      for(const node of fullData.sealedStocks||[])if(visibleDays.has(node.date)&&hiddenLevels.has(Math.min(node.board,5)))visibleThemes.add(node.theme);
      // Four-board themes stay emphasized across their whole path, including lower tiers.
      // Use the visible dates so panning does not retain an off-screen historical leader.
      themeColors=ladderDistinctThemeColors(fullData.sealedStocks||allSealed,visibleDays);view.themeColors=new Map(themeColors);const strongThemes=new Set((fullData.sealedStocks||allSealed).filter(node=>node.status==='sealed'&&node.board>=4&&visibleDays.has(node.date)).map(node=>node.theme));
      host.querySelectorAll('[data-vl-colored-theme]').forEach(element=>element.style.setProperty('--ladder-theme-color',themeColor(element.dataset.vlColoredTheme)));
      host.querySelectorAll('[data-vl-line-theme]').forEach(element=>element.setAttribute('stroke',themeColor(element.dataset.vlLineTheme)));
      host.querySelectorAll('[data-vl-box-theme]').forEach(element=>element.classList.toggle('vl-theme-emphasis',strongThemes.has(element.dataset.vlBoxTheme)));
      host.querySelectorAll('[data-vl-line-theme]').forEach(element=>element.classList.toggle('vl-theme-emphasis',strongThemes.has(element.dataset.vlLineTheme)));
      const range=[...visibleDays].sort(),firstDay=range[0]||view.endDay,lastDay=range.at(-1)||view.endDay,rangeLabel=fmtDate(firstDay)+'至'+fmtDate(lastDay),shortRange=firstDay.slice(4,6)+'/'+firstDay.slice(6)+'—'+lastDay.slice(4,6)+'/'+lastDay.slice(6),stats=new Map([...visibleThemes].map(theme=>[theme,{name:theme,count:0,highest:0,codes:new Set()}]));
      for(const node of fullData.sealedStocks||[]){const item=stats.get(node.theme);if(!item)continue;if(visibleDays.has(node.date)){item.highest=Math.max(item.highest,node.board);if(node.status==='sealed')item.codes.add(node.code);}}
      for(const stock of fullData.unpromotedStocks||[]){if(!visibleDays.has(stock.date))continue;if(!stats.has(stock.theme))stats.set(stock.theme,{name:stock.theme,count:0,highest:1,codes:new Set()});stats.get(stock.theme).codes.add(stock.code);}
      for(const stock of fullData.sealedStocks||[]){if(!visibleDays.has(stock.date)||!stats.has(stock.theme))continue;const item=stats.get(stock.theme);item.highest=Math.max(item.highest,stock.board);item.codes.add(stock.code);}
      for(const item of stats.values())item.count=item.codes.size;
      const tiers=[{level:5,label:'高板'},{level:4,label:'四板'},{level:3,label:'三板'},{level:2,label:'二板'},{level:1,label:'首板'}];
      const legendTopicDates=new Map();for(const stock of [...(fullData.sealedStocks||[]),...(fullData.unpromotedStocks||[]),...(fullData.brokenStocks||[])]){if(!visibleDays.has(stock.date))continue;const previous=legendTopicDates.get(stock.theme);if(!previous||stock.date>previous)legendTopicDates.set(stock.theme,stock.date);}
      legend.setAttribute('aria-label',`当前可见题材，${rangeLabel}题材宽度，涨停股票按代码去重，按最高连板数分档`);
      const toolbarRange=$('#ladderToolbarRange');if(toolbarRange){toolbarRange.setAttribute('aria-label',`统计日期范围：${rangeLabel}，共${range.length}个交易日`);toolbarRange.innerHTML=`<span title="${esc(rangeLabel)}">${esc(shortRange)}</span><span>共</span><span class="vl-range-count" title="${range.length}个交易日">${range.length}</span><span>交易日</span>`;}
      if(view.specifiedDayEnabled){renderSpecifiedLegend();host.dataset.legendMs=(performance.now()-legendStarted).toFixed(1);return;}
      legendFactDates=new Set();view.legendStockRecords=new Map();
      const legendMembersByTheme=new Map();for(const stock of [...(fullData.sealedStocks||[]),...(fullData.unpromotedStocks||[]).map(stock=>({...stock,status:'unpromoted'})),...(fullData.brokenStocks||[])]){if(!visibleDays.has(stock.date))continue;if(!legendMembersByTheme.has(stock.theme))legendMembersByTheme.set(stock.theme,[]);legendMembersByTheme.get(stock.theme).push(stock);}
      let legendMarkup=tiers.map(tier=>{const items=[...stats.values()].filter(item=>Math.min(item.highest,5)===tier.level&&(tier.level!==1||item.count>1)).sort((a,b)=>b.highest-a.highest||b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));return `<section class="vl-legend-tier${minBoard&&tier.level<minBoard?' vl-tier-below':''}" aria-label="${tier.label}"><h4><input type="checkbox" class="vl-tier-visibility" data-vl-row-level="${tier.level}" aria-label="显示${tier.label}行" ${hiddenLevels.has(tier.level)?'':'checked'}/><button type="button" class="vl-tier-filter" data-vl-min-board="${tier.level}" aria-pressed="${tier.level===1?!view.foldOtherThemes:minBoard===tier.level}" aria-label="${tier.level===1?'首板：全部展开或收起其他题材':tier.label+'：只显示最高板数达到'+tier.level+'板及以上的题材'}" title="${tier.level===1?'全部展开或收起其他题材':minBoard===tier.level?'再次点击恢复全部':'筛选最高板数达到该档及以上的题材'}">${tier.label}</button>${tier.level===5?legendStockControl():''}</h4><div class="vl-legend-items">${items.map(item=>{const title=item.name+' · 最高'+item.highest+'板 · '+shortRange+'涨停股票去重'+item.count+'只',countMarkup=`<span class="vl-legend-count" style="--theme-color:${themeColor(item.name)};--legend-count-size:${Math.min(26,12+2*Math.sqrt(Math.max(0,item.count-1))).toFixed(1)}px">${item.count}</span>`,topicMarkup=`<span class="vl-legend-topic-name" data-vl-topic-dates="${esc(JSON.stringify([...visibleDays].sort()))}" data-vl-topic="${esc(item.name)}" data-vl-topic-date="${legendTopicDates.get(item.name)||lastDay}">${esc(item.name)}</span>`;return legendThemeEntry(tier.level,item.name,countMarkup,topicMarkup,title,legendMembersByTheme.get(item.name)||[]);}).join('')}</div></section>`;}).join('');
      const classifiedThemes=new Set([...(fullData.sealedStocks||[]),...(fullData.unpromotedStocks||[])].filter(stock=>visibleDays.has(stock.date)).map(stock=>stock.theme));
      const breakStats=new Map();for(const stock of fullData.brokenStocks||[]){if(!visibleDays.has(stock.date)||classifiedThemes.has(stock.theme))continue;if(!breakStats.has(stock.theme))breakStats.set(stock.theme,new Set());breakStats.get(stock.theme).add(stock.code);}
      legendMarkup+=`<section class="vl-legend-tier" aria-label="破板"><h4><input type="checkbox" class="vl-tier-visibility" data-vl-row-level="0" aria-label="显示破板行" ${hiddenLevels.has(0)?'':'checked'}/><button type="button" class="vl-tier-filter" data-vl-break-toggle aria-label="破板：全部展开或收起" aria-expanded="${!view.foldBreakThemes}">破板</button></h4><div class="vl-legend-items">${[...breakStats].filter(([,codes])=>codes.size>1).sort((a,b)=>b[1].size-a[1].size||a[0].localeCompare(b[0],'zh-CN')).map(([theme,codes])=>{const title=theme+' · 首板破板股票去重'+codes.size,countMarkup=`<span class="vl-legend-count" style="--theme-color:${themeColor(theme)};--legend-count-size:${Math.min(26,12+2*Math.sqrt(Math.max(0,codes.size-1))).toFixed(1)}px">${codes.size}</span>`,topicMarkup=`<span class="vl-legend-topic-name" data-vl-topic-dates="${esc(JSON.stringify([...visibleDays].sort()))}" data-vl-topic="${esc(theme)}" data-vl-topic-date="${legendTopicDates.get(theme)||lastDay}">${esc(theme)}</span>`;return legendThemeEntry(0,theme,countMarkup,topicMarkup,title,(legendMembersByTheme.get(theme)||[]).filter(stock=>stock.status==='broken'));}).join('')}</div></section>`;
      updateLadderLegend(legend,legendMarkup);finishLegendStocks();host.dataset.legendMs=(performance.now()-legendStarted).toFixed(1);
    }
    view.updateLegend=()=>{if(view.legendFrame)cancelAnimationFrame(view.legendFrame);view.legendFrame=requestAnimationFrame(()=>{view.legendFrame=0;renderVisibleLegend();});};
    legend.onchange=event=>{const all=event.target.closest('[data-vl-legend-stock-all]');if(all){event.stopPropagation();view.legendStocksAll=all.checked;view.legendStockOverrides.clear();view.legendStockErrors.clear();view.refreshLegendStocks();return;}const input=event.target.closest('[data-vl-row-level]');if(!input)return;const level=Number(input.dataset.vlRowLevel);if(input.checked)hiddenLevels.delete(level);else hiddenLevels.add(level);const top=host.scrollTop;paintLimitupLadder(fullData);host.scrollTop=Math.min(top,Math.max(0,host.scrollHeight-host.clientHeight));view.updateLegend?.();};
    legend.onclick=event=>{if(event.target.closest('.vl-legend-stock-all')){event.stopPropagation();return;}const stockToggle=event.target.closest('[data-vl-legend-stocks]');if(stockToggle){event.preventDefault();event.stopPropagation();if(event.detail>1)return;closeLadderTopicHover();const key=stockToggle.dataset.vlLegendStocks;view.legendStockOverrides.set(key,!ladderLegendStockVisible(view,key));view.legendStockErrors.clear();view.refreshLegendStocks();return;}const stockRow=event.target.closest('[data-vl-legend-stock]');if(stockRow){event.preventDefault();event.stopPropagation();if(event.detail>1)return;const stock=view.legendStockRecords.get(stockRow.dataset.vlLegendStock);if(stock){closeLadderTopicHover();focusLegendStock(stock);}return;}if(event.target.closest('[data-vl-legend-grouping]')){event.preventDefault();event.stopPropagation();closeLadderTopicHover();view.legendCollapsed=!view.legendCollapsed;renderSpecifiedLegend();return;}if(event.target.closest('[data-vl-row-level]')){event.stopPropagation();return;}const breakToggle=event.target.closest('[data-vl-break-toggle]');if(breakToggle){event.preventDefault();toggleAllAggregates(true);return;}const tier=event.target.closest('[data-vl-min-board]');if(tier){event.preventDefault();if(Number(tier.dataset.vlMinBoard)===1)toggleAllAggregates(false);else filterBoard(Number(tier.dataset.vlMinBoard));return;}const element=event.target.closest('[data-vl-theme]');if(!element)return;const theme=element.dataset.vlTheme;if(!view.specifiedDayEnabled&&minBoard&&!boardThemes.has(theme))return;if(event.detail>1)return;event.preventDefault();compactFocus(theme,true);};
    // macOS turns Control + left-click into contextmenu instead of click.
    legend.oncontextmenu=event=>{if(!event.ctrlKey)return;const element=event.target.closest('[data-vl-theme]');if(!element)return;event.preventDefault();event.stopPropagation();const theme=element.dataset.vlTheme;if(!view.specifiedDayEnabled&&minBoard&&!boardThemes.has(theme))return;compactFocus(theme,true);};
    legend.ondblclick=event=>{if(event.target.closest('[data-vl-legend-stocks],.vl-legend-stock-all')){event.preventDefault();event.stopPropagation();return;}const row=event.target.closest('[data-vl-legend-stock]');if(row){event.preventDefault();event.stopPropagation();const stock=view.legendStockRecords.get(row.dataset.vlLegendStock);if(stock){if(stock.status==='unpromoted')navigateUnpromoted(stock.id,stock);else if(stock.status==='broken')navigateBroken(stock);else navigateStock(stock.id,stock);}return;}const element=event.target.closest('[data-vl-theme]');if(!element)return;event.preventDefault();event.stopPropagation();compactFocus(element.dataset.vlTheme,false,true);};
    view.compactFocus=compactFocus;
    view.searchSelect=result=>{
      if(result.kind==='stock')focusLegendStock(result.stock);else{hiddenLevels.clear();compactFocus(result.theme,false,true);}
      const target=result.kind==='stock'?[...host.querySelectorAll('[data-vl-stock-link],[data-vl-unpromoted-link],[data-vl-broken-link]')].find(element=>[element.dataset.vlStockLink,element.dataset.vlUnpromotedLink,element.dataset.vlBrokenLink].includes(result.stock.id)):null;
      const date=host.querySelector(`[data-vl-date="${result.date}"]`);(target||date)?.scrollIntoView({block:'nearest',inline:'nearest'});view.updateLegend?.();
    };
    const specifiedEnabled=$('#ladderSpecifiedDayEnabled'),specifiedDate=$('#ladderSpecifiedDay');
    view.specifiedDayEnabled??=true;view.legendCollapsed??=true;view.specifiedDay||=view.endDay;view.specifiedLegendRequestId||=0;
    const syncSpecifiedDate=()=>{specifiedDate.dataset.date=view.specifiedDay;specifiedDate.setAttribute('aria-label','选择图例指定日');specifiedDate.querySelector('.date-trigger-label').textContent=formatCalendarDate(view.specifiedDay);};
    specifiedEnabled.checked=view.specifiedDayEnabled;syncSpecifiedDate();
    const changeSpecified=()=>{closeLadderTopicHover();view.specifiedDayEnabled=specifiedEnabled.checked;if(view.specifiedDayEnabled)refreshSpecifiedLegend();else{view.specifiedLegendRequestId++;renderVisibleLegend();}};
    specifiedEnabled.onchange=changeSpecified;
    view.setSpecifiedLegendDate=async date=>{
      if(!state.dates.includes(date))return;
      const visible=(view.visibleDays?.length?view.visibleDays:[...filterDays]).slice().sort(),outside=visible.length&&(date<visible[0]||date>visible.at(-1));
      if(view.specifiedDay!==date)view.specifiedLegendPayload=null;view.specifiedDay=date;syncSpecifiedDate();closeLadderTopicHover();
      // Only move the plot when the selected day is outside its on-screen date range.
      if(view.specifiedDayEnabled&&outside){await openLadderDate(date,true);return;}
      if(view.specifiedDayEnabled)refreshSpecifiedLegend();else view.specifiedLegendRequestId++;
    };
    if(view.specifiedDayEnabled)refreshSpecifiedLegend();
    view.refreshSearch?.();view.updateLegend();host.dataset.paintMs=(performance.now()-paintStarted).toFixed(1);markPaint('total');host.dataset.paintProfile=JSON.stringify(paintProfile);

  }
  async function openLimitupLadder(){
    if(history.state?.ladderReturn)return returnToLadderForDate();
    if(history.state?.view==='home'){
      const status=await readLiveLadderStatus(),lastOffline=state.dates.filter(day=>day!==status?.date).at(-1);
      if(status?.available&&state.date===lastOffline)return openLadderDate(status.date);
      return returnToLadderForDate();
    }
    syncBrowserRoute('ladder',state.date);renderLimitupLadder();
  }
  function openHome(date=state.date,historyMode='push'){if(needsReviewDate(date)){syncBrowserRoute('home',date,'','',historyMode);loadDate(date);return;}syncBrowserRoute('home',date,'','',historyMode);state.topic=null;state.stock=null;state.index=null;state.indexData=null;renderHome();}
  function goBackInApp(fallbackView='home',topic=''){if(history.state?.tradingAlert&&history.state.hasAppParent){history.back();return;}if(fallbackView==='topic'&&topic)openTopic(topic);else if(fallbackView==='indices')openIndicesOverview();else openHome();}
  async function restoreBrowserRoute(route){if(route?.view==='live'){await refreshMarketStatus();if(liveEnabled){livePageShell();await refreshLivePage();return;}syncBrowserRoute('home',state.date,'','','replace');}const date=state.dates.includes(route?.date)?route.date:state.date;if(needsReviewDate(date)&&!await loadDate(date))return;if(route?.view==='ladder'){renderLimitupLadder();return;}if(route?.view==='indices'){renderIndicesOverview();return;}if(route?.view==='index'&&route.index&&indexSequence().some(item=>item.code===route.index)){await openIndex(route.index,date,'replace');return;}if(route?.view==='topic'&&route.topic){state.stock=null;state.index=null;renderNav();if(state.review.topics.some(t=>t.name===route.topic))renderTopic(route.topic);else renderTopicNoData(route.topic);return;}if(route?.view==='stock'&&route.stock){const stock=resolveTopicStock(route.topic,route.stock,route.outcome)||( !route.topic ? navigableStocks().find(s=>s.code===route.stock) : null );if(stock){await selectStock(stock.topic,stock.code,{historyMode:'none',outcome:route.outcome});return;}}state.topic=null;state.stock=null;state.index=null;renderHome();}
  function topicNavigationOrder(){return visibleTopics().map(topic=>topic.name);}
  function navigateTopic(step){const topics=topicNavigationOrder(),index=topics.indexOf(state.topic),target=topics[index+step];if(target)openTopic(target);}
  function renderTopicNoData(name){content.classList.remove('six-grid-page');state.indicesPage=false;state.topic=name;state.stock=null;state.index=null;state.indexData=null;$('#crumbBack').hidden=false;$('#crumbBack').textContent='← 返回每日总览';$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=true;$('#crumbSeparator').hidden=true;$('#crumbBack').onclick=()=>openHome();$('#topbarActions').innerHTML=`<div class="topic-nav-controls">${datePickerTriggerMarkup('topicDatePickerTrigger','date-nav-button')}<span class="topic-position" aria-label="所选日期该题材无记录">该日暂无记录</span></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button>`;$('#openSettings').onclick=openSettings;content.innerHTML=`<div class="page-title topic-page-title"><div class="topic-title-copy"><span class="eyebrow">THEME / ${fmtDate(state.date)}</span><div class="topic-title-main"><h1>${esc(name)}</h1></div></div></div><section class="panel"><div class="empty-state">${esc(fmtDate(state.date))} 没有「${esc(name)}」题材的涨停记录。</div></section>`;applyLadderReturnLink();}
  function boardTraitBadges(stock){
    if(!stock)return '';
    const badges=[];
    if(stock.board_shape==='one_word')badges.push(['一字','one-word','']);
    else if(stock.board_shape==='t_shape')badges.push(['T字','t-shape','']);
    if(stock.reversal_shape==='earth_sky')badges.push(['地天','earth-sky','最低价触及当日跌停价，收盘封涨停']);
    else if(stock.reversal_shape==='near_earth_sky')badges.push(['准地天','near-earth-sky','最低涨幅不高于-7%，收盘封涨停，且不属于地天']);
    if(stock.board_strength==='weak')badges.push(['烂板','weak-board','开板次数超过3次，或最后封板晚于14:00']);
    else if(stock.board_strength==='strong'&&stock.board_shape!=='one_word')badges.push(['强板','strong-board','开板不超过1次，且最后封板早于10:30']);
    return badges.length?`<span class="board-traits">${badges.map(([label,kind,title])=>`<span class="board-shape-badge ${kind}"${title?` title="${esc(title)}"`:''}>${label}</span>`).join('')}</span>`:'';
  }
  function renderTopic(name){const t=state.review.topics.find(x=>x.name===name);if(!t){renderTopicNoData(name);return;}content.classList.remove('six-grid-page');state.indicesPage=false;state.topic=name;state.stock=null;state.index=null;state.indexData=null;const topicNames=topicNavigationOrder(),topicIndex=topicNames.indexOf(name),topicPool=new Map((state.review.pool?.stocks||[]).map(stock=>[String(stock.ts_code||'').slice(0,6),stock])),topicStocks=[...t.stocks].map(stock=>({...stock,status:resolvedBoardStatus(stock,topicPool.get(stock.code))})).sort((a,b)=>compareBoardPriority(a,b,x=>x.status,(x,y)=>(topicPool.get(x.code)?.lu_time||'99:99:99').localeCompare(topicPool.get(y.code)?.lu_time||'99:99:99'))),unpromotedStocks=[...topicUnpromotedStocks(name)].sort((a,b)=>compareBoardPriority(a,b,x=>x.previous_status||boardCountLabel(x.board_count),(x,y)=>String(x.name||'').localeCompare(String(y.name||''),'zh-CN')));$('#crumbBack').hidden=false;$('#crumbBack').textContent='← 返回每日总览';$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=true;$('#crumbSeparator').hidden=true;$('#crumbBack').onclick=()=>openHome();$('#topbarActions').innerHTML=`<div class="topic-nav-controls">${datePickerTriggerMarkup('topicDatePickerTrigger','date-nav-button')}<button id="prevTopic" class="date-nav-button" title="←" ${topicIndex<=0?'disabled':''}>← 前一题材</button><span class="topic-position" title="题材顺序" aria-label="题材序号">${topicIndex<0?'—':topicIndex+1} / ${topicNames.length}</span><button id="nextTopic" class="date-nav-button" title="→" ${topicIndex<0||topicIndex>=topicNames.length-1?'disabled':''}>后一题材 →</button></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button>`;$('#openSettings').onclick=openSettings;$('#topbarActions #prevTopic').onclick=()=>navigateTopic(-1);$('#topbarActions #nextTopic').onclick=()=>navigateTopic(1);content.innerHTML=`<div class="page-title topic-page-title"><div class="topic-title-copy"><span class="eyebrow">THEME / ${fmtDate(state.date)}</span><div class="topic-title-row"><div class="topic-title-main">${topicCountBadge(t,'topic-stock-count')}<h1>${esc(t.name)}</h1></div><div class="topic-page-chart-group"><div class="topic-history-chart">${topicTrendChart(state.review.marketStats?.topicLimitUpHistory?.[name])}</div>${topicLadderChart(topicStocks)}</div></div></div></div><section class="topic-hero selectable"><span class="eyebrow">催化与题材逻辑</span><p>${esc(t.summary||'现有复盘报告未单列题材催化说明。')}</p></section><div class="section-heading"><h3>涨停梯队 ${topicLadderCountSummary(topicStocks)}</h3></div><div class="panel"><table class="stock-table ladder-table"><thead><tr><th>股票</th><th><span title="每分钟收盘涨幅，纵轴范围为当日跌停至涨停幅度">分时图</span></th><th>日K</th><th>连板</th><th>首次涨停</th><th>最后封板</th><th>耗时</th><th>次数</th><th>封单金额</th><th>自由换手率</th>${topicLimitUpSpanHeader}<th>封单率</th>${topicTradingHeaders}<th>流通市值</th><th>总市值</th><th>涨停原因与题材关系</th></tr></thead><tbody>${topicStocks.map(s=>{const p=topicPool.get(s.code);return `<tr class="ladder-stock-row ${ladderColorClass(s)}" data-stock-row="${esc(s.code)}"><td><div class="stock-cell-identity">${marketCapBadge(p?.total_mv)}<div><div class="stock-name">${esc(s.name)}</div><div class="stock-code">${esc(tushareCode(s.code))}</div></div></div></td><td class="intraday-cell">${topicIntradayPlaceholder("读取中")}</td><td class="daily-kline-cell">${topicIntradayPlaceholder("读取中")}</td><td><div class="board-cell"><span class="board-badge" title="${esc(boardLabel(s.status))}">${esc(boardCountLabel(stockBoardNumber(s)))}</span>${boardTraitBadges(p)}</div></td><td class="seal-time">${esc(p?.lu_time||'—')}</td><td class="seal-time">${esc(p?.last_time||'—')}</td><td class="seal-time">${openingDuration(p?.lu_time,p?.last_time)}</td><td class="amount-cell">${p?.open_times==null?'—':esc(p.open_times)}</td><td class="amount-cell">${compactYuan(p?.limit_order)}</td><td class="amount-cell">${p?.free_float_turnover_rate==null?'—':`${Number(p.free_float_turnover_rate).toFixed(2)}%`}</td>${topicLimitUpSpanCell(p)}<td class="amount-cell">${sealedAmountRatio(p||{})}</td>${topicTradingCells(p)}<td class="amount-cell">${compactMarketCap(p?.float_mv)}</td><td class="amount-cell">${compactMarketCap(p?.total_mv)}</td><td class="reason-cell selectable"><b>${esc(s.reason)}</b><br>${esc(s.bridge)}</td></tr>`}).join('')}</tbody></table></div><div class="section-heading break-board-heading"><h3>未晋级与破板</h3>${outcomeRateSummary(name,topicStocks,topicBreakStocks(name))}</div><div class="topic-outcomes-grid"><section class="topic-outcome"><header><h4>未晋级（${topicUnpromotedStocks(name).length}）</h4></header>${unpromotedStocks.length?`<div class="topic-outcome-scroll"><table class="stock-table outcome-table"><thead><tr><th>股票</th><th><span title="每分钟收盘涨幅，纵轴范围为当日跌停至涨停幅度">分时图</span></th><th>日K</th><th>昨日连板</th><th>今日涨停过</th><th>涨幅</th><th>最高涨幅</th>${topicTradingHeaders}${topicValuationHeaders}${topicLimitUpSpanHeader}</tr></thead><tbody>${unpromotedStocks.map(stock=>`<tr data-unpromoted-code="${esc(String(stock.ts_code||'').slice(0,6))}"><td><div class="stock-cell-identity${stock.touched_limit_today?' touched-limit-unpromoted':''}">${marketCapBadge(stock.total_mv)}<div><div class="outcome-stock-name"><span class="stock-name">${esc(stock.name)}</span>${stock.opened_at_limit?'<span class="open-at-limit-badge">开盘</span>':''}</div><div class="stock-code">${esc(tushareCode(stock.ts_code||''))}</div></div></div></td><td class="intraday-cell">${topicIntradayPlaceholder("读取中")}</td><td class="daily-kline-cell">${topicIntradayPlaceholder("读取中")}</td><td><span class="board-badge" title="${esc(boardLabel(stock.previous_status||boardCountLabel(stock.board_count)))}">${esc(boardCountLabel(stockBoardNumber(stock)))}</span></td><td class="${stock.touched_limit_today?'pct-up':'pct-muted'}">${stock.touched_limit_today?'是':'否'}</td><td class="${Number(stock.close_pct)>=0?'pct-up':'pct-down'}">${stock.close_pct==null?'—':`${Number(stock.close_pct)>0?'+':''}${Number(stock.close_pct).toFixed(2)}%`}</td><td class="${Number(stock.high_pct)>=0?'pct-up':'pct-down'}">${stock.high_pct==null?'—':`${Number(stock.high_pct)>0?'+':''}${Number(stock.high_pct).toFixed(2)}%`}</td>${topicTradingCells(stock)}${topicValuationCells(stock)}${topicLimitUpSpanCell(stock)}</tr>`).join('')}</tbody></table></div>`:`<div class="break-board-empty">当日该题材暂无未晋级个股</div>`}</section><section class="topic-outcome"><header><h4>破板（${topicBreakStocks(name).length}）</h4></header>${topicBreakStocks(name).length?`<div class="topic-outcome-scroll"><table class="stock-table outcome-table"><thead><tr><th>股票</th><th><span title="每分钟收盘涨幅，纵轴范围为当日跌停至涨停幅度">分时图</span></th><th>日K</th><th>首次触板</th><th>破板时间</th><th>涨幅</th><th>最高涨幅</th>${topicTradingHeaders}${topicValuationHeaders}${topicLimitUpSpanHeader}</tr></thead><tbody>${topicBreakStocks(name).map(stock=>`<tr data-broken-code="${esc(String(stock.ts_code||'').slice(0,6))}"><td><div class="stock-cell-identity">${marketCapBadge(stock.total_mv)}<div><div class="stock-name">${esc(stock.name)}</div><div class="stock-code">${esc(tushareCode(stock.ts_code||''))}</div></div></div></td><td class="intraday-cell">${topicIntradayPlaceholder("读取中")}</td><td class="daily-kline-cell">${topicIntradayPlaceholder("读取中")}</td><td class="seal-time">${esc(stock.first_limit_time||'—')}</td><td class="seal-time">${esc(stock.break_time||'—')}</td>${topicCloseChangeCell(stock)}${topicHighChangeCell(stock)}${topicTradingCells(stock)}${topicValuationCells(stock)}${topicLimitUpSpanCell(stock)}</tr>`).join('')}</tbody></table></div>`:`<div class="break-board-empty">当日该题材暂无破板个股</div>`}</section></div>`;content.querySelectorAll('[data-stock-row]').forEach(r=>r.addEventListener('click',event=>{if(event.target.closest('.intraday-mini,.daily-kline-mini'))return;selectStock(name,r.dataset.stockRow);}));content.querySelectorAll('tr[data-unpromoted-code]').forEach(row=>row.addEventListener('click',event=>{if(event.target.closest('.intraday-mini,.daily-kline-mini'))return;selectStock(name,row.dataset.unpromotedCode,{outcome:'unpromoted'});}));content.querySelectorAll('tr[data-broken-code]').forEach(row=>row.addEventListener('click',event=>{if(event.target.closest('.intraday-mini,.daily-kline-mini'))return;selectStock(name,row.dataset.brokenCode,{outcome:'broken'});}));const allTopicStocks=[...topicStocks,...unpromotedStocks,...topicBreakStocks(name)];loadTopicIntraday(name,allTopicStocks);loadTopicDailyKline(name,allTopicStocks);applyLadderReturnLink();}
  function navigableStocks(){
    const topics=visibleTopics();
    if(state.navDisplayMode!=='board')return topics.flatMap(topic=>topic.navStocks);
    const times=new Map((state.review.pool?.stocks||[]).map(stock=>[String(stock.ts_code||'').slice(0,6),stock.lu_time||'']));
    return boardNavigationTiers(topics,times).flatMap(tier=>{
      const ordered=[];
      for(const kind of ['promoted','unpromoted','broken']){
        const groups=new Map();
        for(const item of tier.stocks){const itemKind=item.isUnpromoted?'unpromoted':item.isBroken?'broken':'promoted';if(itemKind!==kind)continue;if(!groups.has(item.topic))groups.set(item.topic,[]);groups.get(item.topic).push(item);}
        for(const items of groups.values()){
          items.sort((a,b)=>(kind==='promoted'?(a.time||'99:99:99').localeCompare(b.time||'99:99:99'):0)||String(a.stock.name||'').localeCompare(String(b.stock.name||''),'zh-CN'));
          ordered.push(...items.map(item=>item.stock));
        }
      }
      return ordered;
    });
  }
  function resolveTopicStock(topicName,code,outcome=null){const existingTopic=state.review?.topics.find(item=>item.name===topicName),priorStock=topicUnpromotedStocks(topicName).find(stock=>String(stock.ts_code||'').slice(0,6)===code);const brokenStock=topicBreakStocks(topicName).find(stock=>String(stock.ts_code||'').slice(0,6)===code);const topic=existingTopic||(priorStock||brokenStock?{name:topicName,summary:'',stocks:[]}:null);if(!topic)return null;const findUnpromoted=()=>topicUnpromotedStocks(topicName).find(stock=>String(stock.ts_code||'').slice(0,6)===code);const findBroken=()=>topicBreakStocks(topicName).find(stock=>String(stock.ts_code||'').slice(0,6)===code);if(outcome==='unpromoted'){const item=findUnpromoted();if(item)return unpromotedNavStock(topic,item);}if(outcome==='broken'){const item=findBroken();if(item)return makeBrokenStock(topic,item,code);}const found=topicNavStocks(topic).find(s=>s.code===code);if(found)return found;const unpromoted=findUnpromoted();if(unpromoted)return unpromotedNavStock(topic,unpromoted);const broken=findBroken();if(broken)return makeBrokenStock(topic,broken,code);return null;}
  function makeBrokenStock(topic,broken,code){return {name:broken.name,code,topic:topic.name,summary:topic.summary,status:broken.status||'破板',navLabel:'破板',isBroken:true,closePct:broken.close_pct??broken.pct_chg??(broken.daily_close!=null&&broken.pre_close?((Number(broken.daily_close)/Number(broken.pre_close))-1)*100:null),firstLimitTime:broken.first_limit_time||'',breakTime:broken.break_time||'',reason:broken.performance_limit_reason||broken.limit_reason||'当日冲击首板，盘中触及涨停后收盘未能封住。',bridge:topic.summary||''};}
  async function selectStock(topic,code,{historyMode='push',outcome=null}={}){if(stockNavigationTimer){clearTimeout(stockNavigationTimer);stockNavigationTimer=null;pendingStockTarget=null;}const stock=resolveTopicStock(topic,code,outcome);if(!stock)return;if(historyMode!=='none')syncBrowserRoute('stock',state.date,stock.topic,stock.code,historyMode,outcome||'');state.latestMode=state.stockDatePreference==='latest';state.stockData=null;await loadStock(stock);}
  function canMoveStock(step,stock=state.stock){if(!stock||!state.review)return false;const stocks=navigableStocks(),index=stocks.findIndex(x=>x.code===stock.code&&x.topic===stock.topic);return index>=0&&Boolean(stocks[index+step]);}
  function moveStockSelection(step){if(!state.stock||!state.review)return;const current=pendingStockTarget||state.stock,stocks=navigableStocks(),index=stocks.findIndex(x=>x.code===current.code&&x.topic===current.topic),next=stocks[index+step];if(index<0||!next)return;pendingStockTarget=next;if(stockNavigationTimer)clearTimeout(stockNavigationTimer);stockNavigationTimer=setTimeout(()=>{const target=pendingStockTarget;pendingStockTarget=null;stockNavigationTimer=null;if(target&&(target.code!==state.stock?.code||target.topic!==state.topic))selectStock(target.topic,target.code);},50);}
  function setupStockKeyboard(){window.addEventListener('keydown',event=>{if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey)return;const target=event.target;if(target?.isContentEditable||target?.closest('input,textarea,select,[contenteditable=true]'))return;if($('#analysisDrawer').classList.contains('open'))return;if(event.key==='Backspace'){if(state.index){event.preventDefault();goBackInApp('indices');return;}if(state.indicesPage){event.preventDefault();openHome();return;}if(state.stock){event.preventDefault();openTopic(state.stock.topic);return;}if(state.topic){event.preventDefault();openHome();return;}}if(event.key==='ArrowLeft'||event.key==='ArrowRight'){const step=event.key==='ArrowLeft'?-1:1;if(history.state?.view==='ladder'){if(activeChartZoom||!datePicker.hidden||!$('#settingsOverlay').hidden)return;event.preventDefault();moveLadderDate(step);return;}if(state.index){const list=indexSequence(),index=list.findIndex(item=>item.code===state.index.code);if(list[index+step]){event.preventDefault();moveIndex(step);}return;}if(state.stock){if(canMoveStock(step)){event.preventDefault();moveStockSelection(step);}return;}if(state.topic){const topics=topicNavigationOrder(),index=topics.indexOf(state.topic);if(topics[index+step]){event.preventDefault();navigateTopic(step);}return;}if(state.indicesPage){event.preventDefault();navigateIndicesDate(step);return;}if(!state.topic&&!state.stock&&state.review){const index=state.dates.indexOf(state.date);if(state.dates[index+step]){event.preventDefault();navigateReviewDate(step);}}return;}});}
  async function loadStock(stock){const requestId=++state.stockLoadId,date=state.date,route=location.href,current=()=>requestId===state.stockLoadId&&date===state.date&&route===location.href;state.index=null;state.indexData=null;state.topic=stock.topic;state.stock=stock;state.expandedTopics.add(stock.topic);state.latestMode=state.stockDatePreference==='latest';const canonicalCode=canonicalStockCode(stock.ts_code||stock.code);$('#crumbBack').hidden=false;$('#crumbBack').textContent=`← 返回概念：${stock.topic}`;$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=true;$('#crumbSeparator').hidden=true;$('#crumbBack').onclick=()=>openTopic(stock.topic,state.date);renderNav();applyLadderReturnLink();requestAnimationFrame(()=>nav.querySelector('.stock-link.active')?.scrollIntoView({block:'nearest'}));$('#crumbCurrent').textContent=stock.name;content.innerHTML='<div class="loading"><span class="spinner"></span><p>正在读取行情数据…</p></div>';try{let data=await readStockCache(canonicalCode,date);if(!current())return;if(!data||data.code&&data.code!==canonicalCode||data.previousLimitUpTradingDays===undefined||data.previousLimitUpHistoricalFirst===undefined||data.limitUpSpanVersion!==4||data.chartSeriesVersion!==6||data.seriesReferenceDate!==shanghaiDateKey()||!Array.isArray(data.suspendedDays)||!Array.isArray(data.latest?.suspendedDays))data=await api(`/api/stock?code=${encodeURIComponent(canonicalCode)}&date=${date}`);if(!current())return;state.stockData=data;saveStockCache(canonicalCode,date,data);renderStock(stock,data);}catch(e){if(!current())return;content.innerHTML=`<div class="empty-state">行情读取失败：${esc(e.message)}<br><button class="light-button" id="retryStock">重试</button></div>`;$('#retryStock').onclick=()=>loadStock(stock)}}
  function renderStock(s,d){closeChartZoom();const stockSequence=navigableStocks(),topicSequence=stockSequence.filter(stock=>stock.topic===s.topic),stockIndex=topicSequence.findIndex(stock=>stock.code===s.code);state.charts.forEach(c=>{try{window.klinecharts.dispose(c)}catch{}});state.charts=[];state.chartInstances=[];content.classList.toggle('six-grid-page',state.chartLayout==='grid');const pool=(state.review.pool?.stocks||[]).find(x=>String(x.ts_code||'').slice(0,6)===s.code),breakPool=(state.review.pool?.all_break_stocks||state.review.pool?.break_stocks||[]).find(x=>String(x.ts_code||'').slice(0,6)===s.code),nonPromotedPool=(state.review.marketStats?.nonPromotedStocks||[]).find(x=>String(x.ts_code||'').slice(0,6)===s.code);const isTouchedBreak=Boolean(s.isBroken||s.isUnpromoted&&s.touchedLimitToday||breakPool);const factTable=items=>items.length?`<div class=\"stock-key-table-wrap\"><div class=\"stock-key-grid${items.length<=12?' balanced':''}\">${items.map(([label,value,tone])=>`<div class=\"stock-key-fact\" title=\"${esc(label)}：${esc(value??'—')}\"><span>${esc(label)}</span><b${tone?` class="${tone}"`:''}>${esc(value??'—')}</b></div>`).join('')}</div></div>`:'';const keyFacts=pool?factTable([['首次涨停',pool.lu_time||'—'],['最后封板',pool.last_time||'—'],['开板耗时',openingDuration(pool.lu_time,pool.last_time)],['开板次数',pool.open_times??'—'],['封单金额',compactYuan(pool.limit_order)],['成交额',compactYuan(pool.daily_amount)],['自由换手率',pool.free_float_turnover_rate==null?'—':`${Number(pool.free_float_turnover_rate).toFixed(2)}%`],['封单率',sealedAmountRatio(pool)],['流通市值',compactMarketCap(pool.float_mv)],['总市值',compactMarketCap(pool.total_mv)],['量比',pool.volume_ratio==null?'—':Number(pool.volume_ratio).toFixed(2)],['开盘涨幅',priceChangePct(pool.daily_open,pool.pre_close)],['振幅',dailyAmplitudePct(pool)],...moneyFlowFacts(pool),['涨停跨度',d.previousLimitUpHistoricalFirst?'历史首板':d.previousLimitUpTradingDays==null?'—':`${d.previousLimitUpTradingDays}日`]]):isTouchedBreak?factTable([['首次触板',s.firstLimitTime||breakPool?.first_limit_time||'—'],['破板时间',s.breakTime||breakPool?.break_time||'—'],['今日最高涨幅',priceChangePct(breakPool?.daily_high,breakPool?.pre_close)],['开板耗时',openingDuration(s.firstLimitTime||breakPool?.first_limit_time,s.breakTime||breakPool?.break_time)],['开板次数',breakPool?.open_times??'—'],['成交额',compactYuan(breakPool?.daily_amount)],['自由换手率',breakPool?.free_float_turnover_rate==null?'—':`${Number(breakPool.free_float_turnover_rate).toFixed(2)}%`],['流通市值',compactMarketCap(breakPool?.float_mv)],['总市值',compactMarketCap(breakPool?.total_mv)],['量比',breakPool?.volume_ratio==null?'—':Number(breakPool.volume_ratio).toFixed(2)],['开盘涨幅',priceChangePct(breakPool?.daily_open,breakPool?.pre_close)],['振幅',dailyAmplitudePct(breakPool||{})],...moneyFlowFacts(breakPool||{}),['涨停跨度',d.previousLimitUpHistoricalFirst?'历史首板':d.previousLimitUpTradingDays==null?'—':`${d.previousLimitUpTradingDays}日`]]):s.isUnpromoted&&nonPromotedPool?factTable([['今日最高涨幅',nonPromotedPool.high_pct==null?'—':`${Number(nonPromotedPool.high_pct)>0?'+':''}${Number(nonPromotedPool.high_pct).toFixed(2)}%`],['成交额',compactYuan(nonPromotedPool.daily_amount)],['自由换手率',nonPromotedPool.free_float_turnover_rate==null?'—':`${Number(nonPromotedPool.free_float_turnover_rate).toFixed(2)}%`],['流通市值',compactMarketCap(nonPromotedPool.float_mv)],['总市值',compactMarketCap(nonPromotedPool.total_mv)],['量比',nonPromotedPool.volume_ratio==null?'—':Number(nonPromotedPool.volume_ratio).toFixed(2)],['开盘涨幅',priceChangePct(nonPromotedPool.daily_open,nonPromotedPool.pre_close)],['振幅',dailyAmplitudePct(nonPromotedPool)],...moneyFlowFacts(nonPromotedPool),['涨停跨度',d.previousLimitUpHistoricalFirst?'历史首板':d.previousLimitUpTradingDays==null?'—':`${d.previousLimitUpTradingDays}日`]]):'';const keyFactsHtml=keyFacts;const chartSpecs=[['oneMin','1 分钟','1 分钟数据库'],['daily','日线','日线数据库'],['fifteenMin','15 分钟','15 分钟数据库'],['monthly','月线','日线聚合'],['weekly','周线','日线聚合']];const conceptLabels=state.review.stockConcepts?.[s.code]||[],conceptRows=Array.from({length:3},(_,i)=>{const rowSize=Math.ceil(conceptLabels.length/3);return conceptLabels.slice(i*rowSize,(i+1)*rowSize);}),conceptTags=conceptLabels.length?`<div class="stock-concept-tags" aria-label="开盘啦题材标签">${conceptRows.map(row=>`<div class="stock-concept-tag-row">${row.map(label=>`<span>${esc(label)}</span>`).join('')}</div>`).join('')}</div>`:'',chartData=state.latestMode?mergeChartData(d,d.latest):d,latestDailyBars=chartData.daily||[],latestDailyBar=latestDailyBars[latestDailyBars.length-1],previousDailyBar=latestDailyBars[latestDailyBars.length-2],latestClose=latestDailyBar?.close==null?null:Number(latestDailyBar.close),latestPct=latestDailyBar?.pct_chg!=null?Number(latestDailyBar.pct_chg):latestClose!=null&&Number(previousDailyBar?.close)>0?(latestClose/Number(previousDailyBar.close)-1)*100:null,latestPctText=latestPct==null?'—':`${latestPct>=0?'+':''}${latestPct.toFixed(2)}%`;
    const latestQuoteDate=latestDailyBar?.timestamp?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}).format(new Date(latestDailyBar.timestamp)):state.date.slice(4,6)+'/'+state.date.slice(6,8);$('#crumbBack').hidden=false;$('#crumbBack').textContent=`← 返回概念：${s.topic}`;$('#crumbWorkspace').hidden=true;$('#crumbCurrent').hidden=true;$('#crumbSeparator').hidden=true;$('#crumbBack').onclick=()=>{if(state.review.topics.some(topic=>topic.name===s.topic))openTopic(s.topic,state.date);else{syncBrowserRoute('topic',state.date,s.topic);renderTopicNoData(s.topic);renderNav();}};content.innerHTML=`<div class="stock-head"><div class="stock-title"><div class="stock-monogram ${s.isUnpromoted?(isTouchedBreak?'broken':'unpromoted'):s.isBroken?'broken':pool?.board_shape==='one_word'?'one-word':pool?.board_shape==='t_shape'?'t-shape':'promoted'}">${esc(s.isUnpromoted||s.isBroken?stockOutcomeBadgeText(s,isTouchedBreak):(`${stockBoardNumber(s)||'—'}`))}</div><div class="stock-info-row"><div class="stock-info-copy"><span class="eyebrow">STOCK / ${fmtDate(state.date)}</span><div class="stock-name-row"><h1>${esc(s.name)}</h1><div class="stock-latest-quote"><span><i>收盘</i><b>${latestClose==null?'—':num(latestClose)}</b></span><span class="${latestPct==null?'':latestPct>=0?'pct-up':'pct-down'}"><i>涨幅</i><b>${esc(latestPctText)}</b></span></div></div><div class="stock-code">${esc(tushareCode(s.code))} · ${esc(s.navLabel||boardLabel(s.status))} · 行情日期 ${esc(latestQuoteDate)}</div></div>${keyFactsHtml}${conceptTags}</div></div></div><section class="stock-overview selectable"><div class="overview-grid stock-reason-only"><div class="overview-item"><span class="eyebrow">涨停原因</span><p><b>${esc(s.reason)}</b></p></div></div><div class="stock-mini-metrics"><div class="mini-metric"><span>题材</span><strong>${esc(s.topic)}</strong></div><div class="mini-metric"><span>封板时间</span><strong>${esc(pool?.lu_time||'—')}</strong></div><div class="mini-metric"><span>1 分钟覆盖</span><strong>${chartData.coverage.oneMinDays} 天 / ${chartData.coverage.oneMinBars} 根</strong></div><div class="mini-metric"><span>15 分钟覆盖</span><strong>${esc(chartData.coverage.fifteenDays)} 天 · ${esc(d.cacheBackend==='redis'?'Redis 缓存':'本地缓存')}</strong></div></div></section><div class="chart-stack ${state.chartLayout==='grid'?'six-grid':''}">${state.chartLayout==='grid'?`<section class="chart-card reason-card"><div class="chart-head"><div class="chart-title"><strong>涨停原因</strong></div></div><div class="reason-copy">${esc(s.reason)}</div></section>`:''}${chartSpecs.map(([key,title,source],i)=>`<section class="chart-card"><div class="chart-head"><div class="chart-title"><strong>${title}</strong>${['daily','weekly','monthly','fifteenMin'].includes(key)?`<span style="margin-left:6px;color:#f0c451;font-size:10px">涨停日 ${state.date.slice(4,6)}/${state.date.slice(6,8)}</span>`:''}</div><div class="chart-meta">${source} · ${(chartData[key]||[]).length} 根${key==='fifteenMin'&&chartData.coverage.fifteenStart?` · ${chartData.coverage.fifteenStart}—${chartData.coverage.fifteenEnd}`:''}</div></div><div id="chart-${i}" class="chart-mount ${key==='oneMin'||key==='fifteenMin'?'intraday':''}"></div>${key==='fifteenMin'&&chartData.coverage.fifteenError?`<div class="chart-note">15 分钟数据暂时被占用，其他周期仍可使用；请稍后重试。${chartData.coverage.fifteenStart?`当前缓存覆盖 ${chartData.coverage.fifteenStart}—${chartData.coverage.fifteenEnd}`:''}</div>`:key==='fifteenMin'&&chartData.coverage.fifteenDays<50?`<div class="chart-note">数据库当前覆盖 ${chartData.coverage.fifteenDays} 个交易日${chartData.coverage.fifteenStart?`（${chartData.coverage.fifteenStart}—${chartData.coverage.fifteenEnd}）`:''}；未用 1 分钟数据替代 15 分钟数据。</div>`:''}</section>`).join('')}</div>`;$('#topbarActions').innerHTML=`<div class="stock-nav-controls"><button class="date-nav-button" id="prevStock" ${canMoveStock(-1)?'':'disabled'}>← 上一只</button><span class="stock-position" title="题材内序号 / 当前题材股票总数 / 全部股票总数" aria-label="题材内序号、当前题材股票总数、全部股票总数">${stockIndex<0?'—':stockIndex+1} / ${topicSequence.length} / ${stockSequence.length}</span><button class="date-nav-button" id="nextStock" ${canMoveStock(1)?'':'disabled'}>下一只 →</button></div><button id="openSettings" class="settings-button" type="button" aria-label="设置" title="设置">⚙️</button>`;$('#openSettings').onclick=openSettings;$('#prevStock').onclick=()=>moveStockSelection(-1);$('#nextStock').onclick=()=>moveStockSelection(1);chartSpecs.forEach(([key,title],i)=>{const mount=document.getElementById(`chart-${i}`);drawChart(`chart-${i}`,chartData[key]||[],key,s.code,state.date,chartData.daily||[],chartData.suspendedDays||[]);if(mount){mount.title='双击放大图表';mount.addEventListener('dblclick',()=>toggleChartZoom(mount,title),true);}}); applyLadderReturnLink();}
  function registerSessionHighlight(kc){if(kc.getSupportedOverlays().includes('tradingAlertSessionHighlight'))return;kc.registerOverlay({name:'tradingAlertSessionHighlight',totalStep:3,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,createPointFigures({coordinates,bounding}){if(coordinates.length<2)return[];const left=Math.min(coordinates[0].x,coordinates[1].x),right=Math.max(coordinates[0].x,coordinates[1].x);if(right<=left)return[];return{type:'rect',attrs:{x:left,y:0,width:right-left,height:bounding.height},styles:{style:'fill',color:'rgba(198,207,214,0.12)',borderColor:'transparent',borderSize:0},ignoreEvent:true};}});}
  function registerSuspensionHighlight(kc){if(kc.getSupportedOverlays().includes('tradingAlertSuspensionHighlight'))return;kc.registerOverlay({name:'tradingAlertSuspensionHighlight',totalStep:2,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,createPointFigures({coordinates,bounding}){if(coordinates.length<2)return[];const left=Math.min(coordinates[0].x,coordinates[1].x),right=Math.max(coordinates[0].x,coordinates[1].x);if(right<=left)return[];const centerX=left+(right-left)/2,centerY=bounding.height/2;return[{type:'rect',attrs:{x:left,y:0,width:right-left,height:bounding.height},styles:{style:'fill',color:'rgba(240,196,81,0.13)',borderColor:'rgba(240,196,81,0.28)',borderSize:1},ignoreEvent:true},{type:'text',attrs:{x:centerX,y:centerY,text:'停 牌',align:'center',baseline:'middle'},styles:{color:'#f0c451',size:14,weight:'bold',backgroundColor:'transparent',borderColor:'transparent',paddingLeft:0,paddingRight:0,paddingTop:0,paddingBottom:0},ignoreEvent:true}];}});}
  function registerSessionCloseLabel(kc){
    if(kc.getSupportedOverlays().includes('tradingAlertSessionCloseLabel'))return;
    kc.registerOverlay({name:'tradingAlertSessionCloseLabel',totalStep:1,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
      createXAxisFigures:({coordinates})=>coordinates.length?[{type:'text',attrs:{x:coordinates[0].x-2,y:4,text:'15:00',align:'right',baseline:'top'},styles:{color:'#9aa4ad',size:9},ignoreEvent:true}]:[]});
  }
  function completeLiveSessionAxis(bars,date){
    if(!bars.length||date!==shanghaiDateKey()||chartDayKey(bars.at(-1))!==date)return bars;
    const result=bars.slice(),last=bars.at(-1).timestamp,midnight=Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}T00:00:00+08:00`);
    for(const [start,end] of [[571,690],[781,900]])for(let minute=start;minute<=end;minute++){
      const timestamp=midnight+minute*60000;if(timestamp>last)result.push({timestamp,futureSession:true});
    }
    return result;
  }
  function registerLiveSessionVolume(kc){
    if(kc.getSupportedIndicators().includes('LIVE_SESSION_VOL'))return;
    const periods=[5,10,20,60];kc.registerIndicator({name:'LIVE_SESSION_VOL',shortName:'VOL',series:'volume',calcParams:periods,precision:2,minValue:0,shouldFormatBigNumber:true,
      figures:[...periods.map(n=>({key:'ma'+n,title:'MA'+n+': ',type:'line'})),{key:'volume',title:'VOLUME: ',type:'bar',styles:({data})=>({color:data.current?.close>=data.current?.open?'#d45555':'#148a69'})}],
      calc(bars){const sums=periods.map(()=>0);return bars.map((bar,i)=>{if(bar.futureSession)return {};const volume=Number(bar.volume)||0,result={volume};periods.forEach((n,j)=>{sums[j]+=volume;if(i>=n)sums[j]-=Number(bars[i-n].volume)||0;if(i>=n-1)result['ma'+n]=sums[j]/n;});return result;});}
    });
  }
  function registerIntradayAverage(kc){if(kc.getSupportedIndicators().includes('INTRADAY_AVG'))return;const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});kc.registerIndicator({name:'INTRADAY_AVG',shortName:'分时均线',calcParams:[],precision:2,shouldOhlc:false,shouldFormatBigNumber:false,series:'price',styles:{lines:[{color:'#f0c451',size:1}]},figures:[{key:'average',title:'分时均线: ',type:'line'}],calc(bars){let day='',amount=0,volume=0;return bars.map((bar,index)=>{const currentDay=dateFormat.format(new Date(bar.timestamp)),dayChanged=currentDay!==day;if(dayChanged){day=currentDay;amount=0;volume=0;}const close=Number(bar.close)||0,barVolume=Number(bar.volume)||0,barAmount=Number(bar.amount??(close*barVolume))||0;if(bar.suspended||bar.futureSession)return {average:null};amount+=barAmount;volume+=barVolume;return {average:dayChanged&&index>0?null:volume===0?close:amount/volume};});}});}
  function registerIndexTurnover(kc){
    if(kc.getSupportedIndicators().includes('INDEX_TURNOVER'))return;
    kc.registerIndicator({name:'INDEX_TURNOVER',shortName:'成交额',calcParams:[5,10,20,60],precision:2,series:'volume',minValue:0,shouldOhlc:false,shouldFormatBigNumber:true,
      figures:[{key:'turnover',title:'成交额: ',type:'bar',styles:({data})=>{const bar=data.current;return {color:!bar?'#888':bar.close>=bar.open?'#d45555':'#148a69'};}},...[5,10,20,60].map(n=>({key:'ma'+n,title:'MA'+n+': ',type:'line'}))],
      calc(bars){const totals=[0,0,0,0],periods=[5,10,20,60];return bars.map((bar,i)=>{if(bar.futureSession)return {};const value=Number(bar.amount)||0,result={turnover:value,open:Number(bar.open),close:Number(bar.close)};periods.forEach((n,j)=>{totals[j]+=value;if(i>=n)totals[j]-=Number(bars[i-n].amount)||0;result['ma'+n]=i>=n-1?totals[j]/n:null;});return result;});}
    });
  }
  const chartDayKey = (bar) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(bar.timestamp)).replaceAll('-','');
  function weekKey(day){const y=Number(day.slice(0,4)),m=Number(day.slice(4,6))-1,d=Number(day.slice(6,8));const t=new Date(Date.UTC(y,m,d));t.setUTCDate(t.getUTCDate()-((t.getUTCDay()+6)%7));return t.toISOString().slice(0,10);}
  function inChartPeriod(day,anchor,key){return key==='weekly'?weekKey(day)===weekKey(anchor):key==='monthly'?day.slice(0,6)===anchor.slice(0,6):day===anchor;}
  const chartFactContexts=new WeakMap();
  function chartReferenceClose(daily,day){
    const previous=daily.filter(bar=>chartDayKey(bar)<day&&Number(bar.close)>0).at(-1);
    if(previous)return Number(previous.close);
    const current=daily.find(bar=>chartDayKey(bar)===day),value=Number(current?.pre_close);
    return value>0?value:null;
  }
  function registerChartPercentAxis(kc){
    if(kc.getSupportedIndicators().includes('TRADING_ALERT_PERCENT_AXIS'))return;
    kc.registerIndicator({name:'TRADING_ALERT_PERCENT_AXIS',shortName:'',series:'price',precision:2,visible:false,figures:[],calc:()=>[]});
  }
  function configureChartFacts(chart,host,key,bars,daily,analysisDate,options={}){
    let context=chartFactContexts.get(chart);if(!context){context={};chartFactContexts.set(chart,context);}
    const real=bars.filter(bar=>!bar.futureSession&&Number(bar.close)>0),firstDay=real.length?chartDayKey(real[0]):'',base=key==='oneMin'?chartReferenceClose(daily,firstDay):null;
    Object.assign(context,{key,bars:real,daily,analysisDate,base,host});
    const percent=value=>value==null||!Number.isFinite(Number(value))?'—':(Number(value)>0?'+':'')+Number(value).toFixed(2)+'%';
    chart.setStyles({candle:{tooltip:{legend:{template:({prev,current})=>{
      const price=Number(current.close),prior=prev?.close,dayBase=key==='oneMin'?chartReferenceClose(context.daily,chartDayKey(current)):null,rawPct=key==='oneMin'?(dayBase?((price/dayBase)-1)*100:null):current.pct_chg??(Number(prior)>0?(price/Number(prior)-1)*100:null),amount=current.amount==null?null:Number(current.amount)*(['daily','weekly','monthly'].includes(key)?1000:1),turn=current.turnover_rate_f;
      const rows=[{title:'',value:'{time}'},{title:'开 ',value:'{open}'},{title:'高 ',value:'{high}'},{title:'低 ',value:'{low}'},{title:'收 ',value:'{close}'},{title:'额 ',value:compactYuan(amount)},{title:'幅 ',value:{text:percent(rawPct),color:rawPct>0?'#d45555':rawPct<0?'#148a69':'#9aa4ad'}}];
      if(key==='daily')rows.push({title:'换 ',value:turn==null?'—':Number(turn).toFixed(2)+'%'});
      host.dataset.tooltipDate=chartDayKey(current);host.dataset.tooltipBase=dayBase==null?'':String(dayBase);host.dataset.tooltipPct=rawPct==null?'':Number(rawPct).toFixed(4);host.dataset.tooltipTurnover=turn==null?'':String(turn);host.dataset.tooltipAmount=amount==null?'':String(amount);
      return rows;
    }}}}});
    if(key!=='oneMin'||!options.detached||!base)return;
    const previous=chartReferenceClose(daily,String(analysisDate).replaceAll('-',''));
    let maximum=Math.max(.5,...real.flatMap(bar=>[bar.high,bar.low,bar.close].filter(value=>value!=null&&Number.isFinite(Number(value))).map(value=>Math.abs((Number(value)/base-1)*100))),...previous?[Math.abs((previous/base-1)*100)]:[]);
    const step=maximum<=10?.5:maximum<=20?1:5;maximum=Math.ceil(maximum*1.08/step)*step;
    context.maximum=maximum;
    const from=base*(1-maximum/100),to=base*(1+maximum/100),range=to-from;
    const priceRange=()=>({from,to,range,realFrom:from,realTo:to,realRange:range,displayFrom:from,displayTo:to,displayRange:range});
    const pctRange=()=>({from,to,range,realFrom:-maximum,realTo:maximum,realRange:2*maximum,displayFrom:-maximum,displayTo:maximum,displayRange:2*maximum});
    const percentAxisId='trading-alert-percent-axis',priceAxis=chart.getYAxes({paneId:'candle_pane'}).find(axis=>axis.id!==percentAxisId);
    if(!priceAxis)return;
    registerChartPercentAxis(window.klinecharts);
    const kc=window.klinecharts;
    if(!kc.getSupportedOverlays().includes('tradingAlertReferenceLine'))kc.registerOverlay({name:'tradingAlertReferenceLine',totalStep:1,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
      createPointFigures:({coordinates,bounding,overlay})=>coordinates.length?[{type:'line',attrs:{coordinates:[{x:0,y:coordinates[0].y},{x:bounding.width,y:coordinates[0].y}]},styles:{color:'#f0c451',size:overlay.extendData?.size||1,style:'dashed',dashedValue:overlay.extendData?.dashes||[5,3]},ignoreEvent:true},{type:'text',attrs:{x:4,y:coordinates[0].y-3,text:overlay.extendData?.label||'',align:'left',baseline:'bottom'},styles:{color:'#f0c451',size:8,backgroundColor:'transparent'},ignoreEvent:true}]:[]});
    if(!chart.getIndicators({id:'trading-alert-percent-carrier'}).length)chart.createIndicator({id:'trading-alert-percent-carrier',name:'TRADING_ALERT_PERCENT_AXIS',paneId:'candle_pane',yAxisId:percentAxisId,visible:false},false);
    chart.overrideYAxis({paneId:'candle_pane',id:priceAxis.id,name:'normal',position:'left',gap:{top:0,bottom:0},createRange:priceRange});
    chart.overrideYAxis({paneId:'candle_pane',id:percentAxisId,name:'normal',position:'right',gap:{top:0,bottom:0},createRange:pctRange,minSpan:()=>.01,
      valueToRealValue:(value,{range:r})=>r.range?(value-r.from)/r.range*r.realRange+r.realFrom:r.realFrom,
      realValueToValue:(value,{range:r})=>r.realRange?(value-r.realFrom)/r.realRange*r.range+r.from:r.from,
      displayValueToText:value=>(Number(value)>0?'+':'')+Number(value).toFixed(2)+'%'});
    const baseline=(id,value,color,size,dashes)=>({name:'tradingAlertReferenceLine',id,paneId:'candle_pane',lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,points:[{timestamp:real[0].timestamp,value}],extendData:{size,dashes,label:id==='intraday-zero-line'?'五日 0.00%':'当日昨收'}});
    chart.removeOverlay({id:'intraday-zero-line'});chart.createOverlay(baseline('intraday-zero-line',base,'#f0c451',1.1,[5,3]));
    chart.removeOverlay({id:'intraday-selected-prev-close'});if(previous&&Math.abs(previous-base)>1e-8)chart.createOverlay(baseline('intraday-selected-prev-close',previous,'#f0c451',.7,[2,3]));
    Object.assign(host.dataset,{pctBase:String(base),pctBaseDate:firstDay,pctMin:String(-maximum),pctMax:String(maximum),priceMin:String(from),priceMax:String(to),selectedPreviousClose:previous==null?'':String(previous),axisMode:'left-price-right-five-day-pct'});
  }
  function drawChart(id,data,key,ticker,analysisDate,dailyBars,suspendedDays=[],options={}){const host=document.getElementById(id);if(!host)return;host.style.backgroundColor=key==='fifteenMin'?'#18202a':'#0b0d0f';if(!data.length){host.innerHTML='<div class="empty-state">该周期暂无行情数据</div>';return;}const realData=data;if(options.liveSession&&key==='oneMin'){data=completeLiveSessionAxis(data,analysisDate);host.dataset.sessionEnd=String(data.at(-1).timestamp);host.dataset.lastQuoteTime=String(realData.at(-1).timestamp);}const kc=window.klinecharts,compact=options.compact??content.classList.contains('six-grid-page'),indexIntraday=Boolean(state.index||options.isIndex)&&(key==='oneMin'||key==='fifteenMin');try{const chart=kc.init(id);if(!chart){host.innerHTML='<div class="empty-state">图表初始化失败</div>';return;}if(!options.detached){state.charts.push(id);state.chartInstances.push(chart);}chart.setStyles('dark');if(options.line)chart.setStyles({candle:{type:'area',area:{value:'close',lineSize:1,lineColor:'#e4ece7',backgroundColor:'transparent',point:{show:false}}}});chart.setStyles({candle:{bar:{upColor:'#d45555',downColor:'#148a69',noChangeColor:'#888',upBorderColor:'#d45555',downBorderColor:'#148a69',upWickColor:'#d45555',downWickColor:'#148a69'},tooltip:{title:{show:false,template:''},legend:compact?{size:9,family:'Helvetica Neue',marginLeft:2,marginTop:1,marginRight:2,marginBottom:1}:{size:12}},priceMark:{last:{line:{show:false},text:{show:false}}}},indicator:{bars:[{upColor:'#d45555',downColor:'#148a69',noChangeColor:'#888'}],tooltip:compact?{showRule:'always',offsetTop:2,title:{show:true,showName:false,showParams:false,size:9,family:'Helvetica Neue',marginLeft:2,marginTop:1,marginRight:3,marginBottom:1},legend:{size:9,family:'Helvetica Neue',marginLeft:3,marginTop:1,marginRight:4,marginBottom:1}}:{showRule:'always',offsetTop:4}},crosshair:{show:true,horizontal:{show:true,line:{show:true,...(['daily','weekly','monthly','fifteenMin'].includes(key)?{color:'#f0c451',size:1}:{})}},vertical:{show:true,line:{show:true,...(['daily','weekly','monthly','fifteenMin'].includes(key)?{color:'#f0c451',size:1}:{})}}},grid:{horizontal:{color:'#292d31'},vertical:{color:'#202428'}},xAxis:{axisLine:{color:'#343a40'},tickLine:{color:'#343a40'},tickText:{color:'#9aa4ad'}},yAxis:{axisLine:{color:'#343a40'},tickLine:{color:'#343a40'},tickText:{color:'#9aa4ad'}},separator:{color:'#343a40'}});if(options.detached)chart.setStyles({candle:{tooltip:{showRule:'follow_cross'}},indicator:{tooltip:{showRule:'follow_cross'}},xAxis:{tickText:{size:9}},yAxis:{tickText:{size:9}}});if(!kc.__tradingAlertNoTimeLabel&&typeof kc.registerLocale==='function'){kc.registerLocale('zh-CN',{time:'',volume:'量：'});kc.__tradingAlertNoTimeLabel=true;}if(indexIntraday&&!kc.__tradingAlertIndexLocale){kc.registerLocale('zh-CN-index',{time:'',open:'开：',high:'高：',low:'低：',close:'收：',volume:'成交额：',turnover:'成交额：',change:'涨幅：',second:'秒',minute:'',hour:'小时',day:'天',week:'周',month:'月',year:'年'});kc.__tradingAlertIndexLocale=true;}chart.setLocale(indexIntraday?'zh-CN-index':'zh-CN');chart.setTimezone('Asia/Shanghai');chart.setDataLoader(options.stream?{getBars:({type,callback})=>callback(type==='init'?options.stream.getBars():[],false),subscribeBar:({callback})=>options.stream.subscribe(callback),unsubscribeBar:()=>options.stream.unsubscribe()}:{getBars:({callback})=>callback(data,false)});chart.setSymbol({ticker,pricePrecision:2,volumePrecision:2});const type=key==='weekly'?'week':key==='monthly'?'month':key==='oneMin'||key==='fifteenMin'?'minute':'day';chart.setPeriod({type,span:key==='fifteenMin'?15:1});if(['daily','weekly','monthly','fifteenMin'].includes(key))chart.createIndicator({name:'MA',calcParams:[5,10,20,30,60,120,250],paneId:'candle_pane'},true);if(key==='oneMin'&&!indexIntraday){registerIntradayAverage(kc);chart.createIndicator({name:'INTRADAY_AVG',paneId:'candle_pane'},true);}if(indexIntraday)registerIndexTurnover(kc);if(options.liveSession)registerLiveSessionVolume(kc);chart.createIndicator({name:indexIntraday?'INDEX_TURNOVER':options.liveSession?'LIVE_SESSION_VOL':'VOL',calcParams:[5,10,20,60],paneId:'volume_pane',precision:2,shouldFormatBigNumber:true},false);const candleHeight=compact?Math.max(135,Math.round(host.clientHeight*.78)):Math.max(320,Math.round(host.clientHeight*.78)),volumeHeight=compact?Math.max(38,Math.round(host.clientHeight*.18)):Math.max(64,Math.round(host.clientHeight*.18));chart.setPaneOptions({id:'candle_pane',height:candleHeight,minHeight:compact?120:300});chart.setPaneOptions({id:'volume_pane',height:volumeHeight,minHeight:compact?32:56});if(key==='oneMin'){const minSpace=options.minBarSpace??(indexIntraday?0.1:0.5);chart.setLayoutOptions({barSpaceLimit:{min:minSpace,max:50}});const plotWidth=Math.max(1,host.clientWidth-100);chart.setBarSpace(Math.max(minSpace,Math.min(50,plotWidth/data.length)));}chart.overrideYAxis({paneId:'candle_pane',name:'default',gap:{top:0.22,bottom:0.08}});chart.overrideYAxis({paneId:'volume_pane',name:'default',gap:{top:compact?0.55:0.38,bottom:0.04}});if(key==='oneMin'||key==='fifteenMin'){const dayLabel=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});const separators=[];const lineStyle={color:'#cbd5cf',size:.8,style:'dashed',dashedValue:[4,3]};const addSeparator=(bar,index)=>{for(const paneId of ['candle_pane','volume_pane'])separators.push({name:'verticalStraightLine',paneId,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,points:[{timestamp:bar.timestamp,dataIndex:index}],styles:{line:lineStyle}});};data.forEach((bar,index)=>{const day=dayLabel.format(new Date(bar.timestamp)),firstOfDay=index===0||day!==dayLabel.format(new Date(data[index-1].timestamp));if(firstOfDay)addSeparator(bar,index);});if(key==='oneMin'){const lastBar=data[data.length-1];for(const paneId of ['candle_pane','volume_pane'])separators.push({name:'verticalStraightLine',paneId,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:Boolean(options.liveSession),needDefaultYAxisFigure:false,points:[{timestamp:lastBar.timestamp+(options.liveSession?0:60_000),dataIndex:data.length-(options.liveSession?1:0)}],styles:{line:lineStyle}});}if(separators.length)chart.createOverlay(separators);if(key==='oneMin'&&options.liveSession){registerSessionCloseLabel(kc);chart.createOverlay({name:'tradingAlertSessionCloseLabel',paneId:'candle_pane',lock:true,points:[{timestamp:data.at(-1).timestamp,dataIndex:data.length-1}]});}}
      if(key==='oneMin'){
        registerSuspensionHighlight(kc);
        suspendedDays.forEach(item=>{const day=String(item.date||'').replaceAll('-','');const dayBars=data.filter(bar=>bar.suspended&&chartDayKey(bar)===day);if(dayBars.length){const first=dayBars[0],last=dayBars.at(-1);chart.createOverlay({name:'tradingAlertSuspensionHighlight',id:'suspension-'+day,paneId:'candle_pane',lock:true,zLevel:-1,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,points:[{timestamp:first.timestamp,dataIndex:data.indexOf(first)},{timestamp:last.timestamp,dataIndex:data.indexOf(last)}]});}});
      }
      if(analysisDate){
        const anchor=String(analysisDate).replaceAll('-','');
        const dateBars=data.filter(bar=>chartDayKey(bar)===anchor);
        const dailyEvent=(dailyBars||[]).find(bar=>chartDayKey(bar)===anchor);
        const eventBar=(key==='oneMin'||key==='fifteenMin')?(dateBars.filter(bar=>!bar.futureSession).at(-1)||null):dailyEvent;
        const periodMarker=['weekly','monthly'].includes(key)?data.filter(bar=>inChartPeriod(chartDayKey(bar),anchor,key)).at(-1):null;
        const targetPrice=eventBar?Number(eventBar.close):NaN;
        if(Number.isFinite(targetPrice)&&targetPrice>0){
          const lineAnchor=periodMarker||eventBar;
          chart.createOverlay({name:'horizontalStraightLine',id:'selected-limitup-close-'+key,groupId:'selected-limitup-close',paneId:'candle_pane',lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,points:[{timestamp:lineAnchor.timestamp,value:targetPrice}],styles:{line:{color:'#f0c451',size:.8,style:'dashed',dashedValue:[4,3]}}});
        }
        if(['oneMin','fifteenMin'].includes(key)&&dateBars.length){
          registerSessionHighlight(kc);
          const first=dateBars[0],dayLast=dateBars.at(-1),nextDayFirst=key==='fifteenMin'?data.find(bar=>chartDayKey(bar)>anchor):null,last=nextDayFirst||dayLast;
          chart.createOverlay({name:'tradingAlertSessionHighlight',id:'selected-limitup-session-band-'+key,paneId:'candle_pane',lock:true,zLevel:-1,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,points:[{timestamp:first.timestamp,dataIndex:data.indexOf(first)},{timestamp:last.timestamp,dataIndex:data.indexOf(last)}]});
        }else if(['daily','weekly','monthly'].includes(key)){
          const marker=key==='weekly'||key==='monthly'?periodMarker:data.filter(bar=>inChartPeriod(chartDayKey(bar),anchor,key)).at(-1);
          if(marker)chart.createOverlay({name:'verticalStraightLine',id:'selected-limitup-date-'+key,groupId:'selected-limitup-date',paneId:'candle_pane',lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:true,needDefaultYAxisFigure:false,points:[{timestamp:marker.timestamp}],styles:{line:{color:'#f0c451',size:.8,style:'dashed',dashedValue:[4,3]}}});
        }
      }
      if(analysisDate&&!state.latestMode&&!options.endAtLatest){let target=-1;data.forEach((bar,index)=>{if(chartDayKey(bar)<=String(analysisDate).replaceAll('-',''))target=index;});if(target>=0)chart.scrollToDataIndex(target,0);else chart.scrollToRealTime();}else{chart.setOffsetRightDistance(0);chart.scrollToRealTime();}configureChartFacts(chart,host,key,data,dailyBars||[],analysisDate,options);return chart;}catch(e){console.error(e);host.innerHTML=`<div class="empty-state">图表加载失败：${esc(e.message)}</div>`;}}
  function syncSettingsOptions(){document.querySelectorAll('#uiScaleOptions [data-scale]').forEach(button=>button.classList.toggle('active',button.dataset.scale===state.uiScalePreference));document.querySelectorAll('#chartLayoutOptions [data-layout]').forEach(button=>button.classList.toggle('active',button.dataset.layout===state.chartLayout));document.querySelectorAll('#stockDateModeOptions [data-mode]').forEach(button=>button.classList.toggle('active',button.dataset.mode===(state.index?(state.latestMode?'latest':'analysis'):state.stockDatePreference)));}
  function openSettings(){syncSettingsOptions();$('#settingsOverlay').hidden=false;requestAnimationFrame(()=>$('#closeSettings').focus());}
  function closeSettings(){ $('#settingsOverlay').hidden=true; }
  function setupSettings(){const overlay=$('#settingsOverlay');$('#closeSettings').onclick=closeSettings;overlay.addEventListener('click',event=>{if(event.target===overlay)closeSettings();});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!overlay.hidden)closeSettings();});$('#uiScaleOptions').addEventListener('click',event=>{const button=event.target.closest('[data-scale]');if(!button)return;state.uiScalePreference=button.dataset.scale;localStorage.setItem('uiScalePreference',state.uiScalePreference);fitUiScale();syncSettingsOptions();});$('#chartLayoutOptions').addEventListener('click',event=>{const button=event.target.closest('[data-layout]');if(!button)return;state.chartLayout=button.dataset.layout;localStorage.setItem('chartLayout',state.chartLayout);fitUiScale();syncSettingsOptions();if(state.stock&&state.stockData)renderStock(state.stock,state.stockData);else if(state.index&&state.indexData)renderIndex(state.index,state.indexData);});$('#stockDateModeOptions').addEventListener('click',event=>{const button=event.target.closest('[data-mode]');if(!button)return;state.stockDatePreference=button.dataset.mode;localStorage.setItem('stockDatePreference',state.stockDatePreference);if(state.index&&history.state?.indexCutoff)history.replaceState({...history.state,indexCutoff:false},'',location.href);state.latestMode=state.stockDatePreference==='latest';syncSettingsOptions();if(state.stock&&state.stockData)renderStock(state.stock,state.stockData);else if(state.index)loadIndex(state.index);});}
  let pendingSelection=null;
  function openAnalysis(text,topic,code){pendingSelection={text,topic,code:canonicalStockCode(code)};$('#selectedText').textContent=text;$('#analysisResult').innerHTML='<div class="empty-insight"><span>✦</span><p>点击“生成结构化分析”，查看日报中对应的题材催化和个股逻辑。</p></div>';$('#analysisDrawer').classList.add('open');$('#analysisDrawer').setAttribute('aria-hidden','false');$('#selectionAction').hidden=true;}
  function setupSelection(){document.addEventListener('mouseup',e=>{const sel=window.getSelection();const text=sel?.toString().trim();if(!text||!e.target.closest('.selectable'))return;pendingSelection={text,topic:state.topic||'',code:state.stock?canonicalStockCode(state.stock.ts_code||state.stock.code):''};const action=$('#selectionAction');action.hidden=false;action.style.left=`${Math.min(innerWidth-70,Math.max(75,e.clientX))}px`;action.style.top=`${Math.max(58,e.clientY-10)}px`;});document.addEventListener('mousedown',e=>{if(!e.target.closest('#selectionAction'))$('#selectionAction').hidden=true});$('#analyzeSelection').onclick=()=>{if(pendingSelection)openAnalysis(pendingSelection.text,pendingSelection.topic,pendingSelection.code)};$('#closeDrawer').onclick=()=>{$('#analysisDrawer').classList.remove('open');$('#analysisDrawer').setAttribute('aria-hidden','true')};$('#runAnalysis').onclick=runAnalysis;setupStockKeyboard();}
  async function runAnalysis(){if(!pendingSelection)return;const b=$('#runAnalysis');b.disabled=true;b.textContent='正在整理…';try{const d=await api('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:state.date,topic:pendingSelection.topic,code:pendingSelection.code,selection:pendingSelection.text,question:$('#analysisQuestion').value})});const stock=d.stock||{};const list=(d.stocks||[]).map(x=>`${x.name}：${x.reason}；${x.bridge}`).join('<br>');$('#analysisResult').innerHTML=`<div class="insight-block"><h4>选中的内容</h4><div class="insight-quote">${esc(d.selected)}</div></div>${d.question?`<div class="insight-block"><h4>你的问题</h4><p>${esc(d.question)}</p></div>`:''}<div class="insight-block"><h4>当日题材催化</h4><p>${esc(d.catalyst||'Neo4j 未提供题材总述')}</p></div><div class="insight-block"><h4>${stock.name?'个股逻辑桥梁':'题材内涨停个股'}</h4><p>${stock.name?`<b>${esc(stock.reason||'')}</b><br>${esc(stock.bridge||'')}`:list||'没有匹配到个股记录'}</p></div>${stock.name?`<div class="insight-block"><h4>判断边界</h4><p>${esc(stock.caveat||stock.confidence||'需要结合盘中信息进一步确认')}</p></div>`:''}<div class="insight-block"><h4>数据模式</h4><p>${esc(d.disclaimer)}</p></div>`;}catch(e){$('#analysisResult').innerHTML=`<div class="empty-state">分析失败：${esc(e.message)}</div>`;}finally{b.disabled=false;b.innerHTML='生成结构化分析 <span>→</span>';}}
  const formatCalendarDate=date=>date?`${date.slice(0,4)}/${date.slice(4,6)}/${date.slice(6,8)}`:'';
  const datePickerTriggerMarkup=(id,className,date=state.date)=>`<button id="${id}" class="${className} topbar-calendar-trigger date-picker-trigger" data-date-picker-trigger type="button" aria-label="选择复盘日期" aria-haspopup="dialog" aria-expanded="false"><span class="date-trigger-label">${formatCalendarDate(date)}</span><span class="nav-calendar-icon" aria-hidden="true">▦</span></button>`;
  let calendarMonth='';
  function closeDatePicker(){if(activeDatePickerTrigger)activeDatePickerTrigger.setAttribute('aria-expanded','false');datePicker.hidden=true;activeDatePickerTrigger=null;}
  function datePickerSelectedDate(trigger=activeDatePickerTrigger){
    return (trigger?.id==='ladderSpecifiedDay'?ladderView?.specifiedDay:trigger?.id==='ladderDatePickerTrigger'?ladderView?.endDay:state.date)||state.dates.at(-1);
  }
  function openDatePicker(trigger){
    if(activeDatePickerTrigger&&activeDatePickerTrigger!==trigger)activeDatePickerTrigger.setAttribute('aria-expanded','false');
    activeDatePickerTrigger=trigger;calendarMonth=datePickerSelectedDate(trigger).slice(0,6);renderDatePicker();
    document.body.append(datePicker);datePicker.hidden=false;trigger.setAttribute('aria-expanded','true');
    const rect=trigger.getBoundingClientRect(),width=248;
    let left=rect.right-width;left=Math.max(8,Math.min(left,window.innerWidth-width-8));
    let top=rect.bottom+7;datePicker.style.left=`${left}px`;datePicker.style.top=`${top}px`;
    if(top+datePicker.offsetHeight>window.innerHeight-8){top=Math.max(8,rect.top-datePicker.offsetHeight-7);datePicker.style.top=`${top}px`;}
    if(trigger.id==='topicDatePickerTrigger'){
      const topic=state.topic;
      if(topic&&!state.topicDates[topic])api(`/api/topic-dates?topic=${encodeURIComponent(topic)}`).then(result=>{state.topicDates[topic]=new Set(result.dates||[]);if(activeDatePickerTrigger?.id==='topicDatePickerTrigger'&&state.topic===topic)renderDatePicker();}).catch(()=>{state.topicDates[topic]=new Set([state.date]);if(activeDatePickerTrigger?.id==='topicDatePickerTrigger'&&state.topic===topic)renderDatePicker();toast('暂时无法读取该题材的有记录日期');});
    }
  }
  function renderDatePicker(){
    const selected=datePickerSelectedDate();
    if(!calendarMonth&&selected)calendarMonth=selected.slice(0,6);
    if(!calendarMonth)return;
    const year=Number(calendarMonth.slice(0,4)),month=Number(calendarMonth.slice(4,6));
    const monthValue=year*100+month,minMonth=Number(state.dates[0].slice(0,6)),maxMonth=Number(state.dates[state.dates.length-1].slice(0,6));
    const count=new Date(Date.UTC(year,month,0)).getUTCDate(),offset=(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7;
    const marketDates=new Set(state.dates),topicMode=activeDatePickerTrigger?.id==='topicDatePickerTrigger',topicDates=topicMode?(state.topicDates[state.topic]||new Set([state.date])):null,latestDates=topicMode?(state.topicDates[state.topic]?Array.from(state.topicDates[state.topic]).sort():[]):state.dates,latestDate=latestDates[latestDates.length-1]||'',cells=Array(offset).fill('<span class="calendar-blank"></span>');
    for(let day=1;day<=count;day++){
      const date=`${calendarMonth}${String(day).padStart(2,'0')}`,isAvailable=marketDates.has(date)&&(!topicMode||topicDates.has(date)),isSelected=date===selected;
      cells.push(`<button type="button" class="${isAvailable?'available':''}${isSelected?' selected':''}" data-date="${date}" aria-label="${date}" ${isAvailable?'':'disabled'}>${day}</button>`);
    }
    while(cells.length%7)cells.push('<span class="calendar-blank"></span>');
    const ladderMode=['ladderDatePickerTrigger','ladderSpecifiedDay'].includes(activeDatePickerTrigger?.id),selectedIndex=state.dates.indexOf(selected),previousDate=state.dates[selectedIndex-1]||'',nextDate=state.dates[selectedIndex+1]||'';
    const latestButton=`<button type="button" class="calendar-latest-button" data-latest="true" title="跳转到${latestDate?formatCalendarDate(latestDate):'最新可用日期'}" ${latestDate&&(!ladderMode||selected!==latestDate)?'':'disabled'}>回到最新一天</button>`;
    const dayNavigation=ladderMode?`<div class="calendar-trade-navigation"><button type="button" class="calendar-day-nav" data-date="${previousDate}" aria-label="前一交易日" ${previousDate?'':'disabled'}>← 前一日</button>${latestButton}<button type="button" class="calendar-day-nav" data-date="${nextDate}" aria-label="后一交易日" ${nextDate?'':'disabled'}>后一日 →</button></div>`:'';
    datePicker.innerHTML=`<div class="calendar-head"><button type="button" class="calendar-month-nav" data-month="-1" aria-label="上个月" ${monthValue<=minMonth?'disabled':''}>‹</button><strong>${year}年${month}月</strong><button type="button" class="calendar-month-nav" data-month="1" aria-label="下个月" ${monthValue>=maxMonth?'disabled':''}>›</button></div><div class="calendar-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-grid">${cells.join('')}</div>${dayNavigation}${ladderMode?'':`<div class="calendar-footer">${latestButton}</div>`}`;
  }
  async function chooseReviewDate(date){if(!state.dates.includes(date))return;const pickerId=activeDatePickerTrigger?.id;closeDatePicker();if(pickerId==='ladderSpecifiedDay'){ladderView?.setSpecifiedLegendDate?.(date);return;}if(pickerId==='ladderDatePickerTrigger'){await openLadderDate(date);return;}if(state.indicesPage){await openIndicesOverview(date);return;}if(state.topic){const topic=state.topic;syncBrowserRoute('topic',date,topic);if(!await loadDate(date))return;renderNav();if(state.review.topics.some(item=>item.name===topic))renderTopic(topic);else renderTopicNoData(topic);return;}syncBrowserRoute('home',date);await loadDate(date);}
  function needsReviewDate(date){return date!==state.date||state.review?.date!==date;}
  async function loadDate(date,{renderHomePage=true}={}){
    const requestId=++state.dateLoadId,route=location.href;
    state.date=date;state.stockLoadId++;state.indexLoadId++;
    const current=()=>requestId===state.dateLoadId&&date===state.date&&route===location.href;
    document.querySelectorAll('.date-trigger-label').forEach(label=>label.textContent=formatCalendarDate(date));
    content.innerHTML='<div class="loading"><span class="spinner"></span><p>正在读取每日分析与市场数据…</p></div>';
    try{
      const review=await api(`/api/review?date=${date}`);
      if(!current())return false;
      if(review.date!==date)throw new Error('返回的行情日期与所选日期不一致');
      state.review=review;
      $('#dataSourceLabel').textContent=`已连接 · 涨停行情库${review.analysisStatus==='待补充'?' · 题材分析待补充':''}`;
      $('#crumbCurrent').textContent='每日总览';if(renderHomePage)renderHome();return true;
    }catch(error){
      if(!current())return false;
      content.innerHTML=`<div class="empty-state">读取失败：${esc(error.message)}</div>`;
      $('#dataSourceLabel').textContent='数据读取失败';return false;
    }
  }
  async function start(){setupLiveNavigation();setupIndexHover();try{const {dates,onlineLadderDate}=await api('/api/dates');state.dates=dates.slice().sort();if(routeFromLocation().view==='ladder'&&onlineLadderDate&&!state.dates.includes(onlineLadderDate))state.dates.push(onlineLadderDate);state.dates.sort();if(!state.dates.length)throw new Error('涨停行情数据库中没有可展示的交易日数据');const incoming=routeFromLocation(),defaultDate=state.dates[state.dates.length-1],initialDate=state.dates.includes(incoming.date)?incoming.date:defaultDate,initialRoute={tradingAlert:true,view:incoming.view||'home',date:initialDate,topic:incoming.topic||'',stock:incoming.stock||'',outcome:incoming.outcome||'',index:incoming.index||'',ladderEnd:incoming.ladderEnd||''};calendarMonth=initialDate.slice(0,6);renderDatePicker();syncBrowserRoute(initialRoute.view,initialRoute.date,initialRoute.topic,initialRoute.stock,'replace',initialRoute.outcome,initialRoute.index,initialRoute.ladderEnd);if(await loadDate(initialDate,{renderHomePage:initialRoute.view==='home'})&&initialRoute.view!=='home')await restoreBrowserRoute(initialRoute);window.addEventListener('popstate',event=>restoreBrowserRoute(event.state?.tradingAlert?event.state:routeFromLocation()));}catch(e){content.innerHTML=`<div class="empty-state">${esc(e.message)}</div>`}document.body.append(datePicker);document.addEventListener('click',event=>{const trigger=event.target.closest('[data-date-picker-trigger]');if(trigger){if(activeDatePickerTrigger===trigger&&!datePicker.hidden)closeDatePicker();else openDatePicker(trigger);}});datePicker.onclick=async event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.month){const y=Number(calendarMonth.slice(0,4)),m=Number(calendarMonth.slice(4,6))+Number(button.dataset.month),d=new Date(Date.UTC(y,m-1,1));calendarMonth=`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;renderDatePicker();return;}if(button.dataset.latest){const topicMode=activeDatePickerTrigger?.id==='topicDatePickerTrigger',dates=topicMode?Array.from(state.topicDates[state.topic]||[]).sort():state.dates,target=dates[dates.length-1];if(target)await chooseReviewDate(target);return;}if(button.dataset.date)await chooseReviewDate(button.dataset.date);};document.addEventListener('mousedown',event=>{if(!event.target.closest('[data-date-picker-trigger]')&&!datePicker.contains(event.target))closeDatePicker();});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!datePicker.hidden)closeDatePicker();});$('#refreshBtn').onclick=async()=>{if(isLivePage()){await refreshLivePage();return;}const wasLadder=history.state?.view==='ladder',wasIndices=state.indicesPage;if(!await loadDate(state.date))return;if(wasLadder)renderLimitupLadder();else if(wasIndices)renderIndicesOverview();};$('.collapse').onclick=()=>{const collapsed=!appShell.classList.contains('nav-collapsed');setNavigationCollapsed(collapsed);if(window.innerWidth<=700)$('.sidebar').classList.toggle('open',!collapsed);};$('#navReopen').onclick=()=>{setNavigationCollapsed(false);if(window.innerWidth<=700)$('.sidebar').classList.add('open');};setupSettings();setupSelection();}
  function fitUiScale(){const browserZoom=(window.devicePixelRatio||initialDevicePixelRatio)/initialDevicePixelRatio,layoutWidth=window.innerWidth*browserZoom,automatic=state.chartLayout==='grid'?1:Math.max(1,Math.min(1.4,layoutWidth/1440)),multiplier=state.uiScalePreference==='auto'?1:Number(state.uiScalePreference)||1,scale=Math.max(1,Math.min(1.8,automatic*multiplier));document.documentElement.style.zoom=String(scale);}
  window.addEventListener('resize',fitUiScale,{passive:true});fitUiScale();
  start();
})();
