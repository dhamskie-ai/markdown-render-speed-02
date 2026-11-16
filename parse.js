// SPDX-License-Identifier: MIT
// FastMark - a fresh CommonMark 0.31.2 + GFM 0.29 parser, written from scratch.
// parse(markdown) returns the HTML marked 18.1.3 returns with its default options.

const ESC = { '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '&': '&amp;' };

// Escape for running text: every & < > " ' is escaped. Named entities are
// their own nodes by the time text reaches here, so a bare & in text is
// always a literal & (for example one produced by a backslash escape).
const ALLENC = /[&<>"']/g;
function escText(s) {
  return s.replace(ALLENC, (m) => ESC[m]);
}

// Escape for attribute values (href, title, language, alt): an & that
// already starts something looking like an entity reference
// (&name; &#123; &#x1F;) is left alone, the way marked leaves it in URLs;
// every other & becomes &amp;. < > " ' always escape.
const NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});)/g;
function escAttr(s) {
  return s.replace(NOENC, (m) => ESC[m]);
}

// Escape for code spans and code blocks: every & < > " ' is escaped.
function escCode(s) {
  return s.replace(ALLENC, (m) => ESC[m]);
}

// Decode one numeric character reference starting at s[i] ('&' then '#').
// Returns the decoded string, or null when it is not a valid reference.
function decodeNumeric(s, i) {
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  let num = 0;
  let digits = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else break;
    num = num * (hex ? 16 : 10) + d;
    if (num > 0x10FFFF) return null;
    j++;
    digits++;
  }
  if (digits === 0 || j >= s.length || s[j] !== ';') return null;
  if (hex ? digits > 6 : digits > 7) return null;
  if (num === 0 || (num >= 0xD800 && num <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(num);
}

// ASCII punctuation lookup (code < 128). Anything else is punctuation when
// it has Unicode general category P (checked with a property escape).
const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isSpaceOrTab(c) {
  return c === 32 || c === 9;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) {
  return isAlpha(c) || isDigit(c);
}
// Is the character at s[i] (or -1 for start / len for end) Unicode whitespace?
function isUniSpaceAt(s, i) {
  if (i < 0 || i >= s.length) return true;
  const c = s.charCodeAt(i);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  if (c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF) return true;
  return false;
}
// Is the character at s[i] Unicode punctuation? marked treats Unicode
// symbols (currency, math, modifier, other) as punctuation here too, so
// *£* and *€* do not form emphasis.
function isUniPunctAt(s, i) {
  if (i < 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return /\p{P}|\p{S}/u.test(s[i]);
}

// ---------- block parsing ----------

// Is the whole line (raw) blank (only spaces/tabs)?
function isBlankRaw(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Columns of leading whitespace starting at ln.i (tabs expand to the next
// multiple of 4 using the absolute column). Does not consume anything.
function countIndent(ln) {
  let cols = 0;
  let col = ln.col;
  let k = ln.i;
  while (k < ln.s.length) {
    const ch = ln.s[k];
    if (ch === ' ') { cols++; col++; k++; }
    else if (ch === '\t') { const w = 4 - (col % 4); cols += w; col += w; k++; }
    else break;
  }
  return cols;
}

// Expand tabs in s to spaces, assuming s starts at absolute column col.
// A tab advances to the next multiple of 4.
function expandTabs(s, col) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let c = col;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Is the remainder of the line (from ln.i) only whitespace?
function isBlankRemainder(ln) {
  for (let k = ln.i; k < ln.s.length; k++) {
    const c = ln.s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Consume up to n columns of spaces/tabs. A tab that straddles the boundary
// is replaced by spaces so the rest of the line keeps its alignment.
function advanceCols(ln, n) {
  while (n > 0 && ln.i < ln.s.length) {
    const ch = ln.s[ln.i];
    if (ch === ' ') { ln.i++; ln.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (ln.col % 4);
      if (w <= n) { ln.i++; ln.col += w; n -= w; }
      else {
        ln.s = ln.s.slice(0, ln.i) + ' '.repeat(w) + ln.s.slice(ln.i + 1);
        ln.i += n; ln.col += n; n = 0;
      }
    } else break;
  }
}

// Skip one optional space (a space, or a tab counted as one column).
function skipOneSpace(ln) {
  if (ln.i < ln.s.length && (ln.s[ln.i] === ' ' || ln.s[ln.i] === '\t')) advanceCols(ln, 1);
}

function newBlock(t) {
  return { t, children: [], lastBlank: false };
}

function parseBlocks(lines, refs, endsWithNewline) {
  const doc = newBlock('doc');
  const stack = [doc];
  for (let li = 0; li < lines.length; li++) {
    const ln = { s: lines[li], i: 0, col: 0 };
    // Whether the line after this one is blank (or we are at EOF without a
    // trailing newline): an HTML block ending on this line gets no trailing
    // newline in that case.
    ln.nextBlank = li + 1 >= lines.length ? !endsWithNewline : /^[ \t]*$/.test(lines[li + 1]);
    // True only when this line is the last one and the source has no
    // trailing newline: an HTML block ending here gets no trailing
    // newline. (nextBlank is also true when the following line is
    // blank, which must NOT suppress the trailing newline.)
    ln.atEofNoTrail = li + 1 >= lines.length && !endsWithNewline;

    // Phase 1: match open containers. A blank remainder keeps quote/item/
    // list/code/html open but closes paragraphs, tables and html types 6-7.
    // Inside a fenced code block, a line that does not match a list item's
    // indent is code content (not a reason to close the item). A blockquote
    // still needs its '>' marker on every line, so quote keeps breaking.
    const inFenced = stack[stack.length - 1].t === 'code' && stack[stack.length - 1].fenced;
    let j = 1;
    while (j < stack.length) {
      const b = stack[j];
      if (b.t === 'quote') {
        const saveI = ln.i, saveCol = ln.col;
        const ind = countIndent(ln);
        if (ind <= 3) {
          advanceCols(ln, ind);
          if (ln.s[ln.i] === '>') {
            ln.i++; ln.col++;
            skipOneSpace(ln);
            j++;
            continue;
          }
        }
        ln.i = saveI; ln.col = saveCol;
        break;
      } else if (b.t === 'item') {
        if (isBlankRemainder(ln)) {
          // An empty item followed by a blank line ends the item.
          if (b.children.length === 0) break;
          j++;
          continue;
        }
        const ind = countIndent(ln);
        if (ind >= b.indent) { advanceCols(ln, b.indent); j++; continue; }
        if (inFenced) {
          // A fenced code block with no content yet does not keep the
          // item open for a line below the item's indent: the block
          // stays empty and the item ends.
          const leaf = stack[stack.length - 1];
          if (leaf.t === 'code' && leaf.fenced && leaf.lines.length === 0) break;
          j++;
          continue;
        }
        break;
      } else if (b.t === 'list') {
        j++;
        continue;
      } else if (b.t === 'code' && b.fenced) {
        j++;
        continue;
      } else if (b.t === 'code') {
        if (isBlankRemainder(ln)) {
          const ind = countIndent(ln);
          advanceCols(ln, Math.min(ind, 4));
          j++;
          continue;
        }
        const ind = countIndent(ln);
        if (ind >= 4) { advanceCols(ln, 4); j++; continue; }
        if (inFenced) { j++; continue; }
        break;
      } else if (b.t === 'html') {
        j++;
        continue;
      } else if (b.t === 'para') {
        if (isBlankRemainder(ln)) break;
        j++;
        continue;
      } else if (b.t === 'table') {
        // A tab-only line is a row of empty cells, not a blank line.
        if (isBlankRemainder(ln) && !ln.s.slice(ln.i).includes('\t')) break;
        j++;
        continue;
      } else {
        j++;
        continue;
      }
    }
    // Lazy continuation: the line did not match an open container, but the
    // innermost block is a paragraph and the line is not blank, so the line
    // is paragraph text. Do not close any container for it. A whitespace-
    // only remainder after a consumed container marker (e.g. ">  ") is
    // paragraph content, not a blank line; a bare whitespace-only line
    // (nothing consumed) is blank.
    const blankRem = isBlankRemainder(ln) && (ln.i >= ln.s.length || ln.i === 0);
    const lazy = j < stack.length && stack[stack.length - 1].t === 'para' && !blankRem && !interruptsPara(ln, stack);
    if (!lazy) {
      while (stack.length > j) {
        const popped = stack.pop();
        if (popped.t === 'html') popped.noTrail = true;
        finalize(popped, stack[stack.length - 1], refs);
      }
    }

    // Blank remainder: content for code/html 1-5, else mark lastBlank.
    // A blank line ends an HTML block of type 6 or 7. A whitespace-only
    // remainder inside a container is not a blank line for a paragraph:
    // fall through to Phase 2 so the lazy branch adds it as text.
    // A tab-only line inside a table is a row of empty cells, not a
    // blank line: skip the blank handling so Phase 2 adds it as a row.
    if (isBlankRemainder(ln) && !(stack[stack.length - 1].t === 'table' && ln.s.includes('\t'))) {
      const leaf = stack[stack.length - 1];
      if (leaf.t === 'code') {
        if (leaf.fenced) {
          const ind = countIndent(ln);
          advanceCols(ln, Math.min(ind, leaf.fenceInd || 0));
          leaf.lines.push(ln.s.slice(ln.i));
        } else {
          leaf.lines.push(ln.s.slice(ln.i));
        }
      } else if (leaf.t === 'html' && leaf.htmlType <= 5) leaf.lines.push('');
      else if (blankRem) {
        if (leaf.t === 'html') {
          leaf.noTrail = true;
          finalize(stack.pop(), stack[stack.length - 1], refs);
        }
        // A blank line inside a blockquote only marks the quote itself;
        // otherwise it marks every open container (so a blank line between
        // list items loosens the list).
        if (j >= 1 && j - 1 < stack.length && stack[j - 1].t === 'quote') {
          stack[j - 1].lastBlank = true;
        } else {
          for (let k = 1; k < stack.length; k++) stack[k].lastBlank = true;
        }
      } else {
        // Whitespace-only line inside a container: not blank. Fall through
        // to Phase 2 (lazy branch) without marking lastBlank.
      }
      if (leaf.t === 'code' || (leaf.t === 'html' && leaf.htmlType <= 5) || blankRem) continue;
    }
    // Snapshot lastBlank before resetting: a child added to a container on
    // this line must still see whether the previous line was blank.
    for (let k = 1; k < stack.length; k++) { stack[k].blankBefore = stack[k].lastBlank; stack[k].lastBlank = false; }

    // Phase 2: the innermost leaf consumes the line, or new blocks open.
    let leaf = stack[stack.length - 1];
    if (lazy) {
      // Strip leading whitespace only when Phase 1 consumed no container
      // marker (the whitespace is indent, not content). When a marker was
      // consumed (e.g. ">  ![img]"), the space after it is content.
      let k = ln.i;
      let hasContent = false;
      for (let m = ln.i; m < ln.s.length; m++) {
        if (ln.s[m] !== ' ' && ln.s[m] !== '\t') { hasContent = true; break; }
      }
      if (hasContent && ln.i === 0) {
        while (k < ln.s.length && (ln.s[k] === ' ' || ln.s[k] === '\t')) k++;
      }
      let content = ln.s.slice(k);
      // A lazy setext underline is paragraph text indented by 4 spaces.
      if (/^=+$/.test(content) || /^-+$/.test(content)) content = '    ' + content;
      leaf.lines.push(content);
      continue;
    }
    if (leaf.t === 'code' && leaf.fenced) {
      const ind = countIndent(ln);
      if (ind <= 3) {
        const saveI = ln.i, saveCol = ln.col;
        advanceCols(ln, ind);
        const fl = fenceRun(ln, leaf.fenceChar);
        if (fl >= leaf.fenceLen) {
          ln.i += fl;
          if (isBlankRemainder(ln)) {
            finalize(stack.pop(), stack[stack.length - 1], refs);
            continue;
          }
        }
        ln.i = saveI; ln.col = saveCol;
      }
      const strip = Math.min(ind, leaf.fenceInd || 0);
      advanceCols(ln, strip);
      let content = ln.s.slice(ln.i);
      // A tab the indent stripping lands on expands to spaces: the
      // stripping consumed columns (container or fence indent), so the
      // tab aligns to the next multiple of 4 from the absolute column.
      if (ln.col > 0 && content.charCodeAt(0) === 9) {
        const w = 4 - (ln.col % 4);
        content = ' '.repeat(w) + content.slice(1);
      }
      leaf.lines.push(content);
      continue;
    }
    if (leaf.t === 'code') {
      leaf.lines.push(ln.s.slice(ln.i));
      continue;
    }
    if (leaf.t === 'html') {
      leaf.lines.push(ln.s.slice(ln.i));
      if (leaf.htmlEnd && leaf.htmlEnd.test(ln.s.slice(ln.i))) {
        leaf.noTrail = ln.nextBlank;
        finalize(stack.pop(), stack[stack.length - 1], refs);
      }
      continue;
    }
    if (leaf.t === 'table') {
      // A whitespace-only line containing a tab is a row of empty
      // cells, not an indented-code block start.
      const isTabRow = /^[ \t]*\t[ \t]*$/.test(ln.s.slice(ln.i));
      if (!isTabRow && lineStartsBlock(ln)) {
        finalize(stack.pop(), stack[stack.length - 1], refs);
        leaf = stack[stack.length - 1];
      } else {
        const row = parseTableRow(ln.s.slice(ln.i));
        while (row.length < leaf.ncols) row.push('');
        leaf.rows.push(row.slice(0, leaf.ncols));
        continue;
      }
    }
    openNewBlocks(ln, stack, refs, lazy);
  }
  while (stack.length > 1) {
    const b = stack.pop();
    if (b.t === 'html' && b.noTrail === undefined) b.noTrail = !endsWithNewline;
    finalize(b, stack[stack.length - 1], refs);
  }
  return doc;
}

// ---------- block starts ----------

function saveLn(ln) { return { s: ln.s, i: ln.i, col: ln.col }; }
function restoreLn(ln, sv) { ln.s = sv.s; ln.i = sv.i; ln.col = sv.col; }

function fenceRun(ln, ch) {
  let n = 0;
  while (ln.i + n < ln.s.length && ln.s[ln.i + n] === ch) n++;
  return n;
}

function isPunctChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return false;
}

// Remove backslash escapes before ASCII punctuation: \x -> x.
function unescapePunct(s) {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && k + 1 < s.length && isPunctChar(s[k + 1])) { out += s[k + 1]; k++; }
    else out += c;
  }
  return out;
}

// Setext underline level (1 for =, 2 for -), or 0. ind is the leading
// indent in columns (must be < 4).
function setextLevel(ln, ind) {
  if (ind >= 4) return 0;
  const sv = saveLn(ln);
  advanceCols(ln, ind);
  const c = ln.s[ln.i];
  if (c !== '=' && c !== '-') { restoreLn(ln, sv); return 0; }
  let k = ln.i;
  while (k < ln.s.length && ln.s[k] === c) k++;
  while (k < ln.s.length && (ln.s[k] === ' ' || ln.s[k] === '\t')) k++;
  restoreLn(ln, sv);
  if (k !== ln.s.length) return 0;
  return c === '=' ? 1 : 2;
}

// Parse a table delimiter row. Returns alignments ('left'|'right'|'center'|
// null per column) or null when the line is not a delimiter row.
function parseDelimRow(text) {
  let s = text.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '');
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  if (s === '') return null;
  const cells = s.split('|');
  const out = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c[0] === ':';
    const right = c[c.length - 1] === ':';
    out.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return out;
}

// Split a table row line into trimmed cells. Pipes escaped with a backslash
// and pipes inside code spans do not separate cells.
function parseTableRow(text) {
  let start = 0, end = text.length;
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start++;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let s = text.slice(start, end);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let codeLen = 0; // >0 while inside a code span of this backtick length
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '|') { cur += '|'; i++; continue; }
      cur += c + s[i + 1]; i++; continue;
    }
    if (c === '`') {
      let n = 0;
      while (i + n < s.length && s[i + n] === '`') n++;
      if (codeLen === 0) {
        // Only enter a code span when a matching closer exists later;
        // otherwise the backticks are literal text and '|' still splits.
        let found = false;
        for (let k = i + n; k < s.length; k++) {
          if (s[k] === '`') {
            let m = 0;
            while (k + m < s.length && s[k + m] === '`') m++;
            if (m === n) { found = true; break; }
            k += m - 1;
          }
        }
        if (found) codeLen = n;
      } else if (n === codeLen) codeLen = 0;
      cur += s.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (c === '|' && codeLen === 0) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Index just past the '>' of a tag starting at s[i] ('<'), or -1 when the
// tag is not well formed. Shared with the inline HTML parser.
function findTagEnd(s, i) {
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (j >= s.length || !isAlpha(s.charCodeAt(j))) return -1;
  while (j < s.length && (isAlnum(s.charCodeAt(j)) || s[j] === '-')) j++;
  // Right after the tag name only whitespace, '>', or '/' may follow.
  if (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '>' && s[j] !== '/') return -1;
  if (closing) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  while (j < s.length) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= s.length) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/') return s[j + 1] === '>' ? j + 2 : -1;
    if (!isAlpha(s.charCodeAt(j)) && s[j] !== '_' && s[j] !== ':') return -1;
    while (j < s.length && (isAlnum(s.charCodeAt(j)) || s[j] === '_' || s[j] === ':' || s[j] === '.' || s[j] === '-')) j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '=') {
      j++;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= s.length) return -1;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < s.length && s[j] !== q) j++;
        if (j >= s.length) return -1;
        j++;
      } else {
        if (j >= s.length) return -1;
        while (j < s.length && !isSpace(s.charCodeAt(j)) && s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '>' && s[j] !== '`') j++;
        if (j >= s.length) return -1;
      }
      // After an attribute value only whitespace, '>', or '/' may follow.
      if (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '>' && s[j] !== '/') return -1;
    }
  }
  return -1;
}

