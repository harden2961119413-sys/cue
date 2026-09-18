// resume-context.js — 兼容旧调用的薄封装。
const { buildResumeContext, parseResume } = require('./interview-context');

function buildResumeContextLegacy(resumeText, limit = 1200) {
  return buildResumeContext(resumeText, limit);
}

module.exports = { buildResumeContext, parseResume, buildResumeContextLegacy };
