require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paywall = require('./paywall');

// Optional: on-video captions (npm i @napi-rs/canvas)
let canvasLib = null;
try {
  canvasLib = require('@napi-rs/canvas');
} catch {
  /* captions disabled until the package is installed */
}

// ---------- Health server (Render web services must bind a port) ----------
const http = require('http');
const PORT = process.env.PORT || 3000;
const healthServer = http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Video downloader bot is running');
  })
  .listen(PORT, '0.0.0.0', () => console.log('Health server listening on port ' + PORT));

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
let COOKIES = process.env.YTDLP_COOKIES || ''; // optional cookies.txt path (Render Secret Files are read-only)
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50); // 50 = standard Bot API limit
const MAX_DURATION_MIN = Number(process.env.MAX_DURATION_MIN || 60);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const TMP_DIR = path.join(__dirname, 'tmp');
const DATABASE_URL = process.env.DATABASE_URL || '';

// Free-tier feature limits (admins and premium users are exempt)
const FREE_CLIP_LIMIT = Number(process.env.FREE_CLIP_LIMIT || 1); // free clip jobs
const FREE_CAPTION_LIMIT = Number(process.env.FREE_CAPTION_LIMIT || 1); // free "Set text" caption uses
const FREE_FEATURE_WINDOW = (process.env.FREE_FEATURE_WINDOW || 'lifetime').toLowerCase(); // 'lifetime' | 'daily'
const FREE_WINDOW_TEXT = FREE_FEATURE_WINDOW === 'daily' ? 'per day' : 'in total';

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// ffmpeg lookup order: env var -> `ffmpeg-static` / `ffprobe-static` npm packages (if installed) -> system PATH
function resolveBin(envVal, pkg, fallback) {
  if (envVal) return envVal;
  try {
    const p = require(pkg);
    return typeof p === 'string' ? p : p.path || fallback;
  } catch {
    return fallback;
  }
}
const FFMPEG = resolveBin(process.env.FFMPEG_PATH, 'ffmpeg-static', 'ffmpeg');
const FFPROBE = resolveBin(process.env.FFPROBE_PATH, 'ffprobe-static', 'ffprobe');

// Clip feature
const CLIP_COUNT = Number(process.env.CLIP_COUNT || 5); // max clips per job
const CLIP_SOURCE_HEIGHT = Number(process.env.CLIP_SOURCE_HEIGHT || 720); // resolution of the working copy
const CLIP_SOURCE_MAX_MB = Number(process.env.CLIP_SOURCE_MAX_MB || 400); // max size of the working copy
const CLIP_LENGTHS = [20, 30, 60]; // seconds offered in the menu
const CLIP_MIN_VIDEO_SEC = 90; // only offer clipping for videos longer than this

// Caption feature
const CAPTION_MAX_CHARS = 120;
const POS_LABEL = { top: '⬆️ Top', mid: '⏺ Middle', bot: '⬇️ Bottom' };

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}
fs.mkdirSync(TMP_DIR, { recursive: true });

// yt-dlp rewrites its cookie file on exit, which fails on read-only paths like /etc/secrets.
// Work on a writable copy instead.
if (COOKIES) {
  try {
    const writable = path.join(TMP_DIR, 'yt-cookies.txt');
    // Normalise: strip BOM/leading blank lines (a common paste problem) and use LF newlines
    const raw = fs.readFileSync(COOKIES, 'utf8');
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
    const first = text.split('\n')[0].trim();
    const cookieLines = text.split('\n').filter((l) => l.split('\t').length >= 7).length // includes #HttpOnly_ lines;
    if (!/^# (Netscape )?HTTP Cookie File/.test(first) || cookieLines === 0) {
      // A malformed file would make yt-dlp fail on every link (TikTok too), so ignore it
      console.error(
        `Cookies file unusable: ${raw.length} bytes, first line "${first.slice(0, 40)}", ${cookieLines} cookie lines (needs "# Netscape HTTP Cookie File" header and tab-separated cookie lines). Ignoring it.`
      );
      COOKIES = '';
    } else {
      fs.writeFileSync(writable, text.endsWith('\n') ? text : text + '\n');
      COOKIES = writable;
      console.log(`YouTube cookies loaded (${cookieLines} cookie lines).`);
    }
  } catch (e) {
    console.error('Could not read YTDLP_COOKIES file (' + COOKIES + '):', e.message);
    try {
      const dir = path.dirname(COOKIES);
      console.error('Files in ' + dir + ': ' + (fs.readdirSync(dir).join(', ') || '(empty)'));
    } catch {
      console.error('Directory ' + path.dirname(COOKIES) + ' does not exist: no Secret File has been created on this service.');
    }
    COOKIES = '';
  }
} else {
  console.warn('⚠️  YTDLP_COOKIES not set: YouTube will likely block this server ("Sign in to confirm you\'re not a bot").');
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30 * 60 * 1000 });

// ---------- Activity logging (PostgreSQL) ----------
let pool = null;
const dbReady = () => Boolean(pool);

async function initDb() {
  if (!DATABASE_URL) {
    console.warn('DATABASE_URL not set: activity logging is disabled.');
    return;
  }
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    console.warn('"pg" is not installed: run `npm i pg` to enable activity logging.');
    return;
  }
  const p = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  p.on('error', (e) => console.error('DB pool error:', e.message));
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS dl_users (
        user_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        language_code TEXT,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        event_count INTEGER NOT NULL DEFAULT 0
      )`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS dl_activity_log (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_id BIGINT,
        chat_id BIGINT,
        event TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        url TEXT,
        title TEXT,
        choice TEXT,
        duration_ms INTEGER,
        error TEXT,
        details JSONB
      )`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS dl_feature_usage (
        user_id BIGINT NOT NULL,
        feature TEXT NOT NULL,
        period TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, feature, period)
      )`);
    await p.query('CREATE INDEX IF NOT EXISTS dl_activity_user_idx ON dl_activity_log (user_id, created_at DESC)');
    await p.query('CREATE INDEX IF NOT EXISTS dl_activity_event_idx ON dl_activity_log (event, created_at DESC)');
  } catch (e) {
    p.end().catch(() => {});
    throw e;
  }
  pool = p;
  console.log('Activity logging enabled (PostgreSQL).');
}

// Fire-and-forget: logging must never break or slow down the bot
function logEvent(from, event, data = {}) {
  if (!pool) return;
  const { chatId, url, title, choice, status = 'ok', error, durationMs, details } = data;
  (async () => {
    if (from && from.id) {
      await pool.query(
        `INSERT INTO dl_users (user_id, username, first_name, language_code, event_count)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (user_id) DO UPDATE SET
           username = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           language_code = EXCLUDED.language_code,
           last_seen = now(),
           event_count = dl_users.event_count + 1`,
        [from.id, from.username || null, from.first_name || null, from.language_code || null]
      );
    }
    await pool.query(
      `INSERT INTO dl_activity_log (user_id, chat_id, event, status, url, title, choice, duration_ms, error, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        from ? from.id : null,
        chatId || null,
        event,
        status,
        url ? String(url).slice(0, 500) : null,
        title ? String(title).slice(0, 300) : null,
        choice ? String(choice).slice(0, 30) : null,
        durationMs != null ? Math.round(durationMs) : null,
        error ? String(error).slice(0, 500) : null,
        details ? JSON.stringify(details) : null,
      ]
    );
  })().catch((e) => console.error('Log error:', e.message));
}

