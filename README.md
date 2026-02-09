# Live Pitch Trace

Live Pitch Trace is a browser app that monitors microphone input and visualizes your singing pitch as a smooth, scrolling line against a target note or scale.

## Features

- Real-time microphone pitch detection in the vocal range.
- Scrolling pitch trace that updates continuously while you sing.
- Wider horizontal graph for easier phrase-level pitch tracking.
- Taller visualization area for better vertical pitch spacing.
- Target modes:
  - `Single Note` (choose any note from C2 to B6)
  - `Scale` with separate selectors for:
    - `Scale Tonic` (starting note like C2, C3, F#3, etc.)
    - `Scale Type` (Major, Minor variants, Pentatonic, Blues)
- Reference playback:
  - `Single Note`: sustained tone until stopped
  - `Scale`: ascending scale playback, with optional loop
- Settings popup (top-right `Settings` button) for:
  - theme (`System`, `Light`, `Dark`)
  - difficulty (`Easy`, `Standard`, `Hard`, `Expert`) which controls in-tune cents tolerance
  - reference waveform (`sine`, `triangle`, `square`, `sawtooth`)
  - scale note duration slider (shown only in `Scale` mode)
  - scale note gap slider (shown only in `Scale` mode)
- In-tune feedback based on cents difference:
  - Green trace and status when within the selected difficulty tolerance
  - Red trace and status when out of tune
- Orange trace line shows active reference playback notes.

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
2. Select a target note (Single mode) or choose `Scale Tonic` + `Scale Type` (Scale mode).
3. Optional: open top-right `Settings` and set theme, difficulty, and waveform.
4. In `Scale` mode, adjust duration/gap sliders in `Settings`.
5. Optional in `Scale` mode: enable `Loop Scale Playback`.
6. Optional: click `Play Reference` to hear the selected note or scale.
7. Click `Stop Tone` to stop reference playback at any time.
8. Click `Start Monitoring` and allow microphone access.
9. Sing and watch:
   - `Detected` note/frequency
   - `Tuning` state (`In tune`, `Sharp`, `Flat`)
   - Scrolling trace against dashed target lines
10. Click `Stop` to end monitoring.
