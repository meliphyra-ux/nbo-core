// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Deploy progress reporting: optional, timed, secret-free sub-step
// messages. Callers (the control-plane runner) add the "[mm:ss]" prefix
// and the environment name; messages here carry only the step and its
// duration, e.g. "function ssr: image built in 34.1s".

export interface ProgressOptions {
  onProgress?: (message: string) => void;
  // now is injectable so tests are deterministic; defaults to Date.now.
  now?: () => number;
}

export interface Progress {
  // report emits one message (a no-op without an onProgress).
  report(message: string): void;
  // timed runs fn and reports "<done> in N.Ns" on success or
  // "<fail> failed after N.Ns" (then rethrows) on failure.
  timed<T>(done: string, fail: string, fn: () => Promise<T>): Promise<T>;
  // scope returns a Progress whose messages are prefixed "<prefix>: ".
  scope(prefix: string): Progress;
}

export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function createProgress(options?: ProgressOptions, prefix = ""): Progress {
  const now = options?.now ?? Date.now;
  const emit = options?.onProgress;
  const report = (message: string) => {
    if (!emit) return;
    try {
      emit(prefix ? `${prefix}: ${message}` : message);
    } catch {
      // A broken progress sink must never fail a deploy.
    }
  };
  return {
    report,
    async timed<T>(done: string, fail: string, fn: () => Promise<T>): Promise<T> {
      const start = now();
      try {
        const result = await fn();
        report(`${done} in ${formatSeconds(now() - start)}`);
        return result;
      } catch (err) {
        report(`${fail} failed after ${formatSeconds(now() - start)}`);
        throw err;
      }
    },
    scope: (p: string) => createProgress(options, prefix ? `${prefix}: ${p}` : p),
  };
}
