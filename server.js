require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const compression = require('compression');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_API_KEY || '';

// ─── MIDDLEWARE ─────────────────────────────────────────────
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── TMDB CLIENT ───────────────────────────────────────────
const tmdb = axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    params: { api_key: TMDB_KEY },
    timeout: 15000,
});

// ─── SCRAPER CLIENT ────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const scraper = axios.create({
    headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
    },
    timeout: 15000,
    maxRedirects: 5,
});

// ─── SQLITE CACHE ──────────────────────────────────────────
const db = new Database(path.join(__dirname, 'cache.db'));
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const getCache = db.prepare('SELECT data FROM cache WHERE key = ? AND cached_at > datetime("now", "-3 hours")');
const setCache = db.prepare('INSERT OR REPLACE INTO cache (key, data, cached_at) VALUES (?, ?, CURRENT_TIMESTAMP)');

async function cached(key, fetchFn) {
    const row = getCache.get(key);
    if (row) return JSON.parse(row.data);
    const data = await fetchFn();
    setCache.run(key, JSON.stringify(data));
    return data;
}

setInterval(() => {
    db.exec(`DELETE FROM cache WHERE cached_at < datetime('now', '-12 hours')`);
}, 3600000);

// ─── STREAM EMBED SOURCES ──────────────────────────────────
const STREAM_SOURCES = {
    movie: [
        { name: 'VidSrc.xyz',  url: (id) => `https://vidsrc.xyz/embed/movie?tmdb=${id}` },
        { name: 'VidSrc.to',   url: (id) => `https://vidsrc.to/embed/movie/${id}` },
        { name: '2Embed',      url: (id) => `https://www.2embed.cc/embed/tmdb/movie?id=${id}` },
        { name: 'SuperEmbed',  url: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1` },
        { name: 'AutoEmbed',   url: (id) => `https://autoembed.cc/movie/${id}` },
    ],
    tv: [
        { name: 'VidSrc.xyz',  url: (id, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
        { name: 'VidSrc.to',   url: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
        { name: '2Embed',      url: (id, s, e) => `https://www.2embed.cc/embed/tmdb/tv?id=${id}&s=${s}&e=${e}` },
        { name: 'SuperEmbed',  url: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
    ],
};

// ─── ADULT SCRAPERS ────────────────────────────────────────

async function scrapeEPornerMovies(query = '', page = 1) {
    try {
        const url = query
            ? `https://www.eporner.com/search/${encodeURIComponent(query)}/${page}/`
            : `https://www.eporner.com/cat/${page}/`;
        const { data } = await scraper.get(url);
        const $ = cheerio.load(data);
        const videos = [];

        $('div.mb, div.videopage, div[id^="v"]').each((i, el) => {
            const linkEl = $(el).find('a[href*="/video"]').first();
            const href = linkEl.attr('href') || '';
            const title = linkEl.attr('title') || $(el).find('h2, .title').first().text().trim();
            const imgEl = $(el).find('img').first();
            const thumbnail = imgEl.attr('data-src') || imgEl.attr('src') || '';
            const duration = $(el).find('.duration, .tim, span.duration').text().trim();

            if (title && href && href.includes('/video')) {
                const vidMatch = href.match(/video-([\w-]+)/);
                const videoId = vidMatch ? vidMatch[1] : href.split('/').filter(Boolean).pop();
                videos.push({
                    id: `ep-${videoId}`,
                    source: 'eporner',
                    title: title.replace(/\s+/g, ' ').substring(0, 150),
                    thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
                    url: href.startsWith('http') ? href : `https://www.eporner.com${href}`,
                    embedUrl: `https://www.eporner.com/embed/${videoId}/`,
                    duration: duration,
                });
            }
        });
        return videos;
    } catch (err) {
        console.error('[EPorner]', err.message);
        return [];
    }
}

async function scrapeSpankBangMovies(query = '', page = 1) {
    try {
        const url = query
            ? `https://spankbang.com/s/${encodeURIComponent(query)}/${page}/`
            : `https://spankbang.com/trending_videos/${page}/`;
        const { data } = await scraper.get(url);
        const $ = cheerio.load(data);
        const videos = [];

        $('div.video-item, article, li[class*="video"], div.i').each((i, el) => {
            const linkEl = $(el).find('a').first();
            const href = linkEl.attr('href') || '';
            const title = $(el).find('h2, .n, .title, a').first().text().trim() || linkEl.attr('title') || '';
            const imgEl = $(el).find('img').first();
            const thumbnail = imgEl.attr('data-src') || imgEl.attr('src') || '';
            const duration = $(el).find('.l, .duration, span.duration').text().trim();

            if (title && href && href.match(/^\/[a-z0-9]+/)) {
                const idMatch = href.match(/^\/([a-z0-9]+)\//);
                const videoId = idMatch ? idMatch[1] : '';
                if (videoId && videoId.length > 3) {
                    videos.push({
                        id: `sb-${videoId}`,
                        source: 'spankbang',
                        title: title.replace(/\s+/g, ' ').substring(0, 150),
                        thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
                        url: `https://spankbang.com${href}`,
                        embedUrl: `https://spankbang.com/${videoId}/embed/`,
                        duration: duration,
                    });
                }
            }
        });
        return videos;
    } catch (err) {
        console.error('[SpankBang]', err.message);
        return [];
    }
}

async function scrapeXVideosMovies(query = '', page = 0) {
    try {
        const url = query
            ? `https://www.xvideos.com/?k=${encodeURIComponent(query)}&p=${page}`
            : `https://www.xvideos.com/new/${page}`;
        const { data } = await scraper.get(url);
        const $ = cheerio.load(data);
        const videos = [];

        $('div.thumb-under, div.thumb-block').each((i, el) => {
            const parent = $(el).closest('.thumb-block') || $(el).parent();
            const linkEl = parent.find('a[href*="/video"]').first();
            const href = linkEl.attr('href') || '';
            const idMatch = href.match(/\/video(\d+)\//);
            if (!idMatch) return;

            const videoId = idMatch[1];
            const title = linkEl.attr('title') || $(el).find('p a').text().trim();
            const imgEl = parent.find('img').first();
            const thumbnail = imgEl.attr('data-src') || imgEl.attr('src') || '';
            const duration = $(el).find('.duration').text().trim();

            if (title) {
                videos.push({
                    id: `xv-${videoId}`,
                    source: 'xvideos',
                    title: title.replace(/\s+/g, ' ').substring(0, 150),
                    thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
                    url: `https://www.xvideos.com${href}`,
                    embedUrl: `https://www.xvideos.com/embedframe/${videoId}`,
                    duration: duration,
                });
            }
        });
        return videos;
    } catch (err) {
        console.error('[XVideos]', err.message);
        return [];
    }
}

async function scrapeXNXXMovies(query = '', page = 1) {
    try {
        const url = query
            ? `https://www.xnxx.com/search/${encodeURIComponent(query)}/${page}`
            : `https://www.xnxx.com/new/${page}`;
        const { data } = await scraper.get(url);
        const $ = cheerio.load(data);
        const videos = [];

        $('div.thumb-under, div.thumb-block').each((i, el) => {
            const parent = $(el).closest('.thumb-block') || $(el).parent();
            const linkEl = parent.find('a[href*="/video"]').first();
            const href = linkEl.attr('href') || '';
            const idMatch = href.match(/\/video(\d+)\//);
            if (!idMatch) return;

            const videoId = idMatch[1];
            const title = linkEl.attr('title') || linkEl.text().trim();
            const imgEl = parent.find('img').first();
            const thumbnail = imgEl.attr('data-src') || imgEl.attr('src') || '';
            const duration = $(el).find('.duration').text().trim();

            if (title) {
                videos.push({
                    id: `xn-${videoId}`,
                    source: 'xnxx',
                    title: title.replace(/\s+/g, ' ').substring(0, 150),
                    thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
                    url: `https://www.xnxx.com${href}`,
                    embedUrl: `https://www.xnxx.com/embedframe/${videoId}`,
                    duration: duration,
                });
            }
        });
        return videos;
    } catch (err) {
        console.error('[XNXX]', err.message);
        return [];
    }
}

async function scrapeRedTubeMovies(query = '', page = 1) {
    try {
        const url = query
            ? `https://www.redtube.com/search?query=${encodeURIComponent(query)}&page=${page}`
            : `https://www.redtube.com/?page=${page}`;
        const { data } = await scraper.get(url);
        const $ = cheerio.load(data);
        const videos = [];

        $('div.video_block_wrapper, li[class*="video"], div[class*="video_block"]').each((i, el) => {
            const linkEl = $(el).find('a').first();
            const href = linkEl.attr('href') || '';
            const idMatch = href.match(/\/(\d+)\/?/);
            if (!idMatch) return;

            const videoId = idMatch[1];
            const title = $(el).find('.video_title, h2, a[title]').first().text().trim() || linkEl.attr('title') || '';
            const imgEl = $(el).find('img').first();
            const thumbnail = imgEl.attr('data-src') || imgEl.attr('src') || '';
            const duration = $(el).find('.duration, span.duration').text().trim();

            if (title) {
                videos.push({
                    id: `rt-${videoId}`,
                    source: 'redtube',
                    title: title.replace(/\s+/g, ' ').substring(0, 150),
                    thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
                    url: href.startsWith('http') ? href : `https://www.redtube.com${href}`,
                    embedUrl: `https://embed.redtube.com/?id=${videoId}`,
                    duration: duration,
                });
            }
        });
        return videos;
    } catch (err) {
        console.error('[RedTube]', err.message);
        return [];
    }
}

async function searchAdultAll(query = '') {
    const results = await Promise.allSettled([
        scrapeXVideosMovies(query),
        scrapeXNXXMovies(query),
        scrapeEPornerMovies(query),
        scrapeSpankBangMovies(query),
        scrapeRedTubeMovies(query),
    ]);

    let all = [];
    results.forEach(r => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            all = all.concat(r.value);
        }
    });

    // Shuffle
    for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
    }

    return all;
}

// ─── TMDB API ROUTES ───────────────────────────────────────

app.get('/api/config', (req, res) => {
    res.json({ hasKey: !!TMDB_KEY });
});

app.get('/api/trending/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const page = req.query.page || 1;
        const data = await cached(`trending:${type}:${page}`, async () => {
            const r = await tmdb.get(`/trending/${type}/week`, { params: { page, include_adult: true } });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q, type = 'multi', page = 1 } = req.query;
        if (!q) return res.status(400).json({ error: 'Missing query (?q=)' });
        const data = await cached(`search:${type}:${q}:${page}`, async () => {
            const r = await tmdb.get(`/search/${type}`, { params: { query: q, page, include_adult: true } });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/movie/:id', async (req, res) => {
    try {
        const data = await cached(`movie:${req.params.id}`, async () => {
            const r = await tmdb.get(`/movie/${req.params.id}`, {
                params: { append_to_response: 'credits,similar,videos,watch/providers' },
            });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/movie/:id/streams', (req, res) => {
    const sources = STREAM_SOURCES.movie.map((s) => ({ name: s.name, url: s.url(req.params.id) }));
    res.json({ sources });
});

app.get('/api/tv/:id', async (req, res) => {
    try {
        const data = await cached(`tv:${req.params.id}`, async () => {
            const r = await tmdb.get(`/tv/${req.params.id}`, {
                params: { append_to_response: 'credits,similar,videos,watch/providers' },
            });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tv/:id/season/:season', async (req, res) => {
    try {
        const { id, season } = req.params;
        const data = await cached(`tv:${id}:s${season}`, async () => {
            const r = await tmdb.get(`/tv/${id}/season/${season}`);
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tv/:id/:season/:episode/streams', (req, res) => {
    const { id, season, episode } = req.params;
    const sources = STREAM_SOURCES.tv.map((s) => ({ name: s.name, url: s.url(id, season, episode) }));
    res.json({ sources });
});

app.get('/api/genres/:type', async (req, res) => {
    try {
        const type = req.params.type === 'tv' ? 'tv' : 'movie';
        const data = await cached(`genres:${type}`, async () => {
            const r = await tmdb.get(`/genre/${type}/list`);
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/discover/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { genre, page = 1, sort_by = 'popularity.desc' } = req.query;
        const data = await cached(`discover:${type}:${genre}:${page}:${sort_by}`, async () => {
            const params = { page, sort_by, include_adult: true };
            if (genre) params.with_genres = genre;
            const r = await tmdb.get(`/discover/${type}`, { params });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/now-playing', async (req, res) => {
    try {
        const data = await cached('now-playing', async () => {
            const r = await tmdb.get('/movie/now_playing', { params: { include_adult: true } });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/top-rated/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const page = req.query.page || 1;
        const data = await cached(`top-rated:${type}:${page}`, async () => {
            const r = await tmdb.get(`/${type}/top_rated`, { params: { page, include_adult: true } });
            return r.data;
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── ADULT API ROUTES ──────────────────────────────────────

app.get('/api/adult/search', async (req, res) => {
    try {
        const { q = '', page = 1 } = req.query;
        const cacheKey = `adult:search:${q}:${page}`;
        const row = getCache.get(cacheKey);
        if (row) return res.json({ videos: JSON.parse(row.data), cached: true });

        const videos = await searchAdultAll(q);
        setCache.run(cacheKey, JSON.stringify(videos));
        res.json({ videos, cached: false });
    } catch (err) {
        console.error('[Adult Search]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/adult/trending', async (req, res) => {
    try {
        const cacheKey = 'adult:trending';
        const row = getCache.get(cacheKey);
        if (row) return res.json({ videos: JSON.parse(row.data), cached: true });

        const videos = await searchAdultAll('');
        setCache.run(cacheKey, JSON.stringify(videos));
        res.json({ videos, cached: false });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/adult/source/:source', async (req, res) => {
    try {
        const { source } = req.params;
        const { q = '', page = 1 } = req.query;
        const cacheKey = `adult:${source}:${q}:${page}`;
        const row = getCache.get(cacheKey);
        if (row) return res.json({ videos: JSON.parse(row.data), cached: true });

        let videos = [];
        switch (source) {
            case 'xvideos': videos = await scrapeXVideosMovies(q, parseInt(page) - 1); break;
            case 'xnxx': videos = await scrapeXNXXMovies(q, page); break;
            case 'eporner': videos = await scrapeEPornerMovies(q, page); break;
            case 'spankbang': videos = await scrapeSpankBangMovies(q, page); break;
            case 'redtube': videos = await scrapeRedTubeMovies(q, page); break;
            default: videos = await searchAdultAll(q); break;
        }

        setCache.run(cacheKey, JSON.stringify(videos));
        res.json({ videos, cached: false });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🎬 MovieBox running at http://localhost:${PORT}\n`);
    if (!TMDB_KEY) {
        console.log('⚠️  No TMDB API key! Add TMDB_API_KEY to .env');
        console.log('   Free key: https://www.themoviedb.org/settings/api\n');
    } else {
        console.log('✅ TMDB API key loaded\n');
    }
    console.log('🔞 Adult scrapers loaded: XVideos, XNXX, EPorner, SpankBang, RedTube\n');
});
