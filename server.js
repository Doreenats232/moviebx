/* ==========================================================
   server.js — MovieBox-style streaming site
   
   CATALOG: Cinemeta (fast, reliable, key-free)
   VIDEO:   fzmovies.watch (15 real embed servers) + VidSrc fallback
   DOWNLOAD: YTS (IMDb ID + title search)
   ADULT:   xvideos, xnxx, spankbang, eporner, redtube
   
   NO MovieBox API (it doesn't have a public JSON API).
   NO TMDB. NO API KEYS. NO ENV VARS.
   ========================================================== */
var express = require('express');
var axios = require('axios');
var cheerio = require('cheerio');

var app = express();
var PORT = process.env.PORT || 3000;

var http = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*'
  }
});

/* =============== CINEMETA — PRIMARY CATALOG =============== */
var CM = 'https://v3-cinemeta.strem.io';

function normMeta(m, type) {
  return {
    id: m.imdb_id || m.id,
    type: type,
    title: m.name || m.title || 'Untitled',
    poster: m.poster || '',
    backdrop: m.background || '',
    year: String(m.releaseInfo || m.year || '').slice(0, 4),
    rating: m.imdbRating || m.vote_average || 0,
    overview: m.description || m.overview || '',
    genres: m.genres || []
  };
}

async function cmCatalog(type, skip, q) {
  var url = CM + '/catalog/' + type + '/top' +
    (q ? '/search=' + encodeURIComponent(q) : '/skip=' + (skip || 0)) + '.json';
  var r = await http.get(url);
  return (r.data.metas || []).map(function(m) { return normMeta(m, type); });
}

async function cmMeta(type, id) {
  try {
    var r = await http.get(CM + '/meta/' + type + '/' + id + '.json');
    var m = r.data.meta;
    if (!m) return null;
    return {
      id: m.imdb_id || m.id,
      type: type,
      title: m.name || '',
      poster: m.poster || '',
      backdrop: m.background || '',
      year: String(m.releaseInfo || '').slice(0, 4),
      rating: m.imdbRating || 0,
      overview: m.description || '',
      genres: m.genres || [],
      cast: (m.cast || []).join(', '),
      director: (m.director || m.writers || []).join(', '),
      videos: (m.videos || []).map(function(v) {
        return { id: v.id, season: v.season, episode: v.episode, title: v.title, thumbnail: v.thumbnail || '' };
      })
    };
  } catch (e) { return null; }
}

/* =============== FZMOVIES — PRIMARY VIDEO SOURCE =============== */
var FZ = 'https://fzmovies.watch';
var fzCache = {};

function fzGet(key) { var c = fzCache[key]; return (c && Date.now() - c.at < 1800000) ? c.data : null; }
function fzSet(key, data) { fzCache[key] = { data: data, at: Date.now() }; }

// Search fzmovies for a movie/series by title
async function fzSearch(title) {
  var key = 'fz:q:' + title.toLowerCase().trim().slice(0, 50);
  var cached = fzGet(key);
  if (cached) return cached;

  var results = [];

  // Method 1: WP REST API
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
  } catch (e) { console.log('[FZ] REST search err: ' + (e.code || e.message)); }

  // Method 2: Scrape search page if REST failed
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
    } catch (e) { console.log('[FZ] Search scrape err: ' + (e.code || e.message)); }
  }

  fzSet(key, results);
  return results;
}

// Get video sources from a fzmovies movie/series page
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

    // 1. Extract post ID and nonce for stream API
    var pidM = html.match(/data-post-id="(\d+)"/);
    var postId = pidM ? pidM[1] : null;
    var nonceM = html.match(/"nonce":"([a-f0-9]+)"/);
    var nonce = nonceM ? nonceM[1] : null;

    // 2. Extract default iframe
    var iframeRe = /<iframe[^>]+src="(https?:\/\/[^"]+)"[^>]*>/g;
    var im;
    while ((im = iframeRe.exec(html))) {
      var src = im[1];
      if (src.indexOf('youtube') < 0 && src.indexOf('vimeo') < 0 && src.indexOf('googletagmanager') < 0 &&
          src.indexOf('about:') < 0 && src.indexOf('javascript:') < 0) {
        out.push({ name: 'FZ Default', quality: 'HD', url: src, provider: 'fz' });
        break;
      }
    }

    // 3. Extract server buttons
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

    // 4. Try stream API for non-default servers
    if (postId && servers.length > 1) {
      // Try 2 at a time to avoid overwhelming
      for (var i = 0; i < servers.length; i += 2) {
        var batch = servers.slice(i, i + 2);
        var promises = batch.map(async function(srv) {
          if (srv.isActive && out.length) return null;
          try {
            var headers = {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': url,
              'Accept': 'application/json',
              'Origin': FZ
            };
            if (nonce) headers['X-WP-Nonce'] = nonce;
            var sr = await http.post(
              FZ + '/wp-json/movie-engine/v1/stream/',
              'post_id=' + postId + '&server_index=' + srv.index,
              { headers: headers, timeout: 4000 }
            );
            var streamUrl = null;
            if (sr.data) {
              if (sr.data.data && sr.data.data.url) streamUrl = sr.data.data.url;
              else if (sr.data.url) streamUrl = sr.data.url;
              else if (typeof sr.data === 'string' && sr.data.indexOf('http') === 0) streamUrl = sr.data;
              if (!streamUrl && typeof sr.data === 'string') {
                var m2 = sr.data.match(/src="(https?:\/\/[^"]+)"/);
                if (m2) streamUrl = m2[1];
              }
            }
            return streamUrl ? { name: 'FZ ' + srv.name, quality: 'HD', url: streamUrl, provider: 'fz' } : null;
          } catch (e) { return null; }
        });
        var res = await Promise.all(promises);
        res.forEach(function(x) { if (x) out.push(x); });
      }
    }

    console.log('[FZ] ' + slug + ': ' + out.length + ' sources');
  } catch (e) { console.log('[FZ] Scrape ' + slug + ': ' + (e.code || e.message)); }

  fzSet(key, out);
  return out;
}

