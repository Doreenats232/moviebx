const axios = require('axios');
const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

function qualityOf(name) {
  const n = String(name).toLowerCase();
  if (/(2160|uhd|4k|remux)/.test(n)) return '4K';
  if (/(1080p|bluray|bdrip|webrip|web-dl|webdl)/.test(n)) return '1080p';
  if (/(720p)/.test(n)) return '720p';
  if (/(480p|360p|hdcam|camrip|cam)/.test(n)) return 'CAM';
  return 'HD';
}

class RealDebrid {
  constructor(token) {
    this.token = String(token || '').trim();
    this.enabled = this.token.length > 10;
    this.client = axios.create({
      baseURL: RD_BASE,
      headers: { Authorization: `Bearer ${this.token}` },
      timeout: 20000
    });
  }

  async check() {
    if (!this.enabled) return { enabled: false, error: 'No Real-Debrid token configured' };
    try {
      const { data } = await this.client.get('/user');
      return {
        enabled: true,
        username: data.username,
        plan: data.type,
        expires: data.expiration,
        fidelity: data.fidelity || 0,
        points: data.points || 0
      };
    } catch (e) {
      return { enabled: false, error: (e.response && e.response.data && e.response.data.error) || e.message };
    }
  }

  async addMagnet(magnet) {
    const body = new URLSearchParams({ magnet });
    const { data } = await this.client.post('/torrents/addMagnet', body);
    return data.id;
  }

  async info(id) {
    const { data } = await this.client.get(`/torrents/info/${id}`);
    return data;
  }

  async selectFiles(id, ids = 'all') {
    const body = new URLSearchParams({ files: ids });
    await this.client.post(`/torrents/selectFiles/${id}`, body);
    return true;
  }

  async unrestrict(link) {
    const body = new URLSearchParams({ link });
    const { data } = await this.client.post('/unrestrict/link', body);
    return {
      url: data.download,
      filename: data.filename,
      filesize: data.filesize,
      host: data.host,
      quality: qualityOf(data.filename)
    };
  }

  async resolve(magnet, { pollMs = 3000, maxWait = 120000 } = {}) {
    if (!this.enabled) throw new Error('Real-Debrid not configured. Add a key in Settings or set RD_API_KEY.');
    if (!magnet) throw new Error('No magnet provided');

    const id = await this.addMagnet(magnet);
    let info = await this.info(id);

    if (info.status === 'waiting_files_selection') {
      await this.selectFiles(id);
      info = await this.info(id);
    }

    const started = Date.now();
    while (!['downloaded', 'error', 'dead', 'virus'].includes(info.status)) {
      if (Date.now() - started > maxWait) {
        throw new Error(`Real-Debrid cache miss — torrent is still downloading (status: ${info.status}). Try a higher-seed source.`);
      }
      await new Promise(r => setTimeout(r, pollMs));
      info = await this.info(id);
    }

    if (info.status !== 'downloaded') throw new Error(`Real-Debrid status: ${info.status}`);

    const links = info.links || [];
    const unrestricted = await Promise.all(links.map(l => this.unrestrict(l).catch(() => null)));

    return {
      torrent_id: id,
      filename: info.filename,
      bytes: info.bytes,
      files: (info.files || []).map(f => ({
        name: String(f.path || '').replace(/^\//, ''),
        size: f.bytes,
        selected: f.selected === 1
      })),
      streams: unrestricted
        .filter(Boolean)
        .map(u => ({
          name: `Real-Debrid · ${u.quality} · ${u.host}`,
          quality: u.quality,
          url: u.url,
          filename: u.filename,
          filesize: u.filesize
        }))
        .sort((a, b) => {
          const rank = { '4K': 0, '1080p': 1, '720p': 2, 'HD': 3, 'CAM': 4 };
          return (rank[a.quality] ?? 9) - (rank[b.quality] ?? 9);
        })
    };
  }

  async deleteTorrent(id) {
    await this.client.delete(`/torrents/delete/${id}`).catch(() => {});
    return true;
  }
}

module.exports = RealDebrid;
module.exports.qualityOf = qualityOf;
