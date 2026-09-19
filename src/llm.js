// LLM factory — OpenAI, Anthropic, Gemini and OpenAI-compatible providers.
// 2026-09 output-length fix:
// - normal Fast: 2048
// - normal Smart: 4096
// - screenshot answers: at least 4096
// - dedicated screen technical / coding mode: 6144
// Explicit params.maxTokens always wins.

const { createCompatibleClientOptions } = require('./openai-compatible');

const CUSTOM_PROVIDER = 'custom';
const CURRENT_GEMINI_DEFAULT = 'gemini-2.5-flash';
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  azure: 'gpt-4o-mini'
};

const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0)(?:-|$)/i;
const PROVIDER_LABELS = {
  azure: 'Azure AI Foundry',
  openai: 'OpenAI',
  minimax: 'MiniMax'
};
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

const FAST_MAX_TOKENS = 2048;
const SMART_MAX_TOKENS = 4096;
const SCREEN_MAX_TOKENS = 4096;
const TECH_SCREEN_MAX_TOKENS = 6144;
const ABSOLUTE_MAX_TOKENS = 16384;

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function isQuotaError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 429 || code === 429 || code === 'insufficient_quota' ||
    code === 'rate_limit_exceeded' || code === 'RESOURCE_EXHAUSTED' ||
    /quota|billing|rate limit|exceeded your current quota|resource_exhausted|too many requests/i.test(text);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 ||
    /\b404\b|is not found for api version|model not found/i.test(text);
}

function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function formatProviderErrorMessage(error, provider, model) {
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds
      ? ` Wait about ${formatRetryWait(retrySeconds)}`
      : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or switch providers/models in Settings.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404). Pick a current model in Settings or clear the field to use cue's default.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || [])
    .filter((turn) => valid.has(turn.role))
    .map((turn) => ({ role: turn.role, text: String(turn.text || '') }));
}

function stripDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return match ? { mime: match[1], b64: match[2] } : null;
}

function clampTokenBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(256, Math.min(ABSOLUTE_MAX_TOKENS, Math.floor(n)));
}

function isDedicatedTechnicalScreenPrompt(system) {
  const text = String(system || '');
  return /资深中文技术面试现场题助手|屏幕技术题模式|可直接提交的 ACM 完整代码|禁止 LeetCode|标准输入输出与 main/i.test(text);
}

function resolveMaxTokens(settings, params = {}) {
  const explicit = clampTokenBudget(params.maxTokens);
  if (explicit) return explicit;

  if (isDedicatedTechnicalScreenPrompt(params.system)) {
    return TECH_SCREEN_MAX_TOKENS;
  }

  if (params.imageDataUrl) {
    return SCREEN_MAX_TOKENS;
  }

  const system = String(params.system || '');
  if (/项目深挖|项目知识文档|系统设计/i.test(system)) {
    return Math.max(3072, settings && settings.smart ? SMART_MAX_TOKENS : FAST_MAX_TOKENS);
  }

  return settings && settings.smart ? SMART_MAX_TOKENS : FAST_MAX_TOKENS;
}

function appendTruncationNotice(onToken) {
  if (typeof onToken !== 'function') return;
  onToken('\n\n⚠️ 输出达到模型长度上限。可以再次触发“解决屏幕上的技术题”，或要求“从刚才中断处继续”。');
}

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  const messages = [{ role: 'system', content: system }];

  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    if (last && imageDataUrl && turn.role === 'user') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: turn.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: turn.role, content: turn.text });
    }
  });

const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,

    // Qwen 极速面试模式
    // 只对阿里云 Qwen 生效
    ...(String(model).toLowerCase().startsWith('qwen')
        ? {
            reasoning_effort: 'none'
        }
        : {})
});

  let full = '';
  let finishReason = null;
  for await (const part of stream) {
    const choice = part.choices && part.choices[0];
    const delta = choice && choice.delta && choice.delta.content;
    if (delta) {
      full += delta;
      onToken(delta);
    }
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (finishReason === 'length') appendTruncationNotice(onToken);
  return full;
}

