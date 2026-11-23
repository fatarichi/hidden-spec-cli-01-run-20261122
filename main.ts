// mend: the CLI SPEC.md specifies (version 1). Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`. Reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE, V4A, JSON), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under SPEC.md section 3. */
interface FileModel {
  lines: string[];
  br: string; // '\r\n' when the first line feed follows a carriage return, else '\n'
  final: boolean; // the text ends with that break
}
function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, [old path, new path], in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Positions (0-based) where O occurs in lines at one tier, from `from` on. */
function occurrencesAt(O: string[], lines: string[], tier: number, from: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? stripTrail : stripBoth;
  const o = O.map(norm);
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(lines[i + j]!) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, 1, 2; only 0 when strict) at which O occurs in lines from
 * `from` on, and its positions there. null when O occurs at no tier.
 */
function findTier(O: string[], lines: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Build the lines that replace O at `pos` in `lines`, given N.
 * `ctx` marks, for each line of O and of N, whether it is a context line; the
 * context lines of O and N are the same lines, in the same order. A context
 * line of N is written as the file's own matched line, never the patch's. At
 * tier 2 every other line of N is re-indented (F replaces P). At tiers 0 and
 * 1 the lines of N are written as they are.
 */
function replacement(O: string[], oCtx: boolean[], N: string[], nCtx: boolean[], lines: string[], pos: number, tier: number): string[] {
  const oCtxIdx: number[] = [];
  for (let j = 0; j < O.length; j += 1) if (oCtx[j]) oCtxIdx.push(j);
  const F = O.length > 0 ? leadWs(lines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const out: string[] = [];
  let c = 0;
  for (let k = 0; k < N.length; k += 1) {
    if (nCtx[k]) {
      out.push(lines[pos + oCtxIdx[c]!]!);
      c += 1;
    } else {
      const t = N[k]!;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    }
  }
  return out;
}

/** Replace the k matched lines at `pos` with `rep` in the file model. */
function spliceLines(m: FileModel, pos: number, k: number, rep: string[]): void {
  m.lines.splice(pos, k, ...rep);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const m = splitFile(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(m));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number; // old start line (1-based, from the header)
  body: string[]; // body lines, trailing empty lines removed
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function cleanDiffPath(raw: string): string {
  let p = raw;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface RawSection {
  headOld: string | null | undefined; // null: /dev/null; undefined: no pair
  headNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function parseHunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

function hunkBackslash(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (l.startsWith(' ') || l.startsWith('+') || l === '') last = i;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\');
}

/** Split a hunk body into O (context + `-`) and N (context + `+`), with context flags. */
function hunkON(body: string[]): { O: string[]; oCtx: boolean[]; N: string[]; nCtx: boolean[] } {
  const O: string[] = [];
  const oCtx: boolean[] = [];
  const N: string[] = [];
  const nCtx: boolean[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l.startsWith(' ')) {
      O.push(l.slice(1));
      oCtx.push(true);
      N.push(l.slice(1));
      nCtx.push(true);
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
      oCtx.push(false);
    } else if (l.startsWith('+')) {
      N.push(l.slice(1));
      nCtx.push(false);
    } else if (l === '') {
      O.push('');
      oCtx.push(true);
      N.push('');
      nCtx.push(true);
    }
  }
  return { O, oCtx, N, nCtx };
}

function parseUnified(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): RawSection => ({
    headOld: undefined,
    headNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    create: false,
    remove: false,
    hunks: [],
  });
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git a/'.length);
      const sep = rest.indexOf(' b/');
      if (!l.startsWith('diff --git a/') || sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const go = rest.slice(0, sep);
      const gn = rest.slice(sep + 3);
      if (go === '' || gn === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = go;
      cur.gitNew = gn;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body, backslashAfterLast: hunkBackslash(body) });
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const op = headerPath(l);
          const np = headerPath(lines[i + 1]!);
          cur.headOld = op === '/dev/null' ? null : cleanDiffPath(op);
          cur.headNew = np === '/dev/null' ? null : cleanDiffPath(np);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.create = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.remove = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = fresh();
      const op = headerPath(l);
      const np = headerPath(lines[i + 1]!);
      cur.headOld = op === '/dev/null' ? null : cleanDiffPath(op);
      cur.headNew = np === '/dev/null' ? null : cleanDiffPath(np);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply one hunk to the file model, following section 6. `d` is the running line delta. */
function applyHunk(m: FileModel, h: Hunk, d: number, strict: boolean): number {
  const { O, oCtx, N, nCtx } = hunkON(h.body);
  if (O.length > 0) {
    const found = findTier(O, m.lines, strict, 0);
    if (found === null) throw new Fail('no-match', '');
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + O.length === m.lines.length;
    const rep = replacement(O, oCtx, N, nCtx, m.lines, best, found.tier);
    spliceLines(m, best, O.length, rep);
    if (runsToEnd) m.final = !h.backslashAfterLast;
    return d + (N.length - O.length);
  }
  // O empty: insert N after the first A + d lines.
  const at = Math.min(Math.max(h.a + d, 0), m.lines.length);
  const runsToEnd = at === m.lines.length;
  spliceLines(m, at, 0, N);
  if (runsToEnd) m.final = !h.backslashAfterLast;
  return d + N.length;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldPath = sec.headOld !== undefined ? sec.headOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
    const newPath = sec.headNew !== undefined ? sec.headNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
    const isCreate = sec.create || oldPath === null;
    const isRemove = sec.remove || newPath === null;
    if (isCreate) {
      const np = newPath;
      // The `+` lines of all its hunks, in order; ends with a line break
      // unless a `\` line follows its last `+` line.
      let plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k += 1) if (h.body[k]!.startsWith('+')) lastPlus = k;
        for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
        if (lastPlus >= 0 && lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.startsWith('\\')) noBreak = true;
        else if (lastPlus >= 0) noBreak = false;
      }
      edits.push((tree) => {
        if (np === undefined || np === null) return;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      });
      continue;
    }
    if (isRemove) {
      const op = oldPath;
      edits.push((tree) => {
        if (op === undefined || op === null) return;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
      continue;
    }
    const op = oldPath as string;
    const np = newPath as string;
    const isMove = op !== np;
    edits.push((tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const m = splitFile(before);
      let d = 0;
      try {
        for (const h of sec.hunks) d = applyHunk(m, h, d, strict);
      } catch (e) {
        if (e instanceof Fail && e.path === '') throw new Fail('no-match', op);
        throw e;
      }
      const out = joinFile(m);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, out);
        tree.moves.push([op, np]);
      } else {
        tree.now.set(op, out);
      }
    });
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // index just after the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    // The path: nearest line before SEARCH, after prevEnd, not blank and not
    // starting with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    // Find `=======` then `>>>>>>> REPLACE` after SEARCH.
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const m = splitFile(before);
      const found = findTier(oldLines, m.lines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const rep2 = replacement(oldLines, oldLines.map(() => false), newLines, newLines.map(() => false), m.lines, found.pos[0]!, found.tier);
      spliceLines(m, found.pos[0]!, oldLines.length, rep2);
      tree.now.set(p, joinFile(m));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4AChunk {
  anchor: string | null; // null: no anchor
  eof: boolean;
  O: string[];
  oCtx: boolean[];
  N: string[];
  nCtx: boolean[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number; // 0-based index of the section's opening line
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // Section spans: each starts at an Add/Delete/Update line; blank lines at
  // the end of a section (before the next section or *** End Patch) are not
  // part of it, so the span is trimmed of trailing blank lines.
  const starts: number[] = [];
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (blank(l)) continue;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) starts.push(i);
    // `*** Move to: ` and `*** End of File` lines sit inside a section's span
    // and are handled by that section's parser; any other line is caught by
    // the span checks below or by the section parser.
  }
  const sections: V4ASection[] = [];
  for (let s = 0; s < starts.length; s += 1) {
    const si = starts[s]!;
    const l = lines[si]!;
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const path = l.slice(kind === 'add' ? '*** Add File: '.length : kind === 'delete' ? '*** Delete File: '.length : '*** Update File: '.length).trim();
    let end = s + 1 < starts.length ? starts[s + 1]! : last;
    while (end > si + 1 && blank(lines[end - 1]!)) end -= 1;
    const sec: V4ASection = { kind, path, line: si, moveTo: null, addLines: [], chunks: [] };
    let i = si + 1;
    if (kind === 'add') {
      while (i < end) {
        const a = lines[i]!;
        if (a.startsWith('+')) sec.addLines.push(a.slice(1));
        else if (a === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else if (kind === 'delete') {
      while (i < end) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else {
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      let cur: V4AChunk | null = null;
      const flush = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < end) {
        const a = lines[i]!;
        if (a === '*** End of File') {
          if (cur !== null) cur.eof = true;
          flush();
          i += 1;
          continue;
        }
        if (a.startsWith('@@')) {
          flush();
          const anchor = a.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, O: [], oCtx: [], N: [], nCtx: [] };
          i += 1;
          continue;
        }
        if (a.startsWith(' ') || a.startsWith('-') || a.startsWith('+') || a === '') {
          if (cur === null) cur = { anchor: null, eof: false, O: [], oCtx: [], N: [], nCtx: [] };
          if (a.startsWith(' ')) {
            cur.O.push(a.slice(1));
            cur.oCtx.push(true);
            cur.N.push(a.slice(1));
            cur.nCtx.push(true);
          } else if (a.startsWith('-')) {
            cur.O.push(a.slice(1));
            cur.oCtx.push(false);
          } else if (a.startsWith('+')) {
            cur.N.push(a.slice(1));
            cur.nCtx.push(false);
          } else {
            cur.O.push('');
            cur.oCtx.push(true);
            cur.N.push('');
            cur.nCtx.push(true);
          }
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${si + 1}`);
    }
    sections.push(sec);
  }
  // Any non-blank, non-section line between Begin Patch and End Patch that is
  // not inside a section span is a parse error; the span scan above already
  // throws for lines starting with `*** `, and other lines can only sit
  // before the first section or between sections, where they are also errors.
  // (Lines before the first section start are caught here.)
  if (starts.length > 0) {
    for (let i = first + 1; i < starts[0]!; i += 1) {
      if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
    }
  } else {
    for (let i = first + 1; i < last; i += 1) {
      if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      const p = sec.path;
      const content = sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content);
      });
    } else if (sec.kind === 'delete') {
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = sec.path;
      const to = sec.moveTo;
      const chunks = sec.chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (to !== null && !safe(to)) throw new Fail('unsafe', to);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
        const m = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundAt = -1;
            for (const t of strict ? [0] : [0, 1, 2]) {
              const norm = t === 0 ? (s: string): string => s : t === 1 ? stripTrail : stripBoth;
              const a = norm(ch.anchor);
              for (let k = cursor; k < m.lines.length; k += 1) {
                if (norm(m.lines[k]!) === a) {
                  foundAt = k;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          if (ch.O.length === 0) {
            const at = ch.eof ? m.lines.length : cursor;
            spliceLines(m, at, 0, ch.N);
            cursor = at + ch.N.length;
            continue;
          }
          let found: { tier: number; pos: number[] } | null = null;
          for (const t of strict ? [0] : [0, 1, 2]) {
            let pos = occurrencesAt(ch.O, m.lines, t, cursor);
            if (ch.eof) pos = pos.filter((x) => x + ch.O.length === m.lines.length);
            if (pos.length > 0) {
              found = { tier: t, pos };
              break;
            }
          }
          if (found === null) throw new Fail('no-match', p);
          const pos = found.pos[0]!;
          const rep = replacement(ch.O, ch.oCtx, ch.N, ch.nCtx, m.lines, pos, found.tier);
          spliceLines(m, pos, ch.O.length, rep);
          cursor = pos + rep.length;
        }
        const out = joinFile(m);
        if (to !== null) {
          tree.now.set(p, null);
          tree.now.set(to, out);
          tree.moves.push([p, to]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Exit 0: one line per changed path, in byte order of the paths (UTF-8).
  // A successful move is `R <old> -> <new>`, sorted by <new>, replacing that
  // pair's `D` and `A` lines.
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.now.get(from) === null && tree.original(to) === null && tree.now.get(to) !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      covered.add(from);
      covered.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
