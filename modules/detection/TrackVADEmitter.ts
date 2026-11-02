import { getLogger } from '@jitsi/logger';

import JitsiLocalTrack from '../RTC/JitsiLocalTrack';
import RTC from '../RTC/RTC';
import EventEmitter from '../util/EventEmitter';
import { createAudioContext } from '../webaudio/WebAudioUtils';

import { DetectionEvents } from './DetectionEvents';

export interface IVadProcessor {
    calculateAudioFrameVAD: (pcmSample: Float32Array | number[]) => number;
    destroy?: () => void | Promise<void>;
    getRequiredPCMFrequency: () => number;
    getSampleLength: () => number;
}

const logger = getLogger('vad:TrackVADEmitter');

/**
 * Releases processors supporting disposal while remaining compatible with older implementations.
 */
export function destroyVADProcessor(processor: IVadProcessor): void {
    try {
        Promise.resolve(processor.destroy?.()).catch(error => logger.warn('Failed to destroy VAD processor', error));
    } catch (error) {
        logger.warn('Failed to destroy VAD processor', error);
    }
}

export type AudioContextType = AudioContext;
export type ScriptProcessorNodeType = ScriptProcessorNode;
export type MediaStreamAudioSourceNodeType = MediaStreamAudioSourceNode;

/**
 * Connects an audio JitsiLocalTrack to a vadProcessor using WebAudio ScriptProcessorNode.
 * Once an object is created audio from the local track flows through the ScriptProcessorNode as raw PCM.
 * The PCM is processed by the injected vad module and a voice activity detection score is obtained, the
 * score is published to consumers via an EventEmitter.
 * After work is done with this service the destroy method needs to be called for a proper cleanup.
 * Successful construction transfers processor ownership; direct construction borrows the track,
 * whereas create() acquires and owns a separate VAD capture.
 *
 * @fires VAD_SCORE_PUBLISHED
 */
export default class TrackVADEmitter extends EventEmitter {
    private _procNodeSampleRate: number;
    private _vadProcessor: Nullable<IVadProcessor>;
    private _localTrack: Nullable<JitsiLocalTrack>;
    private _bufferResidue: Float32Array;
    private _audioContext: Nullable<AudioContextType>;
    private _vadSampleSize: number;
    private _audioSource?: MediaStreamAudioSourceNodeType;
    private _audioProcessingNode?: ScriptProcessorNodeType;
    private _destroyed = false;
    private _running = false;
    private _generation = 0;
    private _ownsTrack = false;

    /**
     * Constructor.
     *
     * @param {number} procNodeSampleRate - Sample rate of the ScriptProcessorNode. Possible values  256, 512, 1024,
     *  2048, 4096, 8192, 16384. Passing other values will default to closes neighbor.
     * @param {Object} vadProcessor - VAD processor that allows us to calculate VAD score for PCM samples.
     * @param {JitsiLocalTrack} jitsiLocalTrack - JitsiLocalTrack corresponding to micDeviceId.
     * Direct construction borrows this track; it must never stop the published microphone.
     * @param {boolean} ownsTrack - Whether the track was captured exclusively for VAD.
     */
    constructor(
            procNodeSampleRate: number,
            vadProcessor: IVadProcessor,
            jitsiLocalTrack: JitsiLocalTrack,
            ownsTrack = false) {
        super();

        /**
         * Sample rate of the ScriptProcessorNode.
         */
        this._procNodeSampleRate = procNodeSampleRate;

        /**
         * VAD Processor that allows us to calculate VAD score for PCM samples
         */
        this._vadProcessor = vadProcessor;

        /**
         * The JitsiLocalTrack instance.
         */
        this._localTrack = jitsiLocalTrack;

        /**
         * Buffer to hold residue PCM resulting after a ScriptProcessorNode callback
         */
        this._bufferResidue = new Float32Array([]);

        /**
         * Event listener function that will be called by the ScriptProcessNode with raw PCM data, depending on the set
         * sample rate.
         */
        this._onAudioProcess = this._onAudioProcess.bind(this);

        try {
            this._audioContext = createAudioContext({ sampleRate: vadProcessor.getRequiredPCMFrequency() });
            if (!this._audioContext) {
                throw new Error('Web Audio is unavailable for VAD');
            }
            this._vadSampleSize = vadProcessor.getSampleLength();
            this._initializeAudioContext();
            this._ownsTrack = ownsTrack;
        } catch (error) {
            this._cleanupResources();
            throw error;
        }
    }

