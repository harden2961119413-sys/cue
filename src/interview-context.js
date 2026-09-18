// interview-context.js
// 面向中文技术面试的上下文路由：识别题型，并只注入当前问题需要的资料。

const CATEGORY_PATTERNS = {
  project: [
    /项目.*(架构|难点|职责|技术选型|为什么|怎么做|怎么实现|性能|优化|故障|压测|qps|延迟|一致性|高可用|扩容|复盘)/i,
    /(介绍|讲讲|说说|展开|深挖).{0,12}(项目|系统|服务|平台)/i,
    /(你|您).{0,8}(项目|简历).{0,20}(怎么|为什么|如何|负责|做了什么)/i,
    /tell me more about (the|your) project/i,
    /walk me through (the|your) project/i,
    /why did you (choose|use)/i,
  ],
  behavioral: [
    /讲一个.*(经历|例子|故事)/i, /有没有.*(经历|例子)/i, /遇到过.*(冲突|失败|压力|困难|挑战)/i,
    /你是怎么.*(处理|推动|协调|解决)/i, /最大的(挑战|失败|成就|收获)/i,
    /tell me about a time/i, /give me an example/i, /describe a situation/i,
    /how did you handle/i, /have you ever/i, /under pressure/i, /tight deadline/i,
  ],
  motivation: [
    /为什么(想来|选择|投|考虑).*(公司|岗位|我们)/i, /为什么离职/i, /职业规划/i,
    /为什么要招你/i, /你的优势/i, /你的缺点/i, /五年.*规划/i,
    /why (do you want|are you interested|this company|this role|us|here)/i,
    /why should we hire/i, /career goals/i,
  ],
  situational: [
    /如果.*你会怎么/i, /假设.*怎么/i, /线上.*(故障|事故|宕机).*怎么/i,
    /怎么做技术选型/i, /怎么排查/i, /如何权衡/i, /如何推进/i,
    /what would you do if/i, /how would you (handle|approach|deal with)/i,
    /production (outage|incident|down)/i,
  ],
  experience: [
    /自我介绍/i, /介绍一下自己/i, /讲讲你的经历/i, /最近一段工作/i, /主要负责什么/i,
    /技术栈/i, /日常工作/i, /简历/i,
    /tell me about yourself/i, /walk me through your (resume|background|experience|role|career)/i,
    /what (were you responsible|did you do|was your role)/i,
  ],
  compensation: [
    /薪资/i, /期望薪资/i, /多久(能|可以)入职/i, /到岗/i, /offer/i, /还有什么问题/i, /反问/i,
    /salary/i, /compensation/i, /notice period/i, /start date/i, /questions for (us|me)/i,
  ],
  technical: [
    /什么是/i, /说一下/i, /讲一下/i, /原理/i, /底层/i, /区别/i, /对比/i, /优缺点/i,
    /jvm/i, /gc/i, /jmm/i, /hashmap/i, /线程池/i, /spring/i, /事务/i,
    /mysql/i, /redis/i, /mq/i, /kafka/i, /rocketmq/i, /rpc/i, /微服务/i, /分布式/i,
    /goroutine/i, /channel/i, /\bgmp\b/i, /context/i, /逃逸分析/i, /pprof/i,
    /\brag\b/i, /react/i, /function calling/i, /tool calling/i, /\bmcp\b/i, /\ba2a\b/i,
    /agent/i, /workflow/i, /memory/i, /embedding/i, /rerank/i, /langgraph/i, /harness/i,
    /system design/i, /design (a|an|the)/i, /difference between/i, /how does .* work/i,
    /algorithm/i, /complexity/i, /data structure/i, /architecture/i, /trade.?off/i,
  ],
};

function detectCategory(transcript) {
  if (!transcript || !transcript.length) return 'general';
  const recentThem = transcript
    .filter(t => t.channel === 'them')
    .slice(-5)
    .map(t => t.text)
    .join(' ');
  if (!recentThem) return 'general';

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some(re => re.test(recentThem))) return category;
  }
  return 'general';
}

