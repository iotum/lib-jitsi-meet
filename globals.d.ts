export {};

declare global {
    type Timeout = ReturnType<typeof setTimeout>;
    interface Window {
        JitsiMeetJS?: {
            app?: {
                connectionTimes?: Record<string, any>;
            };
        };
        connectionTimes?: Record<string, any>;
        cordova?: {
            plugins?: {
                iosrtc?: any;
            };
        };
    }
    interface RTCPeerConnection {
        /** @deprecated iosrtc / legacy non-standard API */
        getRemoteStreams?(): MediaStream[];
        /** @deprecated iosrtc non-standard property: stream map keyed by stream id */
        remoteStreams?: { [streamId: string]: MediaStream };
    }
    interface RTCRtpReceiver {
        createEncodedStreams?: () => {
            readable: ReadableStream<RTCEncodedAudioFrame | RTCEncodedVideoFrame>;
            writable: WritableStream<RTCEncodedAudioFrame | RTCEncodedVideoFrame>;
        }
    }
    interface MediaStream {
        oninactive?: ((this: MediaStream, ev: Event) => void) | ((this: MediaStreamTrack, ev: Event) => void) | null;
    }
}
