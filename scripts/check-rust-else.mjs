import fs from 'node:fs';
import path from 'node:path';

const TARGET_ROOTS = ['src-tauri/src', 'src-tauri/tests'];

function collectRustFiles(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRustFiles(fullPath, output);
      continue;
    }
    if (entry.name.endsWith('.rs')) output.push(fullPath);
  }
  return output;
}

function stripStringsAndComments(source) {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      continue;
    }

    if (current === '/' && next === '*') {
      result += '  ';
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') {
          depth += 1;
          result += '  ';
          index += 2;
          continue;
        }
        if (source[index] === '*' && source[index + 1] === '/') {
          depth -= 1;
          result += '  ';
          index += 2;
          continue;
        }
        result += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (current === 'r' && (next === '#' || next === '"')) {
      let hashes = 0;
      let scan = index + 1;
      while (source[scan] === '#') {
        hashes += 1;
        scan += 1;
      }
      if (source[scan] === '"') {
        result += ' '.repeat(scan - index + 1);
        index = scan + 1;
        const closing = '"' + '#'.repeat(hashes);
        while (index < source.length && !source.startsWith(closing, index)) {
          result += source[index] === '\n' ? '\n' : ' ';
          index += 1;
        }
        if (source.startsWith(closing, index)) {
          result += ' '.repeat(closing.length);
          index += closing.length;
        }
        continue;
      }
    }

    if (current === '"') {
      result += ' ';
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          result += '  ';
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          result += ' ';
          index += 1;
          break;
        }
        result += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (current === "'") {
      if (source[index + 1] === '\\') {
        let scan = index + 2;
        while (scan < source.length && source[scan] !== "'" && source[scan] !== '\n') scan += 1;
        if (source[scan] === "'") {
          result += ' '.repeat(scan - index + 1);
          index = scan + 1;
          continue;
        }
      }
      if (source[index + 1] !== '\\' && source[index + 2] === "'") {
        result += '   ';
        index += 3;
        continue;
      }
    }

    result += current;
    index += 1;
  }
  return result;
}

function findDisallowedElse(source) {
  const cleaned = stripStringsAndComments(source);
  const violations = [];
  const regex = /\belse\b/g;
  let match = regex.exec(cleaned);
  while (match !== null) {
    const start = match.index;
    const after = cleaned.slice(start + 4);
    const isElseIf = /^\s+if\b/.test(after);
    const before = cleaned.slice(0, start).trimEnd();
    const precededByBrace = before.endsWith('}');
    if (isElseIf || precededByBrace) {
      const line = cleaned.slice(0, start).split('\n').length;
      violations.push(line);
    }
    match = regex.exec(cleaned);
  }
  return violations;
}

const roots = process.argv.slice(2);
const scanRoots = roots.length > 0 ? roots : TARGET_ROOTS;
const files = scanRoots.flatMap((root) =>
  fs.statSync(root).isDirectory() ? collectRustFiles(root) : [root],
);

let totalViolations = 0;
for (const file of files.sort()) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = findDisallowedElse(source);
  for (const line of lines) {
    console.error(
      `${file}:${line}: disallowed \`else\` (use early returns, let ... else, match, or a helper)`,
    );
    totalViolations += 1;
  }
}

if (totalViolations > 0) {
  console.error(`\nFound ${totalViolations} disallowed \`else\` occurrences in Rust.`);
  process.exit(1);
}
