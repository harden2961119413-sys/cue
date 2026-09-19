// src/stt-streaming.js
// Unified cloud streaming STT.
//
// Providers:
// - Qwen Audio 3.0 ASR Flash Streaming (Alibaba Model Studio)
// - Deepgram Nova-3
// - OpenAI Realtime transcription
//
// Batch fallback remains in src/stt.js.
//
// Qwen is implemented in its own provider module so future providers such as
// Doubao/iFlytek/Tencent can be added without making this file monolithic.

const { looksLikeHallucination } = require('./stt');
const { CURRENT_GEMINI_DEFAULT } = require('./llm');
const {
  QwenStreamingSTT,
  resolveQwenAsrConfig
} = require('./stt-providers/qwen');

// ============================================================================
// OpenAI Realtime transcription
// ============================================================================

class OpenAIRealtimeSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'gpt-realtime-whisper';
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._pendingAudio = [];
    this._sessionReady = false;
  }

  async connect() {
    if (this.ws && this.connected) return;

    try {
      const WebSocket = require('ws');
      const url =
        'wss://api.openai.com/v1/realtime?intent=transcription';

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');

        this._sendEvent({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: {
                  type: 'audio/pcm',
                  rate: 24000
                },
                transcription: {
                  model: this.model,
                  language: 'en'
                }
              }
            }
          }
        });
      });

      this.ws.on('message', (data) => {
        try {
          this._handleEvent(
            JSON.parse(data.toString())
          );
        } catch (_) {}
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._sessionReady = false;
        this.onStatusChange('disconnected');

        if (
          code !== 1000 &&
          !this.reconnecting
        ) {
          this._attemptReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.onError({
          provider: 'openai-realtime',
          message: err.message,
          status: null
        });
      });

      this.ws.on(
        'unexpected-response',
        (_request, response) => {
          let body = '';

          response.on('data', (chunk) => {
            body += chunk.toString();
          });

          response.on('end', () => {
            this.onError({
              provider: 'openai-realtime',
              status: response.statusCode,
              message:
                body ||
                `OpenAI realtime handshake failed (${response.statusCode}).`
            });
          });
        }
      );
    } catch (e) {
      this.onError({
        provider: 'openai-realtime',
        message: e.message,
        status: null
      });
    }
  }

  _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this._sessionReady = true;
        this._flushPendingAudio();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.onInterim(event.delta);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (
          event.transcript &&
          event.transcript.trim()
        ) {
          this.onTranscript(
            event.transcript.trim()
          );
        }
        break;

      case 'error':
        this.onError({
          provider: 'openai-realtime',
          message:
            event.error?.message ||
            'Unknown realtime error',
          status: event.error?.code
        });
        break;

      default:
        break;
    }
  }

  sendAudio(pcmBuffer) {
    if (
      !this.connected ||
      !this._sessionReady
    ) {
      this._pendingAudio.push(
        pcmBuffer
      );

      if (
        this._pendingAudio.length >
        80
      ) {
        this._pendingAudio.shift();
      }

      return;
    }

    const resampled =
      this._resample16to24(
        Buffer.from(pcmBuffer)
      );

    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: resampled.toString('base64')
    });
  }

  _resample16to24(pcm16kHz) {
    const srcSamples =
      pcm16kHz.length / 2;

    const dstSamples =
      Math.floor(
        srcSamples *
        24000 /
        16000
      );

    const out =
      Buffer.alloc(
        dstSamples * 2
      );

    for (
      let i = 0;
      i < dstSamples;
      i++
    ) {
      const srcPos =
        i * 16000 / 24000;

      const idx =
        Math.floor(srcPos);

      const frac =
        srcPos - idx;

      const s0 =
        idx < srcSamples
          ? pcm16kHz.readInt16LE(
              idx * 2
            )
          : 0;

      const s1 =
        idx + 1 < srcSamples
          ? pcm16kHz.readInt16LE(
              (idx + 1) * 2
            )
          : s0;

      const sample =
        Math.round(
          s0 + (s1 - s0) * frac
        );

      out.writeInt16LE(
        Math.max(
          -32768,
          Math.min(
            32767,
            sample
          )
        ),
        i * 2
      );
    }

    return out;
  }

  _flushPendingAudio() {
    while (
      this._pendingAudio.length >
      0
    ) {
      const chunk =
        this._pendingAudio.shift();

      const resampled =
        this._resample16to24(
          Buffer.from(chunk)
        );

      this._sendEvent({
        type:
          'input_audio_buffer.append',
        audio:
          resampled.toString('base64')
      });
    }
  }

  _sendEvent(event) {
    if (
      this.ws &&
      this.ws.readyState === 1
    ) {
      this.ws.send(
        JSON.stringify(event)
      );
    }
  }

  _attemptReconnect() {
    if (
      this._reconnectAttempts >=
      this._maxReconnectAttempts
    ) {
      this.onError({
        provider: 'openai-realtime',
        message:
          'Max reconnection attempts reached',
        status: null
      });
      return;
    }

    this.reconnecting = true;
    this._reconnectAttempts++;

    const delay =
      this._reconnectDelay *
      Math.pow(
        2,
        this._reconnectAttempts - 1
      );

    setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._sessionReady = false;
    this._pendingAudio = [];

    if (this.ws) {
      try {
        if (
          this.ws.readyState === 1
        ) {
          this.ws.close(1000);
        } else if (
          this.ws.readyState === 0
        ) {
          this.ws.terminate();
        }
      } catch (_) {}

      this.ws = null;
    }

    this.connected = false;
  }
}