// HTML block start at the current position (after container markers).
// Returns {type, end} or null. On success ln is left at the '<' (indent
// stripped); on failure ln is restored.
function htmlBlockStart(ln, ind) {
  if (ind >= 4) return null;
  const sv = saveLn(ln);
  advanceCols(ln, ind);
  const s = ln.s;
  const i = ln.i;
  if (s[i] !== '<') { restoreLn(ln, sv); return null; }
  if (s.startsWith('<!--', i)) return { type: 2, end: /-->/ };
  if (s.startsWith('<?', i)) return { type: 3, end: /\?>/ };
  if (s.startsWith('<!', i)) {
    const c = s[i + 2];
    if (c && isAlpha(c.charCodeAt(0))) return { type: 4, end: />/ };
    if (s.startsWith('<![CDATA[', i)) return { type: 5, end: /\]\]>/ };
    restoreLn(ln, sv);
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= s.length || !isAlpha(s.charCodeAt(j))) { restoreLn(ln, sv); return null; }
  let k = j;
  while (k < s.length && (isAlnum(s.charCodeAt(k)) || s[k] === '-')) k++;
  const name = s.slice(j, k).toLowerCase();
  const after = s[k];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '>' && after !== '/') { restoreLn(ln, sv); return null; }
  if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    return { type: 1, end: new RegExp('</' + name, 'i') };
  }
  if (BLOCK_TAGS.has(name)) return { type: 6, end: null };
  // Type 7: any other tag, but it must be alone on the line.
  const tagEnd = findTagEnd(s, i);
  if (tagEnd === -1) { restoreLn(ln, sv); return null; }
  let m = tagEnd;
  while (m < s.length && (s[m] === ' ' || s[m] === '\t')) m++;
  if (m !== s.length) { restoreLn(ln, sv); return null; }
  return { type: 7, end: null };
}

