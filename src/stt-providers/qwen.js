// src/stt-providers/qwen.js
// Alibaba Cloud Model Studio / Qwen real-time ASR provider.
//
// Protocol:
//   WebSocket -> run-task -> task-started -> binary PCM -> result-generated
//   -> finish-task -> task-finished
//
// Audio expected by Cue:
//   16 kHz / 16-bit signed little-endian / mono PCM.
//
// This provider deliberately reuses Cue's existing Custom Alibaba credentials:
//   settings.apiKeys.custom
//   settings.baseUrl
//
// If baseUrl is an Alibaba Model Studio HTTP endpoint, its host is converted
// automatically to the matching WebSocket inference endpoint.

const crypto = require('crypto');

const DEFAULT_QWEN_ASR_MODEL = 'qwen-audio-3.0-asr-flash-streaming';
const DEFAULT_CN_WS = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const DEFAULT_INTL_WS = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference';
const AUDIO_FRAME_BYTES = 3200; // 100ms @ 16kHz, 16-bit, mono.
const MAX_PENDING_BYTES = 16000 * 2 * 5; // Keep at most five seconds before ready.

const BASE_TECH_TERMS = [
  'Java', 'Go', 'Golang', 'Python', 'JavaScript', 'TypeScript',
  'Spring Boot', 'Spring Cloud', 'JVM', 'GC', 'G1', 'ZGC',
  'HashMap', 'ConcurrentHashMap', 'ThreadLocal',
  'MySQL', 'PostgreSQL', 'Redis', 'MongoDB',
  'Kafka', 'RocketMQ', 'RabbitMQ',
  'Docker', 'Kubernetes', 'K8s', 'Helm',
  'AWS', 'Azure', 'GCP',
  'REST API', 'gRPC', 'HTTP', 'WebSocket',
  'microservices', 'distributed system', 'CAP', 'MVCC',
  'CI/CD', 'GitHub Actions', 'GitLab',
  'RAG', 'Agent', 'LLM', 'MCP', 'LangChain'
];

function isAlibabaModelStudioUrl(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return (
    value.includes('dashscope.aliyuncs.com') ||
    value.includes('dashscope-intl.aliyuncs.com') ||
    value.includes('.maas.aliyuncs.com')
  );
}

function deriveWebSocketUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();

  if (!raw) return DEFAULT_CN_WS;

  if (/^wss:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, '');
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.host;

    if (host.includes('dashscope-intl.aliyuncs.com')) {
      return DEFAULT_INTL_WS;
    }

    if (
      host.includes('dashscope.aliyuncs.com') ||
      host.endsWith('.maas.aliyuncs.com')
    ) {
      return `wss://${host}/api-ws/v1/inference`;
    }
  } catch (_) {}

  return DEFAULT_CN_WS;
}

function extractTerms(text) {
  const raw = String(text || '');
  const matches = raw.match(
    /\b[A-Za-z][A-Za-z0-9+.#/_-]{1,30}(?:\s+[A-Za-z][A-Za-z0-9+.#/_-]{1,30}){0,2}\b/g
  ) || [];

  return Array.from(
    new Set(matches.map((item) => item.trim()).filter(Boolean))
  ).slice(0, 80);
}

function buildQwenContext(settings = {}) {
  const qwen = settings.qwenAsr || {};
  const source = [
    qwen.useResume === false ? '' : (settings.resumeText || ''),
    qwen.useProjectKnowledge === false ? '' : (settings.projectKnowledge || ''),
    qwen.useJobDescription === false ? '' : (settings.jobDescription || '')
  ].join('\n');



  const customVocabulary = (qwen.vocabulary || []);
  const terms = Array.from(
    new Set([...BASE_TECH_TERMS, ...extractTerms(source), ...customVocabulary])
  ).slice(0, 120);

  const context = [
    '这是软件工程师技术面试的实时语音识别。',
    '中文和英文技术术语可能混合出现。',
    '以下词汇仅用于帮助识别专业术语，不是需要转写的语音：',
    terms.join(', ')
  ].join('\n');

  return context.slice(0, 1800);
}

function resolveQwenAsrConfig(settings = {}) {
  const keys = settings.apiKeys || {};
  const qwen = settings.qwenAsr || {};
  const customLooksAlibaba = isAlibabaModelStudioUrl(settings.baseUrl);

  const apiKey =
    String(
      qwen.apiKey ||
      keys.qwenAsr ||
      (customLooksAlibaba ? keys.custom : '') ||
      process.env.DASHSCOPE_API_KEY ||
      ''
    ).trim();

  const websocketUrl = deriveWebSocketUrl(
    qwen.websocketUrl ||
    (customLooksAlibaba ? settings.baseUrl : '')
  );

  return {
    apiKey,
    websocketUrl,
    model: String(qwen.model || DEFAULT_QWEN_ASR_MODEL).trim(),
    language: qwen.language || 'auto',
    contextText:
      qwen.useInterviewContext === false
        ? ''
        : buildQwenContext(settings),
    available: !!apiKey
  };
}

function buildRunTaskMessage(config, taskId) {
  const input = {};

  if (config.contextText) {
    input.context = [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: config.contextText
          }
        ]
      }
    ];
  }

  return {
    header: {
      action: 'run-task',
      task_id: taskId,
      streaming: 'duplex'
    },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: config.model || DEFAULT_QWEN_ASR_MODEL,
      parameters: {
        format: 'pcm',
        sample_rate: 16000,
        language_hints: config.language && config.language !== 'auto' ? [config.language] : undefined,
        semantic_punctuation_enabled: true
      },
      input
    }
  };
}