async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM dl_users) AS users,
      (SELECT count(*) FROM dl_users WHERE last_seen > now() - interval '24 hours') AS active_24h,
      count(*) FILTER (WHERE event = 'link_info') AS links,
      count(*) FILTER (WHERE event = 'download_done') AS downloads,
      count(*) FILTER (WHERE event = 'clips_done') AS clip_jobs,
      count(*) FILTER (WHERE status = 'error') AS errors,
      count(*) FILTER (WHERE event = 'download_done' AND created_at > now() - interval '24 hours') AS downloads_24h,
      count(*) FILTER (WHERE event = 'clips_done' AND created_at > now() - interval '24 hours') AS clips_24h,
      count(*) FILTER (WHERE status = 'error' AND created_at > now() - interval '24 hours') AS errors_24h
    FROM dl_activity_log`);
  const recent = await pool.query(`
    SELECT to_char(created_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS t, user_id, event, status,
           left(coalesce(title, url, ''), 28) AS what
    FROM dl_activity_log ORDER BY id DESC LIMIT 8`);
  return { s: rows[0], recent: recent.rows };
}

// ---------- Free-tier feature limits (clips, captions) ----------
const isAdmin = (id) => ADMIN_IDS.includes(id);
const memFeatureUsage = new Map(); // fallback when PostgreSQL is not available (resets on restart)
let premiumDetectWarned = false;

const featurePeriod = () => (FREE_FEATURE_WINDOW === 'daily' ? new Date().toISOString().slice(0, 10) : 'all');

// Admins always pass, so they never hit the paywall's daily limit either
async function getAccess(userId) {
  if (isAdmin(userId)) return { allowed: true, admin: true };
  return paywall.checkAccess(userId);
}

// Works with several common shapes of paywall module; adjust here if yours differs
async function isPremiumUser(userId, access) {
  for (const fn of ['isPremium', 'isSubscribed', 'hasPremium', 'hasActiveSubscription']) {
    if (typeof paywall[fn] === 'function') {
      try {
        return Boolean(await paywall[fn](userId));
      } catch (e) {
        console.error('Premium check error:', e.message);
      }
    }
  }
  if (access && typeof access === 'object') {
    for (const k of ['premium', 'isPremium', 'subscribed', 'isSubscribed', 'unlimited', 'paid']) {
      if (k in access) return Boolean(access[k]);
    }
    if (typeof access.plan === 'string') return access.plan.toLowerCase() !== 'free';
  }
  if (!premiumDetectWarned) {
    premiumDetectWarned = true;
    console.warn('⚠️  Could not detect premium status from ./paywall; every non-admin user is treated as free for clips/captions.');
  }
  return false;
}

async function getFeatureUsed(userId, feature) {
  const period = featurePeriod();
  if (pool) {
    try {
      const r = await pool.query('SELECT used FROM dl_feature_usage WHERE user_id=$1 AND feature=$2 AND period=$3', [userId, feature, period]);
      return r.rows[0] ? Number(r.rows[0].used) : 0;
    } catch (e) {
      console.error('Feature usage read error:', e.message);
    }
  }
  return memFeatureUsage.get(`${userId}:${feature}:${period}`) || 0;
}

async function bumpFeatureUsed(userId, feature) {
  const period = featurePeriod();
  const key = `${userId}:${feature}:${period}`;
  memFeatureUsage.set(key, (memFeatureUsage.get(key) || 0) + 1);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO dl_feature_usage (user_id, feature, period, used) VALUES ($1,$2,$3,1)
       ON CONFLICT (user_id, feature, period) DO UPDATE SET used = dl_feature_usage.used + 1`,
      [userId, feature, period]
    );
  } catch (e) {
    console.error('Feature usage write error:', e.message);
  }
}

// -> { allowed, exempt, left, limit }. exempt = admin or premium (nothing is counted for them)
async function featureGate(userId, feature, limit, access) {
  if (isAdmin(userId)) return { allowed: true, exempt: true };
  if (await isPremiumUser(userId, access)) return { allowed: true, exempt: true };
  const used = await getFeatureUsed(userId, feature);
  const left = Math.max(0, limit - used);
  return { allowed: left > 0, exempt: false, left, limit };
}

const FEATURE_LABEL = { clip: ['clip job', 'clip jobs', '✂️'], caption: ['caption', 'captions', '📝'] };
function featureLimitText(feature, limit) {
  const [one, many, icon] = FEATURE_LABEL[feature];
  return (
    `🔒 <b>Free ${one} limit reached</b>\n\n` +
    `${icon} Free users get <b>${limit}</b> ${limit === 1 ? one : many} ${FREE_WINDOW_TEXT}. ` +
    'Upgrade to <b>Premium</b> to keep using it without limits.\n\n👇 Tap <b>Plans</b> to upgrade.'
  );
}
function featureLeftLine(feature, gate) {
  if (gate.exempt) return '';
  const [one, many] = FEATURE_LABEL[feature];
  return `🆓 Free ${many} left: <b>${gate.left}/${gate.limit}</b>\n`;
}

// Used by caption menu buttons. Returns true when the user was blocked.
async function denyCaptionIfLocked(ctx) {
  const access = await getAccess(ctx.from.id).catch(() => null);
  const gate = await featureGate(ctx.from.id, 'caption', FREE_CAPTION_LIMIT, access);
  if (gate.allowed) return false;
  logEvent(ctx.from, 'limit_reached', { chatId: ctx.chat.id, details: { action: 'caption' } });
  await ctx.answerCbQuery('Free caption limit reached.');
  await ctx.reply(featureLimitText('caption', FREE_CAPTION_LIMIT), { parse_mode: 'HTML', ...paywall.plansKeyboard() });
  return true;
}

// ---------- Menu labels ----------
const BTN_DOWNLOAD = '📥 How to download';
const BTN_CLIPS = '✂️ Make clips';
const BTN_PLANS = '💎 Plans';
const BTN_HELP = '❓ Help';
const BTN_ABOUT = 'ℹ️ About';
const MENU_LABELS = new Set([BTN_DOWNLOAD, BTN_CLIPS, BTN_PLANS, BTN_HELP, BTN_ABOUT]);

// Persistent keyboard under the input box (works on mobile and desktop apps)
const mainMenu = Markup.keyboard([[BTN_DOWNLOAD, BTN_CLIPS], [BTN_PLANS, BTN_HELP, BTN_ABOUT]])
  .resize()
  .placeholder('Paste a YouTube or TikTok link…');

// Log commands, menu taps and button taps (downloads/clips are logged with richer details below)
bot.use(async (ctx, next) => {
  try {
    const text = ctx.message && ctx.message.text;
    const chatId = ctx.chat && ctx.chat.id;
    if (text && ctx.from) {
      if (text.startsWith('/')) logEvent(ctx.from, 'command', { chatId, details: { text: text.slice(0, 100) } });
      else if (MENU_LABELS.has(text)) logEvent(ctx.from, 'menu', { chatId, details: { button: text } });
    } else if (ctx.callbackQuery && ctx.callbackQuery.data && ctx.from) {
      const d = ctx.callbackQuery.data;
      if (!/^(dl|cp):/.test(d)) logEvent(ctx.from, 'button', { chatId, details: { action: d.split(':')[0] } });
    }
  } catch {
    /* never block the update */
  }
  return next();
});

// ---------- Helpers ----------
const ALLOWED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com', // also covers vm.tiktok.com, vt.tiktok.com, www.tiktok.com
];

function extractUrl(text = '') {
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    const host = u.hostname.toLowerCase();
    const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

function baseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--no-progress'];
  if (COOKIES) args.push('--cookies', COOKIES);
  // YouTube needs an external JavaScript runtime; reuse the Node.js that runs this bot (set YTDLP_JS_RUNTIME=off to disable)
  if ((process.env.YTDLP_JS_RUNTIME || 'node').toLowerCase() !== 'off') {
    args.push('--js-runtimes', 'node:' + process.execPath);
  }
  // Optional: route yt-dlp through a (residential) proxy, e.g. http://user:pass@host:port
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  // Optional: raw extractor args, e.g. youtube:player_client=tv_simply,web_safari
  if (process.env.YTDLP_EXTRACTOR_ARGS) args.push('--extractor-args', process.env.YTDLP_EXTRACTOR_ARGS);
  if (FFMPEG !== 'ffmpeg') args.push('--ffmpeg-location', FFMPEG);
  return args;
}

function runBin(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 50 * 1024 * 1024, timeout: 15 * 60 * 1000, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve(stdout);
      }
    );
  });
}
const run = (args, opts) => runBin(YTDLP, args, opts);

let ffmpegReady = null;
async function hasFfmpeg() {
  if (ffmpegReady === true) return true;
  try {
    await runBin(FFMPEG, ['-version'], { timeout: 10000 });
    ffmpegReady = true;
  } catch {
    ffmpegReady = false;
  }
  return ffmpegReady;
}

async function getInfo(url) {
  const out = await run([...baseArgs(), '-J', url]);
  return JSON.parse(out);
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1);

const escHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Short single-line version of an error for the logs
const errText = (err) =>
  String((err && (err.stderr || err.message)) || err || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-2)
    .join(' ')
    .slice(0, 400);

// Truncate by characters (not UTF-16 units) so emojis are never cut in half
function clip(str, n) {
  const a = Array.from(str);
  return a.length > n ? a.slice(0, n).join('') + '…' : str;
}

