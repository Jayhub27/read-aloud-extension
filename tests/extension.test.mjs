/**
 * End-to-end verification: loads the unpacked extension in a real Chromium,
 * drives the toolbar popup, and asserts on speech-engine calls and highlights.
 *
 * Speech is observed through a deterministic in-extension test engine injected
 * into the extension's isolated world (the same world as the content script).
 * Real system voices are probed separately; audibility cannot be asserted in
 * this headless environment.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const EXTENSION_ID_HEADER = 'chrome-extension://';

/**
 * Use a Chromium already present in the Playwright cache, preferring the
 * revision this Playwright version expects. Override with TTS_CHROME.
 */
function resolveChromePath() {
  if (process.env.TTS_CHROME) return process.env.TTS_CHROME;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  const candidates = [];

  try {
    const browsers = JSON.parse(fsSync.readFileSync(
      path.join(ROOT, 'node_modules/playwright-core/browsers.json'),
      'utf8',
    ));
    const entry = browsers.browsers.find((browser) => browser.name === 'chromium');
    if (entry) {
      for (const folder of ['chrome-linux64', 'chrome-linux']) {
        candidates.push(path.join(cache, `chromium-${entry.revision}`, folder, 'chrome'));
      }
    }
  } catch (err) {
    /* fall through to the cache scan */
  }

  try {
    const dirs = fsSync.readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10));
    for (const dir of dirs) {
      for (const folder of ['chrome-linux64', 'chrome-linux']) {
        candidates.push(path.join(cache, dir, folder, 'chrome'));
      }
    }
  } catch (err) {
    /* no cache */
  }

  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  return found || chromium.executablePath();
}

const CHROME = resolveChromePath();

const FIXTURE_SENTENCES = {
  p1first: 'The quick brown fox jumps over the lazy dog.',
  p1second: 'Reading text aloud helps people focus on long documents.',
  p1third: 'A good reader marks the sentence being spoken so the eye can follow along.',
  heading: 'Reading Room',
  question: 'Why spoken words matter',
  quote: '\u201cThe limits of my language mean the limits of my world.\u201d',
};

const STUB_SOURCE = `
globalThis.__TTS_TEST_LOG__ = [];
const log = globalThis.__TTS_TEST_LOG__;
let current = null;
let timer = null;
let charIndex = 0;
const state = { speaking: false, paused: false };

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.rate = 1;
    this.pitch = 1;
    this.voice = null;
    this.lang = '';
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onboundary = null;
  }
}

function fire(utterance, name, event) {
  if (utterance && typeof utterance[name] === 'function') utterance[name](event);
}

function finishCurrent() {
  const utterance = current;
  current = null;
  state.speaking = false;
  state.paused = false;
  clearTimeout(timer);
  timer = null;
  fire(utterance, 'onend', {});
}

function tick() {
  if (!current || state.paused) return;
  const step = Math.max(1, Math.ceil(current.text.length / 10));
  const next = Math.min(current.text.length, charIndex + step);
  const event = { name: 'word', charIndex: charIndex, charLength: next - charIndex, elapsedTime: 0 };
  charIndex = next;
  fire(current, 'onboundary', event);
  if (charIndex >= current.text.length) finishCurrent();
  else timer = setTimeout(tick, 110);
}

const engine = {
  get speaking() { return state.speaking; },
  get paused() { return state.paused; },
  get pending() { return false; },
  speak(utterance) {
    if (current) finishCurrent();
    log.push({
      text: utterance.text,
      rate: utterance.rate,
      pitch: utterance.pitch,
      voice: utterance.voice ? utterance.voice.name : null,
    });
    current = utterance;
    charIndex = 0;
    state.speaking = true;
    state.paused = false;
    fire(utterance, 'onstart', {});
    timer = setTimeout(tick, 50);
  },
  pause() {
    if (state.speaking) {
      state.paused = true;
      clearTimeout(timer);
      timer = null;
    }
  },
  resume() {
    if (state.speaking && state.paused) {
      state.paused = false;
      timer = setTimeout(tick, 50);
    }
  },
  cancel() {
    clearTimeout(timer);
    timer = null;
    const utterance = current;
    current = null;
    state.speaking = false;
    state.paused = false;
    if (utterance) fire(utterance, 'onend', {});
  },
  getVoices() {
    return [
      { name: 'Test Voice A', lang: 'en-US', default: true, localService: true },
      { name: 'Test Voice B', lang: 'en-GB', default: false, localService: true },
    ];
  },
  addEventListener() {},
  removeEventListener() {},
};

globalThis.__TTS_ENGINE__ = engine;
globalThis.SpeechSynthesisUtterance = FakeUtterance;
`;