const SECTION_PATTERNS = [
  { key: 'name',       re: null, label: null },
  { key: 'summary',    re: /(?:summary|objective|profile|about|个人总结|个人简介|简介)[^\n]*\n([\s\S]{20,500}?)(?=\n[A-Z\u4e00-\u9fa5]|\n\n[A-Z\u4e00-\u9fa5]|$)/i, label: '个人简介' },
  { key: 'experience', re: /(?:experience|work history|employment|工作经历|实习经历)[^\n]*\n([\s\S]{20,2200}?)(?=\n(?:education|skills|projects|certif|awards|教育|技能|项目|证书|荣誉|$))/i, label: '工作经历' },
  { key: 'skills',     re: /(?:skills?|technical skills?|competencies|tech stack|技能|专业技能|技术栈)[^\n]*\n([\s\S]{10,800}?)(?=\n(?:experience|education|projects|certif|awards|work|工作|教育|项目|证书|$))/i, label: '技能' },
  { key: 'education',  re: /(?:education|academic|教育经历|教育背景)[^\n]*\n([\s\S]{10,500}?)(?=\n(?:experience|skills|projects|certif|awards|work|工作|技能|项目|证书|$))/i, label: '教育经历' },
  { key: 'projects',   re: /(?:projects?|portfolio|项目经历|项目)[^\n]*\n([\s\S]{10,1400}?)(?=\n(?:experience|education|skills|certif|awards|work|工作|教育|技能|证书|$))/i, label: '项目经历' },
];

function parseResume(text) {
  if (!text || !text.trim()) return null;
  const clean = text.trim();
  const sections = {};
  const firstLine = clean.split('\n').find(l => l.trim().length > 1 && l.trim().length < 80);
  if (firstLine) sections.name = firstLine.trim();
  for (const { key, re } of SECTION_PATTERNS) {
    if (!re) continue;
    const m = re.exec(clean);
    if (m && m[1]) sections[key] = m[1].trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  }
  return { sections, raw: clean, parsed: Object.keys(sections).length > 1 };
}

function clip(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd() + '…';
}

function buildResumeBlock(resumeText, limit = 2600) {
  if (!resumeText || !resumeText.trim()) return '';
  const parsed = parseResume(resumeText);
  if (!parsed) return '';
  if (parsed.parsed) {
    const parts = [];
    let rem = limit;
    const order = ['name', 'summary', 'experience', 'skills', 'projects', 'education'];
    for (const key of order) {
      if (rem <= 0) break;
      const val = parsed.sections[key];
      if (!val) continue;
      const sp = SECTION_PATTERNS.find(s => s.key === key);
      const label = sp && sp.label;
      const chunk = label ? `${label}：\n${clip(val, Math.min(Math.max(rem - label.length - 2, 0), 1000))}` : clip(val, 80);
      if (chunk) {
        parts.push(chunk);
        rem -= chunk.length;
      }
    }
    return parts.join('\n\n');
  }
  return clip(parsed.raw, limit);
}

function buildJDBlock(jd, limit = 800) {
  if (!jd || !jd.trim()) return '';
  return '=== 目标岗位 / JD ===\n' + clip(jd.trim().replace(/\s+/g, ' '), limit);
}

