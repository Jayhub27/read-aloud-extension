# Read Aloud — text to speech Chrome extension

A Manifest V3 Chrome extension that reads the selected text, or the whole page, with the
browser's system voices and falls back to a bundled neural voice when the browser reports no
system voices. No build step to load it, no external service, and no download at read time.

## Download

[Download the latest release](https://github.com/Jayhub27/read-aloud-extension/releases/latest),
unzip it, and follow **Install unpacked** below. You can also clone the repository:

```bash
git clone https://github.com/Jayhub27/read-aloud-extension.git
```

![Read Aloud popup with the bundled engine active](docs/popup-bundled.png)

![The spoken sentence highlighted on the page](docs/highlight.png)

## What it does

- Reads the current selection, or the whole page when nothing is selected.
- Play, pause, resume and stop from the toolbar popup.
- Speed (0.5×–2×), pitch (0–2), voice and engine pickers saved in `chrome.storage.local`.
- **System voices by default.** When `speechSynthesis.getVoices()` is empty, it uses a bundled
  Piper neural voice (LJSpeech, 22.05 kHz), which ships inside the extension (~90 MB of assets) and
  synthesizes locally with ONNX Runtime Web.
- The popup shows which engine is active: **System** or **Bundled**, next to the engine picker.
- Highlights the sentence being spoken without modifying the page markup.
- Keyboard shortcuts and a right-click **Read aloud** / **Stop reading** menu.
- Chunks very long sentences (240 characters) so playback stays responsive.

## Install unpacked

1. Open `chrome://extensions` in Chrome or any Chromium browser.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
4. Pin **Read Aloud** to the toolbar.
5. Reload any tab you opened before installing, so the content script is present.

Chrome 116 or newer is required (CSS Custom Highlight API plus `chrome.runtime.getContexts`).

## Use

- Select some text and press **Play** to read only that. Press **Play** with nothing selected to
  read the page from the top.
- **Pause** stops the voice and keeps the highlight on the current sentence. **Resume** continues
  from the last spoken word (system) or audio position (bundled), and **Stop** clears playback and
  the highlight.
- Speed, pitch, voice and engine changes apply from the next sentence and persist between sessions.
- **Engine** offers `Auto — system, then bundled`, `System voices`, and `Bundled neural (Piper)`.
  Auto is the default. The badge on the right shows what the next reading will actually use.
- Shortcuts: `Ctrl+Shift+Y` reads, `Ctrl+Shift+U` stops. Rebind them at
  `chrome://extensions/shortcuts`.
- Right-click a page or a selection and choose **Read aloud** (or **Stop reading**).

## How it works

```mermaid
flowchart LR
  subgraph ext[Chrome extension]
    popup["Popup<br/>transport + engine picker"]:::blue
    worker["Service worker<br/>tab + offscreen router"]:::blue
    content["Content script<br/>sentences, state, highlight"]:::green
    offscreen["Offscreen document<br/>Piper + ONNX + Web Audio"]:::purple
  end
  system["System speechSynthesis<br/>OS voices"]:::amber
  page["Page DOM<br/>CSS highlight"]:::green

  popup -->|"play / pause / resume / stop"| content
  worker -->|"context menu + shortcuts"| content
  content -->|"voices reported"| system
  content -->|"no voices or forced bundled"| worker
  worker --> offscreen
  content -->|"prefetch next sentence"| worker
  offscreen -->|"22 kHz PCM + ended events"| content
  system -->|"start / boundary / end"| content
  content -->|"Highlight range"| page
```

The popup and service worker message the content script; the content script owns playback state,
sentence progress and highlighting. For system voices it speaks one `SpeechSynthesisUtterance` per
sentence. For the bundled engine it sends each sentence to an offscreen document, which phonemizes
it with espeak-ng, runs the Piper VITS model with ONNX Runtime Web, and plays the PCM with Web
Audio. While a sentence plays, the next one is synthesized in the background, so playback does not
pause between sentences. Nothing leaves the machine.

The neural model loads when the popup opens and the bundled engine is selected, so the first Play
does not wait for it. Reading from the context menu or a shortcut without opening the popup pays a
one-time model load of roughly 2.5 seconds.

**Highlighting** uses `CSS.highlights` with the `::highlight(tts-extension-reading)` rule from
`src/content.css`. A `Range` is built from source-text offsets, so the page DOM is untouched and
`Ctrl+Z`, React, and other scripts never see highlight wrappers.

**Pause is cancel-and-remember** for both engines. Chrome's `speechSynthesis.pause()` did nothing
with Linux system voices in testing, so the extension cancels the current utterance and remembers
the last word boundary. For the bundled engine it stops the audio source and remembers the exact
audio offset, then starts a new source there on resume. This behaves the same on every platform.

The sentence splitter handles common abbreviations (`Dr.`, `e.g.`, `U.S.`), decimals, closing
quotes, and paragraph breaks. It returns offsets into the collected text, which keeps the
highlight aligned even when sentences span inline elements.

## The bundled voice

`vendor/piper/` contains a Piper neural voice, `en_US-ljspeech-medium`, plus the runtime that runs
it in the browser:

| Piece | Size |
| --- | --- |
| Voice model (VITS, 22.05 kHz, public-domain LJSpeech) | 61 MB |
| espeak-ng phonemizer (WASM + data) | 18 MB |
| ONNX Runtime Web (WASM backend) | 11 MB |
| Glue JS (piper-wasm, ORT loader) | 0.6 MB |

Total shipped size is about **90 MB**. The popup never downloads anything; every file is fetched
from the extension package by the offscreen document. `npm run build:vendor` copies the runtime from
npm; the model download is documented in `scripts/build-vendor.mjs`.

Measured in headless Chromium on this machine, the voice synthesizes at about **4x real time**
(0.7–1.5 seconds per sentence, 22.05 kHz output). That is fast enough to synthesize the next
sentence while the current one plays. The higher-quality `high` variant of the same voice measured
0.5x real time, slower than playback, so the medium model is the one bundled.

Pitch is applied by synthesizing at a scaled `length_scale` and playing the result back at a
matching `playbackRate`, which keeps the requested speed while shifting the voice. The slider's
0–2 range maps to a pitch factor of 0.5–2.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save speed, pitch, voice and engine preference. |
| `scripting` | Inject the reader into tabs opened before install, and into tabs driven by commands. |
| `contextMenus` | Add the right-click menu items. |
| `activeTab` | Talk to the page the user is looking at. |
| `offscreen` | Run the bundled voice and Web Audio outside any tab. |
| `host_permissions: <all_urls>` | Read page text and show the highlight on any normal website. |

No page text leaves the machine. System voices come from the operating system; the fallback voice
runs in WebAssembly inside the extension. There is no TTS server, API key, analytics, or runtime
download.

## Tests

```bash
npm install --include=dev
npm test
```

`npm test` runs the unit tests and then the Playwright suite. This is the command to use — `bun
test` enforces a 5-second timeout that the browser suite will exceed.

### Unit tests

`npm run test:unit` runs `tests/unit.test.mjs` with Node's built-in test runner. It loads
`src/sentence.js` in a VM (the same classic script the content script uses) and checks sentence
boundaries, abbreviations, decimals, quotes, paragraphs, trimming and long-sentence chunking.

### Browser tests

`npm run test:e2e` launches the unpacked extension in a real Chromium persistent context:

```js
chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME,
  headless: true,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
  ],
})
```

The test finds a Chromium build in `~/.cache/ms-playwright`, preferring the revision that the
installed Playwright expects. Override it with `TTS_CHROME=/path/to/chrome npm run test:e2e`.

Three browser tests run against a local fixture page served over HTTP:

1. **Deterministic playback contract (system engine).** A fake speech engine is injected into the
   extension's isolated world (the same world as the content script), recording every utterance and
   firing `start` / `boundary` / `end`. The test selects a paragraph, plays, and asserts the first
   utterance, engine state, popup progress and the exact highlighted sentence. It pauses, waits,
   and asserts no new utterance starts and the highlight is frozen. It resumes, checks the remaining
   text is spoken and the highlight moves on, then stops and checks everything is cleared. It also
   reads the whole page, changes and reloads speed/pitch/voice settings, verifies the shortcut
   commands are registered, verifies the context menu exists, and drives the same command handler
   the menu and shortcuts use.
2. **Bundled neural voice (no system voices).** Chromium reports zero voices, so the default `Auto`
   preference must choose the bundled engine. The test asserts the popup says **Bundled**, plays a
   sentence, and inspects the offscreen document: real 22.05 kHz PCM with over 10,000 samples and a
   non-silent peak, plus a phoneme count (real synthesis, not a stub). It waits for the audio to
   advance the highlight to the next sentence, asserts that sentence started from the prefetched
   buffer in under 250 ms, pauses and checks the audio offset and highlight freeze, resumes and
   checks playback continues, then stops. Result: `test-results/bundled-voice.json`.
3. **Real system engine.** Forces the `System` preference and uses Chromium's real
   `speechSynthesis` with `--enable-speech-dispatcher`. It asserts speaking starts, pause stops it,
   resume restarts it, sentence progress continues, and stop silences it. Result:
   `test-results/real-speech.json`.

Screenshots `docs/popup-bundled.png`, `docs/popup.png` and `docs/highlight.png` are captured by the
tests, not mocked up.

### What the tests do not prove

No one can hear the audio in the headless test environment. **Audibility is unverified.** The
bundled test proves that the engine produced non-silent PCM and that real Web Audio playback
advanced, paused and resumed; the system test proves Chromium reported `speaking: true` and
advanced through sentences (speech-dispatcher with espeak-ng is installed here). Neither can prove
that sound reached a speaker at a usable volume.

## Known limitations

- Chrome/Chromium 116+ only (CSS Custom Highlight API and `chrome.runtime.getContexts`).
- Reads the first selection range when several ranges are selected.
- Cannot run on `chrome://` pages, the Chrome Web Store, or the built-in PDF viewer.
- The bundled voice is a single US English neural voice (Piper LJSpeech). It sounds far better than
  the old eSpeak fallback but adds about 90 MB to the extension.
- The first use of the bundled voice pays a one-time model load of about 2.5 seconds. Opening the
  popup warms it up; context-menu and shortcut starts cannot.
- Pitch on the bundled voice is a resampling effect. It is clean near 1.0 and can sound artifacty at
  the extremes of the 0–2 slider.
- System voice lists on Linux speech-dispatcher installations can be huge; the picker caps them at
  300 entries.
- Sentence splitting is heuristic; unusual abbreviations or all-lowercase prose can split in an
  unexpected place.
- If no system voice starts within four seconds, the popup shows an error. Switching the engine to
  `Bundled neural` always works without system voices.

## Project layout

```text
manifest.json            Manifest V3, permissions, shortcuts, content scripts
icons/                   Toolbar and extensions-page icons
src/background.js        Context menus, shortcuts, offscreen router, tab targeting
src/content.js           Selection/page text, engine choice, playback, highlight
src/sentence.js          Sentence segmentation with source offsets
src/content.css          ::highlight() styling
src/offscreen.html/js    Bundled voice synthesis and Web Audio playback
src/popup.html/css/js    Toolbar UI, settings and active-engine badge
vendor/piper/            Committed Piper model, phonemizer, ONNX Runtime and licenses
scripts/build-vendor.mjs Refreshes vendor/piper from npm and checks for the model
tests/unit.test.mjs      Sentence splitter tests
tests/extension.test.mjs Playwright browser tests + screenshots
test-page/index.html     Fixture article for the browser tests
docs/                    Screenshots captured by the tests
```

## License

GPL-3.0. The extension code is GPL-3.0 because the bundled Piper phonemizer embeds espeak-ng, which
is GPL. The Piper inference code and piper-wasm build are MIT, ONNX Runtime Web is MIT, and the
LJSpeech voice model is public domain. See `LICENSE`, `vendor/piper/LICENSE-espeak-ng`,
`vendor/piper/LICENSE-piper-wasm` and `vendor/piper/LICENSE-onnxruntime`.