function normalizeAzureBaseURL(raw) {
  let url = String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
  if (!url) return '';
  if (/cognitiveservices\.azure\.com/i.test(url) && !/\/openai\/v1$/i.test(url)) {
    url += '/openai/v1';
  }
  return url;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, endpoint }) {
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) {
    throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  }

  const messages = [{ role: 'system', content: system }];
  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    if (last && imageDataUrl && turn.role === 'user') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: turn.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: turn.role, content: turn.text });
    }
  });

  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({
      endpoint: url.replace(/\/openai$/i, ''),
      apiKey,
      apiVersion: '2024-10-21'
    });
  } else {
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }

  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    max_completion_tokens: maxTokens
  });

  let full = '';
  let finishReason = null;
  for await (const part of stream) {
    const choice = part.choices && part.choices[0];
    const delta = choice && choice.delta && choice.delta.content;
    if (delta) {
      full += delta;
      onToken(delta);
    }
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (finishReason === 'length') appendTruncationNotice(onToken);
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const messages = turns.map((turn, index) => {
    const last = index === turns.length - 1;
    if (last && imageDataUrl && turn.role === 'user') {
      const image = stripDataUrl(imageDataUrl);
      const content = [];
      if (image) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mime,
            data: image.b64
          }
        });
      }
      content.push({ type: 'text', text: turn.text });
      return { role: 'user', content };
    }
    return { role: turn.role, content: turn.text };
  });

  const stream = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages,
    stream: true
  });

  let full = '';
  let stopReason = null;
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta &&
      event.delta.type === 'text_delta'
    ) {
      full += event.delta.text;
      onToken(event.delta.text);
    }
    if (event.type === 'message_delta' && event.delta && event.delta.stop_reason) {
      stopReason = event.delta.stop_reason;
    }
  }
  if (stopReason === 'max_tokens') appendTruncationNotice(onToken);
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const contents = turns.map((turn, index) => {
    const last = index === turns.length - 1;
    const parts = [{ text: turn.text }];
    if (last && imageDataUrl && turn.role === 'user') {
      const image = stripDataUrl(imageDataUrl);
      if (image) {
        parts.push({ inlineData: { mimeType: image.mime, data: image.b64 } });
      }
    }
    return {
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });

  const stream = await ai.models.generateContentStream({
    model,
    contents,
    config: {
      systemInstruction: system,
      maxOutputTokens: maxTokens
    }
  });

  let full = '';
  let finishReason = null;
  for await (const chunk of stream) {
    const text = chunk && chunk.text;
    if (text) {
      full += text;
      onToken(text);
    }
    const candidate = chunk && chunk.candidates && chunk.candidates[0];
    if (candidate && candidate.finishReason) finishReason = candidate.finishReason;
  }
  if (String(finishReason || '').toUpperCase() === 'MAX_TOKENS') {
    appendTruncationNotice(onToken);
  }
  return full;
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const messages = [{ role: 'system', content: system }];

  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    if (last && imageDataUrl && turn.role === 'user') {
      const image = stripDataUrl(imageDataUrl);
      messages.push(
        image
          ? { role: 'user', content: turn.text, images: [image.b64] }
          : { role: 'user', content: turn.text }
      );
    } else {
      messages.push({ role: turn.role, content: turn.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_predict: maxTokens }
      })
    });
  } catch (error) {
    throw new Error(`Ollama fetch failed: ${error.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          full += data.message.content;
          onToken(data.message.content);
        }
      } catch (_) {}
    }
  }

  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.message && data.message.content) {
        full += data.message.content;
        onToken(data.message.content);
      }
    } catch (_) {}
  }
  return full;
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  let apiKey = keys[provider];
  let baseURL = '';
  let configurationError = '';
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];

  if (provider === 'gemini' && DEAD_GEMINI_MODEL_RE.test(model || '')) {
    model = CURRENT_GEMINI_DEFAULT;
  }
  if (!model) model = DEFAULT_MODELS[provider] || '';

  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';

  if (provider === CUSTOM_PROVIDER) {
    try {
      const clientOptions = createCompatibleClientOptions(apiKey, settings.baseUrl);
      apiKey = clientOptions.apiKey;
      baseURL = clientOptions.baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!model && !configurationError) {
      configurationError = 'Set a Fast or Smart model for the Custom provider.';
    }
  } else if (provider !== 'ollama' && !apiKey) {
    configurationError = `Add your ${provider} API key in Settings.`;
  }

  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  const ready = !configurationError && !!model;

  return {
    provider,
    model,
    apiKey,
    baseURL,
    ready,
    configurationError,

    async stream(params = {}) {
      if (!ready) {
        throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      }

      const maxTokens = resolveMaxTokens(settings, params);
      const args = {
        apiKey,
        baseURL,
        endpoint,
        model,
        ...params,
        maxTokens,
        turns: sanitizeTurns(params.turns),
        onToken: typeof params.onToken === 'function' ? params.onToken : () => {}
      };

      try {
        if (provider === 'openai') return await streamOpenAI(args);
        if (provider === CUSTOM_PROVIDER) return await streamOpenAI(args);
        if (provider === 'ollama') return await streamOllama(args);
        if (provider === 'groq') {
          return await streamOpenAI({ ...args, baseURL: 'https://api.groq.com/openai/v1' });
        }
        if (provider === 'minimax') {
          return await streamOpenAI({
            ...args,
            baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en
          });
        }
        if (provider === 'anthropic') return await streamAnthropic(args);
        if (provider === 'gemini') return await streamGemini(args);
        if (provider === 'azure') return await streamAzure(args);
        throw new Error('unknown provider: ' + provider);
      } catch (error) {
        throw new Error(formatProviderErrorMessage(error, provider, model));
      }
    }
  };
}

module.exports = {
  createLLM,
  formatProviderErrorMessage,
  isQuotaError,
  CURRENT_GEMINI_DEFAULT,
  resolveMaxTokens,
  FAST_MAX_TOKENS,
  SMART_MAX_TOKENS,
  SCREEN_MAX_TOKENS,
  TECH_SCREEN_MAX_TOKENS
};
