const axios = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';
const STILL = 'https://image.tmdb.org/t/p/w300';

const TV_PROVIDERS = [
  { name: 'Embed.su',     quality: '1080p', tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc.cc',    quality: '1080p', tv: (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc.xyz',   quality: '1080p', tv: (id, s, e) => `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc',       quality: '1080p', tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
  { name: 'VidLink',      quality: '1080p', tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}` },
  { name: 'AutoEmbed',    quality: '1080p', tv: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc.net',   quality: '1080p', tv: (id, s, e) => `https://vidsrc.net/embed/tv/${id}/${s}/${e}` },
  { name: '2Embed',       quality: '1080p', tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` },
  { name: 'MultiEmbed',   quality: '1080p', tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&s=${s}&e=${e}` },
  { name: 'SmashyStream', quality: '1080p', tv: (id, s, e) => `https://player.smashystream.com/tv/${id}/${s}/${e}` },
  { name: 'VidEasy',      quality: '1080p', tv: (id, s, e) => `https://player.videasy.to/tv/${id}/${s}/${e}` }
];

const JUNK_RE = /domain is for sale|parked|godaddy|sedo\.com|buy this domain|404 not found|video not found|no video|this video (has been|is) removed|<title>\s*news|latest news|blog post|article/i;
const PLAYER_RE = /(player|video|iframe|embed|jwplayer|videojs|\.mp4|\.m3u8|stream|play)/i;
const probeCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function tmdb(path, params = {}) {
  return axios.get(`${TMDB}${path}`, {
    params: { api_key: TMDB_KEY, language: 'en-US', include_adult: true, ...params },
    timeout: 15000
  }).then(r => r.data);
}
function mapShow(t) {
  return {
    id: t.id,
    title: t.name || t.original_name || 'Untitled',
    poster: t.poster_path ? `${IMG}${t.poster_path}` : null,
    backdrop: t.backdrop_path ? `${BACKDROP}${t.backdrop_path}` : null,
    year: (t.first_air_date || '').slice(0, 4),
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    overview: t.overview || ''
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
  const d = await tmdb('/trending/tv/week', { page });
  return (d.results || []).map(mapShow);
}
async function search(q, page = 1) {
  const d = await tmdb('/search/tv', { query: q, page });
  return (d.results || []).map(mapShow);
}
async function getDetails(id) {
  const t = await tmdb(`/tv/${id}`);
  return {
    id: t.id,
    title: t.name || 'Untitled',
    year: (t.first_air_date || '').slice(0, 4),
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    genres: (t.genres || []).map(g => g.name),
    synopsis: t.overview || 'No synopsis available.',
    poster: t.poster_path ? `${IMG}${t.poster_path}` : null,
    backdrop: t.backdrop_path ? `${BACKDROP}${t.backdrop_path}` : null,
    seasons: (t.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ number: s.season_number, episodes: s.episode_count || 0, name: s.name || `Season ${s.season_number}` }))
  };
}
async function getSeason(id, season) {
  const s = await tmdb(`/tv/${id}/season/${season}`);
  return {
    season: Number(s.season_number || season),
    episodes: (s.episodes || []).map(e => ({
      number: e.episode_number,
      title: e.name || `Episode ${e.episode_number}`,
      thumb: e.still_path ? `${STILL}${e.still_path}` : null,
      air_date: e.air_date || '',
      runtime: e.runtime ? `${e.runtime} min` : ''
    }))
  };
}
async function getEpisodeStream(id, season, episode) {
  const ep = await tmdb(`/tv/${id}/season/${season}/episode/${episode}`).catch(() => ({}));
  const raw = [];
  for (const p of TV_PROVIDERS) {
    try {
      if (typeof p.tv !== 'function') continue;
      const url = p.tv(id, season, episode);
      if (url) raw.push({ name: p.name, quality: p.quality || 'HD', url });
    } catch (e) {}
  }
  let sources = await buildSources(raw);
  if (!sources.length) {
    sources = [
      { name: 'Embed.su', quality: '1080p', url: `https://embed.su/embed/tv/${id}/${season}/${episode}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.cc', quality: '1080p', url: `https://vidsrc.cc/v2/embed/tv/${id}/${season}/${episode}`, health: 'ok', latency: 0 }
    ];
  }
  return {
    title: ep.name || `S${season}E${episode}`,
    air_date: ep.air_date || '',
    synopsis: ep.overview || '',
    thumb: ep.still_path ? `${STILL}${ep.still_path}` : null,
    sources,
    next: { season: Number(season), episode: Number(episode) + 1 }
  };
}

module.exports = { getTrending, search, getDetails, getSeason, getEpisodeStream, TV_PROVIDERS };
