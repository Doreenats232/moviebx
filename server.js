const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');  // ← ADD THIS LINE

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Ensure data directory exists ────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(cors());
// ... rest of your server.js stays the same

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SQLite Cache ───────────────────────────────────────────────
const db = new Database('./data/cache.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )
`);

function getCached(key) {
  const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setCache(key, value) {
  db.prepare('INSERT OR REPLACE INTO cache (key, value, fetched_at) VALUES (?, ?, datetime(\'now\'))').run(key, JSON.stringify(value));
}

function cleanOldCache() {
  db.prepare("DELETE FROM cache WHERE fetched_at < datetime('now', '-6 hours')").run();
}

setInterval(cleanOldCache, 60 * 60 * 1000);

// ─── Scrapers ───────────────────────────────────────────────────
const movies = require('./scrapers/movies');
const tvshows = require('./scrapers/tvshows');
const adult = require('./scrapers/adult');

// ─── MOVIES ─────────────────────────────────────────────────────

app.get('/api/trending', async (req, res) => {
  try {
    const cached = getCached('trending');
    if (cached) return res.json(cached);

    const data = await movies.getTrending();
    setCache('trending', data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch trending' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);
    const cacheKey = `search:${q.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await movies.search(q);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `movie:${id}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await movies.getDetails(id);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch movie details' });
  }
});

app.get('/api/genre/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const page = req.query.page || 1;
    const cacheKey = `genre:${name}:${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await movies.getByGenre(name, page);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch genre' });
  }
});

app.get('/api/movie/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `stream:movie:${id}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await movies.getStreamSources(id);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

// ─── TV SHOWS ───────────────────────────────────────────────────

app.get('/api/tv/trending', async (req, res) => {
  try {
    const cached = getCached('tv_trending');
    if (cached) return res.json(cached);

    const data = await tvshows.getTrending();
    setCache('tv_trending', data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch TV trending' });
  }
});

app.get('/api/tv/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `tv:${id}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await tvshows.getDetails(id);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch TV details' });
  }
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const cacheKey = `tv:stream:${id}:${season}:${episode}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await tvshows.getEpisodeStream(id, season, episode);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch episode stream' });
  }
});

// ─── ADULT (18+) ────────────────────────────────────────────────

app.get('/api/adult/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const page = req.query.page || 1;
    const cacheKey = `adult:search:${q.toLowerCase()}:${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await adult.search(q, page);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Adult search failed' });
  }
});

app.get('/api/adult/trending', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const cacheKey = `adult:trending:${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await adult.getTrending(page);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch adult trending' });
  }
});

app.get('/api/adult/category/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const page = req.query.page || 1;
    const cacheKey = `adult:cat:${name}:${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await adult.getByCategory(name, page);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch adult category' });
  }
});

app.get('/api/adult/video/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;
    const cacheKey = `adult:video:${source}:${id}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await adult.getVideo(source, id);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch adult video' });
  }
});

// ─── SPA Fallback ───────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieBX running on port ${PORT}`);
});
