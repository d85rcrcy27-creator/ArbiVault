import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
const pick = <T extends Record<string, unknown>>(row: T, sourceApp: string) => ({ ...row, source_app: sourceApp });

async function rows(client: ReturnType<typeof createClient>, table: string, columns: string, ownerColumn: string, ownerId: string, orderColumn = "created_at") {
  const result = await client.from(table).select(columns).eq(ownerColumn, ownerId).order(orderColumn, { ascending: false }).limit(100);
  if (result.error) return { data: [], error: table };
  return { data: result.data || [], error: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!supabaseUrl || !anonKey) return json({ error: "ArbiVault backend configuration is unavailable" }, 503);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  const user = authData?.user;
  if (authError || !user?.id) return json({ error: "Valid ArbiVault sign-in required" }, 401);

  const warnings: string[] = [];
  const arbiSpecs = [
    ["payments", "id,owner_id,task_id,provider,provider_payment_id,amount,currency,status,paid_at,created_at,tx_hash,chain,asset,network,confirmation_count,metadata", "owner_id", "created_at"],
    ["tasks", "id,owner_id,opportunity_id,title,description,status,price,currency,payment_confirmed_at,completed_at,created_at,updated_at", "owner_id", "created_at"],
    ["opportunities", "id,owner_id,source,source_url,title,description,opportunity_type,status,estimated_value,discovered_at,updated_at,compliance_status", "owner_id", "created_at"],
    ["trades", "id,owner_id,chain,strategy,pair,notional_amount,gross_profit,fees_paid,net_profit,status,execution_mode,tx_hash,explorer_url,created_at,updated_at,confirmed_at,network_fee_usd,flash_loan_fee_usd,x402_resource_fee_usd,pnl_currency,fee_breakdown", "owner_id", "created_at"],
    ["bot_execution_runs", "id,owner_id,workflow,status,started_at,completed_at,error", "owner_id", "started_at"],
  ] as const;

  const arbiResults = await Promise.all(arbiSpecs.map(([table, columns, ownerColumn, orderColumn]) =>
    rows(userClient, table, columns, ownerColumn, user.id, orderColumn)
  ));
  const arbiData: Record<string, unknown[]> = {};
  arbiSpecs.forEach(([table], index) => {
    arbiData[table] = (arbiResults[index].data as Record<string, unknown>[]).map((row) => pick(row, "arbivault"));
    if (arbiResults[index].error) warnings.push("ArbiVault source table unavailable: " + table);
  });

  const responseData: Record<string, unknown> = {
    payments: arbiData.payments || [], tasks: arbiData.tasks || [],
    opportunities: arbiData.opportunities || [], trades: arbiData.trades || [],
    runs: arbiData.bot_execution_runs || [],
  };
  const sourceStatus: Record<string, unknown> = {
    arbivault: { connected: true },
    quantum: { connected: false, reason: "Quantum service-role secret is not configured" },
  };

  const quantumUrl = Deno.env.get("QUANTUM_SUPABASE_URL") || "https://gbfqnbemoqvvrhxysgoe.supabase.co";
  const quantumServiceKey = Deno.env.get("QUANTUM_SUPABASE_SERVICE_ROLE_KEY");
  if (quantumServiceKey && user.email) {
    try {
      const quantum = createClient(quantumUrl, quantumServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      let quantumUserId: string | null = null;
      for (let page = 1; page <= 50 && !quantumUserId; page++) {
        const { data, error } = await quantum.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error("Quantum identity lookup failed");
        const match = (data.users || []).find((candidate) => (candidate.email || "").toLowerCase() === user.email!.toLowerCase());
        if (match) quantumUserId = match.id;
        if (!data.users || data.users.length < 1000) break;
      }
      if (!quantumUserId) {
        sourceStatus.quantum = { connected: false, reason: "No matching Quantum Lead AI account email was found" };
      } else {
        const qSpecs = [
          ["payments", "id,owner_id,task_id,provider,provider_payment_id,amount,currency,status,paid_at,created_at,tx_hash,chain,asset,network,confirmation_count,metadata", "owner_id", "created_at"],
          ["tasks", "id,owner_id,opportunity_id,title,description,status,price,currency,payment_confirmed_at,completed_at,created_at,updated_at", "owner_id", "created_at"],
          ["trades", "id,owner_id,chain,strategy,pair,notional_amount,gross_profit,fees_paid,net_profit,status,execution_mode,tx_hash,explorer_url,created_at,updated_at,confirmed_at,network_fee_usd,flash_loan_fee_usd,x402_resource_fee_usd,pnl_currency,fee_breakdown", "owner_id", "created_at"],
          ["bot_execution_runs", "id,owner_id,workflow,status,started_at,completed_at,error", "owner_id", "started_at"],
        ] as const;
        const qResults = await Promise.all(qSpecs.map(([table, columns, ownerColumn, orderColumn]) =>
          rows(quantum, table, columns, ownerColumn, quantumUserId!, orderColumn)
        ));
        const qData: Record<string, unknown[]> = {};
        qSpecs.forEach(([table], index) => {
          qData[table] = (qResults[index].data as Record<string, unknown>[]).map((row) => pick(row, "quantum_lead_ai"));
          if (qResults[index].error) warnings.push("Quantum source table unavailable: " + table);
        });
        const qOpp = await quantum.from("opportunities")
          .select("id,business_name,industry,location,recommended_service,task_type,estimated_value,data_source,analysis_notes,execution_status,quality_status,status,created_at,updated_at,data_quality_status")
          .eq("created_by", quantumUserId).order("created_at", { ascending: false }).limit(100);
        if (qOpp.error) warnings.push("Quantum source table unavailable: opportunities");
        const normalizedOpps = (qOpp.data || []).map((row) => ({
          id: row.id, owner_id: quantumUserId, source: row.data_source || "Quantum Lead AI", source_url: null,
          title: row.recommended_service || row.business_name || row.task_type || "Lead opportunity",
          description: row.analysis_notes || row.industry || row.location || null,
          opportunity_type: row.task_type || "lead_generation", status: row.status || row.execution_status || "unknown",
          estimated_value: row.estimated_value, discovered_at: row.created_at, updated_at: row.updated_at,
          compliance_status: row.data_quality_status || row.quality_status || null, source_app: "quantum_lead_ai",
        }));
        responseData.payments = [...(responseData.payments as unknown[]), ...(qData.payments || [])];
        responseData.tasks = [...(responseData.tasks as unknown[]), ...(qData.tasks || [])];
        responseData.opportunities = [...(responseData.opportunities as unknown[]), ...normalizedOpps];
        responseData.trades = [...(responseData.trades as unknown[]), ...(qData.trades || [])];
        responseData.runs = [...(responseData.runs as unknown[]), ...(qData.bot_execution_runs || [])];
        sourceStatus.quantum = { connected: true };
      }
    } catch (_error) {
      sourceStatus.quantum = { connected: false, reason: "Quantum source query failed; check server-side credentials and schema" };
    }
  }

  return json({ ok: true, generatedAt: new Date().toISOString(), sourceStatus, warnings, data: responseData });
});
