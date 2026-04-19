import { HealthResponse, HealthResponseSchema } from '@qufox/shared-types';

const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '/api';

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/healthz`);
  if (!res.ok) throw new Error(`healthz ${res.status}`);
  const json = (await res.json()) as unknown;
  return HealthResponseSchema.parse(json);
}
