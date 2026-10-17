const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { costOf } = require('./pricing');

function getClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Rough chars-per-token ratio, used only when a transcript line was written
// mid-stream and its output_tokens is still the message_start placeholder.
const CHARS_PER_TOKEN = 3.6;

// Per-file parse results, reused while a file's size and mtime are unchanged.
const fileCache = new Map();

function walkJsonl(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') out.push(p);
  }
  return out;
}

function promptText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  if (content.some(b => b.type === 'tool_result')) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function isNoisePrompt(text) {
  return !text
    || text.startsWith('<local-command')
    || text.startsWith('<command-name')
    || text.startsWith('<command-message')
    || text.startsWith('[Request interrupted')
    || text.startsWith('<system-reminder>')
    || text.startsWith('Caveat:');
}

function contentChars(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b.type === 'text') n += (b.text || '').length;
    else if (b.type === 'thinking') n += (b.thinking || '').length;
    else if (b.type === 'tool_use') n += JSON.stringify(b.input || {}).length;
  }
  return n;
}

async function parseFile(filePath) {
  const isSide = filePath.includes(`${path.sep}subagents${path.sep}`);
  const result = {
    sessionId: null, isSide, cwd: null, gitBranch: null, version: null, title: null,
    prompts: [], requests: new Map(), costStates: new Map(), order: [],
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let promptIdx = -1;

  for await (const line of rl) {
    if (!line) continue;
    // Skip large attachment / request-blob lines without paying for JSON.parse.
    const head = line.slice(0, 400);
    if (!head.includes('"type":"assistant"') && !head.includes('"type":"user"')
      && !head.includes('cost-state') && !head.includes('ai-title')
      && !line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }

    if (e.sessionId && !result.sessionId) result.sessionId = e.sessionId;
    if (e.cwd && !result.cwd) result.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== 'HEAD') result.gitBranch = e.gitBranch;
    if (e.version) result.version = e.version;

    if (e.type === 'ai-title' && e.aiTitle) { result.title = e.aiTitle; continue; }

    if (e.type === 'cost-state' && e.startTime) {
      const prev = result.costStates.get(e.startTime);
      if (!prev || (e.totalDuration || 0) >= (prev.totalDuration || 0)) result.costStates.set(e.startTime, e);
      continue;
    }

    if (e.type === 'user' && e.message?.role === 'user' && !isSide) {
      if (e.isMeta || e.isSidechain || e.isCompactSummary) continue;
      const text = promptText(e.message.content);
      if (isNoisePrompt(text)) continue;
      promptIdx = result.prompts.length;
      result.prompts.push({ text: text.substring(0, 2000), t: Date.parse(e.timestamp) || null });
      continue;
    }

    if (e.type === 'assistant' && e.message?.usage) {
      const m = e.message;
      if (!m.model || m.model === '<synthetic>') continue;
      const u = m.usage;
      const key = m.id || e.requestId || e.uuid;
      const cc = u.cache_creation || {};
      const cw1 = cc.ephemeral_1h_input_tokens || 0;
      const cw5 = cc.ephemeral_5m_input_tokens != null
        ? cc.ephemeral_5m_input_tokens
        : Math.max(0, (u.cache_creation_input_tokens || 0) - cw1);
      const tools = Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'tool_use' && b.name).map(b => b.name)
        : [];

      // Claude Code writes one line per content block, all sharing a message id;
      // merge them instead of counting each line as its own request.
      let r = result.requests.get(key);
      if (!r) {
        r = {
          t: Date.parse(e.timestamp) || null, model: m.model,
          in: 0, cw5: 0, cw1: 0, cr: 0, out: 0, think: 0, web: 0,
          fast: false, tools: [], chars: 0, final: false, p: isSide ? null : promptIdx, side: isSide,
        };
        result.requests.set(key, r);
        result.order.push(key);
      }
      r.in = Math.max(r.in, u.input_tokens || 0);
      r.cw5 = Math.max(r.cw5, cw5);
      r.cw1 = Math.max(r.cw1, cw1);
      r.cr = Math.max(r.cr, u.cache_read_input_tokens || 0);
      r.out = Math.max(r.out, u.output_tokens || 0);
      r.think = Math.max(r.think, u.output_tokens_details?.thinking_tokens || 0);
      r.web = Math.max(r.web, u.server_tool_use?.web_search_requests || 0);
      if (u.speed === 'fast') r.fast = true;
      if (m.stop_reason) r.final = true;
      r.chars += contentChars(m.content);
      for (const t of tools) r.tools.push(t);
    }
  }
  return result;
}

