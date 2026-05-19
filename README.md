# openpilot fingerprint route debugger

A small all-client-side web app that scans a public openpilot route for
fingerprint debugging evidence.

It fetches comma's public route file list, downloads qlogs first when available,
falls back to rlogs, supports `.zst` and `.bz2`, decompresses in the browser, and
decodes just enough Cap'n Proto to summarize:

- `CarParams`, including the selected `carFingerprint`, fingerprint source, mode
  flags, redacted VIN, and `carFw`
- public raw firmware bytes from `carFw.fwVersion`, plus Python `bytes`
  literals and `FW_VERSIONS`-style snippets for opendbc/openpilot firmware files
- startup and recognition events such as `carUnrecognized` and `dashcamMode`
- compact CAN evidence grouped by bus/source, address, message length, count,
  and first/last segment

The report shows debugging options separately for stock openpilot, SunnyPilot's
SunnyLink/car selector path, and hardcoded-fp as a last-resort debugging aid when
a logged fingerprint is already known.

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite.

## Deploy on Cloudflare Pages

Use these settings:

- Build command: `npm run build`
- Build output directory: `dist`
- Node version: current LTS or newer

No server-side function is required.

## Deploy on GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/pages.yml`.
Pushes to `main` build the app and deploy `dist` to GitHub Pages.

For the `ophwug/op-fingerprint-reading-tool` project page, the app is built
with the Vite base path `/op-fingerprint-reading-tool/`, so the expected URL is:

```text
https://ophwug.github.io/op-fingerprint-reading-tool/
```

## Getting a usable route

1. Open [comma Connect](https://connect.comma.ai/) and select the drive.
2. Open **More info** and turn on **Public access**.
3. Copy either the browser URL or the route name.

Accepted inputs look like:

```text
5beb9b58bd12b691|0000010a--a51155e496
https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496/90/105
```

You can turn Public access off again after reading the route.

## Privacy

The app runs in the browser and does not store route data. VIN is redacted in
the visible report by default. Firmware bytes are intentionally public in the
debugging report because they are core fingerprint evidence.

## Useful commands

```sh
npm test
npm run test:smoke
npm run build
```

`test:smoke` uses the public demo route from `op-replay-clipper`, so it needs
network access.
