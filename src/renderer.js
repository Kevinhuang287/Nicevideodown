// ========== State ==========
let currentVideoInfo = null;
let currentVideos = null;
let settings = {};
let cleanupListeners = [];
let queueItems = [];
let selectedResolutionId = 'best';

// ========== DOM refs ==========
const $ = (id) => document.getElementById(id);

const urlInput = $('urlInput');
const clearUrlBtn = $('clearUrlBtn');
const fetchBtn = $('fetchBtn');
const urlError = $('urlError');
const loadingSpinner = $('loadingSpinner');
const videoInfo = $('videoInfo');
const multiVideoSection = $('multiVideoSection');
const multiVideoCount = $('multiVideoCount');
const multiVideoList = $('multiVideoList');
// One-time event delegation for multi-video download buttons (NOT inside displayMultipleVideoInfo)
multiVideoList.addEventListener('click', (e) => {
  const btn = e.target.closest('.mv-dl-btn');
  if (!btn) return;
  const idx = parseInt(btn.dataset.index);
  startDownloadAtIndex(idx);
});
const thumbnail = $('thumbnail');
const duration = $('duration');
const videoTitle = $('videoTitle');
const videoChannel = $('videoChannel');
const resolutionSelect = $('resolutionSelect');
const formatSelect = $('formatSelect');
const outputDir = $('outputDir');
const browseDirBtn = $('browseDirBtn');
const downloadBtn = $('downloadBtn');
const queueTab = $('queueTab');
const historyTab = $('historyTab');
const queuePanel = $('queuePanel');
const historyPanel = $('historyPanel');
const queueList = $('queueList');
const queueEmpty = $('queueEmpty');
const queueCount = $('queueCount');
const pauseAllBtn = $('pauseAllBtn');
const resumeAllBtn = $('resumeAllBtn');
const cancelAllBtn = $('cancelAllBtn');
const historyList = $('historyList');
const historyEmpty = $('historyEmpty');
const clearHistoryBtn = $('clearHistoryBtn');
const themeToggle = $('themeToggle');
const proxyUrl = $('proxyUrl');
const testProxyBtn = $('testProxyBtn');
const proxyStatus = $('proxyStatus');
const toolStatus = $('toolStatus');
const toastRegion = $('toastRegion');
const csResolution = $('csResolution');
const csValue = $('csValue');
const csDropdown = $('csDropdown');

// Bilibili login DOM refs
const biliLoginBtn = $('biliLoginBtn');
const biliLoginStatus = $('biliLoginStatus');
const biliLoginModal = $('biliLoginModal');
const biliLoginClose = $('biliLoginClose');
const biliLoginBody = $('biliLoginBody');
const qrImage = $('qrImage');
const qrStatus = $('qrStatus');
const qrWrapper = $('qrWrapper');

// Batch DOM refs
const batchTab = $('batchTab');
const batchPanel = $('batchPanel');
const batchUrlInput = $('batchUrlInput');
const batchParseBtn = $('batchParseBtn');
const batchUrlStats = $('batchUrlStats');
const batchResults = $('batchResults');
const batchCount = $('batchCount');
const batchTotalSize = $('batchTotalSize');
const batchStartAllBtn = $('batchStartAllBtn');
const batchResultList = $('batchResultList');
const batchEmpty = $('batchEmpty');
const batchSaveDir = $('batchSaveDir');
const batchSaveBrowseBtn = $('batchSaveBrowseBtn');
const batchCookieWarning = $('batchCookieWarning');

// ========== Utility Functions ==========

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showElement(el) { el.classList.remove('hidden'); }
function hideElement(el) { el.classList.add('hidden'); }

function formatStatus(status) {
  const map = {
    'queued': '排队中',
    'fetching': '准备中',
    'downloading': '下载中',
    'paused': '已暂停',
    'completed': '已完成',
    'error': '下载失败',
    'cancelled': '已取消',
  };
  return map[status] || '未知状态';
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(1) + units[i];
}

const SUPPORTED_VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv',
  'taptap.cn', 'taptap.io', 'douyin.com', 'iesdouyin.com',
  'xiaohongshu.com', 'xhslink.com',
];

function hostMatches(hostname, domains) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function extractKnownVideoUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return '';
  const matches = raw.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  if (/^https?:\/\/\S+$/i.test(raw)) matches.unshift(raw);
  for (const candidate of [...new Set(matches)]) {
    try {
      const cleaned = candidate.replace(/[，。；、）】》」』,.;)\]}]+$/g, '');
      const parsed = new URL(cleaned);
      if (['http:', 'https:'].includes(parsed.protocol)
          && hostMatches(parsed.hostname, SUPPORTED_VIDEO_HOSTS)) {
        parsed.protocol = 'https:';
        return parsed.href;
      }
    } catch (e) { /* 继续尝试下一条网址 */ }
  }
  return '';
}

function isKnownVideoUrl(value) {
  return !!extractKnownVideoUrl(value);
}

function isYoutubeUrl(value) {
  try {
    const url = extractKnownVideoUrl(value) || String(value || '').trim();
    return hostMatches(new URL(url).hostname, ['youtube.com', 'youtu.be']);
  } catch (e) {
    return false;
  }
}

function safeImageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch (e) {
    return '';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function toChineseError(error, fallback = '操作失败，请重试') {
  const raw = String(error?.message || error || '').replace(/[\r\n]+/g, ' ').trim();
  const cleaned = raw
    .replace(/^Error\s+(?:invoking remote method|occurred while handling).*?Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  const chineseIndex = cleaned.search(/[㐀-鿿]/);
  if (chineseIndex >= 0) return cleaned.slice(chineseIndex, chineseIndex + 300);
  return fallback;
}

function showToast(message, type = 'info') {
  if (!toastRegion) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

function installImageFallback(container, fallbackClass) {
  container.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.fallbackApplied === 'true') return;
    image.dataset.fallbackApplied = 'true';
    const fallback = document.createElement('div');
    fallback.className = fallbackClass;
    fallback.textContent = '封面加载失败';
    image.replaceWith(fallback);
  }, true);
}

installImageFallback(multiVideoList, 'mv-thumb-placeholder');
installImageFallback(batchResultList, 'batch-thumb-empty');
thumbnail.addEventListener('error', () => {
  thumbnail.classList.add('image-failed');
  thumbnail.removeAttribute('src');
  thumbnail.alt = '封面加载失败';
});

async function persistSettings(nextSettings = settings) {
  try {
    const saved = await window.ytdl.saveSettings(nextSettings);
    if (saved && typeof saved === 'object') settings = saved;
    return true;
  } catch (error) {
    showToast(toChineseError(error, '保存设置失败，请检查后重试'), 'error');
    return false;
  }
}

// ========== Theme ==========

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

// ========== Bilibili QR Login ==========

let _biliPollTimer = null;

function updateBiliLoginUI(status) {
  if (status.loggedIn && !status.expired) {
    biliLoginStatus.textContent = 'B站已登录';
    biliLoginStatus.className = 'bili-login-status logged-in';
    biliLoginBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
    biliLoginBtn.title = 'B站已登录，点击管理';
  } else if (status.loggedIn && status.expired) {
    biliLoginStatus.textContent = 'B站登录已过期';
    biliLoginStatus.className = 'bili-login-status expired';
    biliLoginBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
    biliLoginBtn.title = 'B站登录已过期，点击管理';
  } else {
    biliLoginStatus.textContent = '';
    biliLoginStatus.className = 'bili-login-status';
    biliLoginBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
    biliLoginBtn.title = 'B站扫码登录';
  }
}

async function checkBiliLoginStatus() {
  try {
    const status = await window.ytdl.getBilibiliLoginStatus();
    updateBiliLoginUI(status);
  } catch (e) { /* ignore */ }
}

