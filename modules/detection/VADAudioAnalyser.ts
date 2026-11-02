import { getLogger } from '@jitsi/logger';

import JitsiConference from '../../JitsiConference';
import { JitsiConferenceEvents } from '../../JitsiConferenceEvents';
import JitsiLocalTrack from '../RTC/JitsiLocalTrack';
import EventEmitter from '../util/EventEmitter';

import { DetectionEvents } from './DetectionEvents';
import TrackVADEmitter, { IVadProcessor, destroyVADProcessor } from './TrackVADEmitter';

const logger = getLogger('vad:VADAudioAnalyser');

/**
 * Sample rate of TrackVADEmitter, it defines how many audio samples are processed at a time.
 * @type {number}
 */
const VAD_EMITTER_SAMPLE_RATE: number = 4096;

export type IVADProcessor = IVadProcessor;

export interface IVADDetectionService {
    changeMuteState: (isMuted: boolean) => void;
    isActive: () => boolean;
    on: (event: string, handler: () => void) => void;
    processVADScore: (vadScore: IVADScore) => void;
    removeListener?: (event: string, handler: () => void) => void;
    reset: () => void;
}

export interface IVADScore {
    deviceId: string;
    pcmData: Float32Array | number[];
    score: number;
    timestamp: number;
}

/**
 * Connects a TrackVADEmitter to the target conference local audio track and manages various services that use
 * the data to produce audio analytics (VADTalkMutedDetection and VADNoiseDetection).
 */
export default class VADAudioAnalyser extends EventEmitter {
    private _createVADProcessor: () => IVADProcessor | Promise<IVADProcessor>;
    private _vadEmitter: Nullable<TrackVADEmitter>;
    private _isVADEmitterRunning: boolean;
    private _detectionServices: IVADDetectionService[];
    private _vadInitTracker: Promise<void>;
    private _conference: Nullable<JitsiConference>;
    private _destroyed = false;
    private _generation = 0;
    private _track: Nullable<JitsiLocalTrack> = null;
    private _detectorListeners = new Map<IVADDetectionService, () => void>();

    /**
     * Creates <tt>VADAudioAnalyser</tt>
     * @param {JitsiConference} conference - JitsiConference instance that created us.
     * @param {Object} createVADProcessor - Function that creates a Voice activity detection processor. The processor
     * needs to implement the following functions:
     * - <tt>getSampleLength()</tt> - Returns the sample size accepted by getSampleLength.
     * - <tt>getRequiredPCMFrequency()</tt> - Returns the PCM frequency at which the processor operates.
     * - <tt>calculateAudioFrameVAD(pcmSample)</tt> - Process a 32 float pcm sample of getSampleLength size.
     * @constructor
     */
    constructor(conference: JitsiConference, createVADProcessor: () => IVADProcessor | Promise<IVADProcessor>) {
        super();

        /**
         * Member function that instantiates a VAD processor.
         */
        this._createVADProcessor = createVADProcessor;

        /**
         * Current {@link TrackVADEmitter}. VAD Emitter uses a {@link JitsiLocalTrack} and VAD processor to generate
         * period voice probability scores.
         */
        this._vadEmitter = null;

        /**
         * Current state of the _vadEmitter
         */
        this._isVADEmitterRunning = false;

        /**
         * Array of currently attached VAD processing services.
         */
        this._detectionServices = [];

        /**
         * Promise used to chain create and destroy operations associated with TRACK_ADDED and TRACK_REMOVED events
         * coming from the conference.
         * Because we have an async created component (VAD Processor) we need to make sure that it's initialized before
         * we destroy it ( when changing the device for instance), or when we use it from an external point of entry
         * i.e. (TRACK_MUTE_CHANGED event callback).
         */
        this._vadInitTracker = Promise.resolve();

        /**
         * Listens for {@link TrackVADEmitter} events and processes them.
         */
        this._processVADScore = this._processVADScore.bind(this);

        this._conference = conference;
        this._trackAdded = this._trackAdded.bind(this);
        this._trackRemoved = this._trackRemoved.bind(this);
        this._trackMuteChanged = this._trackMuteChanged.bind(this);
        this.destroy = this.destroy.bind(this);
        conference.on(JitsiConferenceEvents.TRACK_ADDED, this._trackAdded);
        conference.on(JitsiConferenceEvents.TRACK_REMOVED, this._trackRemoved);
        conference.on(JitsiConferenceEvents.TRACK_MUTE_CHANGED, this._trackMuteChanged);
        conference.on(JitsiConferenceEvents.CONFERENCE_LEFT, this.destroy);
    }

