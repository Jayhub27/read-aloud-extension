/**
 * Offscreen document: synthesizes speech locally with Kale TTS, an 80M-class
 * neural text-to-speech model distilled to 7.5M parameters and running in
 * ONNX Runtime Web, then plays the PCM with Web Audio.
 *
 * Only used when the system speech engine is unavailable, or when the user
 * explicitly selects the bundled engine. Everything stays on the machine.
 */
import * as ort from '../vendor/kale/ort/ort.wasm.min.mjs';
import { KaleTTS } from '../vendor/kale/js/kale-tts.mjs';

const MODEL_BASE = chrome.runtime.getURL('vendor/kale/models/kale-tts-1-nano/');
const FRONTEND_BASE = chrome.runtime.getURL('vendor/kale/frontend/');
const DEFAULT_VOICE = 'f06';
const VOICE_NAMES = {
  s057b: 'Kenzie',
  f06: 'Simone',
  w165: 'Frankie',
  w602: 'Darlene',
  m3: 'Owen',
  t071: 'Toby',
  x328: 'Earl',
  h013f: 'Magnus',
};

let audioContext = null;
let gainNode = null;

let buffer = null;
let source = null;
let duration = 0;

let offset = 0;
let startedAt = 0;
let playing = false;
let paused = false;
let activeToken = 0;
let activeTabId = null;

let lastSynthesis = null;
let lastStart = null;

let tts = null;
let ttsPromise = null;
let workChain = Promise.resolve();
let prepared = null;
let prepareEpoch = 0;
const loadedVoices = new Set();

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function voiceId(value) {
  const text = String(value || '');
  const id = text.startsWith('kale:') ? text.slice(5) : DEFAULT_VOICE;
  return VOICE_NAMES[id] ? id : DEFAULT_VOICE;
}

function keyFor(text, rate, pitch, voice) {
  return text + '|' + clamp(rate, 0.5, 2) + '|' + clamp(pitch, 0.5, 2) + '|' + voice;
}

async function initKale() {
  if (tts) return tts;
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async function () {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    tts = await KaleTTS.load(MODEL_BASE, {
      ort: ort,
      graph: 'int8',
      executionProviders: ['wasm'],
      frontend: FRONTEND_BASE,
    });
    return tts;
  })();
  ttsPromise.catch(function () {
    ttsPromise = null;
    tts = null;
  });
  return ttsPromise;
}

function enqueue(task) {
  const run = workChain.then(task, task);
  workChain = run.then(function () {}, function () {});
  return run;
}

async function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    gainNode = audioContext.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch (error) { /* checked below */ }
  }
  if (audioContext.state !== 'running') {
    throw new Error('Audio playback is blocked (context is ' + audioContext.state + ')');
  }
  return audioContext;
}

function stopSource() {
  if (source) {
    source.onended = null;
    try { source.stop(); } catch (error) { /* already stopped */ }
    try { source.disconnect(); } catch (error) { /* already disconnected */ }
    source = null;
  }
  playing = false;
}

function liveOffset() {
  if (!playing || !audioContext) return offset;
  return Math.min(duration, offset + Math.max(0, audioContext.currentTime - startedAt));
}

function playFrom(startAt, token, tabId) {
  stopSource();
  const begin = Math.max(0, Math.min(Number(startAt) || 0, Math.max(0, duration - 0.02)));

  source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode);
  source.start(0, begin);

  offset = begin;
  startedAt = audioContext.currentTime;
  playing = true;
  paused = false;
  activeToken = token;
  activeTabId = tabId;

  const thisSource = source;
  thisSource.onended = function () {
    if (thisSource !== source || !playing) return;
    source = null;
    playing = false;
    offset = duration;
    chrome.runtime.sendMessage({
      __tts: true,
      target: 'background',
      type: 'bundled-ended',
      token: activeToken,
      tabId: activeTabId,
    }).catch(function () { /* service worker may be asleep */ });
  };
}

/* ------------------------------------------------------------------ *
 * Pitch and speed. Kale synthesizes at a fixed pace, so the controls
 * are applied to the PCM: resample for pitch, WSOLA for duration.
 * ------------------------------------------------------------------ */

