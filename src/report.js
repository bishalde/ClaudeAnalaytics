const { costOf, uncachedCostOf, getPricing, pricingTable } = require('./pricing');
const { normalizeModel } = require('./parser');

const BLOCK_MS = 5 * 60 * 60 * 1000;
const WHAT_IF_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

function projectName(project, cwd) {
  if (cwd) return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  return project.replace(/^-/, '').split('-').pop() || project;
}

function emptyTokens() {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, total: 0 };
}
function emptyCost() {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, web: 0, total: 0 };
}
function addRequest(acc, r) {
  acc.tokens.input += r.in;
  acc.tokens.cacheWrite += r.cw5 + r.cw1;
  acc.tokens.cacheRead += r.cr;
  acc.tokens.output += r.out;
  acc.tokens.thinking += r.think;
  acc.tokens.total += r.in + r.cw5 + r.cw1 + r.cr + r.out;
  for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 'web']) acc.cost[k] += r.cb[k];
  acc.cost.total += r.cost;
  acc.requests += 1;
}
function newAcc(extra) {
  return { tokens: emptyTokens(), cost: emptyCost(), requests: 0, ...extra };
}
function tokensOf(r) {
  return { input: r.in, cacheWrite5m: r.cw5, cacheWrite1h: r.cw1, cacheRead: r.cr, output: r.out, webSearch: r.web, speed: r.fast ? 'fast' : 'standard' };
}
function topKey(map) {
  let best = null, bestV = -1;
  for (const [k, v] of Object.entries(map)) if (v > bestV) { best = k; bestV = v; }
  return best;
}

function filterOptions(sessions) {
  const projects = {};
  const models = {};
  let min = null, max = null;
  for (const s of sessions) {
    const p = projects[s.project] ||= { id: s.project, name: projectName(s.project, s.cwd), cost: 0 };
    for (const r of s.requests) {
      p.cost += r.cost;
      const m = normalizeModel(r.model);
      models[m] = (models[m] || 0) + r.cost;
      if (r.t) {
        if (min == null || r.t < min) min = r.t;
        if (max == null || r.t > max) max = r.t;
      }
    }
  }
  return {
    projects: Object.values(projects).sort((a, b) => b.cost - a.cost),
    models: Object.entries(models).sort((a, b) => b[1] - a[1]).map(([id]) => id),
    minDate: min ? dayKey(min) : null,
    maxDate: max ? dayKey(max) : null,
  };
}

function buildBlocks(requests, now) {
  const sorted = requests.filter(r => r.t).sort((a, b) => a.t - b.t);
  const blocks = [];
  let cur = null;
  for (const r of sorted) {
    if (!cur || r.t >= cur.end || r.t - cur.last >= BLOCK_MS) {
      const start = new Date(r.t); start.setMinutes(0, 0, 0);
      cur = newAcc({ start: start.getTime(), end: start.getTime() + BLOCK_MS, first: r.t, last: r.t, models: {} });
      blocks.push(cur);
    }
    addRequest(cur, r);
    cur.last = r.t;
    const m = normalizeModel(r.model);
    cur.models[m] = (cur.models[m] || 0) + r.cost;
  }
  return blocks.map(b => {
    const active = now < b.end && now - b.last < BLOCK_MS;
    const elapsedH = Math.max((Math.min(now, b.end) - b.first) / 3.6e6, 1 / 60);
    const burnRate = active ? b.cost.total / elapsedH : null;
    return {
      start: b.start, end: b.end, first: b.first, last: b.last, active,
      cost: b.cost.total, tokens: b.tokens.total, outputTokens: b.tokens.output, requests: b.requests,
      models: Object.entries(b.models).sort((x, y) => y[1] - x[1]).map(([m]) => m),
      burnRate,
      projected: active ? b.cost.total + burnRate * Math.max(0, (b.end - now) / 3.6e6) : null,
      remainingMs: active ? b.end - now : 0,
    };
  });
}