function buildFinishTaskMessage(taskId) {
  return {
    header: {
      action: 'finish-task',
      task_id: taskId,
      streaming: 'duplex'
    },
    payload: {
      input: {}
    }
  };
}

function parseQwenEvent(message) {
  const eventName = message?.header?.event || '';

  if (eventName === 'task-started') {
    return { type: 'started' };
  }

  if (eventName === 'result-generated') {
    const sentence = message?.payload?.output?.sentence;
    if (!sentence || sentence.heartbeat) {
      return { type: 'heartbeat' };
    }

    return {
      type: sentence.sentence_end ? 'final' : 'interim',
      text: String(sentence.text || '').trim(),
      sentenceId: sentence.sentence_id ?? null,
      beginTime: sentence.begin_time ?? null,
      endTime: sentence.end_time ?? null
    };
  }

  if (eventName === 'task-finished') {
    return { type: 'finished' };
  }

  if (eventName === 'task-failed') {
    return {
      type: 'error',
      code: message?.header?.error_code || 'QWEN_ASR_TASK_FAILED',
      message:
        message?.header?.error_message ||
        'Qwen ASR task failed.'
    };
  }

  return { type: 'unknown' };
}

class QwenStreamingSTT {
  constructor(config, options = {}) {
    this.config = config;
    this.apiKey = config.apiKey;
    this.websocketUrl = config.websocketUrl;
    this.model = config.model || DEFAULT_QWEN_ASR_MODEL;

    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    this.ws = null;
    this.connected = false;
    this.taskStarted = false;
    this.taskId = null;

    this._pendingAudio = Buffer.alloc(0);
    this._allowReconnect = true;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 600;
    this._closingTimer = null;
    this._lastFinalKey = '';
  }

