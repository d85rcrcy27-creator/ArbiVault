import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(
  supabaseUrl,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { ...corsHeaders, "cache-control": "no-store" } });

// Repeated polling observations are not independent trades. Count one entry for
// a signal per symbol + buy/sell venue route, until it fails or the route has
// gone unobserved for more than 60 seconds.
function distinctSignalEntries(
  samples: any[],
  predicate: (sample: any) => boolean,
  rearmGapMs = 60_000,
) {
  const state = new Map<string, { qualifies: boolean; at: number }>();
  const entries: any[] = [];
  for (const sample of samples) {
    const key = String(sample.routeKey || sample.symbol || "unknown");
    const at = new Date(sample.observed_at).getTime();
    const qualifies = predicate(sample);
    const previous = state.get(key);
    const gapMs = previous && Number.isFinite(at) && Number.isFinite(previous.at)
      ? at - previous.at
      : Infinity;
    if (qualifies && (!previous || !previous.qualifies || gapMs > rearmGapMs)) {
      entries.push(sample);
    }
    state.set(key, { qualifies, at });
  }
  return entries;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authorization = req.headers.get("Authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return json({ error: "authentication_required" }, 401);
    }
    const caller = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: "authentication_required" }, 401);

    const body = await req.json().catch(() => ({}));
    const skillId = String(body.skill_id || "");
    const requestedThreshold = Number(body.threshold);
    const days = Math.min(730, Math.max(1, Number(body.days ?? 730)));

    if (Number.isFinite(requestedThreshold) && requestedThreshold < 0) {
      return json({ error: "invalid_threshold" }, 400);
    }

    let skill: any = null;
    if (skillId) {
      const { data, error } = await admin
        .from("bot_skills")
        .select("id,owner_id,name,conditions,risk_limits,observation_only,discovery_enabled,strategy_bot_id")
        .eq("id", skillId)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "skill_not_found" }, 404);
      if (data.owner_id !== user.id) return json({ error: "skill_owner_mismatch" }, 403);
      skill = data;
    }

    // Latency/volume skills must backtest recorded observations from the actual
    // public market scout. They must not be forced through the unrelated daily-close
    // spread-training dataset, and this path never starts execution.
    const skillConditions = Array.isArray(skill?.conditions)
      ? skill.conditions
      : (skill?.conditions && typeof skill.conditions === "object" ? [skill.conditions] : []);
    const hasLatencyOrVolumeCondition = skillId && skillConditions.some((condition: any) =>
      /latency|volume/i.test(String(condition?.label || ""))
    );

    if (hasLatencyOrVolumeCondition) {
      const endAt = new Date();
      const startAt = new Date(endAt.getTime() - days * 86400000);
      const liveSampleLimit = 10000;
      const queryPageSize = 1000;
      const { data: sampledLiveRows, error: liveRowsError } = await admin.rpc(
        "sample_arbivault_market_observations",
        {
          p_owner_id: skill.owner_id,
          p_source_key: "public_exchange_order_books",
          p_domain: "execution_scout",
          p_metric: "spread_pct",
          p_symbols: null,
          p_start_at: startAt.toISOString(),
          p_end_at: endAt.toISOString(),
          p_sample_limit: liveSampleLimit,
        },
      );
      if (liveRowsError) return json({ error: "live_observation_lookup_failed", detail: liveRowsError.message }, 500);

      // This SQL sampler spreads the cap across the full time window, instead of
      // treating the newest 10,000 polls as a trading history.
      const liveRows: any[] = sampledLiveRows || [];
      const liveRowsCount = Number(liveRows[0]?.available_count ?? liveRows.length);
      const chronologicallyOrderedLiveRows = liveRows.slice().sort(
        (a: any, b: any) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime()
      );
      const bases = [...new Set(chronologicallyOrderedLiveRows.map((row: any) => String(row.symbol || "").split("/")[0]).filter(Boolean))];
      const volumeSymbols = bases.map((symbol) => symbol + "/USD");
      const volumeRows: any[] = [];
      if (volumeSymbols.length) {
        const { data: sampledVolumeRows, error: volumeRowsError } = await admin.rpc(
          "sample_arbivault_market_observations",
          {
            p_owner_id: skill.owner_id,
            p_source_key: "coingecko",
            p_domain: null,
            p_metric: "public_market_price",
            p_symbols: volumeSymbols,
            p_start_at: startAt.toISOString(),
            p_end_at: endAt.toISOString(),
            p_sample_limit: liveSampleLimit,
          },
        );
        if (volumeRowsError) return json({ error: "live_volume_lookup_failed", detail: volumeRowsError.message }, 500);
        volumeRows.push(...(sampledVolumeRows || []));
      }

      const volumeHistory = new Map<string, any[]>();
      const chronologicallyOrderedVolumeRows = volumeRows.slice().sort(
        (a: any, b: any) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime()
      );
      for (const row of chronologicallyOrderedVolumeRows) {
        const key = String(row.symbol || "").toUpperCase();
        const list = volumeHistory.get(key) || [];
        const volume = Number(row.metadata?.volume24h);
        if (Number.isFinite(volume) && volume >= 0) list.push({
          at: new Date(row.observed_at).getTime(),
          volume24hUsd: volume,
        });
        volumeHistory.set(key, list);
      }

      const nearestVolume = (symbol: string, observedAt: string) => {
        const list = volumeHistory.get((symbol.split("/")[0] + "/USD").toUpperCase()) || [];
        if (!list.length) return null;
        const target = new Date(observedAt).getTime();
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].at < target) lo = mid + 1;
          else hi = mid;
        }
        const candidates = [list[lo - 1], list[lo]].filter(Boolean);
        if (!candidates.length) return null;
        const chosen = candidates.reduce((best, item) =>
          Math.abs(item.at - target) < Math.abs(best.at - target) ? item : best
        );
        return Math.abs(chosen.at - target) <= 10 * 60 * 1000 ? chosen.volume24hUsd : null;
      };

      const notional = Number(body.notional ?? skill?.risk_limits?.maxNotional ?? skill?.risk_limits?.max_trade_size ?? 1000);
      // CEX quote observations require a venue-fee model, not a made-up gas fee.
      // Default to 0.10% taker fee per venue (0.20% round trip) plus 0.05%
      // slippage reserve. These are assumptions, not measured user fees or fills.
      const feePct = body.round_trip_fee_pct == null ? 0.20 : Number(body.round_trip_fee_pct);
      const slippagePct = body.slippage_pct == null ? 0.05 : Number(body.slippage_pct);
      const costPct = feePct + slippagePct;
      const minSpreadPct = body.min_spread_pct == null ? 0.30 : Number(body.min_spread_pct);
      const profitCondition = skillConditions.find((condition: any) =>
        /profit/i.test(String(condition?.label || "")) &&
        !["%", "bps", "ms", "x"].includes(String(condition?.unit || "").toLowerCase())
      );
      const configuredProfitFloor = profitCondition
        ? Number.parseFloat(String(profitCondition.value ?? ""))
        : (skill?.risk_limits?.min_profit_threshold == null ? 2 : Number(skill.risk_limits.min_profit_threshold));
      const minimumPotentialNetProfitUsd = body.min_net_profit_usd == null
        ? (Number.isFinite(configuredProfitFloor) && configuredProfitFloor >= 0 ? configuredProfitFloor : 2)
        : Number(body.min_net_profit_usd);
      if (![notional, feePct, slippagePct, costPct, minSpreadPct, minimumPotentialNetProfitUsd].every(Number.isFinite) ||
          notional <= 0 || feePct < 0 || slippagePct < 0 || costPct >= 100 ||
          minSpreadPct < 0 || minimumPotentialNetProfitUsd < 0) {
        return json({ error: "invalid_cost_assumptions_or_notional" }, 400);
      }
      const builtSamples = chronologicallyOrderedLiveRows.map((row: any) => {
        const metadata = row.metadata || {};
        const quotes = Array.isArray(metadata.quotes) ? metadata.quotes : [];
        const buyExchange = String(metadata.buy_exchange || "");
        const sellExchange = String(metadata.sell_exchange || "");
        const buyQuote = quotes.find((quote: any) => String(quote.exchange || "").toLowerCase() === buyExchange.toLowerCase());
        const sellQuote = quotes.find((quote: any) => String(quote.exchange || "").toLowerCase() === sellExchange.toLowerCase());
        const quoteLatencies = [buyQuote?.latencyMs, sellQuote?.latencyMs]
          .map(Number)
          .filter((value: number) => Number.isFinite(value) && value >= 0);
        const latencyMs = quoteLatencies.length === 2 ? Math.max(...quoteLatencies) : null;
        const spreadPct = Number(row.value);
        const volume24hUsd = nearestVolume(String(row.symbol || ""), row.observed_at);
        const estimatedNetProfitUsd = notional * (spreadPct - costPct) / 100;
        const buyVenue = String(metadata.buy_exchange ?? metadata.buyExchange ?? "");
        const sellVenue = String(metadata.sell_exchange ?? metadata.sellExchange ?? "");
        return {
          id: row.id,
          symbol: row.symbol,
          routeKey: `${String(row.symbol || "")}|${buyVenue}|${sellVenue}`,
          observed_at: row.observed_at,
          spreadPct,
          latencyMs,
          volume24hUsd,
          estimatedGrossProfitUsd: notional * spreadPct / 100,
          estimatedNetProfitUsd,
        };
      }).filter((sample: any) => Number.isFinite(sample.spreadPct));

      if (!builtSamples.length) {
        return json({
          ok: false, supported: false, reason: "no_recorded_live_market_observations",
          skill_id: skillId, strategy: skill?.name || null, samples: 0, trades: 0,
          pnl: null, pnl_is_realized: false, live_market_observations_only: true,
        }, 409);
      }

      const spreadCondition = skillConditions.find((condition: any) =>
        String(condition?.label || "").toLowerCase().includes("spread")
      );
      const spreadThreshold = spreadCondition
        ? Number.parseFloat(String(spreadCondition.value ?? ""))
        : null;
      const conditionThresholds = skillConditions.map((condition: any) => ({
        label: String(condition?.label || ""),
        value: condition?.value == null ? null : String(condition.value),
        unit: condition?.unit == null ? null : String(condition.unit),
      }));

      const conditionPasses = (condition: any, sample: any) => {
        const label = String(condition?.label || "").toLowerCase();
        const threshold = Number.parseFloat(String(condition?.value ?? ""));
        if (!Number.isFinite(threshold)) return false;
        if (label.includes("latency")) return sample.latencyMs != null && sample.latencyMs < threshold;
        if (label.includes("volume")) return sample.volume24hUsd != null && sample.volume24hUsd > threshold;
        if (label.includes("spread")) return sample.spreadPct > threshold;
        if (label.includes("profit")) return sample.estimatedNetProfitUsd > threshold;
        return false;
      };
      // Negative spreads are observations, not executed losses. Count only distinct
      // entries that pass the configured market spread floor and net-profit floor.
      const positiveSpreadSamples = builtSamples.filter((sample: any) => sample.spreadPct > 0);
      const qualifying = distinctSignalEntries(builtSamples, (sample: any) =>
        sample.spreadPct >= minSpreadPct &&
        sample.estimatedNetProfitUsd > 0 &&
        skillConditions.every((condition: any) => conditionPasses(condition, sample))
      );
      const wins = qualifying.filter((sample: any) => sample.estimatedNetProfitUsd > 0);
      const netPnl = qualifying.reduce((sum: number, sample: any) => sum + sample.estimatedNetProfitUsd, 0);

      // Polling every few seconds must not charge the same hypothetical trade fee
      // repeatedly. These totals include only distinct signal entries above the
      // gross-spread floor and configured minimum net profit, never all 10,000 polls.
      const potentialSignalEntries = distinctSignalEntries(builtSamples, (sample: any) =>
        sample.spreadPct >= minSpreadPct &&
        sample.estimatedNetProfitUsd >= minimumPotentialNetProfitUsd
      );
      const potentialProfitable = potentialSignalEntries;
      const potentialGrossPnl = potentialSignalEntries.reduce((sum: number, sample: any) =>
        sum + sample.estimatedGrossProfitUsd, 0);
      const potentialNetPnl = potentialSignalEntries.reduce((sum: number, sample: any) =>
        sum + sample.estimatedNetProfitUsd, 0);
      const bestSample = positiveSpreadSamples.reduce((best: any, sample: any) =>
        !best || sample.estimatedNetProfitUsd > best.estimatedNetProfitUsd ? sample : best, null);
      const observedTimes = builtSamples.map((sample: any) => new Date(sample.observed_at).getTime()).filter(Number.isFinite);
      const observedSpanDays = observedTimes.length
        ? Math.max(0, (Math.max(...observedTimes) - Math.min(...observedTimes)) / 86400000)
        : 0;
      const result: any = {
        ok: true,
        supported: true,
        source: "recorded_live_market_observations",
        data_scope: "public_exchange_order_books + contemporaneous CoinGecko 24h volume",
        data_methodology: "A time-stratified sample of up to 10,000 recorded live order-book observations distributed across the full requested window; CoinGecko 24h USD volume observations are independently time-stratified across that same window and matched within ten minutes. Repeated polls are de-duplicated into signal entries by symbol and buy/sell venue.",
        available_dataset_samples: liveRowsCount ?? builtSamples.length,
        sample_limit: liveSampleLimit,
        newest_samples_selected: false,
        time_stratified_sample: true,
        live_market_observations_only: true,
        condition_thresholds: conditionThresholds,
        threshold_pct: Number.isFinite(spreadThreshold) ? Math.max(spreadThreshold, minSpreadPct) : minSpreadPct,
        configured_skill_spread_threshold_pct: Number.isFinite(spreadThreshold) ? spreadThreshold : null,
        market_min_spread_pct: minSpreadPct,
        threshold_reached: qualifying.length > 0,
        pnl_is_realized: false,
        pnl_is_executable: false,
        execution_triggered: false,
        warning: "Backtest results never initiate live trades. Live trades independently require fresh quotes, positive estimated net profit, an executable route, active execution policy, and signer authorization.",
        skill_id: skillId,
        strategy: skill.name,
        requested_days: days,
        observed_span_days: Number(observedSpanDays.toFixed(3)),
        window_start: startAt.toISOString(),
        window_end: endAt.toISOString(),
        notional_usd: notional,
        round_trip_fee_pct: feePct,
        slippage_pct: slippagePct,
        total_cost_assumption_pct: costPct,
        minimum_potential_net_profit_usd: minimumPotentialNetProfitUsd,
        potential_signal_events: potentialSignalEntries.length,
        potential_event_methodology: "One entry per symbol + buy/sell venue route when observed spread clears the configured floor and estimated net clears the USD profit floor; repeated polls of the same signal are not added as separate trades.",
        network_fee_included: false,
        network_fee_estimate_usd: null,
        network_fee_policy: "Not included: observations come from centralized-exchange order books, not a confirmed on-chain route or gas estimate.",
        samples: builtSamples.length,
        samples_with_latency: builtSamples.filter((sample: any) => sample.latencyMs != null).length,
        samples_with_volume: builtSamples.filter((sample: any) => sample.volume24hUsd != null).length,
        trades: qualifying.length,
        wins: wins.length,
        losses: Math.max(0, qualifying.length - wins.length),
        winRate: qualifying.length ? Math.round(wins.length / qualifying.length * 100) : 0,
        pnl: Number(netPnl.toFixed(2)),
        gross_pnl: Number(qualifying.reduce((sum: number, sample: any) => sum + notional * sample.spreadPct / 100, 0).toFixed(2)),
        estimated_net_pnl: Number(netPnl.toFixed(2)),
        strategy_qualified_net_pnl: Number(netPnl.toFixed(2)),
        strategy_qualified_gross_pnl: Number(qualifying.reduce((sum: number, sample: any) => sum + notional * sample.spreadPct / 100, 0).toFixed(2)),
        // Existing field names are retained for UI compatibility. Values now sum
        // distinct qualifying signal entries rather than every repeated poll.
        potential_gross_pnl_all_samples: Number(potentialGrossPnl.toFixed(2)),
        potential_net_pnl_all_samples: Number(potentialNetPnl.toFixed(2)),
        potential_profitable_samples: potentialProfitable.length,
        best_sample_spread_pct: bestSample ? Number(bestSample.spreadPct.toFixed(6)) : null,
        best_sample_potential_net_profit_usd: bestSample ? Number(bestSample.estimatedNetProfitUsd.toFixed(2)) : null,
        estimated_not_realized: true,
        cost_methodology: "Assumes 0.10% taker fees at each CEX venue (0.20% round trip) plus a 0.05% slippage reserve by default. Costs are estimated assumptions, not measured user fees or blockchain gas. Potential totals sum distinct entries that clear the configured spread and net-profit floors; they are not realized or executable PnL.",
        historical_max_spread_pct: Number(Math.max(...builtSamples.map((sample: any) => sample.spreadPct)).toFixed(6)),
        historical_min_route_latency_ms: Math.min(...builtSamples.filter((sample: any) => sample.latencyMs != null).map((sample: any) => sample.latencyMs), Infinity),
        reason: qualifying.length
          ? "live_observation_conditions_matched"
          : (Number(Math.max(...builtSamples.map((sample: any) => sample.spreadPct)).toFixed(6)) < minSpreadPct
              ? "historical_max_spread_below_market_floor"
              : "no_recorded_observations_matched_all_skill_conditions"),
        first_observation: builtSamples[0]?.observed_at || null,
        last_observation: builtSamples[builtSamples.length - 1]?.observed_at || null,
      };
      if (skillId) {
        const { error: saveError } = await admin.from("bot_skills").update({ backtest: result }).eq("id", skillId).eq("owner_id", skill.owner_id);
        if (saveError) return json({ error: "backtest_result_save_failed", detail: saveError.message }, 500);
      }
      return json(result);
    }

    const { data: dataset, error: datasetError } = await admin
      .from("strategy_training_datasets")
      .select("id,dataset_key,start_date,end_date,last_ingested_at")
      .eq("dataset_key", "crypto_cross_venue_2024_2025")
      .eq("active", true)
      .maybeSingle();

    if (datasetError) return json({ error: datasetError.message }, 500);
    if (!dataset || !dataset.last_ingested_at) {
      return json({
        ok: false,
        source: "historical_strategy_training",
        data_scope: "crypto_cross_venue_2024_2025",
        supported: false,
        reason: "historical_training_dataset_not_populated",
        dataset_start: dataset?.start_date || "2024-01-01",
        dataset_end: dataset?.end_date || "2025-12-31",
        skill_id: skillId || null,
      }, 409);
    }

    // Historical windows are anchored to the dataset's end date, never to "now".
    // This prevents a 2024-2025 training backtest from silently returning zero
    // because the current calendar date is in 2026.
    const datasetEnd = new Date(`${dataset.end_date}T23:59:59.999Z`);
    const datasetStart = new Date(datasetEnd.getTime() - days * 86400000);
    const { data: observations, error: observationsError } = await admin
      .from("strategy_training_observations")
      .select("id,source_key,symbol,metric,value,observed_at,metadata")
      .eq("dataset_id", dataset.id)
      .eq("metric", "spread_pct")
      .gte("observed_at", datasetStart.toISOString())
      .lte("observed_at", datasetEnd.toISOString())
      .order("observed_at", { ascending: true })
      .limit(10000);

    if (observationsError) return json({ error: observationsError.message }, 500);

    const samples = (observations || [])
      .map((row: any) => ({
        spread: Number(row.value),
        observed_at: row.observed_at,
        source_key: row.source_key || row.metadata?.source_key || null,
        symbol: row.symbol || row.metadata?.symbol || null,
        metadata: row.metadata || {},
      }))
      .filter((row: any) => Number.isFinite(row.spread));

    const sortedSpreads = samples.map((row: any) => row.spread).sort((a: number, b: number) => a - b);
    const percentile = (p: number) => sortedSpreads.length
      ? sortedSpreads[Math.min(sortedSpreads.length - 1, Math.floor((sortedSpreads.length - 1) * p))]
      : null;
    const spreadStats = {
      available_dataset_samples: samples.length,
      historical_min_spread_pct: sortedSpreads.length ? Number(sortedSpreads[0].toFixed(6)) : null,
      historical_median_spread_pct: percentile(0.5) == null ? null : Number(percentile(0.5)!.toFixed(6)),
      historical_p90_spread_pct: percentile(0.9) == null ? null : Number(percentile(0.9)!.toFixed(6)),
      historical_max_spread_pct: sortedSpreads.length ? Number(sortedSpreads[sortedSpreads.length - 1].toFixed(6)) : null,
      observations_above_fee_assumption: samples.filter((row: any) => row.spread > 0.10).length,
    };

    const conditions = Array.isArray(skill?.conditions) ? skill.conditions : [];
    const spreadCondition = conditions.find((item: any) =>
      String(item?.label || "").toLowerCase().includes("spread")
    );
    const spreadThreshold = spreadCondition ? Number(spreadCondition.value) : null;
    const riskThreshold = Number(skill?.risk_limits?.min_profit_threshold);

    const threshold = skillId
      ? (Number.isFinite(spreadThreshold)
          ? spreadThreshold
          : Number.isFinite(riskThreshold) ? riskThreshold : null)
      : (Number.isFinite(requestedThreshold) ? requestedThreshold : null);

    const requiresSpread = !!spreadCondition || Number.isFinite(riskThreshold);
    // Respect the actual backtest controls rather than silently using a $10,000
    // notional for every skill. Values are assumptions, not realized execution costs.
    const FEE_PCT = body.round_trip_fee_pct == null ? 0.10 : Number(body.round_trip_fee_pct);
    const SLIPPAGE_PCT = body.slippage_pct == null ? 0 : Number(body.slippage_pct);
    const COST_PCT = FEE_PCT + SLIPPAGE_PCT;
    const requestedNotional = Number(body.notional ?? skill?.risk_limits?.maxNotional ?? skill?.risk_limits?.max_trade_size ?? 10000);
    const NOTIONAL = Number.isFinite(requestedNotional) && requestedNotional > 0 ? requestedNotional : 10000;
    if (![FEE_PCT, SLIPPAGE_PCT].every((value) => Number.isFinite(value) && value >= 0) || COST_PCT >= 100) {
      return json({ error: "invalid_cost_assumptions" }, 400);
    }

    if (!requiresSpread || threshold === null) {
      return json({
        ok: true,
        source: "historical_strategy_training",
        data_scope: dataset.dataset_key,
        fallback_used: false,
        source_keys: [...new Set(samples.map((row: any) => row.source_key).filter(Boolean))],
        skill_id: skillId || null,
        strategy: skill?.name || null,
        days,
        threshold_pct: null,
        supported: false,
        reason: "strategy_has_no_spread_profit_backtest_criterion",
        pnl_is_realized: false,
        pnl_is_executable: false,
        source_is_historical_observation_data: true,
        ...spreadStats,
        samples: samples.length,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnl: 0,
        gross_pnl: 0,
        estimated_net_pnl: 0,
        fee_pct: FEE_PCT,
        notional: NOTIONAL,
        first_observation: samples[0]?.observed_at || null,
        last_observation: samples[samples.length - 1]?.observed_at || null,
      });
    }

    // Negative spread observations mean no positive arbitrage spread was present;
    // they remain in historical sample statistics but are not counted as executed losses.
    const positiveSpreadSamples = samples.filter((row: any) => row.spread > 0);
    const qualifying = positiveSpreadSamples.filter((row: any) => row.spread >= threshold);
    const profitable = qualifying.filter((row: any) => row.spread > COST_PCT);
    const grossPnl = qualifying.reduce((sum: number, row: any) => sum + (NOTIONAL * row.spread) / 100, 0);
    const netPnl = qualifying.reduce((sum: number, row: any) => sum + (NOTIONAL * (row.spread - COST_PCT)) / 100, 0);

    // Potential-profit diagnostics are calculated across every recorded sample,
    // separately from the strategy-qualified backtest. They are hypothetical and
    // must not be presented as realized PnL or executable opportunities.
    const potentialProfitable = positiveSpreadSamples.filter((row: any) => row.spread > COST_PCT);
    const potentialGrossPnl = positiveSpreadSamples.reduce((sum: number, row: any) => sum + (NOTIONAL * row.spread) / 100, 0);
    const potentialNetPnl = positiveSpreadSamples.reduce((sum: number, row: any) => sum + (NOTIONAL * (row.spread - COST_PCT)) / 100, 0);
    const bestSample = positiveSpreadSamples.reduce((best: any, row: any) => !best || row.spread > best.spread ? row : best, null);
    const bestSampleNetProfit = bestSample ? NOTIONAL * (bestSample.spread - COST_PCT) / 100 : null;

    return json({
      ok: true,
      source: "historical_strategy_training",
      data_scope: dataset.dataset_key,
      training_window_start: datasetStart.toISOString(),
      training_window_end: datasetEnd.toISOString(),
      training_window_start: datasetStart.toISOString(),
      training_window_end: datasetEnd.toISOString(),
      fallback_used: false,
      source_keys: [...new Set(samples.map((row: any) => row.source_key).filter(Boolean))],
      pnl_is_realized: false,
      pnl_is_executable: false,
      source_is_historical_observation_data: true,
      cost_methodology: "Historical spread-only observations; estimated net profit subtracts the configured round-trip fee and slippage assumptions. Potential totals sum hypothetical sample-level results and are not realized or executable PnL.",
      ...spreadStats,
      skill_id: skillId || null,
      strategy: skill?.name || null,
      days,
      threshold_pct: threshold,
      threshold_reached: qualifying.length > 0,
      reason: qualifying.length ? "historical_observations_matched_strategy_threshold" : "historical_max_spread_below_strategy_threshold",
      samples: samples.length,
      trades: qualifying.length,
      wins: profitable.length,
      losses: Math.max(0, qualifying.length - profitable.length),
      winRate: qualifying.length ? Math.round((profitable.length / qualifying.length) * 100) : 0,
      pnl: Number(netPnl.toFixed(2)),
      gross_pnl: Number(grossPnl.toFixed(2)),
      estimated_net_pnl: Number(netPnl.toFixed(2)),
      strategy_qualified_net_pnl: Number(netPnl.toFixed(2)),
      strategy_qualified_gross_pnl: Number(grossPnl.toFixed(2)),
      potential_gross_pnl_all_samples: Number(potentialGrossPnl.toFixed(2)),
      potential_net_pnl_all_samples: Number(potentialNetPnl.toFixed(2)),
      potential_profitable_samples: potentialProfitable.length,
      best_sample_spread_pct: bestSample ? Number(bestSample.spread.toFixed(6)) : null,
      best_sample_potential_net_profit_usd: bestSampleNetProfit == null ? null : Number(bestSampleNetProfit.toFixed(2)),
      estimated_not_realized: true,
      fee_pct: FEE_PCT,
      slippage_pct: SLIPPAGE_PCT,
      total_cost_assumption_pct: COST_PCT,
      notional: NOTIONAL,
      first_observation: samples[0]?.observed_at || null,
      last_observation: samples[samples.length - 1]?.observed_at || null,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "backtest_error" }, 500);
  }
});