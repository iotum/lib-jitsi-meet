# Jitsi Meet API library

You can use Jitsi Meet API to create Jitsi Meet video conferences with a custom GUI.

## Installation

- [Installation guide](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-ljm-api/#installation)
- [Checkout the example](https://github.com/jitsi/ljm-getting-started)

## Building the sources

To build the library, just type:
```
npm install
npm run build
```

To lint:
```
npm run lint
```

and to run unit tests:
```
npm test
```

## VAD resource ownership

After `createTrackVADEmitter` succeeds, the emitter owns the supplied VAD processor,
its separate microphone capture, and its AudioContext. Call `destroy()` when finished;
it is idempotent and invokes the processor's optional `destroy()` method. If creation
rejects, the caller still owns the processor and must dispose it. `stop()` only pauses
processing, so `start()` can resume it. Directly constructed emitters borrow their
track and do not stop the published microphone.

Conference mute and audio-level subscriptions belong to each published local track.
Removing or replacing a camera or desktop track must leave the microphone's
subscriptions intact so talking-while-muted detection can re-arm on later mute cycles.
