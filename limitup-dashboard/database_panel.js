/* Database status reads control ledgers only. Updates run existing server-side services. */
(() => {
  'use strict';
  const button = document.getElementById('databaseButton');
  if (!button) return;
  const overlay = document.createElement('div');
  overlay.className = 'database-overlay'; overlay.hidden = true;
  overlay.innerHTML = `<section class="database-dialog" role="dialog" aria-modal="true" aria-labelledby="databaseTitle" tabindex="-1"><header><h2 id="databaseTitle">数据库</h2><button type="button" data-db-refresh title="重新读取控制表">刷新状态</button><button type="button" data-db-close aria-label="关闭数据库窗口">×</button></header><nav class="database-tabs" role="tablist" aria-label="数据库"></nav><div class="database-caption"></div><div class="database-message" role="status" aria-live="polite"></div><div class="database-body"></div></section>`;
  document.body.append(overlay);
  const dialog = overlay.querySelector('.database-dialog'), tabs = overlay.querySelector('.database-tabs');
  const body = overlay.querySelector('.database-body'), caption = overlay.querySelector('.database-caption');
  const message = overlay.querySelector('.database-message');
  let inventory = [], active = '', serial = 0, poll = 0, detail = null, returnFocus = null;
  const pending = new Set(), lastGood = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  async function api(path, options) {
    const response = await fetch(path, {cache:'no-store', ...options});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }
  function time(value) {
    if (!value) return '未记录';
    if (/^\d{8}$/.test(value)) return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}`;
    if (/Z$|[+-]\d\d:\d\d$/.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(+date)) return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
    }
    return String(value).replace('T',' ');
  }
  function running(job) { return ['queued','running'].includes(job.state); }
  function drawTabs() {
    tabs.innerHTML = inventory.map(item => `<button type="button" role="tab" aria-selected="${item.id===active}" data-db-tab="${esc(item.id)}">${esc(item.label)}</button>`).join('');
  }
  function drawRows(data) {
    caption.textContent = `${data.engine} · ${data.path} · 读取于 ${time(data.checkedAt)}`;
    const jobs = data.jobs || [], inProgress = jobs.find(running);
    const last = jobs[jobs.length-1];
    message.textContent = last ? `${last.table}：${last.message}${last.finishedAt ? ' · '+time(last.finishedAt) : ''}` : '';
    if(data.notice)message.textContent=data.notice;
    message.classList.toggle('error', last?.state === 'failed' || !!data.busy);
    body.innerHTML = `<table class="database-table"><thead><tr><th>数据表名称</th><th>最新日期或时间</th><th>更新</th></tr></thead><tbody>${data.tables.map(row => {
      const job = jobs.slice().reverse().find(j => j.table===row.name && running(j));
      const busy = job || pending.has(data.id+':'+row.name);
      const checkpoints = (row.checkpoints||[]).map(p => `${p.key}：${time(p.date)} · ${time(p.updatedAt)}`).join('\n');
      const title = [row.source, row.updatedAt ? '记录更新：'+time(row.updatedAt) : '', checkpoints].filter(Boolean).join('\n');
      return `<tr><td title="${esc(title)}"><span>${esc(row.name)}</span></td><td title="${esc(title)}" class="${row.latest?'':'database-unknown'}">${esc(time(row.latest))}</td><td><button type="button" data-db-update="${esc(row.name)}" ${!row.canUpdate || busy || inProgress || data.busy ? 'disabled' : ''} title="${esc(row.updateReason || row.source)}">${busy?'更新中…':'更新'}</button></td></tr>`;
    }).join('')}</tbody></table><p class="database-foot">只读取控制表或更新日志；未记录表示没有独立断点。鼠标停留可查看记录来源。</p>`;
  }
  function schedule(data) {
    clearTimeout(poll);
    if (overlay.hidden || !(data.jobs||[]).some(running)) return;
    poll = setTimeout(async () => {
      const id = active, request = serial;
      try {
        const state = await api('/api/database-update-jobs?database='+encodeURIComponent(id));
        if (overlay.hidden || id!==active || request!==serial) return;
        if (state.jobs.some(running)) { detail = {...detail,jobs:state.jobs}; drawRows(detail); schedule(detail); }
        else await load(id, true);
      } catch (error) {
        if (!overlay.hidden && id===active && request===serial) { message.textContent=error.message; message.classList.add('error'); schedule(detail); }
      }
    }, 2000);
  }
  async function load(id, force=false) {
    clearTimeout(poll); active=id; detail=null; const request=++serial;
    drawTabs(); caption.textContent=''; message.textContent=''; message.classList.remove('error'); body.innerHTML='<div class="database-loading">正在读取控制表…</div>';
    try {
      const data = await api('/api/database-status?database='+encodeURIComponent(id)+(force?'&force=1':''));
      if (request!==serial || overlay.hidden) return;
      detail=data; if(!data.busy)lastGood.set(id,data); drawRows(data); schedule(data);
    } catch (error) {
      if (request!==serial || overlay.hidden) return;
      const previous=lastGood.get(id);
      if(previous){detail={...previous,busy:true,notice:error.message+'；显示上次读取的记录'};drawRows(detail);schedule(detail);}
      else{body.textContent='';message.textContent=error.message;message.classList.add('error');}
    }
  }
  async function open() {
    returnFocus=document.activeElement; overlay.hidden=false; dialog.focus(); button.setAttribute('aria-expanded','true');
    const request=++serial; body.textContent='正在读取数据库清单…';
    try {
      const data=await api('/api/databases');
      if (overlay.hidden || request!==serial) return;
      inventory=data.databases; if (!inventory.some(item=>item.id===active)) active=inventory[0]?.id || '';
      if (active) await load(active); else body.textContent='没有找到正在使用的数据库';
    } catch (error) { if (!overlay.hidden && request===serial) { message.textContent=error.message; message.classList.add('error'); } }
  }
  function close() { overlay.hidden=true; ++serial; clearTimeout(poll); button.setAttribute('aria-expanded','false'); returnFocus?.focus(); }
  button.setAttribute('aria-expanded','false'); button.onclick=open;
  overlay.querySelector('[data-db-close]').onclick=close;
  overlay.querySelector('[data-db-refresh]').onclick=()=>active && load(active,true);
  overlay.onclick=event=>{if(event.target===overlay)close();};
  tabs.onclick=event=>{const tab=event.target.closest('[data-db-tab]'); if(tab)load(tab.dataset.dbTab);};
  tabs.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault(); let index=inventory.findIndex(item=>item.id===active);
    index=event.key==='Home'?0:event.key==='End'?inventory.length-1:(index+(event.key==='ArrowRight'?1:-1)+inventory.length)%inventory.length;
    load(inventory[index].id); tabs.querySelector(`[aria-selected="true"]`)?.focus();
  };
  body.onclick=async event=>{
    const target=event.target.closest('[data-db-update]'); if(!target || target.disabled || !detail)return;
    const id=active, name=target.dataset.dbUpdate, key=id+':'+name;
    if(pending.has(key))return; pending.add(key); target.disabled=true; target.textContent='提交中…';
    try {
      const data=await api('/api/database-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({databaseId:id,table:name})});
      if(active===id && !overlay.hidden && detail) {
        detail={...detail,jobs:[...(detail.jobs||[]).filter(job=>job.id!==data.job.id),data.job]}; drawRows(detail); schedule(detail);
      }
    } catch(error) {
      if(active===id && !overlay.hidden) { if(detail)drawRows(detail); message.textContent=error.message; message.classList.add('error'); }
    } finally {
      pending.delete(key);
      if(active===id && !overlay.hidden && detail) {const text=message.textContent, failed=message.classList.contains('error'); drawRows(detail);if(failed){message.textContent=text;message.classList.add('error');}}
    }
  };
  document.addEventListener('keydown',event=>{
    if(overlay.hidden)return;
    if(event.key==='Escape'){event.preventDefault(); event.stopImmediatePropagation(); close();return;}
    if(event.key==='Tab') {
      const targets=[...dialog.querySelectorAll('button:not([disabled])')].filter(el=>el.getClientRects().length);
      const first=targets[0], last=targets[targets.length-1];
      if(event.shiftKey && (document.activeElement===first || document.activeElement===dialog)){event.preventDefault(); last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    }
  },true);
})();
