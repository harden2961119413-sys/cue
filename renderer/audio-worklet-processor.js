// renderer/audio-worklet-processor.js

class CueAudioProcessor
  extends AudioWorkletProcessor {

  constructor() {
    super();

    // 16 kHz:
    //
    // 960 samples = 60 ms
    //
    // This is also exactly two
    // 30 ms VAD frames.
    this._bufferSize = 960;

    this._buffer =
      new Float32Array(
        this._bufferSize
      );

    this._writeIndex = 0;
  }

  process(
    inputs,
    _outputs,
    _parameters
  ) {
    const input =
      inputs[0];

    if (
      !input ||
      !input[0]
    ) {
      return true;
    }

    const channelData =
      input[0];

    for (
      let index = 0;
      index <
      channelData.length;
      index += 1
    ) {
      this._buffer[
        this._writeIndex
      ] =
        channelData[index];

      this._writeIndex += 1;

      if (
        this._writeIndex >=
        this._bufferSize
      ) {
        this._flush();
      }
    }

    return true;
  }

  _flush() {
    if (
      this._writeIndex === 0
    ) {
      return;
    }

    const pcm =
      new Int16Array(
        this._writeIndex
      );

    for (
      let index = 0;
      index <
      this._writeIndex;
      index += 1
    ) {
      const sample =
        Math.max(
          -1,
          Math.min(
            1,
            this._buffer[
              index
            ]
          )
        );

      pcm[index] =
        sample < 0
          ? sample * 0x8000
          : sample * 0x7fff;
    }

    this.port.postMessage(
      pcm.buffer,
      [pcm.buffer]
    );

    this._buffer =
      new Float32Array(
        this._bufferSize
      );

    this._writeIndex = 0;
  }
}


registerProcessor(
  'cue-audio-processor',
  CueAudioProcessor
);