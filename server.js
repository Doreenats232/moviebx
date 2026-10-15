// server.js — Complete streaming aggregator backend
// Drop-in replacement. All routes preserved + MovieBox scraper added.

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ── Ensure data dir ──
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── SQLite cache ──
const db = new Database(path.join(DATA_DIR, 'cache.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value TEXT, ts INTEGER
)`);
const cacheGet = (k, ttlMs = 30 * 60000) => {
  const r = db.prepare('SELECT value,ts FROM cache WHERE key=?').get(k);
  if (!r || Date.now() - r.ts > ttlMs) return null;
  try { return JSON.parse(r.value); } catch { return null; }
};
const cacheSet = (k, v) => {
  db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?)').run(k, JSON.stringify(v), Date.now());
};

// ── TMDB ──
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_KEY || '83987b2f70a5e6fbf4b1b22f79b5e725';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const tmdb = async (ep, p = {}) => {
  const u = new URL(`${TMDB}${ep}`);
  u.searchParams.set('api_key', TMDB_KEY);
  u.searchParams.set('include_adult', 'true');
  for (const [k, v] of Object.entries(p)) if (v != null) u.searchParams.set(k, v);
  const r = await axios.get(u.toString(), { timeout: 8000 });
  return r.data;
};

// ── Helpers ──
const IMG = (p, w = 500) => p ? `${TMDB_IMG}/w${w}${p}` : null;
const BACKDROP = (p) => p ? `${TMDB_IMG}/original${p}` : null;

function mapMovie(d) {
  return {
    id: d.id,
    title: d.title || d.name || '',
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    poster: IMG(d.poster_path),
    backdrop: BACKDROP(d.backdrop_path),
    rating: d.vote_average ? +d.vote_average.toFixed(1) : null,
    overview: d.overview || '',
    genre: (d.genre_ids || []).join(','),
    type: d.media_type || 'movie'
  };
}

function mapDetail(d) {
  return {
    id: d.id,
    title: d.title || d.name || '',
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    poster: IMG(d.poster_path, 780),
    backdrop: BACKDROP(d.backdrop_path),
    rating: d.vote_average ? +d.vote_average.toFixed(1) : null,
    runtime: d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : null,
    synopsis: d.overview || '',
    genres: (d.genres || []).map(g => g.name),
    seasons: (d.seasons || []).map(s => ({
      number: s.season_number,
      episodes: s.episode_count
    }))
  };
}

// ══════════════════════════════════════════════
//  MOVIE ROUTES
// ══════════════════════════════════════════════

app.get('/api/movies/trending', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const ck = `trending:${page}`;
    const cached = cacheGet(ck, 30 * 60000);
    if (cached) return res.json(cached);
    const d = await tmdb('/trending/movie/week', { page });
    const out = { results: (d.results || []).map(mapMovie), page, total_pages: d.total_pages };
    cacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/search', async (req, res) => {
  try {
    const { q, page = 1 } = req.query;
    if (!q) return res.json({ results: [] });
    const d = await tmdb('/search/movie', { query: q, page });
    res.json({ results: (d.results || []).map(mapMovie) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/genre/:name', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const ck = `genre:${req.params.name}:${page}`;
    const cached = cacheGet(ck, 60 * 60000);
    if (cached) return res.json(cached);
    // Map genre name to TMDB genre ID
    const genreMap = { action:28,adventure:12,animation:16,comedy:35,crime:80,documentary:99,drama:18,family:10751,fantasy:14,history:36,horror:27,music:10402,mystery:9648,romance:10749,'sci-fi':878,thriller:53,war:10752,western:37 };
    const gid = genreMap[req.params.name.toLowerCase()] || 28;
    const d = await tmdb('/discover/movie', { with_genres: gid, sort_by: 'popularity.desc', page, 'vote_count.gte': 50 });
    const out = { results: (d.results || []).map(mapMovie) };
    cacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    const ck = `movie:${req.params.id}`;
    const cached = cacheGet(ck, 120 * 60000);
    if (cached) return res.json(cached);
    const d = await tmdb(`/movie/${req.params.id}`, { append_to_response: 'videos,credits,similar' });
    const out = mapDetail(d);
    // Extract trailer
    const trailers = (d.videos?.results || []).filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
    if (trailers.length) out.trailer = { url: `https://www.youtube.com/watch?v=${trailers[0].key}` };
    // Cast
    out.cast = (d.credits?.cast || []).slice(0, 12).map(c => ({ id: c.id, name: c.name, character: c.character, photo: IMG(c.profile_path, 185) }));
    // Similar
    out.similar = (d.similar?.results || []).slice(0, 12).map(mapMovie);
    cacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/trailer', async (req, res) => {
  try {
    const d = await tmdb(`/movie/${req.params.id}`, { append_to_response: 'videos' });
    const trailers = (d.videos?.results || []).filter(v => v.site === 'YouTube');
    if (trailers.length) res.json({ url: `https://www.youtube.com/watch?v=${trailers[0].key}` });
    else res.status(404).json({ error: 'No trailer' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/similar', async (req, res) => {
  try {
    const d = await tmdb(`/movie/${req.params.id}/similar`);
    res.json({ results: (d.results || []).map(mapMovie) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  STREAM SOURCES (18-provider pool)
// ══════════════════════════════════════════════

const PROVIDERS = [
  { name:'VidSrc 1', base:'https://vidsrc.me/embed/movie?tmdb=' },
  { name:'VidSrc 2', base:'https://vidsrc.to/embed/movie/' },
  { name:'VidSrc 3', base:'https://vidsrc.xyz/embed/movie/' },
  { name:'VidSrc 4', base:'https://vidsrc.me/embed/movie/' },
  { name:'EmbedSu', base:'https://embed.su/embed/movie/' },
  { name:'VidLink', base:'https://vidlink.pro/movie/' },
  { name:'2Embed', base:'https://www.2embed.cc/embed/movie/' },
  { name:'MultiEmbed', base:'https://multiembed.mov/?video_id=' },
  { name:'AutoEmbed', base:'https://autoembed.co/movie/' },
  { name:'SmashyStream', base:'https://embed.smashystream.com/movie.php?tmdb=' },
  { name:'23Embed', base:'https://23embed.com/movie/' },
  { name:'FilmEmbed', base:'https://filmembed.net/movie/' },
  { name:'MoviesAPI', base:'https://moviesapi.club/movie/' },
  { name:'VidEasy', base:'https://v2.vidsrc.me/src/embed/?tmdb=' },
  { name:'RuVid', base:'https://ruvid.net/embed/movie/' },
  { name:'SuperEmbed', base:'https://multiembed.mov/directstream.php?video_id=' },
  { name:'EmbedVid', base:'https://embed.vidsrc.me/movie/' },
  { name:'VidCloud', base:'https://mzzcloud.life/embed/movie/' },
];

const TV_PROVIDERS = [
  { name:'VidSrc 1', base:'https://vidsrc.me/embed/tv?tmdb=&season=&episode=' },
  { name:'VidSrc 2', base:'https://vidsrc.to/embed/tv/' },
  { name:'VidSrc 3', base:'https://vidsrc.xyz/embed/tv/' },
  { name:'EmbedSu', base:'https://embed.su/embed/tv/' },
  { name:'VidLink', base:'https://vidlink.pro/tv/' },
  { name:'2Embed', base:'https://www.2embed.cc/embed/tv/' },
  { name:'MultiEmbed', base:'https://multiembed.mov/?video_id=' },
  { name:'AutoEmbed', base:'https://autoembed.co/tv/' },
  { name:'SmashyStream', base:'https://embed.smashystream.com/tv.php?tmdb=' },
  { name:'23Embed', base:'https://23embed.com/tv/' },
  { name:'FilmEmbed', base:'https://filmembed.net/tv/' },
  { name:'MoviesAPI', base:'https://moviesapi.club/tv/' },
  { name:'VidEasy', base:'https://v2.vidsrc.me/src/embed/?tmdb=' },
  { name:'RuVid', base:'https://ruvid.net/embed/tv/' },
  { name:'SuperEmbed', base:'https://multiembed.mov/directstream.php?video_id=' },
  { name:'EmbedVid', base:'https://embed.vidsrc.me/tv/' },
  { name:'VidCloud', base:'https://mzzcloud.life/embed/tv/' },
];

// Health cache
const healthCache = {};
async function probeHost(url, timeout = 3000) {
  try {
    const t0 = Date.now();
    await axios.head(url, { timeout, maxRedirects: 5, validateStatus: () => true });
    return { ok: true, latency: Date.now() - t0 };
  } catch { return { ok: false, latency: 9999 }; }
}

function buildMovieSources(tmdbId) {
  return PROVIDERS.map((p, i) => ({
    id: `src-${i}`,
    name: p.name,
    quality: 'HD',
    url: p.base + tmdbId,
    health: healthCache[p.name]?.ok === false ? 'down' : 'ok',
    latency: healthCache[p.name]?.latency || 9999
  }));
}

function buildTVSources(tmdbId, season, episode) {
  return TV_PROVIDERS.map((p, i) => {
    let url;
    if (p.base.includes('tmdb=&season=')) {
      url = p.base.replace('tmdb=', `tmdb=${tmdbId}`).replace('season=', `season=${season}`).replace('episode=', `episode=${episode}`);
    } else if (p.base.includes('video_id=')) {
      url = p.base + tmdbId;
    } else {
      url = p.base + `${tmdbId}/${season}/${episode}`;
    }
    return { id: `tsrc-${i}`, name: p.name, quality: 'HD', url, health: 'ok', latency: 9999 };
  });
}

app.get('/api/movie/:id/sources', async (req, res) => {
  try {
    res.json({ sources: buildMovieSources(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/source/probe', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    const r = await probeHost(url);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  TV ROUTES
// ══════════════════════════════════════════════

app.get('/api/tv/trending', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const ck = `tv-trending:${page}`;
    const cached = cacheGet(ck, 30 * 60000);
    if (cached) return res.json(cached);
    const d = await tmdb('/trending/tv/week', { page });
    const out = { results: (d.results || []).map(mapMovie) };
    cacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/search', async (req, res) => {
  try {
    const { q, page = 1 } = req.query;
    if (!q) return res.json({ results: [] });
    const d = await tmdb('/search/tv', { query: q, page });
    res.json({ results: (d.results || []).map(mapMovie) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
  try {
    const ck = `tv:${req.params.id}`;
    const cached = cacheGet(ck, 120 * 60000);
    if (cached) return res.json(cached);
    const d = await tmdb(`/tv/${req.params.id}`, { append_to_response: 'videos,credits,similar' });
    const out = mapDetail(d);
    out.type = 'tv';
    // Trailer
    const trailers = (d.videos?.results || []).filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
    if (trailers.length) out.trailer = { url: `https://www.youtube.com/watch?v=${trailers[0].key}` };
    // Cast
    out.cast = (d.credits?.cast || []).slice(0, 12).map(c => ({ id: c.id, name: c.name, character: c.character, photo: IMG(c.profile_path, 185) }));
    // Similar
    out.similar = (d.similar?.results || []).slice(0, 12).map(mapMovie);
    cacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/season/:num', async (req, res) => {
  try {
    const { id, num } = req.params;
    const ck = `tv-season:${id}:${num}`;
    const cached = cacheGet(ck, 60 * 60000);
    if (cached) return res.json(cached);
    const d = await tmdb(`/tv/${id}/season/${num}`);
    const out = {
      season_number: d.season_number,
      episodes: (d.episodes || []).map(e => ({
        number: e.episode_number,
        title: e.name || '',
        air_date: e.air_date || '',
        overview: e.overview || '',
        thumb: e.still_path ? IMG(e.still_path, 300) : null
      }))
    };
    cacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    // Get episode info
    const d = await tmdb(`/tv/${id}/season/${season}/episode/${episode}`);
    // Build sources
    const sources = buildTVSources(id, season, episode);
    // Next episode info
    let next = null;
    try {
      const sd = await tmdb(`/tv/${id}/season/${season}/episode/${+episode + 1}`);
      if (sd && sd.episode_number) {
        next = { season: +season, episode: sd.episode_number, title: sd.name };
      }
    } catch {
      try {
        const nd = await tmdb(`/tv/${id}/season/${+season + 1}/episode/1`);
        if (nd && nd.episode_number) {
          next = { season: +season + 1, episode: nd.episode_number, title: nd.name };
        }
      } catch {}
    }
    res.json({
      title: d.name || `S${season} E${episode}`,
      air_date: d.air_date || '',
      overview: d.overview || '',
      sources,
      next
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  ADULT ROUTES
// ══════════════════════════════════════════════

const ADULT_SOURCES = ['xvideos', 'xnxx', 'spankbang', 'eporner', 'redtube'];

async function scrapeXVideos(query, page = 1) {
  const url = `https://www.xvideos.com/?k=${encodeURIComponent(query)}&p=${page - 1}`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const results = [];
    $('.thumb-under a, .thumb a, [data-id]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || $el.find('a').attr('href') || '';
      const title = $el.text().trim() || $el.attr('title') || '';
      if (href && href.includes('/video')) {
        const id = href.match(/video(\d+)/)?.[1] || href;
        results.push({ id: `xv-${id}`, title: title.slice(0, 120), source: 'xvideos', url: `https://www.xvideos.com${href.startsWith('/') ? '' : '/'}${href}`, duration: '', views: '' });
      }
    });
    return results.slice(0, 20);
  } catch { return []; }
}

async function scrapeXNXX(query, page = 1) {
  const url = `https://www.xnxx.com/search/${encodeURIComponent(query)}/${page}`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const results = [];
    $('.thumb-under a, .thumb a, [data-id]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const title = $el.text().trim() || $el.attr('title') || '';
      if (href && href.includes('/video')) {
        const id = href.match(/video(\d+)/)?.[1] || href;
        results.push({ id: `xnxx-${id}`, title: title.slice(0, 120), source: 'xnxx', url: `https://www.xnxx.com${href}`, duration: '', views: '' });
      }
    });
    return results.slice(0, 20);
  } catch { return []; }
}

async function scrapeSpankBang(query, page = 1) {
  const url = `https://spankbang.com/s/${encodeURIComponent(query)}/${page}/`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const results = [];
    $('.video-item a, .thumb a, [class*="video"] a').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const title = $el.attr('title') || $el.text().trim() || '';
      if (href && href.includes('/video')) {
        results.push({ id: `sb-${href.replace(/\D/g, '')}`, title: title.slice(0, 120), source: 'spankbang', url: `https://spankbang.com${href}`, duration: '', views: '' });
      }
    });
    return results.slice(0, 20);
  } catch { return []; }
}

async function scrapeEPorner(query, page = 1) {
  const url = `https://www.eporner.com/search/${encodeURIComponent(query)}/${page}/`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const results = [];
    $('.mb .phimage a, .video-preview a, [class*="thumb"] a').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const title = $el.attr('title') || $el.text().trim() || '';
      if (href && href.includes('/video-')) {
        const id = href.match(/video-([^/]+)/)?.[1] || href;
        results.push({ id: `ep-${id}`, title: title.slice(0, 120), source: 'eporner', url: `https://www.eporner.com${href}`, duration: '', views: '' });
      }
    });
    return results.slice(0, 20);
  } catch { return []; }
}

async function scrapeRedTube(query, page = 1) {
  const url = `https://www.redtube.com/?search=${encodeURIComponent(query)}&page=${page}`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const results = [];
    $('[class*="video-item"] a, [class*="video_box"] a, [data-id]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const title = $el.attr('title') || $el.text().trim() || '';
      if (href && /\/\d+/.test(href)) {
        const id = href.match(/\/(\d+)/)?.[1] || href;
        results.push({ id: `rt-${id}`, title: title.slice(0, 120), source: 'redtube', url: `https://www.redtube.com${href}`, duration: '', views: '' });
      }
    });
    return results.slice(0, 20);
  } catch { return []; }
}

const SCRAPERS = { xvideos: scrapeXVideos, xnxx: scrapeXNXX, spankbang: scrapeSpankBang, eporner: scrapeEPorner, redtube: scrapeRedTube };

async function scrapeMulti(query, source = 'all', page = 1) {
  if (source !== 'all' && SCRAPERS[source]) {
    return await SCRAPERS[source](query, page);
  }
  const results = await Promise.allSettled(ADULT_SOURCES.map(s => SCRAPERS[s](query, page)));
  const all = [];
  results.forEach(r => { if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value); });
  // Interleave
  const out = [];
  const max = Math.max(...results.map(r => r.status === 'fulfilled' ? r.value.length : 0));
  for (let i = 0; i < max; i++) {
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value[i]) out.push(r.value[i]);
    }
  }
  return out.slice(0, 40);
}

app.get('/api/adult/trending', async (req, res) => {
  try {
    const { source = 'all', page = 1 } = req.query;
    const results = await scrapeMulti('', source, page);
    res.json({ results, source });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/search', async (req, res) => {
  try {
    const { q, source = 'all', page = 1 } = req.query;
    if (!q) return res.json({ results: [] });
    const results = await scrapeMulti(q, source, page);
    res.json({ results, source, query: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/category/:cat', async (req, res) => {
  try {
    const { source = 'all', page = 1 } = req.query;
    const results = await scrapeMulti(req.params.cat, source, page);
    res.json({ results, category: req.params.cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/performer/:name', async (req, res) => {
  try {
    const { source = 'all', page = 1 } = req.query;
    const results = await scrapeMulti(req.params.name, source, page);
    res.json({ results, performer: req.params.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/video/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;
    // Build a basic response with the source URL as primary
    let url = '';
    if (source === 'xvideos') url = `https://www.xvideos.com/video${id}`;
    else if (source === 'xnxx') url = `https://www.xnxx.com/video${id}`;
    else if (source === 'spankbang') url = `https://spankbang.com/${id}/video/`;
    else if (source === 'eporner') url = `https://www.eporner.com/video-${id}/`;
    else if (source === 'redtube') url = `https://www.redtube.com/${id}`;
    else url = id; // fallback: treat id as URL

    res.json({
      title: `${source} Video`,
      source,
      url,
      thumb: '',
      duration: '',
      views: '',
      sources: [{ name: 'Primary', quality: 'HD', url }]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  4K / TORRENT ROUTES
// ══════════════════════════════════════════════

async function scrapeYTS(query) {
  try {
    const r = await axios.get(`https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=5`, { timeout: 8000 });
    return (r.data?.data?.movies || []).map(m => ({
      quality: m.quality?.join(', ') || 'HD',
      size: m.torrents?.[0]?.size || '?',
      seeds: m.torrents?.[0]?.seeds || 0,
      source: 'YTS',
      magnet: m.torrents?.[0]?.hash ? `magnet:?xt=urn:btih:${m.torrents[0].hash}&dn=${encodeURIComponent(m.title_english || m.title || 'movie')}` : null,
      detailUrl: m.torrents?.[0]?.url || null
    }));
  } catch { return []; }
}

async function scrape1337x(query) {
  try {
    const r = await axios.get(`https://1337x.to/search/${encodeURIComponent(query)}/1/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000
    });
    const $ = cheerio.load(r.data);
    const results = [];
    $('table.table-list tbody tr').each((_, el) => {
      const $el = $(el);
      const name = $el.find('td.coll-1 a:last-child').text().trim();
      const href = $el.find('td.coll-1 a:last-child').attr('href') || '';
      const seeds = parseInt($el.find('td.coll-2').text().trim()) || 0;
      const size = $el.find('td.coll-4').text().trim() || '?';
      const quality = /2160|4k/i.test(name) ? '4K' : /1080/i.test(name) ? '1080p' : /720/i.test(name) ? '720p' : 'HD';
      results.push({ quality, size, seeds, source: '1337x', magnet: null, detailUrl: href.startsWith('http') ? href : `https://1337x.to${href}` });
    });
    return results.slice(0, 5);
  } catch { return []; }
}

async function scrapeTorrentGalaxy(query) {
  try {
    const r = await axios.get(`https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000
    });
    const $ = cheerio.load(r.data);
    const results = [];
    $('div.tgxtablerow.txlight').each((_, el) => {
      const $el = $(el);
      const name = $el.find('a.txlight').last().text().trim();
      const href = $el.find('a.txlight').last().attr('href') || '';
      const seeds = parseInt($el.find('.txgreendownloadfont').text().trim()) || 0;
      const quality = /2160|4k/i.test(name) ? '4K' : /1080/i.test(name) ? '1080p' : 'HD';
      results.push({ quality, size: '?', seeds, source: 'TorrentGalaxy', magnet: null, detailUrl: href.startsWith('http') ? href : `https://torrentgalaxy.to${href}` });
    });
    return results.slice(0, 5);
  } catch { return []; }
}

async function scrapeLimeTorrents(query) {
  try {
    const r = await axios.get(`https://www.limetorrents.pro/search/all/${encodeURIComponent(query)}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000
    });
    const $ = cheerio.load(r.data);
    const results = [];
    $('table.table2 tbody tr').each((_, el) => {
      const $el = $(el);
      const name = $el.find('td.torname a').text().trim();
      const href = $el.find('td.torname a').attr('href') || '';
      const size = $el.find('td.torsize').text().trim() || '?';
      const seeds = parseInt($el.find('td.torseeds').text().trim()) || 0;
      const quality = /2160|4k/i.test(name) ? '4K' : /1080/i.test(name) ? '1080p' : 'HD';
      results.push({ quality, size, seeds, source: 'LimeTorrents', magnet: null, detailUrl: href.startsWith('http') ? href : `https://www.limetorrents.pro${href}` });
    });
    return results.slice(0, 5);
  } catch { return []; }
}

async function scrapeNyaa(query) {
  try {
    const r = await axios.get(`https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query)}&s=seeders&o=desc`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000
    });
    const $ = cheerio.load(r.data);
    const results = [];
    $('table.torrent-list tbody tr').each((_, el) => {
      const $el = $(el);
      const name = $el.find('td:nth-child(2) a:last-child').text().trim();
      const href = $el.find('td:nth-child(3) a').attr('href') || '';
      const size = $el.find('td:nth-child(4)').text().trim() || '?';
      const seeds = parseInt($el.find('td:nth-child(6)').text().trim()) || 0;
      const quality = /2160|4k/i.test(name) ? '4K' : /1080/i.test(name) ? '1080p' : 'HD';
      const magnet = href.startsWith('magnet:') ? href : null;
      results.push({ quality, size, seeds, source: 'Nyaa', magnet, detailUrl: null });
    });
    return results.slice(0, 5);
  } catch { return []; }
}

const TORRENT_SCRAPERS = [scrapeYTS, scrape1337x, scrapeTorrentGalaxy, scrapeLimeTorrents, scrapeNyaa];

app.get('/api/movie/:id/4k', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) {
      // Try to get title from TMDB
      try {
        const d = await tmdb(`/movie/${req.params.id}`);
        const searchQ = `${d.title} ${d.release_date?.slice(0, 4) || ''}`;
        const results = await searchAllTorrents(searchQ);
        return res.json({ results, query: searchQ });
      } catch { return res.json({ results: [], error: 'No title available' }); }
    }
    const results = await searchAllTorrents(q);
    res.json({ results, query: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode/4k', async (req, res) => {
  try {
    const q = req.query.q;
    const results = q ? await searchAllTorrents(q) : [];
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function searchAllTorrents(q) {
  const all = await Promise.allSettled(TORRENT_SCRAPERS.map(fn => fn(q)));
  const results = [];
  all.forEach(r => { if (r.status === 'fulfilled' && Array.isArray(r.value)) results.push(...r.value); });
  // Sort: 4K first, then by seeds
  results.sort((a, b) => {
    const qa = a.quality === '4K' ? 2 : a.quality === '1080p' ? 1 : 0;
    const qb = b.quality === '4K' ? 2 : b.quality === '1080p' ? 1 : 0;
    if (qa !== qb) return qb - qa;
    return (b.seeds || 0) - (a.seeds || 0);
  });
  return results;
}

// ══════════════════════════════════════════════
//  DEBRID (placeholder)
// ══════════════════════════════════════════════

app.get('/api/debrid/status', (req, res) => {
  const enabled = !!process.env.REAL_DEBRID_TOKEN;
  res.json({ enabled, provider: enabled ? 'Real-Debrid' : 'none' });
});

// ══════════════════════════════════════════════
//  SYSTEM ROUTES
// ══════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    cache_size: db.prepare('SELECT COUNT(*) as c FROM cache').get().c
  });
});

app.post('/api/cache/clear', (req, res) => {
  try {
    db.exec('DELETE FROM cache');
    res.json({ ok: true, message: 'Cache cleared' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs', (req, res) => {
  const routes = [
    'GET  /api/movies/trending?page=1',
    'GET  /api/movies/search?q=QUERY&page=1',
    'GET  /api/movies/genre/GENRE?page=1',
    'GET  /api/movie/:id',
    'GET  /api/movie/:id/sources',
    'GET  /api/movie/:id/trailer',
    'GET  /api/movie/:id/similar',
    'GET  /api/movie/:id/4k?q=TITLE',
    'GET  /api/tv/trending?page=1',
    'GET  /api/tv/search?q=QUERY&page=1',
    'GET  /api/tv/:id',
    'GET  /api/tv/:id/season/:num',
    'GET  /api/tv/:id/:season/:episode',
    'GET  /api/tv/:id/:season/:episode/4k?q=TITLE',
    'GET  /api/adult/trending?source=all&page=1',
    'GET  /api/adult/search?q=QUERY&source=all&page=1',
    'GET  /api/adult/category/CAT?source=all&page=1',
    'GET  /api/adult/performer/NAME?source=all&page=1',
    'GET  /api/adult/video/:source/:id',
    'GET  /api/mb/feed',
    'GET  /api/mb/trending',
    'GET  /api/mb/trending-tv',
    'GET  /api/mb/search?q=QUERY',
    'POST /api/mb/refresh',
    'GET  /api/source/probe?url=URL',
    'GET  /api/debrid/status',
    'GET  /api/health',
    'POST /api/cache/clear',
  ];
  res.json({ name: 'MovieBox Streaming API', version: '3.0.0', routes });
});

// ── Mount MovieBox scraper ──
try { require('./moviebox').mount(app); } catch (e) { console.warn('[moviebox.js] not loaded:', e.message); }

// ── Serve frontend ──
app.use(express.static(__dirname));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬 MovieBox Streaming Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Docs:   http://localhost:${PORT}/api/docs`);
  console.log(`   Frontend: http://localhost:${PORT}\n`);
});
