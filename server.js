const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const movies = require('./movies');
const tvshows = require('./tvshows');
const adult = require('./adult');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';

// ── CACHE (Redis -> SQLite -> memory) ──────────────────
let cacheGet = async () => null;
let cacheSet = async () => {};
let cacheClear = async () => {};

(async () => {
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      const c = createClient({ url: process.env.REDIS_URL });
      await c.connect();
      cacheGet = async k => { const v = await c.get(k); return v ? JSON.parse(v) : null; };
      cacheSet = async (k, v) => { await c.setEx(k, 1800, JSON.stringify(v)); };
      cacheClear = async () => { await c.flushAll().catch(() => {}); };
      console.log('[cache] redis'); return;
    } catch (e) { console.log('[cache] redis fail', e.message); }
  }
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA, 'cache.sqlite'));
    db.exec("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, at TEXT DEFAULT (datetime('now')))");
    const g = db.prepare('SELECT v FROM cache WHERE k = ?');
    const s = db.prepare("INSERT INTO cache (k,v,at) VALUES (?,?,datetime('now')) ON CONFLICT(k) DO UPDATE SET v=excluded.v, at=datetime('now')");
    const a = db.prepare('DELETE FROM cache');
    cacheGet = async k => { const r = g.get(k); return r ? JSON.parse(r.v) : null; };
    cacheSet = async (k, v) => { s.run(k, JSON.stringify(v)); };
    cacheClear = async () => { a.run(); };
    console.log('[cache] sqlite'); return;
  } catch (e) { console.log('[cache] sqlite fail', e.message); }
  const m = new Map();
  cacheGet = async k => m.get(k) ?? null;
  cacheSet = async (k, v) => { m.set(k, v); if (m.size > 800) m.delete(m.keys().next().value); };
  cacheClear = async () => m.clear();
  console.log('[cache] memory');
})();

async function cached(key, fn) {
  try {
    const hit = await cacheGet(key);
    if (hit) return hit;
    const val = await fn();
    await cacheSet(key, val);
    return val;
  } catch (e) { return await fn(); }
}

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[api]', req.path, e.message);
    res.status(500).json({ error: e.message, path: req.path });
  });
}

const list = arr => ({ results: Array.isArray(arr) ? arr : [] });

// ── MOVIES ─────────────────────────────────────────────
app.get('/api/movies/trending', wrap(async (req, res) => {
  const p = req.query.page || 1;
  res.json(list(await cached(`m:trend:${p}`, () => movies.getTrending(p))));
}));

app.get('/api/movies/search', wrap(async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json(list([]));
  const p = req.query.page || 1;
  res.json(list(await cached(`m:search:${q}:${p}`, () => movies.search(q, p))));
}));

app.get('/api/movies/genre/:name', wrap(async (req, res) => {
  const p = req.query.page || 1;
  res.json(list(await cached(`m:genre:${req.params.name}:${p}`, () => movies.getByGenre(req.params.name, p))));
}));

app.get('/api/movie/:id', wrap(async (req, res) => {
  const d = await cached(`m:d:${req.params.id}`, () => movies.getDetails(req.params.id));
  res.json(d);
}));

