const assert =
  require('node:assert/strict');

const test =
  require('node:test');

const {
  AdaptiveVAD
} =
  require('../src/vad');


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


function makeVad(events) {
  return new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 100,

    minSpeechFrames: 3,
    silenceFrames: 3,

    noiseAdaptRate: 0,

    onSpeechStart:
      () =>
        events.push('start'),

    onSpeechEnd:
      () =>
        events.push('end')
  });
}


test(
  'short burst does not become confirmed speech',
  () => {
    const events = [];

    const vad =
      makeVad(events);

    vad.processChunk(
      frame(1000)
    );

    vad.processChunk(
      frame(1000)
    );

    // Only two strong frames.
    // minSpeechFrames = 3.
    vad.processChunk(
      frame(0)
    );

    vad.processChunk(
      frame(0)
    );

    vad.processChunk(
      frame(0)
    );

    assert.deepEqual(
      events,
      []
    );

    assert.equal(
      vad.getState().state,
      'silence'
    );
  }
);


test(
  'confirmed speech ends after trailing silence',
  () => {
    const events = [];

    const vad =
      makeVad(events);

    for (
      let i = 0;
      i < 5;
      i += 1
    ) {
      vad.processChunk(
        frame(1000)
      );
    }

    assert.deepEqual(
      events,
      ['start']
    );

    for (
      let i = 0;
      i < 3;
      i += 1
    ) {
      vad.processChunk(
        frame(0)
      );
    }

    assert.deepEqual(
      events,
      [
        'start',
        'end'
      ]
    );

    assert.equal(
      vad.getState().state,
      'silence'
    );
  }
);


test(
  'preserves incomplete VAD frames across arbitrary PCM chunks',
  () => {
    const alignedEvents = [];
    const chunkedEvents = [];

    const aligned =
      makeVad(
        alignedEvents
      );

    const chunked =
      makeVad(
        chunkedEvents
      );

    const pcm =
      Buffer.concat([
        frame(0),
        frame(0),

        frame(1000),
        frame(1000),
        frame(1000),
        frame(1000),

        frame(0),
        frame(0),
        frame(0),
        frame(0)
      ]);

    // Reference:
    // exact 30 ms frames.
    for (
      let offset = 0;
      offset < pcm.length;
      offset += FRAME_BYTES
    ) {
      aligned.processChunk(
        pcm.subarray(
          offset,
          offset + FRAME_BYTES
        )
      );
    }

    // Feed exactly the same PCM
    // using deliberately awkward
    // chunk boundaries.
    const chunkSizes = [
      1000,
      734,
      1550,
      622,
      2048,
      918
    ];

    let offset = 0;
    let index = 0;

    while (
      offset < pcm.length
    ) {
      let size =
        chunkSizes[
          index %
          chunkSizes.length
        ];

      // Int16 alignment.
      if (size % 2 !== 0) {
        size += 1;
      }

      const end =
        Math.min(
          pcm.length,
          offset + size
        );

      chunked.processChunk(
        pcm.subarray(
          offset,
          end
        )
      );

      offset = end;
      index += 1;
    }

    assert.deepEqual(
      chunkedEvents,
      alignedEvents
    );

    assert.deepEqual(
      chunkedEvents,
      [
        'start',
        'end'
      ]
    );
  }
);