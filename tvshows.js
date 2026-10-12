const axios = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';
const STILL = 'https://image.tmdb.org/t/p/w300';

const TV_PROVIDERS = [
  { name: 'VidSrc',       quality: '1080p', tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc.xyz',   quality: '1080p', tv: (id, s, e) => `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc.cc',    quality: '1080p', tv: (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` },
  { name: 'VidSrc.net',   quality: '1080p', tv: (id, s, e) => `https://vidsrc.net/embed/tv/${id}/${s}/${e}` },
  { name: 'Embed.su',     quality: '1080p', tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}` },
  { name: 'VidLink',      quality: '1080p', tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}` },
  { name: '2Embed',       quality: '1080p', tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` },
  { name: 'MultiEmbed',   quality: '1080p', tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&s=${s}&e=${e}` },
  { name: 'AutoEmbed',    quality: '1080p', tv: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` },
  { name: 'SmashyStream', quality: '1080p', tv: (id, s, e) => `https://player.smashystream.com/tv/${id}/${s}/${e}` },
  { name: 'VidEasy',      quality: '1080p', tv: (id, s, e) => `https://player.videasy.to/tv/${id}/${s}/${e}` }
];

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
  const ep = await tmdb(`/tv/${id}/season/${season}/episode/${episode}`);
  const sources = [];
  for (const p of TV_PROVIDERS) {
    try {
      if (typeof p.tv !== 'function') continue;
      const url = p.tv(id, season, episode);
      if (!url) continue;
      sources.push({ name: p.name, quality: p.quality || 'HD', url, health: 'ok', latency: 0 });
    } catch (e) {}
  }
  if (!sources.length) {
    sources.push(
      { name: 'VidSrc', quality: '1080p', url: `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.xyz', quality: '1080p', url: `https://vidsrc.xyz/embed/tv/${id}/${season}/${episode}`, health: 'ok', latency: 0 }
    );
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