function buildInterviewContext(settings, mode, transcript) {
  if (mode === 'leetcode') return null;

  const category = detectCategory(transcript || []);
  const resume    = settings.resumeText || '';
  const project   = settings.projectKnowledge || '';
  const jd        = settings.jobDescription || '';
  const stories   = settings.starStories || '';
  const whyCo     = settings.whyCompany || '';
  const whyLeave  = settings.whyLeaving || '';
  const workStyle = settings.workStyle || '';
  const salary    = settings.salaryTarget || '';
  const questions = settings.questionsToAsk || '';

  const hasResume = resume.trim().length > 0;
  const hasProject = project.trim().length > 0;
  const hasStories = stories.trim().length > 0;
  const hasJD = jd.trim().length > 0;
  const blocks = [];

  // 项目深挖时项目知识文档拥有最高事实优先级。
  if (category === 'project' && hasProject) {
    blocks.push(
      '=== 项目知识文档（项目深挖最高优先级事实源） ===\n' +
      clip(project.trim(), 5000) +
      '\n\n规则：只能把这里明确写出的内容当作候选人的真实项目事实。不要擅自补数字、组件、职责或故障。'
    );
  }

  if (hasResume) {
    const resumeLimit = ['behavioral', 'experience', 'project'].includes(category) ? 2800 : 1600;
    const rb = buildResumeBlock(resume, resumeLimit);
    if (rb) blocks.push('=== 候选人简历 ===\n' + rb);
  }

  // 非项目类问题也允许带一小段项目知识，方便八股追问落到真实项目。
  if (category !== 'project' && hasProject && ['technical', 'situational', 'general'].includes(category)) {
    blocks.push('=== 可用于技术追问的项目事实摘要 ===\n' + clip(project.trim(), category === 'technical' ? 1800 : 1200));
  }

  if (hasJD) blocks.push(buildJDBlock(jd, category === 'technical' ? 500 : 800));

  switch (category) {
    case 'project':
      if (!hasProject) {
        blocks.push(
          '（未提供独立项目知识文档。项目深挖时只能依据简历和已有 STAR 信息回答；缺失的项目事实不得编造。）'
        );
      }
      if (hasStories) blocks.push('=== 与项目相关的 STAR/亮点 ===\n' + clip(stories.trim(), 1000));
      break;

    case 'behavioral':
      if (hasStories) {
        blocks.push(
          '=== STAR 故事 ===\n' + clip(stories.trim(), 2200) +
          '\n回答行为题时优先复用真实故事：背景 -> 任务 -> 我的行动 -> 结果/复盘。'
        );
      } else {
        blocks.push('（未提供 STAR 故事。只能基于简历/项目事实组织回答，不要虚构经历。）');
      }
      if (workStyle) blocks.push('=== 工作方式 / 价值观 ===\n' + clip(workStyle, 500));
      break;

    case 'motivation':
      if (whyCo) blocks.push('=== 为什么这家公司 / 岗位 ===\n' + clip(whyCo, 600));
      if (whyLeave) blocks.push('=== 离职原因 ===\n' + clip(whyLeave, 400));
      if (workStyle) blocks.push('=== 工作偏好 ===\n' + clip(workStyle, 400));
      break;

    case 'situational':
      if (workStyle) blocks.push('=== 决策与协作风格 ===\n' + clip(workStyle, 600));
      if (hasStories) blocks.push('=== 可参考的历史经历 ===\n' + clip(stories, 900));
      break;

    case 'compensation':
      if (salary) blocks.push('=== 薪资期望 ===\n' + salary);
      if (questions) blocks.push('=== 准备好的反问 ===\n' + clip(questions, 800));
      break;

    case 'technical':
      blocks.push(
        '=== 技术面试回答要求 ===\n' +
        '优先用中文按“结论 -> 原理 -> 关键细节/边界 -> 场景与取舍 -> 如有材料则结合真实项目”回答。' +
        'Agent/Java/Go/后端问题如果存在多种实现，要说明为什么选某一种。'
      );
      break;

    default:
      if (hasStories) blocks.push('=== 关键经历亮点 ===\n' + clip(stories, 700));
      if (workStyle) blocks.push('=== 工作方式 ===\n' + clip(workStyle, 350));
      break;
  }

  if (!blocks.length) return null;

  const tailorNote = hasJD
    ? '\n\n所有回答都应优先突出与目标岗位最相关的能力，但不得为了匹配 JD 而虚构经历。'
    : '';

  return blocks.join('\n\n') + tailorNote;
}

function buildResumeContext(resumeText, jobDescription, mode) {
  if (!resumeText || !String(resumeText).trim()) return null;
  if (typeof jobDescription === 'number') {
    const cleaned = String(resumeText).trim().replace(/\s+/g, ' ');
    const limit = jobDescription || 1200;
    const clipped = cleaned.length > limit ? cleaned.slice(0, limit).trimEnd() + '…' : cleaned;
    return ['候选人简历参考：', clipped, '回答候选人背景相关问题时，以这份简历为事实依据。'].join('\n');
  }
  const rb = buildResumeBlock(resumeText, 2000);
  const jb = buildJDBlock(jobDescription || '', 700);
  const parts = [];
  if (rb) parts.push('=== 候选人简历 ===\n' + rb);
  if (jb) parts.push(jb);
  return parts.length ? parts.join('\n\n') : null;
}

module.exports = { buildInterviewContext, buildResumeContext, detectCategory, parseResume };
