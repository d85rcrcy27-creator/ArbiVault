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
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "authentication_required" }, 401);

    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "authentication_required" }, 401);

    const body = await req.json().catch(() => ({}));
    const skillId = String(body.skill_id || "");
    const threshold = Number(body.threshold ?? 0);
    const days = Math.min(90, Math.max(1, Number(body.days ?? 30)));

    if (!Number.isFinite(threshold) || threshold < 0) {
      return json({ error: "invalid_threshold" }, 400);
    }

    const since = new Date(Date.now() - days * 86400000).toISOString();
    const fetchAll = async (skillFilter: string | null = null) => {
      const pageSize = 1000;
      const rows: any[] = [];

      for (let page = 0; page < 20; page += 1) {
        let query = admin
          .from("strategy_observations")
          .select("id,bot_skill_id,source_key,domain,symbol,metric,value,observed_at,metadata")
          .eq("owner_id", userData.user.id)
          .eq("metric", "spread_pct")
          .gte("observed_at", since)
          .order("observed_at", { ascending: true })
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (skillFilter) query = query.eq("bot_skill_id", skillFilter);

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
    let fetched = await fetchAll(skillId || null);
    if (fetched.error) return json({ error: fetched.error.message }, 500);

    let observations = fetched.rows;
    let dataScope = skillId ? "skill_linked_observations" : "owner_market_observations";
    let fallbackUsed = false;

    if (skillId && observations.length === 0) {
      fetched = await fetchAll(null);
      if (fetched.error) return json({ error: fetched.error.message }, 500);
      observations = fetched.rows;
      dataScope = "owner_market_observations_fallback";
      fallbackUsed = true;
    }

    const samples = (observations || [])
      .map((row: any) => ({
        spread: Number(row.value),
        observed_at: row.observed_at,
        source_key: row.source_key || row.metadata?.source_key || null,
        symbol: row.symbol || row.metadata?.symbol || null,
        metadata: row.metadata || {},
      }))
      .filter((row: any) => Number.isFinite(row.spread));

    const conditions = Array.isArray(skill.conditions) ? skill.conditions : [];
    const conditionText = JSON.stringify(skill.conditions || {}).toLowerCase();

    const spreadCondition = conditions.find((item: any) =>
      String(item?.label || "").toLowerCase().includes("spread")
    );
    const spreadThreshold = spreadCondition
      ? Number(spreadCondition.value)
      : null;

    const riskThreshold = Number(skill.risk_limits?.min_profit_threshold);
    const threshold = Number.isFinite(spreadThreshold)
      ? spreadThreshold
      : Number.isFinite(riskThreshold)
        ? riskThreshold
        : null;

    const requiresSpread = !!spreadCondition || Number.isFinite(riskThreshold);
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
      days,
      threshold_pct: threshold,
      samples: samples.length,
      trades: qualifying.length,
      wins: wins.length,
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