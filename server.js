const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const movies = require('./movies');
const tvshows = require('./tvshows');
const adult = require('./adult');
const torrents = require('./torrents');
const RealDebrid = require('./debrid');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';

// ─────────────────────────────────────────────────────
// CACHE (Redis -> SQLite -> memory)
// ─────────────────────────────────────────────────────
let cacheGet = async () => null;
let cacheSet = async () => {};
let cacheClear = async () => {};

(async () => {
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      const client = createClient({ url: process.env.REDIS_URL });
      await client.connect();
      cacheGet = async k => { const v = await client.get(k); return v ? JSON.parse(v) : null; };
      cacheSet = async (k, v) => { await client.setEx(k, 1800, JSON.stringify(v)); };
      cacheClear = async () => { await client.flushAll().catch(() => {}); };
      console.log('[cache] redis');
      return;
    } catch (e) { console.log('[cache] redis failed ->', e.message); }
  }
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA, 'cache.sqlite'));
    db.exec("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, at TEXT DEFAULT (datetime('now')))");
    const qGet = db.prepare('SELECT v FROM cache WHERE k = ?');
    const qSet = db.prepare("INSERT INTO cache (k, v, at) VALUES (?, ?, datetime('now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = datetime('now')");
    const qAll = db.prepare('DELETE FROM cache');
    cacheGet = async k => { const r = qGet.get(k); return r ? JSON.parse(r.v) : null; };
    cacheSet = async (k, v) => { qSet.run(k, JSON.stringify(v)); };
    cacheClear = async () => { qAll.run(); };
    console.log('[cache] sqlite');
    return;
  } catch (e) { console.log('[cache] sqlite failed ->', e.message); }
  const mem = new Map();
  cacheGet = async k => mem.get(k) ?? null;
  cacheSet = async (k, v) => { mem.set(k, v); if (mem.size > 900) mem.delete(mem.keys().next().value); };
  cacheClear = async () => mem.clear();
  console.log('[cache] memory');
})();

async function cached(key, fn, fallbackToFn = true) {
  try {
    const hit = await cacheGet(key);
    if (hit) return hit;
    const val = await fn();
    await cacheSet(key, val);
    return val;
  } catch (e) {
    if (fallbackToFn) return await fn();
    throw e;
  }
}

// ─────────────────────────────────────────────────────
// SERVER-SIDE DEBRID (single key, zero user config)
// ─────────────────────────────────────────────────────
const RD_KEY = (process.env.RD_API_KEY || '').trim();
const RD = new RealDebrid(RD_KEY);

const rateLimit = new Map();
function rl(req, key, max = 30, windowMs = 60000) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon').split(',')[0];
  const k = `${ip}:${key}`;
  const now = Date.now();
  const rec = rateLimit.get(k) || { count: 0, at: now };
  if (now - rec.at > windowMs) { rec.count = 0; rec.at = now; }
  rec.count++;
  rateLimit.set(k, rec);
  return rec.count <= max;
}

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(500).json({ error: e.message }));
}

// ─────────────────────────────────────────────────────
// MOVIES
// ─────────────────────────────────────────────────────
app.get('/api/movies/trending', wrap(async (req, res) => {
  const page = req.query.page || 1;
  const results = await cached(`movies:trend:${page}`, () => movies.getTrending(page));
  res.json({ results });
}));

app.get('/api/movies/search', wrap(async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ results: [] });
  const page = req.query.page || 1;
  const results = await cached(`movies:search:${q}:${page}`, () => movies.search(q, page));
  res.json({ results });
}));

app.get('/api/movies/genre/:name', wrap(async (req, res) => {
  const page = req.query.page || 1;
  const results = await cached(`movies:genre:${req.params.name}:${page}`, () => movies.getByGenre(req.params.name, page));
  res.json({ results });
}));

app.get('/api/movie/:id', wrap(async (req, res) => {
  const d = await cached(`movie:${req.params.id}`, () => movies.getDetails(req.params.id));
  res.json(d);
}));

