import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...cors, "cache-control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authorization = req.headers.get("Authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return json({ error: "authentication_required" }, 401);
    }
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: "authentication_required" }, 401);

    const body = await req.json().catch(() => ({}));
    const strategyId = String(body.strategy_bot_id || "355216ab-7398-4fe8-a866-5551a22996fc");
    const hours = Math.min(168, Math.max(1, Number(body.lookback_hours ?? 24)));

    const { data: strategy, error: strategyError } = await admin
      .from("arbivault_strategy_bots")
      .select("id,name,strategy,enabled,execution_enabled,flash_loan_enabled,chains,max_trade_size,min_profit_threshold,slippage_tolerance,max_gas_budget,cooldown_ms,owner_id")
      .eq("id", strategyId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (strategyError) return json({ error: "strategy_lookup_failed", detail: strategyError.message }, 500);
    if (!strategy) return json({ error: "strategy_not_found_or_not_owned" }, 404);

    const { data: skills, error: skillsError } = await admin
      .from("bot_skills")
      .select("id,name,active,conditions,actions,risk_limits,data_sources,observation_only,discovery_enabled,strategy_bot_id")
      .eq("owner_id", user.id)
      .eq("strategy_bot_id", strategy.id)
      .order("created_at", { ascending: true });
    if (skillsError) return json({ error: "strategy_skill_lookup_failed", detail: skillsError.message }, 500);

    const { data: routes, error: routesError } = await admin
      .from("arbivault_strategy_routes")
      .select("id,chain,pair,dex_venue,reference_venue,route_type,enabled,discovery_only,builder_enabled,builder_status,strategy_bot_id")
      .eq("strategy_bot_id", strategy.id)
      .order("chain", { ascending: true });
    if (routesError) return json({ error: "strategy_route_lookup_failed", detail: routesError.message }, 500);

    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const skillIds = (skills || []).map((s: any) => s.id);
    let observations: any[] = [];
    if (skillIds.length) {
      const { data, error } = await admin
        .from("strategy_observations")
        .select("id,bot_skill_id,strategy_bot_id,source_key,domain,symbol,metric,value,observed_at,metadata,observed_route_id,execution_route_id")
        .eq("owner_id", user.id)
        .in("bot_skill_id", skillIds)
        .gte("observed_at", since)
        .order("observed_at", { ascending: false })
        .limit(2000);
      if (error) return json({ error: "strategy_observation_lookup_failed", detail: error.message }, 500);
      observations = (data || []).filter((o: any) => !o.strategy_bot_id || o.strategy_bot_id === strategy.id);
    }

    const skillById = new Map((skills || []).map((s: any) => [s.id, s]));
    const decisions = observations.map((o: any) => {
      const skill: any = skillById.get(o.bot_skill_id);
      const metadata = o.metadata && typeof o.metadata === "object" ? o.metadata : {};
      const spreadPct = Number(o.value);
      const netProfit = Number(metadata.net_profit_after_costs_usd);
      const quoteAge = Number(metadata.quote_age_ms);
      const maxSpreadSlippageBps = Number(metadata.slippage_bps);
      const routeVerified = metadata.both_legs_executable === true && metadata.execution_route_verified === true;
      const liquidityVerified = metadata.liquidity_depth_verified === true;
      const costEvidence = ["fees_usd", "slippage_cost_usd", "gas_cost_usd"].every(
        (key) => metadata[key] !== undefined && metadata[key] !== null && Number.isFinite(Number(metadata[key])) && Number(metadata[key]) >= 0
      );
      const reasons: string[] = [];
      if (!skill || !skill.active) reasons.push("skill_inactive_or_missing");
      if (o.metric !== "spread_pct") reasons.push("unsupported_observation_metric");
      if (!Number.isFinite(spreadPct)) reasons.push("spread_value_missing");
      else if (spreadPct < 0.30) reasons.push("spread_below_threshold");
      if (!costEvidence) reasons.push("cost_breakdown_missing");
      if (!Number.isFinite(netProfit)) reasons.push("net_profit_after_costs_missing");
      else if (netProfit < 2) reasons.push("net_profit_below_threshold");
      if (!Number.isFinite(quoteAge)) reasons.push("quote_freshness_missing");
      else if (quoteAge > 1000) reasons.push("quote_stale");
      if (!routeVerified) reasons.push("both_execution_legs_not_verified");
      if (!liquidityVerified) reasons.push("liquidity_depth_not_verified");
      
      return {
        observation_id: o.id,
        skill_id: o.bot_skill_id,
        skill_name: skill?.name || null,
        symbol: o.symbol,
        observed_at: o.observed_at,
        spread_pct: Number.isFinite(spreadPct) ? spreadPct : null,
        net_profit_after_costs_usd: Number.isFinite(netProfit) ? netProfit : null,
        quote_age_ms: Number.isFinite(quoteAge) ? quoteAge : null,
        candidate: reasons.length === 0,
        execution_authorized: reasons.length === 0 && !!skill && !skill.observation_only && strategy.execution_enabled === true,
        execution_blocked_reasons: [
          ...(skill?.observation_only ? ["skill_observation_only"] : []),
          ...(strategy.execution_enabled !== true ? ["strategy_execution_disabled"] : []),
        ],
        rejection_reasons: reasons,
      };
    });

    const activeSkills = (skills || []).filter((s: any) => s.active);
    const missingSkillLinks = activeSkills.filter((s: any) => s.strategy_bot_id !== strategy.id);
    const routesEnabled = (routes || []).filter((r: any) => r.enabled);
    return json({
      ok: true,
      strategy,
      skills: skills || [],
      routes: routes || [],
      evaluation: {
        lookback_hours: hours,
        observations_reviewed: observations.length,
        active_skill_count: activeSkills.length,
        skill_link_integrity: missingSkillLinks.length === 0,
        enabled_route_count: routesEnabled.length,
        execution_enabled: strategy.execution_enabled,
        live_execution_performed: false,
        candidates: decisions.filter((d: any) => d.candidate),
        rejected_observations: decisions.filter((d: any) => !d.candidate).slice(0, 100),
        status: !activeSkills.length ? "blocked_no_active_skills" :
          !observations.length ? "waiting_for_linked_live_observations" :
          decisions.some((d: any) => d.candidate) ? "candidate_found_requires_execution_validation" :
          "observations_rejected_by_cost_and_execution_gates",
      },
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    return json({ error: "strategy_evaluation_failed", detail: error instanceof Error ? error.message : "unknown_error" }, 500);
  }
});