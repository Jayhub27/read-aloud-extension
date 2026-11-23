// text lines -> the release front end (kaleTts: dizione rules + lexicon + overrides + g2p model) -> sentences -> IPA -> Kokoro ids
// usage: node to_ids.mjs <in.jsonl {id,text}> <out.json> [override file]
import { readFileSync, writeFileSync } from "node:fs";
import { termsReplacer } from "./terms.ts";
import { G2p, G2pModel, normalizer, readTable, sentences } from "./words/kaleTts.js";
const [, , inp, out, ov = "override.public.tsv"] = process.argv;
const here = new URL("./words/", import.meta.url).pathname;
const lex = readTable(readFileSync(here + "lexicon.tsv", "utf8"));
readTable(readFileSync(here + ov, "utf8"), lex);
const buf = readFileSync(here + "g2p.bin"); const g2p = new G2p(lex, new G2pModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const norm0 = normalizer(lex);
const applyTerms = termsReplacer(readFileSync(here + "terms.tsv", "utf8"));   // terms: dictionary, camelCase split, dictionary
const norm = (t) => norm0(applyTerms(t)); const map = JSON.parse(readFileSync(here + "ipa2kokoro.json", "utf8"));
const rows = readFileSync(inp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => {
  const sents = sentences(r.text, norm).map((s) => { const ipa = g2p.phonemes(s); return { s, ipa, ids: [...ipa].map((c) => map[c]).filter((x) => x !== undefined) }; });
  return { id: r.id, text: r.text, normalized: sents.map((x) => x.s).join(" "), sents: sents.map((x) => x.ids), ipa: sents.map((x) => x.ipa) };
});
writeFileSync(out, JSON.stringify(rows, null, 1)); console.log(rows.length, "lines");
