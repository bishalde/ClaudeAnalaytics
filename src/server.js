const express = require('express');
const path = require('path');
const { parseAllSessions } = require('./parser');
const { buildReport, sessionDetail } = require('./report');
const { toCSV } = require('./export');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function readFilters(q) {
  return {
    from: DAY_RE.test(q.from || '') ? q.from : null,
    to: DAY_RE.test(q.to || '') ? q.to : null,
    project: typeof q.project === 'string' && q.project ? q.project : null,
    model: typeof q.model === 'string' && q.model ? q.model : null,
  };
}

function createServer() {
  const app = express();

  let data = null;
  let loading = null;
  // Re-parsing only touches files whose size/mtime changed, so it is cheap
  // enough to run on every refresh or live-mode poll.
  async function load(force) {
    if (data && !force) return data;
    if (!loading) {
      loading = parseAllSessions().then(d => { data = d; return d; }).finally(() => { loading = null; });
    }
    return loading;
  }

  app.get('/api/data', async (req, res) => {
    try {
      const d = await load(req.query.refresh === '1');
      res.json(buildReport(d, readFilters(req.query)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id', async (req, res) => {
    try {
      const detail = sessionDetail(await load(false), req.params.id);
      if (!detail) return res.status(404).json({ error: 'Session not found' });
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/export', async (req, res) => {
    try {
      const d = await load(false);
      const level = req.query.level === 'requests' ? 'requests' : req.query.level === 'prompts' ? 'prompts' : 'sessions';
      const stamp = new Date().toISOString().split('T')[0];
      if (req.query.format === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename="claude-usage-${stamp}.json"`);
        return res.json(buildReport(d, readFilters(req.query)));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="claude-usage-${level}-${stamp}.csv"`);
      res.send(toCSV(d, readFilters(req.query), level));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Kept for older clients; /api/data?refresh=1 does the same in one round trip.
  app.get('/api/refresh', async (req, res) => {
    try {
      const d = await load(true);
      res.json({ ok: true, sessions: d.sessions.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer, readFilters };
