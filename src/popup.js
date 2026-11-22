/* Read Aloud popup: transport controls, voice settings, live status. */
(function () {
  'use strict';

  const DEFAULT_SETTINGS = { rate: 1, pitch: 1, voice: '', engine: 'auto' };
  const RESTRICTED_SCHEMES = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;

  const elements = {
    play: document.getElementById('play'),
    pause: document.getElementById('pause'),
    resume: document.getElementById('resume'),
    stop: document.getElementById('stop'),
    rate: document.getElementById('rate'),
    pitch: document.getElementById('pitch'),
    voice: document.getElementById('voice'),
    engine: document.getElementById('engine'),
    engineActive: document.getElementById('engine-active'),
    rateOut: document.getElementById('rate-out'),
    pitchOut: document.getElementById('pitch-out'),
    source: document.getElementById('source-label'),
    progressText: document.getElementById('progress-text'),
    progressCount: document.getElementById('progress-count'),
    progressFill: document.getElementById('progress-fill'),
    statusDot: document.getElementById('status-dot'),
    hint: document.getElementById('hint'),
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let targetTab = null;
  let lastStatus = null;
  let pollTimer = null;
  let pollBusy = false;
  let saveTimer = null;
  let voicesLoaded = false;
  let currentEngine = null;
  let warmedUp = false;

  function clamp(value, min, max, fallback) {
    const number = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalize(input) {
    const raw = input && typeof input === 'object' ? input : {};
    return {
      rate: clamp(raw.rate, 0.5, 2, DEFAULT_SETTINGS.rate),
      pitch: clamp(raw.pitch, 0, 2, DEFAULT_SETTINGS.pitch),
      voice: typeof raw.voice === 'string' ? raw.voice : DEFAULT_SETTINGS.voice,
      engine: raw.engine === 'system' || raw.engine === 'bundled' ? raw.engine : DEFAULT_SETTINGS.engine,
    };
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get({ ttsSettings: DEFAULT_SETTINGS });
      settings = normalize(stored.ttsSettings);
    } catch (err) {
      settings = Object.assign({}, DEFAULT_SETTINGS);
    }
    elements.rate.value = String(settings.rate);
    elements.pitch.value = String(settings.pitch);
    elements.engine.value = settings.engine;
    updateOutputs();
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({ ttsSettings: settings });
    } catch (err) {
      /* storage can fail in private windows; keep the in-memory value */
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 120);
  }

  function updateOutputs() {
    elements.rateOut.textContent = settings.rate.toFixed(1) + '\u00d7';
    elements.pitchOut.textContent = settings.pitch.toFixed(1);
  }

  function isReadableUrl(url) {
    if (!url) return true;
    return !RESTRICTED_SCHEMES.test(url);
  }

  async function resolveTargetTab() {
    let active = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      active = tabs && tabs[0] ? tabs[0] : null;
    } catch (err) {
      active = null;
    }

    if (active && active.id !== undefined && !/^chrome-extension:/i.test(active.url || '')) {
      return active;
    }

    // The popup can also be opened as a normal tab (handy for screenshots and
    // debugging). In that case pick the most recently used web page instead.
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const candidates = tabs
        .filter(function (tab) {
          return tab.id !== undefined && !/^chrome-extension:/i.test(tab.url || '') && isReadableUrl(tab.url);
        })
        .sort(function (a, b) {
          return (b.lastAccessed || 0) - (a.lastAccessed || 0);
        });
      if (candidates.length) return candidates[0];
    } catch (err) {
      /* fall through */
    }
    return active;
  }

  async function send(message) {
    if (!targetTab || targetTab.id === undefined) {
      throw new Error('No active tab');
    }
    return chrome.tabs.sendMessage(targetTab.id, Object.assign({ __tts: true }, message));
  }

  function showError(text) {
    elements.hint.textContent = text;
    elements.hint.classList.add('error');
    elements.statusDot.className = 'dot error';
    elements.statusDot.title = 'Error';
  }

  function clearError() {
    elements.hint.classList.remove('error');
    elements.hint.textContent = 'Select text to read just that, or press Play for the whole page.';
  }

  /**
   * Start loading the neural model while the user is still choosing
   * settings, so the first Play does not wait for a multi-second model load.
   * Only called when the bundled engine is actually going to be used.
   */
  function warmupBundledVoice() {
    if (warmedUp) return;
    warmedUp = true;
    try {
      chrome.runtime.sendMessage({
        __tts: true,
        target: 'background',
        type: 'warmup',
      }).catch(function () { /* the voice will load on first use */ });
    } catch (err) {
      /* older browsers return undefined instead of a promise */
    }
  }

  function renderEngine(info) {
    currentEngine = info || null;
    const type = info ? info.type : null;
    elements.engineActive.textContent = type === 'bundled' ? 'Bundled' : type === 'system' ? 'System' : 'Unknown';
    elements.engineActive.title = type === 'bundled'
      ? 'Bundled neural voice (Piper); no system voices needed'
      : type === 'system'
        ? (info.voiceCount ? info.voiceCount + ' system voices available' : 'System voice engine')
        : 'Could not detect a voice engine';

    if (type === 'bundled') warmupBundledVoice();

    const first = elements.voice.querySelector('option[value=""]');
    if (first) first.textContent = type === 'bundled' ? 'Piper English (US)' : 'System default';
  }

  function renderVoices(voices) {
    const select = elements.voice;
    const previous = settings.voice;
    select.innerHTML = '';

    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = currentEngine && currentEngine.type === 'bundled' ? 'Piper English (US)' : 'System default';
    select.appendChild(fallback);

    const seen = new Set();
    voices.forEach(function (voice) {
      if (!voice || !voice.name || seen.has(voice.name)) return;
      seen.add(voice.name);
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = voice.lang ? voice.name + ' (' + voice.lang + ')' : voice.name;
      select.appendChild(option);
    });

    if (previous && !seen.has(previous)) {
      const option = document.createElement('option');
      option.value = previous;
      option.textContent = previous + ' (not available now)';
      select.appendChild(option);
    }

    select.value = previous || '';
    voicesLoaded = true;
  }

  async function loadVoices() {
    let voices = [];
    try {
      const response = await send({ type: 'voices' });
      if (response && Array.isArray(response.voices)) voices = response.voices;
    } catch (err) {
      voices = [];
    }
    if (!voices.length && typeof speechSynthesis !== 'undefined') {
      try {
        voices = (speechSynthesis.getVoices() || []).slice(0, 300).map(function (voice) {
          return { name: voice.name, lang: voice.lang, default: voice.default };
        });
      } catch (err) {
        voices = [];
      }
    }
    renderVoices(voices);
  }

  function renderStatus(status) {
    lastStatus = status || null;

    if (!status || !status.ok) {
      elements.source.textContent = 'No page connected';
      elements.progressText.textContent = 'Nothing playing';
      elements.progressCount.textContent = '';
      elements.progressFill.style.width = '0%';
      elements.statusDot.className = 'dot idle';
      elements.statusDot.title = 'Idle';
      elements.play.disabled = false;
      elements.pause.disabled = true;
      elements.resume.disabled = true;
      elements.stop.disabled = true;
      return;
    }

    const playing = status.status === 'playing';
    const paused = status.status === 'paused';

    elements.statusDot.className = 'dot ' + (playing ? 'playing' : paused ? 'paused' : 'idle');
    elements.statusDot.title = playing ? 'Playing' : paused ? 'Paused' : 'Idle';

    elements.play.disabled = false;
    elements.pause.disabled = !playing;
    elements.resume.disabled = !paused;
    elements.stop.disabled = !playing && !paused && !status.total;

    if (status.total > 0 && status.index >= 0) {
      const percent = Math.min(100, Math.round(((status.index + 1) / status.total) * 100));
      elements.progressFill.style.width = percent + '%';
      elements.progressCount.textContent = status.index + 1 + ' / ' + status.total;
      elements.source.textContent = (status.source === 'selection' ? 'Reading selection' : 'Reading page') +
        (playing ? '' : paused ? ' \u00b7 paused' : ' \u00b7 finished');
      const preview = status.sentence || '';
      elements.progressText.textContent = playing || paused
        ? preview
        : 'Finished \u2014 press Play to read again';
      elements.progressText.title = preview;
    } else {
      elements.progressFill.style.width = '0%';
      elements.progressCount.textContent = '';
      elements.source.textContent = status.source === 'selection' ? 'Selection ready' : 'Page ready';
      elements.progressText.textContent = 'Nothing playing';
    }

    if (status.engine) {
      renderEngine({ type: status.engine, voiceCount: status.engineVoiceCount || 0 });
    }

    if (status.error) {
      showError(status.error);
    } else {
      clearError();
    }
  }

  async function loadEngine() {
    try {
      const response = await send({ type: 'engine', settings: settings });
      if (response && response.engine) renderEngine(response.engine);
    } catch (err) {
      renderEngine(null);
    }
  }

  async function poll() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const status = await send({ type: 'status' });
      renderStatus(status);
    } catch (err) {
      renderStatus(null);
      showError('This page cannot be read. Reload it, then try again.');
    } finally {
      pollBusy = false;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, 450);
  }

  async function runAction(type) {
    clearError();
    try {
      const response = await send(Object.assign({ type: type }, type === 'play' || type === 'toggle' ? { settings: settings } : {}));
      if (response) renderStatus(response);
      if (response && response.error) showError(response.error);
      if (response && response.engine) {
        renderEngine({ type: response.engine, voiceCount: response.engineVoiceCount || 0 });
      }
      if (type === 'play' && response && !response.error && settings.voice && !voicesLoaded) {
        loadVoices();
      }
    } catch (err) {
      renderStatus(null);
      showError('This page cannot be read. Reload it, then try again.');
    }
  }

  function bind() {
    elements.play.addEventListener('click', function () { runAction('play'); });
    elements.pause.addEventListener('click', function () { runAction('pause'); });
    elements.resume.addEventListener('click', function () { runAction('resume'); });
    elements.stop.addEventListener('click', function () { runAction('stop'); });

    elements.rate.addEventListener('input', function () {
      settings.rate = clamp(elements.rate.value, 0.5, 2, 1);
      updateOutputs();
      scheduleSave();
      send({ type: 'settings', settings: settings }).catch(function () {});
    });

    elements.pitch.addEventListener('input', function () {
      settings.pitch = clamp(elements.pitch.value, 0, 2, 1);
      updateOutputs();
      scheduleSave();
      send({ type: 'settings', settings: settings }).catch(function () {});
    });

    elements.voice.addEventListener('change', function () {
      settings.voice = elements.voice.value;
      scheduleSave();
      send({ type: 'settings', settings: settings }).catch(function () {});
    });

    elements.engine.addEventListener('change', function () {
      settings.engine = elements.engine.value;
      scheduleSave();
      send({ type: 'settings', settings: settings })
        .then(function () { return loadEngine(); })
        .catch(function () {});
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === ' ' && event.target === document.body) {
        event.preventDefault();
        runAction(lastStatus && lastStatus.status === 'playing' ? 'pause' : 'play');
      }
    });
  }

  async function init() {
    bind();
    await loadSettings();
    targetTab = await resolveTargetTab();

    if (!targetTab || !isReadableUrl(targetTab.url)) {
      renderStatus(null);
      showError('Chrome does not allow extensions to read this page. Try a normal website.');
      return;
    }

    await poll();
    await loadEngine();
    await loadVoices();
    startPolling();
  }

  init().catch(function (err) {
    showError('Read Aloud failed to start: ' + (err && err.message ? err.message : err));
  });
})();
