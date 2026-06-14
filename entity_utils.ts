// Pure helpers for preserving Telegram message entities (mentions, especially
// `text_mention` for users without a @username, plus bold/italic/spoiler/etc.)
// when the bot rewrites a message: it prepends a prefix and swaps the original
// social links for fixer URLs, both of which shift entity offsets.
//
// Telegram entity offsets are counted in UTF-16 code units — the same unit as
// JavaScript string indices and `.length` — so plain string slicing keeps them
// aligned (do NOT use spread/`[...str]`, which counts code points).

export interface TextEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: unknown;
  language?: string;
  custom_emoji_id?: string;
}

export interface SpanEdit {
  start: number;
  end: number;
  replacement: string;
}

export interface LinkReplacement {
  original: string;
  replacement: string;
}

export interface RemapResult {
  text: string;
  entities: TextEntity[];
}

// Apply a set of absolute span edits to `text`, optionally prepend `prefix`, and
// remap each entity to its new position. Entities whose span overlaps any edited
// region are dropped (their underlying text changed — e.g. a link entity over a
// URL we just replaced); all others are shifted by the net length change of the
// edits that precede them, plus the prefix length.
export function applyEdits(
  text: string,
  entities: TextEntity[],
  edits: SpanEdit[],
  prefix = ''
): RemapResult {
  const sorted = [...edits].sort((a, b) => a.start - b.start);

  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) continue; // defensively skip overlapping/invalid edits
    out += text.slice(pos, e.start) + e.replacement;
    pos = e.end;
  }
  out += text.slice(pos);

  const prefixLen = prefix.length;
  const remapped: TextEntity[] = [];
  for (const ent of entities) {
    const entStart = ent.offset;
    const entEnd = ent.offset + ent.length;
    let overlaps = false;
    let delta = 0;
    for (const e of sorted) {
      if (entStart < e.end && entEnd > e.start) {
        overlaps = true;
        break;
      }
      if (e.end <= entStart) {
        delta += e.replacement.length - (e.end - e.start);
      }
    }
    if (overlaps) continue;
    remapped.push({ ...ent, offset: ent.offset + delta + prefixLen });
  }

  return { text: prefix + out, entities: remapped };
}

// Convenience wrapper: locate each `original` link in `text` (left to right) and
// replace it with its fixer URL, preserving entities. Links not found verbatim
// are skipped — mirroring the original `String.replace` behaviour.
export function applyLinkReplacements(
  text: string,
  entities: TextEntity[] | undefined,
  replacements: LinkReplacement[],
  prefix = ''
): RemapResult {
  const edits: SpanEdit[] = [];
  let cursor = 0;
  for (const r of replacements) {
    if (!r.original) continue;
    const idx = text.indexOf(r.original, cursor);
    if (idx === -1) continue;
    edits.push({
      start: idx,
      end: idx + r.original.length,
      replacement: r.replacement,
    });
    cursor = idx + r.original.length;
  }
  return applyEdits(text, entities ?? [], edits, prefix);
}
