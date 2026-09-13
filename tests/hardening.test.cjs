'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function between(start, end) {
  const begin = main.indexOf(start);
  const stop = main.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && stop > begin, `Expected source section: ${start}`);
  return main.slice(begin, stop);
}

test('diagnostic buffers stay bounded during long downloads', () => {
  const source = between('const MAX_YTDLP_DIAGNOSTIC_CHARS', '// yt-dlp download');
  const sandbox = {};
  vm.runInNewContext(source + '\nresult = appendBoundedText("a".repeat(20), "b".repeat(20), 24);', sandbox);
  assert.equal(sandbox.result.length, 24);
  assert.equal(sandbox.result, 'a'.repeat(4) + 'b'.repeat(20));
});

test('logs redact URL credentials, query values and Windows user names', () => {
  const source = between('function sanitizeLogMessage', 'function translateError');
  const sandbox = {};
  vm.runInNewContext(
    source + '\nresult = sanitizeLogMessage("https://user:secret@example.com/v?id=123&token=abc C:\\\\Users\\\\12345\\\\file.txt");',
    sandbox,
  );
  assert.doesNotMatch(sandbox.result, /secret|123|abc|12345/);
  assert.match(sandbox.result, /<credentials>|<redacted>|%USERPROFILE%/);
});

test('JSON storage recovers from backup and preserves the previous valid value', () => {
  const source = between('function loadJSON', 'function sanitizeSettings');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nicevideodown-storage-'));
  const file = path.join(directory, 'settings.json');
  const sandbox = {
    fs,
    path,
    process,
    mkdirSync: fs.mkdirSync,
    existsSync: fs.existsSync,
    debugLog: () => {},
  };
  try {
    fs.writeFileSync(file, '{broken', 'utf8');
    fs.writeFileSync(file + '.bak', '{"recovered":true}', 'utf8');
    vm.runInNewContext(source + '\nrecovered = loadJSON(file, {}); saved = saveJSON(file, {version:1}); savedAgain = saveJSON(file, {version:2});', {
      ...sandbox,
      file,
    });
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    const backup = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    assert.deepEqual(current, { version: 2 });
    assert.deepEqual(backup, { version: 1 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex wrapper uses a disposable per-run session and removes it', () => {
  const wrapper = fs.readFileSync(path.join(root, 'codex-download.ps1'), 'utf8');
  assert.match(wrapper, /SpecialFolder\]::LocalApplicationData/);
  assert.match(wrapper, /Environment\['CODEX_RUNTIME_DIR'\] = \$runtime/);
  assert.match(wrapper, /Join-Path \$runtime 'sessions'/);
  assert.match(wrapper, /Environment\['CODEX_RUNTIME_SESSION'\] = \$sessionDir/);
  assert.match(wrapper, /Remove-Item -LiteralPath \$sessionDir -Recurse -Force/);
  assert.doesNotMatch(wrapper, /\$tempDir = Join-Path \$runtime 'temp'/);
  assert.doesNotMatch(wrapper, /\$runtime = Join-Path \$root 'codex-runtime'/);
  assert.doesNotMatch(main, /path\.join\(CODEX_APP_DIR, 'codex-downloads'\)/);
});

test('release versions agree and the release allowlist excludes private runtime data', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/codex-release.json'), 'utf8'));
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'codex-interface.json'), 'utf8'));
  assert.equal(pkg.version, '2.2.1');
  assert.equal(config.package.version, pkg.version);
  assert.equal(contract.version, pkg.version);
  const released = config.files.join('\n').toLowerCase();
  assert.doesNotMatch(released, /cookie|credential|history|settings|\.log|user-data|session-data/);
  assert.match(main, /message: `视频下载神器　版本 \$\{app\.getVersion\(\)\}`/);
});
