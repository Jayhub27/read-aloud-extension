/**
 * Refreshes the vendored neural voice runtime.
 *
 * The extension loads its files directly, so this script copies the runtime
 * pieces out of node_modules and applies the English-only trim to the
 * espeak-ng data. Run it after upgrading onnxruntime-web or
 * @diffusionstudio/piper-wasm:
 *
 *   npm run build:vendor
 *
 * The voice model is a 23MB file and is not published on npm. Download the
 * full-precision model once with:
 *
 *   curl -L -o vendor/piper/en_US-ljspeech-medium.onnx \
 *     https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx
 *   curl -L -o vendor/piper/en_US-ljspeech-medium.onnx.json \
 *     https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json
 *
 * The committed model is int8-quantized; `scripts/quantize-model.py` rebuilds
 * it from the full-precision download.
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

const KEEP = new Set([
  '/espeak-ng-data/phondata',
  '/espeak-ng-data/phonindex',
  '/espeak-ng-data/phontab',
  '/espeak-ng-data/intonations',
  '/espeak-ng-data/en_dict',
  '/espeak-ng-data/lang/gmw/en',
  '/espeak-ng-data/lang/gmw/en-US',
]);

/** Extract the loadPackage({...}) object without evaluating it. */
function readPackage(source) {
  const marker = 'loadPackage(';
  const start = source.indexOf(marker) + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) throw new Error('Could not find the phonemizer file table');
  return { start, end, pkg: JSON.parse(source.slice(start, end + 1)) };
}

async function trimPhonemizer() {
  const jsPath = path.join(OUT, 'piper_phonemize.js');
  const dataPath = path.join(OUT, 'piper_phonemize.data');
  const source = await fs.readFile(jsPath, 'utf8');
  const data = await fs.readFile(dataPath);
  const { start, end, pkg } = readPackage(source);
  const selected = pkg.files.filter((file) => KEEP.has(file.filename));

  const files = [];
  const chunks = [];
  let offset = 0;
  for (const file of selected) {
    const chunk = data.subarray(file.start, file.end);
    files.push({ filename: file.filename, start: offset, end: offset + chunk.length });
    chunks.push(chunk);
    offset += chunk.length;
  }

  const blob = Buffer.concat(chunks);
  const trimmed = {
    files,
    remote_package_size: blob.length,
  };
  await fs.writeFile(dataPath, blob);
  await fs.writeFile(jsPath, source.slice(0, start) + JSON.stringify(trimmed) + source.slice(end + 1));
  console.log(`${'piper_phonemize.data'.padEnd(32)} ${(blob.length / 1024 / 1024).toFixed(2)} MB (${files.length} English files)`);
}

await fs.mkdir(OUT, { recursive: true });

for (const [from, to] of COPIES) {
  const source = path.join(NODE_MODULES, from);
  await fs.copyFile(source, path.join(OUT, to));
  const { size } = await fs.stat(path.join(OUT, to));
  console.log(`${to.padEnd(32)} ${(size / 1024 / 1024).toFixed(2)} MB`);
}

await trimPhonemizer();

const model = path.join(OUT, 'en_US-ljspeech-medium.onnx');
try {
  const { size } = await fs.stat(model);
  console.log(`${'en_US-ljspeech-medium.onnx'.padEnd(32)} ${(size / 1024 / 1024).toFixed(2)} MB`);
} catch (error) {
  console.error(
    '\nMissing vendor/piper/en_US-ljspeech-medium.onnx.\n' +
    'Download it with the curl commands in this file, then run npm run build:vendor again.',
  );
  process.exitCode = 1;
}
