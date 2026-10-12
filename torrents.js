
const axios = require('axios');
const cheerio = require('cheerio');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

function http(url, params = {}) {
  return axios.get(url, {
    params,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml' },
    timeout: 15000
  });
}

function magnetFromHash(hash, name) {
  return `magnet:?xt=urn:btih:${String(hash).toUpperCase()}&dn=${encodeURIComponent(name || '')}`;
}

function qualityOf(name) {
  const n = String(name).toLowerCase();
  if (/(2160|uhd|4k|remux)/.test(n)) return '4K';
  if (/(1080p|bluray|bdrip|webrip|web-dl|webdl)/.test(n)) return '1080p';
  if (/(720p)/.test(n)) return '720p';
  if (/(480p|360p|hdcam|camrip|cam)/.test(n)) return 'CAM';
  return 'HD';
}

function norm(t) {
  return { ...t, quality: t.quality || qualityOf(t.title), size: t.size || '—', seeds: t.seeds || 0, peers: t.peers || 0 };
}

// ──────────────────────────────────────────────────────
// YTS — native 4K BluRay remuxes
// ──────────────────────────────────────────────────────
async function yts(query, opts = {}) {
  try {
    const { data } = await http('https://yts.mx/api/v2/list_movies.json', {
      query_term: query,
      limit: 12,
      sort_by: 'download_count',
      minimum_rating: 0,
      quality: opts.quality
    });
    const movies = (data.data && data.data.movies) || [];
    return movies.flatMap(m => (m.torrents || []).map(t => norm({
      source: 'YTS',
      title: `${m.title} ${m.year || ''} ${t.quality || t.type || ''}`.trim(),
      quality: t.quality === '2160p' ? '4K' : (t.quality || qualityOf(t.type)),
      size: t.size,
      seeds: t.seeds,
      peers: t.peers,
      magnet: magnetFromHash(t.hash, `${m.title} ${m.year}`),
      year: m.year
    })));
  } catch { return []; }
}

// ──────────────────────────────────────────────────────
// 1337x — search returns detailUrl; magnet fetched on demand
// ──────────────────────────────────────────────────────
async function x1337(query) {
  try {
    const { data } = await http(`https://1337x.to/search/${encodeURIComponent(query)}/1`);
    const $ = cheerio.load(data);
    const out = [];
    $('table.table-list tbody tr').each((i, el) => {
      const a = $(el).find('td.name a').last();
      const name = a.text().trim();
      const href = a.attr('href');
      const seeds = parseInt($(el).find('td.seeds').text(), 10) || 0;
      const peers = parseInt($(el).find('td.leeches').text(), 10) || 0;
      const size = $(el).find('td.size').text().trim();
      if (name && href) out.push(norm({ source: '1337x', title: name, size, seeds, peers, detailUrl: `https://1337x.to${href}` }));
    });
    return out.slice(0, 12);
  } catch { return []; }
}

// ──────────────────────────────────────────────────────
// TorrentGalaxy — magnets exposed directly
// ──────────────────────────────────────────────────────
async function tgx(query) {
  try {
    const { data } = await http('https://tgx.rs/torrents.php', { search: query, lang: 1, sort: 'seeders', order: 'desc' });
    const $ = cheerio.load(data);
    const out = [];
    $('table tr').each((i, el) => {
      const magnet = $(el).find('a[href^="magnet:"]').attr('href');
      if (!magnet) return;
      const name = $(el).find('a[href^="/torrent/"]').first().text().trim() || $(el).find('td a').first().text().trim();
      const seeds = parseInt($(el).find('td').eq(-2).text(), 10) || 0;
      const peers = parseInt($(el).find('td').eq(-1).text(), 10) || 0;
      const sizeCell = $(el).find('td').filter((k, e) => /\d+(\.\d+)?\s*(GB|MB|TB|KB)/i.test($(e).text())).first().text().trim();
      if (name && magnet) out.push(norm({ source: 'TorrentGalaxy', title: name, size: sizeCell, seeds, peers, magnet }));
    });
    return out.slice(0, 12);
  } catch { return []; }
}

// ──────────────────────────────────────────────────────
// LimeTorrents — magnets exposed
// ──────────────────────────────────────────────────────
async function lime(query) {
  try {
    const { data } = await http(`https://www.limetorrents.info/search/all/${encodeURIComponent(query)}/`);
    const $ = cheerio.load(data);
    const out = [];
    $('table.table2 tr').each((i, el) => {
      if (i === 0) return;
      const magnet = $(el).find('a[href^="magnet:"]').attr('href');
      const name = $(el).find('td').eq(0).text().trim();
      const size = $(el).find('td').eq(3).text().trim();
      const seeds = parseInt($(el).find('td').eq(4).text(), 10) || 0;
      const peers = parseInt($(el).find('td').eq(5).text(), 10) || 0;
      if (name && magnet) out.push(norm({ source: 'LimeTorrents', title: name, size, seeds, peers, magnet }));
    });
    return out.slice(0, 12);
  } catch { return []; }
}

// ──────────────────────────────────────────────────────
// Nyaa — anime / Japanese content, magnets exposed
// ──────────────────────────────────────────────────────
async function nyaa(query) {
  try {
    const { data } = await http('https://nyaa.si/', { f: '0', c: '0_0', q: query, s: 'seeders', o: 'desc' });
    const $ = cheerio.load(data);
    const out = [];
    $('table.torrent-list tbody tr').each((i, el) => {
      const magnet = $(el).find('a[href^="magnet:"]').attr('href');
      const name = $(el).find('td[colspan="2"] a').last().text().trim() || $(el).find('a').last().text().trim();
      const size = $(el).find('td').eq(-3).text().trim();
      const seeds = parseInt($(el).find('td').eq(-2).text(), 10) || 0;
      const peers = parseInt($(el).find('td').eq(-1).text(), 10) || 0;
      if (name && magnet) out.push(norm({ source: 'Nyaa', title: name, size, seeds, peers, magnet }));
    });
    return out.slice(0, 12);
  } catch { return []; }
}

// ──────────────────────────────────────────────────────
// Unified search across all 5
// ──────────────────────────────────────────────────────
async function search(query, opts = {}) {
  const [a, b, c, d, e] = await Promise.all([
    yts(query, opts).catch(() => []),
    x1337(query).catch(() => []),
    tgx(query).catch(() => []),
    lime(query).catch(() => []),
    nyaa(query).catch(() => [])
  ]);
  return [...a, ...b, ...c, ...d, ...e].sort((x, y) => (y.seeds || 0) - (x.seeds || 0));
}

// Extract magnet from a detail page when the scraper only gave us a URL
async function fetchMagnet(detailUrl) {
  const { data } = await http(detailUrl);
  const m = String(data).match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^"'<\s]*/);
  return m ? m[0] : null;
}

async function ensureMagnet(item) {
  if (item.magnet) return item.magnet;
  if (item.detailUrl) return await fetchMagnet(item.detailUrl);
  throw new Error('No magnet or detail URL');
}

module.exports = { search, yts, x1337, tgx, lime, nyaa, fetchMagnet, ensureMagnet, qualityOf };
