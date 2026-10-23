import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, x-client-info, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

async function currentUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(authorization)) return null;
  const userClient = createClient(URL, ANON, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  return error || !data.user ? null : data.user;
}

async function builderDiagnostic() {
  const { data: cronToken, error: tokenError } = await admin.rpc("get_bot_cron_token");
  if (tokenError || typeof cronToken !== "string" || cronToken.length < 16) {
    throw new Error("diagnostic_authorization_unavailable");
  }
  const response = await fetch(URL + "/functions/v1/arbivault-transaction-builder", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SERVICE,
      authorization: "Bearer " + SERVICE,
      "x-arbivault-cron-token": cronToken,
    },
    body: JSON.stringify({ mode: "diagnostic" }),
    signal: AbortSignal.timeout(25000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result !== "object") {
    throw new Error("executor_diagnostic_failed_http_" + response.status);
  }
  return result;
}

function diagnosticBlockers(chainDiagnostic: any, walletAddress: string) {
  const executor = chainDiagnostic?.executor || {};
  const blockers: string[] = [];
  if (chainDiagnostic?.rpc_chain_ok !== true) blockers.push("chain_rpc_unhealthy");
  if (chainDiagnostic?.aave_pool_resolved !== true) blockers.push("aave_pool_unresolved");
  if (executor.configured !== true) blockers.push("executor_address_not_configured");
  if (executor.code_deployed !== true) blockers.push("executor_runtime_bytecode_missing");
  if (executor.pool_matches_expected !== true) blockers.push("executor_pool_mismatch");
  if (executor.source_verification?.verified !== true) blockers.push("executor_source_not_verified");
  if (executor.payout_recipient_matches_generated_hot_wallet !== true) blockers.push("executor_payout_wallet_not_verified");
  if (String(executor.payout_recipient_address || "").toLowerCase() !== walletAddress.toLowerCase()) {
    blockers.push("executor_payout_wallet_does_not_match_strategy_wallet");
  }
  if (chainDiagnostic?.ready_for_flash_transaction_test !== true) blockers.push("executor_not_ready_for_payout_test");
  if (executor.payout_audited !== true && chainDiagnostic?.payout_audited !== true) blockers.push("executor_payout_configuration_not_audited");
  return blockers;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ ok: false, error: "authentication_required" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");
    const chain = String(body.chain || "").toLowerCase();
    if (!["bnb", "ethereum"].includes(chain)) return json({ ok: false, error: "unsupported_chain" }, 400);
    if (!["status", "authorize"].includes(action)) return json({ ok: false, error: "unsupported_action" }, 400);
    if (action === "authorize" && body.confirmation !== "AUTHORIZE_ONE_FLASH_PAYOUT_TEST") {
      return json({ ok: false, error: "explicit_one_time_confirmation_required" }, 400);
    }

    const { data: bots, error: botError } = await admin
      .from("arbivault_strategy_bots")
      .select("id,owner_id,name,strategy,enabled,execution_enabled,flash_loan_enabled,chains")
      .eq("owner_id", user.id)
      .eq("strategy", "flash_loan_arbitrage")
      .eq("enabled", true)
      .eq("execution_enabled", true)
      .eq("flash_loan_enabled", true)
      .order("updated_at", { ascending: false })
      .limit(10);
    if (botError) return json({ ok: false, error: "strategy_lookup_failed" }, 503);
    const bot = (bots || []).find((candidate: any) => Array.isArray(candidate.chains) && candidate.chains.includes(chain));
    if (!bot) return json({ ok: false, error: "no_enabled_flash_strategy_for_chain" }, 404);

    const { data: routes, error: routeError } = await admin
      .from("arbivault_strategy_routes")
      .select("id,strategy_bot_id,chain,pair,route_type,enabled,discovery_only,builder_enabled,transaction_builder,payout_test_authorized,payout_test_authorized_by,payout_test_authorized_at,payout_test_used_at,payout_test_execution_attempt_id,payout_test_tx_hash")
      .eq("strategy_bot_id", bot.id)
      .eq("chain", chain)
      .eq("route_type", "flash_liquidity")
      .eq("enabled", true)
      .limit(2);
    if (routeError) return json({ ok: false, error: "route_lookup_failed" }, 503);
    const route = routes?.length === 1 ? routes[0] : null;
    if (!route) return json({ ok: false, error: routes?.length ? "multiple_enabled_flash_routes_for_chain" : "enabled_flash_route_not_found" }, 409);
    if (route.transaction_builder !== "aave_v3_atomic_flash_loan_v1" ||
        (chain === "bnb" ? route.pair !== "BNB/USDT" : route.pair !== "ETH/USDC")) {
      return json({ ok: false, error: "route_builder_chain_pair_mismatch" }, 409);
    }
    if (route.discovery_only !== true || route.builder_enabled === true) {
      return json({ ok: false, error: "payout_test_requires_discovery_only_disabled_builder_route" }, 409);
    }

    const blockers: string[] = [];
    const { data: walletBindings, error: bindingError } = await admin
      .from("arbivault_strategy_wallets")
      .select("wallet_id,chain,purpose,status")
      .eq("owner_id", user.id)
      .eq("strategy_bot_id", bot.id)
      .eq("chain", chain)
      .eq("purpose", "strategy_execution")
      .eq("status", "assigned");
    if (bindingError) return json({ ok: false, error: "strategy_wallet_binding_lookup_failed" }, 503);
    const boundIds = (walletBindings || []).map((binding: any) => binding.wallet_id).filter(Boolean);
    if (!boundIds.length) blockers.push("strategy_wallet_binding_missing");

    const { data: wallets, error: walletError } = boundIds.length
      ? await admin
          .from("wallets")
          .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status")
          .eq("owner_id", user.id)
          .eq("chain", chain)
          .in("id", boundIds)
          .eq("status", "active")
          .eq("is_hot", true)
          .eq("wallet_role", "trading_hot")
          .eq("data_quality_status", "verified")
      : { data: [], error: null };
    if (walletError) return json({ ok: false, error: "strategy_wallet_lookup_failed" }, 503);
    const wallet = (wallets || []).length === 1 ? wallets[0] : null;
    if (!wallet) blockers.push("unique_active_verified_strategy_hot_wallet_required");

    let approval = null;
    if (wallet) {
      const { data, error: approvalError } = await admin
        .from("approved_wallets")
        .select("id")
        .eq("owner_id", user.id)
        .eq("wallet_id", wallet.id)
        .eq("status", "approved")
        .maybeSingle();
      if (approvalError) return json({ ok: false, error: "wallet_approval_lookup_failed" }, 503);
      approval = data;
    }
    if (!approval) blockers.push("strategy_hot_wallet_not_approved");
    if (route.payout_test_used_at || route.payout_test_execution_attempt_id) {
      return json({
        ok: true,
        chain,
        route_id: route.id,
        status: "payout_test_already_claimed_requires_reconciliation",
        payout_test_tx_hash: route.payout_test_tx_hash || null,
        authorized: route.payout_test_authorized === true,
        can_authorize: false,
        blockers: ["previous_one_shot_payout_test_has_been_claimed"],
      });
    }

    const { data: adapter, error: adapterError } = wallet
      ? await admin
          .from("execution_adapters")
          .select("id,chain,configured,health_status,read_only,can_broadcast,automatic_signing,signer_provider,allowed_wallet_id")
          .eq("chain", chain)
          .eq("allowed_wallet_id", wallet.id)
          .maybeSingle()
      : { data: null, error: null };
    if (adapterError) return json({ ok: false, error: "execution_adapter_lookup_failed" }, 503);
    const adapterReady = !!adapter && adapter.configured === true &&
      adapter.health_status === "healthy" && adapter.read_only === false &&
      adapter.can_broadcast === true && adapter.automatic_signing === true &&
      adapter.signer_provider === "internal_vault";
    if (!adapterReady) blockers.push("healthy_internal_signer_adapter_not_configured_for_bound_wallet");

    let chainDiagnostic: any = null;
    try {
      const diagnostic = await builderDiagnostic();
      chainDiagnostic = chain === "ethereum" ? diagnostic.ethereum : diagnostic.bnb;
      blockers.push(...diagnosticBlockers(chainDiagnostic, String(wallet?.address || "")));
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "executor_diagnostic_failed");
    }

    const { data: executorRegistry, error: executorRegistryError } = await admin
      .from("flash_executor_deployments")
      .select("chain,executor_address,status,source_verified,payout_audited,payout_behavior_verified")
      .eq("chain", chain)
      .maybeSingle();
    if (executorRegistryError) blockers.push("executor_registry_lookup_failed");
    else if (!executorRegistry) blockers.push("executor_deployment_registry_row_missing");
    else {
      if (executorRegistry.status !== "verified") blockers.push("executor_registry_status_not_verified");
      if (executorRegistry.source_verified !== true) blockers.push("executor_source_not_verified_in_registry");
      if (executorRegistry.payout_audited !== true) blockers.push("executor_payout_not_audited_in_registry");
      if (executorRegistry.payout_behavior_verified === true) blockers.push("executor_payout_behavior_already_verified");
      if (chainDiagnostic?.executor?.address &&
          String(executorRegistry.executor_address || "").toLowerCase() !== String(chainDiagnostic.executor.address).toLowerCase()) {
        blockers.push("executor_registry_address_differs_from_live_diagnostic");
      }
    }
    const { data: executionPolicy, error: policyError } = await admin
      .from("arbivault_execution_policy")
      .select("enabled,starts_at,ends_at")
      .eq("policy_key", "primary")
      .maybeSingle();
    const policyNow = Date.now();
    const policyActive = !policyError && !!executionPolicy &&
      executionPolicy.enabled === true &&
      !!executionPolicy.starts_at && new Date(executionPolicy.starts_at).getTime() <= policyNow &&
      (!executionPolicy.ends_at || new Date(executionPolicy.ends_at).getTime() > policyNow);
    if (!policyActive) blockers.push(policyError ? "execution_policy_lookup_failed" : "execution_policy_not_active");
    const alreadyVerified = chainDiagnostic?.payout_behavior_verified === true ||
      chainDiagnostic?.executor?.payout_behavior_verified === true ||
      executorRegistry?.payout_behavior_verified === true;
    const alreadyAuthorizedByUser = route.payout_test_authorized === true &&
      String(route.payout_test_authorized_by || "") === String(user.id);
    const authorizedByAnotherUser = route.payout_test_authorized === true && !alreadyAuthorizedByUser;
    if (authorizedByAnotherUser) blockers.push("one_shot_payout_test_authorized_by_another_owner");

    const canAuthorize = blockers.length === 0 && !alreadyVerified &&
      route.payout_test_authorized !== true &&
      route.payout_test_used_at == null &&
      route.payout_test_execution_attempt_id == null;
    if (action === "status") {
      return json({
        ok: true, chain, route_id: route.id, pair: route.pair, strategy_bot_id: bot.id,
        wallet_id: wallet?.id || null, wallet_address: wallet?.address || null, executor: chainDiagnostic?.executor || null,
        chain_diagnostic: chainDiagnostic,
        payout_test_authorized: alreadyAuthorizedByUser,
        payout_test_authorization_state: alreadyAuthorizedByUser
          ? "authorized_waiting_for_profitable_quote_and_manual_passkey_approval"
          : authorizedByAnotherUser
            ? "authorized_by_another_owner"
            : route.payout_test_used_at != null || route.payout_test_execution_attempt_id != null
              ? "previous_test_requires_reconciliation"
              : "not_authorized",
        can_authorize: canAuthorize, blockers,
        policy: { max_notional_usd: 25, min_estimated_net_profit_usd: Number((bot as any).min_profit_threshold || 2), requires_passkey: true, broadcasts_without_manual_approval: false },
      });
    }

    if (!canAuthorize) {
      return json({ ok: false, error: "payout_test_preflight_blocked", chain, blockers }, 409);
    }
    const now = new Date().toISOString();
    const { data: authorizedRoute, error: authorizeError } = await admin
      .from("arbivault_strategy_routes")
      .update({
        payout_test_authorized: true,
        payout_test_authorized_by: user.id,
        payout_test_authorized_at: now,
        payout_test_used_at: null,
        payout_test_execution_attempt_id: null,
        payout_test_tx_hash: null,
        updated_at: now,
      })
      .eq("id", route.id)
      .eq("payout_test_authorized", false)
      .is("payout_test_used_at", null)
      .is("payout_test_execution_attempt_id", null)
      .select("id,payout_test_authorized,payout_test_authorized_at")
      .maybeSingle();
    if (authorizeError) return json({ ok: false, error: "payout_test_authorization_update_failed" }, 503);
    if (!authorizedRoute) return json({ ok: false, error: "payout_test_route_authorization_race" }, 409);
    return json({
      ok: true,
      chain,
      route_id: route.id,
      payout_test_authorized: true,
      payout_test_authorized_at: authorizedRoute.payout_test_authorized_at,
      next_step: "The scheduled worker may prepare one capped atomic payout-test attempt if a live quote clears the net-profit and fee limits. It still requires the normal passkey/biometric approval before signing. No transaction was signed or broadcast by this request.",
    });
  } catch {
    return json({ ok: false, error: "payout_test_request_failed" }, 500);
  }
});
