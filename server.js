const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cache.db'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT,ts INTEGER)');
const cacheGet = (k, ttl = 1800000) => {
  const r = db.prepare('SELECT value,ts FROM cache WHERE key=?').get(k);
  if (!r || Date.now() - r.ts > ttl) return null;
  try { return JSON.parse(r.value); } catch { return null; }
};
const cacheSet = (k, v) => {
  db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?)').run(k, JSON.stringify(v), Date.now());
};

const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_KEY || '83987b2f70a5e6fbf4b1b22f79b5e725';
const IMG = (p, w = 500) => p ? `https://image.tmdb.org/t/p/w${w}${p}` : null;
const BD = p => p ? `https://image.tmdb.org/t/p/original${p}` : null;

async function tmdb(ep, p = {}) {
  const u = new URL(TMDB + ep);
  u.searchParams.set('api_key', KEY);
  u.searchParams.set('include_adult', 'true');
  for (const [k, v] of Object.entries(p)) if (v != null) u.searchParams.set(k, v);
  const r = await axios.get(u.toString(), { timeout: 8000 });
  return r.data;
}

function mMovie(d) {
  return {
    id: d.id, title: d.title || d.name || '',
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    poster: IMG(d.poster_path), backdrop: BD(d.backdrop_path),
    rating: d.vote_average ? +d.vote_average.toFixed(1) : null,
    overview: d.overview || '', genre: (d.genre_ids || []).join(','),
    type: d.media_type || 'movie'
  };
}

function mDetail(d) {
  return {
    id: d.id, title: d.title || d.name || '',
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    poster: IMG(d.poster_path, 780), backdrop: BD(d.backdrop_path),
    rating: d.vote_average ? +d.vote_average.toFixed(1) : null,
    runtime: d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : null,
    synopsis: d.overview || '',
    genres: (d.genres || []).map(g => g.name),
    seasons: (d.seasons || []).map(s => ({ number: s.season_number, episodes: s.episode_count }))
  };
}

