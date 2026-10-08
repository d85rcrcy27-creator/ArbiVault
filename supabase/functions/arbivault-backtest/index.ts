import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

Deno.serve(async (req) => {
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
    const baseQuery = () => admin
      .from("strategy_observations")
      .select("id,bot_skill_id,source_key,domain,symbol,metric,value,observed_at,metadata")
      .eq("owner_id", userData.user.id)
      .eq("metric", "spread_pct")
      .gte("observed_at", since)
      .order("observed_at", { ascending: true })
      .limit(10000);

    // Live scout observations are intentionally stored without a skill linkage.
    // A skill-specific backtest therefore uses linked samples when they exist,
    // otherwise it falls back to the owner's real historical market observations.
    let { data: observations, error } = skillId
      ? await baseQuery().eq("bot_skill_id", skillId)
      : await baseQuery();

    if (error) return json({ error: error.message }, 500);

    let dataScope = skillId ? "skill_linked_observations" : "owner_market_observations";
    let fallbackUsed = false;

    if (skillId && !(observations || []).length) {
      const fallback = await baseQuery();
      if (fallback.error) return json({ error: fallback.error.message }, 500);
      observations = fallback.data || [];
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

    const FEE_PCT = 0.20;
    const NOTIONAL = 1000;
    const qualifying = samples.filter((row: any) => row.spread >= threshold);
    const wins = qualifying.filter((row: any) => row.spread > FEE_PCT);
    const pnl = qualifying.reduce(
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
      losses: Math.max(0, qualifying.length - wins.length),
      winRate: qualifying.length ? Math.round((wins.length / qualifying.length) * 100) : 0,
      pnl: Number(pnl.toFixed(2)),
      fee_pct: FEE_PCT,
      notional: NOTIONAL,
      first_observation: samples[0]?.observed_at || null,
      last_observation: samples[samples.length - 1]?.observed_at || null,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "backtest_error" }, 500);
  }
});