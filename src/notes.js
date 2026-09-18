// notes.js — 将面试转写整理成中文结构化复盘笔记。

function buildNotesPrompt(transcript) {
  const who = (t) => (t.channel === 'them' ? '面试官' : '候选人');
  const lines = transcript.map((t) => who(t) + '：' + t.text).join('\n');
  return (
    '面试转写：\n' +
    (lines || '（空）') +
    '\n\n请生成简洁的中文面试笔记，必须严格使用下面五个一级标题，标题单独占一行：\n' +
    '面试摘要：\n' +
    '关键问题：\n' +
    '技术知识点：\n' +
    '项目深挖：\n' +
    '待复习与跟进：\n' +
    '每条使用“- ”开头。摘要控制在 2~3 句；技术知识点优先记录 Agent / Java / Go / 后端八股、系统设计与手撕题。'
  );
}

const HEADERS = [
  ['summary', /^(?:面试摘要|meeting summary)\s*[：:]?\s*$/i],
  ['keyPoints', /^(?:关键问题|key points)\s*[：:]?\s*$/i],
  ['decisions', /^(?:技术知识点|decisions)\s*[：:]?\s*$/i],
  ['actionItems', /^(?:项目深挖|action items)\s*[：:]?\s*$/i],
  ['followUp', /^(?:待复习与跟进|follow[- ]up)\s*[：:]?\s*$/i]
];

function parseNotes(text) {
  const out = { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  if (!text || !text.trim()) return out;

  const lines = text.split(/\r?\n/);
  let cur = null;
  const buckets = { summary: [], keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  for (const raw of lines) {
    const line = raw.trim();
    const matched = HEADERS.find(([, re]) => re.test(line));
    if (matched) { cur = matched[0]; continue; }
    if (!cur) continue;
    if (!line) { cur = null; continue; }
    buckets[cur].push(line);
  }
  for (const [k, arr] of Object.entries(buckets)) {
    if (k === 'summary') { out.summary = arr.join(' ').trim(); continue; }
    out[k] = arr
      .map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\[[ x]\]\s*/, '').replace(/^[0-9]+[.)]\s*/, '').trim())
      .filter(Boolean);
  }

  const anything = Object.values(buckets).some((a) => a.length);
  if (!anything && text.trim()) out.summary = text.trim();
  return out;
}

module.exports = { buildNotesPrompt, parseNotes };
