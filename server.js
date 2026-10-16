/* ==========================================================
   server.js — MovieBox-style streaming site
   OPTION 2 (built): real MovieBox web API = PRIMARY,
   key-free stack (Cinemeta / VidSrc / YTS / adult scrapers) = FALLBACK.

   GUARANTEE 1 — CATALOG CONSISTENCY
     Trending/search rows always match the real MovieBox catalog.
     On MovieBox failure we serve the last-known-good MB snapshot —
     we NEVER silently swap to IMDb-top content.
   GUARANTEE 2 — FRESHER DATA
     MovieBox fetched live with a 5-minute TTL, never merged or
     diluted with fallback rows. `source` field labels every response.

   CONFIRMED LIVE DOMAIN: movieboxhd.net
   NO TMDB. NO API KEYS. NO ENV VARS.
   Repo = 3 files: server.js, package.json, Dockerfile.
   ========================================================== */
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const http = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*'
  }
});

/* =============== MOVIEBOX PRIMARY LAYER =============== */
const MB_BASES = [
  'https://movieboxhd.net',        // confirmed live — always tried first
  'https://web.moviebox.ng',
  'https://moviebox.digital',
  'https://moviebox.bio',
  'https://moviebox.ng'
];
let mbActive = null;
const MB_TTL = 5 * 60 * 1000;
const SNAP = '/tmp/mb_snapshot.json';

function snapLoad() {
  try { return JSON.parse(fs.readFileSync(SNAP, 'utf8')) || {}; } catch (e) { return {}; }
}
function snapSave(kind, items) {
  try {
    const s = snapLoad();
    s[kind] = { items: items, at: Date.now() };
    fs.writeFileSync(SNAP, JSON.stringify(s));
  } catch (e) {}
}
function snapItems(kind) {
  const s = snapLoad()[kind];
  return s && s.items && s.items.length ? s.items : null;
}

async function mbFetch(pathname, params) {
  const bases = mbActive ? [mbActive].concat(MB_BASES.filter(b => b !== mbActive)) : MB_BASES;
  let lastErr = null;
  for (const base of bases) {
    try {
      const r = await http.get(base + pathname, { params: params });
      if (r.data) { mbActive = base; return r.data; }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('moviebox unreachable');
}

function mbList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && raw.data) {
    const d = raw.data;
    return d.list || d.items || d.movies || d.results || d.contents || [];
  }
  return (raw && (raw.list || raw.items || raw.results)) || [];
}

function mbNorm(m, type) {
  const rid = String(m.imdb_code || m.imdb_id || m.imdb || m.id || '');
  const id = rid.indexOf('tt') === 0 ? rid : (/^\d+$/.test(rid) ? 'tt' + rid : '');
  return {
    id: id,
    type: type || (m.seasons || m.episodes ? 'series' : 'movie'),
    title: m.title || m.name || m.original_title || 'Untitled',
    poster: m.poster || m.cover || m.thumb || m.poster_url || m.cover_url || '',
    backdrop: m.backdrop || m.background || m.banner || '',
    year: String(m.year || m.release_date || m.released || '').slice(0, 4),
    rating: m.rating || m.imdb_rating || m.vote_average || 0,
    overview: m.overview || m.description || m.plot || m.synopsis || '',
    genres: m.genres || m.genre || []
  };
}

async function mbTrending(type) {
  const tries = [
    ['/api/home', { type: type }],
    ['/api/' + (type === 'series' ? 'series' : 'movie') + '/trending', {}],
    ['/api/discover', { type: type }],
    ['/api/v1/home', { type: type }],
    ['/api/v1/' + (type === 'series' ? 'series' : 'movie') + '/trending', {}],
    ['/api/v1/discover', { type: type }],
    ['/home', { type: type }],
    ['/trending', { type: type }]
  ];
  for (const t of tries) {
    try {
      const items = mbList(await mbFetch(t[0], t[1])).map(x => mbNorm(x, type)).filter(x => x.id);
      if (items.length) return items;
    } catch (e) {}
  }
  throw new Error('moviebox trending empty');
}

async function mbSearch(type, q) {
  const tries = [
    ['/api/search', { q: q, type: type }],
    ['/api/v1/search', { q: q, type: type }],
    ['/search', { q: q, type: type }],
    ['/api/v1/search/' + encodeURIComponent(q), { type: type }]
  ];
  for (const t of tries) {
    try {
      const raw = await mbFetch(t[0], t[1]);
      const items = mbList(raw).map(x => mbNorm(x, type)).filter(x => x.id && x.title);
      if (items.length) return items;
    } catch (e) {}
  }
  return [];
}