async function doBiliLogout() {
  try {
    await window.ytdl.bilibiliLogout();
    updateBiliLoginUI({ loggedIn: false });
    // Refresh video info if a B站 video is loaded (to show updated quality list)
    if (currentVideoInfo && currentVideoInfo.resolutionOptions &&
        currentVideoInfo.resolutionOptions.some(o => o.id.startsWith('bili_'))) {
      const url = urlInput.value.trim();
      if (url && /bilibili\.com|b23\.tv/i.test(url)) {
        fetchVideoInfo();
      }
    }
  } catch (error) {
    showToast(toChineseError(error, '退出 B站登录失败，请重试'), 'error');
  }
}

// Handle login button click: if logged in, show dialog; if not logged in, start login
biliLoginBtn.addEventListener('click', async () => {
  try {
    const status = await window.ytdl.getBilibiliLoginStatus();
    if (status.loggedIn) {
      if (confirm('B站扫码登录\n\n当前已登录。\n• 可获取更多画质档位\n• 可下载账号有权限的视频\n\n确定要退出登录吗？')) {
        await doBiliLogout();
      }
    } else {
      await startBiliLogin();
    }
  } catch (error) {
    showToast(toChineseError(error, '无法读取 B站登录状态，请重试'), 'error');
  }
});

// Start QR login flow
let _biliPollInFlight = false;

async function startBiliLogin() {
  if (_biliPollTimer) clearInterval(_biliPollTimer);
  _biliPollTimer = null;
  _biliPollInFlight = false;

  biliLoginModal.classList.remove('hidden');
  qrImage.src = '';
  qrStatus.textContent = '正在获取二维码…';
  qrStatus.className = 'qr-status';

  try {
    const result = await window.ytdl.bilibiliLoginStart();
    if (result.error) {
      qrStatus.textContent = toChineseError(result.error, '获取二维码失败，请重试');
      qrStatus.className = 'qr-status error';
      return;
    }
    if (typeof window.qrcode !== 'function' || !result.qrcodeUrl || !result.qrcodeKey) {
      throw new Error('本地二维码组件不可用，请重新安装软件');
    }

    const qr = window.qrcode(0, 'M');
    qr.addData(result.qrcodeUrl);
    qr.make();
    qrImage.src = qr.createDataURL(5, 8);
    qrStatus.textContent = '请使用 B站客户端扫码';
    qrStatus.className = 'qr-status pending';

    let pollCount = 0;
    _biliPollTimer = setInterval(async () => {
      if (_biliPollInFlight) return;
      if (++pollCount > 60) {
        clearInterval(_biliPollTimer);
        _biliPollTimer = null;
        qrStatus.textContent = '登录已超时，请重新获取二维码';
        qrStatus.className = 'qr-status error';
        return;
      }

      _biliPollInFlight = true;
      try {
        const pollResult = await window.ytdl.bilibiliLoginPoll(result.qrcodeKey);
        if (pollResult.status === 'confirmed') {
          clearInterval(_biliPollTimer);
          _biliPollTimer = null;
          qrStatus.textContent = '登录成功';
          qrStatus.className = 'qr-status success';
          setTimeout(() => {
            biliLoginModal.classList.add('hidden');
            checkBiliLoginStatus();
            if (currentVideoInfo && currentVideoInfo.resolutionOptions &&
                currentVideoInfo.resolutionOptions.some(option => option.id.startsWith('bili_'))) {
              const currentUrl = urlInput.value.trim();
              if (currentUrl && isKnownVideoUrl(currentUrl)) fetchVideoInfo();
            }
          }, 1000);
        } else if (pollResult.status === 'scanned') {
          qrStatus.textContent = '已扫码，请在手机上确认' + (pollResult.nickname ? `（${pollResult.nickname}）` : '');
          qrStatus.className = 'qr-status scanned';
        } else if (pollResult.status === 'expired') {
          clearInterval(_biliPollTimer);
          _biliPollTimer = null;
          qrStatus.textContent = '二维码已过期，请重新登录';
          qrStatus.className = 'qr-status error';
        } else if (pollResult.status === 'error') {
          clearInterval(_biliPollTimer);
          _biliPollTimer = null;
          qrStatus.textContent = toChineseError(pollResult.error, '检查登录状态失败，请重试');
          qrStatus.className = 'qr-status error';
        }
      } catch (error) {
        qrStatus.textContent = toChineseError(error, '检查登录状态失败，正在重试');
        qrStatus.className = 'qr-status error';
      } finally {
        _biliPollInFlight = false;
      }
    }, 2000);
  } catch (error) {
    qrStatus.textContent = toChineseError(error, '登录失败，请检查网络后重试');
    qrStatus.className = 'qr-status error';
  }
}
// Modal close
biliLoginClose.addEventListener('click', () => {
  if (_biliPollTimer) {
    clearInterval(_biliPollTimer);
    _biliPollTimer = null;
  }
  _biliPollInFlight = false;
  biliLoginModal.classList.add('hidden');
});

// Click outside modal to close
biliLoginModal.addEventListener('click', (e) => {
  if (e.target === biliLoginModal) {
    if (_biliPollTimer) {
      clearInterval(_biliPollTimer);
      _biliPollTimer = null;
    }
    biliLoginModal.classList.add('hidden');
  }
});

// ========== Auto-paste detection ==========

urlInput.addEventListener('paste', () => {
  // Small delay to let the paste complete
  setTimeout(() => {
    const val = urlInput.value.trim();
    if (val && isKnownVideoUrl(val)) {
      fetchVideoInfo();
    }
  }, 50);
});

urlInput.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  try {
    const text = await window.ytdl.readClipboard();
    if (text) {
      urlInput.value = text;
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      hideError();
      hideElement(videoInfo);
      hideMultiVideo();
      const val = text.trim();
      if (isKnownVideoUrl(val)) {
        fetchVideoInfo();
      }
    }
  } catch (err) { /* clipboard unavailable */ }
});

urlInput.addEventListener('input', () => {
  clearUrlBtn.style.display = urlInput.value.trim() ? '' : 'none';
});

clearUrlBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearUrlBtn.style.display = 'none';
  urlInput.focus();
  hideError();
  hideElement(videoInfo);
  hideMultiVideo();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fetchVideoInfo();
  }
});

// ========== Fetch Video Info ==========

fetchBtn.addEventListener('click', fetchVideoInfo);

