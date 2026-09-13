#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(name + ' requires a value');
  return argv[index + 1];
}
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function sourcePath(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid release path: ' + relative);
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Release input escapes source root');
  if (!fs.lstatSync(resolved).isFile()) throw new Error('Release input must be a regular file: ' + relative);
  return resolved;
}
function modulePackageVersion(specifier) {
  let current = path.dirname(require.resolve(specifier));
  while (true) {
    const packageFile = path.join(current, 'package.json');
    if (fs.existsSync(packageFile)) {
      const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (metadata.name === '@electron/asar' && metadata.version) return metadata.version;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Unable to read @electron/asar package version');
}
async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/codex-release.json'), 'utf8'));
  if (config.schemaVersion !== 1) throw new Error('Unsupported release manifest schema');
  const modulePath = option('--asar-module', '@electron/asar');
  const asar = require(modulePath);
  const version = modulePackageVersion(modulePath);
  if (version !== config.asarVersion) throw new Error('Expected @electron/asar ' + config.asarVersion + ', got ' + version);
  const output = path.resolve(option('--output', path.join(root, 'dist', 'codex-release')));
  if (output === root || root.startsWith(output + path.sep)) throw new Error('Output cannot contain source root');
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Output directory must be empty: ' + output);
  const relativeFiles = [...config.files].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (new Set(relativeFiles).size !== relativeFiles.length) throw new Error('Duplicate release input');
  const inputs = relativeFiles.map(relative => ({relative, source:sourcePath(relative)}));
  for (const relative of config.externalFiles) {
    if (!relativeFiles.includes(relative)) throw new Error('External entry is not an archive input: ' + relative);
  }
  const contract = JSON.parse(fs.readFileSync(sourcePath('codex-interface.json'), 'utf8'));
  if (contract.version !== config.package.version || contract.entryPoint !== 'codex-download.ps1') {
    throw new Error('Runtime package version/entry differs from Codex contract');
  }
  const mainText = fs.readFileSync(sourcePath(config.package.main), 'utf8');
  for (const marker of ['const CODEX_CLI_MODE =', 'async function runCodexCli()', 'async function runCodexSelfTest()']) {
    if (!mainText.includes(marker)) throw new Error('Codex main-process integration missing: ' + marker);
  }
  fs.mkdirSync(output, {recursive:true});
  const payload = path.join(output, 'payload');
  fs.mkdirSync(payload);
  const manifest = {
    schemaVersion:1,
    packageName:config.package.name,
    packageVersion:config.package.version,
    builder:{name:'@electron/asar', version},
    inputs:[]
  };
  for (const {relative, source} of inputs) {
    const destination = path.join(payload, relative);
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.copyFileSync(source, destination);
    manifest.inputs.push({path:relative, sha256:sha256(fs.readFileSync(source))});
  }
  const packageBytes = Buffer.from(JSON.stringify(config.package, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(payload, 'package.json'), packageBytes);
  manifest.inputs.push({path:'package.json', sha256:sha256(packageBytes)});
  manifest.inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const resources = path.join(output, 'resources');
  fs.mkdirSync(resources);
  const archive = path.join(resources, 'app.asar');
  await asar.createPackage(payload, archive);
  for (const input of manifest.inputs) {
    const actual = asar.extractFile(archive, path.normalize(input.path));
    if (sha256(actual) !== input.sha256) throw new Error('Archive verification failed: ' + input.path);
  }
  const archivedFiles = asar.listPackage(archive).filter(name => !asar.statFile(archive, name.replace(/^[\\/]+/, '')).files)
    .map(name => name.replace(/^[\\/]+/, '').replace(/\\/g, '/')).sort();
  const expectedFiles = manifest.inputs.map(item => item.path).sort();
  if (JSON.stringify(archivedFiles) !== JSON.stringify(expectedFiles)) throw new Error('Unexpected file in archive');
  for (const relative of config.externalFiles) fs.copyFileSync(sourcePath(relative), path.join(output, relative));
  manifest.archive = {path:'resources/app.asar', bytes:fs.statSync(archive).size, sha256:sha256(fs.readFileSync(archive))};
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ok:true, output, archive:manifest.archive, files:manifest.inputs.length}) + '\n');
}
main().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
