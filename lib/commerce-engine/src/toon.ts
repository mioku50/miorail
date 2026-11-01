// ---------------------------------------------------------------------------
// TOON, the part Bitrefill's MCP speaks.
//
// Bitrefill's read tools answer in TOON (Token-Oriented Object Notation), a
// compact text form of JSON. This decoder reads the shapes those answers use,
// strictly: objects by two-space indentation, `key: value`, inline arrays
// `key[N]: a,b`, tables `key[N]{f1,f2}:` with N rows, lists `key[N]:` with N
// `- ` items, and quoted strings with \" \\ \n \r \t escapes. Anything else,
// including a count that does not match its rows, throws with the line, so a
// changed answer is a failed read and never a guess.
//
// Written here rather than taken as a package: the official decoder pulled a
// re-resolution of unrelated wallet dependencies into the lockfile (2026-11-01).
// ---------------------------------------------------------------------------

export class ToonParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`TOON line ${line}: ${message}`);
    this.name = 'ToonParseError';
  }
}

interface LineV1 {
  depth: number;
  text: string;
  no: number;
}

const HEADER_V1 = /^(?<key>"(?:[^"\\]|\\.)*"|[^\s"[\]{}:][^"[\]{}:]*?)(?:\[(?<count>\d+)(?<delimiter>[\t|]?)\](?:\{(?<fields>[^}]*)\})?)?:(?<rest>.*)$/;
const NUMBER_V1 = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function unquoteV1(token: string, no: number): string {
  let out = '';
  for (let i = 1; i < token.length - 1; i += 1) {
    const char = token[i]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = token[i + 1];
    i += 1;
    if (next === '"' || next === '\\') out += next;
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else throw new ToonParseError(`unknown escape \\${next ?? ''}`, no);
  }
  return out;
}

function primitiveV1(raw: string, no: number): unknown {
  const token = raw.trim();
  if (token.startsWith('"')) {
    if (token.length < 2 || !token.endsWith('"') || token.endsWith('\\"') && !token.endsWith('\\\\"')) {
      throw new ToonParseError('unterminated string', no);
    }
    return unquoteV1(token, no);
  }
  if (token === 'null') return null;
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (NUMBER_V1.test(token)) return Number(token);
  return token;
}

function keyV1(raw: string, no: number): string {
  const key = raw.trim();
  return key.startsWith('"') ? unquoteV1(key, no) : key;
}

/** Splits one delimited row, honouring quotes. */
function splitV1(row: string, delimiter: string, no: number): unknown[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (quoted) {
      current += char;
      if (char === '\\') {
        current += row[i + 1] ?? '';
        i += 1;
      } else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else current += char;
  }
  if (quoted) throw new ToonParseError('unterminated string in a row', no);
  cells.push(current);
  return cells.map((cell) => primitiveV1(cell, no));
}

function linesV1(text: string): LineV1[] {
  const lines: LineV1[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    const spaces = line.length - line.trimStart().length;
    if (/^\s*\t/.test(line) || spaces % 2 !== 0) throw new ToonParseError('indentation is not two spaces per level', index + 1);
    lines.push({ depth: spaces / 2, text: line.slice(spaces), no: index + 1 });
  });
  return lines;
}

export function decodeToonV1(text: string): unknown {
  const lines = linesV1(text);
  let at = 0;

  const peek = (): LineV1 | undefined => lines[at];

  function field(target: Record<string, unknown>, content: string, depth: number, no: number): void {
    const header = HEADER_V1.exec(content);
    if (!header?.groups) throw new ToonParseError('expected `key: value`', no);
    const { key, count, delimiter, fields, rest } = header.groups as Record<string, string | undefined>;
    const name = keyV1(key!, no);
    if (Object.prototype.hasOwnProperty.call(target, name)) throw new ToonParseError(`duplicate key ${name}`, no);
    if (count === undefined) {
      if (rest!.trim() !== '') {
        target[name] = primitiveV1(rest!, no);
        return;
      }
      const next = peek();
      target[name] = next && next.depth > depth ? object(depth + 1) : {};
      return;
    }
    target[name] = array(Number(count), delimiter || ',', fields, rest!, depth, no);
  }

  function array(count: number, delimiter: string, fields: string | undefined, rest: string, depth: number, no: number): unknown[] {
    if (fields !== undefined) {
      if (rest.trim() !== '') throw new ToonParseError('a table header carries no inline values', no);
      const names = fields.split(delimiter).map((name) => keyV1(name, no));
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i += 1) {
        const line = peek();
        if (!line || line.depth !== depth + 1) throw new ToonParseError(`table expects ${count} rows, found ${i}`, no);
        at += 1;
        const cells = splitV1(line.text, delimiter, line.no);
        if (cells.length !== names.length) throw new ToonParseError(`row has ${cells.length} cells for ${names.length} fields`, line.no);
        rows.push(Object.fromEntries(names.map((name, column) => [name, cells[column]])));
      }
      return rows;
    }
    if (rest.trim() !== '') {
      const values = splitV1(rest.trim(), delimiter, no);
      if (values.length !== count) throw new ToonParseError(`array says ${count} values, found ${values.length}`, no);
      return values;
    }
    if (count === 0) return [];
    const items: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const line = peek();
      if (!line || line.depth !== depth + 1 || !line.text.startsWith('- ')) throw new ToonParseError(`list expects ${count} items, found ${i}`, no);
      at += 1;
      items.push(item(line.text.slice(2), depth + 1, line.no));
    }
    return items;
  }

  /** One `- ` item: a primitive, or an object whose first field sits on the hyphen line. */
  function item(content: string, depth: number, no: number): unknown {
    const header = HEADER_V1.exec(content);
    if (!header || content.trimStart().startsWith('"') && !/^"(?:[^"\\]|\\.)*"\s*(?:\[\d+[\t|]?\](?:\{[^}]*\})?)?:/.test(content)) {
      return primitiveV1(content, no);
    }
    const target: Record<string, unknown> = {};
    field(target, content, depth + 1, no);
    while (peek() && peek()!.depth === depth + 1) {
      const line = peek()!;
      if (line.text.startsWith('- ')) break;
      at += 1;
      field(target, line.text, depth + 1, line.no);
    }
    return target;
  }

  function object(depth: number): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    while (peek()) {
      const line = peek()!;
      if (line.depth < depth) break;
      if (line.depth > depth) throw new ToonParseError('unexpected indentation', line.no);
      at += 1;
      field(target, line.text, depth, line.no);
    }
    return target;
  }

  const first = peek();
  if (!first) return {};
  if (first.text.startsWith('[')) {
    const header = /^\[(\d+)([\t|]?)\](?:\{([^}]*)\})?:(.*)$/.exec(first.text);
    if (!header) throw new ToonParseError('expected a root array header', first.no);
    at += 1;
    const value = array(Number(header[1]), header[2] || ',', header[3], header[4]!, -1, first.no);
    if (peek()) throw new ToonParseError('text after the root array', peek()!.no);
    return value;
  }
  const root = object(0);
  if (peek()) throw new ToonParseError('text after the root object', peek()!.no);
  return root;
}