function fmtDuration(sec) {
  if (sec === undefined || sec === null) return null;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtCount(n) {
  if (!n && n !== 0) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Pick a Telegram-friendly thumbnail (JPEG, <= 1280px wide when possible)
function pickThumbnail(info) {
  const thumbs = (info.thumbnails || []).filter((t) => t.url && /^https?:/i.test(t.url));
  const jpgs = thumbs.filter((t) => /\.jpe?g(\?|$)/i.test(t.url) || t.ext === 'jpg');
  const pool = jpgs.length ? jpgs : thumbs;
  const fit = pool.filter((t) => !t.width || t.width <= 1280);
  const list = (fit.length ? fit : pool).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  return (list[0] && list[0].url) || info.thumbnail || null;
}

// Build the list of selectable video heights with estimated sizes
function buildOptions(info) {
  const formats = info.formats || [];

  const audioSizes = formats
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .map((f) => f.filesize || f.filesize_approx || 0);
  const bestAudioSize = audioSizes.length ? Math.max(...audioSizes) : 0;

  const byHeight = new Map();
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none' || !f.height) continue;
    let size = f.filesize || f.filesize_approx || 0;
    if (size && (!f.acodec || f.acodec === 'none')) size += bestAudioSize;
    const prev = byHeight.get(f.height);
    if (!prev || size > prev.size) byHeight.set(f.height, { height: f.height, size });
  }

  const limit = MAX_UPLOAD_MB * 1024 * 1024;
  let hidden = 0;
  const videos = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .filter((v) => {
      if (v.size && v.size > limit) {
        hidden++;
        return false;
      }
      return true;
    })
    .slice(0, 6);

  return { videos, hidden, bestAudioSize };
}

function qualityIcon(h) {
  if (h >= 2160) return '🌟';
  if (h >= 1080) return '🔥';
  if (h >= 720) return '📺';
  return '🎬';
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------- On-video captions (text + emojis rendered to a transparent PNG, then overlaid by ffmpeg) ----------
// Text and emojis are drawn as separate runs, each with its own font, so colour emojis render reliably
// (Windows: Segoe UI Emoji, macOS: Apple Color Emoji, Linux: install fonts-noto-color-emoji).
const TEXT_FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

const segmenter =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

function isEmoji(g) {
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(g)) return false;
  return g.codePointAt(0) >= 0x231a || /\uFE0F/.test(g);
}

// "Hi 🔥!" -> [{t:'Hi ', e:false}, {t:'🔥', e:true}, {t:'!', e:false}]
function toRuns(str) {
  const runs = [];
  for (const g of graphemes(str)) {
    const e = isEmoji(g);
    if (runs.length && runs[runs.length - 1].e === e) runs[runs.length - 1].t += g;
    else runs.push({ t: g, e });
  }
  return runs;
}

function wrapCaption(text, maxW, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + w : w;
      if (width(test) <= maxW) {
        line = test;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (width(w) <= maxW) {
        line = w;
        continue;
      }
      let chunk = '';
      for (const g of graphemes(w)) {
        if (chunk && width(chunk + g) > maxW) {
          lines.push(chunk);
          chunk = g;
        } else chunk += g;
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines.slice(0, 6);
}

// Returns a PNG buffer of exactly W x H (transparent unless `bg` is given, which is used for previews)
function renderCaption({ text, pos }, W, H, bg) {
  if (!canvasLib) throw new Error('@napi-rs/canvas is not installed');
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }

  const size = Math.max(28, Math.min(96, Math.round(Math.min(W, H) * 0.075)));
  const setFont = (e) => (ctx.font = e ? `${size}px ${EMOJI_FONT}` : `bold ${size}px ${TEXT_FONT}`);
  const width = (str) => toRuns(str).reduce((w, r) => (setFont(r.e), w + ctx.measureText(r.t).width), 0);
  const padX = size * 0.5;
  const padY = size * 0.3;
  const lineH = size * 1.3;

  const lines = wrapCaption(text, W * 0.88 - padX * 2, width);
  const textW = Math.max(...lines.map(width));
  const boxW = Math.min(W * 0.94, textW + padX * 2);
  const boxH = lines.length * lineH + padY * 2;
  const margin = H > W ? H * 0.16 : H * 0.08; // keep clear of the app UI at the bottom
  const boxY = pos === 'top' ? H * (H > W ? 0.1 : 0.06) : pos === 'mid' ? (H - boxH) / 2 : H - boxH - margin;
  const boxX = (W - boxW) / 2;
  const r = size * 0.4;

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.moveTo(boxX + r, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
  ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    let x = (W - width(line)) / 2;
    const y = boxY + padY + lineH * (i + 0.5);
    for (const run of toRuns(line)) {
      setFont(run.e);
      ctx.fillText(run.t, x, y);
      x += ctx.measureText(run.t).width;
    }
  });
  return canvas.toBuffer('image/png');
}

// Video size via ffmpeg's own stream info (so ffprobe is not required)
async function probeSize(file) {
  let raw = '';
  try {
    raw = await runBin(FFMPEG, ['-hide_banner', '-i', file]);
  } catch (e) {
    raw = String(e.stderr || '');
  }
  const m = raw.match(/Stream #\d+:\d+.*?Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  if (!m) throw new Error('Could not read video size');
  return { w: Number(m[1]) - (Number(m[1]) % 2), h: Number(m[2]) - (Number(m[2]) % 2) };
}

// ---------- Highlight detection (for clips) ----------

// Per-second loudness (RMS dB) of the whole file, via ffmpeg
async function audioLevels(src, n) {
  const out = await runBin(FFMPEG, [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-i',
    src,
    '-vn',
    '-ac',
    '1',
    '-af',
    'aresample=16000,asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'null',
    '-',
  ]);
  const levels = [];
  const re = /RMS_level=(-?\d+(?:\.\d+)?|-?inf|nan)/gi;
  let m;
  while ((m = re.exec(out))) {
    const v = parseFloat(m[1]);
    levels.push(Number.isFinite(v) ? v : -90);
  }
  while (levels.length < n) levels.push(-90);
  return levels.slice(0, n);
}

// dB array -> 0..1 (ignores the quietest 10% and the loudest 2% so a single spike doesn't dominate)
function normalizeLevels(db) {
  const v = db.map((x) => Math.max(x, -60));
  const sorted = [...v].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))];
  const range = Math.max(hi - lo, 1);
  return v.map((x) => Math.min(1, Math.max(0, (x - lo) / range)));
}

// YouTube "Most replayed" heatmap -> one value per second (0..1)
function heatmapToSeconds(heatmap, n) {
  const arr = new Array(n).fill(0);
  for (const h of heatmap) {
    const s = Math.max(0, Math.floor(h.start_time));
    const e = Math.min(n, Math.ceil(h.end_time));
    for (let i = s; i < e; i++) arr[i] = Math.max(arr[i], h.value);
  }
  return arr;
}

// Pick the best non-overlapping windows of `len` seconds
function pickWindows(perSec, len, count) {
  const n = perSec.length;
  if (n < len) return [];
  const cum = [0];
  for (const v of perSec) cum.push(cum[cum.length - 1] + v);
  const cands = [];
  for (let s = 0; s + len <= n; s++) cands.push({ start: s, score: (cum[s + len] - cum[s]) / len });
  cands.sort((a, b) => b.score - a.score);

  const picked = [];
  const gap = len + 3; // small breathing room between clips
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.start - c.start) >= gap)) picked.push(c);
  }
  return picked; // ranked best -> worst
}

async function probeDuration(file) {
  const out = await runBin(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return parseFloat(out) || 0;
}

// Blurred-background 9:16 canvas (TikTok / Reels / Shorts)
const VERTICAL_BASE =
  '[0:v]split=2[a][b];' +
  '[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=25:3[bg];' +
  '[b]scale=720:-2[fg];' +
  '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]';

// capPng: optional full-frame transparent PNG (same size as the output) with the caption already drawn on it
function buildClipArgs(src, start, len, fmt, out, capPng) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', src];
  if (capPng) args.push('-i', capPng);
  args.push('-t', String(len));

  let fc = null;
  if (fmt === 'v') {
    fc = VERTICAL_BASE + (capPng ? ';[base][1:v]overlay=0:0,format=yuv420p[v]' : ';[base]format=yuv420p[v]');
  } else if (capPng) {
    fc = '[0:v][1:v]overlay=0:0,format=yuv420p[v]';
  }
  if (fc) args.push('-filter_complex', fc, '-map', '[v]', '-map', '0:a?');
  else args.push('-map', '0:v:0', '-map', '0:a?', '-pix_fmt', 'yuv420p');

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '24',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    out
  );
  return args;
}

const bar = (step, total = 4) => '▰'.repeat(step) + '▱'.repeat(total - step);

// ---------- Sessions (callback_data is limited to 64 bytes, so we keep URLs server-side) ----------
// id -> { id, url, userId, title, uploader, meta, videos, hidden, bestAudioSize, canClip, canCaption,
//         overlay: {text,pos}|null, header, caption, markup, duration, heatmap, expires }
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
  for (const [uid, p] of pending) if (p.expires < now) pending.delete(uid);
}, 5 * 60 * 1000);

// users who are about to type their caption text: userId -> { id, chatId, msgId, isPhoto, expires }
const pending = new Map();

let active = 0;
const busyUsers = new Set();

// Returns the session if it exists and belongs to the user, otherwise answers the callback and returns null
async function getOwnedSession(ctx, id) {
  const session = sessions.get(id);
  if (!session) {
    await ctx.answerCbQuery('This request expired. Send the link again.', { show_alert: true });
    return null;
  }
  if (session.userId !== ctx.from.id) {
    await ctx.answerCbQuery('This menu belongs to someone else.', { show_alert: true });
    return null;
  }
  return session;
}

