const axios = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';

const GENRES = {
  action: 28, comedy: 35, horror: 27, romance: 10749, 'sci-fi': 878, thriller: 53,
  drama: 18, animation: 16, fantasy: 14, adventure: 12, crime: 80, mystery: 9648
};

const PROVIDERS = [
  { name: 'VidSrc',       quality: '1080p', movie: id => `https://vidsrc.to/embed/movie/${id}` },
  { name: 'VidSrc.xyz',   quality: '1080p', movie: id => `https://vidsrc.xyz/embed/movie/${id}` },
  { name: 'VidSrc.cc',    quality: '1080p', movie: id => `https://vidsrc.cc/v2/embed/movie/${id}` },
  { name: 'VidSrc.net',   quality: '1080p', movie: id => `https://vidsrc.net/embed/movie/${id}` },
  { name: 'VidSrc.pro',   quality: '1080p', movie: id => `https://vidsrc.pro/embed/movie/${id}` },
  { name: 'Embed.su',     quality: '1080p', movie: id => `https://embed.su/embed/${id}` },
  { name: 'VidLink',      quality: '1080p', movie: id => `https://vidlink.pro/movie/${id}` },
  { name: '2Embed.cc',    quality: '1080p', movie: id => `https://www.2embed.cc/embed/${id}` },
  { name: '2Embed.me',    quality: '1080p', movie: id => `https://www.2embed.me/embed/${id}` },
  { name: 'MultiEmbed',   quality: '1080p', movie: id => `https://multiembed.mov/?video_id=${id}` },
  { name: 'AutoEmbed',    quality: '1080p', movie: id => `https://player.autoembed.cc/embed/movie/${id}` },
  { name: 'SmashyStream', quality: '1080p', movie: id => `https://player.smashystream.com/movie/${id}` },
  { name: '23Embed',      quality: '720p',  movie: id => `https://23embed.com/embed/${id}` },
  { name: 'VidEasy',      quality: '1080p', movie: id => `https://player.videasy.to/movie/${id}` },
  { name: 'RuVid',        quality: '720p',  movie: id => `https://ruvid.net/embed/${id}` }
];

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
  const out = [];
  for (const p of PROVIDERS) {
    try {
      if (typeof p.movie !== 'function') continue;
      const url = p.movie(id);
      if (!url) continue;
      out.push({ name: p.name, quality: p.quality || 'HD', url, health: 'ok', latency: 0 });
    } catch (e) { /* skip broken provider */ }
  }
  // HARD FALLBACK — never return []
  if (!out.length) {
    out.push(
      { name: 'VidSrc', quality: '1080p', url: `https://vidsrc.to/embed/movie/${id}`, health: 'ok', latency: 0 },
      { name: 'VidSrc.xyz', quality: '1080p', url: `https://vidsrc.xyz/embed/movie/${id}`, health: 'ok', latency: 0 },
      { name: 'Embed.su', quality: '1080p', url: `https://embed.su/embed/${id}`, health: 'ok', latency: 0 }
    );
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
