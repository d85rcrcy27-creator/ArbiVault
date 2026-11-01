import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { privateKeyToAccount } from "npm:viem@2.39.0/accounts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const ETH_CHAIN_ID = 1;
const ETH_WALLET_ID = "9c1ef47c-23bb-4885-8e54-373f0cdbf8a3";
const ETH_ADDRESS = "0xa7Eb59484C9dBFD3a57313d221d9a6E3eAD570E2";
const ETH_ADAPTER_ID = "a1dc63b2-ba7c-493e-aa9d-7fdd8e2aed43";
const ETH_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const RPC = Deno.env.get("ETHEREUM_RPC_URL") || "https://ethereum-rpc.publicnode.com";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

async function authorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data, error } = await admin.rpc("get_bot_cron_token");
  return !error && !!data && supplied === String(data);
}

async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("ethereum_rpc_http_" + response.status);
  const body = await response.json();
  if (body?.error || body?.result == null) throw new Error("ethereum_rpc_result_unavailable");
  return body.result;
}

function normalizedPrivateKey(value: unknown): `0x${string}` {
  const raw = String(value || "").trim();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("wallet_secret_format_invalid");
  return `0x${hex}`;
}

async function keepSigningDisabled(reason: string) {
  const { error } = await admin.from("execution_adapters").update({
    configured: false,
    health_status: "blocked",
    can_broadcast: false,
    automatic_signing: false,
    last_error: reason,
    last_health_check_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", ETH_ADAPTER_ID).eq("chain", "ethereum").eq("signer_provider", "internal_vault");
  if (error) throw new Error("failed_to_persist_safe_signer_state");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ ok: false, error: "unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "verify_and_repair_eth_trading_signer") {
      return json({ ok: false, error: "action_not_allowlisted" }, 400);
    }

    const [{ data: wallet, error: walletError }, { data: adapter, error: adapterError },
      { data: deployment, error: deploymentError }, { data: deploymentSigner, error: deploymentSignerError }] = await Promise.all([
      admin.from("wallets")
        .select("id,owner_id,chain,address,status,is_hot,wallet_role,secret_ref")
        .eq("id", ETH_WALLET_ID).maybeSingle(),
      admin.from("execution_adapters")
        .select("id,chain,signer_provider,allowed_wallet_id,signer_key_ref,configured,health_status,can_broadcast,automatic_signing,allowed_contracts")
        .eq("id", ETH_ADAPTER_ID).maybeSingle(),
      admin.from("flash_executor_deployments")
        .select("chain,chain_id,executor_address,deployment_tx_hash,runtime_bytecode_hash,status,source_verified,payout_audited,payout_behavior_verified,hot_wallet_address,pool_address")
        .eq("chain", "ethereum").maybeSingle(),
      admin.from("executor_deployment_signers")
        .select("chain,chain_id,signer_address,status")
        .eq("chain", "ethereum").maybeSingle(),
    ]);

    if (walletError || adapterError || deploymentError || deploymentSignerError) {
      return json({ ok: false, error: "ethereum_signer_registry_lookup_failed" }, 503);
    }
    if (!wallet || !adapter ||
      wallet.chain !== "ethereum" ||
      wallet.address.toLowerCase() !== ETH_ADDRESS.toLowerCase() ||
      wallet.status !== "active" ||
      wallet.is_hot !== true ||
      wallet.wallet_role !== "trading_hot" ||
      !wallet.secret_ref ||
      adapter.chain !== "ethereum" ||
      adapter.signer_provider !== "internal_vault") {
      await keepSigningDisabled("canonical_eth_trading_wallet_or_adapter_preconditions_failed");
      return json({
        ok: false,
        error: "canonical_eth_wallet_or_adapter_preconditions_failed",
        signing_enabled: false,
        broadcast_enabled: false,
      }, 409);
    }

    const { data: secret, error: secretError } = await admin.rpc("get_wallet_secret", { p_wallet_id: ETH_WALLET_ID });
    if (secretError || !secret) {
      await keepSigningDisabled("eth_signer_secret_unavailable");
      return json({
        ok: false,
        error: "eth_signer_secret_unavailable",
        signing_enabled: false,
        broadcast_enabled: false,
      }, 409);
    }

    let derivedAddress = "";
    try {
      derivedAddress = privateKeyToAccount(normalizedPrivateKey(secret)).address;
    } catch {
      await keepSigningDisabled("eth_signer_secret_format_or_derivation_invalid");
      return json({
        ok: false,
        error: "eth_signer_secret_format_or_derivation_invalid",
        signing_enabled: false,
        broadcast_enabled: false,
      }, 409);
    }

    if (derivedAddress.toLowerCase() !== ETH_ADDRESS.toLowerCase()) {
      await keepSigningDisabled("signer_secret_address_mismatch");
      return json({
        ok: false,
        error: "signer_secret_address_mismatch",
        secret_matches_wallet: false,
        signing_enabled: false,
        broadcast_enabled: false,
      }, 409);
    }

    const { error: bindingUpdateError } = await admin.from("wallets")
      .update({ key_binding_verified_at: new Date().toISOString() })
      .eq("id", ETH_WALLET_ID)
      .eq("chain", "ethereum")
      .eq("address", ETH_ADDRESS);
    if (bindingUpdateError) {
      await keepSigningDisabled("eth_key_binding_verification_persist_failed");
      return json({ ok: false, error: "eth_key_binding_verification_persist_failed", signing_enabled: false, broadcast_enabled: false }, 503);
    }

    const balanceHex = String(await rpc("eth_getBalance", [ETH_ADDRESS, "latest"]));
    const balanceWei = BigInt(balanceHex).toString();
    const codeCandidate = String(deployment?.executor_address || Deno.env.get("ARBIVAULT_ETH_FLASH_EXECUTOR") || "").trim();
    let executorCodePresent = false;
    let executorCandidateValid = /^0x[a-fA-F0-9]{40}$/.test(codeCandidate);
    let executorChainId: number | null = null;
    if (executorCandidateValid) {
      executorChainId = Number(BigInt(String(await rpc("eth_chainId"))));
      const code = String(await rpc("eth_getCode", [codeCandidate, "latest"]));
      executorCodePresent = /^0x[0-9a-f]*$/i.test(code) && !/^0x0*$/i.test(code);
      if (executorChainId !== ETH_CHAIN_ID) {
        executorCodePresent = false;
      }
    }

    const executorRegistryVerified = !!deployment &&
      deployment.status === "verified" &&
      deployment.source_verified === true &&
      deployment.payout_audited === true &&
      deployment.payout_behavior_verified === true &&
      !!deployment.executor_address &&
      deployment.hot_wallet_address?.toLowerCase() === ETH_ADDRESS.toLowerCase() &&
      deployment.pool_address?.toLowerCase() === ETH_POOL.toLowerCase() &&
      executorCodePresent &&
      executorChainId === ETH_CHAIN_ID;

    // Repair only the provably stale wallet binding. Keep broadcast and automatic
    // signing disabled until executor bytecode/payout and the separate trade
    // authorization path are ready. No signed transaction is created or sent.
    const blockingReason = !executorRegistryVerified
      ? "Signer binding verified; broadcast remains disabled because a fully verified Ethereum flash executor is not registered."
      : balanceWei === "0"
        ? "Signer binding verified; broadcast remains disabled because the trading wallet has no ETH for gas."
        : !deploymentSigner || deploymentSigner.status !== "active"
          ? "Signer binding verified; the dedicated Ethereum deployment signer is missing or inactive."
          : "Signer binding verified; automatic signing remains disabled pending the explicit standing trade-authorization path.";

    const { error: updateError } = await admin.from("execution_adapters").update({
      allowed_wallet_id: ETH_WALLET_ID,
      signer_key_ref: ETH_ADDRESS,
      configured: true,
      health_status: "healthy",
      can_broadcast: false,
      automatic_signing: false,
      last_error: blockingReason,
      last_health_check_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", ETH_ADAPTER_ID).eq("chain", "ethereum").eq("signer_provider", "internal_vault");

    if (updateError) return json({ ok: false, error: "eth_signer_binding_repair_failed" }, 500);

    return json({
      ok: true,
      action: "verify_and_repair_eth_trading_signer",
      chain: "ethereum",
      chain_id: ETH_CHAIN_ID,
      wallet_id: ETH_WALLET_ID,
      wallet_address: ETH_ADDRESS,
      wallet_is_active_hot_wallet: true,
      secret_matches_wallet: true,
      adapter_id: ETH_ADAPTER_ID,
      stale_binding_repaired: adapter.allowed_wallet_id !== ETH_WALLET_ID ||
        String(adapter.signer_key_ref || "").toLowerCase() !== ETH_ADDRESS.toLowerCase(),
      signer_health: "healthy",
      signing_enabled: false,
      broadcast_enabled: false,
      trading_wallet_balance_wei: balanceWei,
      deployment_signer_present: !!deploymentSigner && deploymentSigner.status === "active",
      executor_registry_entry_present: !!deployment?.executor_address,
      executor_candidate_configured: executorCandidateValid,
      executor_code_present: executorCodePresent,
      executor_registry_verified: executorRegistryVerified,
      blocker: blockingReason,
      transaction_sent: false,
    });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "eth_signer_repair_failed",
      transaction_sent: false,
    }, 500);
  }
});