let server;
let fixtureUrl;

function startFixtureServer() {
  const handler = async (req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.split('?')[0];
    const file = path.join(ROOT, 'test-page', name);
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  };
  return new Promise((resolve) => {
    const instance = http.createServer(handler);
    instance.listen(0, '127.0.0.1', () => {
      resolve({ server: instance, url: `http://127.0.0.1:${instance.address().port}/` });
    });
  });
}

async function waitFor(check, label, options = {}) {
  const timeout = options.timeout || 6000;
  const interval = options.interval || 50;
  const started = Date.now();
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() - started > timeout) {
      throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

before(async () => {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const started = await startFixtureServer();
  server = started.server;
  fixtureUrl = started.url;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function launchWithExtension(t, extraArgs = []) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-extension-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...extraArgs,
    ],
  });

  t.after(async () => {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return { context, worker };
}

test('Read Aloud extension reads, pauses, resumes and highlights', async (t) => {
  const { context, worker } = await launchWithExtension(t);
  const extensionId = new URL(worker.url()).host;
  const tabIdOf = async () => worker.evaluate(async ({ url }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url) || tabs[0];
    return tab && tab.id;
  }, { url: fixtureUrl });

  const page = await context.newPage();
  const popup = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push('page: ' + error.message));
  popup.on('pageerror', (error) => pageErrors.push('popup: ' + error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push('page: ' + message.text());
  });
  popup.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push('popup: ' + message.text());
  });
  worker.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push('worker: ' + message.text());
  });

  await page.goto(fixtureUrl);
  await page.waitForFunction(() => document.documentElement.dataset.ttsReady === '1');
  const tabId = await tabIdOf();

  async function isolated(body) {
    const fnSource = `async () => { ${body} }`;
    return worker.evaluate(async ({ tabId, fnSource }) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: new Function(`return (${fnSource})()`),
      });
      if (result && result.error) throw new Error(result.error);
      return result ? result.result : null;
    }, { tabId, fnSource });
  }

  await worker.evaluate(async ({ tabId, source }) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: new Function(source),
    });
  }, { tabId, source: STUB_SOURCE });

  await popup.setViewportSize({ width: 340, height: 560 });
  await popup.goto(`${EXTENSION_ID_HEADER}${extensionId}/src/popup.html`);
  await popup.waitForFunction(() => document.querySelectorAll('#voice option').length > 1, { timeout: 10000 });

  const highlightText = () => page.evaluate(() => {
    const registry = CSS.highlights.get('tts-extension-reading');
    if (!registry) return null;
    return Array.from(registry).map((range) => range.toString()).join('\n');
  });

  const speechLog = () => isolated('return (globalThis.__TTS_TEST_LOG__ || []).map((entry) => entry);');

  const engineState = () => isolated('const e = globalThis.__TTS_ENGINE__; return { speaking: Boolean(e && e.speaking), paused: Boolean(e && e.paused) };');

  const snapshot = () => isolated('return globalThis.__TTS_CONTENT__.snapshot();');

  const selectText = (selector) => page.evaluate((sel) => {
    const element = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);

  const clearSelection = () => page.evaluate(() => window.getSelection().removeAllRanges());

  const sourceLabel = () => popup.locator('#source-label').textContent();
  const progressText = () => popup.locator('#progress-text').textContent();
  const progressCount = () => popup.locator('#progress-count').textContent();

  await t.test('loads without errors and detects the fixture page', async () => {
    assert.match(worker.url(), /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/);
    assert.equal(await sourceLabel(), 'Page ready');
    assert.equal(await popup.locator('#status-dot').getAttribute('class'), 'dot idle');
    const voices = await popup.locator('#voice option').allTextContents();
    assert.ok(voices.includes('Test Voice A (en-US)'), 'voice picker is populated from the page engine');
    assert.equal(await popup.locator('#engine-active').textContent(), 'System', 'system voices are preferred when present');
    assert.equal(await popup.inputValue('#engine'), 'auto');
    assert.deepEqual(pageErrors, []);
  });

  await t.test('reads only the selected text and highlights its first sentence', async () => {
    await selectText('#p1');
    await popup.click('#play');

    await waitFor(async () => (await sourceLabel()) === 'Reading selection', 'selection source label');
    await waitFor(async () => (await highlightText()) === FIXTURE_SENTENCES.p1first, 'first sentence highlight');

    const log = await speechLog();
    assert.ok(log.length >= 1, 'at least one utterance was sent to the engine');
    assert.equal(log[0].text, FIXTURE_SENTENCES.p1first);
    assert.equal(log[0].rate, 1);
    assert.equal(log[0].pitch, 1);
    assert.equal(log[0].voice, null, 'default voice is used until one is picked');

    const engine = await engineState();
    assert.equal(engine.speaking, true, 'speech engine reports speaking');
    assert.equal(engine.paused, false);

    const state = await snapshot();
    assert.equal(state.source, 'selection');
    assert.equal(state.total, 3, 'three sentences in the selected paragraph');
    assert.equal(state.status, 'playing');
    assert.match(await progressCount(), /^\d+ \/ 3$/);
    assert.equal(await highlightText(), state.sentence, 'highlight follows the current sentence');

    const nativeSelection = await page.evaluate(() => window.getSelection().toString());
    assert.equal(nativeSelection, '', 'native selection is cleared so the highlight is visible');

    assert.match(await popup.locator('#hint').textContent(), /Select text/);
  });

  let pausedState = null;
  let pausedLogLength = 0;
  let pausedHighlight = null;

  await t.test('pause stops the engine and freezes the highlight', async () => {
    await popup.click('#pause');
    await waitFor(async () => (await sourceLabel()).includes('paused'), 'paused label');

    const engine = await engineState();
    assert.equal(engine.speaking, false, 'engine is stopped, not just marked paused');
    assert.equal(engine.paused, false, 'the platform pause flag is irrelevant now');

    pausedState = await snapshot();
    pausedHighlight = await highlightText();
    pausedLogLength = (await speechLog()).length;
    assert.equal(pausedState.status, 'paused');
    assert.equal(pausedHighlight, pausedState.sentence, 'highlight stays on the paused sentence');
    assert.ok(pausedState.sentence.length > 0);

    await page.waitForTimeout(900);
    assert.equal((await speechLog()).length, pausedLogLength, 'no new utterance starts while paused');
    assert.equal(await highlightText(), pausedHighlight, 'highlight stays on the paused sentence');
    const afterWait = await snapshot();
    assert.equal(afterWait.index, pausedState.index, 'sentence index is frozen while paused');
  });

  await t.test('resume re-speaks from the paused point and moves on', async () => {
    await popup.click('#resume');
    await waitFor(async () => (await sourceLabel()) === 'Reading selection', 'playing label after resume');

    const engine = await engineState();
    assert.equal(engine.speaking, true, 'engine is speaking again');

    await waitFor(async () => (await speechLog()).length > pausedLogLength, 'resumed utterance', { timeout: 4000 });
    const log = await speechLog();
    const resumedText = log[pausedLogLength].text;
    assert.ok(resumedText.length > 0, 'resume sends the remaining text to the engine');
    assert.ok(
      pausedState.sentence.endsWith(resumedText) || resumedText === FIXTURE_SENTENCES.p1second,
      'resume restarts at the paused position, not from the beginning of the page',
    );

    await waitFor(async () => {
      const current = await snapshot();
      return current.index > pausedState.index || (current.status === 'idle' && current.total > 0);
    }, 'playback to advance past the paused sentence', { timeout: 6000 });

    const advanced = await snapshot();
    if (advanced.status === 'playing' || advanced.status === 'paused') {
      assert.equal(await highlightText(), advanced.sentence, 'highlight follows the new sentence');
    }
  });

  await t.test('stop clears speech and the highlight', async () => {
    await popup.click('#stop');
    await waitFor(async () => (await sourceLabel()) === 'Page ready', 'idle label after stop');

    assert.equal(await highlightText(), null);
    const engine = await engineState();
    assert.equal(engine.speaking, false);
    assert.equal(engine.paused, false);
    const state = await snapshot();
    assert.equal(state.status, 'idle');
    assert.equal(state.total, 0);
    assert.equal(await progressCount(), '');
  });

  await t.test('reads the whole page when nothing is selected', async () => {
    await clearSelection();
    const beforePlay = (await speechLog()).length;
    await popup.click('#play');
    await waitFor(async () => (await sourceLabel()) === 'Reading page', 'page source label');

    const state = await snapshot();
    assert.equal(state.source, 'page');
    assert.ok(state.total >= 10, `page has many sentences, got ${state.total}`);

    const log = await speechLog();
    assert.equal(log[beforePlay].text, FIXTURE_SENTENCES.heading, 'page reading starts at the heading');
    await waitFor(async () => (await highlightText()) === FIXTURE_SENTENCES.heading, 'page heading highlight');
    assert.match(await progressCount(), new RegExp('^\\d+ / ' + state.total + '$'));

    await waitFor(async () => {
      const sentences = await isolated('return globalThis.__TTS_CONTENT__.getSentences();');
      return sentences.includes(FIXTURE_SENTENCES.question) && sentences.includes(FIXTURE_SENTENCES.p1third);
    }, 'page sentences to include headings and paragraphs');

    await popup.click('#stop');
    await waitFor(async () => (await sourceLabel()) === 'Page ready', 'idle after page reading');
  });

  await t.test('speed, pitch and voice persist across popup reloads', async () => {
    await popup.evaluate(() => {
      const rate = document.getElementById('rate');
      rate.value = '1.6';
      rate.dispatchEvent(new Event('input', { bubbles: true }));
      const pitch = document.getElementById('pitch');
      pitch.value = '0.7';
      pitch.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await popup.selectOption('#voice', 'Test Voice B');
    await popup.waitForTimeout(400);

    const stored = await worker.evaluate(async () => {
      const result = await chrome.storage.local.get('ttsSettings');
      return result.ttsSettings;
    });
    assert.deepEqual(stored, { rate: 1.6, pitch: 0.7, voice: 'Test Voice B', engine: 'auto' });

    await popup.reload();
    await popup.waitForFunction(() => document.querySelectorAll('#voice option').length > 1, { timeout: 10000 });
    assert.equal(await popup.inputValue('#rate'), '1.6');
    assert.equal(await popup.inputValue('#pitch'), '0.7');
    assert.equal(await popup.inputValue('#voice'), 'Test Voice B');
    assert.equal(await popup.locator('#rate-out').textContent(), '1.6\u00d7');
    assert.equal(await popup.locator('#pitch-out').textContent(), '0.7');

    await selectText('#p2');
    await popup.click('#play');
    await waitFor(async () => (await speechLog()).length > 0, 'reading with saved settings');
    const log = await speechLog();
    const last = log[log.length - 1];
    assert.equal(last.rate, 1.6);
    assert.equal(last.pitch, 0.7);
    assert.equal(last.voice, 'Test Voice B');
    assert.equal(await sourceLabel(), 'Reading selection');
    assert.match(await popup.locator('#hint').textContent(), /Select text/, 'no error is shown');
    await popup.click('#stop');
  });

  await t.test('context menu and keyboard commands are registered', async () => {
    const commands = await worker.evaluate(async () => chrome.commands.getAll());
    const read = commands.find((command) => command.name === 'read-aloud');
    const stop = commands.find((command) => command.name === 'stop-reading');
    assert.ok(read, 'read-aloud command exists');
    assert.ok(stop, 'stop-reading command exists');
    assert.match(read.shortcut || '', /Ctrl\+Shift\+Y/i);
    assert.match(stop.shortcut || '', /Ctrl\+Shift\+U/i);

    const duplicate = await worker.evaluate(() => new Promise((resolve) => {
      chrome.contextMenus.create({ id: 'tts-read-aloud', title: 'probe', contexts: ['page'] }, () => {
        resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : '');
      });
    }));
    assert.match(duplicate, /duplicate/i, 'menu item already exists, so creating it again fails');

    await selectText('#p1');
    const played = await worker.evaluate(async ({ tabId, url }) => {
      return globalThis.__ttsBackground.runCommand('play', { id: tabId, url });
    }, { tabId, url: fixtureUrl });
    assert.equal(played.status, 'playing');
    assert.equal(played.source, 'selection');
    await waitFor(async () => /Reading selection/.test(await sourceLabel()), 'popup picks up command state');

    await waitFor(async () => (await highlightText()) === FIXTURE_SENTENCES.p1first, 'highlight from command');

    const stopped = await worker.evaluate(async ({ tabId, url }) => {
      return globalThis.__ttsBackground.runCommand('stop', { id: tabId, url });
    }, { tabId, url: fixtureUrl });
    assert.equal(stopped.status, 'idle');
    assert.equal(await highlightText(), null);
  });

  await t.test('captures popup and highlight screenshots', async () => {
    await selectText('#quote');
    await popup.click('#play');
    await waitFor(async () => (await highlightText()) === FIXTURE_SENTENCES.quote, 'quote highlight');
    await popup.click('#pause');
    await waitFor(async () => (await sourceLabel()).includes('paused'), 'paused for screenshots');
    await page.waitForTimeout(150);

    await page.screenshot({ path: path.join(DOCS_DIR, 'highlight.png') });
    await popup.locator('body').screenshot({ path: path.join(DOCS_DIR, 'popup.png') });
    await popup.click('#stop');

    const highlightShot = await fs.stat(path.join(DOCS_DIR, 'highlight.png'));
    const popupShot = await fs.stat(path.join(DOCS_DIR, 'popup.png'));
    assert.ok(highlightShot.size > 10000, 'highlight screenshot looks like a real image');
    assert.ok(popupShot.size > 5000, 'popup screenshot looks like a real image');
  });

  await t.test('reported no page or extension errors', async () => {
    assert.deepEqual(pageErrors, []);
    const unexpected = consoleErrors.filter((entry) => !/duplicate id/i.test(entry));
    assert.deepEqual(unexpected, []);
  });
});

