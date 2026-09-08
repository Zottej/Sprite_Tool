/** Nombres habituales → carácter Unicode (solo si el token es el nombre completo del glifo). */
const NAMED_CHARS: Record<string, string> = {
  space: ' ',
  sp: ' ',
  blank: ' ',
  espacio: ' ',
  underscore: '_',
  underline: '_',
  guionbajo: '_',
  hyphen: '-',
  dash: '-',
  guion: '-',
  /** Guión: solo si el archivo se llama exactamente así (no `a_minus`). */
  minus: '-',
  period: '.',
  dot: '.',
  punto: '.',
  comma: ',',
  coma: ',',
  colon: ':',
  semicolon: ';',
  quote: "'",
  apostrophe: "'",
  doublequote: '"',
  quotes: '"',
  slash: '/',
  backslash: '\\',
  pipe: '|',
  question: '?',
  exclamation: '!',
  bang: '!',
  at: '@',
  hash: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  star: '*',
  asterisk: '*',
  plus: '+',
  equal: '=',
  equals: '=',
  tilde: '~',
  caret: '^',
  backtick: '`',
  less: '<',
  greater: '>',
  lparen: '(',
  rparen: ')',
  lbracket: '[',
  rbracket: ']',
  lbrace: '{',
  rbrace: '}',
};

type CaseHint = 'upper' | 'lower';

/** Marcadores de mayúscula (Windows no permite A.png y a.png a la vez). */
const UPPER_MARKERS = new Set([
  'upper', 'uppercase', 'up', 'uc', 'cap', 'caps', 'capital',
  'mayus', 'mayuscula', 'mayúscula', 'maiuscula', 'big', 'grande',
]);

/** Marcadores de minúscula. `minus`/`min` solo cuentan si hay letra en el nombre. */
const LOWER_MARKERS = new Set([
  'lower', 'lowercase', 'low', 'lc', 'small', 'tiny',
  'minuscula', 'minúscula', 'minuscula', 'min',
]);

const fileBaseName = (fileName: string) => {
  const trimmed = String(fileName || '').trim();
  const noPath = trimmed.replace(/^.*[/\\]/, '');
  return noPath.replace(/\.[^.]+$/i, '');
};

/** Quita sufijos de copia de Windows / export: `A (1)`, `A - copia`, `A_copy`. */
const stripCopySuffix = (name: string) =>
  name
    .replace(/\s*\(\d+\)$/i, '')
    .replace(/\s*-\s*copia(\s*\(\d+\))?$/i, '')
    .replace(/[_\s-]+copy$/i, '')
    .replace(/[_\s-]+copia$/i, '')
    .trim();

const fromCodePointSafe = (cp: number): string | null => {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return null;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return null;
  }
};

/** Un solo grafema printable (letra, dígito, símbolo). */
const asSingleGlyph = (s: string): string | null => {
  const chars = [...s];
  if (chars.length !== 1) return null;
  const ch = chars[0];
  const cp = ch.codePointAt(0)!;
  if (cp < 32 && ch !== ' ') return null;
  if (cp === 0x7f) return null;
  return ch;
};

const applyCaseHint = (ch: string, hint: CaseHint | null): string => {
  if (!hint) return ch;
  if (![...ch].some((c) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(c))) return ch;
  return hint === 'upper' ? ch.toLocaleUpperCase('en-US') : ch.toLocaleLowerCase('en-US');
};

const isUpperMarker = (token: string) => UPPER_MARKERS.has(token.toLowerCase());
const isLowerMarker = (token: string) => {
  const t = token.toLowerCase();
  if (LOWER_MARKERS.has(t)) return true;
  // `minus` = minúscula solo en contexto con letra (si no, es el signo "-")
  return t === 'minus';
};

const parseCodeToken = (token: string): string | null => {
  const t = token.trim();
  if (!t) return null;

  const uni = t.match(/^(?:u\+|u|uni|codepoint[_-]?)([0-9a-f]{2,6})$/i);
  if (uni) return fromCodePointSafe(parseInt(uni[1], 16));

  const dec = t.match(/^(?:ascii|code|cp)[_-]?(\d{1,7})$/i);
  if (dec) return fromCodePointSafe(parseInt(dec[1], 10));

  const charNum = t.match(/^(?:char|glyph)[_-]?(\d{1,7})$/i);
  if (charNum) return fromCodePointSafe(parseInt(charNum[1], 10));

  if (/^\d{1,3}$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 32 && n <= 126) return fromCodePointSafe(n);
  }

  return null;
};

const parseNamedOrSingle = (token: string): string | null => {
  const t = token.trim();
  if (!t) return null;
  const named = NAMED_CHARS[t.toLowerCase()];
  if (named !== undefined) return named;
  return asSingleGlyph(t);
};

/**
 * Extrae hint de casing y la letra desde tokens tipo:
 * `A_mayus`, `a_minus`, `upper_A`, `lower-a`, `cap_b`
 */
