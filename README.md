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

## Branch release

Build a prerelease from any branch with a custom tag:

Push this branch before dispatching. Keep the `release.yml` filename, which is
already registered on the default branch. `--ref release-workflow` selects this
branch's workflow; `branch` selects the source to build. No merge into `master`
is required.

```
gh workflow run release.yml --repo iotum/lib-jitsi-meet --ref release-workflow -f branch=<branch> -f tag=<tag>
```
