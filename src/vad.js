// src/vad.js

class AdaptiveVAD {
  constructor(options = {}) {
    this.sampleRate =
      options.sampleRate ?? 16000;

    this.frameDurationMs =
      options.frameDurationMs ?? 30;

    this.frameSize =
      Math.floor(
        this.sampleRate *
        this.frameDurationMs /
        1000
      );

    this.frameBytes =
      this.frameSize * 2;

    // Keep generic defaults conservative.
    // Local Whisper overrides these per channel.
    this.onsetThreshold =
      options.onsetThreshold ?? 250;

    this.offsetThreshold =
      options.offsetThreshold ?? 150;

    this.silenceFrames =
      options.silenceFrames ?? 15;

    this.minSpeechFrames =
      Math.max(
        1,
        options.minSpeechFrames ?? 4
      );

    this.initialNoiseFloor =
      options.initialNoiseFloor ?? 80;

    this.noiseFloor =
      this.initialNoiseFloor;

    this.noiseAdaptRate =
      options.noiseAdaptRate ?? 0.02;

    this.noiseMaxAdapt =
      options.noiseMaxAdapt ?? 400;

    this.onSpeechStart =
      options.onSpeechStart ||
      (() => {});

    this.onSpeechEnd =
      options.onSpeechEnd ||
      (() => {});

    this.onVADState =
      options.onVADState ||
      (() => {});

    this.state = 'silence';

    this.candidateFrames = 0;
    this.speechFrames = 0;
    this.silenceFrameCount = 0;

    // Preserve incomplete 30 ms frames
    // across AudioWorklet chunks.
    this.pendingBytes =
      Buffer.alloc(0);
  }

  processChunk(pcmBuffer) {
    const chunk =
      Buffer.from(pcmBuffer || []);

    if (!chunk.length) {
      return;
    }

    if (chunk.length % 2 !== 0) {
      throw new Error(
        'VAD PCM must contain complete Int16 samples.'
      );
    }

    const input =
      this.pendingBytes.length
        ? Buffer.concat([
            this.pendingBytes,
            chunk
          ])
        : chunk;

    let offset = 0;

    while (
      offset + this.frameBytes <=
      input.length
    ) {
      const frame =
        input.subarray(
          offset,
          offset + this.frameBytes
        );

      const energy =
        this._computeRMS(frame);

      this._processFrame(
        energy
      );

      offset += this.frameBytes;
    }

    this.pendingBytes =
      Buffer.from(
        input.subarray(offset)
      );
  }

  _computeRMS(frame) {
    let sum = 0;

    const count =
      frame.length / 2;

    for (
      let offset = 0;
      offset < frame.length;
      offset += 2
    ) {
      const sample =
        frame.readInt16LE(offset);

      sum += sample * sample;
    }

    return Math.sqrt(
      sum /
      Math.max(
        1,
        count
      )
    );
  }

  _adaptNoiseFloor(energy) {
    if (
      energy >=
      this.noiseMaxAdapt
    ) {
      return;
    }

    this.noiseFloor =
      this.noiseFloor *
        (
          1 -
          this.noiseAdaptRate
        ) +
      energy *
        this.noiseAdaptRate;
  }

  _getThresholds() {
    return {
      onset:
        Math.max(
          this.onsetThreshold,
          this.noiseFloor * 2.0
        ),

      offset:
        Math.max(
          this.offsetThreshold,
          this.noiseFloor * 1.3
        )
    };
  }

  _confirmSpeech() {
    this.state = 'speech';

    this.speechFrames =
      this.candidateFrames;

    this.candidateFrames = 0;

    this.silenceFrameCount = 0;

    this.onSpeechStart();

    this.onVADState(
      'speech'
    );
  }

