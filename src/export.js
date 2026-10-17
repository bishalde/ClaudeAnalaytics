const { buildReport, dayKey } = require('./report');
const { normalizeModel } = require('./parser');

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csv(header, rows) {
  return [header.join(','), ...rows.map(r => r.map(cell).join(','))].join('\n') + '\n';
}

function toCSV(data, filters, level) {
  if (level === 'requests') {
    const { from, to, project, model } = filters;
    const rows = [];
    for (const s of data.sessions) {
      if (project && s.project !== project) continue;
      for (const r of s.requests) {
        if (model && normalizeModel(r.model) !== model) continue;
        const k = r.t ? dayKey(r.t) : null;
        if ((from || to) && (!k || (from && k < from) || (to && k > to))) continue;
        rows.push([
          r.t ? new Date(r.t).toISOString() : '', s.sessionId, s.project, normalizeModel(r.model),
          r.side ? 'subagent' : 'main', Math.round(r.in), Math.round(r.cw5), Math.round(r.cw1), Math.round(r.cr),
          Math.round(r.out), Math.round(r.think), r.web, r.fast ? 'fast' : 'standard', r.tools.join(' '),
          r.cb.input, r.cb.cacheWrite, r.cb.cacheRead, r.cb.output, r.cb.web, r.cost,
        ]);
      }
    }
    return csv(['timestamp', 'session_id', 'project', 'model', 'source', 'input_tokens', 'cache_write_5m_tokens',
      'cache_write_1h_tokens', 'cache_read_tokens', 'output_tokens', 'thinking_tokens', 'web_searches', 'speed', 'tools',
      'input_cost', 'cache_write_cost', 'cache_read_cost', 'output_cost', 'web_cost', 'total_cost_usd'], rows);
  }

  const report = buildReport(data, filters, { allPrompts: level === 'prompts' });
  if (level === 'prompts') {
    return csv(['date', 'project', 'session_id', 'model', 'requests', 'total_tokens', 'output_tokens', 'cost_usd', 'prompt'],
      report.topPrompts.map(p => [
        p.date, p.projectName, p.sessionId, p.model, p.requests, Math.round(p.tokens.total), Math.round(p.tokens.output), p.cost.total, p.prompt,
      ]));
  }
  return csv(['date', 'start', 'end', 'project', 'branch', 'session_id', 'model', 'prompts', 'requests',
    'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'total_tokens',
    'cost_usd', 'subagent_cost_usd', 'claude_code_reported_cost_usd', 'lines_added', 'lines_removed', 'first_prompt'],
  report.sessions.map(s => [
    s.date, s.start ? new Date(s.start).toISOString() : '', s.end ? new Date(s.end).toISOString() : '',
    s.projectName, s.gitBranch, s.sessionId, s.model, s.prompts, s.requests,
    Math.round(s.tokens.input), Math.round(s.tokens.cacheWrite), Math.round(s.tokens.cacheRead), Math.round(s.tokens.output),
    Math.round(s.tokens.total), s.cost.total, s.subagentCost, s.reportedCost, s.linesAdded, s.linesRemoved, s.firstPrompt,
  ]));
}

module.exports = { toCSV };
