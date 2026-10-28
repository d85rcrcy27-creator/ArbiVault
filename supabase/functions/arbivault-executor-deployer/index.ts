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
  sourceBlobSha: "7b8771f3b262813f746bc16c5436c95d2740fb04",
  ownerId: "3406bc39-44c9-438b-b1ca-0a95683f7dda",
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
  ownerId: "3406bc39-44c9-438b-b1ca-0a95683f7dda",
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
    if ([BSC.hotWallet, ETH.hotWallet, config.hotWallet, config.profitRecipient].filter(Boolean).some(
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
  if ([BSC.hotWallet, ETH.hotWallet, config.hotWallet, config.profitRecipient].filter(Boolean).some(
    (address) => address.toLowerCase() === account.address.toLowerCase()
  )) {
    throw new Error("deployment_signer_matches_trading_wallet");
  }

  return { account, created };
}
async function resolveConfiguredChain(base: ChainConfig): Promise<ChainConfig> {
  const { data: tradingRows, error: tradingError } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,custody_type,wallet_role,data_quality_status,secret_ref")
    .eq("owner_id", base.ownerId).eq("chain", base.chain).eq("status", "active")
    .eq("is_hot", true).eq("wallet_role", "trading_hot")
    .eq("data_quality_status", "verified").not("secret_ref", "is", null).limit(2);
  if (tradingError) throw new Error("trading_hot_wallet_lookup_failed");
  if (!tradingRows || tradingRows.length !== 1) throw new Error("active_verified_trading_wallet_missing_or_ambiguous");
  const trading = tradingRows[0];
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(trading.address || ""))) throw new Error("trading_hot_wallet_address_invalid");

  const { data: profiles, error: profileError } = await supabase.from("profit_recipient_profiles")
    .select("id,owner_id,wallet_id,chain,asset,status,activation_at,verification_source")
    .eq("owner_id", base.ownerId).eq("chain", base.chain).eq("asset", "ALL").eq("status", "active").limit(2);
  if (profileError) throw new Error("active_profit_destination_lookup_failed");
  if (!profiles || profiles.length !== 1) throw new Error("active_all_assets_profit_destination_missing_or_ambiguous");
  const profile = profiles[0];
  if (profile.activation_at && new Date(profile.activation_at).getTime() > Date.now()) throw new Error("profit_destination_activation_delay_pending");

  const { data: recipient, error: recipientError } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,custody_type,wallet_role,data_quality_status,secret_ref")
    .eq("id", profile.wallet_id).eq("owner_id", base.ownerId).maybeSingle();
  if (recipientError) throw new Error("profit_destination_wallet_lookup_failed");
  if (!recipient || recipient.status !== "active" || recipient.chain !== base.chain || recipient.wallet_role !== "profit_recipient" || recipient.custody_type !== "turnkey" ||
      recipient.is_hot !== false || recipient.data_quality_status !== "verified" || !recipient.secret_ref ||
      !/^0x[a-fA-F0-9]{40}$/.test(String(recipient.address || ""))) throw new Error("profit_destination_wallet_integrity_check_failed");
  if (String(recipient.address).toLowerCase() === String(trading.address).toLowerCase()) throw new Error("profit_destination_must_be_separate_from_trading_wallet");
  return { ...base, walletId: String(trading.id), hotWallet: String(trading.address),
    profitRecipientWalletId: String(recipient.id), profitRecipient: String(recipient.address) };
}
async function verifyHotWalletRecord(config: ChainConfig) {
  const { data, error } = await supabase.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status,secret_ref")
    .eq("id", config.walletId).eq("owner_id", config.ownerId).maybeSingle();
  if (error || !data) throw new Error("approved_hot_wallet_record_unavailable");
  if (data.chain !== config.chain || data.status !== "active" || data.is_hot !== true || data.wallet_role !== "trading_hot" ||
      data.data_quality_status !== "verified" || !data.secret_ref || String(data.address).toLowerCase() !== config.hotWallet.toLowerCase()) {
    throw new Error("approved_hot_wallet_configuration_mismatch");
  }
}
async function getExistingDeployment(config: ChainConfig) {
  const { data, error } = await supabase.from("flash_executor_deployments")
    .select("chain,executor_address,deployment_tx_hash,status,source_verified,payout_audited,hot_wallet_id,hot_wallet_address,profit_recipient_wallet_id,profit_recipient_address")
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
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(config.chain + "_deployment_nonce_out_of_safe_range");
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
  const payoutAudited = sourceVerified && hotWallet.toLowerCase() === config.hotWallet.toLowerCase() &&
    profitRecipient.toLowerCase() === config.profitRecipient.toLowerCase() && pool.toLowerCase() === config.pool.toLowerCase();
  const { error } = await supabase.from("flash_executor_deployments").update({
    executor_address: address, deployment_tx_hash: txHash || existing.deployment_tx_hash,
    runtime_bytecode_hash: keccak256(code as Hex), status: sourceVerified ? "verified" : "deployed_unverified",
    source_verified: sourceVerified, payout_audited: payoutAudited, payout_behavior_verified: false,
    profit_recipient_wallet_id: config.profitRecipientWalletId, profit_recipient_address: config.profitRecipient,
    failure_code: null, updated_at: new Date().toISOString(),
  }).eq("chain", config.chain);
  if (error) throw new Error("deployment_registry_update_failed");
  return {
    ok: true, chain: config.chain, chain_id: config.chainId, executor_address: address,
    deployment_tx_hash: txHash || existing.deployment_tx_hash, hot_wallet: hotWallet, profit_recipient: profitRecipient,
    profit_recipient_wallet_id: config.profitRecipientWalletId, pool,
    runtime_bytecode_bytes: (code.length - 2) / 2, runtime_bytecode_hash: keccak256(code as Hex),
    source_verification: verification, payout_audited: payoutAudited,
    payout_behavior_verified: false, status: sourceVerified ? "verified" : "deployed_unverified",
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
    config = await resolveConfiguredChain(baseConfig);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "executor_wallet_resolution_failed", 409, { broadcast_attempted: false });
  }
  if (mode === "deploy") {
    const expectedHotWallet = String(body.expected_hot_wallet || "");
    const expectedProfitRecipient = String(body.expected_profit_recipient || "");
    if (expectedHotWallet.toLowerCase() !== config.hotWallet.toLowerCase() || expectedProfitRecipient.toLowerCase() !== config.profitRecipient.toLowerCase()) {
      return fail("deployment_wallet_config_changed_since_preflight", 409, { hot_wallet: config.hotWallet, profit_recipient: config.profitRecipient, broadcast_attempted: false });
    }
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
        hot_wallet: config.hotWallet, profit_recipient: config.profitRecipient, profit_recipient_wallet_id: config.profitRecipientWalletId,
        pool: config.pool, init_code_hash: check.initCodeHash, broadcast_attempted: false });
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
      chainId: config.chainId, nonce: Number(prepared.nonce), gas: prepared.gas, gasPrice: prepared.gasPrice,
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
    hot_wallet: config.hotWallet, profit_recipient: config.profitRecipient, profit_recipient_wallet_id: config.profitRecipientWalletId,
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
