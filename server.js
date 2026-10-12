const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists BEFORE opening the DB
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// FLAT REPO: require from root, not from scrapers/
const movies = require('./movies');
const tvshows = require('./tvshows');
const adult = require('./adult');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Cache (SQLite with in-memory fallback) ─────────────────────
let cache;
try {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'cache.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  cache = {
    get: (k) => {
      const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(k);
      return row ? JSON.parse(row.value) : null;
    },
    set: (k, v) => {
      db.prepare(`
        INSERT INTO cache (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = datetime('now')
      `).run(k, JSON.stringify(v));
    }
  };
} catch (e) {
  console.warn('SQLite cache unavailable, using memory:', e.message);
  const mem = new Map();
  cache = {
    get: (k) => mem.get(k) || null,
    set: (k, v) => mem.set(k, v)
  };
}

async function cached(key, fetcher) {
  const hit = cache.get(key);
  if (hit) return hit;
  const data = await fetcher();
  cache.set(key, data);
  return data;
}

// ─── Static assets (whitelist extensions to protect source) ────
app.use((req, res, next) => {
  if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|mp4|webm|json)$/i.test(req.path)) {
    return res.sendFile(path.join(__dirname, req.path), err => {
      if (err) res.status(404).end();
    });
  }
  next();
});

// ─── MOVIES ─────────────────────────────────────────────────────
app.get('/api/movies/trending', async (req, res) => {
  try {
    res.json({ results: await cached('movies:trending', () => movies.getTrending()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    res.json({ results: await cached(`movies:search:${q}`, () => movies.search(q)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/genre/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const page = req.query.page || 1;
    res.json({ results: await cached(`movies:genre:${name}:${page}`, () => movies.getByGenre(name, page)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    res.json(await cached(`movie:${req.params.id}`, () => movies.getDetails(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/sources', async (req, res) => {
  try {
    res.json(await cached(`movie:sources:${req.params.id}`, () => movies.getStreamSources(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TV ─────────────────────────────────────────────────────────
app.get('/api/tv/trending', async (req, res) => {
  try {
    res.json({ results: await cached('tv:trending', () => tvshows.getTrending()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
  try {
    res.json(await cached(`tv:${req.params.id}`, () => tvshows.getDetails(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    res.json(await cached(`tv:${id}:${season}:${episode}`, () => tvshows.getEpisodeStream(id, season, episode)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADULT ──────────────────────────────────────────────────────
app.get('/api/adult/trending', async (req, res) => {
  try {
    const page = req.query.page || 1;
    res.json({ results: await cached(`adult:trending:${page}`, () => adult.getTrending(page)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const page = req.query.page || 1;
    res.json({ results: await cached(`adult:search:${q}:${page}`, () => adult.search(q, page)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/category/:name', async (req, res) => {
  try {
    const page = req.query.page || 1;
    res.json({ results: await cached(`adult:cat:${req.params.name}:${page}`, () => adult.getByCategory(req.params.name, page)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/video/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;
    res.json(await cached(`adult:video:${source}:${id}`, () => adult.getVideo(source, id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Frontend fallback ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MovieBox running on http://localhost:${PORT}`);
});