async function fetchVideoInfo() {
  const rawInput = urlInput.value.trim();
  if (!rawInput) {
    showError('请输入视频链接，或抖音、小红书分享口令');
    return;
  }

  const url = extractKnownVideoUrl(rawInput);
  if (!url) {
    showError('请输入有效链接；支持 YouTube、B站、TapTap、抖音和小红书，也可粘贴完整分享口令');
    return;
  }
  if (urlInput.value !== url) {
    urlInput.value = url;
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  hideError();
  hideElement(videoInfo);
  showElement(loadingSpinner);
  fetchBtn.disabled = true;

  try {
    const infos = await window.ytdl.fetchVideoInfo(url);
    if (!Array.isArray(infos) || infos.length === 0) throw new Error('没有找到可下载的视频');
    if (infos.length === 1) {
      currentVideoInfo = infos[0];
      currentVideos = null;
      displayVideoInfo(currentVideoInfo);
      hideMultiVideo();
      showElement(videoInfo);
    } else {
      currentVideoInfo = null;
      currentVideos = infos;
      hideElement(videoInfo);
      displayMultipleVideoInfo(infos);
    }
    hideElement(loadingSpinner);
    videoInfo.classList.add('fade-in');
    fetchBtn.disabled = false;
  } catch (err) {
    hideElement(loadingSpinner);
    fetchBtn.disabled = false;
    showError(toChineseError(err, '获取视频信息失败，请检查链接或网络后重试'));
  }
}

function showError(msg) {
  urlError.textContent = msg;
  showElement(urlError);
}

function hideError() {
  hideElement(urlError);
}

function displayVideoInfo(info) {
  // Thumbnail
  const thumbnailUrl = safeImageUrl(info.thumbnail);
  thumbnail.classList.remove('image-failed');
  if (thumbnailUrl) thumbnail.src = thumbnailUrl;
  else {
    thumbnail.removeAttribute('src');
    thumbnail.classList.add('image-failed');
  }
  thumbnail.alt = info.title || '视频封面';

  // Duration
  duration.textContent = formatDuration(info.duration);

  // Title & Channel
  videoTitle.textContent = info.title;
  videoChannel.textContent = info.channel || '';

  const webmOption = formatSelect.querySelector('option[value="webm"]');
  const isImageNote = ['douyin-note', 'xiaohongshu-note'].includes(info.platform);
  const canUseWebm = isYoutubeUrl(info.webpageUrl);
  if (webmOption) webmOption.disabled = !canUseWebm;
  if (!canUseWebm && formatSelect.value === 'webm') formatSelect.value = 'mp4';
  if (isImageNote) {
    formatSelect.value = 'mp4';
    formatSelect.disabled = true;
    formatSelect.title = '图文作品将保存为原图文件夹';
  } else {
    formatSelect.disabled = false;
    formatSelect.title = canUseWebm ? '选择输出格式' : '当前平台仅支持 MP4 视频格式';
  }

  // Resolution options — native hidden select (for backward compat)
  resolutionSelect.innerHTML = '';
  for (const opt of info.resolutionOptions) {
    const option = document.createElement('option');
    option.value = opt.id;
    option.textContent = opt.label;
    if (opt.id === 'best') option.selected = true;
    resolutionSelect.appendChild(option);
  }

  // Resolution options — custom dropdown
  selectedResolutionId = 'best';
  renderCustomResolutionSelect(info.resolutionOptions);

  // Enable download button
  downloadBtn.disabled = false;
  downloadBtn.classList.add('ready');
}

function hideMultiVideo() {
  hideElement(multiVideoSection);
  multiVideoList.innerHTML = '';
  currentVideos = null;
}

// Build resolution options HTML for a native <select>
function _buildResolutionOptions(resolutionOptions) {
  return resolutionOptions.map(opt =>
    `<option value="${escapeAttribute(opt.id)}"${opt.id === 'best' ? ' selected' : ''}${opt._virtual ? ' disabled' : ''}>${escapeHtml(opt.label)}</option>`
  ).join('');
}

function displayMultipleVideoInfo(infos) {
  multiVideoCount.textContent = `该页面包含 ${infos.length} 个视频，请选择要下载的视频：`;
  multiVideoList.innerHTML = infos.map((video, idx) => {
    const durationStr = formatDuration(video.duration);
    const thumbUrl = safeImageUrl(video.thumbnail);
    const thumbHtml = thumbUrl
      ? `<img src="${escapeAttribute(thumbUrl)}" alt="${escapeAttribute(video.title || '视频封面')}" loading="lazy">`
      : '<div class="mv-thumb-placeholder">暂无缩略图</div>';
    const durationBadge = video.duration > 0 ? `<span class="duration-badge">${durationStr}</span>` : '';
    const resOptions = _buildResolutionOptions(video.resolutionOptions);

    return `<div class="card mv-card" data-index="${idx}">
      <div class="mv-card-left">
        <div class="thumbnail-wrapper">
          ${thumbHtml}
          ${durationBadge}
        </div>
      </div>
      <div class="mv-card-right">
        <h4 class="mv-card-title" title="${escapeAttribute(video.title)}">${escapeHtml(video.title)}</h4>
        <div class="mv-card-controls">
          <div class="mv-control-row">
            <label>画质</label>
            <select id="mv_res_${idx}" class="mv-res-select">${resOptions}</select>
          </div>
          <div class="mv-control-row">
            <label>格式</label>
            <select id="mv_fmt_${idx}" class="mv-fmt-select" title="${isYoutubeUrl(video.webpageUrl) ? '选择输出格式' : '当前平台仅支持 MP4'}">
              <option value="mp4">MP4</option>
              <option value="webm"${isYoutubeUrl(video.webpageUrl) ? '' : ' disabled'}>WebM（仅 YouTube）</option>
            </select>
          </div>
        </div>
        <button class="btn-primary btn-download mv-dl-btn" data-index="${idx}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          下载此视频
        </button>
      </div>
    </div>`;
  }).join('');

  showElement(multiVideoSection);
}

function renderCustomResolutionSelect(options) {
  csDropdown.innerHTML = options.map((opt, i) => {
    const sel = opt.id === selectedResolutionId;
    const divider = (i > 0 && opt.id === 'audio') ? '<div class="cs-divider"></div>' : '';
    const disabled = opt._virtual ? ' cs-disabled' : '';
    const badge = opt._disableReason ? `<span class="cs-badge">${escapeHtml(opt._disableReason)}</span>` : '';
    return `${divider}<div class="cs-option${sel ? ' selected' : ''}${disabled}" data-value="${escapeAttribute(opt.id)}">
      <span class="cs-opt-label">${escapeHtml(opt.label)}</span>
      ${badge}
      ${sel ? '<span class="cs-check">✓</span>' : ''}
    </div>`;
  }).join('');

  const selected = options.find(o => o.id === selectedResolutionId);
  csValue.textContent = selected ? selected.label : '选择画质';
  csValue.classList.toggle('placeholder', !selected);
}

// ========== Download Settings ==========

// Resolution change
resolutionSelect.addEventListener('change', () => {
  const isNoteImages = ['douyin-note', 'xiaohongshu-note'].includes(currentVideoInfo?.platform) && resolutionSelect.value !== 'audio';
  formatSelect.disabled = resolutionSelect.value === 'audio' || isNoteImages;
  if (isNoteImages) formatSelect.title = '图文作品将保存为原图文件夹';
});

// ========== Custom Resolution Select ==========

function selectResolutionOption(value) {
  const selectedOption = currentVideoInfo?.resolutionOptions?.find(option => option.id === value);
  if (!selectedOption || selectedOption._virtual) return;
  selectedResolutionId = value;
  if (currentVideoInfo) {
    renderCustomResolutionSelect(currentVideoInfo.resolutionOptions);
  }
  // Sync hidden native select and trigger its change handler
  resolutionSelect.value = value;
  resolutionSelect.dispatchEvent(new Event('change', { bubbles: true }));
  // Close dropdown
  csResolution.classList.remove('open');
}

// Click trigger to toggle dropdown
const csTrigger = csResolution.querySelector('.cs-trigger');
csTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  csResolution.classList.toggle('open');
});

// Select option via click
csDropdown.addEventListener('click', (e) => {
  const opt = e.target.closest('.cs-option');
  if (!opt) return;
  if (opt.classList.contains('cs-disabled')) return;
  selectResolutionOption(opt.dataset.value);
});

// Close on outside click
document.addEventListener('click', () => {
  csResolution.classList.remove('open');
});

// Keyboard navigation
csTrigger.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (csResolution.classList.contains('open')) {
      // Confirm currently hovered/focused option
      const hovered = csDropdown.querySelector('.cs-option:hover') || csDropdown.querySelector('.cs-option.selected');
      if (hovered) selectResolutionOption(hovered.dataset.value);
    } else {
      csResolution.classList.add('open');
    }
  }
  if (e.key === 'Escape') {
    csResolution.classList.remove('open');
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!csResolution.classList.contains('open')) {
      csResolution.classList.add('open');
    }
    const opts = csDropdown.querySelectorAll('.cs-option:not(.cs-disabled)');
    if (opts.length === 0) return;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const cur = csDropdown.querySelector('.cs-option.selected');
    const idx = cur ? Array.from(opts).indexOf(cur) : (dir === 1 ? -1 : 0);
    const next = Math.max(0, Math.min(opts.length - 1, idx + dir));
    // Update visual selection (does NOT commit until Enter)
    opts.forEach(o => o.classList.remove('selected'));
    opts[next].classList.add('selected');
    opts[next].scrollIntoView({ block: 'nearest' });
    // Keep focus on trigger so subsequent Enter works
  }
});

// Prevent dropdown close when clicking inside it
csDropdown.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Output directory
browseDirBtn.addEventListener('click', async () => {
  try {
    const dir = await window.ytdl.selectOutputDir();
    if (dir) {
      outputDir.value = dir;
      settings.outputDir = dir;
      await persistSettings();
    }
  } catch (error) {
    showToast(toChineseError(error, '选择保存位置失败，请重试'), 'error');
  }
});