// Edits the caption (photo card) or text (text card) of a message.
// No markup => buttons are removed (prevents double taps while a job is running).
function makeEditorRef(telegram, chatId, msgId, isPhoto) {
  return (t, markup) => {
    const extra = { parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) };
    const p = isPhoto
      ? telegram.editMessageCaption(chatId, msgId, undefined, t, extra)
      : telegram.editMessageText(chatId, msgId, undefined, t, extra);
    return p.catch(() => {});
  };
}
function makeEditor(ctx) {
  const msg = ctx.callbackQuery.message;
  return makeEditorRef(ctx.telegram, ctx.chat.id, msg.message_id, Boolean(msg.photo && msg.photo.length));
}

// Builds the main card (caption text + inline keyboard) from a session
function buildCard(s) {
  const id = s.id;
  const rows = [];
  if (s.videos.length) {
    const btns = s.videos.map((v) =>
      Markup.button.callback(
        `${qualityIcon(v.height)} ${v.height}p${v.size ? ` · ${mb(v.size)}MB` : ''}`,
        `dl:${id}:${v.height}`
      )
    );
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  } else {
    // Fallback (some TikTok links expose few formats)
    rows.push([Markup.button.callback('🎬 Best available', `dl:${id}:best`)]);
  }
  rows.push([
    Markup.button.callback(
      `🎵 Audio MP3${s.bestAudioSize ? ` · ${mb(s.bestAudioSize)}MB` : ''}`,
      `dl:${id}:audio`
    ),
  ]);
  if (s.canClip) rows.push([Markup.button.callback('✂️ Create Clips · best moments', `clip:${id}`)]);
  if (s.canCaption) {
    rows.push([
      Markup.button.callback(
        s.overlay ? `📝 Caption: ON · ${POS_LABEL[s.overlay.pos]}` : '📝 Add caption (text + emojis)',
        `cap:${id}`
      ),
    ]);
  }
  rows.push([
    Markup.button.url('🔗 Original', s.url),
    Markup.button.callback('💎 Plans', 'open_plans'),
    Markup.button.callback('✖️ Cancel', `cancel:${id}`),
  ]);

  let caption = s.header;
  if (s.uploader) caption += `\n👤 ${escHtml(s.uploader.slice(0, 80))}`;
  if (s.meta.length) caption += `\n${s.meta.join('  •  ')}`;
  if (s.overlay) caption += `\n📝 <i>${escHtml(clip(s.overlay.text, 60))}</i>`;
  caption += '\n\n👇 <b>Choose a quality</b>';
  if (s.hidden) {
    caption += `\n<i>${plural(s.hidden, 'higher option')} hidden (over the ${MAX_UPLOAD_MB}MB Telegram limit).</i>`;
  }
  return { caption, markup: Markup.inlineKeyboard(rows).reply_markup };
}

function refreshCard(s) {
  const c = buildCard(s);
  s.caption = c.caption;
  s.markup = c.markup;
}

// The caption settings screen
function captionMenu(s) {
  const id = s.id;
  const cur = s.overlay ? `<b>${escHtml(s.overlay.text)}</b>  ·  ${POS_LABEL[s.overlay.pos]}` : '<i>none yet</i>';
  const text =
    `${s.header}\n\n` +
    '📝 <b>On-video caption</b>\n' +
    `Current: ${cur}\n\n` +
    'It gets burned into downloaded videos and clips (not MP3). Emojis are supported 🎉🔥😍';
  const posBtn = (p) =>
    Markup.button.callback((s.overlay && s.overlay.pos === p ? '✅ ' : '') + POS_LABEL[p], `cappos:${id}:${p}`);
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback(s.overlay ? '✏️ Change text' : '✏️ Set text', `capset:${id}`)],
    [posBtn('top'), posBtn('mid'), posBtn('bot')],
    [Markup.button.callback('👁 Preview', `capprev:${id}`), Markup.button.callback('🗑 Remove', `capoff:${id}`)],
    [Markup.button.callback('⬅️ Back', `back:${id}`)],
  ]).reply_markup;
  return { text, markup };
}

// Re-dispatch "/plans" so the paywall module's own handler runs (used by menu + inline buttons)
function openPlans(ctx) {
  const base = ctx.message || ctx.callbackQuery.message;
  const text = '/plans';
  return bot.handleUpdate({
    update_id: ctx.update.update_id,
    message: {
      message_id: base.message_id,
      date: Math.floor(Date.now() / 1000),
      chat: base.chat,
      from: ctx.from,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  });
}

// ---------- Texts ----------
const WELCOME = () =>
  '👋 <b>Welcome to the Video Downloader!</b>\n\n' +
  'Paste a <b>YouTube</b> or <b>TikTok</b> link and I\'ll show you a preview with the available qualities.\n\n' +
  '✂️ <b>Clips:</b> on longer videos I can auto-cut the best moments into ready-to-post clips.\n' +
  '📝 <b>Captions:</b> add your own text + emojis on top of the video.\n\n' +
  `🆓 <b>Free plan:</b> ${paywall.FREE_DAILY_LIMIT} downloads per day, ${FREE_CLIP_LIMIT} clip job and ${FREE_CAPTION_LIMIT} caption ${FREE_WINDOW_TEXT}\n` +
  '💎 <b>Premium:</b> unlimited downloads, clips and captions\n\n' +
  '<i>Only download content you have the right to save.</i>';

const HOW_TO =
  '📥 <b>How to download</b>\n\n' +
  '1️⃣ Copy a YouTube or TikTok link\n' +
  '2️⃣ Paste it here in the chat\n' +
  '3️⃣ Optional: tap <b>📝 Add caption</b> to put your text + emojis on the video\n' +
  '4️⃣ Pick a quality (🎬 video or 🎵 MP3)\n' +
  '5️⃣ Wait a few seconds and receive your file\n\n' +
  `📦 Max file size: <b>${MAX_UPLOAD_MB}MB</b> • ⏱ Max length: <b>${MAX_DURATION_MIN} min</b>`;

const CLIPS_HELP =
  '✂️ <b>Highlight clips</b>\n\n' +
  '1️⃣ Paste a YouTube or TikTok link\n' +
  '2️⃣ Optional: tap <b>📝 Add caption</b> to put text + emojis on every clip\n' +
  '3️⃣ Tap <b>✂️ Create Clips</b> on the preview\n' +
  '4️⃣ Choose <b>📱 Vertical 9:16</b> (TikTok / Reels / Shorts) or <b>🖥 Original</b>, and a length\n' +
  `5️⃣ I find the best moments and send up to <b>${CLIP_COUNT}</b> clips, ranked from best to least hype\n\n` +
  'Tap any clip → <b>Save</b> to download it.\n' +
  `<i>Works on videos longer than ${Math.round((CLIP_MIN_VIDEO_SEC / 60) * 10) / 10} min. Uses 1 download from your daily limit. Free users get ${FREE_CLIP_LIMIT} clip job ${FREE_WINDOW_TEXT}.</i>`;

const ABOUT =
  'ℹ️ <b>About this bot</b>\n\n' +
  'Fast YouTube & TikTok downloader with quality selection, MP3 extraction, thumbnail previews, auto highlight clips and on-video captions.\n\n' +
  'Use the <b>Menu</b> button (☰ / "/") next to the message box to see all commands.';

const startInline = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📥 How it works', 'show_howto'), Markup.button.callback('✂️ Clips', 'show_clips')],
    [Markup.button.callback('💎 Plans', 'open_plans')],
  ]);

// ---------- Commands ----------
bot.start(async (ctx) => {
  // Reply keyboard first (persistent menu), then the welcome card with inline buttons
  await ctx.reply('🏠 Main menu ready — use the buttons below.', mainMenu);
  await ctx.reply(WELCOME(), { parse_mode: 'HTML', ...startInline() });
});

bot.command('menu', (ctx) => ctx.reply('🏠 Main menu', mainMenu));
bot.help((ctx) => ctx.reply(HOW_TO, { parse_mode: 'HTML', ...startInline() }));
bot.command('about', (ctx) => ctx.reply(ABOUT, { parse_mode: 'HTML' }));
bot.command('clips', (ctx) => ctx.reply(CLIPS_HELP, { parse_mode: 'HTML' }));

