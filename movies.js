const axios = require('axios');
const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';

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

async function getStreamSources(id) {
  return [
    { name: 'VidSrc',     quality: 'HD',  url: `https://vidsrc.to/embed/movie/${id}` },
    { name: 'VidSrc XYZ', quality: 'HD',  url: `https://vidsrc.xyz/embed/movie/${id}` },
    { name: '2Embed',     quality: 'HD',  url: `https://www.2embed.cc/embedtmdb/${id}` },
    { name: 'MoviesAPI',  quality: 'CAM', url: `https://moviesapi.club/${id}` },
    { name: 'MultiEmbed', quality: 'HD',  url: `https://multiembed.mov/?video_id=${id}&tmdb=1` }
  ];
}

module.exports = { getTrending, search, getByGenre, getDetails, getTrailer, getStreamSources };
