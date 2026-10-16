/* ==========================================================
   server.js — MovieBox streaming site
   PRIMARY VIDEO: fzmovies.watch (15 servers, real embeds)
   PRIMARY CATALOG: MovieBox API (consistency guarantee)
   FALLBACK: Cinemeta metadata + VidSrc embeds + YTS
   ========================================================== */
var express = require('express');
var axios = require('axios');
var cheerio = require('cheerio');
var fs = require('fs');

var app = express();
var PORT = process.env.PORT || 3000;

var http = axios.create({
  timeout: 6000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*'
  }
});

function withTimeout(p, ms) {
  return Promise.race([p, new Promise(function(_, r) { setTimeout(function() { r(new Error('timeout')); }, ms); })]);
}

/* =============== FZMOVIES WATCH — PRIMARY VIDEO SOURCE =============== */
var FZ_BASE = 'https://fzmovies.watch';
var fzCache = {};
var FZ_TTL = 30 * 60 * 1000;

function fzCached(key) {
  var c = fzCache[key];
  return (c && Date.now() - c.at < FZ_TTL) ? c.data : null;
}
function fzStore(key, data) {
  fzCache[key] = { data: data, at: Date.now() };
}

// Search fzmovies by title via WP REST API
async function fzSearch(query) {
  var key = 'fz:search:' + query.toLowerCase().trim();
  var cached = fzCached(key);
  if (cached) return cached;

  var results = [];

  // Method 1: WP REST API
  try {
    var r = await withTimeout(http.get(FZ_BASE + '/wp-json/wp/v2/movie_engine_movie', {
      params: { search: query, per_page: 8, _fields: 'id,title,slug,link' }
    }), 8000);
    if (r.data && Array.isArray(r.data)) {
      results = r.data.map(function(p) {
        var t = (p.title && p.title.rendered) ? p.title.rendered.replace(/<[^>]+>/g, '') : '';
        var slug = p.slug || '';
        var link = p.link || '';
        var isTv = link.indexOf('/tv-series/') >= 0;
        return { postId: p.id, title: t, slug: slug, type: isTv ? 'series' : 'movie' };
      }).filter(function(x) { return x.title; });
    }
  } catch(e) { console.log('[FZ] REST search fail: ' + (e.code || e.message)); }

  // Method 2: Scrape search page
  if (!results.length) {
    try {
      var html = (await withTimeout(http.get(FZ_BASE + '/', {
        params: { s: query },
        headers: { 'Accept': 'text/html' }
      }), 8000)).data;
      var $ = cheerio.load(html);
      var seen = {};
      $('a[href*="/movies/"], a[href*="/tv-series/"]').each(function(i, el) {
        if (results.length >= 8) return;
        var href = $(el).attr('href') || '';
        var title = $(el).attr('aria-label') || $(el).find('.movie-engine-card-title').text() || $(el).text();
        title = title.trim();
        if (title.length < 3 || title.length > 200) return;
        var slug = href.replace(FZ_BASE + '/movies/', '').replace(FZ_BASE + '/tv-series/', '').replace(/\/$/, '');
        if (!slug || seen[slug]) return;
        seen[slug] = true;
        var isTv = href.indexOf('/tv-series/') >= 0;
        results.push({ postId: 0, title: title, slug: slug, type: isTv ? 'series' : 'movie' });
      });
    } catch(e) { console.log('[FZ] Search scrape fail: ' + (e.code || e.message)); }
  }

  fzStore(key, results);
  return results;
}

// Get video sources from fzmovies movie page
async function fzGetSources(slug, type) {
  var key = 'fz:src:' + slug;
  var cached = fzCached(key);
  if (cached) return cached;

  var path = (type === 'series') ? '/tv-series/' : '/movies/';
  var url = FZ_BASE + path + slug + '/';
  var sources = [];

  try {
    var r = await withTimeout(http.get(url, { headers: { 'Accept': 'text/html' } }), 10000);
    var html = typeof r.data === 'string' ? r.data : '';
    var $ = cheerio.load(html);

    // 1. Extract post ID and nonce
    var postIdMatch = html.match(/data-post-id="(\d+)"/);
    var postId = postIdMatch ? postIdMatch[1] : null;
    var nonceMatch = html.match(/"nonce":"([a-f0-9]+)"/);
    var nonce = nonceMatch ? nonceMatch[1] : null;
    var restNonceMatch = html.match(/"rest_nonce":"([a-f0-9]+)"/);
    var restNonce = restNonceMatch ? restNonceMatch[1] : nonce;

    // 2. Extract default iframe (always embedded)
    var defaultIframe = null;
    var containerRe = /movie-engine-player-container[^>]*>([\s\S]*?)<\/div>\s*<\/div>/;
    var containerMatch = html.match(containerRe);
    if (containerMatch) {
      var iframeRe = /<iframe[^>]+src="([^"]+)"/;
      var iframeMatch = containerMatch[1].match(iframeRe);
      if (iframeMatch) defaultIframe = iframeMatch[1];
    }
    // Simpler fallback
    if (!defaultIframe) {
      var simpleRe = /<iframe[^>]+src="(https?:\/\/[^"]+)"[^>]*>/g;
      var sm;
      while ((sm = simpleRe.exec(html))) {
        var src = sm[1];
        if (src.indexOf('youtube') < 0 && src.indexOf('vimeo') < 0 && src.indexOf('googletagmanager') < 0) {
          defaultIframe = src;
          break;
        }
      }
    }
    if (defaultIframe) {
      sources.push({ name: 'FZ Default', quality: 'HD', url: defaultIframe, provider: 'fz' });
    }

    // 3. Extract server buttons
    var servers = [];
    var serverRe = /data-server-index="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
    var srvMatch;
    while ((srvMatch = serverRe.exec(html))) {
      var idx = srvMatch[1];
      var nameMatch = srvMatch[2].match(/movie-engine-server-name[^>]*>([^<]+)/);
      var name = nameMatch ? nameMatch[1].trim() : ('Server ' + idx);
      var isActive = srvMatch[0].indexOf('active') >= 0;
      servers.push({ index: idx, name: name, isActive: isActive });
    }

    // 4. Try stream API for each server (parallel, 3 at a time)
    if (postId && servers.length > 1) {
      var batches = [];
      for (var i = 0; i < servers.length; i += 3) {
        batches.push(servers.slice(i, i + 3));
      }
      for (var b = 0; b < batches.length; b++) {
        var batch = batches[b];
        var promises = batch.map(async function(srv) {
          if (srv.isActive && defaultIframe) return null;
          try {
            var headers = {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': url,
              'Accept': 'application/json',
              'Origin': FZ_BASE
            };
            if (restNonce) headers['X-WP-Nonce'] = restNonce;
            var streamR = await withTimeout(
              http.post(FZ_BASE + '/wp-json/movie-engine/v1/stream/',
                'post_id=' + postId + '&server_index=' + srv.index,
                { headers: headers }
              ), 5000
            );
            var streamUrl = null;
            if (streamR.data) {
              if (streamR.data.data && streamR.data.data.url) streamUrl = streamR.data.data.url;
              else if (streamR.data.url) streamUrl = streamR.data.url;
              else if (typeof streamR.data === 'string' && streamR.data.indexOf('http') === 0) streamUrl = streamR.data;
              // Check for nested HTML with iframe
              if (!streamUrl && typeof streamR.data === 'string') {
                var iframeM = streamR.data.match(/src="(https?:\/\/[^"]+)"/);
                if (iframeM) streamUrl = iframeM[1];
              }
              if (!streamUrl && streamR.data.data && typeof streamR.data.data === 'string') {
                var iframeM2 = streamR.data.data.match(/src="(https?:\/\/[^"]+)"/);
                if (iframeM2) streamUrl = iframeM2[1];
              }
            }
            return streamUrl ? { name: 'FZ ' + srv.name, quality: 'HD', url: streamUrl, provider: 'fz' } : null;
          } catch(e) { return null; }
        });
        var results = await Promise.all(promises);
        results.forEach(function(x) { if (x) sources.push(x); });
      }
    }

    console.log('[FZ] ' + slug + ': ' + sources.length + ' sources');
  } catch(e) {
    console.log('[FZ] Scrape fail ' + slug + ': ' + (e.code || e.message));
  }

  fzStore(key, sources);
  return sources;
}