function monthSummary(requests, now) {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const prevStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const elapsedDays = (now - monthStart) / 864e5;
  let mtd = 0, prev = 0, today = 0, prevSamePoint = 0;
  const todayKey = dayKey(now);
  const prevCutoff = prevStart + (now - monthStart);
  for (const r of requests) {
    if (!r.t) continue;
    if (r.t >= monthStart) mtd += r.cost;
    else if (r.t >= prevStart) {
      prev += r.cost;
      if (r.t < prevCutoff) prevSamePoint += r.cost;
    }
    if (dayKey(r.t) === todayKey) today += r.cost;
  }
  return {
    label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    mtd, prev, prevSamePoint, today,
    projected: elapsedDays > 0 ? mtd / elapsedDays * daysInMonth : mtd,
    daysInMonth, dayOfMonth: d.getDate(),
  };
}

function buildReport(data, filters = {}, opts = {}) {
  const now = Date.now();
  const { from, to, project, model } = filters;
  const options = filterOptions(data.sessions);

  const inScope = (s, r) => (!project || s.project === project) && (!model || normalizeModel(r.model) === model);
  const inRange = r => {
    if (!from && !to) return true;
    if (!r.t) return false;
    const k = dayKey(r.t);
    return (!from || k >= from) && (!to || k <= to);
  };

  const totals = newAcc({ sessions: 0, prompts: 0, uncachedCost: 0, subagentCost: 0, reportedCost: 0, estimatedForReported: 0,
    calibratedSessions: 0, linesAdded: 0, linesRemoved: 0, fastRequests: 0, webSearches: 0, longContextRequests: 0, unpricedModels: new Set() });
  const daily = {};
  const models = {};
  const projects = {};
  const tools = {};
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const prompts = [];
  const sessions = [];
  const whatIf = Object.fromEntries(WHAT_IF_MODELS.map(m => [m, 0]));
  const scopedAll = [];

  for (const s of data.sessions) {
    const sAcc = newAcc({ models: {}, subagentCost: 0, prompts: new Set(), first: null, last: null });
    const promptAcc = new Map();
    const pName = projectName(s.project, s.cwd);

    for (const r of s.requests) {
      if (!inScope(s, r)) continue;
      scopedAll.push(r);
      if (!inRange(r)) continue;

      addRequest(totals, r);
      addRequest(sAcc, r);
      totals.uncachedCost += uncachedCostOf(r.model, tokensOf(r));
      if (r.side) { totals.subagentCost += r.cost; sAcc.subagentCost += r.cost; }
      if (r.fast) totals.fastRequests++;
      totals.webSearches += r.web;
      if (!r.priced) totals.unpricedModels.add(r.model);
      const p = getPricing(r.model);
      if (p?.longContext && r.in + r.cw5 + r.cw1 + r.cr > p.longContext.threshold) totals.longContextRequests++;
      for (const m of WHAT_IF_MODELS) whatIf[m] += costOf(m, tokensOf(r)).total;

      const m = normalizeModel(r.model);
      sAcc.models[m] = (sAcc.models[m] || 0) + r.cost;
      const mAcc = models[m] ||= newAcc({ model: m, sessions: new Set() });
      addRequest(mAcc, r);
      mAcc.sessions.add(s.sessionId);

      if (r.t) {
        const k = dayKey(r.t);
        const dAcc = daily[k] ||= newAcc({ date: k, byModel: {}, sessions: new Set() });
        addRequest(dAcc, r);
        dAcc.byModel[m] = (dAcc.byModel[m] || 0) + r.cost;
        dAcc.sessions.add(s.sessionId);
        const d = new Date(r.t);
        heatmap[d.getDay()][d.getHours()] += r.cost;
        if (sAcc.first == null || r.t < sAcc.first) sAcc.first = r.t;
        if (sAcc.last == null || r.t > sAcc.last) sAcc.last = r.t;
      }

      if (r.tools.length) {
        const share = r.cost / r.tools.length;
        for (const t of r.tools) {
          const tAcc = tools[t] ||= { name: t, calls: 0, cost: 0, sessions: new Set() };
          tAcc.calls++;
          tAcc.cost += share;
          tAcc.sessions.add(s.sessionId);
        }
      }

      if (r.p != null) {
        sAcc.prompts.add(r.p);
        let pa = promptAcc.get(r.p);
        if (!pa) {
          pa = newAcc({ idx: r.p, models: {}, tools: {}, subagentCost: 0, t: s.prompts[r.p]?.t || r.t });
          promptAcc.set(r.p, pa);
        }
        addRequest(pa, r);
        pa.models[m] = (pa.models[m] || 0) + r.cost;
        if (r.side) pa.subagentCost += r.cost;
        for (const t of r.tools) pa.tools[t] = (pa.tools[t] || 0) + 1;
      }
    }

    if (!sAcc.requests) continue;
    totals.sessions++;
    totals.prompts += sAcc.prompts.size;
    const fullRange = !from && !to && !model;
    if (s.reported && fullRange) {
      totals.calibratedSessions++;
      totals.reportedCost += s.reported.cost;
      totals.estimatedForReported += sAcc.cost.total;
    }
    if (s.reported) {
      totals.linesAdded += s.reported.linesAdded;
      totals.linesRemoved += s.reported.linesRemoved;
    }

    const firstPrompt = s.prompts.find(p => p.text)?.text || null;
    const primaryModel = topKey(sAcc.models);
    sessions.push({
      sessionId: s.sessionId,
      project: s.project,
      projectName: pName,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      title: s.title,
      firstPrompt: (firstPrompt || s.title || '(no prompt)').substring(0, 300),
      start: sAcc.first,
      end: sAcc.last,
      date: sAcc.first ? dayKey(sAcc.first) : null,
      model: primaryModel,
      models: Object.keys(sAcc.models),
      requests: sAcc.requests,
      prompts: sAcc.prompts.size,
      tokens: sAcc.tokens,
      cost: sAcc.cost,
      subagentCost: sAcc.subagentCost,
      reportedCost: s.reported?.cost ?? null,
      linesAdded: s.reported?.linesAdded ?? null,
      linesRemoved: s.reported?.linesRemoved ?? null,
    });

    const proj = projects[s.project] ||= newAcc({ project: s.project, name: pName, cwd: s.cwd, sessions: 0, models: {}, prompts: [], last: null });
    proj.sessions++;
    for (const k of Object.keys(proj.tokens)) proj.tokens[k] += sAcc.tokens[k];
    for (const k of Object.keys(proj.cost)) proj.cost[k] += sAcc.cost[k];
    proj.requests += sAcc.requests;
    for (const [mm, c] of Object.entries(sAcc.models)) proj.models[mm] = (proj.models[mm] || 0) + c;
    if (sAcc.last && (!proj.last || sAcc.last > proj.last)) proj.last = sAcc.last;

    for (const pa of promptAcc.values()) {
      const text = s.prompts[pa.idx]?.text;
      if (!text) continue;
      const entry = {
        prompt: text.substring(0, 400),
        sessionId: s.sessionId,
        project: s.project,
        projectName: pName,
        t: pa.t,
        date: pa.t ? dayKey(pa.t) : null,
        model: topKey(pa.models),
        requests: pa.requests,
        tokens: pa.tokens,
        cost: pa.cost,
        subagentCost: pa.subagentCost,
        tools: pa.tools,
      };
      prompts.push(entry);
      proj.prompts.push(entry);
    }
  }

  // Daily series with zero-filled gaps so charts show idle days.
  const dayKeys = Object.keys(daily).sort();
  const dailyUsage = [];
  if (dayKeys.length) {
    const lastDay = dayKeys[dayKeys.length - 1];
    const start = from || dayKeys[0];
    let end = to || (from ? dayKey(now) : lastDay);
    if (end < lastDay) end = lastDay;
    for (let k = start, guard = 0; k <= end && guard < 3700; k = addDays(k, 1), guard++) {
      const d = daily[k];
      dailyUsage.push(d
        ? { date: k, cost: d.cost, tokens: d.tokens, requests: d.requests, sessions: d.sessions.size, byModel: d.byModel }
        : { date: k, cost: emptyCost(), tokens: emptyTokens(), requests: 0, sessions: 0, byModel: {} });
    }
  }

  prompts.sort((a, b) => b.cost.total - a.cost.total);
  sessions.sort((a, b) => b.cost.total - a.cost.total);

  const promptCount = totals.prompts;
  const activeDays = dailyUsage.filter(d => d.requests > 0).length;
  const promptTokens = totals.tokens.input + totals.tokens.cacheWrite + totals.tokens.cacheRead;

  const t = {
    cost: totals.cost,
    tokens: totals.tokens,
    requests: totals.requests,
    sessions: totals.sessions,
    prompts: promptCount,
    activeDays,
    avgCostPerSession: totals.sessions ? totals.cost.total / totals.sessions : 0,
    avgCostPerPrompt: promptCount ? totals.cost.total / promptCount : 0,
    avgCostPerActiveDay: activeDays ? totals.cost.total / activeDays : 0,
    cacheHitRate: promptTokens ? totals.tokens.cacheRead / promptTokens : 0,
    cacheSavings: Math.max(0, totals.uncachedCost - totals.cost.total),
    uncachedCost: totals.uncachedCost,
    subagentCost: totals.subagentCost,
    fastRequests: totals.fastRequests,
    webSearches: totals.webSearches,
    longContextRequests: totals.longContextRequests,
    linesAdded: totals.linesAdded,
    linesRemoved: totals.linesRemoved,
    unpricedModels: [...totals.unpricedModels],
    calibration: {
      sessions: totals.calibratedSessions,
      reportedCost: totals.reportedCost,
      estimatedCost: totals.estimatedForReported,
    },
    dateRange: dailyUsage.length ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date } : null,
  };

  const modelBreakdown = Object.values(models).map(m => ({
    model: m.model, tokens: m.tokens, cost: m.cost, requests: m.requests, sessions: m.sessions.size,
  })).sort((a, b) => b.cost.total - a.cost.total);

  const projectBreakdown = Object.values(projects).map(p => ({
    project: p.project, name: p.name, cwd: p.cwd, tokens: p.tokens, cost: p.cost, requests: p.requests,
    sessions: p.sessions, last: p.last,
    models: Object.entries(p.models).sort((a, b) => b[1] - a[1]).map(([model, cost]) => ({ model, cost })),
    topPrompts: p.prompts.sort((a, b) => b.cost.total - a.cost.total).slice(0, 10),
  })).sort((a, b) => b.cost.total - a.cost.total);

  const toolBreakdown = Object.values(tools).map(x => ({ name: x.name, calls: x.calls, cost: x.cost, sessions: x.sessions.size }))
    .sort((a, b) => b.calls - a.calls);

  const blocks = buildBlocks(scopedAll, now);

  const report = {
    generatedAt: now,
    parsedAt: data.parsedAt,
    filters: { from: from || null, to: to || null, project: project || null, model: model || null },
    options,
    totals: t,
    dailyUsage,
    modelBreakdown,
    projectBreakdown,
    toolBreakdown,
    heatmap,
    topPrompts: opts.allPrompts ? prompts : prompts.slice(0, 25),
    sessions,
    blocks: blocks.slice(-48).reverse(),
    month: monthSummary(scopedAll, now),
    whatIf: WHAT_IF_MODELS.map(m => ({ model: m, cost: whatIf[m] })),
    pricing: pricingTable(),
  };
  report.insights = generateInsights(report, prompts);
  return report;
}

