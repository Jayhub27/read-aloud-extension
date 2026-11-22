# Bundled neural voice

This folder contains everything the extension needs to speak without a system
voice, with no network access at read time:

| File | Purpose |
| --- | --- |
| `en_US-ljspeech-medium.onnx` | Piper VITS voice model, 22,050 Hz, single speaker |
| `en_US-ljspeech-medium.onnx.json` | Model configuration: phoneme map, sample rate, inference scales |
| `piper_phonemize.js` / `.wasm` / `.data` | Emscripten build of piper-phonemize and espeak-ng |
| `ort.min.mjs` | ONNX Runtime Web, ES module entry point |
| `ort-wasm-simd-threaded.mjs` / `.wasm` | ONNX Runtime Web WASM backend |

Synthesis runs in the extension's offscreen document: text is phonemized with
espeak-ng, the phoneme IDs go through the Piper model with ONNX Runtime Web,
and the resulting 22.05 kHz PCM is played with Web Audio.

## Versions

- Piper voice: `en_US-ljspeech-medium` from
  [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), quality
  `medium`, 22,050 Hz.
- Phonemizer: [@diffusionstudio/piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm)
  1.0.0, built from
  [wide-video/piper-wasm](https://github.com/wide-video/piper-wasm) with
  [rhasspy/espeak-ng](https://github.com/rhasspy/espeak-ng).
- Runtime: [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web)
  1.20.1, WASM backend, single-threaded.

`npm run build:vendor` copies the runtime files from `node_modules`; the model
is downloaded separately with the curl commands in `scripts/build-vendor.mjs`.

## Licensing

The extension is distributed under GPL-3.0 because the phonemizer embeds
espeak-ng:

- **Piper** inference code and the piper-wasm build: MIT (see
  `LICENSE-piper-wasm`).
- **espeak-ng**, embedded in `piper_phonemize.wasm`: GPL-3.0 (see
  `LICENSE-espeak-ng`).
- **ONNX Runtime Web**: MIT (see `LICENSE-onnxruntime`).
- **LJSpeech voice model**: public domain. The model card lists the
  [LJSpeech dataset](https://keithito.com/LJ-Speech-Dataset/) as public domain.