async function parseFileCached(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const cached = fileCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.result;
  let result;
  try { result = await parseFile(filePath); } catch { return null; }
  fileCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, result });
  return result;
}

function normalizeModel(m) {
  return (m || '').replace(/\[.*?\]$/, '');
}

// Claude Code records its own running cost per process ("cost-state"). Its token
// totals include requests the transcript misses or under-reports (streamed lines,
// title generation, classifiers), so top up our per-request numbers to match.
function calibrate(session, costStates) {
  const states = [...costStates.values()].sort((a, b) => a.startTime - b.startTime);
  if (!states.length) return;
  const BUCKETS = [['inputTokens', 'in'], ['outputTokens', 'out'], ['cacheReadInputTokens', 'cr'],
    ['cacheCreationInputTokens', 'cw'], ['thinkingTokens', 'think'], ['webSearchRequests', 'web']];

  states.forEach((st, i) => {
    const from = st.startTime;
    const to = i + 1 < states.length ? states[i + 1].startTime : Infinity;
    const inWindow = session.requests.filter(r => r.t != null && r.t >= from && r.t < to);
    const lastT = inWindow.length ? inWindow[inWindow.length - 1].t : from;

    // The same model can appear under several aliases (e.g. "claude-opus-5[1m]").
    const usageByModel = {};
    for (const [rawModel, mu] of Object.entries(st.modelUsage || {})) {
      const acc = usageByModel[normalizeModel(rawModel)] ||= {};
      for (const [src] of BUCKETS) acc[src] = (acc[src] || 0) + (mu[src] || 0);
    }

    for (const [model, mu] of Object.entries(usageByModel)) {
      let reqs = inWindow.filter(r => normalizeModel(r.model) === model);
      if (!reqs.length) {
        const bg = {
          t: lastT, model, in: 0, cw5: 0, cw1: 0, cr: 0, out: 0, think: 0, web: 0,
          fast: false, tools: [], chars: 0, final: true, p: null, side: true, background: true,
        };
        session.requests.push(bg);
        reqs = [bg];
      }
      for (const [src, dst] of BUCKETS) {
        const reported = mu[src] || 0;
        const get = r => dst === 'cw' ? r.cw5 + r.cw1 : r[dst];
        const have = reqs.reduce((s, r) => s + get(r), 0);
        const missing = reported - have;
        if (missing <= 0) continue;
        // Spread the shortfall by each request's share; output uses content size
        // as the weight because streamed lines carry placeholder counts.
        const weight = dst === 'out' || dst === 'think'
          ? r => Math.max(r.chars, 1)
          : r => Math.max(get(r), 1);
        const totalW = reqs.reduce((s, r) => s + weight(r), 0);
        for (const r of reqs) {
          const add = missing * weight(r) / totalW;
          if (dst === 'cw') {
            const total = r.cw5 + r.cw1;
            const share1h = total > 0 ? r.cw1 / total : (session.requests.some(x => x.cw1 > 0) ? 1 : 0);
            r.cw1 += add * share1h;
            r.cw5 += add * (1 - share1h);
          } else {
            r[dst] += add;
          }
        }
      }
      for (const r of reqs) r.calibrated = true;
    }
  });

  session.reported = {
    cost: states.reduce((s, st) => s + (st.totalCostUSD || 0), 0),
    linesAdded: states.reduce((s, st) => s + (st.totalLinesAdded || 0), 0),
    linesRemoved: states.reduce((s, st) => s + (st.totalLinesRemoved || 0), 0),
    apiDurationMs: states.reduce((s, st) => s + (st.totalAPIDuration || 0), 0),
    unknownModelCost: states.some(st => st.hasUnknownModelCost),
  };
}