test('bundled offline voice speaks when Chromium reports no system voices', async (t) => {
  const { context, worker } = await launchWithExtension(t);
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  const popup = await context.newPage();
  const pageErrors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => pageErrors.push('page: ' + error.message));
  popup.on('pageerror', (error) => pageErrors.push('popup: ' + error.message));
  context.on('request', (request) => {
    const requestUrl = request.url();
    if (/^https?:/i.test(requestUrl) && !requestUrl.startsWith(fixtureUrl)) {
      externalRequests.push(requestUrl);
    }
  });

  await page.goto(fixtureUrl);
  await page.waitForFunction(() => document.documentElement.dataset.ttsReady === '1');

  const tabId = await worker.evaluate(async ({ url }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url) || tabs[0];
    return tab && tab.id;
  }, { url: fixtureUrl });

  const snapshot = () => worker.evaluate(async ({ tabId }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => globalThis.__TTS_CONTENT__.snapshot(),
    });
    return result.result;
  }, { tabId });

  const bundledStatus = () => worker.evaluate(async () => globalThis.__ttsBackground.getBundledStatus());

  const highlightText = () => page.evaluate(() => {
    const registry = CSS.highlights.get('tts-extension-reading');
    if (!registry) return null;
    return Array.from(registry).map((range) => range.toString()).join('\n');
  });

  const selectText = (selector) => page.evaluate((sel) => {
    const element = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);

  const sourceLabel = () => popup.locator('#source-label').textContent();

  const systemVoiceCount = await page.evaluate(() => window.speechSynthesis.getVoices().length);
  assert.equal(systemVoiceCount, 0, 'this run has no system voices, so auto mode must bundle');

  await popup.setViewportSize({ width: 340, height: 620 });
  await popup.goto(`${EXTENSION_ID_HEADER}${extensionId}/src/popup.html`);
  await popup.waitForFunction(
    () => document.getElementById('engine-active').textContent === 'Bundled',
    { timeout: 15000 },
  );
  assert.equal(await popup.inputValue('#engine'), 'auto', 'auto remains the default preference');
  assert.equal(await popup.locator('#voice option').first().textContent(), 'Bundled English (US)');

  await selectText('#p1');
  await popup.click('#play');
  await waitFor(async () => (await sourceLabel()) === 'Reading selection', 'bundled reading to start');

  const synthesis = await waitFor(async () => {
    const status = await bundledStatus();
    const stats = status && status.synthesis;
    if (!status || !status.ok || !stats) return null;
    return stats.bytes > 10000 && stats.peak > 0 && stats.duration > 1 ? status : null;
  }, 'the bundled engine to synthesize audio', { timeout: 20000 });

  assert.equal(synthesis.state, 'playing');
  assert.equal(synthesis.contextState, 'running', 'Web Audio is running in the offscreen document');
  assert.equal(synthesis.engine, 'bundled');
  assert.ok(synthesis.synthesis.bytes > 10000, 'a real PCM buffer was produced');
  assert.ok(synthesis.synthesis.peak > 1000, 'the PCM buffer is not silent');
  assert.ok(
    synthesis.synthesis.nonZeroSamples > synthesis.synthesis.samples * 0.1,
    'most samples carry signal, not just a click',
  );

  const playing = await snapshot();
  assert.equal(playing.engine, 'bundled');
  assert.equal(playing.total, 3);
  assert.equal(await highlightText(), playing.sentence);

  await waitFor(
    async () => (await highlightText()) === FIXTURE_SENTENCES.p1second,
    'the highlighted sentence to advance with bundled audio',
    { timeout: 15000 },
  );

  await popup.click('#pause');
  await waitFor(async () => (await sourceLabel()).includes('paused'), 'bundled pause label');
  const paused = await waitFor(async () => {
    const status = await bundledStatus();
    return status && status.state === 'paused' ? status : null;
  }, 'bundled audio to pause');

  const pausedSnapshot = await snapshot();
  const pausedHighlight = await highlightText();
  await page.waitForTimeout(1200);
  const afterPause = await bundledStatus();
  assert.equal(afterPause.state, 'paused');
  assert.ok(Math.abs(afterPause.offset - paused.offset) < 0.05, 'audio offset is frozen while paused');
  assert.equal((await snapshot()).index, pausedSnapshot.index, 'sentence index is frozen while paused');
  assert.equal(await highlightText(), pausedHighlight, 'highlight is frozen while paused');

  await popup.locator('body').screenshot({ path: path.join(DOCS_DIR, 'popup-bundled.png') });

  await popup.click('#resume');
  await waitFor(async () => (await sourceLabel()) === 'Reading selection', 'bundled resume label');
  await waitFor(async () => (await bundledStatus()).state === 'playing', 'bundled audio to resume');

  await waitFor(async () => {
    const current = await snapshot();
    return current.index > pausedSnapshot.index || (current.status === 'idle' && current.total > 0);
  }, 'bundled playback to continue past the paused sentence', { timeout: 20000 });

  const beforeStop = await snapshot();
  if (beforeStop.status !== 'idle') {
    await popup.click('#stop');
  } else {
    await worker.evaluate(async ({ tabId, url }) => {
      await globalThis.__ttsBackground.runCommand('stop', { id: tabId, url });
    }, { tabId, url: fixtureUrl });
  }

  await waitFor(async () => (await bundledStatus()).state === 'idle', 'bundled audio to stop');
  assert.equal(await highlightText(), null);
  assert.equal((await snapshot()).status, 'idle');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, [], 'bundled synthesis makes no external network requests');

  const vendorFiles = [
    'vendor/mespeak/mespeak.bundle.js',
    'vendor/mespeak/mespeak_config.json',
    'vendor/mespeak/voices/en/en-us.json',
    'vendor/mespeak/LICENSE',
    'vendor/mespeak/README.md',
  ];
  let vendorBytes = 0;
  for (const file of vendorFiles) vendorBytes += (await fs.stat(path.join(ROOT, file))).size;
  assert.ok(vendorBytes < 30 * 1024 * 1024, `bundled voice must stay under 30MB, got ${vendorBytes}`);

  const result = {
    checkedAt: new Date().toISOString(),
    engine: 'bundled meSpeak/eSpeak (Web Audio, offscreen document)',
    systemVoices: systemVoiceCount,
    preference: 'auto',
    resolved: synthesis.engine,
    synthesis: synthesis.synthesis,
    sampleRate: synthesis.sampleRate,
    vendorBytes,
    pauseOffset: paused.offset,
    resumed: true,
    stopped: true,
    audible: false,
    note: 'The bundled engine produced non-silent PCM and advanced real playback. No audio device was available to listen, so audibility is unverified.',
  };
  await fs.writeFile(path.join(RESULTS_DIR, 'bundled-voice.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Bundled voice:', JSON.stringify(result, null, 2));
});

