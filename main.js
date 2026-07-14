const { app, BrowserWindow, ipcMain, dialog, Notification, nativeTheme, Menu, net, session, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { existsSync, mkdirSync, unlinkSync, readdirSync, statSync } = fs;
const { execFileSync, spawn, execFile } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const nodeNet = require('net');

// Must be set before app.whenReady() — Windows uses this to associate
// the taskbar icon with the running window. Without it, Windows reuses
// a cached icon from the previous exe's hashed AppUserModelID.
app.setAppUserModelId('com.u2bdown.app');

let _systemProxy = null;
let _systemProxyPromise = null;
let _appliedProxy = '';

const VIDEO_HOSTS = {
  youtube: ['youtube.com', 'youtu.be'],
  bilibili: ['bilibili.com', 'b23.tv'],
  taptap: ['taptap.cn', 'taptap.io'],
  douyin: ['douyin.com', 'iesdouyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
};

const DOUYIN_MEDIA_HOSTS = ['douyinvod.com', 'bytevcloud.com', 'douyin.com', 'snssdk.com', 'douyinstatic.com'];
const DOUYIN_IMAGE_HOSTS = ['douyinpic.com', 'byteimg.com', 'douyinstatic.com'];
const DOUYIN_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/${process.versions.chrome || '148.0.0.0'} Safari/537.36`;
const XHS_MEDIA_HOSTS = ['xhscdn.com', 'xiaohongshu.com'];
const XHS_USER_AGENT = DOUYIN_USER_AGENT;

function hostMatches(hostname, domains) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function extractHttpUrlCandidates(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请输入视频链接');
  if (raw.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
    throw new Error('视频链接或分享口令过长，或包含无效字符');
  }

  const matches = raw.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  if (/^https?:\/\/\S+$/i.test(raw)) matches.unshift(raw);
  return [...new Set(matches.map(candidate => candidate
    .replace(/[，。；、）】》」』,.;)\]}]+$/g, '')
    .trim()).filter(Boolean))];
}

function normalizeVideoUrl(value, { youtubeOnly = false } = {}) {
  const candidates = extractHttpUrlCandidates(value);
  let foundWebUrl = false;

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (e) {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    foundWebUrl = true;

    const isYoutube = hostMatches(parsed.hostname, VIDEO_HOSTS.youtube);
    const isSupported = isYoutube
      || hostMatches(parsed.hostname, VIDEO_HOSTS.bilibili)
      || hostMatches(parsed.hostname, VIDEO_HOSTS.taptap)
      || hostMatches(parsed.hostname, VIDEO_HOSTS.douyin)
      || hostMatches(parsed.hostname, VIDEO_HOSTS.xiaohongshu);
    if (!isSupported || (youtubeOnly && !isYoutube)) continue;

    parsed.protocol = 'https:';
    return parsed.href;
  }

  if (youtubeOnly) throw new Error('批量下载仅支持 YouTube 视频链接');
  if (foundWebUrl) throw new Error('暂不支持该网站，请使用 YouTube、B站、TapTap、抖音或小红书的链接');
  throw new Error('没有在文本中找到可用的链接；粘贴抖音或小红书分享口令时请保留完整分享网址');
}

function isYouTubeUrl(url) {
  try { return hostMatches(new URL(String(url || '')).hostname, VIDEO_HOSTS.youtube); }
  catch (e) { return false; }
}

function isBilibiliUrl(url) {
  try { return hostMatches(new URL(String(url || '')).hostname, VIDEO_HOSTS.bilibili); }
  catch (e) { return false; }
}

function isTapTapUrl(url) {
  try { return hostMatches(new URL(String(url || '')).hostname, VIDEO_HOSTS.taptap); }
  catch (e) { return false; }
}

function isDouyinUrl(url) {
  try { return hostMatches(new URL(String(url || '')).hostname, VIDEO_HOSTS.douyin); }
  catch (e) { return false; }
}

function isXiaohongshuUrl(url) {
  try { return hostMatches(new URL(String(url || '')).hostname, VIDEO_HOSTS.xiaohongshu); }
  catch (e) { return false; }
}

function normalizeProxyUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 2048 || /[\r\n\t\0 ]/.test(raw)) {
    throw new Error('代理地址格式无效，不能包含空格或换行');
  }
  if (!raw.includes('://')) raw = `http://${raw}`;

  let parsed;
  try { parsed = new URL(raw); }
  catch (e) { throw new Error('代理地址格式无效，请检查主机和端口'); }
  const allowed = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
  if (!allowed.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('代理类型不受支持，请使用软件支持的网页代理或套接字代理格式');
  }
  return parsed.href;
}

function normalizeSystemProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('=')) {
    const entries = Object.fromEntries(raw.split(';').map(part => {
      const idx = part.indexOf('=');
      return idx > 0 ? [part.slice(0, idx).toLowerCase(), part.slice(idx + 1)] : ['', ''];
    }).filter(([key, val]) => key && val));
    return normalizeProxyUrl(entries.https || entries.http || entries.socks || '');
  }
  return normalizeProxyUrl(raw);
}

function isLikelyYouTubeThrottleError(msg) {
  const s = String(msg || '');
  return [
    "Sign in to confirm you're not a bot",
    'HTTP Error 429',
    'Status code 429',
    'HTTP Error 403',
    'Status code 403',
    '--cookies-from-browser',
    'confirm your age',
    'Requested format is not available',
  ].some(k => s.includes(k));
}

function getEffectiveProxy() {
  const s = getSettings();
  try {
    if (s.proxyUrl) return normalizeProxyUrl(s.proxyUrl);
    if (_systemProxy) return normalizeProxyUrl(_systemProxy);
    return normalizeProxyUrl(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
  } catch (e) {
    debugLog(`[PROXY] Ignored invalid proxy: ${e.message}`);
    return '';
  }
}

function ytdlpArgs(extra = [], options = {}) {
  const proxy = getEffectiveProxy();
  const settings = getSettings();
  const isDownload = options.forDownload;
  const args = ['--no-warnings', '--no-playlist'];

  if (isDownload) {
    // Download mode: reliability-oriented retries and timeouts
    args.push(
      '--retries', '10', '--fragment-retries', '15', '--file-access-retries', '5',
      '--retry-sleep', 'fragment:2', '--retry-sleep', 'extractor:5', '--retry-sleep', 'http:3',
      '--socket-timeout', '30', '--throttled-rate', '100K',
      '--progress', '--newline',
    );
    const useAria = settings.useAria2c !== false && aria2cPath && !options.noAria;
    if (useAria) {
      args.push('--external-downloader', aria2cPath);
      let ariaArgs = 'aria2c:-x 16 -s 16 -k 2M --min-split-size=1M --max-connection-per-server=16 --continue=true --file-allocation=none --connect-timeout=30 --timeout=30 --retry-wait=3 --max-tries=10 --summary-interval=2';
      if (proxy) ariaArgs += ` --all-proxy=${proxy}`;
      args.push('--external-downloader-args', ariaArgs);
    } else {
      const fragmentCount = options.isYouTube ? 4 : (settings.concurrentFragments || 8);
      args.push('--concurrent-fragments', String(fragmentCount));
    }
  } else {
    // Info mode: lightweight, fail fast
    args.push('--socket-timeout', '15');
  }

  args.push(...getCookieArgs(extra));
  if (proxy) args.push('--proxy', proxy);
  if (extra) args.push(...extra);
  return args;
}

function terminateProcessTree(proc) {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) { resolve(); return; }
    if (process.platform !== 'win32') {
      try { proc.kill('SIGTERM'); } catch (e) {}
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(proc.pid), '/f', '/t'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('close', done);
      killer.once('error', () => {
        try { proc.kill(); } catch (e) {}
        done();
      });
      setTimeout(() => {
        try { proc.kill(); } catch (e) {}
        done();
      }, 1500);
    } catch (e) {
      try { proc.kill(); } catch (err) {}
      done();
    }
  });
}
// Path resolution: in development mode (electron .), __dirname is the project root.
// In packaged mode, binaries must sit next to the .exe.
const APP_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const USER_DATA_DIR = app.getPath('userData');
const BILIBILI_COOKIES_FILE = path.join(USER_DATA_DIR, 'B站登录信息.txt');
const YOUTUBE_COOKIES_FILE = path.join(USER_DATA_DIR, 'YouTube登录信息.txt');
const XHS_COOKIES_FILE = path.join(USER_DATA_DIR, '小红书访问凭据.txt');
const MANAGED_COOKIES_FILE = path.join(USER_DATA_DIR, '登录信息.txt');
const LEGACY_MANAGED_COOKIES_FILE = path.join(USER_DATA_DIR, 'cookies.txt');
const APP_COOKIES_FILE = path.join(APP_DIR, '登录信息.txt');
const LEGACY_COOKIES_FILE = path.join(APP_DIR, 'cookies.txt');
const YTDLP_PATH = path.join(APP_DIR, 'yt-dlp.exe');

const COOKIE_PLATFORM_DOMAINS = {
  bilibili: ['bilibili.com'],
  youtube: ['youtube.com', 'youtu.be', 'googlevideo.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com'],
};

function parseNetscapeCookieLine(line) {
  const value = String(line || '').trim();
  const isHttpOnly = value.startsWith('#HttpOnly_');
  if (!value || (value.startsWith('#') && !isHttpOnly)) return null;
  const cookieValue = isHttpOnly ? value.slice('#HttpOnly_'.length) : value;
  const parts = cookieValue.split('\t');
  if (parts.length < 7) return null;
  return { line: value, parts, domain: parts[0].replace(/^\./, '').toLowerCase() };
}

function cookieLineMatchesPlatform(line, platform) {
  const parsed = parseNetscapeCookieLine(line);
  const domains = COOKIE_PLATFORM_DOMAINS[platform] || [];
  return !!parsed && hostMatches(parsed.domain, domains);
}

function readCookieLines(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try { return fs.readFileSync(filePath, 'utf8').split(/\r?\n/); }
  catch (error) { return []; }
}

function writePlatformCookieFile(filePath, platformLabel, lines) {
  const unique = new Map();
  for (const line of lines) {
    const parsed = parseNetscapeCookieLine(line);
    if (!parsed) continue;
    const expiresAt = Number(parsed.parts[4]);
    if (expiresAt > 0 && expiresAt < Math.floor(Date.now() / 1000)) continue;
    const key = parsed.parts[0].toLowerCase() + '|' + parsed.parts[2] + '|' + parsed.parts[5];
    unique.set(key, parsed.line);
  }
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const header = '# Netscape HTTP Cookie File\n# ' + platformLabel
    + '登录凭据，由视频下载神器管理，请勿公开分享。\n';
  fs.writeFileSync(filePath, header + [...unique.values()].join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try { fs.chmodSync(filePath, 0o600); } catch (error) {}
}

function migrateLegacyCookieFiles() {
  const legacyFiles = [
    MANAGED_COOKIES_FILE,
    LEGACY_MANAGED_COOKIES_FILE,
    APP_COOKIES_FILE,
    LEGACY_COOKIES_FILE,
  ].filter((file, index, list) => existsSync(file) && list.indexOf(file) === index);
  const targets = [
    ['bilibili', 'B站', BILIBILI_COOKIES_FILE],
    ['youtube', 'YouTube', YOUTUBE_COOKIES_FILE],
    ['xiaohongshu', '小红书', XHS_COOKIES_FILE],
  ];

  for (const [platform, label, target] of targets) {
    const existing = readCookieLines(target).filter(line => cookieLineMatchesPlatform(line, platform));
    const migrated = legacyFiles.flatMap(readCookieLines)
      .filter(line => cookieLineMatchesPlatform(line, platform));
    if (existing.length === 0 && migrated.length === 0) continue;
    writePlatformCookieFile(target, label, [...migrated, ...existing]);
    debugLog('[COOKIES] ' + label + ' credentials are stored separately in protected app data');
  }
}

function getPlatformCookieFile(platform) {
  const target = platform === 'bilibili'
    ? BILIBILI_COOKIES_FILE
    : platform === 'youtube'
      ? YOUTUBE_COOKIES_FILE
      : (platform === 'xiaohongshu' ? XHS_COOKIES_FILE : '');
  if (!target || !existsSync(target)) return '';
  return readCookieLines(target).some(line => cookieLineMatchesPlatform(line, platform)) ? target : '';
}

function execYtdlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, ytdlpArgs(args), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = options.timeout ? setTimeout(() => {
      timedOut = true;
      terminateProcessTree(proc).catch(() => {});
      reject(new Error(options.timeoutMsg || '操作超时'));
    }, options.timeout) : null;
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) resolve(stdout.trim());
      else {
        const errMsg = stderr.trim() || `yt-dlp exited with code ${code}`;
        debugLog(`[YTDLP] exit=${code} args=${args.slice(0, 4).join(' ')} err=${errMsg.substring(0, 300)}`);
        reject(new Error(errMsg));
      }
    });
    proc.on('error', e => {
      if (timer) clearTimeout(timer);
      if (timedOut) return;
      debugLog(`[YTDLP] spawn error: ${e.message.substring(0, 200)}`);
      reject(e);
    });
  });
}

// yt-dlp download with progress tracking (for HLS/native downloads like TapTap)
function execYtdlpWithProgress(args, task) {
  return new Promise((resolve, reject) => {
    // Disable external downloader (aria2c) for Bilibili HLS downloads —
    // when aria2c handles HLS fragments, yt-dlp does not output [download]
    // progress lines. yt-dlp's built-in fragment downloader always outputs
    // per-fragment [download] progress, giving smooth progress updates.
    const isBilibili = args.some(a => typeof a === 'string' && /bilibili\.com|b23\.tv/i.test(a));
    const isYouTube = args.some(a => typeof a === 'string' && /youtube\.com|youtu\.be|music\.youtube\.com|m\.youtube\.com/i.test(a));
    const ytArgs = ytdlpArgs(args, { forDownload: true, noAria: isBilibili, isYouTube });
    if (isBilibili) {
      const cfIdx = ytArgs.indexOf('--concurrent-fragments');
      if (cfIdx !== -1) ytArgs[cfIdx + 1] = '32';
      const trIdx = ytArgs.indexOf('--throttled-rate');
      if (trIdx !== -1) ytArgs.splice(trIdx, 2);
      ytArgs.push('--add-header', 'Referer:https://www.bilibili.com/');
      ytArgs.push('--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    }
    const proc = spawn(YTDLP_PATH, ytArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    nativeDownloadProcs.set(task.id, proc);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let idleTimer = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(proc).catch(() => {});
        nativeDownloadProcs.delete(task.id);
        reject(new Error('下载长时间没有响应，请检查网络或代理后重试'));
      }, 180000);
    };
    resetIdleTimer();

    // Parse progress from yt-dlp output. HLS/native downloads write progress
    // to stdout; regular downloads (when routed through here) use stderr.
    function parseProgress(text) {
      let progressUpdated = false;
      // yt-dlp may use \r (carriage return) to overwrite progress lines when output is not TTY.
      // Split by both \r and \n to capture every progress update.
      const rawLines = text.split(/[\r\n]+/).filter(Boolean);
      for (const line of rawLines) {
        if (!/\[download\]\s+\d+\.?\d*%/.test(line)) continue;
        const pctMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (pctMatch) task.progress.percent = parseFloat(pctMatch[1]);
        const sizeMatch = line.match(/of\s+~?\s*([\d.]+[KMGT]?i?B)/);
        if (sizeMatch) task.progress.totalSize = sizeMatch[1];
        const speedMatch = line.match(/at\s+([\d.]+[KMGT]?i?B\/s)/);
        if (speedMatch) task.progress.speed = speedMatch[1];
        const etaMatch = line.match(/ETA\s+([\d:]+)/);
        if (etaMatch) task.progress.eta = etaMatch[1];
        progressUpdated = true;
      }
      if (progressUpdated) {
        const now = Date.now();
        if (!task._lastEmit || now - task._lastEmit >= 300) {
          const newPct = task.progress.percent;
          const newSpeed = task.progress.speed;
          if (newPct !== task._lastPct || newSpeed !== task._lastSpeed) {
            emitQueue();
            sendToWindow('download-progress', task.id, { ...task.progress });
            task._lastEmit = now;
            task._lastPct = newPct;
            task._lastSpeed = newSpeed;
          }
        }
      }
    }

    proc.stdout.on('data', d => {
      resetIdleTimer();
      const text = d.toString();
      stdout += text;
      parseProgress(text);
    });
    proc.stderr.on('data', d => {
      resetIdleTimer();
      const text = d.toString();
      stderr += text;
      parseProgress(text);
    });

    proc.on('close', code => {
      if (idleTimer) clearTimeout(idleTimer);
      nativeDownloadProcs.delete(task.id);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error((stderr || stdout).trim() || `yt-dlp exited with code ${code}`));
    });
    proc.on('error', e => {
      if (idleTimer) clearTimeout(idleTimer);
      nativeDownloadProcs.delete(task.id);
      reject(e);
    });
  });
}

// ========== External Tool Detection ==========

function commandAvailable(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    return true;
  } catch (error) {
    return false;
  }
}

function detectFfmpeg() {
  const candidates = [
    path.join(APP_DIR, 'ffmpeg.exe'),
    path.resolve(APP_DIR, '..', 'ffmpeg.exe'),
    path.resolve(APP_DIR, '..', '..', 'ffmpeg.exe'),
  ];
  const bundled = candidates.find(file => existsSync(file));
  if (bundled) return bundled;
  return commandAvailable('ffmpeg', ['-version']) ? 'ffmpeg' : null;
}

function detectFfprobe() {
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    const bundled = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
    if (existsSync(bundled)) return bundled;
  }
  return commandAvailable('ffprobe', ['-version']) ? 'ffprobe' : null;
}

function detectAria2c() {
  const candidates = [
    path.join(APP_DIR, 'aria2c.exe'),
    path.resolve(APP_DIR, '..', 'aria2c.exe'),
    path.resolve(APP_DIR, '..', '..', 'aria2c.exe'),
  ];
  const bundled = candidates.find(file => existsSync(file));
  if (bundled) return bundled;
  return commandAvailable('aria2c', ['--version']) ? 'aria2c' : null;
}

const ffmpegPath = detectFfmpeg();
const ffprobePath = detectFfprobe();
const aria2cPath = detectAria2c();


function detectCookiePlatform(values) {
  const args = Array.isArray(values) ? values : [values];
  for (const value of args) {
    if (typeof value !== 'string') continue;
    if (isBilibiliUrl(value)) return 'bilibili';
    if (isYouTubeUrl(value)) return 'youtube';
    if (isXiaohongshuUrl(value)) return 'xiaohongshu';
  }
  return '';
}

function getCookieArgs(values) {
  const platform = detectCookiePlatform(values);
  const cookiesFile = getPlatformCookieFile(platform);
  if (cookiesFile) {
    debugLog(`[COOKIES] Using ${path.basename(cookiesFile)} for ${platform}`);
    return ['--cookies', cookiesFile];
  }
  debugLog(`[COOKIES] No cookie file configured for ${platform || 'this platform'}`);
  return [];
}

function getBilibiliSessdata() {
  const cookiesFile = getPlatformCookieFile('bilibili');
  if (!cookiesFile) return null;
  try {
    const content = fs.readFileSync(cookiesFile, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7 && parts[5] === 'SESSDATA' && parts[0].includes('bilibili.com')) {
        return parts[6];
      }
    }
  } catch (e) { /* no usable cookie file */ }
  return null;
}
// ========== Bilibili QR Login ==========

// Parse Set-Cookie header value into { name, value, domain, path, expires }
function parseSetCookie(setCookieStr) {
  const parts = setCookieStr.split(';').map(s => s.trim());
  const firstEq = parts[0].indexOf('=');
  if (firstEq === -1) return null;
  const name = parts[0].slice(0, firstEq);
  const value = parts[0].slice(firstEq + 1);
  let domain = '', path = '/', expires = 0;
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    const k = eq === -1 ? parts[i] : parts[i].slice(0, eq);
    const v = eq === -1 ? '' : parts[i].slice(eq + 1);
    if (k.toLowerCase() === 'domain') domain = v;
    else if (k.toLowerCase() === 'path') path = v;
    else if (k.toLowerCase() === 'expires') expires = Math.floor(new Date(v).getTime() / 1000) || 0;
  }
  if (!expires) expires = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days default
  return { name, value, domain, path, expires };
}

// Save B站 Set-Cookie headers to the dedicated Netscape cookie file.
function normalizeCookieDomain(domain) {
  const value = String(domain || '.bilibili.com').trim().toLowerCase();
  return value.startsWith('.') ? value : `.${value}`;
}

function saveBilibiliCookies(setCookieList) {
  const sourceFile = getPlatformCookieFile('bilibili') || BILIBILI_COOKIES_FILE;
  let existingLines = [];
  try {
    if (sourceFile) existingLines = fs.readFileSync(sourceFile, 'utf8').split('\n');
  } catch (e) { /* start with an empty cookie jar */ }

  const newEntries = [];
  for (const sc of setCookieList) {
    const parsed = parseSetCookie(sc);
    if (!parsed || !parsed.name) continue;
    parsed.domain = normalizeCookieDomain(parsed.domain);
    if (!hostMatches(parsed.domain.replace(/^\./, ''), ['bilibili.com'])) continue;
    newEntries.push(parsed);
  }
  if (newEntries.length === 0) throw new Error('登录响应中没有可保存的有效凭据');

  const newNames = new Set(newEntries.map(e => `${normalizeCookieDomain(e.domain)}|${e.name}`));
  const keptLines = existingLines.filter(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true;
    const parts = t.split('\t');
    if (parts.length < 7) return true;
    const key = `${normalizeCookieDomain(parts[0])}|${parts[5]}`;
    return !newNames.has(key);
  });

  const netscapeLines = newEntries.map(e => [
    normalizeCookieDomain(e.domain), 'TRUE', e.path || '/', 'TRUE',
    String(e.expires), e.name, e.value,
  ].join('\t'));
  const oldBody = keptLines.filter(l => l.trim() && !l.trim().startsWith('#'));
  writePlatformCookieFile(BILIBILI_COOKIES_FILE, 'B站', [...netscapeLines, ...oldBody]);
  debugLog(`[COOKIES] Saved ${newEntries.length} Bilibili credential item(s) in app data`);
}
// Start B站 QR login: returns { qrcodeUrl, qrcodeKey }
async function startBilibiliLogin() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'passport.bilibili.com',
      path: '/x/passport-login/web/qrcode/generate',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error('B站登录服务暂时不可用，请稍后重试'));
        return;
      }
      let data = '';
      res.on('data', c => {
        if (data.length < 1024 * 1024) data += c;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data) {
            debugLog('[BILI-LOGIN] QR code generated');
            resolve({ qrcodeUrl: json.data.url, qrcodeKey: json.data.qrcode_key });
          } else {
            reject(new Error(json.message || '获取二维码失败'));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('获取登录二维码超时')));
    req.on('error', reject);
    req.end();
  });
}

