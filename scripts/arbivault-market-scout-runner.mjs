// ArbiVault continuous market scout runner
// Node.js 20+
// Install: npm install @supabase/supabase-js
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
// Calls the existing authenticated scout and reads back its persisted route observations.
// Read-only: does not execute trades, authorize wallet signing, or move funds.

import { createClient } from "@supabase/supabase-js";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_EMAIL", "SUPABASE_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const intervalSeconds = Math.max(60, Number(process.env.SCOUT_INTERVAL_SECONDS || 300));
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: true, persistSession: false, detectSessionInUrl: false } },
);

let stopping = false;
let running = false;
process.on("SIGINT", () => { stopping = true; console.log("Stopping scout loop."); });
process.on("SIGTERM", () => { stopping = true; console.log("Stopping scout loop."); });

async function ensureSession() {
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session && existing.session.expires_at * 1000 > Date.now() + 60_000) return;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env.SUPABASE_EMAIL,
    password: process.env.SUPABASE_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error("Supabase sign-in failed: " + (error?.message || "session_missing"));
  }
}

async function scoutOnce() {
  if (running || stopping) return;
  running = true;
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  try {
    await ensureSession();
    const { data, error } = await supabase.functions.invoke("arbivault-market-scout", {
      body: { mode: "read_only", execute: false },
    });
    if (error) {
      console.error(new Date().toISOString(), "scout_failed", error.message);
      return;
    }
    if (!data || data.ok !== true) {
      console.error(new Date().toISOString(), "scout_unhealthy", JSON.stringify(data ?? null));
      return;
    }

    // Pull back the persisted observed-opportunity rows created by this scout run.
    // RLS must allow the authenticated user to read their own strategy_observations.
    const { data: observedRows, error: observedError } = await supabase
      .from("strategy_observations")
      .select("id,symbol,metric,value,observed_at,metadata,observed_route_id,execution_route_id,strategy_bot_id,execution_bot_config_id")
      .eq("domain", "execution_scout")
      .eq("metric", "spread_pct")
      .gte("observed_at", startedAt)
      .order("observed_at", { ascending: false })
      .limit(100);

    const linkedObservations = (observedRows ?? []).map((row) => ({
      observation_id: row.id,
      pair: row.symbol,
      spread_pct: row.value,
      observed_at: row.observed_at,
      observed_route_id: row.observed_route_id ?? null,
      execution_route_id: row.execution_route_id ?? null,
      strategy_bot_id: row.strategy_bot_id ?? null,
      execution_bot_config_id: row.execution_bot_config_id ?? null,
      route_link_status: row.observed_route_id ? "linked_to_observed_route" : "unlinked_observation",
      buy_exchange: row.metadata?.buy_exchange ?? null,
      sell_exchange: row.metadata?.sell_exchange ?? null,
      chain: row.metadata?.chain ?? null,
    }));

    const routeSummaries = (data.routes ?? []).map((route) => ({
      chain: route.chain,
      pair: route.pair,
      buy_exchange: route.buyExchange,
      sell_exchange: route.sellExchange,
      spread_pct: route.spreadPct,
      latency_ms: route.latency,
      observed_route_id: route.observed_route_id ?? null,
      execution_route_id: route.execution_route_id ?? null,
      strategy_bot_id: route.strategy_bot_id ?? null,
      route_link_status: route.observed_route_id ? "linked_to_observed_route" : "no_matching_observed_route",
    }));

    console.log(JSON.stringify({
      timestamp: new Date(data.timestamp_ms || Date.now()).toISOString(),
      status: "observed",
      source: data.source,
      live_quote_count: data.live_quote_count ?? 0,
      live_pair_count: data.live_pair_count ?? 0,
      feeds: data.feeds ?? [],
      persisted_observations: data.observer_execution_links?.observation_persisted ?? 0,
      public_observations: data.public_observation_persisted ?? 0,
      routes: routeSummaries,
      observed_opportunity_route: {
        table: "strategy_observations",
        linked_observation_count: linkedObservations.filter((row) => row.observed_route_id).length,
        unlinked_observation_count: linkedObservations.filter((row) => !row.observed_route_id).length,
        query_error: observedError?.message ?? null,
        observations: linkedObservations,
      },
      feed_health: data.feed_health ?? [],
      chain_rpc_health: data.chain_rpc_health ?? [],
      note: "Observed spreads are not realized profit. No trade was submitted.",
    }));
  } catch (error) {
    console.error(new Date().toISOString(), "scout_error", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

console.log(`ArbiVault market scout starting; interval=${intervalSeconds}s; observed-route tracking enabled; execution disabled.`);
await scoutOnce();
while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  if (!stopping) await scoutOnce();
}
