import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from "npm:viem@2.39.0";
import { privateKeyToAccount } from "npm:viem@2.39.0/accounts";
import * as bitcoin from "npm:bitcoinjs-lib@7.0.0";
import * as ecc from "npm:tiny-secp256k1@2.2.3";
import { ECPairFactory } from "npm:ecpair@3.0.0";
import { VersionedTransaction, Transaction } from "npm:@solana/web3.js@1.98.4";
import { Turnkey } from "npm:@turnkey/sdk-server@1.5.0";
import { TurnkeySigner } from "npm:@turnkey/solana@1.0.0";

const ECPair = ECPairFactory(ecc);

function createTurnkeySolanaSigner() {
  const apiPublicKey = Deno.env.get("TURNKEY_API_PUBLIC_KEY") || "";
  const apiPrivateKey = Deno.env.get("TURNKEY_API_PRIVATE_KEY") || "";
  const organizationId = Deno.env.get("TURNKEY_ORGANIZATION_ID") || "";
  if (!apiPublicKey || !apiPrivateKey || !organizationId) {
    throw new Error("turnkey_solana_signer_not_configured");
  }
  const turnkey = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });
  return new TurnkeySigner({
    client: turnkey.apiClient() as any,
    organizationId,
  });
}
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const json = (x: unknown, s = 200) =>
  Response.json(x, { status: s, headers: { "cache-control": "no-store" } });

async function authorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data } = await supabase.rpc("get_bot_cron_token");
  return !!data && supplied === data;
}

async function hash(v: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}

function strictBigInt(name: string, value: unknown): bigint {
  if (value === undefined || value === null) throw new Error(`evm_${name}_missing`);
  const s = String(value);
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) throw new Error(`evm_${name}_invalid`);
  return BigInt(s);
}

const BSC_RPC = Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org";
const ETH_RPC = Deno.env.get("ETHEREUM_RPC_URL") || "https://cloudflare-eth.com";
const SOLANA_RPC = Deno.env.get("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";

// EVM signing uses chain-bound allowlists. Dedicated flash-executor signing remains fail-closed
// per chain until its deployment, immutable payout wallet, source verification, and payout audit are configured.
const BSC_PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const BSC_BISWAP_ROUTER_V2 = "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8";
const BSC_WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const ETH_UNISWAP_V2_ROUTER = "0x7a250d5630B4cf539739dF2C5dAcb4c659F2488D";
const ETH_SUSHISWAP_V2_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ENV_BSC_FLASH_EXECUTOR = (Deno.env.get("ARBIVAULT_BSC_FLASH_EXECUTOR") || "").trim();
let BSC_FLASH_EXECUTOR = ENV_BSC_FLASH_EXECUTOR;
const ENV_ETH_FLASH_EXECUTOR = (Deno.env.get("ARBIVAULT_ETH_FLASH_EXECUTOR") || "").trim();
let ETH_FLASH_EXECUTOR = ENV_ETH_FLASH_EXECUTOR;
const ENV_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED = Deno.env.get("ARBIVAULT_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED") === "true" || Deno.env.get("ARBIVAULT_FLASH_EXECUTOR_PAYOUT_AUDITED") === "true";
let BSC_FLASH_EXECUTOR_PAYOUT_AUDITED = ENV_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED;
const ENV_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED = Deno.env.get("ARBIVAULT_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED") === "true";
let ETH_FLASH_EXECUTOR_PAYOUT_AUDITED = ENV_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED;
const FLASH_EXECUTOR_ABI = parseAbi(["function executeFlashLoan(address asset,uint256 amount,uint256 minProfit,address[] targets,uint256[] values,bytes[] data)","function HOT_WALLET() view returns (address)"]);

async function syncExecutorRegistry() {
  const { data: rows, error } = await supabase
    .from("flash_executor_deployments")
    .select("chain,executor_address,status,source_verified,payout_audited")
    .in("chain", ["bnb", "ethereum"]);
  if (error) throw new Error("flash_executor_registry_lookup_failed");
  const bnb = (rows || []).find((row: any) => row.chain === "bnb") || null;
  const ethereum = (rows || []).find((row: any) => row.chain === "ethereum") || null;
  const usableStatuses = ["pending", "deployed_unverified", "verified"];
  BSC_FLASH_EXECUTOR = bnb
    ? (usableStatuses.includes(bnb.status) ? String(bnb.executor_address || "").trim() : "")
    : ENV_BSC_FLASH_EXECUTOR;
  ETH_FLASH_EXECUTOR = ethereum
    ? (usableStatuses.includes(ethereum.status) ? String(ethereum.executor_address || "").trim() : "")
    : ENV_ETH_FLASH_EXECUTOR;
  BSC_FLASH_EXECUTOR_PAYOUT_AUDITED = bnb
    ? (bnb.status === "verified" && bnb.source_verified === true && bnb.payout_audited === true)
    : ENV_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED;
  ETH_FLASH_EXECUTOR_PAYOUT_AUDITED = ethereum
    ? (ethereum.status === "verified" && ethereum.source_verified === true && ethereum.payout_audited === true)
    : ENV_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED;
}

const BSC_FLASH_ROUTER_ABI = parseAbi(["function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)"]);
const ETH_FLASH_ROUTER_ABI = parseAbi(["function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)"]);
const BSC_PANCAKE_V2_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
]);

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!response.ok) throw new Error("broadcast_rpc_http_" + response.status);
  const body = await response.json();
  if (body.error) throw new Error("broadcast_rpc_" + (body.error.code || "error"));
  return body.result;
}

