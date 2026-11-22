/* Read Aloud service worker: toolbar action, keyboard shortcuts, context menu. */
'use strict';

const READ_MENU_ID = 'tts-read-aloud';
const STOP_MENU_ID = 'tts-stop-reading';
const DEFAULT_SETTINGS = { rate: 1, pitch: 1, voice: '' };
const BLOCKED_SCHEMES = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted):/i;

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

// Exposed for the integration test harness; no messages or web pages reach it.
globalThis.__ttsBackground = {
  runCommand: runCommand,
  getSettings: getSettings,
};
