const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_HTML_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

const COMMON_NAMED_CHARACTER_REFERENCES: Readonly<Record<string, string>> = Object.freeze({
  NewLine: "\n",
  Tab: "\t",
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
});

interface HtmlTag {
  closing: boolean;
  end: number;
  name: string;
  secret: boolean;
  start: number;
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}

function normalizedNumericReference(value: string, radix: 10 | 16): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isFinite(codePoint) ||
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
}

function decodeClassCharacterReferences(value: string): string {
  return value.replace(
    /&(?:#[xX]([0-9A-Fa-f]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]+);)/g,
    (reference, hexadecimal: string | undefined, decimal: string | undefined, named: string) => {
      if (hexadecimal !== undefined) return normalizedNumericReference(hexadecimal, 16);
      if (decimal !== undefined) return normalizedNumericReference(decimal, 10);
      return COMMON_NAMED_CHARACTER_REFERENCES[named] ?? reference;
    },
  );
}

function hasSecretHtmlClass(attributes: string): boolean {
  let cursor = 0;
  while (cursor < attributes.length) {
    while (isHtmlWhitespace(attributes[cursor]) || attributes[cursor] === "/") cursor += 1;
    const nameStart = cursor;
    while (
      cursor < attributes.length &&
      !isHtmlWhitespace(attributes[cursor]) &&
      attributes[cursor] !== "=" &&
      attributes[cursor] !== "/"
    ) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = attributes.slice(nameStart, cursor).toLowerCase();
    while (isHtmlWhitespace(attributes[cursor])) cursor += 1;
    if (attributes[cursor] !== "=") continue;
    cursor += 1;
    while (isHtmlWhitespace(attributes[cursor])) cursor += 1;

    let attributeValue: string;
    const quote = attributes[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1;
      attributeValue = attributes.slice(valueStart, cursor);
      if (cursor < attributes.length) cursor += 1;
    } else {
      const valueStart = cursor;
      while (cursor < attributes.length && !isHtmlWhitespace(attributes[cursor])) cursor += 1;
      attributeValue = attributes.slice(valueStart, cursor);
    }

    if (
      name === "class" &&
      decodeClassCharacterReferences(attributeValue)
        .split(/[\t\n\f\r ]+/)
        .some((className) => className.toLowerCase() === "secret")
    ) {
      return true;
    }
  }
  return false;
}

function tagEnd(value: string, start: number): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor + 1;
    }
  }
  return undefined;
}

function readHtmlTag(value: string, start: number): HtmlTag | undefined {
  let cursor = start + 1;
  while (isHtmlWhitespace(value[cursor])) cursor += 1;
  const closing = value[cursor] === "/";
  if (closing) {
    cursor += 1;
    while (isHtmlWhitespace(value[cursor])) cursor += 1;
  }
  const nameStart = cursor;
  if (!/[A-Za-z]/.test(value[cursor] ?? "")) return undefined;
  cursor += 1;
  while (cursor < value.length && /[A-Za-z0-9:-]/.test(value[cursor] ?? "")) cursor += 1;
  const name = value.slice(nameStart, cursor).toLowerCase();
  if (!isHtmlWhitespace(value[cursor]) && value[cursor] !== "/" && value[cursor] !== ">") {
    return undefined;
  }
  const end = tagEnd(value, cursor);
  if (end === undefined) return undefined;
  const attributes = value.slice(cursor, end - 1);
  return {
    closing,
    end,
    name,
    secret: !closing && hasSecretHtmlClass(attributes),
    start,
  };
}

function nextHtmlTag(value: string, from: number): HtmlTag | undefined {
  let cursor = from;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) return undefined;
    if (value.startsWith("<!--", start)) {
      const end = value.indexOf("-->", start + 4);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    if (value.startsWith("<!", start) || value.startsWith("<?", start)) {
      const end = tagEnd(value, start + 2);
      if (end === undefined) return undefined;
      cursor = end;
      continue;
    }
    const tag = readHtmlTag(value, start);
    if (tag) return tag;
    cursor = start + 1;
  }
  return undefined;
}

function rawTextClosingTag(value: string, from: number, name: string): HtmlTag | undefined {
  let cursor = from;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) return undefined;
    const tag = readHtmlTag(value, start);
    if (tag?.closing && tag.name === name) return tag;
    cursor = start + 1;
  }
  return undefined;
}

function* htmlTags(value: string): Generator<HtmlTag> {
  let cursor = 0;
  while (cursor < value.length) {
    const tag = nextHtmlTag(value, cursor);
    if (!tag) return;
    yield tag;
    cursor = tag.end;
    if (!tag.closing && RAW_TEXT_HTML_ELEMENTS.has(tag.name)) {
      if (tag.name === "plaintext") return;
      const closing = rawTextClosingTag(value, cursor, tag.name);
      if (!closing) return;
      yield closing;
      cursor = closing.end;
    }
  }
}

/**
 * Removes HTML elements whose class list contains `secret`. Foundry emits
 * native GM-only content as `<section class="secret">`; the tokenizer also
 * preserves the host's legacy protection for other element names.
 */
export function redactFoundrySecretHtml(value: string, replacement = ""): string {
  const tags = htmlTags(value);
  let copyFrom = 0;
  let output = "";

  for (let next = tags.next(); !next.done; next = tags.next()) {
    const opening = next.value;
    if (opening.closing || !opening.secret) continue;
    output += value.slice(copyFrom, opening.start) + replacement;
    if (VOID_HTML_ELEMENTS.has(opening.name)) {
      copyFrom = opening.end;
      continue;
    }

    let depth = 1;
    let end = value.length;
    for (let nested = tags.next(); !nested.done; nested = tags.next()) {
      const tag = nested.value;
      if (tag.name !== opening.name) continue;
      if (tag.closing) depth -= 1;
      else if (!VOID_HTML_ELEMENTS.has(tag.name)) depth += 1;
      if (depth === 0) {
        end = tag.end;
        break;
      }
    }
    copyFrom = end;
  }

  return copyFrom === 0 ? value : output + value.slice(copyFrom);
}
