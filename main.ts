// SPDX-License-Identifier: MIT
// FastMark driver: reads every case, renders it with parse, writes html.json.
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
for (let k = 0; k < cases.length; k++) {
  const doc = cases[k].markdown;
  // Render each case on its own: a document that throws (a parser bug on
  // one pathological input) must score zero for that case only, never
  // abort the whole run and zero all 720. A failure is logged with its
  // case id so a bad input can be reproduced from the log alone.
  try {
    rendered[k] = parse(doc);
  } catch (err) {
    failures++;
    console.error(`FastMark: case ${cases[k].id} threw, emitting '':`, err instanceof Error ? err.message : err);
    rendered[k] = '';
  }
}
if (failures > 0) console.error(`FastMark: ${failures} of ${cases.length} cases failed to parse`);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
