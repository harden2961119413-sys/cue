// src/utterance-segmenter.js

const {
  AdaptiveVAD,
  AudioRingBuffer
} = require('./vad');

const DEFAULT_SAMPLE_RATE = 16000;

const PCM_BYTES_PER_SAMPLE = 2;

const DEFAULT_PRE_ROLL_MS = 300;

const DEFAULT_MIN_UTTERANCE_MS =
  180;

const DEFAULT_MAX_UTTERANCE_MS =
  8000;

const DEFAULT_PREVIEW_INTERVAL_MS =
  900;

const DEFAULT_PREVIEW_WINDOW_MS =
  5000;

const DEFAULT_MIN_PREVIEW_MS =
  1200;


class UtteranceSegmenter {
  constructor({
    channel,

    sampleRate =
      DEFAULT_SAMPLE_RATE,

    preRollMs =
      DEFAULT_PRE_ROLL_MS,

    minUtteranceMs =
      DEFAULT_MIN_UTTERANCE_MS,

    maxUtteranceMs =
      DEFAULT_MAX_UTTERANCE_MS,

    previewIntervalMs =
      DEFAULT_PREVIEW_INTERVAL_MS,

    previewWindowMs =
      DEFAULT_PREVIEW_WINDOW_MS,

    minPreviewMs =
      DEFAULT_MIN_PREVIEW_MS,

    vadOptions = {},

    onSpeechState =
      () => {},

    onPreview =
      () => {},

    onUtterance =
      () => {}
  }) {
    if (!channel) {
      throw new Error(
        'UtteranceSegmenter requires a channel.'
      );
    }

    this.channel = channel;
    this.sampleRate = sampleRate;

    this.minimumBytes =
      this._millisecondsToBytes(
        minUtteranceMs
      );

    this.maximumBytes =
      this._millisecondsToBytes(
        maxUtteranceMs
      );

    this.previewIntervalBytes =
      previewIntervalMs > 0
        ? this._millisecondsToBytes(
            previewIntervalMs
          )
        : 0;

    this.previewWindowBytes =
      this._millisecondsToBytes(
        previewWindowMs
      );

    this.minimumPreviewBytes =
      this._millisecondsToBytes(
        minPreviewMs
      );

    this.onSpeechState =
      onSpeechState;

    this.onPreview =
      onPreview;

    this.onUtterance =
      onUtterance;

    this.ringBuffer =
      new AudioRingBuffer(
        preRollMs,
        sampleRate
      );

    this.utteranceChunks = [];
    this.utteranceBytes = 0;

    this.bytesAtLastPreview = 0;

    this.collecting = false;

    this.startedDuringPush = false;
    this.endedDuringPush = false;

    this.segmentId = 0;

    this.vad =
      new AdaptiveVAD({
        sampleRate,

        ...vadOptions,

        onSpeechStart:
          () =>
            this._beginUtterance(),

        onSpeechEnd:
          (durationMs) =>
            this._requestUtteranceEnd(
              durationMs
            )
      });
  }

  push(pcm) {
    const chunk =
      Buffer.from(pcm || []);

    if (
      chunk.length <
      PCM_BYTES_PER_SAMPLE
    ) {
      return;
    }

    if (
      chunk.length %
        PCM_BYTES_PER_SAMPLE !==
      0
    ) {
      throw new Error(
        'PCM chunks must contain complete Int16 samples.'
      );
    }

    this.startedDuringPush = false;
    this.endedDuringPush = false;

    const wasCollecting =
      this.collecting;

    // Keep pre-roll while VAD is still
    // deciding whether a candidate really
    // is speech.
    if (!wasCollecting) {
      this.ringBuffer.write(
        chunk
      );
    }

    this.vad.processChunk(
      chunk
    );

    // The chunk that confirmed speech is
    // already present in pre-roll.
    if (wasCollecting) {
      this._appendChunk(
        chunk
      );
    }

    if (
      this.endedDuringPush
    ) {
      this._finalizeUtterance(
        'endpoint'
      );
    }
  }

  stop() {
    if (this.collecting) {
      this._finalizeUtterance(
        'stop'
      );
    }

    this.reset();
  }

