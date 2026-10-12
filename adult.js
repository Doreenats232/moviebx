const axios = require('axios');
const cheerio = require('cheerio');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

const enc = (u) => Buffer.from(u).toString('base64url');
const dec = (id) => Buffer.from(String(id), 'base64url').toString();

async function fetchHTML(url) {
  const { data } = await axios.get(url, { headers: UA, timeout: 15000 });
  return cheerio.load(data);
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function num(s) {
  const t = clean(s).replace(/,/g, '');
  const m = t.match(/[\d.]+\s*[kKmM]?/);
  return m ? m[0].trim() : '';
}

// ── per-source list parsing ─────────────────────────────────
const SOURCES = {
  xvideos: {
    list: (q, cat, page) => {
      const p = Math.max(0, page - 1);
      if (q) return `https://www.xvideos.com/?k=${encodeURIComponent(q)}&p=${p}`;
      if (cat && cat !== 'trending' && cat !== 'popular' && cat !== 'new') return `https://www.xvideos.com/tags/${encodeURIComponent(cat)}?p=${p}`;
      return `https://www.xvideos.com/?p=${p}`;
    },
    parse: ($) => {
      const out = [];
      $('#video-list .thumb-block, .thumb-block').each((i, el) => {
        const a = $(el).find('a[href*="/video"]').first();
        const href = a.attr('href');
        if (!href) return;
        const title = clean($(el).find('p.title a').text() || a.attr('title'));
        const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        out.push({
          id: enc('https://www.xvideos.com' + href),
          source: 'xvideos', title,
          poster: thumb, thumbnail: thumb,
          duration: clean($(el).find('.duration').text()),
          views: num($(el).find('.views').text())
        });
      });
      return out;
    }
  },
  xnxx: {
    list: (q, cat, page) => {
      const p = Math.max(0, page - 1);
      if (q) return `https://www.xnxx.com/?k=${encodeURIComponent(q)}&p=${p}`;
      if (cat && cat !== 'trending' && cat !== 'popular' && cat !== 'new') return `https://www.xnxx.com/tags/${encodeURIComponent(cat)}?p=${p}`;
      return `https://www.xnxx.com/hits`;
    },
    parse: ($) => {
      const out = [];
      $('.thumb-block, .thumb-inside').each((i, el) => {
        const a = $(el).find('a[href*="/video-"]').first();
        const href = a.attr('href');
        if (!href) return;
        const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        out.push({
          id: enc(href.startsWith('http') ? href : 'https://www.xnxx.com' + href),
          source: 'xnxx',
          title: clean($(el).find('.thumb-under p a, p.title a').first().text() || a.attr('title')),
          poster: thumb, thumbnail: thumb,
          duration: clean($(el).find('.duration').text()),
          views: num($(el).find('.views, .mobile-hide').text())
        });
      });
      return out;
    }
  },
  eporner: {
    list: (q, cat, page) => {
      if (q) return `https://www.eporner.com/search/${encodeURIComponent(q)}/${page > 1 ? page + '/' : ''}`;
      if (cat && cat !== 'trending' && cat !== 'popular' && cat !== 'new') return `https://www.eporner.com/category/${encodeURIComponent(cat)}/${page > 1 ? page + '/' : ''}`;
      return `https://www.eporner.com/${page > 1 ? page + '/' : ''}`;
    },
    parse: ($) => {
      const out = [];
      $('div.mb, .video-item').each((i, el) => {
        const a = $(el).find('a[href*="/video-"], a.mbtitle').first();
        const href = a.attr('href');
        if (!href) return;
        const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        out.push({
          id: enc(href.startsWith('http') ? href : 'https://www.eporner.com' + href),
          source: 'eporner',
          title: clean(a.attr('title') || a.text()),
          poster: thumb, thumbnail: thumb,
          duration: clean($(el).find('.mbtim, .duration').text()),
          views: num($(el).find('.mbvie').text())
        });
      });
      return out;
    }
  },
  spankbang: {
    list: (q, cat, page) => {
      const p = page > 1 ? `${page}/` : '';
      if (q) return `https://spankbang.com/s/${encodeURIComponent(q)}/${p}`;
      if (cat && cat !== 'trending' && cat !== 'popular' && cat !== 'new') return `https://spankbang.com/${encodeURIComponent(cat)}/videos/${p}`;
      return `https://spankbang.com/trending_videos/${p}`;
    },
    parse: ($) => {
      const out = [];
      $('div.video-item, li.video-item').each((i, el) => {
        const a = $(el).find('a').first();
        const href = a.attr('href');
        if (!href) return;
        const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        out.push({
          id: enc(href.startsWith('http') ? href : 'https://spankbang.com' + href),
          source: 'spankbang',
          title: clean(a.attr('title') || $(el).find('p.name').text()),
          poster: thumb, thumbnail: thumb,
          duration: clean($(el).find('.i-length, .length').text()),
          views: num($(el).find('.i-views, .views').text())
        });
      });
      return out;
    }
  },
  redtube: {
    list: (q, cat, page) => {
      const base = 'https://www.redtube.com';
      if (q) return `${base}/?search=${encodeURIComponent(q)}&page=${page}`;
      if (cat && cat !== 'trending' && cat !== 'popular' && cat !== 'new') return `${base}/${encodeURIComponent(cat)}?page=${page}`;
      return `${base}/?page=${page}`;
    },
    parse: ($) => {
      const out = [];
      $('div.video-item, li.thumb-block').each((i, el) => {
        const a = $(el).find('a[href*="/"]').first();
        const href = a.attr('href');
        if (!href) return;
        const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        out.push({
          id: enc(href.startsWith('http') ? href : 'https://www.redtube.com' + href),
          source: 'redtube',
          title: clean($(el).find('.video-title, .thumb-title').text() || a.attr('title')),
          poster: thumb, thumbnail: thumb,
          duration: clean($(el).find('.video-duration, .duration').text()),
          views: num($(el).find('.video-views, .views').text())
        });
      });
      return out;
    }
  }
};

const SOURCE_LIST = Object.keys(SOURCES);

async function scrapeOne(src, q, cat, page) {
  const s = SOURCES[src];
  if (!s) return [];
  try {
    const $ = await fetchHTML(s.list(q, cat, page));
    return s.parse($);
  } catch (e) {
    console.warn(`adult scrape failed (${src}): ${e.message}`);
    return [];
  }
}

function pickSource(source) {
  return source && source !== 'all' && SOURCES[source] ? [source] : SOURCE_LIST;
}

async function getTrending(page = 1, source) {
  const lists = await Promise.all(pickSource(source).map(s => scrapeOne(s, null, 'trending', page)));
  return lists.flat().slice(0, 60);
}

async function search(q, page = 1, source) {
  const lists = await Promise.all(pickSource(source).map(s => scrapeOne(s, q, null, page)));
  return lists.flat().slice(0, 60);
}

async function getByCategory(name, page = 1, source) {
  const lists = await Promise.all(pickSource(source).map(s => scrapeOne(s, null, name, page)));
  return lists.flat().slice(0, 60);
}

// ── stream extraction ───────────────────────────────────────
async function getVideo(source, id) {
  const url = dec(id);
  const { data: html } = await axios.get(url, { headers: UA, timeout: 15000 });
  const $ = cheerio.load(html);
  const title = clean($('title').text().replace(/\s*[-|].*$/, '')) || 'Adult Video';
  const duration = clean($('.duration, .video-duration, .i-length').first().text());
  const views = num($('.views, .video-views, .i-views').first().text());
  const thumb = $('meta[property="og:image"]').attr('content') ||
                $('img').first().attr('data-src') || $('img').first().attr('src');

  const sources = [];
  const push = (name, u) => {
    if (!u) return;
    u = u.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(u) && !sources.some(x => x.url === u)) sources.push({ name, url: u });
  };

  const patterns = [
    ['High',  /setVideoUrlHigh\(\s*['"]([^'"]+)['"]/, /"video_url"\s*:\s*"([^"]+)"/],
    ['Low',   /setVideoUrlLow\(\s*['"]([^'"]+)['"]/,  /"video_url_low"\s*:\s*"([^"]+)"/],
    ['MP4',   /<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i, /file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i],
    ['Alt',   /video_url\s*:\s*['"]([^'"]+)['"]/, /stream_url["']?\s*[:=]\s*["']([^"']+)["']/]
  ];
  for (const [name, ...regs] of patterns) {
    for (const re of regs) {
      const m = html.match(re);
      if (m) { push(name, m[1]); break; }
    }
  }

  return {
    source, title, duration, views, thumb,
    pageUrl: url,
    sources: sources.length ? sources : [{ name: 'Embed', url }]
  };
}

module.exports = { getTrending, search, getByCategory, getVideo, SOURCE_LIST };
