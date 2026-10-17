let DATA = null;
let currentSort = { key: 'cost', dir: 'desc' };
let searchQuery = '';
let metric = 'cost';
let sessionPage = 0;
let liveTimer = null;
const PAGE_SIZE = 50;
const filters = { range: '30', from: '', to: '', project: '', model: '' };

const MODEL_COLORS = ['#6366f1', '#10b981', '#f97316', '#ec4899', '#22d3ee', '#eab308', '#a855f7', '#64748b'];
const BUCKETS = [
  { key: 'cacheRead', label: 'Cache reads', color: '#6366f1', help: 'Re-reading conversation history from cache' },
  { key: 'cacheWrite', label: 'Cache writes', color: '#a855f7', help: 'Storing new context in the cache (1.25x-2x input price)' },
  { key: 'output', label: 'Output', color: '#14b8a6', help: 'Text, code, tool calls and thinking Claude generated' },
  { key: 'input', label: 'Uncached input', color: '#f59e0b', help: 'Prompt tokens billed at the full input price' },
  { key: 'web', label: 'Web search', color: '#ec4899', help: '$10 per 1,000 searches' },
];

// ---------- formatting ----------
function fmt(n) {
  n = Math.round(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
function money(n, opts) {
  n = n || 0;
  if (opts === 'short' && n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString();
  if (n >= 100) return '$' + n.toFixed(0);
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function modelClass(m) {
  m = m || '';
  if (/opus|fable|mythos/.test(m)) return 'model-opus';
  if (m.includes('sonnet')) return 'model-sonnet';
  if (m.includes('haiku')) return 'model-haiku';
  return 'model-unknown';
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function modelShort(m) {
  if (!m) return 'Unknown';
  m = m.replace(/\[.*?\]$/, '');
  let match = m.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?=-\d{8}|$|-)/i);
  if (match) return cap(match[1]) + ' ' + match[2] + (match[3] ? '.' + match[3] : '');
  match = m.match(/^claude-(\d)-(\d)-(opus|sonnet|haiku)/i);
  if (match) return cap(match[3]) + ' ' + match[1] + '.' + match[2];
  match = m.match(/^claude-(\d)-(opus|sonnet|haiku)/i);
  if (match) return cap(match[2]) + ' ' + match[1];
  for (const f of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) if (m.includes(f)) return cap(f);
  return m;
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function attr(s) { return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(d) {
  if (!d) return '';
  const p = d.split('-');
  return MONTHS[parseInt(p[1]) - 1] + ' ' + parseInt(p[2]);
}
function formatTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function formatDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + formatTime(ms);
}
function duration(ms) {
  if (!ms || ms < 60000) return '<1m';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 3.6e6) return Math.max(1, Math.round(diff / 6e4)) + 'm ago';
  if (diff < 864e5) return Math.round(diff / 3.6e6) + 'h ago';
  if (diff < 30 * 864e5) return Math.round(diff / 864e5) + 'd ago';
  return formatDate(dayKey(ms));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function toolLabel(name) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (m) return m[1].replace(/^claude_ai_/, '').replace(/^plugin_/, '') + ' · ' + m[2];
  return name;
}
function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- filters & URL state ----------
function rangeToDates(range) {
  const today = dayKey(Date.now());
  if (range === 'all') return { from: '', to: '' };
  if (range === 'today') return { from: today, to: '' };
  if (range === 'month') { const d = new Date(); return { from: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-01', to: '' }; }
  const n = parseInt(range, 10);
  return { from: dayKey(Date.now() - (n - 1) * 864e5), to: '' };
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('range')) filters.range = p.get('range');
  else if (storageGet('ca-range')) filters.range = storageGet('ca-range');
  filters.from = p.get('from') || '';
  filters.to = p.get('to') || '';
  filters.project = p.get('project') || '';
  filters.model = p.get('model') || '';
  if (filters.range !== 'custom') Object.assign(filters, rangeToDates(filters.range));
}
function writeHash() {
  const p = new URLSearchParams();
  const session = new URLSearchParams(location.hash.slice(1)).get('session');
  p.set('range', filters.range);
  if (filters.range === 'custom') { if (filters.from) p.set('from', filters.from); if (filters.to) p.set('to', filters.to); }
  if (filters.project) p.set('project', filters.project);
  if (filters.model) p.set('model', filters.model);
  if (session && document.getElementById('drilldown').classList.contains('open')) p.set('session', session);
  history.replaceState(null, '', '#' + p.toString());
  storageSet('ca-range', filters.range === 'custom' ? '30' : filters.range);
}
function queryString(extra) {
  const p = new URLSearchParams();
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  if (filters.project) p.set('project', filters.project);
  if (filters.model) p.set('model', filters.model);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}
function setRange(range) {
  filters.range = range;
  Object.assign(filters, rangeToDates(range));
  sessionPage = 0;
  writeHash();
  fetchData();
}
function clearFilters() {
  filters.project = '';
  filters.model = '';
  setRange('all');
}

// ---------- data ----------
async function fetchData(refresh) {
  try {
    const res = await fetch('/api/data?' + queryString(refresh ? { refresh: '1' } : {}));
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    DATA = await res.json();
    render();
  } catch (err) {
    document.getElementById('loading').innerHTML = '<div class="loading-text">Could not load data: ' + escapeHtml(err.message) + '</div>';
  }
}
async function refreshData() {
  await fetchData(true);
  toast('Re-read session files');
}
function toggleLive() {
  const btn = document.getElementById('liveBtn');
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
    btn.classList.remove('on');
    storageSet('ca-live', '0');
  } else {
    liveTimer = setInterval(() => { if (!document.hidden) fetchData(true); }, 30000);
    btn.classList.add('on');
    storageSet('ca-live', '1');
    fetchData(true);
  }
}
function exportData(format, level) {
  closeMenus();
  const q = queryString(format === 'json' ? { format: 'json' } : { format: 'csv', level });
  const a = document.createElement('a');
  a.href = '/api/export?' + q;
  a.click();
}
function toggleMenu(id, e) {
  e.stopPropagation();
  const el = document.getElementById(id);
  const open = el.classList.contains('open');
  closeMenus();
  if (!open) el.classList.add('open');
}
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
document.addEventListener('click', closeMenus);

// ---------- render ----------
function render() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  renderFilters();
  renderStats();
  renderInsights();
  renderDailyChart();
  renderModelChart();
  renderBuckets();
  renderWhatIf();
  renderBlocks();
  renderHeatmap();
  renderTools();
  renderProjectBreakdown();
  renderTopPrompts();
  renderSessions();
  renderFooter();
}

function renderFilters() {
  const o = DATA.options;
  document.querySelectorAll('#rangeChips button').forEach(b => b.classList.toggle('on', b.dataset.range === filters.range));
  const from = document.getElementById('fromDate');
  const to = document.getElementById('toDate');
  from.value = filters.from || '';
  to.value = filters.to || '';
  if (o.minDate) { from.min = o.minDate; to.min = o.minDate; }
  const projSel = document.getElementById('projectFilter');
  projSel.innerHTML = '<option value="">All projects</option>' + o.projects.map(p =>
    '<option value="' + attr(p.id) + '"' + (p.id === filters.project ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
  const modelSel = document.getElementById('modelFilter');
  modelSel.innerHTML = '<option value="">All models</option>' + o.models.map(m =>
    '<option value="' + attr(m) + '"' + (m === filters.model ? ' selected' : '') + '>' + escapeHtml(modelShort(m)) + '</option>').join('');
  document.getElementById('clearFilters').style.display = (filters.project || filters.model || filters.range !== 'all') ? '' : 'none';
  const t = DATA.totals;
  document.getElementById('dateRange').textContent = t.dateRange ? formatDate(t.dateRange.from) + ' – ' + formatDate(t.dateRange.to) : 'No activity';
}

function getBudget() { const v = parseFloat(storageGet('ca-budget')); return isFinite(v) && v > 0 ? v : null; }
function editBudget() {
  const cur = getBudget();
  const v = prompt('Monthly budget in USD (leave empty to remove):', cur || '');
  if (v === null) return;
  const n = parseFloat(v);
  if (v.trim() === '' || !isFinite(n) || n <= 0) storageSet('ca-budget', '');
  else storageSet('ca-budget', String(n));
  renderStats();
}

function renderStats() {
  const t = DATA.totals;
  const mo = DATA.month;
  const budget = getBudget();
  const block = DATA.blocks.find(b => b.active);
  const cal = t.calibration;
  const calNote = cal.sessions
    ? 'Claude Code logged ' + money(cal.reportedCost) + ' for ' + cal.sessions + ' of these sessions'
    : 'Estimated from API list prices';
  const promptTokens = t.tokens.input + t.tokens.cacheWrite + t.tokens.cacheRead;

  let monthSub = 'on pace for ' + money(mo.projected);
  if (mo.prevSamePoint > 0) {
    const delta = Math.round((mo.mtd - mo.prevSamePoint) / mo.prevSamePoint * 100);
    monthSub += ' · ' + (delta >= 0 ? '+' : '') + delta + '% vs last month';
  }
  let budgetHtml = '<button class="link-btn small" onclick="editBudget()">Set a monthly budget</button>';
  if (budget) {
    const used = Math.min(100, mo.mtd / budget * 100);
    const over = mo.projected > budget;
    budgetHtml = '<div class="budget"><div class="budget-bar"><div style="width:' + used.toFixed(1) + '%" class="' + (mo.mtd > budget ? 'over' : over ? 'warn' : '') + '"></div>' +
      '<span class="budget-pace" style="left:' + Math.min(100, mo.dayOfMonth / mo.daysInMonth * 100).toFixed(1) + '%"></span></div>' +
      '<div class="budget-text">' + Math.round(mo.mtd / budget * 100) + '% of ' + money(budget) + (over ? ' · projected over' : '') +
      ' <button class="link-btn small" onclick="editBudget()">edit</button></div></div>';
  }

  let blockCard;
  if (block) {
    const elapsed = 1 - block.remainingMs / (5 * 3.6e6);
    blockCard = { label: 'Current 5h block', display: money(block.cost), grad: 'var(--grad2)',
      sub: duration(block.remainingMs) + ' left · ' + money(block.burnRate) + '/h · ~' + money(block.projected) + ' by reset',
      extra: '<div class="budget-bar thin"><div style="width:' + (elapsed * 100).toFixed(1) + '%"></div></div>' };
  } else {
    const last = DATA.blocks[0];
    blockCard = { label: 'Current 5h block', display: 'Idle', grad: 'var(--grad2)',
      sub: last ? 'last block ' + relTime(last.last) + ' · ' + money(last.cost) : 'no activity yet' };
  }

  const cards = [
    { label: 'Estimated cost', display: money(t.cost.total), grad: 'linear-gradient(135deg,#10b981,#059669)',
      sub: money(t.avgCostPerActiveDay) + '/active day · ' + money(t.avgCostPerSession) + '/session', title: calNote },
    { label: mo.label, display: money(mo.mtd), grad: 'var(--grad1)', sub: monthSub, extra: budgetHtml },
    blockCard,
    { label: 'Saved by caching', display: money(t.cacheSavings), grad: 'var(--grad3)',
      sub: pct(t.tokens.cacheRead, promptTokens) + '% of prompt tokens served from cache' },
    { label: 'Sessions', display: fmt(t.sessions), grad: 'var(--grad4)',
      sub: fmt(t.prompts) + ' prompts · ' + fmt(t.requests) + ' API calls' },
    { label: 'Tokens', display: fmt(t.tokens.total), grad: 'linear-gradient(135deg,#64748b,#94a3b8)',
      sub: fmt(t.tokens.output) + ' written' + (t.tokens.thinking ? ' (' + fmt(t.tokens.thinking) + '+ thinking)' : '') },
  ];
  document.getElementById('statsRow').innerHTML = cards.map((c, i) =>
    '<div class="stat-card anim d' + Math.min(i + 1, 5) + '"' + (c.title ? ' title="' + attr(c.title) + '"' : '') + '>' +
    '<div class="bar" style="background:' + c.grad + '"></div>' +
    '<div class="stat-label">' + escapeHtml(c.label) + '</div>' +
    '<div class="stat-value">' + c.display + '</div>' +
    '<div class="stat-sub">' + c.sub + '</div>' + (c.extra || '') + '</div>'
  ).join('');
}

function renderInsights() {
  const insights = DATA.insights || [];
  const section = document.getElementById('insightsSection');
  if (!insights.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const icons = { warning: '!', info: 'i', neutral: '~', good: '✓' };
  document.getElementById('insightsList').innerHTML = insights.map((ins, i) => {
    const detail = ins.description ? '<div class="insight-detail">' + escapeHtml(ins.description) + '</div>' : '';
    const action = ins.action ? '<div class="insight-action">' + escapeHtml(ins.action) + '</div>' : '';
    return '<div class="insight-card ' + ins.type + ' anim d' + Math.min(i + 2, 5) + '" onclick="this.classList.toggle(\'expanded\')">' +
      '<div class="insight-top">' +
      '<div class="insight-indicator">' + icons[ins.type] + '</div>' +
      '<div class="insight-title">' + escapeHtml(ins.title) + '</div>' +
      '<div class="insight-arrow"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg></div>' +
      '</div><div class="insight-expand">' + detail + action + '</div></div>';
  }).join('');
}

// ---------- charts ----------
function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}
function modelColorMap() {
  const map = {};
  DATA.options.models.forEach((m, i) => { map[m] = MODEL_COLORS[Math.min(i, MODEL_COLORS.length - 1)]; });
  return map;
}
function roundedRect(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function renderDailyChart() {
  const canvas = document.getElementById('dailyChart');
  const tip = document.getElementById('dailyTip');
  const data = DATA.dailyUsage;
  const w = Math.max(200, canvas.parentElement.clientWidth);
  const h = 220;
  const ctx = setupCanvas(canvas, w, h);
  document.getElementById('dailyTitle').textContent = metric === 'cost' ? 'Spend per Day' : 'Tokens per Day';
  if (!data.length) { canvas.onmousemove = null; return; }

  const colors = modelColorMap();
  // Each bar is a stack of [label, value, color] segments.
  const series = data.map(d => metric === 'cost'
    ? Object.entries(d.byModel).sort((a, b) => b[1] - a[1]).map(([m, v]) => [modelShort(m), v, colors[m] || '#64748b'])
    : BUCKETS.filter(b => b.key !== 'web').map(b => [b.label, d.tokens[b.key], b.color]));
  const totals = series.map(s => s.reduce((a, x) => a + x[1], 0));
  const max = Math.max(...totals, metric === 'cost' ? 0.01 : 1);
  const left = 52, bottom = 26, top = 8;
  const chartH = h - bottom - top;
  const slot = (w - left) / data.length;
  const barW = Math.max(2, Math.min(28, slot - 3));
  const label = v => metric === 'cost' ? (max >= 10 ? '$' + fmt(v) : '$' + v.toFixed(2)) : fmt(v);

  ctx.font = '500 10px Inter, system-ui'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = top + chartH - chartH * i / 4;
    ctx.fillText(label(max * i / 4), left - 8, y + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w, y); ctx.stroke();
  }
  series.forEach((segs, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    let y = top + chartH;
    segs.forEach(([, v, c], j) => {
      const sh = v / max * chartH;
      if (sh <= 0) return;
      ctx.fillStyle = c;
      ctx.beginPath();
      if (j === segs.length - 1 || segs.slice(j + 1).every(s => s[1] <= 0)) roundedRect(ctx, x, y - sh, barW, sh, 3);
      else ctx.rect(x, y - sh, barW, sh);
      ctx.fill();
      y -= sh;
    });
  });
  ctx.fillStyle = '#64748b'; ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(data.length / Math.floor((w - left) / 60)));
  data.forEach((d, i) => {
    if (i % step === 0) ctx.fillText(formatDate(d.date), left + i * slot + slot / 2, h - 8);
  });

  const legendItems = metric === 'cost'
    ? DATA.modelBreakdown.map(m => modelShort(m.model) + '|' + (colors[m.model] || '#64748b'))
    : BUCKETS.filter(b => b.key !== 'web').map(b => b.label + '|' + b.color);
  document.getElementById('dailyLegend').innerHTML = legendItems.map(x => {
    const [l, c] = x.split('|');
    return '<div class="legend-item"><div class="legend-dot" style="background:' + c + '"></div>' + escapeHtml(l) + '</div>';
  }).join('');

  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - left) / slot);
    if (i < 0 || i >= data.length) { tip.style.display = 'none'; return; }
    const d = data[i];
    const rows = series[i].filter(s => s[1] > 0).map(s =>
      '<div class="tip-row"><span class="legend-dot" style="background:' + s[2] + '"></span>' + escapeHtml(s[0]) + '<b>' + label(s[1]) + '</b></div>').join('');
    tip.innerHTML = '<div class="tip-title">' + formatDate(d.date) + ' · ' + (metric === 'cost' ? money(d.cost.total) : fmt(d.tokens.total)) + '</div>' +
      (rows || '<div class="tip-row">No activity</div>') +
      '<div class="tip-foot">' + d.sessions + ' sessions · ' + d.requests + ' API calls</div>';
    tip.style.display = 'block';
    const x = left + i * slot + slot / 2;
    tip.style.left = Math.min(Math.max(0, x - tip.offsetWidth / 2), w - tip.offsetWidth) + 'px';
  };
  canvas.onmouseleave = () => { tip.style.display = 'none'; };
}

