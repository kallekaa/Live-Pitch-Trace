"use strict";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQ = 440;
const CANVAS_WIDTH = 1320;
const CANVAS_HEIGHT = 560;
const TRACE_POINTS = 820;
const DEFAULT_IN_TUNE_CENTS = 25;
const REFERENCE_SYNC_DELAY_MS = 90;
const DEFAULT_MIN_FREQ = 70;
const DEFAULT_MAX_FREQ = 1100;
const RANGE_PADDING_SEMITONES = 3;
const MIN_VIEW_SPAN_SEMITONES = 9;
const VIEW_RANGE_SMOOTHING = 0.2;
const THEME_STORAGE_KEY = "live-pitch-trace-theme";

const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11, 12],
  natural_minor: [0, 2, 3, 5, 7, 8, 10, 12],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11, 12],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11, 12],
  major_pentatonic: [0, 2, 4, 7, 9, 12],
  minor_pentatonic: [0, 3, 5, 7, 10, 12],
  blues: [0, 3, 5, 6, 7, 10, 12]
};

const dom = {
  mode: document.getElementById("mode"),
  targetNote: document.getElementById("target-note"),
  scaleTonic: document.getElementById("scale-tonic"),
  scaleType: document.getElementById("scale-type"),
  singleGroup: document.getElementById("single-note-group"),
  scaleTonicGroup: document.getElementById("scale-tonic-group"),
  scaleTypeGroup: document.getElementById("scale-type-group"),
  scaleLoopGroup: document.getElementById("scale-loop-group"),
  loopScale: document.getElementById("loop-scale"),
  scaleSettingsGroup: document.getElementById("scale-settings-group"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsPanel: document.getElementById("settings-panel"),
  difficultySelect: document.getElementById("difficulty-select"),
  waveform: document.getElementById("waveform"),
  noteDurationMs: document.getElementById("note-duration-ms"),
  noteDurationValue: document.getElementById("note-duration-value"),
  noteGapMs: document.getElementById("note-gap-ms"),
  noteGapValue: document.getElementById("note-gap-value"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  playReferenceBtn: document.getElementById("play-reference-btn"),
  stopReferenceBtn: document.getElementById("stop-reference-btn"),
  themeSelect: document.getElementById("theme-select"),
  toleranceLabel: document.getElementById("tolerance-label"),
  detectedNote: document.getElementById("detected-note"),
  detectedFrequency: document.getElementById("detected-frequency"),
  tuningStatus: document.getElementById("tuning-status"),
  canvas: document.getElementById("pitch-canvas")
};

const ctx = dom.canvas.getContext("2d", { alpha: false });
dom.canvas.width = CANVAS_WIDTH;
dom.canvas.height = CANVAS_HEIGHT;

let audioContext = null;
let analyserNode = null;
let stream = null;
let source = null;
let rafId = null;
let playbackVizRafId = null;
let isRunning = false;
let pitchBuffer = [];
let referenceBuffer = [];
let smoothFrequency = null;
let mutedFrames = 0;
let freqData = new Float32Array(2048);
let playbackContext = null;
let playbackNodes = [];
let playbackWaiters = [];
let playbackSessionId = 0;
let activePlaybackFrequency = null;
let referenceSignalHistory = [];
let viewMinFreq = NaN;
let viewMaxFreq = NaN;
let inTuneCentsThreshold = DEFAULT_IN_TUNE_CENTS;

function initTargetNotes() {
  const singleNoteOptions = [];
  const scaleTonicOptions = [];

  for (let octave = 2; octave <= 6; octave += 1) {
    for (const name of NOTE_NAMES) {
      const noteLabel = `${name}${octave}`;
      singleNoteOptions.push(noteLabel);
      if (octave <= 5) {
        scaleTonicOptions.push(noteLabel);
      }
    }
  }

  singleNoteOptions.forEach((label) => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    dom.targetNote.appendChild(option);
  });
  dom.targetNote.value = "A4";

  scaleTonicOptions.forEach((label) => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    dom.scaleTonic.appendChild(option);
  });
  dom.scaleTonic.value = "C3";
}

