const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('LLM budgets are expanded', () => {
  const code = read('src/llm.js');
  assert.match(code, /FAST_MAX_TOKENS = 2048/);
  assert.match(code, /SMART_MAX_TOKENS = 4096/);
  assert.match(code, /SCREEN_MAX_TOKENS = 4096/);
  assert.match(code, /TECH_SCREEN_MAX_TOKENS = 6144/);
  assert.match(code, /params\.imageDataUrl/);
});

test('dedicated screen prompt has 6144 future-compatible budget', () => {
  const code = read('src/prompts.js');
  const block = code.slice(code.indexOf('leetcode:'));
  assert.match(block, /maxTokens:\s*6144/);
  assert.match(block, /ACM/);
  assert.match(block, /完整 main/);
});

test('truncation is surfaced instead of looking like a silent UI stop', () => {
  const code = read('src/llm.js');
  assert.match(code, /finishReason === 'length'/);
  assert.match(code, /stopReason === 'max_tokens'/);
  assert.match(code, /MAX_TOKENS/);
  assert.match(code, /输出达到模型长度上限/);
});

test('bootstrap injects user-friendly streaming auto-scroll', () => {
  const code = read('src/bugfix-main.js');
  assert.match(code, /MutationObserver/);
  assert.match(code, /cueAutoScrollFix/);
  assert.match(code, /BOTTOM_THRESHOLD = 72/);
  assert.match(code, /userPinned/);
  assert.match(code, /scrollTop = messages\.scrollHeight/);
});

test('previous passthrough fix remains present', () => {
  const code = read('src/bugfix-main.js');
  assert.match(code, /CommandOrControl\+Shift\+I/);
  assert.match(code, /removeAllListeners\('mouse:ignore'\)/);
});