function resample(input, factor) {
  const length = Math.max(1, Math.floor(input.length / factor));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * factor;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = index < input.length ? input[index] : 0;
    const b = index + 1 < input.length ? input[index + 1] : 0;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

/**
 * WSOLA time stretch. factor > 1 makes the audio longer (slower), factor < 1
 * shorter (faster), with pitch unchanged.
 */
function timeStretch(input, factor, sampleRate) {
  if (!(factor > 0) || Math.abs(factor - 1) < 0.01) return input;

  const frame = Math.round(0.04 * sampleRate);
  const hop = Math.round(frame / 2);
  const outputLength = Math.max(frame, Math.round(input.length * factor));
  const output = new Float32Array(outputLength + frame);
  const norm = new Float32Array(outputLength + frame);
  const window = new Float32Array(frame);
  for (let i = 0; i < frame; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  }

  const inputHop = hop / factor;
  const search = Math.round(0.008 * sampleRate);
  let outputPosition = 0;
  let nominal = 0;
  let previousTail = null;

  while (outputPosition < outputLength) {
    let best = Math.round(nominal);
    if (previousTail) {
      let bestScore = -Infinity;
      const low = Math.max(0, best - search);
      const high = Math.min(input.length - hop, best + search);
      for (let candidate = low; candidate <= high; candidate += 4) {
        let score = 0;
        for (let i = 0; i < hop; i += 1) score += input[candidate + i] * previousTail[i];
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    best = Math.max(0, Math.min(input.length - 1, best));

    for (let i = 0; i < frame && outputPosition + i < output.length; i += 1) {
      const value = best + i < input.length ? input[best + i] : 0;
      output[outputPosition + i] += value * window[i];
      norm[outputPosition + i] += window[i];
    }

    previousTail = input.subarray(best + hop, best + hop + hop);
    outputPosition += hop;
    nominal += inputHop;
  }

  const result = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    result[i] = norm[i] > 1e-6 ? output[i] / norm[i] : 0;
  }
  return result;
}

function pitchShift(input, factor, sampleRate) {
  if (Math.abs(factor - 1) < 0.01) return input;
  return timeStretch(resample(input, factor), factor, sampleRate);
}

async function synthesize(text, rate, pitch, voice) {
  const started = performance.now();
  const instance = await initKale();
  if (!loadedVoices.has(voice)) {
    await instance.preload(voice);
    loadedVoices.add(voice);
  }

  const { audio, sampleRate } = await instance.speak(text, { voice });
  if (!audio || !audio.length) throw new Error('The neural voice produced no audio');

  const speed = clamp(rate, 0.5, 2);
  const pitchFactor = clamp(pitch, 0.5, 2);
  let pcm = audio;
  if (Math.abs(pitchFactor - 1) >= 0.01) pcm = pitchShift(pcm, pitchFactor, sampleRate);
  if (Math.abs(speed - 1) >= 0.01) pcm = timeStretch(pcm, 1 / speed, sampleRate);

  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.abs(pcm[i]);
    if (value > peak) peak = value;
  }
  if (!peak) throw new Error('The neural voice produced silence');

  await ensureAudioContext();
  const audioBuffer = audioContext.createBuffer(1, pcm.length, sampleRate);
  audioBuffer.copyToChannel(pcm, 0);

  const seconds = audioBuffer.duration;
  const synthesis = {
    engine: 'bundled',
    voice: 'Kale · ' + VOICE_NAMES[voice],
    voiceId: voice,
    sampleRate: sampleRate,
    pcmSamples: pcm.length,
    duration: seconds,
    synthesizeMs: Math.round(performance.now() - started),
    peak: Number(peak.toFixed(4)),
    rate: speed,
    pitch: pitchFactor,
  };

  return {
    buffer: audioBuffer,
    duration: seconds,
    synthesis: synthesis,
  };
}

async function prepare(text, rate, pitch, voice) {
  const key = keyFor(text, rate, pitch, voice);
  if (prepared && prepared.key === key) return prepared;
  const epoch = prepareEpoch;
  return enqueue(async function () {
    if (prepared && prepared.key === key) return prepared;
    const result = await synthesize(text, rate, pitch, voice);
    if (epoch === prepareEpoch) prepared = Object.assign({ key: key }, result);
    return result;
  });
}

async function speak(text, rate, pitch, voice, startAt, token, tabId) {
  const started = performance.now();
  const key = keyFor(text, rate, pitch, voice);
  let result = null;
  let usedPrepared = false;

  if (prepared && prepared.key === key) {
    result = prepared;
    prepared = null;
    usedPrepared = true;
  } else {
    result = await enqueue(function () { return synthesize(text, rate, pitch, voice); });
  }

  buffer = result.buffer;
  duration = result.duration;
  lastSynthesis = result.synthesis;
  playFrom(startAt, token, tabId);
  lastStart = {
    prepared: usedPrepared,
    startLatencyMs: Math.round(performance.now() - started),
    at: Date.now(),
  };
  return result;
}

async function handle(message) {
  switch (message.type) {
    case 'bundled-warmup': {
      const instance = await initKale();
      const voice = voiceId(message.voice);
      await instance.preload(voice);
      loadedVoices.add(voice);
      // Compile the graph and fill the front-end caches now, while the popup
      // is open, instead of on the first spoken sentence.
      await enqueue(function () { return instance.speak('Ready.', { voice: voice }); });
      return {
        ok: true,
        engine: 'bundled',
        ready: true,
        voice: voice,
        sampleRate: 24000,
      };
    }
    case 'bundled-synthesize': {
      const voice = voiceId(message.voice);
      const result = await enqueue(function () {
        return synthesize(String(message.text || ''), message.rate, message.pitch, voice);
      });
      return {
        ok: true,
        engine: 'bundled',
        duration: result.duration,
        synthesis: result.synthesis,
      };
    }
    case 'bundled-prepare': {
      const voice = voiceId(message.voice);
      const result = await prepare(String(message.text || ''), message.rate, message.pitch, voice);
      return {
        ok: true,
        engine: 'bundled',
        prepared: true,
        duration: result.duration,
        synthesis: result.synthesis,
      };
    }
    case 'bundled-speak': {
      await ensureAudioContext();
      const voice = voiceId(message.voice);
      const result = await speak(
        String(message.text || ''),
        message.rate,
        message.pitch,
        voice,
        message.startAt,
        message.token,
        message.tabId,
      );
      return {
        ok: true,
        engine: 'bundled',
        duration: result.duration,
        offset: liveOffset(),
        sampleRate: audioContext.sampleRate,
        contextState: audioContext.state,
        synthesis: lastSynthesis,
        lastStart: lastStart,
      };
    }
    case 'bundled-pause': {
      if (playing) {
        const at = liveOffset();
        stopSource();
        offset = at;
        paused = true;
      }
      return { ok: true, offset: offset, duration: duration };
    }
    case 'bundled-resume': {
      if (!buffer) return { ok: false, error: 'Nothing to resume' };
      await ensureAudioContext();
      playFrom(offset, activeToken, activeTabId);
      return { ok: true, offset: liveOffset(), duration: duration };
    }
    case 'bundled-stop': {
      stopSource();
      paused = false;
      offset = 0;
      duration = 0;
      buffer = null;
      prepared = null;
      prepareEpoch += 1;
      return { ok: true };
    }
    case 'bundled-status': {
      return {
        ok: true,
        engine: 'bundled',
        voice: lastSynthesis ? lastSynthesis.voiceId : null,
        state: playing ? 'playing' : paused ? 'paused' : 'idle',
        offset: liveOffset(),
        duration: duration,
        prepared: Boolean(prepared),
        sampleRate: audioContext ? audioContext.sampleRate : null,
        contextState: audioContext ? audioContext.state : 'uninitialised',
        synthesis: lastSynthesis,
        lastStart: lastStart,
      };
    }
    default:
      return { ok: false, error: 'Unknown bundled voice message: ' + message.type };
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.__tts !== true) return undefined;
  if (message.target !== 'offscreen' || message.relayed !== true) return undefined;

  handle(message)
    .then(sendResponse)
    .catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });
  return true;
});
