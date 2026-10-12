const axios = require('axios');
const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const img = (p, size = 'w500') => p ? `https://image.tmdb.org/t/p/${size}${p}` : null;

function mapShow(m) {
  return {
    id: m.id,
    title: m.name || m.title,
    poster: img(m.poster_path),
    backdrop: img(m.backdrop_path, 'w1280'),
    year: (m.first_air_date || '').slice(0, 4),
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
  const d = await tmdb('/trending/tv/week', { page });
  return (d.results || []).map(mapShow);
}

async function search(q, page = 1) {
  const d = await tmdb('/search/tv', { query: q, page, include_adult: true });
  return (d.results || []).map(mapShow);
}

async function getDetails(id) {
  const t = await tmdb(`/tv/${id}`);
  return {
    id: t.id,
    title: t.name,
    poster: img(t.poster_path),
    backdrop: img(t.backdrop_path, 'w1280'),
    year: (t.first_air_date || '').slice(0, 4),
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    genres: (t.genres || []).map(g => g.name),
    synopsis: t.overview,
    seasons: (t.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ number: s.season_number, episodes: s.episode_count, poster: img(s.poster_path) }))
  };
}

async function getSeason(id, season) {
  const s = await tmdb(`/tv/${id}/season/${season}`);
  return {
    season: s.season_number,
    title: s.name,
    episodes: (s.episodes || []).map(e => ({
      number: e.episode_number,
      title: e.name,
      thumb: img(e.still_path, 'w300'),
      air_date: e.air_date,
      overview: e.overview
    }))
  };
}

// ═══════════════════════════════════════════════════════════
// 18-PROVIDER POOL (TV URLs)  — expand by appending
// ═══════════════════════════════════════════════════════════
const TV_PROVIDERS = [
  { name: 'VidSrc',       quality: 'HD',  tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc XYZ',   quality: 'HD',  tv: (id, s, e) => `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc CC',    quality: 'HD',  tv: (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc Net',   quality: 'HD',  tv: (id, s, e) => `https://vidsrc.net/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc Pro',   quality: 'HD',  tv: (id, s, e) => `https://vidsrc.pro/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc Stream',quality: 'HD',  tv: (id, s, e) => `https://vidsrc.stream/embed/tv/${id}/${s}/${e}` },
  { name: 'Embed.su',     quality: 'HD',  tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}` },
  { name: 'VidLink',      quality: 'HD',  tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}` },
  { name: '2Embed',       quality: 'HD',  tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` },
  { name: '2Embed Me',    quality: 'HD',  tv: (id, s, e) => `https://www.2embed.me/embed/${id}/${s}/${e}` },
  { name: 'MultiEmbed',   quality: 'HD',  tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
  { name: 'AutoEmbed',    quality: 'HD',  tv: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` },
  { name: 'SmashyStream', quality: 'HD',  tv: (id, s, e) => `https://player.smashystream.com/tv/${id}/${s}/${e}` },
  { name: '23Embed',      quality: 'HD',  tv: (id, s, e) => `https://www.23embed.com/tv/${id}/${s}/${e}` },
  { name: 'FilmEmbed',    quality: 'HD',  tv: (id, s, e) => `https://www.filmembed.com/embed/tv/${id}/${s}/${e}` },
  { name: 'MoviesAPI',    quality: 'CAM', tv: (id, s, e) => `https://moviesapi.club/tv/${id}/${s}/${e}` },
  { name: 'VidEasy',      quality: 'HD',  tv: (id, s, e) => `https://player.videasy.to/tv/${id}/${s}/${e}` },
  { name: 'RuVid',        quality: 'HD',  tv: (id, s, e) => `https://ruvid.net/embed/tv/${id}/${s}/${e}` }
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

async function getEpisodeStream(id, season, episode) {
  const s = await tmdb(`/tv/${id}/season/${season}`).catch(() => ({ episodes: [] }));
  const eps = s.episodes || [];
  const cur = eps.find(e => String(e.episode_number) === String(episode));
  const maxEp = eps.length ? Math.max(...eps.map(e => e.episode_number)) : 0;
  const next = Number(episode) < maxEp
    ? { season: Number(season), episode: Number(episode) + 1 }
    : { season: Number(season) + 1, episode: 1 };

  const sources = await rankSources(
    TV_PROVIDERS.map(p => ({ name: p.name, quality: p.quality, url: p.tv(id, season, episode) }))
  );

  return {
    title: cur ? cur.name : `Season ${season} Episode ${episode}`,
    thumb: cur ? img(cur.still_path, 'w780') : null,
    air_date: cur ? cur.air_date : null,
    next,
    sources
  };
}

module.exports = { getTrending, search, getDetails, getSeason, getEpisodeStream };
