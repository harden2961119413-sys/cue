const assert =
  require('node:assert/strict');

const test =
  require('node:test');

const {
  UtteranceSegmenter
} =
  require(
    '../src/utterance-segmenter'
  );


const FRAME_SAMPLES = 480;

const FRAME_BYTES =
  FRAME_SAMPLES * 2;


function frame(amplitude) {
  const buffer =
    Buffer.alloc(
      FRAME_BYTES
    );

  for (
    let offset = 0;
    offset < buffer.length;
    offset += 2
  ) {
    buffer.writeInt16LE(
      amplitude,
      offset
    );
  }

  return buffer;
}


function pushFrames(
  segmenter,
  amplitude,
  count
) {
  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    segmenter.push(
      frame(amplitude)
    );
  }
}


test(
  'includes pre-roll and emits after configured trailing silence',
  () => {
    const utterances = [];
    const speechStates = [];

    const segmenter =
      new UtteranceSegmenter({
        channel: 'you',

        preRollMs: 300,

        vadOptions: {
          onsetThreshold: 200,
          offsetThreshold: 100,

          minSpeechFrames: 3,
          silenceFrames: 3,

          noiseAdaptRate: 0
        },

        onSpeechState:
          (
            _channel,
            speaking
          ) =>
            speechStates.push(
              speaking
            ),

        onUtterance:
          (
            _channel,
            pcm
          ) =>
            utterances.push(
              pcm
            )
      });

    // Fill the 300 ms pre-roll.
    pushFrames(
      segmenter,
      0,
      10
    );

    // 240 ms speech.
    pushFrames(
      segmenter,
      1200,
      8
    );

    // 90 ms endpoint.
    pushFrames(
      segmenter,
      0,
      3
    );

    assert.equal(
      utterances.length,
      1
    );

    assert.deepEqual(
      speechStates,
      [
        true,
        false
      ]
    );

    // At confirmation time the
    // 300ms ring contains the most
    // recent 10 frames. Then the
    // remaining speech + trailing
    // silence is appended.
    assert.equal(
      utterances[0].length,
      FRAME_BYTES * 18
    );
  }
);


test(
  'short false-positive burst does not create an utterance',
  () => {
    const utterances = [];

    const segmenter =
      new UtteranceSegmenter({
        channel: 'them',

        vadOptions: {
          onsetThreshold: 200,
          offsetThreshold: 100,

          minSpeechFrames: 3,
          silenceFrames: 3,

          noiseAdaptRate: 0
        },

        onUtterance:
          (
            _channel,
            pcm
          ) =>
            utterances.push(
              pcm
            )
      });

    pushFrames(
      segmenter,
      1000,
      2
    );

    pushFrames(
      segmenter,
      0,
      10
    );

    assert.equal(
      utterances.length,
      0
    );
  }
);


test(
  'flushes an active utterance when capture stops',
  () => {
    const utterances = [];

    const segmenter =
      new UtteranceSegmenter({
        channel: 'them',

        vadOptions: {
          onsetThreshold: 200,
          offsetThreshold: 100,

          minSpeechFrames: 3,
          silenceFrames: 3,

          noiseAdaptRate: 0
        },

        onUtterance:
          (
            _channel,
            pcm
          ) =>
            utterances.push(
              pcm
            )
      });

    pushFrames(
      segmenter,
      1000,
      8
    );

    segmenter.stop();

    assert.equal(
      utterances.length,
      1
    );

    assert.ok(
      utterances[0].length >=
      FRAME_BYTES * 8
    );
  }
);


test(
  'splits long speech into bounded final segments',
  () => {
    const utterances = [];

    const segmenter =
      new UtteranceSegmenter({
        channel: 'you',

        preRollMs: 60,

        minUtteranceMs: 30,

        maxUtteranceMs: 300,

        previewIntervalMs: 0,

        vadOptions: {
          onsetThreshold: 200,
          offsetThreshold: 100,

          minSpeechFrames: 3,

          noiseAdaptRate: 0
        },

        onUtterance:
          (
            _channel,
            pcm
          ) =>
            utterances.push(
              pcm
            )
      });

    pushFrames(
      segmenter,
      1000,
      24
    );

    segmenter.stop();

    assert.ok(
      utterances.length >= 3
    );

    assert.ok(
      utterances.every(
        (pcm) =>
          pcm.length <=
          FRAME_BYTES * 10
      )
    );
  }
);


test(
  'emits rolling previews before the final endpoint',
  () => {
    const previews = [];
    const finals = [];

    const segmenter =
      new UtteranceSegmenter({
        channel: 'them',

        previewIntervalMs: 90,
        previewWindowMs: 300,
        minPreviewMs: 90,

        vadOptions: {
          onsetThreshold: 200,
          offsetThreshold: 100,

          minSpeechFrames: 3,
          silenceFrames: 3,

          noiseAdaptRate: 0
        },

        onPreview:
          (
            _channel,
            pcm
          ) =>
            previews.push(
              pcm
            ),

        onUtterance:
          (
            _channel,
            pcm
          ) =>
            finals.push(
              pcm
            )
      });

    pushFrames(
      segmenter,
      1000,
      8
    );

    assert.ok(
      previews.length >= 1
    );

    assert.equal(
      finals.length,
      0
    );

    pushFrames(
      segmenter,
      0,
      3
    );

    assert.equal(
      finals.length,
      1
    );
  }
);