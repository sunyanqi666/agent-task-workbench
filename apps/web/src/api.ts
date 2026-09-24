import type { HealthInfo } from 'contracts';

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/api/v1/health');
  if (!res.ok) {
    throw new Error(`/api/v1/health -> ${res.status}`);
  }
  return (await res.json()) as HealthInfo;
}