function noteNameToMidi(noteName) {
  const match = /^([A-G]#?)(\d)$/.exec(noteName);
  if (!match) {
    return null;
  }

  const pitchClass = match[1];
  const octave = Number(match[2]);
  const noteIndex = NOTE_NAMES.indexOf(pitchClass);
  if (noteIndex < 0) {
    return null;
  }

  return noteIndex + (octave + 1) * 12;
}

function midiToFrequency(midi) {
  return A4_FREQ * Math.pow(2, (midi - 69) / 12);
}

function noteToFrequency(noteName) {
  const midi = noteNameToMidi(noteName);
  if (!Number.isFinite(midi)) {
    return null;
  }
  return midiToFrequency(midi);
}

function frequencyToNote(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / A4_FREQ));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const closestFreq = A4_FREQ * Math.pow(2, (midi - 69) / 12);
  const cents = 1200 * Math.log2(frequency / closestFreq);

  return {
    name: `${name}${octave}`,
    midi,
    cents,
    closestFreq
  };
}

function autoCorrelate(buffer, sampleRate) {
  const size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i += 1) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) {
    return null;
  }

  let r1 = 0;
  let r2 = size - 1;
  const threshold = 0.2;
  for (let i = 0; i < size / 2; i += 1) {
    if (Math.abs(buffer[i]) < threshold) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < size / 2; i += 1) {
    if (Math.abs(buffer[size - i]) < threshold) {
      r2 = size - i;
      break;
    }
  }
  const clipped = buffer.slice(r1, r2);
  const clippedSize = clipped.length;
  if (clippedSize < 2) {
    return null;
  }

  const correlations = new Array(clippedSize).fill(0);
  for (let lag = 0; lag < clippedSize; lag += 1) {
    let corr = 0;
    for (let i = 0; i < clippedSize - lag; i += 1) {
      corr += clipped[i] * clipped[i + lag];
    }
    correlations[lag] = corr;
  }

  let dip = 0;
  while (dip < clippedSize - 1 && correlations[dip] > correlations[dip + 1]) {
    dip += 1;
  }

  let peakIndex = -1;
  let peakValue = -Infinity;
  for (let i = dip; i < clippedSize; i += 1) {
    if (correlations[i] > peakValue) {
      peakValue = correlations[i];
      peakIndex = i;
    }
  }

  if (peakIndex <= 0 || peakIndex >= clippedSize - 1) {
    return null;
  }

  const left = correlations[peakIndex - 1];
  const center = correlations[peakIndex];
  const right = correlations[peakIndex + 1];
  const shiftDen = left - 2 * center + right;
  const shift = shiftDen !== 0 ? 0.5 * (left - right) / shiftDen : 0;
  const period = peakIndex + shift;

  if (!Number.isFinite(period) || period <= 0) {
    return null;
  }

  const frequency = sampleRate / period;
  if (frequency < 60 || frequency > 1400) {
    return null;
  }
  return frequency;
}

function buildScaleFrequencies() {
  const tonicMidi = noteNameToMidi(dom.scaleTonic.value);
  const intervals = SCALE_INTERVALS[dom.scaleType.value] || SCALE_INTERVALS.major;
  if (!Number.isFinite(tonicMidi)) {
    return [];
  }

  return intervals
    .map((interval) => midiToFrequency(tonicMidi + interval))
    .filter((freq) => Number.isFinite(freq) && freq > 0);
}

function getTargetFrequencies() {
  if (dom.mode.value === "single") {
    const freq = noteToFrequency(dom.targetNote.value);
    return freq ? [freq] : [];
  }
  return buildScaleFrequencies();
}

function nearestTargetFrequency(freq, targets) {
  if (!targets.length) {
    return null;
  }

  let nearest = targets[0];
  let minDistance = Math.abs(targets[0] - freq);
  for (let i = 1; i < targets.length; i += 1) {
    const distance = Math.abs(targets[i] - freq);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = targets[i];
    }
  }
  return nearest;
}

function frequencyToY(freq, minFreq, maxFreq) {
  const clamped = Math.min(maxFreq, Math.max(minFreq, freq));
  const logMin = Math.log2(minFreq);
  const logMax = Math.log2(maxFreq);
  const norm = (Math.log2(clamped) - logMin) / (logMax - logMin);
  return CANVAS_HEIGHT - norm * CANVAS_HEIGHT;
}

