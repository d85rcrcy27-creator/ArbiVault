export type TemporalFluxPoint = {
  value: unknown;
  observed_at: string | number | Date;
  metadata?: Record<string, unknown> | null;
};

export type TemporalFluxRoute = {
  buyExchange?: string | null;
  sellExchange?: string | null;
  buy_exchange?: string | null;
  sell_exchange?: string | null;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function routeKey(metadata?: Record<string, unknown> | TemporalFluxRoute | null): string | null {
  const buy = String(metadata?.buy_exchange ?? metadata?.buyExchange ?? "").trim().toLowerCase();
  const sell = String(metadata?.sell_exchange ?? metadata?.sellExchange ?? "").trim().toLowerCase();
  return buy && sell ? `${buy}->${sell}` : null;
}

function timestampMs(value: string | number | Date): number | null {
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
    : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Descriptive temporal analysis only. This is not a profit guarantee and must
 * never replace fresh executable quotes, gas/fee accounting, or execution gates.
 */
export function analyzeTemporalFlux(
  rawPoints: TemporalFluxPoint[],
  currentRoute?: TemporalFluxRoute | null,
  nowMs = Date.now(),
) {
  const points = rawPoints
    .map((point) => ({
      value: finiteNumber(point.value),
      t: timestampMs(point.observed_at),
      metadata: point.metadata ?? {},
    }))
    .filter((point): point is { value: number; t: number; metadata: Record<string, unknown> } =>
      point.value !== null && point.t !== null && nowMs - point.t >= -5_000 && nowMs - point.t <= 15 * 60_000
    )
    .sort((a, b) => a.t - b.t)
    .slice(-120);

  const latest = points[points.length - 1] ?? null;
  const feedLatencies = points.map((point) => finiteNumber(point.metadata?.latency_ms)).filter((value): value is number => value !== null && value >= 0).sort((a, b) => a - b);
  const medianFeedLatencyMs = feedLatencies.length ? feedLatencies[Math.floor((feedLatencies.length - 1) / 2)] : null;
  const latestFeedLatencyMs = latest ? finiteNumber(latest.metadata?.latency_ms) : null;
  const latestAgeMs = latest ? Math.max(0, nowMs - latest.t) : null;
  const sampleCount = points.length;
  const spanSeconds = sampleCount > 1 ? Math.round((points[sampleCount - 1].t - points[0].t) / 1000) : 0;
  const mean = sampleCount ? points.reduce((sum, point) => sum + point.value, 0) / sampleCount : null;
  const variance = sampleCount && mean !== null
    ? points.reduce((sum, point) => sum + (point.value - mean) ** 2, 0) / sampleCount
    : null;
  const stddev = variance === null ? null : Math.sqrt(variance);
  const positiveRatio = sampleCount
    ? points.filter((point) => point.value > 0).length / sampleCount
    : null;

  const observedRouteKeys = points.map((point) => routeKey(point.metadata)).filter((key): key is string => Boolean(key));
  const routeRotationCount = observedRouteKeys.slice(1).filter((key, index) => key !== observedRouteKeys[index]).length;
  const desiredRouteKey = routeKey(currentRoute)
    ?? routeKey(latest?.metadata);
  const matchingRoutePoints = desiredRouteKey
    ? points.filter((point) => routeKey(point.metadata) === desiredRouteKey)
    : [];
  const routePersistenceRatio = matchingRoutePoints.length
    ? matchingRoutePoints.filter((point) => point.value > 0).length / matchingRoutePoints.length
    : null;

  // Linear regression over minutes from the first sample yields percentage points/minute.
  const origin = points[0]?.t ?? nowMs;
  const xs = points.map((point) => (point.t - origin) / 60_000);
  const ys = points.map((point) => point.value);
  const xMean = xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : 0;
  const yMean = ys.length ? ys.reduce((sum, value) => sum + value, 0) / ys.length : 0;
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  const slope = sampleCount >= 2 && denominator > 0
    ? xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0) / denominator
    : null;
  const currentSpread = latest?.value ?? null;
  const decayToZeroSeconds = currentSpread !== null && currentSpread > 0 && slope !== null && slope < 0
    ? Math.round((currentSpread / Math.abs(slope)) * 60)
    : null;
  const confidence = sampleCount >= 12 && spanSeconds >= 120 ? "high"
    : sampleCount >= 5 && spanSeconds >= 30 ? "medium"
    : "insufficient";
  const stale = latestAgeMs === null || latestAgeMs > 60_000;
  const freshnessFactor = latestAgeMs === null ? 0 : latestAgeMs <= 15_000 ? 1 : latestAgeMs <= 60_000 ? 0.5 : 0;
  const persistenceFactor = routePersistenceRatio ?? positiveRatio ?? 0;
  const trendFactor = slope === null ? 0.5 : slope < -0.005 ? 0.15 : slope > 0.005 ? 1 : 0.65;
  const priorityScore = confidence === "insufficient" || stale
    ? 0
    : Math.round(100 * (0.35 * persistenceFactor + 0.25 * (positiveRatio ?? 0) + 0.20 * freshnessFactor + 0.20 * trendFactor));
  const status = sampleCount < 5 ? "insufficient_history"
    : stale ? "stale_history"
    : slope !== null && slope < -0.005 ? "decaying"
    : slope !== null && slope > 0.005 ? "expanding"
    : "range_bound";

  return {
    model: "temporal_flux_rotation_v1",
    status,
    confidence,
    sample_count: sampleCount,
    history_span_seconds: spanSeconds,
    current_spread_pct: currentSpread,
    mean_spread_pct: mean === null ? null : Number(mean.toFixed(6)),
    spread_volatility_pct_points: stddev === null ? null : Number(stddev.toFixed(6)),
    positive_spread_ratio: positiveRatio === null ? null : Number(positiveRatio.toFixed(4)),
    slope_pct_points_per_min: slope === null ? null : Number(slope.toFixed(6)),
    estimated_decay_to_zero_seconds: decayToZeroSeconds,
    route_rotation_count: routeRotationCount,
    current_route_key: desiredRouteKey,
    current_route_sample_count: matchingRoutePoints.length,
    current_route_persistence_ratio: routePersistenceRatio === null ? null : Number(routePersistenceRatio.toFixed(4)),
    latest_observation_age_ms: latestAgeMs,
    median_feed_latency_ms: medianFeedLatencyMs,
    latest_feed_latency_ms: latestFeedLatencyMs,
    priority_score: priorityScore,
    timestamp_quality: "collector_observed_at; exchange-native timestamps not available in this feed",
    execution_authorization: "not_an_authorization; live quote and net-profit checks remain mandatory",
  };
}