// ========== Download ==========

downloadBtn.addEventListener('click', () => startDownload());

let activeDownloadId = null;

async function startDownload(videoInfoOverride) {
  // If called per-card (multi-video), resolve video info from override;
  // otherwise use the global currentVideoInfo (single-video flow)
  const video = videoInfoOverride || currentVideoInfo;
  if (!video) return;

  const url = urlInput.value.trim();
  let formatId;
  let requestedFormat = formatSelect.value;
  if (videoInfoOverride && currentVideos) {
    const idx = currentVideos.indexOf(video);
    const resSelect = document.getElementById(`mv_res_${idx}`);
    const fmtSelect = document.getElementById(`mv_fmt_${idx}`);
    if (resSelect) formatId = resSelect.value;
    if (fmtSelect) requestedFormat = fmtSelect.value;
  }
  if (!formatId) formatId = resolutionSelect.value;
  if (!isYoutubeUrl(video.webpageUrl) && requestedFormat === 'webm') requestedFormat = 'mp4';

  const isImageCollection = ['douyin-note', 'xiaohongshu-note'].includes(video.platform) && formatId !== 'audio';
  const ext = formatId === 'audio' ? 'mp3' : (isImageCollection ? 'images' : requestedFormat);
  const selAudioOnly = formatId === 'audio';
  const outDir = outputDir.value || settings.outputDir;

  // Resolve "最佳画质（自动）" to the highest available resolution formatId
  if (formatId === 'best') {
    const highest = video.resolutionOptions.find(o => o.id !== 'best' && o.id !== 'audio' && !o._virtual);
    if (highest) {
      formatId = highest.id;
    }
  }

  // Find format info for the resolution
  const selectedFormat = video.resolutionOptions.find(o => o.id === formatId);

  const options = {
    formatId,
    formatNote: selectedFormat
      ? (selectedFormat.label || selectedFormat.formatNote).replace(/\s+约[\d.]+[MG]$/, '').trim()
      : formatId,
    resolutionLabel: selectedFormat?.formatNote || (formatId === 'audio' ? 'audio' : ''),
    ext,
    audioOnly: selAudioOnly,
    hasAudio: !!(selectedFormat?.hasAudio),
    filesize: selectedFormat?.filesize || 0,
    outputDir: outDir,
    title: video.title,
    isImageCollection,
    imageCount: isImageCollection ? Math.max(0, Number(video.imageCount) || 0) : 0,
    isNativeDownload: !!video.needsNativeDownload,
    playlistIndex: video.playlistIndex || 1,
  };

  try {
    const taskId = await window.ytdl.startDownload({ url, options });
    activeDownloadId = taskId;

    if (!videoInfoOverride) {
      // Single-video: show feedback on the global button
      downloadBtn.disabled = true;
      downloadBtn.textContent = '已添加到队列';
      setTimeout(() => {
        downloadBtn.textContent = '开始下载';
        downloadBtn.disabled = false;
      }, 2000);
    }
  } catch (err) {
    showToast(toChineseError(err, '添加下载任务失败，请重试'), 'error');
    if (!videoInfoOverride) {
      downloadBtn.textContent = '开始下载';
      downloadBtn.disabled = false;
    }
  }
}

// Start download for a specific video in the multi-video list
async function startDownloadAtIndex(idx) {
  if (!currentVideos || idx < 0 || idx >= currentVideos.length) return;
  await startDownload(currentVideos[idx]);
  queueTab.click();
}


// ========== Queue Display ==========

function queueRenderSignature(items) {
  return items.map(task => JSON.stringify([
    task.id,
    task.status,
    Number(task.progress?.percent || 0).toFixed(1),
    task.progress?.speed || '',
    task.progress?.eta || '',
    task.progress?.totalSize || '',
    task.stage || '',
    task.error || '',
    task.options?.formatNote || '',
    task.options?.actualResolution || '',
  ])).join('|');
}

function renderQueue(items) {
  // Skip if queue data hasn't changed since last render
  const sig = queueRenderSignature(items);
  if (sig === (renderQueue._lastSig)) return;
  renderQueue._lastSig = sig;

  queueItems = items;
  // Show/hide empty state
  if (items.length === 0) {
    showElement(queueEmpty);
    queueList.innerHTML = '';
  } else {
    hideElement(queueEmpty);
  }

  // Count active items
  const activeCount = items.filter(t => t.status === 'queued' || t.status === 'downloading' || t.status === 'fetching' || t.status === 'paused').length;
  queueCount.textContent = activeCount;

  // Build list — using data-action attributes instead of inline onclick
  // to avoid lost clicks from rapid DOM re-rendering (event delegation)
  queueList.innerHTML = items.map(task => {
    const statusIcon = getStatusIcon(task.status);
    const pct = Math.max(0, Math.min(100, Number(task.progress?.percent) || 0));
    const metaParts = [];
    if (task.options?.formatNote) {
      if (task.status === 'completed' && task.options?.actualResolution) {
        metaParts.push(`${task.options.formatNote} (${task.options.actualResolution})`);
      } else {
        metaParts.push(task.options.formatNote);
      }
    }
    if (task.progress?.totalSize) metaParts.push(task.progress.totalSize);
    if (task.status === 'error' && task.error) {
      metaParts.push(task.error);
    } else if (task.status === 'completed') {
      // 完成态不显示速度，只显示文件大小（已在上面添加）
    } else if (task.progress?.speed) {
      metaParts.push(task.progress.speed);
      if (task.progress?.eta) metaParts.push(`剩余 ${task.progress.eta}`);
    } else if (task.status === 'downloading') {
      const stageText = {
        'preparing': '准备中',
        'downloading': '正在下载',
        'resolving': '正在解析下载资源',
        'creating-task': '正在建立下载任务',
        'connecting': '正在连接资源',
        'merging': '正在合并音视频',
        'finalizing': '正在校验最终文件',
      };
      metaParts.push(stageText[task.stage] || '准备中');
    } else if (task.status === 'queued') {
      metaParts.push('等待中');
    }

    const actions = [];
    if (task.status === 'paused') actions.push('<button data-action="resume" title="继续">▶</button>');
    if (task.status === 'queued' || task.status === 'paused') actions.push('<button data-action="remove" title="移除">✕</button>');
    if ((task.status === 'downloading' || task.status === 'fetching') && !task._finalizing && !['merging', 'finalizing'].includes(task.stage)) actions.push('<button data-action="pause" title="暂停">⏸</button>');
    if (task.status === 'error' || task.status === 'cancelled') actions.push('<button data-action="retry" title="重试">↻</button>');
    if (task.status === 'cancelled' || task.status === 'error' || task.status === 'completed') actions.push('<button data-action="remove" title="移除">✕</button>');

    return `
      <div class="queue-item" data-id="${escapeAttribute(task.id)}">
        <div class="queue-item-icon ${escapeAttribute(task.status)}">${statusIcon}</div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(task.title || '未知视频')}</div>
          <div class="queue-item-meta">${escapeHtml(formatStatus(task.status))}${metaParts.length ? ' · ' + escapeHtml(metaParts.join(' · ')) : ''}</div>
          ${(task.status === 'downloading' || task.status === 'paused') ? `
            <div class="queue-mini-bar">
              <div class="queue-mini-fill" style="width: ${pct}%"></div>
            </div>
          ` : ''}
        </div>
        ${task.status === 'downloading' ? `<div class="queue-item-progress">${pct.toFixed(1)}%</div>` : ''}
        <div class="queue-item-actions">${actions.join('')}</div>
      </div>
    `;
  }).join('');

}