function isThematicBreak(ln, ind) {
  if (ind >= 4) return false;
  const sv = saveLn(ln);
  advanceCols(ln, ind);
  const c = ln.s[ln.i];
  if (c !== '*' && c !== '-' && c !== '_') { restoreLn(ln, sv); return false; }
  let count = 0;
  let k = ln.i;
  while (k < ln.s.length) {
    const ch = ln.s[k];
    if (ch === c) { count++; k++; }
    else if (ch === ' ' || ch === '\t') k++;
    else { restoreLn(ln, sv); return false; }
  }
  restoreLn(ln, sv);
  return count >= 3;
}

// Parse a list marker at the current position. ind is the leading indent
// in columns (< 4). Returns null, or {bullet, delim, num, markerWidth,
// contentIndent, char} where char is the bullet char or the delimiter.
function parseListMarker(ln, ind) {
  const sv = saveLn(ln);
  advanceCols(ln, ind);
  const s = ln.s;
  const i = ln.i;
  let bullet = false, delim = '', num = 0, markerWidth = 0, char = '';
  const c = s[i];
  if (c === '-' || c === '+' || c === '*') {
    bullet = true;
    markerWidth = 1;
    char = c;
  } else if (c >= '0' && c <= '9') {
    let k = i, n = 0;
    while (k < s.length && s[k] >= '0' && s[k] <= '9' && k - i < 9) { n = n * 10 + (s.charCodeAt(k) - 48); k++; }
    if (k === i || k - i > 9) { restoreLn(ln, sv); return null; }
    if (s[k] !== '.' && s[k] !== ')') { restoreLn(ln, sv); return null; }
    delim = s[k];
    num = n;
    markerWidth = (k - i) + 1;
    char = delim;
  } else { restoreLn(ln, sv); return null; }
  const after = s[i + markerWidth];
  if (after !== undefined && after !== ' ' && after !== '\t') { restoreLn(ln, sv); return null; }
  ln.i = i + markerWidth;
  ln.col += markerWidth;
  const spaces = countIndent(ln);
  let contentIndent;
  if (isBlankRemainder(ln)) contentIndent = ind + markerWidth + 1;
  else if (spaces >= 5) contentIndent = ind + markerWidth + 1;
  else contentIndent = ind + markerWidth + spaces;
  restoreLn(ln, sv);
  return { bullet, delim, num, markerWidth, contentIndent, char };
}

// Add child to parent, marking the enclosing list loose when a blank line
// separated this block from the previous child of a list item.
function addChild(stack, parent, child) {
  if (parent.t === 'item' && parent.children.length > 0 && parent.blankBefore) {
    const li = stack.indexOf(parent);
    const list = li > 0 ? stack[li - 1] : null;
    if (list && list.t === 'list') list.tight = false;
  }
  parent.children.push(child);
}

// Close an open paragraph at the top of the stack, if there is one.
function closePara(stack, refs) {
  if (stack[stack.length - 1].t === 'para') {
    finalize(stack.pop(), stack[stack.length - 1], refs);
  }
}

// ---------- opening new blocks ----------

// A leaf block (heading, code, html, hr, paragraph, blockquote) cannot be
// a direct child of a list, only list items can. When the stack top is a
// list (the previous item just closed), close it first so the new block
// lands in the list's parent.
function ensureNotListTop(stack, refs) {
  while (stack.length > 1 && stack[stack.length - 1].t === 'list') {
    finalize(stack.pop(), stack[stack.length - 1], refs);
  }
}

