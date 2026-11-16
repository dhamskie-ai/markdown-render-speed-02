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
for (let k = 0; k < cases.length; k++) {
  const doc = cases[k].markdown;
  rendered[k] = parse(doc);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