async function broadcastSigned(chain: string, signed: string) {
  // Broadcast only serialized, signed transactions. Never accept unsigned payloads here.
  if (chain === "bnb" || chain === "ethereum") {
    const endpoint = chain === "ethereum" ? ETH_RPC : BSC_RPC;
    const label = chain === "ethereum" ? "ethereum" : "bsc";
    const txHash = await rpc(endpoint, "eth_sendRawTransaction", [signed]);
    if (!txHash) throw new Error(`${label}_broadcast_missing_tx_hash`);
    return String(txHash);
  }
  if (chain === "solana") {
    const txHash = await rpc(SOLANA_RPC, "sendTransaction", [signed, { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
    if (!txHash) throw new Error("solana_broadcast_missing_signature");
    return String(txHash);
  }
  if (chain === "bitcoin") {
    // bitcoinjs-lib returns a finalized PSBT; extract the raw network transaction
    // before submitting to a public Bitcoin relay.
    const psbt = bitcoin.Psbt.fromBase64(signed, { network: bitcoin.networks.bitcoin });
    const txHex = psbt.extractTransaction().toHex();
    const response = await fetch("https://mempool.space/api/tx", {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "text/plain" },
      body: txHex,
    });
    const body = (await response.text()).trim();
    if (!response.ok) throw new Error(`bitcoin_broadcast_http_${response.status}${body ? `_${body.slice(0, 160)}` : ""}`);
    if (!body) throw new Error("bitcoin_broadcast_missing_tx_hash");
    return body;
  }
  throw new Error("broadcast_chain_not_configured");
}

async function getSecret(id: string) {
  const { data, error } = await supabase.rpc("get_wallet_secret", { p_wallet_id: id });
  if (error || !data) throw new Error("wallet_secret_unavailable");
  return String(data);
}

function decode64(v: string) {
  return Uint8Array.from(atob(v), c => c.charCodeAt(0));
}

async function rotateFlaggedWallet(walletId: string) {
  const token = (await supabase.rpc("get_bot_cron_token")).data;
  if (!token) return { ok: false, error: "rotation_auth_unavailable" };
  try {
    const response = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/arbivault-wallet-rotation`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-arbivault-cron-token": String(token),
        },
        body: JSON.stringify({ wallet_id: walletId, trigger: "signer_contract_code_detection" }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const body = await response.json().catch(() => ({}));
    return { ...body, ok: response.ok && body?.ok === true, http_status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "wallet_rotation_unreachable",
    };
  }
}

function hasContractCode(code: string) {
  return /^0x[0-9a-f]*$/i.test(code) && !/^0x0*$/i.test(code);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    await syncExecutorRegistry();
    const b = await req.json();
    const adapterId = String(b.adapter_id || "");
    const walletId = String(b.source_wallet_id || "");
    const signingRequestId = String(b.signing_request_id || "");
    const chain = String(b.chain || "").toLowerCase();
    const unsigned = String(b.unsigned_transaction || "");
    const requestedMode = String(b.mode ?? "trade").toLowerCase();
    if (!["trade", "transfer"].includes(requestedMode)) {
      return json({ error: "invalid_signing_mode" }, 400);
    }
    const mode = requestedMode;

    if (
      !adapterId ||
      !walletId ||
      !signingRequestId ||
      !unsigned ||
      !["ethereum", "bnb", "solana", "bitcoin"].includes(chain)
    ) {
      return json({ error: "invalid_request" }, 400);
    }

    const { data: adapter, error: ae } = await supabase
      .from("execution_adapters")
      .select("*")
      .eq("id", adapterId)
      .maybeSingle();
    if (ae) return json({ error: ae.message }, 500);
    if (
      !adapter ||
      adapter.configured !== true ||
      adapter.automatic_signing !== true ||
      adapter.can_broadcast !== true ||
      adapter.signer_provider !== "internal_vault"
    ) {
      return json({ error: "adapter_not_authorized" }, 403);
    }

    if (
      adapter.allowed_wallet_id !== walletId ||
      adapter.signing_boundary !== "internal_vault"
    ) {
      return json({ error: "wallet_not_bound_to_internal_signer" }, 403);
    }

    const { data: wallet, error: we } = await supabase
      .from("wallets")
      .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status")
      .eq("id", walletId)
      .maybeSingle();
    if (we) return json({ error: "source_wallet_lookup_failed" }, 503);
    if (
      !wallet ||
      wallet.status !== "active" ||
      wallet.is_hot !== true ||
      wallet.wallet_role !== "trading_hot" ||
      wallet.chain !== chain
    ) {
      return json({ error: "source_wallet_not_active_trading_hot" }, 403);
    }

    // A hot wallet is not execution-eligible solely because its row is active.
    // Require verified provenance and an explicit, owner-scoped approval before
    // any signing or broadcast. Missing/ revoked approvals fail closed.
    if (wallet.data_quality_status !== "verified") {
      return json({ error: "source_wallet_not_verified" }, 403);
    }
    const { data: approvedWallet, error: approvalError } = await supabase
      .from("approved_wallets")
      .select("id")
      .eq("owner_id", wallet.owner_id)
      .eq("wallet_id", wallet.id)
      .eq("status", "approved")
      .maybeSingle();
    if (approvalError) return json({ error: "wallet_approval_lookup_failed" }, 503);
    if (!approvedWallet) {
      return json({ error: "source_wallet_not_approved" }, 403);
    }

    if (chain === "bnb" || chain === "ethereum") {
      const walletCode = String(await rpc(chain === "bnb" ? BSC_RPC : ETH_RPC, "eth_getCode", [wallet.address, "latest"]));
      if (hasContractCode(walletCode)) {
        const rotation = await rotateFlaggedWallet(walletId);
        const replacement = Array.isArray(rotation.rotated_wallets)
          ? rotation.rotated_wallets.find((item: any) => item.old_wallet_id === walletId) || null
          : null;
        return json({
          error: "source_wallet_is_contract_rotate_required",
          rotation_triggered: rotation.ok === true && !!replacement,
          replacement_wallet_id: replacement?.new_wallet_id || null,
          chain,
          rotation_error: rotation.ok === true ? null : rotation.error || rotation.errors?.[0]?.error || "wallet_rotation_failed",
          signing_blocked: true,
          broadcast_attempted: false,
        }, 409);
      }
    }

    if (String(adapter.signer_key_ref || "").toLowerCase() !== String(wallet.address).toLowerCase()) {
      return json({ error: "signer_wallet_mismatch" }, 403);
    }

    if (mode === "transfer") {
      return json({ error: "withdrawal_requires_human_approval" }, 403);
    }

    const payloadHash = await hash(unsigned);
    const { data: requestRow, error: re } = await supabase
      .from("signing_requests")
      .select(
        "id,owner_id,execution_attempt_id,chain,source_wallet_id,payload_hash,status,biometric_required,biometric_verified,approval_method,expires_at,approval_expires_at"
      )
      .eq("id", signingRequestId)
      .maybeSingle();

    if (re) return json({ error: re.message }, 500);
    if (!requestRow) return json({ error: "signing_request_not_found" }, 404);
    if (requestRow.owner_id !== wallet.owner_id) {
      return json({ error: "authorization_owner_mismatch" }, 403);
    }
    if (requestRow.source_wallet_id !== walletId || requestRow.chain !== chain) {
      return json({ error: "signing_request_wallet_mismatch" }, 403);
    }
    if (requestRow.payload_hash !== payloadHash) {
      return json({ error: "signing_payload_mismatch" }, 403);
    }
    if (requestRow.status !== "authorized") {
      return json({ error: "human_approval_required" }, 403);
    }
    if (requestRow.biometric_required !== true || requestRow.biometric_verified !== true) {
      return json({ error: "biometric_approval_required" }, 403);
    }
    const nowForApproval = Date.now();
    if (!requestRow.approval_expires_at || new Date(requestRow.approval_expires_at).getTime() <= nowForApproval) {
      return json({ error: "signing_approval_expired" }, 410);
    }
    if (requestRow.expires_at && new Date(requestRow.expires_at).getTime() <= nowForApproval) {
      return json({ error: "signing_request_expired" }, 410);
    }

    if (!requestRow.execution_attempt_id) {
      return json({ error: "execution_attempt_missing" }, 403);
    }
    const { data: attemptRow, error: attemptError } = await supabase
      .from("execution_attempts")
      .select("id,owner_id,adapter_id,chain,wallet_id,execution_mode,status,transaction_payload_hash")
      .eq("id", requestRow.execution_attempt_id)
      .maybeSingle();
    if (attemptError) return json({ error: "execution_attempt_lookup_failed" }, 500);
    if (
      !attemptRow ||
      attemptRow.owner_id !== wallet.owner_id ||
      attemptRow.adapter_id !== adapterId ||
      attemptRow.wallet_id !== walletId ||
      attemptRow.chain !== chain ||
      attemptRow.execution_mode !== "on_chain" ||
      attemptRow.status !== "validated" ||
      attemptRow.transaction_payload_hash !== payloadHash
    ) {
      return json({ error: "execution_attempt_authorization_mismatch" }, 403);
    }


    const { data: executionPolicy, error: executionPolicyError } = await supabase
      .from("arbivault_execution_policy")
      .select("enabled,starts_at,ends_at,mode")
      .eq("policy_key", "primary")
      .maybeSingle();
    if (executionPolicyError) return json({ error: "execution_policy_lookup_failed" }, 503);
    const policyNow = Date.now();
    if (
      !executionPolicy ||
      executionPolicy.enabled !== true ||
      !executionPolicy.starts_at ||
      new Date(executionPolicy.starts_at).getTime() > policyNow ||
      (executionPolicy.ends_at && new Date(executionPolicy.ends_at).getTime() <= policyNow)
    ) {
      return json({ error: "execution_policy_not_active", signing_blocked: true, broadcast_attempted: false }, 409);
    }

    const { data: latestBeforeSigning, error: latestBeforeSigningError } = await supabase
      .from("signing_requests")
      .select("status,tx_hash,broadcast_at")
      .eq("id", requestRow.id)
      .maybeSingle();
    if (latestBeforeSigningError) return json({ error: "signing_request_state_lookup_failed" }, 503);
    if (latestBeforeSigning?.status === "broadcast" && latestBeforeSigning.tx_hash) {
      return json({
        ok: true,
        signing_request_id: requestRow.id,
        provider: "internal_vault",
        chain,
        mode,
        tx_hash: String(latestBeforeSigning.tx_hash),
        signed: true,
        broadcast: true,
        idempotent_replay: true,
      });
    }
    if (latestBeforeSigning?.status !== "authorized") {
      return json({ error: "signing_request_already_claimed_or_not_authorized", signing_blocked: true }, 409);
    }

    const sv = chain === "solana" ? "" : await getSecret(walletId);
    let signed = "";

    if (chain === "bnb" || chain === "ethereum") {
      // Only structured, chain-bound EVM payloads are signable; router and
      // token paths are allowlisted separately for Ethereum mainnet and BNB.
      let candidate: any;
      try {
        candidate = JSON.parse(unsigned);
      } catch {
        return json({ error: "evm_transaction_must_be_structured_json" }, 400);
      }
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return json({ error: "evm_json_not_object" }, 400);
      }

      const to = String(candidate.to || "");
      if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
        return json({ error: "evm_destination_invalid" }, 400);
      }
      if (!candidate.from || String(candidate.from).toLowerCase() !== wallet.address.toLowerCase()) {
        return json({ error: "transaction_sender_mismatch" }, 403);
      }
      const expectedChainId = chain === "ethereum" ? 1 : 56;
      if (Number(candidate.chainId) !== expectedChainId) {
        return json({ error: "transaction_chain_id_mismatch" }, 403);
      }

      const allowed = Array.isArray(adapter.allowed_contracts)
        ? adapter.allowed_contracts.map((x: unknown) => String(x).toLowerCase())
        : [];
      const auditedBnbFlashTarget = chain === "bnb" && !!BSC_FLASH_EXECUTOR && to.toLowerCase() === BSC_FLASH_EXECUTOR.toLowerCase() && BSC_FLASH_EXECUTOR_PAYOUT_AUDITED;
      const auditedEthFlashTarget = chain === "ethereum" && !!ETH_FLASH_EXECUTOR && to.toLowerCase() === ETH_FLASH_EXECUTOR.toLowerCase() && ETH_FLASH_EXECUTOR_PAYOUT_AUDITED;
      if ((!allowed.length || !allowed.includes(to.toLowerCase())) && !auditedBnbFlashTarget && !auditedEthFlashTarget) {
        return json({ error: "destination_contract_not_allowlisted" }, 403);
      }
      const data = String(candidate.data || "");
      if (!/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) {
        return json({ error: "evm_calldata_invalid" }, 400);
      }
      const value = strictBigInt("value", candidate.value);
      const nowSec = BigInt(Math.floor(Date.now() / 1000));

      if (chain === "ethereum" && ETH_FLASH_EXECUTOR && to.toLowerCase() === ETH_FLASH_EXECUTOR.toLowerCase()) {
        if (!ETH_FLASH_EXECUTOR_PAYOUT_AUDITED) return json({ error: "ethereum_flash_executor_payout_audit_not_enabled" }, 403);
        const executorCode = String(await rpc(ETH_RPC, "eth_getCode", [ETH_FLASH_EXECUTOR, "latest"]));
        if (!hasContractCode(executorCode)) return json({ error: "ethereum_flash_executor_code_not_deployed" }, 403);
        if (value !== 0n) return json({ error: "ethereum_flash_executor_native_value_forbidden" }, 403);
        let flash: any;
        try { flash = decodeFunctionData({ abi: FLASH_EXECUTOR_ABI, data: data as `0x${string}` }); }
        catch { return json({ error: "ethereum_flash_executor_method_not_allowlisted" }, 403); }
        if (flash.functionName !== "executeFlashLoan") return json({ error: "ethereum_flash_executor_method_not_allowlisted" }, 403);
        const [asset, amount, minProfit, targets, values, calls] = flash.args as readonly [string,bigint,bigint,readonly string[],readonly bigint[],readonly string[]];
        const ethFlashRouters = [ETH_UNISWAP_V2_ROUTER.toLowerCase(), ETH_SUSHISWAP_V2_ROUTER.toLowerCase()];
        if (![ETH_WETH.toLowerCase(), ETH_USDC.toLowerCase()].includes(String(asset).toLowerCase()) ||
            amount <= 0n || minProfit <= 0n || targets.length !== 2 ||
            targets.length !== values.length || targets.length !== calls.length ||
            targets[0].toLowerCase() === targets[1].toLowerCase() ||
            targets.some((target) => !ethFlashRouters.includes(target.toLowerCase())) ||
            values.some((v) => v !== 0n)) {
          return json({ error: "ethereum_flash_executor_parameters_not_allowlisted" }, 403);
        }
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const deadlineMax = nowSec + 120n;
        const intermediate = String(asset).toLowerCase() === ETH_WETH.toLowerCase() ? ETH_USDC.toLowerCase() : ETH_WETH.toLowerCase();
        for (let i = 0; i < calls.length; i++) {
          let leg: any;
          try { leg = decodeFunctionData({ abi: ETH_FLASH_ROUTER_ABI, data: calls[i] as `0x${string}` }); }
          catch { return json({ error: "ethereum_flash_leg_method_not_allowlisted" }, 403); }
          if (leg.functionName !== "swapExactTokensForTokens") return json({ error: "ethereum_flash_leg_method_not_allowlisted" }, 403);
          const [amountIn, amountOutMin, path, recipient, deadline] = leg.args as readonly [bigint,bigint,readonly string[],string,bigint];
          if (amountIn <= 0n || amountOutMin <= 0n || path.length !== 2 ||
              recipient.toLowerCase() !== ETH_FLASH_EXECUTOR.toLowerCase() ||
              deadline <= nowSec || deadline > deadlineMax) {
            return json({ error: "ethereum_flash_leg_parameters_invalid" }, 403);
          }
          const a = path[0].toLowerCase(), z = path[1].toLowerCase();
          if (i === 0 && (a !== String(asset).toLowerCase() || z !== intermediate || amountIn !== amount)) {
            return json({ error: "ethereum_flash_first_leg_must_spend_borrowed_asset" }, 403);
          }
          if (i === 1 && (a !== intermediate || z !== String(asset).toLowerCase())) {
            return json({ error: "ethereum_flash_second_leg_must_return_borrowed_asset" }, 403);
          }
        }
        const getter = encodeFunctionData({ abi: FLASH_EXECUTOR_ABI, functionName: "HOT_WALLET" });
        const payoutRaw = String(await rpc(ETH_RPC, "eth_call", [{ to: ETH_FLASH_EXECUTOR, data: getter }, "latest"]));
        const payout = decodeFunctionResult({ abi: FLASH_EXECUTOR_ABI, functionName: "HOT_WALLET", data: payoutRaw as `0x${string}` }) as string;
        if (payout.toLowerCase() !== wallet.address.toLowerCase()) return json({ error: "ethereum_flash_executor_payout_wallet_mismatch" }, 403);
      } else if (chain === "bnb" && BSC_FLASH_EXECUTOR && to.toLowerCase() === BSC_FLASH_EXECUTOR.toLowerCase()) {
        if (!BSC_FLASH_EXECUTOR_PAYOUT_AUDITED) return json({ error: "flash_executor_payout_audit_not_enabled" }, 403);
        const executorCode = String(await rpc(BSC_RPC, "eth_getCode", [BSC_FLASH_EXECUTOR, "latest"]));
        if (executorCode === "0x" || executorCode === "0x0") return json({ error: "flash_executor_code_not_deployed" }, 403);
        if (value !== 0n) return json({ error: "flash_executor_native_value_forbidden" }, 403);
        let flash: any;
        try {
          flash = decodeFunctionData({ abi: FLASH_EXECUTOR_ABI, data: data as `0x${string}` });
        } catch {
          return json({ error: "flash_executor_method_not_allowlisted" }, 403);
        }
        if (flash.functionName !== "executeFlashLoan") return json({ error: "flash_executor_method_not_allowlisted" }, 403);
        const [asset, amount, minProfit, targets, values, calls] = flash.args as readonly [string,bigint,bigint,readonly string[],readonly bigint[],readonly string[]];
        const flashRouters = [BSC_PANCAKE_V2_ROUTER.toLowerCase(), BSC_BISWAP_ROUTER_V2.toLowerCase()];
        if (![BSC_WBNB.toLowerCase(), BSC_USDT.toLowerCase()].includes(String(asset).toLowerCase()) ||
            amount <= 0n || minProfit <= 0n || targets.length !== 2 ||
            targets.length !== values.length || targets.length !== calls.length ||
            targets[0].toLowerCase() === targets[1].toLowerCase() ||
            targets.some((target) => !flashRouters.includes(target.toLowerCase())) ||
            values.some((v) => v !== 0n)) {
          return json({ error: "flash_executor_parameters_not_allowlisted" }, 403);
        }
        const deadlineMax = nowSec + 600n;
        let sawForward = false;
        let sawReturn = false;
        let firstInput: string | null = null;
        let finalOutput: string | null = null;
        for (let i = 0; i < calls.length; i++) {
          const callData = calls[i];
          let leg: any;
          try { leg = decodeFunctionData({ abi: BSC_FLASH_ROUTER_ABI, data: callData as `0x${string}` }); }
          catch { return json({ error: "flash_leg_method_not_allowlisted" }, 403); }
          if (leg.functionName !== "swapExactTokensForTokens") return json({ error: "flash_leg_method_not_allowlisted" }, 403);
          const [amountIn, amountOutMin, path, recipient, deadline] = leg.args as readonly [bigint,bigint,readonly string[],string,bigint];
          if (amountIn <= 0n || amountOutMin <= 0n || path.length !== 2 ||
              recipient.toLowerCase() !== BSC_FLASH_EXECUTOR.toLowerCase() ||
              deadline <= nowSec || deadline > deadlineMax) {
            return json({ error: "flash_leg_parameters_invalid" }, 403);
          }
          const a = String(path[0]).toLowerCase(), z = String(path[1]).toLowerCase();
          if (i === 0) {
            firstInput = a;
            if (a !== String(asset).toLowerCase() ||
                z !== (a === BSC_USDT.toLowerCase() ? BSC_WBNB.toLowerCase() : BSC_USDT.toLowerCase()) ||
                amountIn !== amount) {
              return json({ error: "flash_first_leg_must_spend_borrowed_asset" }, 403);
            }
          } else {
            finalOutput = z;
            if (a !== (String(asset).toLowerCase() === BSC_USDT.toLowerCase() ? BSC_WBNB.toLowerCase() : BSC_USDT.toLowerCase()) ||
                z !== String(asset).toLowerCase()) {
              return json({ error: "flash_second_leg_must_return_borrowed_asset" }, 403);
            }
          }
          if (a === BSC_USDT.toLowerCase() && z === BSC_WBNB.toLowerCase()) sawForward = true;
          if (a === BSC_WBNB.toLowerCase() && z === BSC_USDT.toLowerCase()) sawReturn = true;
          if (!((a === BSC_USDT.toLowerCase() && z === BSC_WBNB.toLowerCase()) ||
                (a === BSC_WBNB.toLowerCase() && z === BSC_USDT.toLowerCase()))) {
            return json({ error: "flash_leg_path_not_allowlisted" }, 403);
          }
        }
        if (!sawForward || !sawReturn || !firstInput || !finalOutput || firstInput !== String(asset).toLowerCase() || finalOutput !== String(asset).toLowerCase()) {
          return json({ error: "flash_round_trip_incomplete_or_asset_mismatch" }, 403);
        }
        const getter = encodeFunctionData({ abi: FLASH_EXECUTOR_ABI, functionName: "HOT_WALLET" });
        const payoutRaw = String(await rpc(BSC_RPC, "eth_call", [{ to: BSC_FLASH_EXECUTOR, data: getter }, "latest"]));
        const payout = decodeFunctionResult({ abi: FLASH_EXECUTOR_ABI, functionName: "HOT_WALLET", data: payoutRaw as `0x${string}` }) as string;
        if (payout.toLowerCase() !== wallet.address.toLowerCase()) return json({ error: "flash_executor_payout_wallet_mismatch" }, 403);
      } else {
        const approvedRouter = chain === "ethereum" ? ETH_UNISWAP_V2_ROUTER : BSC_PANCAKE_V2_ROUTER;
        if (to.toLowerCase() !== approvedRouter.toLowerCase()) {
          return json({ error: "evm_destination_has_no_approved_method_policy" }, 403);
        }
        let decoded: any;
        try {
          decoded = decodeFunctionData({ abi: BSC_PANCAKE_V2_ABI, data: data as `0x${string}` });
        } catch {
          return json({ error: "evm_method_not_allowlisted" }, 403);
        }
        const args = decoded.args as readonly unknown[];
        const deadline = strictBigInt("deadline", decoded.functionName === "swapExactETHForTokens" ? args[3] : args[4]);
        if (deadline <= nowSec || deadline > nowSec + 600n) return json({ error: "swap_deadline_invalid_or_stale" }, 409);
        const recipient = String(decoded.functionName === "swapExactETHForTokens" ? args[2] : args[3]).toLowerCase();
        if (recipient !== wallet.address.toLowerCase()) return json({ error: "swap_recipient_must_be_source_hot_wallet" }, 403);

        const tokenIn = chain === "ethereum" ? ETH_USDC : BSC_USDT;
        const nativeWrapped = chain === "ethereum" ? ETH_WETH : BSC_WBNB;
        const prefix = chain === "ethereum" ? "eth_usdc" : "bnb_usdt";
        if (decoded.functionName === "swapExactETHForTokens") {
          const amountOutMin = strictBigInt("amount_out_min", args[0]);
          const path = args[1] as readonly string[];
          if (amountOutMin <= 0n || value <= 0n || path.length !== 2 ||
              String(path[0]).toLowerCase() !== nativeWrapped.toLowerCase() ||
              String(path[1]).toLowerCase() !== tokenIn.toLowerCase()) return json({ error: `${prefix}_buy_path_invalid` }, 403);
        } else if (decoded.functionName === "swapExactTokensForETH") {
          const amountIn = strictBigInt("amount_in", args[0]);
          const amountOutMin = strictBigInt("amount_out_min", args[1]);
          const path = args[2] as readonly string[];
          if (amountIn <= 0n || amountOutMin <= 0n || value !== 0n || path.length !== 2 ||
              String(path[0]).toLowerCase() !== tokenIn.toLowerCase() ||
              String(path[1]).toLowerCase() !== nativeWrapped.toLowerCase()) return json({ error: `${prefix}_sell_path_invalid` }, 403);
        } else return json({ error: "evm_method_not_allowlisted" }, 403);
      }

      let nonce: bigint;
      let gas: bigint;
      let gasPrice: bigint;
      try {
        nonce = strictBigInt("nonce", candidate.nonce);
        gas = strictBigInt("gas", candidate.gas);
        gasPrice = strictBigInt("gasPrice", candidate.gasPrice);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "evm_fee_fields_invalid" }, 400);
      }
      if (gas <= 0n || gasPrice <= 0n) {
        return json({ error: "evm_fee_fields_invalid" }, 400);
      }

      const account = privateKeyToAccount(sv as `0x${string}`);
      if (account.address.toLowerCase() !== wallet.address.toLowerCase()) {
        return json({ error: "signer_secret_address_mismatch" }, 403);
      }
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        return json({ error: "evm_nonce_out_of_range" }, 400);
      }
      const tx = {
        chainId: expectedChainId,
        nonce: Number(nonce),
        to: to as `0x${string}`,
        value,
        data: data as `0x${string}`,
        gas,
        gasPrice,
      };
      signed = await account.signTransaction(tx);
    } else if (chain === "solana") {
      const raw = decode64(unsigned);
      let versioned: VersionedTransaction | null = null;
      try {
        versioned = VersionedTransaction.deserialize(raw);
      } catch {
        versioned = null;
      }
      const turnkeySigner = createTurnkeySolanaSigner();
      if (versioned) {
        const message: any = versioned.message;
        const required = Number(message?.header?.numRequiredSignatures || 0);
        const staticKeys: any[] = message?.staticAccountKeys || [];
        if (
          required < 1 ||
          staticKeys[0]?.toBase58() !== wallet.address ||
          !staticKeys.slice(0, required).some((key: any) => key.toBase58() === wallet.address)
        ) {
          return json({ error: "solana_fee_payer_or_signer_mismatch" }, 403);
        }
        const signedVersioned = await turnkeySigner.signTransaction(versioned, wallet.address) as VersionedTransaction;
        if (!signedVersioned.signatures?.length || signedVersioned.signatures.every((sig: Uint8Array) => sig.every((byte) => byte === 0))) {
          return json({ error: "turnkey_solana_signature_missing" }, 502);
        }
        signed = btoa(String.fromCharCode(...signedVersioned.serialize()));
      } else {
        let legacy: Transaction;
        try {
          legacy = Transaction.from(raw);
        } catch {
          return json({ error: "solana_transaction_decode_failed" }, 400);
        }
        if (!legacy.feePayer || legacy.feePayer.toBase58() !== wallet.address) {
          return json({ error: "solana_fee_payer_or_signer_mismatch" }, 403);
        }
        const signedLegacy = await turnkeySigner.signTransaction(legacy, wallet.address) as Transaction;
        const signature = signedLegacy.signatures.find((item: any) => item.publicKey.toBase58() === wallet.address)?.signature;
        if (!signature || signature.every((byte: number) => byte === 0)) {
          return json({ error: "turnkey_solana_signature_missing" }, 502);
        }
        signed = btoa(String.fromCharCode(...signedLegacy.serialize()));
      }
    } else {
      const psbt = bitcoin.Psbt.fromBase64(unsigned, { network: bitcoin.networks.bitcoin });
      const key = ECPair.fromWIF(sv, bitcoin.networks.bitcoin);
      const network = bitcoin.networks.bitcoin;
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network });
      const keyAddresses = [
        bitcoin.payments.p2pkh({ pubkey: key.publicKey, network }).address,
        p2wpkh.address,
        bitcoin.payments.p2sh({ redeem: p2wpkh, network }).address,
      ].filter((address): address is string => typeof address === "string");
      if (!keyAddresses.includes(wallet.address)) {
        return json({ error: "signer_secret_address_mismatch" }, 403);
      }
      if (psbt.txInputs.length === 0 || psbt.txOutputs.length === 0) {
        return json({ error: "bitcoin_transaction_shape_invalid" }, 400);
      }
      psbt.signAllInputs(key);
      const signaturesValid = psbt.validateSignaturesOfAllInputs((pubkey, messageHash, signature) => {
        try {
          // BIP340/Taproot uses x-only public keys; legacy ECDSA uses compressed keys.
          return pubkey.length === 32
            ? ecc.verifySchnorr(messageHash, pubkey, signature)
            : ecc.verify(messageHash, pubkey, signature);
        } catch {
          return false;
        }
      });
      if (!signaturesValid) {
        return json({ error: "bitcoin_signature_validation_failed" }, 500);
      }
      psbt.finalizeAllInputs();
      signed = psbt.toBase64();
    }

    const now = new Date().toISOString();
    // Recheck the active EVM wallet immediately before network submission.
    // If code appeared after preflight, quarantine/rotate and do not broadcast.
    if (chain === "bnb" || chain === "ethereum") {
      const endpoint = chain === "bnb" ? BSC_RPC : ETH_RPC;
      const latestCode = String(await rpc(endpoint, "eth_getCode", [wallet.address, "latest"]));
      if (hasContractCode(latestCode)) {
        const rotation = await rotateFlaggedWallet(walletId);
        const replacement = Array.isArray(rotation.rotated_wallets)
          ? rotation.rotated_wallets.find((item: any) => item.old_wallet_id === walletId) || null
          : null;
        return json({
          error: "source_wallet_contract_code_detected_before_broadcast",
          rotation_triggered: rotation.ok === true && !!replacement,
          replacement_wallet_id: replacement?.new_wallet_id || null,
          chain,
          rotation_error: rotation.ok === true ? null : rotation.error || rotation.errors?.[0]?.error || "wallet_rotation_failed",
          signed: true,
          broadcast_attempted: false,
        }, 409);
      }
    }

    const txHash = await broadcastSigned(chain, signed);
    const broadcastAt = new Date().toISOString();

    const { error: markError } = await supabase
      .from("signing_requests")
      .update({ status: "broadcast", signed_at: now, broadcast_at: broadcastAt, tx_hash: txHash })
      .eq("id", requestRow.id)
      .eq("status", "authorized");

    if (markError) {
      // The network broadcast already succeeded. Persist the execution attempt too,
      // then return success with an explicit persistence warning instead of causing
      // the caller to retry and potentially rebroadcast the same nonce.
      if (requestRow.execution_attempt_id) {
        await supabase.from("execution_attempts").update({
          status: "broadcast",
          tx_hash: txHash,
          signed_at: now,
          broadcast_at: broadcastAt,
          updated_at: broadcastAt,
          failure_reason: null,
        }).eq("id", requestRow.execution_attempt_id);
      }
      return json({
        ok: true,
        signing_request_id: requestRow.id,
        provider: "internal_vault",
        chain,
        mode,
        tx_hash: txHash,
        signed: true,
        broadcast: true,
        state_persisted: false,
      }, 202);
    }

    await supabase
      .from("execution_adapters")
      .update({
        last_signed_at: now,
        last_broadcast_at: broadcastAt,
        health_status: "healthy",
        last_error: null,
        updated_at: broadcastAt,
      })
      .eq("id", adapter.id);

    return json({
      ok: true,
      signing_request_id: requestRow.id,
      provider: "internal_vault",
      chain,
      mode,
      tx_hash: txHash,
      signed: true,
      broadcast: true,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "internal_signer_error" }, 500);
  }
});