test('real Chromium speech engine starts, pauses, resumes and stops', async (t) => {
  const { context, worker } = await launchWithExtension(t, ['--enable-speech-dispatcher']);
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  const popup = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  popup.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(fixtureUrl);
  await page.waitForFunction(() => document.documentElement.dataset.ttsReady === '1');

  const tabId = await worker.evaluate(async ({ url }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url) || tabs[0];
    return tab && tab.id;
  }, { url: fixtureUrl });

  const snapshot = () => worker.evaluate(async ({ tabId }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => globalThis.__TTS_CONTENT__.snapshot(),
    });
    return result.result;
  }, { tabId });

  const realState = () => page.evaluate(() => ({
    speaking: window.speechSynthesis.speaking,
    paused: window.speechSynthesis.paused,
    pending: window.speechSynthesis.pending,
  }));

  const highlightText = () => page.evaluate(() => {
    const registry = CSS.highlights.get('tts-extension-reading');
    if (!registry) return null;
    return Array.from(registry).map((range) => range.toString()).join('\n');
  });

  await popup.setViewportSize({ width: 340, height: 560 });
  // Force the platform engine: this machine's speech-dispatcher can speak even
  // though getVoices() reports no voices, which auto mode would treat as empty.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      ttsSettings: { rate: 1, pitch: 1, voice: '', engine: 'system' },
    });
  });
  await popup.goto(`${EXTENSION_ID_HEADER}${extensionId}/src/popup.html`);
  await popup.waitForFunction(() => /ready/i.test(document.getElementById('source-label').textContent), { timeout: 10000 });
  await popup.waitForFunction(
    () => document.getElementById('engine-active').textContent === 'System',
    { timeout: 10000 },
  );
  assert.equal(await popup.locator('#engine-active').textContent(), 'System');
  assert.equal(await popup.inputValue('#engine'), 'system');

  const voices = await page.evaluate(() => window.speechSynthesis.getVoices().length);

  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p1'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await popup.click('#play');

  const started = await waitFor(
    async () => (await realState()).speaking,
    'the real speech engine to report speaking',
    { timeout: 8000 },
  ).catch(() => false);

  if (!started) {
    const result = {
      checkedAt: new Date().toISOString(),
      engine: 'Chromium speechSynthesis (speech-dispatcher on Linux)',
      voices,
      started: false,
      audible: false,
      note: 'No system voice started in this environment, so real audibility is unverified.',
    };
    await fs.writeFile(path.join(RESULTS_DIR, 'real-speech.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('Real speech:', JSON.stringify(result, null, 2));
    t.skip('the real speech engine did not start in this environment');
    return;
  }

  await waitFor(async () => (await popup.locator('#source-label').textContent()) === 'Reading selection', 'popup to show real speech');

  const playingState = await snapshot();
  assert.equal(playingState.status, 'playing');
  assert.equal(playingState.total, 3);
  assert.equal(await highlightText(), playingState.sentence, 'real speech highlights the current sentence');

  await popup.click('#pause');
  await waitFor(async () => (await popup.locator('#source-label').textContent()).includes('paused'), 'popup to show paused');

  const audioStopped = await waitFor(
    async () => !(await realState()).speaking,
    'the real speech engine to stop speaking on pause',
    { timeout: 5000 },
  ).catch(() => false);
  assert.equal(audioStopped, true, 'pause stops real synthesis instead of relying on the broken platform pause');

  const pausedState = await snapshot();
  await page.waitForTimeout(1600);
  const afterPause = await snapshot();
  assert.equal(afterPause.index, pausedState.index, 'real synthesis does not advance while paused');
  assert.equal(await highlightText(), pausedState.sentence, 'highlight is frozen while paused');

  await popup.click('#resume');
  await waitFor(
    async () => (await realState()).speaking,
    'the real speech engine to start again after resume',
    { timeout: 8000 },
  );

  const advanced = await waitFor(async () => {
    const current = await snapshot();
    return current.index > pausedState.index || (current.status === 'idle' && current.total > 0);
  }, 'real speech to continue past the paused sentence', { timeout: 20000 });

  const beforeStop = await snapshot();
  if (beforeStop.status !== 'idle') {
    await popup.click('#stop');
  } else {
    await worker.evaluate(async ({ tabId, url }) => {
      await globalThis.__ttsBackground.runCommand('stop', { id: tabId, url });
    }, { tabId, url: fixtureUrl });
  }

  await waitFor(async () => !(await realState()).speaking, 'real speech to stop', { timeout: 5000 });
  await page.waitForTimeout(200);
  assert.equal(await highlightText(), null, 'stop clears the highlight');
  assert.deepEqual(pageErrors, []);

  const result = {
    checkedAt: new Date().toISOString(),
    engine: 'Chromium speechSynthesis (speech-dispatcher on Linux)',
    voices,
    started: true,
    pauseStoppedSynthesis: audioStopped,
    pausedIndexFrozen: afterPause.index === pausedState.index,
    resumed: true,
    advanced,
    stopped: true,
    audible: false,
    note: 'Synthesis events ran for real in headless Chromium. No audio device was available to listen, so audibility itself is unverified.',
  };
  await fs.writeFile(path.join(RESULTS_DIR, 'real-speech.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Real speech:', JSON.stringify(result, null, 2));
});
