# Bundled neural voice

This folder contains Kale TTS 1 nano and everything it needs to speak without a
system voice, with no network access at read time:

| Path | Purpose | Size |
| --- | --- | --- |
| `models/kale-tts-1-nano/kale-tts-1-nano.onnx` | int8 voice model, 7.5M parameters, 24 kHz | 14.8 MB |
| `models/kale-tts-1-nano/voices.json` | Voice list, graph names and model input layout | 4 KB |
| `models/kale-tts-1-nano/tokenizer.json` | IPA-to-token map | 2 KB |
| `models/kale-tts-1-nano/voices/` | Eight US voice packs (`.bin` + `.extra.bin`) | 4.2 MB |
| `frontend/` | CMUdict lexicon, g2p model, number/date rules, homographs | 4.7 MB |
| `js/kale-tts.mjs` | Kale TTS browser API | 28 KB |
| `ort/` | ONNX Runtime Web 1.22.0, WASM backend | 11 MB |

Synthesis runs in the extension's offscreen document. The front end turns text
into IPA using a CMUdict lexicon plus a small g2p model, Kale emits 24 kHz PCM,
and Web Audio plays it. There is no espeak dependency.

The upstream repository also ships two British voices (`d03`, `d13`); they need
the en-gb front end, which is not bundled. The eight US voices are Simone
(default), Kenzie, Owen, Frankie, Darlene, Toby, Earl and Magnus.

## Versions

- Model: [KaleComputer/kale-tts-1-nano](https://huggingface.co/KaleComputer/kale-tts-1-nano)
  (int8 graph, 24 kHz, eight en-us voices).
- Runtime: [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web)
  1.22.0, WASM-only build, single-threaded.
- API and front end: the `js/` and `frontend/` folders from the same model
  repository.

## Licensing

The extension is MIT. The bundled assets are Apache-2.0:

- **Kale TTS 1 nano** model, JS API and front end: Apache-2.0. See
  `LICENSE`.
- **Kokoro-82M**, **Maya-1**, **StyleTTS2** and **Ettin**: notices and
  licenses are collected in `THIRD_PARTY_NOTICES.md`.
- **ONNX Runtime Web**: MIT.