// fzmovies trending (scrape homepage)
async function fzTrending() {
  var cached = fzCached('fz:trending');
  if (cached) return cached;

  var results = [];
  try {
    var r = await withTimeout(http.get(FZ_BASE + '/', { headers: { 'Accept': 'text/html' } }), 8000);
    var $ = cheerio.load(r.data);
    var seen = {};
    $('.movie-engine-movie-card').each(function(i, el) {
      if (results.length >= 30) return;
      var a = $(el).find('a.movie-engine-card-poster');
      var href = a.attr('href') || '';
      var img = $(el).find('img').attr('src') || '';
      var title = $(el).find('.movie-engine-card-title a').text().trim();
      var year = $(el).find('.year').text().trim();
      var rating = $(el).find('.movie-engine-card-rating').text().trim().replace(/[^0-9.]/g, '');
      var slug = href.replace(FZ_BASE + '/movies/', '').replace(FZ_BASE + '/tv-series/', '').replace(/\/$/, '');
      if (!slug || seen[slug] || !title) return;
      seen[slug] = true;
      var isTv = href.indexOf('/tv-series/') >= 0;
      results.push({
        id: 'fz:' + slug, type: isTv ? 'series' : 'movie', title: title,
        poster: img, backdrop: '', year: year,
        rating: parseFloat(rating) || 0, overview: '', genres: [],
        fzSlug: slug, fzType: isTv ? 'series' : 'movie'
      });
    });
    console.log('[FZ] Trending: ' + results.length + ' items');
  } catch(e) { console.log('[FZ] Trending fail: ' + (e.code || e.message)); }

  fzStore('fz:trending', results);
  return results;
}

/* =============== MOVIEBOX PRIMARY LAYER (CATALOG) =============== */
var MB_BASES = ['https://movieboxhd.net', 'https://web.moviebox.ng', 'https://moviebox.digital', 'https://moviebox.bio', 'https://moviebox.ng'];
var mbActive = null;
var SNAP = '/tmp/mb_snapshot.json';

function snapLoad() { try { return JSON.parse(fs.readFileSync(SNAP, 'utf8')) || {}; } catch (e) { return {}; } }
function snapSave(kind, items) { try { var s = snapLoad(); s[kind] = { items: items, at: Date.now() }; fs.writeFileSync(SNAP, JSON.stringify(s)); } catch (e) {} }
function snapItems(kind) { var s = snapLoad()[kind]; return s && s.items && s.items.length ? s.items : null; }

async function mbFetch(pathname, params) {
  var bases = mbActive ? [mbActive] : [MB_BASES[0], MB_BASES[1]];
  if (mbActive && mbActive !== MB_BASES[0]) bases.push(MB_BASES[0]);
  for (var i = 0; i < bases.length; i++) {
    try {
      var r = await http.get(bases[i] + pathname, { params: params });
      if (r.data && typeof r.data === 'object') { mbActive = bases[i]; return r.data; }
    } catch (e) {}
  }
  throw new Error('moviebox unreachable');
}

function mbList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.data)) return raw.data;
    var d = raw.data;
    if (d && typeof d === 'object') return d.list || d.items || d.movies || d.results || d.contents || [];
    return raw.list || raw.items || raw.movies || raw.results || [];
  }
  return [];
}

function mbNorm(m, type) {
  if (!m || typeof m !== 'object') return null;
  var rid = String(m.imdb_code || m.imdb_id || m.imdb || m.id || '');
  var id = rid.indexOf('tt') === 0 ? rid : (/^\d+$/.test(rid) ? 'tt' + rid : '');
  if (!id) return null;
  return { id: id, type: type || 'movie', title: m.title || m.name || m.original_title || 'Untitled', poster: m.poster || m.cover || m.thumb || m.poster_url || m.image || '', backdrop: m.backdrop || m.background || '', year: String(m.year || m.release_date || '').slice(0, 4), rating: m.rating || m.imdb_rating || 0, overview: m.overview || m.description || '', genres: m.genres || m.genre || [] };
}

