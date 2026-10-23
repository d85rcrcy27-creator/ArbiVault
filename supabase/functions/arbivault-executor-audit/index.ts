import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "npm:viem@2.39.0";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const userClient = (authorization: string) => createClient(URL, ANON, {
  global: { headers: { Authorization: authorization } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
// Discover an already-deployed executor by configured address even without a local deployment row.
// This removes registry presence as a discovery prerequisite, not live verification safeguards.
const ENV_EXECUTORS: Record<string, string> = {
  bnb: (Deno.env.get("ARBIVAULT_BSC_FLASH_EXECUTOR") || "").trim(),
  ethereum: (Deno.env.get("ARBIVAULT_ETH_FLASH_EXECUTOR") || "").trim(),
};
const CONFIGS = [
  { chain: "bnb", chainId: 56, pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", rpc: Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org" },
  { chain: "ethereum", chainId: 1, pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", rpc: Deno.env.get("ETHEREUM_RPC_URL") || "https://ethereum-rpc.publicnode.com" },
] as const;
const abi = parseAbi(["function HOT_WALLET() view returns (address)", "function PROFIT_RECIPIENT() view returns (address)", "function POOL() view returns (address)"]);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS", "cache-control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

async function rpc(config: typeof CONFIGS[number], method: string, params: unknown[] = []) {
  const response = await fetch(config.rpc, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("rpc_http_" + response.status);
  const body = await response.json();
  if (body?.error || body?.result == null) throw new Error("rpc_result_unavailable");
  return body.result;
}
async function readGetter(config: typeof CONFIGS[number], address: Address, functionName: "HOT_WALLET" | "PROFIT_RECIPIENT" | "POOL") {
  const data = encodeFunctionData({ abi, functionName });
  const raw = String(await rpc(config, "eth_call", [{ to: address, data }, "latest"]));
  return decodeFunctionResult({ abi, functionName, data: raw as Hex }) as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(authorization)) return json({ ok: false, error: "authentication_required" }, 401);
  const { data: authData, error: authError } = await userClient(authorization).auth.getUser();
  if (authError || !authData.user) return json({ ok: false, error: "authentication_invalid" }, 401);

  const audits = [];
  for (const config of CONFIGS) {
    const base = { chain: config.chain, chain_id: config.chainId, executor_address: null as string | null, deployment_tx_hash: null as string | null, runtime_bytecode_hash: null as string | null, status: "not_deployed", source_verified: false, payout_audited: false, payout_behavior_verified: false, checks: {} as Record<string, boolean>, failure_code: null as string | null };
    const { data: deployment, error: registryError } = await admin.from("flash_executor_deployments")
      .select("chain,chain_id,contract_name,executor_address,deployment_tx_hash,deployer_address,deployment_nonce,hot_wallet_id,hot_wallet_address,profit_recipient_wallet_id,profit_recipient_address,pool_address,contract_source_blob_sha,init_code_hash,runtime_bytecode_hash,status,source_verified,payout_audited,payout_behavior_verified,failure_code,github_workflow_ref,github_run_id,created_at,updated_at")
      .eq("chain", config.chain).maybeSingle();
    let outcome: string = "not_deployed";
    if (registryError) {
      outcome = "registry_error";
      base.failure_code = "deployment_registry_lookup_failed";
    } else {
      const candidateAddress = String(deployment?.executor_address || ENV_EXECUTORS[config.chain] || "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(candidateAddress)) {
        base.checks = { registry_entry_present: !!deployment?.executor_address, configured_candidate_present: false, runtime_code_present: false, source_verified: false, payout_audited: false, payout_behavior_verified: false };
        base.failure_code = "no_executor_candidate_configured";
        outcome = "no_candidate";
      } else {
      const registryBacked = !!deployment?.executor_address;
      base.executor_address = candidateAddress;
      base.deployment_tx_hash = deployment?.deployment_tx_hash || null;
      base.runtime_bytecode_hash = deployment?.runtime_bytecode_hash || null;
      base.source_verified = deployment?.source_verified === true;
      base.payout_audited = deployment?.payout_audited === true;
      base.payout_behavior_verified = deployment?.payout_behavior_verified === true;
      base.status = registryBacked ? String(deployment.status) : "external_candidate_unverified";
      try {
        const liveChainId = Number(BigInt(String(await rpc(config, "eth_chainId"))));
        const code = String(await rpc(config, "eth_getCode", [base.executor_address, "latest"]));
        const runtimeCodePresent = /^0x[0-9a-f]+$/i.test(code) && code.length > 2;
        let hotWalletMatch = false;
        let profitRecipientMatch = false;
        let profitRecipientProfileActive = false;
        let profitRecipientDistinct = false;
        let poolMatch = false;
        let runtimeHashMatch = false;
        let hotWalletRecordValid = false;
        if (runtimeCodePresent) {
          const [hotWallet, profitRecipient, pool] = await Promise.all([
            readGetter(config, base.executor_address as Address, "HOT_WALLET"),
            readGetter(config, base.executor_address as Address, "PROFIT_RECIPIENT"),
            readGetter(config, base.executor_address as Address, "POOL"),
          ]);
          if (deployment?.hot_wallet_id && deployment?.profit_recipient_wallet_id && deployment?.hot_wallet_address && deployment?.profit_recipient_address) {
            const [tradingResult, recipientResult] = await Promise.all([
              admin.from("wallets").select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
                .eq("id", deployment.hot_wallet_id).maybeSingle(),
              admin.from("wallets").select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
                .eq("id", deployment.profit_recipient_wallet_id).maybeSingle(),
            ]);
            const trading = tradingResult.data;
            const recipient = recipientResult.data;
            hotWalletRecordValid = !tradingResult.error && !!trading && trading.status === "active" &&
              trading.chain === config.chain && trading.is_hot === true && trading.wallet_role === "trading_hot" &&
              trading.data_quality_status === "verified" && !!trading.secret_ref &&
              String(trading.address).toLowerCase() === String(deployment.hot_wallet_address).toLowerCase();
            hotWalletMatch = hotWalletRecordValid && hotWallet.toLowerCase() === String(deployment.hot_wallet_address).toLowerCase();
            const recipientValid = !recipientResult.error && !!recipient && recipient.status === "active" &&
              recipient.chain === config.chain && recipient.is_hot === false && recipient.wallet_role === "profit_recipient" &&
              recipient.data_quality_status === "verified" && !!recipient.secret_ref &&
              /^0x[a-fA-F0-9]{40}$/.test(String(recipient.address || "")) &&
              String(recipient.address).toLowerCase() === String(deployment.profit_recipient_address).toLowerCase();
            profitRecipientDistinct = !!recipient && String(recipient.address).toLowerCase() !== String(deployment.hot_wallet_address).toLowerCase();
            if (recipientValid && recipient) {
              const { data: profile, error: profileError } = await admin.from("profit_recipient_profiles")
                .select("id,owner_id,wallet_id,chain,asset,status,activation_at")
                .eq("owner_id", recipient.owner_id).eq("wallet_id", recipient.id)
                .eq("chain", config.chain).eq("asset", "ALL").eq("status", "active").maybeSingle();
              profitRecipientProfileActive = !profileError && !!profile &&
                (!profile.activation_at || new Date(profile.activation_at).getTime() <= Date.now());
            }
            profitRecipientMatch = recipientValid && profitRecipientProfileActive && profitRecipientDistinct &&
              profitRecipient.toLowerCase() === String(deployment.profit_recipient_address).toLowerCase();
          }
          poolMatch = pool.toLowerCase() === config.pool.toLowerCase() &&
            (!deployment?.pool_address || String(deployment.pool_address).toLowerCase() === config.pool.toLowerCase());
          runtimeHashMatch = deployment?.runtime_bytecode_hash
            ? keccak256(code as Hex).toLowerCase() === String(deployment.runtime_bytecode_hash).toLowerCase()
            : false;
        }
        const payoutAuditMatchesCurrentWallets = base.source_verified && runtimeHashMatch && hotWalletMatch && profitRecipientMatch && poolMatch;
        base.checks = {
          registry_entry_present: registryBacked,
          configured_candidate_present: true,
          chain_id_match: liveChainId === config.chainId && (!deployment?.chain_id || Number(deployment.chain_id) === config.chainId),
          runtime_code_present: runtimeCodePresent,
          runtime_bytecode_hash_match: runtimeHashMatch,
          hot_wallet_record_valid: hotWalletRecordValid,
          hot_wallet_match: hotWalletMatch,
          profit_recipient_profile_active: profitRecipientProfileActive,
          profit_recipient_distinct_from_trading_wallet: profitRecipientDistinct,
          profit_recipient_match: profitRecipientMatch,
          pool_match: poolMatch,
          source_verified: base.source_verified,
          payout_audit_consistent_with_current_wallets: base.payout_audited && payoutAuditMatchesCurrentWallets,
          payout_behavior_verified: base.payout_behavior_verified,
        };
        const allChecks = Object.values(base.checks).every(Boolean);
        // Never label an external candidate verified without a registry-backed bytecode baseline and payout audit.
        outcome = allChecks && registryBacked ? "verified" : "candidate_unverified";
        if (!runtimeCodePresent) base.failure_code = "executor_runtime_bytecode_missing";
        else if (!base.checks.chain_id_match) base.failure_code = "chain_id_mismatch";
        else if (!registryBacked) base.failure_code = "candidate_requires_registry_audit_baseline";
        else if (!runtimeHashMatch) base.failure_code = "runtime_bytecode_hash_mismatch";
        else if (!runtimeHashMatch) base.failure_code = "runtime_bytecode_hash_mismatch";
        else if (!hotWalletRecordValid || !hotWalletMatch) base.failure_code = "executor_trading_wallet_mismatch_or_unverified";
        else if (!profitRecipientProfileActive || !profitRecipientDistinct || !profitRecipientMatch) base.failure_code = "executor_profit_destination_missing_inactive_or_mismatched";
        else if (!poolMatch) base.failure_code = "executor_pool_mismatch";
        else if (!base.source_verified) base.failure_code = "source_not_verified";
        else if (!base.payout_audited || !payoutAuditMatchesCurrentWallets) base.failure_code = "payout_not_audited_or_wallets_changed";
        else if (!base.payout_behavior_verified) base.failure_code = "payout_behavior_not_verified";
      } catch {
        outcome = "rpc_unavailable";
        base.failure_code = "live_chain_audit_unavailable";
        base.checks = { registry_entry_present: registryBacked, configured_candidate_present: true, live_chain_checks_completed: false };
      }
      }
    }
    const record = {
      actor_id: authData.user.id,
      chain: config.chain,
      chain_id: config.chainId,
      outcome,
      executor_address: base.executor_address,
      deployment_tx_hash: base.deployment_tx_hash,
      runtime_bytecode_hash: base.runtime_bytecode_hash,
      checks: base.checks,
      failure_code: base.failure_code,
    };
    const { data: auditRecord, error: auditError } = await admin.from("executor_audit_events").insert(record)
      .select("id,chain,chain_id,outcome,executor_address,deployment_tx_hash,runtime_bytecode_hash,checks,failure_code,checked_at").single();
    audits.push({ ...base, outcome, audit_record: auditError ? null : auditRecord, audit_record_error: auditError ? "audit_record_persistence_failed" : null,
      deployment: deployment ? {
        contract_name: deployment.contract_name, deployer_address: deployment.deployer_address,
        deployment_nonce: deployment.deployment_nonce, contract_source_blob_sha: deployment.contract_source_blob_sha,
        init_code_hash: deployment.init_code_hash, github_workflow_ref: deployment.github_workflow_ref,
        github_run_id: deployment.github_run_id, created_at: deployment.created_at, updated_at: deployment.updated_at,
      } : null,
      candidate_source: deployment?.executor_address ? "registry" : (ENV_EXECUTORS[config.chain] ? "environment_config" : "none") });
  }
  return json({ ok: true, audited_at: new Date().toISOString(), records: audits });
});
