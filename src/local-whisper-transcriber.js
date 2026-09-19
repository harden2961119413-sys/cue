// src/local-whisper-transcriber.js

const {
  UtteranceSegmenter
} =
  require(
    './utterance-segmenter'
  );

const {
  WhisperServerSession
} =
  require(
    './whisper-server-session'
  );

const {
  LocalAsrScheduler
} =
  require(
    './local-asr-scheduler'
  );


const CHANNELS =
  Object.freeze([
    'you',
    'them'
  ]);

const DEFAULT_DRAIN_TIMEOUT_MS =
  15000;


class LocalWhisperTranscriber {
  constructor({
    sessionOptions,

    sessionFactory =
      (options) =>
        new WhisperServerSession(
          options
        ),

    segmenterFactory =
      (options) =>
        new UtteranceSegmenter(
          options
        ),

    drainTimeoutMs =
      DEFAULT_DRAIN_TIMEOUT_MS,

    onTranscript =
      () => {},

    onInterim =
      () => {},

    onSpeechState =
      () => {},

    onStatus =
      () => {},

    onMetrics =
      () => {},

    onError =
      () => {}
  }) {
    this.session =
      sessionFactory({
        ...sessionOptions,

        onState:
          onStatus
      });

    this.segmenterFactory =
      segmenterFactory;

    this.drainTimeoutMs =
      drainTimeoutMs;

    this.onTranscript =
      onTranscript;

    this.onInterim =
      onInterim;

    this.onSpeechState =
      onSpeechState;

    this.onStatus =
      onStatus;

    this.onMetrics =
      onMetrics;

    this.onError =
      onError;

    this.segmenters =
      new Map();

    this.acceptingAudio =
      false;

    this.discardPendingJobs =
      false;

    this.stopping =
      false;

    this.scheduler =
      new LocalAsrScheduler({
        transcribe:
          (pcm) =>
            this.session
              .transcribe(pcm),

        onInterim:
          (
            channel,
            text
          ) => {
            if (
              this.discardPendingJobs
            ) {
              return;
            }

            this.onInterim(
              channel,
              text
            );
          },

        onFinal:
          (
            channel,
            text
          ) => {
            if (
              this.discardPendingJobs
            ) {
              return;
            }

            // Remove an interim before
            // publishing the definitive
            // transcript.
            this.onInterim(
              channel,
              ''
            );

            this.onTranscript(
              channel,
              text
            );
          },

        onBusyChange:
          ({
            busy,
            channel
          }) => {
            if (
              this.stopping
            ) {
              return;
            }

            if (busy) {
              this.onStatus({
                status:
                  'transcribing',

                channel,

                pending:
                  this.scheduler
                    .pendingCount()
              });

            } else if (
              this.acceptingAudio
            ) {
              this.onStatus({
                status:
                  'ready',

                message:
                  'Local Whisper is ready.'
              });
            }
          },

        onMetrics:
          (metrics) =>
            this.onMetrics(
              metrics
            ),

        onError:
          (error) => {
            if (
              !this.discardPendingJobs
            ) {
              this.onError(
                error
              );
            }
          }
      });
  }

  async start() {
    this.stopping = false;

    this.discardPendingJobs =
      false;

    await this.session.start();

    for (
      const channel of
      CHANNELS
    ) {
      const isRemoteAudio =
        channel === 'them';

      this.segmenters.set(
        channel,

        this.segmenterFactory({
          channel,

          // Interviewer needs much
          // lower latency than candidate
          // self-transcription.
          maxUtteranceMs:
            isRemoteAudio
              ? 7000
              : 10000,

          // Only produce rolling
          // previews for interviewer.
          //
          // This keeps local CPU load
          // controlled.
          previewIntervalMs:
            isRemoteAudio
              ? 900
              : 0,

          previewWindowMs:
            5000,

          minPreviewMs:
            1200,

          vadOptions: {
            onsetThreshold:
              isRemoteAudio
                ? 150
                : 170,

            offsetThreshold:
              isRemoteAudio
                ? 90
                : 100,

            silenceFrames:
              isRemoteAudio
                ? 12
                : 14,

            minSpeechFrames:
              3
          },

          onSpeechState:
            (
              speechChannel,
              speaking,
              durationMs
            ) => {
              this.onSpeechState(
                speechChannel,
                speaking,
                durationMs
              );
            },

          onPreview:
            (
              previewChannel,
              pcm,
              meta
            ) => {
              if (
                !this.acceptingAudio
              ) {
                return;
              }

              // Preview is deliberately
              // interviewer-only.
              if (
                previewChannel !==
                'them'
              ) {
                return;
              }

              this.scheduler
                .scheduleInterim(
                  previewChannel,
                  pcm,
                  meta
                );
            },

          onUtterance:
            (
              utteranceChannel,
              pcm,
              meta
            ) => {
              this.scheduler
                .scheduleFinal(
                  utteranceChannel,
                  pcm,
                  meta
                );
            }
        })
      );
    }

    this.acceptingAudio =
      true;
  }

  push(
    channel,
    pcm
  ) {
    if (
      !this.acceptingAudio
    ) {
      return;
    }

    const segmenter =
      this.segmenters.get(
        channel
      );

    if (!segmenter) {
      throw new Error(
        `Unknown local Whisper channel: ${channel}`
      );
    }

    segmenter.push(
      pcm
    );
  }

  async stop() {
    this.stopping = true;

    this.acceptingAudio =
      false;

    // Flush active utterances as final.
    for (
      const segmenter of
      this.segmenters.values()
    ) {
      segmenter.stop();
    }

    const drained =
      await this.scheduler.drain(
        this.drainTimeoutMs
      );

    if (!drained) {
      this.discardPendingJobs =
        true;

      this.scheduler
        .clearPending();

      this.session
        .abortInferences();
    }

    await this.session.stop({
      force:
        !drained
    });

    this.segmenters.clear();

    this.onStatus({
      status:
        'off',

      message:
        'Local Whisper stopped.'
    });
  }

  forceStop() {
    this.stopping = true;

    this.acceptingAudio =
      false;

    this.discardPendingJobs =
      true;

    this.scheduler
      .clearPending();

    this.session
      .abortInferences();

    this.segmenters.clear();

    return this.session.stop({
      force: true
    });
  }
}


module.exports = {
  LocalWhisperTranscriber,
  CHANNELS,
  DEFAULT_DRAIN_TIMEOUT_MS
};