  reset() {
    this.collecting = false;

    this.startedDuringPush = false;
    this.endedDuringPush = false;

    this.utteranceChunks = [];
    this.utteranceBytes = 0;

    this.bytesAtLastPreview = 0;

    this.ringBuffer.clear();
    this.vad.reset();
  }

  _beginUtterance() {
    this.collecting = true;

    this.startedDuringPush = true;

    this.segmentId += 1;

    const preRoll =
      this.ringBuffer.read();

    this.utteranceChunks =
      preRoll.length
        ? [
            Buffer.from(
              preRoll
            )
          ]
        : [];

    this.utteranceBytes =
      preRoll.length;

    this.bytesAtLastPreview = 0;

    this.ringBuffer.clear();

    this.onSpeechState(
      this.channel,
      true
    );
  }

  _requestUtteranceEnd(
    durationMs
  ) {
    this.endedDuringPush =
      true;

    this.onSpeechState(
      this.channel,
      false,
      durationMs
    );
  }

  _appendChunk(chunk) {
    this.utteranceChunks.push(
      Buffer.from(chunk)
    );

    this.utteranceBytes +=
      chunk.length;

    // Hard upper bound.
    //
    // Do not allow a continuous
    // interviewer monologue to block
    // transcription for 20-25 seconds.
    while (
      this.utteranceBytes >=
      this.maximumBytes
    ) {
      const combined =
        Buffer.concat(
          this.utteranceChunks,
          this.utteranceBytes
        );

      const finalPcm =
        Buffer.from(
          combined.subarray(
            0,
            this.maximumBytes
          )
        );

      this._emitFinal(
        finalPcm,
        'max-duration'
      );

      const remainder =
        Buffer.from(
          combined.subarray(
            this.maximumBytes
          )
        );

      this.utteranceChunks =
        remainder.length
          ? [remainder]
          : [];

      this.utteranceBytes =
        remainder.length;

      this.bytesAtLastPreview = 0;

      this.segmentId += 1;
    }

    this._maybeEmitPreview();
  }

  _maybeEmitPreview() {
    if (
      !this.previewIntervalBytes
    ) {
      return;
    }

    if (
      this.utteranceBytes <
      this.minimumPreviewBytes
    ) {
      return;
    }

    if (
      this.utteranceBytes -
        this.bytesAtLastPreview <
      this.previewIntervalBytes
    ) {
      return;
    }

    const combined =
      Buffer.concat(
        this.utteranceChunks,
        this.utteranceBytes
      );

    const start =
      Math.max(
        0,
        combined.length -
          this.previewWindowBytes
      );

    const preview =
      Buffer.from(
        combined.subarray(start)
      );

    this.bytesAtLastPreview =
      this.utteranceBytes;

    this.onPreview(
      this.channel,
      preview,
      {
        segmentId:
          this.segmentId,

        reason:
          'rolling'
      }
    );
  }

  _finalizeUtterance(
    reason
  ) {
    if (!this.collecting) {
      return;
    }

    const utterance =
      Buffer.concat(
        this.utteranceChunks,
        this.utteranceBytes
      );

    if (
      utterance.length >=
      this.minimumBytes
    ) {
      this._emitFinal(
        utterance,
        reason
      );
    }

    this.collecting = false;

    this.endedDuringPush = false;

    this.utteranceChunks = [];
    this.utteranceBytes = 0;

    this.bytesAtLastPreview = 0;

    this.ringBuffer.clear();
  }

  _emitFinal(
    pcm,
    reason
  ) {
    this.onUtterance(
      this.channel,
      Buffer.from(pcm),
      {
        segmentId:
          this.segmentId,

        reason
      }
    );
  }

  _millisecondsToBytes(
    durationMs
  ) {
    return Math.floor(
      this.sampleRate *
      PCM_BYTES_PER_SAMPLE *
      durationMs /
      1000
    );
  }
}


module.exports = {
  UtteranceSegmenter,

  DEFAULT_SAMPLE_RATE,

  DEFAULT_PRE_ROLL_MS,

  DEFAULT_MIN_UTTERANCE_MS,

  DEFAULT_MAX_UTTERANCE_MS,

  DEFAULT_PREVIEW_INTERVAL_MS,

  DEFAULT_PREVIEW_WINDOW_MS
};