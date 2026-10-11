import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2.39.0/accounts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type EvmChain = "bnb" | "ethereum";
type WalletRow = {
  id: string;
  owner_id: string;
  chain: EvmChain;
  address: string;
  label: string | null;
  status: string;
  is_hot: boolean;
  wallet_role: string;
  custody_type: string | null;
  secret_ref: string | null;
};

const CHAIN_CONFIG: Record<EvmChain, {
  chainId: string;
  rpcEnv: string;
  fallbacks: string[];
  router: string;
  label: string;
}> = {
  bnb: {
    chainId: "0x38",
    rpcEnv: "BSC_RPC_URL",
    fallbacks: ["https://bsc-dataseed.binance.org", "https://bsc-rpc.publicnode.com"],
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    label: "BNB",
  },
  ethereum: {
    chainId: "0x1",
    rpcEnv: "ETHEREUM_RPC_URL",
    fallbacks: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"],
    router: "0x7a250d5630B4cf539739dF2C5dAcb4c659F2488D",
    label: "Ethereum",
  },
};

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });

async function authorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data, error } = await supabase.rpc("get_bot_cron_token");
  return !error && !!data && supplied === data;
}

async function rpc(endpoint: string, method: string, params: unknown[]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error("rpc_http_" + response.status);
  const body = await response.json();
  if (body.error) throw new Error("rpc_error_" + String(body.error.code || "unknown"));
  return body.result;
}

async function walletAddressHasContractCode(chain: EvmChain, address: string) {
  const config = CHAIN_CONFIG[chain];
  const endpoints = [...new Set([
    (Deno.env.get(config.rpcEnv) || "").trim(),
    ...config.fallbacks,
  ].filter(Boolean))];
  let lastError = "wallet_code_check_failed";
  for (const endpoint of endpoints) {
    try {
      const chainId = String(await rpc(endpoint, "eth_chainId", [])).toLowerCase();
      if (chainId !== config.chainId) {
        lastError = "wallet_code_check_wrong_chain";
        continue;
      }
      const code = String(await rpc(endpoint, "eth_getCode", [address, "latest"]));
      if (!/^0x[0-9a-f]*$/i.test(code)) {
        lastError = "wallet_code_check_invalid_response";
        continue;
      }
      return !/^0x0*$/i.test(code);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "wallet_code_check_failed";
    }
  }
  throw new Error(lastError);
}