// Poll B站 QR scan status
// Returns: { status: 'pending'|'scanned'|'confirmed'|'expired', nickname?: string }
async function pollBilibiliLogin(qrcodeKey) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'passport.bilibili.com',
      path: `/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error('B站登录服务暂时不可用，请稍后重试'));
        return;
      }
      let data = '';
      const setCookies = [];
      if (res.headers['set-cookie']) {
        const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
        setCookies.push(...raw);
      }
      res.on('data', c => {
        if (data.length < 1024 * 1024) data += c;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && setCookies.length > 0) {
            // Login confirmed — save cookies
            saveBilibiliCookies(setCookies);
            debugLog('[BILI-LOGIN] Login success, cookies saved');
            resolve({ status: 'confirmed' });
          } else if (json.code === 86090) {
            resolve({ status: 'scanned', nickname: json.data?.nickname || '' });
          } else if (json.code === 86038) {
            resolve({ status: 'expired' });
          } else {
            resolve({ status: 'pending' });
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('检查登录状态超时')));
    req.on('error', reject);
    req.end();
  });
}

// Check if B站 login is active
function getBilibiliLoginStatus() {
  const sessdata = getBilibiliSessdata();
  if (!sessdata) return { loggedIn: false };
  // Rough expiry check from the dedicated B站 cookie file.
  try {
    const cookiesFile = getPlatformCookieFile('bilibili');
    if (!cookiesFile) return { loggedIn: false };
    const content = fs.readFileSync(cookiesFile, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7 && parts[5] === 'SESSDATA' && parts[0].includes('bilibili.com')) {
        const expires = parseInt(parts[4], 10);
        const expired = expires > 0 && Date.now() / 1000 > expires;
        return { loggedIn: true, expired, expiresAt: expires };
      }
    }
  } catch (e) { /* ignore */ }
  return { loggedIn: !!sessdata, expired: false };
}

// Logout Bilibili without touching YouTube credentials.
function logoutBilibili() {
  writePlatformCookieFile(BILIBILI_COOKIES_FILE, 'B站', []);

  _bilibiliQualityCache.clear();
  debugLog('[BILI-LOGIN] Logout: Bilibili credentials removed from active cookie jar');
  return { ok: true };
}
// ========== System Proxy Auto-Detection ==========

function detectSystemProxyAsync() {
  if (_systemProxyPromise) return _systemProxyPromise;
  _systemProxyPromise = new Promise((resolve) => {
    const script = Buffer.from(
      "$ProgressPreference='SilentlyContinue'; " +
      "try { $r = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; " +
      "if ($r.ProxyEnable -eq 1 -and $r.ProxyServer) { Write-Output $r.ProxyServer } else { exit 1 } } catch { exit 1 }",
      'utf16le',
    ).toString('base64');
    const powershellPath = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';

    execFile(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', script],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
      (error, stdout) => {
        if (error) { _systemProxy = ''; resolve(''); return; }
        const raw = String(stdout || '').split('\n')
          .map(line => line.trim())
          .find(line => line && !line.startsWith('#') && !line.startsWith('<')) || '';
        try { _systemProxy = normalizeSystemProxy(raw); }
        catch (e) { _systemProxy = ''; }
        resolve(_systemProxy);
      },
    );
  });
  return _systemProxyPromise;
}

function setGlobalProxy(proxyUrl) {
  if (_appliedProxy) {
    if (process.env.HTTP_PROXY === _appliedProxy) delete process.env.HTTP_PROXY;
    if (process.env.HTTPS_PROXY === _appliedProxy) delete process.env.HTTPS_PROXY;
    _appliedProxy = '';
  }
  if (!proxyUrl) return;

  const normalized = normalizeProxyUrl(proxyUrl);
  process.env.HTTP_PROXY = normalized;
  process.env.HTTPS_PROXY = normalized;
  process.env.NO_PROXY = '<local>';
  _appliedProxy = normalized;
}

async function applySessionProxy(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl || '');
  setGlobalProxy(normalized);
  if (!session.defaultSession) return;
  if (normalized) {
    await session.defaultSession.setProxy({
      proxyRules: normalized,
      proxyBypassRules: '<local>',
    });
  } else {
    await session.defaultSession.setProxy({ mode: 'system' });
  }
}
// ========== ytdl Error Translation ==========
function sanitizeErrorMsg(msg) {
  if (!msg) return '';
  let s = msg;
  // Normalize non-ASCII curly quotes / smart apostrophes to ASCII
  // YouTube error messages can contain U+2019 (') in "you're" etc.
  s = s.replace(/[‘’‚‛ʼ＇]/g, "'");
  s = s.replace(/[“”„‟]/g, '"');
  // Strip Electron IPC wrappers
  s = s.replace(/^Error\s*:?[ ]*(?:invoking remote method|occurred while handling).*?Error:\s*/i, '');
  // Strip yt-dlp ERROR: prefix
  s = s.replace(/^ERROR:\s*/i, '');
  // Strip URLs (especially GitHub links in yt-dlp errors)
  s = s.replace(/https?:\/\/[^\s]+/g, '');
  // Strip ANSI escape sequences
  s = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  // Strip leading brackets like [youtube], [youtube:truncated_id] or [generic]
  s = s.replace(/^\[[\w:]+\]\s*/, '');
  // Strip trailing GitHub/generic pointers
  s = s.replace(/\s*See\s+https?:\/\/[^\s]+.*$/i, '');
  s = s.replace(/\s*This\s+error\s+is\s+from\s+.*$/i, '');
  return s.trim();
}

function translateError(msg) {
  if (!msg) return '未知错误';
  const clean = sanitizeErrorMsg(msg);
  const map = {
    // ── 登录验证 / Cookie / Bot 检查 ──
    "Sign in to confirm you're not a bot":
      '请求被 YouTube 拦截，需要登录验证。可能是短时间请求过于频繁、当前网络环境受限或缺少有效登录信息。请间隔一到两小时后重试；如仍频繁出现，可将从已登录浏览器导出的账号信息保存为“登录信息.txt”并放到软件目录。',
    'Fresh cookies (not necessarily logged in) are needed':
      '抖音需要新的匿名访问凭据。软件会自动创建隔离的抖音访问会话；如仍失败，请先在浏览器中打开该视频确认可以播放，再返回软件重试。',
    'Failed to decrypt with DPAPI':
      '无法读取浏览器登录信息，可能是浏览器启用了密码保护或系统解密失败。请手动导出 YouTube 账号信息，保存为“登录信息.txt”并放到软件目录后重试。',
    'Could not copy Chrome cookie database':
      '无法读取浏览器登录信息，可能是浏览器正在运行、数据被占用或权限不足。请关闭浏览器后重试，或手动导出 YouTube 账号信息并保存为“登录信息.txt”。',
    'Sign in to confirm your age':
      '该视频需要年龄验证，必须提供已登录且符合年龄要求的 YouTube 账号信息。请从已登录浏览器导出账号信息，保存为“登录信息.txt”并放到软件目录后重试。',
    'confirm your age':
      '该视频需要年龄验证，必须提供已登录且符合年龄要求的 YouTube 账号信息。请从已登录浏览器导出账号信息，保存为“登录信息.txt”并放到软件目录后重试。',

    // ── 视频不可用 / 已被移除 ──
    'Video unavailable':
      '视频无法访问。可能原因：视频已被上传者删除、设为私密、或因版权等原因被下架。建议操作：检查链接是否正确，或换一个视频重试。',
    'This video is unavailable':
      '视频无法访问。可能原因：视频已被删除、设为私密或受版权保护。建议操作：确认链接是否有效，或换一个视频重试。',
    'This video is not available':
      '视频无法访问。可能原因：视频已被删除、设为私密或受版权保护。建议操作：确认链接是否有效，或换一个视频重试。',
    'Private video':
      '这是一个私人视频，无法访问。只有上传者或被邀请的用户才能观看。',
    'No video id found':
      '无法从链接中识别出视频 ID。可能原因：链接格式不正确，或不是标准的 YouTube 视频链接。建议操作：复制浏览器地址栏中完整的 YouTube 视频链接再试。',
    'not a valid YouTube video ID':
      '无法从链接中识别出视频 ID。可能原因：链接格式不正确，或不是标准的 YouTube 视频链接。建议操作：复制浏览器地址栏中完整的 YouTube 视频链接再试。',
    'No such video':
      '该视频不存在。可能原因：链接已失效、视频已被删除或 ID 不正确。建议操作：确认链接是否正确。',
    'Video too long':
      '视频过长，无法解析。YouTube 对过长的视频有解析限制。',

    // ── 版权限制 ──
    'Copyright':
      '该视频受版权保护，无法下载。可能原因：上传者或版权方限制了该视频的下载。建议操作：可尝试在线观看，或换一个视频下载。',
    'copyright':
      '该视频受版权保护，无法下载。可能原因：上传者或版权方限制了该视频的下载。建议操作：可尝试在线观看，或换一个视频下载。',

    // ── 网络连接异常 ──
    'Connect Timeout':
      '连接 YouTube 超时。可能原因：当前网络到 YouTube 的连接不稳定、或 YouTube 暂时繁忙。建议操作：检查网络连接；如使用代理，请在软件代理设置中配置代理地址；稍后重试。',
    'connect ETIMEDOUT':
      '连接 YouTube 超时。可能原因：当前网络到 YouTube 的连接不稳定、或 YouTube 暂时繁忙。建议操作：检查网络连接；如使用代理，请在软件代理设置中配置代理地址；稍后重试。',
    'connect ECONNREFUSED':
      '连接被拒绝。可能原因：网络防火墙阻止了连接、或代理地址配置有误。建议操作：检查网络和代理设置后重试。',
    'connect ENETUNREACH':
      '网络不可达。可能原因：网络连接已断开、或 DNS 解析异常。建议操作：检查网络连接是否正常，稍后重试。',
    'getaddrinfo':
      'DNS 解析失败，无法解析 YouTube 的服务器地址。可能原因：DNS 服务异常或网络配置问题。建议操作：检查网络连接，或尝试更换 DNS 服务器后重试。',
    'Incomplete Read':
      '网络连接中断，数据读取不完整。可能原因：网络不稳定、代理连接异常、或 YouTube 服务器响应中断。建议操作：检查网络和代理设置后重试。',
    'urlopen error':
      '网络请求失败。可能原因：网络连接不稳定、代理配置有误、或无法连接到 YouTube。建议操作：检查网络连接和代理设置后重试。',
    'URLError':
      '网络请求失败。可能原因：网络连接不稳定、代理配置有误、或无法连接到 YouTube。建议操作：检查网络连接和代理设置后重试。',
    'No connection could be made':
      '无法建立网络连接。可能原因：目标服务器不可达、代理配置有误、或防火墙阻止了连接。建议操作：检查网络和代理设置后重试。',

    // ── HTTP 状态码错误 ──
    'Status code 502':
      'YouTube 服务暂时不可用（502）。可能原因：YouTube 服务器临时故障或正在维护。建议操作：请稍后重试。',
    'Status code 503':
      'YouTube 服务暂时不可用（503）。可能原因：YouTube 服务器繁忙或正在维护。建议操作：请等待几分钟后再试。',
    'Status code 504':
      'YouTube 网关超时（504）。可能原因：YouTube 服务器响应超时，可能是网络波动或服务器负载过高。建议操作：请稍后重试。',
    'Status code 410':
      '视频信息已过期（410）。可能原因：该视频链接已失效、或 YouTube 上的信息已被更新。建议操作：刷新后重试。',
    'Status code 404':
      '视频不存在（404）。可能原因：链接错误或视频已被删除。建议操作：检查链接是否正确。',
    'Status code 403':
      '访问被拒绝（403）。可能原因：当前平台限制了该视频、直链已过期、存在地区限制或代理异常。请重新获取视频信息；如仍失败，请检查网络与代理。',
    'HTTP Error 403':
      '访问被拒绝（403）。可能原因：当前平台限制了该视频、直链已过期、存在地区限制或代理异常。请重新获取视频信息；如仍失败，请检查网络与代理。',
    'HTTP Error 429':
      '请求过于频繁（429）。当前平台已触发频率限制，请等待几分钟后再试。',
    'Status code 429':
      '请求过于频繁（429）。当前平台已触发频率限制，请等待几分钟后再试。',
    'HTTP Error 5':
      '平台服务暂时不可用（5xx），可能是服务器故障或网络波动，请等待几分钟后重试。',
    'Status code 5':
      '平台服务暂时不可用（5xx），可能是服务器故障或网络波动，请等待几分钟后重试。',

    // ── 格式 / 解析异常 ──
    'Requested format is not available':
      '请求的画质格式不可用。可能原因：该视频没有当前选择的画质。建议操作：选择其他画质后重试。',
    'Unable to extract':
      '无法解析该视频的信息。可能原因：平台页面结构已更新、视频受限或链接格式特殊。请重新复制链接后重试。',
    'No audio formats found':
      '未找到可下载的音频格式。可能原因：该视频不包含独立的音频流。建议操作：可尝试下载包含音频的视频格式。',
    'No video formats found':
      '未找到可下载的视频格式。可能原因：该视频可能是纯音频内容。建议操作：可以选择仅下载音频。',
    'No formats found':
      '未找到任何可下载的格式。可能原因：该视频格式特殊或受到了限制。建议操作：换一个视频重试。',

    // ── 链接格式异常 ──
    'Unsupported URL':
      '不支持该链接。当前支持 YouTube、B站、TapTap、抖音和小红书；抖音、小红书可粘贴完整分享口令。',
    'Unsupported url scheme':
      '链接协议格式不正确，请重新复制完整链接；抖音、小红书也可以直接粘贴包含分享网址的完整口令。',
    'unknown url type':
      '链接协议格式不正确，请确认链接包含完整的网页地址。',
    'not a valid URL':
      '链接格式无效，请复制完整链接；抖音、小红书可直接粘贴完整分享口令。',
    'URL looks truncated':
      '链接不完整或格式不正确，请重新复制完整链接，或完整的抖音、小红书分享口令。',

    // ── 通用请求异常（放在 URL/HTTP 之后，避免覆盖更具体的匹配） ──
    'Unable to handle request':
      '无法处理该请求，可能是链接格式、网络代理或平台限制导致。请检查链接和网络后重试。',

    // ── 其他 ──
    'UNKNOWN':
      '请求失败，请检查网络或稍后重试。',
    'ffmpeg':
      '缺少高清合并组件，无法合并音视频。请重新安装完整的软件后重试。',
    'aria2 RPC':
      '多线程下载组件连接失败，可能是加速进程未正常启动或意外退出。请重启软件后重试。',
    'timeout':
      '下载组件连接超时，可能是加速进程未启动、意外退出或网络连接异常。请重启软件后重试；如频繁出现，请检查网络和代理设置。',

    // ── 兜底：yt-dlp 建议文本中的 cookies 提示（匹配优先级最末） ──
    '--cookies-from-browser':
      '请求被平台限制，可能是网络环境、访问频率或登录信息失效。请稍后重试；如视频需要账号权限，请更新软件使用的“登录信息.txt”。',
  };
  for (const [key, val] of Object.entries(map)) {
    if (clean.includes(key) || msg.includes(key)) return val;
  }
  // Fallback: remove English prefixes from raw error
  let fallback = clean
    .replace(/^Error\s*:\s*/i, '')
    .replace(/^ERROR\s*:\s*/i, '')
    .trim();
  if (/[㐀-鿿]/.test(fallback)) return fallback;
  if (fallback) debugLog(`[ERROR] Untranslated external error: ${fallback.substring(0, 300)}`);
  return '操作失败，请检查网络、代理或链接后重试；如仍失败，请重启软件。';
}

function toChineseServiceError(error, action = '操作') {
  const clean = sanitizeErrorMsg(error?.message || error || '');
  if (/[㐀-鿿]/.test(clean)) return clean;
  if (clean) debugLog(`[ERROR] ${action}: ${clean.substring(0, 300)}`);
  return `${action}失败，请检查网络或代理设置后重试`;
}
// --- Paths ---
const HISTORY_FILE = path.join(USER_DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(USER_DATA_DIR, 'settings.json');
const DEBUG_LOG_PATH = path.join(USER_DATA_DIR, 'debug_download.log');

// Throttled debug log — batched and asynchronous so progress updates never block the UI.
const _debugBuf = [];
let _debugTimer = null;
let _debugWriting = false;
try {
  if (existsSync(DEBUG_LOG_PATH) && statSync(DEBUG_LOG_PATH).size > 5 * 1024 * 1024) {
    const oldLog = DEBUG_LOG_PATH + '.old';
    try { if (existsSync(oldLog)) unlinkSync(oldLog); } catch (e) {}
    fs.renameSync(DEBUG_LOG_PATH, oldLog);
  }
} catch (e) {}

function debugLog(msg) {
  _debugBuf.push(`[${new Date().toISOString()}] ${msg}`);
  if (_debugBuf.length >= 20) { _flushDebug(); return; }
  if (!_debugTimer) _debugTimer = setTimeout(_flushDebug, 500);
}

function _flushDebug() {
  _debugTimer = null;
  if (_debugWriting || _debugBuf.length === 0) return;
  _debugWriting = true;
  const batch = _debugBuf.splice(0, _debugBuf.length).join('\n') + '\n';
  fs.appendFile(DEBUG_LOG_PATH, batch, (error) => {
    _debugWriting = false;
    if (error) return;
    if (_debugBuf.length > 0 && !_debugTimer) _debugTimer = setTimeout(_flushDebug, 100);
  });
}

// --- State ---
function getMaxConcurrentDownloads() {
  const n = Number(getSettings()?.maxConcurrentDownloads);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(3, Math.floor(n)));
}
let mainWindow = null;
let downloadQueue = [];
let activeTaskIds = new Set();
let downloadStates = new Map(); // taskId -> { videoGid, audioGid, isDash, videoFile, audioFile, outputFile, connectTimer }
let nativeDownloadProcs = new Map(); // taskId -> ChildProcess (native yt-dlp downloads e.g. TapTap HLS)
let mediaMergeProcs = new Map(); // taskId -> ChildProcess (final audio/video merge)

// --- Aria2 RPC global state ---
const ARIA2_RPC_PORT_START = 16888;
let aria2RpcPort = ARIA2_RPC_PORT_START;
let aria2RpcSecret = '';
let aria2RpcProc = null;
let aria2RpcPollTimer = null;
let _aria2Restarting = false; // guard against concurrent restart attempts
let _pollInFlight = false;
let _shuttingDown = false;
let _emitQueuePending = false; // microtask debounce for emitQueue
let _settingsCache = null; // cache for getSettings()
let _historyCache = null; // cache for getHistory()
let _bilibiliQualityCache = new Map(); // bvid → cached quality tiers

// --- Default Settings ---
const DEFAULT_SETTINGS = {
  outputDir: app.getPath('downloads'),
  darkMode: false,
  audioOnly: false,
  subtitles: false,
  lastFormat: 'best',
  proxyUrl: '',
  concurrentFragments: 8,
  useAria2c: true,
  maxConcurrentDownloads: 2,
};

// ========== Helpers ==========

function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* ignore */ }
  return defaultVal;
}

function saveJSON(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    debugLog(`[STORAGE] Save failed for ${path.basename(file)}: ${e.message}`);
    return false;
  }
}

function sanitizeSettings(input, { strictProxy = false } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = { ...DEFAULT_SETTINGS };

  if (typeof source.outputDir === 'string' && source.outputDir.trim() && !source.outputDir.includes('\0')) {
    result.outputDir = path.resolve(source.outputDir.trim());
  }
  result.darkMode = source.darkMode === true;
  result.audioOnly = source.audioOnly === true;
  result.subtitles = source.subtitles === true;
  result.lastFormat = ['best', 'mp4', 'webm', 'mp3'].includes(source.lastFormat) ? source.lastFormat : 'best';
  result.concurrentFragments = Math.max(1, Math.min(32, Math.floor(Number(source.concurrentFragments) || 8)));
  result.useAria2c = source.useAria2c !== false;
  result.maxConcurrentDownloads = Math.max(1, Math.min(3, Math.floor(Number(source.maxConcurrentDownloads) || 2)));

  try {
    result.proxyUrl = normalizeProxyUrl(source.proxyUrl || '');
  } catch (e) {
    if (strictProxy) throw e;
    result.proxyUrl = '';
  }
  return result;
}

function getSettings() {
  if (_settingsCache) return _settingsCache;
  _settingsCache = sanitizeSettings(loadJSON(SETTINGS_FILE, {}));
  return _settingsCache;
}

function saveSettings(s, options = {}) {
  const sanitized = sanitizeSettings(s, options);
  if (!saveJSON(SETTINGS_FILE, sanitized)) throw new Error('设置保存失败，请检查软件数据目录是否可写');
  _settingsCache = sanitized;
  return sanitized;
}

function getHistory() {
  if (!_historyCache) _historyCache = loadJSON(HISTORY_FILE, []);
  return _historyCache;
}

function saveHistory(h) {
  _historyCache = h;
  return saveJSON(HISTORY_FILE, h);
}

function sendToWindow(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(1) + units[i];
}

function parseSizeBytes(s) {
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([KMGTP])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'K': return n * 1024;
    case 'M': return n * 1024 * 1024;
    case 'G': return n * 1024 * 1024 * 1024;
    case 'T': return n * 1024 * 1024 * 1024 * 1024;
    default: return n;
  }
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const units = ['B/s', 'K/s', 'M/s', 'G/s'];
  let i = 0, v = bps;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + units[i];
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.min(Math.floor(seconds), 99 * 3600 + 59 * 60 + 59);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function getOutputContainer(task) {
  if (task.options?.audioOnly || task.options?.formatId === 'audio') return 'mp3';
  if (task.options?.isImageCollection) return 'images';
  return task.options?.ext === 'webm' && isYouTubeUrl(task.url) ? 'webm' : 'mp4';
}

function validateDownloadRequest(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('下载参数无效，请重新获取视频信息');
  const url = normalizeVideoUrl(payload.url);
  const input = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const formatId = String(input.formatId || 'best');
  if (!/^[A-Za-z0-9_.:+/\[\]<>=-]{1,256}$/.test(formatId)) {
    throw new Error('画质参数无效，请重新选择画质');
  }

  const audioOnly = input.audioOnly === true || formatId === 'audio';
  const isImageCollection = input.isImageCollection === true
    && (isDouyinUrl(url) || isXiaohongshuUrl(url)) && !audioOnly;
  let ext = String(input.ext || 'mp4').toLowerCase();
  if (!['mp4', 'webm', 'mp3', 'images'].includes(ext)) ext = 'mp4';
  if (audioOnly) ext = 'mp3';
  if (isImageCollection) ext = 'images';
  if (!isYouTubeUrl(url) && ext === 'webm') ext = 'mp4';

  let outputDir = getSettings().outputDir;
  if (typeof input.outputDir === 'string' && input.outputDir.trim() && !input.outputDir.includes('\0')) {
    outputDir = path.resolve(input.outputDir.trim());
  }

  return {
    url,
    options: {
      formatId,
      formatNote: String(input.formatNote || '').slice(0, 200),
      resolutionLabel: String(input.resolutionLabel || '').slice(0, 100),
      ext,
      audioOnly,
      hasAudio: input.hasAudio === true,
      filesize: Math.max(0, Math.min(Number(input.filesize) || 0, Number.MAX_SAFE_INTEGER)),
      outputDir,
      title: String(input.title || '未知视频').slice(0, 500),
      isImageCollection,
      imageCount: isImageCollection ? Math.max(0, Math.min(100, Math.floor(Number(input.imageCount) || 0))) : 0,
      isNativeDownload: input.isNativeDownload === true || isBilibiliUrl(url) || isTapTapUrl(url) || audioOnly,
      playlistIndex: Math.max(1, Math.min(10000, Math.floor(Number(input.playlistIndex) || 1))),
    },
  };
}

function reserveOutputPath(task, outputDir, baseName, ext) {
  const normalizedDir = path.resolve(outputDir);
  const previous = task._plannedOutputFile;
  if (previous && path.dirname(previous).toLowerCase() === normalizedDir.toLowerCase()
      && path.extname(previous).toLowerCase() === `.${ext.toLowerCase()}`) {
    return previous;
  }

  const isReserved = candidate => {
    const key = candidate.toLowerCase();
    if (existsSync(candidate)) return true;
    return downloadQueue.some(other => other.id !== task.id && (
      String(other._plannedOutputFile || '').toLowerCase() === key
      || String(other.outputFile || '').toLowerCase() === key
    ));
  };

  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? '' : ` (${index})`;
    const candidate = path.join(normalizedDir, `${baseName}${suffix}.${ext}`);
    if (!isReserved(candidate)) {
      task._plannedOutputFile = candidate;
      return candidate;
    }
  }
  const fallback = path.join(normalizedDir, `${baseName} ${Date.now()}.${ext}`);
  task._plannedOutputFile = fallback;
  return fallback;
}

function reserveOutputDirectory(task, outputDir, baseName) {
  const normalizedDir = path.resolve(outputDir);
  const previous = task._plannedOutputFile;
  if (previous && path.dirname(previous).toLowerCase() === normalizedDir.toLowerCase()) {
    return previous;
  }

  const isReserved = candidate => {
    const key = candidate.toLowerCase();
    if (existsSync(candidate)) return true;
    return downloadQueue.some(other => other.id !== task.id && (
      String(other._plannedOutputFile || '').toLowerCase() === key
      || String(other.outputFile || '').toLowerCase() === key
    ));
  };

  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? '' : ` (${index})`;
    const candidate = path.join(normalizedDir, `${baseName}${suffix}`);
    if (!isReserved(candidate)) {
      task._plannedOutputFile = candidate;
      return candidate;
    }
  }
  const fallback = path.join(normalizedDir, `${baseName} ${Date.now()}`);
  task._plannedOutputFile = fallback;
  return fallback;
}
// ========== yt-dlp Video Info Fetching ==========

const DOUYIN_CACHE_MS = 5 * 60 * 1000;
const douyinFormatCache = new Map();
const douyinExtractionInFlight = new Map();

function normalizeDouyinMediaUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || !hostMatches(parsed.hostname, DOUYIN_MEDIA_HOSTS)) return '';
    return parsed.href;
  } catch (e) {
    return '';
  }
}

function normalizeDouyinImageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || !hostMatches(parsed.hostname, DOUYIN_IMAGE_HOSTS)) return '';
    return parsed.href;
  } catch (error) {
    return '';
  }
}

function pickDouyinImageUrl(image) {
  const urls = Array.isArray(image?.url_list) ? image.url_list : [];
  return urls.map(normalizeDouyinImageUrl).find(Boolean) || '';
}

function pickDouyinMediaUrl(address) {
  const urls = Array.isArray(address?.url_list) ? address.url_list
    .map(normalizeDouyinMediaUrl).filter(Boolean) : [];
  return urls.find(value => {
    try { return !hostMatches(new URL(value).hostname, VIDEO_HOSTS.douyin); }
    catch (e) { return false; }
  }) || urls[0] || '';
}
function getDouyinRateEdge(rate, video, address) {
  const width = Math.max(0, Number(address?.width || rate?.width) || 0);
  const height = Math.max(0, Number(address?.height || rate?.height) || 0);
  if (width > 0 && height > 0) return Math.min(width, height);

  const name = [rate?.gear_name, rate?.quality_type, rate?.quality_label]
    .filter(Boolean).join('_').toLowerCase();
  if (/(?:^|[_-])(?:2k|1440p?)(?:[_-]|$)/.test(name)) return 1440;
  if (/(?:^|[_-])(?:4k|2160p?)(?:[_-]|$)/.test(name)) return 2160;
  const match = name.match(/(?:^|[_-])(\d{3,4})p?(?:[_-]|$)/);
  if (match) return Number(match[1]);

  const sourceWidth = Math.max(0, Number(video?.width) || 0);
  const sourceHeight = Math.max(0, Number(video?.height) || 0);
  return sourceWidth > 0 && sourceHeight > 0 ? Math.min(sourceWidth, sourceHeight) : 0;
}

function buildDouyinRatioAddress(address, video, edge) {
  const sourceWidth = Math.max(0, Number(video?.width) || 0);
  const sourceHeight = Math.max(0, Number(video?.height) || 0);
  const sourceEdge = sourceWidth > 0 && sourceHeight > 0 ? Math.min(sourceWidth, sourceHeight) : edge;
  const scale = sourceEdge > 0 ? edge / sourceEdge : 1;
  const width = sourceWidth > 0 ? Math.max(1, Math.round(sourceWidth * scale)) : edge;
  const height = sourceHeight > 0 ? Math.max(1, Math.round(sourceHeight * scale)) : edge;
  const urlList = (Array.isArray(address?.url_list) ? address.url_list : []).map(value => {
    try {
      const mediaUrl = new URL(String(value || '').replace('/aweme/v1/playwm/', '/aweme/v1/play/'));
      mediaUrl.searchParams.set('ratio', `${edge}p`);
      return mediaUrl.href;
    } catch (error) {
      return String(value || '');
    }
  }).filter(Boolean);
  return { ...address, width, height, data_size: 0, url_list: urlList };
}

function getDouyinRates(video) {
  const apiRates = Array.isArray(video?.bit_rate) ? video.bit_rate.filter(Boolean) : [];
  if (apiRates.length > 0) return apiRates;

  const sourceWidth = Math.max(0, Number(video?.width) || 0);
  const sourceHeight = Math.max(0, Number(video?.height) || 0);
  const sourceEdge = sourceWidth > 0 && sourceHeight > 0 ? Math.min(sourceWidth, sourceHeight) : 1080;
  const ceiling = Math.min(sourceEdge, 1080);
  const tiers = [...new Set([ceiling, 720, 540].filter(edge => edge > 0 && edge <= ceiling))];
  return tiers.map(edge => ({
    gear_name: `public_${edge}p`,
    bit_rate: 0,
    _displayEdge: edge,
    play_addr: buildDouyinRatioAddress(video?.play_addr, video, edge),
  }));
}


function getDouyinResolutionLabel(edge) {
  if (edge >= 2160) return '4K（2160P）';
  if (edge >= 1440) return '2K（1440P）';
  if (edge >= 1080) return '1080P（全高清）';
  if (edge >= 720) return '720P（高清）';
  if (edge >= 576) return '576P（清晰）';
  if (edge >= 540) return '540P（标清）';
  if (edge >= 480) return '480P（标清）';
  return `${edge}P`;
}

function formatDouyinApproxSize(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  const mb = value / (1024 * 1024);
  return mb >= 1024 ? ` 约${(mb / 1024).toFixed(1)}G` : ` 约${mb.toFixed(1)}M`;
}

function parseDouyinNote(aweme, requestedUrl, finalUrl) {
  const images = (Array.isArray(aweme.images) ? aweme.images : []).map((image, index) => ({
    index: index + 1,
    url: pickDouyinImageUrl(image),
    width: Math.max(0, Number(image?.width) || 0),
    height: Math.max(0, Number(image?.height) || 0),
  })).filter(image => image.url);
  if (images.length === 0) throw new Error('该抖音图文作品没有返回可下载的原图');

  const formatMap = new Map();
  formatMap.set('douyin_images', {
    id: 'douyin_images',
    kind: 'images',
    images,
    filesize: 0,
  });
  const directMusicUrl = normalizeDouyinMediaUrl(aweme.video?.play_addr?.uri);
  const musicUrl = directMusicUrl || pickDouyinMediaUrl(aweme.music?.play_url || aweme.video?.play_addr);
  if (musicUrl) {
    formatMap.set('audio', { id: 'audio', kind: 'audio', url: musicUrl, filesize: 0 });
  }

  const resolutionOptions = [{
    id: 'best',
    label: `全部原图（${images.length} 张）`,
    height: 99999,
    ext: 'images',
    formatNote: `全部原图（${images.length} 张）`,
    hasAudio: false,
    filesize: 0,
  }];
  if (musicUrl) {
    resolutionOptions.push({
      id: 'audio',
      label: '仅背景音乐（MP3）',
      height: 0,
      ext: 'mp3',
      formatNote: '背景音乐',
      hasAudio: true,
      filesize: 0,
    });
  }

  const workId = String(aweme.aweme_id || '').trim();
  const canonicalUrl = workId ? `https://www.douyin.com/note/${workId}` : finalUrl || requestedUrl;
  const now = Date.now();
  return {
    createdAt: now,
    expiresAt: now + DOUYIN_CACHE_MS,
    formatMap,
    info: {
      title: String(aweme.desc || '抖音图文作品').trim() || '抖音图文作品',
      thumbnail: images[0].url,
      duration: 0,
      channel: String(aweme.author?.nickname || ''),
      channelUrl: '',
      description: String(aweme.desc || '').slice(0, 500),
      resolutionOptions,
      subtitleList: [],
      webpageUrl: canonicalUrl,
      videoId: workId,
      needsNativeDownload: true,
      playlistIndex: 1,
      platform: 'douyin-note',
      contentType: 'note',
      imageCount: images.length,
    },
  };
}

