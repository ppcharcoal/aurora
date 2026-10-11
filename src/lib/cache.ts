// Memoises API results for the session so moving between views is instant
// and doesn't burn API quota. `refresh` forces a reload.
const memo = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
  if (refresh || !memo.has(key)) {
    const p = load().catch((e) => {
      memo.delete(key);
      throw e;
    });
    memo.set(key, p);
  }
  return memo.get(key) as Promise<T>;
}

export function invalidate(prefix: string) {
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
}
