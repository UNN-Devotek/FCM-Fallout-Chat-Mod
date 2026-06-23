import { useQuery } from '@tanstack/react-query';
import { api } from '../../../services/api';
import type { StatsRange } from '../components/CrtRangeSelector';

export type { StatsRange };

export interface BucketCount {
  bucket: string;
  count: number;
}

export interface ChannelMessageCount {
  channelId: string;
  channelName: string;
  count: number;
}

export interface SourceSplit {
  game: number;
  discord: number;
}

export interface DownloadCount {
  version: string;
  count: number;
}

export interface ModerationActivity {
  bucket: string;
  bans: number;
  reports: number;
  auditActions: number;
}

export interface ActivityPoint {
  bucket: string;
  messages: number;
  activeUsers: number;
}

export interface CommunityStats {
  range: StatsRange;
  bucketSize: 'hour' | 'day';
  signupsPerBucket: BucketCount[];
  dauPerBucket: BucketCount[];
  messagesPerBucket: BucketCount[];
  activityOverTime: ActivityPoint[];
  messagesPerChannel: ChannelMessageCount[];
  messageSplit: SourceSplit;
  // versionDistribution removed — its data source (app_version telemetry) was
  // deleted in #117; the backend no longer returns it. See ServerHealth.tsx.
  downloadsPerVersion: DownloadCount[];
  moderationPerBucket: ModerationActivity[];
}

export function useCommunityStats(range: StatsRange) {
  return useQuery<CommunityStats>({
    queryKey: ['community-stats', range],
    queryFn: () =>
      api.get<CommunityStats>(`/api/admin/community-stats?range=${encodeURIComponent(range)}`),
    staleTime: 2 * 60 * 1000,    // 2 min — stats don't need real-time freshness
    refetchInterval: 5 * 60 * 1000,
  });
}
