/**
 * Offscreen document: synthesizes speech locally with the bundled meSpeak
 * (eSpeak) voice and plays it with Web Audio.
 *
 * Only used when the system speech engine is unavailable, or when the user
 * explicitly selects the bundled engine.
 */
(function () {
  'use strict';

  const meSpeak = globalThis.meSpeakLib;
  const VOICE_ID = 'en/en-us';

  let audioContext = null;
  let gainNode = null;

  let buffer = null;
  let source = null;
  let cacheKey = '';
  let duration = 0;

  let offset = 0;
  let startedAt = 0;
  let playing = false;
  let paused = false;
  let activeToken = 0;
  let activeTabId = null;

  let lastSynthesis = null;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  async function initVoice() {
    if (!meSpeak) throw new Error('Bundled voice runtime is missing');
    const configUrl = chrome.runtime.getURL('vendor/mespeak/mespeak_config.json');
    const voiceUrl = chrome.runtime.getURL('vendor/mespeak/voices/en/en-us.json');
    const responses = await Promise.all([fetch(configUrl), fetch(voiceUrl)]);
    for (const response of responses) {
      if (!response.ok) throw new Error('Could not load bundled voice data');
    }
    const [config, voice] = await Promise.all(responses.map((response) => response.json()));
    meSpeak.loadConfig(config);
    meSpeak.loadVoice(voice);
    if (!meSpeak.isConfigLoaded() || !meSpeak.isVoiceLoaded(VOICE_ID)) {
      throw new Error('Bundled voice data did not load');
    }
  }

  const ready = initVoice();
  ready.catch(function (error) {
    console.error('Read Aloud bundled voice failed to initialise:', error);
  });

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

  async function synthesize(text, rate, pitch) {
    const speed = clamp(Math.round(175 * (Number(rate) || 1)), 80, 340);
    const voicePitch = clamp(Math.round(50 * (Number(pitch) || 1)), 5, 95);
    const key = text + '|' + speed + '|' + voicePitch;
    if (cacheKey === key && buffer) return;

    const started = performance.now();
    const wav = meSpeak.speak(text, {
      rawdata: 'array',
      speed: speed,
      pitch: voicePitch,
      amplitude: 100,
    });
    if (!wav || !wav.length) throw new Error('Speech synthesis produced no audio');

    const bytes = Uint8Array.from(wav);
    const view = new DataView(bytes.buffer, 0, bytes.byteLength);
    let peak = 0;
    let nonZero = 0;
    let samples = 0;
    for (let i = 44; i + 1 < bytes.length; i += 2) {
      const value = Math.abs(view.getInt16(i, true));
      samples += 1;
      if (value > 0) nonZero += 1;
      if (value > peak) peak = value;
    }
    if (peak === 0) throw new Error('Speech synthesis produced silence');

    const audio = await audioContext.decodeAudioData(bytes.buffer.slice(0));
    buffer = audio;
    duration = audio.duration;
    cacheKey = key;
    lastSynthesis = {
      bytes: bytes.length,
      peak: peak,
      nonZeroSamples: nonZero,
      samples: samples,
      sampleRate: audio.sampleRate,
      duration: audio.duration,
      synthesizeMs: Math.round(performance.now() - started),
      speed: speed,
      pitch: voicePitch,
      voice: VOICE_ID,
    };
  }

  async function handle(message) {
    await ensureAudioContext();

    switch (message.type) {
      case 'bundled-speak': {
        await synthesize(String(message.text || ''), message.rate, message.pitch);
        playFrom(message.startAt, message.token, message.tabId);
        return {
          ok: true,
          engine: 'bundled',
          duration: duration,
          offset: liveOffset(),
          sampleRate: audioContext.sampleRate,
          contextState: audioContext.state,
          synthesis: lastSynthesis,
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
      case 'bundled-stop': {
        stopSource();
        paused = false;
        offset = 0;
        return { ok: true };
      }
      case 'bundled-status': {
        return {
          ok: true,
          engine: 'bundled',
          state: playing ? 'playing' : paused ? 'paused' : 'idle',
          offset: liveOffset(),
          duration: duration,
          sampleRate: audioContext.sampleRate,
          contextState: audioContext.state,
          synthesis: lastSynthesis,
        };
      }
      default:
        return { ok: false, error: 'Unknown bundled voice message: ' + message.type };
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.__tts !== true) return undefined;
    if (message.target !== 'offscreen' || message.relayed !== true) return undefined;

    ready
      .then(function () { return handle(message); })
      .then(sendResponse)
      .catch(function (error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      });
    return true;
  });
})();