function parseDouyinAweme(aweme, requestedUrl, finalUrl) {
  if (!aweme || typeof aweme !== 'object') throw new Error('抖音没有返回有效的视频信息');
  const imageCount = Array.isArray(aweme.images) ? aweme.images.length : 0;
  if (Number(aweme.aweme_type) === 2 && imageCount > 0) return parseDouyinNote(aweme, requestedUrl, finalUrl);
  const video = aweme.video || {};
  const rates = getDouyinRates(video);
  const byResolution = new Map();

  for (const rate of rates) {
    const address = rate?.play_addr || video.play_addr;
    const width = Math.max(0, Number(address?.width || rate?.width || video.width) || 0);
    const height = Math.max(0, Number(address?.height || rate?.height || video.height) || 0);
    const shortEdge = Math.max(0, Number(rate?._displayEdge) || getDouyinRateEdge(rate, video, address));
    const mediaUrl = pickDouyinMediaUrl(address);
    if (!shortEdge || !mediaUrl) continue;
    const candidate = {
      id: `douyin_${shortEdge}`,
      url: mediaUrl,
      width,
      height,
      shortEdge,
      bitrate: Math.max(0, Number(rate?.bit_rate) || 0),
      filesize: Math.max(0, Number(address?.data_size) || 0),
    };
    const existing = byResolution.get(shortEdge);
    if (!existing || candidate.bitrate > existing.bitrate
        || (candidate.bitrate === existing.bitrate && candidate.filesize > existing.filesize)) {
      byResolution.set(shortEdge, candidate);
    }
  }

  const formats = [...byResolution.values()].sort((a, b) => b.shortEdge - a.shortEdge);
  if (formats.length === 0) throw new Error('抖音没有返回可下载的清晰度');
  const formatMap = new Map(formats.map(format => [format.id, format]));
  const top = formats[0];
  const resolutionOptions = [{
    id: 'best',
    label: `最佳画质（自动）${formatDouyinApproxSize(top.filesize)}`,
    height: 99999,
    ext: 'mp4',
    formatNote: '最佳画质',
    hasAudio: true,
    filesize: top.filesize,
  }];
  for (const format of formats) {
    const label = getDouyinResolutionLabel(format.shortEdge);
    resolutionOptions.push({
      id: format.id,
      label: `${label}${formatDouyinApproxSize(format.filesize)}`,
      height: format.shortEdge,
      ext: 'mp4',
      formatNote: label,
      hasAudio: true,
      filesize: format.filesize,
    });
  }
  resolutionOptions.push({
    id: 'audio',
    label: '仅音频（MP3）',
    height: 0,
    ext: 'mp3',
    formatNote: '音频',
    hasAudio: true,
    filesize: 0,
  });

  const thumbnail = [video.cover, video.origin_cover, video.dynamic_cover]
    .flatMap(item => Array.isArray(item?.url_list) ? item.url_list : [])
    .map(value => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' ? parsed.href : '';
      } catch (e) { return ''; }
    }).find(Boolean) || '';
  const videoId = String(aweme.aweme_id || '').trim();
  const canonicalUrl = videoId ? `https://www.douyin.com/video/${videoId}` : finalUrl || requestedUrl;
  const durationMs = Number(video.duration || aweme.duration) || 0;
  const now = Date.now();
  const cdnExpiry = (Number(video.cdn_url_expired) || 0) * 1000 - 60000;

  return {
    createdAt: now,
    expiresAt: cdnExpiry > now ? Math.min(now + DOUYIN_CACHE_MS, cdnExpiry) : now + DOUYIN_CACHE_MS,
    formatMap,
    info: {
      title: String(aweme.desc || '抖音视频').trim() || '抖音视频',
      thumbnail,
      duration: durationMs > 1000 ? durationMs / 1000 : durationMs,
      channel: String(aweme.author?.nickname || ''),
      channelUrl: '',
      description: String(aweme.desc || '').slice(0, 500),
      resolutionOptions,
      subtitleList: [],
      webpageUrl: canonicalUrl,
      videoId,
      needsNativeDownload: true,
      playlistIndex: 1,
      platform: 'douyin',
    },
  };
}

function cacheDouyinRecord(record, ...keys) {
  for (const key of keys) {
    const value = String(key || '').trim();
    if (value) douyinFormatCache.set(value, record);
  }
}


function requestDouyinRedirect(targetUrl, browserSession, timeout = 2500) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    let request = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(String(value || targetUrl));
    };
    try {
      request = net.request({
        method: 'GET',
        url: targetUrl,
        session: browserSession,
        redirect: 'manual',
      });
      request.setHeader('User-Agent', DOUYIN_USER_AGENT);
      request.setHeader('Accept', 'text/html,application/xhtml+xml');
      request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9');
      request.on('redirect', (_statusCode, _method, redirectUrl) => {
        finish(redirectUrl);
        try { request.abort(); } catch (error) {}
      });
      request.on('response', response => {
        const rawLocation = response.headers?.location;
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        response.on('data', () => {});
        response.on('end', () => finish(location || targetUrl));
        if (location) finish(location);
      });
      request.on('error', () => finish(targetUrl));
      timer = setTimeout(() => {
        try { request.abort(); } catch (error) {}
        finish(targetUrl);
      }, timeout);
      request.end();
    } catch (error) {
      finish(targetUrl);
    }
  });
}
async function resolveDouyinBrowserUrl(url, browserSession) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch (e) { return url; }
  const isShortEntry = parsed.hostname.toLowerCase() === 'v.douyin.com'
    || (hostMatches(parsed.hostname, ['iesdouyin.com']) && /\/share\//i.test(parsed.pathname));
  if (!isShortEntry) return parsed.href;

  try {
    let currentUrl = parsed.href;
    for (let hop = 0; hop < 3; hop += 1) {
      const nextUrl = await requestDouyinRedirect(currentUrl, browserSession);
      if (!nextUrl || nextUrl === currentUrl) break;
      currentUrl = new URL(nextUrl, currentUrl).href;
      if (!isDouyinUrl(currentUrl)) return parsed.href;
      const workMatch = new URL(currentUrl).pathname.match(/\/(?:share\/)?(video|note)\/(\d+)/i);
      if (workMatch) {
        // 抖音分享页只返回基础播放地址，通常最高只能枚举到 1080P。
        // 统一进入桌面作品页，让页面请求 aweme/detail，才能取得 2K/4K 等完整码流。
        return `https://www.douyin.com/${workMatch[1].toLowerCase()}/${workMatch[2]}`;
      }
    }
    return currentUrl;
  } catch (e) {
    return parsed.href;
  }
}
function getDouyinAwemeFromPayload(data) {
  return data?.aweme_detail || (Array.isArray(data?.aweme_list) ? data.aweme_list[0] : null) || null;
}


function findDouyinAwemeInRouterData(value, depth = 0) {
  if (!value || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const aweme = findDouyinAwemeInRouterData(item, depth + 1);
      if (aweme) return aweme;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (value.aweme_id && (value.video?.play_addr || Array.isArray(value.images))) return value;
  for (const item of Object.values(value)) {
    const aweme = findDouyinAwemeInRouterData(item, depth + 1);
    if (aweme) return aweme;
  }
  return null;
}

async function fetchDouyinSsrAweme(browserSession, requestedUrl) {
  try {
    let workMatch = String(requestedUrl || '').match(/\/(?:share\/)?(video|note)\/(\d+)/i);
    if (!workMatch) {
      const response = await browserSession.fetch(String(requestedUrl || ''), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': DOUYIN_USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      workMatch = String(response.url || '').match(/\/(?:share\/)?(video|note)\/(\d+)/i);
    }
    if (!workMatch) return null;
    const workType = workMatch[1].toLowerCase();
    const workId = workMatch[2];

    const shareUrl = `https://www.iesdouyin.com/share/${workType}/${workId}/?from_ssr=1`;
    const response = await browserSession.fetch(shareUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
    if (!match) return null;
    const aweme = findDouyinAwemeInRouterData(JSON.parse(match[1]));
    if (!aweme) return null;
    const imageCount = Array.isArray(aweme.images) ? aweme.images.length : 0;
    if (workType === 'note' || (Number(aweme.aweme_type) === 2 && imageCount > 0)) {
      debugLog(`[DOUYIN] SSR share page captured note/${workId} with ${imageCount} image(s)`);
      return aweme;
    }
    const sourceWidth = Math.max(0, Number(aweme.video?.width) || 0);
    const sourceHeight = Math.max(0, Number(aweme.video?.height) || 0);
    const sourceEdge = Math.min(sourceWidth, sourceHeight);
    debugLog(`[DOUYIN] SSR share page captured ${workType}/${workId} source=${sourceEdge || 0}p`);
    return aweme;
  } catch (error) {
    debugLog(`[DOUYIN] SSR share page unavailable: ${String(error.message).substring(0, 160)}`);
    return null;
  }
}
async function fetchDouyinDetailWithSession(browserSession, resourceUrl) {
  try {
    const parsed = new URL(String(resourceUrl || ''));
    if (parsed.protocol !== 'https:' || !hostMatches(parsed.hostname, VIDEO_HOSTS.douyin)
        || !/aweme\/detail/i.test(parsed.pathname)) return null;
    const response = await browserSession.fetch(parsed.href, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.douyin.com/',
        'User-Agent': DOUYIN_USER_AGENT,
      },
    });
    if (!response.ok) return null;
    return getDouyinAwemeFromPayload(await response.json());
  } catch (e) {
    return null;
  }
}

async function readDouyinDetailFromPage(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
  return win.webContents.executeJavaScript(`(async () => {
    const detailPattern = /\\/aweme\\/v1\\/web\\/aweme\\/detail|aweme\\/detail/i;
    const urls = [...new Set(performance.getEntriesByType('resource')
      .map(entry => entry.name)
      .filter(value => detailPattern.test(value)))].slice(-6).reverse();
    for (const resourceUrl of urls) {
      try {
        const response = await fetch(resourceUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-cache',
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        if (!response.ok) continue;
        const data = await response.json();
        const aweme = data?.aweme_detail || (Array.isArray(data?.aweme_list) ? data.aweme_list[0] : null);
        if (aweme) return { aweme, resourceCount: urls.length };
      } catch (e) {}
    }
    return {
      aweme: null,
      resourceCount: urls.length,
      pagePath: location.pathname.slice(0, 120),
      titleLength: document.title.length,
      renderDataLength: document.getElementById('RENDER_DATA')?.textContent?.length || 0,
    };
  })()`, true);
}

function runDouyinBrowserExtraction(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let lastPageSummary = '';
    const fallbackTimers = new Set();
    const responseRequests = new Set();
    const partition = 'persist:douyin-public';
    const browserSession = session.fromPartition(partition);
    browserSession.setUserAgent(DOUYIN_USER_AGENT, 'zh-CN,zh;q=0.9');
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isDouyinUrl(targetUrl)) event.preventDefault();
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const fallbackTimer of fallbackTimers) clearTimeout(fallbackTimer);
      fallbackTimers.clear();
      try { win.webContents.debugger.removeListener('message', onDebuggerMessage); } catch (e) {}
      try { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch (e) {}
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const succeed = (aweme) => {
      if (settled || !aweme) return;
      settled = true;
      const finalUrl = win.webContents.getURL() || url;
      cleanup();
      resolve({ aweme, finalUrl });
    };

    let noteCaptureStarted = false;
    const captureNavigatedWork = (_event, targetUrl) => {
      try {
        const target = new URL(String(targetUrl || ''));
        if (!settled && !noteCaptureStarted && isDouyinUrl(target.href)
            && /\/(?:share\/)?note\/\d+/i.test(target.pathname)) {
          noteCaptureStarted = true;
          fetchDouyinSsrAweme(browserSession, target.href).then(succeed).catch(error => {
            noteCaptureStarted = false;
            debugLog(`[DOUYIN] Note navigation fallback unavailable: ${String(error.message).substring(0, 160)}`);
          });
        }
      } catch (error) {}
    };
    win.webContents.on('did-navigate', captureNavigatedWork);
    win.webContents.on('did-redirect-navigation', captureNavigatedWork);
    const tryPageFallback = async () => {
      if (settled || win.isDestroyed()) return;
      try {
        const result = await readDouyinDetailFromPage(win);
        if (result?.aweme) {
          debugLog(`[DOUYIN] Page fallback captured detail response (${result.resourceCount || 0} candidates)`);
          succeed(result.aweme);
          return;
        }
        if (result) {
          lastPageSummary = `页面路径=${result.pagePath || '未知'}，详情请求=${result.resourceCount || 0}，页面数据=${result.renderDataLength || 0}`;
          debugLog(`[DOUYIN] Waiting for detail: ${lastPageSummary}`);
        }
      } catch (error) {
        debugLog(`[DOUYIN] Page fallback unavailable: ${String(error.message).substring(0, 160)}`);
      }
    };
    const scheduleFallback = (delay) => {
      const fallbackTimer = setTimeout(() => {
        fallbackTimers.delete(fallbackTimer);
        tryPageFallback().catch(() => {});
      }, delay);
      fallbackTimers.add(fallbackTimer);
    };

    const onDebuggerMessage = async (_event, method, params) => {
      if (settled) return;
      if (method === 'Network.responseReceived') {
        const responseUrl = String(params?.response?.url || '');
        if (/\/aweme\/v1\/web\/aweme\/detail|aweme\/detail/i.test(responseUrl)) {
          if (Number(params?.response?.status) === 200) {
            responseRequests.add(params.requestId);
            fetchDouyinDetailWithSession(browserSession, responseUrl).then(succeed).catch(() => {});
          } else {
            debugLog(`[DOUYIN] Detail request returned HTTP ${Number(params?.response?.status) || 0}`);
          }
        }
        return;
      }
      if (method !== 'Network.loadingFinished' || !responseRequests.has(params?.requestId)) return;
      responseRequests.delete(params.requestId);
      try {
        const result = await win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const raw = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        const aweme = getDouyinAwemeFromPayload(JSON.parse(raw));
        if (aweme) succeed(aweme);
      } catch (error) {
        debugLog(`[DOUYIN] Failed to read browser response: ${String(error.message).substring(0, 200)}`);
      }
    };

    try {
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.on('message', onDebuggerMessage);
      win.webContents.debugger.sendCommand('Network.enable').catch(error => {
        debugLog(`[DOUYIN] Network monitor unavailable: ${String(error.message).substring(0, 160)}`);
      });
      resolveDouyinBrowserUrl(url, browserSession).then(entryUrl => {
        if (settled) return;
        fetchDouyinSsrAweme(browserSession, entryUrl).then(aweme => {
          if (!aweme || settled) return;
          const imageCount = Array.isArray(aweme.images) ? aweme.images.length : 0;
          const isNote = Number(aweme.aweme_type) === 2 && imageCount > 0;
          const apiRateCount = Array.isArray(aweme.video?.bit_rate)
            ? aweme.video.bit_rate.filter(Boolean).length : 0;
          if (isNote || apiRateCount >= 2) {
            succeed(aweme);
            return;
          }
          const ssrTimer = setTimeout(() => {
            fallbackTimers.delete(ssrTimer);
            if (!settled) succeed(aweme);
          }, 8000);
          fallbackTimers.add(ssrTimer);
          debugLog('[DOUYIN] SSR video kept briefly as fallback while collecting full quality data');
        }).catch(error => {
          debugLog(`[DOUYIN] Fast SSR path unavailable: ${String(error.message).substring(0, 160)}`);
        });
        win.loadURL(entryUrl, {
          userAgent: DOUYIN_USER_AGENT,
          extraHeaders: 'Accept-Language: zh-CN,zh;q=0.9\n',
        }).catch(error => {
          debugLog(`[DOUYIN] Hidden page load: ${String(error.message).substring(0, 200)}`);
        });
        [1600, 5000, 9000].forEach(scheduleFallback);
      }).catch(() => fail('无法打开抖音页面，请检查网络或代理后重试'));
    } catch (error) {
      fail('无法启动抖音安全解析环境，请重启软件后重试');
      return;
    }

    timer = setTimeout(() => {
      if (lastPageSummary) debugLog(`[DOUYIN] Timed out: ${lastPageSummary}`);
      fail('抖音解析超过 15 秒仍未取得视频信息。请确认作品是公开视频，并检查网络或代理后重试');
    }, 15000);
  });
}
async function fetchDouyinVideoInfo(url, { force = false } = {}) {
  const cached = douyinFormatCache.get(url);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.info;
  if (!force && douyinExtractionInFlight.has(url)) return douyinExtractionInFlight.get(url).then(record => record.info);

  const promise = runDouyinBrowserExtraction(url).then(({ aweme, finalUrl }) => {
    const record = parseDouyinAweme(aweme, url, finalUrl);
    cacheDouyinRecord(record, url, finalUrl, record.info.webpageUrl);
    debugLog(`[DOUYIN] Extracted ${record.info.videoId || 'video'} with ${record.formatMap.size} resolutions`);
    return record;
  }).finally(() => douyinExtractionInFlight.delete(url));
  douyinExtractionInFlight.set(url, promise);
  return promise.then(record => record.info);
}

