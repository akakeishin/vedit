/**
 * Map a collection with a bounded worker pool.
 *
 * `shouldContinue` is checked before claiming each new item, so callers can
 * cheaply supersede a large hydration run without cancelling the requests
 * that are already in flight. Results retain input order; unclaimed slots
 * remain undefined.
 */
export async function mapWithConcurrency(items, limit, worker, shouldContinue = () => true) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (shouldContinue()) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: count }, () => runWorker()));
  return results;
}
