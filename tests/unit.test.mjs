import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the classic script the same way the content script does, but with a
// CommonJS-style `module` object available.
const source = readFileSync(new URL('../src/sentence.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(source, sandbox);
const { splitSentences, isAbbreviation } = sandbox.module.exports;

function segments(input, options) {
  // Copy into this realm so deep equality does not compare vm prototypes.
  return Array.from(splitSentences(input, options), (sentence) => ({
    text: sentence.text,
    start: sentence.start,
    end: sentence.end,
  }));
}

function texts(input, options) {
  return segments(input, options).map((sentence) => sentence.text);
}

function assertOffsets(input, sentences) {
  for (const sentence of sentences) {
    assert.equal(input.slice(sentence.start, sentence.end), sentence.text, 'offsets must map back to source');
    assert.ok(sentence.text.length > 0, 'sentences must not be empty');
  }
}

test('splits plain prose into sentences', () => {
  const input = 'The quick brown fox jumps over the lazy dog. Reading text aloud helps people focus. A good reader marks the sentence.';
  const sentences = segments(input);
  assert.deepEqual(sentences.map((s) => s.text), [
    'The quick brown fox jumps over the lazy dog.',
    'Reading text aloud helps people focus.',
    'A good reader marks the sentence.',
  ]);
  assertOffsets(input, sentences);
});

test('keeps abbreviations, initials and decimals together', () => {
  const input = 'Dr. Smith arrived at 9 a.m. on Monday. He brought 3.14 pies and a copy of U.S. News. Then he left.';
  const result = texts(input);
  assert.deepEqual(result, [
    'Dr. Smith arrived at 9 a.m. on Monday.',
    'He brought 3.14 pies and a copy of U.S. News.',
    'Then he left.',
  ]);
});

test('keeps closing quotes attached to their sentence', () => {
  const input = '"Stop!" she said. "Are you sure?" she asked. Then... silence.';
  assert.deepEqual(texts(input), [
    '"Stop!" she said.',
    '"Are you sure?" she asked.',
    'Then... silence.',
  ]);
});

test('does not split when a period has no following whitespace', () => {
  assert.deepEqual(texts('Visit example.com for more. Or not.'), [
    'Visit example.com for more.',
    'Or not.',
  ]);
});

test('treats a blank line as a paragraph boundary', () => {
  const input = 'First paragraph has one sentence.\n\nSecond paragraph has two. It ends here.';
  const result = segments(input);
  assert.deepEqual(result.map((s) => s.text), [
    'First paragraph has one sentence.',
    'Second paragraph has two.',
    'It ends here.',
  ]);
  assert.ok(result.every((s) => !s.text.includes('\n')));
});

test('trims whitespace from sentence boundaries', () => {
  const input = '  One sentence.   Two sentence.  ';
  const result = segments(input);
  assert.deepEqual(result.map((s) => s.text), ['One sentence.', 'Two sentence.']);
  result.forEach((s) => {
    assert.notEqual(input[s.start], ' ');
    assert.notEqual(input[s.end - 1], ' ');
  });
});

test('chunks long sentences without losing text or offsets', () => {
  const words = Array.from({ length: 90 }, (_, i) => 'word' + i);
  const input = words.join(' ') + '. End.';
  const result = segments(input, { maxLength: 60 });

  assert.ok(result.length > 3, 'long sentence should be chunked');
  result.forEach((sentence) => {
    assert.ok(sentence.text.length <= 60, 'chunk must respect maxLength');
  });

  const chunks = result
    .filter((s) => s.text.startsWith('word'))
    .map((s) => s.text.replace(/\.$/, ''));
  assert.equal(chunks.join(' '), words.join(' '), 'chunk boundaries must not drop or duplicate words');
  assertOffsets(input, result);
});

test('ignores punctuation-only input', () => {
  assert.deepEqual(texts('... !!! ---'), []);
  assert.deepEqual(texts('   \n\n  '), []);
  assert.deepEqual(texts(''), []);
});

test('recognises common abbreviations', () => {
  assert.equal(isAbbreviation('See etc.', 7), true);
  assert.equal(isAbbreviation('e.g.', 3), true);
  assert.equal(isAbbreviation('the U.S.', 7), true);
  assert.equal(isAbbreviation('the dog.', 7), false);
});
