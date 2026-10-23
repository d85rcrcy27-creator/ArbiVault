import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.0.11";
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getContractAddress,
  keccak256, parseAbi, parseAbiParameters,
  type Address, type Hex,
} from "npm:viem@2.39.0";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2.39.0/accounts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const REPOSITORY = "d85rcrcy27-creator/ArbiVault";
const REPOSITORY_ID = "1398360252";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "arbivault-executor-deployer";
const PROVISION_WORKFLOW = REPOSITORY + "/.github/workflows/provision-executor-signers.yml@refs/heads/main";
const PROVISION_CONFIRM_PHRASE = "PROVISION_EXECUTOR_SIGNER";
const JWKS = createRemoteJWKSet(new URL(OIDC_ISSUER + "/.well-known/jwks"));

const BSC = {
  chain: "bnb", chainId: 56,
  workflow: REPOSITORY + "/.github/workflows/deploy-bnb-flash-executor.yml@refs/heads/main",
  confirmPhrase: "DEPLOY_TO_BSC_MAINNET",
  contractName: "ArbiVaultFlashExecutor",
  sourceBlobSha: "4ba59361fa0a125db5d1e538707e8b0932d5c453",
  walletId: "",
  hotWallet: "",
  profitRecipientWalletId: "",
  profitRecipient: "",
  pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
  rpc: Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org",
};
const ETH = {
  chain: "ethereum", chainId: 1,
  workflow: REPOSITORY + "/.github/workflows/deploy-ethereum-flash-executor.yml@refs/heads/main",
  confirmPhrase: "DEPLOY_TO_ETHEREUM_MAINNET",
  contractName: "ArbiVaultEthereumFlashExecutor",
  sourceBlobSha: "4f260f58ffe7201cc478db7752f4622d8df571ac",
  walletId: "",
  hotWallet: "",
  profitRecipientWalletId: "",
  profitRecipient: "",
  pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  rpc: Deno.env.get("ETHEREUM_RPC_URL") || "https://ethereum-rpc.publicnode.com",
};
type ChainConfig = typeof BSC | typeof ETH;
const CONFIGS = new Map<string, ChainConfig>([["bnb", BSC], ["ethereum", ETH]]);
const EXECUTOR_ABI = parseAbi([
  "function HOT_WALLET() view returns (address)",
  "function PROFIT_RECIPIENT() view returns (address)",
  "function POOL() view returns (address)",
]);
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
function fail(error: string, status = 400, details: Record<string, unknown> = {}) {
  return json({ ok: false, error, ...details }, status);
}
function normalizeHexBytecode(input: unknown): Hex {
  if (typeof input !== "string") throw new Error("creation_bytecode_missing");
  const normalized = input.startsWith("0x") ? input : "0x" + input;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(normalized) || normalized.length < 1000) throw new Error("creation_bytecode_invalid");
  if (/__\$[0-9a-fA-F]{34}\$__/.test(normalized)) throw new Error("creation_bytecode_has_unlinked_libraries");
  return normalized as Hex;
}
function buildInitCode(bytecode: Hex, config: ChainConfig): Hex {
  const args = encodeAbiParameters(parseAbiParameters("address pool, address hotWallet, address profitRecipient"), [
    config.pool as Address, config.hotWallet as Address, config.profitRecipient as Address,
  ]);
  return (bytecode + args.slice(2)) as Hex;
}
async function authorizeGithub(req: Request, expectedWorkflow: string) {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("github_oidc_bearer_required");
  const verified = await jwtVerify(match[1], JWKS, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });
  const p = verified.payload;
  if (
    p.repository !== REPOSITORY ||
    String(p.repository_id || "") !== REPOSITORY_ID ||
    p.ref !== "refs/heads/main" ||
    p.workflow_ref !== expectedWorkflow ||
    String(p.event_name || "") !== "workflow_dispatch"
  ) throw new Error("github_oidc_claims_not_allowed");
  return {
    workflowRef: String(p.workflow_ref),
    runId: String(p.run_id || ""),
    actor: String(p.actor || ""),
    sha: String(p.sha || ""),
    eventName: String(p.event_name || ""),
  };
}
async function rpc(config: ChainConfig, method: string, params: unknown[]) {
  const response = await fetch(config.rpc, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(config.chain + "_rpc_http_" + response.status);
  const body = await response.json();
  if (body?.error) throw new Error(config.chain + "_rpc_error_" + (body.error.code ?? "unknown"));
  if (body?.result === undefined || body?.result === null) throw new Error(config.chain + "_rpc_result_missing");
  return body.result;
}
async function getDeploymentAccount(config: ChainConfig, provisionIfMissing = false) {
  const selectSigner = () => supabase.from("executor_deployment_signers")
    .select("chain,chain_id,signer_address,status")
    .eq("chain", config.chain)
    .maybeSingle();

  const { data: initialSigner, error: initialError } = await selectSigner();
  if (initialError) throw new Error("deployment_signer_registry_lookup_failed");

  let signer = initialSigner;
  let created = false;
  if (!signer && provisionIfMissing) {
    const privateKey = generatePrivateKey();
    const candidate = privateKeyToAccount(privateKey);
    if ([BSC.hotWallet, ETH.hotWallet].some(
      (address) => address.toLowerCase() === candidate.address.toLowerCase()
    )) {
      throw new Error("deployment_signer_matches_trading_wallet");
    }

    const { data: stored, error: storeError } = await supabase.rpc("store_executor_deployment_signer", {
      p_chain: config.chain,
      p_signer_address: candidate.address,
      p_secret: privateKey,
    });
    if (storeError || !stored?.ok) throw new Error("deployment_signer_vault_store_failed");
    created = stored.created === true;

    const { data: refreshedSigner, error: refreshError } = await selectSigner();
    if (refreshError || !refreshedSigner) throw new Error("deployment_signer_registry_reload_failed");
    signer = refreshedSigner;
  }

  if (!signer) throw new Error("deployment_signer_not_provisioned");
  if (signer.status !== "active" || Number(signer.chain_id) !== config.chainId) {
    throw new Error("deployment_signer_configuration_invalid");
  }

  const { data: secret, error: secretError } = await supabase.rpc(
    "get_executor_deployment_signer_secret",
    { p_chain: config.chain },
  );
  if (secretError || typeof secret !== "string") throw new Error("deployment_signer_secret_unavailable");

  const normalized = secret.startsWith("0x") ? secret : "0x" + secret;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("deployment_signer_secret_format_invalid");

  let account;
  try {
    account = privateKeyToAccount(normalized as Hex);
  } catch {
    throw new Error("deployment_signer_secret_invalid");
  }

  if (account.address.toLowerCase() !== String(signer.signer_address).toLowerCase()) {
    throw new Error("deployment_signer_address_mismatch");
  }
  if ([BSC.hotWallet, ETH.hotWallet].some(
    (address) => address.toLowerCase() === account.address.toLowerCase()
  )) {
    throw new Error("deployment_signer_matches_trading_wallet");
  }

  return { account, created };
}
async function verifyHotWalletRecord(config: ChainConfig) {
  const { data, error } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
    .eq("id", config.walletId).maybeSingle();
  if (error || !data) throw new Error("approved_hot_wallet_record_unavailable");
  if (data.chain !== config.chain || data.status !== "active" || data.is_hot !== true ||
      data.wallet_role !== "trading_hot" || data.data_quality_status !== "verified" ||
      !data.secret_ref || String(data.address).toLowerCase() !== config.hotWallet.toLowerCase()) {
    throw new Error("approved_hot_wallet_configuration_mismatch");
  }
  const { data: approval, error: approvalError } = await supabase.from("approved_wallets")
    .select("id").eq("owner_id", data.owner_id).eq("wallet_id", data.id).eq("status", "approved").maybeSingle();
  if (approvalError || !approval) throw new Error("approved_hot_wallet_approval_missing");
  const { data: recipientProfile, error: profileError } = await supabase.from("profit_recipient_profiles")
    .select("id,owner_id,wallet_id,chain,asset,status,activation_at")
    .eq("owner_id", data.owner_id).eq("wallet_id", config.profitRecipientWalletId)
    .eq("chain", config.chain).eq("asset", "ALL").eq("status", "active").maybeSingle();
  if (profileError || !recipientProfile ||
      (recipientProfile.activation_at && new Date(recipientProfile.activation_at).getTime() > Date.now())) {
    throw new Error("active_all_asset_profit_recipient_profile_required");
  }
  const { data: recipient, error: recipientError } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
    .eq("id", recipientProfile.wallet_id).maybeSingle();
  if (recipientError || !recipient || recipient.owner_id !== data.owner_id ||
      recipient.chain !== config.chain || recipient.status !== "active" || recipient.is_hot !== false ||
      recipient.wallet_role !== "profit_recipient" || recipient.data_quality_status !== "verified" ||
      !recipient.secret_ref || String(recipient.address).toLowerCase() !== config.profitRecipient.toLowerCase() ||
      String(recipient.address).toLowerCase() === String(data.address).toLowerCase()) {
    throw new Error("active_profit_recipient_wallet_mismatch");
  }
}
async function resolveChainWalletConfig(config: ChainConfig): Promise<ChainConfig> {
  const { data: bots, error: botError } = await supabase.from("arbivault_strategy_bots")
    .select("id,owner_id,enabled,execution_enabled,flash_loan_enabled,chains")
    .eq("owner_id", config.ownerId)
    .eq("strategy", "flash_loan_arbitrage")
    .eq("enabled", true).eq("execution_enabled", true).eq("flash_loan_enabled", true);
  if (botError) throw new Error("atomic_flash_strategy_lookup_failed");
  const bot = (bots || []).find((candidate: any) => Array.isArray(candidate.chains) && candidate.chains.includes(config.chain));
  if (!bot) throw new Error("enabled_atomic_flash_strategy_missing_for_chain");
  const { data: bindings, error: bindingError } = await supabase.from("arbivault_strategy_wallets")
    .select("wallet_id,chain,purpose,status")
    .eq("owner_id", config.ownerId).eq("strategy_bot_id", bot.id)
    .eq("chain", config.chain).eq("purpose", "strategy_execution").eq("status", "assigned");
  if (bindingError) throw new Error("strategy_wallet_binding_lookup_failed");
  const walletIds = (bindings || []).map((binding: any) => binding.wallet_id).filter(Boolean);
  if (walletIds.length !== 1) throw new Error("unique_active_strategy_wallet_binding_required");
  const { data: hotWallet, error: hotWalletError } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
    .eq("id", walletIds[0]).eq("owner_id", config.ownerId).maybeSingle();
  if (hotWalletError || !hotWallet || hotWallet.status !== "active" || hotWallet.is_hot !== true ||
      hotWallet.chain !== config.chain || hotWallet.wallet_role !== "trading_hot" ||
      hotWallet.data_quality_status !== "verified" || !hotWallet.secret_ref) {
    throw new Error("active_verified_strategy_hot_wallet_missing");
  }
  const { data: approval, error: approvalError } = await supabase.from("approved_wallets")
    .select("id").eq("owner_id", config.ownerId).eq("wallet_id", hotWallet.id).eq("status", "approved").maybeSingle();
  if (approvalError || !approval) throw new Error("approved_strategy_hot_wallet_missing");
  const { data: profiles, error: profileError } = await supabase.from("profit_recipient_profiles")
    .select("id,owner_id,wallet_id,chain,asset,status,activation_at")
    .eq("owner_id", config.ownerId).eq("chain", config.chain).eq("asset", "ALL").eq("status", "active");
  if (profileError) throw new Error("profit_recipient_profile_lookup_failed");
  const activeProfiles = (profiles || []).filter((profile: any) =>
    !profile.activation_at || new Date(profile.activation_at).getTime() <= Date.now()
  );
  if (activeProfiles.length !== 1) throw new Error("unique_active_all_asset_profit_recipient_required");
  const profile = activeProfiles[0];
  const { data: profitWallet, error: profitWalletError } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
    .eq("id", profile.wallet_id).eq("owner_id", config.ownerId).maybeSingle();
  if (profitWalletError || !profitWallet || profitWallet.status !== "active" || profitWallet.is_hot !== false ||
      profitWallet.chain !== config.chain || profitWallet.wallet_role !== "profit_recipient" ||
      profitWallet.data_quality_status !== "verified" || !profitWallet.secret_ref ||
      String(profitWallet.address).toLowerCase() === String(hotWallet.address).toLowerCase()) {
    throw new Error("active_verified_profit_recipient_wallet_missing");
  }
  return { ...config, walletId: hotWallet.id, hotWallet: hotWallet.address,
    profitRecipientWalletId: profitWallet.id, profitRecipient: profitWallet.address };
}
async function getExistingDeployment(config: ChainConfig) {
  const { data, error } = await supabase.from("flash_executor_deployments")
    .select("chain,chain_id,executor_address,deployment_tx_hash,status,source_verified,payout_audited,payout_behavior_verified,hot_wallet_id,hot_wallet_address,profit_recipient_wallet_id,profit_recipient_address,pool_address,contract_source_blob_sha,runtime_bytecode_hash")
    .eq("chain", config.chain).maybeSingle();
  if (error) throw new Error("deployment_registry_lookup_failed");
  return data;
}
async function prepare(config: ChainConfig, bytecode: Hex) {
  await verifyHotWalletRecord(config);
  const existing = await getExistingDeployment(config);
  if (existing) throw new Error("deployment_registry_already_has_" + existing.status);
  const chainId = Number(String(await rpc(config, "eth_chainId", [])).toLowerCase());
  if (chainId !== config.chainId) throw new Error(config.chain + "_rpc_chain_id_mismatch");
  const poolCode = String(await rpc(config, "eth_getCode", [config.pool, "latest"]));
  if (!/^0x[0-9a-f]+$/i.test(poolCode) || poolCode.length <= 2) throw new Error(config.chain + "_aave_pool_code_missing");
  const { account } = await getDeploymentAccount(config);
  const initCode = buildInitCode(bytecode, config);
  const gasPrice = BigInt(String(await rpc(config, "eth_gasPrice", [])));
  const estimate = BigInt(String(await rpc(config, "eth_estimateGas", [{ from: account.address, data: initCode, value: "0x0" }])));
  if (estimate <= 0n || gasPrice <= 0n) throw new Error(config.chain + "_gas_estimate_invalid");
  const gas = (estimate * 120n + 99n) / 100n;
  const balance = BigInt(String(await rpc(config, "eth_getBalance", [account.address, "latest"])));
  const required = gas * gasPrice;
  const requiredWithReserve = (required * 110n + 99n) / 100n;
  if (balance < requiredWithReserve) {
    return { ok: false as const, error: config.chain + "_deployment_signer_underfunded", chain: config.chain,
      chain_id: config.chainId, deployer_address: account.address, balance_wei: balance.toString(),
      estimated_gas: gas.toString(), gas_price_wei: gasPrice.toString(),
      required_with_reserve_wei: requiredWithReserve.toString(), broadcast_attempted: false };
  }
  const nonce = BigInt(String(await rpc(config, "eth_getTransactionCount", [account.address, "pending"])));
  const expectedAddress = getContractAddress({ from: account.address, nonce });
  return { ok: true as const, config, account, initCode, nonce, expectedAddress, gasPrice, gas, balance,
    initCodeHash: keccak256(initCode), deployerAddress: account.address, requiredWithReserve };
}
async function codeAt(config: ChainConfig, address: string) {
  return String(await rpc(config, "eth_getCode", [address, "latest"]));
}
async function readGetter(config: ChainConfig, address: string, functionName: "HOT_WALLET" | "PROFIT_RECIPIENT" | "POOL") {
  const calldata = encodeFunctionData({ abi: EXECUTOR_ABI, functionName });
  const raw = String(await rpc(config, "eth_call", [{ to: address, data: calldata }, "latest"]));
  return decodeFunctionResult({ abi: EXECUTOR_ABI, functionName, data: raw as Hex }) as string;
}
async function sourcifyExact(config: ChainConfig, address: string) {
  try {
    const response = await fetch("https://sourcify.dev/server/v2/contract/" + config.chainId + "/" + address,
      { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { checked: true, verified: false, status: response.status };
    const body = await response.json();
    return { checked: true, verified: body?.match === "exact_match" && body?.runtimeMatch === "exact_match",
      match: body?.match || null, runtime_match: body?.runtimeMatch || null, verified_at: body?.verifiedAt || null };
  } catch { return { checked: true, verified: false, error: "sourcify_lookup_failed" }; }
}
async function verifyAndRecord(config: ChainConfig, address: string, txHash: string | null) {
  const existing = await getExistingDeployment(config);
  if (!existing || String(existing.executor_address).toLowerCase() !== address.toLowerCase()) throw new Error("deployment_registry_address_mismatch");
  const code = await codeAt(config, address);
  if (!/^0x[0-9a-f]+$/i.test(code) || code.length <= 2) throw new Error("executor_runtime_bytecode_missing");
  const hotWallet = await readGetter(config, address, "HOT_WALLET");
  const profitRecipient = await readGetter(config, address, "PROFIT_RECIPIENT");
  const pool = await readGetter(config, address, "POOL");
  if (hotWallet.toLowerCase() !== config.hotWallet.toLowerCase()) throw new Error("executor_hot_wallet_getter_mismatch");
  if (profitRecipient.toLowerCase() !== config.profitRecipient.toLowerCase()) throw new Error("executor_profit_recipient_getter_mismatch");
  if (pool.toLowerCase() !== config.pool.toLowerCase()) throw new Error("executor_pool_getter_mismatch");
  const verification = await sourcifyExact(config, address);
  const sourceVerified = verification.verified === true;
  const runtimeHash = keccak256(code as Hex).toLowerCase();
  const registryHash = String(existing.runtime_bytecode_hash || "").toLowerCase();
  // First successful exact-source verification establishes the registry baseline.
  // Once a hash exists it is immutable: any later mismatch blocks rather than overwrites.
  const runtimeHashMatchesRegistry = !registryHash || registryHash === runtimeHash;
  if (registryHash && !runtimeHashMatchesRegistry) throw new Error("executor_runtime_bytecode_hash_mismatch");
  const payoutAudited = sourceVerified &&
    runtimeHashMatchesRegistry &&
    hotWallet.toLowerCase() === config.hotWallet.toLowerCase() &&
    profitRecipient.toLowerCase() === config.profitRecipient.toLowerCase() &&
    pool.toLowerCase() === config.pool.toLowerCase() &&
    !!existing.profit_recipient_wallet_id &&
    String(existing.profit_recipient_wallet_id) === String(config.profitRecipientWalletId) &&
    String(existing.profit_recipient_address || "").toLowerCase() === config.profitRecipient.toLowerCase() &&
    String(existing.hot_wallet_id || "") === String(config.walletId) &&
    String(existing.hot_wallet_address || "").toLowerCase() === config.hotWallet.toLowerCase() &&
    Number(existing.chain_id) === config.chainId &&
    String(existing.contract_source_blob_sha || "") === config.sourceBlobSha;
  const { error } = await supabase.from("flash_executor_deployments").update({
    executor_address: address, deployment_tx_hash: txHash || existing.deployment_tx_hash,
    hot_wallet_id: config.walletId, hot_wallet_address: hotWallet,
    profit_recipient_wallet_id: config.profitRecipientWalletId, profit_recipient_address: profitRecipient,
    pool_address: pool, contract_source_blob_sha: config.sourceBlobSha,
    runtime_bytecode_hash: runtimeHash, status: sourceVerified && payoutAudited ? "verified" : "deployed_unverified",
    source_verified: sourceVerified, payout_audited: payoutAudited, payout_behavior_verified: false,
    failure_code: null, updated_at: new Date().toISOString(),
  }).eq("chain", config.chain);
  if (error) throw new Error("deployment_registry_update_failed");
  return {
    ok: true, chain: config.chain, chain_id: config.chainId, executor_address: address,
    deployment_tx_hash: txHash || existing.deployment_tx_hash, hot_wallet: hotWallet,
    profit_recipient: profitRecipient, pool,
    runtime_bytecode_bytes: (code.length - 2) / 2, runtime_bytecode_hash: runtimeHash,
    source_verification: verification, payout_audited: payoutAudited,
    payout_behavior_verified: false, status: sourceVerified && payoutAudited ? "verified" : "deployed_unverified",
  };
}
Deno.serve(async (req) => {
  if (req.method !== "POST") return fail("method_not_allowed", 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail("invalid_json", 400); }

  const chain = String(body.chain || "");
  const baseConfig = CONFIGS.get(chain);
  if (!baseConfig) return fail("chain_not_allowlisted", 400);

  const mode = String(body.mode || "");
  if (!["provision_signer", "preflight", "deploy", "verify"].includes(mode)) {
    return fail("mode_not_allowlisted", 400);
  }
  const provisionMode = mode === "provision_signer";
  const expectedPhrase = provisionMode ? PROVISION_CONFIRM_PHRASE : baseConfig.confirmPhrase;
  if (body.confirm_phrase !== expectedPhrase) return fail("confirmation_phrase_missing_or_invalid", 403);

  let identity: { workflowRef: string; runId: string; actor: string; sha: string; eventName: string };
  try {
    identity = await authorizeGithub(req, provisionMode ? PROVISION_WORKFLOW : baseConfig.workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = ["github_oidc_bearer_required", "github_oidc_claims_not_allowed"].includes(message)
      ? message : "github_oidc_validation_failed";
    return fail(code, 401);
  }

  let config: ChainConfig;
  try {
    config = await resolveChainWalletConfig(baseConfig);
  } catch (error) {
    const blocker = error instanceof Error ? error.message : "active_chain_wallet_and_profit_destination_required";
    return fail(blocker, 409, { chain, broadcast_attempted: false });
  }

  if (provisionMode) {
    try {
      await verifyHotWalletRecord(config);
      const result = await getDeploymentAccount(config, true);
      return json({
        ok: true,
        mode: "provision_signer",
        chain: config.chain,
        chain_id: config.chainId,
        signer_address: result.account.address,
        signer_status: "active",
        created: result.created,
        custody: "supabase_vault_server_only",
        private_key_returned: false,
        github_workflow_ref: identity.workflowRef,
        github_run_id: identity.runId,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "deployment_signer_provision_failed", 409);
    }
  }
  if (mode === "verify") {
    const existing = await getExistingDeployment(config).catch(() => null);
    if (!existing?.executor_address) return fail("executor_not_deployed", 409);
    try {
      const result = await verifyAndRecord(config, String(existing.executor_address), existing.deployment_tx_hash || null);
      return json({ ...result, github_workflow_ref: identity.workflowRef, github_run_id: identity.runId },
        result.source_verification?.verified ? 200 : 202);
    } catch (error) { return fail(error instanceof Error ? error.message : "executor_verification_failed", 409); }
  }
  const sourceBlobSha = String(body.contract_source_blob_sha || "");
  if (sourceBlobSha !== config.sourceBlobSha) return fail("contract_source_revision_not_allowlisted", 403,
    { expected_contract_source_blob_sha: config.sourceBlobSha });
  let bytecode: Hex;
  try { bytecode = normalizeHexBytecode(body.creation_bytecode); }
  catch (error) { return fail(error instanceof Error ? error.message : "creation_bytecode_invalid", 400); }
  if (mode === "preflight") {
    try {
      const check = await prepare(config, bytecode);
      if (!check.ok) return fail(check.error, 402, {
        chain: check.chain, chain_id: check.chain_id, deployer_address: check.deployer_address,
        balance_wei: check.balance_wei, estimated_gas: check.estimated_gas, gas_price_wei: check.gas_price_wei,
        required_with_reserve_wei: check.required_with_reserve_wei, broadcast_attempted: false,
      });
      return json({ ok: true, mode: "preflight", chain: config.chain, chain_id: config.chainId,
        deployer_address: check.deployerAddress, balance_wei: check.balance.toString(),
        estimated_gas: check.gas.toString(), gas_price_wei: check.gasPrice.toString(),
        required_with_reserve_wei: check.requiredWithReserve.toString(), expected_contract_address: check.expectedAddress,
        init_code_hash: check.initCodeHash, broadcast_attempted: false });
    } catch (error) { return fail(error instanceof Error ? error.message : "deployment_preflight_failed", 409, { broadcast_attempted: false }); }
  }
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(config, bytecode);
    if (!prepared.ok) return fail(prepared.error, 402, {
      chain: prepared.chain, chain_id: prepared.chain_id, deployer_address: prepared.deployer_address,
      balance_wei: prepared.balance_wei, estimated_gas: prepared.estimated_gas, gas_price_wei: prepared.gas_price_wei,
      required_with_reserve_wei: prepared.required_with_reserve_wei, broadcast_attempted: false,
    });
  } catch (error) { return fail(error instanceof Error ? error.message : "deployment_preflight_failed", 409, { broadcast_attempted: false }); }

  const { error: insertError } = await supabase.from("flash_executor_deployments").insert({
    chain: config.chain, chain_id: config.chainId, contract_name: config.contractName,
    executor_address: prepared.expectedAddress, deployment_tx_hash: null, deployer_address: prepared.deployerAddress,
    deployment_nonce: prepared.nonce.toString(), hot_wallet_id: config.walletId, hot_wallet_address: config.hotWallet,
    profit_recipient_wallet_id: config.profitRecipientWalletId, profit_recipient_address: config.profitRecipient,
    pool_address: config.pool, contract_source_blob_sha: config.sourceBlobSha, init_code_hash: prepared.initCodeHash,
    status: "pending", source_verified: false, payout_audited: false, payout_behavior_verified: false,
    github_workflow_ref: identity.workflowRef, github_run_id: identity.runId, updated_at: new Date().toISOString(),
  });
  if (insertError) return fail("deployment_registry_insert_failed_or_duplicate", 409, { broadcast_attempted: false });

  let signed: Hex;
  try {
    signed = await prepared.account.signTransaction({
      chainId: config.chainId, nonce: prepared.nonce, gas: prepared.gas, gasPrice: prepared.gasPrice,
      data: prepared.initCode, value: 0n, type: "legacy",
    });
  } catch { return fail("deployment_transaction_signing_failed", 500, { broadcast_attempted: false }); }
  const txHash = keccak256(signed);
  const { error: txHashSaveError } = await supabase.from("flash_executor_deployments")
    .update({ deployment_tx_hash: txHash, updated_at: new Date().toISOString() })
    .eq("chain", config.chain).eq("status", "pending");
  if (txHashSaveError) return fail("deployment_transaction_hash_persistence_failed", 500, {
    deployment_tx_hash: txHash, broadcast_attempted: false,
  });
  try {
    const returnedHash = String(await rpc(config, "eth_sendRawTransaction", [signed]));
    if (returnedHash.toLowerCase() !== txHash.toLowerCase()) return fail("rpc_broadcast_hash_mismatch", 502, {
      predicted_tx_hash: txHash, returned_tx_hash: returnedHash, expected_contract_address: prepared.expectedAddress,
      broadcast_attempted: true,
    });
  } catch {
    return fail("deployment_broadcast_result_uncertain_check_tx_hash", 502, {
      deployment_tx_hash: txHash, expected_contract_address: prepared.expectedAddress,
      deployer_address: prepared.deployerAddress, broadcast_attempted: true,
    });
  }
  let receipt: any = null;
  for (let i = 0; i < 15; i++) {
    try { receipt = await rpc(config, "eth_getTransactionReceipt", [txHash]); if (receipt) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!receipt) return json({
    ok: true, mode: "deploy", status: "pending", chain: config.chain, chain_id: config.chainId,
    deployer_address: prepared.deployerAddress, executor_address: prepared.expectedAddress,
    deployment_tx_hash: txHash, broadcast_attempted: true, confirmed: false,
    note: "Transaction accepted by RPC; receipt not yet available. Do not resubmit.",
  }, 202);
  if (String(receipt.status).toLowerCase() !== "0x1") {
    await supabase.from("flash_executor_deployments")
      .update({ status: "failed", failure_code: "deployment_reverted", updated_at: new Date().toISOString() })
      .eq("chain", config.chain);
    return fail("deployment_transaction_reverted", 409, {
      deployment_tx_hash: txHash, executor_address: prepared.expectedAddress, broadcast_attempted: true, confirmed: true,
    });
  }
  try {
    const result = await verifyAndRecord(config, prepared.expectedAddress, txHash);
    return json({ ...result, mode: "deploy", deployer_address: prepared.deployerAddress,
      deployment_nonce: prepared.nonce.toString(), block_number: receipt.blockNumber || null,
      broadcast_attempted: true, confirmed: true, github_workflow_ref: identity.workflowRef, github_run_id: identity.runId }, 200);
  } catch (error) {
    await supabase.from("flash_executor_deployments").update({
      status: "deployed_unverified",
      failure_code: error instanceof Error ? error.message.slice(0, 120) : "post_deployment_verification_failed",
      updated_at: new Date().toISOString(),
    }).eq("chain", config.chain);
    return fail(error instanceof Error ? error.message : "post_deployment_verification_failed", 409, {
      deployment_tx_hash: txHash, executor_address: prepared.expectedAddress, broadcast_attempted: true, confirmed: true,
    });
  }
});