function openNewBlocks(ln, stack, refs, lazy) {
  while (true) {
    // A marker line whose remainder is blank opens nothing further.
    if (isBlankRemainder(ln)) return;
    const cont = stack[stack.length - 1];
    const ind = countIndent(ln);

    // Setext heading: a paragraph followed by a = or - run.
    if (cont.t === 'para' && ind < 4) {
      const lvl = setextLevel(ln, ind);
      if (lvl) {
        const para = stack.pop();
        const rest = extractRefs(para, refs);
        if (rest.trim() === '') {
          // The paragraph was only reference definitions: not a heading.
          // Keep it and take this line as ordinary paragraph text.
          stack.push(para);
          para.lines.push(ln.s.slice(ln.i));
          return;
        }
        const h = newBlock('head');
        h.level = lvl;
        h.inline = rest.trim();
        const parent = stack[stack.length - 1];
        const idx = parent.children.indexOf(para);
        if (idx >= 0) parent.children[idx] = h;
        else parent.children.push(h);
        return;
      }
    }
    // Table delimiter: a one-line paragraph followed by a delimiter row.
    if (cont.t === 'para' && cont.lines.length === 1 && ind < 4) {
      const delim = parseDelimRow(ln.s.slice(ln.i));
      if (delim) {
        const header = parseTableRow(cont.lines[0]);
        if (header.length === delim.length) {
          const para = stack.pop();
          const tb = newBlock('table');
          tb.ncols = delim.length;
          tb.align = delim;
          tb.header = header;
          tb.rows = [];
          const parent = stack[stack.length - 1];
          const idx = parent.children.indexOf(para);
          if (idx >= 0) parent.children[idx] = tb;
          else parent.children.push(tb);
          stack.push(tb);
          return;
        }
      }
    }
    // ATX heading.
    if (ind < 4) {
      const sv = saveLn(ln);
      advanceCols(ln, ind);
      const hrun = fenceRun(ln, '#');
      if (hrun >= 1 && hrun <= 6 && (ln.i + hrun >= ln.s.length || ln.s[ln.i + hrun] === ' ' || ln.s[ln.i + hrun] === '\t')) {
        ln.i += hrun; ln.col += hrun;
        let content = ln.s.slice(ln.i);
        content = content.replace(/[ \t]+$/, '');
        content = content.replace(/[ \t]+#+$/, '');
        content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        ensureNotListTop(stack, refs);
        closePara(stack, refs);
        const h = newBlock('head');
        h.level = hrun;
        h.inline = content;
        addChild(stack, stack[stack.length - 1], h);
        return;
      }
      restoreLn(ln, sv);
    }
    // Fenced code.
    if (ind < 4) {
      const sv = saveLn(ln);
      advanceCols(ln, ind);
      const ch = ln.s[ln.i];
      if (ch === '`' || ch === '~') {
        const fl = fenceRun(ln, ch);
        if (fl >= 3) {
          const info = ln.s.slice(ln.i + fl);
          if (ch !== '`' || !info.includes('`')) {
            ensureNotListTop(stack, refs);
            closePara(stack, refs);
            const cb = newBlock('code');
            cb.fenced = true;
            cb.fenceChar = ch;
            cb.fenceLen = fl;
            cb.fenceInd = ind;
            cb.info = info.trim();
            cb.lang = unescapePunct(cb.info.split(/[ \t]/, 1)[0] || '');
            cb.lines = [];
            addChild(stack, stack[stack.length - 1], cb);
            stack.push(cb);
            return;
          }
        }
      }
      restoreLn(ln, sv);
    }
    // HTML block (type 7 cannot interrupt a paragraph).
    if (ind < 4) {
      const sv = saveLn(ln);
      const hb = htmlBlockStart(ln, ind);
      if (hb && (hb.type !== 7 || cont.t !== 'para')) {
        ensureNotListTop(stack, refs);
        closePara(stack, refs);
        const h = newBlock('html');
        h.htmlType = hb.type;
        h.htmlEnd = hb.end;
        h.lines = [ln.s.slice(sv.i)];
        addChild(stack, stack[stack.length - 1], h);
        // The end condition may already hold on the first line (a one-line
        // <style>...</style> or <!-- ... -->): then the block is complete
        // at once, so finalize it here instead of pushing it open.
        if (h.htmlEnd && h.htmlEnd.test(h.lines[0])) {
          h.noTrail = ln.nextBlank;
          finalize(h, stack[stack.length - 1], refs);
        } else {
          stack.push(h);
        }
        return;
      }
      restoreLn(ln, sv);
    }
    // Thematic break.
    if (ind < 4 && isThematicBreak(ln, ind)) {
      ensureNotListTop(stack, refs);
      closePara(stack, refs);
      addChild(stack, stack[stack.length - 1], newBlock('hr'));
      return;
    }
    // List item.
    if (ind < 4) {
      const lm = parseListMarker(ln, ind);
      let empty = false;
      if (lm) {
        const sv = saveLn(ln);
        advanceCols(ln, ind);
        ln.i += lm.markerWidth;
        ln.col += lm.markerWidth;
        empty = isBlankRemainder(ln);
        restoreLn(ln, sv);
      }
      // An ordered marker with a number other than 1 cannot interrupt a
      // paragraph, except when the paragraph sits inside a list item: then
      // the marker starts a nested list in that item.
      const paraInItem = cont.t === 'para' && stack.length >= 2 && stack[stack.length - 2].t === 'item';
      const numBlocks = !!lm && !lm.bullet && lm.num !== 1 && !paraInItem;
      if (lm && !(cont.t === 'para' && (numBlocks || empty))) {
        closePara(stack, refs);
        let parent = stack[stack.length - 1];
        let list = null;
        if (parent.t === 'list' && parent.bullet === lm.bullet && parent.char === lm.char) {
          list = parent;
        } else {
          if (parent.t === 'list') {
            finalize(stack.pop(), stack[stack.length - 1], refs);
            parent = stack[stack.length - 1];
          }
          list = newBlock('list');
          list.bullet = lm.bullet;
          list.delim = lm.delim;
          list.char = lm.char;
          list.start = lm.num;
          list.tight = true;
          addChild(stack, parent, list);
          stack.push(list);
        }
        if (list.children.length > 0 && list.blankBefore) list.tight = false;
        const item = newBlock('item');
        item.indent = lm.contentIndent;
        list.children.push(item);
        stack.push(item);
        advanceCols(ln, ind);
        ln.i += lm.markerWidth;
        ln.col += lm.markerWidth;
        advanceCols(ln, lm.contentIndent - ind - lm.markerWidth);
        continue;
      }
    }
    // Blockquote.
    if (ind < 4) {
      const sv = saveLn(ln);
      advanceCols(ln, ind);
      if (ln.s[ln.i] === '>') {
        ensureNotListTop(stack, refs);
        closePara(stack, refs);
        ln.i++; ln.col++;
        skipOneSpace(ln);
        const q = newBlock('quote');
        addChild(stack, stack[stack.length - 1], q);
        stack.push(q);
        continue;
      }
      restoreLn(ln, sv);
    }
    // Indented code (cannot interrupt a paragraph).
    if (ind >= 4 && cont.t !== 'para') {
      ensureNotListTop(stack, refs);
      advanceCols(ln, 4);
      const cb = newBlock('code');
      cb.fenced = false;
      cb.lines = [ln.s.slice(ln.i)];
      addChild(stack, stack[stack.length - 1], cb);
      stack.push(cb);
      return;
    }
    // Paragraph (new or continuation). A lazy continuation line has its
    // leading whitespace stripped.
    if (cont.t === 'para') {
      if (lazy) {
        let k = ln.i;
        while (k < ln.s.length && (ln.s[k] === ' ' || ln.s[k] === '\t')) k++;
        cont.lines.push(ln.s.slice(k));
      } else {
        cont.lines.push(ln.s.slice(ln.i));
      }
    } else {
      ensureNotListTop(stack, refs);
      const p = newBlock('para');
      p.lines = [ln.s.slice(ln.i)];
      addChild(stack, stack[stack.length - 1], p);
      stack.push(p);
    }
    return;
  }
}

// Does this line start a block that can interrupt a paragraph? Used for
// lazy continuation: a line that starts such a block is not a lazy
// continuation of the open paragraph.
function interruptsPara(ln, stack) {
  const ind = countIndent(ln);
  if (ind >= 4) return false;
  const sv = saveLn(ln);
  advanceCols(ln, ind);
  const c = ln.s[ln.i];
  if (c === '#') {
    const n = fenceRun(ln, '#');
    if (n >= 1 && n <= 6 && (ln.i + n >= ln.s.length || ln.s[ln.i + n] === ' ' || ln.s[ln.i + n] === '\t')) { restoreLn(ln, sv); return true; }
  }
  if (c === '`' || c === '~') {
    if (fenceRun(ln, c) >= 3) { restoreLn(ln, sv); return true; }
  }
  if (c === '<') {
    const hb = htmlBlockStart(ln, ind);
    restoreLn(ln, sv);
    if (hb && hb.type !== 7) return true;
    return false;
  }
  if (c === '>') { restoreLn(ln, sv); return true; }
  restoreLn(ln, sv);
  if (isThematicBreak(ln, ind)) return true;
  const lm = parseListMarker(ln, ind);
  if (lm) {
    if (lm.bullet || lm.num === 1) return true;
    // Any marker interrupts when a list is already open: it either
    // continues that list or starts a new one (different bullet/delim).
    if (stack) {
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].t === 'list') return true;
      }
    }
  }
  return false;
}