// Admin only: diagnose YouTube blocking (version, cookies, JS runtime, proxy, live test)
bot.command('ytcheck', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const url = ctx.message.text.split(/\s+/)[1] || 'https://www.youtube.com/watch?v=jNQXAC9IWRI';
  await ctx.reply('🔎 Running yt-dlp check…');
  let ver = '?';
  try {
    ver = (await runBin(YTDLP, ['--version'], { timeout: 15000 })).trim();
  } catch (e) {
    return ctx.reply('❌ yt-dlp not runnable: ' + clip(String(e.message), 300));
  }
  let cookieInfo = 'none';
  if (COOKIES) {
    try {
      const txt = fs.readFileSync(COOKIES, 'utf8');
      const first = txt.split(/\r?\n/)[0];
      const yt = txt.split(/\r?\n/).filter((l) => /youtube\.com|google\.com/.test(l) && l.split('\t').length >= 7).length;
      cookieInfo = `${yt} youtube/google cookies, header ${/Netscape|HTTP Cookie File/.test(first) ? 'OK' : 'BAD (' + clip(first, 30) + ')'}`;
    } catch (e) {
      cookieInfo = 'unreadable: ' + e.message;
    }
  }
  let result;
  let verboseTail = '';
  try {
    const out = await run([...baseArgs(), '--verbose', '--skip-download', '--print', 'title', url], { timeout: 60000 });
    result = '✅ Works: ' + clip(out.trim(), 80);
  } catch (e) {
    const lines = String(e.stderr || e.message).trim().split('\n');
    result = '❌ ' + clip(lines.slice(-3).join(' | '), 600);
    // Verbose tail shows which player clients ran and what each one said
    verboseTail = lines.filter((l) => /\[youtube\]|WARNING|ERROR|js runtime|challenge|cookies|client/i.test(l)).slice(-14).join('\n');
  }
  await ctx.reply(
    '🛠 <b>YouTube check</b>\n\n' +
      `yt-dlp: <code>${escHtml(ver)}</code>\n` +
      `Cookies: ${escHtml(cookieInfo)}\n` +
      `JS runtime flag: ${(process.env.YTDLP_JS_RUNTIME || 'node').toLowerCase() === 'off' ? 'off' : 'node'}\n` +
      `Proxy: ${process.env.YTDLP_PROXY ? 'set' : 'none'}\n\n` +
      escHtml(result),
    { parse_mode: 'HTML' }
  );
  if (verboseTail) await ctx.reply('Verbose tail:\n' + clip(verboseTail, 3500)).catch(() => {});
});

