const assert =
  require('node:assert/strict');

const test =
  require('node:test');

const {
  LocalAsrScheduler
} =
  require(
    '../src/local-asr-scheduler'
  );


function nextTurn() {
  return new Promise(
    (resolve) =>
      setImmediate(resolve)
  );
}


test(
  'keeps only the latest pending interim snapshot',
  async () => {
    const started = [];
    const resolvers = [];
    const interims = [];

    const scheduler =
      new LocalAsrScheduler({
        transcribe:
          (pcm) =>
            new Promise(
              (resolve) => {
                started.push(
                  pcm.toString()
                );

                resolvers.push(
                  resolve
                );
              }
            ),

        onInterim:
          (_channel, text) =>
            interims.push(text)
      });

    scheduler.scheduleInterim(
      'them',
      Buffer.from('one')
    );

    await nextTurn();

    assert.deepEqual(
      started,
      ['one']
    );

    // These arrive while "one"
    // is still running.
    scheduler.scheduleInterim(
      'them',
      Buffer.from('two')
    );

    scheduler.scheduleInterim(
      'them',
      Buffer.from('three')
    );

    // Finish #1.
    resolvers[0](
      'result one'
    );

    await nextTurn();
    await nextTurn();

    // "two" must have been replaced
    // by the latest snapshot.
    assert.deepEqual(
      started,
      [
        'one',
        'three'
      ]
    );

    resolvers[1](
      'result three'
    );

    assert.equal(
      await scheduler.drain(
        1000
      ),
      true
    );

    assert.deepEqual(
      interims,
      [
        'result one',
        'result three'
      ]
    );
  }
);


test(
  'prioritizes interviewer final audio over candidate final audio',
  async () => {
    const started = [];
    const resolvers = [];

    const scheduler =
      new LocalAsrScheduler({
        transcribe:
          (pcm) =>
            new Promise(
              (resolve) => {
                started.push(
                  pcm.toString()
                );

                resolvers.push(
                  resolve
                );
              }
            )
      });

    // Occupy inference first.
    scheduler.scheduleInterim(
      'you',
      Buffer.from(
        'running-preview'
      )
    );

    await nextTurn();

    scheduler.scheduleFinal(
      'you',
      Buffer.from(
        'you-final'
      )
    );

    scheduler.scheduleFinal(
      'them',
      Buffer.from(
        'them-final'
      )
    );

    resolvers[0](
      'preview result'
    );

    await nextTurn();
    await nextTurn();

    assert.equal(
      started[1],
      'them-final'
    );

    resolvers[1](
      'them result'
    );

    await nextTurn();
    await nextTurn();

    assert.equal(
      started[2],
      'you-final'
    );

    resolvers[2](
      'you result'
    );

    assert.equal(
      await scheduler.drain(
        1000
      ),
      true
    );
  }
);


test(
  'does not publish an interim that became stale after final endpoint',
  async () => {
    const started = [];
    const resolvers = [];

    const interims = [];
    const finals = [];

    const scheduler =
      new LocalAsrScheduler({
        transcribe:
          (pcm) =>
            new Promise(
              (resolve) => {
                started.push(
                  pcm.toString()
                );

                resolvers.push(
                  resolve
                );
              }
            ),

        onInterim:
          (_channel, text) =>
            interims.push(text),

        onFinal:
          (_channel, text) =>
            finals.push(text)
      });

    scheduler.scheduleInterim(
      'them',
      Buffer.from(
        'preview'
      )
    );

    await nextTurn();

    // Endpoint occurs before the
    // preview inference finishes.
    scheduler.scheduleFinal(
      'them',
      Buffer.from(
        'final'
      )
    );

    resolvers[0](
      'stale preview'
    );

    await nextTurn();
    await nextTurn();

    // Old interim must be suppressed.
    assert.deepEqual(
      interims,
      []
    );

    assert.equal(
      started[1],
      'final'
    );

    resolvers[1](
      'final transcript'
    );

    assert.equal(
      await scheduler.drain(
        1000
      ),
      true
    );

    assert.deepEqual(
      finals,
      [
        'final transcript'
      ]
    );
  }
);