// Pure helpers for preserving Telegram message entities (mentions, especially
// `text_mention` for users without a @username, plus bold/italic/spoiler/etc.)
// when the bot rewrites a message: it prepends a prefix and swaps the original
// social links for fixer URLs, both of which shift entity offsets.
//
// Telegram entity offsets are counted in UTF-16 code units — the same unit as
// JavaScript string indices and `.length` — so plain string slicing keeps them
// aligned (do NOT use spread/`[...str]`, which counts code points).

import type { User } from 'node-telegram-bot-api';

// Structurally a Bot API MessageEntity. `user` is typed from the lib (a
// type-only import, so this module stays runtime-dependency-free) purely so
// entities we remap here stay assignable to the send/edit params — nothing
// below reads the field.
export interface TextEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: User;
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

// Surface the people mentioned in the original message as a short, prominent
// header line ("🔔 Отметили: @bob, Jane"), so a ping buried mid-message
// ("эй @bob глянь <link>") stays obvious after the bot deletes the original and
// reposts its rewrite. Returns the header text plus the entities needed to keep
// `text_mention` pings alive — those target users have no @username, so the ping
// only works through the entity, and its offset must point into the header.
// Plain `@username` mentions ride as text (Telegram auto-links and pings them),
// so they need no entity. Dedupes (by user id for text_mentions, by the visible
// @handle otherwise) and caps the list so a message spamming mentions can't
// blow up the header. Returns null when there is nothing to surface.
export function buildMentionPing(
  text: string,
  entities: TextEntity[] | undefined,
  opts: { max?: number } = {}
): RemapResult | null {
  if (!entities?.length) return null;
  const max = opts.max ?? 5;
  const mentions = entities.filter(
    e => e.type === 'mention' || e.type === 'text_mention'
  );
  if (mentions.length === 0) return null;

  let out = '🔔 Отметили: ';
  const outEntities: TextEntity[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const m of mentions) {
    if (count >= max) break;
    const display = text.slice(m.offset, m.offset + m.length);
    if (!display) continue;
    const key =
      m.type === 'text_mention' && m.user ? `id:${m.user.id}` : `t:${display}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (count > 0) out += ', ';
    const start = out.length;
    out += display;
    if (m.type === 'text_mention' && m.user) {
      outEntities.push({
        type: 'text_mention',
        offset: start,
        length: display.length,
        user: m.user,
      });
    }
    count += 1;
  }
  if (count === 0) return null;
  out += '\n\n';
  return { text: out, entities: outEntities };
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
