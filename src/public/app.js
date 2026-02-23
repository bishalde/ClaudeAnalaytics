let DATA = null;
let currentSort = { key: 'total', dir: 'desc' };
let searchQuery = '';

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtFull(n) { return n.toLocaleString(); }
function modelClass(m) {
  if (m.includes('opus')) return 'model-opus';
  if (m.includes('sonnet')) return 'model-sonnet';
  if (m.includes('haiku')) return 'model-haiku';
  return 'model-unknown';
}
function modelShort(m) {
  let match = m.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1) + ' ' + match[2] + '.' + match[3];
  match = m.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)/i);
  if (match) return match[3].charAt(0).toUpperCase() + match[3].slice(1) + ' ' + match[1] + '.' + match[2];
  match = m.match(/^claude-(\d+)-(opus|sonnet|haiku)/i);
  if (match) return match[2].charAt(0).toUpperCase() + match[2].slice(1) + ' ' + match[1];
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return m;
}
function projectShort(p) {
  let s = p.replace(/^[A-Za-z]--/, '');
  const known = /^(?:Users|home|user)-[^-]+-|^(?:GitHub|GitLab|git|Projects|projects|workspace|Workspace|Desktop|Documents|source|src|dev|Dev|code|Code|repos|Repos)-/;
  let prev;
  do { prev = s; s = s.replace(known, ''); } while (s !== prev && s.length > 0);
  return s || p;
}
function projectFull(p) { return p.replace(/^([A-Za-z])--/, '$1:\\'); }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function formatDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(parts[1]) - 1] + ' ' + parseInt(parts[2]);
}

function animateValue(el, end, duration) {
  const start = 0;
  const startTime = performance.now();
  const text = el.textContent;
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (end - start) * eased);
    el.textContent = fmt(current);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

async function fetchData() {
  const res = await fetch('/api/data');
  DATA = await res.json();
  render();
}
async function refreshData() {
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  await fetch('/api/refresh');
  await fetchData();
}

function render() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  renderStats();
  renderInsights();
  renderDailyChart();
  renderModelChart();
  renderProjectBreakdown();
  renderTopPrompts();
  renderSessions();
}

function renderStats() {
  const t = DATA.totals;
  const range = t.dateRange ? formatDate(t.dateRange.from) + ' - ' + formatDate(t.dateRange.to) : '';
  document.getElementById('dateRange').textContent = range;
  const costSub = t.costBreakdown ? t.costBreakdown.map(c => modelShort(c.model) + ': $' + c.cost.toFixed(2)).join(' · ') : '';
  const cards = [
    { label: 'Total Usage', value: t.totalTokens, sub: fmt(t.totalInputTokens) + ' read + ' + fmt(t.totalOutputTokens) + ' written', grad: 'var(--grad1)' },
    { label: 'Est. API Cost', value: null, display: '$' + (t.estimatedCost || 0).toFixed(2), sub: costSub || 'based on current API pricing', grad: 'linear-gradient(135deg,#10b981,#059669)' },
    { label: 'Conversations', value: t.totalSessions, sub: '~' + fmt(t.avgTokensPerSession) + ' tokens avg', grad: 'var(--grad2)' },
    { label: 'Messages', value: t.totalQueries, sub: '~' + fmt(t.avgTokensPerQuery) + ' tokens avg', grad: 'var(--grad3)' },
  ];
  document.getElementById('statsRow').innerHTML = cards.map((c, i) =>
    '<div class="stat-card anim d' + (i + 1) + '">' +
    '<div class="bar" style="background:' + c.grad + '"></div>' +
    '<div class="stat-label">' + c.label + '</div>' +
    '<div class="stat-value"' + (c.value !== null ? ' data-target="' + c.value + '"' : '') + '>' + (c.display || fmt(c.value)) + '</div>' +
    '<div class="stat-sub">' + c.sub + '</div></div>'
  ).join('');
  document.querySelectorAll('.stat-value[data-target]').forEach(el => {
    animateValue(el, parseInt(el.dataset.target), 1200);
  });
}