/* =============== EMBED PROVIDERS (VidSrc fallback) =============== */
var EMBEDS_MOVIE = [
  ['VidSrc.xyz', 'https://vidsrc.xyz/embed/movie?imdb='],
  ['VidSrc.cc', 'https://vidsrc.cc/v2/embed/movie/'],
  ['VidSrc.to', 'https://vidsrc.to/embed/movie/'],
  ['Embed.su', 'https://embed.su/embed/movie/'],
  ['MultiEmbed', 'https://multiembed.mov/?video_id='],
  ['AutoEmbed', 'https://autoembed.cc/embed/movie/'],
  ['VidLink', 'https://vidlink.pro/movie/'],
  ['2Embed', 'https://www.2embed.cc/embed/imdb/movie?id='],
  ['Smashy', 'https://embed.smashystream.com/playere.php?imdb='],
  ['SuperEmbed', 'https://superembeds.com/embed/movie?imdb=']
];
var EMBEDS_TV = [
  ['VidSrc.xyz', 'https://vidsrc.xyz/embed/tv?imdb={id}&ss={s}&ee={e}'],
  ['VidSrc.cc', 'https://vidsrc.cc/v2/embed/tv/{id}/{s}/{e}'],
  ['VidSrc.to', 'https://vidsrc.to/embed/tv/{id}/{s}/{e}'],
  ['Embed.su', 'https://embed.su/embed/tv/{id}/{s}/{e}'],
  ['MultiEmbed', 'https://multiembed.mov/?video_id={id}&s={s}&e={e}'],
  ['AutoEmbed', 'https://autoembed.cc/embed/tv/{id}/{s}/{e}'],
  ['VidLink', 'https://vidlink.pro/tv/{id}/{s}/{e}'],
  ['2Embed', 'https://www.2embed.cc/embed/imdb/tv?id={id}&s={s}&e={e}'],
  ['Smashy', 'https://embed.smashystream.com/playere.php?imdb={id}&s={s}&e={e}'],
  ['SuperEmbed', 'https://superembeds.com/embed/tv?imdb={id}&s={s}&e={e}']
];

function embedSources(type, id, s, e) {
  if (type === 'series') {
    return EMBEDS_TV.map(function(v) {
      return { name: v[0], quality: 'auto', url: v[1].replace('{id}', id).replace('{s}', s || 1).replace('{e}', e || 1), provider: 'embed' };
    });
  }
  return EMBEDS_MOVIE.map(function(v) { return { name: v[0], quality: 'auto', url: v[1] + id, provider: 'embed' }; });
}

/* =============== UNIFIED ROUTES =============== */

// Trending: Cinemeta primary
async function getTrending(type) {
  try {
    var items = await cmCatalog(type, 0);
    return { results: items, source: 'cinemeta' };
  } catch (e) {
    console.log('[TRENDING] Cinemeta fail: ' + e.message);
    return { results: [], source: 'none' };
  }
}

// Search: Cinemeta + fzmovies
async function getSearch(type, q) {
  if (!q) return { results: [], source: 'none' };
  var items = [];
  var seen = {};

  // Cinemeta search
  try {
    var cm = await cmCatalog(type, 0, q);
    cm.forEach(function(x) { if (x.id && !seen[x.id]) { seen[x.id] = true; items.push(x); } });
  } catch (e) {}

  // fzmovies search (supplementary)
  try {
    var fz = await fzSearch(q);
    fz.forEach(function(x) {
      if (x.type === type) {
        var id = 'fz:' + x.slug;
        if (!seen[id]) {
          seen[id] = true;
          items.push({ id: id, type: type, title: x.title, poster: '', backdrop: '', year: '', rating: 0, overview: '', genres: [], fzSlug: x.slug });
        }
      }
    });
  } catch (e) {}

  return { results: items, source: items.length ? 'cinemeta+fz' : 'none' };
}

