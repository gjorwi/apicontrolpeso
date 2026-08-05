require('dotenv').config();
const express = require('express');
const cors = require('cors');
const emailRoutes = require('./routes/email');
const syncRoutes = require('./routes/sync');
const syncStore = require('./services/syncStore');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use('/api/smtp', emailRoutes);
app.use('/api/sync', syncRoutes);

app.use((err, req, res, next) => {
  console.error('[error]', req.path, '-', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Error interno.' });
});

const port = Number(process.env.PORT) || 10000;

async function start() {
  try {
    const usedMongo = await syncStore.initDb();
    console.log(`[db] storage=${usedMongo ? 'MongoDB (Mongoose)' : 'archivo JSON (fallback)'}`);
  } catch (e) {
    console.warn('[db] init error, fallback archivo JSON:', e.message);
  }
  app.listen(port, () => {
    console.log(`[server] listening on :${port} (env=${process.env.NODE_ENV || 'development'}, mock=${process.env.MOCK_MAIL === 'true'})`);
  });
}

start();
