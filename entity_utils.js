"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyEdits = applyEdits;
exports.buildMentionPing = buildMentionPing;
exports.applyLinkReplacements = applyLinkReplacements;
function applyEdits(text, entities, edits, prefix = '') {
    const sorted = [...edits].sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const e of sorted) {
        if (e.start < pos)
            continue;
        out += text.slice(pos, e.start) + e.replacement;
        pos = e.end;
    }
    out += text.slice(pos);
    const prefixLen = prefix.length;
    const remapped = [];
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
        if (overlaps)
            continue;
        remapped.push({ ...ent, offset: ent.offset + delta + prefixLen });
    }
    return { text: prefix + out, entities: remapped };
}
function buildMentionPing(text, entities, opts = {}) {
    if (!entities?.length)
        return null;
    const max = opts.max ?? 5;
    const mentions = entities.filter(e => e.type === 'mention' || e.type === 'text_mention');
    if (mentions.length === 0)
        return null;
    let out = '🔔 Отметили: ';
    const outEntities = [];
    const seen = new Set();
    let count = 0;
    for (const m of mentions) {
        if (count >= max)
            break;
        const display = text.slice(m.offset, m.offset + m.length);
        if (!display)
            continue;
        const key = m.type === 'text_mention' && m.user ? `id:${m.user.id}` : `t:${display}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        if (count > 0)
            out += ', ';
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
    if (count === 0)
        return null;
    out += '\n\n';
    return { text: out, entities: outEntities };
}
function applyLinkReplacements(text, entities, replacements, prefix = '') {
    const edits = [];
    let cursor = 0;
    for (const r of replacements) {
        if (!r.original)
            continue;
        const idx = text.indexOf(r.original, cursor);
        if (idx === -1)
            continue;
        edits.push({
            start: idx,
            end: idx + r.original.length,
            replacement: r.replacement,
        });
        cursor = idx + r.original.length;
    }
    return applyEdits(text, entities ?? [], edits, prefix);
}