async function mbTrending(type) {
  var shapes = [['/api/home', { type: type }], ['/api/discover', { type: type }], ['/api/v1/home', { type: type }]];
  for (var i = 0; i < shapes.length; i++) {
    try {
      var raw = await withTimeout(mbFetch(shapes[i][0], shapes[i][1]), 5000);
      var items = mbList(raw).map(function(x) { return mbNorm(x, type); }).filter(Boolean);
      if (items.length) return items;
    } catch (e) {}
  }
  throw new Error('moviebox trending empty');
}

async function mbSearch(type, q) {
  var shapes = [['/api/search', { q: q, type: type }], ['/api/v1/search', { q: q, type: type }]];
  for (var i = 0; i < shapes.length; i++) {
    try {
      var raw = await withTimeout(mbFetch(shapes[i][0], shapes[i][1]), 5000);
      var items = mbList(raw).map(function(x) { return mbNorm(x, type); }).filter(function(x) { return x && x.id; });
      if (items.length) return items;
    } catch (e) {}
  }
  return [];
}

async function mbDetail(type, id) {
  var shapes = [['/api/detail', { imdb_id: id, type: type }], ['/api/v1/detail/' + id, { type: type }]];
  for (var i = 0; i < shapes.length; i++) {
    try {
      var raw = await withTimeout(mbFetch(shapes[i][0], shapes[i][1]), 5000);
      var list = mbList(raw);
      var norm = mbNorm(list[0] || raw.data || raw, type);
      if (norm && norm.title) return norm;
    } catch (e) {}
  }
  return null;
}

async function mbSources(type, id, s, e) {
  var shapes = [['/api/play', { imdb_id: id, type: type, season: s, episode: e }], ['/api/v1/play', { imdb_id: id, type: type, season: s, episode: e }]];
  for (var i = 0; i < shapes.length; i++) {
    try {
      var raw = await withTimeout(mbFetch(shapes[i][0], shapes[i][1]), 5000);
      var out = mbList(raw).map(function(x) { return { name: x.name || 'MB', quality: x.quality || 'auto', url: x.url || x.play_url || x.link || '', provider: 'mb' }; }).filter(function(x) { return x.url; });
      if (out.length) return out;
    } catch (e) {}
  }
  return [];
}

async function mbVideoUrls(type, id) {
  var paths = type === 'series' ? ['/tv/' + id, '/watch/tv/' + id] : ['/movie/' + id, '/watch/' + id, '/detail/' + id];
  for (var b = 0; b < Math.min(MB_BASES.length, 2); b++) {
    for (var p = 0; p < paths.length; p++) {
      try {
        var r = await http.get(MB_BASES[b] + paths[p]);
        var html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        var urls = [];
        var re = /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/g;
        var m;
        while ((m = re.exec(html)) && urls.length < 5) {
          urls.push({ name: 'MB Stream', quality: 'auto', url: m[1], provider: 'mb' });
        }
        if (urls.length) return urls;
      } catch (e) {}
    }
  }
  return [];
}

/* =============== FREE FALLBACK STACK =============== */
var CINEMETA = 'https://v3-cinemeta.strem.io';

async function cmCatalog(type, skip, q) {
  var url = CINEMETA + '/catalog/' + type + '/top' + (q ? '/search=' + encodeURIComponent(q) : '/skip=' + (skip || 0)) + '.json';
  var r = await http.get(url);
  return (r.data.metas || []).map(function(m) { return { id: m.imdb_id || m.id, type: type, title: m.name, poster: m.poster || '', backdrop: m.background || '', year: String(m.releaseInfo || '').slice(0, 4), rating: m.imdbRating || 0, overview: m.description || '', genres: m.genres || [] }; });
}

async function cmMeta(type, id) {
  try { var r = await http.get(CINEMETA + '/meta/' + type + '/' + id + '.json'); return r.data.meta || null; } catch (e) { return null; }
}

var VIDSRCS_MOVIE = [
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
var VIDSRCS_TV = [
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

function vidSources(type, id, s, e) {
  if (type === 'series') return VIDSRCS_TV.map(function(v) { return { name: v[0], quality: 'auto', url: v[1].replace('{id}', id).replace('{s}', s || 1).replace('{e}', e || 1), provider: 'embed' }; });
  return VIDSRCS_MOVIE.map(function(v) { return { name: v[0], quality: 'auto', url: v[1] + id, provider: 'embed' }; });
}

/* =============== UNIFIED =============== */
async function unifiedTrending(type) {
  // fzmovies trending as supplementary source for richer catalog
  var fzItems = [];
  try { fzItems = await fzTrending(); } catch(e) {}
  var fzFiltered = fzItems.filter(function(x) { return x.type === type; });

  try {
    var items = await mbTrending(type);
    snapSave(type, items);
    // Merge fz items that aren't duplicates
    if (fzFiltered.length) {
      var titles = {};
      items.forEach(function(x) { titles[x.title.toLowerCase()] = true; });
      fzFiltered.forEach(function(x) {
        if (!titles[x.title.toLowerCase()]) items.push(x);
      });
    }
    return { results: items, source: 'moviebox' };
  } catch(e) {
    var cached = snapItems(type);
    if (cached) {
      if (fzFiltered.length) {
        var titles2 = {};
        cached.forEach(function(x) { titles2[x.title.toLowerCase()] = true; });
        fzFiltered.forEach(function(x) { if (!titles2[x.title.toLowerCase()]) cached.push(x); });
      }
      return { results: cached, source: 'moviebox-cache' };
    }
    if (fzFiltered.length) return { results: fzFiltered, source: 'fzmovies' };
    try { return { results: await cmCatalog(type, 0), source: 'fallback' }; }
    catch(e2) { return { results: [], source: 'none' }; }
  }
}

async function unifiedSearch(type, q) {
  if (!q) return { results: [], source: 'none' };
  // Search both fzmovies and MovieBox in parallel
  var fzP = fzSearch(q).catch(function() { return []; });
  var mbP = mbSearch(type, q).catch(function() { return []; });
  var fzResults = await fzP;
  var mbResults = await mbP;

  var items = [];
  var seen = {};
  // MB results first
  mbResults.forEach(function(x) {
    if (x.id && !seen[x.id]) { seen[x.id] = true; items.push(x); }
  });
  // FZ results (convert to common format)
  fzResults.forEach(function(x) {
    var id = 'fz:' + x.slug;
    if (!seen[id]) {
      seen[id] = true;
      items.push({ id: id, type: x.type || type, title: x.title, poster: '', backdrop: '', year: '', rating: 0, overview: '', genres: [], fzSlug: x.slug, fzType: x.type });
    }
  });

  if (items.length) return { results: items, source: items.length ? (mbResults.length ? 'moviebox+fz' : 'fzmovies') : 'none' };
  try { return { results: await cmCatalog(type, 0, q), source: 'fallback' }; }
  catch(e2) { return { results: [], source: 'none' }; }
}

async function unifiedDetail(type, id) {
  // If fzmovies ID
  if (id.indexOf('fz:') === 0) {
    var slug = id.replace('fz:', '');
    return { meta: { id: id, type: type, title: slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }), poster: '', backdrop: '', year: '', rating: 0, overview: '', genres: [], fzSlug: slug }, source: 'fzmovies' };
  }
  try {
    var d = await mbDetail(type, id);
    if (d && d.title) return { meta: d, source: 'moviebox' };
  } catch(e) {}
  var m = await cmMeta(type, id);
  if (!m) return { meta: null, source: 'none' };
  return { meta: { id: m.imdb_id || m.id, type: type, title: m.name, poster: m.poster || '', backdrop: m.background || '', year: String(m.releaseInfo || '').slice(0, 4), rating: m.imdbRating || 0, overview: m.description || '', genres: m.genres || [], cast: (m.cast || []).join(', '), director: (m.director || m.writers || []).join(', '), videos: (m.videos || []).map(function(v) { return { id: v.id, season: v.season, episode: v.episode, title: v.title, thumbnail: v.thumbnail || '' }; }) }, source: 'fallback' };
}