// Event delegation for queue action buttons (avoids lost clicks from innerHTML churn)
queueList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const item = btn.closest('.queue-item');
  if (!item) return;
  const taskId = item.dataset.id;
  if (!taskId) return;

  try {
    switch (btn.dataset.action) {
      case 'pause':
        await window.ytdl.pauseDownload(taskId);
        break;
      case 'resume':
        await window.ytdl.resumeDownload(taskId);
        break;
      case 'retry':
        await window.ytdl.retryDownload(taskId);
        break;
      case 'remove':
        await handleRemoveQueueItem(taskId);
        break;
    }
  } catch (error) {
    showToast(toChineseError(error, '任务操作失败，请重试'), 'error');
  }
});

// Right-click context menu on queue items
queueList.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.queue-item');
  if (!item) return;
  const taskId = item.dataset.id;
  if (!taskId) return;
  e.preventDefault();
  window.ytdl.showQueueContextMenu(taskId);
});

function getStatusIcon(status) {
  switch (status) {
    case 'queued': return '⏳';
    case 'fetching':
    case 'downloading': return '▶';
    case 'paused': return '⏸';
    case 'completed': return '✓';
    case 'error': return '✕';
    case 'cancelled': return '−';
    default: return '•';
  }
}


function formatHistoryDate(date) {
  if (!date) return '';
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    return ` · ${d.toLocaleString()}`;
  } catch (e) { return ''; }
}

async function handleRemoveQueueItem(taskId) {
  try {
    await window.ytdl.removeQueueItem(taskId);
  } catch (error) {
    showToast(toChineseError(error, '移除任务失败，请重试'), 'error');
  }
}

// ========== History Display ==========

let historyData = [];

async function renderHistory() {
  const newData = await window.ytdl.getHistory();
  const sig = JSON.stringify(newData);
  if (sig === renderHistory._lastSig) return;
  renderHistory._lastSig = sig;
  historyData = newData;

  if (historyData.length === 0) {
    showElement(historyEmpty);
    historyList.innerHTML = '';
    return;
  }

  hideElement(historyEmpty);

  historyList.innerHTML = historyData.map(item => {
    const formatText = item.actualResolution
      ? `${item.format || '最佳画质'}（${item.actualResolution}）`
      : (item.format || '最佳画质');
    const metaText = `${formatText}${item.fileSize ? ` · ${item.fileSize}` : ''}${formatHistoryDate(item.downloadedAt || item.date)}`;
    return `
    <div class="queue-item" data-id="${escapeAttribute(item.id)}">
      <div class="queue-item-icon completed">✓</div>
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(item.title || '未知视频')}</div>
        <div class="queue-item-meta">${escapeHtml(metaText)}</div>
      </div>
      <div class="queue-item-actions">
        ${item.filePath ? `<button data-action="open-file" title="打开文件位置">📂</button>` : ''}
        <button data-action="delete-history" title="删除">✕</button>
      </div>
    </div>
  `;
  }).join('');
}

// Event delegation for history action buttons (avoids onclick CSP issues)
historyList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const itemEl = btn.closest('.queue-item');
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  if (!id) return;
  const item = historyData.find(h => h.id === id);
  if (!item) return;

  try {
    if (btn.dataset.action === 'open-file') {
      await window.ytdl.openInExplorer(item.filePath);
    } else if (btn.dataset.action === 'delete-history') {
      await window.ytdl.deleteHistoryItem(id);
      await renderHistory();
    }
  } catch (error) {
    showToast(toChineseError(error, '历史记录操作失败，请重试'), 'error');
  }
});

clearHistoryBtn.addEventListener('click', async () => {
  if (!window.confirm('确定清空全部下载历史吗？此操作不会删除已下载文件。')) return;
  try {
    await window.ytdl.clearHistory();
    await renderHistory();
    showToast('下载历史已清空', 'success');
  } catch (error) {
    showToast(toChineseError(error, '清空下载历史失败，请重试'), 'error');
  }
});

// ========== Tabs ==========

queueTab.addEventListener('click', () => {
  queueTab.classList.add('active');
  batchTab.classList.remove('active');
  historyTab.classList.remove('active');
  queuePanel.classList.add('active');
  batchPanel.classList.remove('active');
  historyPanel.classList.remove('active');
  showElement(resumeAllBtn);
  showElement(pauseAllBtn);
  showElement(cancelAllBtn);
  hideElement(clearHistoryBtn);
  hideElement(batchStartAllBtn);
});

batchTab.addEventListener('click', () => {
  batchTab.classList.add('active');
  queueTab.classList.remove('active');
  historyTab.classList.remove('active');
  batchPanel.classList.add('active');
  queuePanel.classList.remove('active');
  historyPanel.classList.remove('active');
  hideElement(resumeAllBtn);
  hideElement(pauseAllBtn);
  hideElement(cancelAllBtn);
  hideElement(clearHistoryBtn);
  showElement(batchStartAllBtn);
});

historyTab.addEventListener('click', () => {
  historyTab.classList.add('active');
  queueTab.classList.remove('active');
  batchTab.classList.remove('active');
  historyPanel.classList.add('active');
  queuePanel.classList.remove('active');
  batchPanel.classList.remove('active');
  hideElement(resumeAllBtn);
  hideElement(pauseAllBtn);
  hideElement(cancelAllBtn);
  showElement(clearHistoryBtn);
  hideElement(batchStartAllBtn);
  renderHistory();
});

// ========== Batch Operations ==========

pauseAllBtn.addEventListener('click', async () => {
  try {
    await window.ytdl.pauseAll();
  } catch (error) {
    showToast(toChineseError(error, '暂停全部任务失败，请重试'), 'error');
  }
});

resumeAllBtn.addEventListener('click', async () => {
  try {
    await window.ytdl.resumeAll();
  } catch (error) {
    showToast(toChineseError(error, '继续全部任务失败，请重试'), 'error');
  }
});

cancelAllBtn.addEventListener('click', async () => {
  const cancellable = queueItems.filter(item => ['queued', 'fetching', 'downloading', 'paused'].includes(item.status));
  if (cancellable.length === 0) {
    showToast('当前没有可取消的任务');
    return;
  }
  if (!window.confirm(`确定取消 ${cancellable.length} 个未完成任务吗？已下载的临时片段将被清理。`)) return;
  try {
    await window.ytdl.cancelAll();
    showToast('未完成任务已取消', 'success');
  } catch (error) {
    showToast(toChineseError(error, '取消全部任务失败，请重试'), 'error');
  }
});

// ========== Batch Download ==========

let batchData = []; // { id, url, title, thumbnail, duration, channel, resolutionOptions, selectedId, format, autoNote }

// Parse and validate YouTube URLs from textarea
function parseBatchUrls(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const seen = new Set();
  const allValid = [];
  const invalid = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    if (isYoutubeUrl(line)) allValid.push(line);
    else invalid.push(line);
  }
  const valid = allValid.slice(0, 50);
  return { valid, invalid, total: lines.length, omitted: Math.max(0, allValid.length - valid.length) };
}

// Auto-trigger batch parse on paste
batchUrlInput.addEventListener('paste', () => {
  setTimeout(() => {
    const text = batchUrlInput.value.trim();
    if (text) {
      batchParseBtn.click();
    }
  }, 50);
});

// Right-click auto-paste on batch textarea
batchUrlInput.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  try {
    const text = await window.ytdl.readClipboard();
    if (text) {
      batchUrlInput.value = text;
      batchUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (text.trim()) {
        batchParseBtn.click();
      }
    }
  } catch (err) { /* clipboard unavailable */ }
});

// Progressive batch parse listener (shows results as each batch resolves)
let _batchListenActive = false;
let _batchExpectedCount = 0;
let _batchCookieDetected = false;

function sanitizeBatchError(error) {
  return toChineseError(error, '无法获取视频信息')
    .replace(/cookies?\.txt/gi, '登录信息')
    .replace(/cookies?/gi, '登录信息');
}

function _hasCookieErrors() {
  return batchData.some(item => /登录|验证|cookie/i.test(item.autoNote || ''));
}

function _updateCookieBanner() {
  if (_hasCookieErrors()) showElement(batchCookieWarning);
  else hideElement(batchCookieWarning);
}

