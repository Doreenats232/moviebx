const axios = require('axios');
const cheerio = require('cheerio');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };

function toCard(item) {
  return {
    id: item.id,
    source: item.source,
    type: 'adult',
    title: item.title || 'Untitled',
    thumbnail: item.thumbnail || null,
    duration: item.duration || null,
    views: item.views || null,
    embed: item.embed || null
  };
}

// ─── XVideos ────────────────────────────────────────────────────
async function xvideosList(url) {
  const { data } = await axios.get(url, { headers: UA });
  const $ = cheerio.load(data);
  const out = [];
  $('#content .thumb-block').each((i, el) => {
    const a = $(el).find('.thumb-under a');
    const href = a.attr('href') || '';
    const id = href.split('/').filter(Boolean).pop();
    out.push(toCard({
      id: `xvideos:${id}`,
      source: 'xvideos',
      title: a.attr('title') || a.text().trim(),
      thumbnail: $(el).find('.thumb img').attr('data-src') || $(el).find('.thumb img').attr('src'),
      duration: $(el).find('.thumb-badge').text().trim() || null,
      views: $(el).find('.metadata .views').text().trim() || null
    }));
  });
  return out;
}

// ─── XNXX ───────────────────────────────────────────────────────
async function xnxxList(url) {
  const { data } = await axios.get(url, { headers: UA });
  const $ = cheerio.load(data);
  const out = [];
  $('.thumb-under').each((i, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href') || '';
    const id = href.split('/').filter(Boolean).pop();
    out.push(toCard({
      id: `xnxx:${id}`,
      source: 'xnxx',
      title: a.attr('title') || a.text().trim(),
      thumbnail: $(el).closest('.thumb-block').find('img').attr('data-src') || $(el).closest('.thumb-block').find('img').attr('src'),
      duration: $(el).find('.thumb-badge').text().trim() || null
    }));
  });
  return out;
}

// ─── EPorner ────────────────────────────────────────────────────
async function epornerList(url) {
  const { data } = await axios.get(url, { headers: UA });
  const $ = cheerio.load(data);
  const out = [];
  $('.mb.videos').each((i, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href') || '';
    const id = href.split('/').filter(Boolean).pop();
    out.push(toCard({
      id: `eporner:${id}`,
      source: 'eporner',
      title: $(el).find('.mbtit a').text().trim() || a.attr('title'),
      thumbnail: $(el).find('img').attr('data-src') || $(el).find('img').attr('src'),
      duration: $(el).find('.mbtim').text().trim() || null,
      views: $(el).find('.mbvie').text().trim() || null
    }));
  });
  return out;
}

// ─── SpankBang ──────────────────────────────────────────────────
async function spankbangList(url) {
  const { data } = await axios.get(url, { headers: UA });
  const $ = cheerio.load(data);
  const out = [];
  $('.video-item').each((i, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href') || '';
    const id = href.split('/').filter(Boolean).pop();
    out.push(toCard({
      id: `spankbang:${id}`,
      source: 'spankbang',
      title: a.attr('title') || a.text().trim(),
      thumbnail: $(el).find('img').attr('data-src') || $(el).find('img').attr('src'),
      duration: $(el).find('.p-i-l-i-d').text().trim() || null
    }));
  });
  return out;
}

// ─── RedTube ────────────────────────────────────────────────────
async function redtubeList(url) {
  const { data } = await axios.get(url, { headers: UA });
  const $ = cheerio.load(data);
  const out = [];
  $('.video-box').each((i, el) => {
    const a = $(el).find('a.thumb-link').first();
    const href = a.attr('href') || '';
    const id = href.split('/').filter(Boolean).pop();
    out.push(toCard({
      id: `redtube:${id}`,
      source: 'redtube',
      title: $(el).find('.video-title').text().trim() || a.attr('title'),
      thumbnail: a.find('img').attr('data-src') || a.find('img').attr('src'),
      duration: $(el).find('.video-duration').text().trim() || null
    }));
  });
  return out;
}

// ─── Public API ─────────────────────────────────────────────────
async function search(q, page = 1) {
  const queries = [
    xvideosList(`https://www.xvideos.com/?k=${encodeURIComponent(q)}&p=${page - 1}`),
    xnxxList(`https://www.xnxx.com/search/${encodeURIComponent(q)}/${page}`),
    epornerList(`https://www.eporner.com/search/${encodeURIComponent(q)}/${page}/`),
    redtubeList(`https://www.redtube.com/?search=${encodeURIComponent(q)}&page=${page}`)
  ];
  const results = await Promise.allSettled(queries);
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []).slice(0, 60);
}

async function getTrending(page = 1) {
  const calls = [
    xvideosList(`https://www.xvideos.com/`),
    xnxxList(`https://www.xnxx.com/hits`),
    epornerList(`https://www.eporner.com/`),
    spankbangList(`https://spankbang.com/trending_videos/${page}/`),
    redtubeList(`https://www.redtube.com/?page=${page}`)
  ];
  const results = await Promise.allSettled(calls);
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []).slice(0, 60);
}

async function getByCategory(name, page = 1) {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const calls = [
    xvideosList(`https://www.xvideos.com/${slug}/best/p/${page - 1}`),
    epornerList(`https://www.eporner.com/cat/${slug}/${page}/`),
    spankbangList(`https://spankbang.com/${slug}/videos/${page}/`)
  ];
  const results = await Promise.allSettled(calls);
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []).slice(0, 60);
}

async function getVideo(source, id) {
  let url = '';
  switch (source) {
    case 'xvideos': url = `https://www.xvideos.com/video${id}/x`; break;
    case 'xnxx': url = `https://www.xnxx.com/video-${id}/x`; break;
    case 'eporner': url = `https://www.eporner.com/video-${id}/x`; break;
    case 'spankbang': url = `https://spankbang.com/${id}/video/x`; break;
    case 'redtube': url = `https://www.redtube.com/${id}`; break;
    default: throw new Error('Unknown source');
  }

  const { data } = await axios.get(url, { headers: UA });

  let streamUrl = null;
  const patterns = [
    /setVideoUrlHigh\(['"]([^'"]+)['"]\)/,
    /setVideoUrlLow\(['"]([^'"]+)['"]\)/,
    /html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/,
    /"video_url"\s*:\s*"([^"]+)"/,
    /stream_url['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
    /<source[^>]+src=["']([^"']+)["']/,
    /file:\s*['"]([^'"]+\.(mp4|m3u8)[^'"]*)['"]/
  ];
  for (const p of patterns) {
    const m = data.match(p);
    if (m) { streamUrl = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/'); break; }
  }

  return {
    source, id,
    embed: url,
    page: url,
    stream: streamUrl,
    fallback: `https://www.xvideos.com/embedframe/${id}`
  };
}

module.exports = { search, getTrending, getByCategory, getVideo };
