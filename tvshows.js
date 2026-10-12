const axios = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB = 'https://api.themoviedb.org/3';

async function tmdb(url, params = {}) {
  const { data } = await axios.get(TMDB + url, {
    params: { api_key: TMDB_KEY, language: 'en-US', ...params }
  });
  return data;
}

function toCard(item) {
  return {
    id: item.id,
    type: 'tv',
    title: item.name || 'Unknown',
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
    year: (item.first_air_date || '').slice(0, 4),
    rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
    overview: item.overview || ''
  };
}

async function getTrending() {
  const data = await tmdb('/trending/tv/week');
  return data.results.map(toCard);
}

async function getDetails(id) {
  const t = await tmdb(`/tv/${id}`, { append_to_response: 'credits,videos,similar' });
  return {
    id: t.id,
    type: 'tv',
    title: t.name,
    poster: t.poster_path ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null,
    backdrop: t.backdrop_path ? `https://image.tmdb.org/t/p/w780${t.backdrop_path}` : null,
    year: (t.first_air_date || '').slice(0, 4),
    rating: Math.round((t.vote_average || 0) * 10) / 10,
    genres: (t.genres || []).map(g => g.name),
    overview: t.overview,
    seasons: (t.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ season: s.season_number, name: s.name, episodes: s.episode_count, poster: s.poster_path ? `https://image.tmdb.org/t/p/w300${s.poster_path}` : null })),
    cast: (t.credits && t.credits.cast ? t.credits.cast : []).slice(0, 12).map(c => ({
      name: c.name, character: c.character,
      photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
    })),
    trailer: (t.videos && t.videos.results ? t.videos.results : [])
      .filter(v => v.site === 'YouTube' && v.type === 'Trailer')[0]?.key || null,
    similar: (t.similar && t.similar.results ? t.similar.results : []).slice(0, 12).map(toCard)
  };
}

async function getEpisodeStream(id, season, episode) {
  const ep = await tmdb(`/tv/${id}/season/${season}/episode/${episode}`);
  const sources = [
    { provider: 'VidSrc', quality: 'HD', url: `https://vidsrc.xyz/embed/tv/${id}/${season}/${episode}` },
    { provider: 'VidSrc CC', quality: 'HD', url: `https://vidsrc.cc/v2/embed/tv/${id}/${season}/${episode}` },
    { provider: '2Embed', quality: 'HD', url: `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}` },
    { provider: 'SuperEmbed', quality: 'HD', url: `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}` },
    { provider: 'EmbedSu', quality: 'HD', url: `https://embed.su/embed/tv/${id}/${season}/${episode}` }
  ];
  return {
    id: Number(id), season: Number(season), episode: Number(episode),
    title: ep.name, overview: ep.overview,
    still: ep.still_path ? `https://image.tmdb.org/t/p/w780${ep.still_path}` : null,
    sources
  };
}

module.exports = { getTrending, getDetails, getEpisodeStream };