window.ytdl.onBatchParseProgress((partial) => {
  if (!_batchListenActive) return;

  for (const r of partial) {
    if (r.ok && r.info) {
      const info = r.info;
      const bestOpt = info.resolutionOptions && info.resolutionOptions.length > 0
        ? info.resolutionOptions[0] : null;
      batchData.push({
        id: generateBatchId(),
        url: r.url,
        title: info.title || '未知视频',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        channel: info.channel || '',
        resolutionOptions: info.resolutionOptions || [],
        selectedId: bestOpt ? bestOpt.id : 'best',
        format: 'mp4',
        autoNote: '',
        outputDir: '',
        _prevResId: null,
        needsNativeDownload: !!info.needsNativeDownload,
      });
    } else {
      batchData.push({
        id: generateBatchId(),
        url: r.url,
        title: '解析失败',
        thumbnail: '',
        duration: 0,
        channel: '',
        resolutionOptions: [],
        selectedId: 'best',
        format: 'mp4',
        autoNote: sanitizeBatchError(r.error),
        outputDir: '',
        _prevResId: null,
      });
    }
  }

  renderBatchResults();
  _updateCookieBanner();
  batchUrlStats.textContent = `正在解析 ${batchData.length}/${_batchExpectedCount}…`;
});

// Batch parse button
batchParseBtn.addEventListener('click', async () => {
  const text = batchUrlInput.value.trim();
  if (!text) return;

  const { valid, invalid, omitted } = parseBatchUrls(text);
  if (valid.length === 0) {
    batchUrlStats.textContent = '没有有效的 YouTube 链接';
    return;
  }

  batchUrlStats.textContent = `正在解析 ${valid.length} 个视频…`;
  batchParseBtn.disabled = true;
  hideElement(batchResults);
  hideElement(batchEmpty);

  // Enable progressive rendering via listener
  _batchListenActive = true;
  _batchExpectedCount = valid.length;
  batchData = [];

  try {
    const results = await window.ytdl.fetchMultipleVideoInfo(valid);

    // Safety fallback: process any items missed by progressive listener
    if (batchData.length < results.length) {
      for (let i = batchData.length; i < results.length; i++) {
        const r = results[i];
        if (r.ok && r.info) {
          const info = r.info;
          const bestOpt = info.resolutionOptions && info.resolutionOptions.length > 0
            ? info.resolutionOptions[0] : null;
          batchData.push({
            id: generateBatchId(),
            url: r.url,
            title: info.title || '未知视频',
            thumbnail: info.thumbnail || '',
            duration: info.duration || 0,
            channel: info.channel || '',
            resolutionOptions: info.resolutionOptions || [],
            selectedId: bestOpt ? bestOpt.id : 'best',
            format: 'mp4',
            autoNote: '',
            outputDir: '',
            _prevResId: null,
            needsNativeDownload: !!info.needsNativeDownload,
          });
        } else {
          batchData.push({
            id: generateBatchId(),
            url: r.url,
            title: '解析失败',
            thumbnail: '',
            duration: 0,
            channel: '',
            resolutionOptions: [],
            selectedId: 'best',
            format: 'mp4',
            autoNote: sanitizeBatchError(r.error),
            outputDir: '',
            _prevResId: null,
          });
        }
      }
      renderBatchResults();
      _updateCookieBanner(); // also check after safety fallback
    }

    // Show results (already shown by progressive listener, but ensure visibility)
    showElement(batchResults);

    const failed = batchData.filter(d => d.title === '解析失败').length;
    const hasCookie = _hasCookieErrors();
    let stats = `共 ${batchData.length} 个视频`;
    if (failed > 0) {
      if (hasCookie && failed === batchData.length) {
        stats += `，全部因登录验证限制失败`;
      } else if (hasCookie) {
        stats += `，${failed} 个解析失败（含登录验证限制）`;
      } else {
        stats += `，${failed} 个解析失败`;
      }
    }
    if (invalid.length > 0) stats += `，${invalid.length} 个无效链接已忽略`;
    if (omitted > 0) stats += `，超出上限的 ${omitted} 个链接未处理`;
    batchUrlStats.textContent = stats;
  } catch (err) {
    batchUrlStats.textContent = '批量解析失败：' + toChineseError(err, '请检查网络后重试');
  } finally {
    _batchListenActive = false;
    batchParseBtn.disabled = false;
  }
});

let _batchIdCounter = 0;
function generateBatchId() {
  return 'batch_' + (++_batchIdCounter) + '_' + Date.now().toString(36);
}

// Apply unified quality to all items (with auto-downgrade)
function applyBatchQuality(qualityVal) {
  for (const item of batchData) {
    if (!item.resolutionOptions || item.resolutionOptions.length === 0) {
      item.autoNote = '无可用格式';
      continue;
    }

    if (qualityVal === 'best') {
      const best = item.resolutionOptions[0];
      item.selectedId = best ? best.id : 'best';
      item.autoNote = '';
      continue;
    }

    const targetHeight = parseInt(qualityVal);
    // Find the best option at target height or lower (auto-downgrade)
    let selected = null;
    for (const opt of item.resolutionOptions) {
      if (opt.id === 'best' || opt.id === 'audio' || opt._virtual) continue;
      if (opt.height && opt.height <= targetHeight) {
        if (!selected || opt.height > selected.height) selected = opt;
      }
    }
    if (selected) {
      item.selectedId = selected.id;
      item.autoNote = selected.height < targetHeight
        ? `已自动降级到${selected.height}p` : '';
    } else if (qualityVal === '360') {
      // Even 360p not available — just use best
      const best = item.resolutionOptions.find(o => o.id !== 'audio' && !o._virtual);
      item.selectedId = best ? best.id : 'best';
      item.autoNote = '已使用最佳画质';
    } else {
      // Try next lower tier recursively
      const lowerTiers = [360, 480, 720, 1080, 1440, 2160].filter(h => h < targetHeight).reverse();
      let found = false;
      for (const lt of lowerTiers) {
        for (const opt of item.resolutionOptions) {
          if (opt.id === 'best' || opt.id === 'audio' || opt._virtual) continue;
          if (opt.height && opt.height <= lt) {
            if (!selected || opt.height > selected.height) selected = opt;
          }
        }
        if (selected) {
          item.selectedId = selected.id;
          item.autoNote = `已自动降级到${selected.height}p`;
          found = true;
          break;
        }
      }
      if (!found) {
        const best = item.resolutionOptions.find(o => o.id !== 'audio' && !o._virtual);
        item.selectedId = best ? best.id : 'best';
        item.autoNote = '已使用最佳画质';
      }
    }
  }
}