// Detail
async function getDetail(type, id) {
  // fzmovies ID
  if (id.indexOf('fz:') === 0) {
    var slug = id.replace('fz:', '');
    var title = slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    return { meta: { id: id, type: type, title: title, poster: '', backdrop: '', year: '', rating: 0, overview: '', genres: [], fzSlug: slug }, source: 'fzmovies' };
  }
  // Cinemeta
  var m = await cmMeta(type, id);
  return m ? { meta: m, source: 'cinemeta' } : { meta: null, source: 'none' };
}

// Sources: fzmovies primary → embed fallback
async function getSources(type, id, title, s, e) {
  var out = [];

  // 1. fzmovies (primary — real working embeds)
  var fzSlug = null;
  if (id.indexOf('fz:') === 0) {
    fzSlug = id.replace('fz:', '');
  } else if (title) {
    try {
      var fzResults = await fzSearch(title);
      if (fzResults.length) fzSlug = fzResults[0].slug;
    } catch (e) {}
  }
  if (fzSlug) {
    try {
      var fzSrcs = await fzSources(fzSlug, type);
      fzSrcs.forEach(function(x) { out.push(x); });
    } catch (e) {}
  }

  // 2. Embed providers (fallback)
  if (id.indexOf('tt') === 0) {
    embedSources(type, id, s, e).forEach(function(x) { out.push(x); });
  }

  // Dedupe
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
  try {
    var s = await fzSearch('dark nuns');
    out.push({ test: 'search', results: s.length, sample: s.slice(0, 2) });
  } catch (e) { out.push({ test: 'search', error: e.message }); }
  try {
    var t = await http.get(FZ + '/', { headers: { 'Accept': 'text/html' }, timeout: 8000 });
    var $ = cheerio.load(t.data);
    var count = $('.movie-engine-movie-card').length;
    out.push({ test: 'homepage', cards: count });
  } catch (e) { out.push({ test: 'homepage', error: e.message }); }
  res.json(out);
});

app.get('/api/debug/fz/:slug', async function(req, res) {
  res.json({ slug: req.params.slug, sources: await fzSources(req.params.slug, req.query.type || 'movie') });
});

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
  var id = req.params.id;
  var detail = (id.indexOf('fz:') === 0) ? null : await getDetail('movie', id);
  var title = detail && detail.meta ? detail.meta.title : '';
  res.json(await getSources('movie', id, title));
});

app.get('/api/tv/:id/sources', async function(req, res) {
  var id = req.params.id;
  var detail = (id.indexOf('fz:') === 0) ? null : await getDetail('series', id);
  var title = detail && detail.meta ? detail.meta.title : '';
  res.json(await getSources('series', id, title, req.query.s || 1, req.query.e || 1));
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
  var id = req.params.id;
  var detail = (id.indexOf('fz:') === 0) ? null : await getDetail('series', id);
  var title = detail && detail.meta ? detail.meta.title : '';
  res.json(await getSources('series', id, title, req.params.season, req.params.episode));
});

app.get('/api/movie/:id/4k', async function(req, res) {
  try {
    var id = req.params.id;
    var torrents = [];
    // By IMDb ID
    try {
      var r = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: id } });
      (r.data.data && r.data.data.movies || []).forEach(function(m) {
        (m.torrents || []).forEach(function(t) {
          torrents.push({ quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash, title: m.title_long || m.title, magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title) });
        });
      });
    } catch (e) {}
    // By title fallback
    if (!torrents.length) {
      var detail = await getDetail('movie', id);
      if (detail.meta && detail.meta.title) {
        try {
          var r2 = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: detail.meta.title, limit: 5 } });
          (r2.data.data && r2.data.data.movies || []).forEach(function(m) {
            (m.torrents || []).forEach(function(t) {
              torrents.push({ quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash, title: m.title_long || m.title, magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title) });
            });
          });
        } catch (e) {}
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

