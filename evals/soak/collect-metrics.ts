/**
 * Thin Prometheus query client. Only GET /api/v1/query is used — soak
 * reports don't need range queries; instant snapshots at report-time are
 * enough to flag SLO breaches.
 */
export type PromResult = { value: number | null; raw: unknown };

export async function queryPrometheus(baseUrl: string, query: string): Promise<PromResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { value: null, raw: `http ${res.status}` };
    const json = (await res.json()) as {
      data?: { result?: Array<{ value?: [number, string] }> };
    };
    const result = json?.data?.result?.[0];
    const v = result?.value?.[1];
    const value = v !== undefined ? Number(v) : null;
    return { value: Number.isFinite(value ?? NaN) ? value : null, raw: json };
  } catch (err) {
    return { value: null, raw: (err as Error).message };
  }
}