function priceRequest(r) {
  const c = costOf(r.model, {
    input: r.in, cacheWrite5m: r.cw5, cacheWrite1h: r.cw1, cacheRead: r.cr,
    output: r.out, webSearch: r.web, speed: r.fast ? 'fast' : 'standard',
  });
  r.cost = c.total;
  r.cb = { input: c.input, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output, web: c.web };
  r.priced = c.known;
}

async function parseAllSessions() {
  const projectsDir = path.join(getClaudeDir(), 'projects');
  if (!fs.existsSync(projectsDir)) return { sessions: [], parsedAt: Date.now(), claudeDir: getClaudeDir() };

  const sessionMap = new Map();
  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  const seenFiles = new Set();

  for (const pd of projectDirs) {
    const files = walkJsonl(path.join(projectsDir, pd.name));
    for (const file of files) {
      seenFiles.add(file);
      const parsed = await parseFileCached(file);
      if (!parsed) continue;
      // Subagent files live in <session-id>/subagents/...; their own sessionId field
      // also points at the parent session.
      const rel = path.relative(path.join(projectsDir, pd.name), file).split(path.sep);
      const sessionId = parsed.sessionId || (rel.length > 1 ? rel[0] : path.basename(file, '.jsonl'));

      let s = sessionMap.get(sessionId);
      if (!s) {
        s = { sessionId, project: pd.name, parts: [] };
        sessionMap.set(sessionId, s);
      }
      s.parts.push(parsed);
    }
  }
  for (const f of fileCache.keys()) if (!seenFiles.has(f)) fileCache.delete(f);

  const sessions = [];
  for (const s of sessionMap.values()) {
    const main = s.parts.find(p => !p.isSide) || s.parts[0];
    const prompts = s.parts.filter(p => !p.isSide).flatMap(p => p.prompts);
    const requests = [];
    const seen = new Set();
    const costStates = new Map();
    let subagentFiles = 0;
    let promptOffset = 0;

    for (const part of s.parts) {
      if (part.isSide) subagentFiles++;
      for (const key of part.order) {
        if (seen.has(key)) continue;
        seen.add(key);
        const r = { ...part.requests.get(key) };
        if (!part.isSide && r.p != null && r.p >= 0) r.p += promptOffset;
        else if (!part.isSide && r.p === -1) r.p = null;
        // Streamed lines without a stop_reason carry the message_start placeholder
        // for output_tokens; estimate from the content we can see.
        if (!r.final) r.out = Math.max(r.out, Math.round(r.chars / CHARS_PER_TOKEN));
        requests.push(r);
      }
      if (!part.isSide) promptOffset += part.prompts.length;
      for (const [k, v] of part.costStates) costStates.set(k, v);
    }
    if (!requests.length) continue;
    requests.sort((a, b) => (a.t || 0) - (b.t || 0));

    // Subagent requests belong to whichever prompt was active when they ran.
    const promptTimes = prompts.map(p => p.t || 0);
    for (const r of requests) {
      if (r.p != null || r.t == null) continue;
      let lo = 0, hi = promptTimes.length - 1, idx = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (promptTimes[mid] <= r.t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      r.p = idx;
    }

    const session = {
      sessionId: s.sessionId,
      project: s.project,
      cwd: main.cwd,
      gitBranch: s.parts.map(p => p.gitBranch).filter(Boolean).pop() || null,
      version: main.version,
      title: s.parts.map(p => p.title).filter(Boolean).pop() || null,
      prompts,
      requests,
      subagentFiles,
      reported: null,
    };
    calibrate(session, costStates);
    session.requests.sort((a, b) => (a.t || 0) - (b.t || 0));
    for (const r of session.requests) priceRequest(r);
    session.start = session.requests.find(r => r.t)?.t || null;
    session.end = [...session.requests].reverse().find(r => r.t)?.t || null;
    sessions.push(session);
  }

  return { sessions, parsedAt: Date.now(), claudeDir: getClaudeDir() };
}

module.exports = { parseAllSessions, normalizeModel };
