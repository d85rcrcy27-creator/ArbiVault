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