async function resolveDouyinFormat(url, formatId) {
  let record = douyinFormatCache.get(url);
  if (!record || record.expiresAt <= Date.now()) {
    await fetchDouyinVideoInfo(url, { force: true });
    record = douyinFormatCache.get(url);
  }
  if (!record) throw new Error('抖音清晰度信息已失效，请重新获取视频信息');
  if (formatId === 'best') return [...record.formatMap.values()][0];
  if (formatId === 'audio') return record.formatMap.get('audio') || [...record.formatMap.values()][0];
  const selected = record.formatMap.get(formatId);
  if (!selected) throw new Error('当前视频不再提供所选清晰度，请重新获取视频信息后选择其他画质');
  return selected;
}

const xhsFormatCache = new Map();
const xhsExtractionInFlight = new Map();
const XHS_CACHE_MS = 10 * 60 * 1000;

function normalizeXhsMediaUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)
        || !hostMatches(parsed.hostname, XHS_MEDIA_HOSTS)) return '';
    parsed.protocol = 'https:';
    return parsed.href;
  } catch (error) {
    return '';
  }
}

function pickXhsMediaUrl(...values) {
  for (const value of values.flat(Infinity)) {
    const url = normalizeXhsMediaUrl(value);
    if (url) return url;
  }
  return '';
}

function buildXhsOriginalImageUrl(image) {
  const candidates = [
    image?.urlDefault, image?.urlPre, image?.url,
    ...(Array.isArray(image?.urlList) ? image.urlList : []),
    ...(Array.isArray(image?.infoList) ? image.infoList.map(item => item?.url) : []),
  ];
  for (const value of candidates) {
    const normalized = normalizeXhsMediaUrl(value);
    if (!normalized) continue;
    try {
      const parsed = new URL(normalized);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (/^sns-webpic/i.test(parsed.hostname) && parts.length >= 3) {
        const assetKey = parts.slice(2).join('/').split('!')[0];
        if (/^[\w./-]+$/.test(assetKey) && !assetKey.includes('..')) {
          return `https://ci.xiaohongshu.com/${assetKey}?imageView2/format/png`;
        }
      }
    } catch (error) {}
    return normalized;
  }
  return '';
}

function getXhsNoteId(value) {
  const match = String(value || '').match(/\/(?:explore|discovery\/item)\/([\da-f]{16,32})/i);
  return match ? match[1] : '';
}

function findXhsNoteInPayload(value, noteId = '', depth = 0) {
  if (!value || depth > 14) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const note = findXhsNoteInPayload(item, noteId, depth + 1);
      if (note) return note;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const id = String(value.noteId || value.note_id || value.id || '');
  const hasMedia = Array.isArray(value.imageList) || Array.isArray(value.image_list)
    || value.video?.media?.stream || value.video?.consumer?.originVideoKey;
  if (hasMedia && (!noteId || !id || id === noteId)) return value;
  for (const key of ['note', 'noteCard', 'note_card', 'data', 'items', 'noteDetailMap']) {
    if (!(key in value)) continue;
    const note = findXhsNoteInPayload(value[key], noteId, depth + 1);
    if (note) return note;
  }
  for (const [key, item] of Object.entries(value)) {
    if (['note', 'noteCard', 'note_card', 'data', 'items', 'noteDetailMap'].includes(key)) continue;
    const note = findXhsNoteInPayload(item, noteId, depth + 1);
    if (note) return note;
  }
  return null;
}

function getXhsResolutionLabel(edge) {
  if (edge >= 2160) return '4K（2160P）';
  if (edge >= 1440) return '2K（1440P）';
  if (edge >= 1080) return '1080P（全高清）';
  if (edge >= 720) return '720P（高清）';
  if (edge >= 540) return `${edge}P（标清）`;
  return `${edge}P`;
}

function getXhsVideoStreams(note) {
  const streamRoot = note?.video?.media?.stream || {};
  const streams = [];
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.masterUrl || value.master_url || Array.isArray(value.backupUrls)
        || Array.isArray(value.backup_urls)) {
      streams.push(value);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(streamRoot);
  return streams;
}

function parseXhsNote(note, requestedUrl, finalUrl) {
  if (!note || typeof note !== 'object') throw new Error('小红书没有返回有效的作品信息');
  const noteId = String(note.noteId || note.note_id || note.id || getXhsNoteId(finalUrl) || getXhsNoteId(requestedUrl));
  const imageList = Array.isArray(note.imageList) ? note.imageList
    : (Array.isArray(note.image_list) ? note.image_list : []);
  const images = imageList.map((image, index) => ({
    index: index + 1,
    url: buildXhsOriginalImageUrl(image),
    width: Math.max(0, Number(image?.width || image?.infoList?.[0]?.width) || 0),
    height: Math.max(0, Number(image?.height || image?.infoList?.[0]?.height) || 0),
  })).filter(image => image.url);
  const title = String(note.title || note.displayTitle || note.desc || '小红书作品').trim() || '小红书作品';
  const description = String(note.desc || note.description || '').slice(0, 500);
  const channel = String(note.user?.nickname || note.user?.nickName || note.user?.name || '');
  const canonicalUrl = noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : (finalUrl || requestedUrl);
  const streams = getXhsVideoStreams(note);

  if (streams.length > 0) {
    const byResolution = new Map();
    for (const stream of streams) {
      const width = Math.max(0, Number(stream.width) || 0);
      const height = Math.max(0, Number(stream.height) || 0);
      const shortEdge = width > 0 && height > 0 ? Math.min(width, height) : 0;
      const url = pickXhsMediaUrl(stream.masterUrl, stream.master_url, stream.backupUrls, stream.backup_urls);
      if (!shortEdge || !url) continue;
      const candidate = {
        id: `xhs_${shortEdge}`,
        kind: 'video',
        url,
        width,
        height,
        shortEdge,
        bitrate: Math.max(0, Number(stream.videoBitrate || stream.video_bitrate || stream.avgBitrate || stream.avg_bitrate) || 0),
        filesize: Math.max(0, Number(stream.size) || 0),
        codec: String(stream.videoCodec || stream.video_codec || ''),
      };
      const existing = byResolution.get(shortEdge);
      if (!existing || candidate.bitrate > existing.bitrate
          || (candidate.bitrate === existing.bitrate && candidate.filesize > existing.filesize)) {
        byResolution.set(shortEdge, candidate);
      }
    }
    const formats = [...byResolution.values()].sort((a, b) => b.shortEdge - a.shortEdge);
    if (formats.length === 0) throw new Error('小红书没有返回可下载的视频清晰度');
    const formatMap = new Map(formats.map(format => [format.id, format]));
    const top = formats[0];
    const resolutionOptions = [{
      id: 'best',
      label: `最佳画质（自动）${formatDouyinApproxSize(top.filesize)}`,
      height: 99999, ext: 'mp4', formatNote: '最佳画质', hasAudio: true, filesize: top.filesize,
    }];
    for (const format of formats) {
      const label = getXhsResolutionLabel(format.shortEdge);
      resolutionOptions.push({
        id: format.id,
        label: `${label}${formatDouyinApproxSize(format.filesize)}`,
        height: format.shortEdge,
        ext: 'mp4',
        formatNote: label,
        hasAudio: true,
        filesize: format.filesize,
      });
    }
    resolutionOptions.push({
      id: 'audio', label: '仅音频（MP3）', height: 0, ext: 'mp3',
      formatNote: '音频', hasAudio: true, filesize: 0,
    });
    const durationMs = Number(note.video?.media?.video?.duration || streams[0]?.duration || note.video?.duration) || 0;
    const now = Date.now();
    return {
      createdAt: now,
      expiresAt: now + XHS_CACHE_MS,
      formatMap,
      info: {
        title,
        thumbnail: images[0]?.url || '',
        duration: durationMs > 1000 ? durationMs / 1000 : durationMs,
        channel,
        channelUrl: '',
        description,
        resolutionOptions,
        subtitleList: [],
        webpageUrl: canonicalUrl,
        videoId: noteId,
        needsNativeDownload: true,
        playlistIndex: 1,
        platform: 'xiaohongshu',
      },
    };
  }

  if (images.length === 0) {
    throw new Error('该小红书作品没有返回可下载的视频或原图；请确认笔记仍可公开浏览');
  }
  const formatMap = new Map([['xhs_images', {
    id: 'xhs_images', kind: 'images', images, filesize: 0,
  }]]);
  const now = Date.now();
  return {
    createdAt: now,
    expiresAt: now + XHS_CACHE_MS,
    formatMap,
    info: {
      title,
      thumbnail: images[0].url,
      duration: 0,
      channel,
      channelUrl: '',
      description,
      resolutionOptions: [{
        id: 'best', label: `全部原图（${images.length} 张）`, height: 99999,
        ext: 'images', formatNote: `全部原图（${images.length} 张）`, hasAudio: false, filesize: 0,
      }],
      subtitleList: [],
      webpageUrl: canonicalUrl,
      videoId: noteId,
      needsNativeDownload: true,
      playlistIndex: 1,
      platform: 'xiaohongshu-note',
      contentType: 'note',
      imageCount: images.length,
    },
  };
}

async function runXhsYtdlpExtraction(url) {
  const raw = await execYtdlp(['--no-playlist', '-J', url], {
    timeout: 12000,
    timeoutMsg: '小红书备用解析超过 12 秒，已停止等待',
  });
  const data = JSON.parse(raw);
  const formats = Array.isArray(data.formats) ? data.formats : [];
  const streams = formats.filter(format => {
    if (!format || format.vcodec === 'none') return false;
    const mediaUrl = normalizeXhsMediaUrl(format.url);
    const width = Number(format.width) || 0;
    const height = Number(format.height) || 0;
    return !!mediaUrl && width > 0 && height > 0;
  }).map(format => ({
    width: Number(format.width) || 0,
    height: Number(format.height) || 0,
    videoBitrate: Math.round((Number(format.vbr || format.tbr) || 0) * 1000),
    avgBitrate: Math.round((Number(format.tbr) || 0) * 1000),
    size: Number(format.filesize || format.filesize_approx) || 0,
    videoCodec: String(format.vcodec || ''),
    audioCodec: String(format.acodec || ''),
    duration: (Number(data.duration) || 0) * 1000,
    masterUrl: format.url,
  }));
  if (streams.length === 0) throw new Error('小红书备用解析没有返回可下载的视频清晰度');
  const thumbnail = normalizeXhsMediaUrl(data.thumbnail)
    || (Array.isArray(data.thumbnails)
      ? data.thumbnails.map(item => normalizeXhsMediaUrl(item?.url)).find(Boolean)
      : '');
  return {
    finalUrl: String(data.webpage_url || data.original_url || url),
    note: {
      noteId: String(data.id || getXhsNoteId(url)),
      title: String(data.title || '小红书视频'),
      desc: String(data.description || ''),
      user: { nickname: String(data.uploader || data.channel || '') },
      imageList: thumbnail ? [{ urlDefault: thumbnail }] : [],
      video: {
        media: { video: { duration: (Number(data.duration) || 0) * 1000 }, stream: { ytdlp: streams } },
      },
    },
  };
}

function cacheXhsRecord(record, ...keys) {
  for (const key of keys) {
    const value = String(key || '').trim();
    if (value) xhsFormatCache.set(value, record);
  }
}

async function resolveXhsBrowserUrl(url, browserSession) {
  let currentUrl = String(url || '');
  try {
    const first = new URL(currentUrl);
    if (!hostMatches(first.hostname, ['xhslink.com'])) return first.href;
    for (let hop = 0; hop < 5; hop += 1) {
      const next = await requestDouyinRedirect(currentUrl, browserSession, 4000);
      if (!next || next === currentUrl) break;
      currentUrl = new URL(next, currentUrl).href;
      const parsed = new URL(currentUrl);
      if (!hostMatches(parsed.hostname, VIDEO_HOSTS.xiaohongshu)) break;
      if (getXhsNoteId(parsed.href)) return parsed.href;
    }
  } catch (error) {}
  return currentUrl;
}

async function importXhsCookiesToSession(browserSession) {
  const cookieFile = getPlatformCookieFile('xiaohongshu');
  if (!cookieFile) return;
  const tasks = [];
  for (const line of readCookieLines(cookieFile)) {
    const parsed = parseNetscapeCookieLine(line);
    if (!parsed || !cookieLineMatchesPlatform(line, 'xiaohongshu')) continue;
    const [rawDomain, , cookiePath, secureFlag, expires, name, ...valueParts] = parsed.parts;
    const domain = rawDomain.replace(/^\./, '');
    const secure = String(secureFlag).toUpperCase() === 'TRUE';
    const normalizedPath = String(cookiePath || '/').startsWith('/') ? String(cookiePath || '/') : `/${cookiePath}`;
    const details = {
      url: `${secure ? 'https' : 'http'}://${domain}${normalizedPath}`,
      name,
      value: valueParts.join('\t'),
      path: normalizedPath,
      secure,
      httpOnly: String(line).startsWith('#HttpOnly_'),
    };
    if (rawDomain.startsWith('.')) details.domain = rawDomain;
    const expirationDate = Number(expires);
    if (expirationDate > 0) details.expirationDate = expirationDate;
    tasks.push(browserSession.cookies.set(details));
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
    debugLog(`[XHS] Loaded ${tasks.length} isolated access credential item(s)`);
  }
}

async function persistXhsSessionCookies(browserSession) {
  const cookies = await browserSession.cookies.get({});
  const lines = [];
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '').toLowerCase();
    if (!hostMatches(domain.replace(/^\./, ''), COOKIE_PLATFORM_DOMAINS.xiaohongshu)) continue;
    const normalizedDomain = domain.startsWith('.') ? domain : `.${domain}`;
    const includeSubdomains = normalizedDomain.startsWith('.') ? 'TRUE' : 'FALSE';
    const cookiePath = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
    const prefix = cookie.httpOnly ? '#HttpOnly_' : '';
    const safeName = String(cookie.name || '').replace(/[\r\n\t]/g, '');
    const safeValue = String(cookie.value || '').replace(/[\r\n\t]/g, '');
    if (!safeName) continue;
    lines.push(`${prefix}${normalizedDomain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expires}\t${safeName}\t${safeValue}`);
  }
  if (lines.length === 0) return;
  const existing = readCookieLines(XHS_COOKIES_FILE)
    .filter(line => cookieLineMatchesPlatform(line, 'xiaohongshu'));
  writePlatformCookieFile(XHS_COOKIES_FILE, '小红书', [...existing, ...lines]);
  debugLog(`[XHS] Saved ${lines.length} isolated access credential item(s)`);
}

async function readXhsNoteFromPage(win, requestedUrl) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
  const noteId = getXhsNoteId(win.webContents.getURL()) || getXhsNoteId(requestedUrl);
  return win.webContents.executeJavaScript(`(() => {
    const noteId = ${JSON.stringify(noteId)};
    const state = window.__INITIAL_STATE__;
    const direct = state?.note?.noteDetailMap?.[noteId]?.note;
    if (direct) return { note: direct, pagePath: location.pathname, title: document.title };
    const seen = new Set();
    const find = (value, depth = 0) => {
      if (!value || depth > 12 || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) { const found = find(item, depth + 1); if (found) return found; }
        return null;
      }
      const id = String(value.noteId || value.note_id || value.id || '');
      const hasMedia = Array.isArray(value.imageList) || Array.isArray(value.image_list)
        || value.video?.media?.stream || value.video?.consumer?.originVideoKey;
      if (hasMedia && (!noteId || !id || id === noteId)) return value;
      for (const item of Object.values(value)) { const found = find(item, depth + 1); if (found) return found; }
      return null;
    };
    return { note: find(state), pagePath: location.pathname, title: document.title };
  })()`, true);
}

function runXhsBrowserExtraction(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const fallbackTimers = new Set();
    const responseRequests = new Map();
    const partition = 'persist:xiaohongshu-public';
    const browserSession = session.fromPartition(partition);
    browserSession.setUserAgent(XHS_USER_AGENT, 'zh-CN,zh;q=0.9');
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: false, spellcheck: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, targetUrl) => {
      try {
        if (!hostMatches(new URL(targetUrl).hostname, VIDEO_HOSTS.xiaohongshu)) event.preventDefault();
      } catch (error) { event.preventDefault(); }
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const item of fallbackTimers) clearTimeout(item);
      try { win.webContents.debugger.removeListener('message', onDebuggerMessage); } catch (error) {}
      try { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch (error) {}
      try { if (!win.isDestroyed()) win.destroy(); } catch (error) {}
    };
    const fail = message => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
      persistXhsSessionCookies(browserSession).catch(() => {});
    };
    const succeed = note => {
      if (settled || !note) return;
      settled = true;
      const finalUrl = win.webContents.getURL() || url;
      cleanup();
      persistXhsSessionCookies(browserSession).catch(() => {});
      resolve({ note, finalUrl });
    };
    const tryPage = async () => {
      if (settled || win.isDestroyed()) return;
      const result = await readXhsNoteFromPage(win, url).catch(() => null);
      if (result?.note) return succeed(result.note);
      if (/website-login\/error|\/404/i.test(result?.pagePath || '')) {
        fail('小红书触发了安全限制。请确认当前网络可正常打开该笔记，并重新复制最新分享链接后重试');
      }
    };
    const schedule = delay => {
      const item = setTimeout(() => {
        fallbackTimers.delete(item);
        tryPage().catch(() => {});
      }, delay);
      fallbackTimers.add(item);
    };
    const onDebuggerMessage = async (_event, method, params) => {
      if (settled) return;
      if (method === 'Network.responseReceived') {
        const responseUrl = String(params?.response?.url || '');
        if (/\/api\/sns\/web\/v1\/feed|note\/detail|\/explore\//i.test(responseUrl)
            && Number(params?.response?.status) === 200) {
          responseRequests.set(params.requestId, getXhsNoteId(responseUrl) || getXhsNoteId(url));
        }
        return;
      }
      if (method !== 'Network.loadingFinished' || !responseRequests.has(params?.requestId)) return;
      const noteId = responseRequests.get(params.requestId);
      responseRequests.delete(params.requestId);
      try {
        const result = await win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const raw = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        const note = findXhsNoteInPayload(JSON.parse(raw), noteId || getXhsNoteId(url));
        if (note) succeed(note);
      } catch (error) {}
    };

    try {
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.on('message', onDebuggerMessage);
      win.webContents.debugger.sendCommand('Network.enable').catch(() => {});
      importXhsCookiesToSession(browserSession)
        .then(() => resolveXhsBrowserUrl(url, browserSession)).then(entryUrl => {
        if (!getXhsNoteId(entryUrl)) {
          fail('无法从小红书分享链接中识别作品编号，请重新复制最新分享链接');
          return;
        }
        win.loadURL(entryUrl, {
          userAgent: XHS_USER_AGENT,
          extraHeaders: 'Accept-Language: zh-CN,zh;q=0.9\n',
        }).catch(error => debugLog(`[XHS] Hidden page load: ${String(error.message).substring(0, 180)}`));
        [1200, 3200, 6500, 10000].forEach(schedule);
      }).catch(() => fail('无法打开小红书分享链接，请检查网络后重试'));
    } catch (error) {
      fail('无法启动小红书安全解析环境，请重启软件后重试');
      return;
    }
    timer = setTimeout(() => {
      fail('小红书解析超过 16 秒仍未取得作品信息。请确认笔记可公开浏览，并重新复制最新分享链接');
    }, 16000);
  });
}

async function fetchXhsVideoInfo(url, { force = false } = {}) {
  const cached = xhsFormatCache.get(url);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.info;
  if (!force && xhsExtractionInFlight.has(url)) return xhsExtractionInFlight.get(url).then(record => record.info);
  const extraction = Promise.any([
    runXhsBrowserExtraction(url),
    runXhsYtdlpExtraction(url),
  ]).catch(error => {
    const errors = Array.isArray(error?.errors) ? error.errors : [error];
    const preferred = errors.find(item => /[㐀-鿿]/.test(String(item?.message || item))) || errors[0];
    throw new Error(String(preferred?.message || preferred || '小红书作品解析失败'));
  });
  const promise = extraction.then(({ note, finalUrl }) => {
    const record = parseXhsNote(note, url, finalUrl);
    cacheXhsRecord(record, url, finalUrl, record.info.webpageUrl);
    debugLog(`[XHS] Extracted ${record.info.videoId || 'note'} with ${record.formatMap.size} downloadable option(s)`);
    return record;
  }).finally(() => xhsExtractionInFlight.delete(url));
  xhsExtractionInFlight.set(url, promise);
  return promise.then(record => record.info);
}

async function resolveXhsFormat(url, formatId) {
  let record = xhsFormatCache.get(url);
  if (!record || record.expiresAt <= Date.now()) {
    await fetchXhsVideoInfo(url, { force: true });
    record = xhsFormatCache.get(url);
  }
  if (!record) throw new Error('小红书清晰度信息已失效，请重新获取作品信息');
  if (formatId === 'best') return [...record.formatMap.values()][0];
  if (formatId === 'audio') return [...record.formatMap.values()].find(item => item.kind === 'video');
  const selected = record.formatMap.get(formatId);
  if (!selected) throw new Error('当前作品不再提供所选清晰度，请重新获取作品信息');
  return selected;
}

// Fetch video info for a single URL — returns first video entry only (used by batch flow)
async function fetchVideoInfo(url) {
  const json = await execYtdlp(['-j', url]);
  const lines = json.split('\n').filter(Boolean);
  const firstData = JSON.parse(lines[0]);
  return _parseVideoData(firstData, url);
}

// TapTap API type → Chinese label mapping
const TAPTAP_VIDEO_LABELS = {
  app_detail: '宣传片',
  app_trial: '实机画面',
};

