const axios = require('axios');
const crypto = require('crypto');
const { URL } = require('url');

// Default Spotify constants
const DEFAULT_SP_DC = "AQAO1j7bPbFcbVh5TbQmwmTd_XFckJhbOipaA0t2BZpViASzI6Qrk1Ty0WviN1K1mmJv_hV7xGVbMPHm4-HAZbs3OXOHSu38Xq7hZ9wqWwvdZwjiWTQmKWLoKxJP1j3kI7-8eWgVZ8TcPxRnXrjP3uDJ9SnzOla_EpxePC74dHa5D4nBWWfFLdiV9bMQuzUex6izb12gCh0tvTt3Xlg";

const TOKEN_URL = 'https://open.spotify.com/api/token';
const SERVER_TIME_URL = 'https://open.spotify.com/api/server-time';
const CLIENT_VERSION = '1.2.46.25.g7f189073';

const HEADERS = {
  'accept': 'application/json',
  'content-type': 'application/json',
  'origin': 'https://open.spotify.com/',
  'referer': 'https://open.spotify.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'spotify-app-version': CLIENT_VERSION,
  'app-platform': 'WebPlayer'
};

// Helper: fetch TOTP secret
async function getSecretVersion() {
  const res = await axios.get('https://raw.githubusercontent.com/Thereallo1026/spotify-secrets/refs/heads/main/secrets/secrets.json');
  const data = res.data[res.data.length - 1];
  const asciiCodes = [...data.secret].map(c => c.charCodeAt(0));
  const transformed = asciiCodes.map((val, i) => val ^ ((i % 33) + 9));
  const secretKey = Buffer.from(transformed.join(''));
  return { secret: secretKey, version: data.version };
}

// Helper: generate TOTP
function generateTOTP(secret, version, timestamp) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = (binary % 10 ** 6).toString().padStart(6, '0');
  return otp;
}

// Fetch access token
async function getSpotifyAccessToken() {
  const { secret, version } = await getSecretVersion();
  const serverTimeRes = await axios.get(SERVER_TIME_URL);
  const serverTime = serverTimeRes.data.serverTime * 1e3;
  const totp = generateTOTP(secret, version, serverTime);
  const params = {
    reason: 'init',
    productType: 'web-player',
    totp,
    totpVer: version,
    ts: serverTime
  };
  const tokenRes = await axios.get(TOKEN_URL, { params });
  return tokenRes.data.accessToken;
}

// Extract track ID from URL or ID
function extractTrackId(input) {
  if (!input) throw new Error('No track ID or URL provided');
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input;
  try {
    const parsed = new URL(input);
    const parts = parsed.pathname.split('/');
    if (parts[1] === 'track') return parts[2];
  } catch {}
  throw new Error('Invalid Spotify track URL or ID');
}

// Fetch track metadata
async function getTrackDetails(trackId, token) {
  const res = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
}

// Fetch lyrics JSON
async function getLyrics(trackId, token, sp_dc = DEFAULT_SP_DC) {
  const cookies = `sp_dc=${sp_dc}`;
  const res = await axios.get(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from_token`, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}`, Cookie: cookies }
  });
  return res.data;
}

// Format lyrics (plain/synced)
function formatLyrics(data, type = 'plain') {
  if (!data || !data.lyrics || !data.lyrics.lines) return 'No lyrics available';
  const lines = data.lyrics.lines;
  if (type === 'synchronized') {
    return lines.map(line => `[${line.time}] ${line.words}`).join('\n');
  } else {
    return lines.map(line => line.words).join('\n');
  }
}

// Serverless handler for Vercel
module.exports = async (req, res) => {
  try {
    const trackInput = req.query.id || req.query.url || req.query.track;
    const format = req.query.format || 'plain';

    if (!trackInput) {
      return res.status(400).json({ error: 'Missing track id or url' });
    }

    const accessToken = await getSpotifyAccessToken();
    const trackId = extractTrackId(trackInput);

    const [track, lyricsData] = await Promise.all([
      getTrackDetails(trackId, accessToken),
      getLyrics(trackId, accessToken)
    ]);

    const response = {
      track: {
        id: track.id,
        name: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        album: track.album.name,
        releaseDate: track.album.release_date,
        spotifyUrl: track.external_urls.spotify
      },
      lyrics: formatLyrics(lyricsData, format),
      developerCredit: 'https://t.me/Teleservices_Api'
    };

    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
