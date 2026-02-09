# Live Pitch Trace

Live Pitch Trace is a browser app that monitors microphone input and visualizes your singing pitch as a smooth, scrolling line against a target note or scale.

## Features

- Real-time microphone pitch detection in the vocal range.
- Scrolling pitch trace that updates continuously while you sing.
- Target modes:
  - `Single Note` (choose any note from C2 to B6)
  - `Scale` (common major/minor/pentatonic options)
- In-tune feedback based on cents difference:
  - Green trace and status when within `25 cents`
  - Red trace and status when out of tune

## Run

Because microphone access requires a secure context, run this app from `http://localhost` (or HTTPS), not from a plain `file://` URL.

### Option 1: VS Code Live Server

1. Open the folder in VS Code.
2. Run Live Server on `index.html`.
3. Use the local URL shown by the extension.

### Option 2: Node static server

If you have Node.js installed:

```bash
npx serve .
```

Then open the local URL (for example `http://localhost:3000`).

## Usage

1. Choose `Target Mode`.
2. Select a target note or scale.
3. Click `Start Monitoring` and allow microphone access.
4. Sing and watch:
   - `Detected` note/frequency
   - `Tuning` state (`In tune`, `Sharp`, `Flat`)
   - Scrolling trace against dashed target lines
5. Click `Stop` to end monitoring.
