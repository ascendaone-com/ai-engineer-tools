import { DurationBucket, LinesChangedBucket } from "@ascenda-one/tool-contract";

export function bucketLinesChanged(count: number): LinesChangedBucket {
  if (count <= 0) return "0"; if (count <= 10) return "1-10"; if (count <= 50) return "10-50"; if (count <= 200) return "50-200"; return "200+";
}

export function bucketDurationMs(durationMs: number | undefined): DurationBucket | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const minutes = durationMs / 60000;
  if (minutes <= 1) return "0-1m";
  if (minutes <= 5) return "1-5m";
  if (minutes <= 10) return "5-10m";
  if (minutes <= 30) return "10-30m";
  if (minutes <= 60) return "30-60m";
  return "60m+";
}