    /**
     * Factory method that sets up all the necessary components for the creation of the TrackVADEmitter.
     *
     * @param {string} micDeviceId - Target microphone device id.
     * @param {number} procNodeSampleRate - Sample rate of the proc node.
     * @param {Object} vadProcessor -Module that calculates the voice activity score for a certain audio PCM sample.
     * The processor needs to implement the following functions:
     * - <tt>getSampleLength()</tt> - Returns the sample size accepted by getSampleLength.
     * - <tt>getRequiredPCMFrequency()</tt> - Returns the PCM frequency at which the processor operates.
     * - <tt>calculateAudioFrameVAD(pcmSample)</tt> - Process a 32 float pcm sample of getSampleLength size.
     * Ownership of the processor transfers only on success. On rejection the caller must dispose it.
     * @returns {Promise<TrackVADEmitter>} - Promise resolving in a new instance of TrackVADEmitter.
     */
    static create(
            micDeviceId: string,
            procNodeSampleRate: number,
            vadProcessor: IVadProcessor
    ): Promise<TrackVADEmitter> {
        return RTC.obtainAudioAndVideoPermissions({
            devices: [ 'audio' ],
            micDeviceId
        }).then((localTrack: JitsiLocalTrack[]) => {
            // We only expect one audio track when specifying a device id.
            if (!localTrack[0]) {
                throw new Error(`Failed to create jitsi local track for device id: ${micDeviceId}`);
            }

            try {
                return new TrackVADEmitter(procNodeSampleRate, vadProcessor, localTrack[0], true);
            } catch (error) {
                for (const track of localTrack) {
                    try {
                        track.stopStream();
                    } catch (stopError) {
                        logger.warn('Failed to stop VAD capture', stopError);
                    }
                }
                throw error;
            }
        });
    }

    /**
     * Sets up the audio graph in the AudioContext.
     *
     * @returns {void}
     */
    _initializeAudioContext(): void {
        this._audioSource = this._audioContext.createMediaStreamSource(this._localTrack.stream);

        // TODO AudioProcessingNode is deprecated in the web audio specifications and the recommended replacement
        // is audio worklet, however at the point of implementation AudioProcessingNode was still de de facto way
        // of achieving this functionality and supported in all major browsers as opposed to audio worklet which
        // was only available in Chrome. This todo is just a reminder that we should replace AudioProcessingNode
        // with audio worklet when it's mature enough and has more browser support.
        // We don't need stereo for determining the VAD score so we create a single channel processing node.
        this._audioProcessingNode = this._audioContext.createScriptProcessor(this._procNodeSampleRate, 1, 1);
    }