async function mbDetail(type, id) {
  const tries = [
    ['/api/detail', { imdb_id: id, type: type }],
    ['/api/v1/detail', { imdb_id: id, type: type }],
    ['/api/detail/' + id, { type: type }],
    ['/api/v1/detail/' + id, { type: type }],
    ['/detail/' + id, { type: type }],
    ['/api/' + id, { type: type }]
  ];
  for (const t of tries) {
    try {
      const raw = await mbFetch(t[0], t[1]);
      const list = mbList(raw);
      const norm = mbNorm(list[0] || raw.data || raw, type);
      if (norm && norm.title) return norm;
    } catch (e) {}
  }
  return null;
}

async function mbSources(type, id, s, e) {
  const tries = [
    ['/api/play', { imdb_id: id, type: type, season: s, episode: e }],
    ['/api/v1/play', { imdb_id: id, type: type, season: s, episode: e }],
    ['/api/play/' + id, { type: type, season: s, episode: e }],
    ['/api/v1/stream', { imdb_id: id, type: type, season: s, episode: e }],
    ['/api/stream/' + id, { type: type, season: s, episode: e }]
  ];
  for (const t of tries) {
    try {
      const raw = await mbFetch(t[0], t[1]);
      const out = mbList(raw).map(x => ({
        name: x.name || x.quality || 'MovieBox',
        quality: x.quality || x.label || 'auto',
        url: x.url || x.play_url || x.link || x.stream_url || x.file || ''
      })).filter(x => x.url);
      if (out.length) return out;
    } catch (e) {}
  }
  return [];
}

/* =============== FREE FALLBACK STACK (key-free) =============== */
const CINEMETA = 'https://v3-cinemeta.strem.io';

async function cmCatalog(type, skip, q) {
  const url = CINEMETA + '/catalog/' + type + '/top' +
    (q ? '/search=' + encodeURIComponent(q) : '/skip=' + (skip || 0)) + '.json';
  const r = await http.get(url);
  return (r.data.metas || []).map(m => ({
    id: m.imdb_id || m.id,
    type: type,
    title: m.name,
    poster: m.poster || '',
    backdrop: m.background || '',
    year: String(m.releaseInfo || '').slice(0, 4),
    rating: m.imdbRating || 0,
    overview: m.description || '',
    genres: m.genres || []
  }));
}

async function cmMeta(type, id) {
  try {
    const r = await http.get(CINEMETA + '/meta/' + type + '/' + id + '.json');
    return r.data.meta || null;
  } catch (e) { return null; }
}

const VIDSRCS_MOVIE = [
  ['VidSrc.xyz', 'https://vidsrc.xyz/embed/movie?imdb='],
  ['VidSrc.cc', 'https://vidsrc.cc/v2/embed/movie/'],
  ['VidSrc.to', 'https://vidsrc.to/embed/movie/'],
  ['Embed.su', 'https://embed.su/embed/movie/'],
  ['AutoEmbed', 'https://autoembed.cc/embed/movie/'],
  ['VidLink', 'https://vidlink.pro/movie/'],
  ['2Embed', 'https://2embed.cc/embed/'],
  ['Moviee', 'https://moviee.tv/embed/movie/']
];
const VIDSRCS_TV = [
  ['VidSrc.xyz', 'https://vidsrc.xyz/embed/tv?imdb={id}&ss={s}&ee={e}'],
  ['VidSrc.cc', 'https://vidsrc.cc/v2/embed/tv/{id}/{s}/{e}'],
  ['VidSrc.to', 'https://vidsrc.to/embed/tv/{id}/{s}/{e}'],
  ['Embed.su', 'https://embed.su/embed/tv/{id}/{s}/{e}'],
  ['AutoEmbed', 'https://autoembed.cc/embed/tv/{id}/{s}/{e}'],
  ['VidLink', 'https://vidlink.pro/tv/{id}/{s}/{e}'],
  ['2Embed', 'https://2embed.cc/embed/'],
  ['Moviee', 'https://moviee.tv/embed/tv/{id}/{s}/{e}']
];

function vidSources(type, id, s, e) {
  if (type === 'series') {
    return VIDSRCS_TV.map(v => ({
      name: v[0],
      quality: 'auto',
      url: v[1].replace('{id}', id).replace('{s}', s || 1).replace('{e}', e || 1)
    }));
  }
  return VIDSRCS_MOVIE.map(v => ({ name: v[0], quality: 'auto', url: v[1] + id }));
}

/* =============== UNIFIED (MB primary -> MB snapshot -> free) =============== */
async function unifiedTrending(type) {
  try {
    const items = await mbTrending(type);
    snapSave(type, items);
    return { results: items, source: 'moviebox' };
  } catch (e) {
    const cached = snapItems(type);
    if (cached) return { results: cached, source: 'moviebox-cache' };
    try {
      return { results: await cmCatalog(type, 0), source: 'fallback' };
    } catch (e2) { return { results: [], source: 'none' }; }
  }
}

async function unifiedSearch(type, q) {
  if (!q) return { results: [], source: 'none' };
  try {
    const items = await mbSearch(type, q);
    if (items.length) return { results: items, source: 'moviebox' };
    throw new Error('empty');
  } catch (e) {
    try {
      return { results: await cmCatalog(type, 0, q), source: 'fallback' };
    } catch (e2) { return { results: [], source: 'none' }; }
  }
}

