const axios = require('axios');
const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';

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

async function getEpisodeStream(id, season, episode) {
  const s = await tmdb(`/tv/${id}/season/${season}`).catch(() => ({ episodes: [] }));
  const eps = s.episodes || [];
  const cur = eps.find(e => String(e.episode_number) === String(episode));
  const maxEp = eps.length ? Math.max(...eps.map(e => e.episode_number)) : 0;
  let next = null;
  if (Number(episode) < maxEp) {
    next = { season: Number(season), episode: Number(episode) + 1 };
  } else {
    next = { season: Number(season) + 1, episode: 1 };
  }
  return {
    title: cur ? cur.name : `Season ${season} Episode ${episode}`,
    thumb: cur ? img(cur.still_path, 'w780') : null,
    air_date: cur ? cur.air_date : null,
    next,
    sources: [
      { name: 'VidSrc',     quality: 'HD', url: `https://vidsrc.to/embed/tv/${id}/${season}/${episode}` },
      { name: 'VidSrc XYZ', quality: 'HD', url: `https://vidsrc.xyz/embed/tv/${id}/${season}/${episode}` },
      { name: '2Embed',     quality: 'HD', url: `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}` },
      { name: 'MultiEmbed', quality: 'HD', url: `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}` }
    ]
  };
}

module.exports = { getTrending, search, getDetails, getSeason, getEpisodeStream };