// Does this line start a block-level construct (used to end a table)?
function lineStartsBlock(ln) {
  const ind = countIndent(ln);
  if (ind >= 4) return true; // indented code
  const sv = saveLn(ln);
  advanceCols(ln, ind);
  const c = ln.s[ln.i];
  if (c === '#') {
    const n = fenceRun(ln, '#');
    if (n >= 1 && n <= 6 && (ln.i + n >= ln.s.length || ln.s[ln.i + n] === ' ' || ln.s[ln.i + n] === '\t')) { restoreLn(ln, sv); return true; }
  }
  if (c === '`' || c === '~') {
    if (fenceRun(ln, c) >= 3) { restoreLn(ln, sv); return true; }
  }
  if (c === '<') {
    const hb = htmlBlockStart(ln, ind);
    restoreLn(ln, sv);
    if (hb) return true;
  }
  if (c === '>') { restoreLn(ln, sv); return true; }
  restoreLn(ln, sv);
  if (isThematicBreak(ln, ind)) return true;
  if (parseListMarker(ln, ind)) return true;
  return false;
}

// ---------- finalizing blocks ----------

function paraText(para) {
  return para.lines.join('\n');
}

function finalize(b, parent, refs) {
  if (b.t === 'para') {
    const rest = extractRefs(b, refs);
    if (rest.trim() === '') {
      const idx = parent.children.indexOf(b);
      if (idx >= 0) parent.children.splice(idx, 1);
    } else {
      b.inline = rest;
    }
  } else if (b.t === 'code' && !b.fenced) {
    while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
    b.text = b.lines.length ? b.lines.join('\n') + '\n' : '';
  } else if (b.t === 'code') {
    // Fenced code: only the blank line immediately before the closing
    // fence is dropped; earlier trailing blank lines are content.
    if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
    b.text = b.lines.length ? b.lines.join('\n') + '\n' : '';
  } else if (b.t === 'html') {
    b.text = b.lines.length ? b.lines.join('\n') + (b.noTrail ? '' : '\n') : '';
  }
}

// ---------- link reference definitions ----------

function skipWsNl(text, j) {
  while (j < text.length) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n') j++;
    else break;
  }
  return j;
}

function normalizeLabel(s) {
  const out = s.trim().replace(/\s+/g, ' ').toLowerCase();
  return out.replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

function parseRefDef(text, i) {
  const n = text.length;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isPunctChar(text[j + 1])) { label += text[j] + text[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') break;
    label += c;
    j++;
  }
  if (j >= n || text[j] !== ']') return null;
  const norm = normalizeLabel(label);
  if (!norm || norm.length > 999) return null;
  j++;
  j = skipWsNl(text, j);
  if (text[j] !== ':') return null;
  j++;
  j = skipWsNl(text, j);
  let dest;
  if (text[j] === '<') {
    let k = j + 1;
    let d = '';
    while (k < n) {
      const c = text[k];
      if (c === '\n') return null;
      if (c === '\\' && k + 1 < n && isPunctChar(text[k + 1])) { d += text[k + 1]; k += 2; continue; }
      if (c === '>') break;
      if (c === '<') return null;
      d += c;
      k++;
    }
    if (k >= n || text[k] !== '>') return null;
    dest = d;
    j = k + 1;
  } else {
    let k = j;
    let d = '';
    let parens = 0;
    while (k < n) {
      const c = text[k];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && k + 1 < n && isPunctChar(text[k + 1])) { d += text[k + 1]; k += 2; continue; }
      if (c === '(') parens++;
      else if (c === ')') { if (parens === 0) break; parens--; }
      d += c;
      k++;
    }
    if (d === '') return null;
    dest = d;
    j = k;
  }
  // Title: same line (after spaces) or on the next line (any indent).
  // A following line that is another ref def is not a title.
  let title = null;
  let k = j;
  let spaces = 0;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) { k++; spaces++; }
  const oc = text[k];
  if (oc === '"' || oc === "'" || oc === '(') {
    if (spaces === 0) return null;
    const t = parseTitle(text, k);
    if (!t) return null;
    title = t.title;
    j = t.end;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
    if (j < n && text[j] !== '\n') return null;
    return { label: norm, dest, title, end: j };
  }
  if (text[k] === '\n') {
    let k2 = k + 1;
    while (k2 < n && (text[k2] === ' ' || text[k2] === '\t')) k2++;
    const oc2 = text[k2];
    if (oc2 === '"' || oc2 === "'" || oc2 === '(') {
      const t = parseTitle(text, k2);
      if (t) {
        let j2 = t.end;
        while (j2 < n && (text[j2] === ' ' || text[j2] === '\t')) j2++;
        if (j2 >= n || text[j2] === '\n') {
          return { label: norm, dest, title: t.title, end: j2 };
        }
      }
      // Invalid next-line title: fall back to no title.
    }
  }
  if (k < n && text[k] !== '\n') return null;
  return { label: norm, dest, title, end: k };
}

function parseTitle(text, k) {
  const n = text.length;
  const oc = text[k];
  const close = oc === '(' ? ')' : oc;
  let t = '';
  k++;
  while (k < n) {
    const c = text[k];
    if (c === '\\' && k + 1 < n && isPunctChar(text[k + 1])) { t += text[k + 1]; k += 2; continue; }
    if (c === close) return { title: t, end: k + 1 };
    if (oc === '(' && c === '(') return null;
    t += c;
    k++;
  }
  return null;
}

// Pull leading link reference definitions out of a paragraph. Returns the
// remaining text (which may be empty).
function extractRefs(para, refs) {
  const text = para.lines.join('\n');
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let k = pos;
    let cols = 0;
    while (k < n && cols < 3) {
      const c = text[k];
      if (c === ' ') { cols++; k++; }
      else if (c === '\t') { cols += 4 - (cols % 4); k++; }
      else break;
    }
    if (cols >= 4 || text[k] !== '[') break;
    const def = parseRefDef(text, k);
    if (!def) break;
    if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
    pos = def.end;
    if (pos < n && text[pos] === '\n') pos++;
    else if (pos < n) break;
    if (pos >= n) { pos = n; break; }
  }
  return text.slice(pos);
}

// ---------- inline parsing ----------

function isUniSpaceChar(ch) {
  if (ch === '') return true;
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
function isUniPunctChar(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return /\p{P}|\p{S}/u.test(ch);
}

function skipInlineWs(src, j) {
  while (j < src.length) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n') j++;
    else break;
  }
  return j;
}

// Find the end of a code span: the index just past the next backtick run
// of exactly length n starting at or after `start`, or -1.
function findCodeSpanEnd(src, start, n) {
  let j = start;
  while (j < src.length) {
    if (src[j] === '`') {
      let m = 0;
      while (j + m < src.length && src[j + m] === '`') m++;
      if (m === n) return j + m;
      j += m;
    } else j++;
  }
  return -1;
}

// Find the ']' matching the '[' at src[i]. Bracket depth is tracked and
// code spans and backslash escapes are skipped. Returns -1 when unmatched.
function findClosingBracket(src, i) {
  let depth = 1;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length && isPunctChar(src[j + 1])) { j += 2; continue; }
    if (c === '`') {
      let n = 0;
      while (j + n < src.length && src[j + n] === '`') n++;
      const end = findCodeSpanEnd(src, j + n, n);
      if (end === -1) { j += n; continue; }
      j = end;
      continue;
    }
    if (c === '<') {
      const a = tryAutolink(src, j);
      if (a) { j = a.end; continue; }
      const h = tryHtmlInline(src, j);
      if (h) { j = h.end; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Scan for the ']' closing a reference label starting at src[j] ('[').
// An unescaped '[' inside makes it invalid. Returns index or -1.
function findLabelEnd(src, j) {
  let k = j + 1;
  while (k < src.length) {
    const c = src[k];
    if (c === '\\' && k + 1 < src.length && isPunctChar(src[k + 1])) { k += 2; continue; }
    if (c === '[') return -1;
    if (c === ']') return k;
    k++;
  }
  return -1;
}

function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && !nd.auto) return true;
    if (nd.children && containsLink(nd.children)) return true;
  }
  return false;
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code') out += escText(nd.s);
    else if (nd.t === 'entity') out += nd.s;
    else if (nd.t === 'soft' || nd.t === 'br') out += '\n';
    else if (nd.t === 'img') out += nd.alt;
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}