async function unifiedSources(type, id, title, s, e) {
  var out = [];

  // 1. fzmovies — PRIMARY (real working embeds from 15 servers)
  var fzSlug = null;
  var fzType = type;
  if (id.indexOf('fz:') === 0) {
    fzSlug = id.replace('fz:', '');
    fzType = type;
  } else if (title) {
    try {
      var fzResults = await fzSearch(title);
      if (fzResults.length) {
        fzSlug = fzResults[0].slug;
        fzType = fzResults[0].type || type;
      }
    } catch(e) {}
  }
  if (fzSlug) {
    try {
      var fzSrcs = await fzGetSources(fzSlug, fzType);
      fzSrcs.forEach(function(x) { out.push(x); });
    } catch(e) {}
  }

  // 2. MovieBox video scraping
  if (id.indexOf('fz:') !== 0) {
    try { (await withTimeout(mbVideoUrls(type, id), 5000)).forEach(function(x) { out.push(x); }); } catch(e) {}
    // 3. MovieBox API
    try { (await mbSources(type, id, s, e)).forEach(function(x) { out.push(x); }); } catch(e) {}
  }

  // 4. Free embed providers (fallback)
  if (id.indexOf('tt') === 0) {
    vidSources(type, id, s, e).forEach(function(x) { out.push(x); });
  }

  // Deduplicate by URL
  var seen = {};
  out = out.filter(function(x) {
    if (seen[x.url]) return false;
    seen[x.url] = true;
    return true;
  });

  return { sources: out };
}

/* =============== ADULT SCRAPERS =============== */
var ADULT_SOURCES = [
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
  var jobs = ADULT_SOURCES.map(async function(src) {
    try { return extractAdult((await http.get(urlFn ? urlFn(src) : src.list)).data, src); } catch (e) { return []; }
  });
  var merged = (await Promise.all(jobs)).reduce(function(a, b) { return a.concat(b); }, []);
  var seen = {};
  return merged.filter(function(x) { return seen[x.url] ? false : (seen[x.url] = true); });
}

/* =============== ROUTES =============== */
app.get('/api/health', function(req, res) {
  var s = snapLoad();
  res.json({ ok: true, fz_base: FZ_BASE, moviebox_base: mbActive, primary: MB_BASES[0], snapshot: { movies: s.movies ? Math.round((Date.now() - s.movies.at) / 1000) + 's ago' : 'none', series: s.series ? Math.round((Date.now() - s.series.at) / 1000) + 's ago' : 'none' } });
});

app.get('/api/debug/fz', async function(req, res) {
  var out = [];
  // Test search
  try {
    var search = await fzSearch('dark nuns');
    out.push({ test: 'search', query: 'dark nuns', results: search.length, first: search[0] || null });
  } catch(e) { out.push({ test: 'search', error: e.message }); }
  // Test trending
  try {
    var trend = await fzTrending();
    out.push({ test: 'trending', count: trend.length, sample: trend.slice(0, 3) });
  } catch(e) { out.push({ test: 'trending', error: e.message }); }
  res.json(out);
});

app.get('/api/debug/fz/:slug', async function(req, res) {
  var srcs = await fzGetSources(req.params.slug, req.query.type || 'movie');
  res.json({ slug: req.params.slug, sources: srcs });
});

app.get('/api/debug/mb', async function(req, res) {
  var out = [];
  for (var i = 0; i < Math.min(MB_BASES.length, 2); i++) {
    var paths = ['/api/home', '/api/discover', '/api/v1/home'];
    for (var j = 0; j < paths.length; j++) {
      var start = Date.now();
      try {
        var r = await http.get(MB_BASES[i] + paths[j], { params: { type: 'movie' } });
        out.push({ base: MB_BASES[i], path: paths[j], status: r.status, typeof: typeof r.data, ms: Date.now() - start });
      } catch(e) { out.push({ base: MB_BASES[i], path: paths[j], error: e.code || e.message, ms: Date.now() - start }); }
    }
  }
  res.json(out);
});

app.get('/api/movies/trending', async function(req, res) { res.json(await unifiedTrending('movie')); });
app.get('/api/tv/trending', async function(req, res) { res.json(await unifiedTrending('series')); });
app.get('/api/movies/search', async function(req, res) { res.json(await unifiedSearch('movie', req.query.q)); });
app.get('/api/tv/search', async function(req, res) { res.json(await unifiedSearch('series', req.query.q)); });
app.get('/api/movies/genre/:name', async function(req, res) {
  var g = req.params.name.toLowerCase();
  var feed = await unifiedTrending('movie');
  res.json({ results: feed.results.filter(function(x) { return (x.genres || []).some(function(y) { return String(y).toLowerCase().indexOf(g) >= 0; }); }), source: feed.source });
});