// ============================================================================
// Deepgram Nova streaming
// ============================================================================

class DeepgramStreamingSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model =
      options.model || 'nova-3';

    this.ws = null;
    this.connected = false;

    this.onTranscript =
      options.onTranscript ||
      (() => {});

    this.onInterim =
      options.onInterim ||
      (() => {});

    this.onError =
      options.onError ||
      (() => {});

    this.onStatusChange =
      options.onStatusChange ||
      (() => {});

    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;

    this._keepAliveInterval = null;
    this._committed = '';
    this._allowReconnect = true;
  }

  async connect() {
    if (
      this.ws &&
      this.connected
    ) {
      return;
    }

    this._allowReconnect = true;

    try {
      const WebSocket =
        require('ws');

      const params =
        new URLSearchParams({
          model: this.model,
          language: 'zh-CN',
          smart_format: 'true',
          interim_results: 'true',
          utterance_end_ms: '1000',
          vad_events: 'true',
          encoding: 'linear16',
          sample_rate: '16000',
          channels: '1',
          endpointing: '300',
          punctuate: 'true'
        });

      const url =
        `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      this.ws =
        new WebSocket(url, {
          headers: {
            Authorization:
              `Token ${this.apiKey}`
          }
        });

      this.ws.on(
        'open',
        () => {
          this.connected = true;
          this._reconnectAttempts = 0;
          this.onStatusChange(
            'connected'
          );

          this._keepAliveInterval =
            setInterval(() => {
              if (
                this.ws &&
                this.ws.readyState === 1
              ) {
                this.ws.send(
                  JSON.stringify({
                    type: 'KeepAlive'
                  })
                );
              }
            }, 3000);
        }
      );

      this.ws.on(
        'message',
        (data) => {
          try {
            this._handleMessage(
              JSON.parse(
                data.toString()
              )
            );
          } catch (_) {}
        }
      );

      this.ws.on(
        'close',
        (code) => {
          this.connected = false;
          this._clearKeepAlive();
          this.onStatusChange(
            'disconnected'
          );

          if (
            code !== 1000 &&
            this._allowReconnect
          ) {
            this._attemptReconnect();
          }
        }
      );

      this.ws.on(
        'error',
        (err) => {
          this.onError({
            provider: 'deepgram',
            message: err.message,
            status: null
          });
        }
      );

      this.ws.on(
        'unexpected-response',
        (_request, response) => {
          let body = '';

          response.on(
            'data',
            (chunk) => {
              body +=
                chunk.toString();
            }
          );

          response.on(
            'end',
            () => {
              this.onError({
                provider: 'deepgram',
                status:
                  response.statusCode,
                message:
                  body ||
                  `Deepgram handshake failed (${response.statusCode}).`
              });
            }
          );
        }
      );
    } catch (e) {
      this.onError({
        provider: 'deepgram',
        message: e.message,
        status: null
      });
    }
  }

  _handleMessage(msg) {
    if (
      msg.type === 'Results'
    ) {
      const alt =
        msg.channel
          ?.alternatives?.[0];

      if (!alt) return;

      const text =
        (alt.transcript || '')
          .trim();

      if (msg.speech_final) {
        const full =
          (
            (this._committed || '') +
            ' ' +
            text
          ).trim();

        this._committed = '';

        if (
          full &&
          !looksLikeHallucination(
            full
          )
        ) {
          this.onTranscript(full);
        }

        this.onInterim('');
        return;
      }

      if (!text) return;

      if (msg.is_final) {
        this._committed =
          (
            (this._committed || '') +
            ' ' +
            text
          ).trim();

        this.onInterim(
          this._committed
        );
      } else {
        this.onInterim(
          (
            (this._committed || '') +
            ' ' +
            text
          ).trim()
        );
      }

      return;
    }

    if (
      msg.type ===
      'UtteranceEnd'
    ) {
      this._flushCommitted();
      return;
    }

    if (
      msg.type === 'Error'
    ) {
      this.onError({
        provider: 'deepgram',
        message:
          msg.description ||
          msg.message,
        status: msg.variant
      });
    }
  }

  _flushCommitted() {
    const full =
      (this._committed || '')
        .trim();

    this._committed = '';

    if (
      full &&
      !looksLikeHallucination(
        full
      )
    ) {
      this.onTranscript(full);
    }

    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (
      this.ws &&
      this.ws.readyState === 1
    ) {
      this.ws.send(
        Buffer.from(pcmBuffer)
      );
    }
  }

  _clearKeepAlive() {
    if (
      this._keepAliveInterval
    ) {
      clearInterval(
        this._keepAliveInterval
      );

      this._keepAliveInterval =
        null;
    }
  }

  _attemptReconnect() {
    if (
      !this._allowReconnect
    ) {
      return;
    }

    if (
      this._reconnectAttempts >=
      this._maxReconnectAttempts
    ) {
      this.onError({
        provider: 'deepgram',
        message:
          'Max reconnection attempts reached',
        status: null
      });

      return;
    }

    this._reconnectAttempts++;

    const delay =
      this._reconnectDelay *
      Math.pow(
        2,
        this._reconnectAttempts - 1
      );

    setTimeout(() => {
      if (
        this._allowReconnect
      ) {
        this.connect();
      }
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._allowReconnect = false;

    this._flushCommitted();
    this._clearKeepAlive();

    const ws = this.ws;

    this.ws = null;
    this.connected = false;

    if (!ws) return;

    try {
      if (
        ws.readyState === 1
      ) {
        try {
          ws.send(
            JSON.stringify({
              type: 'CloseStream'
            })
          );
        } catch (_) {}

        ws.close(1000);
      } else if (
        ws.readyState === 0
      ) {
        ws.terminate();
      } else if (
        ws.readyState !== 3
      ) {
        ws.terminate();
      }
    } catch (_) {
      try {
        ws.terminate();
      } catch (_) {}
    }
  }
}

// ============================================================================
// Batch helpers
// ============================================================================

async function transcribeBatchOpenAI(
  apiKey,
  wav,
  model
) {
  const OpenAI =
    require('openai');

  const toFile =
    OpenAI.toFile ||
    require('openai/uploads')
      .toFile;

  const client =
    new OpenAI({ apiKey });

  const file =
    await toFile(
      wav,
      'audio.wav',
      { type: 'audio/wav' }
    );

  const res =
    await client.audio
      .transcriptions
      .create({
        file,
        model:
          model ||
          'whisper-1',
        response_format:
          'text',
        language: 'en'
      });

  return (
    typeof res === 'string'
      ? res
      : res.text || ''
  ).trim();
}

async function transcribeBatchGemini(
  apiKey,
  wav
) {
  const { GoogleGenAI } =
    require('@google/genai');

  const ai =
    new GoogleGenAI({
      apiKey
    });

  const res =
    await ai.models
      .generateContent({
        model:
          CURRENT_GEMINI_DEFAULT,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.'
              },
              {
                inlineData: {
                  mimeType:
                    'audio/wav',
                  data:
                    wav.toString(
                      'base64'
                    )
                }
              }
            ]
          }
        ]
      });

  return (
    (res && res.text) ||
    ''
  ).trim();
}

// ============================================================================
// Factory
// ============================================================================

function createStreamingSTT(
  settings,
  channel,
  callbacks
) {
  const keys =
    settings.apiKeys || {};

  const selectedProvider =
    settings.sttProvider ||
    'auto';

  const {
    onTranscript,
    onInterim,
    onError,
    onStatusChange
  } = callbacks;

  if (
    selectedProvider === 'local' ||
    selectedProvider === 'gemini'
  ) {
    return {
      type: 'batch',
      provider:
        selectedProvider,
      instance: null
    };
  }

  // Qwen is first in Auto mode whenever Cue's Custom endpoint is Alibaba
  // Model Studio. This gives the project a China-friendly low-latency path
  // while retaining Deepgram/OpenAI as fallbacks.
  const qwenConfig =
    resolveQwenAsrConfig(
      settings
    );

  if (
    (
      selectedProvider === 'qwen' ||
      selectedProvider === 'auto'
    ) &&
    qwenConfig.available
  ) {
    const stt =
      new QwenStreamingSTT(
        qwenConfig,
        {
          onTranscript:
            (text) =>
              onTranscript(
                channel,
                text
              ),
          onInterim:
            (text) =>
              onInterim(
                channel,
                text
              ),
          onError,
          onStatusChange:
            (status) =>
              onStatusChange(
                channel,
                status
              )
        }
      );

    return {
      type: 'streaming',
      provider: 'qwen-asr',
      instance: stt
    };
  }

  if (
    (
      selectedProvider ===
        'auto' ||
      selectedProvider ===
        'deepgram'
    ) &&
    keys.deepgram
  ) {
    const stt =
      new DeepgramStreamingSTT(
        keys.deepgram,
        {
          model: 'nova-3',
          onTranscript:
            (text) =>
              onTranscript(
                channel,
                text
              ),
          onInterim:
            (text) =>
              onInterim(
                channel,
                text
              ),
          onError,
          onStatusChange:
            (status) =>
              onStatusChange(
                channel,
                status
              )
        }
      );

    return {
      type: 'streaming',
      provider: 'deepgram',
      instance: stt
    };
  }

  if (
    (
      selectedProvider ===
        'auto' ||
      selectedProvider ===
        'openai'
    ) &&
    keys.openai
  ) {
    const stt =
      new OpenAIRealtimeSTT(
        keys.openai,
        {
          model:
            'gpt-realtime-whisper',
          onTranscript:
            (text) =>
              onTranscript(
                channel,
                text
              ),
          onInterim:
            (text) =>
              onInterim(
                channel,
                text
              ),
          onError,
          onStatusChange:
            (status) =>
              onStatusChange(
                channel,
                status
              )
        }
      );

    return {
      type: 'streaming',
      provider:
        'openai-realtime',
      instance: stt
    };
  }

  return {
    type: 'batch',
    provider:
      selectedProvider ===
        'auto' &&
      keys.gemini
        ? 'gemini'
        : selectedProvider,
    instance: null
  };
}

module.exports = {
  QwenStreamingSTT,
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini
};
