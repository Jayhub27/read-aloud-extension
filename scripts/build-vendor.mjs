/**
 * Refreshes the vendored neural voice runtime.
 *
 * The extension loads its files directly, so this script only copies the
 * runtime pieces out of node_modules and checks that the voice model is in
 * place. Run it after upgrading onnxruntime-web or @diffusionstudio/piper-wasm:
 *
 *   npm run build:vendor
 *
 * The voice model is a 61MB file and is not published on npm. Download it
 * once with:
 *
 *   curl -L -o vendor/piper/en_US-ljspeech-medium.onnx \
 *     https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx
 *   curl -L -o vendor/piper/en_US-ljspeech-medium.onnx.json \
 *     https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'vendor/piper');
const NODE_MODULES = path.join(ROOT, 'node_modules');

const COPIES = [
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.js', 'piper_phonemize.js'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.wasm', 'piper_phonemize.wasm'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.data', 'piper_phonemize.data'],
  ['onnxruntime-web/dist/ort.min.mjs', 'ort.min.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
];

await fs.mkdir(OUT, { recursive: true });

for (const [from, to] of COPIES) {
  const source = path.join(NODE_MODULES, from);
  await fs.copyFile(source, path.join(OUT, to));
  const { size } = await fs.stat(path.join(OUT, to));
  console.log(`${to.padEnd(32)} ${(size / 1024 / 1024).toFixed(1)} MB`);
}

const model = path.join(OUT, 'en_US-ljspeech-medium.onnx');
try {
  const { size } = await fs.stat(model);
  console.log(`${'en_US-ljspeech-medium.onnx'.padEnd(32)} ${(size / 1024 / 1024).toFixed(1)} MB`);
} catch (error) {
  console.error(
    '\nMissing vendor/piper/en_US-ljspeech-medium.onnx.\n' +
    'Download it with the curl commands in this file, then run npm run build:vendor again.',
  );
  process.exitCode = 1;
}