// Render batch results as full card layout
function renderBatchResults() {
  batchResultList.innerHTML = batchData.map(item => {
    const opt = item.resolutionOptions.find(option => option.id === item.selectedId);
    const sizeLabel = opt?.filesize ? formatFileSize(opt.filesize) : '';
    const isFailed = item.title === '解析失败';
    const thumbUrl = safeImageUrl(item.thumbnail);
    const itemId = escapeAttribute(item.id);

    return `
      <div class="batch-item-card" data-id="${itemId}">
        <button class="batch-card-close" data-batch-remove="${itemId}" title="从列表中移除" aria-label="从列表中移除">✕</button>
        <div class="batch-card-thumb">
          ${thumbUrl
            ? `<img src="${escapeAttribute(thumbUrl)}" alt="视频封面">`
            : `<div class="batch-thumb-empty" aria-label="暂无封面">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25" aria-hidden="true">
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <polygon points="10,8 16,12 10,16" fill="currentColor"/>
                </svg>
               </div>`
          }
          ${item.duration ? `<span class="duration-badge">${escapeHtml(formatDuration(item.duration))}</span>` : ''}
        </div>
        ${isFailed ? `
        <div class="batch-card-body">
          <div class="batch-card-error">${escapeHtml(item.autoNote || '无法获取视频信息')}</div>
        </div>
        ` : `
        <div class="batch-card-body">
          <div class="batch-card-title" title="${escapeAttribute(item.title)}">${escapeHtml(item.title)}</div>
          <div class="batch-card-row-sub">
            ${item.channel ? `<span class="batch-card-channel">${escapeHtml(item.channel)}</span>` : ''}
            ${item.autoNote ? `<span class="batch-auto-note">${escapeHtml(item.autoNote)}</span>` : ''}
          </div>
          <div class="batch-card-actions">
            <div class="batch-card-ctrl">
              <select data-batch-quality="${itemId}" class="batch-sm-select" aria-label="选择画质"${item.format === 'mp3' ? ' disabled' : ''}>
                ${item.resolutionOptions.map(option =>
                  `<option value="${escapeAttribute(option.id)}"${option.id === item.selectedId ? ' selected' : ''}${option._virtual ? ' disabled' : ''}>${escapeHtml(option.label || option.formatNote || '未知画质')}</option>`
                ).join('')}
              </select>
              <select data-batch-format="${itemId}" class="batch-sm-select batch-format-select" aria-label="选择格式">
                <option value="mp4"${item.format === 'mp4' ? ' selected' : ''}>MP4</option>
                <option value="webm"${item.format === 'webm' ? ' selected' : ''}>WebM</option>
                <option value="mp3"${item.format === 'mp3' ? ' selected' : ''}>MP3 音频</option>
              </select>
            </div>
            <span class="batch-card-size">${escapeHtml(sizeLabel)}</span>
            <button class="btn-primary btn-sm batch-dl-btn" data-batch-download="${itemId}">下载</button>
          </div>
        </div>
        `}
      </div>
    `;
  }).join('');

  const active = batchData.filter(item => item.title !== '解析失败');
  const totalCount = active.length;
  let totalBytes = 0;
  for (const item of active) {
    const opt = item.resolutionOptions.find(option => option.id === item.selectedId);
    if (opt?.filesize) totalBytes += opt.filesize;
  }

  batchCount.textContent = `待下载：${totalCount} 个视频`;
  batchTotalSize.textContent = totalBytes > 0 ? `预计共 ${formatFileSize(totalBytes)}` : '';
  batchStartAllBtn.textContent = totalCount > 0 ? `开始全部下载（${totalCount}）` : '开始全部下载';
  batchStartAllBtn.disabled = totalCount === 0;
}

// Per-item controls via event delegation
batchResultList.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-batch-quality]');
  if (sel) {
    const id = sel.dataset.batchQuality;
    const item = batchData.find(d => d.id === id);
    if (item) {
      item.selectedId = sel.value;
      if (sel.value === 'audio') item.format = 'mp3';
      else if (item.format === 'mp3') item.format = 'mp4';
      item.autoNote = '';
      renderBatchResults();
    }
    return;
  }

  const fmt = e.target.closest('[data-batch-format]');
  if (fmt) {
    const id = fmt.dataset.batchFormat;
    const item = batchData.find(d => d.id === id);
    if (item) {
      const newFmt = fmt.value;
      if (newFmt === 'mp3' && item.format !== 'mp3') {
        // 保存当前画质并切换到音频
        item._prevResId = item.selectedId === 'audio' ? item._prevResId : item.selectedId;
        item.selectedId = 'audio';
      } else if (newFmt !== 'mp3' && item.format === 'mp3') {
        // 从音频切回视频时恢复原画质
        item.selectedId = item._prevResId || 'best';
      }
      item.format = newFmt;
      item.autoNote = '';
      renderBatchResults();
    }
    return;
  }

});

// Dir browse per item
batchResultList.addEventListener('click', async (e) => {
  const dirBtn = e.target.closest('[data-batch-dir]');
  if (dirBtn) {
    const id = dirBtn.dataset.batchDir;
    const item = batchData.find(d => d.id === id);
    if (item) {
      const dir = await window.ytdl.selectOutputDir();
      if (dir) {
        item.outputDir = dir;
        renderBatchResults();
      }
    }
    return;
  }

  // Remove item from batch list
  const closeBtn = e.target.closest('[data-batch-remove]');
  if (closeBtn) {
    const id = closeBtn.dataset.batchRemove;
    const idx = batchData.findIndex(d => d.id === id);
    if (idx !== -1) {
      batchData.splice(idx, 1);
      if (batchData.length === 0) {
        hideElement(batchResults);
        showElement(batchEmpty);
        batchUrlStats.textContent = '';
        batchStartAllBtn.textContent = '开始全部下载';
        batchStartAllBtn.disabled = true;
      } else {
        renderBatchResults();
      }
    }
    return;
  }

  // Per-item download
  const dlBtn = e.target.closest('[data-batch-download]');
  if (dlBtn) {
    const id = dlBtn.dataset.batchDownload;
    const item = batchData.find(d => d.id === id);
    if (!item || item.title === '解析失败') return;

    downloadSingleBatchItem(item, dlBtn);
    return;
  }
});

async function downloadSingleBatchItem(item, btnEl) {
  let opt = item.resolutionOptions.find(option => option.id === item.selectedId);
  if (!opt) return;

  let formatId = item.selectedId;
  const selAudioOnly = item.format === 'mp3' || formatId === 'audio';
  if (selAudioOnly) {
    formatId = 'audio';
    opt = item.resolutionOptions.find(option => option.id === 'audio') || opt;
  }
  const ext = selAudioOnly ? 'mp3' : (item.format === 'webm' ? 'webm' : 'mp4');
  const dir = item.outputDir || batchSaveDir.value.trim() || settings.outputDir || '';

  // Resolve 'best' to highest available tier so queue shows real resolution
  if (formatId === 'best') {
    const highest = item.resolutionOptions.find(o => o.id !== 'best' && o.id !== 'audio');
    if (highest) {
      formatId = highest.id;
      opt = highest;
    }
  }

  const options = {
    formatId,
    formatNote: opt
      ? (opt.label || opt.formatNote).replace(/\s+约[\d.]+[MG]$/, '').trim()
      : formatId,
    resolutionLabel: opt.formatNote || (selAudioOnly ? '音频' : ''),
    ext,
    audioOnly: selAudioOnly,
    hasAudio: !!(opt.hasAudio),
    filesize: opt.filesize || 0,
    outputDir: dir,
    title: item.title,
    isNativeDownload: !!item.needsNativeDownload,
  };

  try {
    btnEl.disabled = true;
    btnEl.textContent = '提交中…';
    await window.ytdl.startDownload({ url: item.url, options });
    btnEl.textContent = '已添加';
    queueTab.click();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = '下载';
    showToast(toChineseError(err, '添加该下载任务失败，请重试'), 'error');
  }
}

// Start all downloads
batchStartAllBtn.addEventListener('click', async () => {
  const active = batchData.filter(d => d.title !== '解析失败');
  if (active.length === 0) return;

  batchStartAllBtn.disabled = true;
  batchStartAllBtn.textContent = '正在提交…';
  const dir = batchSaveDir.value.trim() || settings.outputDir || '';

  let added = 0;
  let errors = 0;

  for (const item of active) {
    let opt = item.resolutionOptions.find(o => o.id === item.selectedId);
    if (!opt) { errors++; continue; }

    // Build options matching single download format
    let formatId = item.selectedId;
    const selAudioOnly = item.format === 'mp3' || formatId === 'audio';
    if (selAudioOnly) {
      formatId = 'audio';
      opt = item.resolutionOptions.find(option => option.id === 'audio') || opt;
    }
    const ext = selAudioOnly ? 'mp3' : (item.format === 'webm' ? 'webm' : 'mp4');

    if (formatId === 'best') {
      const highest = item.resolutionOptions.find(o => o.id !== 'best' && o.id !== 'audio' && !o._virtual);
      if (highest) {
        formatId = highest.id;
        opt = highest;
      }
    }

    const itemDir = item.outputDir || dir;
    const options = {
      formatId,
      formatNote: opt
        ? (opt.label || opt.formatNote).replace(/\s+约[\d.]+[MG]$/, '').trim()
        : formatId,
      resolutionLabel: opt.formatNote || (selAudioOnly ? '音频' : ''),
      ext,
      audioOnly: selAudioOnly,
      hasAudio: !!(opt.hasAudio),
      filesize: opt.filesize || 0,
      outputDir: itemDir,
      title: item.title,
      isNativeDownload: !!item.needsNativeDownload,
    };

    try {
      await window.ytdl.startDownload({ url: item.url, options });
      added++;
    } catch (error) {
      console.error('批量任务提交失败：', item.title, error);
      errors++;
    }
  }

  batchStartAllBtn.disabled = false;
  batchStartAllBtn.textContent = '开始全部下载';
  batchUrlStats.textContent = `已提交 ${added} 个任务${errors > 0 ? `，${errors} 个失败` : ''}`;

  // Switch to queue tab so user can see progress
  queueTab.click();
});

