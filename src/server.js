const express = require('express');
const path = require('path');

function createServer() {
  const app = express();

  let cachedData = null;

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) {
        cachedData = await require('./parser').parseAllSessions();
      }
      res.json(cachedData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      delete require.cache[require.resolve('./parser')];
      cachedData = await require('./parser').parseAllSessions();
      res.json({ ok: true, sessions: cachedData.sessions.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };
