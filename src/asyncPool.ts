/**
 * Maps `items` with at most `concurrency` concurrent `mapper` invocations; result order matches `items`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = index++;
      if (i >= items.length) {
        return;
      }
      results[i] = await mapper(items[i]);
    }
  };
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
