const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
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
      cacheSet = async (k, v) => { await client.setEx(k, 600, JSON.stringify(v)); };
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
  cacheSet = async (k, v) => { mem.set(k, v); if (mem.size > 800) mem.delete(mem.keys().next().value); };
  cacheClear = async () => mem.clear();
  console.log('[cache] memory');
})();

async function cached(key, fn) {
  try {
    const hit = await cacheGet(key);
    if (hit) return hit;
    const val = await fn();
    await cacheSet(key, val);
    return val;
  } catch (e) {
    return await fn();
  }
}

// ─────────────────────────────────────────────────────
// DEBRID resolver
// ─────────────────────────────────────────────────────
function debridFor(req) {
  const headerKey = (req.headers['x-rd-key'] || '').trim();
  const envKey = (process.env.RD_API_KEY || '').trim();
  return new RealDebrid(headerKey || envKey);
}

const rateLimit = new Map();
function rl(req, key, max = 20, windowMs = 60000) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon';
  const k = `${ip}:${key}`;
  const now = Date.now();
  const rec = rateLimit.get(k) || { count: 0, at: now };
  if (now - rec.at > windowMs) { rec.count = 0; rec.at = now; }
  rec.count++;
  rateLimit.set(k, rec);
  return rec.count <= max;
}

// ─────────────────────────────────────────────────────
// MOVIES
// ─────────────────────────────────────────────────────
app.get('/api/movies/trending', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const results = await cached(`movies:trend:${page}`, () => movies.getTrending(page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.json({ results: [] });
    const page = req.query.page || 1;
    const results = await cached(`movies:search:${q}:${page}`, () => movies.search(q, page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/genre/:name', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const results = await cached(`movies:genre:${req.params.name}:${page}`, () => movies.getByGenre(req.params.name, page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    const d = await cached(`movie:${req.params.id}`, () => movies.getDetails(req.params.id));
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/sources', async (req, res) => {
  try {
    const d = await cached(`movie:src:${req.params.id}`, () => movies.getStreamSources(req.params.id));
    res.json({ sources: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/trailer', async (req, res) => {
  try {
    const t = await cached(`movie:trail:${req.params.id}`, () => movies.getTrailer(req.params.id));
    if (!t) return res.status(404).json({ error: 'No trailer found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/similar', async (req, res) => {
  try {
    const results = await cached(`movie:sim:${req.params.id}`, async () => {
      const { data } = await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}/similar`, {
        params: { api_key: process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d', language: 'en-US' },
        timeout: 15000
      });
      return (data.results || []).map(m => ({
        id: m.id,
        title: m.title,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
        backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
        year: (m.release_date || '').slice(0, 4),
        rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null
      }));
    });
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 4K TORRENTS (movies) ─────────────────────────────
app.get('/api/movie/:id/4k', async (req, res) => {
  try {
    if (!rl(req, '4k', 25)) return res.status(429).json({ error: 'Too many requests' });
    const q = req.query.q || '';
    if (!q) return res.status(400).json({ error: 'Missing q=title' });
    const results = await cached(`torrents:movie:${q}`, () => torrents.search(q));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────
// TV SHOWS
// ─────────────────────────────────────────────────────
app.get('/api/tv/trending', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const results = await cached(`tv:trend:${page}`, () => tvshows.getTrending(page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.json({ results: [] });
    const page = req.query.page || 1;
    const results = await cached(`tv:search:${q}:${page}`, () => tvshows.search(q, page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
  try {
    const d = await cached(`tv:${req.params.id}`, () => tvshows.getDetails(req.params.id));
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/season/:season', async (req, res) => {
  try {
    const d = await cached(`tv:${req.params.id}:s${req.params.season}`, () => tvshows.getSeason(req.params.id, req.params.season));
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const d = await cached(`tv:${id}:${season}:${episode}`, () => tvshows.getEpisodeStream(id, season, episode));
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode/4k', async (req, res) => {
  try {
    if (!rl(req, '4k', 25)) return res.status(429).json({ error: 'Too many requests' });
    const q = req.query.q || '';
    if (!q) return res.status(400).json({ error: 'Missing q=title' });
    const suffix = `S${String(req.params.season).padStart(2, '0')}E${String(req.params.episode).padStart(2, '0')}`;
    const results = await cached(`torrents:tv:${q}:${suffix}`, () => torrents.search(`${q} ${suffix}`));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────
// TORRENT RESOLVE (Real-Debrid)
// ─────────────────────────────────────────────────────
app.post('/api/torrent/resolve', async (req, res) => {
  try {
    if (!rl(req, 'resolve', 8, 60000)) return res.status(429).json({ error: 'Rate limit — 8 resolves/minute max' });
    const { magnet, detailUrl, source } = req.body || {};
    if (!magnet && !detailUrl) return res.status(400).json({ error: 'Missing magnet or detailUrl' });

    const finalMagnet = await torrents.ensureMagnet({ magnet, detailUrl, source });
    const rd = debridFor(req);
    const status = await rd.check();
    if (!status.enabled) return res.status(401).json({ error: status.error || 'Real-Debrid key required. Add one in Settings.' });

    const out = await rd.resolve(finalMagnet);
    res.json({ ...out, debrid: status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// DEBRID STATUS
// ─────────────────────────────────────────────────────
app.get('/api/debrid/status', async (req, res) => {
  const rd = debridFor(req);
  const s = await rd.check();
  res.json(s);
});

app.post('/api/debrid/test', async (req, res) => {
  const { key } = req.body || {};
  const rd = new RealDebrid(key);
  const s = await rd.check();
  res.json(s);
});

// ─────────────────────────────────────────────────────
// ADULT
// ─────────────────────────────────────────────────────
app.get('/api/adult/trending', async (req, res) => {
  try {
    const { source, page = 1 } = req.query;
    const results = await cached(`adult:trend:${source || 'all'}:${page}`, () => adult.getTrending(source, page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/search', async (req, res) => {
  try {
    const { q, source, page = 1 } = req.query;
    if (!q) return res.json({ results: [] });
    const results = await cached(`adult:search:${q}:${source || 'all'}:${page}`, () => adult.search(q, source, page));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/category/:name', async (req, res) => {
  try {
    const { source, page = 1 } = r
