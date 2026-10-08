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
  Response.json(value, {
    status,
    headers: {
      ...corsHeaders,
      "cache-control": "no-store",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // Public research backtest: no user/session authentication.
    // Only aggregated public market observations are queried; private wallet/skill
    // records are never read by this endpoint.
    const body = await req.json().catch(() => ({}));
    const skillId = String(body.skill_id || "");
    const requestedThreshold = Number(body.threshold);
    const days = Math.min(90, Math.max(1, Number(body.days ?? 30)));

    if (Number.isFinite(requestedThreshold) && requestedThreshold < 0) {
      return json({ error: "invalid_threshold" }, 400);
    }

    const skill: any = null;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const fetchAll = async (skillFilter: string | null = null) => {
      const pageSize = 1000;
      const rows: any[] = [];

      for (let page = 0; page < 20; page += 1) {
        let query = admin
          .from("strategy_observations")
          .select("id,source_key,domain,symbol,metric,value,observed_at,metadata")
          .eq("source_key", "public_exchange_order_books")
          .eq("metric", "spread_pct")
          .gte("observed_at", since)
          .order("observed_at", { ascending: true })
          .range(page * pageSize, (page + 1) * pageSize - 1);

        const { data, error } = await query;
        if (error) return { rows: [], error };
        const batch = data || [];
        rows.push(...batch);
        if (batch.length < pageSize) break;
      }

      return { rows, error: null };
    };

    // Live scout observations are intentionally stored without a skill linkage.
    // A skill-specific backtest therefore uses linked samples when they exist,
    // otherwise it falls back to the owner's real historical market observations.
    const fetched = await fetchAll(null);
    if (fetched.error) return json({ error: fetched.error.message }, 500);

    const observations = fetched.rows;
    const dataScope = "public_exchange_order_books";
    const fallbackUsed = false;

    const samples = (observations || [])
      .map((row: any) => ({
        spread: Number(row.value),
        observed_at: row.observed_at,
        source_key: row.source_key || row.metadata?.source_key || null,
        symbol: row.symbol || row.metadata?.symbol || null,
        metadata: row.metadata || {},
      }))
      .filter((row: any) => Number.isFinite(row.spread));

    const threshold = Number.isFinite(requestedThreshold) ? requestedThreshold : null;
    const requiresSpread = threshold !== null;
    const FEE_PCT = 0.10;
    const NOTIONAL = 10000;

    // A historical spread observation is not automatically a trade.
    // Only observations meeting an explicit spread/profit threshold qualify.
    if (!requiresSpread || threshold === null) {
      return json({
        ok: true,
        source: "historical_strategy_observations",
        data_scope: dataScope,
        fallback_used: fallbackUsed,
        source_keys: [...new Set(samples.map((row: any) => row.metadata?.source_key || row.source_key).filter(Boolean))],
        skill_id: skillId || null,
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
    const grossPnl = qualifying.reduce(
      (sum: number, row: any) => sum + (NOTIONAL * row.spread) / 100,
      0,
    );
    const netPnl = qualifying.reduce(
      (sum: number, row: any) => sum + (NOTIONAL * (row.spread - FEE_PCT)) / 100,
      0,
    );

    return json({
      ok: true,
      source: "historical_strategy_observations",
      data_scope: dataScope,
      fallback_used: fallbackUsed,
      source_keys: [...new Set(samples.map((row: any) => row.metadata?.source_key || row.source_key).filter(Boolean))],
      skill_id: skillId || null,
      strategy: "public_market_backtest",
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