function getThemeColor(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function getCanvasPalette() {
  return {
    fill: getThemeColor("--grid-fill", "#f8fbfd"),
    line: getThemeColor("--grid-line", "#d8e5ed"),
    text: getThemeColor("--grid-text", "#3c5764"),
    target: getThemeColor("--target", "#1e6fbb"),
    good: getThemeColor("--good", "#0f9d58"),
    bad: getThemeColor("--bad", "#cf3f3f"),
    reference: getThemeColor("--reference-trace", "#f29e26")
  };
}

function drawGrid(minFreq, maxFreq, palette) {
  ctx.fillStyle = palette.fill;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 12; i += 1) {
    const y = (CANVAS_HEIGHT / 12) * i;
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_WIDTH, y);
  }
  for (let i = 0; i <= 14; i += 1) {
    const x = (CANVAS_WIDTH / 14) * i;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_HEIGHT);
  }
  ctx.stroke();

  ctx.fillStyle = palette.text;
  ctx.font = "12px Segoe UI";
  const lowNote = frequencyToNote(minFreq).name;
  const highNote = frequencyToNote(maxFreq).name;
  ctx.fillText(`Low: ${lowNote}`, 10, CANVAS_HEIGHT - 10);
  const textWidth = ctx.measureText(`High: ${highNote}`).width;
  ctx.fillText(`High: ${highNote}`, CANVAS_WIDTH - textWidth - 10, 16);
}

