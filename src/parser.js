const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

function extractSessionData(entries) {
  const queries = [];
  let pendingUserMessage = null;

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.role === 'user') {
      const content = entry.message.content;
      if (entry.isMeta) continue;
      if (typeof content === 'string' && (
        content.startsWith('<local-command') ||
        content.startsWith('<command-name')
      )) continue;

      const textContent = typeof content === 'string'
        ? content
        : content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      pendingUserMessage = {
        text: textContent || null,
        timestamp: entry.timestamp,
      };
    }

    if (entry.type === 'assistant' && entry.message?.usage) {
      const usage = entry.message.usage;
      const model = entry.message.model || 'unknown';
      if (model === '<synthetic>') continue;

      const inputTokens = (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      const outputTokens = usage.output_tokens || 0;

      const tools = [];
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name) tools.push(block.name);
        }
      }

      queries.push({
        userPrompt: pendingUserMessage?.text || null,
        userTimestamp: pendingUserMessage?.timestamp || null,
        assistantTimestamp: entry.timestamp,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        tools,
      });
    }
  }

  return queries;
}

async function parseAllSessions() {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return { sessions: [], dailyUsage: [], modelBreakdown: [], topPrompts: [], totals: {} };
  }

  const historyPath = path.join(claudeDir, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];

  const sessionFirstPrompt = {};
  for (const entry of historyEntries) {
    if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
      const display = entry.display.trim();
      if (display.startsWith('/') && display.length < 30) continue;
      sessionFirstPrompt[entry.sessionId] = display;
    }
  }

  const projectDirs = fs.readdirSync(projectsDir).filter(d => {
    return fs.statSync(path.join(projectsDir, d)).isDirectory();
  });

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, '.jsonl');

      let entries;
      try {
        entries = await parseJSONLFile(filePath);
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      const queries = extractSessionData(entries);
      if (queries.length === 0) continue;

      let inputTokens = 0, outputTokens = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
      }
      const totalTokens = inputTokens + outputTokens;

      const firstTimestamp = entries.find(e => e.timestamp)?.timestamp;
      const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

      const modelCounts = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

      const firstPrompt = sessionFirstPrompt[sessionId]
        || queries.find(q => q.userPrompt)?.userPrompt
        || '(no prompt)';

      let currentPrompt = null;
      let promptInput = 0, promptOutput = 0;
      const flushPrompt = () => {
        if (currentPrompt && (promptInput + promptOutput) > 0) {
          allPrompts.push({
            prompt: currentPrompt.substring(0, 300),
            inputTokens: promptInput,
            outputTokens: promptOutput,
            totalTokens: promptInput + promptOutput,
            date,
            sessionId,
            model: primaryModel,
          });
        }
      };
      for (const q of queries) {
        if (q.userPrompt && q.userPrompt !== currentPrompt) {
          flushPrompt();
          currentPrompt = q.userPrompt;
          promptInput = 0;
          promptOutput = 0;
        }
        promptInput += q.inputTokens;
        promptOutput += q.outputTokens;
      }
      flushPrompt();

      sessions.push({
        sessionId,
        project: projectDir,
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        queries,
        inputTokens,
        outputTokens,
        totalTokens,
      });

      if (date !== 'unknown') {
        if (!dailyMap[date]) {
          dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0, queries: 0 };
        }
        dailyMap[date].inputTokens += inputTokens;
        dailyMap[date].outputTokens += outputTokens;
        dailyMap[date].totalTokens += totalTokens;
        dailyMap[date].sessions += 1;
        dailyMap[date].queries += queries.length;
      }

      for (const q of queries) {
        if (q.model === '<synthetic>' || q.model === 'unknown') continue;
        if (!modelMap[q.model]) {
          modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0 };
        }
        modelMap[q.model].inputTokens += q.inputTokens;
        modelMap[q.model].outputTokens += q.outputTokens;
        modelMap[q.model].totalTokens += q.totalTokens;
        modelMap[q.model].queryCount += 1;
      }
    }
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project;
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj,
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        sessionCount: 0, queryCount: 0,
        modelMap: {},
        allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.queryCount += 1;
    }

    let curPrompt = null, curInput = 0, curOutput = 0, curConts = 0;
    let curModels = {}, curTools = {};
    const flushProjectPrompt = () => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput,
          continuations: curConts,
          model: topModel,
          toolCounts: { ...curTools },
          date: session.date,
          sessionId: session.sessionId,
        });
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flushProjectPrompt();
        curPrompt = q.userPrompt;
        curInput = 0; curOutput = 0; curConts = 0;
        curModels = {}; curTools = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput += q.inputTokens;
      curOutput += q.outputTokens;
      if (q.model && q.model !== '<synthetic>') curModels[q.model] = (curModels[q.model] || 0) + 1;
      for (const t of q.tools || []) curTools[t] = (curTools[t] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => ({
    project: p.project,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    totalTokens: p.totalTokens,
    sessionCount: p.sessionCount,
    queryCount: p.queryCount,
    modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  const grandTotals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, s) => sum + s.queryCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  if (grandTotals.totalQueries > 0) {
    grandTotals.avgTokensPerQuery = Math.round(grandTotals.totalTokens / grandTotals.totalQueries);
  }
  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
  }

  const insights = generateInsights(sessions, allPrompts, grandTotals);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights,
  };
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const examples = [...new Set(shortExpensive.map(p => p.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts',
      type: 'warning',
      title: 'Short, vague messages are costing you the most',
      description: `${shortExpensive.length} times you sent a short message like ${examples.map(e => '"' + e + '"').join(', ')} -- and each time, Claude used over 100K tokens to respond. That adds up to ${fmt(totalWasted)} tokens total.`,
      action: 'Try being specific. Instead of "Yes", say "Yes, update the login page and run the tests."',
    });
  }

  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: 'The longer you chat, the more each message costs',
        description: `In ${growthData.length} conversations, messages near the end cost ${avgGrowth}x more than at the start. Every message re-reads the entire history.`,
        action: 'Start a fresh conversation when you move to a new task.',
      });
    }
  }

  const turnCounts = sessions.map(s => s.queryCount);
  const medianTurns = turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0;
  const longCount = sessions.filter(s => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      title: `Just ${longCount} long conversations used ${longPct}% of all your tokens`,
      description: `You have ${longCount} conversations with over 200 messages each, consuming ${fmt(longTokens)} tokens. Your typical conversation is about ${medianTurns} messages.`,
      action: 'Try keeping one conversation per task.',
    });
  }

  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        title: `${outputPct.toFixed(1)}% of your tokens are Claude actually writing`,
        description: `Out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from Claude writing. The rest is re-reading context.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers.',
      });
    }
  }

  if (sessions.length >= 10) {
    const dayOfWeekMap = {};
    for (const s of sessions) {
      if (!s.timestamp) continue;
      const d = new Date(s.timestamp);
      const day = d.getDay();
      if (!dayOfWeekMap[day]) dayOfWeekMap[day] = { tokens: 0, sessions: 0 };
      dayOfWeekMap[day].tokens += s.totalTokens;
      dayOfWeekMap[day].sessions += 1;
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = Object.entries(dayOfWeekMap).map(([d, v]) => ({ day: dayNames[d], ...v, avg: v.tokens / v.sessions }));
    if (days.length >= 3) {
      days.sort((a, b) => b.avg - a.avg);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: 'day-pattern',
        type: 'neutral',
        title: `You use Claude the most on ${busiest.day}s`,
        description: `${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens each, compared to ${fmt(Math.round(quietest.avg))} on ${quietest.day}s.`,
        action: null,
      });
    }
  }

  const opusSessions = sessions.filter(s => s.model.includes('opus'));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 10 && s.totalTokens < 200_000);
    if (simpleOpus.length >= 3) {
      const wastedTokens = simpleOpus.reduce((s, ses) => s + ses.totalTokens, 0);
      insights.push({
        id: 'model-mismatch',
        type: 'warning',
        title: `${simpleOpus.length} simple conversations used Opus unnecessarily`,
        description: `These conversations had fewer than 10 messages and used ${fmt(wastedTokens)} tokens on Opus. Sonnet or Haiku would give similar results for less.`,
        action: 'Use /model to switch to Sonnet or Haiku for simple tasks.',
      });
    }
  }

  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter(s => {
      const userMessages = s.queries.filter(q => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });
    if (toolHeavy.length >= 3) {
      const totalToolTokens = toolHeavy.reduce((s, ses) => s + ses.totalTokens, 0);
      const avgRatio = toolHeavy.reduce((s, ses) => {
        const userMsgs = ses.queries.filter(q => q.userPrompt).length;
        return s + (ses.queryCount - userMsgs) / Math.max(userMsgs, 1);
      }, 0) / toolHeavy.length;
      insights.push({
        id: 'tool-heavy',
        type: 'info',
        title: `${toolHeavy.length} conversations had ${Math.round(avgRatio)}x more tool calls than messages`,
        description: `Each tool call re-reads the entire conversation. These ${toolHeavy.length} conversations used ${fmt(totalToolTokens)} tokens total.`,
        action: 'Point Claude to specific files and line numbers when you can.',
      });
    }
  }

  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      projectTokens[proj] = (projectTokens[proj] || 0) + s.totalTokens;
    }
    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = ((topTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
      if (pct >= 60) {
        const projName = topProject.replace(/^C--Users-[^-]+-?/, '').replace(/^Projects-?/, '').replace(/-/g, '/') || '~';
        insights.push({
          id: 'project-dominance',
          type: 'info',
          title: `${pct}% of your tokens went to one project: ${projName}`,
          description: `Your "${projName}" project used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total.`,
          action: 'Breaking long conversations into smaller sessions could reduce its footprint.',
        });
      }
    }
  }

  if (sessions.length >= 10) {
    const shortSessions = sessions.filter(s => s.queryCount >= 3 && s.queryCount <= 15);
    const longSessions2 = sessions.filter(s => s.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvg = Math.round(shortSessions.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / shortSessions.length);
      const longAvg = Math.round(longSessions2.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / longSessions2.length);
      const ratio = (longAvg / Math.max(shortAvg, 1)).toFixed(1);
      if (ratio >= 2) {
        insights.push({
          id: 'conversation-efficiency',
          type: 'warning',
          title: `Each message costs ${ratio}x more in long conversations`,
          description: `Short conversations (~${fmt(shortAvg)} tokens/msg) vs long ones (~${fmt(longAvg)} tokens/msg). That's ${ratio}x more per message.`,
          action: 'Start fresh conversations more often.',
        });
      }
    }
  }

  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter(s => {
      const firstQuery = s.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });
    if (heavyStarts.length >= 5) {
      const avgStartTokens = Math.round(heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0) / heavyStarts.length);
      insights.push({
        id: 'heavy-context',
        type: 'info',
        title: `${heavyStarts.length} conversations started with ${fmt(avgStartTokens)}+ tokens of context`,
        description: `Before you even type, Claude reads CLAUDE.md, project files, and system context. This gets re-read every message.`,
        action: 'Keep your CLAUDE.md files concise.',
      });
    }
  }

  return insights;
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

module.exports = { parseAllSessions };
