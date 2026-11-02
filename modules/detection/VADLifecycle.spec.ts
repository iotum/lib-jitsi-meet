import JitsiConference from '../../JitsiConference';
import { JitsiConferenceEvents } from '../../JitsiConferenceEvents';
import JitsiLocalTrack from '../RTC/JitsiLocalTrack';
import RTC from '../RTC/RTC';
import EventEmitter from '../util/EventEmitter';

import { DetectionEvents } from './DetectionEvents';
import TrackVADEmitter, { IVadProcessor } from './TrackVADEmitter';
import VADAudioAnalyser, { IVADDetectionService } from './VADAudioAnalyser';
import VADReportingService from './VADReportingService';

/**
 * Allows chained initialization promises to settle without advancing detector timers.
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; ++i) {
        await Promise.resolve();
    }
}

/**
 * Creates a controllable asynchronous initialization result.
 */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => {
        resolve = res;
    });

    return { promise, resolve };
}

describe('VAD resource lifecycle', () => {
    let context: jasmine.SpyObj<AudioContext>;
    let source: jasmine.SpyObj<MediaStreamAudioSourceNode>;
    let node: jasmine.SpyObj<ScriptProcessorNode>;
    let track: jasmine.SpyObj<JitsiLocalTrack>;
    let processor: jasmine.SpyObj<IVadProcessor>;
    let permissions: jasmine.Spy;
    let contextConstructor: jasmine.Spy;
    let emitters: TrackVADEmitter[];

    beforeEach(() => {
        source = jasmine.createSpyObj('source', [ 'connect', 'disconnect' ]);
        node = jasmine.createSpyObj('node', [ 'connect', 'disconnect' ]);
        context = jasmine.createSpyObj('context',
            [ 'createMediaStreamSource', 'createScriptProcessor', 'close' ], { state: 'running' });
        context.createMediaStreamSource.and.returnValue(source);
        context.createScriptProcessor.and.returnValue(node);
        context.close.and.returnValue(Promise.resolve());
        contextConstructor = spyOn(window, 'AudioContext').and.returnValue(context);
        track = jasmine.createSpyObj('track',
            [ 'stopStream', 'getDeviceId', 'getTrackLabel', 'isLocalAudioTrack', 'isMuted' ],
            { stream: new MediaStream() });
        track.getDeviceId.and.returnValue('mic');
        track.isLocalAudioTrack.and.returnValue(true);
        track.isMuted.and.returnValue(true);
        processor = jasmine.createSpyObj('processor',
            [ 'calculateAudioFrameVAD', 'getRequiredPCMFrequency', 'getSampleLength', 'destroy' ]);
        processor.getRequiredPCMFrequency.and.returnValue(48000);
        processor.getSampleLength.and.returnValue(480);
        processor.calculateAudioFrameVAD.and.returnValue(0.9);
        permissions = spyOn(RTC, 'obtainAudioAndVideoPermissions').and.resolveTo([ track ]);
        emitters = [];
    });

    afterEach(() => {
        emitters.forEach(emitter => emitter.destroy());
    });

    /**
     * Acquires a real emitter with mocked browser resources.
     */
    async function createEmitter(): Promise<TrackVADEmitter> {
        const emitter = await TrackVADEmitter.create('mic', 4096, processor);

        emitters.push(emitter);

        return emitter;
    }

    /**
     * Supplies enough PCM data to produce several VAD scores.
     */
    function audioEvent(): AudioProcessingEvent {
        const buffer = jasmine.createSpyObj<AudioBuffer>('buffer', [ 'getChannelData' ]);

        buffer.getChannelData.and.returnValue(new Float32Array(4096));

        return jasmine.createSpyObj<AudioProcessingEvent>('event', [], { inputBuffer: buffer });
    }

    it('releases owned resources and listeners exactly once', async () => {
        const emitter = await createEmitter();

        emitter.on(DetectionEvents.VAD_SCORE_PUBLISHED, jasmine.createSpy('score'));
        emitter.start();
        emitter.destroy();
        emitter.destroy();
        emitter.start();
        expect(node.onaudioprocess).toBeNull();
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(node.disconnect).toHaveBeenCalledTimes(1);
        expect(track.stopStream).toHaveBeenCalledTimes(1);
        expect(processor.destroy).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
        expect(emitter.listenerCount(DetectionEvents.VAD_SCORE_PUBLISHED)).toBe(0);
    });

    it('keeps stop/start restartable and rejects callbacks queued before stop', async () => {
        const emitter = await createEmitter();

        emitter.start();
        const queued = node.onaudioprocess;

        emitter.start();
        expect(source.connect).toHaveBeenCalledTimes(1);
        emitter.stop();
        expect(track.stopStream).not.toHaveBeenCalled();
        expect(processor.destroy).not.toHaveBeenCalled();
        expect(context.close).not.toHaveBeenCalled();
        emitter.start();
        queued.call(node, audioEvent());
        expect(processor.calculateAudioFrameVAD).not.toHaveBeenCalled();
        node.onaudioprocess.call(node, audioEvent());
        expect(processor.calculateAudioFrameVAD).toHaveBeenCalled();
    });

    it('neutralizes captured callbacks and direct processing after destroy', async () => {
        const emitter = await createEmitter();

        emitter.start();
        const queued = node.onaudioprocess;

        emitter.destroy();
        queued.call(node, audioEvent());
        emitter._onAudioProcess(audioEvent());
        expect(processor.calculateAudioFrameVAD).not.toHaveBeenCalled();
    });

    it('stops processing immediately when a score listener destroys the emitter', async () => {
        const emitter = await createEmitter();

        emitter.on(DetectionEvents.VAD_SCORE_PUBLISHED, () => emitter.destroy());
        emitter.start();
        node.onaudioprocess.call(node, audioEvent());
        expect(processor.calculateAudioFrameVAD).toHaveBeenCalledTimes(1);
    });

    it('never stops a borrowed published microphone', () => {
        const emitter = new TrackVADEmitter(4096, processor, track);

        emitter.destroy();
        expect(track.stopStream).not.toHaveBeenCalled();
        expect(processor.destroy).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
    });

    it('accepts legacy processors without a destroy method', async () => {
        const legacy: IVadProcessor = {
            calculateAudioFrameVAD: () => 0,
            getRequiredPCMFrequency: () => 48000,
            getSampleLength: () => 480
        };
        const emitter = await TrackVADEmitter.create('mic', 4096, legacy);

        emitter.destroy();
        expect(context.close).toHaveBeenCalledTimes(1);
    });

    it('releases capture and context after partial graph initialization failure', async () => {
        context.createScriptProcessor.and.throwError('graph failed');
        await expectAsync(TrackVADEmitter.create('mic', 4096, processor)).toBeRejectedWithError('graph failed');
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(track.stopStream).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
        expect(processor.destroy).not.toHaveBeenCalled();
    });

    it('leaves processor ownership with the caller after capture failure', async () => {
        permissions.and.rejectWith(new Error('permission denied'));
        await expectAsync(TrackVADEmitter.create('mic', 4096, processor)).toBeRejectedWithError('permission denied');
        expect(processor.destroy).not.toHaveBeenCalled();
        expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    });

    it('releases capture when AudioContext construction fails', async () => {
        contextConstructor.and.throwError('context failed');
        await expectAsync(TrackVADEmitter.create('mic', 4096, processor)).toBeRejectedWithError('context failed');
        expect(track.stopStream).toHaveBeenCalledTimes(1);
        expect(processor.destroy).not.toHaveBeenCalled();
    });

    it('closes the context if processor initialization throws', async () => {
        processor.getSampleLength.and.throwError('sample length failed');
        await expectAsync(TrackVADEmitter.create('mic', 4096, processor)).toBeRejectedWithError('sample length failed');
        expect(track.stopStream).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
        expect(processor.destroy).not.toHaveBeenCalled();
    });

    it('handles synchronous close failures and asynchronous processor disposal failures', async () => {
        const emitter = await createEmitter();

        context.close.and.throwError('close failed');
        processor.destroy.and.callFake(async () => {
            throw new Error('processor failed');
        });
        emitter.destroy();
        await settle();
        expect(processor.destroy).toHaveBeenCalledTimes(1);
        expect(track.stopStream).toHaveBeenCalledTimes(1);
    });

    it('finishes teardown despite disconnect, capture, processor, and context failures', async () => {
        const emitter = await createEmitter();

        source.disconnect.and.throwError('disconnect failed');
        track.stopStream.and.throwError('stop failed');
        processor.destroy.and.throwError('processor failed');
        context.close.and.rejectWith(new Error('close failed'));
        emitter.destroy();
        await settle();
        emitter.destroy();
        expect(node.disconnect).toHaveBeenCalledTimes(1);
        expect(processor.destroy).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
    });

    describe('analyser', () => {
        let conference: jasmine.SpyObj<JitsiConference>;
        let events: EventEmitter;
        let detector: jasmine.SpyObj<IVADDetectionService>;
        let analyser: VADAudioAnalyser;
        let publishedTrack: jasmine.SpyObj<JitsiLocalTrack>;

        beforeEach(() => {
            events = new EventEmitter();
            conference = jasmine.createSpyObj('conference', [ 'on', 'off' ]);
            conference.on.and.callFake((event, listener) => {
                events.on(event, listener);

                return conference;
            });
            conference.off.and.callFake((event, listener) => {
                events.off(event, listener);

                return conference;
            });
            detector = jasmine.createSpyObj('detector',
                [ 'on', 'removeListener', 'isActive', 'changeMuteState', 'processVADScore', 'reset' ]);
            publishedTrack = jasmine.createSpyObj('published microphone',
                [ 'getDeviceId', 'getTrackLabel', 'isLocalAudioTrack', 'isMuted', 'stopStream' ]);
            publishedTrack.getDeviceId.and.returnValue('mic');
            publishedTrack.isLocalAudioTrack.and.returnValue(true);
            publishedTrack.isMuted.and.returnValue(true);
        });

        afterEach(() => {
            analyser?.destroy();
            expect(publishedTrack.stopStream).not.toHaveBeenCalled();
        });

        it('disposes a processor resolving after conference teardown without capturing', async () => {
            const pending = deferred<IVadProcessor>();

            analyser = new VADAudioAnalyser(conference, () => pending.promise);
            analyser._trackAdded(publishedTrack);
            await settle();
            events.emit(JitsiConferenceEvents.CONFERENCE_LEFT);
            pending.resolve(processor);
            await settle();
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(permissions).not.toHaveBeenCalled();
            expect(events.listenerCount(JitsiConferenceEvents.TRACK_ADDED)).toBe(0);
        });

        it('destroys an emitter resolving after teardown without starting detectors', async () => {
            const pending = deferred<JitsiLocalTrack[]>();

            permissions.and.returnValue(pending.promise);
            analyser = new VADAudioAnalyser(conference, () => processor);
            analyser.addVADDetectionService(detector);
            analyser._trackAdded(publishedTrack);
            await settle();
            analyser.destroy();
            pending.resolve([ track ]);
            await settle();
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(track.stopStream).toHaveBeenCalledTimes(1);
            expect(detector.changeMuteState).not.toHaveBeenCalled();
            expect(detector.removeListener).toHaveBeenCalled();
        });

        it('disposes a caller-owned processor on emitter creation failure and recovers', async () => {
            const replacement = { ...processor, destroy: jasmine.createSpy('replacement destroy') };
            const factory = jasmine.createSpy('factory').and.returnValues(processor, replacement);

            permissions.and.rejectWith(new Error('capture failed'));
            analyser = new VADAudioAnalyser(conference, factory);
            analyser._trackAdded(publishedTrack);
            await settle();
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            permissions.and.resolveTo([ track ]);
            analyser._trackAdded(publishedTrack);
            await settle();
            expect(permissions).toHaveBeenCalledTimes(2);
            expect(context.createScriptProcessor).toHaveBeenCalledTimes(1);
        });

        it('discards initialization superseded by track removal', async () => {
            const pending = deferred<IVadProcessor>();

            analyser = new VADAudioAnalyser(conference, () => pending.promise);
            analyser._trackAdded(publishedTrack);
            await settle();
            analyser._trackRemoved(publishedTrack);
            pending.resolve(processor);
            await settle();
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(permissions).not.toHaveBeenCalled();
        });

        it('does not restart from retained detector callbacks after destruction', async () => {
            analyser = new VADAudioAnalyser(conference, () => processor);
            analyser.addVADDetectionService(detector);
            analyser._trackAdded(publishedTrack);
            await settle();
            const stateChanged = detector.on.calls.mostRecent().args[1];

            detector.isActive.and.returnValue(true);
            stateChanged();
            expect(source.connect).toHaveBeenCalledTimes(1);
            analyser.destroy();
            analyser.destroy();
            stateChanged();
            analyser._trackAdded(publishedTrack);
            await settle();
            expect(source.connect).toHaveBeenCalledTimes(1);
            expect(processor.destroy).toHaveBeenCalledTimes(1);
        });
    });

    describe('reporting service', () => {
        let service: VADReportingService;
        let device: MediaDeviceInfo;

        beforeEach(() => {
            device = jasmine.createSpyObj('device', [ 'toJSON' ],
                { deviceId: 'mic', kind: 'audioinput', label: 'Microphone' });
            jasmine.clock().install();
        });

        afterEach(() => {
            service?.destroy();
            jasmine.clock().uninstall();
        });

        it('deduplicates devices, publishes, and permanently stops reporting on destroy', async () => {
            const factory = jasmine.createSpy('factory').and.returnValue(processor);

            service = await VADReportingService.create([ device, device ], 100, factory);
            const report = jasmine.createSpy('report');

            service.on(DetectionEvents.VAD_REPORT_PUBLISHED, report);
            service._devicePublishVADScore({ deviceId: 'mic', score: 0.9, timestamp: 1 });
            jasmine.clock().tick(100);
            expect(report).toHaveBeenCalledTimes(1);
            expect(factory).toHaveBeenCalledTimes(1);
            service.destroy();
            service.destroy();
            service._startPublish();
            service._reportVadScore();
            jasmine.clock().tick(200);
            expect(report).toHaveBeenCalledTimes(1);
            expect(processor.destroy).toHaveBeenCalledTimes(1);
        });

        it('cleans up processors on capture failure without starting a reporting interval', async () => {
            permissions.and.rejectWith(new Error('capture failed'));
            service = await VADReportingService.create([ device ], 100, () => processor);
            const report = jasmine.createSpy('report');

            service.on(DetectionEvents.VAD_REPORT_PUBLISHED, report);
            jasmine.clock().tick(100);
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(report).not.toHaveBeenCalled();
        });

        it('cleans up an emitter whose start fails', async () => {
            node.connect.and.throwError('connect failed');
            service = await VADReportingService.create([ device ], 100, () => processor);
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(track.stopStream).toHaveBeenCalledTimes(1);
            expect(context.close).toHaveBeenCalledTimes(1);
        });

        it('handles synchronous processor factory failures as device initialization errors', async () => {
            service = await VADReportingService.create([ device ], 100, () => {
                throw new Error('processor failed');
            });
            expect(permissions).not.toHaveBeenCalled();
        });

        it('disposes late contexts and never starts timers after destroy', async () => {
            service = new VADReportingService(100);
            service.destroy();
            const emitter = await createEmitter();

            service._setVADContextArray([ { deviceInfo: device, scoreArray: [], vadEmitter: emitter } ]);
            service._startPublish();
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(context.close).toHaveBeenCalledTimes(1);
        });

        it('releases a processor resolving after reporting teardown', async () => {
            const pending = deferred<IVadProcessor>();
            const original = VADReportingService.prototype._setVADContextArray;
            const secondProcessor = { ...processor, destroy: jasmine.createSpy('second processor destroy') };

            spyOn(VADReportingService.prototype, '_setVADContextArray').and.callFake(function(contexts) {
                service = this;
                original.call(this, contexts);
                this.destroy();
            });
            const creation = VADReportingService.create(
                [ device, { ...device, deviceId: 'second' } ], 100,
                jasmine.createSpy('factory').and.returnValues(processor, pending.promise));

            await settle();
            pending.resolve(secondProcessor);
            await creation;
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(secondProcessor.destroy).toHaveBeenCalledTimes(1);
            expect(permissions).toHaveBeenCalledTimes(1);
        });

        it('destroys an emitter resolving after reporting teardown without restarting it', async () => {
            const pending = deferred<JitsiLocalTrack[]>();
            const original = VADReportingService.prototype._setVADContextArray;
            const secondProcessor = { ...processor, destroy: jasmine.createSpy('second processor destroy') };
            const secondCapture = jasmine.createSpyObj<JitsiLocalTrack>('second capture', [ 'stopStream' ],
                { stream: new MediaStream() });

            permissions.and.returnValues(Promise.resolve([ track ]), pending.promise);
            spyOn(VADReportingService.prototype, '_setVADContextArray').and.callFake(function(contexts) {
                service = this;
                original.call(this, contexts);
                this.destroy();
            });
            const creation = VADReportingService.create(
                [ device, { ...device, deviceId: 'second' } ], 100,
                jasmine.createSpy('factory').and.returnValues(processor, secondProcessor));

            await settle();
            pending.resolve([ secondCapture ]);
            await creation;
            expect(processor.destroy).toHaveBeenCalledTimes(1);
            expect(secondProcessor.destroy).toHaveBeenCalledTimes(1);
            expect(secondCapture.stopStream).toHaveBeenCalledTimes(1);
            expect(source.connect).toHaveBeenCalledTimes(1);
        });
    });
});