// GUARANTEED shape: {sources:[...]} — never empty
app.get('/api/movie/:id/sources', wrap(async (req, res) => {
  let src = [];
  try {
    src = await cached(`m:src:${req.params.id}`, () => movies.getStreamSources(req.params.id));
  } catch (e) { console.error('[sources]', e.message); }
  if (!Array.isArray(src)) src = [];
  src = src.filter(s => s && s.url);
  if (!src.length) {
    src = [
      { name: 'VidSrc', quality: '1080p', url: `https://vidsrc.to/embed/movie/${req.params.id}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.xyz', quality: '1080p', url: `https://vidsrc.xyz/embed/movie/${req.params.id}`, health: 'ok', latency: 0 },
      { name: 'Embed.su', quality: '1080p', url: `https://embed.su/embed/${req.params.id}`, health: 'ok', latency: 0 }
    ];
  }
  res.json({ sources: src, count: src.length });
}));

app.get('/api/movie/:id/trailer', wrap(async (req, res) => {
  const t = await cached(`m:tr:${req.params.id}`, () => movies.getTrailer(req.params.id));
  if (!t) return res.status(404).json({ error: 'No trailer found' });
  res.json(t);
}));

app.get('/api/movie/:id/similar', wrap(async (req, res) => {
  res.json(list(await cached(`m:sim:${req.params.id}`, () => movies.getSimilar(req.params.id))));
}));

// ── TV ─────────────────────────────────────────────────
app.get('/api/tv/trending', wrap(async (req, res) => {
  const p = req.query.page || 1;
  res.json(list(await cached(`t:trend:${p}`, () => tvshows.getTrending(p))));
}));

app.get('/api/tv/search', wrap(async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json(list([]));
  const p = req.query.page || 1;
  res.json(list(await cached(`t:search:${q}:${p}`, () => tvshows.search(q, p))));
}));

app.get('/api/tv/:id', wrap(async (req, res) => {
  const d = await cached(`t:d:${req.params.id}`, () => tvshows.getDetails(req.params.id));
  res.json(d);
}));

app.get('/api/tv/:id/season/:season', wrap(async (req, res) => {
  const d = await cached(`t:s:${req.params.id}:${req.params.season}`, () => tvshows.getSeason(req.params.id, req.params.season));
  res.json(d);
}));