function drawTargets(targets, minFreq, maxFreq, palette) {
  ctx.strokeStyle = palette.target;
  ctx.lineWidth = 1.8;
  ctx.setLineDash([7, 5]);
  targets.forEach((targetFreq) => {
    const y = frequencyToY(targetFreq, minFreq, maxFreq);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_WIDTH, y);
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

function drawTrace(targets, minFreq, maxFreq, palette) {
  if (pitchBuffer.length < 2) {
    return;
  }

  const xStep = CANVAS_WIDTH / (TRACE_POINTS - 1);
  ctx.lineWidth = 2.6;

  for (let i = 1; i < pitchBuffer.length; i += 1) {
    const prev = pitchBuffer[i - 1];
    const curr = pitchBuffer[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) {
      continue;
    }

    const x0 = (i - 1) * xStep;
    const x1 = i * xStep;
    const y0 = frequencyToY(prev, minFreq, maxFreq);
    const y1 = frequencyToY(curr, minFreq, maxFreq);
    const nearest = nearestTargetFrequency(curr, targets);
    const cents = nearest ? Math.abs(1200 * Math.log2(curr / nearest)) : 1000;
    ctx.strokeStyle = cents <= inTuneCentsThreshold ? palette.good : palette.bad;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

function drawReferenceTrace(minFreq, maxFreq, palette) {
  if (referenceBuffer.length < 2) {
    return;
  }

  const xStep = CANVAS_WIDTH / (TRACE_POINTS - 1);
  ctx.lineWidth = 2.3;
  ctx.strokeStyle = palette.reference;

  for (let i = 1; i < referenceBuffer.length; i += 1) {
    const prev = referenceBuffer[i - 1];
    const curr = referenceBuffer[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) {
      continue;
    }

    const x0 = (i - 1) * xStep;
    const x1 = i * xStep;
    const y0 = frequencyToY(prev, minFreq, maxFreq);
    const y1 = frequencyToY(curr, minFreq, maxFreq);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

function getSynchronizedReferenceFrequency(referenceFreq) {
  const now = performance.now();
  referenceSignalHistory.push({
    t: now,
    f: Number.isFinite(referenceFreq) ? referenceFreq : NaN
  });

  const trimBefore = now - 5000;
  while (referenceSignalHistory.length > 1 && referenceSignalHistory[1].t < trimBefore) {
    referenceSignalHistory.shift();
  }

  const targetTime = now - REFERENCE_SYNC_DELAY_MS;
  for (let i = referenceSignalHistory.length - 1; i >= 0; i -= 1) {
    if (referenceSignalHistory[i].t <= targetTime) {
      return referenceSignalHistory[i].f;
    }
  }

  return referenceSignalHistory.length ? referenceSignalHistory[0].f : NaN;
}

function resetViewRange() {
  viewMinFreq = NaN;
  viewMaxFreq = NaN;
}

function computeTargetViewRange(targets) {
  if (!targets.length) {
    return {
      min: DEFAULT_MIN_FREQ,
      max: DEFAULT_MAX_FREQ
    };
  }

  const minTarget = Math.min(...targets);
  const maxTarget = Math.max(...targets);
  const paddingRatio = Math.pow(2, RANGE_PADDING_SEMITONES / 12);
  let min = minTarget / paddingRatio;
  let max = maxTarget * paddingRatio;

  const minSpanRatio = Math.pow(2, MIN_VIEW_SPAN_SEMITONES / 12);
  const currentSpanRatio = max / min;
  if (currentSpanRatio < minSpanRatio) {
    const centerFreq = Math.sqrt(min * max);
    const halfSpan = Math.sqrt(minSpanRatio);
    min = centerFreq / halfSpan;
    max = centerFreq * halfSpan;
  }

  min = Math.max(40, min);
  max = Math.min(2200, max);
  if (max <= min * 1.01) {
    max = min * 1.01;
  }

  return { min, max };
}

function getViewRange(targets) {
  const targetRange = computeTargetViewRange(targets);
  if (!Number.isFinite(viewMinFreq) || !Number.isFinite(viewMaxFreq)) {
    viewMinFreq = targetRange.min;
    viewMaxFreq = targetRange.max;
    return {
      min: viewMinFreq,
      max: viewMaxFreq
    };
  }

  viewMinFreq += (targetRange.min - viewMinFreq) * VIEW_RANGE_SMOOTHING;
  viewMaxFreq += (targetRange.max - viewMaxFreq) * VIEW_RANGE_SMOOTHING;
  return {
    min: viewMinFreq,
    max: viewMaxFreq
  };
}

function renderFrame(currentFreq, referenceFreq = activePlaybackFrequency) {
  const targets = getTargetFrequencies();
  const viewRange = getViewRange(targets);
  const minFreq = viewRange.min;
  const maxFreq = viewRange.max;
  const palette = getCanvasPalette();

  if (pitchBuffer.length >= TRACE_POINTS) {
    pitchBuffer.shift();
  }
  pitchBuffer.push(Number.isFinite(currentFreq) ? currentFreq : NaN);
  const syncedReferenceFreq = getSynchronizedReferenceFrequency(referenceFreq);
  if (referenceBuffer.length >= TRACE_POINTS) {
    referenceBuffer.shift();
  }
  referenceBuffer.push(Number.isFinite(syncedReferenceFreq) ? syncedReferenceFreq : NaN);

  drawGrid(minFreq, maxFreq, palette);
  drawTargets(targets, minFreq, maxFreq, palette);
  drawReferenceTrace(minFreq, maxFreq, palette);
  drawTrace(targets, minFreq, maxFreq, palette);
}

function updateStatus(freq) {
  if (!Number.isFinite(freq)) {
    dom.detectedNote.textContent = "--";
    dom.detectedFrequency.textContent = "-- Hz";
    mutedFrames += 1;
    if (mutedFrames > 8) {
      dom.tuningStatus.textContent = "No stable pitch detected";
      dom.tuningStatus.style.color = "#4a6572";
    }
    return;
  }

  mutedFrames = 0;
  const noteInfo = frequencyToNote(freq);
  dom.detectedNote.textContent = `${noteInfo.name} (${noteInfo.cents >= 0 ? "+" : ""}${noteInfo.cents.toFixed(1)}c)`;
  dom.detectedFrequency.textContent = `${freq.toFixed(1)} Hz`;

  const targets = getTargetFrequencies();
  const nearest = nearestTargetFrequency(freq, targets);
  if (!nearest) {
    dom.tuningStatus.textContent = "No target selected";
    dom.tuningStatus.style.color = "#4a6572";
    return;
  }

  const centsOff = 1200 * Math.log2(freq / nearest);
  const absCents = Math.abs(centsOff);
  if (absCents <= inTuneCentsThreshold) {
    dom.tuningStatus.textContent = `In tune (${centsOff >= 0 ? "+" : ""}${centsOff.toFixed(1)}c)`;
    dom.tuningStatus.style.color = "#0f9d58";
  } else if (centsOff > 0) {
    dom.tuningStatus.textContent = `Sharp by ${absCents.toFixed(1)}c`;
    dom.tuningStatus.style.color = "#cf3f3f";
  } else {
    dom.tuningStatus.textContent = `Flat by ${absCents.toFixed(1)}c`;
    dom.tuningStatus.style.color = "#cf3f3f";
  }
}

function updateAudioFrame() {
  if (!isRunning || !analyserNode) {
    return;
  }

  analyserNode.getFloatTimeDomainData(freqData);
  const detected = autoCorrelate(freqData, audioContext.sampleRate);
  if (Number.isFinite(detected)) {
    if (!Number.isFinite(smoothFrequency)) {
      smoothFrequency = detected;
    } else {
      smoothFrequency = smoothFrequency * 0.78 + detected * 0.22;
    }
  } else {
    smoothFrequency = null;
  }

  updateStatus(smoothFrequency);
  renderFrame(smoothFrequency);
  rafId = window.requestAnimationFrame(updateAudioFrame);
}

function setControlsRunning(running) {
  dom.startBtn.disabled = running;
  dom.stopBtn.disabled = !running;
  dom.mode.disabled = running;
  dom.targetNote.disabled = running;
  dom.scaleTonic.disabled = running;
  dom.scaleType.disabled = running;
  dom.loopScale.disabled = running;
}

function updateDifficultyFromSelection() {
  const parsed = clampNumber(dom.difficultySelect.value, 5, 80, DEFAULT_IN_TUNE_CENTS);
  inTuneCentsThreshold = Math.round(parsed);
  dom.difficultySelect.value = String(inTuneCentsThreshold);
  dom.toleranceLabel.textContent = String(inTuneCentsThreshold);
}

function startPlaybackVisualizationLoop() {
  if (isRunning || playbackVizRafId) {
    return;
  }

  const tick = () => {
    if (isRunning) {
      playbackVizRafId = null;
      return;
    }

    renderFrame(smoothFrequency);
    const shouldContinue =
      Number.isFinite(activePlaybackFrequency) ||
      playbackNodes.length > 0 ||
      playbackWaiters.length > 0;
    if (shouldContinue) {
      playbackVizRafId = window.requestAnimationFrame(tick);
    } else {
      playbackVizRafId = null;
    }
  };

  playbackVizRafId = window.requestAnimationFrame(tick);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function updateScaleSettingOutputs() {
  dom.noteDurationValue.textContent = `${dom.noteDurationMs.value} ms`;
  dom.noteGapValue.textContent = `${dom.noteGapMs.value} ms`;
}

function getScalePlaybackTiming() {
  const noteDurationMs = clampNumber(dom.noteDurationMs.value, 140, 900, 320);
  const noteGapMs = clampNumber(dom.noteGapMs.value, 0, 300, 55);
  dom.noteDurationMs.value = String(Math.round(noteDurationMs));
  dom.noteGapMs.value = String(Math.round(noteGapMs));
  updateScaleSettingOutputs();
  return {
    noteDurationMs: Math.round(noteDurationMs),
    noteGapMs: Math.round(noteGapMs)
  };
}

async function ensurePlaybackContext() {
  if (!playbackContext || playbackContext.state === "closed") {
    playbackContext = new window.AudioContext();
  }

  if (playbackContext.state !== "running") {
    try {
      await playbackContext.resume();
    } catch (_error) {
      // Ignore and try fallback context creation below.
    }
  }

  if (playbackContext.state !== "running") {
    playbackContext = new window.AudioContext();
    if (playbackContext.state !== "running") {
      try {
        await playbackContext.resume();
      } catch (_error) {
        // Keep as-is; caller will effectively no-op if audio output is blocked.
      }
    }
  }

  return playbackContext;
}

function removePlaybackNode(node) {
  playbackNodes = playbackNodes.filter((entry) => entry !== node);
  if (playbackNodes.length === 0 && playbackWaiters.length === 0) {
    dom.stopReferenceBtn.disabled = true;
  }
}

function waitForPlayback(ms) {
  return new Promise((resolve) => {
    const waiter = {
      id: 0,
      resolve
    };

    waiter.id = window.setTimeout(() => {
      playbackWaiters = playbackWaiters.filter((entry) => entry !== waiter);
      resolve(true);
      if (playbackNodes.length === 0 && playbackWaiters.length === 0) {
        dom.stopReferenceBtn.disabled = true;
      }
    }, ms);

    playbackWaiters.push(waiter);
  });
}

function fadeOutAndStopTone(node, releaseSeconds = 0.03) {
  const now = node.context.currentTime;
  try {
    node.gain.gain.cancelScheduledValues(now);
    node.gain.gain.setValueAtTime(Math.max(node.gain.gain.value, 0.0001), now);
    node.gain.gain.linearRampToValueAtTime(0.0001, now + releaseSeconds);
    node.osc.stop(now + releaseSeconds + 0.005);
  } catch (_error) {
    // Ignore if node is already stopped.
  }
}

function stopReferencePlayback() {
  playbackSessionId += 1;
  activePlaybackFrequency = null;
  referenceSignalHistory = [];
  playbackWaiters.forEach((waiter) => {
    window.clearTimeout(waiter.id);
    waiter.resolve(false);
  });
  playbackWaiters = [];
  playbackNodes.forEach((node) => {
    try {
      node.osc.onended = null;
      fadeOutAndStopTone(node, 0.015);
    } catch (_error) {
      // Ignore if oscillator has already stopped.
    }
    try {
      node.osc.disconnect();
      node.gain.disconnect();
    } catch (_error) {
      // Ignore disconnect errors.
    }
  });
  playbackNodes = [];
  dom.stopReferenceBtn.disabled = true;
  renderFrame(smoothFrequency);
}

function createReferenceTone(context, frequency, gainValue = 0.1, waveType = "sine") {
  const startTime = context.currentTime + 0.002;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = waveType;
  osc.frequency.setValueAtTime(frequency, startTime);

  gain.gain.setValueAtTime(0.0001, Math.max(0, startTime - 0.01));
  gain.gain.linearRampToValueAtTime(gainValue, startTime + 0.02);

  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(startTime);
  const nodeRef = { osc, gain, context };
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch (_error) {
      // Ignore disconnect errors.
    }
    removePlaybackNode(nodeRef);
  };
  playbackNodes.push(nodeRef);

  return nodeRef;
}

async function playScaleSequence(context, targets, sessionId, waveType, loopScale) {
  const timing = getScalePlaybackTiming();
  const noteDurationMs = timing.noteDurationMs;
  const gapDurationMs = timing.noteGapMs;

  do {
    for (const freq of targets) {
      if (sessionId !== playbackSessionId) {
        return;
      }

      activePlaybackFrequency = freq;
      startPlaybackVisualizationLoop();
      const node = createReferenceTone(context, freq, 0.09, waveType);
      const playedFullNote = await waitForPlayback(noteDurationMs);
      if (sessionId !== playbackSessionId || !playedFullNote) {
        return;
      }

      fadeOutAndStopTone(node, 0.02);
      activePlaybackFrequency = null;
      const playedGap = await waitForPlayback(gapDurationMs);
      if (sessionId !== playbackSessionId || !playedGap) {
        return;
      }
    }
  } while (loopScale && sessionId === playbackSessionId);

  if (sessionId === playbackSessionId) {
    activePlaybackFrequency = null;
    dom.stopReferenceBtn.disabled = true;
  }
}

async function playReference() {
  stopReferencePlayback();
  const sessionId = playbackSessionId;
  referenceSignalHistory = [];

  const context = await ensurePlaybackContext();
  if (sessionId !== playbackSessionId) {
    return;
  }

  if (dom.mode.value === "single") {
    const freq = noteToFrequency(dom.targetNote.value);
    if (!Number.isFinite(freq)) {
      return;
    }
    activePlaybackFrequency = freq;
    createReferenceTone(context, freq, 0.1, dom.waveform.value);
    dom.stopReferenceBtn.disabled = false;
    startPlaybackVisualizationLoop();
    return;
  }

  const targets = getTargetFrequencies();
  if (!targets.length) {
    return;
  }
  dom.stopReferenceBtn.disabled = false;
  playScaleSequence(context, targets, sessionId, dom.waveform.value, dom.loopScale.checked);
}

function closeSettingsPanel() {
  dom.settingsPanel.classList.add("hidden");
  dom.settingsBtn.setAttribute("aria-expanded", "false");
}

function openSettingsPanel() {
  dom.settingsPanel.classList.remove("hidden");
  dom.settingsBtn.setAttribute("aria-expanded", "true");
}

function toggleSettingsPanel() {
  const isHidden = dom.settingsPanel.classList.contains("hidden");
  if (isHidden) {
    openSettingsPanel();
  } else {
    closeSettingsPanel();
  }
}

function resolveThemeMode(mode) {
  if (mode === "dark" || mode === "light") {
    return mode;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setThemeMode(mode) {
  const normalizedMode = mode === "dark" || mode === "light" || mode === "system" ? mode : "system";
  const resolved = resolveThemeMode(normalizedMode);
  document.body.classList.toggle("dark", resolved === "dark");
  dom.themeSelect.value = normalizedMode;
  window.localStorage.setItem(THEME_STORAGE_KEY, normalizedMode);
  renderFrame(smoothFrequency);
}

function initTheme() {
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  const initialMode = saved === "dark" || saved === "light" || saved === "system" ? saved : "system";
  setThemeMode(initialMode);

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    if (dom.themeSelect.value === "system") {
      setThemeMode("system");
    }
  });
}

async function startMonitoring() {
  if (isRunning) {
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
  } catch (error) {
    dom.tuningStatus.textContent = "Microphone permission denied";
    dom.tuningStatus.style.color = "#cf3f3f";
    return;
  }

  audioContext = new window.AudioContext();
  source = audioContext.createMediaStreamSource(stream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.15;
  source.connect(analyserNode);

  pitchBuffer = [];
  referenceBuffer = [];
  referenceSignalHistory = [];
  resetViewRange();
  smoothFrequency = null;
  mutedFrames = 0;
  isRunning = true;
  setControlsRunning(true);
  dom.tuningStatus.textContent = "Listening...";
  dom.tuningStatus.style.color = "#4a6572";
  updateAudioFrame();
}

function stopMonitoring() {
  if (!isRunning) {
    return;
  }

  isRunning = false;
  if (rafId) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  setControlsRunning(false);
  dom.tuningStatus.textContent = "Stopped";
  dom.tuningStatus.style.color = "#4a6572";
}

function updateModeUi() {
  stopReferencePlayback();
  resetViewRange();
  const mode = dom.mode.value;
  if (mode === "single") {
    dom.singleGroup.classList.remove("hidden");
    dom.scaleTonicGroup.classList.add("hidden");
    dom.scaleTypeGroup.classList.add("hidden");
    dom.scaleLoopGroup.classList.add("hidden");
    dom.scaleSettingsGroup.classList.add("hidden");
  } else {
    dom.singleGroup.classList.add("hidden");
    dom.scaleTonicGroup.classList.remove("hidden");
    dom.scaleTypeGroup.classList.remove("hidden");
    dom.scaleLoopGroup.classList.remove("hidden");
    dom.scaleSettingsGroup.classList.remove("hidden");
  }
  renderFrame(smoothFrequency);
}

function boot() {
  initTargetNotes();
  initTheme();
  updateDifficultyFromSelection();
  updateScaleSettingOutputs();
  renderFrame(null);
  dom.mode.addEventListener("change", updateModeUi);
  dom.targetNote.addEventListener("change", () => {
    stopReferencePlayback();
    resetViewRange();
    renderFrame(smoothFrequency);
  });
  dom.scaleTonic.addEventListener("change", () => {
    stopReferencePlayback();
    resetViewRange();
    renderFrame(smoothFrequency);
  });
  dom.scaleType.addEventListener("change", () => {
    stopReferencePlayback();
    resetViewRange();
    renderFrame(smoothFrequency);
  });
  dom.waveform.addEventListener("change", stopReferencePlayback);
  dom.noteDurationMs.addEventListener("input", () => {
    updateScaleSettingOutputs();
    stopReferencePlayback();
  });
  dom.noteGapMs.addEventListener("input", () => {
    updateScaleSettingOutputs();
    stopReferencePlayback();
  });
  dom.loopScale.addEventListener("change", stopReferencePlayback);
  dom.startBtn.addEventListener("click", startMonitoring);
  dom.stopBtn.addEventListener("click", stopMonitoring);
  dom.playReferenceBtn.addEventListener("click", playReference);
  dom.stopReferenceBtn.addEventListener("click", stopReferencePlayback);
  dom.difficultySelect.addEventListener("change", () => {
    updateDifficultyFromSelection();
    renderFrame(smoothFrequency);
  });
  dom.themeSelect.addEventListener("change", () => setThemeMode(dom.themeSelect.value));
  dom.settingsBtn.addEventListener("click", toggleSettingsPanel);
  dom.settingsPanel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", (event) => {
    if (dom.settingsPanel.classList.contains("hidden")) {
      return;
    }
    if (event.target === dom.settingsBtn || dom.settingsBtn.contains(event.target)) {
      return;
    }
    if (dom.settingsPanel.contains(event.target)) {
      return;
    }
    closeSettingsPanel();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSettingsPanel();
    }
  });
  updateModeUi();
}

boot();
