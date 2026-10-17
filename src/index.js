#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-code-usage-analytics - See where your Claude Code tokens and dollars go

Usage:
  claude-code-usage-analytics [options]

Options:
  --port <port>     Port to run dashboard on (default: 3456)
  --host <host>     Interface to bind (default: 127.0.0.1, local only)
  --no-open         Don't auto-open browser
  --summary         Print a cost summary in the terminal and exit
  --json            Print the full report as JSON and exit
  --days <n>        Limit --summary / --json to the last n days
  --help, -h        Show this help message

Examples:
  npx claude-code-usage-analytics              Open dashboard in browser
  npx claude-code-usage-analytics --summary    Quick terminal summary
  claude-code-usage-analytics --json --days 7  Last week's report as JSON
`);
  process.exit(0);
}

function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const port = argValue('--port') !== undefined ? parseInt(argValue('--port'), 10) : 3456;
const host = argValue('--host') || '127.0.0.1';
const noOpen = args.includes('--no-open');
const days = argValue('--days') !== undefined ? parseInt(argValue('--days'), 10) : null;

if (isNaN(port)) {
  console.error('Error: --port must be a number');
  process.exit(1);
}
if (days !== null && (isNaN(days) || days < 1)) {
  console.error('Error: --days must be a positive number');
  process.exit(1);
}

if (args.includes('--summary') || args.includes('--json')) {
  runCli().catch(err => { console.error(err.message); process.exit(1); });
} else {
  startServer();
}

async function runCli() {
  const { parseAllSessions } = require('./parser');
  const { buildReport, dayKey } = require('./report');
  const filters = days ? { from: dayKey(Date.now() - (days - 1) * 864e5) } : {};
  const report = buildReport(await parseAllSessions(), filters);

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const t = report.totals;
  const $ = n => '$' + n.toFixed(2);
  const tok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  const range = t.dateRange ? `${t.dateRange.from} to ${t.dateRange.to}` : 'no data';

  console.log(`\n  Claude Code usage  (${range})\n`);
  console.log(`  Estimated cost      ${$(t.cost.total)}`);
  console.log(`  This month          ${$(report.month.mtd)}  (on pace for ${$(report.month.projected)})`);
  console.log(`  Saved by caching    ${$(t.cacheSavings)}  (${Math.round(t.cacheHitRate * 100)}% cache hit rate)`);
  console.log(`  Sessions / prompts  ${t.sessions} / ${t.prompts}  (${t.requests} API requests)`);
  console.log(`  Tokens              ${tok(t.tokens.total)}  (${tok(t.tokens.output)} output)`);
  const active = report.blocks.find(b => b.active);
  if (active) {
    const mins = Math.round(active.remainingMs / 60000);
    console.log(`  Current 5h block    ${$(active.cost)}  (${Math.floor(mins / 60)}h ${mins % 60}m left, ${$(active.burnRate)}/h)`);
  }
  console.log('\n  By model');
  for (const m of report.modelBreakdown) {
    console.log(`    ${pad(m.model, 30)}${lpad($(m.cost.total), 12)}${lpad(tok(m.tokens.total), 10)}`);
  }
  console.log('\n  Top projects');
  for (const p of report.projectBreakdown.slice(0, 8)) {
    console.log(`    ${pad(p.name, 30)}${lpad($(p.cost.total), 12)}${lpad(p.sessions + ' sess', 10)}`);
  }
  if (t.calibration.sessions) {
    console.log(`\n  Calibrated against Claude Code's own cost records for ${t.calibration.sessions} sessions.`);
  }
  console.log('');
}

function startServer() {
  const { createServer } = require('./server');
  const app = createServer();

  const server = app.listen(port, host, async () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`\n  Claude Analytics dashboard running at ${url}\n`);

    if (!noOpen) {
      try {
        const open = (await import('open')).default;
        await open(url);
      } catch {
        console.log('  Could not auto-open browser. Open the URL manually.');
      }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try --port <other-port>`);
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    server.close();
    process.exit(0);
  });
}