async function rotateWallet(oldWallet: WalletRow) {
  const chain = oldWallet.chain;
  const config = CHAIN_CONFIG[chain];
  const now = new Date().toISOString();

  // Claim by quarantining the source row conditionally. A concurrent worker that
  // sees the same address will lose this compare-and-set and must not mint another wallet.
  const { data: claimed, error: claimError } = await supabase
    .from("wallets")
    .update({
      status: "quarantined",
      data_quality_status: "needs_review",
      updated_at: now,
    })
    .eq("id", oldWallet.id)
    .eq("owner_id", oldWallet.owner_id)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (claimError) throw new Error("old_wallet_quarantine_failed");
  if (!claimed) return { rotated: false, reason: "wallet_rotation_already_claimed", old_wallet_id: oldWallet.id };

  // Disable every signer bound to the flagged address before making any replacement active.
  const { error: adapterDisableError } = await supabase
    .from("execution_adapters")
    .update({
      configured: false,
      automatic_signing: false,
      can_broadcast: false,
      health_status: "blocked",
      last_error: "wallet_address_has_contract_code_rotation_required",
      updated_at: now,
    })
    .eq("allowed_wallet_id", oldWallet.id);
  if (adapterDisableError) throw new Error("old_wallet_signer_disable_failed");

  const { error: requestError } = await supabase
    .from("signing_requests")
    .update({ status: "rejected", rejected_at: now })
    .eq("source_wallet_id", oldWallet.id)
    .in("status", ["pending", "authorized"]);
  if (requestError) throw new Error("old_wallet_pending_signatures_revoke_failed");

  const { error: attemptError } = await supabase
    .from("execution_attempts")
    .update({
      status: "blocked",
      failure_reason: "wallet_address_has_contract_code_rotated",
      updated_at: now,
    })
    .eq("wallet_id", oldWallet.id)
    .in("status", ["created", "validated", "awaiting_signature"]);
  if (attemptError) throw new Error("old_wallet_open_attempts_block_failed");

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() === oldWallet.address.toLowerCase()) {
    throw new Error("replacement_wallet_address_collision");
  }

  const { data: newWallet, error: createError } = await supabase
    .from("wallets")
    .insert({
      owner_id: oldWallet.owner_id,
      chain,
      address: account.address,
      label: "ArbiVault " + config.label + " trading hot wallet (rotated)",
      status: "active",
      is_hot: true,
      custody_type: "server_vault",
      wallet_role: "trading_hot",
      verification_source: "arbivault-wallet-rotation",
      data_quality_status: "verified",
      derivation_path: "internal-random-secp256k1",
    })
    .select("id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref")
    .single();
  if (createError || !newWallet) throw new Error("replacement_wallet_create_failed");

  // Secret material goes directly to the existing protected Vault RPC; it is never
  // returned in this function response, emitted to logs, or stored in browser state.
  const { data: secretRef, error: secretError } = await supabase.rpc("store_wallet_secret", {
    p_wallet_id: newWallet.id,
    p_secret: privateKey,
  });
  if (secretError || !secretRef) {
    await supabase.from("wallets").update({
      status: "quarantined",
      data_quality_status: "needs_review",
      updated_at: new Date().toISOString(),
    }).eq("id", newWallet.id);
    throw new Error("replacement_wallet_secret_storage_failed");
  }
  const { error: refError } = await supabase
    .from("wallets")
    .update({ secret_ref: secretRef, updated_at: new Date().toISOString() })
    .eq("id", newWallet.id)
    .eq("owner_id", oldWallet.owner_id);
  if (refError) {
    await supabase.from("wallets").update({
      status: "quarantined",
      data_quality_status: "needs_review",
      updated_at: new Date().toISOString(),
    }).eq("id", newWallet.id);
    throw new Error("replacement_wallet_secret_reference_failed");
  }

  const { data: previousBindings, error: bindingsLookupError } = await supabase
    .from("bot_wallet_bindings")
    .select("id")
    .eq("owner_id", oldWallet.owner_id)
    .eq("wallet_id", oldWallet.id);
  if (bindingsLookupError) throw new Error("bot_wallet_binding_lookup_failed");

  const { error: bindingsUpdateError } = await supabase
    .from("bot_wallet_bindings")
    .update({ wallet_id: newWallet.id })
    .eq("owner_id", oldWallet.owner_id)
    .eq("wallet_id", oldWallet.id);
  if (bindingsUpdateError) throw new Error("bot_wallet_binding_rotation_failed");

  // If the old wallet was not bound yet, ensure the execution bot receives the replacement.
  if (!previousBindings?.length) {
    const { data: bot, error: botError } = await supabase
      .from("bot_configs")
      .select("id")
      .eq("owner_id", oldWallet.owner_id)
      .eq("bot_role", "execution")
      .maybeSingle();
    if (botError) throw new Error("execution_bot_lookup_failed");
    if (bot?.id) {
      const { data: existingBinding, error: bindingError } = await supabase
        .from("bot_wallet_bindings")
        .select("id")
        .eq("owner_id", oldWallet.owner_id)
        .eq("bot_config_id", bot.id)
        .eq("wallet_id", newWallet.id)
        .eq("role", "execution")
        .maybeSingle();
      if (bindingError) throw new Error("replacement_binding_lookup_failed");
      if (!existingBinding) {
        const { error: bindingInsertError } = await supabase.from("bot_wallet_bindings").insert({
          owner_id: oldWallet.owner_id,
          bot_config_id: bot.id,
          wallet_id: newWallet.id,
          role: "execution",
        });
        if (bindingInsertError) throw new Error("replacement_binding_create_failed");
      }
    }
  }

  const { error: strategyWalletError } = await supabase
    .from("arbivault_strategy_wallets")
    .update({
      wallet_id: newWallet.id,
      status: "assigned",
      updated_at: new Date().toISOString(),
    })
    .eq("owner_id", oldWallet.owner_id)
    .eq("chain", chain)
    .eq("wallet_id", oldWallet.id);
  if (strategyWalletError) throw new Error("strategy_wallet_rotation_failed");

  const { error: auditError } = await supabase.rpc("record_reconciliation_event", {
    p_wallet_id: newWallet.id,
    p_chain: chain,
    p_tx_hash: null,
    p_payment_id: null,
    p_trade_id: null,
    p_event_type: "wallet_rotated_contract_code_detected",
    p_status: "verified",
    p_source: "arbivault-wallet-rotation",
    p_details: {
      reason: "contract_code_detected_at_trading_hot_wallet_address",
      replaced_wallet_id: oldWallet.id,
      replaced_wallet_address: oldWallet.address,
      replacement_wallet_id: newWallet.id,
      replacement_wallet_address: newWallet.address,
      old_wallet_status: "quarantined",
      secret_stored_in_vault: true,
      funds_moved_automatically: false,
    },
  });
  if (auditError) throw new Error("wallet_rotation_audit_failed");

  const allowedContracts = [config.router];
  const { data: existingAdapter, error: newAdapterLookupError } = await supabase
    .from("execution_adapters")
    .select("id")
    .eq("chain", chain)
    .eq("allowed_wallet_id", newWallet.id)
    .eq("signer_provider", "internal_vault")
    .maybeSingle();
  if (newAdapterLookupError) throw new Error("replacement_adapter_lookup_failed");

  const adapterPatch = {
    configured: true,
    health_status: "healthy",
    read_only: false,
    signing_boundary: "internal_vault",
    can_broadcast: true,
    can_withdraw: false,
    automatic_signing: true,
    allowed_wallet_id: newWallet.id,
    signer_key_ref: newWallet.address,
    policy_version: "arbivault-internal-v3",
    last_error: null,
    allowed_contracts: allowedContracts,
    allowed_programs: [],
    max_transaction_value: 0,
    updated_at: new Date().toISOString(),
  };

  if (existingAdapter?.id) {
    const { error } = await supabase.from("execution_adapters").update(adapterPatch).eq("id", existingAdapter.id);
    if (error) throw new Error("replacement_adapter_enable_failed");
  } else {
    const { error } = await supabase.from("execution_adapters").insert({
      ...adapterPatch,
      name: "ArbiVault Internal Vault " + config.label + " Trading Signer",
      adapter_type: "dex_router",
      endpoint: "supabase://arbivault-signer",
      chain,
      signer_provider: "internal_vault",
    });
    if (error) throw new Error("replacement_adapter_create_failed");
  }

  return {
    rotated: true,
    reason: "contract_code_detected",
    chain,
    old_wallet_id: oldWallet.id,
    old_wallet_address: oldWallet.address,
    new_wallet_id: newWallet.id,
    new_wallet_address: newWallet.address,
    secret_stored_in_vault: true,
    old_wallet_quarantined: true,
    old_signing_disabled: true,
    pending_signatures_revoked: true,
    automatic_funds_transfer: false,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const requestedWalletId = typeof body.wallet_id === "string" ? body.wallet_id : null;
    const allowedChains: EvmChain[] = ["bnb", "ethereum"];
    let wallets: WalletRow[] = [];

    if (requestedWalletId) {
      const { data, error } = await supabase
        .from("wallets")
        .select("id,owner_id,chain,address,label,status,is_hot,wallet_role,custody_type,secret_ref")
        .eq("id", requestedWalletId)
        .maybeSingle();
      if (error) return json({ error: "wallet_lookup_failed" }, 500);
      if (!data) return json({ error: "wallet_not_found" }, 404);
      if (!allowedChains.includes(data.chain) || data.status !== "active" || data.is_hot !== true || data.wallet_role !== "trading_hot") {
        return json({ error: "wallet_not_active_evm_trading_hot" }, 409);
      }
      wallets = [data as WalletRow];
    } else {
      const { data, error } = await supabase
        .from("wallets")
        .select("id,owner_id,chain,address,label,status,is_hot,wallet_role,custody_type,secret_ref")
        .in("chain", allowedChains)
        .eq("status", "active")
        .eq("is_hot", true)
        .eq("wallet_role", "trading_hot")
        .eq("custody_type", "server_vault")
        .order("created_at", { ascending: true });
      if (error) return json({ error: "active_hot_wallet_scan_failed" }, 500);
      wallets = (data || []) as WalletRow[];
    }

    const checked: Array<Record<string, unknown>> = [];
    const rotated: Array<Record<string, unknown>> = [];
    const blockedChains = new Set<EvmChain>();
    const errors: Array<Record<string, unknown>> = [];

    for (const wallet of wallets) {
      if (!allowedChains.includes(wallet.chain) || wallet.status !== "active") continue;
      try {
        const hasCode = await walletAddressHasContractCode(wallet.chain, wallet.address);
        checked.push({ wallet_id: wallet.id, chain: wallet.chain, has_contract_code: hasCode });
        if (!hasCode) continue;
        const result = await rotateWallet(wallet);
        if (result.rotated) rotated.push(result);
        else if (result.reason === "wallet_rotation_already_claimed") {
          blockedChains.add(wallet.chain);
          errors.push({ wallet_id: wallet.id, chain: wallet.chain, error: result.reason });
        }
      } catch (error) {
        blockedChains.add(wallet.chain);
        errors.push({
          wallet_id: wallet.id,
          chain: wallet.chain,
          error: error instanceof Error ? error.message : "wallet_rotation_failed",
        });
      }
    }

    const result = {
      ok: errors.length === 0,
      worker: "wallet-rotation",
      checked_wallets: checked.length,
      checked,
      rotated_wallets: rotated,
      blocked_chains: [...blockedChains],
      errors,
      funds_transferred: false,
    };
    return json(result, errors.length ? 503 : 200);
  } catch (error) {
    return json({
      ok: false,
      worker: "wallet-rotation",
      error: error instanceof Error ? error.message : "wallet_rotation_failed",
      blocked_chains: ["bnb", "ethereum"],
      funds_transferred: false,
    }, 500);
  }
});
