/* Read Aloud service worker: toolbar action, keyboard shortcuts, context menu. */
'use strict';

const READ_MENU_ID = 'tts-read-aloud';
const STOP_MENU_ID = 'tts-stop-reading';
const OFFSCREEN_URL = 'src/offscreen.html';
const DEFAULT_SETTINGS = { rate: 1, pitch: 1, voice: '', engine: 'auto' };
const BLOCKED_SCHEMES = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted):/i;

let offscreenCreating = null;

function isReadableUrl(url) {
  if (!url) return true;
  return !BLOCKED_SCHEMES.test(url);
}

function createMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: READ_MENU_ID,
      title: 'Read aloud',
      contexts: ['selection', 'page'],
    });
    chrome.contextMenus.create({
      id: STOP_MENU_ID,
      title: 'Stop reading',
      contexts: ['selection', 'page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

async function getSettings() {
  try {
    const stored = await chrome.storage.local.get({ ttsSettings: DEFAULT_SETTINGS });
    return Object.assign({}, DEFAULT_SETTINGS, stored.ttsSettings || {});
  } catch (err) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) throw new Error('Offscreen documents are not available in this browser');

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    if (contexts.length > 0) return;
  }

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Speak text with the bundled neural voice (Piper) when system voices are unavailable.',
    });
    offscreenCreating.catch(function () { /* handled by the caller */ })
      .finally(function () { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function offscreenRequest(message) {
  await ensureOffscreenDocument();
  const payload = Object.assign({
    __tts: true,
    target: 'offscreen',
    relayed: true,
  }, message);

  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response !== undefined) return response;
  } catch (err) {
    /* The document may still be registering its listener. */
  }

  await new Promise(function (resolve) { setTimeout(resolve, 150); });
  return chrome.runtime.sendMessage(payload);
}

async function getBundledStatus() {
  try {
    return await offscreenRequest({ type: 'bundled-status' });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Load the neural model before the first sentence is read. The popup calls
 * this when it opens, so the multi-second model load happens while the user
 * is still choosing settings.
 */
async function warmupBundledVoice() {
  try {
    return await offscreenRequest({ type: 'bundled-warmup' });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Page was opened before the extension was installed/reloaded, or the
    // content script was never injected: inject it and retry once.
    await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['src/content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['src/sentence.js', 'src/content.js'],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

/**
 * Run a reading command in a tab. Shared by the context menu, keyboard
 * shortcuts and tests.
 * @param {'play'|'stop'|'toggle'} command
 * @param {{id?: number, url?: string}} tab
 */
async function runCommand(command, tab) {
  if (!tab || tab.id === undefined || tab.id === null) return null;
  if (!isReadableUrl(tab.url)) {
    console.warn('Read Aloud cannot run on this URL:', tab.url);
    return null;
  }

  const settings = await getSettings();
  const message = { __tts: true, type: command, settings: settings };

  try {
    return await sendToTab(tab.id, message);
  } catch (err) {
    console.warn('Read Aloud could not reach the page:', err && err.message ? err.message : err);
    return null;
  }
}

chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  const target = tab && tab.id !== undefined
    ? tab
    : { id: info.tabId, url: info.pageUrl };
  const command = info.menuItemId === STOP_MENU_ID ? 'stop' : 'play';
  // "Read aloud" always starts from the current selection (if any).
  await runCommand(command, target);
});

chrome.commands.onCommand.addListener(async function (command) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) return;
  if (command === 'stop-reading') {
    await runCommand('stop', tab);
  } else if (command === 'read-aloud') {
    await runCommand('play', tab);
  }
});

// Relay content-script requests to the offscreen voice document, and play
// completion events back to the tab that started the sentence.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.__tts !== true) return undefined;

  if (message.target === 'offscreen' && message.relayed !== true) {
    if (!sender.tab || sender.tab.id === undefined) return undefined;
    offscreenRequest(Object.assign({}, message, { tabId: sender.tab.id }))
      .then(sendResponse)
      .catch(function (error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      });
    return true;
  }

  if (message.target === 'background' && message.type === 'warmup') {
    warmupBundledVoice().then(sendResponse).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });
    return true;
  }

  if (message.target === 'background' && message.type === 'bundled-ended') {
    if (typeof message.tabId === 'number') {
      chrome.tabs.sendMessage(message.tabId, {
        __tts: true,
        type: 'bundled-ended',
        fromBackground: true,
        token: message.token,
      }).catch(function () { /* tab closed or navigated */ });
    }
    return undefined;
  }

  return undefined;
});

// Exposed for the integration test harness; no messages or web pages reach it.
globalThis.__ttsBackground = {
  runCommand: runCommand,
  getSettings: getSettings,
  ensureOffscreenDocument: ensureOffscreenDocument,
  getBundledStatus: getBundledStatus,
  warmupBundledVoice: warmupBundledVoice,
};