  _processFrame(energy) {
    const {
      onset,
      offset
    } =
      this._getThresholds();

    switch (this.state) {
      case 'silence': {
        this._adaptNoiseFloor(
          energy
        );

        if (
          energy >= onset
        ) {
          this.state =
            'candidate';

          this.candidateFrames =
            1;

          if (
            this.minSpeechFrames ===
            1
          ) {
            this._confirmSpeech();
          }
        }

        break;
      }

      case 'candidate': {
        // Candidate must be consecutive
        // strong speech.
        if (
          energy >= onset
        ) {
          this.candidateFrames +=
            1;

          if (
            this.candidateFrames >=
            this.minSpeechFrames
          ) {
            this._confirmSpeech();
          }

        } else {
          // False positive:
          // click, notification,
          // short burst, etc.
          this.state =
            'silence';

          this.candidateFrames =
            0;

          this._adaptNoiseFloor(
            energy
          );
        }

        break;
      }

      case 'speech': {
        // Hysteresis:
        //
        // onset = threshold to ENTER speech
        // offset = lower threshold to STAY in speech
        if (
          energy >= offset
        ) {
          this.speechFrames += 1;
          this.silenceFrameCount = 0;

        } else {
          this.state =
            'trailing';

          this.silenceFrameCount =
            1;
        }

        break;
      }

      case 'trailing': {
        if (
          energy >= offset
        ) {
          // Speech resumed.
          this.state =
            'speech';

          this.speechFrames +=
            1;

          this.silenceFrameCount =
            0;

        } else {
          this.silenceFrameCount +=
            1;

          if (
            this.silenceFrameCount >=
            this.silenceFrames
          ) {
            const durationMs =
              this.speechFrames *
              this.frameDurationMs;

            this.state =
              'silence';

            this.candidateFrames =
              0;

            this.speechFrames =
              0;

            this.silenceFrameCount =
              0;

            this.onSpeechEnd(
              durationMs
            );

            this.onVADState(
              'silence'
            );
          }
        }

        break;
      }
    }
  }

  getState() {
    return {
      state:
        this.state,

      isSpeaking:
        this.state === 'speech' ||
        this.state === 'trailing',

      noiseFloor:
        Math.round(
          this.noiseFloor
        ),

      speechDurationMs:
        this.speechFrames *
        this.frameDurationMs
    };
  }

  reset() {
    this.state =
      'silence';

    this.candidateFrames =
      0;

    this.speechFrames =
      0;

    this.silenceFrameCount =
      0;

    this.noiseFloor =
      this.initialNoiseFloor;

    this.pendingBytes =
      Buffer.alloc(0);
  }
}


class AudioRingBuffer {
  constructor(
    durationMs,
    sampleRate = 16000
  ) {
    this.capacity =
      Math.floor(
        sampleRate *
        2 *
        durationMs /
        1000
      );

    this.buffer =
      Buffer.alloc(
        this.capacity
      );

    this.writePos = 0;
    this.filled = false;
  }

  write(pcm) {
    const input =
      Buffer.from(pcm || []);

    if (!input.length) {
      return;
    }

    if (
      input.length >=
      this.capacity
    ) {
      input.copy(
        this.buffer,
        0,
        input.length -
          this.capacity
      );

      this.writePos = 0;
      this.filled = true;

      return;
    }

    const space =
      this.capacity -
      this.writePos;

    if (
      input.length <=
      space
    ) {
      input.copy(
        this.buffer,
        this.writePos
      );

      this.writePos +=
        input.length;

      if (
        this.writePos ===
        this.capacity
      ) {
        this.writePos = 0;
        this.filled = true;
      }

      return;
    }

    input.copy(
      this.buffer,
      this.writePos,
      0,
      space
    );

    input.copy(
      this.buffer,
      0,
      space
    );

    this.writePos =
      input.length -
      space;

    this.filled = true;
  }

  read() {
    if (!this.filled) {
      return this.buffer.subarray(
        0,
        this.writePos
      );
    }

    return Buffer.concat([
      this.buffer.subarray(
        this.writePos
      ),

      this.buffer.subarray(
        0,
        this.writePos
      )
    ]);
  }

  clear() {
    this.writePos = 0;
    this.filled = false;
  }
}


module.exports = {
  AdaptiveVAD,
  AudioRingBuffer
};