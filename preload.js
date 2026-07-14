const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytdl', {
  // Video info
  fetchVideoInfo: (url) => ipcRenderer.invoke('fetch-video-info', url),
  fetchMultipleVideoInfo: (urls) => ipcRenderer.invoke('fetch-multiple-video-info', urls),

  // Download control
  startDownload: (params) => ipcRenderer.invoke('start-download', params),
  pauseDownload: (taskId) => ipcRenderer.invoke('pause-download', taskId),
  resumeDownload: (taskId) => ipcRenderer.invoke('resume-download', taskId),
  cancelDownload: (taskId) => ipcRenderer.invoke('cancel-download', taskId),
  removeFromQueue: (taskId) => ipcRenderer.invoke('remove-from-queue', taskId),
  removeQueueItem: (taskId) => ipcRenderer.invoke('remove-queue-item', taskId),
  retryDownload: (taskId) => ipcRenderer.invoke('retry-download', taskId),
  pauseAll: () => ipcRenderer.invoke('pause-all'),
  resumeAll: () => ipcRenderer.invoke('resume-all'),
  cancelAll: () => ipcRenderer.invoke('cancel-all'),

  // Directory
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),

  // History
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  deleteHistoryItem: (id) => ipcRenderer.invoke('delete-history-item', id),

  // Queue
  getQueue: () => ipcRenderer.invoke('get-queue'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Proxy
  testProxy: (proxyUrl) => ipcRenderer.invoke('test-proxy', proxyUrl),
  getSystemProxy: () => ipcRenderer.invoke('get-system-proxy'),

  // Fullscreen
  exitFullscreen: () => ipcRenderer.invoke('exit-fullscreen'),

  // Context menu
  showQueueContextMenu: (taskId) => ipcRenderer.invoke('show-queue-context-menu', taskId),

  // File
  openInExplorer: (filePath) => ipcRenderer.invoke('open-in-explorer', filePath),

  // Tools detection
  getTools: () => ipcRenderer.invoke('get-tools'),

  // Clipboard
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),

  // Bilibili QR Login
  bilibiliLoginStart: () => ipcRenderer.invoke('bilibili-login-start'),
  bilibiliLoginPoll: (qrcodeKey) => ipcRenderer.invoke('bilibili-login-poll', qrcodeKey),
  getBilibiliLoginStatus: () => ipcRenderer.invoke('get-bilibili-login-status'),
  bilibiliLogout: () => ipcRenderer.invoke('bilibili-logout'),

  // Events from main
  onQueueUpdated: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('queue-updated', handler);
    return () => ipcRenderer.removeListener('queue-updated', handler);
  },
  onDownloadProgress: (cb) => {
    const handler = (_, taskId, progress) => cb(taskId, progress);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
  onDownloadComplete: (cb) => {
    const handler = (_, taskId, filePath) => cb(taskId, filePath);
    ipcRenderer.on('download-complete', handler);
    return () => ipcRenderer.removeListener('download-complete', handler);
  },
  onDownloadError: (cb) => {
    const handler = (_, taskId, error) => cb(taskId, error);
    ipcRenderer.on('download-error', handler);
    return () => ipcRenderer.removeListener('download-error', handler);
  },
  onDownloadStage: (cb) => {
    const handler = (_, taskId, stage) => cb(taskId, stage);
    ipcRenderer.on('download-stage', handler);
    return () => ipcRenderer.removeListener('download-stage', handler);
  },
  onQueueContextRemove: (cb) => {
    const handler = (_, taskId) => cb(taskId);
    ipcRenderer.on('queue-context-remove', handler);
    return () => ipcRenderer.removeListener('queue-context-remove', handler);
  },

  // Batch parse progress (progressive)
  onBatchParseProgress: (cb) => {
    const handler = (_, partial) => cb(partial);
    ipcRenderer.on('batch-parse-progress', handler);
    return () => ipcRenderer.removeListener('batch-parse-progress', handler);
  },
});
