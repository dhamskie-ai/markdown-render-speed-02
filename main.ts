// SPDX-License-Identifier: MIT
// FastMark driver: reads every case, renders it with parse, writes html.json.
// Note on the render contract: a whitespace-only line inside a fenced code
// block keeps the container indent rules of the block that holds it —
// parse.js expands the line's tabs from their absolute column and then
// strips the list-item indent Phase 1 skipped for blank lines, so a
// tab-only line in a fenced block inside a list item renders as spaces,
// never as a literal tab. The driver itself does no tab handling; it
// only feeds each case to parse() and collects the HTML.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
// cases.json is an array of { id, markdown } objects, in grading order.
const cases = JSON.parse(raw) as Array<{ id: string; markdown: string }>;
const rendered = new Array<string>(cases.length);
let failures = 0;
// Track per-case render time: the competition grades median speed against
// marked, so a single pathological input that takes seconds would sink
// the whole run. Log the slowest cases so a slowdown can be bisected.
const timings = new Array<number>(cases.length);
const runStart = Date.now();
for (let k = 0; k < cases.length; k++) {
  const doc = cases[k].markdown;
  // Render each case on its own: a document that throws (a parser bug on
  // one pathological input) must score zero for that case only, never
  // abort the whole run and zero all 720. A failure is logged with its
  // case id plus a snippet of the input, so a bad input can be
  // reproduced from the log alone without re-running the whole set.
  const t0 = Date.now();
  try {
    rendered[k] = parse(doc);
  } catch (err) {
    failures++;
    const snippet = doc.slice(0, 200).replace(/\n/g, '\\n');
    console.error(`FastMark: case ${cases[k].id} threw, emitting '':`, err instanceof Error ? err.message : err, `input: ${snippet}`);
    rendered[k] = '';
  }
  timings[k] = Date.now() - t0;
}
if (failures > 0) console.error(`FastMark: ${failures} of ${cases.length} cases failed to parse`);
const slowest = timings
  .map((ms, k) => ({ id: cases[k].id, ms }))
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 3);
// Median render time is what the competition grades against marked, so
// report it alongside the total: a low median with a high total means a
// few pathological cases, not a generally slow parser.
const sorted = [...timings].sort((a, b) => a - b);
const median = sorted.length % 2 === 0
  ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  : sorted[Math.floor(sorted.length / 2)];
const ok = cases.length - failures;
console.error(`FastMark: total ${Date.now() - runStart}ms, slowest: ${slowest.map((s) => `${s.id}=${s.ms}ms`).join(', ')}, rendered ${ok}/${cases.length}, median ${median}ms/case`);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