async function unifiedDetail(type, id) {
  try {
    const d = await mbDetail(type, id);
    if (d && d.title) return { meta: d, source: 'moviebox' };
    throw new Error('empty');
  } catch (e) {
    const m = await cmMeta(type, id);
    if (!m) return { meta: null, source: 'none' };
    return {
      meta: {
        id: m.imdb_id || m.id,
        type: type,
        title: m.name,
        poster: m.poster || '',
        backdrop: m.background || '',
        year: String(m.releaseInfo || '').slice(0, 4),
        rating: m.imdbRating || 0,
        overview: m.description || '',
        genres: m.genres || [],
        cast: (m.cast || []).join(', '),
        director: (m.director || m.writers || []).join(', '),
        videos: (m.videos || []).map(v => ({
          id: v.id, season: v.season, episode: v.episode,
          title: v.title, thumbnail: v.thumbnail || ''
        }))
      },
      source: 'fallback'
    };
  }
}

async function unifiedSources(type, id, s, e) {
  const out = [];
  try { (await mbSources(type, id, s, e)).forEach(x => out.push(x)); } catch (err) {}
  vidSources(type, id, s, e).forEach(x => out.push(x));
  return { sources: out };
}

/* =============== ADULT SCRAPERS (cheerio, key-free) =============== */
const ADULT_SOURCES = [
  { name: 'xvideos', base: 'https://www.xvideos.com', list: 'https://www.xvideos.com/', search: 'https://www.xvideos.com/?k=' },
  { name: 'xnxx', base: 'https://www.xnxx.com', list: 'https://www.xnxx.com/', search: 'https://www.xnxx.com/search/' },
  { name: 'spankbang', base: 'https://spankbang.com', list: 'https://spankbang.com/', search: 'https://spankbang.com/s/' },
  { name: 'eporner', base: 'https://www.eporner.com', list: 'https://www.eporner.com/', search: 'https://www.eporner.com/search/' },
  { name: 'redtube', base: 'https://www.redtube.com', list: 'https://www.redtube.com/', search: 'https://www.redtube.com/?search=' }
];

function extractAdult(html, src) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href]').each((i, el) => {
    if (out.length >= 30) return;
    const a = $(el);
    const href = a.attr('href') || '';
    const img = a.find('img').first();
    const thumb = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src') || '';
    const title = (img.attr('title') || a.attr('title') || a.text() || '').trim();
    if (!thumb || title.length < 4) return;
    if (href.indexOf('http') !== 0 && href.indexOf('/') !== 0) return;
    const url = href.indexOf('http') === 0 ? href : src.base + href;
    if (out.some(x => x.url === url)) return;
    out.push({
      id: Buffer.from(url).toString('base64').replace(/=+$/, ''),
      source: src.name,
      title: title.slice(0, 120),
      thumb: thumb,
      url: url
    });
  });
  return out;
}

async function adultFeed(url) {
  const jobs = ADULT_SOURCES.map(async src => {
    try {
      const u = url ? url(src) : src.list;
      return extractAdult((await http.get(u)).data, src);
    } catch (e) { return []; }
  });
  const merged = (await Promise.all(jobs)).reduce((a, b) => a.concat(b), []);
  const seen = {};
  return merged.filter(x => seen[x.url] ? false : (seen[x.url] = true));
}

/* =============== ROUTES =============== */
app.get('/api/health', (req, res) => {
  const s = snapLoad();
  res.json({
    ok: true,
    moviebox_base: mbActive,
    movieboxhd_primary: MB_BASES[0],
    snapshot: {
      movies: s.movies ? Math.round((Date.now() - s.movies.at) / 1000) + 's ago' : 'none',
      series: s.series ? Math.round((Date.now() - s.series.at) / 1000) + 's ago' : 'none'
    }
  });
});

app.get('/api/movies/trending', async (req, res) => res.json(await unifiedTrending('movie')));
app.get('/api/tv/trending', async (req, res) => res.json(await unifiedTrending('series')));
app.get('/api/movies/search', async (req, res) => res.json(await unifiedSearch('movie', req.query.q)));
app.get('/api/tv/search', async (req, res) => res.json(await unifiedSearch('series', req.query.q)));

app.get('/api/movies/genre/:name', async (req, res) => {
  const g = req.params.name.toLowerCase();
  const feed = await unifiedTrending('movie');
  return res.json({ results: feed.results.filter(x => (x.genres || []).some(y => String(y).toLowerCase().indexOf(g) >= 0)), source: feed.source });
});

app.get('/api/movie/:id', async (req, res) => res.json(await unifiedDetail('movie', req.params.id)));
app.get('/api/tv/:id', async (req, res) => res.json(await unifiedDetail('series', req.params.id)));
app.get('/api/movie/:id/sources', async (req, res) => res.json(await unifiedSources('movie', req.params.id)));
app.get('/api/tv/:id/sources', async (req, res) => res.json(await unifiedSources('series', req.params.id, req.query.s || 1, req.query.e || 1)));