// ═══ MOVIES ═══
app.get('/api/movies/trending', async (req, res) => {
  try {
    const p = req.query.page || 1;
    const ck = `t:${p}`;
    const c = cacheGet(ck, 1800000);
    if (c) return res.json(c);
    const d = await tmdb('/trending/movie/week', { page: p });
    const o = { results: (d.results || []).map(mMovie), page: +p, total_pages: d.total_pages };
    cacheSet(ck, o);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/search', async (req, res) => {
  try {
    const { q, page = 1 } = req.query;
    if (!q) return res.json({ results: [] });
    const d = await tmdb('/search/movie', { query: q, page });
    res.json({ results: (d.results || []).map(mMovie) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movies/genre/:name', async (req, res) => {
  try {
    const p = req.query.page || 1;
    const ck = `g:${req.params.name}:${p}`;
    const c = cacheGet(ck, 3600000);
    if (c) return res.json(c);
    const gm = { action:28,adventure:12,animation:16,comedy:35,crime:80,documentary:99,drama:18,family:10751,fantasy:14,history:36,horror:27,music:10402,mystery:9648,romance:10749,'sci-fi':878,thriller:53,war:10752,western:37 };
    const gid = gm[req.params.name.toLowerCase()] || 28;
    const d = await tmdb('/discover/movie', { with_genres: gid, sort_by: 'popularity.desc', page: p, 'vote_count.gte': 50 });
    const o = { results: (d.results || []).map(mMovie) };
    cacheSet(ck, o);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    const ck = `m:${req.params.id}`;
    const c = cacheGet(ck, 7200000);
    if (c) return res.json(c);
    const d = await tmdb(`/movie/${req.params.id}`, { append_to_response: 'videos,credits,similar' });
    const o = mDetail(d);
    const trailers = (d.videos?.results || []).filter(v => v.site === 'YouTube' && v.type === 'Trailer');
    if (trailers.length) o.trailer = { url: `https://www.youtube.com/watch?v=${trailers[0].key}` };
    o.cast = (d.credits?.cast || []).slice(0, 12).map(c => ({ id: c.id, name: c.name, character: c.character, photo: IMG(c.profile_path, 185) }));
    o.similar = (d.similar?.results || []).slice(0, 12).map(mMovie);
    cacheSet(ck, o);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/trailer', async (req, res) => {
  try {
    const d = await tmdb(`/movie/${req.params.id}`, { append_to_response: 'videos' });
    const t = (d.videos?.results || []).filter(v => v.site === 'YouTube');
    if (t.length) res.json({ url: `https://www.youtube.com/watch?v=${t[0].key}` });
    else res.status(404).json({ error: 'No trailer' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/movie/:id/similar', async (req, res) => {
  try {
    const d = await tmdb(`/movie/${req.params.id}/similar`);
    res.json({ results: (d.results || []).map(mMovie) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ STREAM SOURCES ═══
const PROVIDERS = [
  { n:'VidSrc', b:'https://vidsrc.me/embed/movie?tmdb=' },
  { n:'VidSrc2', b:'https://vidsrc.to/embed/movie/' },
  { n:'VidSrc3', b:'https://vidsrc.xyz/embed/movie/' },
  { n:'VidSrc4', b:'https://v2.vidsrc.me/src/embed/?tmdb=' },
  { n:'EmbedSu', b:'https://embed.su/embed/movie/' },
  { n:'VidLink', b:'https://vidlink.pro/movie/' },
  { n:'2Embed', b:'https://www.2embed.cc/embed/movie/' },
  { n:'MultiEmbed', b:'https://multiembed.mov/?video_id=' },
  { n:'AutoEmbed', b:'https://autoembed.co/movie/' },
  { n:'Smashy', b:'https://embed.smashystream.com/movie.php?tmdb=' },
  { n:'23Embed', b:'https://23embed.com/movie/' },
  { n:'FilmEmbed', b:'https://filmembed.net/movie/' },
  { n:'MoviesAPI', b:'https://moviesapi.club/movie/' },
  { n:'VidEasy', b:'https://v2.vidsrc.me/src/embed/?tmdb=' },
  { n:'RuVid', b:'https://ruvid.net/embed/movie/' },
  { n:'SuperEmbed', b:'https://multiembed.mov/directstream.php?video_id=' },
  { n:'EmbedVid', b:'https://embed.vidsrc.me/movie/' },
  { n:'VidCloud', b:'https://mzzcloud.life/embed/movie/' }
];

const TV_PROVIDERS = [
  { n:'VidSrc', b:'https://vidsrc.me/embed/tv?tmdb=', s:true },
  { n:'VidSrc2', b:'https://vidsrc.to/embed/tv/' },
  { n:'VidSrc3', b:'https://vidsrc.xyz/embed/tv/' },
  { n:'EmbedSu', b:'https://embed.su/embed/tv/' },
  { n:'VidLink', b:'https://vidlink.pro/tv/' },
  { n:'2Embed', b:'https://www.2embed.cc/embed/tv/' },
  { n:'MultiEmbed', b:'https://multiembed.mov/?video_id=' },
  { n:'AutoEmbed', b:'https://autoembed.co/tv/' },
  { n:'Smashy', b:'https://embed.smashystream.com/tv.php?tmdb=' },
  { n:'23Embed', b:'https://23embed.com/tv/' },
  { n:'FilmEmbed', b:'https://filmembed.net/tv/' },
  { n:'MoviesAPI', b:'https://moviesapi.club/tv/' },
  { n:'VidEasy', b:'https://v2.vidsrc.me/src/embed/?tmdb=' },
  { n:'RuVid', b:'https://ruvid.net/embed/tv/' },
  { n:'SuperEmbed', b:'https://multiembed.mov/directstream.php?video_id=' },
  { n:'EmbedVid', b:'https://embed.vidsrc.me/tv/' },
  { n:'VidCloud', b:'https://mzzcloud.life/embed/tv/' }
];

function movieSrc(id) {
  return PROVIDERS.map((p, i) => ({ id: i, name: p.n, quality: 'HD', url: p.b + id, health: 'ok', latency: 9999 }));
}

function tvSrc(id, s, e) {
  return TV_PROVIDERS.map((p, i) => {
    let url;
    if (p.s) url = p.b.replace('tmdb=', `tmdb=${id}&season=${s}&episode=${e}`);
    else if (p.b.includes('video_id=')) url = p.b + id;
    else url = p.b + `${id}/${s}/${e}`;
    return { id: i, name: p.n, quality: 'HD', url, health: 'ok', latency: 9999 };
  });
}

app.get('/api/movie/:id/sources', (req, res) => {
  res.json({ sources: movieSrc(req.params.id) });
});

// ═══ TV ═══
app.get('/api/tv/trending', async (req, res) => {
  try {
    const p = req.query.page || 1;
    const ck = `tvt:${p}`;
    const c = cacheGet(ck, 1800000);
    if (c) return res.json(c);
    const d = await tmdb('/trending/tv/week', { page: p });
    const o = { results: (d.results || []).map(mMovie) };
    cacheSet(ck, o);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/search', async (req, res) => {
  try {
    const { q, page = 1 } = req.query;
    if (!q) return res.json({ results: [] });
    const d = await tmdb('/search/tv', { query: q, page });
    res.json({ results: (d.results || []).map(mMovie) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
  try {
    const ck = `tv:${req.params.id}`;
    const c = cacheGet(ck, 7200000);
    if (c) return res.json(c);
    const d = await tmdb(`/tv/${req.params.id}`, { append_to_response: 'videos,credits,similar' });
    const o = mDetail(d);
    o.type = 'tv';
    const trailers = (d.videos?.results || []).filter(v => v.site === 'YouTube' && v.type === 'Trailer');
    if (trailers.length) o.trailer = { url: `https://www.youtube.com/watch?v=${trailers[0].key}` };
    o.cast = (d.credits?.cast || []).slice(0, 12).map(c => ({ id: c.id, name: c.name, character: c.character, photo: IMG(c.profile_path, 185) }));
    o.similar = (d.similar?.results || []).slice(0, 12).map(mMovie);
    cacheSet(ck, o);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/season/:num', async (req, res) => {
  try {
    const { id, num } = req.params;
    const ck = `tvs:${id}:${num}`;
    const c = cacheGet(ck, 3600000);
    if (c) return res.json(c);
    const d = await tmdb(`/tv/${id}/season/${num}`);
    const o = {
      season_number: d.season_number,
      episodes: (d.episodes || []).map(e => ({
        number: e.episode_number, title: e.name || '', air_date: e.air_date || '',
        overview: e.overview || '', thumb: e.still_path ? IMG(e.still_path, 300) : null
      }))
    };
    cacheSet(ck, o);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const d = await tmdb(`/tv/${id}/season/${season}/episode/${episode}`);
    const sources = tvSrc(id, season, episode);
    let next = null;
    try {
      const nd = await tmdb(`/tv/${id}/season/${season}/episode/${+episode + 1}`);
      if (nd && nd.episode_number) next = { season: +season, episode: nd.episode_number, title: nd.name };
    } catch {
      try {
        const nd2 = await tmdb(`/tv/${id}/season/${+season + 1}/episode/1`);
        if (nd2 && nd2.episode_number) next = { season: +season + 1, episode: nd2.episode_number, title: nd2.name };
      } catch {}
    }
    res.json({ title: d.name || `S${season} E${episode}`, air_date: d.air_date || '', overview: d.overview || '', sources, next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ ADULT ═══
const ADULT_SRC = ['xvideos', 'xnxx', 'spankbang', 'eporner', 'redtube'];

async function scXV(q, p) {
  try {
    const r = await axios.get(`https://www.xvideos.com/?k=${encodeURIComponent(q)}&p=${(p||1)-1}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const out = [];
    $('div.thumb-under a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim().slice(0, 120);
      if (href.includes('/video')) {
        const id = href.match(/video(\d+)/)?.[1] || href;
        out.push({ id: `xv-${id}`, title, source: 'xvideos', url: `https://www.xvideos.com${href}`, duration: '', views: '' });
      }
    });
    return out.slice(0, 20);
  } catch { return []; }
}

async function scXN(q, p) {
  try {
    const r = await axios.get(`https://www.xnxx.com/search/${encodeURIComponent(q)}/${p||1}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const out = [];
    $('div.thumb-under a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim().slice(0, 120);
      if (href.includes('/video')) {
        const id = href.match(/video(\d+)/)?.[1] || href;
        out.push({ id: `xnxx-${id}`, title, source: 'xnxx', url: `https://www.xnxx.com${href}`, duration: '', views: '' });
      }
    });
    return out.slice(0, 20);
  } catch { return []; }
}

async function scSB(q, p) {
  try {
    const r = await axios.get(`https://spankbang.com/s/${encodeURIComponent(q)}/${p||1}/`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const out = [];
    $('div.video-item a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).attr('title') || $(el).text().trim().slice(0, 120);
      if (href.includes('/video')) out.push({ id: `sb-${href.replace(/\D/g, '')}`, title, source: 'spankbang', url: `https://spankbang.com${href}`, duration: '', views: '' });
    });
    return out.slice(0, 20);
  } catch { return []; }
}

async function scEP(q, p) {
  try {
    const r = await axios.get(`https://www.eporner.com/search/${encodeURIComponent(q)}/${p||1}/`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const out = [];
    $('div.mb a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).attr('title') || $(el).text().trim().slice(0, 120);
      if (href.includes('/video-')) {
        const id = href.match(/video-([^/]+)/)?.[1] || href;
        out.push({ id: `ep-${id}`, title, source: 'eporner', url: `https://www.eporner.com${href}`, duration: '', views: '' });
      }
    });
    return out.slice(0, 20);
  } catch { return []; }
}

async function scRT(q, p) {
  try {
    const r = await axios.get(`https://www.redtube.com/?search=${encodeURIComponent(q)}&page=${p||1}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
    const $ = cheerio.load(r.data);
    const out = [];
    $('[class*="video-item"] a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).attr('title') || $(el).text().trim().slice(0, 120);
      if (/\/\d+/.test(href)) {
        const id = href.match(/\/(\d+)/)?.[1] || href;
        out.push({ id: `rt-${id}`, title, source: 'redtube', url: `https://www.redtube.com${href}`, duration: '', views: '' });
      }
    });
    return out.slice(0, 20);
  } catch { return []; }
}

const SCRAPERS = { xvideos: scXV, xnxx: scXN, spankbang: scSB, eporner: scEP, redtube: scRT };

async function multiSc(q, src, pg) {
  src = src || 'all'; pg = pg || 1;
  if (src !== 'all' && SCRAPERS[src]) return await SCRAPERS[src](q, pg);
  const r = await Promise.allSettled(ADULT_SRC.map(s => SCRAPERS[s](q, pg)));
  const out = [];
  const max = Math.max(...r.map(x => x.status === 'fulfilled' ? x.value.length : 0));
  for (let i = 0; i < max; i++) for (const x of r) if (x.status === 'fulfilled' && x.value[i]) out.push(x.value[i]);
  return out.slice(0, 40);
}

app.get('/api/adult/trending', async (req, res) => {
  try { res.json({ results: await multiSc('hot', req.query.source, req.query.page), source: req.query.source || 'all' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/search', async (req, res) => {
  try {
    const { q, source, page } = req.query;
    if (!q) return res.json({ results: [] });
    res.json({ results: await multiSc(q, source, page), query: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/category/:cat', async (req, res) => {
  try { res.json({ results: await multiSc(req.params.cat, req.query.source, req.query.page), category: req.params.cat }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/performer/:name', async (req, res) => {
  try { res.json({ results: await multiSc(req.params.name, req.query.source, req.query.page), performer: req.params.name }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adult/video/:source/:id', (req, res) => {
  const { source, id } = req.params;
  const urls = {
    xvideos: `https://www.xvideos.com/video${id}`,
    xnxx: `https://www.xnxx.com/video${id}`,
    spankbang: `https://spankbang.com/${id}/video/`,
    eporner: `https://www.eporner.com/video-${id}/`,
    redtube: `https://www.redtube.com/${id}`
  };
  res.json({ title: `${source} Video`, source, url: urls[source] || id, thumb: '', duration: '', views: '', sources: [{ name: 'Primary', quality: 'HD', url: urls[source] || id }] });
});

// ═══ 4K / TORRENT ═══
async function yts(q) {
  try {
    const r = await axios.get(`https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=5`, { timeout: 8000 });
    return (r.data?.data?.movies || []).map(m => ({
      quality: m.quality?.join(', ') || 'HD', size: m.torrents?.[0]?.size || '?', seeds: m.torrents?.[0]?.seeds || 0, source: 'YTS',
      magnet: m.torrents?.[0]?.hash ? `magnet:?xt=urn:btih:${m.torrents[0].hash}&dn=${encodeURIComponent(m.title_english || m.title)}` : null,
      detailUrl: m.torrents?.[0]?.url || null
    }));
  } catch { return []; }
}

async function sc1337x(q) {
  try {
    const r = await axios.get(`https://1337x.to/search/${encodeURIComponent(q)}/1/`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const $ = cheerio.load(r.data);
    const out = [];
    $('table.table-list tbody tr').each((_, el) => {
      const $el = $(el);
      const name = $el.find('td.coll-1 a:last-child').text().trim();
      const href = $el.find('td.coll-1 a:last-child').attr('href') || '';
      const seeds = parseInt($el.find('td.coll-2').text().trim()) || 0;
      const size = $el.find('td.coll-4').text().trim() || '?';
      const qual = /2160|4k/i.test(name) ? '4K' : /1080/i.test(name) ? '1080p' : 'HD';
      out.push({ quality: qual, size, seeds, source: '1337x', magnet: null, detailUrl: href.startsWith('http') ? href : `https://1337x.to${href}` });
    });
    return out.slice(0, 5);
  } catch { return []; }
}

async function searchAllT(q) {
  const r = await Promise.allSettled([yts(q), sc1337x(q)]);
  const out = [];
  r.forEach(x => { if (x.status === 'fulfilled' && Array.isArray(x.value)) out.push(...x.value); });
  out.sort((a, b) => {
    const qa = a.quality === '4K' ? 2 : a.quality === '1080p' ? 1 : 0;
    const qb = b.quality === '4K' ? 2 : b.quality === '1080p' ? 1 : 0;
    if (qa !== qb) return qb - qa;
    return (b.seeds || 0) - (a.seeds || 0);
  });
  return out;
}

app.get('/api/movie/:id/4k', async (req, res) => {
  try {
    let q = req.query.q;
    if (!q) {
      try {
        const d = await tmdb(`/movie/${req.params.id}`);
        q = `${d.title} ${d.release_date?.slice(0, 4) || ''}`;
      } catch { return res.json({ results: [] }); }
    }
    res.json({ results: await searchAllT(q), query: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode/4k', async (req, res) => {
  try { res.json({ results: req.query.q ? await searchAllT(req.query.q) : [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ SYSTEM ═══
app.get('/api/debrid/status', (_req, res) => {
  res.json({ enabled: !!process.env.REAL_DEBRID_TOKEN, provider: 'none' });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cache: db.prepare('SELECT COUNT(*) as c FROM cache').get().c });
});

app.post('/api/cache/clear', (_req, res) => {
  try { db.exec('DELETE FROM cache'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs', (_req, res) => {
  res.json({
    name: 'MovieBox API', version: '3.1',
    routes: [
      'GET /api/movies/trending?page=N',
      'GET /api/movies/search?q=Q&page=N',
      'GET /api/movies/genre/:name?page=N',
      'GET /api/movie/:id',
      'GET /api/movie/:id/sources',
      'GET /api/movie/:id/trailer',
      'GET /api/movie/:id/similar',
      'GET /api/movie/:id/4k?q=TITLE',
      'GET /api/tv/trending?page=N',
      'GET /api/tv/search?q=Q&page=N',
      'GET /api/tv/:id',
      'GET /api/tv/:id/season/:num',
      'GET /api/tv/:id/:season/:episode',
      'GET /api/tv/:id/:season/:episode/4k?q=TITLE',
      'GET /api/adult/trending?source=all&page=N',
      'GET /api/adult/search?q=Q&source=all&page=N',
      'GET /api/adult/category/:cat?source=all&page=N',
      'GET /api/adult/performer/:name?source=all&page=N',
      'GET /api/adult/video/:source/:id',
      'GET /api/debrid/status',
      'GET /api/health',
      'POST /api/cache/clear'
    ]
  });
});

// ── Serve frontend ──
app.use(express.static(__dirname));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MovieBox running on port ${PORT}`));
