'use strict';
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });

const clean = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const b64u = s => Buffer.from(String(s)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function normMeta(m, type) {
  return {
    id: m.id, type: type || m.type || 'movie', title: m.name,
    poster: m.poster || '', backdrop: m.background || m.poster || '',
    year: String(m.releaseInfo || '').slice(0, 4), rating: m.imdbRating || '',
    overview: clean(m.description), genres: m.genres || []
  };
}

// ---------- providers (key-free) ----------
function movieSources(id) {
  return [
    { name: 'VidSrc', quality: 'HD', url: 'https://vidsrc.xyz/embed/movie?imdb=' + id },
    { name: 'VidSrc CC', quality: 'HD', url: 'https://vidsrc.cc/v2/embed/movie/' + id },
    { name: 'VidSrc TO', quality: 'HD', url: 'https://vidsrc.to/embed/movie/' + id },
    { name: 'EmbedSu', quality: 'HD', url: 'https://embed.su/embed/movie/' + id },
    { name: 'AutoEmbed', quality: 'HD', url: 'https://autoembed.cc/embed/movie/' + id },
    { name: 'VidLink', quality: 'HD', url: 'https://vidlink.pro/movie/' + id },
    { name: '2Embed', quality: 'SD', url: 'https://www.2embed.cc/embed/' + id },
    { name: 'Moviee', quality: 'HD', url: 'https://moviee.tv/embed/movie/' + id }
  ];
}
function tvSources(id, s, e) {
  return [
    { name: 'VidSrc', quality: 'HD', url: 'https://vidsrc.xyz/embed/tv?imdb=' + id + '&season=' + s + '&episode=' + e },
    { name: 'VidSrc CC', quality: 'HD', url: 'https://vidsrc.cc/v2/embed/tv/' + id + '/' + s + '/' + e },
    { name: 'VidSrc TO', quality: 'HD', url: 'https://vidsrc.to/embed/tv/' + id + '/' + s + '/' + e },
    { name: 'EmbedSu', quality: 'HD', url: 'https://embed.su/embed/tv/' + id + '/' + s + '/' + e },
    { name: 'AutoEmbed', quality: 'HD', url: 'https://autoembed.cc/embed/tv/' + id + '/' + s + '/' + e },
    { name: 'VidLink', quality: 'HD', url: 'https://vidlink.pro/tv/' + id + '/' + s + '/' + e },
    { name: '2Embed', quality: 'SD', url: 'https://www.2embed.cc/embedtv/' + id + '&s=' + s + '&e=' + e }
  ];
}

// ---------- metadata routes ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/movies/trending', async (req, res) => {
  try {
    const r = await http.get(CINEMETA + '/catalog/movie/top/skip=0.json');
    res.json({ results: (r.data.metas || []).map(m => normMeta(m, 'movie')) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/movies/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const r = await http.get(CINEMETA + '/catalog/movie/top/search=' + encodeURIComponent(q) + '.json');
    res.json({ results: (r.data.metas || []).map(m => normMeta(m, 'movie')) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/movies/genre/:name', async (req, res) => {
  const g = String(req.params.name).toLowerCase().replace(/-/g, ' ');
  try {
    const pages = await Promise.all([0, 100, 200, 300].map(n =>
      http.get(CINEMETA + '/catalog/movie/top/skip=' + n + '.json').catch(() => ({ data: { metas: [] } }))
    ));
    const all = pages.flatMap(p => p.data.metas || []);
    const hits = all.filter(m => (m.genres || []).some(x => String(x).toLowerCase().replace(/-/g, ' ') === g));
    res.json({ results: hits.map(m => normMeta(m, 'movie')) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    const r = await http.get(CINEMETA + '/meta/movie/' + req.params.id + '.json');
    const m = r.data.meta;
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json(Object.assign(normMeta(m, 'movie'), {
      runtime: m.runtime || '',
      synopsis: clean(m.description),
      cast: (m.cast || []).map(n => ({ name: n, character: '' })),
      director: (m.director || []).join(', '),
      trailer: (m.trailers && m.trailers[0]) ? { url: 'https://www.youtube.com/watch?v=' + m.trailers[0].source } : null
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/movie/:id/sources', (req, res) => res.json({ sources: movieSources(req.params.id) }));

app.get('/api/movie/:id/similar', async (req, res) => {
  try {
    const r = await http.get(CINEMETA + '/catalog/movie/top/skip=0.json');
    const all = (r.data.metas || []).filter(m => m.id !== req.params.id).slice(0, 12);
    res.json({ results: all.map(m => normMeta(m, 'movie')) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/movie/:id/4k', async (req, res) => {
  try {
    const r = await http.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: req.params.id, limit: 1 } });
    const m = (r.data && r.data.data && r.data.data.movies || [])[0];
    const out = (m && m.torrents || []).map(t => ({
      quality: t.quality, size: t.size, seeds: t.seeds, peers: t.peers, hash: t.hash,
      magnet: 'magnet:?xt=urn:btih:' + t.hash + '&dn=' + encodeURIComponent(m.title)
    }));
    res.json({ results: out, title: m ? m.title : '' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- TV ----------
async function seriesMeta(id) {
  const r = await http.get(CINEMETA + '/meta/series/' + id + '.json');
  return r.data.meta;
}

app.get('/api/tv/trending', async (req, res) => {
  try {
    const r = await http.get(CINEMETA + '/catalog/series/top/skip=0.json');
    res.json({ results: (r.data.metas || []).map(m => normMeta(m, 'tv')) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/tv/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const r = await http.get(CINEMETA + '/catalog/series/top/search=' + encodeURIComponent(q) + '.json');
    res.json({ results: (r.data.metas || []).map(m => normMeta(m, 'tv')) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
  try {
    const m = await seriesMeta(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const vids = m.videos || [];
    const bySeason = {};
    vids.forEach(v => {
      const s = v.season || 1;
      if (!bySeason[s]) bySeason[s] = 0;
      bySeason[s]++;
    });
    const seasons = Object.keys(bySeason).sort((a, b) => a - b).map(s => ({ number: +s, episodes: bySeason[s] }));
    res.json(Object.assign(normMeta(m, 'tv'), {
      runtime: m.runtime || '',
      synopsis: clean(m.description),
      cast: (m.cast || []).map(n => ({ name: n, character: '' })),
      trailer: (m.trailers && m.trailers[0]) ? { url: 'https://www.youtube.com/watch?v=' + m.trailers[0].source } : null,
      seasons: seasons.length ? seasons : [{ number: 1, episodes: 0 }]
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/tv/:id/season/:num', async (req, res) => {
  try {
    const m = await seriesMeta(req.params.id);
    const s = +req.params.num;
    const eps = (m.videos || []).filter(v => (v.season || 1) === s).map(v => ({
      number: v.episode, title: v.title || ('Episode ' + v.episode), thumb: v.thumbnail || ''
    }));
    res.json({ episodes: eps.sort((a, b) => a.number - b.number) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/tv/:id/:season/:episode', (req, res) => {
  res.json({ sources: tvSources(req.params.id, req.params.season, req.params.episode) });
});

// ---------- adult scrapers (key-free) ----------
const XH = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'age_verified=1' };
const GET = url => http.get(url, { headers: XH }).then(r => r.data).catch(() => '');

function pick(html, source, base, sel) {
  const $ = cheerio.load(html || ''); const out = [];
  $(sel).each((_, el) => {
    const a = $(el).find('a[href]').first();
    let href = a.attr('href') || '';
    if (!href) return;
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = base + href;
    if (!/^https?:/.test(href)) return;
    const img = $(el).find('img').first();
    const thumb = (img.attr('data-src') || img.attr('src') || '').split(' ')[0];
    const title = clean($(el).find('.thumb-name a, .thumb-under a, .title, .video-title').first().text() || img.attr('alt') || 'Video');
    const duration = clean($(el).find('.thumb-duration, .duration, .tim').first().text());
    out.push({ source, title, url: href, thumb, duration });
  });
  return out;
}

const xvideos = q => GET(q ? 'https://www.xvideos.com/?k=' + encodeURIComponent(q) : 'https://www.xvideos.com/')
  .then(h => pick(h, 'xvideos', 'https://www.xvideos.com', '#video_ol_thumbs .thumb, .mozaique .thumb'));
const xnxx = q => GET(q ? 'https://www.xnxx.com/search/' + encodeURIComponent(q) : 'https://www.xnxx.com/best')
  .then(h => pick(h, 'xnxx', 'https://www.xnxx.com', '.mozaique .thumb-block, .thumb-block'));
const spankbang = q => GET(q ? 'https://spankbang.com/s/' + encodeURIComponent(q) + '/' : 'https://spankbang.com/new_videos/')
  .then(h => pick(h, 'spankbang', 'https://spankbang.com', '.video-item, .video-list .item'));
const eporner = q => GET(q ? 'https://www.eporner.com/search/' + encodeURIComponent(q) + '/' : 'https://www.eporner.com/')
  .then(h => pick(h, 'eporner', 'https://www.eporner.com', '.mb, .videosbox > div'));
const redtube = q => GET(q ? 'https://www.redtube.com/?search=' + encodeURIComponent(q) : 'https://www.redtube.com/most_popular')
  .then(h => pick(h, 'redtube', 'https://www.redtube.com', '.video-box, .video_thumb'));

async function adultAll(q) {
  const rs = await Promise.allSettled([xvideos(q), xnxx(q), spankbang(q), eporner(q), redtube(q)]);
  const out = []; const seen = new Set();
  rs.forEach(r => {
    if (r.status !== 'fulfilled') return;
    r.value.forEach(v => { if (v.url && !seen.has(v.url)) { seen.add(v.url); out.push(v); } });
  });
  return out;
}

app.get('/api/adult/trending', async (req, res) => {
  try { res.json({ results: (await adultAll('')).slice(0, 60) }); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/adult/search', async (req, res) => {
  try { res.json({ results: (await adultAll(String(req.query.q || ''))).slice(0, 80) }); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/adult/category/:cat', async (req, res) => {
  try { res.json({ results: (await adultAll(String(req.params.cat).replace(/\+/g, ' '))).slice(0, 80) }); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/adult/performer/:name', async (req, res) => {
  try { res.json({ results: (await adultAll(req.params.name)).slice(0, 80) }); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/adult/video/:source', async (req, res) => {
  try {
    const page = unb64u(String(req.query.u || ''));
    const html = (await GET(page)).replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    const rx = /(https?:\/\/[^"'\s]+?\.mp4[^"'\s]*)/g;
    const files = []; let m;
    while ((m = rx.exec(html)) && files.length < 8) {
      const u = m[1];
      if (/preview|thumbs|\.jpg|\.png|\.gif/.test(u)) continue;
      if (!files.some(f => f.url === u)) files.push({ quality: /1080/.test(u) ? '1080p' : /720/.test(u) ? '720p' : 'SD', url: u });
    }
    res.json({ files });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- misc ----------
app.get('/api/debrid/status', (req, res) => res.json({ enabled: false }));
app.post('/api/cache/clear', (req, res) => res.json({ ok: true }));
app.get('/api/docs', (req, res) => res.json({
  routes: ['/api/health', '/api/movies/trending', '/api/movies/search?q=', '/api/movies/genre/:name',
    '/api/movie/:id', '/api/movie/:id/sources', '/api/movie/:id/similar', '/api/movie/:id/4k',
    '/api/tv/trending', '/api/tv/search?q=', '/api/tv/:id', '/api/tv/:id/season/:num', '/api/tv/:id/:season/:episode',
    '/api/adult/trending', '/api/adult/search?q=', '/api/adult/category/:cat', '/api/adult/performer/:name', '/api/adult/video/:source?u=']
}));

// ---------- UI (inline, one file) ----------
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MovieBox</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#101114;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow-x:hidden}
a{color:inherit;text-decoration:none}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:#18191d;padding:20px 0;z-index:100;display:flex;flex-direction:column;overflow-y:auto}
.logo{font-size:24px;font-weight:800;padding:0 20px 26px;background:linear-gradient(135deg,#1cb7ff,#2ff58b);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sidebar nav a{display:flex;align-items:center;gap:12px;padding:11px 20px;color:#888;font-size:15px;cursor:pointer}
.sidebar nav a:hover,.sidebar nav a.active{color:#fff;background:rgba(28,183,255,.1)}
.sidebar .divider{height:1px;background:#2a2b30;margin:12px 20px}
.sidebar .lbl{font-size:11px;text-transform:uppercase;color:#888;padding:8px 20px;letter-spacing:1px}
.main{margin-left:220px;min-height:100vh}
.topbar{position:sticky;top:0;z-index:90;background:rgba(16,17,20,.95);backdrop-filter:blur(10px);padding:14px 30px;display:flex;align-items:center;gap:14px}
.search\boxed{flex:1;max-width:500px;position:relative}
.searchbox input{width:100%;padding:10px 16px 10px 40px;background:#1e1f24;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;outline:none}
.searchbox input:focus{border-color:#1cb7ff}
.sicon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#888}
.hero{position:relative;height:400px;overflow:hidden;margin:0 30px 30px;border-radius:16px}
.hslide{position:absolute;inset:0;opacity:0;transition:opacity .8s;cursor:pointer}
.hslide.active{opacity:1}
.hbg{position:absolute;inset:0;background-size:cover;background-position:center}
.hbg:after{content:'';position:absolute;inset:0;background:linear-gradient(to right,rgba(16,17,20,.95),rgba(16,17,20,.55) 55%,rgba(16,17,20,.25))}
.hinfo{position:relative;z-index:2;padding:50px;height:100%;display:flex;flex-direction:column;justify-content:center}
.htitle{font-size:40px;font-weight:800;line-height:1.1;margin-bottom:12px;max-width:520px}
.hmeta{display:flex;gap:12px;align-items:center;margin-bottom:14px;font-size:14px;color:#aaa}
.hmeta .rating{color:#ffda6b;font-weight:700}
.hdesc{font-size:15px;line-height:1.6;color:#bbb;max-width:520px;max-height:76px;overflow:hidden;margin-bottom:18px}
.btns{display:flex;gap:12px}
.btn{padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;border:none;display:inline-flex;align-items:center;gap:8px}
.bp{background:linear-gradient(135deg,#1cb7ff,#2ff58b);color:#000}
.bs{background:rgba(255,255,255,.12);color:#fff}
.dots{position:absolute;bottom:18px;right:50px;display:flex;gap:8px;z-index:5}
.dot{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.3);cursor:pointer;transition:.3s}
.dot.active{background:#1cb7ff;width:30px;border-radius:5px}
.section{padding:0 30px;margin-bottom:36px}
.shead{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.shead h2{font-size:20px;font-weight:700}
.row{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}
.row::-webkit-scrollbar{height:4px}
.row::-webkit-scrollbar-thumb{background:#333;border-radius:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px}
.card{cursor:pointer;transition:transform .2s}
.card:hover{transform:scale(1.05)}
.poster{width:100%;height:260px;border-radius:12px;overflow:hidden;position:relative;background:#28292e}
.poster img{width:100%;height:100%;object-fit:cover}
.no-img{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;font-size:40px}
.rb{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.7);color:#ffda6b;font-size:11px;font-weight:700;padding:3px 7px;border-radius:6px}
.yb{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.7);color:#fff;font-size:11px;padding:3px 7px;border-radius:6px}
.dl{position:absolute;bottom:8px;right:8px;background:rgba(28,183,255,.9);color:#000;border:none;width:32px;height:32px;border-radius:8px;font-size:15px;cursor:pointer;opacity:0;transition:.2s}
.card:hover .dl{opacity:1}
.ct{margin-top:8px;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.genres{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.pill{padding:8px 18px;background:#28292e;border-radius:20px;font-size:13px;cursor:pointer;border:1px solid transparent}
.pill:hover,.pill.active{background:#1cb7ff;color:#000}
.overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.85);backdrop-filter:blur(4px);overflow-y:auto;padding:40px 20px}
.overlay.open{display:flex;justify-content:center;align-items:flex-start}
.modal{background:#1a1b1f;border-radius:16px;max-width:900px;width:100%;overflow:hidden;position:relative}
.mclose{position:absolute;top:14px;right:14px;z-index:10;background:rgba(0,0,0,.6);border:none;color:#fff;font-size:24px;width:36px;height:36px;border-radius:50%;cursor:pointer}
.mhero{position:relative;height:380px;overflow:hidden}
.mbg{position:absolute;inset:0;background-size:cover;background-position:center;filter:brightness(.4)}
.minfo{position:relative;z-index:2;padding:60px 40px 28px;height:100%;display:flex;flex-direction:column;justify-content:flex-end}
.mtitle{font-size:34px;font-weight:800;margin-bottom:10px}
.mmeta{display:flex;gap:14px;align-items:center;font-size:14px;color:#aaa;margin-bottom:12px}
.mmeta .rating{color:#ffda6b;font-weight:700}
.mbody{padding:28px 40px}
.mbody h3{font-size:18px;margin-bottom:12px}
.syn{color:#bbb;line-height:1.7;margin-bottom:22px}
.castrow{display:flex;gap:12px;overflow-x:auto;margin-bottom:22px}
.ccard{flex:0 0 90px;text-align:center}
.ccard .cav{width:72px;height:72px;border-radius:50%;background:#333;margin:0 auto 6px;display:flex;align-items:center;justify-content:center;font-size:26px}
.ccard .cname{font-size:11px;font-weight:600}
.epgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:14px}
.ep{background:#222;border-radius:10px;overflow:hidden;cursor:pointer}
.ep:hover{background:#2c2c2c}
.ep .eth{width:100%;height:130px;object-fit:cover;background:#181818;display:block}
.ep .einfo{padding:10px 12px}
.ep .enum{font-size:12px;color:#1cb7ff;font-weight:700}
.ep .etitle{font-size:13px;font-weight:600;margin-top:4px}
.selsel{margin-bottom:16px}
.selsel select{background:#222;border:1px solid #444;color:#fff;padding:8px 14px;border-radius:8px;font-size:14px}
#player{display:none;position:fixed;inset:0;z-index:300;background:#000;flex-direction:column}
#player.open{display:flex}
.ptop{display:flex;align-items:center;padding:10px 16px;background:rgba(0,0,0,.85);gap:12px}
.ptop button{background:none;border:none;color:#fff;font-size:20px;cursor:pointer}
.ptitle{font-size:15px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pwrap{flex:1;position:relative;background:#000}
.pwrap iframe,.pwrap video{position:absolute;inset:0;width:100%;height:100%;border:none;background:#000}
.pbar{display:none;gap:8px;padding:8px 14px;background:rgba(0,0,0,.85);overflow-x:auto}
.pbar.show{display:flex}
.src{padding:6px 14px;background:#222;border:1px solid #444;border-radius:6px;color:#aaa;font-size:12px;cursor:pointer;white-space:nowrap}
.src.active,.src:hover{background:#1cb7ff;color:#000;border-color:#1cb7ff}
.pmsg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-size:15px;z-index:5;text-align:center}
.bbar{display:none;position:fixed;bottom:0;left:0;right:0;background:#18191d;z-index:100;justify-content:space-around;padding:8px 0}
.bb{display:flex;flex-direction:column;align-items:center;gap:2px;color:#888;font-size:10px;cursor:pointer;padding:4px 10px}
.bb.active{color:#1cb7ff}
.bb .bi{font-size:20px}
.agegate{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.96);display:none;align-items:center;justify-content:center;flex-direction:column;gap:18px}
.agegate h2{font-size:28px}
.agegate p{color:#aaa;max-width:400px;text-align:center}
.agebtns{display:flex;gap:14px}
.agebtns button{padding:12px 32px;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;border:none}
.loading{text-align:center;padding:60px;color:#888}
.spinner{width:40px;height:40px;border:3px solid #333;border-top-color:#1cb7ff;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
#toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:12px 24px;border-radius:10px;font-size:14px;z-index:999;opacity:0;transition:.3s;pointer-events:none}
#toast.show{opacity:1}
@media(max-width:768px){
.sidebar{display:none}.main{margin-left:0}
.topbar{padding:12px 16px}.section{padding:0 16px}
.hero{height:300px;margin:0 16px 20px}.hinfo{padding:26px}.htitle{font-size:24px}
.poster{height:220px}.mhero{height:250px}.minfo{padding:26px 20px 20px}.mtitle{font-size:22px}
.mbody{padding:20px}.bbar{display:flex}
}
</style></head><body>

<div class="sidebar">
  <div class="logo">MovieBox</div>
  <nav>
    <a class="active" data-tab="home">🏠 Home</a>
    <a data-tab="movies">🎬 Movie</a>
    <a data-tab="tv">📺 TV Show</a>
    <a data-tab="adult">🔞 18+</a>
    <a data-tab="mylist">📋 My List</a>
  </nav>
  <div class="divider"></div><div class="lbl">Genres</div>
  <nav id="gnav"></nav>
</div>

<div class="main">
  <div class="topbar">
    <div class="searchbox">
      <span class="sicon">🔍</span>
      <input id="q" placeholder="Search movies / TV Shows">
    </div>
    <button class="btn bs" onclick="location.reload()">⟳</button>
  </div>
  <div id="content"><div class="loading"><div class="spinner"></div>Loading...</div></div>
</div>

<div class="bbar">
  <div class="bb active" data-tab="home"><div class="bi">🏠</div>Home</div>
  <div class="bb" data-tab="movies"><div class="bi">🎬</div>Movies</div>
  <div class="bb" data-tab="tv"><div class="bi">📺</span></div>TV</div>
  <div class="bb" data-tab="adult"><div class="bi">🔞</div>18+</div>
  <div class="bb" data-tab="mylist"><div class="bi">📋</div>My List</div>
</div>

<div class="overlay" id="detail">
  <div class="modal">
    <button class="mclose" onclick="closeDetail()">&times;</button>
    <div class="mhero">
      <div class="mbg" id="mbg"></div>
      <div class="minfo">
        <div class="mtitle" id="mtitle"></div>
        <div class="mmeta" id="mmeta"></div>
        <div class="btns" id="mbtns"></div>
      </div>
    </div>
    <div class="mbody" id="mbody"></div>
  </div>
</div>

<div id="player">
  <div class="ptop">
    <button onclick="closePlayer()">←</button>
    <div class="ptitle" id="ptitle"></div>
    <button onclick="document.getElementById('pbar').classList.toggle('show')">⏭</button>
  </div>
  <div class="pwrap" id="pwrap">
    <iframe id="pframe" referrerpolicy="no-referrer" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe>
    <video id="pvideo" controls autoplay style="display:none"></video>
    <div class="pmsg" id="pmsg"></div>
  </div>
  <div class="pbar" id="pbar"></div>
</div>

<div class="agegate" id="agegate">
  <h2>🔞 Age Verification</h2>
  <p>This section contains adult content. You must be 18 or older to proceed.</p>
  <div class="agebtns">
    <button style="background:linear-gradient(135deg,#1cb7ff,#2ff58b);color:#000" onclick="okAge()">I am 18+ Enter</button>
    <button style="background:#333;color:#fff" onclick="noAge()">Go Back</button>
  </div>
</div>

<div id="toast"></div>

<script>
window.open=function(){return null;};
var tab='home',sources=[],srcIdx=0,huntTimer=null,detail=null;
var myList=JSON.parse(localStorage.getItem('mylist')||'[]');
var cw=JSON.parse(localStorage.getItem('cw')||'[]');
var ageOk=localStorage.getItem('age_ok')==='1';
var GENRES=['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy','Horror','Mystery','Romance','Sci-Fi','Thriller','War','Western'];
var ACATS=['popular','milf','teen','anal','big ass','blowjob','hardcore','lesbian','amateur','public','massage','creampie','threesome','pov','big tits','hentai','japanese','ebony','latina','russian','indian'];

function api(u){return fetch(u).then(function(r){return r.json();}).catch(function(){return null;});}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function $(i){return document.getElementById(i);}
function toast(m){var t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},2500);}

function card(m){
  return '<div class="card" data-id="'+esc(m.id)+'" data-type="'+esc(m.type)+'">'+
    '<div class="poster">'+(m.poster?'<img loading="lazy" src="'+esc(m.poster)+'">':'<div class="no-img">🎬</div>')+
    (m.rating?'<div class="rb">★ '+esc(m.rating)+'</div>':'')+
    (m.year?'<div class="yb">'+esc(m.year)+'</div>':'')+
    '<button class="dl" onclick="event.stopPropagation();downloadIt(\\''+esc(m.id)+'\\')">⬇</button></div>'+
    '<div class="ct">'+esc(m.title)+'</div></div>';
}
function acard(m){
  return '<div class="card" data-adult="1" data-src="'+esc(m.source)+'" data-url="'+esc(m.url)+'" data-title="'+esc(m.title)+'">'+
    '<div class="poster">'+(m.thumb?'<img loading="lazy" src="'+esc(m.thumb)+'">':'<div class="no-img">🔞</div>')+
    (m.duration?'<div class="rb">'+esc(m.duration)+'</div>':'')+'</div>'+
    '<div class="ct">'+esc(m.title)+'</div></div>';
}
function head(t){return '<div class="section"><div class="shead"><h2>'+t+'</h2></div>';}

function buildNav(){
  var n=$('gnav'),h='';
  GENRES.forEach(function(g){h+='<a data-genre="'+g+'">▸ '+g+'</a>';});
  n.innerHTML=h;
}

document.addEventListener('click',function(e){
  var t=e.target.closest('[data-tab]');
  if(t){var tb=t.dataset.tab;
    if(tb==='adult'&&!ageOk){$('agegate').style.display='flex';return;}
    setTab(tb);tab=tb;loadTab(tb);return;}
  var g=e.target.closest('[data-genre]');
  if(g){setTab('genre');loadGenre(g.dataset.genre);return;}
  var c=e.target.closest('.card');
  if(c){
    if(c.dataset.adult){playAdult(c.dataset.src,c.dataset.url,c.dataset.title);}
    else{openDetail(c.dataset.id,c.dataset.type);}
    return;
  }
  var ep=e.target.closest('.ep');
  if(ep){playEp(ep.dataset.id,ep.dataset.s,ep.dataset.e);}
});

function setTab(tb){
  document.querySelectorAll('[data-tab]').forEach(function(el){el.classList.toggle('active',el.dataset.tab===tb);});
}

$('q').addEventListener('keyup',function(e){
  if(e.key==='Enter'){var v=this.value.trim();if(v)searchAll(v);}
});

function loadTab(t){
  if(t==='home')loadHome();
  else if(t==='movies')loadMovies();
  else if(t==='tv')loadTV();
  else if(t==='adult')loadAdult();
  else if(t==='mylist')loadMyList();
  else loadHome();
}

function loadHome(){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Loading...</div>';
  Promise.all([api('/api/movies/trending'),api('/api/tv/trending')]).then(function(r){
    var mv=(r[0]&&r[0].results)||[],tv=(r[1]&&r[1].results)||[],h='';
    if(mv.length){
      h+='<div class="hero" id="hero">';
      mv.slice(0,5).forEach(function(m,i){
        h+='<div class="hslide'+(i===0?' active':'')+'" data-id="'+esc(m.id)+'" data-type="movie">'+
          '<div class="hbg" style="background-image:url('+esc(m.backdrop||m.poster)+')"></div>'+
          '<div class="hinfo"><div class="htitle">'+esc(m.title)+'</div>'+
          '<div class="hmeta"><span class="rating">★ '+esc(m.rating||'N/A')+'</span><span>'+esc(m.year||'')+'</span></div>'+
          '<div class="hdesc">'+esc(m.overview||'')+'</div>'+
          '<div class="btns"><button class="btn bp" onclick="event.stopPropagation();playMovie(\\''+esc(m.id)+'\\')">▶ Watch Now</button>'+
          '<button class="btn bs" onclick="event.stopPropagation();addList(\\''+esc(m.id)+'\\')">+ My List</button></div></div></div>';
      });
      h+='<div class="dots" id="dots">';
      mv.slice(0,5).forEach(function(_,i){h+='<div class="dot'+(i===0?' active':'')+'"></div>';});
      h+='</div></div>';
      setTimeout(startHero,150);
    }
    if(cw.length){h+=head('Continue Watching')+'<div class="row">';cw.slice(0,10).forEach(function(m){h+=card(m);});h+='</div></div>';}
    h+=head('Trending Movies')+'<div class="row">';mv.forEach(function(m){h+=card(m);});h+='</div></div>';
    h+=head('Trending TV Shows')+'<div class="row">';tv.forEach(function(m){h+=card(m);});h+='</div></div>';
    C.innerHTML=h;
  });
}

function loadMovies(){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Loading...</div>';
  api('/api/movies/trending').then(function(d){
    var h='<div class="section"><h2 style="margin-bottom:14px">Movies</h2><div class="genres">';
    GENRES.forEach(function(g){h+='<div class="pill" data-genre="'+g+'">'+g+'</div>';});
    h+='</div><div class="grid">';
    ((d&&d.results)||[]).forEach(function(m){h+=card(m);});
    h+='</div></div>';C.innerHTML=h;
  });
}

function loadGenre(g){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Loading...</div>';
  api('/api/movies/genre/'+encodeURIComponent(g)).then(function(d){
    var h='<div class="section"><h2 style="margin-bottom:14px">'+esc(g)+'</h2><div class="genres">';
    GENRES.forEach(function(x){h+='<div class="pill'+(x===g?' active':'')+'" data-genre="'+x+'">'+x+'</div>';});
    h+='</div><div class="grid">';
    ((d&&d.results)||[]).forEach(function(m){h+=card(m);});
    if(!(d&&d.results&&d.results.length))h+='<div style="color:#888">No results</div>';
    h+='</div></div>';C.innerHTML=h;
  });
}

function loadTV(){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Loading...</div>';
  api('/api/tv/trending').then(function(d){
    var h='<div class="section"><h2 style="margin-bottom:14px">TV Shows</h2><div class="grid">';
    ((d&&d.results)||[]).forEach(function(m){h+=card(m);});
    h+='</div></div>';C.innerHTML=h;
  });
}

function searchAll(q){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Searching...</div>';
  Promise.all([api('/api/movies/search?q='+encodeURIComponent(q)),api('/api/tv/search?q='+encodeURIComponent(q))]).then(function(r){
    var all=((r[0]&&r[0].results)||[]).concat((r[1]&&r[1].results)||[]);
    var h='<div class="section"><h2 style="margin-bottom:14px">Results for "'+esc(q)+'"</h2><div class="grid">';
    all.forEach(function(m){h+=card(m);});
    if(!all.length)h+='<div style="color:#888;padding:30px">No results found</div>';
    h+='</div></div>';C.innerHTML=h;
  });
}

function loadMyList(){
  var h='<div class="section"><h2 style="margin-bottom:14px">My List</h2><div class="grid">';
  if(myList.length){myList.forEach(function(m){h+=card(m);});}
  else{h+='<div style="color:#888;padding:30px">Your list is empty.</div>';}
  h+='</div></div>';$('content').innerHTML=h;
}

function loadAdult(){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Loading...</div>';
  api('/api/adult/trending').then(function(d){
    var h='<div class="section"><h2 style="margin-bottom:14px">🔞 Adult Content</h2><div class="genres">';
    ACATS.forEach(function(c){h+='<div class="pill" onclick="adultCat(\\''+esc(c)+'\\')">'+esc(c)+'</div>';});
    h+='</div><div class="searchbox" style="max-width:420px;margin-bottom:20px"><span class="sicon">🔍</span>'+
      '<input id="aq" placeholder="Search adult..." onkeyup="if(event.key===\\'Enter\\')adultSearch(this.value)"></div>';
    h+='<div class="grid">';
    ((d&&d.results)||[]).forEach(function(m){h+=acard(m);});
    h+='</div></div>';C.innerHTML=h;
  });
}

function adultCat(c){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Loading...</div>';
  api('/api/adult/category/'+encodeURIComponent(c)).then(function(d){
    var h='<div class="section"><h2 style="margin-bottom:14px">🔞 '+esc(c)+'</h2><div class="grid">';
    ((d&&d.results)||[]).forEach(function(m){h+=acard(m);});
    h+='</div></div>';C.innerHTML=h;
  });
}
function adultSearch(q){
  var C=$('content');C.innerHTML='<div class="loading"><div class="spinner"></div>Searching...</div>';
  api('/api/adult/search?q='+encodeURIComponent(q)).then(function(d){
    var h='<div class="section"><h2 style="margin-bottom:14px">🔞 '+esc(q)+'</h2><div class="grid">';
    ((d&&d.results)||[]).forEach(function(m){h+=acard(m);});
    h+='</div></div>';C.innerHTML=h;
  });
}

function openDetail(id,type){
  detail={id:id,type:type};
  $('detail').classList.add('open');
  $('mbody').innerHTML='<div class="loading"><div class="spinner"></div></div>';
  var srcUrl=type==='tv'?'/api/tv/'+id+'/1/1':'/api/movie/'+id+'/sources';
  api(srcUrl).then(function(d){sources=(d&&d.sources)||[];});
  api(type==='tv'?'/api/tv/'+id:'/api/movie/'+id).then(function(d){
    if(!d){closeDetail();return;}
    detail=d;detail.id=id;detail.type=type;
    $('mbg').style.backgroundImage='url('+(d.backdrop||d.poster||'')+')';
    $('mtitle').textContent=d.title||'';
    $('mmeta').innerHTML='<span class="rating">★ '+esc(d.rating||'N/A')+'</span><span>'+esc(d.year||'')+'</span><span>'+esc(d.runtime||'')+'</span>'+
      (d.genres||[]).map(function(g){return '<span style="color:#1cb7ff">'+esc(g)+'</span>';}).join(' ');
    $('mbtns').innerHTML='<button class="btn bp" onclick="playMovie(\\''+esc(id)+'\\',\\''+esc(type)+'\\')">▶ Play</button>'+
      '<button class="btn bs" onclick="addList(\\''+esc(id)+'\\')">+ My List</button>'+
      (d.trailer?'<button class="btn bs" onclick="location.href=\\''+esc(d.trailer.url)+'\\'">🎬 Trailer</button>':'');
    var h='';
    if(d.synopsis)h+='<h3>Synopsis</h3><div class="syn">'+esc(d.synopsis)+'</div>';
    if(d.cast&&d.cast.length){
      h+='<h3>Cast</h3><div class="castrow">';
      d.cast.slice(0,12).forEach(function(c){h+='<div class="ccard"><div class="cav">👤</div><div class="cname">'+esc(c.name)+'</div></div>';});
      h+='</div>';
    }
    if(type==='tv'&&d.seasons&&d.seasons.length){
      h+='<h3>Episodes</h3><div class="selsel"><select id="ssel" onchange="loadEps(\\''+esc(id)+'\\',this.value)">';
      d.seasons.forEach(function(s){h+='<option value="'+s.number+'">Season '+s.number+' ('+s.episodes+' eps)</option>';});
      h+='</select></div><div class="epgrid" id="epg"><div class="loading"><div class="spinner"></div></div></div>';
      setTimeout(function(){loadEps(id,d.seasons[0].number);},80);
    }
    h+='<h3 style="margin-top:22px">Similar</h3><div class="row" id="simrow" style="margin-top:12px"></div>';
    $('mbody').innerHTML=h;
    api('/api/movie/'+id+'/similar').then(function(s){
      var r='';((s&&s.results)||[]).forEach(function(m){r+=card(m);});
      var el=$('simrow');if(el)el.innerHTML=r;
    });
  });
}

function loadEps(id,s){
  var g=$('epg');if(!g)return;
  g.innerHTML='<div class="loading"><div class="spinner"></div></div>';
  api('/api/tv/'+id+'/season/'+s).then(function(d){
    var h='';
    ((d&&d.episodes)||[]).forEach(function(e){
      h+='<div class="ep" data-id="'+esc(id)+'" data-s="'+s+'" data-e="'+e.number+'">'+
        (e.thumb?'<img class="eth" src="'+esc(e.thumb)+'">':'<div class="eth"></div>')+
        '<div class="einfo"><div class="enum">E'+e.number+'</div><div class="etitle">'+esc(e.title)+'</div></div></div>';
    });
    g.innerHTML=h||'<div style="color:#888">No episodes found</div>';
  });
}

function closeDetail(){$('detail').classList.remove('open');}

function playMovie(id,type){
  closeDetail();
  var title=(detail&&detail.title)||'';
  if(type==='tv'){
    startPlayer(title,[]);
    api('/api/tv/'+id+'/1/1').then(function(d){startPlayer(title,(d&&d.sources)||[]);});
  }else{
    if(sources&&sources.length){startPlayer(title,sources);}
    else{api('/api/movie/'+id+'/sources').then(function(d){startPlayer(title,(d&&d.sources)||[]);});}
  }
  addCW(id,type,title);
}
function playEp(id,s,e){
  closeDetail();
  var title=((detail&&detail.title)||'')+' S'+s+' E'+e;
  startPlayer(title,[]);
  api('/api/tv/'+id+'/'+s+'/'+e).then(function(d){startPlayer(title,(d&&d.sources)||[]);});
}

function startPlayer(title,list){
  sources=list||[];srcIdx=0;
  $('player').classList.add('open');
  $('ptitle').textContent=title;
  $('pvideo').style.display='none';
  $('pframe').style.display='block';
  $('pbar').classList.remove('show');
  renderSrcs();
  if(!sources.length){$('pmsg').textContent='Loading sources...';return;}
  $('pmsg').textContent='';
  trySrc(0);
}

function trySrc(i){
  clearTimeout(huntTimer);
  if(i>=sources.length){$('pmsg').textContent='All sources failed. Tap ⏭ to retry.';return;}
  srcIdx=i;renderSrcs();
  var f=$('pframe'),loaded=false;
  $('pmsg').textContent='';
  f.onload=function(){
    if(loaded)return;loaded=true;
    setTimeout(function(){clearTimeout(huntTimer);},1200);
  };
  f.src=sources[i].url;
  huntTimer=setTimeout(function(){if(!loaded)trySrc(i+1);},6500);
}

function renderSrcs(){
  var h='';
  sources.forEach(function(s,i){
    h+='<div class="src'+(i===srcIdx?' active':'')+'" onclick="trySrc('+i+')">'+esc(s.name)+' '+esc(s.quality||'')+'</div>';
  });
  $('pbar').innerHTML=h;
}

function playAdult(source,url,title){
  startPlayer(title,[]);
  $('pmsg').textContent='Loading...';
  var b=btoa(unescape(encodeURIComponent(url))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  api('/api/adult/video/'+source+'?u='+b).then(function(d){
    if(d&&d.files&&d.files.length){
      var v=$('pvideo');
      $('pframe').style.display='none';
      v.style.display='block';
      v.src=d.files[0].url;
      v.play().catch(function(){});
      $('pmsg').textContent='';
    }else{
      $('pframe').src=url;
      $('pmsg').textContent='';
    }
  });
}

function closePlayer(){
  clearTimeout(huntTimer);
  $('player').classList.remove('open');
  $('pframe').src='';
  var v=$('pvideo');v.pause();v.src='';
}

function downloadIt(id){
  toast('Fetching download...');
  api('/api/movie/'+id+'/4k').then(function(d){
    var t=(d&&d.results)||[];
    if(!t.length){toast('No download found');return;}
    t.sort(function(a,b){return (b.seeds||0)-(a.seeds||0);});
    var best=null;
    for(var i=0;i<t.length;i++){if(t[i].quality==='1080p'){best=t[i];break;}}
    best=best||t[0];
    if(navigator.clipboard)navigator.clipboard.writeText(best.magnet).catch(function(){});
    toast('⬇ '+best.quality+' · '+best.size+' · magnet copied');
  });
}

function addList(id){
  if(myList.some(function(x){return x.id===id;})){toast('Already in your list');return;}
  var m=detail&&detail.id===id?detail:{id:id,type:'movie',title:(detail&&detail.title)||'',poster:(detail&&detail.poster)||''};
  myList.push({id:m.id,type:m.type,title:m.title,poster:m.poster,backdrop:m.backdrop,rating:m.rating,year:m.year});
  localStorage.setItem('mylist',JSON.stringify(myList));
  toast('Added to My List ✓');
}

function addCW(id,type,title){
  cw=cw.filter(function(x){return x.id!==id;});
  cw.unshift({id:id,type:type,title:title,poster:(detail&&detail.poster)||'',backdrop:(detail&&detail.backdrop)||'',rating:(detail&&detail.rating)||'',year:(detail&&detail.year)||''});
  if(cw.length>20)cw=cw.slice(0,20);
  localStorage.setItem('cw',JSON.stringify(cw));
}

function okAge(){ageOk=true;localStorage.setItem('age_ok','1');$('agegate').style.display='none';setTab('adult');tab='adult';loadAdult();}
function noAge(){$('agegate').style.display='none';setTab('home');tab='home';loadHome();}

var heroIdx=0,heroTimer=null;
function startHero(){
  var sl=document.querySelectorAll('.hslide');
  if(sl.length<2)return;
  clearInterval(heroTimer);
  heroTimer=setInterval(function(){
    sl[heroIdx].classList.remove('active');
    var d=document.querySelectorAll('.dot');if(d[heroIdx])d[heroIdx].classList.remove('active');
    heroIdx=(heroIdx+1)%sl.length;
    sl[heroIdx].classList.add('active');
    if(d[heroIdx])d[heroIdx].classList.add('active');
  },5000);
}

buildNav();
loadHome();
</script>
</body></html>`;

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.type('html').send(HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MovieBox on :' + PORT));
