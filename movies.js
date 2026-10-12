const axios = require('axios');
const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const GENRE = { action:28, adventure:12, animation:16, comedy:35, crime:80, drama:18, fantasy:14, horror:27, romance:10749, 'sci-fi':878, thriller:53, mystery:9648, war:10752, western:37, documentary:99, family:10751, music:10402, history:36 };

const img = (p, size = 'w500') => p ? `https://image.tmdb.org/t/p/${size}${p}` : null;

function mapMovie(m) {
  return {
    id: m.id,
    title: m.title || m.name,
    poster: img(m.poster_path),
    backdrop: img(m.backdrop_path, 'w1280'),
    year: (m.release_date || m.first_air_date || '').slice(0, 4),
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    overview: m.overview
  };
}

async function tmdb(path, params = {}) {
  const { data } = await axios.get(`${TMDB}${path}`, {
    params: { api_key: KEY, language: 'en-US', ...params },
    timeout: 15000
  });
  return data;
}

async function getTrending(page = 1) {
  const d = await tmdb('/trending/movie/week', { page });
  return (d.results || []).map(mapMovie);
}

async function search(q, page = 1) {
  const d = await tmdb('/search/movie', { query: q, page, include_adult: true });
  return (d.results || []).map(mapMovie);
}

async function getByGenre(name, page = 1) {
  const id = GENRE[String(name).toLowerCase()] || 28;
  const d = await tmdb('/discover/movie', {
    with_genres: id, page, sort_by: 'popularity.desc', include_adult: true
  });
  return (d.results || []).map(mapMovie);
}

async function getDetails(id) {
  const m = await tmdb(`/movie/${id}`);
  return {
    id: m.id,
    title: m.title,
    poster: img(m.poster_path),
    backdrop: img(m.backdrop_path, 'w1280'),
    year: (m.release_date || '').slice(0, 4),
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    runtime: m.runtime ? `${m.runtime} min` : null,
    genres: (m.genres || []).map(g => g.name),
    synopsis: m.overview,
    quality: 'HD'
  };
}

async function getTrailer(id) {
  const v = await tmdb(`/movie/${id}/videos`);
  const list = v.results || [];
  const t = list.find(x => x.site === 'YouTube' && x.type === 'Trailer') || list[0];
  return t ? { key: t.key, url: `https://www.youtube.com/embed/${t.key}?autoplay=1` } : null;
}

// ═══════════════════════════════════════════════════════════
// 18-PROVIDER POOL  (expand by appending to this array)
// ═══════════════════════════════════════════════════════════
const PROVIDERS = [
  { name: 'VidSrc',       quality: 'HD',  movie: id => `https://vidsrc.to/embed/movie/${id}` },
  { name: 'VidSrc XYZ',   quality: 'HD',  movie: id => `https://vidsrc.xyz/embed/movie/${id}` },
  { name: 'VidSrc CC',    quality: 'HD',  movie: id => `https://vidsrc.cc/v2/embed/movie/${id}` },
  { name: 'VidSrc Net',   quality: 'HD',  movie: id => `https://vidsrc.net/embed/movie/${id}` },
  { name: 'VidSrc Pro',   quality: 'HD',  movie: id => `https://vidsrc.pro/embed/movie/${id}` },
  { name: 'VidSrc Stream',quality: 'HD',  movie: id => `https://vidsrc.stream/embed/movie/${id}` },
  { name: 'Embed.su',     quality: 'HD',  movie: id => `https://embed.su/embed/movie/${id}` },
  { name: 'VidLink',      quality: 'HD',  movie: id => `https://vidlink.pro/movie/${id}` },
  { name: '2Embed',       quality: 'HD',  movie: id => `https://www.2embed.cc/embedtmdb/${id}` },
  { name: '2Embed Me',    quality: 'HD',  movie: id => `https://www.2embed.me/embed/${id}` },
  { name: 'MultiEmbed',   quality: 'HD',  movie: id => `https://multiembed.mov/?video_id=${id}&tmdb=1` },
  { name: 'AutoEmbed',    quality: 'HD',  movie: id => `https://player.autoembed.cc/embed/movie/${id}` },
  { name: 'SmashyStream', quality: 'HD',  movie: id => `https://player.smashystream.com/movie/${id}` },
  { name: '23Embed',      quality: 'HD',  movie: id => `https://www.23embed.com/movie/${id}` },
  { name: 'FilmEmbed',    quality: 'HD',  movie: id => `https://www.filmembed.com/embed/movie/${id}` },
  { name: 'MoviesAPI',    quality: 'CAM', movie: id => `https://moviesapi.club/${id}` },
  { name: 'VidEasy',      quality: 'HD',  movie: id => `https://player.videasy.to/movie/${id}` },
  { name: 'RuVid',        quality: 'HD',  movie: id => `https://ruvid.net/embed/movie/${id}` }
];

// ═══════════════════════════════════════════════════════════
// SOURCE HEALTH PROBE  (feature #11)
// ═══════════════════════════════════════════════════════════
const healthCache = new Map();
const TTL = 10 * 60 * 1000;

async function probeHost(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return { health: 'down', latency: 9999 }; }
  const hit = healthCache.get(host);
  if (hit && Date.now() - hit.at < TTL) return hit;

  const started = Date.now();
  let health = 'down';
  try {
    await axios.get(url, {
      timeout: 3000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      validateStatus: s => s < 500
    });
    health = 'ok';
  } catch (e) {
    health = e.code === 'ECONNABORTED' ? 'slow' : 'down';
  }

  const latency = Date.now() - started;
  if (health === 'ok' && latency > 3000) health = 'slow';
  const rec = { health, latency, at: Date.now() };
  healthCache.set(host, rec);
  return rec;
}

const RANK = { ok: 0, slow: 1, down: 2 };

async function rankSources(sources) {
  const probes = await Promise.all(
    sources.map(s => probeHost(s.url).catch(() => ({ health: 'down', latency: 9999 })))
  );
  return sources
    .map((s, i) => ({ ...s, health: probes[i].health, latency: probes[i].latency }))
    .sort((a, b) => (RANK[a.health] - RANK[b.health]) || (a.latency - b.latency));
}

async function getStreamSources(id) {
  return rankSources(PROVIDERS.map(p => ({ name: p.name, quality: p.quality, url: p.movie(id) })));
}

module.exports = { getTrending, search, getByGenre, getDetails, getTrailer, getStreamSources };