const guessFromPartsWithCase = (parts: string[]): string | null => {
  if (parts.length === 0) return null;

  let hint: CaseHint | null = null;
  const rest: string[] = [];
  for (const p of parts) {
    if (isUpperMarker(p)) {
      hint = 'upper';
      continue;
    }
    if (isLowerMarker(p)) {
      hint = 'lower';
      continue;
    }
    rest.push(p);
  }

  // Sin marcador de caso: comportamiento anterior sobre todos los parts
  const pool = hint ? rest : parts;

  for (let i = pool.length - 1; i >= 0; i--) {
    const single = asSingleGlyph(pool[i]);
    if (single && /[A-Za-z0-9]/.test(single)) {
      return applyCaseHint(single, hint);
    }
  }

  for (let i = pool.length - 1; i >= 0; i--) {
    // No interpretar "minus" como "-" si ya lo usamos (o podríamos usar) como casing
    if (hint && pool[i].toLowerCase() === 'minus') continue;
    const fromPart = parseCodeToken(pool[i]) ?? parseNamedOrSingle(pool[i]);
    if (fromPart !== null) return applyCaseHint(fromPart, hint);
  }

  // Solo marcador + nada más: no adivinar
  if (hint && rest.length === 0) return null;

  return null;
};

/** `upperA`, `mayusA`, `Alower`, `A_minuscula` (ya partido), `lowera`. */
const guessGluedCase = (base: string): string | null => {
  const upperLead = base.match(/^(upper|uppercase|up|uc|cap|caps|capital|mayuscula|mayúscula|mayus|maiuscula|big)[_-]?([A-Za-zÀ-ÖØ-öø-ÿ])$/i);
  if (upperLead) return upperLead[2].toLocaleUpperCase('en-US');

  const lowerLead = base.match(/^(lower|lowercase|low|lc|small|tiny|minuscula|minúscula|minus|min)[_-]?([A-Za-zÀ-ÖØ-öø-ÿ])$/i);
  if (lowerLead) return lowerLead[2].toLocaleLowerCase('en-US');

  const upperTrail = base.match(/^([A-Za-zÀ-ÖØ-öø-ÿ])[_-]?(upper|uppercase|up|uc|cap|caps|capital|mayuscula|mayúscula|mayus|maiuscula|big)$/i);
  if (upperTrail) return upperTrail[1].toLocaleUpperCase('en-US');

  const lowerTrail = base.match(/^([A-Za-zÀ-ÖØ-öø-ÿ])[_-]?(lower|lowercase|low|lc|small|tiny|minuscula|minúscula|minus|min)$/i);
  if (lowerTrail) return lowerTrail[1].toLocaleLowerCase('en-US');

  return null;
};

/**
 * Intenta deducir el glifo desde el nombre del archivo.
 * Mayúsculas/minúsculas: en Windows no coexisten `A.png` y `a.png`;
 * usá `A_mayus.png` / `a_minus.png`, `upper_A` / `lower_A`, `char_65` / `char_97`, etc.
 */
export const guessGlyphChar = (fileName: string): string | null => {
  let base = stripCopySuffix(fileBaseName(fileName));
  if (!base) return null;

  // Prefijos de contenedor (no de casing)
  base = base.replace(/^(?:glyph|char|letter|digit|key|btn|btnkey)[_-]+/i, '');
  base = stripCopySuffix(base);
  if (!base) return null;

  // Casing pegado o con separador corto: priorizar antes que "minus"→guión
  const gluedCase = guessGluedCase(base);
  if (gluedCase !== null) return gluedCase;

  const parts = base.split(/[_\s.\-]+/).filter(Boolean);
  if (parts.length >= 2) {
    const fromCase = guessFromPartsWithCase(parts);
    if (fromCase !== null) return fromCase;
  }

  const direct = parseCodeToken(base) ?? parseNamedOrSingle(base);
  if (direct !== null) return direct;

  // Prefijo conocido sin separador: letterA, digit0
  const glued = base.match(/^(?:letter|digit|key|btn)(.+)$/i);
  if (glued) {
    const fromGlued = guessGluedCase(glued[1]) ?? parseNamedOrSingle(glued[1]);
    if (fromGlued !== null) return fromGlued;
  }

  // Si entre letras/dígitos ASCII hay exactamente uno, usarlo (`icon-A-16` ya cubierto por parts)
  const alnums = base.match(/[A-Za-z0-9]/g) ?? [];
  if (alnums.length === 1) return alnums[0];

  if (parts.length >= 2) {
    const first = parseNamedOrSingle(parts[0]);
    if (first !== null && first.length === 1 && !/[A-Za-z0-9]/.test(first)) return first;
  }

  return null;
};

/** Etiqueta corta para UI (espacio → "espacio", etc.). */
export const describeGlyphChar = (ch: string): string => {
  if (!ch) return '(vacío)';
  if (ch === ' ') return 'espacio';
  if (ch === '\t') return 'tab';
  if (ch === '\n') return '↵';
  const cp = ch.codePointAt(0);
  if (cp === undefined) return '(vacío)';
  if (ch.length === 1 && ch >= '!' && ch <= '~') return ch;
  return `${ch} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
};
