require('dotenv').config();
const express = require('express');
const cors = require('cors');
const emailRoutes = require('./routes/email');
const syncRoutes = require('./routes/sync');
const syncStore = require('./services/syncStore');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const ts = new Date().toISOString();
  console.log(`[req] ${ts} ${req.method} ${req.originalUrl} from=${req.ip} ua="${req.headers['user-agent'] || ''}"`);
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[res] ${ts} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get('/health', (req, res) => {
  console.log(`[health] hit from=${req.ip} auth="${req.headers.authorization ? 'yes' : 'no'}"`);
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use('/api/smtp', emailRoutes);
app.use('/api/sync', syncRoutes);

app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'NOT_FOUND', message: 'Ruta no encontrada.' });
});

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, '-', err?.message || err);
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
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[server] listening on :${port} (env=${process.env.NODE_ENV || 'development'}, mock=${process.env.MOCK_MAIL === 'true'}) pid=${process.pid}`);
  });
  server.on('connection', (socket) => {
    console.log(`[tcp] connection accepted ${socket.remoteAddress}:${socket.remotePort}`);
  });
}

start();