  async connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return;
    }

    if (!this.apiKey) {
      this.onError({
        provider: 'qwen-asr',
        status: 401,
        message:
          'Qwen ASR API key is missing. Configure Alibaba Model Studio in Custom first.'
      });
      return;
    }

    this._allowReconnect = true;
    this.onStatusChange('connecting');

    try {
      const WebSocket = require('ws');

      this.taskId = crypto.randomUUID();
      this.taskStarted = false;

      this.ws = new WebSocket(this.websocketUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'cue-qwen-asr/1.0'
        }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;

        this._sendJson(
          buildRunTaskMessage(
            {
              ...this.config,
              model: this.model
            },
            this.taskId
          )
        );
      });

      this.ws.on('message', (data, isBinary) => {
        if (isBinary) return;

        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (_) {}
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this.taskStarted = false;
        this.onStatusChange('disconnected');

        if (
          code !== 1000 &&
          this._allowReconnect
        ) {
          this._attemptReconnect();
        }
      });

      this.ws.on('error', (error) => {
        this.onError({
          provider: 'qwen-asr',
          status: null,
          message: error?.message || String(error)
        });
      });

      this.ws.on('unexpected-response', (_request, response) => {
        let body = '';

        response.on('data', (chunk) => {
          body += chunk.toString();
        });

        response.on('end', () => {
          this.onError({
            provider: 'qwen-asr',
            status: response.statusCode,
            message:
              body ||
              `Qwen ASR WebSocket handshake failed (${response.statusCode}).`
          });
        });
      });
    } catch (error) {
      this.onError({
        provider: 'qwen-asr',
        status: null,
        message: error?.message || String(error)
      });
    }
  }

  _handleMessage(message) {
    const event = parseQwenEvent(message);

    if (event.type === 'started') {
      this.taskStarted = true;
      this.onStatusChange('connected');
      this._flushAudio();
      return;
    }

    if (event.type === 'interim') {
      if (event.text) {
        this.onInterim(event.text);
      }
      return;
    }

    if (event.type === 'final') {
      if (!event.text) return;

      const dedupeKey =
        `${event.sentenceId ?? ''}:${event.text}`;

      if (dedupeKey === this._lastFinalKey) {
        return;
      }

      this._lastFinalKey = dedupeKey;
      this.onInterim('');
      this.onTranscript(event.text);
      return;
    }

    if (event.type === 'finished') {
      this.taskStarted = false;
      this.onStatusChange('finished');

      if (!this._allowReconnect) {
        this._closeSocket(1000);
      }
      return;
    }

    if (event.type === 'error') {
      this.onError({
        provider: 'qwen-asr',
        status: event.code,
        message: event.message
      });

      this._allowReconnect = false;
      this._closeSocket(1011);
    }
  }

  sendAudio(pcmBuffer) {
    if (!pcmBuffer) return;

    const incoming = Buffer.from(pcmBuffer);

    if (!incoming.length) return;

    this._pendingAudio = Buffer.concat([
      this._pendingAudio,
      incoming
    ]);

    if (this._pendingAudio.length > MAX_PENDING_BYTES) {
      this._pendingAudio =
        this._pendingAudio.subarray(
          this._pendingAudio.length - MAX_PENDING_BYTES
        );
    }

    if (this.taskStarted) {
      this._flushAudio();
    }
  }

  _flushAudio(force = false) {
    if (
      !this.ws ||
      this.ws.readyState !== 1 ||
      !this.taskStarted
    ) {
      return;
    }

    while (this._pendingAudio.length >= AUDIO_FRAME_BYTES) {
      const frame =
        this._pendingAudio.subarray(0, AUDIO_FRAME_BYTES);

      this._pendingAudio =
        this._pendingAudio.subarray(AUDIO_FRAME_BYTES);

      this.ws.send(frame, { binary: true });
    }

    if (force && this._pendingAudio.length) {
      this.ws.send(this._pendingAudio, { binary: true });
      this._pendingAudio = Buffer.alloc(0);
    }
  }

  _sendJson(payload) {
    if (
      this.ws &&
      this.ws.readyState === 1
    ) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _attemptReconnect() {
    if (!this._allowReconnect) return;

    if (
      this._reconnectAttempts >=
      this._maxReconnectAttempts
    ) {
      this.onError({
        provider: 'qwen-asr',
        status: null,
        message: 'Qwen ASR maximum reconnect attempts reached.'
      });
      return;
    }

    this._reconnectAttempts += 1;

    const delay = Math.min(
      this._reconnectDelay *
        (2 ** (this._reconnectAttempts - 1)),
      8000
    );

    setTimeout(() => {
      if (this._allowReconnect) {
        this.connect();
      }
    }, delay);
  }

  _closeSocket(code = 1000) {
    clearTimeout(this._closingTimer);
    this._closingTimer = null;

    const ws = this.ws;
    this.ws = null;

    if (!ws) return;

    try {
      if (ws.readyState === 1) {
        ws.close(code);
      } else if (ws.readyState === 0) {
        ws.terminate();
      }
    } catch (_) {
      try {
        ws.terminate();
      } catch (_) {}
    }
  }

  disconnect() {
    this._allowReconnect = false;
    this._flushAudio(true);

    if (
      this.ws &&
      this.ws.readyState === 1 &&
      this.taskStarted &&
      this.taskId
    ) {
      this._sendJson(
        buildFinishTaskMessage(this.taskId)
      );

      // Give the service a short window to return the last final sentence and
      // task-finished. If it does not, close anyway so Cue never hangs on stop.
      this._closingTimer = setTimeout(() => {
        this._closeSocket(1000);
      }, 800);

      return;
    }

    this._closeSocket(1000);
  }
}

module.exports = {
  DEFAULT_QWEN_ASR_MODEL,
  DEFAULT_CN_WS,
  DEFAULT_INTL_WS,
  AUDIO_FRAME_BYTES,
  isAlibabaModelStudioUrl,
  deriveWebSocketUrl,
  buildQwenContext,
  resolveQwenAsrConfig,
  buildRunTaskMessage,
  buildFinishTaskMessage,
  parseQwenEvent,
  QwenStreamingSTT
};
