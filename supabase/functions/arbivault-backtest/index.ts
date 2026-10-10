import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { ...corsHeaders, "cache-control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
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
        .select("id,name,conditions,risk_limits,observation_only,discovery_enabled,strategy_bot_id")
        .eq("id", skillId)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "skill_not_found" }, 404);
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
      const { data: liveRows, error: liveRowsError } = await admin
        .from("strategy_observations")
        .select("id,symbol,metric,value,observed_at,metadata")
        .eq("owner_id", skill.owner_id)
        .eq("source_key", "public_exchange_order_books")
        .eq("domain", "execution_scout")
        .eq("metric", "spread_pct")
        .gte("observed_at", startAt.toISOString())
        .lte("observed_at", endAt.toISOString())
        .order("observed_at", { ascending: true })
        .limit(10000);
      if (liveRowsError) return json({ error: "live_observation_lookup_failed", detail: liveRowsError.message }, 500);

      const bases = [...new Set((liveRows || []).map((row: any) => String(row.symbol || "").split("/")[0]).filter(Boolean))];
      const volumeSymbols = bases.map((symbol) => symbol + "/USD");
      const { data: volumeRows, error: volumeRowsError } = volumeSymbols.length
        ? await admin
            .from("strategy_observations")
            .select("symbol,value,observed_at,metadata")
            .eq("owner_id", skill.owner_id)
            .eq("source_key", "coingecko")
            .eq("metric", "public_market_price")
            .in("symbol", volumeSymbols)
            .gte("observed_at", startAt.toISOString())
            .lte("observed_at", endAt.toISOString())
            .order("observed_at", { ascending: true })
            .limit(10000)
        : { data: [], error: null };
      if (volumeRowsError) return json({ error: "live_volume_lookup_failed", detail: volumeRowsError.message }, 500);

      const volumeHistory = new Map<string, any[]>();
      for (const row of volumeRows || []) {
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
      const feePct = body.round_trip_fee_pct == null ? 0.20 : Number(body.round_trip_fee_pct);
      const slippagePct = body.slippage_pct == null ? 0.10 : Number(body.slippage_pct);
      const costPct = feePct + slippagePct;
      const builtSamples = (liveRows || []).map((row: any) => {
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
        return {
          id: row.id,
          symbol: row.symbol,
          observed_at: row.observed_at,
          spreadPct,
          latencyMs,
          volume24hUsd,
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
      const qualifying = builtSamples.filter((sample: any) =>
        skillConditions.every((condition: any) => conditionPasses(condition, sample))
      );
      const wins = qualifying.filter((sample: any) => sample.estimatedNetProfitUsd > 0);
      const netPnl = qualifying.reduce((sum: number, sample: any) => sum + sample.estimatedNetProfitUsd, 0);
      const observedTimes = builtSamples.map((sample: any) => new Date(sample.observed_at).getTime()).filter(Number.isFinite);
      const observedSpanDays = observedTimes.length
        ? Math.max(0, (Math.max(...observedTimes) - Math.min(...observedTimes)) / 86400000)
        : 0;
      const result: any = {
        ok: true,
        supported: true,
        source: "recorded_live_market_observations",
        data_scope: "public_exchange_order_books + contemporaneous CoinGecko 24h volume",
        data_methodology: "Recorded live order-book snapshots with selected buy/sell venue latency; volume is matched to the nearest recorded CoinGecko 24h USD volume within ten minutes.",
        live_market_observations_only: true,
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
        historical_max_spread_pct: Number(Math.max(...builtSamples.map((sample: any) => sample.spreadPct)).toFixed(6)),
        historical_min_route_latency_ms: Math.min(...builtSamples.filter((sample: any) => sample.latencyMs != null).map((sample: any) => sample.latencyMs), Infinity),
        reason: qualifying.length ? "live_observation_conditions_matched" : "no_recorded_observations_matched_all_skill_conditions",
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
    const FEE_PCT = 0.10;
    const NOTIONAL = 10000;

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

    const qualifying = samples.filter((row: any) => row.spread >= threshold);
    const profitable = qualifying.filter((row: any) => row.spread > FEE_PCT);
    const grossPnl = qualifying.reduce((sum: number, row: any) => sum + (NOTIONAL * row.spread) / 100, 0);
    const netPnl = qualifying.reduce((sum: number, row: any) => sum + (NOTIONAL * (row.spread - FEE_PCT)) / 100, 0);

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
      skill_id: skillId || null,
      strategy: skill?.name || null,
      days,
      threshold_pct: threshold,
      samples: samples.length,
      trades: qualifying.length,
      wins: profitable.length,
      losses: Math.max(0, qualifying.length - profitable.length),
      winRate: qualifying.length ? Math.round((profitable.length / qualifying.length) * 100) : 0,
      pnl: Number(netPnl.toFixed(2)),
      gross_pnl: Number(grossPnl.toFixed(2)),
      estimated_net_pnl: Number(netPnl.toFixed(2)),
      fee_pct: FEE_PCT,
      notional: NOTIONAL,
      first_observation: samples[0]?.observed_at || null,
      last_observation: samples[samples.length - 1]?.observed_at || null,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "backtest_error" }, 500);
  }
});