// Fetch per-video labels from TapTap API and return a Map of video_id → label
async function fetchTapTapVideoLabels(appId) {
  const url = `https://www.taptap.cn/webapiv2/app/v4/detail?id=${appId}`;

  // Try net.request (Electron Chromium stack, respects proxy via session.setProxy)
  const m1 = await _taptapLabelsNet(url, appId);
  if (m1.size > 0) return m1;

  // Fallback: https.request (Node.js native, respects env.HTTPS_PROXY)
  console.warn('[TAPTAP] net.request returned empty, trying https.request fallback');
  const m2 = await _taptapLabelsHttps(url, appId);
  return m2;
}

// net.request version (primary)
function _taptapLabelsNet(url, appId) {
  return new Promise((resolve) => {
    try {
      const req = net.request({
        method: 'GET',
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'X-UA': 'V=1&PN=WebApp&LANG=zh_CN&VN=1000000&PLT=PC',
        },
      });
      let body = '';
      req.on('response', (res) => {
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const m = _extractLabelMap(data);
            debugLog(`[TAPTAP] net: ${appId} videos=${(data?.data?.app_videos || []).length} mapSize=${m.size}`);
            if (m.size === 0) console.warn(`[TAPTAP] net: no labels for ${appId}`);
            resolve(m);
          } catch (e) {
            console.warn(`[TAPTAP] net parse error: ${e.message}`);
            resolve(new Map());
          }
        });
      });
      req.on('error', (e) => {
        console.warn(`[TAPTAP] net error: ${e.message}`);
        resolve(new Map());
      });
      req.setTimeout(10000, () => { req.abort(); resolve(new Map()); });
      req.end();
    } catch (e) {
      console.warn(`[TAPTAP] net fatal: ${e.message}`);
      resolve(new Map());
    }
  });
}

// https.request fallback (Node.js native, respects process.env.HTTPS_PROXY)
function _taptapLabelsHttps(url, appId) {
  return new Promise((resolve) => {
    try {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'X-UA': 'V=1&PN=WebApp&LANG=zh_CN&VN=1000000&PLT=PC',
        },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const m = _extractLabelMap(data);
            debugLog(`[TAPTAP] https: ${appId} videos=${(data?.data?.app_videos || []).length} mapSize=${m.size}`);
            resolve(m);
          } catch (e) {
            console.warn(`[TAPTAP] https parse error: ${e.message}`);
            resolve(new Map());
          }
        });
      });
      req.on('error', (e) => {
        console.warn(`[TAPTAP] https error: ${e.message}`);
        resolve(new Map());
      });
    } catch (e) {
      console.warn(`[TAPTAP] https fatal: ${e.message}`);
      resolve(new Map());
    }
  });
}

// Extract video_id → label Map from API response data
function _extractLabelMap(data) {
  const videos = data?.data?.app_videos || [];
  const m = new Map();
  for (const v of videos) {
    const label = TAPTAP_VIDEO_LABELS[v.type];
    if (label) m.set(String(v.id), label);
  }
  return m;
}

// Fetch ALL video entries from a playlist URL (TapTap multi-video pages)
async function fetchAllVideosInfo(url) {
  if (isDouyinUrl(url)) return [await fetchDouyinVideoInfo(url)];
  if (isXiaohongshuUrl(url)) return [await fetchXhsVideoInfo(url)];
  const isBilibili = /bilibili\.com|b23\.tv/i.test(url);
  let json;
  // Bilibili: 画质列表由 API 获取，跳过 cookie 重试阶梯
  // B站登录信息由 getCookieArgs() 按平台自动附加到 yt-dlp 调用
  // 同时启动 B站画质查询（BVID 可从 URL 直接提取，无需等 yt-dlp）
  let bilibiliQualityPromise = null;
  if (isBilibili) {
    const bvidMatch = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/i) || url.match(/b23\.tv\/(BV[a-zA-Z0-9]+)/i);
    if (bvidMatch) {
      bilibiliQualityPromise = fetchBilibiliQualityTiers(bvidMatch[1]);
    } else if (/bilibili\.com\/bangumi\/play\/ep\d+/i.test(url)) {
      // For ep URLs, extract BVID from page HTML first
      bilibiliQualityPromise = (async () => {
        try {
          const pageHtml = await _httpGet(url);
          const stateMatch = pageHtml.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
          if (stateMatch) {
            const initState = JSON.parse(stateMatch[1]);
            const bvid = initState.epInfo?.bvid || initState.bvid || initState.videoInfo?.bvid;
            if (bvid) return fetchBilibiliQualityTiers(bvid);
          }
        } catch (e) {}
        return null;
      })();
    }
  }
  json = await execYtdlp(['-j', url]);
  const lines = json.split('\n').filter(Boolean);
  const results = [];

  // Fetch TapTap video labels if this is a TapTap app URL
  const taptapMatch = url.match(/taptap\.(?:cn|io)\/app\/(\d+)/i);
  let labelMap = null;
  if (taptapMatch) {
    labelMap = await fetchTapTapVideoLabels(taptapMatch[1]);
  }

  // Await Bilibili full quality tier list (may already be resolved from parallel fetch)
  let bilibiliAllQualities = null;
  if (bilibiliQualityPromise) {
    try {
      bilibiliAllQualities = await bilibiliQualityPromise;
    } catch (e) {}
  }

  for (const line of lines) {
    const data = JSON.parse(line);
    if (isBilibili && bilibiliAllQualities) data._bilibiliAllQualities = bilibiliAllQualities;
    const info = _parseVideoData(data, url);
    // Enrich title with per-video label from TapTap API
    if (labelMap) {
      const label = labelMap.get(String(data.id)) || labelMap.get(data.id);
      if (label) {
        info.title = `${data.title || '未知标题'} - ${label}`;
        debugLog(`[TAPTAP] Matched: id=${data.id} label=${label} title=${info.title}`);
      } else {
        debugLog(`[TAPTAP] No match: id=${data.id} type=${typeof data.id} mapKeys=[${Array.from(labelMap.keys()).join(',')}]`);
      }
    }
    results.push(info);
  }

  // Fallback: if labelMap had entries but ID matching failed, try order-based matching
  if (labelMap && labelMap.size > 0 && results.length > 0) {
    const enrichedCount = results.filter(r => r.title.includes(' - ')).length;
    if (enrichedCount === 0 && labelMap.size === results.length) {
      const labels = Array.from(labelMap.values());
      console.warn(`[TAPTAP] ID matching failed, using order-based fallback: ${labels.join(', ')}`);
      for (let i = 0; i < results.length; i++) {
        results[i].title = `${results[i].title} - ${labels[i]}`;
      }
    }
  }

  return results;
}

// ========== Bilibili Quality Tier Helpers ==========

// Bilibili quality ID → estimated height (for sorting, not exact)
function _bilibiliQualityToHeight(quality) {
  const MAP = { 208: 2160, 192: 1080, 127: 4320, 125: 2160, 120: 2160, 116: 1080, 112: 1080, 100: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240 };
  return MAP[quality] || 720;
}

// Human-readable reason for why a quality tier is not downloadable
function _bilibiliDisableReason(quality) {
  if (quality === 74 || quality >= 112) return '大会员专享';
  if (quality >= 64) return '需要登录';
  return '';
}

// HTTP GET helper with gzip decompression and UTF-8 decoding
// Uses Electron's net.request (Chromium stack, handles proxy) when available,
// falls back to https.get (Node.js stack).
function _httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const timeout = opts.timeout || 10000;

    // Auto-inject B站 SESSDATA for B站 API calls
    const headers = { 'User-Agent': userAgent, ...(opts.headers || {}) };
    if (!opts.noBiliCookie && /bilibili\.com/i.test(url)) {
      const sessdata = getBilibiliSessdata();
      if (sessdata) {
        headers['Cookie'] = `SESSDATA=${sessdata}`;
      }
    }

    const handleResponse = (res) => {
      const chunks = [];
      let aborted = false;
      const timer = setTimeout(() => { aborted = true; res.destroy?.(); reject(new Error('timeout')); }, timeout);
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (aborted) return;
        clearTimeout(timer);
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const buf = Buffer.concat(chunks);
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          require('zlib').gunzip(buf, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded.toString('utf8'));
          });
        } else {
          resolve(buf.toString('utf8'));
        }
      });
      res.on('error', reject);
    };

    // Use Electron's net.request (handles system proxy, certs correctly)
    if (typeof net !== 'undefined' && net.request) {
      try {
        const req = net.request({
          method: 'GET',
          url,
          headers,
        });
        req.on('response', handleResponse);
        req.on('error', reject);
        req.setTimeout?.(timeout, () => { req.abort?.(); reject(new Error('timeout')); });
        req.end();
        return;
      } catch (e) { /* fall through to https.get */ }
    }

    // Fallback: Node.js https.get
    const req = https.get(url, { headers, timeout }, handleResponse);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Fetch Bilibili's full quality tier list via WBI-signed playurl API
// Strategy: get page HTML → extract cid + WBI keys → sign playurl request → return accept_quality
async function fetchBilibiliQualityTiers(bvid) {
  const cached = _bilibiliQualityCache.get(bvid);
  if (cached) return cached;
  try {
    // Step 1: fetch video page HTML for cid and WBI signing keys
    const pageHtml = await _httpGet(`https://www.bilibili.com/video/${bvid}/`);
    const match = pageHtml.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
    if (!match) return null;
    const initState = JSON.parse(match[1]);
    const cid = initState.cid;
    const wbiKeys = initState.defaultWbiKey;
    if (!cid || !wbiKeys || !wbiKeys.wbiImgKey || !wbiKeys.wbiSubKey) return null;

    // Step 2: generate WBI signature (method: md5(imgKey + subKey)[:16])
    const mixinKey = crypto.createHash('md5')
      .update(wbiKeys.wbiImgKey + wbiKeys.wbiSubKey)
      .digest('hex')
      .slice(0, 16);

    // Helper: signed playurl call
    const callPlayurl = (extraParams) => {
      const params = { bvid, cid: String(cid), qn: '0', fnval: '4048', try_look: '1', ...extraParams };
      const keys = Object.keys(params).sort();
      const queryStr = keys.map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
      const wts = Math.floor(Date.now() / 1000);
      const w_rid = crypto.createHash('md5').update(queryStr + mixinKey + wts).digest('hex');
      return _httpGet(`https://api.bilibili.com/x/player/wbi/playurl?${queryStr}&w_rid=${w_rid}&wts=${wts}`);
    };

    // Step 3: call playurl (Bilibili may require voucher redemption for rate-limited IPs)
    let apiData = JSON.parse(await callPlayurl({}));
    if (apiData.code !== 0 || !apiData.data) return null;

    // Case A: voucher required → redeem it
    if (apiData.data.v_voucher) {
      apiData = JSON.parse(await callPlayurl({ voucher: apiData.data.v_voucher }));
      if (apiData.code !== 0 || !apiData.data) return null;
    }

    // Case B: accept_quality returned directly (no voucher needed)
    if (Array.isArray(apiData.data.accept_quality)) {
      const qualities = apiData.data.accept_quality;
      const descriptions = apiData.data.accept_description || [];
      const result = qualities.map((q, i) => ({ quality: q, description: descriptions[i] || `${q}p` }));
      debugLog(`[BILIBILI] Quality tiers for ${bvid}: ${qualities.join(',')}`);
      _bilibiliQualityCache.set(bvid, result);
      return result;
    }
  } catch (e) {
    debugLog(`[BILIBILI] Quality fetch failed for ${bvid}: ${e.message}`);
  }
  return null;
}

// Parse a single yt-dlp JSON data object into the app's video info structure
function _parseVideoData(data, url) {
  const formats = data.formats || [];
  const duration = data.duration || 0;

  let title = data.title || '未知标题';

  // Detect format characteristics: combined audio (non-DASH) and HLS protocol
  const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none');
  const allHaveEmbeddedAudio = videoFormats.length > 0 && videoFormats.every(f => f.acodec && f.acodec !== 'none');
  const isHlsSource = videoFormats.some(f => f.protocol === 'm3u8_native' || f.protocol === 'm3u8');

  const isTapTap = url && /taptap\.(cn|io)/i.test(url);

  // Map a height to a human-readable label.
  // TapTap HLS formats carry clean format_ids ("2k","1080p","720p",…); use those directly.
  // For other sources, use standard landscape labels; non-standard heights get plain "{h}p".
  function getResolutionLabel(h, fmt) {
    if (isTapTap && fmt && fmt.format_id) {
      const clean = fmt.format_id.replace(/[_-]?(hvc|hev|avc|av01|vp9?|h26[45]).*$/i, '').trim();
      if (clean && !/^\d+$/.test(clean)) return clean;
    }
    const MAP = { 2160: '4K（2160P）', 1440: '2K（1440P）', 1080: '1080P（全高清）', 720: '720P（高清）', 480: '480P（标清）', 360: '360P（流畅）' };
    return MAP[h] || `${h}P`;
  }

  // ---- Resolution grouping ----
  // For Bilibili: group by format display name to preserve quality tiers
  // (e.g. "1080P 高码率" and "1080P 高清" both at 1080p but distinct).
  // For other sources: group by height only (existing behavior).
  const isBilibili = data.extractor === 'BiliBili';

  let resolutionGroups = [];
  if (isBilibili) {
    const formatMap = new Map();
    for (const f of videoFormats) {
      if (!f.height) continue;
      const key = f.format || `${f.height}p`;
      if (!formatMap.has(key)) formatMap.set(key, []);
      formatMap.get(key).push(f);
    }
    resolutionGroups = [...formatMap.entries()]
      .map(([name, fmts]) => ({
        name,
        formats: fmts,
        height: Math.max(...fmts.map(f => f.height)),
        quality: Math.max(...fmts.map(f => f.quality || 0)),
      }))
      .sort((a, b) => b.height - a.height || b.quality - a.quality);

    // Inject virtual entries for quality tiers that exist on Bilibili but are not downloadable
    if (data._bilibiliAllQualities) {
      const existingQualities = new Set();
      for (const group of resolutionGroups) {
        for (const f of group.formats) {
          if (f.quality) existingQualities.add(f.quality);
        }
      }
      for (const qInfo of data._bilibiliAllQualities) {
        if (!existingQualities.has(qInfo.quality)) {
          const height = _bilibiliQualityToHeight(qInfo.quality);
          resolutionGroups.push({
            name: qInfo.description,
            formats: [{ quality: qInfo.quality, height, format: qInfo.description, vcodec: 'placeholder', acodec: 'none', _virtual: true }],
            height,
            quality: qInfo.quality,
          });
        }
      }
      resolutionGroups.sort((a, b) => b.height - a.height || b.quality - a.quality);
    }
  } else {
    const uniqueHeights = [...new Set(videoFormats.map(f => f.height).filter(h => h))].sort((a, b) => b - a);
    resolutionGroups = uniqueHeights.map(h => ({
      name: null,
      formats: videoFormats.filter(f => f.height === h),
      height: h,
      quality: 0,
    }));
  }

  // Pick best format from a list by codec priority, then filesize
  function pickBestFormat(fmtList) {
    if (!fmtList || fmtList.length === 0) return null;
    const sorted = [...fmtList].sort((a, b) => {
      const pa = getCodecPriority(a.vcodec);
      const pb = getCodecPriority(b.vcodec);
      if (pa !== pb) return pa - pb;
      const szA = a.filesize || a.filesize_approx || 0;
      const szB = b.filesize || b.filesize_approx || 0;
      if (szA !== szB) return szB - szA;
      return (a.tbr || 0) - (b.tbr || 0);
    });
    return sorted[0];
  }

  // ---- Find best audio-only format (bestaudio[ext=m4a] / bestaudio) ----
  function getBestAudioFormat() {
    const audioFormats = formats.filter(f =>
      f.vcodec === 'none' && f.acodec && f.acodec !== 'none'
    );
    if (audioFormats.length === 0) return null;
    const m4a = audioFormats.filter(f => f.audio_ext === 'm4a');
    const candidates = m4a.length > 0 ? m4a : audioFormats;
    return candidates.reduce((a, b) =>
      ((a.filesize || a.filesize_approx || 0) > (b.filesize || b.filesize_approx || 0)) ? a : b
    );
  }

  const bestAudioFmt = getBestAudioFormat();

  // Audio size: filesize > filesize_approx > tbr×duration > 160Kbps×duration
  function getAudioSize() {
    if (bestAudioFmt) {
      if (bestAudioFmt.filesize && bestAudioFmt.filesize > 0) return bestAudioFmt.filesize;
      if (bestAudioFmt.filesize_approx && bestAudioFmt.filesize_approx > 0) return bestAudioFmt.filesize_approx;
      if (bestAudioFmt.abr && bestAudioFmt.abr > 0 && duration > 0) {
        return Math.round(bestAudioFmt.abr * 125 * duration);
      }
      if (bestAudioFmt.tbr && bestAudioFmt.tbr > 0 && duration > 0) {
        return Math.round(bestAudioFmt.tbr * 125 * duration);
      }
    }
    if (duration > 0) return Math.round(160 * 125 * duration);
    return 0;
  }

  const audioSize = getAudioSize();

  // ---- Codec priority matching yt-dlp's default sort order: av01 > vp9 > h264 ----
  function getCodecPriority(vcodec) {
    if (!vcodec) return 999;
    if (vcodec.startsWith('av01')) return 0;
    if (vcodec.startsWith('vp')) return 1;
    // avc1/h264 (H.264) and hvc1/hev1 (H.265) — yt-dlp treats them similarly
    if (vcodec.startsWith('avc') || vcodec.startsWith('h264') || vcodec.startsWith('hvc') || vcodec.startsWith('hev')) return 2;
    return 3;
  }

  // ---- Find best video format for a given height cap, matching yt-dlp's preference ----
  function getBestVideoFormat(heightCap) {
    const candidates = formats.filter(f =>
      f.height && f.height <= heightCap && f.vcodec && f.vcodec !== 'none'
    );
    if (candidates.length === 0) return null;
    const maxH = Math.max(...candidates.map(f => f.height));
    const atMaxH = candidates.filter(f => f.height === maxH);
    // Sort by codec priority (av01 > vp9 > h264≈h265), then by filesize descending,
    // then by tbr ascending (prefer efficient codec for HLS sources without known filesize)
    atMaxH.sort((a, b) => {
      const pa = getCodecPriority(a.vcodec);
      const pb = getCodecPriority(b.vcodec);
      if (pa !== pb) return pa - pb;
      const szA = a.filesize || a.filesize_approx || 0;
      const szB = b.filesize || b.filesize_approx || 0;
      if (szA !== szB) return szB - szA;
      return (a.tbr || 0) - (b.tbr || 0);
    });
    return atMaxH[0];
  }

  // Resolution bitrate presets (Mbps) — last-resort fallback
  const BITRATE_MAP = { 2160: 16, 1440: 8, 1080: 5, 720: 2.5, 480: 1.2, 360: 0.7 };

  // Video size with fallback chain. Returns { size, estimated }.
  function getVideoSize(fmt, heightCap) {
    if (!fmt) return { size: 0, estimated: false };
    if (fmt.filesize && fmt.filesize > 0) return { size: fmt.filesize, estimated: false };
    if (fmt.filesize_approx && fmt.filesize_approx > 0) return { size: fmt.filesize_approx, estimated: false };
    if (fmt.vbr && fmt.vbr > 0 && duration > 0) {
      const abrVal = (fmt.abr && fmt.abr > 0) ? fmt.abr : 128;
      return { size: Math.round((fmt.vbr + abrVal) * 125 * duration), estimated: true };
    }
    if (fmt.tbr && fmt.tbr > 0 && duration > 0) {
      let size = Math.round(fmt.tbr * 125 * duration);
      if (isHlsSource) size = Math.round(size * 0.95);
      return { size, estimated: true };
    }
    if (duration > 0) {
      const rate = (BITRATE_MAP[heightCap] || 5) * 1000;
      return { size: Math.round(rate * 125 * duration), estimated: true };
    }
    return { size: 0, estimated: false };
  }

  // Format size label: always show "约" since all sizes are estimates
  function buildSizeLabel(bytes) {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return ` 约${(mb / 1024).toFixed(1)}G`;
    return ` 约${mb.toFixed(0)}M`;
  }

  // ---- Build resolution options with multi-layer size estimation ----
  const resolutionOptions = [];

  // "最佳画质（自动）" — uses the highest actual available height as cap
  if (resolutionGroups.length > 0) {
    const maxH = resolutionGroups[0].height;
    const fmt = getBestVideoFormat(maxH);
    const vInfo = fmt ? getVideoSize(fmt, maxH) : { size: 0, estimated: false };
    const fmtHasAudio = fmt && fmt.acodec && fmt.acodec !== 'none';
    const totalSize = vInfo.size > 0 ? vInfo.size + (fmtHasAudio ? 0 : audioSize) : audioSize;
    resolutionOptions.push({
      id: 'best',
      label: `最佳画质（自动）${buildSizeLabel(totalSize)}`,
      height: 99999, ext: 'mp4', formatNote: 'best',
      hasAudio: fmtHasAudio, filesize: totalSize,
    });
  }

  // One option per resolution group — preserves Bilibili quality tiers (e.g.
  // "1080P 高码率" and "1080P 高清" both at 1080p but listed separately).
  for (const group of resolutionGroups) {
    const h = group.height;
    const fmt = pickBestFormat(group.formats);
    if (!fmt) continue;
    const isVirtual = fmt._virtual;
    const vInfo = getVideoSize(fmt, h);
    const fmtHasAudio = fmt.acodec && fmt.acodec !== 'none';
    const totalSize = vInfo.size > 0 ? vInfo.size + (fmtHasAudio ? 0 : audioSize) : audioSize;
    const maxFps = fmt.fps || 0;
    const label = isBilibili ? group.name : getResolutionLabel(h, fmt);
    const fmtId = isBilibili
      ? (isVirtual ? `bili_${fmt.quality}` : fmt.format_id)
      : (fmtHasAudio ? `best[height<=${h}]` : `bestvideo[height<=${h}]`);
    resolutionOptions.push({
      id: fmtId,
      label: `${label}${!isBilibili && maxFps >= 60 ? ` ${maxFps} 帧` : ''}${isVirtual ? '' : buildSizeLabel(totalSize)}`,
      height: h, ext: 'mp4', formatNote: isBilibili ? group.name : `${h}P`,
      filesize: totalSize, hasAudio: fmtHasAudio,
      _virtual: isVirtual,
      _disableReason: isVirtual ? _bilibiliDisableReason(fmt.quality) : '',
    });
  }

  resolutionOptions.sort((a, b) => b.height - a.height);
  const audioSizeLabel = buildSizeLabel(audioSize);
  resolutionOptions.push({ id: 'audio', label: `仅音频（MP3）${audioSizeLabel}`, height: 0, ext: 'mp3', formatNote: 'audio', filesize: audioSize });

  // Parse subtitles
  const subtitleList = [];
  try {
    const allSubs = { ...(data.subtitles || {}), ...(data.automatic_captions || {}) };
    const seen = new Set();
    for (const [lang, subs] of Object.entries(allSubs)) {
      if (subs && subs.length > 0 && !seen.has(lang)) {
        seen.add(lang);
        const ext = subs.find(s => s.ext === 'srt' || s.ext === 'vtt') || subs[0];
        subtitleList.push({
          lang,
          name: `${lang} — ${ext.name || ext.ext || ''}`,
          url: ext.url,
          ext: ext.ext,
        });
      }
    }
  } catch (e) { /* subtitles not available */ }

  return {
    title,
    thumbnail: (data.thumbnail || '').replace(/^http:\/\//i, 'https://'),
    duration: data.duration || 0,
    channel: data.channel || data.uploader || '',
    channelUrl: data.channel_url || '',
    description: (data.description || '').slice(0, 500),
    resolutionOptions,
    subtitleList,
    webpageUrl: url,
    videoId: data.id,
    needsNativeDownload: isHlsSource || isBilibili,
    playlistIndex: data.playlist_index || 1,
  };
}

// ========== Queue & Download Management ==========

function getQueue() {
  return downloadQueue.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title || '',
    status: t.status,
    progress: t.progress || { percent: 0, speed: '', eta: '', totalSize: '' },
    options: t.options,
    outputFile: t.outputFile || null,
    error: t.error || null,
  }));
}