// Parse an inline link destination/title starting at src[j] ('(').
// Returns {dest, title, end} or null.
function parseInlineLink(src, j) {
  let k = skipInlineWs(src, j + 1);
  if (src[k] === ')') return { dest: '', title: null, end: k + 1 };
  let dest;
  if (src[k] === '<') {
    let m = k + 1;
    let d = '';
    while (m < src.length) {
      const c = src[m];
      if (c === '\n') return null;
      if (c === '\\' && m + 1 < src.length && isPunctChar(src[m + 1])) { d += src[m + 1]; m += 2; continue; }
      if (c === '>') break;
      if (c === '<') return null;
      d += c;
      m++;
    }
    if (src[m] !== '>') return null;
    dest = d;
    k = m + 1;
  } else {
    let m = k;
    let d = '';
    let parens = 0;
    while (m < src.length) {
      const c = src[m];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && m + 1 < src.length && isPunctChar(src[m + 1])) { d += src[m + 1]; m += 2; continue; }
      if (c === '(') parens++;
      else if (c === ')') { if (parens === 0) break; parens--; }
      d += c;
      m++;
    }
    if (d === '') return null;
    dest = d;
    k = m;
  }
  let title = null;
  let m = skipInlineWs(src, k);
  const oc = src[m];
  if (oc === '"' || oc === "'" || oc === '(') {
    const close = oc === '(' ? ')' : oc;
    let t = '';
    m++;
    let closed = false;
    while (m < src.length) {
      const c = src[m];
      if (c === '\\' && m + 1 < src.length && isPunctChar(src[m + 1])) { t += src[m + 1]; m += 2; continue; }
      if (c === close) { closed = true; break; }
      if (oc === '(' && c === '(') return null;
      t += c;
      m++;
    }
    if (!closed) return null;
    title = t;
    k = m + 1;
  }
  k = skipInlineWs(src, k);
  if (src[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

// Try to parse a link (or image) whose '[' is at src[i]. Returns
// {node, end} or null.
function tryParseLink(src, i, refs, isImage) {
  const closeIdx = findClosingBracket(src, i);
  if (closeIdx === -1) return null;
  const textNodes = parseInline(src.slice(i + 1, closeIdx), refs, true);
  if (!isImage && containsLink(textNodes)) return null;
  let j = closeIdx + 1;
  if (src[j] === '(') {
    const res = parseInlineLink(src, j);
    if (res) {
      const node = isImage
        ? { t: 'img', dest: res.dest, title: res.title, alt: plainText(textNodes) }
        : { t: 'link', dest: res.dest, title: res.title, children: textNodes };
      return { node, end: res.end };
    }
    // Inline link failed: fall through to the shortcut reference.
  }
  if (src[j] === '[') {
    const close2 = findLabelEnd(src, j);
    if (close2 === -1) return null;
    let label = normalizeLabel(src.slice(j + 1, close2));
    if (!label) label = normalizeLabel(src.slice(i + 1, closeIdx));
    const ref = label ? refs.get(label) : null;
    if (!ref) return null;
    const node = isImage
      ? { t: 'img', dest: ref.dest, title: ref.title, alt: plainText(textNodes) }
      : { t: 'link', dest: ref.dest, title: ref.title, children: textNodes };
    return { node, end: close2 + 1 };
  }
  const label = normalizeLabel(src.slice(i + 1, closeIdx));
  const ref = label ? refs.get(label) : null;
  if (!ref) return null;
  const node = isImage
    ? { t: 'img', dest: ref.dest, title: ref.title, alt: plainText(textNodes) }
    : { t: 'link', dest: ref.dest, title: ref.title, children: textNodes };
  return { node, end: closeIdx + 1 };
}

// Try an <...> autolink at src[i] ('<'). Returns {node, end} or null.
function tryAutolink(src, i) {
  let j = i + 1;
  if (j < src.length && isAlpha(src.charCodeAt(j))) {
    let k = j + 1;
    while (k < src.length && (isAlnum(src.charCodeAt(k)) || src[k] === '+' || src[k] === '.' || src[k] === '-')) k++;
    if (src[k] === ':' && k - j >= 2 && k - j <= 32) {
      let m = k + 1;
      while (m < src.length && src[m] !== '>' && src[m] !== ' ' && src[m] !== '\t' && src[m] !== '\n' && src.charCodeAt(m) >= 32) m++;
      if (src[m] === '>' && m > k + 1) {
        const url = src.slice(i + 1, m);
        return { node: { t: 'link', dest: url, title: null, auto: true, children: [{ t: 'text', s: url }] }, end: m + 1 };
      }
    }
  }
  const em = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/.exec(src.slice(i + 1));
  if (em) {
    const email = em[0].slice(0, -1);
    return { node: { t: 'link', dest: 'mailto:' + email, title: null, auto: true, children: [{ t: 'text', s: email }] }, end: i + 1 + em[0].length };
  }
  return null;
}

// Try an inline HTML construct at src[i] ('<'). Returns {s, end} or null.
function tryHtmlInline(src, i) {
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return { s: '<!-->', end: i + 5 };
    if (src.startsWith('<!--->', i)) return { s: '<!--->', end: i + 6 };
    const end = src.indexOf('-->', i + 4);
    if (end !== -1) return { s: src.slice(i, end + 3), end: end + 3 };
    return null;
  }
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    if (end !== -1) return { s: src.slice(i, end + 2), end: end + 2 };
    return null;
  }
  if (src.startsWith('<!', i)) {
    const c = src[i + 2];
    if (c && isAlpha(c.charCodeAt(0))) {
      const end = src.indexOf('>', i + 2);
      if (end !== -1) return { s: src.slice(i, end + 1), end: end + 1 };
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end !== -1) return { s: src.slice(i, end + 3), end: end + 3 };
    }
    return null;
  }
  const tagEnd = findTagEnd(src, i);
  if (tagEnd !== -1) return { s: src.slice(i, tagEnd), end: tagEnd };
  return null;
}

// Strip trailing punctuation from a GFM extended autolink, following the
// spec: trailing ? ! . , : ; * _ ~ are dropped (a ; that ends an entity
// reference is kept), and unmatched trailing ) are dropped.
// Common HTML5 named entities (for the autolink trailing-';' rule: a ';'
// is kept only when it closes a valid entity reference).
const HTML_ENTITIES = new Set(('amp lt gt quot apos nbsp copy reg trade hellip mdash ndash laquo raquo deg plusmn sup2 sup3 acute micro para middot cedil ordm ordf iexcl iquest cent pound curren yen brvbar sect uml shy macr times divide minus lowast radic prop infin ang and or cap cup int there4 sim cong asymp ne equiv le ge sub sup nsub sube supe oplus otimes perp sdot lceil rceil lfloor rfloor lang rang loz spades clubs hearts diams bull prime Prime oline frasl weierp image real alefsym larr uarr rarr darr harr crarr lArr uArr rArr dArr hArr forall part exist empty nabla isin notin ni prod sum agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml oslash ugrave uacute ucirc uuml yacute yuml szlig alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega ouml auml uuml euml iuml Ouml Auml Uuml Euml Iuml Oslash oslash Yuml yuml fnof circ tilde ensp emsp thinsp zwnj zwj lrm rlm euro').split(' '));

