/* ==========================================================
   server.js — MovieBox streaming site
   CATALOG: Cinemeta (fast, reliable, key-free)
   VIDEO: fzmovies.watch + VidSrc fallback
   DOWNLOAD: YTS
   ADULT: xvideos, xnxx, spankbang, eporner, redtube
   NO TMDB. NO API KEYS. NO ENV VARS.
   ========================================================== */
var express = require('express');
var axios = require('axios');
var cheerio = require('cheerio');

var app = express();
var PORT = process.env.PORT || 3000;

var http = axios.create({
  timeout: 6000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*'
  }
});

/* =============== CINEMETA — PRIMARY CATALOG =============== */
var CM = 'https://v3-cinemeta.strem.io';

async function cmCatalog(type, skip, q) {
  var url = CM + '/catalog/' + type + '/top' +
    (q ? '/search=' + encodeURIComponent(q) : '/skip=' + (skip || 0)) + '.json';
  var r = await http.get(url);
  return (r.data.metas || []).map(function(m) {
    return { id: m.imdb_id || m.id, type: type, title: m.name, poster: m.poster || '', backdrop: m.background || '', year: String(m.releaseInfo || '').slice(0, 4), rating: m.imdbRating || 0, overview: m.description || '', genres: m.genres || [] };
  });
}

async function cmMeta(type, id) {
  try {
    var r = await http.get(CM + '/meta/' + type + '/' + id + '.json');
    var m = r.data.meta;
    if (!m) return null;
    return {
      id: m.imdb_id || m.id, type: type, title: m.name,
      poster: m.poster || '', backdrop: m.background || '',
      year: String(m.releaseInfo || '').slice(0, 4), rating: m.imdbRating || 0,
      overview: m.description || '', genres: m.genres || [],
      cast: (m.cast || []).join(', '), director: (m.director || m.writers || []).join(', '),
      videos: (m.videos || []).map(function(v) { return { id: v.id, season: v.season, episode: v.episode, title: v.title, thumbnail: v.thumbnail || '' }; })
    };
  } catch (e) { return null; }
}

/* =============== FZMOVIES — PRIMARY VIDEO SOURCE =============== */
var FZ = 'https://fzmovies.watch';
var fzCache = {};

function fzGet(key) { var c = fzCache[key]; return (c && Date.now() - c.at < 1800000) ? c.data : null; }
function fzSet(key, data) { fzCache[key] = { data: data, at: Date.now() }; }

async function fzSearch(title) {
  var key = 'fz:q:' + title.toLowerCase().trim().slice(0, 50);
  var cached = fzGet(key);
  if (cached) return cached;
  var results = [];
  try {
    var r = await http.get(FZ + '/wp-json/wp/v2/movie_engine_movie', {
      params: { search: title, per_page: 6, _fields: 'id,title,slug,link' }
    });
    if (r.data && Array.isArray(r.data)) {
      r.data.forEach(function(p) {
        var t = (p.title && p.title.rendered) ? p.title.rendered.replace(/<[^>]+>/g, '') : '';
        var slug = p.slug || '';
        var isTv = (p.link || '').indexOf('/tv-series/') >= 0;
        if (t && slug) results.push({ postId: p.id, title: t, slug: slug, type: isTv ? 'series' : 'movie' });
      });
    }
  } catch (e) { console.log('[FZ] REST err: ' + (e.code || e.message)); }
  if (!results.length) {
    try {
      var html = (await http.get(FZ + '/', { params: { s: title }, headers: { 'Accept': 'text/html' } })).data;
      var $ = cheerio.load(html);
      var seen = {};
      $('a[href*="/movies/"], a[href*="/tv-series/"]').each(function(i, el) {
        if (results.length >= 6) return;
        var href = $(el).attr('href') || '';
        var lbl = $(el).attr('aria-label') || $(el).find('.movie-engine-card-title').text() || '';
        lbl = lbl.trim();
        if (lbl.length < 3 || lbl.length > 200) return;
        var slug = href.replace(FZ + '/movies/', '').replace(FZ + '/tv-series/', '').replace(/\/$/, '');
        if (!slug || seen[slug]) return;
        seen[slug] = true;
        results.push({ postId: 0, title: lbl, slug: slug, type: href.indexOf('/tv-series/') >= 0 ? 'series' : 'movie' });
      });
    } catch (e) { console.log('[FZ] scrape err: ' + (e.code || e.message)); }
  }
  fzSet(key, results);
  return results;
}

async function fzSources(slug, type) {
  var key = 'fz:s:' + slug;
  var cached = fzGet(key);
  if (cached) return cached;
  var path = (type === 'series') ? '/tv-series/' : '/movies/';
  var url = FZ + path + slug + '/';
  var out = [];
  try {
    var r = await http.get(url, { headers: { 'Accept': 'text/html' } });
    var html = typeof r.data === 'string' ? r.data : '';
    var pidM = html.match(/data-post-id="(\d+)"/);
    var postId = pidM ? pidM[1] : null;
    var nonceM = html.match(/"nonce":"([a-f0-9]+)"/);
    var nonce = nonceM ? nonceM[1] : null;
    var iframeRe = /<iframe[^>]+src="(https?:\/\/[^"]+)"[^>]*>/g;
    var im;
    while ((im = iframeRe.exec(html))) {
      var src = im[1];
      if (src.indexOf('youtube') < 0 && src.indexOf('vimeo') < 0 && src.indexOf('googletagmanager') < 0 && src.indexOf('about:') < 0) {
        out.push({ name: 'FZ Default', quality: 'HD', url: src, provider: 'fz' });
        break;
      }
    }
    var servers = [];
    var srvRe = /data-server-index="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
    var sm;
    while ((sm = srvRe.exec(html))) {
      var idx = sm[1];
      var nameMatch = sm[2].match(/movie-engine-server-name[^>]*>([^<]+)/);
      var name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : ('Server ' + idx);
      var isActive = sm[0].indexOf('active') >= 0;
      servers.push({ index: idx, name: name, isActive: isActive });
    }
    if (postId && servers.length > 1) {
      for (var i = 0; i < servers.length; i += 2) {
        var batch = servers.slice(i, i + 2);
        var promises = batch.map(async function(srv) {
          if (srv.isActive && out.length) return null;
          try {
            var headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url, 'Accept': 'application/json', 'Origin': FZ };
            if (nonce) headers['X-WP-Nonce'] = nonce;
            var sr = await http.post(FZ + '/wp-json/movie-engine/v1/stream/', 'post_id=' + postId + '&server_index=' + srv.index, { headers: headers, timeout: 4000 });
            var streamUrl = null;
            if (sr.data) {
              if (sr.data.data && sr.data.data.url) streamUrl = sr.data.data.url;
              else if (sr.data.url) streamUrl = sr.data.url;
              else if (typeof sr.data === 'string' && sr.data.indexOf('http') === 0) streamUrl = sr.data;
              if (!streamUrl && typeof sr.data === 'string') { var m2 = sr.data.match(/src="(https?:\/\/[^"]+)"/); if (m2) streamUrl = m2[1]; }
            }
            return streamUrl ? { name: 'FZ ' + srv.name, quality: 'HD', url: streamUrl, provider: 'fz' } : null;
          } catch (e) { return null; }
        });
        var res = await Promise.all(promises);
        res.forEach(function(x) { if (x) out.push(x); });
      }
    }
    console.log('[FZ] ' + slug + ': ' + out.length + ' sources');
  } catch (e) { console.log('[FZ] err ' + slug + ': ' + (e.code || e.message)); }
  fzSet(key, out);
  return out;
}