    /**
     * Releases the current emitter without touching the conference microphone.
     */
    private _destroyVADEmitter(): void {
        this._stopVADEmitter();
        this._vadEmitter?.destroy();
        this._vadEmitter = null;
    }

    /**
     * Attach a VAD detector service to the analyser and handle it's state changes.
     *
     * @param {Object} vadTMDetector
     */
    addVADDetectionService(vadService: IVADDetectionService): void {
        if (this._destroyed || this._detectorListeners.has(vadService)) {
            return;
        }
        this._detectionServices.push(vadService);
        const listener = () => {
            if (this._destroyed) {
                return;
            }
            // When the state of a detector changes check if there are any active detectors attached so that
            // the _vadEmitter doesn't run needlessly.
            const activeDetector = this._detectionServices.filter(detector => detector.isActive() === true);

            // If there are no active detectors running and the vadEmitter is running then stop the emitter as it is
            // uses a considerable amount of CPU. Otherwise start the service if it's stopped and there is a detector
            // that needs it.
            if (!activeDetector.length && this._isVADEmitterRunning) {
                this._stopVADEmitter();
            } else if (activeDetector.length && !this._isVADEmitterRunning) {
                this._startVADEmitter();
            }
        };

        this._detectorListeners.set(vadService, listener);
        vadService.on(DetectionEvents.DETECTOR_STATE_CHANGE, listener);
    }

    /**
     * Start the {@link TrackVADEmitter} and attach the event listener.
     * @returns {void}
     */
    _startVADEmitter(): void {
        if (!this._destroyed && this._vadEmitter && !this._isVADEmitterRunning) {
            this._vadEmitter.on(DetectionEvents.VAD_SCORE_PUBLISHED, this._processVADScore);
            this._vadEmitter.start();
            this._isVADEmitterRunning = true;
        }
    }

    /**
     * Stop the {@link TrackVADEmitter} and detach the event listener.
     * @returns {void}
     */
    _stopVADEmitter(): void {
        if (this._vadEmitter) {
            this._vadEmitter.removeListener(DetectionEvents.VAD_SCORE_PUBLISHED, this._processVADScore);
            this._vadEmitter.stop();
        }
        this._isVADEmitterRunning = false;
    }

    /**
     * Listens for {@link TrackVADEmitter} events and directs them to attached services as needed.
     *
     * @param {Object} vadScore -VAD score emitted by {@link TrackVADEmitter}
     * @param {Date}   vadScore.timestamp - Exact time at which processed PCM sample was generated.
     * @param {number} vadScore.score - VAD score on a scale from 0 to 1 (i.e. 0.7)
     * @param {Float32Array} pcmData - Raw PCM data with which the VAD score was calculated.
     * @param {string} vadScore.deviceId - Device id of the associated track.
     * @listens VAD_SCORE_PUBLISHED
     */
    _processVADScore(vadScore: IVADScore): void {
        if (this._destroyed) {
            return;
        }
        for (const detector of this._detectionServices) {
            detector.processVADScore(vadScore);
        }
    }

    /**
     * Change the isMuted state of all attached detection services.
     *
     * @param {boolean} isMuted
     */
    _changeDetectorsMuteState(isMuted: boolean): void {
        for (const detector of this._detectionServices) {
            detector.changeMuteState(isMuted);
        }
    }

