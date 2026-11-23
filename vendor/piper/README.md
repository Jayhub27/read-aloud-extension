# Bundled neural voice

This folder contains everything the extension needs to speak without a system
voice, with no network access at read time:

| File | Purpose | Size |
| --- | --- | --- |
| `en_US-ljspeech-medium.onnx` | Piper VITS voice model, 22,050 Hz, single speaker, int8-quantized | 23 MB |
| `en_US-ljspeech-medium.onnx.json` | Model configuration: phoneme map, sample rate, inference scales | 5 KB |
| `piper_phonemize.js` / `.wasm` / `.data` | Emscripten build of piper-phonemize and espeak-ng | 1.4 MB |
| `ort.min.mjs` | ONNX Runtime Web, ES module entry point | 436 KB |
| `ort-wasm-simd-threaded.mjs` / `.wasm` | ONNX Runtime Web WASM backend | 11 MB |

Synthesis runs in the extension's offscreen document: text is phonemized with
espeak-ng, the phoneme IDs go through the Piper model with ONNX Runtime Web,
and the resulting 22.05 kHz PCM is played with Web Audio.

## Size reductions

Two changes cut the bundle from about 90 MB to about 36 MB:

1. **English-only phonemizer data.** The upstream package preloads 494 files
   for every espeak-ng language (18 MB). The extension only reads `en-us`, so
   only `phondata`, `phonindex`, `phontab`, `intonations`, `en_dict`,
   `lang/gmw/en` and `lang/gmw/en-US` are kept (0.8 MB). Phoneme IDs for the
   test sentences are byte-identical to the full data set.
2. **int8 quantization of the model.** The text encoder, flow and duration
   predictor are quantized to int8 with QDQ, per-channel, using 12 phoneme
   sequences for calibration. The HiFi-GAN vocoder (`/dec/`) stays float32,
   which keeps the output spectrum within about 1 dB of the fp32 model and
   avoids the high-frequency noise seen when the vocoder is quantized. Size
   drops from 61 MB to 23 MB; inference speed is unchanged at about 3.4x real
   time.

The full-precision model is still available upstream if the quantized voice is
ever rejected:

```bash
curl -L -o vendor/piper/en_US-ljspeech-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx
```

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

`npm run build:vendor` copies the runtime files from `node_modules` and
re-applies the English-only trim. The model is downloaded separately with the
curl commands in `scripts/build-vendor.mjs`; quantization is documented in
`scripts/quantize-model.py`.

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