function emitQueue() {
  if (_emitQueuePending) return;
  _emitQueuePending = true;
  Promise.resolve().then(() => {
    _emitQueuePending = false;
    sendToWindow('queue-updated', getQueue());
  });
}

function addToHistory(entry) {
  const history = getHistory();
  history.unshift({
    id: entry.id,
    title: entry.title || '未知视频',
    url: entry.url,
    format: entry.options?.formatNote || 'best',
    actualResolution: entry.options?.actualResolution || '',
    filePath: entry.outputFile,
    downloadedAt: new Date().toISOString(),
    fileSize: entry.progress?.totalSize || '',
  });
  if (history.length > 200) history.length = 200;
  saveHistory(history);
}

function addTaskToQueue(url, options) {
  const initialTotalSize = (options?.filesize > 0) ? formatBytes(options.filesize) : '';
  const task = {
    id: generateId(),
    url,
    title: options?.title || '',
    status: 'queued',
    progress: { percent: 0, speed: '', eta: '', totalSize: initialTotalSize },
    options,
    outputFile: null,
    error: null,
  };
  downloadQueue.unshift(task);
  emitQueue();
  processQueue();
  return task.id;
}

async function resumeQueuedRpcTask(task, state) {
  if (task.status !== 'fetching' || !downloadQueue.some(item => item.id === task.id)) {
    activeTaskIds.delete(task.id);
    return;
  }
  try {
    if (state.videoGid) await aria2RpcCall('aria2.unpause', [state.videoGid]);
    if (state.audioGid) await aria2RpcCall('aria2.unpause', [state.audioGid]);
    task.status = 'downloading';
    task._startTime = Date.now();
    task._connectingSent = false;
    task.progress.speed = '';
    task.progress.eta = '';
    startProgressPolling();
    emitQueue();
  } catch (e) {
    activeTaskIds.delete(task.id);
    task.status = 'error';
    task.error = '恢复下载失败，请点击重试';
    debugLog(`[RESUME] ${task.id}: ${e.message}`);
    emitQueue();
    setTimeout(() => processQueue(), 100);
  }
}

function processQueue() {
  if (_shuttingDown) return;
  const maxConcurrent = getMaxConcurrentDownloads();
  if (downloadQueue.length === 0 || activeTaskIds.size >= maxConcurrent) return;

  const slots = maxConcurrent - activeTaskIds.size;
  const nextTasks = downloadQueue.filter(t => t.status === 'queued').slice(0, slots);

  let changed = false;
  let delay = 0;
  for (const task of nextTasks) {
    activeTaskIds.add(task.id);
    task.status = 'fetching';
    changed = true;
    const state = downloadStates.get(task.id);
    if (state && (state.videoGid || state.audioGid)) {
      setTimeout(() => resumeQueuedRpcTask(task, state), delay);
    } else {
      setTimeout(() => executeDownload(task), delay);
    }
    delay += 100;
  }
  if (changed) emitQueue();
}
// ========== Download Execution (yt-dlp) ==========

function getYtdlpFormatCode(task) {
  if (task.options.audioOnly || task.options.formatId === 'audio') {
    return 'bestaudio[ext=m4a]/bestaudio/best';
  }

  const container = getOutputContainer(task);
  const audioSelector = container === 'webm'
    ? 'bestaudio[ext=webm]/bestaudio'
    : 'bestaudio[ext=m4a]/bestaudio';

  if (task.options.formatId === 'best') {
    return `bestvideo[ext=${container}]+${audioSelector}/best[ext=${container}]/bestvideo+bestaudio/best`;
  }

  const hMatch = task.options.formatId.match(/height<=(\d+)/);
  if (isYouTubeUrl(task.url) && hMatch) {
    const height = hMatch[1];
    return `bestvideo[height<=${height}][ext=${container}]+${audioSelector}/best[height<=${height}][ext=${container}]/bestvideo[height<=${height}]+bestaudio/best`;
  }

  if (task.options.hasAudio) return task.options.formatId;
  const audioExt = container === 'webm' ? 'webm' : 'm4a';
  return `${task.options.formatId}[ext=${container}]+bestaudio[ext=${audioExt}]/${task.options.formatId}+bestaudio[ext=${audioExt}]/${task.options.formatId}+bestaudio/best`;
}
// ========== Aria2 RPC Download Manager ==========

const http = require('http');

function getAria2DownloadOptions(dir, out, proxy, extraHeaders, sourceUrl) {
  const isYouTubeTarget = isYouTubeUrl(sourceUrl);
  const opts = {
    dir, out,
    'continue': true,
    'max-connection-per-server': isYouTubeTarget ? '4' : '16',
    'split': isYouTubeTarget ? '4' : '16',
    'min-split-size': '1M',
    'connect-timeout': '30',
    'timeout': '30',
    'retry-wait': '3',
    'max-tries': '10',
    'allow-overwrite': true,
    'auto-file-renaming': false,
  };
  if (proxy) opts['all-proxy'] = proxy;
  if (extraHeaders && extraHeaders.length > 0) opts['header'] = extraHeaders;
  return opts;
}

async function aria2RpcCall(method, params = []) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now().toString(36),
    method,
    params: [`token:${aria2RpcSecret}`, ...params],
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: aria2RpcPort,
      path: '/jsonrpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('多线程下载组件响应超时，请重启软件后重试')); });
    req.write(body);
    req.end();
  });
}

async function resolveSingleUrl(videoUrl, formatCode, timeout = 30000) {
  if (isDouyinUrl(videoUrl)) {
    const selected = await resolveDouyinFormat(videoUrl, formatCode);
    return selected.url;
  }
  const output = await execYtdlp(['-g', '-f', formatCode, videoUrl], {
    timeout,
    timeoutMsg: '解析下载资源超时',
  });
  return output.split('\n').map(line => line.trim()).find(Boolean) || null;
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = nodeNet.createServer();
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch (e) {}
      resolve(value);
    };
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => finish(true));
  });
}

async function findAvailableAria2Port() {
  for (let offset = 0; offset < 20; offset++) {
    const candidate = ARIA2_RPC_PORT_START + offset;
    if (await canBindPort(candidate)) return candidate;
  }
  return 0;
}

async function startAria2Rpc() {
  if (_shuttingDown) return false;
  if (!aria2cPath) { debugLog('[RPC] aria2c not found'); return false; }

  const availablePort = await findAvailableAria2Port();
  if (_shuttingDown) return false;
  if (!availablePort) {
    debugLog('[RPC] No available local RPC port');
    return false;
  }
  aria2RpcPort = availablePort;
  aria2RpcSecret = crypto.randomBytes(24).toString('hex');

  const proxy = getEffectiveProxy();
  const aArgs = [
    '--enable-rpc',
    '--rpc-listen-port', String(aria2RpcPort),
    '--rpc-secret', aria2RpcSecret,
    '--continue=true',
    '-x', '16',
    '-s', '16',
    '-k', '2M',
    '--min-split-size=1M',
    '--max-connection-per-server=16',
    '--file-allocation=none',
    '--connect-timeout=30',
    '--timeout=30',
    '--retry-wait=3',
    '--max-tries=10',
    '--summary-interval=2',
    '--console-log-level=error',
    '--enable-color=false',
    '--rpc-listen-all=false',
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
  ];
  if (proxy) aArgs.push('--all-proxy', proxy);

  debugLog(`[RPC] Starting aria2c on local port ${aria2RpcPort}`);
  let spawnFailed = false;
  aria2RpcProc = spawn(aria2cPath, aArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  aria2RpcProc.stderr.on('data', d => { debugLog(`[RPC] ${d.toString().trim()}`); });
  aria2RpcProc.once('error', (error) => {
    spawnFailed = true;
    debugLog(`[RPC] Failed to launch aria2c: ${error.message}`);
    aria2RpcProc = null;
  });
  aria2RpcProc.on('exit', (code) => {
    debugLog(`[RPC] aria2c exited code=${code}`);
    aria2RpcProc = null;
  });

  for (let i = 0; i < 25 && !spawnFailed; i++) {
    try {
      await aria2RpcCall('aria2.getGlobalStat');
      debugLog('[RPC] Ready');
      return true;
    } catch (e) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  debugLog('[RPC] Failed to start');
  stopAria2Rpc();
  return false;
}

function stopAria2Rpc() {
  if (aria2RpcPollTimer) { clearInterval(aria2RpcPollTimer); aria2RpcPollTimer = null; }
  const proc = aria2RpcProc;
  aria2RpcProc = null;
  if (proc) terminateProcessTree(proc).catch(() => {});
}

async function stopAllManagedProcesses() {
  _shuttingDown = true;
  if (aria2RpcPollTimer) { clearInterval(aria2RpcPollTimer); aria2RpcPollTimer = null; }
  const processes = new Set([
    aria2RpcProc,
    ...nativeDownloadProcs.values(),
    ...mediaMergeProcs.values(),
  ].filter(Boolean));
  aria2RpcProc = null;
  nativeDownloadProcs.clear();
  mediaMergeProcs.clear();
  await Promise.allSettled([...processes].map(proc => terminateProcessTree(proc)));
}
async function ensureAria2Rpc() {
  // Quick check: RPC already responsive
  try {
    await aria2RpcCall('aria2.getGlobalStat');
    return true;
  } catch (e) {
    // Avoid concurrent restart attempts
    if (_aria2Restarting) {
      debugLog('[RPC] Restart already in progress, waiting...');
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200));
        try { await aria2RpcCall('aria2.getGlobalStat'); return true; }
        catch (e2) { /* still waiting */ }
      }
      return false;
    }
    _aria2Restarting = true;
    try {
      debugLog(`[RPC] Unresponsive (${e.message}), restarting...`);
      stopAria2Rpc();
      await new Promise(r => setTimeout(r, 500));
      const ok = await startAria2Rpc();
      if (ok) debugLog('[RPC] Restart OK');
      else debugLog('[RPC] Restart failed');
      return ok;
    } finally {
      _aria2Restarting = false;
    }
  }
}

function mergeMediaFiles(videoFile, audioFile, outputFile, taskId) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', videoFile, '-i', audioFile, '-c', 'copy'];
    if (path.extname(outputFile).toLowerCase() === '.mp4') args.push('-movflags', '+faststart');
    args.push(outputFile);
    const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (taskId) mediaMergeProcs.set(taskId, proc);
    let stderr = '';
    proc.stderr.on('data', data => stderr += data.toString());
    proc.on('close', (code) => {
      if (taskId) mediaMergeProcs.delete(taskId);
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(0, 300)));
    });
    proc.on('error', error => {
      if (taskId) mediaMergeProcs.delete(taskId);
      reject(error);
    });
  });
}

function execFileCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: options.timeout || 15000,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function verifyMediaFile(filePath) {
  if (!existsSync(filePath)) return { ok: false, error: '文件不存在' };

  if (ffprobePath) {
    const result = await execFileCapture(ffprobePath, [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath,
    ]);
    if (!result.error) {
      try {
        const info = JSON.parse(result.stdout);
        const streams = info.streams || [];
        const videos = streams.filter(stream => stream.codec_type === 'video');
        const audios = streams.filter(stream => stream.codec_type === 'audio');
        const duration = parseFloat(info.format?.duration || 0);
        const ok = videos.length >= 1 && audios.length >= 1 && duration > 0;
        return {
          ok,
          videoStreams: videos.length,
          audioStreams: audios.length,
          duration,
          width: videos[0]?.width || 0,
          height: videos[0]?.height || 0,
          error: !ok ? (videos.length === 0 ? '无视频流' : audios.length === 0 ? '无音频流' : '时长异常') : '',
        };
      } catch (e) {
        debugLog(`[VERIFY] ffprobe JSON parse failed: ${e.message}`);
      }
    }
  }

  if (!ffmpegPath) return { ok: false, error: '缺少媒体校验组件' };
  const result = await execFileCapture(ffmpegPath, ['-i', filePath]);
  const output = result.stderr || result.stdout;
  const videoStreams = (output.match(/Stream.*Video/gi) || []).length;
  const audioStreams = (output.match(/Stream.*Audio/gi) || []).length;
  const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const resolutionMatch = output.match(/(?:,|\s)(\d{3,5})x(\d{3,5})(?:[\s,])/);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  const ok = videoStreams >= 1 && audioStreams >= 1 && duration > 0;
  return {
    ok,
    videoStreams,
    audioStreams,
    duration,
    width: resolutionMatch ? Number(resolutionMatch[1]) : 0,
    height: resolutionMatch ? Number(resolutionMatch[2]) : 0,
    error: !ok ? (videoStreams === 0 ? '无视频流' : audioStreams === 0 ? '无音频流' : '时长异常') : '',
  };
}

async function detectMediaResolution(filePath) {
  if (!filePath || !existsSync(filePath)) return '';
  if (ffprobePath) {
    const result = await execFileCapture(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', filePath,
    ]);
    const match = result.stdout.trim().match(/^(\d{2,5})x(\d{2,5})$/);
    if (match) return `${match[1]}x${match[2]}`;
  }
  if (ffmpegPath) {
    const result = await execFileCapture(ffmpegPath, ['-i', filePath]);
    const output = result.stderr || result.stdout;
    const match = output.match(/(?:,|\s)(\d{3,5})x(\d{3,5})(?:[\s,])/);
    if (match) return `${match[1]}x${match[2]}`;
  }
  return '';
}
function cleanupTempFiles(videoFile, audioFile, finalFile) {
  const dir = path.dirname(videoFile || audioFile || finalFile);
  const toDelete = [];
  if (videoFile && existsSync(videoFile)) toDelete.push(videoFile);
  if (audioFile && existsSync(audioFile)) toDelete.push(audioFile);
  // Also remove aria2 .part and .aria2 control files
  const files = readdirSync(dir);
  const baseNames = [];
  if (videoFile) baseNames.push(path.basename(videoFile));
  if (audioFile) baseNames.push(path.basename(audioFile));
  for (const f of files) {
    for (const base of baseNames) {
      if (f === base + '.part' || f === base + '.aria2') {
        toDelete.push(path.join(dir, f));
      }
    }
  }
  for (const fp of toDelete) {
    try { unlinkSync(fp); debugLog(`[CLEANUP] Deleted temp: ${path.basename(fp)}`); } catch (e) {}
  }
}

// ====== RPC progress polling ======

function startProgressPolling() {
  if (aria2RpcPollTimer) return;
  debugLog('[POLL] Starting');
  aria2RpcPollTimer = setInterval(() => { pollActiveTasks().catch(() => {}); }, 400);
}

function stopProgressPolling() {
  if (aria2RpcPollTimer) { clearInterval(aria2RpcPollTimer); aria2RpcPollTimer = null; }
}

async function failAriaTask(task, state, error) {
  if (state.connectTimer) clearInterval(state.connectTimer);
  if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
  try {
    if (state.videoGid) await aria2RpcCall('aria2.remove', [state.videoGid]);
    if (state.audioGid) await aria2RpcCall('aria2.remove', [state.audioGid]);
  } catch (e) {}
  downloadStates.delete(task.id);
  activeTaskIds.delete(task.id);
  task.status = 'error';
  task.progress.speed = '';
  task.progress.eta = '';
  task.error = translateError(error?.message) || '下载失败，请重试';
  emitQueue();
  sendToWindow('download-error', task.id, task.error);
  setTimeout(() => processQueue(), 100);
}

async function pollActiveTasks() {
  if (_pollInFlight) return;
  _pollInFlight = true;
  let hasPollableTask = false;
  try {
    for (const [taskId, state] of downloadStates) {
      if (!state || (!state.videoGid && !state.audioGid)) continue;
      const task = downloadQueue.find(t => t.id === taskId);
      if (!task || task.status !== 'downloading') continue;
      hasPollableTask = true;
      try {
        await pollTaskProgress(task, state);
        state.pollFailures = 0;
      } catch (e) {
        state.pollFailures = (state.pollFailures || 0) + 1;
        debugLog(`[POLL] ${taskId} failure ${state.pollFailures}: ${e.message}`);
        if (state.pollFailures >= 3) await failAriaTask(task, state, e);
      }
    }
  } finally {
    _pollInFlight = false;
  }
  if (!hasPollableTask) stopProgressPolling();
}
async function pollTaskProgress(task, state) {
  let totalCompleted = 0, totalLength = 0, totalSpeed = 0;
  let videoComplete = !state.videoGid, audioComplete = !state.audioGid;

  if (state.videoGid) {
    const s = await aria2RpcCall('aria2.tellStatus', [state.videoGid]);
    if (s.status === 'error') {
      debugLog(`[ARIA2] Video error ${s.errorCode || ''}: ${s.errorMessage || ''}`);
      throw new Error('视频下载失败，请检查网络或代理后重试');
    }
    if (s.status === 'removed') throw new Error('下载任务已被下载引擎移除，请重试');
    totalCompleted += parseInt(s.completedLength) || 0;
    totalLength += parseInt(s.totalLength) || 0;
    totalSpeed += parseInt(s.downloadSpeed) || 0;
    videoComplete = (s.status === 'complete');
  }
  if (state.audioGid) {
    const s = await aria2RpcCall('aria2.tellStatus', [state.audioGid]);
    if (s.status === 'error') {
      debugLog(`[ARIA2] Audio error ${s.errorCode || ''}: ${s.errorMessage || ''}`);
      throw new Error('音频下载失败，请检查网络或代理后重试');
    }
    if (s.status === 'removed') throw new Error('下载任务已被下载引擎移除，请重试');
    totalCompleted += parseInt(s.completedLength) || 0;
    totalLength += parseInt(s.totalLength) || 0;
    totalSpeed += parseInt(s.downloadSpeed) || 0;
    audioComplete = (s.status === 'complete');
  }

  task.progress.speed = formatSpeed(totalSpeed);
  task.progress.eta = totalSpeed > 0 ? formatEta((totalLength - totalCompleted) / totalSpeed) : '';
  if (totalLength > 0) {
    task.progress.percent = Math.min(100, Math.max(0, (totalCompleted / totalLength) * 100));
    task.progress.totalSize = formatBytes(totalLength);
    // Clear start timeout now that aria2 has reported progress
    if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
    // Transition stage from "connecting" to "downloading" on first real progress
    if (!task._progressStarted) {
      task._progressStarted = true;
      sendToWindow('download-stage', task.id, 'downloading');
    }
  }

  const now = Date.now();
  if (!task._lastEmit || now - task._lastEmit >= 300) {
    // Skip emit if progress hasn't changed meaningfully since last send
    const newPct = task.progress.percent;
    const newSpeed = task.progress.speed;
    if (newPct !== task._lastPct || newSpeed !== task._lastSpeed) {
      emitQueue();
      task._lastEmit = now;
      task._lastPct = newPct;
      task._lastSpeed = newSpeed;
    }
  }

  if (videoComplete && audioComplete) {
    if (state.connectTimer) { clearInterval(state.connectTimer); state.connectTimer = null; }

    // Re-check: task must still be in downloading state (guard against pause race)
    if (task.status !== 'downloading') return;

    task._finalizing = true;
    task.stage = state.isDash ? 'merging' : 'finalizing';
    downloadStates.delete(task.id);
    activeTaskIds.delete(task.id);
    task.progress.speed = ''; task.progress.eta = '';
    sendToWindow('download-stage', task.id, task.stage);
    emitQueue();

    if (state.isDash) {
      // ---- Pre-merge checks ----
      try {
        // Re-confirm both aria2 GIDs are 'complete'
        if (state.videoGid) {
          const vs = await aria2RpcCall('aria2.tellStatus', [state.videoGid]);
          if (vs.status !== 'complete') throw new Error('视频流尚未完成');
        }
        if (state.audioGid) {
          const as = await aria2RpcCall('aria2.tellStatus', [state.audioGid]);
          if (as.status !== 'complete') throw new Error('音频流尚未完成');
        }
        // Verify temp files exist and have content
        if (!existsSync(state.videoFile)) throw new Error('视频临时文件不存在');
        if (!existsSync(state.audioFile)) throw new Error('音频临时文件不存在');
        if (statSync(state.videoFile).size === 0) throw new Error('视频临时文件为空');
        if (statSync(state.audioFile).size === 0) throw new Error('音频临时文件为空');
      } catch (e) {
        task._finalizing = false;
        task.stage = '';
        debugLog(`[MERGE] Pre-check failed for ${task.id}: ${String(e.message || e).substring(0, 300)}`);
        task.status = 'error';
        task.error = '合并前检查失败，请重新下载后重试';
        emitQueue();
        sendToWindow('download-error', task.id, task.error);
        setTimeout(() => processQueue(), 200);
        return;
      }

      // ---- Merge ----
      try {
        await mergeMediaFiles(state.videoFile, state.audioFile, state.outputFile, task.id);
      } catch (e) {
        if (task.status === 'cancelled' || task.status === 'paused') return;
        task._finalizing = false;
        task.stage = '';
        debugLog(`[MERGE] Failed for ${task.id}: ${String(e.message || e).substring(0, 300)}`);
        task.status = 'error';
        task.error = '音视频合并失败，请检查高清合并组件是否完整后重试';
        emitQueue();
        sendToWindow('download-error', task.id, task.error);
        setTimeout(() => processQueue(), 200);
        return;
      }

      // ---- ffprobe verify ----
      const verify = await verifyMediaFile(state.outputFile);
      if (!verify.ok) {
        task._finalizing = false;
        task.stage = '';
        task.status = 'error';
        task.error = '合并后文件校验失败，请重试';
        emitQueue();
        sendToWindow('download-error', task.id, task.error);
        // Keep temp files for retry — do NOT delete them
        setTimeout(() => processQueue(), 200);
        return;
      }

      // ---- Verification passed: cleanup temp files ----
      cleanupTempFiles(state.videoFile, state.audioFile, state.outputFile);
      task.outputFile = state.outputFile;
      if (verify.width && verify.height) task.options.actualResolution = `${verify.width}x${verify.height}`;
      await finishDownload(task);
    } else {
      task.outputFile = state.videoFile;
      await finishDownload(task);
    }
  }
}

// ====== RPC-based download execution ======

async function downloadPlatformViaNative(task, selectedFormat, outPath, audioOnly, platform = 'douyin') {
  const isXhs = platform === 'xiaohongshu';
  const platformName = isXhs ? '小红书' : '抖音';
  const referer = isXhs ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/';
  const userAgent = isXhs ? XHS_USER_AGENT : DOUYIN_USER_AGENT;
  task.options.isNativeDownload = true;
  sendToWindow('download-stage', task.id, audioOnly ? 'converting' : 'downloading');
  const args = [
    '--downloader', 'native',
    '--add-header', `Referer:${referer}`,
    '--add-header', `User-Agent:${userAgent}`,
  ];
  if (audioOnly) {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }
  args.push('-o', outPath, selectedFormat.url);
  task._startTime = Date.now();
  await execYtdlpWithProgress(args, task);
  if (!existsSync(outPath) || statSync(outPath).size <= 0) {
    throw new Error(audioOnly
      ? `${platformName}音频转换完成后未找到有效文件`
      : `${platformName}视频下载完成后未找到有效文件`);
  }
  task.outputFile = outPath;
  await finishDownload(task);
}

