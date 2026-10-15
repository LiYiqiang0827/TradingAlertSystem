import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Presentation, PresentationFile, FileBlob} from '@oai/artifact-tool';

const required=['SKILL_DIR','BUILD_DIR','FINAL_PPTX','DECK_DATA','RUNTIME_PYTHON'];
for(const key of required){if(!process.env[key]||!path.isAbsolute(process.env[key]))throw new Error(`Set absolute ${key}`)}
const skill=process.env.SKILL_DIR, build=process.env.BUILD_DIR, target=process.env.FINAL_PPTX;
const {finalizePresentation,resolvePresentationFont}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const font=resolvePresentationFont({fontFamily:'Arial Unicode MS'});
const data=JSON.parse(await fs.readFile(process.env.DECK_DATA,'utf8'));
const {summary,candidates}=data;
if(!candidates.length||summary.candidate_count!==candidates.length)throw new Error('候选表为空或数量不匹配');
const total=1+2*candidates.length;
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
    '图表为离线数据回顾，不构成买卖建议。',
  ].join('\n');
  const s=newSlide(`${fmt(summary.anchor_date)} 涨停题材复盘`,'cover',notes);
  text(s,`${summary.market_limit_up_count} 只当日涨停  ·  ${summary.candidate_count} 只关注标的`,
    {left:56,top:116,width:1480,height:58},40,accent,true);
  text(s,`近5日涨停与近20日连续2板以上并集；${summary.theme_count} 个关注题材`,
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
}
for(let i=0;i<candidates.length;i++){
  const r=candidates[i];
  const header=`${fmt(summary.anchor_date)}  ${r.theme}（当日涨停${r.theme_limit_up_count}只）`;
  const details=`${r.name}  ${r.ts_code}   ${r.anchor_status||r.alert_name}   观察等级 ${r.importance}/5`;
  const notes=[`股票：${r.name} ${r.ts_code}`,`题材：${r.theme}`,`提醒：${r.alert_name}`,
    `原因：${r.reason}`,`近5日涨停次数：${r.limit_up_count_5d}`,
    `近20日涨停次数：${r.limit_up_count_20d}`,`近20日最高连续板：${r.max_consecutive_boards_20d}`,
    `数据来源：${summary.data_source}`,`数据截止：${summary.chart_cutoff}`,
    `分时：${summary.intraday_source_note}`,
    `图表覆盖：${JSON.stringify(r.chart_coverage)}`,
    '图表是历史行情和事件标注，不构成买卖建议。'].join('\n');
  const s1=newSlide(`${String(i+1).padStart(3,'0')}  ${header}`,'stock-overview',notes);
  text(s1,details,{left:40,top:73,width:1518,height:36},24,accent,true);
  text(s1,r.reason,{left:42,top:108,width:1510,height:38},19,muted);
  await addChart(s1,path.join(dataDir,r.overview_image),`${r.name}日线周线月线图`,
    {left:32,top:151,width:1536,height:700});
  manifest.at(-1).ts_code=r.ts_code;manifest.at(-1).theme=r.theme;

  const s2=newSlide(`${String(i+1).padStart(3,'0')}  ${header}`,'stock-intraday',notes);
  text(s2,details,{left:40,top:73,width:1518,height:36},24,accent,true);
  text(s2,`上：5日1分钟分时（含日内均价、动态MA5/10/20和成交量）；下：3个月15分钟K线。交易日：${summary.intraday_trading_dates_5.map(fmt).join('、')}`,
    {left:42,top:108,width:1510,height:38},18,muted);
  await addChart(s2,path.join(dataDir,r.intraday_image),`${r.name}最近5日分时与成交量`,
    {left:32,top:151,width:1536,height:700});
  manifest.at(-1).ts_code=r.ts_code;manifest.at(-1).theme=r.theme;
  if((i+1)%25===0)console.log(`已编排 ${i+1}/${candidates.length} 只股票`);
}

await fs.mkdir(build,{recursive:true});await fs.mkdir(path.dirname(target),{recursive:true});
const candidatePath=path.join(build,'candidate.pptx');
await (await PresentationFile.exportPptx(deck)).save(candidatePath);
await fs.writeFile(path.join(build,'slide_manifest.json'),JSON.stringify(manifest,null,2));
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
