const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResumeContext, parseResume } = require('../src/resume-context');
const { buildInterviewContext, detectCategory } = require('../src/interview-context');

test('buildResumeContext 输出中文结构化简历上下文', () => {
  const resume = '张三\n后端开发工程师\n\n技能\nJava, Go, Redis\n\n工作经历\n某公司 2023-2026';
  const result = buildResumeContext(resume, '', 'say');
  assert.ok(result !== null);
  assert.match(result, /候选人简历/);
  assert.match(result, /Java/);
});

test('中文简历分段可识别', () => {
  const resume = '张三\n\n个人简介\n三年后端经验，负责交易系统。\n\n技能\nJava, Go\n\n工作经历\n某公司 2023-2026\n\n项目经历\n订单平台';
  const parsed = parseResume(resume);
  assert.ok(parsed.parsed);
  assert.ok(parsed.sections.skills);
});

test('中文项目深挖识别', () => {
  assert.equal(detectCategory([{ channel: 'them', text: '讲讲你这个订单项目的架构，为什么用 Redis？' }]), 'project');
  assert.equal(detectCategory([{ channel: 'them', text: '这个项目 QPS 多少，遇到过什么线上故障？' }]), 'project');
});

test('中文八股识别', () => {
  assert.equal(detectCategory([{ channel: 'them', text: '说一下 JVM 的垃圾回收原理。' }]), 'technical');
  assert.equal(detectCategory([{ channel: 'them', text: 'Go 的 GMP 模型是什么？' }]), 'technical');
  assert.equal(detectCategory([{ channel: 'them', text: 'Agent 里 MCP 和 Function Calling 有什么区别？' }]), 'technical');
});

test('项目深挖优先注入项目知识文档', () => {
  const settings = {
    resumeText: '张三\n后端工程师\n项目：订单平台',
    projectKnowledge: '订单平台采用 MySQL + Redis。本人负责库存扣减链路；峰值数据以压测报告为准，未在本文写具体 QPS。',
    jobDescription: 'Java/Go 后端，Agent 工程方向',
    starStories: '',
    whyCompany: '',
    whyLeaving: '',
    workStyle: '',
    salaryTarget: '',
    questionsToAsk: ''
  };
  const ctx = buildInterviewContext(settings, 'say', [
    { channel: 'them', text: '深挖一下你的订单项目，为什么用 Redis？' }
  ]);
  assert.match(ctx, /项目知识文档/);
  assert.match(ctx, /库存扣减链路/);
  assert.match(ctx, /不得编造|不要擅自补/);
});

test('leetcode 历史模式不注入个人上下文', () => {
  const settings = { resumeText: '张三', projectKnowledge: '内部项目资料' };
  assert.equal(buildInterviewContext(settings, 'leetcode', []), null);
});
