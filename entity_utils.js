"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyEdits = applyEdits;
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
