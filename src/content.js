/**
 * Read Aloud content script.
 *
 * Reads the current selection, or the whole page, using the Web Speech API
 * (system voices only, no network service). Speaks one sentence per utterance
 * so the CSS Custom Highlight API can follow the spoken sentence.
 */
(function () {
  'use strict';

  if (globalThis.__TTS_CONTENT_LOADED__) return;
  globalThis.__TTS_CONTENT_LOADED__ = true;

  const HIGHLIGHT_NAME = 'tts-extension-reading';
  const MAX_UTTERANCE_LENGTH = 240;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'SVG', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP',
  ]);

  const settings = { rate: 1, pitch: 1, voice: '', engine: 'auto' };

  let status = 'idle'; // idle | playing | paused
  let index = -1;
  let sentences = [];
  let source = null;
  let error = '';
  let generation = 0;
  let currentUtterance = null;
  let startWatchdog = null;
  let lastBoundaryOffset = 0;
  let pausedCharOffset = 0;

  let activeEngine = null; // system | bundled, for the current reading
  let detectedEngine = null;
  let engineDetection = null;
  let engineDetectionPreference = null;
  let engineDetectionId = 0;
  let bundledToken = 0;
  let bundledUsed = false;
  let bundledDuration = 0;
  let pausedTimeOffset = 0;

  function getEngine() {
    if (globalThis.__TTS_ENGINE__) return globalThis.__TTS_ENGINE__;
    return typeof window !== 'undefined' ? window.speechSynthesis : null;
  }

  function makeUtterance(text) {
    const Ctor = globalThis.SpeechSynthesisUtterance ||
      (typeof window !== 'undefined' && window.SpeechSynthesisUtterance);
    if (!Ctor) throw new Error('SpeechSynthesisUtterance is unavailable');
    return new Ctor(text);
  }

  function clamp(value, min, max, fallback) {
    const number = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function applySettings(input) {
    if (!input || typeof input !== 'object') return;
    settings.rate = clamp(input.rate, 0.5, 2, settings.rate);
    settings.pitch = clamp(input.pitch, 0, 2, settings.pitch);
    if (typeof input.voice === 'string') settings.voice = input.voice;
    if (input.engine === 'auto' || input.engine === 'system' || input.engine === 'bundled') {
      settings.engine = input.engine;
    }
  }

  function listVoices() {
    const engine = getEngine();
    let voices = [];
    try {
      voices = (engine && engine.getVoices && engine.getVoices()) || [];
    } catch (err) {
      voices = [];
    }
    const result = [];
    const seen = new Set();
    for (const voice of voices) {
      if (!voice || typeof voice.name !== 'string' || seen.has(voice.name)) continue;
      seen.add(voice.name);
      result.push({
        name: voice.name,
        lang: voice.lang || '',
        default: Boolean(voice.default),
        localService: voice.localService !== false,
      });
      // Some Linux speech-dispatcher installs expose thousands of variants;
      // a 300-entry picker is already more than anyone scrolls.
      if (result.length >= 300) break;
    }
    return result;
  }

  function findVoice(name) {
    const engine = getEngine();
    if (!engine || !engine.getVoices) return null;
    try {
      const voices = engine.getVoices() || [];
      return voices.find(function (voice) { return voice.name === name; }) || null;
    } catch (err) {
      return null;
    }
  }

  function countVoices() {
    const engine = getEngine();
    try {
      return engine && engine.getVoices ? (engine.getVoices() || []).length : 0;
    } catch (err) {
      return 0;
    }
  }

  function waitForVoices(timeout) {
    const engine = getEngine();
    if (!engine || !engine.addEventListener) {
      return new Promise(function (resolve) { setTimeout(resolve, Math.min(timeout, 250)); });
    }
    return new Promise(function (resolve) {
      let finished = false;
      let timer = null;
      function finish() {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        try { engine.removeEventListener('voiceschanged', finish); } catch (err) { /* no-op */ }
        resolve();
      }
      timer = setTimeout(finish, timeout);
      try {
        engine.addEventListener('voiceschanged', finish);
      } catch (err) {
        finish();
      }
    });
  }

  function enginePreference() {
    return settings.engine === 'system' || settings.engine === 'bundled' ? settings.engine : 'auto';
  }

  /**
   * Pick the engine for the next reading.
   * - auto: system voices when the browser reports any, otherwise bundled.
   * - system / bundled: explicit user choice.
   * Waits briefly for asynchronously reported system voices before falling back.
   */
  async function detectEngine(force) {
    const preference = enginePreference();
    if (force) {
      detectedEngine = null;
      engineDetection = null;
      engineDetectionPreference = null;
    }

    if (detectedEngine && detectedEngine.preference === preference) {
      const stale = preference === 'auto' &&
        detectedEngine.type === 'bundled' &&
        countVoices() > 0;
      if (!stale) return detectedEngine;
      detectedEngine = null;
    }

    if (engineDetection && engineDetectionPreference === preference) {
      return engineDetection;
    }

    if (!engineDetection || engineDetectionPreference !== preference) {
      const detectionId = ++engineDetectionId;
      engineDetectionPreference = preference;
      engineDetection = (async function () {
        let voiceCount = countVoices();
        if (preference !== 'bundled' && voiceCount === 0) {
          await waitForVoices(700);
          voiceCount = countVoices();
        }

        let type;
        if (preference === 'bundled') type = 'bundled';
        else if (preference === 'system') type = 'system';
        else type = voiceCount > 0 ? 'system' : 'bundled';

        const info = {
          type: type,
          label: type === 'bundled' ? 'Bundled neural voice (Piper)' : 'System voices',
          voiceCount: voiceCount,
          preference: preference,
        };
        detectedEngine = info;
        if (detectionId === engineDetectionId) {
          engineDetection = null;
          engineDetectionPreference = null;
        }
        return info;
      })();
    }

    return engineDetection;
  }

  function sendOffscreen(message, timeout) {
    const payload = Object.assign({ __tts: true, target: 'offscreen' }, message);
    if (!timeout) return chrome.runtime.sendMessage(payload);

    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error('The bundled voice did not respond in time'));
      }, timeout);
      chrome.runtime.sendMessage(payload).then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  function setStatus(next) {
    status = next;
    document.documentElement.dataset.ttsStatus = next;
  }

  function snapshot() {
    const current = index >= 0 && index < sentences.length ? sentences[index] : null;
    const engineType = activeEngine || (detectedEngine ? detectedEngine.type : null);
    return {
      ok: true,
      status: status,
      index: index,
      total: sentences.length,
      source: source,
      sentence: current ? current.text : '',
      error: error,
      duration: bundledDuration,
      engine: engineType,
      engineLabel: engineType === 'bundled'
        ? 'Bundled neural voice'
        : engineType === 'system' ? 'System voices' : '',
      engineVoiceCount: detectedEngine ? detectedEngine.voiceCount : 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * Text collection
   * ------------------------------------------------------------------ */

  function blockOf(element) {
    let node = element;
    while (node && node !== document.body) {
      let display = '';
      try {
        display = getComputedStyle(node).display;
      } catch (err) {
        display = '';
      }
      if (display && display.indexOf('inline') !== 0 && display !== 'contents') return node;
      node = node.parentElement;
    }
    return document.body;
  }

  function isVisibleTextNode(node) {
    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.closest('script, style, noscript, template, textarea, select, [aria-hidden="true"]')) return false;
    let closestSkipped = false;
    try {
      closestSkipped = Boolean(parent.closest('[hidden]'));
    } catch (err) {
      closestSkipped = false;
    }
    if (closestSkipped) return false;
    if (parent.checkVisibility) {
      try {
        if (!parent.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
      } catch (err) {
        /* older Chromium: fall through */
      }
    }
    return true;
  }

  /**
   * Build one continuous text string from the document (or a selection),
   * plus a map back to DOM text nodes so sentences can be highlighted.
   */
  function collectText() {
    const selection = window.getSelection();
    const selected = selection && selection.rangeCount > 0 && selection.toString().trim()
      ? selection.getRangeAt(0)
      : null;

    const root = document.body;
    if (!root) return { text: '', runs: [], source: 'page' };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !/\S/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (!isVisibleTextNode(node)) return NodeFilter.FILTER_REJECT;
        if (selected && !selected.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const pieces = [];
    let text = '';
    let previousBlock = null;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      let start = 0;
      let end = node.nodeValue.length;

      if (selected) {
        if (node === selected.startContainer) start = Math.max(start, selected.startOffset);
        if (node === selected.endContainer) end = Math.min(end, selected.endOffset);
      }
      if (end <= start) continue;

      const raw = node.nodeValue.slice(start, end);
      if (!/\S/.test(raw)) continue;

      const block = blockOf(node.parentElement);
      if (previousBlock && block !== previousBlock) {
        if (!/\s$/.test(text)) text += '\n\n';
      } else if (previousBlock && text && !/\s$/.test(text) && !/^\s/.test(raw)) {
        // Adjacent text nodes inside the same inline flow: preserve exact flow.
      }

      const globalStart = text.length;
      text += raw;
      pieces.push({
        node: node,
        nodeStart: start,
        length: raw.length,
        globalStart: globalStart,
      });
      previousBlock = block;
    }

    return { text: text, runs: pieces, source: selected ? 'selection' : 'page' };
  }

  function pointAt(runs, offset) {
    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      if (offset >= run.globalStart && offset < run.globalStart + run.length) {
        return { node: run.node, offset: run.nodeStart + (offset - run.globalStart) };
      }
    }
    return null;
  }

  function rangeFor(runs, start, end) {
    if (!runs.length) return null;
    const from = pointAt(runs, start);
    const last = pointAt(runs, Math.max(start, end - 1));
    if (!from || !last) return null;
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(last.node, last.offset + 1);
    } catch (err) {
      return null;
    }
    return range;
  }

  /* ------------------------------------------------------------------ *
   * Highlighting
   * ------------------------------------------------------------------ */

  function applyHighlight(range) {
    if (!range) return;
    if (globalThis.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    }
    try {
      const rect = range.getBoundingClientRect();
      if (rect && rect.height > 0 && (rect.top < 0 || rect.bottom > window.innerHeight)) {
        const element = range.startContainer.parentElement;
        if (element) element.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    } catch (err) {
      /* scrolling is best effort */
    }
  }

  function clearHighlight() {
    if (globalThis.CSS && CSS.highlights) CSS.highlights.delete(HIGHLIGHT_NAME);
  }

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  function fail(reason) {
    if (startWatchdog) {
      clearTimeout(startWatchdog);
      startWatchdog = null;
    }
    if (activeEngine === 'bundled' && bundledUsed) {
      bundledToken += 1;
      sendOffscreen({ type: 'bundled-stop' }).catch(function () { /* no doc */ });
      bundledUsed = false;
    }
    error = reason || 'Speech failed';
    setStatus('idle');
    index = -1;
    clearHighlight();
    document.documentElement.dataset.ttsError = error;
  }

  function clearStartWatchdog() {
    if (startWatchdog) {
      clearTimeout(startWatchdog);
      startWatchdog = null;
    }
  }

  function finishReading() {
    clearStartWatchdog();
    setStatus('idle');
    index = -1;
    clearHighlight();
    document.documentElement.dataset.ttsError = '';
  }

  function speakSystemFrom(next, activeGeneration, startOffset) {
    if (activeGeneration !== generation) return;
    clearStartWatchdog();
    if (next >= sentences.length) {
      finishReading();
      return;
    }

    index = next;
    const item = sentences[next];
    applyHighlight(item.range);

    const offset = Math.max(0, Math.min(startOffset || 0, item.text.length));
    const spokenText = offset > 0 ? item.text.slice(offset) : item.text;
    lastBoundaryOffset = offset;

    if (!spokenText.trim()) {
      speakSystemFrom(next + 1, activeGeneration, 0);
      return;
    }

    let utterance;
    try {
      utterance = makeUtterance(spokenText);
    } catch (err) {
      fail('Speech synthesis is not available in this browser.');
      return;
    }

    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;

    const voice = settings.voice ? findVoice(settings.voice) : null;
    if (voice) {
      utterance.voice = voice;
      if (voice.lang) utterance.lang = voice.lang;
    }

    const spokenIndex = next;
    let started = false;
    utterance.onstart = function () {
      if (activeGeneration !== generation) return;
      started = true;
      clearStartWatchdog();
      setStatus('playing');
      applyHighlight(item.range);
    };
    utterance.onboundary = function (event) {
      if (activeGeneration !== generation) return;
      if (event && typeof event.charIndex === 'number') {
        lastBoundaryOffset = offset + event.charIndex;
      }
    };
    utterance.onend = function () {
      clearStartWatchdog();
      if (activeGeneration !== generation) return;
      if (spokenIndex === index) {
        pausedCharOffset = 0;
        speakSystemFrom(spokenIndex + 1, activeGeneration, 0);
      }
    };
    utterance.onerror = function (event) {
      clearStartWatchdog();
      if (activeGeneration !== generation) return;
      const reason = event && event.error;
      if (reason === 'interrupted' || reason === 'canceled') return;
      fail(reason || 'Speech synthesis failed');
    };

    // If the engine never starts (for example the machine has no voices),
    // surface an error instead of leaving the popup stuck on "playing".
    startWatchdog = setTimeout(function () {
      startWatchdog = null;
      if (activeGeneration !== generation || started) return;
      const activeEngine = getEngine();
      if (activeEngine && (activeEngine.speaking || activeEngine.pending)) return;
      fail('No speech started. Check that a system voice is installed.');
    }, 4000);

    currentUtterance = utterance;
    document.documentElement.dataset.ttsError = '';

    const engine = getEngine();
    if (!engine) {
      fail('Speech synthesis is not available in this browser.');
      return;
    }
    try {
      if (engine.paused) engine.resume();
      engine.speak(utterance);
      setStatus('playing');
    } catch (err) {
      fail(String(err && err.message ? err.message : err));
    }
  }

  async function startReading(inputSettings) {
    applySettings(inputSettings);

    generation += 1;
    const activeGeneration = generation;
    clearStartWatchdog();

    const systemEngine = getEngine();
    if (systemEngine) {
      try { systemEngine.cancel(); } catch (err) { /* no-op */ }
    }
    const previous = currentUtterance;
    currentUtterance = null;
    if (previous) {
      previous.onend = null;
      previous.onerror = null;
      previous.onstart = null;
      previous.onboundary = null;
    }

    if (bundledUsed) {
      bundledToken += 1;
      sendOffscreen({ type: 'bundled-stop' }).catch(function () { /* no doc */ });
    }
    bundledUsed = false;
    bundledDuration = 0;
    pausedTimeOffset = 0;
    activeEngine = null;

    clearHighlight();
    error = '';
    pausedCharOffset = 0;
    lastBoundaryOffset = 0;
    document.documentElement.dataset.ttsError = '';

    // Taking a beat here lets Chrome report system voices that load
    // asynchronously; with none, the bundled voice is chosen.
    const engineInfo = await detectEngine();
    if (activeGeneration !== generation) return snapshot();

    const collected = collectText();
    source = collected.source;
    // Drop the native blue selection so only the spoken-sentence highlight
    // stays visible while reading.
    if (source === 'selection') {
      try {
        const activeSelection = window.getSelection();
        if (activeSelection) activeSelection.removeAllRanges();
      } catch (err) {
        /* no-op */
      }
    }
    const parts = globalThis.TTSSentence
      ? globalThis.TTSSentence.splitSentences(collected.text, { maxLength: MAX_UTTERANCE_LENGTH })
      : [];

    sentences = parts.map(function (part) {
      return {
        text: part.text,
        start: part.start,
        end: part.end,
        range: rangeFor(collected.runs, part.start, part.end),
      };
    });

    if (!sentences.length) {
      sentences = [];
      index = -1;
      setStatus('idle');
      fail(source === 'selection' ? 'The selection has no readable text.' : 'No readable text found on this page.');
      return snapshot();
    }

    activeEngine = engineInfo.type;
    index = -1;
    setStatus('playing');

    if (activeEngine === 'bundled') {
      speakBundledFrom(0, activeGeneration, 0);
    } else if (!getEngine()) {
      fail('Speech synthesis is not available in this browser.');
    } else {
      speakSystemFrom(0, activeGeneration, 0);
    }
    return snapshot();
  }

  /**
   * Ask the offscreen document to synthesize a sentence while another one is
   * playing. Failures are silent: the next `bundled-speak` synthesizes on
   * demand if the prefetch did not finish.
   */
  function prefetchBundled(next) {
    if (next < 0 || next >= sentences.length) return;
    const item = sentences[next];
    sendOffscreen({
      type: 'bundled-prepare',
      text: item.text,
      rate: settings.rate,
      pitch: settings.pitch,
    }, 20000).catch(function () { /* synthesized on demand instead */ });
  }

  async function speakBundledFrom(next, activeGeneration, startAt) {
    if (activeGeneration !== generation) return;
    clearStartWatchdog();
    if (next >= sentences.length) {
      finishReading();
      return;
    }

    index = next;
    const item = sentences[next];
    applyHighlight(item.range);
    setStatus('playing');

    bundledUsed = true;
    bundledToken += 1;
    const token = bundledToken;
    bundledDuration = 0;

    try {
      const response = await sendOffscreen({
        type: 'bundled-speak',
        text: item.text,
        rate: settings.rate,
        pitch: settings.pitch,
        startAt: startAt || 0,
        token: token,
      }, 30000);

      if (activeGeneration !== generation) return;

      if (!response || !response.ok) {
        fail(response && response.error ? response.error : 'The bundled voice failed to start.');
        return;
      }

      bundledDuration = response.duration || 0;
      if (typeof response.offset === 'number') pausedTimeOffset = response.offset;
      setStatus('playing');

      // Synthesize the next sentence while this one plays, so playback never
      // waits for the neural model between sentences.
      prefetchBundled(next + 1);
    } catch (err) {
      if (activeGeneration !== generation) return;
      fail('The bundled voice is unavailable: ' + (err && err.message ? err.message : err));
    }
  }

  async function pauseReading() {
    if (status !== 'playing') return snapshot();

    const engineType = activeEngine;
    generation += 1;
    clearStartWatchdog();

    if (engineType === 'bundled') {
      bundledToken += 1;
      pausedTimeOffset = 0;
      setStatus('paused');
      try {
        const response = await sendOffscreen({ type: 'bundled-pause' }, 4000);
        if (response && typeof response.offset === 'number') pausedTimeOffset = response.offset;
      } catch (err) {
        /* fall back to restarting the sentence */
      }
    } else {
      // Chrome's speechSynthesis.pause() is unreliable for system voices (it
      // is a no-op with speech-dispatcher on Linux), so stop the utterance and
      // remember the last word boundary. Resume re-speaks from there.
      const item = index >= 0 && index < sentences.length ? sentences[index] : null;
      pausedCharOffset = item ? Math.max(0, Math.min(lastBoundaryOffset, item.text.length)) : 0;
      const engine = getEngine();
      if (engine) {
        try { engine.cancel(); } catch (err) { /* no-op */ }
      }
      currentUtterance = null;
      setStatus('paused');
    }

    document.documentElement.dataset.ttsError = '';
    return snapshot();
  }

  async function resumeReading() {
    if (status !== 'paused') return snapshot();
    if (index < 0 || index >= sentences.length) {
      setStatus('idle');
      return snapshot();
    }

    generation += 1;
    const activeGeneration = generation;
    setStatus('playing');

    if (activeEngine === 'bundled') {
      const offset = pausedTimeOffset;
      pausedTimeOffset = 0;
      await speakBundledFrom(index, activeGeneration, offset);
    } else {
      const offset = pausedCharOffset;
      pausedCharOffset = 0;
      speakSystemFrom(index, activeGeneration, offset);
    }
    return snapshot();
  }

  function stopReading() {
    generation += 1;
    bundledToken += 1;
    clearStartWatchdog();

    const engine = getEngine();
    if (engine) {
      try { engine.cancel(); } catch (err) { /* no-op */ }
    }
    if (bundledUsed) {
      sendOffscreen({ type: 'bundled-stop' }).catch(function () { /* no doc */ });
    }

    bundledUsed = false;
    bundledDuration = 0;
    pausedTimeOffset = 0;
    activeEngine = null;
    currentUtterance = null;
    sentences = [];
    index = -1;
    error = '';
    pausedCharOffset = 0;
    lastBoundaryOffset = 0;
    source = null;
    clearHighlight();
    setStatus('idle');
    document.documentElement.dataset.ttsError = '';
    return snapshot();
  }

  function handleBundledEnded(message) {
    if (message.token !== bundledToken) return;
    if (activeEngine !== 'bundled' || status !== 'playing') return;
    speakBundledFrom(index + 1, generation, 0);
  }

  function toggleReading(inputSettings) {
    if (status === 'playing') return pauseReading();
    if (status === 'paused') return resumeReading();
    return startReading(inputSettings);
  }

  function respondWith(promise, sendResponse) {
    promise.then(sendResponse).catch(function (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    });
  }

  /* ------------------------------------------------------------------ *
   * Messaging
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.__tts !== true) return undefined;
    if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return undefined;
    if (message.target === 'offscreen' || message.target === 'background') return undefined;

    switch (message.type) {
      case 'ping':
      case 'status':
        sendResponse(snapshot());
        return undefined;
      case 'engine':
        applySettings(message.settings);
        respondWith(detectEngine().then(function (info) {
          return { ok: true, engine: info };
        }), sendResponse);
        return true;
      case 'play':
        respondWith(startReading(message.settings), sendResponse);
        return true;
      case 'pause':
        respondWith(pauseReading(), sendResponse);
        return true;
      case 'resume':
        respondWith(resumeReading(), sendResponse);
        return true;
      case 'stop':
        sendResponse(stopReading());
        return undefined;
      case 'toggle':
        respondWith(toggleReading(message.settings), sendResponse);
        return true;
      case 'bundled-ended':
        if (message.fromBackground) handleBundledEnded(message);
        return undefined;
      case 'settings':
        applySettings(message.settings);
        sendResponse(snapshot());
        return undefined;
      case 'voices': {
        const immediate = listVoices();
        if (immediate.length) {
          sendResponse({ ok: true, voices: immediate });
          return undefined;
        }
        const engine = getEngine();
        let finished = false;
        let timer = null;
        function finish() {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          if (engine && engine.removeEventListener) {
            try { engine.removeEventListener('voiceschanged', finish); } catch (err) { /* no-op */ }
          }
          sendResponse({ ok: true, voices: listVoices() });
        }
        if (engine && engine.addEventListener) {
          try { engine.addEventListener('voiceschanged', finish); } catch (err) { /* no-op */ }
        }
        timer = setTimeout(finish, 1000);
        return true;
      }
      default:
        return undefined;
    }
  });

  globalThis.__TTS_CONTENT__ = {
    snapshot: snapshot,
    getSentences: function () {
      return sentences.map(function (item) { return item.text; });
    },
  };

  document.documentElement.dataset.ttsReady = '1';
})();
