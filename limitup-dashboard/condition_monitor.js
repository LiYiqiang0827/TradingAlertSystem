(() => {
  const STORAGE_KEY = 'trading-alert-condition-canvas:v2';
  const LEGACY_KEY = 'trading-alert-condition-canvas:v1';
  const WIDTH = 2400;
  const HEIGHT = 1500;
  const DEFAULT_CARDS = [
    { id: 'pool0', type: 'pool0', x: 35, y: 110 },
    { id: 'rule', type: 'rule', x: 410, y: 110 },
    { id: 'pool1', type: 'pool1', x: 845, y: 110 },
  ];
  const DEFAULT_EDGES = [
    { id: 'edge-pool0-rule', from: 'pool0', to: 'rule' },
    { id: 'edge-rule-pool1', from: 'rule', to: 'pool1' },
  ];
  const PALETTE = [
    { type: 'pool0', title: '昨日 / 前日涨停观察池', subtitle: '观察池 · 两个交易日的涨停股' },
    { type: 'rule', title: '集合竞价弱转强', subtitle: '条件卡 · 竞价由弱转强' },
    { type: 'pool1', title: '弱转强观察池', subtitle: '观察池 · 条件筛选结果' },
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateText = value => value ? `${value.slice(4, 6)}-${value.slice(6, 8)}` : '—';
  const pct = value => Number.isFinite(Number(value)) ? `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(2)}%` : '—';
  const copy = value => JSON.parse(JSON.stringify(value));

  class ConditionMonitorCanvas {
    constructor(root) {
      this.root = root;
      this.data = null;
      this.busy = false;
      this.running = false;
      this.refreshId = 0;
      this.runTimer = null;
      this.resizeObserver = null;
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this.pendingPort = null;
      this.panDrag = null;
      this.wireDrag = null;
      this.graph = this.readGraph();
      this.scale = this.graph.scale || 1;
      this.panX = this.graph.panX || 0;
      this.panY = this.graph.panY || 0;
    }

    readGraph() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && Array.isArray(saved.cards) && Array.isArray(saved.edges)) {
          return { cards: saved.cards, edges: saved.edges, scale: saved.scale || 1, panX: saved.panX || 0, panY: saved.panY || 0 };
        }
      } catch {}
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        const cards = copy(DEFAULT_CARDS).map(card => ({ ...card, ...(legacy?.[card.id] || {}) }));
        return { cards, edges: copy(DEFAULT_EDGES), scale: 1, panX: 0, panY: 0 };
      } catch {
        return { cards: copy(DEFAULT_CARDS), edges: copy(DEFAULT_EDGES), scale: 1, panX: 0, panY: 0 };
      }
    }

    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.graph, scale: this.scale, panX: this.panX, panY: this.panY }));
    }

    renderShell() {
      this.root.innerHTML = `<section class="condition-monitor">
        <div class="cm-toolbar">
          <div class="cm-toolbar-left">
            <button type="button" class="cm-tool-button cm-library-toggle" data-cm-library-toggle aria-expanded="false" title="打开卡片栏">☰ <span>卡片</span></button>
            <span class="cm-mode-pill is-stopped" data-cm-mode><i></i><span>已停止 · 可编辑画布</span></span>
            <span class="cm-state-text" data-cm-state>等待读取竞价与涨停数据…</span>
          </div>
          <div class="cm-toolbar-right">
            <span class="cm-zoom-value" data-cm-zoom>100%</span>
            <button type="button" class="cm-tool-button" data-cm-refresh title="刷新监控数据">刷新</button>
            <button type="button" class="cm-tool-button" data-cm-reset title="恢复默认卡片与连线">重置画布</button>
            <button type="button" class="cm-run-button" data-cm-run>▶ 运行</button>
            <button type="button" class="cm-stop-button" data-cm-stop disabled>■ 停止</button>
          </div>
        </div>
        <div class="cm-stage">
          <aside class="cm-library" data-cm-library hidden>
            <div class="cm-library-head"><strong>卡片</strong><button type="button" data-cm-library-close aria-label="关闭卡片栏">×</button></div>
            <p>拖动卡片到画布，停止状态下可以编辑。</p>
            <div class="cm-palette" data-cm-palette></div>
            <div class="cm-library-tip">连接方式：点击输出端口，再点击输入端口。拖动连线可更换目标；双击连线删除。</div>
          </aside>
          <div class="cm-viewport" data-cm-viewport aria-label="实时监控画布">
            <div class="cm-canvas" data-cm-canvas>
              <svg class="cm-links" data-cm-links aria-label="卡片连线"><defs><marker id="cm-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#789287"/></marker></defs></svg>
              <div class="cm-node-layer" data-cm-node-layer></div>
            </div>
            <div class="cm-canvas-hint">滚轮缩放 · 空白处拖动画布 · 卡片与连线均可拖动</div>
          </div>
        </div>
        <div class="cm-settings-backdrop" data-cm-settings hidden><section class="cm-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="cm-settings-title"><header><strong id="cm-settings-title">卡片设置</strong><button type="button" data-cm-settings-close aria-label="关闭设置">×</button></header><div data-cm-settings-body></div></section></div>
      </section>`;

      this.canvas = this.root.querySelector('[data-cm-canvas]');
      this.nodeLayer = this.root.querySelector('[data-cm-node-layer]');
      this.linkSvg = this.root.querySelector('[data-cm-links]');
      this.viewport = this.root.querySelector('[data-cm-viewport]');
      this.library = this.root.querySelector('[data-cm-library]');
      this.root.querySelector('[data-cm-refresh]').onclick = () => this.refresh();
      this.root.querySelector('[data-cm-reset]').onclick = () => this.resetGraph();
      this.root.querySelector('[data-cm-run]').onclick = () => this.setRunning(true);
      this.root.querySelector('[data-cm-stop]').onclick = () => this.setRunning(false);
      this.root.querySelector('[data-cm-library-toggle]').onclick = () => this.toggleLibrary();
      this.root.querySelector('[data-cm-library-close]').onclick = () => this.toggleLibrary(false);
      this.root.querySelector('[data-cm-settings-close]').onclick = () => this.closeSettings();
      this.root.querySelector('[data-cm-settings]').addEventListener('click', event => { if (event.target === event.currentTarget) this.closeSettings(); });
      this.root.querySelector('[data-cm-palette]').innerHTML = PALETTE.map(item => `<div class="cm-palette-item" draggable="true" data-cm-template="${item.type}"><span class="cm-palette-icon">${item.type === 'rule' ? '条件' : '观察池'}</span><span><b>${item.title}</b><small>${item.subtitle}</small></span><i>＋</i></div>`).join('');
      this.root.querySelectorAll('[data-cm-template]').forEach(item => item.addEventListener('dragstart', event => {
        if (this.running) { event.preventDefault(); return; }
        event.dataTransfer.setData('text/plain', item.dataset.cmTemplate);
        event.dataTransfer.effectAllowed = 'copy';
      }));
      this.viewport.addEventListener('dragover', event => { if (!this.running) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
      this.viewport.addEventListener('drop', event => this.dropCard(event));
      this.viewport.addEventListener('wheel', event => this.zoomAt(event), { passive: false });
      this.viewport.addEventListener('pointerdown', event => this.beginPan(event));
      window.addEventListener('pointermove', this._pointerMove = event => this.trackPointerMove(event));
      window.addEventListener('pointerup', this._pointerUp = event => this.trackPointerUp(event));
      window.addEventListener('pointercancel', this._pointerCancel = event => this.trackPointerUp(event));
      this.viewport.addEventListener('click', event => { if (!event.target.closest('.cm-card, [data-cm-edge]')) this.setPendingPort(null); });
      this.linkSvg.addEventListener('pointerdown', event => {
        const path = event.target.closest('[data-cm-edge]');
        if (!path || this.running || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const from = path.dataset.cmFrom, to = path.dataset.cmTo;
        const center = id => { const el = this.nodeLayer.querySelector(`[data-cm-card="${CSS.escape(id)}"] [data-cm-port="${id === from ? 'out' : 'in'}"]`); const r = el?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: event.clientX, y: event.clientY }; };
        const a = center(from), b = center(to);
        const moveSide = Math.hypot(event.clientX - a.x, event.clientY - a.y) <= Math.hypot(event.clientX - b.x, event.clientY - b.y) ? 'from' : 'to';
        this.wireDrag = { edgeId: path.dataset.cmEdge, from, to, moveSide, fixedNode: moveSide === 'from' ? to : from, x: event.clientX, y: event.clientY, moved: false };
        this.linkSvg.setPointerCapture?.(event.pointerId);
      });
      this.lastEdgeClick = null;
      this.resizeObserver = new ResizeObserver(() => this.drawLinks());
      this.resizeObserver.observe(this.canvas);
      this.renderGraph();
      this.applyView();
      this.setRunning(false);
    }

    cardMarkup(node) {
      const pos = `left:${Number(node.x) || 0}px;top:${Number(node.y) || 0}px`;
      if (node.type === 'rule') return `<article class="cm-card cm-rule-card" data-cm-card="${esc(node.id)}" data-cm-kind="rule" style="${pos}">
        <header class="cm-card-head"><span class="cm-node cm-node-rule">条件</span><div><strong>集合竞价弱转强</strong><small>竞价早段低开，尾段转为高开</small></div><span class="cm-rule-state" data-cm-role="rule-state">等待数据</span><button type="button" class="cm-card-settings" data-cm-settings-open aria-label="卡片设置" title="卡片设置">⚙</button><button type="button" class="cm-card-remove" data-cm-remove aria-label="删除卡片" title="删除卡片">×</button></header>
        <div class="cm-card-body"><div class="cm-rule-step"><span>01</span><div><b>弱开观察</b><small>09:15–09:20，首个有效样本低于前收盘</small></div></div><div class="cm-rule-step"><span>02</span><div><b>尾段转强</b><small>09:23–09:25 尾段样本；包含 09:26 最终采样</small></div></div><div class="cm-rule-logic">早段首价 ＜ 前收盘　且　尾段最新价 ＞ 前收盘</div><div class="cm-rule-note" data-cm-role="rule-message">数据覆盖尚未确认</div><div class="cm-coverage"><span>候选覆盖</span><b data-cm-role="coverage">—</b></div><div class="cm-coverage"><span>有完整早 / 尾段样本</span><b data-cm-role="evaluated">—</b></div><div class="cm-coverage"><span>采样时间口径</span><b title="接口时间戳表示响应组装时刻">接口响应时刻</b></div></div>
        <footer data-cm-role="rule-foot">阈值：早段低于 0%，尾段高于 0%</footer><button type="button" class="cm-port cm-port-in" data-cm-port="in" aria-label="输入端口"></button><button type="button" class="cm-port cm-port-out" data-cm-port="out" aria-label="输出端口"></button></article>`;
      const level0 = node.type === 'pool0';
      return `<article class="cm-card cm-pool-card ${level0 ? '' : 'cm-level-one'}" data-cm-card="${esc(node.id)}" data-cm-kind="${node.type}" style="${pos}">
        <header class="cm-card-head"><span class="cm-node ${level0 ? '' : 'cm-node-one'}">观察池</span><div><strong>${level0 ? '昨日 / 前日涨停观察池' : '弱转强观察池'}</strong><small>${level0 ? '前两个交易日的封板股票' : '通过条件卡输出的股票'}</small></div><b data-cm-role="count">—</b><button type="button" class="cm-card-settings" data-cm-settings-open aria-label="卡片设置" title="卡片设置">⚙</button><button type="button" class="cm-card-remove" data-cm-remove aria-label="删除卡片" title="删除卡片">×</button></header>
        <div class="cm-card-body" data-cm-role="list"><div class="cm-empty">${level0 ? '读取候选股票…' : '等待条件计算…'}</div></div>
        <footer data-cm-role="foot">${level0 ? '涨停名单：等待读取' : '符合弱转强条件：等待计算'}</footer>
        <button type="button" class="cm-port cm-port-in" data-cm-port="in" aria-label="输入端口"></button><button type="button" class="cm-port cm-port-out" data-cm-port="out" aria-label="输出端口"></button>
      </article>`;
    }

    renderGraph() {
      this.nodeLayer.innerHTML = this.graph.cards.map(node => this.cardMarkup(node)).join('');
      this.nodeLayer.querySelectorAll('[data-cm-card]').forEach(card => {
        this.bindDrag(card);
        card.querySelector('[data-cm-remove]').addEventListener('click', event => { event.stopPropagation(); this.removeCard(card.dataset.cmCard); });
        card.querySelector('[data-cm-settings-open]').addEventListener('click', event => { event.stopPropagation(); this.openSettings(card.dataset.cmCard); });
        card.querySelectorAll('[data-cm-port]').forEach(port => port.addEventListener('click', event => {
          event.stopPropagation(); this.selectPort(card.dataset.cmCard, port.dataset.cmPort);
        }));
      });
      this.drawLinks();
      if (this.data) this.paint(this.data);
    }

    applyView() {
      this.canvas.style.transform = `translate(${this.panX}px,${this.panY}px) scale(${this.scale})`;
      this.root.querySelector('[data-cm-zoom]').textContent = `${Math.round(this.scale * 100)}%`;
      this.drawLinks();
    }

    zoomAt(event) {
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const next = Math.max(.35, Math.min(1.8, this.scale * Math.exp(-event.deltaY * .001)));
      const ratio = next / this.scale;
      this.panX = x - (x - this.panX) * ratio;
      this.panY = y - (y - this.panY) * ratio;
      this.scale = next;
      this.applyView(); this.persist();
    }

    beginPan(event) {
      if (event.target.closest('.cm-card, .cm-library, .cm-canvas-hint, [data-cm-edge]')) return;
      if (this.running || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      this.panDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY, moved: false };
      try { this.viewport.setPointerCapture(event.pointerId); } catch {}
      this.viewport.classList.add('is-panning');
    }

    trackPointerMove(event) {
      if (this.panDrag && event.pointerId === this.panDrag.pointerId) {
        const drag = this.panDrag;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        this.panX = drag.panX + dx; this.panY = drag.panY + dy; this.applyView();
      }
      if (this.wireDrag) {
        const drag = this.wireDrag;
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) { drag.moved = true; this.lastEdgeClick = null; }
        if (drag.moved) { drag.clientX = event.clientX; drag.clientY = event.clientY; this.drawLinks(); }
      }
    }

    trackPointerUp(event) {
      if (this.panDrag && event.pointerId === this.panDrag.pointerId) {
        this.panDrag = null; this.viewport.classList.remove('is-panning'); this.persist();
      }
      if (this.wireDrag) {
        const drag = this.wireDrag; this.wireDrag = null;
        if (drag.moved) {
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-cm-card]');
          const side = drag.moveSide === 'from' ? 'out' : 'in';
          const port = target?.querySelector(`[data-cm-port="${side}"]`);
          const edge = this.graph.edges.find(item => item.id === drag.edgeId);
          if (edge && port && target.dataset.cmCard !== drag.fixedNode) {
            if (drag.moveSide === 'from') edge.from = target.dataset.cmCard;
            else edge.to = target.dataset.cmCard;
            this.persist();
          }
          this.lastEdgeClick = null;
          this.drawLinks();
        } else {
          const now = performance.now();
          if (this.lastEdgeClick?.id === drag.edgeId && now - this.lastEdgeClick.time < 500) {
            this.lastEdgeClick = null; this.removeEdge(drag.edgeId);
          } else this.lastEdgeClick = { id: drag.edgeId, time: now };
        }
      }
    }

    openSettings(cardId) {
      const card = this.graph.cards.find(item => item.id === cardId);
      if (!card) return;
      const meta = PALETTE.find(item => item.type === card.type);
      const body = this.root.querySelector('[data-cm-settings-body]');
      const title = this.root.querySelector('#cm-settings-title');
      title.textContent = `${meta?.title || '卡片'} · 设置`;
      body.innerHTML = card.type === 'rule'
        ? '<p>当前条件：竞价早段低于前收盘，尾段高于前收盘。</p><p class="cm-settings-empty">此卡片目前没有可调整参数。</p>'
        : '<p>观察池按连线接收或提供股票数据。</p><p class="cm-settings-empty">此卡片目前没有可调整参数。</p>';
      const dialog = this.root.querySelector('[data-cm-settings]');
      dialog.hidden = false;
      this.root.querySelector('[data-cm-settings-close]').focus();
    }

    closeSettings() { this.root.querySelector('[data-cm-settings]').hidden = true; }

    toggleLibrary(show = this.library.hidden) {
      this.library.hidden = !show;
      const button = this.root.querySelector('[data-cm-library-toggle]');
      button.setAttribute('aria-expanded', String(show));
      button.title = show ? '关闭卡片栏' : '打开卡片栏';
      this.root.classList.toggle('has-library', show);
    }

    dropCard(event) {
      if (this.running) return;
      const type = event.dataTransfer.getData('text/plain');
      if (!PALETTE.some(item => item.type === type)) return;
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const x = (event.clientX - rect.left - this.panX) / this.scale;
      const y = (event.clientY - rect.top - this.panY) / this.scale;
      this.addCard(type, x, y);
    }

    addCard(type, x, y) {
      if (this.running) return;
      const id = `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      this.graph.cards.push({ id, type, x: x - (type === 'rule' ? 190 : 170), y: y - 40 });
      this.persist(); this.renderGraph();
    }

    removeCard(id) {
      if (this.running) return;
      this.graph.cards = this.graph.cards.filter(node => node.id !== id);
      this.graph.edges = this.graph.edges.filter(edge => edge.from !== id && edge.to !== id);
      if (this.pendingPort?.nodeId === id) this.setPendingPort(null);
      this.persist(); this.renderGraph();
    }

    bindDrag(card) {
      const head = card.querySelector('.cm-card-head');
      let drag = null;
      head.addEventListener('pointerdown', event => {
        if (this.running || event.button !== 0 || event.target.closest('button')) return;
        const rect = card.getBoundingClientRect();
        drag = { dx: (event.clientX - rect.left) / this.scale, dy: (event.clientY - rect.top) / this.scale };
        head.setPointerCapture(event.pointerId); card.classList.add('is-dragging'); event.preventDefault();
      });
      head.addEventListener('pointermove', event => {
        if (!drag) return;
        const box = this.viewport.getBoundingClientRect();
        const x = (event.clientX - box.left - this.panX) / this.scale - drag.dx;
        const y = (event.clientY - box.top - this.panY) / this.scale - drag.dy;
        card.style.left = `${x}px`; card.style.top = `${y}px`;
        const node = this.graph.cards.find(item => item.id === card.dataset.cmCard);
        if (node) { node.x = x; node.y = y; }
        this.drawLinks();
      });
      const done = () => { if (!drag) return; drag = null; card.classList.remove('is-dragging'); this.persist(); this.drawLinks(); };
      head.addEventListener('pointerup', done); head.addEventListener('pointercancel', done);
    }

    selectPort(nodeId, side) {
      if (this.running) return;
      if (side === 'out') {
        if (this.pendingPort?.side === 'in') this.connect(nodeId, this.pendingPort.nodeId);
        else if (this.pendingPort?.nodeId === nodeId && this.pendingPort.side === 'out') this.setPendingPort(null);
        else this.setPendingPort({ nodeId, side });
        return;
      }
      if (this.pendingPort?.side === 'out') this.connect(this.pendingPort.nodeId, nodeId);
      else this.setPendingPort({ nodeId, side });
    }

    setPendingPort(port) {
      this.pendingPort = port;
      this.nodeLayer.querySelectorAll('.cm-port.is-selected').forEach(item => item.classList.remove('is-selected'));
      if (port) this.nodeLayer.querySelector(`[data-cm-card="${CSS.escape(port.nodeId)}"] [data-cm-port="${port.side}"]`)?.classList.add('is-selected');
      this.root.querySelector('[data-cm-state]').textContent = port ? `已选${port.side === 'out' ? '输出' : '输入'}端口，请选择另一端` : (this.data?.message || '等待读取竞价与涨停数据…');
    }

    connect(from, to) {
      if (from === to) { this.setPendingPort(null); return; }
      const exists = this.graph.edges.some(edge => edge.from === from && edge.to === to);
      if (!exists) this.graph.edges.push({ id: `edge-${Date.now().toString(36)}`, from, to });
      this.setPendingPort(null); this.persist(); this.drawLinks();
    }

    removeEdge(id) {
      if (this.running) return;
      this.graph.edges = this.graph.edges.filter(edge => edge.id !== id);
      this.persist(); this.drawLinks();
    }

    drawLinks() {
      if (!this.canvas || !this.linkSvg) return;
      const svgRect = this.canvas.getBoundingClientRect();
      const toPoint = (port, side) => {
        const button = this.nodeLayer.querySelector(`[data-cm-card="${CSS.escape(port)}"] [data-cm-port="${side}"]`);
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { x: (rect.left + rect.width / 2 - svgRect.left) / this.scale, y: (rect.top + rect.height / 2 - svgRect.top) / this.scale };
      };
      const defs = '<defs><marker id="cm-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#789287"/></marker></defs>';
      const paths = this.graph.edges.map(edge => {
        const from = toPoint(edge.from, 'out'), to = toPoint(edge.to, 'in');
        if (!from || !to) return '';
        const dx = Math.max(36, Math.abs(to.x - from.x) * .45);
        const d = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
        return `<path class="cm-edge-hit" data-cm-edge="${esc(edge.id)}" data-cm-from="${esc(edge.from)}" data-cm-to="${esc(edge.to)}" d="${d}"/><path class="cm-edge-visible" d="${d}"/>`;
      }).join('');
      let preview = '';
      if (this.wireDrag?.moved) {
        const x = (this.wireDrag.clientX - svgRect.left) / this.scale, y = (this.wireDrag.clientY - svgRect.top) / this.scale;
        const fixed = toPoint(this.wireDrag.fixedNode, this.wireDrag.moveSide === 'from' ? 'in' : 'out');
        if (fixed) {
          const dx = Math.max(36, Math.abs(x - fixed.x) * .45);
          const d = this.wireDrag.moveSide === 'from' ? `M ${x} ${y} C ${x + dx} ${y}, ${fixed.x - dx} ${fixed.y}, ${fixed.x} ${fixed.y}` : `M ${fixed.x} ${fixed.y} C ${fixed.x + dx} ${fixed.y}, ${x - dx} ${y}, ${x} ${y}`;
          preview = `<path class="cm-wire-preview" d="${d}"/>`;
        }
      }
      this.linkSvg.innerHTML = defs + paths + preview;
    }

    cardRows(rows, level) {
      if (!rows?.length) return `<div class="cm-empty">${level === 0 ? '前两交易日没有涨停名单' : '尚无股票符合当前条件'}</div>`;
      return rows.slice(0, 80).map(row => level === 0
        ? `<div class="cm-stock-row"><span class="cm-stock-date">${(row.dates || []).map(dateText).join(' / ')}</span><b>${esc(row.name)}</b><span>${esc(row.themes?.[0] || '暂无题材')}</span><small>${esc((row.boards || []).at(-1) || '涨停')}</small></div>`
        : `<div class="cm-stock-row cm-match-row"><b>${esc(row.name)}</b><span>${esc(row.themes?.[0] || '暂无题材')}</span><small>${pct(row.earlyPct)} → ${pct(row.latePct)}</small><small>${esc(row.earlyTime)} → ${esc(row.lateTime)}</small></div>`).join('') + (rows.length > 80 ? `<div class="cm-empty">另有 ${rows.length - 80} 只</div>` : '');
    }

    paint(data) {
      this.data = data;
      this.root.querySelector('[data-cm-state]').textContent = data.message || (this.running ? '监控运行中' : '数据已更新');
      this.nodeLayer.querySelectorAll('[data-cm-card]').forEach(card => {
        const kind = card.dataset.cmKind;
        if (kind === 'pool0') {
          card.querySelector('[data-cm-role="count"]').textContent = data.sourceError ? '—' : String(data.candidateCount ?? 0);
          card.querySelector('[data-cm-role="list"]').innerHTML = data.sourceError ? `<div class="cm-empty">${esc(data.sourceError)}</div>` : this.cardRows(data.level0, 0);
          card.querySelector('[data-cm-role="foot"]').textContent = data.sourceError ? 'KPL 涨停名单尚未完整' : `${(data.sessions || []).map(dateText).join('、')} · 涨停候选 ${data.candidateCount ?? 0} 只`;
        } else if (kind === 'pool1') {
          card.querySelector('[data-cm-role="count"]').textContent = data.ruleReady ? String(data.matchedCount ?? 0) : (data.matchedCount ? `${data.matchedCount}*` : '—');
          card.querySelector('[data-cm-role="list"]').innerHTML = data.ruleReady || data.matchedCount ? this.cardRows(data.level1, 1) : '<div class="cm-empty">数据尚不足，暂不判定</div>';
          card.querySelector('[data-cm-role="foot"]').textContent = data.ruleReady ? `符合弱转强条件：${data.matchedCount ?? 0} 只 · ${data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚无竞价采样时间'}` : `筛选未完成${data.matchedCount ? ` · 已观察到 ${data.matchedCount} 只候选匹配，覆盖不完整` : ''}`;
        } else {
          card.querySelector('[data-cm-role="rule-state"]').textContent = data.ruleReady ? (data.matchedCount ? `已筛出 ${data.matchedCount} 只` : '已计算 · 暂无命中') : '数据不足';
          card.querySelector('[data-cm-role="rule-state"]').classList.toggle('ready', !!data.ruleReady);
          card.querySelector('[data-cm-role="rule-message"]').textContent = data.message || '—';
          card.querySelector('[data-cm-role="coverage"]').textContent = `${data.coveredCount ?? 0} / ${data.candidateCount ?? 0} 只`;
          card.querySelector('[data-cm-role="evaluated"]').textContent = `${data.evaluatedCount ?? 0} 只；${data.earlySampleAvailable ? '有早段' : '缺早段'}，${data.lateSampleAvailable ? '有尾段' : '缺尾段'}`;
          card.querySelector('[data-cm-role="rule-foot"]').textContent = data.ruleReady ? `计算完成 · ${data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚无竞价采样时间'}` : '筛选未完成';
        }
      });
      this.drawLinks();
    }

    async refresh() {
      if (this.busy) return;
      this.busy = true;
      const id = ++this.refreshId;
      const button = this.root.querySelector('[data-cm-refresh]');
      button.disabled = true;
      try {
        const response = await fetch('/api/condition-monitor', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
        if (id === this.refreshId) this.paint(data);
      } catch (error) {
        this.root.querySelector('[data-cm-state]').textContent = '读取失败：' + error.message;
        this.root.querySelectorAll('[data-cm-role="rule-message"]').forEach(item => item.textContent = '连接或数据读取失败；保留上一结果。');
      } finally {
        this.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    }

    setRunning(running) {
      this.running = running;
      this.root.classList.toggle('is-running', running);
      this.root.classList.toggle('is-stopped', !running);
      this.root.querySelector('[data-cm-run]').disabled = running;
      this.root.querySelector('[data-cm-stop]').disabled = !running;
      this.root.querySelector('[data-cm-reset]').disabled = running;
      this.root.querySelectorAll('[data-cm-template]').forEach(item => { item.draggable = !running; item.classList.toggle('is-disabled', running); });
      const mode = this.root.querySelector('[data-cm-mode]');
      mode.classList.toggle('is-stopped', !running); mode.classList.toggle('is-running', running);
      mode.querySelector('span').textContent = running ? '运行中 · 画布已锁定' : '已停止 · 可编辑画布';
      if (this.runTimer) clearInterval(this.runTimer);
      this.runTimer = null;
      if (running) { this.refresh(); this.runTimer = setInterval(() => this.refresh(), 6000); }
      else if (this.data) this.root.querySelector('[data-cm-state]').textContent = this.data.message || '已停止 · 可编辑画布';
    }

    resetGraph() {
      if (this.running) return;
      this.graph = { cards: copy(DEFAULT_CARDS), edges: copy(DEFAULT_EDGES), scale: 1, panX: 0, panY: 0 };
      this.scale = 1; this.panX = 0; this.panY = 0; this.pendingPort = null;
      localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY);
      this.renderGraph(); this.applyView();
    }

    destroy() {
      this.resizeObserver?.disconnect();
      window.removeEventListener('pointermove', this._pointerMove);
      window.removeEventListener('pointerup', this._pointerUp);
      window.removeEventListener('pointercancel', this._pointerCancel);
      this.refreshId++;
      if (this.runTimer) clearInterval(this.runTimer);
      this.runTimer = null;
    }
  }

  let active = null;
  window.TradingConditionMonitor = {
    mount(root) { active?.destroy(); active = new ConditionMonitorCanvas(root); active.renderShell(); active.refresh(); return active; },
    refresh() { return active?.refresh(); },
    destroy() { active?.destroy(); active = null; }
  };
})();