/* =============== EMBED PROVIDERS =============== */
var EMBEDS_MOVIE = [
  ['VidSrc.xyz', 'https://vidsrc.xyz/embed/movie?imdb='], ['VidSrc.cc', 'https://vidsrc.cc/v2/embed/movie/'],
  ['VidSrc.to', 'https://vidsrc.to/embed/movie/'], ['Embed.su', 'https://embed.su/embed/movie/'],
  ['MultiEmbed', 'https://multiembed.mov/?video_id='], ['AutoEmbed', 'https://autoembed.cc/embed/movie/'],
  ['VidLink', 'https://vidlink.pro/movie/'], ['2Embed', 'https://www.2embed.cc/embed/imdb/movie?id='],
  ['Smashy', 'https://embed.smashystream.com/playere.php?imdb='], ['SuperEmbed', 'https://superembeds.com/embed/movie?imdb=']
];
var EMBEDS_TV = [
  ['VidSrc.xyz', 'https://vidsrc.xyz/embed/tv?imdb={id}&ss={s}&ee={e}'], ['VidSrc.cc', 'https://vidsrc.cc/v2/embed/tv/{id}/{s}/{e}'],
  ['VidSrc.to', 'https://vidsrc.to/embed/tv/{id}/{s}/{e}'], ['Embed.su', 'https://embed.su/embed/tv/{id}/{s}/{e}'],
  ['MultiEmbed', 'https://multiembed.mov/?video_id={id}&s={s}&e={e}'], ['AutoEmbed', 'https://autoembed.cc/embed/tv/{id}/{s}/{e}'],
  ['VidLink', 'https://vidlink.pro/tv/{id}/{s}/{e}'], ['2Embed', 'https://www.2embed.cc/embed/imdb/tv?id={id}&s={s}&e={e}'],
  ['Smashy', 'https://embed.smashystream.com/playere.php?imdb={id}&s={s}&e={e}'], ['SuperEmbed', 'https://superembeds.com/embed/tv?imdb={id}&s={s}&e={e}']
];
function embedSources(type, id, s, e) {
  if (type === 'series') return EMBEDS_TV.map(function(v) { return { name: v[0], quality: 'auto', url: v[1].replace('{id}', id).replace('{s}', s || 1).replace('{e}', e || 1), provider: 'embed' }; });
  return EMBEDS_MOVIE.map(function(v) { return { name: v[0], quality: 'auto', url: v[1] + id, provider: 'embed' }; });
}

/* =============== UNIFIED ROUTES =============== */
async function getTrending(type) {
  try { return { results: await cmCatalog(type, 0), source: 'cinemeta' }; }
  catch (e) { return { results: [], source: 'none' }; }
}
async function getSearch(type, q) {
  if (!q) return { results: [], source: 'none' };
  var items = []; var seen = {};
  try { var cm = await cmCatalog(type, 0, q); cm.forEach(function(x) { if (x.id && !seen[x.id]) { seen[x.id] = true; items.push(x); } }); } catch (e) {}
  try { var fz = await fzSearch(q); fz.forEach(function(x) { if (x.type === type) { var id = 'fz:' + x.slug; if (!seen[id]) { seen[id] = true; items.push({ id: id, type: type, title: x.title, poster: '', backdrop: '', year: '', rating: 0, overview: '', genres: [], fzSlug: x.slug }); } } }); } catch (e) {}
  return { results: items, source: items.length ? 'cinemeta+fz' : 'none' };
}
async function getDetail(type, id) {
  if (id.indexOf('fz:') === 0) {
    var slug = id.replace('fz:', '');
    return { meta: { id: id, type: type, title: slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }), poster: '', backdrop: '', year: '', rating: 0, overview: '', genres: [], fzSlug: slug }, source: 'fzmovies' };
  }
  var m = await cmMeta(type, id);
  return m ? { meta: m, source: 'cinemeta' } : { meta: null, source: 'none' };
}
async function getSources(type, id, title, s, e) {
  var out = [];
  var fzSlug = null;
  if (id.indexOf('fz:') === 0) fzSlug = id.replace('fz:', '');
  else if (title) { try { var fzR = await fzSearch(title); if (fzR.length) fzSlug = fzR[0].slug; } catch (e) {} }
  if (fzSlug) { try { var fzSrcs = await fzSources(fzSlug, type); fzSrcs.forEach(function(x) { out.push(x); }); } catch (e) {} }
  if (id.indexOf('tt') === 0) embedSources(type, id, s, e).forEach(function(x) { out.push(x); });
  var seen = {};
  out = out.filter(function(x) { return seen[x.url] ? false : (seen[x.url] = true); });
  return { sources: out };
}

/* =============== ADULT SCRAPERS =============== */
var ADULT = [
  { name: 'xvideos', base: 'https://www.xvideos.com', list: 'https://www.xvideos.com/', search: 'https://www.xvideos.com/?k=' },
  { name: 'xnxx', base: 'https://www.xnxx.com', list: 'https://www.xnxx.com/', search: 'https://www.xnxx.com/search/' },
  { name: 'spankbang', base: 'https://spankbang.com', list: 'https://spankbang.com/', search: 'https://spankbang.com/s/' },
  { name: 'eporner', base: 'https://www.eporner.com', list: 'https://www.eporner.com/', search: 'https://www.eporner.com/search/' },
  { name: 'redtube', base: 'https://www.redtube.com', list: 'https://www.redtube.com/', search: 'https://www.redtube.com/?search=' }
];
function extractAdult(html, src) {
  var $ = cheerio.load(html); var out = [];
  $('a[href]').each(function(i, el) {
    if (out.length >= 30) return;
    var a = $(el); var href = a.attr('href') || ''; var img = a.find('img').first();
    var thumb = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src') || '';
    var title = (img.attr('title') || a.attr('title') || a.text() || '').trim();
    if (!thumb || title.length < 4) return;
    if (href.indexOf('http') !== 0 && href.indexOf('/') !== 0) return;
    var url = href.indexOf('http') === 0 ? href : src.base + href;
    if (out.some(function(x) { return x.url === url; })) return;
    out.push({ id: Buffer.from(url).toString('base64').replace(/=+$/, ''), source: src.name, title: title.slice(0, 120), thumb: thumb, url: url });
  });
  return out;
}
async function adultFeed(urlFn) {
  var jobs = ADULT.map(async function(src) {
    try { return extractAdult((await http.get(urlFn ? urlFn(src) : src.list)).data, src); } catch (e) { return []; }
  });
  var merged = (await Promise.all(jobs)).reduce(function(a, b) { return a.concat(b); }, []);
  var seen = {};
  return merged.filter(function(x) { return seen[x.url] ? false : (seen[x.url] = true); });
}

