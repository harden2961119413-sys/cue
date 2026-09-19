const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('provider fallback budgets remain available', () => {
  const code = read('src/llm.js');
  assert.match(code, /FAST_MAX_TOKENS = 2048/);
  assert.match(code, /SMART_MAX_TOKENS = 4096/);
  assert.match(code, /SCREEN_MAX_TOKENS = 4096/);
  assert.match(code, /TECH_SCREEN_MAX_TOKENS = 6144/);
});

test('realtime prompt modes use compact per-mode budgets', () => {
  const code = read('src/prompts.js');
  assert.match(code, /assist:[\s\S]*?maxTokens:\s*900/);
  assert.match(code, /say:[\s\S]*?maxTokens:\s*360/);
  assert.match(code, /answerThis:[\s\S]*?maxTokens:\s*420/);
  assert.match(code, /leetcode:[\s\S]*?maxTokens:\s*2200/);
  assert.match(code, /2~4 句/);
  assert.match(code, /口语化/);
});

test('bootstrap hard-limits fast reply modes before main.js loads', () => {
  const code = read('src/bugfix-main.js');
  assert.match(code, /inferFastReplyBudget/);
  assert.match(code, /实时辅助的中文面试 Copilot/);
  assert.match(code, /return 900/);
  assert.match(code, /return 360/);
  assert.match(code, /return 420/);
  assert.match(code, /return 2200/);

  const patchAt = code.indexOf('llmModule.createLLM =');
  const mainAt = code.indexOf("require('../main.js')");
  assert.ok(patchAt >= 0 && mainAt > patchAt, 'LLM factory must be patched before main.js loads');
});

test('screenshot capture is resized and JPEG-compressed for latency', () => {
  const code = read('src/screen.js');
  assert.match(code, /MAX_CAPTURE_WIDTH = 1600/);
  assert.match(code, /MAX_CAPTURE_HEIGHT = 1000/);
  assert.match(code, /JPEG_QUALITY = 80/);
  assert.match(code, /toJPEG/);
  assert.match(code, /data:image\/jpeg;base64/);
});

test('truncation is surfaced instead of looking like a silent UI stop', () => {
  const code = read('src/llm.js');
  assert.match(code, /finishReason === 'length'/);
  assert.match(code, /stopReason === 'max_tokens'/);
  assert.match(code, /MAX_TOKENS/);
  assert.match(code, /输出达到模型长度上限/);
});

test('previous passthrough fix remains present', () => {
  const code = read('src/bugfix-main.js');
  assert.match(code, /CommandOrControl\+Shift\+I/);
  assert.match(code, /removeAllListeners\('mouse:ignore'\)/);
  assert.match(code, /forcedPassthrough \? true : !!value/);
});