function getDouyinImageExtension(contentType, sourceUrl) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('png')) return 'png';
  if (type.includes('avif')) return 'avif';
  if (type.includes('gif')) return 'gif';
  if (type.includes('webp')) return 'webp';
  try {
    const ext = path.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch (e) {}
  return 'webp';
}

async function downloadPlatformImageCollection(task, selectedFormat, outputDir, baseName, platform = 'douyin') {
  const isXhs = platform === 'xiaohongshu';
  const platformName = isXhs ? '小红书' : '抖音';
  const referer = isXhs ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/';
  const userAgent = isXhs ? XHS_USER_AGENT : DOUYIN_USER_AGENT;
  const images = Array.isArray(selectedFormat?.images) ? selectedFormat.images : [];
  if (selectedFormat?.kind !== 'images' || images.length === 0) {
    throw new Error(`该${platformName}图文作品没有可下载的原图`);
  }

  const outputFolder = reserveOutputDirectory(task, outputDir, baseName);
  mkdirSync(outputFolder, { recursive: true });
  const browserSession = session.fromPartition(isXhs ? 'persist:xiaohongshu-public' : 'persist:douyin-public');
  const concurrency = isXhs ? Math.min(4, images.length) : 1;
  const activeControllers = new Set();
  task._imageAbortControllers = activeControllers;
  const startedAt = Date.now();
  let totalBytes = 0;
  let completedCount = 0;
  let nextIndex = 0;
  let fatalError = null;

  const stopAll = error => {
    if (!fatalError) fatalError = error;
    for (const controller of activeControllers) controller.abort();
  };

  const downloadOne = async index => {
    if (task.status !== 'downloading' || fatalError) throw fatalError || new Error('图文下载已停止');
    const image = images[index];
    const imageUrl = isXhs ? normalizeXhsMediaUrl(image?.url) : normalizeDouyinImageUrl(image?.url);
    if (!imageUrl) throw new Error(`第 ${index + 1} 张原图地址无效`);

    let contentType = '';
    let buffer = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && !buffer; attempt += 1) {
      if (fatalError) throw fatalError;
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await browserSession.fetch(imageUrl, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            Referer: referer,
            'User-Agent': userAgent,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Cache-Control': attempt > 1 ? 'no-cache' : 'max-age=0',
          },
        });
        if (!response.ok) throw new Error(`网络状态 ${response.status}`);
        const declaredSize = Number(response.headers.get('content-length')) || 0;
        if (declaredSize > 50 * 1024 * 1024) throw new Error('原图文件异常过大，已停止下载');
        contentType = response.headers.get('content-type') || '';
        if (contentType && !contentType.toLowerCase().startsWith('image/')) {
          throw new Error('返回内容不是图片');
        }
        const received = Buffer.from(await response.arrayBuffer());
        if (received.length === 0 || received.length > 50 * 1024 * 1024) {
          throw new Error('原图文件无效');
        }
        buffer = received;
      } catch (error) {
        if (fatalError) throw fatalError;
        if (task.status !== 'downloading') throw new Error('图文下载已停止');
        lastError = error?.name === 'AbortError' ? new Error('连接超时') : error;
        debugLog(`[${isXhs ? 'XHS' : 'DOUYIN'}] Image ${index + 1} attempt ${attempt} failed: ${String(lastError?.message || lastError).substring(0, 180)}`);
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }
    }
    if (!buffer) {
      const reason = translateError(lastError?.message || lastError || '网络连接失败');
      throw new Error(`第 ${index + 1} 张原图下载失败，已自动重试 3 次：${reason}`);
    }

    const ext = getDouyinImageExtension(contentType, imageUrl);
    const number = String(index + 1).padStart(String(images.length).length, '0');
    const finalPath = path.join(outputFolder, `${number}.${ext}`);
    const partialPath = finalPath + '.part';
    await fs.promises.writeFile(partialPath, buffer);
    await fs.promises.rename(partialPath, finalPath);

    totalBytes += buffer.length;
    completedCount += 1;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const remaining = images.length - completedCount;
    task.progress = {
      percent: Math.round((completedCount / images.length) * 100),
      speed: formatSpeed(totalBytes / elapsedSeconds),
      eta: formatEta((elapsedSeconds / completedCount) * remaining / concurrency),
      totalSize: formatBytes(totalBytes),
    };
    emitQueue();
    sendToWindow('download-progress', task.id, { ...task.progress });
  };

  const worker = async () => {
    while (!fatalError && task.status === 'downloading') {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= images.length) return;
      try {
        await downloadOne(index);
      } catch (error) {
        stopAll(error);
        return;
      }
    }
  };

  try {
    debugLog(`[${isXhs ? 'XHS' : 'DOUYIN'}] Downloading ${images.length} image(s) with concurrency ${concurrency}`);
    await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
    if (fatalError) throw fatalError;
    if (task.status !== 'downloading' || completedCount !== images.length) throw new Error('图文下载已停止');

    task.outputFile = outputFolder;
    task.options.filesize = totalBytes;
    task.options.imageCount = images.length;
    task.options.imageConcurrency = concurrency;
    task.options.actualResolution = `${images.length} 张原图`;
    await finishDownload(task);
  } catch (error) {
    stopAll(error);
    await fs.promises.rm(outputFolder, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    activeControllers.clear();
    task._imageAbortControllers = null;
  }
}

async function executeDownload(task) {
  try {
    // Guard: task may have been paused or cancelled while waiting in 'fetching'
    // phase (processQueue uses setTimeout with up to 400ms delay). If the
    // status was changed externally, abort — pauseTask/cancelTask already
    // cleaned activeTaskIds and emitted the updated queue.
    if (task.status !== 'fetching') return;
    sendToWindow('download-stage', task.id, 'preparing');

    const settings = getSettings();
    const outputDir = task.options.outputDir || settings.outputDir;
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const formatCode = getYtdlpFormatCode(task);
    const isBilibili = isBilibiliUrl(task.url);
    const isYouTube = isYouTubeUrl(task.url);
    const isDouyin = isDouyinUrl(task.url);
    const isXiaohongshu = isXiaohongshuUrl(task.url);
    const isDirectPlatform = isDouyin || isXiaohongshu;
    const audioOnly = task.options.audioOnly || task.options.formatId === 'audio';
    const outputExt = getOutputContainer(task);
    const effectiveFmtCode = isBilibili ? formatCode.replace(/\[ext=mp4\]/g, '') : formatCode;
    const isDash = !isDirectPlatform && !audioOnly && effectiveFmtCode.includes('+');
    if ((isDash || audioOnly) && !ffmpegPath) {
      throw new Error(audioOnly
        ? '缺少音频转换组件，无法生成真正的 MP3 文件。请重新安装完整的软件后重试。'
        : '缺少音视频合并组件，无法下载当前画质。请重新安装完整的软件后重试。');
    }
    if (audioOnly) task.options.isNativeDownload = true;

    task.status = 'downloading';
    const isResume = task.progress?.percent > 0;
    if (!isResume) {
      task.progress.percent = 0;
      task.progress.speed = '';
      task.progress.eta = '';
      // Keep totalSize pre-populated by addTaskToQueue
    }
    task._startTime = Date.now();
    task._connectingSent = false;
    emitQueue();

    const safeTitle = sanitizeFileName(task.title || '视频');
    const resolutionTag = task.options.resolutionLabel && !audioOnly
      ? '_' + sanitizeFileName(task.options.resolutionLabel)
      : '';
    const baseName = sanitizeFileName(safeTitle + resolutionTag);
    const isImageCollection = isDirectPlatform && task.options.isImageCollection === true && !audioOnly;
    const plannedOutput = isImageCollection ? null : reserveOutputPath(task, outputDir, baseName, outputExt);
    const finalFileName = plannedOutput ? path.basename(plannedOutput) : '';
    const outputBaseName = plannedOutput ? path.basename(plannedOutput, path.extname(plannedOutput)) : '';
    const ext = outputExt;
    const audioFormatCode = ext === 'webm' ? 'bestaudio[ext=webm]/bestaudio' : 'bestaudio[ext=m4a]/bestaudio';
    const directHeaders = isDouyin
      ? ['Referer: https://www.douyin.com/', `User-Agent: ${DOUYIN_USER_AGENT}`]
      : isXiaohongshu
        ? ['Referer: https://www.xiaohongshu.com/', `User-Agent: ${XHS_USER_AGENT}`]
        : null;
    let directPlatformFormat = null;
    if (isDirectPlatform) {
      const platform = isXiaohongshu ? 'xiaohongshu' : 'douyin';
      sendToWindow('download-stage', task.id, 'resolving');
      directPlatformFormat = isXiaohongshu
        ? await resolveXhsFormat(task.url, task.options.formatId)
        : await resolveDouyinFormat(task.url, task.options.formatId);
      if (task.status !== 'downloading') return;
      if (directPlatformFormat.filesize > 0) task.options.filesize = directPlatformFormat.filesize;
      if (isImageCollection) {
        await downloadPlatformImageCollection(task, directPlatformFormat, outputDir, baseName, platform);
        return;
      }
      if (audioOnly) {
        await downloadPlatformViaNative(task, directPlatformFormat, plannedOutput, true, platform);
        return;
      }
      task.options.isNativeDownload = false;
    }

    // === Bilibili: try DASH + aria2 with CDN headers first, fall back to native ===
    if (isBilibili && isDash && aria2cPath) {
      task.options.isNativeDownload = false;
      sendToWindow('download-stage', task.id, 'resolving');
      try {
        const videoFmt = effectiveFmtCode.split('+')[0];
        const rpcOk = await ensureAria2Rpc();
        if (rpcOk) {
          const [videoUrl, audioUrl] = await Promise.all([
            resolveSingleUrl(task.url, videoFmt, 30000),
            resolveSingleUrl(task.url, audioFormatCode, 30000),
          ]);
          if (task.status !== 'downloading') return;
          if (videoUrl && audioUrl) {
            sendToWindow('download-stage', task.id, 'creating-task');
            const vFile = `${outputBaseName}.video.tmp`;
            const aFile = `${outputBaseName}.audio.tmp`;
            const finalFile = finalFileName;
            const proxy = getEffectiveProxy();
            const biliHeaders = [
              'Referer: https://www.bilibili.com/',
              'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ];
            const opts = getAria2DownloadOptions(outputDir, vFile, proxy, biliHeaders, task.url);
            const optsA = getAria2DownloadOptions(outputDir, aFile, proxy, biliHeaders, task.url);

            const vGid = await aria2RpcCall('aria2.addUri', [[videoUrl], opts]);
            if (task.status !== 'downloading') {
              await aria2RpcCall('aria2.remove', [vGid]).catch(() => {});
              return;
            }
            const aGid = await aria2RpcCall('aria2.addUri', [[audioUrl], optsA]);
            if (task.status !== 'downloading') {
              await Promise.allSettled([
                aria2RpcCall('aria2.remove', [vGid]),
                aria2RpcCall('aria2.remove', [aGid]),
              ]);
              return;
            }

            downloadStates.set(task.id, {
              videoGid: vGid, audioGid: aGid, isDash: true,
              videoFile: path.join(outputDir, vFile),
              audioFile: path.join(outputDir, aFile),
              outputFile: path.join(outputDir, finalFile),
            });

            sendToWindow('download-stage', task.id, 'connecting');
            const startTimeout = setTimeout(() => {
              if (task.status !== 'downloading') return;
              task.status = 'error';
              task.error = '下载启动超时：连接资源超时，请检查网络或多线程下载组件';
              const st = downloadStates.get(task.id);
              if (st) {
                if (st.videoGid) aria2RpcCall('aria2.remove', [st.videoGid]).catch(() => {});
                if (st.audioGid) aria2RpcCall('aria2.remove', [st.audioGid]).catch(() => {});
                downloadStates.delete(task.id);
              }
              activeTaskIds.delete(task.id);
              emitQueue();
              sendToWindow('download-error', task.id, task.error);
              processQueue();
            }, 45000);
            task._startTimeout = startTimeout;

            startProgressPolling();
            pollActiveTasks().catch(() => {});
            return; // aria2 DASH 成功
          }
        }
      } catch (e) {
        if (task.status !== 'downloading') return;
        debugLog(`[BILI] aria2 DASH 失败 (${e.message.substring(0, 80)}), 回退到原生下载`);
        downloadStates.delete(task.id);
        if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
      }
      // aria2 失败 — 标记为原生下载（参数已针对 B站优化）
      task.options.isNativeDownload = true;
      debugLog('[BILI] 转为原生 yt-dlp 下载（高频并发 + CDN 头部优化）');
    }

    // Native yt-dlp download (HLS sources, Bilibili fallback, and real MP3 conversion)
    if (task.options.isNativeDownload) {
      if (task.status !== 'downloading') return;
      sendToWindow('download-stage', task.id, 'downloading');
      const outPath = plannedOutput;
      const ytArgs = audioOnly
        ? [
            '-f', effectiveFmtCode,
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--playlist-items', String(task.options.playlistIndex || 1),
            '-o', outPath,
            task.url,
          ]
        : [
            '-f', effectiveFmtCode,
            '--merge-output-format', ext,
            '--playlist-items', String(task.options.playlistIndex || 1),
            '-o', outPath,
            task.url,
          ];

      task._startTime = Date.now();
      await execYtdlpWithProgress(ytArgs, task);
      if (!existsSync(outPath) || statSync(outPath).size <= 0) {
        throw new Error(audioOnly ? 'MP3 转换完成后未找到有效文件' : '下载完成后未找到有效文件');
      }
      task.outputFile = outPath;
      await finishDownload(task);
      return;
    }
    // Resolve direct download URLs via yt-dlp -g, in parallel with RPC health check
    sendToWindow('download-stage', task.id, 'resolving');
    try {
      if (isDash) {
        const videoFmt = effectiveFmtCode.split('+')[0];
        const [rpcOk, videoUrl, audioUrl] = await Promise.all([
          ensureAria2Rpc(),
          resolveSingleUrl(task.url, videoFmt, 30000),
          resolveSingleUrl(task.url, audioFormatCode, 30000),
        ]);
        if (task.status !== 'downloading') return;
        if (!rpcOk) throw new Error('多线程下载组件无法启动。请确认软件文件完整，或重启软件后重试。');
        if (!videoUrl || !audioUrl) throw new Error('无法解析音视频下载地址');

        sendToWindow('download-stage', task.id, 'creating-task');
        const vFile = `${outputBaseName}.video.tmp`;
        const aFile = `${outputBaseName}.audio.tmp`;
        const finalFile = finalFileName;
        const proxy = getEffectiveProxy();
        const opts = getAria2DownloadOptions(outputDir, vFile, proxy, directHeaders, task.url);
        const optsA = getAria2DownloadOptions(outputDir, aFile, proxy, directHeaders, task.url);

        const vGid = await aria2RpcCall('aria2.addUri', [[videoUrl], opts]);
        if (task.status !== 'downloading') {
          await aria2RpcCall('aria2.remove', [vGid]).catch(() => {});
          return;
        }
        const aGid = await aria2RpcCall('aria2.addUri', [[audioUrl], optsA]);
        if (task.status !== 'downloading') {
          await Promise.allSettled([
            aria2RpcCall('aria2.remove', [vGid]),
            aria2RpcCall('aria2.remove', [aGid]),
          ]);
          return;
        }

        downloadStates.set(task.id, {
          videoGid: vGid, audioGid: aGid, isDash: true,
          videoFile: path.join(outputDir, vFile), audioFile: path.join(outputDir, aFile),
          outputFile: path.join(outputDir, finalFile),
        });
      } else {
        const [rpcOk, videoUrl] = await Promise.all([
          ensureAria2Rpc(),
          isDirectPlatform ? Promise.resolve(directPlatformFormat?.url || '') : resolveSingleUrl(task.url, formatCode, 30000),
        ]);
        if (task.status !== 'downloading') return;
        if (!rpcOk) throw new Error('多线程下载组件无法启动。请确认软件文件完整，或重启软件后重试。');
        if (!videoUrl) throw new Error('无法解析下载地址');

        sendToWindow('download-stage', task.id, 'creating-task');
        const vFile = finalFileName;
        const proxy = getEffectiveProxy();
        const opts = getAria2DownloadOptions(outputDir, vFile, proxy, directHeaders, task.url);
        const vGid = await aria2RpcCall('aria2.addUri', [[videoUrl], opts]);
        if (task.status !== 'downloading') {
          await aria2RpcCall('aria2.remove', [vGid]).catch(() => {});
          return;
        }

        downloadStates.set(task.id, {
          videoGid: vGid, audioGid: null, isDash: false,
          videoFile: path.join(outputDir, vFile), audioFile: null,
          outputFile: path.join(outputDir, vFile),
        });
      }
    } catch (e) {
      if (task.status !== 'downloading') return;
      if (isDirectPlatform) {
        const platform = isXiaohongshu ? 'xiaohongshu' : 'douyin';
        const logName = isXiaohongshu ? 'XHS' : 'DOUYIN';
        debugLog(`[${logName}] aria2 direct download failed, using native fallback: ${String(e.message).substring(0, 200)}`);
        const fallbackFormat = directPlatformFormat || (isXiaohongshu
          ? await resolveXhsFormat(task.url, task.options.formatId)
          : await resolveDouyinFormat(task.url, task.options.formatId));
        await downloadPlatformViaNative(task, fallbackFormat, plannedOutput, false, platform);
        return;
      }
      if (!isYouTube) throw e;
      debugLog(`[YOUTUBE] aria2 path failed, fallback to native yt-dlp: ${String(e.message).substring(0, 200)}`);
      if (!isLikelyYouTubeThrottleError(e.message) && !/无法解析|403|429|bot|cookies|age/i.test(String(e.message))) {
        throw e;
      }
      task.options.isNativeDownload = true;
      sendToWindow('download-stage', task.id, 'downloading');
      const outPath = plannedOutput;
      const ytArgs = [
        '-f', effectiveFmtCode,
        '--merge-output-format', ext,
        '--playlist-items', String(task.options.playlistIndex || 1),
        '-o', outPath,
        task.url,
      ];
      task._startTime = Date.now();
      await execYtdlpWithProgress(ytArgs, task);
      if (!existsSync(outPath) || statSync(outPath).size <= 0) {
        throw new Error('下载完成后未找到有效文件');
      }
      task.outputFile = outPath;
      await finishDownload(task);
      return;
    }

    // Once aria2 accepted the task, show connecting
    sendToWindow('download-stage', task.id, 'connecting');

    // Overall start timeout: if no aria2 progress after 45s, fail
    const startTimeout = setTimeout(() => {
      if (task.status !== 'downloading') return;
      task.status = 'error';
      task.error = '下载启动超时：连接资源超时，请检查网络或多线程下载组件';
      const st = downloadStates.get(task.id);
      if (st) {
        if (st.connectTimer) clearInterval(st.connectTimer);
        if (st.videoGid) aria2RpcCall('aria2.remove', [st.videoGid]).catch(() => {});
        if (st.audioGid) aria2RpcCall('aria2.remove', [st.audioGid]).catch(() => {});
        downloadStates.delete(task.id);
      }
      activeTaskIds.delete(task.id);
      emitQueue();
      sendToWindow('download-error', task.id, task.error);
      processQueue();
    }, 45000);
    task._startTimeout = startTimeout;

    // Connect timer: update stage if no speed after 10s
    const connectTimer = setInterval(() => {
      if (task.status !== 'downloading') { clearInterval(connectTimer); return; }
      if (task._connectingSent) { clearInterval(connectTimer); return; }
      if (!task.progress.speed && Date.now() - task._startTime >= 10000) {
        task._connectingSent = true;
        sendToWindow('download-stage', task.id, 'connecting');
      }
    }, 3000);
    const st = downloadStates.get(task.id);
    if (st) st.connectTimer = connectTimer;

    startProgressPolling();
    // Immediate first poll to catch fast-completing downloads
    pollActiveTasks().catch(() => {});

  } catch (err) {
    task._finalizing = false;
    task.stage = '';
    // Pause/cancel kills the native process → reject triggers this catch.
    // Don't override the status that pauseTask/cancelTask already set.
    if (task.status === 'paused' || task.status === 'cancelled') return;
    console.error('下载任务失败：', err);
    task.status = 'error';
    task.error = translateError(err.message) || '下载失败';
    activeTaskIds.delete(task.id);
    downloadStates.delete(task.id);
    if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
    emitQueue();
    sendToWindow('download-error', task.id, task.error);
    setTimeout(() => processQueue(), 200);
  }
}

function sanitizeFileName(name) {
  let value = String(name || '').normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!value) value = '视频';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value.slice(0, 140).replace(/[. ]+$/g, '') || '视频';
}

async function finishDownload(task) {
  if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
  task.status = 'completed';
  task.progress.percent = 100;
  task.progress.speed = '';
  task.progress.eta = '';

  task.progress.totalSize = '';
  if (task.outputFile && !task.options?.isImageCollection) {
    try {
      const fileStat = statSync(task.outputFile);
      if (fileStat.size > 0) task.progress.totalSize = formatBytes(fileStat.size);
    } catch (e) {}
  }
  if (!task.progress.totalSize && task.options?.filesize) {
    task.progress.totalSize = formatBytes(task.options.filesize);
  }

  if (!task.options?.audioOnly && !task.options?.isImageCollection
      && task.outputFile && !task.options?.actualResolution) {
    const actualResolution = await detectMediaResolution(task.outputFile);
    if (actualResolution) task.options.actualResolution = actualResolution;
  }

  cleanupTaskFiles(task, { keepOutput: true });
  addToHistory(task);
  downloadQueue = downloadQueue.filter(item => item.id !== task.id);

  emitQueue();
  sendToWindow('download-stage', task.id, 'complete');
  sendToWindow('download-progress', task.id, { ...task.progress, percent: 100 });
  sendToWindow('download-complete', task.id, task.outputFile || '');
  showNotification('下载完成', task.title || '视频下载已完成');

  activeTaskIds.delete(task.id);
  downloadStates.delete(task.id);
  setTimeout(() => processQueue(), 100);
}

// ========== File Cleanup ==========

function unlinkSyncRetry(filePath, maxRetries = 3, delayBetween = 250) {
  try {
    if (!existsSync(filePath)) return false;
    if (statSync(filePath).isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      unlinkSync(filePath);
    }
    return true;
  } catch (e) {
    if (maxRetries > 1) {
      setTimeout(() => unlinkSyncRetry(filePath, maxRetries - 1, delayBetween), delayBetween);
    } else {
      debugLog(`[CLEANUP] Failed to delete ${path.basename(filePath)}: ${e.message}`);
    }
    return false;
  }
}