function trimAutolinkEnd(s) {
  let end = s.length;
  let changed = true;
  while (changed) {
    changed = false;
    while (end > 0 && '? ! . , : ; * _ ~'.includes(s[end - 1])) {
      if (s[end - 1] === ';') {
        const sub = s.slice(0, end);
        const em = /&([A-Za-z][A-Za-z0-9]{0,31});$/.exec(sub);
        if (em) {
          if (HTML_ENTITIES.has(em[1])) break;
          // Invalid entity: drop the whole &name; from the autolink.
          end = sub.length - em[0].length;
          changed = true;
          continue;
        }
        if (/&#[0-9]{1,7};$/.test(sub) || /&#[Xx][0-9A-Fa-f]{1,6};$/.test(sub)) break;
      }
      end--;
      changed = true;
    }
    while (end > 0 && s[end - 1] === ')') {
      let open = 0, close = 0;
      for (let k = 0; k < end; k++) {
        if (s[k] === '(') open++;
        else if (s[k] === ')') close++;
      }
      if (close > open) { end--; changed = true; }
      else break;
    }
  }
  return s.slice(0, end);
}

// Dry run of the processEmphasis pairing over the delimiter runs seen so
// far plus one hypothetical closer: does that closer pair with an earlier
// opener? The real list is untouched. Used by the autolink boundary rule:
// an email followed by a _ run that closes emphasis links in full.
function closerWouldPair(delims, ch, len, canOpen, canClose) {
  const ds = [];
  for (const d of delims) ds.push({ ch: d.ch, len: d.len, canOpen: d.canOpen, canClose: d.canClose });
  ds.push({ ch, len, canOpen, canClose });
  const target = ds.length - 1;
  let paired = false;
  let i = 0;
  while (i < ds.length) {
    const closer = ds[i];
    if (!closer.canClose || closer.len === 0) { i++; continue; }
    let oi = -1;
    for (let j = i - 1; j >= 0; j--) {
      const op = ds[j];
      if (op.ch !== closer.ch || !op.canOpen || op.len === 0) continue;
      if ((op.canOpen && op.canClose) || (closer.canOpen && closer.canClose)) {
        if ((op.len + closer.len) % 3 === 0 && (op.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      }
      oi = j;
      break;
    }
    if (oi === -1) { i++; continue; }
    if (i === target) paired = true;
    const op = ds[oi];
    const use = op.ch === '~' ? Math.min(op.len, closer.len) : (op.len >= 2 && closer.len >= 2) ? 2 : 1;
    op.len -= use;
    closer.len -= use;
    if (closer.len === 0) i++;
  }
  return paired;
}

// Match an email address at src[pos], the way marked's GFM autolink does.
// The local part holds only letters, digits, and . + - _; domain labels
// may contain _ and - inside, and the match must end at a boundary (not
// a word character, _ or -): when the boundary fails the match backtracks
// a whole label, so a@b.c.d_ links a@b.c and a@b.c_ links nothing at all.
// Exception: when the character after the full match is a _ run that
// closes emphasis against an earlier opener, the full match stands,
// because marked parses the emphasis content on its own and the closer
// is invisible to the autolink.
function matchEmail(src, pos, delims) {
  const rest = src.slice(pos);
  const greedyRe = /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)+/;
  const g = greedyRe.exec(rest);
  if (!g) return null;
  const boundedRe = /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)+(?![A-Za-z0-9_-])/;
  const b = boundedRe.exec(rest);
  if (!b) return null;
  if (b[0].length === g[0].length) return g[0];
  // The boundary failed and the match backtracked a label. If the
  // character after the greedy match is a _ run that closes emphasis,
  // the full match stands after all.
  if (rest[g[0].length] === '_') {
    const p = pos + g[0].length;
    let m = 0;
    while (p + m < src.length && src[p + m] === '_') m++;
    const before = p - 1 >= 0 ? src[p - 1] : '';
    const afterRun = p + m < src.length ? src[p + m] : '';
    const leftFlank = !isUniSpaceChar(afterRun) && (!isUniPunctChar(afterRun) || isUniSpaceChar(before) || isUniPunctChar(before));
    const rightFlank = !isUniSpaceChar(before) && (!isUniPunctChar(before) || isUniSpaceChar(afterRun) || isUniPunctChar(afterRun));
    const canOpen = leftFlank && (!rightFlank || isUniPunctChar(before));
    const canClose = rightFlank && (!leftFlank || isUniPunctChar(afterRun));
    if (canClose && closerWouldPair(delims, '_', m, canOpen, canClose)) return g[0];
  }
  return b[0];
}

// Try a GFM extended autolink (www., scheme://, email) at src[i].
// Returns {node, end} or null.
function tryExtendedAutolink(src, i, delims) {
  // Inside an <a ...> tag's link context (see inLinkSticky) no extended
  // autolink is formed at all.
  if (inLinkSticky) return null;
  const rest = src.slice(i);
  // A www. autolink only starts at the start of the string, after
  // whitespace, or after * _ ~ ( <; after any other character it is part
  // of a longer word and no link is formed. Scheme and email autolinks
  // have no such restriction: they link after any preceding character.
  const wwwOk = i === 0 || src[i - 1] === ' ' || src[i - 1] === '\t' || src[i - 1] === '\n' || src[i - 1] === '*' || src[i - 1] === '_' || src[i - 1] === '~' || src[i - 1] === '(' || src[i - 1] === '<';
  let m;
  if (wwwOk) {
    m = /^www\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+[^\s<]*/.exec(rest);
    if (m) {
      const text = trimAutolinkEnd(m[0]);
      if (text.length > 4) {
        return { node: { t: 'link', dest: 'http://' + text, title: null, auto: true, children: [{ t: 'text', s: text }] }, end: i + text.length };
      }
      return null;
    }
  }
  m = /^(?:https?|ftp):\/\/[^\s<]+/i.exec(rest);
  if (m) {
    const text = trimAutolinkEnd(m[0]);
    if (text.length > 0) {
      return { node: { t: 'link', dest: text, title: null, auto: true, children: [{ t: 'text', s: text }] }, end: i + text.length };
    }
    return null;
  }
  // Generic scheme autolink: scheme:email[/single-segment] (mailto:, xmpp:).
  m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(rest);
  if (m) {
    const emText = matchEmail(src, i + m[0].length, delims);
    if (emText) {
      let text = m[0] + emText;
      const seg = /^\/[^\s<>\/]+/.exec(rest.slice(m[0].length + emText.length));
      if (seg) text += seg[0];
      text = trimAutolinkEnd(text);
      if (text.length > 0) {
        return { node: { t: 'link', dest: text, title: null, auto: true, children: [{ t: 'text', s: text }] }, end: i + text.length };
      }
      return null;
    }
  }
  const emText = matchEmail(src, i, delims);
  if (emText) {
    const text = trimAutolinkEnd(emText);
    if (text.length > 0) {
      return { node: { t: 'link', dest: 'mailto:' + text, title: null, auto: true, children: [{ t: 'text', s: text }] }, end: i + text.length };
    }
  }
  return null;
}

// One piece of inline state survives across the whole document, the way
// marked's lexer keeps it: an <a ...> tag opens link context and only a
// literal </a> closes it. While it is open, GFM extended autolinks
// (www., scheme://, bare email) are not formed; angle autolinks and
// [x](y) links still are. Reset for every document in parse().
let inLinkSticky = false;

// Scan an inline string into a flat node list, then resolve emphasis.
function parseInline(src, refs, noExtAutolink) {
  const nodes = [];
  const delims = [];
  let i = 0;
  const n = src.length;
  let text = '';
  const flush = () => { if (text) { nodes.push({ t: 'text', s: text }); text = ''; } };

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isPunctChar(nx)) { text += nx; i += 2; continue; }
      text += c;
      i++;
      continue;
    }
    if (c === '`') {
      let m = 0;
      while (i + m < n && src[i + m] === '`') m++;
      const end = findCodeSpanEnd(src, i + m, m);
      if (end === -1) { text += src.slice(i, i + m); i += m; continue; }
      let content = src.slice(i + m, end - m).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = end;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const res = tryParseLink(src, i + 1, refs, true);
      if (res) { flush(); nodes.push(res.node); i = res.end; continue; }
      text += '!';
      i++;
      continue;
    }
    if (c === '[') {
      const res = tryParseLink(src, i, refs, false);
      if (res) { flush(); nodes.push(res.node); i = res.end; continue; }
      text += '[';
      i++;
      continue;
    }
    if (c === '*' || c === '_') {
      let m = 0;
      while (i + m < n && src[i + m] === c) m++;
      const before = i - 1 >= 0 ? src[i - 1] : '';
      const after = i + m < n ? src[i + m] : '';
      const leftFlank = !isUniSpaceChar(after) && (!isUniPunctChar(after) || isUniSpaceChar(before) || isUniPunctChar(before));
      const rightFlank = !isUniSpaceChar(before) && (!isUniPunctChar(before) || isUniSpaceChar(after) || isUniPunctChar(after));
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else {
        canOpen = leftFlank && (!rightFlank || isUniPunctChar(before));
        canClose = rightFlank && (!leftFlank || isUniPunctChar(after));
      }
      flush();
      const node = { t: 'text', s: src.slice(i, i + m) };
      nodes.push(node);
      delims.push({ ch: c, node, len: m, canOpen, canClose });
      i += m;
      continue;
    }
    if (c === '~') {
      let m = 0;
      while (i + m < n && src[i + m] === '~') m++;
      if (m <= 2) {
        const before = i - 1 >= 0 ? src[i - 1] : '';
        const after = i + m < n ? src[i + m] : '';
        const leftFlank = !isUniSpaceChar(after) && (!isUniPunctChar(after) || isUniSpaceChar(before) || isUniPunctChar(before));
        const rightFlank = !isUniSpaceChar(before) && (!isUniPunctChar(before) || isUniSpaceChar(after) || isUniPunctChar(after));
        flush();
        const node = { t: 'text', s: src.slice(i, i + m) };
        nodes.push(node);
        delims.push({ ch: '~', node, len: m, canOpen: leftFlank, canClose: rightFlank });
        i += m;
        continue;
      }
      text += src.slice(i, i + m);
      i += m;
      continue;
    }
    if (c === '<') {
      const al = tryAutolink(src, i);
      if (al) { flush(); nodes.push(al.node); i = al.end; continue; }
      const tag = tryHtmlInline(src, i);
      if (tag) {
        // An <a ...> tag (literal space after the a) opens link context;
        // only an exact </a> closes it again. A bare <a>, or a tab or
        // newline after the a, does not open it.
        if (/^<a /i.test(tag.s)) inLinkSticky = true;
        else if (/^<\/a>$/i.test(tag.s)) inLinkSticky = false;
        flush(); nodes.push({ t: 'html', s: tag.s }); i = tag.end; continue;
      }
      text += '<';
      i++;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '#') {
        const dec = decodeNumeric(src, i);
        if (dec !== null) {
          let j = i + 2;
          if (src[j] === 'x' || src[j] === 'X') j++;
          while (j < n && src[j] !== ';') j++;
          text += dec;
          i = j + 1;
          continue;
        }
      } else {
        const c1 = src[i + 1];
        if (c1 && ((c1 >= 'a' && c1 <= 'z') || (c1 >= 'A' && c1 <= 'Z'))) {
          let j = i + 2;
          while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9'))) j++;
          if (src[j] === ';') {
            flush();
            nodes.push({ t: 'entity', s: src.slice(i, j + 1) });
            i = j + 1;
            continue;
          }
        }
      }
      text += '&';
      i++;
      continue;
    }
    if (c === '\n') {
      if (/  +$/.test(text)) {
        text = text.replace(/  +$/, '');
        flush();
        nodes.push({ t: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        flush();
        nodes.push({ t: 'soft' });
        i++;
      }
      continue;
    }
    if (!noExtAutolink) {
      const ext = tryExtendedAutolink(src, i, delims);
      if (ext) { flush(); nodes.push(ext.node); i = ext.end; continue; }
    }
    text += c;
    i++;
  }
  flush();
  processEmphasis(nodes, delims);
  return nodes;
}

