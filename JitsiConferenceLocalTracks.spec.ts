import JitsiConference from './JitsiConference';
import { JitsiConferenceEvents } from './JitsiConferenceEvents';
import { JitsiTrackEvents } from './JitsiTrackEvents';
import JitsiLocalTrack from './modules/RTC/JitsiLocalTrack';
import { DetectionEvents } from './modules/detection/DetectionEvents';
import TrackVADEmitter from './modules/detection/TrackVADEmitter';
import VADAudioAnalyser from './modules/detection/VADAudioAnalyser';
import VADTalkMutedDetection from './modules/detection/VADTalkMutedDetection';
import EventEmitter from './modules/util/EventEmitter';
import { MediaType } from './service/RTC/MediaType';

describe('JitsiConference local track listener ownership', () => {
    let conference: JitsiConference;
    let microphone: jasmine.SpyObj<JitsiLocalTrack>;
    let camera: jasmine.SpyObj<JitsiLocalTrack>;
    let microphoneEvents: EventEmitter;
    let cameraEvents: EventEmitter;
    let muteChanged: jasmine.Spy;
    let audioLevelChanged: jasmine.Spy;

    function createTrack(isAudio: boolean, events: EventEmitter): jasmine.SpyObj<JitsiLocalTrack> {
        const track = jasmine.createSpyObj<JitsiLocalTrack>('local track', [
            'addCancellableListener', 'getDeviceId', 'getSourceName', 'getTrackLabel', 'getType', 'isAudioTrack',
            'isLocalAudioTrack', 'isMuted', 'isVideoTrack', 'setConference'
        ]);

        track.isAudioTrack.and.returnValue(isAudio);
        track.isLocalAudioTrack.and.returnValue(isAudio);
        track.isVideoTrack.and.returnValue(!isAudio);
        track.isMuted.and.returnValue(true);
        track.getSourceName.and.returnValue(isAudio ? 'local-a0' : 'local-v0');
        track.getType.and.returnValue(isAudio ? MediaType.AUDIO : MediaType.VIDEO);
        track.getDeviceId.and.returnValue('mic');
        track.addCancellableListener.and.callFake((event, listener) => {
            events.on(event, listener);

            return () => events.removeListener(event, listener);
        });

        return track;
    }

    beforeEach(() => {
        conference = Object.assign(Object.create(JitsiConference.prototype), {
            _localTrackUnsubscribers: new Map(),
            _sendBridgeVideoTypeMessage: jasmine.createSpy('video type'),
            eventEmitter: new EventEmitter(),
            getActivePeerConnection: () => undefined,
            myUserId: () => 'local',
            rtc: jasmine.createSpyObj('rtc', [ 'addLocalTrack', 'removeLocalTrack' ])
        });
        microphoneEvents = new EventEmitter();
        cameraEvents = new EventEmitter();
        microphone = createTrack(true, microphoneEvents);
        camera = createTrack(false, cameraEvents);
        muteChanged = jasmine.createSpy('mute changed');
        audioLevelChanged = jasmine.createSpy('audio level changed');
        conference.on(JitsiConferenceEvents.TRACK_MUTE_CHANGED, muteChanged);
        conference.on(JitsiConferenceEvents.TRACK_AUDIO_LEVEL_CHANGED, audioLevelChanged);
        conference['_setupNewTrack'](microphone);
        conference['_setupNewTrack'](camera);
    });

    it('keeps microphone mute and audio-level relays when the camera is removed', () => {
        conference.onLocalTrackRemoved(camera);
        microphoneEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);
        microphoneEvents.emit(JitsiTrackEvents.TRACK_AUDIO_LEVEL_CHANGED, 0.5);

        expect(muteChanged).toHaveBeenCalledOnceWith(microphone, undefined);
        expect(audioLevelChanged).toHaveBeenCalledOnceWith('local', 0.5);
    });

    it('keeps camera mute relays when the microphone is removed', () => {
        conference.onLocalTrackRemoved(microphone);
        cameraEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);

        expect(muteChanged).toHaveBeenCalledOnceWith(camera, undefined);
    });

    it('removes only the departed track relays, without removing application listeners', () => {
        const applicationListener = jasmine.createSpy('application listener');

        microphoneEvents.on(JitsiTrackEvents.TRACK_MUTE_CHANGED, applicationListener);
        conference.onLocalTrackRemoved(microphone);
        conference.onLocalTrackRemoved(microphone);
        microphoneEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);
        microphoneEvents.emit(JitsiTrackEvents.TRACK_AUDIO_LEVEL_CHANGED, 0.5);

        expect(muteChanged).not.toHaveBeenCalled();
        expect(audioLevelChanged).not.toHaveBeenCalled();
        expect(applicationListener).toHaveBeenCalledTimes(1);
    });

    it('does not duplicate relays when a track is removed and added again', () => {
        conference.onLocalTrackRemoved(camera);
        conference['_setupNewTrack'](camera);
        conference.onLocalTrackRemoved(camera);
        conference['_setupNewTrack'](camera);
        cameraEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);
        microphoneEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);

        expect(muteChanged.calls.allArgs()).toEqual([ [ camera, undefined ], [ microphone, undefined ] ]);
    });

    it('re-arms talking-while-muted detection after camera removal and repeated unmute/mute cycles', async () => {
        const scores = new EventEmitter();
        const emitter = jasmine.createSpyObj<TrackVADEmitter>('VAD emitter', [
            'destroy', 'on', 'removeListener', 'start', 'stop'
        ]);

        emitter.on.and.callFake((event, listener) => {
            scores.on(event, listener);

            return emitter;
        });
        emitter.removeListener.and.callFake((event, listener) => {
            scores.removeListener(event, listener);

            return emitter;
        });
        spyOn(TrackVADEmitter, 'create').and.resolveTo(emitter);
        const analyser = new VADAudioAnalyser(conference, () => ({
            calculateAudioFrameVAD: () => 0.99,
            getRequiredPCMFrequency: () => 48000,
            getSampleLength: () => 480
        }));
        const detector = new VADTalkMutedDetection();
        const prompt = jasmine.createSpy('talking while muted');
        const settle = async () => {
            for (let i = 0; i < 20; ++i) {
                await Promise.resolve();
            }
        };
        const speak = () => {
            scores.emit(DetectionEvents.VAD_SCORE_PUBLISHED, {
                deviceId: 'mic',
                pcmData: new Float32Array(480),
                score: 0.99,
                timestamp: 1
            });
            jasmine.clock().tick(700);
        };

        analyser.addVADDetectionService(detector);
        detector.on(DetectionEvents.VAD_TALK_WHILE_MUTED, prompt);
        jasmine.clock().install();
        try {
            conference.eventEmitter.emit(JitsiConferenceEvents.TRACK_ADDED, microphone);
            await settle();
            speak();
            expect(prompt).toHaveBeenCalledTimes(1);
            conference.onLocalTrackRemoved(camera);

            for (let cycle = 0; cycle < 2; ++cycle) {
                microphone.isMuted.and.returnValue(false);
                microphoneEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);
                await settle();
                speak();
                expect(prompt).toHaveBeenCalledTimes(cycle + 1);
                microphone.isMuted.and.returnValue(true);
                microphoneEvents.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);
                await settle();
                speak();
                expect(prompt).toHaveBeenCalledTimes(cycle + 2);
            }
        } finally {
            analyser.destroy();
            jasmine.clock().uninstall();
        }
    });
});
