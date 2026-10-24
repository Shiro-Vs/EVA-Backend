/** Reintenta fallos pasajeros del proveedor (red, 500/502/503/504) con espera creciente. Un 429 o un error 4xx no se reintenta. */
export async function fetchRetry(
  f: typeof fetch, url: string, init: RequestInit & { timeoutMs?: number },
  o: { retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const retries = o.retries ?? 2;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const { timeoutMs, ...rest } = init;
      const res = await f(url, { ...rest, signal: AbortSignal.timeout(timeoutMs ?? 45_000) });
      if (![500, 502, 503, 504].includes(res.status) || attempt === retries) return res;
      last = res;
    } catch (e) {
      last = e;
      if (attempt === retries) throw e;
    }
  }
  throw last;
}