function sessionDetail(data, sessionId) {
  const s = data.sessions.find(x => x.sessionId === sessionId);
  if (!s) return null;
  const turns = new Map();
  const timeline = [];
  let subagentCost = 0;
  for (const r of s.requests) {
    timeline.push({
      t: r.t, model: normalizeModel(r.model), cost: r.cost, side: r.side, background: !!r.background,
      context: r.in + r.cw5 + r.cw1 + r.cr, output: r.out,
    });
    if (r.side) subagentCost += r.cost;
    const key = r.p == null ? 'none' : r.p;
    let turn = turns.get(key);
    if (!turn) {
      turn = newAcc({ idx: r.p, tools: {}, models: {}, subagentCost: 0, first: r.t, last: r.t });
      turns.set(key, turn);
    }
    addRequest(turn, r);
    if (r.t) turn.last = r.t;
    const m = normalizeModel(r.model);
    turn.models[m] = (turn.models[m] || 0) + r.cost;
    if (r.side) turn.subagentCost += r.cost;
    for (const t of r.tools) turn.tools[t] = (turn.tools[t] || 0) + 1;
  }
  const total = s.requests.reduce((a, r) => a + r.cost, 0);
  return {
    sessionId: s.sessionId,
    project: s.project,
    projectName: projectName(s.project, s.cwd),
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    version: s.version,
    title: s.title,
    start: s.start,
    end: s.end,
    cost: total,
    subagentCost,
    subagentFiles: s.subagentFiles,
    reported: s.reported,
    resumeCommand: `claude --resume ${s.sessionId}`,
    turns: [...turns.values()].sort((a, b) => (a.first || 0) - (b.first || 0)).map(turn => ({
      prompt: turn.idx == null ? null : s.prompts[turn.idx]?.text || null,
      t: turn.first,
      durationMs: turn.first && turn.last ? turn.last - turn.first : 0,
      requests: turn.requests,
      tokens: turn.tokens,
      cost: turn.cost,
      subagentCost: turn.subagentCost,
      model: topKey(turn.models),
      tools: turn.tools,
    })),
    timeline,
  };
}

