"use strict";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQ = 440;
const CANVAS_WIDTH = 1120;
const CANVAS_HEIGHT = 460;
const TRACE_POINTS = 700;
const IN_TUNE_CENTS = 25;

const SCALE_DEFINITIONS = {
  C_major: ["C3", "D3", "E3", "F3", "G3", "A3", "B3", "C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"],
  G_major: ["G2", "A2", "B2", "C3", "D3", "E3", "F#3", "G3", "A3", "B3", "C4", "D4", "E4", "F#4", "G4"],
  D_major: ["D3", "E3", "F#3", "G3", "A3", "B3", "C#4", "D4", "E4", "F#4", "G4", "A4", "B4", "C#5", "D5"],
  A_minor: ["A2", "B2", "C3", "D3", "E3", "F3", "G3", "A3", "B3", "C4", "D4", "E4", "F4", "G4", "A4"],
  E_minor: ["E2", "F#2", "G2", "A2", "B2", "C3", "D3", "E3", "F#3", "G3", "A3", "B3", "C4", "D4", "E4"],
  Pentatonic_C: ["C3", "D3", "E3", "G3", "A3", "C4", "D4", "E4", "G4", "A4", "C5"]
};

const dom = {
  mode: document.getElementById("mode"),
  targetNote: document.getElementById("target-note"),
  targetScale: document.getElementById("target-scale"),
  singleGroup: document.getElementById("single-note-group"),
  scaleGroup: document.getElementById("scale-group"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
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
let isRunning = false;
let pitchBuffer = [];
let smoothFrequency = null;
let mutedFrames = 0;
let freqData = new Float32Array(2048);

function initTargetNotes() {
  const noteOptions = [];
  for (let octave = 2; octave <= 6; octave += 1) {
    for (const name of NOTE_NAMES) {
      noteOptions.push(`${name}${octave}`);
    }
  }

  noteOptions.forEach((label) => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    dom.targetNote.appendChild(option);
  });
  dom.targetNote.value = "A4";
}

function noteToFrequency(noteName) {
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

  const midi = noteIndex + (octave + 1) * 12;
  return A4_FREQ * Math.pow(2, (midi - 69) / 12);
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

function getTargetFrequencies() {
  if (dom.mode.value === "single") {
    const freq = noteToFrequency(dom.targetNote.value);
    return freq ? [freq] : [];
  }

  const scale = SCALE_DEFINITIONS[dom.targetScale.value] || [];
  return scale.map(noteToFrequency).filter((freq) => Number.isFinite(freq));
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

function drawGrid(minFreq, maxFreq) {
  ctx.fillStyle = "#f8fbfd";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.strokeStyle = "#d8e5ed";
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

  ctx.fillStyle = "#3c5764";
  ctx.font = "12px Segoe UI";
  const lowNote = frequencyToNote(minFreq).name;
  const highNote = frequencyToNote(maxFreq).name;
  ctx.fillText(`Low: ${lowNote}`, 10, CANVAS_HEIGHT - 10);
  const textWidth = ctx.measureText(`High: ${highNote}`).width;
  ctx.fillText(`High: ${highNote}`, CANVAS_WIDTH - textWidth - 10, 16);
}

function drawTargets(targets, minFreq, maxFreq) {
  ctx.strokeStyle = "rgba(30, 111, 187, 0.65)";
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

function drawTrace(targets, minFreq, maxFreq) {
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
    ctx.strokeStyle = cents <= IN_TUNE_CENTS ? "#0f9d58" : "#cf3f3f";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

function renderFrame(currentFreq) {
  const targets = getTargetFrequencies();
  const minFreq = 70;
  const maxFreq = 1100;

  if (pitchBuffer.length >= TRACE_POINTS) {
    pitchBuffer.shift();
  }
  pitchBuffer.push(Number.isFinite(currentFreq) ? currentFreq : NaN);

  drawGrid(minFreq, maxFreq);
  drawTargets(targets, minFreq, maxFreq);
  drawTrace(targets, minFreq, maxFreq);
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
  if (absCents <= IN_TUNE_CENTS) {
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
  dom.targetScale.disabled = running;
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
  const mode = dom.mode.value;
  if (mode === "single") {
    dom.singleGroup.classList.remove("hidden");
    dom.scaleGroup.classList.add("hidden");
  } else {
    dom.singleGroup.classList.add("hidden");
    dom.scaleGroup.classList.remove("hidden");
  }
  renderFrame(smoothFrequency);
}

function boot() {
  initTargetNotes();
  renderFrame(null);
  dom.mode.addEventListener("change", updateModeUi);
  dom.targetNote.addEventListener("change", () => renderFrame(smoothFrequency));
  dom.targetScale.addEventListener("change", () => renderFrame(smoothFrequency));
  dom.startBtn.addEventListener("click", startMonitoring);
  dom.stopBtn.addEventListener("click", stopMonitoring);
}

boot();