app.get('/api/movie/:id', async function(req, res) { res.json(await unifiedDetail('movie', req.params.id)); });
app.get('/api/tv/:id', async function(req, res) { res.json(await unifiedDetail('series', req.params.id)); });

app.get('/api/movie/:id/sources', async function(req, res) {
  var id = req.params.id;
  var detail = id.indexOf('fz:') === 0 ? null : await unifiedDetail('movie', id);
  var title = detail && detail.meta ? detail.meta.title : '';
  res.json(await unifiedSources('movie', id, title));
});

app.get('/api/tv/:id/sources', async function(req, res) {
  var id = req.params.id;
  var detail = id.indexOf('fz:') === 0 ? null : await unifiedDetail('series', id);
  var title = detail && detail.meta ? detail.meta.title : '';
  res.json(await unifiedSources('series', id, title, req.query.s || 1, req.query.e || 1));
});

app.get('/api/movie/:id/similar', async function(req, res) {
  var feed = await unifiedTrending('movie');
  res.json({ results: feed.results.filter(function(x) { return x.id !== req.params.id; }).slice(0, 12), source: feed.source });
});

app.get('/api/tv/:id/season/:num', async function(req, res) {
  var d = await unifiedDetail('series', req.params.id);
  res.json({ episodes: ((d.meta && d.meta.videos) || []).filter(function(v) { return String(v.season) === String(req.params.num); }), source: d.source });
});

app.get('/api/tv/:id/:season/:episode', async function(req, res) {
  var id = req.params.id;
  var detail = id.indexOf('fz:') === 0 ? null : await unifiedDetail('series', id);
  var title = detail && detail.meta ? detail.meta.title : '';
  res.json(await unifiedSources('series', id, title, req.params.season, req.params.episode));
});

app.get('/api/movie/:id/4k', async function(req, res) {
  try {
    var id = req.params.id;
    var torrents = [];
    try {
      var r = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: id } });
      (r.data.data && r.data.data.movies || []).forEach(function(m) { (m.torrents || []).forEach(function(t) { torrents.push({ quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash, title: m.title_long || m.title, magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title) }); }); });
    } catch(e) {}
    if (!torrents.length) {
      var detail = await unifiedDetail('movie', id);
      if (detail.meta && detail.meta.title) {
        try {
          var r2 = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: detail.meta.title, limit: 5 } });
          (r2.data.data && r2.data.data.movies || []).forEach(function(m) { (m.torrents || []).forEach(function(t) { torrents.push({ quality: t.quality, size: t.size, seeds: t.seeds, hash: t.hash, title: m.title_long || m.title, magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title_long || m.title) }); }); });
        } catch(e) {}
      }
    }
    torrents.sort(function(a, b) { return (b.quality === '1080p' ? 1 : 0) - (a.quality === '1080p' ? 1 : 0) || b.seeds - a.seeds; });
    res.json({ torrents: torrents, source: 'yts' });
  } catch(e) { res.json({ torrents: [], source: 'yts' }); }
});

