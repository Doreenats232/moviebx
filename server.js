const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const movies = require('./movies');
const tvshows = require('./tvshows');
const adult = require('./adult');

const app = express();
app.use(cors());
app.use(express.json());

// ── Cache: Redis → SQLite → memory ──────────────────────────
let cache = null;
if (process.env.REDIS_URL) {
  try {
    const { createClient } = require('redis');
    const r = createClient({ url: process.env.REDIS_URL });
    r.on('error', () => {});
    r.connect().catch(() => {});
    cache = {
      get: async (k) => { try { const v = await r.get(k); return v ? JSON.parse(v) : null; } catch { return null; } },
      set: async (k, v) => { try { await r.set(k, JSON.stringify(v), { EX: 600 }); } catch {} }
    };
    console.log('Cache: Redis');
  } catch (e) { console.warn('Redis unavailable:', e.message); }
}
if (!cache) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA_DIR, 'cache.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, value TEXT, created_at TEXT DEFAULT (datetime('now'))
    );`);
    cache = {
      get: async (k) => { const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(k); return row ? JSON.parse(row.value) : null; },
      set: async (k, v) => { db.prepare(`INSERT INTO cache (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = datetime('now')`).run(k, JSON.stringify(v)); }
    };
    console.log('Cache: SQLite');
  } catch (e) {
    console.warn('Cache: memory —', e.message);
    const mem = new Map();
    cache = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => mem.set(k, v) };
  }
}

async function cached(key, fetcher) {
  const hit = await cache.get(key);
  if (hit) return hit;
  const data = await fetcher();
  await cache.set(key, data);
  return data;
}

const pg = (req) => Number(req.query.page || 1) || 1;

// ── Static (extension whitelist) ────────────────────────────
app.use((req, res, next) => {
  if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|mp4|webm)$/i.test(req.path)) {
    return res.sendFile(path.join(__dirname, req.path), err => { if (err) res.status(404).end(); });
  }
  next();
});

// ── Docs ────────────────────────────────────────────────────
app.get('/api/docs', (req, res) => {
  res.json({
    movies: ['/api/movies/trending?page=', '/api/movies/search?q=&page=', '/api/movies/genre/:name?page='],
    movie: ['/api/movie/:id', '/api/movie/:id/sources', '/api/movie/:id/trailer'],
    tv: ['/api/tv/trending?page=', '/api/tv/search?q=', '/api/tv/:id', '/api/tv/:id/season/:season', '/api/tv/:id/:season/:episode'],
    adult: ['/api/adult/trending?source=&page=', '/api/adult/search?q=&source=&page=', '/api/adult/category/:name?source=&page=', '/api/adult/video/:source/:id', '/api/adult/performer/:name']
  });
});

// ── MOVIES ──────────────────────────────────────────────────
app.get('/api/movies/trending', async (req, res) => {
  try { res.json({ results: await cached(`movies:trend:${pg(req)}`, () => movies.getTrending(pg(req))) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    res.json({ results: await cached(`movies:search:${q}:${pg(req)}`, () => movies.search(q, pg(req))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/genre/:name', async (req, res) => {
  try {
    res.json({ results: await cached(`movies:genre:${req.params.name}:${pg(req)}`, () => movies.getByGenre(req.params.name, pg(req))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/sources', async (req, res) => {
  try { res.json(await cached(`movie:src:${req.params.id}`, () => movies.getStreamSources(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/trailer', async (req, res) => {
  try { res.json(await cached(`movie:trailer:${req.params.id}`, () => movies.getTrailer(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
  try { res.json(await cached(`movie:${req.params.id}`, () => movies.getDetails(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TV ──────────────────────────────────────────────────────
app.get('/api/tv/trending', async (req, res) => {
  try { res.json({ results: await cached(`tv:trend:${pg(req)}`, () => tvshows.getTrending(pg(req))) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    res.json({ results: await cached(`tv:search:${q}:${pg(req)}`, () => tvshows.search(q, pg(req))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/season/:season', async (req, res) => {
  try {
    const { id, season } = req.params;
    res.json(await cached(`tv:${id}:s${season}`, () => tvshows.getSeason(id, season)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    res.json(await cached(`tv:${id}:${season}:${episode}`, () => tvshows.getEpisodeStream(id, season, episode)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
  try { res.json(await cached(`tv:${req.params.id}`, () => tvshows.getDetails(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADULT ───────────────────────────────────────────────────
app.get('/api/adult/trending', async (req, res) => {
  try {
    const source = req.query.source || 'all';
    res.json({ results: await cached(`adult:trend:${source}:${pg(req)}`, () => adult.getTrending(pg(req), source)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const source = req.query.source || 'all';
    res.json({ results: await cached(`adult:search:${q}:${source}:${pg(req)}`, () => adult.search(q, pg(req), source)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/performer/:name', async (req, res) => {
  try {
    res.json({ results: await cached(`adult:perf:${req.params.name}:${pg(req)}`, () => adult.search(req.params.name, pg(req), req.query.source || 'all')) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/category/:name', async (req, res) => {
  try {
    const source = req.query.source || 'all';
    res.json({ results: await cached(`adult:cat:${req.params.name}:${source}:${pg(req)}`, () => adult.getByCategory(req.params.name, pg(req), source)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/video/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;
    res.json(await cached(`adult:vid:${source}:${id}`, () => adult.getVideo(source, id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API 404 (JSON, never HTML) ──────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `No route for ${req.path}`, hint: 'GET /api/docs' });
});

// ── Frontend ────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MovieBox running on http://localhost:${PORT}`));