app.get('/api/movie/:id/sources', wrap(async (req, res) => {
  const d = await cached(`movie:src:${req.params.id}`, () => movies.getStreamSources(req.params.id));
  res.json({ sources: d });
}));

app.get('/api/movie/:id/trailer', wrap(async (req, res) => {
  const t = await cached(`movie:trail:${req.params.id}`, () => movies.getTrailer(req.params.id));
  if (!t) return res.status(404).json({ error: 'No trailer found' });
  res.json(t);
}));

app.get('/api/movie/:id/similar', wrap(async (req, res) => {
  const results = await cached(`movie:sim:${req.params.id}`, async () => {
    const { data } = await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}/similar`, {
      params: { api_key: TMDB_KEY, language: 'en-US' }, timeout: 15000
    });
    return (data.results || []).map(m => ({
      id: m.id, title: m.title,
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
      backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
      year: (m.release_date || '').slice(0, 4),
      rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null
    }));
  });
  res.json({ results });
}));

// ─── 4K TORRENT LIST (movies) ─────────────────────────
app.get('/api/movie/:id/4k', wrap(async (req, res) => {
  if (!rl(req, '4k', 25)) return res.status(429).json({ error: 'Rate limit' });
  let q = req.query.q;
  if (!q) {
    const det = await cached(`movie:${req.params.id}`, () => movies.getDetails(req.params.id));
    q = `${det.title} ${det.year || ''}`.trim();
  }
  const results = await cached(`torrents:movie:${req.params.id}:${q}`, () => torrents.search(q), false);
  res.json({ results, query: q, debrid: RD.enabled });
}));

// ─────────────────────────────────────────────────────
// TV SHOWS
// ─────────────────────────────────────────────────────
app.get('/api/tv/trending', wrap(async (req, res) => {
  const page = req.query.page || 1;
  const results = await cached(`tv:trend:${page}`, () => tvshows.getTrending(page));
  res.json({ results });
}));

app.get('/api/tv/search', wrap(async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ results: [] });
  const page = req.query.page || 1;
  const results = await cached(`tv:search:${q}:${page}`, () => tvshows.search(q, page));
  res.json({ results });
}));

app.get('/api/tv/:id', wrap(async (req, res) => {
  const d = await cached(`tv:${req.params.id}`, () => tvshows.getDetails(req.params.id));
  res.json(d);
}));

app.get('/api/tv/:id/season/:season', wrap(async (req, res) => {
  const d = await cached(`tv:${req.params.id}:s${req.params.season}`, () => tvshows.getSeason(req.params.id, req.params.season));
  res.json(d);
}));

app.get('/api/tv/:id/:season/:episode', wrap(async (req, res) => {
  const { id, season, episode } = req.params;
  const d = await cached(`tv:${id}:${season}:${episode}`, () => tvshows.getEpisodeStream(id, season, episode));
  res.json(d);
}));

app.get('/api/tv/:id/:season/:episode/4k', wrap(async (req, res) => {
  if (!rl(req, '4k', 25)) return res.status(429).json({ error: 'Rate limit' });
  const { id, season, episode } = req.params;
  const det = await cached(`tv:${id}`, () => tvshows.getDetails(id));
  const suffix = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const q = req.query.q || `${det.title} ${suffix}`;
  const results = await cached(`torrents:tv:${id}:${suffix}`, () => torrents.search(q), false);
  res.json({ results, query: q, debrid: RD.enabled });
}));

// ─────────────────────────────────────────────────────
// TORRENT RESOLVE (server-side, zero user config)
// ─────────────────────────────────────────────────────
app.post('/api/torrent/resolve', wrap(async (req, res) => {
  if (!rl(req, 'resolve', 10, 60000)) return res.status(429).json({ error: 'Rate limit — 10 resolves/min' });
  const { magnet, detailUrl, source, title } = req.body || {};
  if (!magnet && !detailUrl) return res.status(400).json({ error: 'Missing magnet or detailUrl' });

  const finalMagnet = await torrents.ensureMagnet({ magnet, detailUrl, source });
  const hash = require('crypto').createHash('md5').update(finalMagnet).digest('hex');

  const out = await cached(`resolved:${hash}`, async () => {
    const s = await RD.check();
    if (!s.enabled) throw new Error(s.error || 'Real-Debrid not configured on server. Set RD_API_KEY.');
    return await RD.resolve(finalMagnet);
  }, false);

  res.json({ ...out, debrid: { enabled: true, cached: true }, title });
}));

app.get('/api/debrid/status', wrap(async (req, res) => {
  const s = await cached('debrid:status', () => RD.check(), false);
  res.json(s);
}));

app.post('/api/cache/clear', wrap(async (req, res) => {
  await cacheClear();
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────
// ADULT
// ─────────────────────────────────────────────────────
app.get('/api/adult/trending', wrap(async (req, res) => {
  const { source, page = 1 } = req.query;
  const results = await cached(`adult:trend:${source || 'all'}:${page}`, () => adult.getTrending(source, page));
  res.json({ results });
}));

app.get('/api/adult/search', wrap(async (req, res) => {
  const { q, source, page = 1 } = req.query;
  if (!q) return res.json({ results: [] });
  const results = await cached(`adult:search:${q}:${source || 'all'}:${page}`, () => adult.search(q, source, page));
  res.json({ results });
}));

app.get('/api/adult/category/:name', wrap(async (req, res) => {
  const { source, page = 1 } = req.query;
  const results = await cached(`adult:cat:${req.params.name}:${source || 'all'}:${page}`, () => adult.getCategory(req.params.name, source, page));
  res.json({ results });
}));

app.get('/api/adult/video/:source/:id', wrap(async (req, res) => {
  const key = `adult:vid:${req.params.source}:${req.params.id}`;
  const d = await cached(key, () => adult.getVideo(req.params.source, req.params.id));
  res.json(d);
}));

app.get('/api/adult/performer/:name', wrap(async (req, res) => {
  const { source, page = 1 } = req.query;
  const results = await cached(`adult:perf:${req.params.name}:${source || 'all'}:${page}`, () => adult.search(req.params.name, source, page));
  res.json({ results });
}));

// ─────────────────────────────────────────────────────
// API DOCS
// ─────────────────────────────────────────────────────
app.get('/api/docs', (req, res) => res.json({
  name: 'MovieBox API',
  version: '2.0.4k',
  endpoints: {
    movies: ['/api/movies/trending', '/api/movies/search', '/api/movies/genre/:name', '/api/movie/:id', '/api/movie/:id/sources', '/api/movie/:id/trailer', '/api/movie/:id/similar', '/api/movie/:id/4k'],
    tv: ['/api/tv/trending', '/api/tv/search', '/api/tv/:id', '/api/tv/:id/season/:s', '/api/tv/:id/:s/:e', '/api/tv/:id/:s/:e/4k'],
    adult: ['/api/adult/trending', '/api/adult/search', '/api/adult/category/:name', '/api/adult/video/:source/:id', '/api/adult/performer/:name'],
    torrent: ['POST /api/torrent/resolve'],
    debrid: ['/api/debrid/status', 'POST /api/cache/clear']
  }
}));

// ─────────────────────────────────────────────────────
// STATIC (flat repo, extension whitelist)
// ─────────────────────────────────────────────────────
const ALLOWED = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const fp = path.join(__dirname, req.path === '/' ? 'index.html' : req.path);
  const ext = path.extname(fp).toLowerCase();
  const base = path.basename(fp);
  if (['server.js', 'package.json', 'Dockerfile', '.env'].includes(base)) return next();
  if (!ALLOWED.has(ext)) return next();
  if (!fp.startsWith(__dirname)) return next();
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return res.sendFile(fp);
  next();
});

app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).json({ error: 'index.html not found at repo root' });
});

app.listen(PORT, () => console.log(`🎬 MovieBox running on :${PORT} | RD_API_KEY ${RD_KEY ? '✅' : '❌ missing'}`));