    /**
     * ScriptProcessorNode callback, the input parameters contains the PCM audio that is then sent to rnnoise.
     * Rnnoise only accepts PCM samples of 480 bytes whereas the webaudio processor node can't sample at a multiple
     * of 480 thus after each _onAudioProcess callback there will remain and PCM buffer residue equal
     * to _procNodeSampleRate / 480 which will be added to the next sample buffer and so on.\
     *
     *
     * @param {AudioProcessingEvent} audioEvent - Audio event.
     * @returns {void}
     * @fires VAD_SCORE_PUBLISHED
     */
    _onAudioProcess(audioEvent: AudioProcessingEvent): void {
        if (this._destroyed || !this._running) {
            return;
        }
        const generation = this._generation;

        // Prepend the residue PCM buffer from the previous process callback.
        const inData = audioEvent.inputBuffer.getChannelData(0);
        const completeInData = [ ...this._bufferResidue, ...inData ];
        const sampleTimestamp = Date.now();

        let i = 0;

        for (; i + this._vadSampleSize < completeInData.length; i += this._vadSampleSize) {
            if (this._destroyed || !this._running || generation !== this._generation) {
                return;
            }
            const pcmSample = completeInData.slice(i, i + this._vadSampleSize);

            // The VAD processor might change the values inside the array so we make a copy.
            const vadScore = this._vadProcessor.calculateAudioFrameVAD(pcmSample.slice());

            if (this._destroyed || !this._running || generation !== this._generation) {
                return;
            }
            this.emit(DetectionEvents.VAD_SCORE_PUBLISHED, {
                deviceId: this._localTrack.getDeviceId(),
                pcmData: pcmSample,
                score: vadScore,
                timestamp: sampleTimestamp
            });
        }

        if (!this._destroyed && this._running && generation === this._generation) {
            this._bufferResidue = new Float32Array(completeInData.slice(i, completeInData.length));
        }
    }

    /**
     * Connects the nodes in the AudioContext to start the flow of audio data.
     *
     * @returns {void}
     */
    _connectAudioGraph(): void {
        const generation = ++this._generation;

        this._audioProcessingNode.onaudioprocess = event => {
            if (generation === this._generation) {
                this._onAudioProcess(event);
            }
        };
        this._audioSource.connect(this._audioProcessingNode);
        this._audioProcessingNode.connect(this._audioContext.destination);
    }

    /**
     * Disconnects the nodes in the AudioContext.
     *
     * @returns {void}
     */
    _disconnectAudioGraph(): void {
        if (this._audioProcessingNode) {
            this._audioProcessingNode.onaudioprocess = null;
        }
        for (const node of [ this._audioProcessingNode, this._audioSource ]) {
            try {
                node?.disconnect();
            } catch (error) {
                logger.warn('Failed to disconnect VAD audio node', error);
            }
        }
    }

    /**
     * Cleanup potentially acquired resources.
     *
     * @returns {void}
     */
    _cleanupResources(): void {
        this._disconnectAudioGraph();
        if (this._ownsTrack) {
            try {
                this._localTrack?.stopStream();
            } catch (error) {
                logger.warn('Failed to stop VAD capture', error);
            }
        }
        try {
            if (this._audioContext && this._audioContext.state !== 'closed') {
                this._audioContext.close().catch(error => logger.warn('Failed to close VAD AudioContext', error));
            }
        } catch (error) {
            logger.warn('Failed to close VAD AudioContext', error);
        }
        this._audioProcessingNode = undefined;
        this._audioSource = undefined;
        this._localTrack = null;
        this._audioContext = null;
        this._bufferResidue = new Float32Array([]);
    }

    /**
     * Start the emitter by connecting the audio graph.
     *
     * @returns {void}
     */
    start(): void {
        if (this._destroyed || this._running) {
            return;
        }
        this._running = true;
        try {
            this._connectAudioGraph();
        } catch (error) {
            this.stop();
            throw error;
        }
    }

    /**
     * Stops the emitter by disconnecting the audio graph.
     *
     * @returns {void}
     */
    stop(): void {
        this._running = false;
        ++this._generation;
        this._disconnectAudioGraph();
        this._bufferResidue = new Float32Array([]);
    }

    /**
     * Destroy TrackVADEmitter instance (release resources and stop callbacks).
     *
     * @returns {void}
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }

        this._destroyed = true;
        this._running = false;
        ++this._generation;
        this._cleanupResources();
        const processor = this._vadProcessor;

        this._vadProcessor = null;
        if (processor) {
            destroyVADProcessor(processor);
        }
        this.removeAllListeners();
    }
}
