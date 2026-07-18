import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrencyLogic.js';

describe('mapWithConcurrency', () => {
  it('preserves input order while respecting the concurrency ceiling', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 10;
    });
    expect(result).toEqual([40, 30, 20, 10]);
    expect(peak).toBe(2);
  });

  it('stops claiming new work once the caller is superseded', async () => {
    let current = true;
    const visited = [];
    const result = await mapWithConcurrency([1, 2, 3], 1, async (value) => {
      visited.push(value);
      current = false;
      return value;
    }, () => current);
    expect(visited).toEqual([1]);
    expect(result).toEqual([1, undefined, undefined]);
  });

  it('handles an empty collection without starting a worker', async () => {
    let called = false;
    const result = await mapWithConcurrency([], 8, async () => { called = true; });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});
