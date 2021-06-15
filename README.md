# Jitsi Meet API library

You can use Jitsi Meet API to create Jitsi Meet video conferences with a custom GUI.

## Installation

- [Installation guide](doc/API.md#installation)
- [Checkout the example](doc/example)

## Building the sources

NOTE: you need Node.js >= 12 and npm >= 6

To build the library, just type:
```
npm install
```
To lint:
```
npm run lint
```
and to run unit tests:
```
npm test
```
if you need to rebuild lib-jitsi-meet.min.js

```
npm run postinstall
```

Both linting and units will also be done by a pre-commit hook.

## Building from sources for ICC

ICC versioning uses ICC-`<release-month>`#`<git-hash>`:
```sh
export ICC_RELEASE="ICC-$(date +%y%m)"
export LIB_JITSI_MEET_COMMIT_HASH="${ICC_RELEASE}#$(git rev-parse --short HEAD)"
npm install
npm run build

# commit the compiled code
git add lib-jitsi-meet.min.* lib-jitsi-meet.e2ee-worker.*
git commit -m "release ${ICC_RELEASE}" --no-verify
git tag "${ICC_RELEASE}"
# push to master iotum branch
git push origin "${ICC_RELEASE}"
```