app.get('/api/adult/trending', async function(req, res) { res.json({ results: await adultFeed(null) }); });
app.get('/api/adult/search', async function(req, res) { res.json({ results: await adultFeed(function(src) { return src.search + encodeURIComponent(req.query.q || ''); }) }); });
app.get('/api/adult/category/:cat', async function(req, res) { res.json({ results: await adultFeed(function(src) { return src.base + '/' + req.params.cat; }) }); });
app.get('/api/adult/performer/:name', async function(req, res) { res.json({ results: await adultFeed(function(src) { return src.search + encodeURIComponent(req.params.name); }) }); });
app.get('/api/adult/video/:source', async function(req, res) {
  try {
    var page = Buffer.from(String(req.query.u || ''), 'base64').toString('utf8');
    var html = (await http.get(page, { headers: { Referer: 'https://www.google.com/' } })).data;
    var urls = []; var re = /(https?:)?\/\/[^"'\s]+?\.mp4[^"'\s]*/g; var m;
    while ((m = re.exec(html)) && urls.length < 10) { var u = m[0]; if (u.indexOf('//') === 0) u = 'https:' + u; if (urls.indexOf(u) === -1) urls.push(u); }
    res.json({ urls: urls, page: page });
  } catch(e) { res.json({ urls: [], page: '' }); }
});

app.get('/api/debrid/status', function(req, res) { res.json({ enabled: false }); });
app.post('/api/cache/clear', function(req, res) {
  try { fs.unlinkSync(SNAP); } catch(e) {}
  mbActive = null; fzCache = {};
  res.json({ ok: true, snapshot: 'cleared' });
});

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
'.srv-btn.fz{border-color:rgba(255,218,107,.25)}',
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
'.fz-badge{display:inline-block;background:rgba(255,218,107,.15);color:var(--gold);font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px}',
'@media(max-width:860px){#side{display:none}#main{margin-left:0}#tabs{display:flex}.hero{height:320px}.hero h2{font-size:22px}.card{width:126px}.card img{height:190px}}',
'</style></head><body>',
'<div id="side"><h1>Movie<b>Box</b></h1>',
'<div class="nav on" data-tab="home">Home</div>',
'<div class="nav" data-tab="movies">Movies</div>',
'<div class="nav" data-tab="tv">TV Shows</div>',
'<div class="nav" data-tab="adult">18+</div>',
'<div class="nav" data-tab="mylist">My List</div>',
'<div style="margin-top:20px;padding:10px 12px;background:#1A1B20;border-radius:8px;font-size:11px;color:#666">',
'<div style="margin-bottom:4px">Video Source:</div>',
'<div id="src-status" style="color:var(--gold)">fzmovies + fallback</div>',
'<div id="srv-pref" style="color:#555;margin-top:4px">Auto</div></div></div>',
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
'window.open = function(u){ window._open(u, "_blank"); return null; };',
'var S = { tab:"home", heroIdx:0, heroItems:[], srcList:[], srcIdx:-1, cur:null, list:[], cw:[], userPicked:false };',
'try { S.list = JSON.parse(localStorage.getItem("mb_list") || "[]"); S.cw = JSON.parse(localStorage.getItem("mb_cw") || "[]"); } catch(e) {}',
'function srvPref(){ return localStorage.getItem("mb_server") || ""; }',
'function setSrvPref(n){ localStorage.setItem("mb_server", n); var el = document.getElementById("srv-pref"); if(el) el.textContent = n || "Auto"; }',
'function $(s){ return document.querySelector(s); }',
'function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }',
'function api(p){',
'  var c = new AbortController(); var t = setTimeout(function(){ c.abort(); }, 15000);',
'  return fetch(p, { signal: c.signal }).then(function(r){ clearTimeout(t); return r.json(); }).catch(function(e){ clearTimeout(t); return { results:[], sources:[], torrents:[], meta:null }; });',
'}',
'function toast(t){ var e = $("#toast"); e.textContent = t; e.style.opacity = 1; setTimeout(function(){ e.style.opacity = 0; }, 3000); }',
'function card(x){',
'  var fzBadge = (x.id && x.id.indexOf("fz:")===0) ? \'<span class="fz-badge">FZ</span>\' : "";',
'  return \'<div class="card" data-id="\' + esc(x.id) + \'" data-type="\' + esc(x.type||"movie") + \'">\' +',
'    \'<img loading="lazy" src="\' + esc(x.poster) + \'" onerror="this.style.opacity=.15">\' +',
'    \'<div class="dl" data-id="\' + esc(x.id) + \'" data-type="\' + esc(x.type||"movie") + \'">⬇</div>\' +',
'    \'<div class="mt"><div class="t">\' + esc(x.title) + fzBadge + \'</div>\' +',
'    \'<div class="y">\' + esc(x.year) + \' <span class="r">\' + esc(x.rating||"") + \'</span></div></div></div>\';',
'}',
'function row(title, items){',
'  if (!items || !items.length) return "";',
'  return \'<div class="row"><h2>\' + esc(title) + \'</h2><div class="strip">\' + items.map(card).join("") + \'</div></div>\';',
'}',
'function renderHero(items){',
'  S.heroItems = items.slice(0,5); S.heroIdx = 0; paintHero();',
'  if (S._ht) clearInterval(S._ht);',
'  S._ht = setInterval(function(){ S.heroIdx = (S.heroIdx+1) % (S.heroItems.length||1); paintHero(); }, 6000);',
'}',
'function paintHero(){',
'  var x = S.heroItems[S.heroIdx]; if (!x) return;',
'  $("#hero").style.backgroundImage = "url(" + (x.backdrop||x.poster||"") + ")";',
'  $("#hero").innerHTML = \'<div class="scrim"></div><div class="info"><h2>\' + esc(x.title) + \'</h2>\' +',
'    \'<div class="y" style="color:#FFDA6B;font-weight:700">\' + esc(x.year) + \' ★ \' + esc(x.rating||"") + \'</div>\' +',
'    \'<p>\' + esc(x.overview||"") + \'</p>\' +',
'    \'<span class="btn" data-id="\' + esc(x.id) + \'" data-type="\' + esc(x.type||"movie") + \'">▶ Play</span>\' +',
'    \'<span class="btn alt" data-dl="\' + esc(x.id) + \'">⬇ Download</span></div>\';',
'}',
'async function loadTab(tab){',
'  S.tab = tab;',
'  Array.prototype.forEach.call(document.querySelectorAll(".nav,.tb"), function(n){ n.classList.toggle("on", n.getAttribute("data-tab")===tab); });',
'  $("#hero").style.display = (tab==="home") ? "flex" : "none";',
'  var c = $("#content"); c.innerHTML = \'<div class="hd empty-msg">Loading…</div>\';',
'  try {',
'    if (tab==="home") {',
'      var res = await Promise.all([api("/api/movies/trending"), api("/api/tv/trending")]);',
'      var m=res[0], t=res[1];',
'      var all = (m.results||[]).concat(t.results||[]);',
'      if (all.length) { renderHero(all); c.innerHTML = row("Trending Movies", m.results||[]) + row("Trending TV Shows", t.results||[]); }',
'      else { c.innerHTML = \'<div class="hd empty-msg">No content available.</div>\'; }',
'    } else if (tab==="movies") {',
'      var m2 = await api("/api/movies/trending");',
'      c.innerHTML = \'<div class="hd"><input id="search" placeholder="Search movies…"></div><div id="grid">\' + (m2.results&&m2.results.length ? m2.results.map(card).join("") : \'<div class="empty-msg">No movies.</div>\') + \'</div>\';',
'      bindSearch("/api/movies/search");',
'    } else if (tab==="tv") {',
'      var t2 = await api("/api/tv/trending");',
'      c.innerHTML = \'<div class="hd"><input id="search" placeholder="Search TV…"></div><div id="grid">\' + (t2.results&&t2.results.length ? t2.results.map(card).join("") : \'<div class="empty-msg">No TV shows.</div>\') + \'</div>\';',
'      bindSearch("/api/tv/search");',
'    } else if (tab==="adult") {',
'      if (localStorage.getItem("mb_age")!=="1") {',
'        c.innerHTML = \'<div class="hd"><h2>18+ content</h2><p style="color:#9AA0A6;margin:10px 0">Confirm you are 18+.</p><span class="btn" id="ageok">I am 18+</span></div>\';',
'        $("#ageok").onclick = function(){ localStorage.setItem("mb_age","1"); loadTab("adult"); };',
'        return;',
'      }',
'      var a = await api("/api/adult/trending");',
'      c.innerHTML = \'<div class="hd"><input id="search" placeholder="Search 18+…"></div><div id="grid">\' + (a.results||[]).map(function(x){',
'        return \'<div class="card" data-adult="\' + esc(x.id) + \'" data-source="\' + esc(x.source) + \'"><img loading="lazy" src="\' + esc(x.thumb) + \'" onerror="this.style.opacity=.15"><div class="mt"><div class="t">\' + esc(x.title) + \'</div><div class="y">\' + esc(x.source) + \'</div></div></div>\';',
'      }).join("") + \'</div>\';',
'      var si = $("#search");',
'      si && (si.onkeydown = async function(e){ if (e.key!=="Enter") return; var r = await api("/api/adult/search?q="+encodeURIComponent(si.value)); $("#grid").innerHTML = (r.results||[]).map(function(x){',
'        return \'<div class="card" data-adult="\' + esc(x.id) + \'" data-source="\' + esc(x.source) + \'"><img loading="lazy" src="\' + esc(x.thumb) + \'"><div class="mt"><div class="t">\' + esc(x.title) + \'</div></div></div>\';',
'      }).join(""); });',
'    } else if (tab==="mylist") {',
'      c.innerHTML = \'<div class="hd"><h2>My List</h2></div><div id="grid">\' + (S.list.length ? S.list.map(card).join("") : \'<div class="empty-msg">Nothing saved yet.</div>\') + \'</div>\';',
'    }',
'  } catch(err) { c.innerHTML = \'<div class="hd empty-msg">Something went wrong.</div>\'; }',
'}',
'function bindSearch(ep){',
'  var si = $("#search"); if(!si) return;',
'  si.onkeydown = async function(e){ if(e.key!=="Enter") return; var r = await api(ep+"?q="+encodeURIComponent(si.value)); var g=$("#grid"); g.innerHTML = (r.results&&r.results.length) ? r.results.map(card).join("") : \'<div class="empty-msg">No results.</div>\'; };',
'  si.focus();',
'}',
'async function download(id){',
'  toast("Searching torrents…");',
'  var r = await api("/api/movie/"+id+"/4k"); var ts = r.torrents||[];',
'  if (!ts.length) { toast("No torrents found — try play instead"); return; }',
'  var pick = ts[0];',
'  try { await navigator.clipboard.writeText(pick.magnet); } catch(e) {}',
'  toast(pick.quality + " · " + pick.size + " · magnet copied");',
'}',
'async function openDetail(id, type){',
'  var p = (type==="series") ? "/api/tv/" : "/api/movie/";',
'  var sPromise = api(p+id+"/sources");',
'  var d = await api(p+id); var s = await sPromise;',
'  S.cur = { id:id, type:type };',
'  var m = d.meta || { id:id, title:"", poster:"", year:"", rating:"", overview:"", genres:[] };',
'  var sc = s.sources || [];',
'  // Count by provider',
'  var fzCount = sc.filter(function(x){ return x.provider==="fz"; }).length;',
'  var srcLabel = fzCount + " fzmovies + " + (sc.length-fzCount) + " fallback";',
'  var html = \'<div class="bar"><span class="x" id="dclose">✕</span><b>Details</b>\' +',
'    \'<span style="margin-left:auto;color:var(--mut);font-size:11px">\' + esc(srcLabel) + \'</span></div>\' +',
'    \'<div class="body">\' +',
'    \'<div class="detail-hero"><img src="\' + esc(m.poster) + \'" onerror="this.style.opacity=.2"><div>\' +',
'    \'<h2>\' + esc(m.title) + \'</h2>\' +',
'    \'<div style="color:#FFDA6B;font-weight:700;margin-bottom:8px">\' + esc(m.year) + \' ★ \' + esc(m.rating||"") + \'</div>\' +',
'    \'<p style="color:#C9CDD3;line-height:1.6;max-width:560px">\' + esc(m.overview||"") + \'</p>\' +',
'    \'<div>\' + (m.genres||[]).map(function(g){ return \'<span class="chip">\' + esc(g) + \'</span>\'; }).join("") + \'</div>\' +',
'    \'<div style="margin-top:8px">\' + (m.cast ? \'<div style="color:#9AA0A6;font-size:13px">Cast: \' + esc(m.cast) + \'</div>\' : "") + \'</div>\' +',
'    \'<span class="btn" id="dplay">▶ Play</span>\' +',
'    \'<span class="btn alt" id="ddl">⬇ Download</span>\' +',
'    \'<span class="btn alt" id="dsave">+ My List</span></div></div>\';',
'  if (type==="series" && m.videos && m.videos.length) {',
'    var seasons = {}; m.videos.forEach(function(v){ var k=v.season||1; (seasons[k]=seasons[k]||[]).push(v); });',
'    html += \'<h2 style="margin:18px 0 8px">Episodes</h2>\';',
'    Object.keys(seasons).forEach(function(k){',
'      html += \'<div style="margin-bottom:10px"><b style="color:#9AA0A6;font-size:13px">Season \' + esc(k) + \'</b><div class="strip">\' +',
'        seasons[k].map(function(v){ return \'<div class="chip" data-s="\' + esc(v.season) + \'" data-e="\' + esc(v.episode) + \'">E\' + esc(v.episode) + \' · \' + esc(v.title||"") + \'</div>\'; }).join("") + \'</div></div>\';',
'    });',
'  }',
'  html += \'<h2 style="margin:18px 0 8px">Similar</h2>\';',
'  var sim = await api(p+id+"/similar");',
'  html += \'<div class="strip">\' + (sim.results||[]).map(card).join("") + \'</div></div>\';',
'  var el = $("#detail"); el.innerHTML = html; el.style.display = "flex";',
'  el.querySelector("#dclose").onclick = function(){ el.style.display = "none"; };',
'  el.querySelector("#ddl").onclick = function(){ download(id); };',
'  el.querySelector("#dsave").onclick = function(){',
'    if (!S.list.some(function(x){ return x.id===id; })) S.list.push(m);',
'    localStorage.setItem("mb_list", JSON.stringify(S.list)); toast("Added to My List");',
'  };',
'  el.querySelector("#dplay").onclick = function(){ showSources(sc, m); };',
'  Array.prototype.forEach.call(el.querySelectorAll(".chip[data-s]"), function(ch){',
'    ch.onclick = async function(){ var ss = await api("/api/tv/"+id+"/"+ch.getAttribute("data-s")+"/"+ch.getAttribute("data-e")); showSources(ss.sources||[], m); };',
'  });',
'  showSources(sc, m);',
'}',
'function showSources(list, meta){',
'  S.srcList = list || []; S.userPicked = false;',
'  if (!S.srcList.length) { toast("No sources available"); return; }',
'  // Find preferred server',
'  var pref = srvPref();',
'  var startIdx = 0;',
'  if (pref) {',
'    for (var i=0; i<S.srcList.length; i++) {',
'      if (S.srcList[i].name === pref || S.srcList[i].name.indexOf(pref) >= 0) { startIdx = i; break; }',
'    }',
'  }',
'  S.srcIdx = startIdx;',
'  // Build server bar',
'  var srvHtml = \'\';',
'  for (var i=0; i<S.srcList.length; i++) {',
'    var s = S.srcList[i];',
'    var isFz = s.provider === "fz";',
'    var cls = "srv-btn" + (isFz ? " fz" : "") + (i===startIdx ? " on" : "");',
'    srvHtml += \'<span class="\' + cls + \'" data-srv="\' + i + \'">\' + esc(s.name) + \'</span>\';',
'  }',
'  var pl = $("#player");',
'  pl.innerHTML = \'<div class="bar"><span class="x" id="pclose">✕</span><b>\' + esc(meta.title||"Player") + \'</b>\' +',
'    \'<span class="btn alt" id="pwt" style="margin:0 0 0 auto;padding:6px 14px;font-size:12px">🌊 Torrent</span></div>\' +',
'    \'<div class="srv-bar"><span class="srv-label">Server:</span>\' + srvHtml + \'</div>\' +',
'    \'<div id="pframe"></div><div id="pmsg"></div>\';',
'  pl.style.display = "flex";',
'  document.getElementById("pclose").onclick = function(){ pl.style.display = "none"; document.getElementById("pframe").innerHTML = ""; };',
'  document.getElementById("pwt").onclick = function(){ if(S.cur) startWebTorrent(S.cur.id, meta); };',
'  // Server click handlers',
'  Array.prototype.forEach.call(pl.querySelectorAll(".srv-btn"), function(btn){',
'    btn.onclick = function(){',
'      S.userPicked = true;',
'      var idx = parseInt(btn.getAttribute("data-srv"));',
'      S.srcIdx = idx;',
'      setSrvPref(S.srcList[idx].name);',
'      Array.prototype.forEach.call(pl.querySelectorAll(".srv-btn"), function(b){ b.classList.remove("on"); });',
'      btn.classList.add("on");',
'      loadSrc(idx);',
'    };',
'  });',
'  loadSrc(startIdx);',
'}',
'function loadSrc(idx){',
'  if (idx < 0 || idx >= S.srcList.length) return;',
'  var s = S.srcList[idx];',
'  var fr = document.createElement("iframe");',
'  fr.src = s.url;',
'  fr.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";',
'  fr.setAttribute("referrerPolicy", "no-referrer");',
'  var pf = document.getElementById("pframe"); pf.innerHTML = ""; pf.appendChild(fr);',
'  document.getElementById("pmsg").textContent = "Playing: " + s.name + " (" + (idx+1) + "/" + S.srcList.length + ")";',
'}',
'async function startWebTorrent(imdbId, meta){',
'  var pl = $("#player");',
'  var pf = document.getElementById("pframe");',
'  var pm = document.getElementById("pmsg");',
'  if (!pf || !pm) return;',
'  pf.innerHTML = ""; pm.textContent = "Searching torrents…";',
'  var tr = await api("/api/movie/"+imdbId+"/4k");',
'  if (!tr.torrents||!tr.torrents.length) { pm.textContent = "No torrents found."; return; }',
'  var pick = tr.torrents[0];',
'  pm.textContent = "Starting: " + pick.quality + " · " + pick.size + " · connecting…";',
'  try {',
'    if (!window.WebTorrent) { pm.textContent = "WebTorrent not loaded."; return; }',
'    if (S.wtClient) S.wtClient.destroy();',
'    S.wtClient = new WebTorrent();',
'    S.wtClient.on("error", function(err){ pm.textContent = "Error: " + err.message; });',
'    S.wtClient.add(pick.magnet, { announce: ["wss://tracker.openwebtorrent.com","wss://tracker.btorrent.xyz"] }, function(torrent){',
'      var file = torrent.files.reduce(function(b,f){ return (/\.(mp4|mkv|webm)$/i.test(f.name) && (!b||f.length>b.length)) ? f : b; }, null);',
'      if (!file) { pm.textContent = "No video in torrent."; return; }',
'      pf.innerHTML = \'<video id="wtv" controls autoplay playsinline style="width:100%;height:100%;background:#000"></video>\';',
'      file.renderTo("#wtv", { autoplay:true }, function(err){ if(err) pm.textContent = "Error: "+err.message; });',
'      pm.textContent = "Streaming: " + file.name + " · " + torrent.numPeers + " peers";',
'    });',
'  } catch(e) { pm.textContent = "WebTorrent error: " + e.message; }',
'}',
'async function playAdult(id, source){',
'  var r = await api("/api/adult/video/"+source+"?u="+id);',
'  var pl = $("#player");',
'  pl.innerHTML = \'<div class="bar"><span class="x" id="pclose">✕</span><b>18+</b></div><div id="pframe"></div><div id="pmsg"></div>\';',
'  pl.style.display = "flex";',
'  document.getElementById("pclose").onclick = function(){ pl.style.display = "none"; document.getElementById("pframe").innerHTML = ""; };',
'  if (r.urls&&r.urls.length) {',
'    document.getElementById("pframe").innerHTML = \'<video controls autoplay playsinline style="width:100%;height:100%;background:#000" src="\' + esc(r.urls[0]) + \'"></video>\';',
'  } else if (r.page) {',
'    document.getElementById("pframe").innerHTML = \'<iframe allow="autoplay; fullscreen" referrerpolicy="no-referrer" src="\' + esc(r.page) + \'"></iframe>\';',
'  } else { document.getElementById("pmsg").textContent = "No video found."; }',
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
'// Show current server pref',
'(function(){ var el=document.getElementById("srv-pref"); if(el) el.textContent = srvPref() || "Auto"; })();',
'loadTab("home");',
'</scr' + 'ipt></body></html>'
].join('');

app.get('/', function(req, res) { res.type('html').send(HTML); });
app.get('*', function(req, res) {
  if (req.path.indexOf('/api/') === 0) return res.status(404).json({ error: 'unknown route' });
  res.type('html').send(HTML);
});

app.listen(PORT, function() { console.log('MovieBox on ' + PORT + ' — fzmovies primary + MovieBox catalog + embed fallback'); });