// Admin only: usage summary from the activity log
bot.command('stats', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  if (!dbReady()) {
    return ctx.reply('📉 Activity logging is off. Set DATABASE_URL in .env and run: npm i pg');
  }
  try {
    const { s, recent } = await getStats();
    const lines = recent.map(
      (r) => `${r.t} · ${r.user_id || '-'} · ${r.event} ${r.status === 'ok' ? '✅' : '❌'} ${r.what}`
    );
    await ctx.reply(
      '📊 <b>Bot stats</b>\n\n' +
        `👥 Users: <b>${s.users}</b> (active 24h: ${s.active_24h})\n` +
        `🔗 Links checked: <b>${s.links}</b>\n` +
        `📥 Downloads: <b>${s.downloads}</b> (24h: ${s.downloads_24h})\n` +
        `✂️ Clip jobs: <b>${s.clip_jobs}</b> (24h: ${s.clips_24h})\n` +
        `⚠️ Errors: <b>${s.errors}</b> (24h: ${s.errors_24h})\n\n` +
        '🕒 <b>Recent activity</b> (UTC)\n' +
        `<pre>${escHtml(lines.join('\n') || 'nothing yet')}</pre>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Stats error:', e.message);
    await ctx.reply('❌ Could not read the stats right now.');
  }
});

// Menu buttons (reply keyboard) – must be registered before the generic text handler
bot.hears(BTN_DOWNLOAD, (ctx) => ctx.reply(HOW_TO, { parse_mode: 'HTML' }));
bot.hears(BTN_CLIPS, (ctx) => ctx.reply(CLIPS_HELP, { parse_mode: 'HTML' }));
bot.hears(BTN_HELP, (ctx) => ctx.reply(HOW_TO, { parse_mode: 'HTML', ...startInline() }));
bot.hears(BTN_ABOUT, (ctx) => ctx.reply(ABOUT, { parse_mode: 'HTML' }));
bot.hears(BTN_PLANS, (ctx) => openPlans(ctx));

bot.action('show_howto', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(HOW_TO, { parse_mode: 'HTML' });
});
bot.action('show_clips', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(CLIPS_HELP, { parse_mode: 'HTML' });
});
bot.action('open_plans', async (ctx) => {
  await ctx.answerCbQuery();
  return openPlans(ctx);
});

// ---------- Paywall (commands, payments) ----------
// Must be registered before the text handler below, which would otherwise swallow commands
paywall.register(bot);

// ---------- Link handler (also receives the caption text when the user is setting one) ----------
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  // 1) The user tapped "Set text" and is now typing their caption
  const pend = pending.get(ctx.from.id);
  if (pend) {
    pending.delete(ctx.from.id);
    const s = sessions.get(pend.id);
    if (!extractUrl(text) && pend.expires > Date.now() && s && s.userId === ctx.from.id) {
      const editMenu = makeEditorRef(ctx.telegram, pend.chatId, pend.msgId, pend.isPhoto);
      const clean = Array.from(text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim())
        .slice(0, CAPTION_MAX_CHARS)
        .join('');
      if (clean && !/^cancel$/i.test(clean)) {
        s.overlay = { text: clean, pos: (s.overlay && s.overlay.pos) || 'bot' };
        refreshCard(s);
        logEvent(ctx.from, 'caption_set', {
          chatId: ctx.chat.id,
          url: s.url,
          title: s.title,
          details: { text: clean, pos: s.overlay.pos },
        });
      }
      const m = captionMenu(s);
      await editMenu(m.text, m.markup);
      return;
    }
    // expired / link pasted instead: fall through and treat it as a normal message
  }

  // 2) Normal flow: a link
  const url = extractUrl(text);
  if (!url) {
    logEvent(ctx.from, 'invalid_link', { chatId: ctx.chat.id, details: { text: text.slice(0, 100) } });
    return ctx.reply(
      '🤔 That doesn\'t look like a supported link.\n\nPlease send a valid <b>YouTube</b> or <b>TikTok</b> URL.',
      { parse_mode: 'HTML', ...mainMenu }
    );
  }

  const t0 = Date.now();
  const status = await ctx.reply('🔎 <b>Checking the link…</b>', { parse_mode: 'HTML' });
  const editStatus = (t, extra = {}) =>
    ctx.telegram
      .editMessageText(ctx.chat.id, status.message_id, undefined, t, { parse_mode: 'HTML', ...extra })
      .catch(() => {});

  try {
    const info = await getInfo(url);

    if (info.is_live) {
      logEvent(ctx.from, 'link_info', { chatId: ctx.chat.id, url, status: 'error', error: 'live stream' });
      return editStatus('❌ <b>Live streams are not supported.</b>');
    }
    if (info.duration && info.duration > MAX_DURATION_MIN * 60) {
      logEvent(ctx.from, 'link_info', {
        chatId: ctx.chat.id,
        url,
        title: info.title,
        status: 'error',
        error: `too long (${fmtDuration(info.duration)})`,
      });
      return editStatus(`❌ <b>Video is too long</b> (max ${MAX_DURATION_MIN} min).`);
    }

    const { videos, hidden, bestAudioSize } = buildOptions(info);
    const id = crypto.randomBytes(4).toString('hex');
    const title = (info.title || 'video').slice(0, 200);
    const ff = await hasFfmpeg();
    const meta = [
      info.duration && `⏱ ${fmtDuration(info.duration)}`,
      fmtCount(info.view_count) && `👁 ${fmtCount(info.view_count)}`,
      fmtCount(info.like_count) && `👍 ${fmtCount(info.like_count)}`,
    ].filter(Boolean);

    const session = {
      id,
      url,
      userId: ctx.from.id,
      title,
      header: `🎬 <b>${escHtml(title)}</b>`,
      uploader: info.uploader || info.channel || '',
      meta,
      videos,
      hidden,
      bestAudioSize,
      canClip: Boolean(info.duration && info.duration >= CLIP_MIN_VIDEO_SEC) && ff,
      canCaption: Boolean(canvasLib) && ff,
      overlay: null,
      duration: info.duration || undefined,
      heatmap: Array.isArray(info.heatmap) && info.heatmap.length ? info.heatmap : null,
      expires: Date.now() + 15 * 60 * 1000,
    };
    refreshCard(session);
    sessions.set(id, session);

    logEvent(ctx.from, 'link_info', {
      chatId: ctx.chat.id,
      url,
      title,
      durationMs: Date.now() - t0,
      details: { videoSeconds: info.duration || null, heatmap: Boolean(session.heatmap) },
    });

    // ----- Send with thumbnail (fallback to plain text card) -----
    let sent = null;
    const thumb = pickThumbnail(info);
    if (thumb) {
      try {
        sent = await ctx.replyWithPhoto(thumb, {
          caption: session.caption,
          parse_mode: 'HTML',
          reply_markup: session.markup,
        });
        ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      } catch (e) {
        console.error('Thumbnail error:', e.message);
      }
    }
    if (!sent) {
      await editStatus(session.caption, { reply_markup: session.markup, disable_web_page_preview: true });
    }
  } catch (err) {
    console.error('Info error:', err.stderr || err.message);
    logEvent(ctx.from, 'link_info', {
      chatId: ctx.chat.id,
      url,
      status: 'error',
      error: errText(err),
      durationMs: Date.now() - t0,
    });
    await editStatus(escHtml(explainError(err, ctx.from.id)));
  }
});

function explainError(err, userId) {
  const raw = String(err.stderr || err.message || '');
  let msg;
  if (/not a bot/i.test(raw)) {
    msg = '❌ YouTube is blocking this server right now. Please try again later.';
  } else if (/private video|members-only|not available in your country|video unavailable|age-restricted|confirm your age/i.test(raw)) {
    msg = '❌ That video is private, restricted, or unavailable.';
  } else if (/ENOENT/.test(raw)) {
    msg = '❌ Server setup problem: yt-dlp is not installed.';
  } else {
    msg = '❌ Could not read that link. It may be private, region-locked, or unsupported.';
  }
  // Admins (ADMIN_IDS) also see the tail of the raw error to make debugging easy
  if (ADMIN_IDS.includes(userId)) {
    msg += `\n\nDebug: ${raw.trim().split('\n').slice(-2).join(' ').slice(0, 400)}`;
  }
  return msg;
}

// ---------- Cancel / back ----------
bot.action(/^cancel:([a-f0-9]+)$/, async (ctx) => {
  const session = sessions.get(ctx.match[1]);
  if (session && session.userId !== ctx.from.id) {
    return ctx.answerCbQuery('This menu belongs to someone else.', { show_alert: true });
  }
  sessions.delete(ctx.match[1]);
  pending.delete(ctx.from.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/^back:([a-f0-9]+)$/, async (ctx) => {
  const session = await getOwnedSession(ctx, ctx.match[1]);
  if (!session) return;
  pending.delete(ctx.from.id);
  await ctx.answerCbQuery();
  await makeEditor(ctx)(session.caption, session.markup);
});

// ---------- Caption settings ----------
bot.action(/^cap:([a-f0-9]+)$/, async (ctx) => {
  const s = await getOwnedSession(ctx, ctx.match[1]);
  if (!s) return;
  if (await denyCaptionIfLocked(ctx)) return;
  await ctx.answerCbQuery();
  s.expires = Date.now() + 30 * 60 * 1000;
  const m = captionMenu(s);
  await makeEditor(ctx)(m.text, m.markup);
});

bot.action(/^capset:([a-f0-9]+)$/, async (ctx) => {
  const s = await getOwnedSession(ctx, ctx.match[1]);
  if (!s) return;
  if (await denyCaptionIfLocked(ctx)) return;
  await ctx.answerCbQuery();
  s.expires = Date.now() + 30 * 60 * 1000;
  const msg = ctx.callbackQuery.message;
  pending.set(ctx.from.id, {
    id: s.id,
    chatId: ctx.chat.id,
    msgId: msg.message_id,
    isPhoto: Boolean(msg.photo && msg.photo.length),
    expires: Date.now() + 5 * 60 * 1000,
  });
  await makeEditor(ctx)(
    `${s.header}\n\n✏️ <b>Send me your caption text now</b>\n` +
      `Up to ${CAPTION_MAX_CHARS} characters, emojis welcome 🎉🔥😍\n\n` +
      '<i>Send "cancel" to go back.</i>',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `back:${s.id}`)]]).reply_markup
  );
});

bot.action(/^cappos:([a-f0-9]+):(top|mid|bot)$/, async (ctx) => {
  const s = await getOwnedSession(ctx, ctx.match[1]);
  if (!s) return;
  if (!s.overlay) {
    return ctx.answerCbQuery('Set the caption text first.', { show_alert: true });
  }
  await ctx.answerCbQuery(POS_LABEL[ctx.match[2]]);
  s.overlay.pos = ctx.match[2];
  refreshCard(s);
  const m = captionMenu(s);
  await makeEditor(ctx)(m.text, m.markup);
});

bot.action(/^capoff:([a-f0-9]+)$/, async (ctx) => {
  const s = await getOwnedSession(ctx, ctx.match[1]);
  if (!s) return;
  pending.delete(ctx.from.id);
  s.overlay = null;
  refreshCard(s);
  logEvent(ctx.from, 'caption_removed', { chatId: ctx.chat.id, url: s.url, title: s.title });
  await ctx.answerCbQuery('Caption removed');
  await makeEditor(ctx)(s.caption, s.markup);
});

bot.action(/^capprev:([a-f0-9]+)$/, async (ctx) => {
  const s = await getOwnedSession(ctx, ctx.match[1]);
  if (!s) return;
  if (!s.overlay) {
    return ctx.answerCbQuery('Set the caption text first.', { show_alert: true });
  }
  await ctx.answerCbQuery('Rendering preview…');
  try {
    const png = renderCaption(s.overlay, 720, 1280, '#1f2937');
    await ctx.replyWithPhoto({ source: png }, { caption: '👁 Caption preview (9:16 frame)' });
  } catch (e) {
    console.error('Preview error:', e.message);
    await ctx.reply('❌ Could not render the preview. Check the server fonts/emoji support.');
  }
});

// ---------- Download handler ----------
bot.action(/^dl:([a-f0-9]+):(\w+)$/, async (ctx) => {
  const [, id, choice] = ctx.match;
  const session = await getOwnedSession(ctx, id);
  if (!session) return;

  if (busyUsers.has(ctx.from.id)) {
    return ctx.answerCbQuery('You already have a download running.', { show_alert: true });
  }
  if (active >= MAX_CONCURRENT) {
    return ctx.answerCbQuery('Server is busy. Try again in a minute.', { show_alert: true });
  }

  // Paywall: free users get a daily limit, premium users are unlimited, admins are always free
  const access = await getAccess(ctx.from.id);
  if (!access.allowed) {
    logEvent(ctx.from, 'limit_reached', { chatId: ctx.chat.id, url: session.url, details: { action: 'download' } });
    await ctx.answerCbQuery('Daily free limit reached.');
    return ctx.reply(paywall.limitText(access), paywall.plansKeyboard());
  }

  // Caption (Set text) is limited for free users: drop it if they have used up their free captions
  let captionGate = { allowed: true, exempt: true };
  if (session.overlay && choice !== 'audio') {
    captionGate = await featureGate(ctx.from.id, 'caption', FREE_CAPTION_LIMIT, access);
    if (!captionGate.allowed) {
      session.overlay = null;
      logEvent(ctx.from, 'limit_reached', { chatId: ctx.chat.id, url: session.url, details: { action: 'caption' } });
      await ctx.reply(
        featureLimitText('caption', FREE_CAPTION_LIMIT) + '\n\n<i>Your video will be sent without the caption.</i>',
        { parse_mode: 'HTML', ...paywall.plansKeyboard() }
      );
    }
  }

  await ctx.answerCbQuery('Starting...');
  active++;
  busyUsers.add(ctx.from.id);
  pending.delete(ctx.from.id);

  const t0 = Date.now();
  const chatId = ctx.chat.id;
  const msgId = ctx.callbackQuery.message.message_id;
  const edit = makeEditor(ctx);

  const label = choice === 'audio' ? '🎵 MP3' : choice === 'best' ? '🎬 Best' : `🎬 ${choice}p`;
  const prefix = `${id}_${choice}`;
  const outTemplate = path.join(TMP_DIR, `${prefix}.%(ext)s`);
  const wantsCaption = choice !== 'audio' && Boolean(session.overlay);
  const logBase = { chatId, url: session.url, title: session.title, choice };

  try {
    await edit(`${session.header}\n\n⬇️ <b>Downloading ${label}…</b>\n▰▱▱  Step 1 of 3`);
    ctx.sendChatAction(choice === 'audio' ? 'upload_voice' : 'upload_video').catch(() => {});

    const args = [...baseArgs(), '--max-filesize', `${MAX_UPLOAD_MB}M`, '-o', outTemplate];

    if (choice === 'audio') {
      args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (choice === 'best') {
      args.push('-f', 'b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4');
    } else {
      const h = parseInt(choice, 10);
      args.push(
        '-f',
        `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]`,
        '--merge-output-format',
        'mp4'
      );
    }
    args.push(session.url);

    await run(args);

    await edit(
      `${session.header}\n\n${wantsCaption ? '🖍 <b>Adding your caption…</b>' : '⚙️ <b>Processing…</b>'}\n▰▰▱  Step 2 of 3`
    );

    const file = fs.readdirSync(TMP_DIR).find((f) => f.startsWith(prefix + '.'));
    if (!file) throw new Error('Output file not found (possibly over the size limit)');
    let filePath = path.join(TMP_DIR, file);

    // Burn the caption into the video (re-encode)
    if (wantsCaption) {
      try {
        const dim = await probeSize(filePath);
        const capPng = path.join(TMP_DIR, `${prefix}.cap.png`);
        const capOut = path.join(TMP_DIR, `${prefix}.cap.mp4`);
        fs.writeFileSync(capPng, renderCaption(session.overlay, dim.w, dim.h));
        await runBin(FFMPEG, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          filePath,
          '-i',
          capPng,
          '-filter_complex',
          '[0:v][1:v]overlay=0:0,format=yuv420p[v]',
          '-map',
          '[v]',
          '-map',
          '0:a?',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          capOut,
        ]);
        filePath = capOut;
      } catch (e) {
        e.captionFailed = true;
        throw e;
      }
    }

    const size = fs.statSync(filePath).size;

    if (size > MAX_UPLOAD_MB * 1024 * 1024) {
      logEvent(ctx.from, 'download_error', {
        ...logBase,
        status: 'error',
        error: `file ${mb(size)}MB over limit`,
        durationMs: Date.now() - t0,
      });
      await edit(
        `❌ <b>File is ${mb(size)}MB</b>, over the ${MAX_UPLOAD_MB}MB Telegram limit.\nPick a lower quality.\n\n${session.caption}`,
        session.markup
      );
      return;
    }

    await edit(`${session.header}\n\n⬆️ <b>Uploading (${mb(size)}MB)…</b>\n▰▰▰  Step 3 of 3`);
    ctx.sendChatAction(choice === 'audio' ? 'upload_voice' : 'upload_video').catch(() => {});

    const doneKb = Markup.inlineKeyboard([
      [Markup.button.url('🔗 Original link', session.url), Markup.button.callback('💎 Plans', 'open_plans')],
    ]);
    const caption = `${session.header}\n\n✅ <i>Downloaded via @${ctx.botInfo.username}</i>`.slice(0, 1000);

    if (choice === 'audio') {
      await ctx.replyWithAudio(
        { source: filePath },
        {
          title: session.title,
          duration: session.duration,
          caption,
          parse_mode: 'HTML',
          reply_markup: doneKb.reply_markup,
        }
      );
    } else {
      await ctx.replyWithVideo(
        { source: filePath },
        {
          caption,
          parse_mode: 'HTML',
          duration: session.duration,
          supports_streaming: true,
          reply_markup: doneKb.reply_markup,
        }
      );
    }
    if (!isAdmin(ctx.from.id)) {
      await paywall.recordDownload(ctx.from.id).catch((e) => console.error('Usage record error:', e.message));
    }
    if (wantsCaption && !captionGate.exempt) await bumpFeatureUsed(ctx.from.id, 'caption');
    logEvent(ctx.from, 'download_done', {
      ...logBase,
      durationMs: Date.now() - t0,
      details: { sizeMb: Number(mb(size)), captioned: wantsCaption },
    });
    await ctx.telegram.deleteMessage(chatId, msgId).catch(() => {});
    sessions.delete(id);
  } catch (err) {
    console.error('Download error:', err.stderr || err.message);
    logEvent(ctx.from, 'download_error', {
      ...logBase,
      status: 'error',
      error: errText(err),
      durationMs: Date.now() - t0,
      details: { captioned: wantsCaption, captionFailed: Boolean(err.captionFailed) },
    });
    // Restore the card + buttons so the user can retry another quality right away
    const msg = err.captionFailed
      ? '❌ <b>Couldn\'t add the caption.</b> Try removing it or pick another quality.'
      : '❌ <b>Download failed.</b> Try another quality.';
    await edit(`${msg}\n\n${session.caption}`, session.markup);
  } finally {
    active--;
    busyUsers.delete(ctx.from.id);
    // cleanup temp files (also covers the .cap.png / .cap.mp4 files)
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (f.startsWith(prefix + '.')) fs.unlink(path.join(TMP_DIR, f), () => {});
    }
  }
});

// ---------- Clips: format / length menu ----------
bot.action(/^clip:([a-f0-9]+)$/, async (ctx) => {
  const id = ctx.match[1];
  const session = await getOwnedSession(ctx, id);
  if (!session) return;
  await ctx.answerCbQuery();
  session.expires = Date.now() + 30 * 60 * 1000;

  const how = session.heatmap
    ? 'YouTube\'s “Most replayed” data + audio energy'
    : 'audio energy (loudest, most active moments)';
  const clipAccess = await getAccess(ctx.from.id).catch(() => null);
  const clipMenuGate = await featureGate(ctx.from.id, 'clip', FREE_CLIP_LIMIT, clipAccess);
  const text =
    `${session.header}\n\n` +
    '✂️ <b>Create highlight clips</b>\n' +
    featureLeftLine('clip', clipMenuGate) +
    `I\'ll find the best moments using ${how} and cut up to <b>${CLIP_COUNT}</b> clips.\n` +
    (session.overlay ? `📝 Caption on every clip: <i>${escHtml(clip(session.overlay.text, 50))}</i>\n` : '') +
    '\n📱 = Vertical 9:16 (TikTok / Reels / Shorts)\n' +
    '🖥 = Original ratio\n\n' +
    '👇 <b>Pick a format and clip length</b>';

  const kb = Markup.inlineKeyboard([
    CLIP_LENGTHS.map((l) => Markup.button.callback(`📱 ${l}s`, `cp:${id}:v:${l}`)),
    CLIP_LENGTHS.map((l) => Markup.button.callback(`🖥 ${l}s`, `cp:${id}:o:${l}`)),
    [Markup.button.callback('⬅️ Back', `back:${id}`)],
  ]).reply_markup;

  await makeEditor(ctx)(text, kb);
});