function renderModelChart() {
  const canvas = document.getElementById('modelChart');
  const data = DATA.modelBreakdown;
  const size = Math.min(170, canvas.parentElement.clientWidth - 48);
  const ctx = setupCanvas(canvas, size, size);
  const legend = document.getElementById('modelLegend');
  if (!data.length) { legend.innerHTML = ''; return; }
  const colors = modelColorMap();
  const total = data.reduce((s, d) => s + d.cost.total, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 4, innerR = r * 0.62;
  let angle = -Math.PI / 2;
  data.forEach(d => {
    const sa = d.cost.total / total * Math.PI * 2;
    if (sa <= 0) return;
    ctx.beginPath(); ctx.arc(cx, cy, r, angle, angle + sa);
    ctx.arc(cx, cy, innerR, angle + sa, angle, true); ctx.closePath();
    ctx.fillStyle = colors[d.model] || '#64748b'; ctx.fill();
    ctx.strokeStyle = '#0a0a1a'; ctx.lineWidth = 2; ctx.stroke();
    angle += sa;
  });
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = '800 17px Inter, system-ui'; ctx.fillText(money(total, 'short'), cx, cy + 3);
  ctx.font = '500 10px Inter, system-ui'; ctx.fillStyle = '#64748b'; ctx.fillText('total', cx, cy + 17);
  legend.innerHTML = data.map(d =>
    '<div class="legend-item clickable" onclick="filterModel(\'' + attr(d.model) + '\')" title="Filter to this model"><div class="legend-dot" style="background:' + (colors[d.model] || '#64748b') + '"></div>' +
    '<span><strong>' + modelShort(d.model) + '</strong> ' + money(d.cost.total) + ' <span class="muted">(' + pct(d.cost.total, total) + '% · ' + fmt(d.tokens.total) + ' tok)</span></span></div>'
  ).join('');
}
function filterModel(m) {
  filters.model = filters.model === m ? '' : m;
  writeHash();
  fetchData();
}

function renderBuckets() {
  const c = DATA.totals.cost;
  const tk = DATA.totals.tokens;
  const total = c.total || 1;
  const tokenOf = { cacheRead: tk.cacheRead, cacheWrite: tk.cacheWrite, output: tk.output, input: tk.input, web: null };
  const items = BUCKETS.filter(b => c[b.key] > 0 || b.key !== 'web');
  document.getElementById('bucketBar').innerHTML = items.map(b =>
    '<div style="width:' + (c[b.key] / total * 100) + '%;background:' + b.color + '" title="' + attr(b.label) + '"></div>').join('');
  document.getElementById('bucketList').innerHTML = items.map(b =>
    '<div class="bucket-row"><span class="legend-dot" style="background:' + b.color + '"></span>' +
    '<div><div class="bucket-label">' + b.label + '</div><div class="bucket-help">' + b.help + '</div></div>' +
    '<div class="bucket-val"><div>' + money(c[b.key]) + ' <span class="muted">' + pct(c[b.key], total) + '%</span></div>' +
    '<div class="bucket-help">' + (tokenOf[b.key] != null ? fmt(tokenOf[b.key]) + ' tokens' : fmt(DATA.totals.webSearches) + ' searches') + '</div></div></div>'
  ).join('');
}

function renderWhatIf() {
  const actual = DATA.totals.cost.total;
  const rows = [{ model: 'actual', cost: actual }, ...DATA.whatIf];
  const max = Math.max(...rows.map(r => r.cost), 0.01);
  document.getElementById('whatIf').innerHTML = rows.map(r => {
    const isActual = r.model === 'actual';
    const diff = actual ? (r.cost - actual) / actual * 100 : 0;
    const badge = isActual ? '' : '<span class="delta ' + (diff <= 0 ? 'down' : 'up') + '">' + (diff > 0 ? '+' : '') + Math.round(diff) + '%</span>';
    return '<div class="whatif-row' + (isActual ? ' actual' : '') + '"><div class="whatif-label">' + (isActual ? 'What you paid' : 'All on ' + modelShort(r.model)) + '</div>' +
      '<div class="whatif-bar"><div class="' + (isActual ? 'actual' : modelClass(r.model)) + '" style="width:' + (r.cost / max * 100).toFixed(1) + '%"></div></div>' +
      '<div class="whatif-val">' + money(r.cost) + ' ' + badge + '</div></div>';
  }).join('');
}

function renderBlocks() {
  const blocks = DATA.blocks.slice(0, 12);
  const body = document.getElementById('blocksBody');
  if (!blocks.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No activity</td></tr>'; return; }
  const max = Math.max(...blocks.map(b => b.cost), 0.01);
  body.innerHTML = blocks.map(b => {
    const status = b.active ? '<span class="pill live">active · ' + duration(b.remainingMs) + ' left</span>' : '';
    return '<tr class="static"><td><div class="block-time">' + formatDateTime(b.start) + ' – ' + formatTime(b.end) + ' ' + status + '</div>' +
      '<div class="muted small">active ' + duration(b.last - b.first) + (b.active && b.burnRate ? ' · ' + money(b.burnRate) + '/h · ~' + money(b.projected) + ' at reset' : '') + '</div></td>' +
      '<td>' + b.models.map(m => '<span class="model-badge ' + modelClass(m) + '"><span class="model-dot"></span>' + modelShort(m) + '</span>').join(' ') + '</td>' +
      '<td class="token-num">' + fmt(b.requests) + '</td>' +
      '<td class="token-num">' + fmt(b.tokens) + '</td>' +
      '<td class="token-num cost-cell"><div class="mini-bar"><div style="width:' + (b.cost / max * 100).toFixed(1) + '%"></div></div>' + money(b.cost) + '</td></tr>';
  }).join('');
}

function renderHeatmap() {
  const hm = DATA.heatmap;
  const max = Math.max(...hm.flat(), 0.0001);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = '<div class="hm-row hm-head"><span></span>' + Array.from({ length: 24 }, (_, h) =>
    '<span>' + (h % 6 === 0 ? (h % 12 || 12) + (h < 12 ? 'a' : 'p') : '') + '</span>').join('') + '</div>';
  for (const d of order) {
    html += '<div class="hm-row"><span class="hm-day">' + days[d] + '</span>' + hm[d].map((v, h) => {
      const a = v > 0 ? 0.12 + 0.88 * Math.sqrt(v / max) : 0;
      return '<span class="hm-cell" style="background:' + (v > 0 ? 'rgba(99,102,241,' + a.toFixed(3) + ')' : 'rgba(255,255,255,.03)') + '" title="' +
        days[d] + ' ' + (h % 12 || 12) + (h < 12 ? 'am' : 'pm') + ': ' + money(v) + '"></span>';
    }).join('') + '</div>';
  }
  document.getElementById('heatmap').innerHTML = html;
}

function renderTools() {
  const tools = DATA.toolBreakdown.slice(0, 12);
  const el = document.getElementById('toolList');
  if (!tools.length) { el.innerHTML = '<div class="empty">No tool calls</div>'; return; }
  const max = tools[0].calls;
  el.innerHTML = tools.map(t =>
    '<div class="tool-row" title="' + attr(t.name) + '"><div class="tool-name">' + escapeHtml(toolLabel(t.name)) + '</div>' +
    '<div class="tool-bar"><div style="width:' + (t.calls / max * 100).toFixed(1) + '%"></div></div>' +
    '<div class="tool-val">' + fmt(t.calls) + ' <span class="muted">· ' + money(t.cost) + '</span></div></div>'
  ).join('') + '<div class="note">Cost is the share of each API call that requested the tool.</div>';
}

// ---------- tables ----------
function toggleProjectDrawer(i) {
  const row = document.getElementById('proj-row-' + i);
  const drawer = document.getElementById('proj-drawer-' + i);
  const isOpen = drawer.classList.contains('open');
  row.classList.toggle('expanded', !isOpen);
  drawer.classList.toggle('open', !isOpen);
}
function toolChips(tools, extra) {
  return Object.entries(tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([n, c]) => '<span class="tool-chip">' + c + '× ' + escapeHtml(toolLabel(n)) + '</span>').join('') + (extra || '');
}
function modelBadge(m) {
  return '<span class="model-badge ' + modelClass(m) + '"><span class="model-dot"></span>' + modelShort(m) + '</span>';
}
function buildDrawerContent(p) {
  if (!p.topPrompts || !p.topPrompts.length) return '<div class="empty">No prompt data</div>';
  return '<div class="drawer-prompt-list">' + p.topPrompts.map((pr, i) =>
    '<div class="drawer-prompt-row" onclick="openDrilldown(\'' + attr(pr.sessionId) + '\')">' +
    '<div class="drawer-rank">' + (i + 1) + '</div><div>' +
    '<div class="drawer-prompt-text">' + escapeHtml(pr.prompt) + '</div>' +
    '<div class="drawer-prompt-meta">' + modelBadge(pr.model) + toolChips(pr.tools, pr.requests > 1 ? '<span class="tool-chip">' + pr.requests + ' API calls</span>' : '') + '</div></div>' +
    '<div class="drawer-tokens"><div class="value">' + money(pr.cost.total) + '</div>' +
    '<div class="sub">' + fmt(pr.tokens.total) + ' tok</div></div></div>'
  ).join('') + '</div>';
}

function renderProjectBreakdown() {
  const projects = DATA.projectBreakdown;
  const body = document.getElementById('projectsBody');
  document.getElementById('projectsCount').textContent = projects.length + ' project' + (projects.length === 1 ? '' : 's');
  if (!projects.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No projects in this range</td></tr>'; return; }
  const max = projects[0].cost.total || 1;
  const chev = '<svg class="proj-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6l4 4-4 4"/></svg>';
  body.innerHTML = projects.map((p, i) => {
    const pills = p.models.map(m => '<li><span class="model-badge ' + modelClass(m.model) + '"><span class="model-dot"></span>' +
      modelShort(m.model) + ' <span class="token-detail">' + money(m.cost) + '</span></span></li>').join('');
    return '<tr class="proj-row" id="proj-row-' + i + '" onclick="toggleProjectDrawer(' + i + ')"><td>' +
      '<div class="proj-cell">' + chev + '<div>' +
      '<div class="proj-name" title="' + attr(p.cwd || p.project) + '">' + escapeHtml(p.name) +
      ' <button class="link-btn small" onclick="event.stopPropagation();filterProject(\'' + attr(p.project) + '\')">filter</button></div>' +
      '<ul class="model-pills">' + pills + '</ul></div></div></td>' +
      '<td class="token-num cost-cell"><div class="mini-bar"><div style="width:' + (p.cost.total / max * 100).toFixed(1) + '%"></div></div>' + money(p.cost.total) + '</td>' +
      '<td class="token-num">' + fmt(p.tokens.total) + '</td>' +
      '<td class="token-num">' + p.sessions + '</td>' +
      '<td class="token-num muted">' + relTime(p.last) + '</td></tr>' +
      '<tr class="proj-drawer" id="proj-drawer-' + i + '"><td colspan="5"><div class="proj-drawer-inner"><div class="proj-drawer-content">' +
      buildDrawerContent(p) + '</div></div></td></tr>';
  }).join('');
}
function filterProject(p) {
  filters.project = p;
  writeHash();
  fetchData();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderTopPrompts() {
  const prompts = DATA.topPrompts;
  const el = document.getElementById('topPromptsList');
  if (!prompts.length) { el.innerHTML = '<div class="empty">No prompts in this range</div>'; return; }
  const max = prompts[0].cost.total || 1;
  el.innerHTML = prompts.map((p, i) => {
    const c = p.cost;
    const parts = [['cacheRead', '#6366f1'], ['cacheWrite', '#a855f7'], ['output', '#14b8a6'], ['input', '#f59e0b']];
    const sub = p.subagentCost > 0 ? ' · ' + pct(p.subagentCost, c.total) + '% subagents' : '';
    return '<div class="prompt-row" onclick="openDrilldown(\'' + attr(p.sessionId) + '\')">' +
      '<div class="prompt-rank">' + (i + 1) + '</div><div>' +
      '<div class="prompt-text">' + escapeHtml(p.prompt) + '</div>' +
      '<div class="prompt-meta">' + formatDate(p.date) + ' · ' + escapeHtml(p.projectName) + ' · ' + modelShort(p.model) + ' · ' + p.requests + ' API calls' + sub + '</div>' +
      '<div class="token-bar-wrap" style="width:' + Math.max(8, c.total / max * 100) + '%">' +
      parts.map(([k, col]) => '<div style="width:' + (c.total ? c[k] / c.total * 100 : 0) + '%;background:' + col + '"></div>').join('') + '</div></div>' +
      '<div class="prompt-tokens"><div class="value">' + money(c.total) + '</div>' +
      '<div class="sub">' + fmt(p.tokens.total) + ' tokens</div></div></div>';
  }).join('');
}

function renderSessions() {
  let sessions = [...DATA.sessions];
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    sessions = sessions.filter(s =>
      (s.firstPrompt || '').toLowerCase().includes(q) || (s.title || '').toLowerCase().includes(q) ||
      s.models.some(m => m.includes(q) || modelShort(m).toLowerCase().includes(q)) ||
      (s.projectName || '').toLowerCase().includes(q) || (s.gitBranch || '').toLowerCase().includes(q) ||
      s.sessionId.startsWith(q));
  }
  const sortFns = {
    date: (a, b) => (a.start || 0) - (b.start || 0),
    prompt: (a, b) => (a.title || a.firstPrompt).localeCompare(b.title || b.firstPrompt),
    model: (a, b) => (a.model || '').localeCompare(b.model || ''),
    prompts: (a, b) => a.prompts - b.prompts,
    tokens: (a, b) => a.tokens.total - b.tokens.total,
    cost: (a, b) => a.cost.total - b.cost.total,
  };
  const fn = sortFns[currentSort.key] || sortFns.cost;
  sessions.sort((a, b) => currentSort.dir === 'desc' ? fn(b, a) : fn(a, b));
  const pages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  sessionPage = Math.min(sessionPage, pages - 1);
  const page = sessions.slice(sessionPage * PAGE_SIZE, (sessionPage + 1) * PAGE_SIZE);
  document.getElementById('sessionCount').textContent = sessions.length + ' session' + (sessions.length === 1 ? '' : 's');
  document.getElementById('sessionsBody').innerHTML = page.length ? page.map(s => {
    const heading = s.title || s.firstPrompt;
    const sub = s.title && s.firstPrompt !== s.title ? s.firstPrompt : '';
    const extra = [s.gitBranch ? '⎇ ' + s.gitBranch : '', s.subagentCost > 0 ? pct(s.subagentCost, s.cost.total) + '% subagents' : '',
      s.linesAdded ? '+' + fmt(s.linesAdded) + ' / −' + fmt(s.linesRemoved || 0) + ' lines' : ''].filter(Boolean).join(' · ');
    return '<tr onclick="openDrilldown(\'' + attr(s.sessionId) + '\')">' +
      '<td class="date-cell">' + formatDate(s.date) + '<span class="project-tag" title="' + attr(s.cwd || s.project) + '">' + escapeHtml(s.projectName) + '</span></td>' +
      '<td><div class="prompt-preview" title="' + attr(s.firstPrompt) + '">' + escapeHtml(heading) + '</div>' +
      (sub || extra ? '<div class="prompt-sub">' + escapeHtml(sub ? sub.substring(0, 120) : '') + (sub && extra ? ' · ' : '') + escapeHtml(extra) + '</div>' : '') + '</td>' +
      '<td>' + modelBadge(s.model) + (s.models.length > 1 ? ' <span class="muted small">+' + (s.models.length - 1) + '</span>' : '') + '</td>' +
      '<td class="token-num">' + s.prompts + '</td>' +
      '<td class="token-num">' + fmt(s.tokens.total) + '</td>' +
      '<td class="token-num cost-strong">' + money(s.cost.total) + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="empty">No sessions match</td></tr>';

  const pager = document.getElementById('pager');
  pager.innerHTML = pages > 1
    ? '<button ' + (sessionPage === 0 ? 'disabled' : '') + ' onclick="sessionPage--;renderSessions()">‹ Prev</button>' +
      '<span>Page ' + (sessionPage + 1) + ' of ' + pages + '</span>' +
      '<button ' + (sessionPage >= pages - 1 ? 'disabled' : '') + ' onclick="sessionPage++;renderSessions()">Next ›</button>'
    : '';
}

function renderFooter() {
  const cal = DATA.totals.calibration;
  const parts = ['Data read ' + formatTime(DATA.parsedAt)];
  if (cal.sessions) parts.push('cross-checked against Claude Code’s own cost records for ' + cal.sessions + ' sessions (' + money(cal.estimatedCost) + ' estimated vs ' + money(cal.reportedCost) + ' logged)');
  parts.push('prices as of ' + DATA.pricing.updated);
  document.getElementById('footer').innerHTML = escapeHtml(parts.join(' · ')) +
    '<div>Built with <a href="https://claude.ai/code" target="_blank" rel="noopener">Claude Code</a></div>';
}

// ---------- drilldown ----------
let detail = null;
async function openDrilldown(sessionId) {
  const modal = document.getElementById('drilldown');
  document.getElementById('drilldownTitle').textContent = 'Loading…';
  document.getElementById('drilldownMeta').textContent = '';
  document.getElementById('drilldownStats').innerHTML = '';
  document.getElementById('queryList').innerHTML = '';
  modal.classList.add('open');
  document.body.classList.add('no-scroll');
  try {
    const res = await fetch('/api/session/' + encodeURIComponent(sessionId));
    if (!res.ok) throw new Error((await res.json()).error);
    detail = await res.json();
  } catch (err) {
    document.getElementById('drilldownTitle').textContent = 'Could not load session: ' + err.message;
    return;
  }
  const d = detail;
  const hp = new URLSearchParams(location.hash.slice(1));
  hp.set('session', d.sessionId);
  history.replaceState(null, '', '#' + hp.toString());
  const firstPrompt = d.turns.find(t => t.prompt)?.prompt;
  document.getElementById('drilldownTitle').textContent = (d.title || firstPrompt || '(no prompt)').substring(0, 160);
  document.getElementById('drilldownMeta').innerHTML = escapeHtml([formatDateTime(d.start), d.projectName, d.gitBranch ? '⎇ ' + d.gitBranch : '', d.version ? 'v' + d.version : ''].filter(Boolean).join(' · ')) +
    ' · <button class="link-btn small" onclick="copyText(\'' + attr(d.resumeCommand) + '\')">copy resume command</button>';
  const stats = [
    ['Cost', money(d.cost)],
    ['Duration', duration((d.end || 0) - (d.start || 0))],
    ['Prompts', d.turns.filter(t => t.prompt).length],
    ['API calls', d.timeline.length],
  ];
  if (d.subagentCost > 0) stats.push(['Subagents', money(d.subagentCost) + ' (' + pct(d.subagentCost, d.cost) + '%)']);
  if (d.reported) stats.push(['Claude Code logged', money(d.reported.cost)]);
  if (d.reported && d.reported.linesAdded) stats.push(['Lines', '+' + fmt(d.reported.linesAdded) + ' / −' + fmt(d.reported.linesRemoved)]);
  document.getElementById('drilldownStats').innerHTML = stats.map(([l, v]) =>
    '<div class="mini-stat"><div class="mini-label">' + l + '</div><div class="mini-value">' + v + '</div></div>').join('');

  const max = Math.max(...d.turns.map(t => t.cost.total), 0.0001);
  document.getElementById('queryList').innerHTML = d.turns.map((q, i) => {
    const chips = toolChips(q.tools, q.subagentCost > 0 ? '<span class="tool-chip">' + money(q.subagentCost) + ' subagents</span>' : '');
    return '<div class="query-item"><div class="query-num">' + (q.prompt ? i + 1 : '·') + '</div>' +
      '<div><div class="query-prompt' + (q.prompt ? '' : ' no-prompt') + '">' + escapeHtml(q.prompt ? q.prompt.substring(0, 600) : 'Background work (session start, title generation, summaries)') + '</div>' +
      '<div class="drawer-prompt-meta">' + (q.model ? modelBadge(q.model) : '') + '<span class="tool-chip">' + q.requests + ' API calls</span>' +
      (q.durationMs > 60000 ? '<span class="tool-chip">' + duration(q.durationMs) + '</span>' : '') + chips + '</div>' +
      '<div class="mini-bar wide"><div style="width:' + (q.cost.total / max * 100).toFixed(1) + '%"></div></div></div>' +
      '<div class="query-tokens-col"><div class="total">' + money(q.cost.total) + '</div>' +
      '<div class="detail">' + fmt(q.tokens.total) + ' tok · ' + fmt(q.tokens.output) + ' out</div></div></div>';
  }).join('');
  renderContextChart();
}
function closeDrilldown() {
  if (detail || document.getElementById('drilldown').classList.contains('open')) {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('session')) { p.delete('session'); history.replaceState(null, '', '#' + p.toString()); }
  }
  document.getElementById('drilldown').classList.remove('open');
  document.body.classList.remove('no-scroll');
  detail = null;
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied: ' + text), () => toast(text));
}

function renderContextChart() {
  if (!detail) return;
  const canvas = document.getElementById('contextChart');
  const tip = document.getElementById('contextTip');
  const pts = detail.timeline.filter(p => !p.background);
  const w = Math.max(200, canvas.parentElement.clientWidth);
  const h = 150;
  const ctx = setupCanvas(canvas, w, h);
  if (!pts.length) return;
  const left = 48, top = 8, bottom = 18;
  const chartH = h - top - bottom;
  const maxCtx = Math.max(...pts.map(p => p.context), 1);
  const maxCost = Math.max(...pts.map(p => p.cost), 0.0001);
  const slot = (w - left) / pts.length;
  ctx.font = '500 10px Inter, system-ui'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const y = top + chartH - chartH * i / 2;
    ctx.fillText(fmt(maxCtx * i / 2), left - 8, y + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w, y); ctx.stroke();
  }
  pts.forEach((p, i) => {
    const bh = p.cost / maxCost * chartH * 0.5;
    ctx.fillStyle = p.side ? 'rgba(236,72,153,.45)' : 'rgba(20,184,166,.45)';
    ctx.fillRect(left + i * slot, top + chartH - bh, Math.max(1, slot - 1), bh);
  });
  ctx.strokeStyle = '#818cf8'; ctx.lineWidth = 1.5; ctx.beginPath();
  let started = false;
  pts.forEach((p, i) => {
    if (p.side) return;
    const x = left + i * slot + slot / 2, y = top + chartH - p.context / maxCtx * chartH;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#64748b'; ctx.textAlign = 'left';
  ctx.fillText('main context', left + 4, h - 4);
  ctx.fillStyle = '#ec4899'; ctx.fillText('■ subagent calls', left + 90, h - 4);

  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - left) / slot);
    if (i < 0 || i >= pts.length) { tip.style.display = 'none'; return; }
    const p = pts[i];
    tip.innerHTML = '<div class="tip-title">' + formatTime(p.t) + ' · ' + modelShort(p.model) + (p.side ? ' · subagent' : '') + '</div>' +
      '<div class="tip-row">Context<b>' + fmt(p.context) + '</b></div><div class="tip-row">Output<b>' + fmt(p.output) + '</b></div>' +
      '<div class="tip-row">Cost<b>' + money(p.cost) + '</b></div>';
    tip.style.display = 'block';
    tip.style.left = Math.min(Math.max(0, left + i * slot - tip.offsetWidth / 2), w - tip.offsetWidth) + 'px';
  };
  canvas.onmouseleave = () => { tip.style.display = 'none'; };
}

// ---------- pricing ----------
function openPricing() {
  const p = DATA.pricing;
  const rate = v => '$' + (v < 1 ? v.toFixed(2) : v.toFixed(v % 1 ? 2 : 0));
  document.getElementById('pricingMeta').textContent = 'Anthropic API list prices per 1M tokens, as of ' + p.updated;
  document.getElementById('pricingBody').innerHTML =
    '<p class="pricing-intro">Every API request is priced from five token counts in your session logs: uncached input, cache writes (' +
    p.cacheWrite5m + '× input for the 5-minute cache, ' + p.cacheWrite1h + '× for the 1-hour cache), cache reads, output (including thinking), and web searches ($' + p.webSearchPer1k + ' per 1,000). ' +
    'Claude Code writes each streamed response as several log lines; they are merged so nothing is counted twice. Where Claude Code recorded its own running cost for a session, token counts are topped up to match it.</p>' +
    '<p class="pricing-intro">On a Pro or Max plan you pay a flat subscription, so these figures show what the same usage would cost at API rates.</p>' +
    '<table class="tbl"><thead><tr><th>Model</th><th style="text-align:right">Input</th><th style="text-align:right">5m write</th><th style="text-align:right">1h write</th><th style="text-align:right">Cache read</th><th style="text-align:right">Output</th></tr></thead><tbody>' +
    p.models.map(m => '<tr class="static"><td>' + escapeHtml(m.name) + (m.longContext ? '<div class="muted small">above ' + fmt(m.longContext.threshold) + ' prompt tokens: ' + rate(m.longContext.input) + ' / ' + rate(m.longContext.output) + '</div>' : '') +
      (m.fast ? '<div class="muted small">fast mode ' + m.fast + '×</div>' : '') + '</td>' +
      '<td class="token-num">' + rate(m.input) + '</td><td class="token-num">' + rate(m.input * p.cacheWrite5m) + '</td><td class="token-num">' + rate(m.input * p.cacheWrite1h) + '</td>' +
      '<td class="token-num">' + rate(m.cacheRead) + '</td><td class="token-num">' + rate(m.output) + '</td></tr>').join('') +
    '</tbody></table>';
  document.getElementById('pricingModal').classList.add('open');
  document.body.classList.add('no-scroll');
}
function closePricing() {
  document.getElementById('pricingModal').classList.remove('open');
  document.body.classList.remove('no-scroll');
}

// ---------- wiring ----------
document.querySelectorAll('#rangeChips button').forEach(b => b.addEventListener('click', () => setRange(b.dataset.range)));
['fromDate', 'toDate'].forEach(id => document.getElementById(id).addEventListener('change', () => {
  filters.range = 'custom';
  filters.from = document.getElementById('fromDate').value;
  filters.to = document.getElementById('toDate').value;
  writeHash();
  fetchData();
}));
document.getElementById('projectFilter').addEventListener('change', e => { filters.project = e.target.value; writeHash(); fetchData(); });
document.getElementById('modelFilter').addEventListener('change', e => { filters.model = e.target.value; writeHash(); fetchData(); });
document.querySelectorAll('#metricToggle button').forEach(b => b.addEventListener('click', () => {
  metric = b.dataset.metric;
  document.querySelectorAll('#metricToggle button').forEach(x => x.classList.toggle('on', x === b));
  renderDailyChart();
}));
document.querySelectorAll('.tbl th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (currentSort.key === key) currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
    else currentSort = { key, dir: 'desc' };
    document.querySelectorAll('.tbl th[data-sort]').forEach(t => t.classList.remove('sorted', 'asc'));
    th.classList.add('sorted');
    th.classList.toggle('asc', currentSort.dir === 'asc');
    sessionPage = 0;
    renderSessions();
  });
});
document.getElementById('searchInput').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  sessionPage = 0;
  renderSessions();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDrilldown(); closePricing(); closeMenus(); }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); document.getElementById('searchInput').focus(); }
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (DATA) { renderDailyChart(); renderModelChart(); renderContextChart(); } }, 120);
});

readHash();
const initialSession = new URLSearchParams(location.hash.slice(1)).get('session');
writeHash();
fetchData().then(() => { if (initialSession) openDrilldown(initialSession); });
if (storageGet('ca-live') === '1') toggleLive();
