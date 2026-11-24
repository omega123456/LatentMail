const ESCAPED_QUOTE_LENGTH = 2;

type CsvParserState = {
  rows: string[][];
  row: string[];
  field: string;
  inQuotes: boolean;
  index: number;
};

function pushField(state: CsvParserState) {
  state.row.push(state.field);
  state.field = '';
}

function pushRow(state: CsvParserState) {
  pushField(state);
  state.rows.push(state.row);
  state.row = [];
}

function stepQuotedChar(text: string, state: CsvParserState) {
  const char = text[state.index];
  if (char !== '"') {
    state.field += char;
    state.index += 1;
    return;
  }
  if (text[state.index + 1] === '"') {
    state.field += '"';
    state.index += ESCAPED_QUOTE_LENGTH;
    return;
  }
  state.inQuotes = false;
  state.index += 1;
}

function stepUnquotedChar(text: string, state: CsvParserState) {
  const char = text[state.index];
  if (char === '"') {
    state.inQuotes = true;
    state.index += 1;
    return;
  }
  if (char === ',') {
    pushField(state);
    state.index += 1;
    return;
  }
  if (char === '\r') {
    if (text[state.index + 1] === '\n') state.index += 1;
    pushRow(state);
    state.index += 1;
    return;
  }
  if (char === '\n') {
    pushRow(state);
    state.index += 1;
    return;
  }
  state.field += char;
  state.index += 1;
}

export function parseCsv(text: string): string[][] {
  const state: CsvParserState = {
    rows: [],
    row: [],
    field: '',
    inQuotes: false,
    index: 0,
  };

  while (state.index < text.length) {
    if (state.inQuotes) {
      stepQuotedChar(text, state);
      continue;
    }
    stepUnquotedChar(text, state);
  }

  if (state.field.length > 0 || state.row.length > 0 || state.inQuotes) pushRow(state);

  return state.rows.filter((entry) => !(entry.length === 1 && entry[0] === ''));
}