// Form one emphasis (use 1) or strong/del (use 2) node from the delimiter
// pair delims[oi] / delims[ci]. Mutates both lists. Returns the index the
// caller should continue from: the closer's new index when it still has
// characters left (it may close again), or the index the next delimiter
// shifted into when the closer was fully consumed.
function formEmphasis(nodes, delims, oi, ci, use) {
  const opener = delims[oi];
  const closer = delims[ci];
  const opNode = opener.node;
  const clNode = closer.node;
  const opIdx = nodes.indexOf(opNode);
  const clIdx = nodes.indexOf(clNode);
  const children = nodes.slice(opIdx + 1, clIdx);
  const emNode = { t: opener.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'), children };
  opener.len -= use;
  closer.len -= use;
  const replacement = [];
  if (opener.len > 0) { opNode.s = opNode.s.slice(0, opener.len); replacement.push(opNode); }
  replacement.push(emNode);
  if (closer.len > 0) { clNode.s = clNode.s.slice(clNode.s.length - closer.len); replacement.push(clNode); }
  nodes.splice(opIdx, clIdx - opIdx + 1, ...replacement);
  delims.splice(oi + 1, ci - oi - 1);
  let closerIdx = oi + 1;
  if (opener.len === 0) { delims.splice(oi, 1); closerIdx = oi; }
  if (closer.len === 0) delims.splice(closerIdx, 1);
  return closerIdx;
}

// Walk the delimiter list left to right, pairing each closer with the
// nearest earlier opener of the same character.
function processEmphasis(nodes, delims) {
  let i = 0;
  while (i < delims.length) {
    const closer = delims[i];
    if (!closer.canClose || closer.len === 0) { i++; continue; }
    let openerIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      const op = delims[j];
      if (op.ch !== closer.ch || !op.canOpen || op.len === 0) continue;
      if ((op.canOpen && op.canClose) || (closer.canOpen && closer.canClose)) {
        if ((op.len + closer.len) % 3 === 0 && (op.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      }
      openerIdx = j;
      break;
    }
    if (openerIdx === -1) { i++; continue; }
    const opener = delims[openerIdx];
    const use = opener.ch === '~' ? Math.min(opener.len, closer.len) : (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    i = formEmphasis(nodes, delims, openerIdx, i, use);
  }
}

// Percent-encode a URL the way marked does: like encodeURI, but a literal
// % is left alone (marked never double-encodes an existing %XX sequence).
function encodeHref(s) {
  return encodeURI(s).replace(/%25/g, '%');
}

// ---------- rendering ----------

function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escText(nd.s); break;
      case 'code': out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'soft': out += '\n'; break;
      case 'em': out += '<em>' + renderInline(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(nd.children) + '</del>'; break;
      case 'entity': out += nd.s; break;
      case 'link': {
        out += '<a href="' + escAttr(encodeHref(nd.dest)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>' + renderInline(nd.children) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + escAttr(encodeHref(nd.dest)) + '" alt="' + nd.alt + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>';
        break;
      }
      case 'html': out += nd.s; break;
    }
  }
  return out;
}

function renderTable(b, refs) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < b.ncols; k++) {
    const align = b.align[k];
    out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + renderInline(parseInline(b.header[k], refs)) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (b.rows.length === 0) return out + '</table>\n';
  out += '<tbody>';
  for (const row of b.rows) {
    out += '<tr>\n';
    for (let k = 0; k < b.ncols; k++) {
      const align = b.align[k];
      out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + renderInline(parseInline(row[k], refs)) + '</td>\n';
    }
    out += '</tr>\n';
  }
  return out + '</tbody></table>\n';
}

function renderItem(item, refs, tight) {
  const first = item.children[0];
  if (first && first.t === 'para') {
    const m = /^\[( |x|X)\]( |$)/.exec(first.inline);
    if (m) {
      const checked = m[1] === 'x' || m[1] === 'X';
      const box = checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
      const saved = first.inline;
      first.inline = saved.slice(3);
      let out;
      if (tight) {
        out = '<li>' + box + renderBlocks(item.children, refs, true) + '</li>\n';
      } else {
        const rest = item.children.slice(1);
        out = '<li><p>' + box + renderInline(parseInline(first.inline, refs)) + '</p>\n' + renderBlocks(rest, refs, false) + '</li>\n';
      }
      first.inline = saved;
      return out;
    }
  }
  return '<li>' + renderBlocks(item.children, refs, tight) + '</li>\n';
}

function renderBlocks(blocks, refs, tight) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'para':
        if (tight) out += renderInline(parseInline(b.inline, refs));
        else out += '<p>' + renderInline(parseInline(b.inline, refs)) + '</p>\n';
        break;
      case 'head':
        out += '<h' + b.level + '>' + renderInline(parseInline(b.inline, refs)) + '</h' + b.level + '>\n';
        break;
      case 'code': {
        out += '<pre><code';
        if (b.lang) out += ' class="language-' + escAttr(b.lang) + '"';
        out += '>' + escCode(b.text) + '</code></pre>\n';
        break;
      }
      case 'quote':
        out += '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
        break;
      case 'list': {
        if (b.bullet) out += '<ul>\n';
        else out += '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
        for (const item of b.children) out += renderItem(item, refs, b.tight);
        out += b.bullet ? '</ul>\n' : '</ol>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += b.text;
        break;
      case 'table':
        out += renderTable(b, refs);
        break;
    }
  }
  return out;
}

// Main entry: render one Markdown document to an HTML string.
export function parse(src) {
  inLinkSticky = false;
  src = src.replace(/\r\n?/g, '\n');
  const endsWithNewline = src.endsWith('\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const doc = parseBlocks(lines, refs, endsWithNewline);
  return renderBlocks(doc.children, refs, false);
}
