// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// mapLimit runs fn over items with at most `limit` calls in flight and
// resolves with the results in input order. On the first failure it
// starts no further items, waits for every call already in flight to
// settle (so nothing is left running, and no rejection goes
// unhandled), then rejects with that first error — the same "stop at
// the first failure" outcome a sequential loop has, minus the waiting.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