// ---------- Clips: run the job ----------
bot.action(/^cp:([a-f0-9]+):([vo]):(\d+)$/, async (ctx) => {
  const [, id, fmt, lenStr] = ctx.match;
  const len = Number(lenStr);
  const session = await getOwnedSession(ctx, id);
  if (!session) return;

  if (!CLIP_LENGTHS.includes(len)) {
    return ctx.answerCbQuery('Invalid clip length.', { show_alert: true });
  }
  if (!(await hasFfmpeg())) {
    return ctx.answerCbQuery('Clips are unavailable: ffmpeg is not installed on the server.', { show_alert: true });
  }
  if (busyUsers.has(ctx.from.id)) {
    return ctx.answerCbQuery('You already have a job running.', { show_alert: true });
  }
  if (active >= MAX_CONCURRENT) {
    return ctx.answerCbQuery('Server is busy. Try again in a minute.', { show_alert: true });
  }

  // Paywall: a clip job uses one download from the daily limit (admins are always free)
  const access = await getAccess(ctx.from.id);
  if (!access.allowed) {
    logEvent(ctx.from, 'limit_reached', { chatId: ctx.chat.id, url: session.url, details: { action: 'clips' } });
    await ctx.answerCbQuery('Daily free limit reached.');
    return ctx.reply(paywall.limitText(access), paywall.plansKeyboard());
  }

  // Free users get a limited number of clip jobs before they need a subscription
  const clipGate = await featureGate(ctx.from.id, 'clip', FREE_CLIP_LIMIT, access);
  if (!clipGate.allowed) {
    logEvent(ctx.from, 'limit_reached', { chatId: ctx.chat.id, url: session.url, details: { action: 'clip_feature' } });
    await ctx.answerCbQuery('Free clip limit reached.');
    return ctx.reply(featureLimitText('clip', FREE_CLIP_LIMIT), { parse_mode: 'HTML', ...paywall.plansKeyboard() });
  }

  // Caption on clips is limited too: drop it if the free captions are used up
  let clipCaptionGate = { allowed: true, exempt: true };
  if (session.overlay) {
    clipCaptionGate = await featureGate(ctx.from.id, 'caption', FREE_CAPTION_LIMIT, access);
    if (!clipCaptionGate.allowed) {
      session.overlay = null;
      await ctx.reply(
        featureLimitText('caption', FREE_CAPTION_LIMIT) + '\n\n<i>Your clips will be made without the caption.</i>',
        { parse_mode: 'HTML', ...paywall.plansKeyboard() }
      );
    }
  }

  await ctx.answerCbQuery('Starting clips…');
  session.expires = Date.now() + 30 * 60 * 1000;
  active++;
  busyUsers.add(ctx.from.id);
  pending.delete(ctx.from.id);

  const t0 = Date.now();
  const edit = makeEditor(ctx);
  const prefix = `${id}_clip`;
  const srcTemplate = path.join(TMP_DIR, `${prefix}src.%(ext)s`);
  const limitBytes = MAX_UPLOAD_MB * 1024 * 1024;
  const logBase = { chatId: ctx.chat.id, url: session.url, title: session.title, choice: `${fmt}${len}` };
  let sentCount = 0;
  let captionSkipped = false;

  try {
    // 1) Download a working copy
    await edit(`${session.header}\n\n⬇️ <b>Downloading the video…</b>\n${bar(1)}  Step 1 of 4`);
    ctx.sendChatAction('upload_video').catch(() => {});
    const h = CLIP_SOURCE_HEIGHT;
    await run([
      ...baseArgs(),
      '--max-filesize',
      `${CLIP_SOURCE_MAX_MB}M`,
      '-f',
      `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      '--merge-output-format',
      'mp4',
      '-o',
      srcTemplate,
      session.url,
    ]);
    const srcName = fs.readdirSync(TMP_DIR).find((f) => f.startsWith(`${prefix}src.`));
    if (!srcName) throw Object.assign(new Error('Source file not found'), { code: 'TOO_BIG' });
    const src = path.join(TMP_DIR, srcName);

    const total = Math.floor(session.duration || (await probeDuration(src)));
    if (total <= len + 5) {
      logEvent(ctx.from, 'clips_done', { ...logBase, status: 'skipped', details: { reason: 'video too short', total } });
      await edit(
        `ℹ️ <b>This video is already short</b> (${fmtDuration(total)}), so there's nothing to split. Try a shorter clip length.\n\n${session.caption}`,
        session.markup
      );
      return;
    }

    // 2) Find the best moments
    await edit(`${session.header}\n\n🔍 <b>Finding the best moments…</b>\n${bar(2)}  Step 2 of 4`);
    let audio = null;
    try {
      audio = normalizeLevels(await audioLevels(src, total));
    } catch (e) {
      console.error('Audio analysis error:', e.stderr || e.message);
    }
    const heat = session.heatmap ? heatmapToSeconds(session.heatmap, total) : null;

    let scores;
    if (heat && audio) scores = heat.map((v, i) => 0.65 * v + 0.35 * audio[i]);
    else scores = heat || audio;
    if (!scores) throw new Error('No highlight signal available');
    const signal = heat && audio ? 'heatmap+audio' : heat ? 'heatmap' : 'audio';

    const count = Math.max(1, Math.min(CLIP_COUNT, Math.floor(total / len)));
    const windows = pickWindows(scores, len, count);
    if (!windows.length) throw new Error('No clip windows found');

    // Caption overlay (rendered once, reused for every clip)
    let capPng = null;
    if (session.overlay) {
      try {
        const dim = fmt === 'v' ? { w: 720, h: 1280 } : await probeSize(src);
        capPng = path.join(TMP_DIR, `${prefix}cap.png`);
        fs.writeFileSync(capPng, renderCaption(session.overlay, dim.w, dim.h));
      } catch (e) {
        console.error('Caption render error:', e.message);
        capPng = null;
        captionSkipped = true;
      }
    }

    // 3 + 4) Cut and send, best clip first
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const out = path.join(TMP_DIR, `${prefix}${i + 1}.mp4`);

      await edit(`${session.header}\n\n✂️ <b>Cutting clip ${i + 1} of ${windows.length}…</b>\n${bar(3)}  Step 3 of 4`);
      ctx.sendChatAction('upload_video').catch(() => {});
      await runBin(FFMPEG, buildClipArgs(src, w.start, len, fmt, out, capPng));

      const size = fs.statSync(out).size;
      if (size > limitBytes) {
        console.error(`Clip ${i + 1} is ${mb(size)}MB, skipped (over limit)`);
        continue;
      }

      await edit(`${session.header}\n\n⬆️ <b>Sending clip ${i + 1} of ${windows.length}…</b>\n${bar(4)}  Step 4 of 4`);
      const caption =
        `${i === 0 ? '🏆' : '🎬'} <b>Clip ${i + 1} of ${windows.length}</b>${i === 0 ? ' · top moment' : ''}\n` +
        `⏱ ${fmtDuration(w.start)} – ${fmtDuration(w.start + len)}  •  🔥 Hype ${Math.round(w.score * 100)}%\n\n` +
        escHtml(session.title.slice(0, 150));

      await ctx.replyWithVideo(
        { source: out },
        {
          caption,
          parse_mode: 'HTML',
          duration: len,
          supports_streaming: true,
          ...(fmt === 'v' ? { width: 720, height: 1280 } : {}),
        }
      );
      sentCount++;
      fs.unlink(out, () => {});
    }

    if (!sentCount) throw Object.assign(new Error('All clips over size limit'), { code: 'TOO_BIG' });

    if (!isAdmin(ctx.from.id)) {
      await paywall.recordDownload(ctx.from.id).catch((e) => console.error('Usage record error:', e.message));
    }
    if (!clipGate.exempt) await bumpFeatureUsed(ctx.from.id, 'clip');
    if (capPng && !clipCaptionGate.exempt) await bumpFeatureUsed(ctx.from.id, 'caption');
    logEvent(ctx.from, 'clips_done', {
      ...logBase,
      durationMs: Date.now() - t0,
      details: { format: fmt === 'v' ? '9:16' : 'original', seconds: len, clips: sentCount, signal, captioned: Boolean(capPng) },
    });

    await ctx.reply(
      `✅ <b>${plural(sentCount, 'clip')} ready!</b>\n\n` +
        'Ranked from best to least hype. Tap a clip → <b>Save</b> to download it.' +
        (captionSkipped ? '\n\n⚠️ <i>Your caption couldn\'t be added this time.</i>' : ''),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('✂️ Try another length / format', `clip:${id}`)]]),
      }
    );
    await edit(session.caption, session.markup); // restore the original card
  } catch (err) {
    console.error('Clip error:', err.stderr || err.message);
    logEvent(ctx.from, 'clips_error', {
      ...logBase,
      status: 'error',
      error: errText(err),
      durationMs: Date.now() - t0,
    });
    const raw = String(err.stderr || err.message || '');
    let msg = '❌ <b>Couldn\'t create clips.</b> Please try again.';
    if (/ENOENT/.test(raw)) msg = '❌ <b>Server setup problem:</b> ffmpeg is not installed.';
    else if (err.code === 'TOO_BIG' || /max-filesize|larger than/i.test(raw))
      msg = '❌ <b>This video is too large to clip.</b> Try a shorter video or a shorter clip length.';
    await edit(`${msg}\n\n${session.caption}`, session.markup);
  } finally {
    active--;
    busyUsers.delete(ctx.from.id);
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (f.startsWith(prefix)) fs.unlink(path.join(TMP_DIR, f), () => {});
    }
  }
});