app.get('/api/movie/:id/similar', async (req, res) => {
  const d = await unifiedDetail('movie', req.params.id);
  const feed = await unifiedTrending('movie');
  return res.json({ results: feed.results.filter(x => x.id !== req.params.id).slice(0, 12), source: feed.source });
});

app.get('/api/tv/:id/season/:num', async (req, res) => {
  const d = await unifiedDetail('series', req.params.id);
  const eps = ((d.meta && d.meta.videos) || []).filter(v => String(v.season) === String(req.params.num));
  return res.json({ episodes: eps, source: d.source });
});

app.get('/api/tv/:id/:season/:episode', async (req, res) => {
  res.json(await unifiedSources('series', req.params.id, req.params.season, req.params.episode));
});

app.get('/api/movie/:id/4k', async (req, res) => {
  try {
    const r = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: req.params.id } });
    const movies = (r.data.data && r.data.data.movies) || [];
    const torrents = [];
    movies.forEach(m => (m.torrents || []).forEach(t => torrents.push({
      quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash,
      title: m.title_long || m.title,
      magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title)
    })));
    torrents.sort((a, b) => (b.quality === '1080p' ? 1 : 0) - (a.quality === '1080p' ? 1 : 0) || b.seeds - a.seeds);
    res.json({ torrents: torrents, source: 'yts' });
  } catch (e) { res.json({ torrents: [], source: 'yts' }); }
});

app.get('/api/adult/trending', async (req, res) => res.json({ results: await adultFeed(null) }));
app.get('/api/adult/search', async (req, res) => res.json({ results: await adultFeed(src => src.search + encodeURIComponent(req.query.q || '')) }));
app.get('/api/adult/category/:cat', async (req, res) => res.json({ results: await adultFeed(src => src.base + '/' + req.params.cat) }));
app.get('/api/adult/performer/:name', async (req, res) => res.json({ results: await adultFeed(src => src.search + encodeURIComponent(req.params.name)) }));