function money(n) {
  if (n >= 100) return '$' + Math.round(n).toLocaleString();
  return '$' + n.toFixed(2);
}

function generateInsights(report, prompts) {
  const insights = [];
  const t = report.totals;
  const total = t.cost.total;
  if (total <= 0) return insights;
  const pct = x => Math.round(x / total * 100);

  // Cache efficiency
  if (t.cacheSavings > 0) {
    insights.push({
      id: 'cache-savings', type: 'good',
      title: `Prompt caching saved you about ${money(t.cacheSavings)} (${Math.round(t.cacheSavings / t.uncachedCost * 100)}%)`,
      description: `${Math.round(t.cacheHitRate * 100)}% of the prompt tokens Claude read came from cache, billed at a fraction of the normal input price. Without caching this period would have cost ${money(t.uncachedCost)}.`,
      action: 'Long gaps between messages (over an hour) let the cache expire, so the next message pays to re-write it.',
    });
  }
  const writePct = pct(t.cost.cacheWrite);
  if (writePct >= 35) {
    insights.push({
      id: 'cache-writes', type: 'warning',
      title: `${writePct}% of your spend is writing context into the cache`,
      description: `Cache writes cost 1.25x-2x the input price. They spike when a conversation resumes after the cache expired, when CLAUDE.md or tool lists change mid-session, or after compaction.`,
      action: 'Finish a task in one sitting, and start a fresh session instead of resuming an old one hours later.',
    });
  }

  // Vague, expensive prompts
  const vague = prompts.filter(p => p.prompt.trim().length < 25 && p.cost.total >= Math.max(1, total * 0.005));
  if (vague.length >= 2) {
    const sum = vague.reduce((s, p) => s + p.cost.total, 0);
    const examples = [...new Set(vague.map(p => p.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts', type: 'warning',
      title: `Short messages like ${examples.slice(0, 2).map(e => '"' + e + '"').join(' and ')} cost ${money(sum)}`,
      description: `${vague.length} short replies (${examples.map(e => '"' + e + '"').join(', ')}) each kicked off long, expensive runs. Short go-aheads let Claude decide the scope on its own.`,
      action: 'Say what "yes" means: "Yes, update the login page only and run its tests."',
    });
  }

  // Concentration in a few sessions
  if (report.sessions.length >= 5) {
    const top3 = report.sessions.slice(0, 3).reduce((s, x) => s + x.cost.total, 0);
    if (pct(top3) >= 40) {
      insights.push({
        id: 'top-sessions', type: 'info',
        title: `Your 3 most expensive sessions are ${pct(top3)}% of all spend`,
        description: `They cost ${money(top3)} together. The biggest: "${report.sessions[0].firstPrompt.substring(0, 80)}" at ${money(report.sessions[0].cost.total)}.`,
        action: 'Open one in the Sessions table to see which turns drove the cost.',
      });
    }
  }

  // Subagents
  if (pct(t.subagentCost) >= 20) {
    insights.push({
      id: 'subagents', type: 'info',
      title: `Subagents and workflows account for ${pct(t.subagentCost)}% of spend`,
      description: `Background agents cost ${money(t.subagentCost)}. Each one starts its own context and reads files independently.`,
      action: 'Ask for fewer parallel agents, or run subagents on a cheaper model, for broad searches.',
    });
  }

  // Model mix
  const opus = report.modelBreakdown.filter(m => /opus|fable|mythos/.test(m.model)).reduce((s, m) => s + m.cost.total, 0);
  const sonnetWhatIf = report.whatIf.find(w => w.model === 'claude-sonnet-5-5')?.cost;
  if (pct(opus) >= 70 && sonnetWhatIf && sonnetWhatIf < total * 0.8) {
    insights.push({
      id: 'model-mix', type: 'info',
      title: `${pct(opus)}% of spend is on top-tier models`,
      description: `The same tokens on Sonnet 5.5 would cost about ${money(sonnetWhatIf)} instead of ${money(total)}. Real results differ, since a cheaper model may take more turns.`,
      action: 'Use /model to switch to Sonnet for routine edits, reviews and searches.',
    });
  }

  // Context growth inside long sessions
  const longSessions = report.sessions.filter(s => s.requests >= 60);
  if (longSessions.length) {
    insights.push({
      id: 'long-sessions', type: 'info',
      title: `${longSessions.length} session${longSessions.length > 1 ? 's' : ''} ran over 60 requests`,
      description: `Every request re-reads the whole conversation. Long sessions are ${pct(longSessions.reduce((s, x) => s + x.cost.total, 0))}% of spend.`,
      action: 'Use /clear or start a new session when you switch tasks; /compact when you must keep going.',
    });
  }

  // Thinking share
  if (t.tokens.output > 0 && t.tokens.thinking / t.tokens.output > 0.3) {
    insights.push({
      id: 'thinking', type: 'neutral',
      title: `${Math.round(t.tokens.thinking / t.tokens.output * 100)}% of output tokens were thinking`,
      description: `Thinking tokens bill as output. Output is ${pct(t.cost.output)}% of your spend overall.`,
      action: 'Lower the effort level for simple tasks.',
    });
  }

  // Peak time
  let best = { d: 0, h: 0, v: 0 };
  report.heatmap.forEach((row, d) => row.forEach((v, h) => { if (v > best.v) best = { d, h, v }; }));
  if (best.v > 0) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const h12 = h => (h % 12 || 12) + (h < 12 ? 'am' : 'pm');
    insights.push({
      id: 'peak', type: 'neutral',
      title: `Your most expensive hour is ${days[best.d]} ${h12(best.h)}-${h12((best.h + 1) % 24)}`,
      description: `That hour accounts for ${money(best.v)} across the selected period. The heatmap shows the full week.`,
      action: null,
    });
  }

  if (t.unpricedModels.length) {
    insights.push({
      id: 'unpriced', type: 'warning',
      title: `No price on file for ${t.unpricedModels.join(', ')}`,
      description: 'Requests from these models are counted at $0, so totals are a lower bound.',
      action: 'Update src/pricing.js with the model\'s rates.',
    });
  }

  return insights;
}

module.exports = { buildReport, sessionDetail, dayKey };