/* =============== INLINE UI =============== */
var HTML = [
'<!doctype html><html><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>MovieBox</title>',
'<script src="https://cdn.jsdelivr.net/npm/webtorrent@2.5.1/webtorrent.min.js"></scr' + 'ipt>',
'<style>',
':root{--bg:#101114;--card:#28292E;--acc:#1CB7FF;--acc2:#2FF58B;--gold:#FFDA6B;--txt:#EDEFF2;--mut:#9AA0A6}',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{background:var(--bg);color:var(--txt);font-family:system-ui,Segoe UI,Roboto,sans-serif;overflow-x:hidden}',
'a{color:inherit;text-decoration:none}',
'#side{position:fixed;top:0;bottom:0;left:0;width:220px;background:#16171B;padding:18px 14px;overflow-y:auto;z-index:10}',
'#side h1{font-size:20px;margin-bottom:18px}#side h1 b{color:var(--acc)}',
'.nav{padding:10px 12px;border-radius:10px;cursor:pointer;color:var(--mut);font-size:14px;margin-bottom:4px}',
'.nav.on{background:#22242A;color:var(--txt)}.nav:hover{color:var(--txt)}',
'#main{margin-left:220px;padding:0 0 90px;min-height:100vh}',
'.hero{position:relative;height:380px;background:#1A1B20;background-size:cover;background-position:center;display:flex;align-items:flex-end}',
'.hero .scrim{position:absolute;inset:0;background:linear-gradient(0deg,var(--bg) 5%,rgba(16,17,20,.2) 70%)}',
'.hero .info{position:relative;padding:26px 28px;max-width:640px}',
'.hero h2{font-size:30px;margin-bottom:8px}',
'.hero p{color:#C9CDD3;font-size:14px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
'.btn{display:inline-block;background:var(--acc);color:#06222E;font-weight:700;padding:10px 20px;border-radius:10px;cursor:pointer;margin:12px 8px 0 0;font-size:14px;border:none}',
'.btn.alt{background:#2A2C33;color:var(--txt)}',
'.btn.wt{background:#7B2FFF;color:#fff}',
'.row{margin:24px 0 6px}.row h2{font-size:17px;margin:0 22px 10px}',
'.strip{display:flex;gap:12px;overflow-x:auto;padding:4px 22px 12px;-webkit-overflow-scrolling:touch}',
'.card{width:150px;flex:0 0 auto;background:var(--card);border-radius:12px;overflow:hidden;cursor:pointer;position:relative;transition:transform .15s}',
'.card:hover{transform:scale(1.04)}',
'.card img{width:100%;height:225px;object-fit:cover;background:#1D1E23}',
'.card .mt{padding:8px}.card .t{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.card .y{color:var(--mut);font-size:11px;margin-top:3px}.card .r{color:var(--gold);font-weight:700}',
'.dl{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.65);border-radius:8px;padding:4px 8px;font-size:13px;cursor:pointer;z-index:2}',
'#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;padding:18px 22px}',
'#search{width:100%;padding:11px 14px;border-radius:10px;border:1px solid #2C2E35;background:#1B1C21;color:var(--txt);margin-bottom:14px;font-size:14px;outline:none}',
'.ov{position:fixed;inset:0;background:rgba(8,9,11,.96);z-index:60;display:flex;flex-direction:column}',
'.ov .bar{display:flex;align-items:center;gap:8px;padding:10px 16px;flex-shrink:0;flex-wrap:wrap;background:#0A0B0E}',
'.ov .bar .x{cursor:pointer;font-size:22px;color:var(--mut)}',
'.ov .body{flex:1;overflow-y:auto;padding:0 18px 30px}',
'.detail-hero{display:flex;gap:18px;flex-wrap:wrap}',
'.detail-hero img{width:210px;border-radius:12px;flex-shrink:0}',
'.detail-hero h2{font-size:24px;margin-bottom:6px}',
'.chip{display:inline-block;background:#24262C;border-radius:20px;padding:6px 12px;font-size:12px;margin:4px 6px 0 0;cursor:pointer}',
'.chip.on{background:var(--acc);color:#06222E;font-weight:700}',
'.srv-bar{display:flex;gap:5px;padding:6px 16px;overflow-x:auto;flex-shrink:0;background:#0E0F13;align-items:center;-webkit-overflow-scrolling:touch}',
'.srv-btn{padding:5px 10px;border-radius:6px;background:#1A1C22;color:var(--mut);font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;border:1px solid #2A2C33;transition:all .15s}',
'.srv-btn:hover{color:var(--txt);border-color:#444}',
'.srv-btn.on{background:var(--acc);color:#06222E;font-weight:700;border-color:var(--acc)}',
'.srv-btn.fz{border-color:rgba(255,218,107,.3)}',
'.srv-btn.fz.on{background:var(--gold);color:#1A1A1A;border-color:var(--gold)}',
'.srv-label{color:var(--mut);font-size:11px;flex-shrink:0;margin-right:4px}',
'#pframe{position:relative;flex:1;min-height:0}',
'#pframe iframe,#pframe video{position:absolute;inset:0;width:100%;height:100%;border:0}',
'#pmsg{padding:10px;text-align:center;color:var(--mut);flex-shrink:0;font-size:13px}',
'#tabs{position:fixed;left:0;right:0;bottom:0;background:#16171B;display:none;z-index:40}',
'#tabs .tb{flex:1;text-align:center;padding:11px 4px;font-size:11px;color:var(--mut);cursor:pointer}',
'#tabs .tb.on{color:var(--acc)}',
'#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--acc2);color:#06251A;font-weight:700;padding:11px 18px;border-radius:10px;z-index:99;opacity:0;transition:opacity .25s;font-size:13px;pointer-events:none}',
'.hd{padding:18px 22px 0}',
'.empty-msg{text-align:center;color:var(--mut);padding:60px 20px;font-size:15px}',
'.fz-badge{display:inline-block;background:rgba(255,218,107,.15);color:var(--gold);font-size:10px;padding:2px 6px;border-radius:4px;margin-left:4px}',
'.src-indicator{position:fixed;top:10px;right:10px;background:#16171B;padding:6px 12px;border-radius:8px;font-size:11px;color:var(--mut);z-index:5;pointer-events:none}',
'@media(max-width:860px){#side{display:none}#main{margin-left:0}#tabs{display:flex}.hero{height:320px}.hero h2{font-size:22px}.card{width:126px}.card img{height:190px}}',
'</style></head><body>',
'<div id="side"><h1>Movie<b>Box</b></h1>',
'<div class="nav on" data-tab="home">Home</div>',
'<div class="nav" data-tab="movies">Movies</div>',
'<div class="nav" data-tab="tv">TV Shows</div>',
'<div class="nav" data-tab="adult">18+</div>',
'<div class="nav" data-tab="mylist">My List</div>',
'<div style="margin-top:20px;padding:10px 12px;background:#1A1B20;border-radius:8px;font-size:11px">',
'<div style="color:#666;margin-bottom:4px">Server pref:</div>',
'<div id="srv-pref" style="color:var(--gold)">Auto</div></div></div>',
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
'window._open = window.open;',
'window.open = function(u){ if(u) window._open(u,"_blank"); return null; };',
'var S={tab:"home",hi:0,hm:[],sl:[],si:-1,cur:null,list:[],cw:[]};',
'try{S.list=JSON.parse(localStorage.getItem("mb_list")||"[]");S.cw=JSON.parse(localStorage.getItem("mb_cw")||"[]")}catch(e){}',
'function sp(){return localStorage.getItem("mb_server")||""}',
'function ss(n){localStorage.setItem("mb_server",n);var e=document.getElementById("srv-pref");if(e)e.textContent=n||"Auto"}',
'function $(s){return document.querySelector(s)}',
'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}',
'function api(p){var c=new AbortController(),t=setTimeout(function(){c.abort()},20000);return fetch(p,{signal:c.signal}).then(function(r){clearTimeout(t);return r.json()}).catch(function(e){clearTimeout(t);console.log("[API]",p,e.message);return{results:[],sources:[],torrents:[],meta:null}})}',
'function toast(t){var e=$("#toast");e.textContent=t;e.style.opacity=1;setTimeout(function(){e.style.opacity=0},3000)}',
'function card(x){',
'  var fb=x.id&&x.id.indexOf("fz:")===0?\'<span class="fz-badge">FZ</span>\':"",',
'  pb=x.poster?\'<img loading="lazy" src="\'+esc(x.poster)+\'" onerror="this.style.opacity=.15">\':\'<div style="height:225px;background:#1D1E23;display:flex;align-items:center;justify-content:center;color:#555;font-size:11px">No Poster</div>\';',
'  return \'<div class="card" data-id="\'+esc(x.id)+\'" data-type="\'+esc(x.type||"movie")+\'">\'+pb+',
'    \'<div class="dl" data-id="\'+esc(x.id)+\'" data-type="\'+esc(x.type||"movie")+\'">⬇</div>\'+',
'    \'<div class="mt"><div class="t">\'+esc(x.title)+fb+\'</div><div class="y">\'+esc(x.year)+\' <span class="r">\'+esc(x.rating||"")+\'</span></div></div></div\';',
'}',
'function row(title,items){if(!items||!items.length)return"";return \'<div class="row"><h2>\'+esc(title)+\'</h2><div class="strip">\'+items.map(card).join("")+\'</div></div>\'}',
'function rh(items){S.hm=items.slice(0,5);S.hi=0;ph();if(S._ht)clearInterval(S._ht);S._ht=setInterval(function(){S.hi=(S.hi+1)%(S.hm.length||1);ph()},6000)}',
'function ph(){var x=S.hm[S.hi];if(!x)return;var b=$("#hero");b.style.backgroundImage="url("+(x.backdrop||x.poster||"")+")";b.innerHTML=\'<div class="scrim"></div><div class="info"><h2>\'+esc(x.title)+\'</h2><div class="y" style="color:#FFDA6B;font-weight:700">\'+esc(x.year)+\' ★ \'+esc(x.rating||"")+\'</div><p>\'+esc(x.overview||"")+\'</p><span class="btn" data-id="\'+esc(x.id)+\'" data-type="\'+esc(x.type||"movie")+\'">▶ Play</span><span class="btn alt" data-dl="\'+esc(x.id)+\'">⬇ Download</span></div\'}',
'async function loadTab(tab){',
'  S.tab=tab;',
'  Array.prototype.forEach.call(document.querySelectorAll(".nav,.tb"),function(n){n.classList.toggle("on",n.getAttribute("data-tab")===tab)});',
'  $("#hero").style.display=tab==="home"?"flex":"none";',
'  var c=$("#content");c.innerHTML=\'<div class="hd empty-msg">Loading…</div>\';',
'  try{',
'    if(tab==="home"){',
'      var r=await Promise.all([api("/api/movies/trending"),api("/api/tv/trending")]);',
'      var m=r[0],t=r[1],all=(m.results||[]).concat(t.results||[]);',
'      if(all.length){rh(all);c.innerHTML=row("Trending Movies",m.results||[])+row("Trending TV Shows",t.results||[])}',
'      else c.innerHTML=\'<div class="hd empty-msg">No content. Try again.</div>\';',
'    }else if(tab==="movies"){',
'      var m2=await api("/api/movies/trending");',
'      c.innerHTML=\'<div class="hd"><input id="search" placeholder="Search movies…"></div><div id="grid">\'+(m2.results&&m2.results.length?m2.results.map(card).join(""):\'<div class="empty-msg">No movies.</div>\')+\'</div>\';bs("/api/movies/search")',
'    }else if(tab==="tv"){',
'      var t2=await api("/api/tv/trending");',
'      c.innerHTML=\'<div class="hd"><input id="search" placeholder="Search TV…"></div><div id="grid">\'+(t2.results&&t2.results.length?t2.results.map(card).join(""):\'<div class="empty-msg">No TV.</div>\')+\'</div>\';bs("/api/tv/search")',
'    }else if(tab==="adult"){',
'      if(localStorage.getItem("mb_age")!=="1"){c.innerHTML=\'<div class="hd"><h2>18+</h2><p style="color:#9AA0A6;margin:10px 0">Confirm 18+.</p><span class="btn" id="ageok">I am 18+</span></div>\';$("#ageok").onclick=function(){localStorage.setItem("mb_age","1");loadTab("adult")};return}',
'      var a=await api("/api/adult/trending");',
'      c.innerHTML=\'<div class="hd"><input id="search" placeholder="Search 18+…"></div><div id="grid">\'+(a.results||[]).map(function(x){return \'<div class="card" data-adult="\'+esc(x.id)+\'" data-source="\'+esc(x.source)+\'"><img loading="lazy" src="\'+esc(x.thumb)+\'" onerror="this.style.opacity=.15"><div class="mt"><div class="t">\'+esc(x.title)+\'</div><div class="y">\'+esc(x.source)+\'</div></div></div>\'}).join("")+\'</div>\';',
'      var si=$("#search");si&&(si.onkeydown=async function(e){if(e.key!=="Enter")return;var r=await api("/api/adult/search?q="+encodeURIComponent(si.value));$("#grid").innerHTML=(r.results||[]).map(function(x){return \'<div class="card" data-adult="\'+esc(x.id)+\'" data-source="\'+esc(x.source)+\'"><img loading="lazy" src="\'+esc(x.thumb)+\'"><div class="mt"><div class="t">\'+esc(x.title)+\'</div></div></div>\'}).join("")})',
'    }else if(tab==="mylist"){',
'      c.innerHTML=\'<div class="hd"><h2>My List</h2></div><div id="grid">\'+(S.list.length?S.list.map(card).join(""):\'<div class="empty-msg">Nothing saved.</div>\')+\'</div>\'',
'    }',
'  }catch(err){c.innerHTML=\'<div class="hd empty-msg">Error. Refresh.</div>\'}',
'}',
'function bs(ep){var si=$("#search");if(!si)return;si.onkeydown=async function(e){if(e.key!=="Enter")return;var r=await api(ep+"?q="+encodeURIComponent(si.value));$("#grid").innerHTML=(r.results&&r.results.length?r.results.map(card).join(""):\'<div class="empty-msg">No results.</div>\')};si.focus()}',
'async function download(id){toast("Searching…");var r=await api("/api/movie/"+id+"/4k");var ts=r.torrents||[];if(!ts.length){toast("No torrents — try play");return}var p=ts[0];try{await navigator.clipboard.writeText(p.magnet)}catch(e){}toast(p.quality+" · "+p.size+" · copied")}',
'async function openDetail(id,type){',
'  var pf=type==="series"?"/api/tv/":"/api/movie/";',
'  var sp=api(pf+id+"/sources"),d=await api(pf+id),s=await sp;',
'  S.cur={id:id,type:type};',
'  var m=d.meta||{id:id,title:"",poster:"",year:"",rating:"",overview:"",genres:[]};',
'  var sc=s.sources||[];',
'  var fc=sc.filter(function(x){return x.provider==="fz"}).length;',
'  var html=\'<div class="bar"><span class="x" id="dclose">✕</span><b>Details</b><span style="margin-left:auto;color:var(--mut);font-size:11px">\'+fc+\' fzmovies + \'+(sc.length-fc)+\' fallback</span></div><div class="body">\'+',
'    \'<div class="detail-hero"><img src="\'+esc(m.poster)+\'" onerror="this.style.opacity=.2"><div><h2>\'+esc(m.title)+\'</h2>\'+',
'    \'<div style="color:#FFDA6B;font-weight:700;margin-bottom:8px">\'+esc(m.year)+\' ★ \'+esc(m.rating||"")+\'</div>\'+',
'    \'<p style="color:#C9CDD3;line-height:1.6;max-width:560px">\'+esc(m.overview||"")+\'</p>\'+',
'    \'<div>\'+(m.genres||[]).map(function(g){return \'<span class="chip">\'+esc(g)+\'</span>\'}).join("")+\'</div>\'+',
'    (m.cast?\'<div style="margin-top:8px;color:#9AA0A6;font-size:13px">Cast: \'+esc(m.cast)+\'</div>\':"")+',
'    \'<span class="btn" id="dplay">▶ Play</span>\'+',
'    \'<span class="btn alt" id="ddl">⬇ Download</span>\'+',
'    \'<span class="btn alt" id="dsave">+ My List</span></div></div>\';',
'  if(type==="series"&&m.videos&&m.videos.length){',
'    var seas={};m.videos.forEach(function(v){var k=v.season||1;(seas[k]=seas[k]||[]).push(v)});',
'    html+=\'<h2 style="margin:18px 0 8px">Episodes</h2>\';',
'    Object.keys(seas).forEach(function(k){html+=\'<div style="margin-bottom:10px"><b style="color:#9AA0A6;font-size:13px">Season \'+esc(k)+\'</b><div class="strip">\'+seas[k].map(function(v){return \'<div class="chip" data-s="\'+esc(v.season)+\'" data-e="\'+esc(v.episode)+\'">E\'+esc(v.episode)+\' · \'+esc(v.title||"")+\'</div>\'}).join("")+\'</div></div>\'})',
'  }',
'  html+=\'<h2 style="margin:18px 0 8px">Similar</h2>\';',
'  var sim=await api(pf+id+"/similar");',
'  html+=\'<div class="strip">\'+(sim.results||[]).map(card).join("")+\'</div></div>\';',
'  var el=$("#detail");el.innerHTML=html;el.style.display="flex";',
'  el.querySelector("#dclose").onclick=function(){el.style.display="none"};',
'  el.querySelector("#ddl").onclick=function(){download(id)};',
'  el.querySelector("#dsave").onclick=function(){if(!S.list.some(function(x){return x.id===id}))S.list.push(m);localStorage.setItem("mb_list",JSON.stringify(S.list));toast("Added")};',
'  el.querySelector("#dplay").onclick=function(){showSrcs(sc,m)};',
'  Array.prototype.forEach.call(el.querySelectorAll(".chip[data-s]"),function(ch){',
'    ch.onclick=async function(){var ss=await api("/api/tv/"+id+"/"+ch.getAttribute("data-s")+"/"+ch.getAttribute("data-e"));showSrcs(ss.sources||[],m)};',
'  });',
'  showSrcs(sc,m);',
'}',
'function showSrcs(list,meta){',
'  S.sl=list||[];',
'  if(!S.sl.length){toast("No sources");return}',
'  var pref=sp(),si=0;',
'  if(pref){for(var i=0;i<S.sl.length;i++){if(S.sl[i].name===pref||S.sl[i].name.indexOf(pref)>=0){si=i;break}}}',
'  S.si=si;',
'  var sh=\'\';',
'  for(var i=0;i<S.sl.length;i++){var s=S.sl[i],isFz=s.provider==="fz",cls="srv-btn"+(isFz?" fz":"")+(i===si?" on":"");sh+=\'<span class="\'+cls+\'" data-srv="\'+i+\'">\'+esc(s.name)+\'</span>\'}',
'  var pl=$("#player");',
'  pl.innerHTML=\'<div class="bar"><span class="x" id="pclose">✕</span><b>\'+esc(meta.title||"Player")+\'</b><span class="btn alt" id="pwt" style="margin:0 0 0 auto;padding:6px 14px;font-size:12px">🌊 Torrent</span></div><div class="srv-bar"><span class="srv-label">Server:</span>\'+sh+\'</div><div id="pframe"></div><div id="pmsg"></div>\';',
'  pl.style.display="flex";',
'  document.getElementById("pclose").onclick=function(){pl.style.display="none";document.getElementById("pframe").innerHTML=""};',
'  document.getElementById("pwt").onclick=function(){if(S.cur)wt(S.cur.id,meta)};',
'  Array.prototype.forEach.call(pl.querySelectorAll(".srv-btn"),function(btn){',
'    btn.onclick=function(){',
'      var idx=parseInt(btn.getAttribute("data-srv"));S.si=idx;ss(S.sl[idx].name);',
'      Array.prototype.forEach.call(pl.querySelectorAll(".srv-btn"),function(b){b.classList.remove("on")});btn.classList.add("on");',
'      loadS(idx);',
'    };',
'  });',
'  loadS(si);',
'}',
'function loadS(idx){',
'  if(idx<0||idx>=S.sl.length)return;',
'  var s=S.sl[idx],fr=document.createElement("iframe");',
'  fr.src=s.url;fr.allow="autoplay; fullscreen; encrypted-media; picture-in-picture";fr.setAttribute("referrerPolicy","no-referrer");',
'  var pf=document.getElementById("pframe");pf.innerHTML="";pf.appendChild(fr);',
'  document.getElementById("pmsg").textContent="Playing: "+s.name+" ("+(idx+1)+"/"+S.sl.length+")";',
'}',
'async function wt(imdbId,meta){',
'  var pf=document.getElementById("pframe"),pm=document.getElementById("pmsg");if(!pf||!pm)return;',
'  pf.innerHTML="";pm.textContent="Searching torrents…";',
'  var tr=await api("/api/movie/"+imdbId+"/4k");',
'  if(!tr.torrents||!tr.torrents.length){pm.textContent="No torrents.";return}',
'  var p=tr.torrents[0];pm.textContent="Starting: "+p.quality+" · "+p.size+" · connecting…";',
'  try{',
'    if(!window.WebTorrent){pm.textContent="WebTorrent not loaded.";return}',
'    if(S.wc)S.wc.destroy();S.wc=new WebTorrent();',
'    S.wc.on("error",function(e){pm.textContent="Error: "+e.message});',
'    S.wc.add(p.magnet,{announce:["wss://tracker.openwebtorrent.com","wss://tracker.btorrent.xyz"]},function(torrent){',
'      var file=torrent.files.reduce(function(b,f){return(/\.(mp4|mkv|webm)$/i.test(f.name)&&(!b||f.length>b.length))?f:b},null);',
'      if(!file){pm.textContent="No video in torrent.";return}',
'      pf.innerHTML=\'<video id="wtv" controls autoplay playsinline style="width:100%;height:100%;background:#000"></video>\';',
'      file.renderTo("#wtv",{autoplay:true},function(e){if(e)pm.textContent="Error: "+e.message});',
'      pm.textContent="Streaming: "+file.name+" · "+torrent.numPeers+" peers";',
'    });',
'  }catch(e){pm.textContent="Error: "+e.message}',
'}',
'async function playAdult(id,source){',
'  var r=await api("/api/adult/video/"+source+"?u="+id);',
'  var pl=$("#player");pl.innerHTML=\'<div class="bar"><span class="x" id="pclose">✕</span><b>18+</b></div><div id="pframe"></div><div id="pmsg"></div>\';pl.style.display="flex";',
'  document.getElementById("pclose").onclick=function(){pl.style.display="none";document.getElementById("pframe").innerHTML=""};',
'  if(r.urls&&r.urls.length){document.getElementById("pframe").innerHTML=\'<video controls autoplay playsinline style="width:100%;height:100%;background:#000" src="\'+esc(r.urls[0])+\'"></video>\'}',
'  else if(r.page){document.getElementById("pframe").innerHTML=\'<iframe allow="autoplay; fullscreen" referrerpolicy="no-referrer" src="\'+esc(r.page)+\'"></iframe>\'}',
'  else document.getElementById("pmsg").textContent="No video."',
'}',
'document.addEventListener("click",function(e){',
'  var nav=e.target.closest(".nav,.tb");if(nav&&nav.getAttribute("data-tab")){loadTab(nav.getAttribute("data-tab"));return}',
'  var dl=e.target.closest(".dl");if(dl){e.stopPropagation();download(dl.getAttribute("data-id"));return}',
'  var dlb=e.target.closest("[data-dl]");if(dlb){download(dlb.getAttribute("data-dl"));return}',
'  var ad=e.target.closest("[data-adult]");if(ad){playAdult(ad.getAttribute("data-adult"),ad.getAttribute("data-source"));return}',
'  var c=e.target.closest(".card[data-id]");if(c){openDetail(c.getAttribute("data-id"),c.getAttribute("data-type"));return}',
'  var p=e.target.closest(".btn[data-id]");if(p){openDetail(p.getAttribute("data-id"),p.getAttribute("data-type"));return}',
'});',
'(function(){var e=document.getElementById("srv-pref");if(e)e.textContent=sp()||"Auto"})();',
'loadTab("home");',
'</scr' + 'ipt></body></html>'
].join('');

app.get('/', function(req, res) { res.type('html').send(HTML); });
app.get('*', function(req, res) {
  if (req.path.indexOf('/api/') === 0) return res.status(404).json({ error: 'unknown route' });
  res.type('html').send(HTML);
});

app.listen(PORT, function() { console.log('MovieBox on ' + PORT + ' — Cinemeta catalog + fzmovies video + embed fallback'); });