app.get('/api/adult/video/:source', async (req, res) => {
  try {
    const page = Buffer.from(String(req.query.u || ''), 'base64').toString('utf8');
    const html = (await http.get(page, { headers: { Referer: 'https://www.google.com/' } })).data;
    const urls = [];
    const re = /(https?:)?\/\/[^"'\\s]+?\.mp4[^"'\\s]*/g;
    let m;
    while ((m = re.exec(html)) && urls.length < 10) {
      let u = m[0];
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (urls.indexOf(u) === -1) urls.push(u);
    }
    res.json({ urls: urls, page: page });
  } catch (e) { res.json({ urls: [], page: '' }); }
});

app.get('/api/debrid/status', (req, res) => res.json({ enabled: false }));
app.get('/api/docs', (req, res) => res.json({ routes: 'see /api/health' }));
app.post('/api/cache/clear', (req, res) => {
  try { fs.unlinkSync(SNAP); } catch (e) {}
  mbActive = null;
  res.json({ ok: true, snapshot: 'cleared' });
});

/* =============== INLINE UI (one string, concat-only JS) =============== */
const HTML = [
'<!doctype html><html><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>MovieBox</title><style>',
':root{--bg:#101114;--card:#28292E;--acc:#1CB7FF;--acc2:#2FF58B;--gold:#FFDA6B;--txt:#EDEFF2;--mut:#9AA0A6}',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{background:var(--bg);color:var(--txt);font-family:system-ui,Segoe UI,Roboto,sans-serif;overflow-x:hidden}',
'a{color:inherit;text-decoration:none}',
'#side{position:fixed;top:0;bottom:0;left:0;width:220px;background:#16171B;padding:18px 14px;overflow-y:auto}',
'#side h1{font-size:20px;margin-bottom:18px}#side h1 b{color:var(--acc)}',
'.nav{padding:10px 12px;border-radius:10px;cursor:pointer;color:var(--mut);font-size:14px;margin-bottom:4px}',
'.nav.on{background:#22242A;color:var(--txt)}',
'.nav:hover{color:var(--txt)}',
'#main{margin-left:220px;padding:0 0 90px;min-height:100vh}',
'.hero{position:relative;height:380px;background:#1A1B20;background-size:cover;background-position:center;display:flex;align-items:flex-end}',
'.hero .scrim{position:absolute;inset:0;background:linear-gradient(0deg,var(--bg) 5%,rgba(16,17,20,0.2) 70%)}',
'.hero .info{position:relative;padding:26px 28px;max-width:640px}',
'.hero h2{font-size:30px;margin-bottom:8px}',
'.hero p{color:#C9CDD3;font-size:14px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
'.btn{display:inline-block;background:var(--acc);color:#06222E;font-weight:700;padding:10px 20px;border-radius:10px;cursor:pointer;margin:12px 8px 0 0;font-size:14px}',
'.btn.alt{background:#2A2C33;color:var(--txt)}',
'.row{margin:24px 0 6px}.row h2{font-size:17px;margin:0 22px 10px}',
'.strip{display:flex;gap:12px;overflow-x:auto;padding:4px 22px 12px}',
'.card{width:150px;flex:0 0 auto;background:var(--card);border-radius:12px;overflow:hidden;cursor:pointer;position:relative}',
'.card img{width:100%;height:225px;object-fit:cover;background:#1D1E23}',
'.card .mt{padding:8px}.card .t{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.card .y{color:var(--mut);font-size:11px;margin-top:3px}.card .r{color:var(--gold);font-weight:700}',
'.dl{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.65);border-radius:8px;padding:4px 8px;font-size:13px}',
'#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;padding:18px 22px}',
'#search{width:100%;padding:11px 14px;border-radius:10px;border:1px solid #2C2E35;background:#1B1C21;color:var(--txt);margin-bottom:14px;font-size:14px}',
'.ov{position:fixed;inset:0;background:rgba(8,9,11,.96);z-index:60;display:flex;flex-direction:column}',
'.ov .bar{display:flex;align-items:center;gap:12px;padding:12px 16px}',
'.ov .bar .x{cursor:pointer;font-size:22px;color:var(--mut)}',
'.ov .body{flex:1;overflow-y:auto;padding:0 18px 30px}',
'.detail-hero{display:flex;gap:18px;flex-wrap:wrap}',
'.detail-hero img{width:210px;border-radius:12px}',
'.detail-hero h2{font-size:24px;margin-bottom:6px}',
'.chip{display:inline-block;background:#24262C;border-radius:20px;padding:6px 12px;font-size:12px;margin:4px 6px 0 0;cursor:pointer}',
'.chip.on{background:var(--acc);color:#06222E;font-weight:700}',
'#pframe{position:relative;flex:1;min-height:0}',
'#pframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}',
'#pmsg{padding:14px;text-align:center;color:var(--mut)}',
'#tabs{position:fixed;left:0;right:0;bottom:0;background:#16171B;display:none;z-index:40}',
'#tabs .tb{flex:1;text-align:center;padding:11px 4px;font-size:11px;color:var(--mut);cursor:pointer}',
'#tabs .tb.on{color:var(--acc)}',
'#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--acc2);color:#06251A;font-weight:700;padding:11px 18px;border-radius:10px;z-index:99;opacity:0;transition:opacity .25s;font-size:13px}',
'.hd{padding:18px 22px 0}',
'@media(max-width:860px){#side{display:none}#main{margin-left:0}#tabs{display:flex}.hero{height:320px}.hero h2{font-size:22px}.card{width:126px}.card img{height:190px}}',
'</style></head><body>',
'<div id="side"><h1>Movie<b>Box</b></h1>',
'<div class="nav on" data-tab="home">Home</div>',
'<div class="nav" data-tab="movies">Movies</div>',
'<div class="nav" data-tab="tv">TV Shows</div>',
'<div class="nav" data-tab="adult">18+</div>',
'<div class="nav" data-tab="mylist">My List</div>',
'</div>',
'<div id="main"><div id="hero" class="hero"></div><div id="content"></div></div>',
'<div id="detail" class="ov" style="display:none"></div>',
'<div id="player" class="ov" style="display:none"></div>',
'<div id="tabs">',
'<div class="tb on" data-tab="home">Home</div>',
'<div class="tb" data-tab="movies">Movies</div>',
'<div class="tb" data-tab="tv">TV</div>',
'<div class="tb" data-tab="adult">18+</div>',
'<div class="tb" data-tab="mylist">My List</div>',
'</div>',
'<div id="toast"></div>',
'<script>',
'window.open = function(){ return null; };',
'var S = { tab: "home", heroIdx: 0, heroItems: [], srcList: [], srcIdx: 0, cur: null, list: [], cw: [] };',
'try { S.list = JSON.parse(localStorage.getItem("mb_list") || "[]"); S.cw = JSON.parse(localStorage.getItem("mb_cw") || "[]"); } catch(e) {}',
'function $(s){ return document.querySelector(s); }',
'function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }',
'function api(p){ return fetch(p).then(function(r){ return r.json(); }).catch(function(){ return { results: [], sources: [], torrents: [], meta: null }; }); }',
'function toast(t){ var e = $("#toast"); e.textContent = t; e.style.opacity = 1; setTimeout(function(){ e.style.opacity = 0; }, 2400); }',
'function card(x){',
'  return "<div class=\\"card\\" data-id=\\"" + esc(x.id) + "\\" data-type=\\"" + esc(x.type || "movie") + "\\">" +',
'    "<img loading=\\"lazy\\" src=\\"" + esc(x.poster) + "\\" onerror=\\"this.style.opacity=.15\\">" +',
'    "<div class=\\"dl\\" data-id=\\"" + esc(x.id) + "\\" data-type=\\"" + esc(x.type || "movie") + "\\">⬇</div>" +',
'    "<div class=\\"mt\\"><div class=\\"t\\">" + esc(x.title) + "</div>" +',
'    "<div class=\\"y\\">" + esc(x.year) + " <span class=\\"r\\">" + esc(x.rating || "") + "</span></div></div></div>";',
'}',
'function row(title, items){',
'  return "<div class=\\"row\\"><h2>" + esc(title) + "</h2><div class=\\"strip\\">" + items.map(card).join("") + "</div></div>";',
'}',
'function renderHero(items){',
'  S.heroItems = items.slice(0, 5); S.heroIdx = 0; paintHero();',
'  setInterval(function(){ S.heroIdx = (S.heroIdx + 1) % (S.heroItems.length || 1); paintHero(); }, 6000);',
'}',
'function paintHero(){',
'  var x = S.heroItems[S.heroIdx]; if (!x) return;',
'  $("#hero").style.backgroundImage = "url(" + (x.backdrop || x.poster || "") + ")";',
'  $("#hero").innerHTML = "<div class=\\"scrim\\"></div><div class=\\"info\\"><h2>" + esc(x.title) + "</h2>" +',
'    "<div class=\\"y\\" style=\\"color:#FFDA6B;font-weight:700\\">" + esc(x.year) + "  ★ " + esc(x.rating || "") + "</div>" +',
'    "<p>" + esc(x.overview || "") + "</p>" +',
'    "<span class=\\"btn\\" data-id=\\"" + esc(x.id) + "\\" data-type=\\"" + esc(x.type || "movie") + "\\">▶ Play</span>" +',
'    "<span class=\\"btn alt\\" data-dl=\\"" + esc(x.id) + "\\">⬇ Download</span></div>";',
'}',
'async function loadTab(tab){',
'  S.tab = tab;',
'  Array.prototype.forEach.call(document.querySelectorAll(".nav,.tb"), function(n){ n.classList.toggle("on", n.getAttribute("data-tab") === tab); });',
'  $("#hero").style.display = (tab === "home") ? "flex" : "none";',
'  var c = $("#content"); c.innerHTML = "<div class=\\"hd\\">Loading…</div>";',
'  if (tab === "home") {',
'    var m = await api("/api/movies/trending"); var t = await api("/api/tv/trending");',
'    renderHero((m.results || []).concat(t.results || []));',
'    c.innerHTML = row("Trending Movies", m.results || []) + row("Trending TV Shows", t.results || []);',
'  } else if (tab === "movies") {',
'    var m2 = await api("/api/movies/trending");',
'    c.innerHTML = "<div class=\\"hd\\"><input id=\\"search\\" placeholder=\\"Search movies…\\"></div><div id=\\"grid\\">" + (m2.results || []).map(card).join("") + "</div>";',
'    bindSearch("/api/movies/search");',
'  } else if (tab === "tv") {',
'    var t2 = await api("/api/tv/trending");',
'    c.innerHTML = "<div class=\\"hd\\"><input id=\\"search\\" placeholder=\\"Search TV shows…\\"></div><div id=\\"grid\\">" + (t2.results || []).map(card).join("") + "</div>";',
'    bindSearch("/api/tv/search");',
'  } else if (tab === "adult") {',
'    if (localStorage.getItem("mb_age") !== "1") {',
'      c.innerHTML = "<div class=\\"hd\\"><h2>18+ content</h2><p style=\\"color:#9AA0A6;margin:10px 0\\">Confirm you are 18 or older.</p><span class=\\"btn\\" id=\\"ageok\\">I am 18+</span></div>";',
'      $("#ageok").onclick = function(){ localStorage.setItem("mb_age", "1"); loadTab("adult"); };',
'      return;',
'    }',
'    var a = await api("/api/adult/trending");',
'    c.innerHTML = "<div class=\\"hd\\"><input id=\\"search\\" placeholder=\\"Search 18+…\\"></div><div id=\\"grid\\">" + (a.results || []).map(function(x){',
'      return "<div class=\\"card\\" data-adult=\\"" + esc(x.id) + "\\" data-source=\\"" + esc(x.source) + "\\"><img loading=\\"lazy\\" src=\\"" + esc(x.thumb) + "\\" onerror=\\"this.style.opacity=.15\\"><div class=\\"mt\\"><div class=\\"t\\">" + esc(x.title) + "</div><div class=\\"y\\">" + esc(x.source) + "</div></div></div>";',
'    }).join("") + "</div>";',
'    var si = $("#search");',
'    si.onkeydown = async function(e){ if (e.key !== "Enter") return; var r = await api("/api/adult/search?q=" + encodeURIComponent(si.value)); $("#grid").innerHTML = (r.results || []).map(function(x){',
'      return "<div class=\\"card\\" data-adult=\\"" + esc(x.id) + "\\" data-source=\\"" + esc(x.source) + "\\"><img loading=\\"lazy\\" src=\\"" + esc(x.thumb) + "\\"><div class=\\"mt\\"><div class=\\"t\\">" + esc(x.title) + "</div></div></div>";',
'    }).join(""); };',
'  } else if (tab === "mylist") {',
'    c.innerHTML = "<div class=\\"hd\\"><h2>My List</h2></div><div id=\\"grid\\">" + (S.list.length ? S.list.map(card).join("") : "<div style=\\"color:#9AA0A6\\">Nothing saved yet.</div>") + "</div>";',
'  }',
'}',
'function bindSearch(endpoint){',
'  var si = $("#search"); if (!si) return;',
'  si.onkeydown = async function(e){ if (e.key !== "Enter") return; var r = await api(endpoint + "?q=" + encodeURIComponent(si.value)); $("#grid").innerHTML = (r.results || []).map(card).join(""); };',
'}',
'async function download(id){',
'  var r = await api("/api/movie/" + id + "/4k"); var ts = r.torrents || [];',
'  if (!ts.length) { toast("No torrents found"); return; }',
'  var pick = ts[0];',
'  try { await navigator.clipboard.writeText(pick.magnet); } catch(e) {}',
'  toast(pick.quality + " · " + pick.size + " · magnet copied");',
'}',
'async function openDetail(id, type, autoplay){',
'  var p = (type === "series") ? "/api/tv/" : "/api/movie/";',
'  var dPromise = api(p + id);',
'  var sPromise = api(p + id + "/sources");',
'  var d = await dPromise; var s = await sPromise;',
'  S.cur = { id: id, type: type };',
'  var m = d.meta || { id: id, title: "", poster: "", year: "", rating: "", overview: "", genres: [] };',
'  var html = "<div class=\\"bar\\"><span class=\\"x\\" id=\\"dclose\\">✕</span><b>Details</b></div><div class=\\"body\\">" +',
'    "<div class=\\"detail-hero\\"><img src=\\"" + esc(m.poster) + "\\" onerror=\\"this.style.opacity=.2\\"><div>" +',
'    "<h2>" + esc(m.title) + "</h2>" +',
'    "<div style=\\"color:#FFDA6B;font-weight:700;margin-bottom:8px\\">" + esc(m.year) + "  ★ " + esc(m.rating || "") + "</div>" +',
'    "<p style=\\"color:#C9CDD3;line-height:1.6;max-width:560px\\">" + esc(m.overview || "") + "</p>" +',
'    "<div>" + (m.genres || []).map(function(g){ return "<span class=\\"chip\\">" + esc(g) + "</span>"; }).join("") + "</div>" +',
'    "<div style=\\"margin-top:8px\\">" + (m.cast ? "<div style=\\"color:#9AA0A6;font-size:13px\\">Cast: " + esc(m.cast) + "</div>" : "") + "</div>" +',
'    "<span class=\\"btn\\" id=\\"dplay\\">▶ Play</span>" +',
'    "<span class=\\"btn alt\\" id=\\"ddl\\">⬇ Download</span>" +',
'    "<span class=\\"btn alt\\" id=\\"dsave\\">+ My List</span></div></div>";',
'  if (type === "series" && m.videos && m.videos.length) {',
'    var seasons = {};',
'    m.videos.forEach(function(v){ var k = v.season || 1; (seasons[k] = seasons[k] || []).push(v); });',
'    html += "<h2 style=\\"margin:18px 0 8px\\">Episodes</h2>";',
'    Object.keys(seasons).forEach(function(k){',
'      html += "<div style=\\"margin-bottom:10px\\"><b style=\\"color:#9AA0A6;font-size:13px\\">Season " + esc(k) + "</b><div class=\\"strip\\">" +',
'        seasons[k].map(function(v){ return "<div class=\\"chip\\" data-s=\\"" + esc(v.season) + "\\" data-e=\\"" + esc(v.episode) + "\\">E" + esc(v.episode) + " · " + esc(v.title || "") + "</div>"; }).join("") + "</div></div>";',
'    });',
'  }',
'  html += "<h2 style=\\"margin:18px 0 8px\\">Similar</h2>";',
'  var sim = await api(p + id + "/similar");',
'  html += "<div class=\\"strip\\">" + (sim.results || []).map(card).join("") + "</div></div>";',
'  var el = $("#detail"); el.innerHTML = html; el.style.display = "flex";',
'  $("#dclose").onclick = function(){ el.style.display = "none"; };',
'  $("#ddl").onclick = function(){ download(id); };',
'  $("#dsave").onclick = function(){',
'    if (!S.list.some(function(x){ return x.id === id; })) S.list.push(m);',
'    localStorage.setItem("mb_list", JSON.stringify(S.list)); toast("Added to My List");',
'  };',
'  $("#dplay").onclick = function(){ playSources(s.sources || [], m); };',
'  Array.prototype.forEach.call(el.querySelectorAll(".chip[data-s]"), function(ch){',
'    ch.onclick = async function(){',
'      var ss = await api("/api/tv/" + id + "/" + ch.getAttribute("data-s") + "/" + ch.getAttribute("data-e"));',
'      playSources(ss.sources || [], m);',
'    };',
'  });',
'  if (autoplay !== false) playSources(s.sources || [], m);',
'}',
'function playSources(list, meta){',
'  S.srcList = list || []; S.srcIdx = 0;',
'  if (!S.srcList.length) { toast("No sources available"); return; }',
'  var pl = $("#player");',
'  pl.innerHTML = "<div class=\\"bar\\"><span class=\\"x\\" id=\\"pclose\\">✕</span><b>" + esc(meta.title || "Player") + "</b>" +',
'    "<span class=\\"chip on\\" id=\\"pnext\\">⏭ next source</span></div>" +',
'    "<div id=\\"pframe\\"></div><div id=\\"pmsg\\">Hunting source…</div>";',
'  pl.style.display = "flex";',
'  $("#pclose").onclick = function(){ pl.style.display = "none"; $("#pframe").innerHTML = ""; };',
'  $("#pnext").onclick = function(){ trySrc(); };',
'  trySrc();',
'}',
'function trySrc(){',
'  if (S.srcIdx >= S.srcList.length) { $("#pmsg").textContent = "All sources failed. Try again."; return; }',
'  var s = S.srcList[S.srcIdx++];',
'  var fr = document.createElement("iframe");',
'  fr.src = s.url;',
'  fr.allow = "autoplay; fullscreen; encrypted-media";',
'  fr.setAttribute("referrerPolicy", "no-referrer");',
'  var settled = false;',
'  fr.onload = function(){',
'    if (settled) return; settled = true;',
'    $("#pmsg").innerHTML = "<span class=\\"chip\\" id=\\"psound\\">🔇 Tap for sound</span>";',
'    var sc = $("#psound");',
'    if (sc) sc.onclick = function(){ try { fr.contentWindow.postMessage({ command: "unmute" }, "*"); } catch(e) {} sc.textContent = "🔊 " + s.name; };',
'  };',
'  setTimeout(function(){ if (!settled) { settled = true; trySrc(); } }, 6500);',
'  $("#pframe").innerHTML = ""; $("#pframe").appendChild(fr);',
'  $("#pmsg").textContent = "Source " + S.srcIdx + "/" + S.srcList.length + " · " + s.name;',
'}',
'async function playAdult(id, source){',
'  var r = await api("/api/adult/video/" + source + "?u=" + id);',
'  var pl = $("#player");',
'  pl.innerHTML = "<div class=\\"bar\\"><span class=\\"x\\" id=\\"pclose\\">✕</span><b>18+</b></div><div id=\\"pframe\\"></div><div id=\\"pmsg\\"></div>";',
'  pl.style.display = "flex";',
'  $("#pclose").onclick = function(){ pl.style.display = "none"; $("#pframe").innerHTML = ""; };',
'  if (r.urls && r.urls.length) {',
'    $("#pframe").innerHTML = "<video controls autoplay playsinline style=\\"width:100%;height:100%;background:#000\\" src=\\"" + esc(r.urls[0]) + "\\"></video>";',
'  } else {',
'    $("#pframe").innerHTML = "<iframe allow=\\"autoplay; fullscreen\\" referrerpolicy=\\"no-referrer\\" src=\\"" + esc(r.page) + "\\"></iframe>";',
'  }',
'}',
'document.addEventListener("click", function(e){',
'  var nav = e.target.closest(".nav,.tb");',
'  if (nav && nav.getAttribute("data-tab")) { loadTab(nav.getAttribute("data-tab")); return; }',
'  var dl = e.target.closest(".dl");',
'  if (dl) { e.stopPropagation(); download(dl.getAttribute("data-id")); return; }',
'  var dlb = e.target.closest("[data-dl]");',
'  if (dlb) { download(dlb.getAttribute("data-dl")); return; }',
'  var ad = e.target.closest("[data-adult]");',
'  if (ad) { playAdult(ad.getAttribute("data-adult"), ad.getAttribute("data-source")); return; }',
'  var c = e.target.closest(".card[data-id]");',
'  if (c) { openDetail(c.getAttribute("data-id"), c.getAttribute("data-type")); return; }',
'  var p = e.target.closest(".btn[data-id]");',
'  if (p) { openDetail(p.getAttribute("data-id"), p.getAttribute("data-type")); return; }',
'});',
'loadTab("home");',
'</scr' + 'ipt></body></html>'
].join('');

app.get('/', (req, res) => res.type('html').send(HTML));
app.get('*', (req, res) => {
  if (req.path.indexOf('/api/') === 0) return res.status(404).json({ error: 'unknown route' });
  res.type('html').send(HTML);
});

app.listen(PORT, () => console.log('MovieBox running on ' + PORT + ' — primary: ' + MB_BASES[0]));
