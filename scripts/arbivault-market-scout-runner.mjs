// ArbiVault continuous market scout runner
// Node.js 20+
// Install: npm install @supabase/supabase-js
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
// This calls the existing authenticated arbivault-market-scout Edge Function.
// It does not execute trades or authorize wallet signing.

import { createClient } from "@supabase/supabase-js";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_EMAIL", "SUPABASE_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const intervalSeconds = Math.max(60, Number(process.env.SCOUT_INTERVAL_SECONDS || 300));
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: false,
      detectSessionInUrl: false,
    },
  },
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
  if (error || !data.session) throw new Error("Supabase sign-in failed: " + (error?.message || "session_missing"));
}

async function scoutOnce() {
  if (running || stopping) return;
  running = true;
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

    const summary = {
      timestamp: new Date(data.timestamp_ms || Date.now()).toISOString(),
      status: "observed",
      source: data.source,
      live_quote_count: data.live_quote_count ?? 0,
      live_pair_count: data.live_pair_count ?? 0,
      feeds: data.feeds ?? [],
      persisted_observations: data.observer_execution_links?.observation_persisted ?? 0,
      public_observations: data.public_observation_persisted ?? 0,
      route_count: Array.isArray(data.routes) ? data.routes.length : 0,
      routes: (data.routes ?? []).map((r) => ({
        chain: r.chain,
        pair: r.pair,
        buy_exchange: r.buyExchange,
        sell_exchange: r.sellExchange,
        spread_pct: r.spreadPct,
        latency_ms: r.latency,
        execution_route_id: r.execution_route_id ?? null,
      })),
      feed_health: data.feed_health ?? [],
      chain_rpc_health: data.chain_rpc_health ?? [],
      note: "Observation only. Spread is not realized profit; no trade was submitted.",
    };
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(new Date().toISOString(), "scout_error", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

console.log(`ArbiVault market scout starting; interval=${intervalSeconds}s; execution disabled.`);
await scoutOnce();
while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  if (!stopping) await scoutOnce();
}
