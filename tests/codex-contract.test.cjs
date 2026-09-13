'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
function between(start, end) {
  const begin = main.indexOf(start);
  const stop = main.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && stop > begin, 'Expected current production functions');
  return main.slice(begin, stop);
}
const cookieFunctions =
  between('function migrateLegacyCookieFiles()', 'function getPlatformCookieFile(') +
  between('function getPlatformCookieFile(', 'function execYtdlp(');

test('NoCredentials bypasses migration and credential lookup before filesystem access', () => {
  const sandbox = {
    CODEX_NO_CREDENTIALS:true,
    existsSync:() => { throw new Error('Unexpected filesystem lookup'); },
    readCookieLines:() => { throw new Error('Unexpected credential read'); },
    writePlatformCookieFile:() => { throw new Error('Unexpected credential write'); }
  };
  vm.runInNewContext(cookieFunctions + '\nmigrateLegacyCookieFiles(); result = getPlatformCookieFile("youtube");', sandbox);
  assert.equal(sandbox.result, '');
});

test('default CLI still considers the existing read-only credential fallback', () => {
  const lookedUp = [];
  const sandbox = {
    CODEX_NO_CREDENTIALS:false, CODEX_CLI_MODE:true,
    BILIBILI_COOKIES_FILE:'isolated-bili', YOUTUBE_COOKIES_FILE:'isolated-youtube', XHS_COOKIES_FILE:'isolated-xhs',
    READONLY_BILIBILI_COOKIES_FILE:'existing-bili', READONLY_YOUTUBE_COOKIES_FILE:'existing-youtube', READONLY_XHS_COOKIES_FILE:'existing-xhs',
    existsSync:file => { lookedUp.push(file); return false; },
    readCookieLines:() => { throw new Error('Missing files must not be read'); }
  };
  vm.runInNewContext(cookieFunctions + '\nresult = getPlatformCookieFile("youtube");', sandbox);
  assert.equal(sandbox.result, '');
  assert.deepEqual(lookedUp, ['isolated-youtube', 'existing-youtube']);
});

test('source release preserves installed app identity and the CLI version contract', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/codex-release.json')));
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'codex-interface.json')));
  assert.equal(config.package.name, 'shipin-xiazai-shenqi');
  assert.equal(config.package.version, contract.version);
  assert.equal(contract.entryPoint, 'codex-download.ps1');
});

test('restored wrapper accepts the current executable and legacy filename', () => {
  const wrapper = fs.readFileSync(path.join(root, 'codex-download.ps1'), 'utf8');
  assert.ok(wrapper.indexOf("'视频下载神器.exe'") < wrapper.indexOf("'YouTube 下载器.exe'"));
  assert.match(wrapper, /\[switch\]\$NoCredentials/);
  assert.match(wrapper, /if \(\$NoCredentials\).*--no-credentials/);
  assert.match(wrapper, /\.CreateNoWindow = \$true/);
});
