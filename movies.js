const axios = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';

const GENRES = {
  action: 28, comedy: 35, horror: 27, romance: 10749, 'sci-fi': 878, thriller: 53,
  drama: 18, animation: 16, fantasy: 14, adventure: 12, crime: 80, mystery: 9648
};

// Fastest-known providers FIRST
const PROVIDERS = [
  { name: 'Embed.su',     quality: '1080p', movie: id => `https://embed.su/embed/${id}` },
  { name: 'VidSrc.cc',    quality: '1080p', movie: id => `https://vidsrc.cc/v2/embed/movie/${id}` },
  { name: 'VidSrc.xyz',   quality: '1080p', movie: id => `https://vidsrc.xyz/embed/movie/${id}` },
  { name: 'VidSrc',       quality: '1080p', movie: id => `https://vidsrc.to/embed/movie/${id}` },
  { name: 'VidLink',      quality: '1080p', movie: id => `https://vidlink.pro/movie/${id}` },
  { name: 'AutoEmbed',    quality: '1080p', movie: id => `https://player.autoembed.cc/embed/movie/${id}` },
  { name: 'VidSrc.net',   quality: '1080p', movie: id => `https://vidsrc.net/embed/movie/${id}` },
  { name: '2Embed.cc',    quality: '1080p', movie: id => `https://www.2embed.cc/embed/${id}` },
  { name: 'MultiEmbed',   quality: '1080p', movie: id => `https://multiembed.mov/?video_id=${id}` },
  { name: 'SmashyStream', quality: '1080p', movie: id => `https://player.smashystream.com/movie/${id}` },
  { name: '2Embed.me',    quality: '1080p', movie: id => `https://www.2embed.me/embed/${id}` },
  { name: 'VidSrc.pro',   quality: '1080p', movie: id => `https://vidsrc.pro/embed/movie/${id}` },
  { name: 'VidEasy',      quality: '1080p', movie: id => `https://player.videasy.to/movie/${id}` },
  { name: '23Embed',      quality: '720p',  movie: id => `https://23embed.com/embed/${id}` },
  { name: 'RuVid',        quality: '720p',  movie: id => `https://ruvid.net/embed/${id}` }
];

const JUNK_RE = /domain is for sale|parked|godaddy|sedo\.com|buy this domain|404 not found|video not found|no video|this video (has been|is) removed|<title>\s*news|latest news|blog post|article/i;
const PLAYER_RE = /(player|video|iframe|embed|jwplayer|videojs|\.mp4|\.m3u8|stream|play)/i;
const probeCache = new Map(); // host -> {at, ok}
const CACHE_TTL = 10 * 60 * 1000;

function tmdb(path, params = {}) {
  return axios.get(`${TMDB}${path}`, {
    params: { api_key: TMDB_KEY, language: 'en-US', include_adult: true, ...params },
    timeout: 15000
  }).then(r => r.data);
}

function mapMovie(m) {
  return {
    id: m.id,
    title: m.title || m.name || 'Untitled',
    poster: m.poster_path ? `${IMG}${m.poster_path}` : null,
    backdrop: m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null,
    year: (m.release_date || m.first_air_date || '').slice(0, 4),
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    overview: m.overview || ''
  };
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

async function probeSource(s) {
  const host = hostOf(s.url);
  const hit = probeCache.get(host);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return hit.ok ? { ...s, latency: hit.latency || 1, health: 'ok' } : null;
  }
  const t0 = Date.now();
  try {
    const r = await axios.get(s.url, {
      timeout: 1600,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Referer': 'https://www.google.com/'
      },
      validateStatus: () => true
    });
    const body = String(r.data || '');
    const latency = Date.now() - t0;
    const ok = !(r.status >= 400 || body.length < 200 || JUNK_RE.test(body) || !PLAYER_RE.test(body));
    probeCache.set(host, { at: Date.now(), ok, latency });
    return ok ? { ...s, latency, health: latency < 1200 ? 'ok' : 'slow' } : null;
  } catch {
    probeCache.set(host, { at: Date.now(), ok: false });
    return null;
  }
}

async function buildSources(rawList) {
  const valid = (Array.isArray(rawList) ? rawList : []).filter(s => s && s.url).slice(0, 12);
  const results = await Promise.allSettled(valid.map(probeSource));
  const verified = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  verified.sort((a, b) => (a.latency || 0) - (b.latency || 0));
  const vUrls = new Set(verified.map(v => v.url));
  const unverified = valid.filter(v => !vUrls.has(v.url)).map(v => ({ ...v, latency: 9999, health: 'unknown' }));
  return [...verified, ...unverified].slice(0, 10);
}

async function getTrending(page = 1) {
  const d = await tmdb('/trending/movie/week', { page });
  return (d.results || []).map(mapMovie);
}
async function search(q, page = 1) {
  const d = await tmdb('/search/movie', { query: q, page });
  return (d.results || []).map(mapMovie);
}
async function getByGenre(genre, page = 1) {
  const id = GENRES[String(genre).toLowerCase()];
  if (!id) return [];
  const d = await tmdb('/discover/movie', { with_genres: id, page, sort_by: 'popularity.desc' });
  return (d.results || []).map(mapMovie);
}
async function getDetails(id) {
  const m = await tmdb(`/movie/${id}`);
  return {
    id: m.id,
    title: m.title || 'Untitled',
    year: (m.release_date || '').slice(0, 4),
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    runtime: m.runtime ? `${m.runtime} min` : null,
    genres: (m.genres || []).map(g => g.name),
    synopsis: m.overview || 'No synopsis available.',
    poster: m.poster_path ? `${IMG}${m.poster_path}` : null,
    backdrop: m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null,
    quality: 'HD'
  };
}
async function getStreamSources(id) {
  const raw = [];
  for (const p of PROVIDERS) {
    try {
      if (typeof p.movie !== 'function') continue;
      const url = p.movie(id);
      if (url) raw.push({ name: p.name, quality: p.quality || 'HD', url });
    } catch (e) {}
  }
  let out = await buildSources(raw);
  if (!out.length) {
    out = [
      { name: 'Embed.su', quality: '1080p', url: `https://embed.su/embed/${id}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.cc', quality: '1080p', url: `https://vidsrc.cc/v2/embed/movie/${id}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.xyz', quality: '1080p', url: `https://vidsrc.xyz/embed/movie/${id}`, health: 'ok', latency: 0 }
    ];
  }
  return out;
}
async function getTrailer(id) {
  const d = await tmdb(`/movie/${id}/videos`);
  const t = (d.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer')
         || (d.results || []).find(v => v.site === 'YouTube');
  return t ? { url: `https://www.youtube.com/embed/${t.key}?autoplay=1`, name: t.name } : null;
}
async function getSimilar(id) {
  const d = await tmdb(`/movie/${id}/similar`);
  return (d.results || []).map(mapMovie);
}

module.exports = { getTrending, search, getByGenre, getDetails, getStreamSources, getTrailer, getSimilar, PROVIDERS };