/* =============== ROUTES =============== */
app.get('/api/health', function(req, res) { res.json({ ok: true, catalog: 'cinemeta', video: 'fzmovies+embeds' }); });
app.get('/api/debug/fz', async function(req, res) {
  var out = [];
  try { var s = await fzSearch('dark nuns'); out.push({ test: 'search', results: s.length, sample: s.slice(0, 2) }); } catch (e) { out.push({ test: 'search', error: e.message }); }
  res.json(out);
});
app.get('/api/debug/fz/:slug', async function(req, res) { res.json({ slug: req.params.slug, sources: await fzSources(req.params.slug, req.query.type || 'movie') }); });
app.get('/api/movies/trending', async function(req, res) { res.json(await getTrending('movie')); });
app.get('/api/tv/trending', async function(req, res) { res.json(await getTrending('series')); });
app.get('/api/movies/search', async function(req, res) { res.json(await getSearch('movie', req.query.q)); });
app.get('/api/tv/search', async function(req, res) { res.json(await getSearch('series', req.query.q)); });
app.get('/api/movies/genre/:name', async function(req, res) {
  var g = req.params.name.toLowerCase();
  var feed = await getTrending('movie');
  res.json({ results: feed.results.filter(function(x) { return (x.genres || []).some(function(y) { return String(y).toLowerCase().indexOf(g) >= 0; }); }), source: feed.source });
});
app.get('/api/movie/:id', async function(req, res) { res.json(await getDetail('movie', req.params.id)); });
app.get('/api/tv/:id', async function(req, res) { res.json(await getDetail('series', req.params.id)); });
app.get('/api/movie/:id/sources', async function(req, res) {
  var id = req.params.id; var detail = (id.indexOf('fz:') === 0) ? null : await getDetail('movie', id);
  res.json(await getSources('movie', id, detail && detail.meta ? detail.meta.title : ''));
});
app.get('/api/tv/:id/sources', async function(req, res) {
  var id = req.params.id; var detail = (id.indexOf('fz:') === 0) ? null : await getDetail('series', id);
  res.json(await getSources('series', id, detail && detail.meta ? detail.meta.title : '', req.query.s || 1, req.query.e || 1));
});
app.get('/api/movie/:id/similar', async function(req, res) {
  var feed = await getTrending('movie');
  res.json({ results: feed.results.filter(function(x) { return x.id !== req.params.id; }).slice(0, 12), source: feed.source });
});
app.get('/api/tv/:id/season/:num', async function(req, res) {
  var d = await getDetail('series', req.params.id);
  res.json({ episodes: ((d.meta && d.meta.videos) || []).filter(function(v) { return String(v.season) === String(req.params.num); }), source: d.source });
});
app.get('/api/tv/:id/:season/:episode', async function(req, res) {
  var id = req.params.id; var detail = (id.indexOf('fz:') === 0) ? null : await getDetail('series', id);
  res.json(await getSources('series', id, detail && detail.meta ? detail.meta.title : '', req.params.season, req.params.episode));
});
app.get('/api/movie/:id/4k', async function(req, res) {
  try {
    var id = req.params.id; var torrents = [];
    try { var r = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: id } }); (r.data.data && r.data.data.movies || []).forEach(function(m) { (m.torrents || []).forEach(function(t) { torrents.push({ quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash, title: m.title_long || m.title, magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title) }); }); }); } catch (e) {}
    if (!torrents.length) {
      var detail = await getDetail('movie', id);
      if (detail.meta && detail.meta.title) {
        try { var r2 = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: detail.meta.title, limit: 5 } }); (r2.data.data && r2.data.data.movies || []).forEach(function(m) { (m.torrents || []).forEach(function(t) { torrents.push({ quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash, title: m.title_long || m.title, magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title) }); }); }); } catch (e) {}
      }
    }
    torrents.sort(function(a, b) { return (b.quality === '1080p' ? 1 : 0) - (a.quality === '1080p' ? 1 : 0) || b.seeds - a.seeds; });
    res.json({ torrents: torrents, source: 'yts' });
  } catch (e) { res.json({ torrents: [], source: 'yts' }); }
});
app.get('/api/adult/trending', async function(req, res) { res.json({ results: await adultFeed(null) }); });
app.get('/api/adult/search', async function(req, res) { res.json({ results: await adultFeed(function(s) { return s.search + encodeURIComponent(req.query.q || ''); }) }); });
app.get('/api/adult/category/:cat', async function(req, res) { res.json({ results: await adultFeed(function(s) { return s.base + '/' + req.params.cat; }) }); });
app.get('/api/adult/performer/:name', async function(req, res) { res.json({ results: await adultFeed(function(s) { return s.search + encodeURIComponent(req.params.name); }) }); });
app.get('/api/adult/video/:source', async function(req, res) {
  try {
    var page = Buffer.from(String(req.query.u || ''), 'base64').toString('utf8');
    var html = (await http.get(page, { headers: { Referer: 'https://www.google.com/' } })).data;
    var urls = []; var re = /(https?:)?\/\/[^"'\s]+?\.mp4[^"'\s]*/g; var m;
    while ((m = re.exec(html)) && urls.length < 10) { var u = m[0]; if (u.indexOf('//') === 0) u = 'https:' + u; if (urls.indexOf(u) === -1) urls.push(u); }
    res.json({ urls: urls, page: page });
  } catch (e) { res.json({ urls: [], page: '' }); }
});
app.get('/api/debrid/status', function(req, res) { res.json({ enabled: false }); });
app.post('/api/cache/clear', function(req, res) { fzCache = {}; res.json({ ok: true }); });

/* =============== INLINE UI — MovieBox HD Clone =============== */
var HTML = [
'<!doctype html><html lang="en"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
'<title>MovieBox HD: Watch Free Movies & TV Shows Online in HD</title>',
'<link rel="preconnect" href="https://movieboxhd.net">',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}',
'html{font-size:1rem;background:#101114;overflow-x:hidden}',
'body{background:#101114;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;overflow-x:hidden;-webkit-font-smoothing:antialiased}',
'a{color:inherit;text-decoration:none}',
'::-webkit-scrollbar{display:none}',
'',
'/* ===== LAYOUT ===== */',
'.app{display:flex;min-height:100vh}',
'.sidebar{position:fixed;top:0;left:0;bottom:0;width:220px;background:#1a1b1f;z-index:20;display:flex;flex-direction:column;padding-top:62px;overflow-y:auto;scrollbar-width:none}',
'.sidebar::-webkit-scrollbar{display:none}',
'.sidebar .nav-item{display:flex;align-items:center;gap:12px;padding:10px 20px;border-radius:8px;color:rgba(255,255,255,0.6);font-size:14px;font-weight:400;cursor:pointer;transition:all .2s;text-decoration:none;margin-bottom:2px}',
'.sidebar .nav-item:hover{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.85)}',
'.sidebar .nav-item.active{background:rgba(255,255,255,0.1);color:#fff;font-weight:700}',
'.sidebar .nav-item.active .nav-icon svg{filter:brightness(1.5)}',
'.sidebar .nav-divider{height:1px;background:rgba(255,255,255,0.1);margin:12px 20px}',
'.nav-icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
'.nav-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5}',
'.main-content{margin-left:220px;flex:1;min-height:100vh;padding-bottom:20px}',
'',
'/* ===== HEADER ===== */',
'.header{position:sticky;top:0;z-index:50;background:#101114;border-bottom:1px solid rgba(255,255,255,0.1);padding:0 20px;height:62px;display:flex;align-items:center;gap:16px}',
'.header-logo{display:flex;align-items:center;gap:8px;text-decoration:none;flex-shrink:0}',
'.header-logo-icon{width:32px;height:32px;border-radius:8px;background:linear-gradient(91deg,#1CB7FF 1.22%,#2FF58B 50.24%);display:flex;align-items:center;justify-content:center}',
'.header-logo-icon svg{width:20px;height:20px;fill:#101114}',
'.header-logo-text{font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.02em}',
'.search-box{flex:1;max-width:480px;height:40px;background:rgba(255,255,255,0.08);border-radius:8px;display:flex;align-items:center;padding:0 12px;gap:8px;transition:border-color .2s;border:1px solid transparent;margin-left:24px}',
'.search-box:focus-within{border-color:rgba(255,255,255,0.3)}',
'.search-box svg{width:16px;height:16px;fill:none;stroke:rgba(255,255,255,0.6);stroke-width:2;flex-shrink:0}',
'.search-box input{flex:1;background:transparent;border:0;outline:0;color:#fff;font-size:14px;height:100%;font-family:inherit}',
'.search-box input::placeholder{color:rgba(255,255,255,0.35)}',
'.header-right{display:flex;align-items:center;gap:12px;margin-left:auto;flex-shrink:0}',
'.header-btn{height:36px;padding:0 16px;border-radius:20px;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s;border:0;font-family:inherit}',
'.header-btn.download{background:linear-gradient(91deg,#1CB7FF 1.22%,#2FF58B 50.24%);color:#101114}',
'.header-btn.download:hover{opacity:0.9}',
'.header-btn.login{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7)}',
'.header-btn.login:hover{background:rgba(255,255,255,0.15);color:#fff}',
'.header-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2}',
'',
'/* ===== HERO CAROUSEL ===== */',
'.hero-carousel{position:relative;width:100%;aspect-ratio:21/9;max-height:420px;overflow:hidden;background:#1a1b1f;margin-bottom:8px}',
'.hero-slide{position:absolute;inset:0;opacity:0;transition:opacity .8s ease}',
'.hero-slide.active{opacity:1}',
'.hero-slide-bg{position:absolute;inset:0;background-size:cover;background-position:center}',
'.hero-slide-gradient{position:absolute;inset:0;background:linear-gradient(90deg,rgba(16,17,20,0.95) 0%,rgba(16,17,20,0.6) 40%,transparent 70%)}',
'.hero-slide-bottom{position:absolute;inset:0;background:linear-gradient(0deg,#101114 0%,transparent 30%)}',
'.hero-slide-info{position:absolute;bottom:40px;left:40px;max-width:500px;z-index:10}',
'.hero-slide-info h2{font-size:28px;font-weight:800;line-height:1.2;margin-bottom:8px;text-shadow:0 2px 8px rgba(0,0,0,0.5)}',
'.hero-slide-meta{display:flex;align-items:center;gap:8px;margin-bottom:12px;color:rgba(255,255,255,0.8);font-size:13px}',
'.hero-slide-meta .rating{display:flex;align-items:center;gap:4px;color:#FFDA6B;font-weight:700}',
'.hero-slide-meta .rating svg{width:14px;height:14px;fill:#FFDA6B}',
'.hero-slide-desc{color:rgba(255,255,255,0.7);font-size:13px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:16px}',
'.hero-play-btn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(91deg,#1CB7FF 1.22%,#2FF58B 50.24%);color:#101114;font-weight:700;font-size:14px;padding:10px 24px;border-radius:8px;cursor:pointer;border:0;font-family:inherit;transition:opacity .2s}',
'.hero-play-btn:hover{opacity:0.9}',
'.hero-play-btn svg{width:18px;height:18px;fill:#101114}',
'.hero-dots{position:absolute;bottom:16px;right:40px;display:flex;gap:6px;z-index:10}',
'.hero-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.3);cursor:pointer;transition:all .3s;border:0;padding:0}',
'.hero-dot.active{background:#fff;width:24px;border-radius:4px}',
'.hero-nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:10;color:#fff;font-size:18px;transition:background .2s}',
'.hero-nav:hover{background:rgba(255,255,255,0.15)}',
'.hero-nav.prev{left:16px}',
'.hero-nav.next{right:16px}',
'',
'/* ===== CONTENT ROWS ===== */',
'.section{margin-bottom:24px;position:relative}',
'.section-header{display:flex;align-items:center;justify-content:space-between;padding:0 20px;margin-bottom:12px}',
'.section-title{font-size:16px;font-weight:700;color:#fff}',
'.section-more{display:flex;align-items:center;gap:4px;font-size:12px;color:rgba(255,255,255,0.5);cursor:pointer;transition:color .2s}',
'.section-more:hover{color:rgba(255,255,255,0.8)}',
'.section-more svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2}',
'',
'/* ===== MOVIE ROW SCROLL ===== */',
'.row-scroll{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;padding:0 20px 4px;-webkit-overflow-scrolling:touch}',
'.row-scroll::-webkit-scrollbar{display:none}',
'',
'/* ===== MOVIE CARD ===== */',
'.movie-card{flex-shrink:0;width:150px;scroll-snap-align:start;cursor:pointer;position:relative;transition:transform .2s}',
'.movie-card:hover{transform:scale(1.03)}',
'.movie-card-poster{position:relative;width:100%;aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:#2b2e39}',
'.movie-card-poster img{width:100%;height:100%;object-fit:cover;display:block;transition:opacity .3s}',
'.movie-card-poster .quality-badge{position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.65);color:#fff;font-size:9px;font-weight:600;padding:2px 6px;border-radius:4px;backdrop-filter:blur(4px)}',
'.movie-card-poster .rating-badge{position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.65);display:flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;backdrop-filter:blur(4px)}',
'.movie-card-poster .rating-badge svg{width:10px;height:10px;fill:#FFDA6B}',
'.movie-card-poster .rating-badge span{color:#FFDA6B;font-size:10px;font-weight:600}',
'.movie-card-poster .dl-btn{position:absolute;bottom:6px;right:6px;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;cursor:pointer;border:0;color:#fff;font-size:12px;backdrop-filter:blur(4px);transition:background .2s;opacity:0;transform:scale(0.8);transition:all .2s}',
'.movie-card:hover .dl-btn{opacity:1;transform:scale(1)}',
'.movie-card:hover .dl-btn:hover{background:rgba(28,183,255,0.8)}',
'.movie-card-info{padding:6px 0 0}',
'.movie-card-title{font-size:12px;font-weight:400;color:rgba(255,255,255,0.8);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'',
'/* ===== DETAIL OVERLAY ===== */',
'.overlay{position:fixed;inset:0;background:rgba(8,9,11,0.96);z-index:100;display:none;flex-direction:column;animation:fadeIn .3s ease}',
'.overlay.open{display:flex}',
'@keyframes fadeIn{from{opacity:0}to{opacity:1}}',
'.overlay-header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:#0a0b0e;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0}',
'.overlay-close{width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(255,255,255,0.5);font-size:20px;border-radius:50%;transition:all .2s;border:0;background:transparent}',
'.overlay-close:hover{background:rgba(255,255,255,0.1);color:#fff}',
'.overlay-body{flex:1;overflow-y:auto;padding:0 20px 40px}',
'',
'/* ===== DETAIL PAGE ===== */',
'.detail-hero{display:flex;gap:20px;padding:20px 0}',
'.detail-poster{width:180px;border-radius:12px;overflow:hidden;flex-shrink:0}',
'.detail-poster img{width:100%;display:block}',
'.detail-info{flex:1;min-width:0}',
'.detail-info h2{font-size:24px;font-weight:800;margin-bottom:8px}',
'.detail-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px;font-size:13px;color:rgba(255,255,255,0.7)}',
'.detail-meta .rating{color:#FFDA6B;font-weight:700;display:flex;align-items:center;gap:4px}',
'.detail-meta .rating svg{width:14px;height:14px;fill:#FFDA6B}',
'.detail-desc{color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;margin-bottom:12px;max-width:560px}',
'.detail-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}',
'.chip{display:inline-block;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:4px 12px;font-size:12px;color:rgba(255,255,255,0.7);cursor:pointer;transition:all .2s}',
'.chip:hover{background:rgba(255,255,255,0.15);color:#fff}',
'',
'/* ===== SERVER SELECTOR ===== */',
'.server-bar{display:flex;align-items:center;gap:6px;padding:8px 20px;background:#0e0f13;overflow-x:auto;scrollbar-width:none;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.05)}',
'.server-bar::-webkit-scrollbar{display:none}',
'.server-label{font-size:11px;color:rgba(255,255,255,0.4);flex-shrink:0;margin-right:4px}',
'.srv-btn{padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;border:1px solid rgba(255,255,255,0.1);transition:all .15s;font-family:inherit}',
'.srv-btn:hover{color:#fff;border-color:rgba(255,255,255,0.25);background:rgba(255,255,255,0.1)}',
'.srv-btn.on{background:linear-gradient(91deg,#1CB7FF 1.22%,#2FF58B 50.24%);color:#101114;font-weight:700;border-color:transparent}',
'.srv-btn.fz{border-color:rgba(255,218,107,0.25)}',
'.srv-btn.fz.on{background:linear-gradient(91deg,#FFDA6B 0%,#F5C400 100%);color:#1a1a1a;border-color:transparent}',
'',
'/* ===== PLAYER ===== */',
'#pframe{position:relative;flex:1;min-height:0;background:#000}',
'#pframe iframe,#pframe video{position:absolute;inset:0;width:100%;height:100%;border:0}',
'#pmsg{padding:10px;text-align:center;color:rgba(255,255,255,0.4);flex-shrink:0;font-size:12px;background:#0a0b0e}',
'',
'/* ===== BOTTOM TAB BAR (MOBILE) ===== */',
'.bottom-tabs{display:none;position:fixed;bottom:0;left:0;right:0;z-index:50;background:rgba(22,23,27,0.9);backdrop-filter:blur(10px);border-top:1px solid rgba(255,255,255,0.08)}',
'.bottom-tabs-inner{display:flex;align-items:stretch}',
'.bottom-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 0;cursor:pointer;color:rgba(255,255,255,0.4);font-size:10px;transition:color .2s;border:0;background:transparent}',
'.bottom-tab svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.5;margin-bottom:2px}',
'.bottom-tab.active{color:#fff}',
'.bottom-tab.active svg{stroke:url(#grad1)}',
'',
'/* ===== RESPONSIVE ===== */',
'@media(max-width:860px){',
'  .sidebar{display:none}',
'  .main-content{margin-left:0}',
'  .bottom-tabs{display:block}',
'  .hero-carousel{aspect-ratio:16/9;max-height:280px}',
'  .hero-slide-info{left:16px;bottom:28px;right:16px;max-width:none}',
'  .hero-slide-info h2{font-size:18px}',
'  .hero-slide-desc{display:none}',
'  .hero-dots{right:16px;bottom:10px}',
'  .header-logo-text{font-size:16px}',
'  .search-box{margin-left:12px}',
'  .header-btn.login{display:none}',
'  .section-header{padding:0 12px}',
'  .row-scroll{padding:0 12px 4px}',
'  .movie-card{width:120px}',
'  .detail-poster{width:120px}',
'  .detail-hero{gap:12px}',
'  .overlay-body{padding:0 12px 30px}',
'  .server-bar{padding:6px 12px}',
'}',
'',
'/* ===== MISC ===== */',
'.loading-spinner{width:28px;height:28px;border:2px solid rgba(255,255,255,0.1);border-top-color:#1CB7FF;border-radius:50%;animation:spin 0.8s linear infinite;margin:60px auto}',
'@keyframes spin{to{transform:rotate(360deg)}}',
'.empty-msg{text-align:center;color:rgba(255,255,255,0.3);padding:60px 20px;font-size:14px}',
'#toast{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);background:linear-gradient(91deg,#1CB7FF 1.22%,#2FF58B 50.24%);color:#101114;font-weight:700;padding:10px 20px;border-radius:10px;z-index:999;opacity:0;transition:opacity .3s;font-size:13px;pointer-events:none;white-space:nowrap}',
'.cast-text{color:rgba(255,255,255,0.5);font-size:12px;margin-top:4px}',
'.fz-badge{display:inline-block;background:rgba(255,218,107,0.15);color:#FFDA6B;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;font-weight:600}',
'</style></head><body>',
'<svg style="display:none"><defs><linearGradient id="grad1" x1="2.5" y1="11.5" x2="21.5" y2="12"><stop offset="0" stop-color="#1CB7FF"/><stop offset="0.5" stop-color="#2FF58B"/></linearGradient></defs></svg>',
'',
'<!-- SIDEBAR -->',
'<div class="sidebar">',
'  <a href="#" class="nav-item active" data-tab="home"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M3 9.5L12 2l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.5z"/></svg></span>Home</a>',
'  <a href="#" class="nav-item" data-tab="movies"><span class="nav-icon"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>Movies</a>',
'  <a href="#" class="nav-item" data-tab="tv"><span class="nav-icon"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3h8l2 4H6l2-4z"/></svg></span>TV Shows</a>',
'  <div class="nav-divider"></div>',
'  <a href="#" class="nav-item" data-tab="adult"><span class="nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg></span>18+</a>',
'  <a href="#" class="nav-item" data-tab="mylist"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></span>My List</a>',
'</div>',
'',
'<!-- MAIN CONTENT -->',
'<div class="main-content">',
'  <!-- HEADER -->',
'  <header class="header">',
'    <a href="#" class="header-logo" data-tab="home">',
'      <div class="header-logo-icon"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 2l18 10L3 22V2z" fill="#101114"/></svg></div>',
'      <span class="header-logo-text">MovieBox</span>',
'    </a>',
'    <div class="search-box">',
'      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
'      <input type="text" id="searchInput" placeholder="Search movies / TV shows..." autocomplete="off">',
'    </div>',
'    <div class="header-right">',
'      <button class="header-btn download" style="display:none"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download App</button>',
'      <button class="header-btn login"><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Log in</button>',
'    </div>',
'  </header>',
'',
'  <!-- HERO CAROUSEL -->',
'  <div class="hero-carousel" id="heroCarousel"></div>',
'',
'  <!-- CONTENT ROWS -->',
'  <div id="contentArea"></div>',
'</div>',
'',
'<!-- DETAIL OVERLAY -->',
'<div class="overlay" id="detailOverlay"></div>',
'',
'<!-- PLAYER OVERLAY -->',
'<div class="overlay" id="playerOverlay"></div>',
'',
'<!-- BOTTOM TABS (MOBILE) -->',
'<div class="bottom-tabs">',
'  <div class="bottom-tabs-inner">',
'    <button class="bottom-tab active" data-tab="home"><svg viewBox="0 0 24 24"><path d="M3 9.5L12 2l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.5z"/></svg>Home</button>',
'    <button class="bottom-tab" data-tab="movies"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>Movie</button>',
'    <button class="bottom-tab" data-tab="tv"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3h8l2 4H6l2-4z"/></svg>TV Show</button>',
'    <button class="bottom-tab" data-tab="adult"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg>18+</button>',
'    <button class="bottom-tab" data-tab="mylist"><svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>My List</button>',
'  </div>',
'</div>',
'<div id="toast"></div>',
'',
'<script>',
'/* ===== STATE ===== */',
'var S={tab:"home",hi:0,hm:[],sl:[],si:-1,cur:null,list:[],cw:[],searchTimer:null};',
'try{S.list=JSON.parse(localStorage.getItem("mb_list")||"[]");S.cw=JSON.parse(localStorage.getItem("mb_cw")||"[]")}catch(e){}',
'function sp(){return localStorage.getItem("mb_server")||""}',
'function ss(n){localStorage.setItem("mb_server",n)}',
'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}',
'function api(p){var c=new AbortController(),t=setTimeout(function(){c.abort()},20000);return fetch(p,{signal:c.signal}).then(function(r){clearTimeout(t);return r.json()}).catch(function(e){clearTimeout(t);return{results:[],sources:[],torrents:[],meta:null}})}',
'function toast(t){var e=document.getElementById("toast");e.textContent=t;e.style.opacity=1;setTimeout(function(){e.style.opacity=0},3000)}',
'',
'/* ===== HERO CAROUSEL ===== */',
'var heroIdx=0,heroItems=[],heroTimer=null;',
'function renderHero(items){',
'  heroItems=items.slice(0,6);heroIdx=0;',
'  var h=document.getElementById("heroCarousel");',
'  if(!heroItems.length){h.innerHTML="<div class=\\"empty-msg\\">No featured content</div>";return}',
'  var html="";',
'  for(var i=0;i<heroItems.length;i++){',
'    var x=heroItems[i];',
'    html+="<div class=\\"hero-slide"+(i===0?" active":"")+"\\" data-idx=\\""+i+"\\">"+',
'      "<div class=\\"hero-slide-bg\\" style=\\"background-image:url("+esc(x.backdrop||x.poster||"")+")\\"></div>"+',
'      "<div class=\\"hero-slide-gradient\\"></div><div class=\\"hero-slide-bottom\\"></div>"+',
'      "<div class=\\"hero-slide-info\\"><h2>"+esc(x.title)+"</h2>"+',
'      "<div class=\\"hero-slide-meta\\"><span class=\\"rating\\"><svg viewBox=\\"0 0 24 24\\"><path d=\\"M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z\\"/></svg>"+esc(x.rating||"")+"</span>"+',
'      "<span>"+esc(x.year)+"</span></div>"+',
'      "<div class=\\"hero-slide-desc\\">"+esc(x.overview||"")+"</div>"+',
'      "<button class=\\"hero-play-btn\\" onclick=\\"openDetail(\\'"+esc(x.id)+"\\',\\'"+esc(x.type||"movie")+"\\')\\">"+',
'      "<svg viewBox=\\"0 0 24 24\\"><polygon points=\\"5,3 19,12 5,21\\"/></svg>Play Now</button></div></div>";',
'  }',
'  html+="<button class=\\"hero-nav prev\\" onclick=\\"heroNav(-1)\\">‹</button>"+',
'    "<button class=\\"hero-nav next\\" onclick=\\"heroNav(1)\\">›</button>"+',
'    "<div class=\\"hero-dots\\">";',
'  for(var i=0;i<heroItems.length;i++) html+="<button class=\\"hero-dot"+(i===0?" active":"")+"\\" onclick=\\"heroGo("+i+")\\"></button>";',
'  html+="</div>";',
'  h.innerHTML=html;',
'  if(heroTimer)clearInterval(heroTimer);',
'  heroTimer=setInterval(function(){heroGo((heroIdx+1)%heroItems.length)},6000);',
'}',
'function heroGo(i){',
'  var slides=document.querySelectorAll(".hero-slide");',
'  var dots=document.querySelectorAll(".hero-dot");',
'  if(slides[heroIdx])slides[heroIdx].classList.remove("active");',
'  if(dots[heroIdx])dots[heroIdx].classList.remove("active");',
'  heroIdx=i;',
'  if(slides[heroIdx])slides[heroIdx].classList.add("active");',
'  if(dots[heroIdx])dots[heroIdx].classList.add("active");',
'}',
'function heroNav(d){heroGo((heroIdx+d+heroItems.length)%heroItems.length)}',
'',
'/* ===== CARDS & ROWS ===== */',
'function cardHTML(x){',
'  var fb=(x.id&&x.id.indexOf("fz:")===0)?\'<span class="fz-badge">FZ</span>\':"";',
'  var pb=x.poster?\'<img loading="lazy" src="\'+esc(x.poster)+\'" onerror="this.style.opacity=.15">\':\'<div style="width:100%;height:100%;background:#1D1E23;display:flex;align-items:center;justify-content:center;color:#555;font-size:10px">No Image</div>\';',
'  return \'<div class="movie-card" data-id="\'+esc(x.id)+\'" data-type="\'+esc(x.type||"movie")+\'">\'+',
'    \'<div class="movie-card-poster">\'+pb+',
'    \'<div class="dl-btn" data-dlid="\'+esc(x.id)+\'" title="Download">⬇</div></div>\'+',
'    \'<div class="movie-card-info"><div class="movie-card-title">\'+esc(x.title)+fb+\'</div></div></div>\';',
'}',
'function sectionHTML(title,items,id){',
'  if(!items||!items.length)return"";',
'  return \'<div class="section"><div class="section-header"><h2 class="section-title">\'+esc(title)+\'</h2><span class="section-more" data-more="\'+esc(id||"")+\'">More <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></span></div>\'+',
'    \'<div class="row-scroll">\'+items.map(cardHTML).join("")+\'</div></div>\';',
'}',
'',
'/* ===== NAV ===== */',
'function setActiveTab(tab){',
'  document.querySelectorAll(".nav-item").forEach(function(n){n.classList.toggle("active",n.getAttribute("data-tab")===tab)});',
'  document.querySelectorAll(".bottom-tab").forEach(function(n){n.classList.toggle("active",n.getAttribute("data-tab")===tab)});',
'}',
'',
'/* ===== LOAD TAB ===== */',
'async function loadTab(tab){',
'  S.tab=tab;setActiveTab(tab);',
'  var ca=document.getElementById("contentArea");',
'  if(tab==="home"){',
'    ca.innerHTML="<div class=\\"loading-spinner\\"></div>";',
'    try{',
'      var r=await Promise.all([api("/api/movies/trending"),api("/api/tv/trending")]);',
'      var m=r[0],t=r[1];',
'      var all=(m.results||[]).concat(t.results||[]);',
'      renderHero(all);',
'      var html="";',
'      if(m.results&&m.results.length) html+=sectionHTML("Trending Movies",m.results.slice(0,20),"movies");',
'      if(t.results&&t.results.length) html+=sectionHTML("Trending TV Shows",t.results.slice(0,20),"tv");',
'      ca.innerHTML=html||\'<div class="empty-msg">No content available. Try again shortly.</div>\';',
'    }catch(e){ca.innerHTML=\'<div class="empty-msg">Failed to load. Refresh to try again.</div>\'}',
'  }else if(tab==="movies"){',
'    ca.innerHTML="<div class=\\"loading-spinner\\"></div>";',
'    var r=await api("/api/movies/trending");',
'    var html=\'<div class="section"><div class="section-header"><h2 class="section-title">All Movies</h2></div><div class="row-scroll" style="flex-wrap:wrap;overflow:visible">\'+',
'      (r.results||[]).map(cardHTML).join("")+\'</div></div>\';',
'    ca.innerHTML=html;',
'  }else if(tab==="tv"){',
'    ca.innerHTML="<div class=\\"loading-spinner\\"></div>";',
'    var r=await api("/api/tv/trending");',
'    var html=\'<div class="section"><div class="section-header"><h2 class="section-title">All TV Shows</h2></div><div class="row-scroll" style="flex-wrap:wrap;overflow:visible">\'+',
'      (r.results||[]).map(cardHTML).join("")+\'</div></div>\';',
'    ca.innerHTML=html;',
'  }else if(tab==="adult"){',
'    if(localStorage.getItem("mb_age")!=="1"){ca.innerHTML=\'<div class="empty-msg" style="padding:100px 20px"><h2 style="font-size:20px;margin-bottom:16px">18+ Content</h2><p style="margin-bottom:20px">Confirm you are 18 or older.</p><button class="header-btn download" id="ageok">I am 18+</button></div>\';document.getElementById("ageok").onclick=function(){localStorage.setItem("mb_age","1");loadTab("adult")};return}',
'    ca.innerHTML="<div class=\\"loading-spinner\\"></div>";',
'    var a=await api("/api/adult/trending");',
'    ca.innerHTML=\'<div class="section"><div class="section-header"><h2 class="section-title">18+</h2></div><div class="row-scroll" style="flex-wrap:wrap;overflow:visible">\'+(a.results||[]).map(function(x){return \'<div class="movie-card" data-adult="\'+esc(x.id)+\'" data-source="\'+esc(x.source)+\'"><div class="movie-card-poster"><img loading="lazy" src="\'+esc(x.thumb)+\'" onerror="this.style.opacity=.15"></div><div class="movie-card-info"><div class="movie-card-title">\'+esc(x.title)+\'</div></div></div>\'}).join("")+\'</div></div>\';',
'  }else if(tab==="mylist"){',
'    ca.innerHTML=sectionHTML("My List",S.list,"mylist")||\'<div class="empty-msg">No saved movies yet. Tap the bookmark icon on any title.</div>\';',
'  }',
'}',
'',
'/* ===== SEARCH ===== */',
'document.getElementById("searchInput").addEventListener("input",function(e){',
'  clearTimeout(S.searchTimer);',
'  var q=e.target.value.trim();',
'  if(!q){loadTab(S.tab);return}',
'  S.searchTimer=setTimeout(async function(){',
'    var ca=document.getElementById("contentArea");',
'    ca.innerHTML="<div class=\\"loading-spinner\\"></div>";',
'    var r=await Promise.all([api("/api/movies/search?q="+encodeURIComponent(q)),api("/api/tv/search?q="+encodeURIComponent(q))]);',
'    var m=r[0],t=r[1];',
'    var html="";',
'    if(m.results&&m.results.length) html+=sectionHTML("Movies",m.results.slice(0,20),"movies");',
'    if(t.results&&t.results.length) html+=sectionHTML("TV Shows",t.results.slice(0,20),"tv");',
'    ca.innerHTML=html||\'<div class="empty-msg">No results for "\'+esc(q)+\'"</div>\';',
'  },400);',
'});',
'',
'/* ===== DOWNLOAD ===== */',
'async function download(id){',
'  toast("Searching torrents…");',
'  var r=await api("/api/movie/"+id+"/4k");var ts=r.torrents||[];',
'  if(!ts.length){toast("No torrents found — try Play instead");return}',
'  var pick=ts[0];try{await navigator.clipboard.writeText(pick.magnet)}catch(e){}',
'  toast(pick.quality+" · "+pick.size+" · magnet copied!");',
'}',
'',
'/* ===== DETAIL OVERLAY ===== */',
'async function openDetail(id,type){',
'  var ov=document.getElementById("detailOverlay");',
'  ov.innerHTML="<div class=\\"loading-spinner\\" style=\\"margin-top:200px\\"></div>";ov.classList.add("open");',
'  var p=(type==="series")?"/api/tv/":"/api/movie/";',
'  var d=await api(p+id),s=await api(p+id+"/sources");',
'  var m=d.meta||{id:id,title:"",poster:"",year:"",rating:"",overview:"",genres:[]};',
'  var sc=s.sources||[];',
'  var html=\'<div class="overlay-header"><button class="overlay-close" onclick="closeDetail()">✕</button><b>\'+esc(m.title||"Details")+\'</b>\'+',
'    \'<span style="margin-left:auto;color:rgba(255,255,255,0.3);font-size:11px">\'+sc.length+\' sources available</span></div>\'+',
'    \'<div class="overlay-body"><div class="detail-hero">\'+',
'    \'<div class="detail-poster">\'+(m.poster?\'<img src="\'+esc(m.poster)+\'" onerror="this.style.opacity=.2">\':\'<div style="width:100%;aspect-ratio:2/3;background:#1D1E23;border-radius:12px"></div>\')+\'</div>\'+',
'    \'<div class="detail-info"><h2>\'+esc(m.title)+\'</h2>\'+',
'    \'<div class="detail-meta"><span class="rating"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="#FFDA6B"/></svg>\'+esc(m.rating||"")+'</span><span>\'+esc(m.year)+\'</span></div>\'+',
'    \'<div class="detail-desc">\'+esc(m.overview||"")+'</div>\'+',
'    \'<div class="detail-chips">\'+(m.genres||[]).map(function(g){return \'<span class="chip">\'+esc(g)+\'</span>\'}).join("")+\'</div>\'+',
'    (m.cast?\'<div class="cast-text">Cast: \'+esc(m.cast)+\'</div>\':"")+',
'    \'<div style="margin-top:12px">\'+',
'    \'<button class="hero-play-btn" onclick="showSrcs(\'+JSON.stringify(sc)+\',{title:\\\'\'+esc(m.title)+\\\',id:\\\'\'+esc(id)+\\\',type:\\\'\'+esc(type)+\\\'})">▶ Play</button>\'+',
'    \'<button class="header-btn login" style="margin-left:8px" onclick="download(\\\'\'+esc(id)+\\\'\')">⬇ Download</button>\'+',
'    \'<button class="header-btn login" style="margin-left:8px" onclick="saveToList(\\\'\'+esc(id)+\\\',\\\'\'+esc(m.title)+\\\',\\\'\'+esc(m.poster)+\\\',\\\'\'+esc(type)+\\\',\\\'\'+esc(m.year)+\\\',\\\'\'+esc(m.rating)+\\\'\')">＋ My List</button></div></div></div>\';',
'  if(type==="series"&&m.videos&&m.videos.length){',
'    var seas={};m.videos.forEach(function(v){var k=v.season||1;(seas[k]=seas[k]||[]).push(v)});',
'    html+=\'<h2 style="margin:20px 0 10px;font-size:15px">Episodes</h2>\';',
'    Object.keys(seas).forEach(function(k){',
'      html+=\'<div style="margin-bottom:12px"><div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:6px">Season \'+esc(k)+\'</div><div class="row-scroll">\'+',
'        seas[k].map(function(v){return \'<div class="chip" data-s="\'+esc(v.season)+\'" data-e="\'+esc(v.episode)+\'" data-eid="\'+esc(id)+\'">E\'+esc(v.episode)+\' · \'+esc(v.title||"")+\'</div>\'}).join("")+\'</div></div>\';',
'    });',
'  }',
'  html+=\'</div>\';',
'  ov.innerHTML=html;',
'  ov.querySelectorAll(".chip[data-e]").forEach(function(ch){',
'    ch.onclick=async function(){',
'      var ss=await api("/api/tv/"+ch.getAttribute("data-eid")+"/"+ch.getAttribute("data-s")+"/"+ch.getAttribute("data-e"));',
'      showSrcs(ss.sources||[],{title:m.title,id:id,type:"series"});',
'    };',
'  });',
'  if(sc.length) showSrcs(sc,{title:m.title,id:id,type:type});',
'}',
'function closeDetail(){document.getElementById("detailOverlay").classList.remove("open")}',
'function saveToList(id,title,poster,type,year,rating){',
'  if(!S.list.some(function(x){return x.id===id}))S.list.push({id:id,type:type,title:title,poster:poster,year:year,rating:rating});',
'  localStorage.setItem("mb_list",JSON.stringify(S.list));toast("Added to My List");',
'}',
'',
'/* ===== SERVER SELECTOR & PLAYER ===== */',
'function showSrcs(list,meta){',
'  S.sl=list||[];',
'  if(!S.sl.length){toast("No sources available");return}',
'  var pref=sp(),si=0;',
'  if(pref){for(var i=0;i<S.sl.length;i++){if(S.sl[i].name===pref||S.sl[i].name.indexOf(pref)>=0){si=i;break}}}',
'  S.si=si;',
'  var sh="";',
'  for(var i=0;i<S.sl.length;i++){var s=S.sl[i],isFz=s.provider==="fz",cls="srv-btn"+(isFz?" fz":"")+(i===si?" on":"");sh+=\'<span class="\'+cls+\'" data-srv="\'+i+\'">\'+esc(s.name)+\'</span>\'}',
'  var ov=document.getElementById("playerOverlay");',
'  ov.innerHTML=\'<div class="overlay-header"><button class="overlay-close" onclick="closePlayer()">✕</button><b>\'+esc(meta.title||"Player")+\'</b></div>\'+',
'    \'<div class="server-bar"><span class="server-label">Server:</span>\'+sh+\'</div>\'+',
'    \'<div id="pframe"></div><div id="pmsg">Loading source…</div>\';',
'  ov.classList.add("open");',
'  ov.querySelectorAll(".srv-btn").forEach(function(btn){',
'    btn.onclick=function(){',
'      var idx=parseInt(btn.getAttribute("data-srv"));S.si=idx;ss(S.sl[idx].name);',
'      ov.querySelectorAll(".srv-btn").forEach(function(b){b.classList.remove("on")});',
'      btn.classList.add("on");',
'      loadSrc(idx);',
'    };',
'  });',
'  loadSrc(si);',
'}',
'function loadSrc(idx){',
'  if(idx<0||idx>=S.sl.length)return;',
'  var s=S.sl[idx],fr=document.createElement("iframe");',
'  fr.src=s.url;fr.allow="autoplay;fullscreen;encrypted-media;picture-in-picture";fr.setAttribute("referrerPolicy","no-referrer");',
'  var pf=document.getElementById("pframe");pf.innerHTML="";pf.appendChild(fr);',
'  document.getElementById("pmsg").textContent="Playing: "+s.name+" ("+(idx+1)+"/"+S.sl.length+")";',
'}',
'function closePlayer(){document.getElementById("playerOverlay").classList.remove("open");document.getElementById("pframe").innerHTML=""}',
'',
'/* ===== EVENT DELEGATION ===== */',
'document.addEventListener("click",function(e){',
'  var nav=e.target.closest(".nav-item, .bottom-tab, .header-logo");',
'  if(nav&&nav.getAttribute("data-tab")){loadTab(nav.getAttribute("data-tab"));return}',
'  var dl=e.target.closest(".dl-btn[data-dlid]");',
'  if(dl){e.stopPropagation();download(dl.getAttribute("dlid"));return}',
'  var ad=e.target.closest("[data-adult]");',
'  if(ad){',
'    var id=ad.getAttribute("data-adult"),source=ad.getAttribute("data-source");',
'    api("/api/adult/video/"+source+"?u="+id).then(function(r){',
'      var ov=document.getElementById("playerOverlay");',
'      ov.innerHTML=\'<div class="overlay-header"><button class="overlay-close" onclick="closePlayer()">✕</button><b>18+</b></div><div id="pframe"></div><div id="pmsg"></div>\';',
'      ov.classList.add("open");',
'      if(r.urls&&r.urls.length) document.getElementById("pframe").innerHTML=\'<video controls autoplay playsinline style="width:100%;height:100%;background:#000" src="\'+esc(r.urls[0])+\'"></video>\';',
'      else if(r.page) document.getElementById("pframe").innerHTML=\'<iframe allow="autoplay;fullscreen" referrerpolicy="no-referrer" src="\'+esc(r.page)+\'"></iframe>\';',
'      else document.getElementById("pmsg").textContent="No video found.";',
'    });return',
'  }',
'  var c=e.target.closest(".movie-card[data-id]");',
'  if(c){openDetail(c.getAttribute("data-id"),c.getAttribute("data-type"));return}',
'  var more=e.target.closest(".section-more[data-more]");',
'  if(more){',
'    var tab=more.getAttribute("data-more");',
'    if(tab==="movies"||tab==="tv"||tab==="mylist")loadTab(tab);',
'  }',
'});',
'',
'/* ===== INIT ===== */',
'loadTab("home");',
'</scr'+'ipt></body></html>'
].join('');

app.get('/', function(req, res) { res.type('html').send(HTML); });
app.get('*', function(req, res) {
  if (req.path.indexOf('/api/') === 0) return res.status(404).json({ error: 'unknown route' });
  res.type('html').send(HTML);
});

app.listen(PORT, function() { console.log('MovieBox on ' + PORT + ' — Cinemeta + fzmovies + MovieBox HD design'); });