// GUARANTEED shape: {title, sources:[...], next:{...}}
app.get('/api/tv/:id/:season/:episode', wrap(async (req, res) => {
  const { id, season, episode } = req.params;
  let d;
  try {
    d = await cached(`t:e:${id}:${season}:${episode}`, () => tvshows.getEpisodeStream(id, season, episode));
  } catch (e) {
    d = { title: `S${season}E${episode}`, synopsis: '', air_date: '', thumb: null };
  }
  let src = Array.isArray(d.sources) ? d.sources.filter(s => s && s.url) : [];
  if (!src.length) {
    src = [
      { name: 'VidSrc', quality: '1080p', url: `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.xyz', quality: '1080p', url: `https://vidsrc.xyz/embed/tv/${id}/${season}/${episode}`, health: 'ok', latency: 0 }
    ];
  }
  res.json({ ...d, sources: src, next: d.next || { season: Number(season), episode: Number(episode) + 1 } });
}));

// ── ADULT (unchanged) ──────────────────────────────────
app.get('/api/adult/trending', wrap(async (req, res) => {
  const { source, page = 1 } = req.query;
  res.json(list(await cached(`a:t:${source||'all'}:${page}`, () => adult.getTrending(source, page))));
}));
app.get('/api/adult/search', wrap(async (req, res) => {
  const { q, source, page = 1 } = req.query;
  if (!q) return res.json(list([]));
  res.json(list(await cached(`a:s:${q}:${source||'all'}:${page}`, () => adult.search(q, source, page))));
}));
app.get('/api/adult/category/:name', wrap(async (req, res) => {
  const { source, page = 1 } = req.query;
  res.json(list(await cached(`a:c:${req.params.name}:${source||'all'}:${page}`, () => adult.getCategory(req.params.name, source, page))));
}));
app.get('/api/adult/video/:source/:id', wrap(async (req, res) => {
  const d = await cached(`a:v:${req.params.source}:${req.params.id}`, () => adult.getVideo(req.params.source, req.params.id));
  res.json(d);
}));
app.get('/api/adult/performer/:name', wrap(async (req, res) => {
  const { source, page = 1 } = req.query;
  res.json(list(await cached(`a:p:${req.params.name}:${source||'all'}:${page}`, () => adult.search(req.params.name, source, page))));
}));

// ── 4K (on hold, kept working) ─────────────────────────
try {
  const torrents = require('./torrents');
  const RealDebrid = require('./debrid');
  const RD = new RealDebrid(process.env.RD_API_KEY || process.env.TORBOX_API_KEY || process.env.DEBRIDLINK_API_KEY || '');
  app.get('/api/movie/:id/4k', wrap(async (req, res) => {
    const q = req.query.q || '';
    if (!q) return res.json(list([]));
    res.json(list(await cached(`k:m:${req.params.id}`, () => torrents.search(q))));
  }));
  app.get('/api/tv/:id/:season/:episode/4k', wrap(async (req, res) => {
    const q = req.query.q || '';
    if (!q) return res.json(list([]));
    const suf = `S${String(req.params.season).padStart(2,'0')}E${String(req.params.episode).padStart(2,'0')}`;
    res.json(list(await cached(`k:t:${req.params.id}:${suf}`, () => torrents.search(`${q} ${suf}`))));
  }));
  app.post('/api/torrent/resolve', wrap(async (req, res) => {
    const { magnet, detailUrl, source } = req.body || {};
    if (!magnet && !detailUrl) return res.status(400).json({ error: 'Missing magnet or detailUrl' });
    const m = await torrents.ensureMagnet({ magnet, detailUrl, source });
    const s = await RD.check();
    if (!s.enabled) return res.status(402).json({ error: 'Real-Debrid not configured on server.' });
    const out = await RD.resolve(m);
    res.json(out);
  }));
  app.get('/api/debrid/status', wrap(async (req, res) => res.json(await RD.check())));
  console.log('[4k] torrent routes loaded');
} catch (e) {
  console.log('[4k] torrent layer not loaded:', e.message);
  app.get('/api/debrid/status', (req, res) => res.json({ enabled: false, error: '4K layer disabled' }));
  app.get('/api/movie/:id/4k', (req, res) => res.json(list([])));
  app.get('/api/tv/:id/:season/:episode/4k', (req, res) => res.json(list([])));
}

// ── SYSTEM ─────────────────────────────────────────────
app.post('/api/cache/clear', wrap(async (req, res) => { await cacheClear(); res.json({ ok: true }); }));

app.get('/api/health', (req, res) => {
  const check = (mod, fns) => {
    const out = {};
    for (const f of fns) out[f] = typeof mod?.[f] === 'function';
    return out;
  };
  res.json({
    ok: true,
    movies: check(movies, ['getTrending','search','getByGenre','getDetails','getStreamSources','getTrailer','getSimilar']),
    tvshows: check(tvshows, ['getTrending','search','getDetails','getSeason','getEpisodeStream']),
    adult: check(adult, ['getTrending','search','getCategory','getVideo']),
    node: process.version
  });
});

app.get('/api/docs', (req, res) => res.json({
  name: 'MovieBox API', version: '2.1',
  endpoints: {
    movies: ['/api/movies/trending','/api/movies/search','/api/movies/genre/:name','/api/movie/:id','/api/movie/:id/sources','/api/movie/:id/trailer','/api/movie/:id/similar','/api/movie/:id/4k'],
    tv: ['/api/tv/trending','/api/tv/search','/api/tv/:id','/api/tv/:id/season/:s','/api/tv/:id/:s/:e','/api/tv/:id/:s/:e/4k'],
    adult: ['/api/adult/trending','/api/adult/search','/api/adult/category/:name','/api/adult/video/:source/:id','/api/adult/performer/:name'],
    system: ['/api/health','/api/docs','POST /api/cache/clear']
  }
}));

// ── STATIC (flat repo) ─────────────────────────────────
const ALLOWED = new Set(['.html','.css','.js','.json','.png','.jpg','.jpeg','.gif','.svg','.ico','.webp','.woff','.woff2','.ttf']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const fp = path.join(__dirname, req.path === '/' ? 'index.html' : req.path);
  const ext = path.extname(fp).toLowerCase();
  const base = path.basename(fp);
  if (['server.js','package.json','Dockerfile','.env'].includes(base)) return next();
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

app.listen(PORT, () => console.log(`🎬 MovieBox running on :${PORT}`));