async function deleteFileWithRetry(filePath, attempts = 3) {
  for (let index = 0; index < attempts; index++) {
    try {
      if (!existsSync(filePath)) return true;
      const fileStat = await fs.promises.stat(filePath);
      if (fileStat.isDirectory()) {
        await fs.promises.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(filePath);
      }
      return true;
    } catch (e) {
      if (index === attempts - 1) {
        debugLog(`[DELETE] Failed to delete ${path.basename(filePath)}: ${e.message}`);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  return false;
}
function cleanupTaskFiles(task, { keepOutput = false } = {}) {
  if (!task) return;
  const state = downloadStates.get(task.id);
  const finalPaths = new Set([
    task._plannedOutputFile,
    task.outputFile,
    state?.outputFile,
  ].filter(Boolean).map(file => path.resolve(file)));

  const targetPaths = new Set();
  const addWithSidecars = (filePath, removeBase = true) => {
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    if (removeBase) targetPaths.add(resolved);
    targetPaths.add(resolved + '.part');
    targetPaths.add(resolved + '.aria2');
    targetPaths.add(resolved + '.ytdl');
  };

  if (state?.videoFile) addWithSidecars(state.videoFile, true);
  if (state?.audioFile) addWithSidecars(state.audioFile, true);
  for (const finalPath of finalPaths) addWithSidecars(finalPath, !keepOutput);

  const planned = task._plannedOutputFile;
  if (planned) {
    const dir = path.dirname(planned);
    const base = path.basename(planned, path.extname(planned));
    addWithSidecars(path.join(dir, `${base}.video.tmp`), true);
    addWithSidecars(path.join(dir, `${base}.audio.tmp`), true);
  }

  const directories = new Set([...targetPaths].map(file => path.dirname(file)));
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    let files = [];
    try { files = readdirSync(dir); } catch (e) { continue; }
    for (const knownPath of [...targetPaths].filter(file => path.dirname(file) === dir)) {
      const knownName = path.basename(knownPath);
      const fragmentPrefix = knownName + '.part-Frag';
      for (const file of files) {
        if (file.startsWith(fragmentPrefix) && file.endsWith('.part')) {
          targetPaths.add(path.join(dir, file));
        }
      }
    }
  }

  let deleted = 0;
  for (const filePath of targetPaths) {
    if (keepOutput && finalPaths.has(filePath)) continue;
    if (unlinkSyncRetry(filePath)) deleted++;
  }
  if (deleted > 0) debugLog(`[CLEANUP] Removed ${deleted} task-owned file(s)`);
}
// ========== Pause/Resume/Cancel ==========

function hasActiveImageDownloads(task) {
  return (task?._imageAbortControllers instanceof Set && task._imageAbortControllers.size > 0)
    || !!task?._imageAbortController;
}

function abortImageDownloads(task) {
  if (!task) return;
  if (task._imageAbortControllers instanceof Set) {
    for (const controller of task._imageAbortControllers) controller.abort();
    task._imageAbortControllers.clear();
    task._imageAbortControllers = null;
  }
  if (task._imageAbortController) {
    task._imageAbortController.abort();
    task._imageAbortController = null;
  }
}

async function pauseTask(taskId) {
  const task = downloadQueue.find(t => t.id === taskId);
  if (!task || task.status === 'completed') return;
  if (task._finalizing) throw new Error('任务正在处理最终文件，暂时无法暂停');

  if (hasActiveImageDownloads(task)) {
    task.status = 'paused';
    abortImageDownloads(task);
  }
  const state = downloadStates.get(taskId);
  if (state && (state.videoGid || state.audioGid)) {
    // RPC pause: tell aria2 to pause the GIDs, keep .part/.aria2 files intact
    try {
      if (state.videoGid) await aria2RpcCall('aria2.forcePause', [state.videoGid]);
      if (state.audioGid) await aria2RpcCall('aria2.forcePause', [state.audioGid]);
    } catch (e) {
      debugLog(`[PAUSE] RPC error: ${e.message}`);
      try {
        if (state.videoGid) await aria2RpcCall('aria2.unpause', [state.videoGid]);
        if (state.audioGid) await aria2RpcCall('aria2.unpause', [state.audioGid]);
      } catch (resumeError) {
        debugLog(`[PAUSE] Rollback error: ${resumeError.message}`);
      }
      throw new Error('暂停下载失败，任务已继续运行，请稍后重试');
    }

    if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
    task.status = 'paused';
    task.progress.speed = '';
    task.progress.eta = '';
    activeTaskIds.delete(task.id);
    emitQueue();
    sendToWindow('download-progress', task.id, { ...task.progress, status: 'paused' });
    setTimeout(() => processQueue(), 200);
  } else if (task.status !== 'cancelled' && task.status !== 'completed' && task.status !== 'error') {
    // Native yt-dlp download (TapTap HLS): kill the process to stop downloading
    const proc = nativeDownloadProcs.get(taskId);
    if (proc) {
      await terminateProcessTree(proc);
      nativeDownloadProcs.delete(taskId);
    }
    if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
    task.status = 'paused';
    task.progress.speed = '';
    task.progress.eta = '';
    activeTaskIds.delete(task.id);
    emitQueue();
  }
}

async function resumeTask(taskId) {
  const task = downloadQueue.find(item => item.id === taskId);
  if (!task || task.status !== 'paused') return;
  task.status = 'queued';
  task.error = null;
  emitQueue();
  processQueue();
}
async function cancelTask(taskId) {
  const task = downloadQueue.find(t => t.id === taskId);
  if (!task || task.status === 'completed') return;

  if (hasActiveImageDownloads(task)) {
    task.status = 'cancelled';
    abortImageDownloads(task);
  }
  const mergeProc = mediaMergeProcs.get(taskId);
  if (task._finalizing && !mergeProc) {
    throw new Error('任务正在校验最终文件，请稍等片刻后再取消');
  }
  if (mergeProc) {
    task.status = 'cancelled';
    task._finalizing = false;
    task.stage = '';
    emitQueue();
    await terminateProcessTree(mergeProc);
    mediaMergeProcs.delete(taskId);
  }

  const state = downloadStates.get(taskId);
  if (state) {
    // Remove from aria2 RPC — aborts the download and frees the GID
    try {
      if (state.videoGid) await aria2RpcCall('aria2.remove', [state.videoGid]);
      if (state.audioGid) await aria2RpcCall('aria2.remove', [state.audioGid]);
    } catch (e) { /* best effort */ }
    if (state.connectTimer) clearInterval(state.connectTimer);
    downloadStates.delete(taskId);
  } else {
    // Native yt-dlp download (TapTap HLS): kill the process
    const proc = nativeDownloadProcs.get(taskId);
    if (proc) {
      await terminateProcessTree(proc);
      nativeDownloadProcs.delete(taskId);
    }
  }
  activeTaskIds.delete(taskId);
  if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }

  task.status = 'cancelled';
  task._finalizing = false;
  task.stage = '';
  emitQueue();

  // Brief pause to let aria2 release file handles on Windows before cleanup
  // Without this, .tmp.aria2 / .part files may still be locked by the aria2 process
  await new Promise(r => setTimeout(r, 150));
  cleanupTaskFiles(task);

  downloadQueue = downloadQueue.filter(t => t.id !== taskId);
  emitQueue();

  processQueue();
}

async function removeFromQueue(taskId) {
  const task = downloadQueue.find(t => t.id === taskId);
  if (!task) return;

  if (downloadStates.has(taskId)) {
    await cancelTask(taskId);
    return;
  }

  // Paused/error/cancelled tasks may have partial files — clean them up
  if (task.status === 'paused' || task.status === 'error' || task.status === 'cancelled') {
    cleanupTaskFiles(task);
    if (task.outputFile && existsSync(task.outputFile)) {
      unlinkSyncRetry(task.outputFile);
    }
  }

  downloadQueue = downloadQueue.filter(t => t.id !== taskId);
  emitQueue();
}

async function pauseAllTasks() {
  const taskIds = downloadQueue
    .filter(task => !['completed', 'error', 'cancelled', 'paused'].includes(task.status))
    .map(task => task.id);
  const results = await Promise.allSettled(taskIds.map(taskId => pauseTask(taskId)));
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('部分任务未能暂停，仍在运行的任务已保留，请稍后重试');
  }
}

function resumeAllTasks() {
  for (const task of downloadQueue) {
    if (task.status === 'completed' || task.status === 'downloading' || task.status === 'fetching') continue;
    if (task.status === 'error' || task.status === 'cancelled') {
      cleanupTaskFiles(task);
      task.progress = { percent: 0, speed: '', eta: '', totalSize: '' };
      task.outputFile = null;
      task.error = null;
      task._finalizing = false;
      task.stage = '';
    }
    task.status = 'queued';
  }
  emitQueue();
  processQueue();
}

async function cancelAllTasks() {
  const taskIds = downloadQueue
    .filter(task => task.status !== 'completed')
    .map(task => task.id);
  let failed = 0;
  for (const taskId of taskIds) {
    try { await cancelTask(taskId); }
    catch (error) { failed++; debugLog(`[CANCEL] ${taskId}: ${error.message}`); }
  }
  emitQueue();
  processQueue();
  if (failed > 0) throw new Error('部分正在处理最终文件的任务暂时无法取消，其余任务已取消');
}
// ========== IPC Handlers ==========

function setupIPC() {
  // Fetch video info
  ipcMain.handle('fetch-video-info', async (event, url) => {
    try {
      const normalizedUrl = normalizeVideoUrl(url);
      return await fetchAllVideosInfo(normalizedUrl);
    } catch (err) {
      debugLog(`[FETCH] Failed: ${String(err.message || err).substring(0, 300)}`);
      throw new Error(translateError(err.message));
    }
  });

  // Detect cookie/login errors from already-translated messages
  function _isCookieError(translatedMsg) {
    return translatedMsg && translatedMsg.includes('登录验证');
  }

  // Batch fetch multiple video info (批量识别)
  ipcMain.handle('fetch-multiple-video-info', async (event, urls) => {
    if (!Array.isArray(urls)) throw new Error('批量链接格式无效');
    if (urls.length === 0) return [];
    if (urls.length > 50) throw new Error('单次最多识别 50 个视频，请分批处理');
    const normalizedUrls = [...new Set(urls.map(url => normalizeVideoUrl(url, { youtubeOnly: true })))];
    urls = normalizedUrls;

    const results = [];
    const concurrency = 3;
    let cookieBlocked = false;
    const COOKIE_MSG = '请求被 YouTube 拦截，需要登录验证。可能是短时间请求过于频繁、当前网络环境受限或缺少有效登录信息。请间隔一到两小时后重试；如仍频繁出现，可将从已登录浏览器导出的账号信息保存为“登录信息.txt”并放到软件目录。';

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);

      // Fast-failure: remaining URLs all marked as cookie-blocked
      if (cookieBlocked) {
        const items = batch.map(url => ({ url, ok: false, info: null, error: COOKIE_MSG }));
        results.push(...items);
        event.sender.send('batch-parse-progress', items);
        continue;
      }

      const batchResults = await Promise.allSettled(
        batch.map(url => fetchVideoInfo(url))
      );
      const partial = [];
      let allCookieErrors = true;

      for (let j = 0; j < batch.length; j++) {
        const r = batchResults[j];
        const error = r.status === 'rejected' ? translateError(r.reason.message) : null;
        const item = {
          url: batch[j],
          ok: r.status === 'fulfilled',
          info: r.status === 'fulfilled' ? r.value : null,
          error,
        };
        results.push(item);
        partial.push(item);
        if (r.status === 'fulfilled' || (error && !_isCookieError(error))) {
          allCookieErrors = false;
        }
      }

      event.sender.send('batch-parse-progress', partial);

      // If every item in this batch failed with cookie errors, skip remaining
      if (allCookieErrors && i + concurrency < urls.length) {
        cookieBlocked = true;
      }

      if (i + concurrency < urls.length && !cookieBlocked) {
        await new Promise(r => setTimeout(r, 350 + Math.random() * 500));
      }
    }
    return results;
  });

  // Start download
  ipcMain.handle('start-download', async (event, payload) => {
    const request = validateDownloadRequest(payload);
    return addTaskToQueue(request.url, request.options);
  });

  // Pause/Resume/Cancel
  ipcMain.handle('pause-download', (event, taskId) => pauseTask(taskId));
  ipcMain.handle('resume-download', (event, taskId) => resumeTask(taskId));
  ipcMain.handle('cancel-download', (event, taskId) => cancelTask(taskId));
  ipcMain.handle('remove-from-queue', (event, taskId) => removeFromQueue(taskId));
  ipcMain.handle('pause-all', () => pauseAllTasks());
  ipcMain.handle('resume-all', () => resumeAllTasks());
  ipcMain.handle('cancel-all', () => cancelAllTasks());

  // Select directory
  ipcMain.handle('select-output-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载目录',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // History
  ipcMain.handle('get-history', () => getHistory());
  ipcMain.handle('clear-history', () => {
    if (!saveHistory([])) throw new Error('清空下载历史失败，请检查软件数据目录是否可写');
    return { cleared: true };
  });
  ipcMain.handle('delete-history-item', async (event, id) => {
    const history = getHistory();
    const item = history.find(h => h.id === id);
    if (!item) return;

    // If file still exists, ask user whether to delete it
    if (item.filePath && existsSync(item.filePath)) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '删除历史记录',
        message: '是否同时删除原文件？',
        buttons: ['是：删除原文件 + 删除这条记录', '否：只删除这条记录', '取消'],
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return; // 取消 — 什么都不做
      if (response === 0) {
        const deleted = await deleteFileWithRetry(item.filePath);
        if (!deleted) {
          await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '文件删除失败',
            message: '原文件可能正在被其他程序占用。请关闭占用程序后重试。',
          });
          return { removed: false };
        }
      }
    }
    if (!saveHistory(history.filter(h => h.id !== id))) {
      throw new Error('删除历史记录失败，请检查软件数据目录是否可写');
    }
    return { removed: true };
  });

  // Queue
  ipcMain.handle('get-queue', () => getQueue());

  // Retry a failed/cancelled download
  ipcMain.handle('retry-download', async (event, taskId) => {
    const task = downloadQueue.find(t => t.id === taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status !== 'error' && task.status !== 'cancelled') return { ok: false, error: '该状态不可重试' };

    // Clean up aria2 state (stale GIDs, timers)
    const state = downloadStates.get(taskId);
    if (state) {
      if (state.connectTimer) clearInterval(state.connectTimer);
      if (state.videoGid) aria2RpcCall('aria2.remove', [state.videoGid]).catch(() => {});
      if (state.audioGid) aria2RpcCall('aria2.remove', [state.audioGid]).catch(() => {});
      downloadStates.delete(taskId);
    }
    if (task._startTimeout) { clearTimeout(task._startTimeout); task._startTimeout = null; }
    activeTaskIds.delete(taskId);

    // Clean temp files so new download starts fresh
    cleanupTaskFiles(task);
    if (task.outputFile && existsSync(task.outputFile)) {
      unlinkSyncRetry(task.outputFile);
    }

    // Reset task state and re-queue at front
    task.progress = { percent: 0, speed: '', eta: '', totalSize: '' };
    task.error = null;
    task.outputFile = null;
    task._startTime = 0;
    task._connectingSent = false;
    task._progressStarted = false;
    task._lastEmit = 0;
    task._finalizing = false;
    task.stage = '';
    task.status = 'queued';
    downloadQueue = downloadQueue.filter(t => t.id !== taskId);
    downloadQueue.unshift(task);
    emitQueue();
    processQueue();
    return { ok: true };
  });

  // Remove queue item with confirmation dialog (for completed/error/cancelled)
  ipcMain.handle('remove-queue-item', async (event, taskId) => {
    const task = downloadQueue.find(t => t.id === taskId);
    if (!task) return { removed: false };

    // Active downloads — cancel directly, no dialog
    if (task.status === 'downloading' || task.status === 'fetching' || activeTaskIds.has(taskId)) {
      await cancelTask(taskId);
      return { removed: true };
    }

    // Queued — remove silently (no files to clean)
    if (task.status === 'queued') {
      downloadQueue = downloadQueue.filter(t => t.id !== taskId);
      emitQueue();
      return { removed: true };
    }

    // Paused — remove and clean up partial downloaded files
    if (task.status === 'paused') {
      cleanupTaskFiles(task);
      downloadQueue = downloadQueue.filter(t => t.id !== taskId);
      emitQueue();
      return { removed: true };
    }

    // completed / error / cancelled — show confirmation dialog
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['是，删除源文件', '否，仅删除记录', '取消'],
      defaultId: 2,
      cancelId: 2,
      title: '删除下载记录',
      message: '是否同时删除源文件？',
      detail: task.title || '未知视频',
    });

    if (result.response === 2) return { removed: false }; // cancel

    const deleteFile = result.response === 0; // Yes

    if (deleteFile) {
      // Delete source file
      if (task.outputFile && existsSync(task.outputFile)) {
        const deleted = await deleteFileWithRetry(task.outputFile);
        if (!deleted) {
          throw new Error('源文件删除失败，可能正被其他程序占用');
        }
      }
      if (!saveHistory(getHistory().filter(h => h.id !== taskId))) {
        throw new Error('删除下载记录失败，请检查软件数据目录是否可写');
      }
    }

    // Remove from queue
    downloadQueue = downloadQueue.filter(t => t.id !== taskId);
    emitQueue();

    return { removed: true, deletedFile: deleteFile };
  });

  // Settings
  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('save-settings', async (event, settings) => {
    const sanitized = sanitizeSettings(settings, { strictProxy: true });
    await applySessionProxy(sanitized.proxyUrl);
    const saved = saveSettings(sanitized, { strictProxy: true });
    nativeTheme.themeSource = saved.darkMode ? 'dark' : 'light';
    return saved;
  });

  // Bilibili QR Login
  ipcMain.handle('bilibili-login-start', async () => {
    try {
      return await startBilibiliLogin();
    } catch (err) {
      return { error: toChineseServiceError(err, '获取登录二维码') };
    }
  });

  ipcMain.handle('bilibili-login-poll', async (event, qrcodeKey) => {
    if (typeof qrcodeKey !== 'string' || qrcodeKey.length < 8 || qrcodeKey.length > 256) {
      return { status: 'error', error: '登录二维码参数无效，请重新获取' };
    }
    try {
      return await pollBilibiliLogin(qrcodeKey);
    } catch (err) {
      return { status: 'error', error: toChineseServiceError(err, '检查登录状态') };
    }
  });

  ipcMain.handle('get-bilibili-login-status', () => {
    return getBilibiliLoginStatus();
  });

  ipcMain.handle('bilibili-logout', () => {
    return logoutBilibili();
  });

  // Get detected system proxy
  ipcMain.handle('get-system-proxy', async () => await detectSystemProxyAsync());

  // Get available tools (ffmpeg, aria2c)
  ipcMain.handle('get-tools', () => ({
    ffmpeg: !!ffmpegPath,
    ffmpegPath: ffmpegPath,
    aria2c: !!aria2cPath,
    aria2cPath: aria2cPath,
  }));

  // Exit fullscreen
  ipcMain.handle('exit-fullscreen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(false);
    }
  });

  // Test proxy connection
  ipcMain.handle('test-proxy', async (event, proxyUrl) => {
    try {
      const normalized = normalizeProxyUrl(proxyUrl);
      if (!normalized) return { ok: false, error: '请输入代理地址' };
      const args = ['-j', '--no-download', '--proxy', normalized, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'];
      await execYtdlp(args, { timeout: 30000, timeoutMsg: '代理连接测试超时' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: translateError(err.message) };
    }
  });

  // Open in explorer
  ipcMain.handle('open-in-explorer', async (event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length > 32767 || !existsSync(filePath)) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '文件不存在',
        message: '文件不存在，可能已被移动或删除。',
      });
      return { ok: false };
    }
    const resolved = path.resolve(filePath);
    try {
      if (statSync(resolved).isDirectory()) {
        const error = await shell.openPath(resolved);
        if (error) throw new Error(error);
      } else {
        shell.showItemInFolder(resolved);
      }
      return { ok: true };
    } catch (e) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '无法打开文件位置',
        message: '系统文件管理器未能打开该位置，请检查路径或权限。',
      });
      return { ok: false };
    }
  });

  // Read clipboard (for right-click paste)
  ipcMain.handle('read-clipboard', () => {
    return clipboard.readText();
  });

  // Context menu for queue items
  ipcMain.handle('show-queue-context-menu', async (event, taskId) => {
    const task = downloadQueue.find(t => t.id === taskId);
    if (!task) return;

    const template = [];

    if (task.status === 'paused') {
      template.push({ label: '继续下载', click: () => resumeTask(taskId) });
    }

    if (task.status === 'downloading' || task.status === 'fetching') {
      template.push({ label: '暂停下载', click: () => pauseTask(taskId) });
    }

    if (task.status === 'queued' || task.status === 'paused') {
      template.push({ label: '取消下载', click: () => cancelTask(taskId) });
    }

    if (task.outputFile && existsSync(task.outputFile)) {
      template.push({
        label: '打开文件所在位置',
        click: () => { shell.showItemInFolder(path.resolve(task.outputFile)); },
      });
    }

    if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
      if (template.length > 0) template.push({ type: 'separator' });
      if (task.status === 'error' || task.status === 'cancelled') {
        template.push({
          label: '重试下载',
          click: async () => {
            const url = task.url;
            const options = task.options;
            await removeFromQueue(taskId);
            addTaskToQueue(url, options);
          },
        });
      }
      template.push({
        label: '删除记录',
        click: () => { mainWindow.webContents.send('queue-context-remove', taskId); },
      });
    }

    if (template.length === 0) return;

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });
}

// ========== App Lifecycle ==========

function createChineseMenu() {
  const template = [
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'Ctrl+R', role: 'reload' },
        ...(!app.isPackaged ? [{ label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { label: '实际大小', accelerator: 'Ctrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'Ctrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'Ctrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于视频下载神器', click: () => {
          const tools = [
            ffmpegPath ? '高清合并组件：已就绪' : '高清合并组件：未找到',
            aria2cPath ? '多线程加速组件：已启用' : '多线程加速组件：未启用',
          ];
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '关于视频下载神器',
            message: '视频下载神器　版本 2.1',
            detail: `支持 YouTube、B站、TapTap、抖音与小红书视频、图文下载\n\n组件状态：\n${tools.join('\n')}\n\n下载方式：${aria2cPath ? '多线程高速下载' : '内置分片下载'}\n最大并发任务：${getMaxConcurrentDownloads()}`,
          });
        }},
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  const settings = getSettings();
  nativeTheme.themeSource = settings.darkMode ? 'dark' : 'light';

  // Keep Chromium requests and child download tools on the same validated proxy.
  applySessionProxy(settings.proxyUrl).catch(error => {
    debugLog(`[PROXY] Failed to apply saved proxy: ${error.message}`);
  });

  mainWindow = new BrowserWindow({
    width: 900,
    height: 750,
    minWidth: 700,
    minHeight: 600,
    title: '视频下载神器',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
    show: false,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('unresponsive', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow._unresponsiveDialogOpen) return;
    mainWindow._unresponsiveDialogOpen = true;
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '软件暂时没有响应',
      message: '界面响应较慢，下载任务仍可能在后台运行。请稍等片刻；如长时间无响应，可重启软件。',
      buttons: ['知道了'],
    }).finally(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow._unresponsiveDialogOpen = false;
    });
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    debugLog(`[WINDOW] Renderer stopped: ${details.reason}`);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '界面运行异常',
      message: '软件界面意外停止，点击“重新加载”即可恢复；正在进行的下载不会主动删除。',
      buttons: ['重新加载', '关闭软件'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (response === 0) mainWindow.reload();
      else app.quit();
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  try {
    migrateLegacyCookieFiles();
  } catch (error) {
    debugLog(`[COOKIES] Credential migration failed: ${String(error?.message || error)}`);
  }
  detectSystemProxyAsync().catch(() => {});
  // Register IPC handlers and show window ASAP
  setupIPC();
  createChineseMenu();
  createWindow();

  // Start aria2 RPC in background — window is already visible
  startAria2Rpc().then(ok => {
    debugLog(`[RPC] Background start ${ok ? 'OK' : 'failed'}`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  debugLog(`[STARTUP] ${String(error?.stack || error).substring(0, 1000)}`);
  dialog.showErrorBox('软件启动失败', '视频下载神器未能正常启动，请重启电脑后再试；如仍失败，请重新安装完整的软件。');
  app.quit();
});

let _shutdownInProgress = false;
let _shutdownReady = false;
app.on('before-quit', event => {
  if (_shutdownReady) {
    _flushDebug();
    return;
  }
  event.preventDefault();
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;
  stopAllManagedProcesses().finally(() => {
    _flushDebug();
    _shutdownReady = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});




























