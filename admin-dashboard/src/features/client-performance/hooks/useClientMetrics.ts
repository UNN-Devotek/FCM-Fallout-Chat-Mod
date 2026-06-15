import { useQuery } from '@tanstack/react-query';
import { api } from '../../../services/api';

export type MetricsWindow = '1h' | '24h' | '7d' | '30d';
export type MetricsSource = 'overlay' | 'monitor' | 'all';

export interface Percentiles {
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

export interface TimeBucket {
  tStart: string;
  workingSetMb: Percentiles;
  cpuPct: Percentiles;
  gifCacheMb: Percentiles;
  fps: Percentiles;
  sampleCount: number;
}

export interface Outlier {
  tokenPrefix: string;
  workingSetMb: number;
  cpuPct: number;
  gifCacheMb: number | null;
  fps: number | null;
  appVersion: string;
  sampledAt: string;
}

export interface ClientMetricsView {
  timeBuckets: TimeBucket[];
  outliers: Outlier[];
}

export function useClientMetrics(window: MetricsWindow, source: MetricsSource) {
  return useQuery<ClientMetricsView>({
    queryKey: ['client-metrics', window, source],
    queryFn: () => api.get<ClientMetricsView>(
      `/api/admin/client-metrics?window=${window}&source=${source}`,
    ),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}
