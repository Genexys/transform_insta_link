"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALERT_DEDUPE_WINDOW_MS = void 0;
exports.alertKey = alertKey;
exports.createAlertDeduper = createAlertDeduper;
exports.ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_ALERTS = 200;
function alertKey(message) {
    return message.split('\n', 1)[0].trim();
}
function createAlertDeduper(windowMs = exports.ALERT_DEDUPE_WINDOW_MS) {
    const state = new Map();
    return function nextAlert(message, now = Date.now()) {
        const key = alertKey(message);
        const prev = state.get(key);
        if (prev && now - prev.lastSentAt < windowMs) {
            prev.suppressed += 1;
            return null;
        }
        if (state.size >= MAX_TRACKED_ALERTS && !prev) {
            for (const [k, v] of state) {
                if (now - v.lastSentAt >= windowMs)
                    state.delete(k);
            }
            if (state.size >= MAX_TRACKED_ALERTS)
                state.clear();
        }
        const suppressed = prev?.suppressed ?? 0;
        state.set(key, { lastSentAt: now, suppressed: 0 });
        return suppressed > 0
            ? `${message}\n\n(+${suppressed} таких же за последнее время)`
            : message;
    };
}
