// Emits at most one warning per interval so a down backend stays visible without log floods.
export const DEFAULT_WARN_INTERVAL_MS = 60_000;

export function createThrottledWarn(
  warn: (message: string) => void,
  options: { intervalMs?: number; now?: () => number } = {},
): (message: string) => boolean {
  const intervalMs = options.intervalMs ?? DEFAULT_WARN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastWarnedAt: number | undefined;
  return (message) => {
    const current = now();
    if (lastWarnedAt !== undefined && current - lastWarnedAt < intervalMs) {
      return false;
    }
    lastWarnedAt = current;
    warn(message);
    return true;
  };
}
