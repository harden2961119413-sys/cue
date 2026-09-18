const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');

test('assist 默认要求中文、直接回答并支持多种屏幕题', () => {
  const text = MODES.assist.buildSystem(null) + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  assert.match(text, /简体中文/);
  assert.match(text, /项目知识文档/);
  assert.match(text, /AI Coding/);
  assert.match(text, /ACM/);
});

test('say 输出可直接口述的中文答案', () => {
  const text = MODES.say.buildSystem(null) + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /第一人称/);
  assert.match(text, /直接说出口/);
  assert.match(text, /八股/);
});

test('leetcode 历史模式键已升级为 ACM/屏幕技术题模式，并忽略个人上下文', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /ACM/);
  assert.match(system, /标准输入/);
  assert.match(system, /AI Coding/);
  assert.match(system, /Debug/);
  assert.ok(!system.includes('IGNORED_CONTEXT'));
  assert.match(system, /完整 main/);
  assert.match(system, /禁止 LeetCode/);
});

test('followup 输出中文反问', () => {
  const system = MODES.followup.buildSystem(null);
  assert.match(system, /反问/);
  assert.match(system, /技术挑战/);
});

test('所有模式都有 build / buildSystem', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

const RULES = '回答更短。\n优先使用项目符号。';

test('非屏幕技术题模式会注入用户回答规则', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /用户回答规则/);
    assert.ok(withRules.includes(RULES));
  }
});

test('屏幕技术题模式不应用自定义风格，保证 ACM/调试格式稳定', () => {
  const withRules = MODES.leetcode.buildSystem(null, RULES);
  assert.ok(!withRules.includes(RULES));
  assert.match(withRules, /ACM/);
});