bot.catch((err) => console.error('Bot error:', err));

// ---------- Telegram menu setup (the "/" command menu button on desktop + mobile) ----------
async function setupMenu() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🏠 Start & main menu' },
      { command: 'menu', description: '📋 Show menu buttons' },
      { command: 'clips', description: '✂️ How to make highlight clips' },
      { command: 'plans', description: '💎 Plans & upgrade' },
      { command: 'help', description: '❓ How to download' },
      { command: 'about', description: 'ℹ️ About this bot' },
    ]);
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
  } catch (e) {
    console.error('Menu setup error:', e.message);
  }
}

async function start() {
  try {
    await paywall.init();
  } catch (err) {
    console.error('Paywall init error:', err);
    process.exit(1);
  }

  await initDb().catch((e) => console.error('DB init failed, activity logging disabled:', e.message));
  await setupMenu();

  if (!(await hasFfmpeg())) {
    console.warn(
      '⚠️  ffmpeg not found (' + FFMPEG + '). Clips, captions, MP3 and HD merging need it. ' +
        'Install it (apt install ffmpeg) or run: npm i ffmpeg-static ffprobe-static'
    );
  }
  if (!canvasLib) {
    console.warn('⚠️  Captions are disabled. Run: npm i @napi-rs/canvas');
  }

  const MAX_RETRIES = Number(process.env.LAUNCH_RETRIES || 12);
  const RETRY_DELAY_MS = Number(process.env.LAUNCH_RETRY_DELAY_MS || 10000);

  for (let attempt = 1; ; attempt++) {
    try {
      // Resolves only when the bot is stopped; throws if polling fails.
      await bot.launch(() => console.log('Video downloader bot running...'));
      return;
    } catch (err) {
      const is409 = err && err.response && err.response.error_code === 409;
      if (is409 && attempt <= MAX_RETRIES) {
        console.warn(
          `409 Conflict: another instance is still polling this token. Retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s...`
        );
        try {
          bot.stop('retry');
        } catch {
          /* bot was not running */
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      console.error('Startup error:', err);
      process.exit(1);
    }
  }
}

start();

function shutdown(signal) {
  try {
    bot.stop(signal);
  } catch {
    /* not running */
  }
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));