const axios = require('axios');
const cheerio = require('cheerio');

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB = 'https://api.themoviedb.org/3';

async function tmdb(url, params = {}) {
  const { data } = await axios.get(TMDB + url, {
    params: { api_key: TMDB_KEY, language: 'en-US', ...params }
  });
  return data;
}

function toCard(item, type = 'movie') {
  return {
    id: item.id,
    type,
    title: item.title || item.name || 'Unknown',
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
    overview: item.overview || ''
  };
}

async function getTrending() {
  const data = await tmdb('/trending/movie/week');
  return data.results.map(r => toCard(r, 'movie'));
}

async function search(q) {
  const data = await tmdb('/search/movie', { query: q, include_adult: true });
  return data.results.map(r => toCard(r, 'movie'));
}

async function getDetails(id) {
  const m = await tmdb(`/movie/${id}`, { append_to_response: 'credits,videos,similar' });
  return {
    id: m.id,
    type: 'movie',
    title: m.title,
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : null,
    year: (m.release_date || '').slice(0, 4),
    rating: Math.round((m.vote_average || 0) * 10) / 10,
    runtime: m.runtime,
    genres: (m.genres || []).map(g => g.name),
    overview: m.overview,
    cast: (m.credits && m.credits.cast ? m.credits.cast : []).slice(0, 12).map(c => ({
      name: c.name, character: c.character,
      photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
    })),
    trailer: (m.videos && m.videos.results ? m.videos.results : [])
      .filter(v => v.site === 'YouTube' && v.type === 'Trailer')[0]?.key || null,
    similar: (m.similar && m.similar.results ? m.similar.results : []).slice(0, 12).map(s => toCard(s, 'movie'))
  };
}

async function getByGenre(name, page = 1) {
  const g = await tmdb('/genre/movie/list');
  const found = (g.genres || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!found) return [];
  const data = await tmdb('/discover/movie', {
    with_genres: found.id, page, include_adult: true, sort_by: 'popularity.desc'
  });
  return data.results.map(r => toCard(r, 'movie'));
}

async function getStreamSources(id) {
  const m = await tmdb(`/movie/${id}`);
  const sources = [];
  const slug = (m.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  sources.push({ provider: 'VidSrc', quality: 'HD', url: `https://vidsrc.xyz/embed/movie/${id}` });
  sources.push({ provider: 'VidSrc CC', quality: 'HD', url: `https://vidsrc.cc/v2/embed/movie/${id}` });
  sources.push({ provider: '2Embed', quality: 'HD', url: `https://www.2embed.cc/embed/${id}` });
  sources.push({ provider: 'SuperEmbed', quality: 'HD', url: `https://multiembed.mov/?video_id=${id}&tmdb=1` });
  sources.push({ provider: 'EmbedSu', quality: 'HD', url: `https://embed.su/embed/movie/${id}` });

  return { id, title: m.title, slug, sources };
}

module.exports = { getTrending, search, getDetails, getByGenre, getStreamSources };