    /**
     * Notifies the detector that a track was added to the associated {@link JitsiConference}.
     * Only take into account local audio tracks.
     * @param {JitsiLocalTrack} track - The added track.
     * @returns {void}
     * @listens TRACK_ADDED
     */
    _trackAdded(track: JitsiLocalTrack): void {
        if (!this._destroyed && track.isLocalAudioTrack()) {
            this._track = track;
            const generation = ++this._generation;

            // Keep a track promise so we take into account successive TRACK_ADD events being generated so that we
            // destroy/create the processing context in the proper order.
            this._vadInitTracker = this._vadInitTracker.then(async () => {
                if (this._destroyed || generation !== this._generation) {
                    return;
                }
                this._destroyVADEmitter();
                const vadProcessor = await this._createVADProcessor();

                if (this._destroyed || generation !== this._generation) {
                    destroyVADProcessor(vadProcessor);

                    return;
                }
                let vadEmitter: TrackVADEmitter;

                try {
                    vadEmitter = await TrackVADEmitter.create(
                        track.getDeviceId(), VAD_EMITTER_SAMPLE_RATE, vadProcessor);
                } catch (error) {
                    destroyVADProcessor(vadProcessor);
                    throw error;
                }
                if (this._destroyed || generation !== this._generation) {
                    vadEmitter.destroy();

                    return;
                }
                try {
                    logger.debug('Created VAD emitter for track: ', track.getTrackLabel());

                    this._vadEmitter = vadEmitter;

                    // Iterate through the detection services and set their appropriate mute state, depending on
                    // service this will trigger a DETECTOR_STATE_CHANGE which in turn might start the _vadEmitter.
                    this._changeDetectorsMuteState(track.isMuted());
                } catch (error) {
                    this._destroyVADEmitter();
                    throw error;
                }
            })
                .catch(error => {
                    logger.warn('Failed to start VADAudioAnalyser', error);
                });
        }
    }

    /**
     * Notifies the detector that the mute state of a {@link JitsiConference} track has changed. Only takes into account
     * local audio tracks.
     * @param {JitsiLocalTrack} track - The track whose mute state has changed.
     * @returns {void}
     * @listens TRACK_MUTE_CHANGED
     */
    _trackMuteChanged(track: JitsiLocalTrack): void {
        if (!this._destroyed && track === this._track) {
            // On a mute toggle reset the state.
            this._vadInitTracker = this._vadInitTracker.then(() => {
                if (this._destroyed || track !== this._track) {
                    return;
                }
                // Set mute status for the attached detection services.
                this._changeDetectorsMuteState(track.isMuted());
            }).catch(error => logger.warn('Failed to update VAD mute state', error));
        }
    }

    /**
     * Notifies the detector that a track associated with the {@link JitsiConference} was removed. Only takes into
     * account local audio tracks. Cleans up resources associated with the track and resets the processing context.
     *
     * @param {JitsiLocalTrack} track - The removed track.
     * @returns {void}
     * @listens TRACK_REMOVED
     */
    _trackRemoved(track: JitsiLocalTrack): void {
        if (!this._destroyed && track === this._track) {
            this._track = null;
            ++this._generation;
            // Use the promise to make sure operations are in sequence.
            this._vadInitTracker = this._vadInitTracker.then(() => {
                logger.debug('Removing track from VAD detection - ', track.getTrackLabel());

                // Track was removed, clean up and set appropriate states.
                this._destroyVADEmitter();

                // Reset state of detectors when active track is removed.
                for (const detector of this._detectionServices) {
                    detector.reset();
                }
            }).catch(error => logger.warn('Failed to remove VAD track', error));
        }
    }

    /**
     * Stops detection permanently, including pending asynchronous initialization.
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;
        ++this._generation;
        this._track = null;
        this._conference?.off(JitsiConferenceEvents.TRACK_ADDED, this._trackAdded);
        this._conference?.off(JitsiConferenceEvents.TRACK_REMOVED, this._trackRemoved);
        this._conference?.off(JitsiConferenceEvents.TRACK_MUTE_CHANGED, this._trackMuteChanged);
        this._conference?.off(JitsiConferenceEvents.CONFERENCE_LEFT, this.destroy);
        this._conference = null;
        this._destroyVADEmitter();
        for (const [ detector, listener ] of this._detectorListeners) {
            detector.removeListener?.(DetectionEvents.DETECTOR_STATE_CHANGE, listener);
            detector.reset();
        }
        this._detectorListeners.clear();
        this._detectionServices = [];
        this.removeAllListeners();
    }
}
