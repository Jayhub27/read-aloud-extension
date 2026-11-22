/**
 * Offscreen document: synthesizes speech locally with Piper, a neural
 * text-to-speech model running in ONNX Runtime Web, and plays the PCM with
 * Web Audio.
 *
 * Only used when the system speech engine is unavailable, or when the user
 * explicitly selects the bundled engine. Everything stays on the machine.
 */
(function () {
  'use strict';

  const RUNTIME_DIR = 'vendor/piper/';
  const MODEL_FILE = 'en_US-ljspeech-medium.onnx';
  const MODEL_URL = RUNTIME_DIR + MODEL_FILE;
  const CONFIG_URL = RUNTIME_DIR + MODEL_FILE + '.json';
  const VOICE_LABEL = 'Piper en_US ljspeech medium';
  const VOICE_ID = 'en_US-ljspeech-medium';

  let audioContext = null;
  let gainNode = null;

  let buffer = null;
  let source = null;
  let duration = 0;
  let playbackRate = 1;

  let offset = 0;
  let startedAt = 0;
  let playing = false;
  let paused = false;
  let activeToken = 0;
  let activeTabId = null;

  let lastSynthesis = null;
  let lastStart = null;

  let enginePromise = null;
  let engine = null;
  let phonemeLine = null;
  let workChain = Promise.resolve();
  let prepared = null;
  let prepareEpoch = 0;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function keyFor(text, rate, pitch) {
    return text + '|' + clamp(rate, 0.5, 2) + '|' + clamp(pitch, 0.5, 2);
  }

  async function initEngine() {
    if (engine) return engine;
    if (enginePromise) return enginePromise;

    enginePromise = (async function () {
      // ORT ships as an ES module; extension pages may import their own files.
      const ort = await import(chrome.runtime.getURL(RUNTIME_DIR + 'ort.min.mjs'));
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = chrome.runtime.getURL(RUNTIME_DIR);

      const [configResponse, modelResponse] = await Promise.all([
        fetch(chrome.runtime.getURL(CONFIG_URL)),
        fetch(chrome.runtime.getURL(MODEL_URL)),
      ]);
      if (!configResponse.ok || !modelResponse.ok) {
        throw new Error('Could not load the bundled neural voice');
      }
      const [config, modelBytes] = await Promise.all([
        configResponse.json(),
        modelResponse.arrayBuffer(),
      ]);

      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      const phonemizer = await createPiperPhonemize({
        print: function (line) {
          const callback = phonemeLine;
          if (!callback) return;
          phonemeLine = null;
          callback(line);
        },
        printErr: function (line) {
          if (line && String(line).trim()) console.warn('Read Aloud phonemizer:', line);
        },
        locateFile: function (file) {
          if (file.endsWith('.wasm')) return chrome.runtime.getURL(RUNTIME_DIR + 'piper_phonemize.wasm');
          if (file.endsWith('.data')) return chrome.runtime.getURL(RUNTIME_DIR + 'piper_phonemize.data');
          return file;
        },
      });

      engine = {
        ort: ort,
        config: config,
        session: session,
        phonemizer: phonemizer,
        sampleRate: config.audio.sample_rate,
        hasSpeaker: Object.keys(config.speaker_id_map || {}).length > 0,
        voice: config.espeak && config.espeak.voice ? config.espeak.voice : 'en-us',
      };
      return engine;
    })();

    enginePromise.catch(function () {
      // A failed load should not poison later attempts.
      enginePromise = null;
    });
    return enginePromise;
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
    source.playbackRate.value = playbackRate;
    source.connect(gainNode);
    // `begin` is a position on the audible timeline; the buffer holds
    // playbackRate seconds of samples for every audible second.
    source.start(0, begin * playbackRate);

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

  function phonemize(text) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        phonemeLine = null;
        reject(new Error('The neural voice took too long to read the text'));
      }, 15000);

      phonemeLine = function (line) {
        clearTimeout(timer);
        let data = null;
        try {
          data = JSON.parse(line);
        } catch (error) {
          reject(new Error('The neural voice returned unreadable phoneme data'));
          return;
        }
        if (!data || !Array.isArray(data.phoneme_ids) || !data.phoneme_ids.length) {
          reject(new Error('The neural voice produced no phonemes for this text'));
          return;
        }
        resolve(data);
      };

      try {
        engine.phonemizer.callMain([
          '-l', engine.voice,
          '--input', JSON.stringify([{ text: text }]),
          '--espeak_data', '/espeak-ng-data',
        ]);
      } catch (error) {
        clearTimeout(timer);
        phonemeLine = null;
        reject(error);
      }
    });
  }

  async function synthesize(text, rate, pitch) {
    await initEngine();

    const speed = clamp(rate, 0.5, 2);
    const pitchFactor = clamp(pitch, 0.5, 2);
    // Piper exposes speaking rate through length_scale (higher is slower).
    // Synthesizing at pitchFactor/rate and playing back at pitchFactor gives
    // a pitch shift while keeping the requested speed.
    const baseScale = engine.config.inference.length_scale || 1;
    const lengthScale = clamp(baseScale * pitchFactor / speed, 0.2, 4);

    const started = performance.now();
    const phonemeData = await phonemize(text);
    const ids = BigInt64Array.from(phonemeData.phoneme_ids.map(BigInt));
    const length = ids.length;

    const feeds = {
      input: new engine.ort.Tensor('int64', ids, [1, length]),
      input_lengths: new engine.ort.Tensor('int64', BigInt64Array.from([BigInt(length)]), [1]),
      scales: new engine.ort.Tensor('float32', Float32Array.from([
        engine.config.inference.noise_scale,
        lengthScale,
        engine.config.inference.noise_w,
      ]), [3]),
    };
    if (engine.hasSpeaker) {
      feeds.sid = new engine.ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    }

    const output = await engine.session.run(feeds);
    const pcm = output.output.data;

    let peak = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const value = Math.abs(pcm[i]);
      if (value > peak) peak = value;
    }
    if (!pcm.length || peak === 0) {
      throw new Error('The neural voice produced silence');
    }

    await ensureAudioContext();
    const audioBuffer = audioContext.createBuffer(1, pcm.length, engine.sampleRate);
    audioBuffer.copyToChannel(pcm, 0);

    const audibleDuration = audioBuffer.duration / pitchFactor;
    const synthesis = {
      engine: 'bundled',
      voice: VOICE_LABEL,
      voiceId: VOICE_ID,
      phonemes: length,
      pcmSamples: pcm.length,
      sampleRate: engine.sampleRate,
      duration: audibleDuration,
      synthesizeMs: Math.round(performance.now() - started),
      peak: Number(peak.toFixed(4)),
      rate: speed,
      pitch: pitchFactor,
      lengthScale: Number(lengthScale.toFixed(3)),
    };

    return {
      buffer: audioBuffer,
      playbackRate: pitchFactor,
      duration: audibleDuration,
      synthesis: synthesis,
    };
  }

  async function prepare(text, rate, pitch) {
    const key = keyFor(text, rate, pitch);
    if (prepared && prepared.key === key) return prepared;
    const epoch = prepareEpoch;
    return enqueue(async function () {
      if (prepared && prepared.key === key) return prepared;
      const result = await synthesize(text, rate, pitch);
      if (epoch === prepareEpoch) prepared = Object.assign({ key: key }, result);
      return result;
    });
  }

  async function speak(text, rate, pitch, startAt, token, tabId) {
    const started = performance.now();
    const key = keyFor(text, rate, pitch);
    let result = null;
    let usedPrepared = false;

    if (prepared && prepared.key === key) {
      result = prepared;
      prepared = null;
      usedPrepared = true;
    } else {
      result = await enqueue(function () { return synthesize(text, rate, pitch); });
    }

    buffer = result.buffer;
    playbackRate = result.playbackRate;
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
        await initEngine();
        return {
          ok: true,
          engine: 'bundled',
          ready: true,
          voice: VOICE_ID,
          sampleRate: engine.sampleRate,
        };
      }
      case 'bundled-synthesize': {
        const result = await enqueue(function () {
          return synthesize(String(message.text || ''), message.rate, message.pitch);
        });
        return {
          ok: true,
          engine: 'bundled',
          duration: result.duration,
          synthesis: result.synthesis,
        };
      }
      case 'bundled-prepare': {
        const result = await prepare(String(message.text || ''), message.rate, message.pitch);
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
        const result = await speak(
          String(message.text || ''),
          message.rate,
          message.pitch,
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
          voice: VOICE_ID,
          state: playing ? 'playing' : paused ? 'paused' : 'idle',
          offset: liveOffset(),
          duration: duration,
          playbackRate: playbackRate,
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
})();
