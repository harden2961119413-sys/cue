const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('package uses bugfix bootstrap', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/bugfix-main.js');
  assert.match(pkg.scripts['prepare:whisper'], /prepare-whisper-runtime-fixed/);
  assert.ok(pkg.scripts['start:local']);
});

test('passthrough bootstrap wires Ctrl/Cmd+Shift+I and guards renderer mouse state', () => {
  const code = fs.readFileSync(path.join(root, 'src', 'bugfix-main.js'), 'utf8');
  assert.match(code, /CommandOrControl\+Shift\+I/);
  assert.match(code, /removeAllListeners\('mouse:ignore'\)/);
  assert.match(code, /forcedPassthrough \? true : !!value/);
});

test('packaged builds bundle whisper by default', () => {
  const code = fs.readFileSync(path.join(root, 'scripts', 'after-pack.js'), 'utf8');
  assert.ok(!/process\.env\.CUE_BUNDLE_WHISPER/.test(code));
  assert.match(code, /CUE_SKIP_WHISPER/);
  assert.match(code, /prepareWhisperRuntime/);
});

test('mac source checksum includes PR53 correction', () => {
  const manifest = require('../src/whisper-runtime-manifest');
  assert.equal(
    manifest.SOURCE_ARCHIVE_SHA256,
    '98a57a88ef0e733b746544f8ea25157d3265fbf0dac5c32dbb527e6ef4dbfaac'
  );
  const win = manifest.getRuntimeTarget('win32', 'x64');
  assert.equal(win.executable, 'whisper-server.exe');
  assert.equal(win.sha256, '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539');
});
