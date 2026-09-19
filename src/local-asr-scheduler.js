// src/local-asr-scheduler.js

const CHANNELS =
  Object.freeze([
    'you',
    'them'
  ]);

const CHANNEL_PRIORITY =
  Object.freeze([
    'them',
    'you'
  ]);

const DEFAULT_MAX_FINALS =
  3;


class LocalAsrScheduler {
  constructor({
    transcribe,

    onInterim =
      () => {},

    onFinal =
      () => {},

    onBusyChange =
      () => {},

    onMetrics =
      () => {},

    onError =
      () => {},

    maxPendingFinalsPerChannel =
      DEFAULT_MAX_FINALS,

    now =
      Date.now
  }) {
    if (
      typeof transcribe !==
      'function'
    ) {
      throw new Error(
        'LocalAsrScheduler requires transcribe().'
      );
    }

    this.transcribe =
      transcribe;

    this.onInterim =
      onInterim;

    this.onFinal =
      onFinal;

    this.onBusyChange =
      onBusyChange;

    this.onMetrics =
      onMetrics;

    this.onError =
      onError;

    this.maxPendingFinalsPerChannel =
      maxPendingFinalsPerChannel;

    this.now = now;

    this.sequence = 0;

    this.runningJob = null;

    this.latestInterim =
      new Map();

    this.finalQueues =
      new Map(
        CHANNELS.map(
          (channel) => [
            channel,
            []
          ]
        )
      );

    this.finalGeneration =
      new Map(
        CHANNELS.map(
          (channel) => [
            channel,
            0
          ]
        )
      );
  }

  scheduleInterim(
    channel,
    pcm,
    meta = {}
  ) {
    this._requireChannel(
      channel
    );

    const buffer =
      Buffer.from(pcm || []);

    if (!buffer.length) {
      return;
    }

    const job =
      this._createJob({
        channel,
        kind: 'interim',
        pcm: buffer,
        meta,

        finalGeneration:
          this.finalGeneration.get(
            channel
          )
      });

    // Latest-only queue.
    //
    // If inference is slower than the
    // preview cadence, stale snapshots
    // are discarded instead of creating
    // latency backlog.
    this.latestInterim.set(
      channel,
      job
    );

    this._pump();
  }

  scheduleFinal(
    channel,
    pcm,
    meta = {}
  ) {
    this._requireChannel(
      channel
    );

    const buffer =
      Buffer.from(pcm || []);

    if (!buffer.length) {
      return;
    }

    const generation =
      (
        this.finalGeneration.get(
          channel
        ) || 0
      ) + 1;

    this.finalGeneration.set(
      channel,
      generation
    );

    // Any pending preview for this
    // utterance is obsolete once the
    // endpoint arrives.
    this.latestInterim.delete(
      channel
    );

    const queue =
      this.finalQueues.get(
        channel
      );

    queue.push(
      this._createJob({
        channel,
        kind: 'final',
        pcm: buffer,
        meta,
        finalGeneration:
          generation
      })
    );

    // Never allow memory / latency to
    // grow without bound.
    while (
      queue.length >
      this.maxPendingFinalsPerChannel
    ) {
      const dropped =
        queue.shift();

      this.onMetrics({
        channel,
        kind:
          'dropped-final',

        reason:
          'backpressure',

        audioMs:
          dropped.audioMs
      });
    }

    this._pump();
  }

  pendingCount() {
    let count =
      this.runningJob
        ? 1
        : 0;

    for (
      const channel of CHANNELS
    ) {
      count +=
        this.finalQueues
          .get(channel)
          .length;

      if (
        this.latestInterim.has(
          channel
        )
      ) {
        count += 1;
      }
    }

    return count;
  }

  clearPending() {
    this.latestInterim.clear();

    for (
      const queue of
      this.finalQueues.values()
    ) {
      queue.length = 0;
    }
  }

  async drain(
    timeoutMs = 15000
  ) {
    const deadline =
      this.now() +
      timeoutMs;

    while (
      this.pendingCount() > 0
    ) {
      if (
        this.now() >=
        deadline
      ) {
        return false;
      }

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            20
          )
      );
    }

    return true;
  }

  _createJob({
    channel,
    kind,
    pcm,
    meta,
    finalGeneration
  }) {
    this.sequence += 1;

    return {
      sequence:
        this.sequence,

      channel,
      kind,
      pcm,
      meta,

      finalGeneration,

      createdAt:
        this.now(),

      audioMs:
        Math.round(
          pcm.length /
          2 /
          16000 *
          1000
        )
    };
  }

  _takeNextJob() {
    // Finals always win.
    //
    // Interviewer channel wins before
    // candidate channel.
    for (
      const channel of
      CHANNEL_PRIORITY
    ) {
      const queue =
        this.finalQueues.get(
          channel
        );

      if (queue.length) {
        return queue.shift();
      }
    }

    // Only then spend CPU on previews.
    for (
      const channel of
      CHANNEL_PRIORITY
    ) {
      const interim =
        this.latestInterim.get(
          channel
        );

      if (interim) {
        this.latestInterim.delete(
          channel
        );

        return interim;
      }
    }

    return null;
  }

  _pump() {
    if (this.runningJob) {
      return;
    }

    const job =
      this._takeNextJob();

    if (!job) {
      this.onBusyChange({
        busy: false,
        pending: 0
      });

      return;
    }

    this.runningJob = job;

    this.onBusyChange({
      busy: true,

      channel:
        job.channel,

      kind:
        job.kind,

      pending:
        this.pendingCount()
    });

    void this._execute(job);
  }

  async _execute(job) {
    const startedAt =
      this.now();

    const queueMs =
      startedAt -
      job.createdAt;

    try {
      const text =
        await this.transcribe(
          job.pcm
        );

      const finishedAt =
        this.now();

      const inferenceMs =
        finishedAt -
        startedAt;

      const rtf =
        job.audioMs > 0
          ? inferenceMs /
            job.audioMs
          : 0;

      this.onMetrics({
        channel:
          job.channel,

        kind:
          job.kind,

        audioMs:
          job.audioMs,

        queueMs,

        inferenceMs,

        rtf,

        pending:
          this.pendingCount()
      });

      const trimmed =
        String(
          text || ''
        ).trim();

      if (!trimmed) {
        return;
      }

      if (
        job.kind ===
        'interim'
      ) {
        // A final endpoint may have
        // arrived while this inference
        // was running.
        //
        // Do not publish a now-stale
        // preview after that endpoint.
        if (
          this.finalGeneration.get(
            job.channel
          ) !==
          job.finalGeneration
        ) {
          return;
        }

        this.onInterim(
          job.channel,
          trimmed,
          job.meta
        );

        return;
      }

      this.onFinal(
        job.channel,
        trimmed,
        job.meta
      );

    } catch (error) {
      this.onError(
        error,
        job
      );

    } finally {
      this.runningJob = null;

      queueMicrotask(
        () => this._pump()
      );
    }
  }

  _requireChannel(channel) {
    if (
      !CHANNELS.includes(
        channel
      )
    ) {
      throw new Error(
        `Unknown ASR channel: ${channel}`
      );
    }
  }
}


module.exports = {
  LocalAsrScheduler
};