function exportCSV() {
  if (!DATA || !DATA.sessions.length) return;
  const header = 'Date,Project,First Prompt,Model,Messages,Input Tokens,Output Tokens,Total Tokens';
  const rows = DATA.sessions.map(s => {
    const prompt = '"' + (s.firstPrompt || '').replace(/"/g, '""') + '"';
    const proj = '"' + projectShort(s.project).replace(/"/g, '""') + '"';
    return [s.date, proj, prompt, modelShort(s.model), s.queryCount, s.inputTokens, s.outputTokens, s.totalTokens].join(',');
  });
  const csv = header + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'claude-usage-' + new Date().toISOString().split('T')[0] + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function renderInsights() {
  const insights = DATA.insights || [];
  const section = document.getElementById('insightsSection');
  if (!insights.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const icons = { warning: '!', info: 'i', neutral: '~' };
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

function renderDailyChart() {
  const canvas = document.getElementById('dailyChart');
  const ctx = canvas.getContext('2d');
  const data = DATA.dailyUsage;
  if (!data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth - 48;
  const h = 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const maxTotal = Math.max(...data.map(d => d.totalTokens));
  const barW = Math.max(8, Math.min(32, (w - 52) / data.length - 3));
  const gap = 3, chartH = h - 36, startX = 48;
  ctx.font = '500 10px Inter, system-ui'; ctx.fillStyle = '#475569'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = (maxTotal / 4) * i;
    const y = chartH - (chartH * i / 4) + 8;
    ctx.fillText(fmt(val), startX - 10, y + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(startX, y); ctx.lineTo(w, y); ctx.stroke();
  }
  data.forEach((d, i) => {
    const x = startX + i * (barW + gap);
    const baseY = chartH + 8;
    const r = Math.min(4, barW / 2);
    const outH = (d.outputTokens / maxTotal) * chartH;
    if (outH > 0) { ctx.fillStyle = '#14b8a6'; ctx.beginPath(); roundedRect(ctx, x, baseY - outH, barW, outH, r); ctx.fill(); }
    const inH = (d.inputTokens / maxTotal) * chartH;
    if (inH > 0) { ctx.fillStyle = '#6366f1'; ctx.beginPath(); roundedRect(ctx, x, baseY - outH - inH, barW, inH, r); ctx.fill(); }
  });
  ctx.fillStyle = '#475569'; ctx.textAlign = 'center'; ctx.font = '500 10px Inter, system-ui';
  const step = Math.max(1, Math.floor(data.length / 7));
  data.forEach((d, i) => {
    if (i % step === 0 || i === data.length - 1) {
      ctx.fillText(formatDate(d.date), startX + i * (barW + gap) + barW / 2, chartH + 24);
    }
  });
}

function roundedRect(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function renderModelChart() {
  const canvas = document.getElementById('modelChart');
  const ctx = canvas.getContext('2d');
  const data = DATA.modelBreakdown;
  if (!data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const size = Math.min(180, canvas.parentElement.clientWidth - 48);
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  ctx.scale(dpr, dpr);
  const cx = size / 2, cy = size / 2, r = size / 2 - 6, innerR = r * 0.6;
  const total = data.reduce((s, d) => s + d.totalTokens, 0);
  const colors = { opus: '#6366f1', sonnet: '#10b981', haiku: '#f97316' };
  function getColor(m) { for (const [k, c] of Object.entries(colors)) { if (m.includes(k)) return c; } return '#64748b'; }
  let angle = -Math.PI / 2;
  const slices = [...data].sort((a, b) => b.totalTokens - a.totalTokens);
  slices.forEach(d => {
    const sa = (d.totalTokens / total) * Math.PI * 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, angle, angle + sa);
    ctx.arc(cx, cy, innerR, angle + sa, angle, true); ctx.closePath();
    ctx.fillStyle = getColor(d.model); ctx.fill();
    ctx.strokeStyle = '#0a0a1a'; ctx.lineWidth = 3; ctx.stroke();
    angle += sa;
  });
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = '800 17px Inter, system-ui'; ctx.fillText(fmt(total), cx, cy + 2);
  ctx.font = '500 10px Inter, system-ui'; ctx.fillStyle = '#64748b'; ctx.fillText('total', cx, cy + 16);
  document.getElementById('modelLegend').innerHTML = slices.map(d => {
    const pct = ((d.totalTokens / total) * 100).toFixed(1);
    return '<div class="legend-item"><div class="legend-dot" style="background:' + getColor(d.model) + '"></div>' +
      '<span><strong>' + modelShort(d.model) + '</strong> &ndash; ' + fmt(d.totalTokens) + ' (' + pct + '%)</span></div>';
  }).join('');
}

function toggleProjectDrawer(i) {
  const row = document.getElementById('proj-row-' + i);
  const drawer = document.getElementById('proj-drawer-' + i);
  const isOpen = drawer.classList.contains('open');
  row.classList.toggle('expanded', !isOpen);
  drawer.classList.toggle('open', !isOpen);
}

function buildDrawerContent(p) {
  if (!p.topPrompts || !p.topPrompts.length) return '<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px">No prompt data</div>';
  return '<div class="drawer-prompt-list">' + p.topPrompts.map((pr, i) => {
    const toolEntries = Object.entries(pr.toolCounts || {}).sort((a, b) => b[1] - a[1]);
    const chips = toolEntries.map(([n, c]) => '<span class="tool-chip">' + c + '\u00d7 ' + escapeHtml(n) + '</span>').join('') +
      (pr.continuations > 0 ? '<span class="tool-chip">+' + pr.continuations + ' turns</span>' : '');
    const badge = '<span class="model-badge ' + modelClass(pr.model) + '"><span class="model-dot"></span>' + modelShort(pr.model) + '</span>';
    return '<div class="drawer-prompt-row" onclick="openDrilldown(\'' + pr.sessionId + '\')">' +
      '<div class="drawer-rank">' + (i + 1) + '</div><div>' +
      '<div class="drawer-prompt-text">' + escapeHtml(pr.prompt) + '</div>' +
      '<div class="drawer-prompt-meta">' + badge + chips + '</div></div>' +
      '<div class="drawer-tokens"><div class="value">' + fmt(pr.totalTokens) + '</div>' +
      '<div class="sub">' + fmt(pr.inputTokens) + ' / ' + fmt(pr.outputTokens) + '</div></div></div>';
  }).join('') + '</div>';
}

function renderProjectBreakdown() {
  const projects = DATA.projectBreakdown;
  if (!projects || !projects.length) return;
  document.getElementById('projectsCount').textContent = projects.length + ' project' + (projects.length === 1 ? '' : 's');
  const maxTokens = projects[0].totalTokens;
  const chev = '<svg class="proj-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6l4 4-4 4"/></svg>';
  const rows = [];
  projects.forEach((p, i) => {
    const barPct = (p.totalTokens / maxTokens * 100).toFixed(1);
    const pills = p.modelBreakdown.map(m =>
      '<li><span class="model-badge ' + modelClass(m.model) + '"><span class="model-dot"></span>' + modelShort(m.model) +
      ' <span class="token-detail">\u2193' + fmt(m.inputTokens) + '</span>' +
      ' <span class="token-detail">\u2191' + fmt(m.outputTokens) + '</span></span></li>'
    ).join('');
    rows.push(
      '<tr class="proj-row" id="proj-row-' + i + '" onclick="toggleProjectDrawer(' + i + ')"><td style="padding:10px 16px">' +
      '<div style="display:flex;align-items:center;gap:6px">' + chev + '<div>' +
      '<div class="proj-name" title="' + projectFull(p.project) + '">' + escapeHtml(projectShort(p.project)) + '</div>' +
      '<ul class="model-pills">' + pills + '</ul></div></div></td>' +
      '<td class="token-num" style="font-weight:700;vertical-align:top;padding-top:12px">' +
      '<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">' +
      '<div style="flex:1;max-width:60px;height:3px;background:var(--surface2);border-radius:4px;overflow:hidden">' +
      '<div style="width:' + barPct + '%;height:100%;background:var(--indigo);border-radius:4px"></div></div>' +
      '<div><div>' + fmt(p.totalTokens) + '</div><div style="font-size:11px;font-weight:500;color:var(--text3);margin-top:1px">' +
      fmt(p.inputTokens) + ' in \u00b7 ' + fmt(p.outputTokens) + ' out</div></div></div></td>' +
      '<td class="token-num" style="vertical-align:top;padding-top:12px">' + p.sessionCount + '</td>' +
      '<td class="token-num" style="vertical-align:top;padding-top:12px">' + p.queryCount + '</td></tr>',
      '<tr class="proj-drawer" id="proj-drawer-' + i + '"><td colspan="4"><div class="proj-drawer-inner"><div class="proj-drawer-content">' +
      buildDrawerContent(p) + '</div></div></td></tr>'
    );
  });
  document.getElementById('projectsBody').innerHTML = rows.join('');
}

function renderTopPrompts() {
  const prompts = DATA.topPrompts;
  if (!prompts.length) return;
  const maxTokens = prompts[0].totalTokens;
  document.getElementById('topPromptsList').innerHTML = prompts.map((p, i) => {
    const inPct = (p.inputTokens / p.totalTokens) * 100;
    return '<div class="prompt-row" onclick="openDrilldown(\'' + p.sessionId + '\')">' +
      '<div class="prompt-rank">' + (i + 1) + '</div><div>' +
      '<div class="prompt-text">' + escapeHtml(p.prompt) + '</div>' +
      '<div class="prompt-meta">' + formatDate(p.date) + ' &middot; ' + modelShort(p.model) + '</div>' +
      '<div class="token-bar-wrap" style="width:' + Math.max(10, (p.totalTokens / maxTokens) * 100) + '%">' +
      '<div class="token-bar-in" style="width:' + inPct + '%"></div>' +
      '<div class="token-bar-out" style="width:' + (100 - inPct) + '%"></div></div></div>' +
      '<div class="prompt-tokens"><div class="value">' + fmt(p.totalTokens) + '</div>' +
      '<div class="sub">' + fmt(p.inputTokens) + ' read &middot; ' + fmt(p.outputTokens) + ' written</div></div></div>';
  }).join('');
}

function renderSessions() {
  let sessions = [...DATA.sessions];
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    sessions = sessions.filter(s =>
      s.firstPrompt.toLowerCase().includes(q) || s.model.toLowerCase().includes(q) || projectShort(s.project).toLowerCase().includes(q)
    );
  }
  const sortFns = {
    date: (a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''),
    prompt: (a, b) => a.firstPrompt.localeCompare(b.firstPrompt),
    model: (a, b) => a.model.localeCompare(b.model),
    queries: (a, b) => a.queryCount - b.queryCount,
    total: (a, b) => a.totalTokens - b.totalTokens,
    input: (a, b) => a.inputTokens - b.inputTokens,
    output: (a, b) => a.outputTokens - b.outputTokens,
  };
  const fn = sortFns[currentSort.key] || sortFns.total;
  sessions.sort((a, b) => currentSort.dir === 'desc' ? fn(b, a) : fn(a, b));
  document.getElementById('sessionCount').textContent = sessions.length + ' sessions';
  document.getElementById('sessionsBody').innerHTML = sessions.map(s =>
    '<tr onclick="openDrilldown(\'' + s.sessionId + '\')">' +
    '<td class="date-cell">' + formatDate(s.date) + '<span class="project-tag" title="' + escapeHtml(projectShort(s.project)) + '">' + escapeHtml(projectShort(s.project)) + '</span></td>' +
    '<td><div class="prompt-preview" title="' + escapeHtml(s.firstPrompt) + '">' + escapeHtml(s.firstPrompt) + '</div></td>' +
    '<td><span class="model-badge ' + modelClass(s.model) + '"><span class="model-dot"></span>' + modelShort(s.model) + '</span></td>' +
    '<td class="token-num">' + s.queryCount + '</td>' +
    '<td class="token-num" style="font-weight:700">' + fmt(s.totalTokens) + '</td>' +
    '<td class="token-num">' + fmt(s.inputTokens) + '</td>' +
    '<td class="token-num">' + fmt(s.outputTokens) + '</td></tr>'
  ).join('');
}

document.querySelectorAll('.tbl th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (currentSort.key === key) currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
    else currentSort = { key, dir: 'desc' };
    document.querySelectorAll('.tbl th').forEach(t => t.classList.remove('sorted'));
    th.classList.add('sorted');
    renderSessions();
  });
});

document.getElementById('searchInput').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderSessions();
});

function openDrilldown(sessionId) {
  const session = DATA.sessions.find(s => s.sessionId === sessionId);
  if (!session) return;
  document.getElementById('drilldownTitle').textContent = session.firstPrompt.substring(0, 140);
  document.getElementById('drilldownMeta').textContent =
    formatDate(session.date) + ' \u00B7 ' + modelShort(session.model) + ' \u00B7 ' + session.queryCount + ' messages \u00B7 ' + fmt(session.totalTokens) + ' tokens';
  const grouped = [];
  let current = null;
  for (const q of session.queries) {
    if (q.userPrompt) {
      if (current) grouped.push(current);
      current = { prompt: q.userPrompt, inputTokens: q.inputTokens, outputTokens: q.outputTokens, totalTokens: q.totalTokens, continuations: 0 };
    } else if (current) {
      current.inputTokens += q.inputTokens;
      current.outputTokens += q.outputTokens;
      current.totalTokens += q.totalTokens;
      current.continuations++;
    }
  }
  if (current) grouped.push(current);
  document.getElementById('queryList').innerHTML = grouped.map((q, i) => {
    const cont = q.continuations > 0 ? ' + ' + q.continuations + ' tool uses' : '';
    return '<div class="query-item"><div class="query-num">' + (i + 1) + '</div>' +
      '<div class="query-prompt">' + escapeHtml(q.prompt.substring(0, 500)) + '</div>' +
      '<div class="query-tokens-col"><div class="total">' + fmt(q.totalTokens) + '</div>' +
      '<div class="detail">' + fmt(q.inputTokens) + ' read / ' + fmt(q.outputTokens) + ' written' + cont + '</div></div></div>';
  }).join('');
  const panel = document.getElementById('drilldown');
  panel.classList.add('open');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDrilldown() {
  document.getElementById('drilldown').classList.remove('open');
}

fetchData();
window.addEventListener('resize', () => { if (DATA) { renderDailyChart(); renderModelChart(); } });
