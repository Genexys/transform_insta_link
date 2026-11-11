// Collapses repeated admin alerts. During an outage the same alert used to be
// sent once per affected link; now the first one goes out, repeats within the
// window are counted, and the next delivery reports how many were suppressed.
// Pure (time is injected) so it can be unit-tested.

export const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_ALERTS = 200;

type AlertState = { lastSentAt: number; suppressed: number };

// Alerts are the same "kind" when their first line matches; later lines carry
// the varying detail (the URL, the error text).
export function alertKey(message: string): string {
  return message.split('\n', 1)[0].trim();
}

export function createAlertDeduper(windowMs: number = ALERT_DEDUPE_WINDOW_MS) {
  const state = new Map<string, AlertState>();

  // Returns the text to send, or null when this alert should be swallowed.
  return function nextAlert(
    message: string,
    now: number = Date.now()
  ): string | null {
    const key = alertKey(message);
    const prev = state.get(key);

    if (prev && now - prev.lastSentAt < windowMs) {
      prev.suppressed += 1;
      return null;
    }

    if (state.size >= MAX_TRACKED_ALERTS && !prev) {
      for (const [k, v] of state) {
        if (now - v.lastSentAt >= windowMs) state.delete(k);
      }
      if (state.size >= MAX_TRACKED_ALERTS) state.clear();
    }

    const suppressed = prev?.suppressed ?? 0;
    state.set(key, { lastSentAt: now, suppressed: 0 });
    return suppressed > 0
      ? `${message}\n\n(+${suppressed} таких же за последнее время)`
      : message;
  };
}
