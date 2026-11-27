/** One polite JSON GET with a timeout and a few retries. Never scrapes HTML. */
export async function getJson<T>(url: string, retries = 3): Promise<{ data: T; text: string }> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'fefl-graphing-collector (personal project)', accept: 'application/json' }, signal: AbortSignal.timeout(45_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      return { data: JSON.parse(text) as T, text };
    } catch (e) {
      if (i >= retries) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((res) => setTimeout(res, 1500 * 2 ** i));
    }
  }
}
