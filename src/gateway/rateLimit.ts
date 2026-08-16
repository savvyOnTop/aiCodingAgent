export interface RateLimiterOptions {
  /** Max requests per key inside the window. */
  max?: number;
  windowMs?: number;
}

export interface RateLimiter {
  /** True when the request identified by `key` is allowed. */
  allow(key: string): boolean;
  /** Test/cleanup hook. */
  reset(): void;
}

const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Fixed-window request counter per key (token or IP). Deliberately simple:
 * bounded memory (one counter per active key, windows garbage-collect on
 * touch) and no timers.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const max = options.max ?? DEFAULT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windows = new Map<string, { start: number; count: number }>();

  function allow(key: string): boolean {
    const now = Date.now();
    const window = windows.get(key);
    if (!window || now - window.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= max;
  }

  function reset(): void {
    windows.clear();
  }

  return { allow, reset };
}
