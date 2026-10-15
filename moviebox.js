// moviebox.js — MovieBox content scraper
// Fetches live data from movieboxhd.net's SSR payload

const axios = require('axios');

const CACHE_TTL = 30 * 60 * 1000; // 30 min
let cachedData = null;
let cacheTime = 0;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function extractSSRData(html) {
  // MovieBox is Nuxt SSR — all page data is embedded as JSON in __NUXT_DATA__ script
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[1]);
    if (!Array.isArray(raw)) return [];
    // Nuxt stores refs by index — objects that have subjectId are content items
    const results = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (item.subjectId && item.subjectId !== '12') {
        const id = item.subjectId;
        const type = item.subjectType === 52 ? 'movie' : 'tv';
        const cover = item.cover || {};
        const poster = cover.url || '';
        const blurHash = cover.blurHash || '';
        const genre = item.genre || '';
        const country = item.countryName || '';
        const year = item.releaseDate ? String(item.releaseDate).slice(0, 4) : '';
        const rating = item.imdbRatingValue ? String(item.imdbRatingValue) : '';
        const duration = item.duration ? Math.round(item.duration / 60) + 'min' : '';
        const isLimited = item.corner === 12; // "Limited Free" badge
        const hasResource = item.hasResource === true;
        const dubs = item.dubs || [];
        results.push({ id, type, title: item.title || '', poster, blurHash, year, genre, country, rating, duration, isLimited, hasResource, dubs, _raw: item });
      }
    }
    return results;
  } catch { return []; }
}

function extractHeroItems(html) {
  // Carousel data is in the SSR array as BANNER type items
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[1]);
    if (!Array.isArray(raw)) return [];
    // Banner items are typically at the start of the data array
    // Look for items that have subjectId and appear in carousel context
    const banners = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      // Banner items typically have a subjectId + subject with subjectId=52 (movie)
      if (item.subjectId && item.subject && typeof item.subject === 'object') {
        const subj = item.subject;
        if (subj.subjectId) {
          banners.push({
            id: subj.subjectId,
            title: subj.title || item.title || '',
            poster: subj.cover?.url || '',
            backdrop: (subj.cover?.url || '').replace(/w_\d+/, 'w_1280'),
            year: subj.releaseDate ? String(subj.releaseDate).slice(0, 4) : '',
            genre: subj.genre || '',
            rating: subj.imdbRatingValue ? String(subj.imdbRatingValue) : '',
            overview: subj.description || ''
          });
        }
      }
    }
    // Deduplicate
    const seen = new Set();
    return banners.filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; }).slice(0, 10);
  } catch { return []; }
}

async function fetchMBData() {
  if (cachedData && Date.now() - cacheTime < CACHE_TTL) return cachedData;
  try {
    const r = await axios.get('https://movieboxhd.net', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const html = r.data;
    const items = extractSSRData(html);
    const hero = extractHeroItems(html);
    // Classify
    const movies = items.filter(i => i.type === 'movie');
    const tv = items.filter(i => i.type === 'tv');
    cachedData = { movies, tv, hero, html };
    cacheTime = Date.now();
    console.log(`[MovieBox] Scraped: ${movies.length} movies, ${tv.length} TV, ${hero.length} hero items`);
    return cachedData;
  } catch (e) {
    console.error('[MovieBox] Scrape error:', e.message);
    return cachedData || { movies: [], tv: [], hero: [] };
  }
}

// ── Express routes ──
function mount(app) {
  // Combined feed — everything MovieBox has on homepage
  app.get('/api/mb/feed', async (_req, res) => {
    try {
      const d = await fetchMBData();
      res.json({ hero: d.hero, movies: d.movies, tv: d.tv, total: d.movies.length + d.tv.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // MovieBox trending movies
  app.get('/api/mb/trending', async (req, res) => {
    try {
      const d = await fetchMBData();
      res.json({ results: d.movies, source: 'moviebox', count: d.movies.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // MovieBox trending TV
  app.get('/api/mb/trending-tv', async (req, res) => {
    try {
      const d = await fetchMBData();
      res.json({ results: d.tv, source: 'moviebox', count: d.tv.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // MovieBox search (local filter)
  app.get('/api/mb/search', async (req, res) => {
    try {
      const q = (req.query.q || '').toLowerCase();
      const d = await fetchMBData();
      const all = [...d.movies, ...d.tv];
      const results = q ? all.filter(i => i.title.toLowerCase().includes(q) || (i.genre || '').toLowerCase().includes(q)) : all;
      res.json({ results, source: 'moviebox', count: results.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Force refresh
  app.post('/api/mb/refresh', async (_req, res) => {
    cachedData = null; cacheTime = 0;
    try {
      const d = await fetchMBData();
      res.json({ ok: true, movies: d.movies.length, tv: d.tv.length, hero: d.hero.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Full SSR HTML proxy (if you want to serve MovieBox's page structure)
  app.get('/api/mb/html', async (_req, res) => {
    try {
      const d = await fetchMBData();
      res.type('html').send(d.html || '<p>No data</p>');
    } catch (e) { res.status(500).send(e.message); }
  });
}

module.exports = { mount };