// Batch unified save directory browse
batchSaveBrowseBtn.addEventListener('click', async () => {
  try {
    const dir = await window.ytdl.selectOutputDir();
    if (dir) batchSaveDir.value = dir;
  } catch (error) {
    showToast(toChineseError(error, '选择批量保存位置失败，请重试'), 'error');
  }
});

// ========== Theme Toggle ==========

themeToggle.addEventListener('click', async () => {
  const previous = !!settings.darkMode;
  const nextSettings = { ...settings, darkMode: !previous };
  applyTheme(nextSettings.darkMode);
  if (!await persistSettings(nextSettings)) applyTheme(previous);
});

// ========== Proxy Settings ==========

proxyUrl.addEventListener('change', async () => {
  const previous = settings.proxyUrl || '';
  const candidate = proxyUrl.value.trim();
  const ok = await persistSettings({ ...settings, proxyUrl: candidate });
  if (ok) {
    proxyUrl.value = settings.proxyUrl || '';
    proxyStatus.textContent = candidate ? '代理设置已保存' : '已改为使用系统网络设置';
    proxyStatus.className = 'proxy-status visible success';
  } else {
    proxyUrl.value = previous;
    proxyStatus.textContent = '代理地址无效，请使用“协议://主机:端口”的格式';
    proxyStatus.className = 'proxy-status visible error';
  }
});

testProxyBtn.addEventListener('click', async () => {
  const url = proxyUrl.value.trim();
  if (!url) {
    proxyStatus.textContent = '请输入代理地址';
    proxyStatus.className = 'proxy-status visible error';
    return;
  }

  testProxyBtn.disabled = true;
  testProxyBtn.textContent = '测试中…';
  proxyStatus.className = 'proxy-status hidden';

  try {
    const result = await window.ytdl.testProxy(url);
    if (result.ok) {
      proxyStatus.textContent = '✅ 代理连接成功';
      proxyStatus.className = 'proxy-status visible success';
    } else {
      proxyStatus.textContent = '连接失败：' + toChineseError(result.error, '请检查代理地址和网络');
      proxyStatus.className = 'proxy-status visible error';
    }
  } catch (err) {
    proxyStatus.textContent = '测试失败：' + toChineseError(err, '请检查代理地址和网络');
    proxyStatus.className = 'proxy-status visible error';
  } finally {
    testProxyBtn.disabled = false;
    testProxyBtn.textContent = '测试';
  }
});

// ========== Event Listeners from Main ==========

function setupListeners() {
  // Queue updates
  const unsub1 = window.ytdl.onQueueUpdated((queue) => {
    // Preserve stage info set by download-stage events (which isn't in getQueue())
    for (const item of queue) {
      const existing = queueItems.find(t => t.id === item.id);
      if (existing?.stage && !item.stage) {
        item.stage = existing.stage;
      }
    }
    queueItems = queue;
    throttledRender();
  });

  // Throttle rapid renders to avoid full innerHTML rebuild on every IPC.
  // All paths (progress, stage, and queue-updated) now flow through here.
  let _renderTimer = null;
  let _lastQueueSig = '';
  function throttledRender() {
    if (_renderTimer) return;
    _renderTimer = setTimeout(() => {
      _renderTimer = null;
      // Skip rebuild if queue data hasn't actually changed
      const sig = queueRenderSignature(queueItems);
      if (sig === _lastQueueSig) return;
      _lastQueueSig = sig;
      renderQueue(queueItems);
    }, 200);
  }

  // Progress updates
  const unsub2 = window.ytdl.onDownloadProgress((taskId, progress) => {
    const task = queueItems.find(t => t.id === taskId);
    if (task) {
      task.progress = progress;
    }
    throttledRender();
  });

  // Download stage changes (video, audio, merging)
  const unsubStage = window.ytdl.onDownloadStage((taskId, stage) => {
    const task = queueItems.find(t => t.id === taskId);
    if (task) {
      task.stage = stage;
    }
    throttledRender();
  });

  // Download complete
  const unsub3 = window.ytdl.onDownloadComplete((taskId, filePath) => {
    // Queue state will arrive via queue-updated (emitted by finishDownload)
    if (historyPanel.classList.contains('active')) {
      renderHistory();
    }
    if (taskId === activeDownloadId) {
      activeDownloadId = null;
    }
  });

  // Download error
  const unsub4 = window.ytdl.onDownloadError((taskId, error) => {
    console.error('下载任务失败：', taskId, error);
    showToast(toChineseError(error, '下载失败，请在队列中重试'), 'error');
    // 队列状态会由主进程随后同步
  });

  // Context menu: remove record
  const unsubCtx = window.ytdl.onQueueContextRemove((taskId) => {
    handleRemoveQueueItem(taskId);
  });

  cleanupListeners = [unsub1, unsub2, unsub3, unsub4, unsubStage, unsubCtx];
}

// ========== Init ==========

async function init() {
  // Load settings
  settings = await window.ytdl.getSettings();

  // Auto-detect and show system proxy if not manually set
  if (!settings.proxyUrl) {
    const sysProxy = await window.ytdl.getSystemProxy();
    if (sysProxy) {
      proxyUrl.placeholder = `检测到系统代理：${sysProxy}`;
    }
  }

  // Apply theme
  applyTheme(settings.darkMode);

  // Set output dir
  outputDir.value = settings.outputDir || '';

  // Set proxy URL
  proxyUrl.value = settings.proxyUrl || '';

  // Check Bilibili login status
  checkBiliLoginStatus();

  // Check and display tool status (ffmpeg, aria2c)
  try {
    const tools = await window.ytdl.getTools();
    const items = [];
    if (tools.ffmpeg) {
      items.push('<span class="tool-item"><span class="tool-dot ok"></span> 高清合并组件已就绪</span>');
    } else {
      items.push('<span class="tool-item"><span class="tool-dot missing"></span> 缺少高清合并组件</span>');
    }
    if (tools.aria2c) {
      items.push('<span class="tool-item"><span class="tool-dot ok"></span> 多线程加速已启用</span>');
    } else {
      items.push('<span class="tool-item"><span class="tool-dot warn"></span> 未启用多线程加速</span>');
    }
    toolStatus.innerHTML = items.join('');
  } catch (e) { /* ignore */ }

  // Load initial queue
  const queue = await window.ytdl.getQueue();
  renderQueue(queue);

  // Setup IPC listeners
  setupListeners();

  // ESC to exit fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.ytdl.exitFullscreen();
    }
  });

}

window.addEventListener('error', event => {
  console.error('界面运行异常：', event.error || event.message);
  showToast('界面出现异常，请重试；若持续发生，请重新启动软件', 'error');
});

window.addEventListener('unhandledrejection', event => {
  console.error('未处理的界面异常：', event.reason);
  event.preventDefault();
  showToast(toChineseError(event.reason, '操作未完成，请重试'), 'error');
});

window.addEventListener('beforeunload', () => {
  for (const unsubscribe of cleanupListeners) {
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (error) { /* 页面即将关闭 */ }
  }
  cleanupListeners = [];
});

init().catch(error => {
  console.error('界面初始化失败：', error);
  showError(toChineseError(error, '软件初始化失败，请重新启动'));
  showToast(toChineseError(error, '软件初始化失败，请重新启动'), 'error');
});














