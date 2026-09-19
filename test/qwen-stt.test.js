const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_QWEN_ASR_MODEL,
  DEFAULT_CN_WS,
  DEFAULT_INTL_WS,
  deriveWebSocketUrl,
  buildQwenContext,
  resolveQwenAsrConfig,
  buildRunTaskMessage,
  parseQwenEvent
} = require('../src/stt-providers/qwen');

test('derives China websocket URL from old DashScope compatible URL', () => {
  assert.equal(
    deriveWebSocketUrl(
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ),
    DEFAULT_CN_WS
  );
});

test('derives Singapore websocket URL from old international URL', () => {
  assert.equal(
    deriveWebSocketUrl(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    ),
    DEFAULT_INTL_WS
  );
});

test('keeps workspace host when converting HTTP to websocket', () => {
  assert.equal(
    deriveWebSocketUrl(
      'https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    ),
    'wss://ws123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'
  );
});

test('reuses Custom Alibaba key for Qwen ASR', () => {
  const config = resolveQwenAsrConfig({
    baseUrl:
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeys: {
      custom: 'sk-test'
    }
  });

  assert.equal(config.apiKey, 'sk-test');
  assert.equal(config.available, true);
  assert.equal(config.model, DEFAULT_QWEN_ASR_MODEL);
});

test('does not reuse a non-Alibaba Custom key', () => {
  const config = resolveQwenAsrConfig({
    baseUrl:
      'https://example.com/v1',
    apiKeys: {
      custom: 'not-a-qwen-key'
    }
  });

  assert.equal(config.apiKey, '');
  assert.equal(config.available, false);
});

test('builds interview context with technical vocabulary', () => {
  const context = buildQwenContext({
    resumeText:
      'Built Java Spring Boot services with Kafka and Redis.',
    projectKnowledge:
      'Used Kubernetes and ConcurrentHashMap.'
  });

  assert.match(context, /Java/);
  assert.match(context, /Kafka/);
  assert.match(context, /ConcurrentHashMap/);
  assert.ok(context.length <= 1800);
});

test('run-task uses 16k mono PCM compatible parameters', () => {
  const message = buildRunTaskMessage(
    {
      model: DEFAULT_QWEN_ASR_MODEL,
      contextText: 'Java backend interview'
    },
    'task-1'
  );

  assert.equal(
    message.header.action,
    'run-task'
  );
  assert.equal(
    message.payload.model,
    DEFAULT_QWEN_ASR_MODEL
  );
  assert.equal(
    message.payload.parameters.format,
    'pcm'
  );
  assert.equal(
    message.payload.parameters.sample_rate,
    16000
  );
});

test('parses Qwen interim and final recognition events', () => {
  const interim = parseQwenEvent({
    header: {
      event: 'result-generated'
    },
    payload: {
      output: {
        sentence: {
          text: '讲一下 Redis',
          sentence_end: false,
          sentence_id: 1
        }
      }
    }
  });

  const finalResult = parseQwenEvent({
    header: {
      event: 'result-generated'
    },
    payload: {
      output: {
        sentence: {
          text: '讲一下 Redis 缓存击穿。',
          sentence_end: true,
          sentence_id: 1
        }
      }
    }
  });

  assert.equal(interim.type, 'interim');
  assert.equal(finalResult.type, 'final');
  assert.equal(
    finalResult.text,
    '讲一下 Redis 缓存击穿。'
  );
});
