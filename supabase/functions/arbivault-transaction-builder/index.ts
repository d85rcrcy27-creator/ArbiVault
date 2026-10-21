import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "npm:viem@2.39.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BSC_RPC = Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org";
const ETHEREUM_RPC = Deno.env.get("ETHEREUM_RPC_URL") || "https://ethereum-rpc.publicnode.com";
const ETH_AAVE_PROVIDER = (Deno.env.get("ARBIVAULT_ETH_AAVE_PROVIDER") || "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e").trim();
const ENV_ETH_FLASH_EXECUTOR = (Deno.env.get("ARBIVAULT_ETH_FLASH_EXECUTOR") || "").trim();
let ETH_FLASH_EXECUTOR = ENV_ETH_FLASH_EXECUTOR;
const JUPITER_API_KEY = Deno.env.get("JUPITER_API_KEY") || "";
const ENV_BSC_FLASH_EXECUTOR = (Deno.env.get("ARBIVAULT_BSC_FLASH_EXECUTOR") || "").trim();
let BSC_FLASH_EXECUTOR = ENV_BSC_FLASH_EXECUTOR;
// Fail closed until the deployed executor contract source and live bytecode prove that
// realized profits are paid to the calling ArbiVault trading hot wallet.
const ENV_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED = Deno.env.get("ARBIVAULT_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED") === "true" || Deno.env.get("ARBIVAULT_FLASH_EXECUTOR_PAYOUT_AUDITED") === "true";
let BSC_FLASH_EXECUTOR_PAYOUT_AUDITED = ENV_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED;
const ENV_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED = Deno.env.get("ARBIVAULT_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED") === "true";
let ETH_FLASH_EXECUTOR_PAYOUT_AUDITED = ENV_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED;
// Official Aave V3 BNB market provider. Resolve getPool() on-chain at runtime so
// Pool proxy upgrades are picked up without manually rotating an env var.
const BSC_AAVE_PROVIDER = (Deno.env.get("ARBIVAULT_BSC_AAVE_PROVIDER") || "0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D").trim();
const AAVE_PROVIDER_ABI = parseAbi(["function getPool() view returns (address)"]);

const BSC_FLASH_EXPECTED_POOL = "0x6807dc923806fE8Fd134338EABCA509979a7e0cB";
const ETH_FLASH_EXPECTED_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

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

async function persistExecutorAudit(chain: string, executor: Record<string, any>) {
  if (executor.payout_audited !== true || !executor.address) return false;
  const { data, error } = await supabase
    .from("flash_executor_deployments")
    .update({
      status: "verified",
      source_verified: true,
      payout_audited: true,
      updated_at: new Date().toISOString(),
    })
    .eq("chain", chain)
    .eq("executor_address", String(executor.address))
    .select("chain")
    .maybeSingle();
  if (error || !data) throw new Error("flash_executor_audit_persist_failed");
  if (chain === "bnb") BSC_FLASH_EXECUTOR_PAYOUT_AUDITED = true;
  if (chain === "ethereum") ETH_FLASH_EXECUTOR_PAYOUT_AUDITED = true;
  return true;
}


const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const BISWAP_ROUTER_V2 = "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8";
const ETH_UNISWAP_V2_ROUTER = "0x7a250d5630B4cf539739dF2C5dAcb4c659F2488D";
const ETH_SUSHISWAP_V2_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
]);

const FLASH_EXECUTOR_ABI = parseAbi([
  "function executeFlashLoan(address asset,uint256 amount,uint256 minProfit,address[] targets,uint256[] values,bytes[] data)",
]);
const FLASH_PREMIUM_ABI = parseAbi(["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"]);
const FLASH_EXECUTOR_PAYOUT_ABI = parseAbi([
  "function HOT_WALLET() view returns (address)",
  "function POOL() view returns (address)",
]);

const BSC_ATOMIC_ALLOWED_TARGETS = new Set([PANCAKE_V2_ROUTER.toLowerCase(), BISWAP_ROUTER_V2.toLowerCase()]);
const ETH_ATOMIC_ALLOWED_TARGETS = new Set([ETH_UNISWAP_V2_ROUTER.toLowerCase(), ETH_SUSHISWAP_V2_ROUTER.toLowerCase()]);

const MAX_SLIPPAGE_BPS = 100;
const MAX_PRICE_IMPACT_PCT = 5;

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function authorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data } = await supabase.rpc("get_bot_cron_token");
  return !!data && supplied === data;
}

async function rpc(method: string, params: unknown[]) {
  const endpoints = [...new Set([
    BSC_RPC,
    "https://bsc-dataseed.binance.org",
    "https://ethereum-rpc.publicnode.com", // never used for BSC after chain-id validation by callers
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-dataseed-public.bnbchain.org",
  ].filter(Boolean))].filter((url) => !url.includes("ethereum-rpc.publicnode.com"));
  let lastError: unknown = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      });
      if (!response.ok) throw new Error(`bsc_rpc_http_${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(`bsc_rpc_${body.error.code ?? "error"}`);
      if (body.result === undefined || body.result === null) throw new Error("bsc_rpc_result_missing");
      return body.result;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "bsc_rpc_all_providers_failed");
}


async function ethereumRpc(method: string, params: unknown[]) {
  const endpoints = [...new Set([
    ETHEREUM_RPC,
    "https://ethereum-rpc.publicnode.com",
    "https://cloudflare-eth.com",
    "https://eth.llamarpc.com",
  ].filter(Boolean))];
  let lastError: unknown = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      });
      if (!response.ok) throw new Error(`ethereum_rpc_http_${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(`ethereum_rpc_${body.error.code ?? "error"}`);
      if (body.result === undefined || body.result === null) throw new Error("ethereum_rpc_result_missing");
      return body.result;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "ethereum_rpc_all_providers_failed");
}

function toBigInt(value: string) {
  return BigInt(value);
}

function toHex(value: bigint) {
  return `0x${value.toString(16)}`;
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function builderRouteCompatible(route: { chain: string; pair: string; route_type: string; transaction_builder: string }) {
  if (route.transaction_builder === "jupiter_swap_v2") {
    return route.chain === "solana" && ["SOL/USDC", "SOL/USDT"].includes(route.pair);
  }
  if (route.transaction_builder === "pancakeswap_v2") {
    return route.chain === "bnb" && route.pair === "BNB/USDT";
  }
  if (route.transaction_builder === "uniswap_v2") {
    return route.chain === "ethereum" && route.pair === "ETH/USDC";
  }
  if (route.transaction_builder === "aave_v3_atomic_flash_loan_v1") {
    return route.route_type === "flash_liquidity" &&
      ((route.chain === "bnb" && route.pair === "BNB/USDT") ||
       (route.chain === "ethereum" && route.pair === "ETH/USDC"));
  }
  return false;
}

function routeAssets(chain: string, pair: string, side: string) {
  if (chain === "solana") {
    if (pair !== "SOL/USDC" && pair !== "SOL/USDT") {
      throw new Error("pair_not_allowlisted_for_jupiter");
    }
    const stableMint = pair.endsWith("USDC") ? SOL_USDC : SOL_USDT;
    return side === "sell"
      ? { inputMint: SOL_MINT, outputMint: stableMint }
      : { inputMint: stableMint, outputMint: SOL_MINT };
  }

  if (chain === "bnb" && pair === "BNB/USDT") {
    return side === "sell"
      ? { inputToken: WBNB, outputToken: BSC_USDT, nativeInput: true }
      : { inputToken: BSC_USDT, outputToken: WBNB, nativeInput: false };
  }

  throw new Error("pair_not_allowlisted_for_builder");
}

async function buildJupiter(
  taker: string,
  pair: string,
  side: string,
  amountRaw: string,
  slippageBps: number,
) {
  const assets = routeAssets("solana", pair, side);
  if (!("inputMint" in assets) || !assets.inputMint || !assets.outputMint) {
    throw new Error("jupiter_route_assets_invalid");
  }
  if (!JUPITER_API_KEY) {
    throw new Error("jupiter_api_key_not_configured");
  }
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
    throw new Error("jupiter_amount_invalid");
  }
  const params = new URLSearchParams({
    inputMint: assets.inputMint,
    outputMint: assets.outputMint,
    amount: amountRaw,
    taker,
    slippageBps: String(slippageBps),
  });

  const headers: Record<string, string> = { accept: "application/json" };
  if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;

  const response = await fetch(
    `https://api.jup.ag/swap/v2/order?${params.toString()}`,
    { headers },
  );
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.errorMessage || `jupiter_order_http_${response.status}`);
  }
  if (!body?.transaction || typeof body.transaction !== "string") {
    throw new Error(body?.errorMessage || "jupiter_transaction_unavailable");
  }
  try {
    if (!atob(body.transaction).length) throw new Error("empty");
  } catch {
    throw new Error("jupiter_transaction_base64_invalid");
  }
  if (body.inputMint && body.inputMint !== assets.inputMint) {
    throw new Error("jupiter_input_mint_mismatch");
  }
  if (body.outputMint && body.outputMint !== assets.outputMint) {
    throw new Error("jupiter_output_mint_mismatch");
  }
  if (body.inAmount && String(body.inAmount) !== amountRaw) {
    throw new Error("jupiter_input_amount_mismatch");
  }
  if (body.taker && String(body.taker).trim() !== taker) {
    throw new Error("jupiter_taker_mismatch");
  }

  return {
    builder: "jupiter_swap_v2",
    chain: "solana",
    pair,
    side,
    source: taker,
    transaction: body.transaction,
    transaction_format: "base64",
    transaction_payload_hash: await sha256(body.transaction),
    request_id: body.requestId || null,
    router: body.router || null,
    mode: body.mode || null,
    in_amount: body.inAmount || amountRaw,
    out_amount: body.outAmount || null,
    slippage_bps: slippageBps,
    fee_bps: body.feeBps ?? null,
    fee_mint: body.feeMint || null,
    executable: true,
    broadcast_by_builder: false,
    reference: "Jupiter Swap API V2",
  };
}

async function resolveBscAavePool(): Promise<string> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(BSC_AAVE_PROVIDER)) {
    throw new Error("invalid_aave_provider_config");
  }
  const callData = encodeFunctionData({ abi: AAVE_PROVIDER_ABI, functionName: "getPool" });
  const raw = await rpc("eth_call", [{ to: BSC_AAVE_PROVIDER, data: callData }, "latest"]);
  const pool = decodeFunctionResult({
    abi: AAVE_PROVIDER_ABI,
    functionName: "getPool",
    data: raw as `0x${string}`,
  }) as string;
  if (!/^0x[a-fA-F0-9]{40}$/.test(pool) || /^0x0{40}$/i.test(pool)) {
    throw new Error("aave_pool_resolution_failed");
  }
  return pool;
}

async function resolveEthereumAavePool(): Promise<string> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(ETH_AAVE_PROVIDER)) {
    throw new Error("invalid_ethereum_aave_provider_config");
  }
  const callData = encodeFunctionData({ abi: AAVE_PROVIDER_ABI, functionName: "getPool" });
  const raw = await ethereumRpc("eth_call", [{ to: ETH_AAVE_PROVIDER, data: callData }, "latest"]);
  const pool = decodeFunctionResult({
    abi: AAVE_PROVIDER_ABI,
    functionName: "getPool",
    data: raw as `0x${string}`,
  }) as string;
  if (!/^0x[a-fA-F0-9]{40}$/.test(pool) || /^0x0{40}$/i.test(pool)) {
    throw new Error("ethereum_aave_pool_resolution_failed");
  }
  return pool;
}

async function lookupSourcifyVerification(chainId: string, address: string) {
  try {
    const response = await fetch(
      `https://sourcify.dev/server/v2/contract/${chainId}/${address}`,
      { signal: AbortSignal.timeout(2500), headers: { accept: "application/json" } },
    );
    if (!response.ok) return { checked: true, verified: false, match: null, runtime_match: null, http_status: response.status };
    const body = await response.json();
    return {
      checked: true,
      verified: body?.match === "exact_match" && body?.runtimeMatch === "exact_match",
      match: body?.match || null,
      runtime_match: body?.runtimeMatch || null,
      verified_at: body?.verifiedAt || null,
      contract_url: `https://repo.sourcify.dev/${chainId}/${address}`,
    };
  } catch (error) {
    return {
      checked: true,
      verified: false,
      match: null,
      runtime_match: null,
      error: error instanceof Error ? error.message.slice(0, 160) : "sourcify_lookup_failed",
    };
  }
}

async function verifyExecutor(
  chainId: string,
  chain: string,
  executor: string,
  readCode: (address: string) => Promise<unknown>,
  readCall: (address: string, data: string) => Promise<unknown>,
  generatedWallets: Array<{ id: string; owner_id: string; chain: string; address: string }>,
  expectedPool: string,
) {
  const validAddress = /^0x[a-fA-F0-9]{40}$/.test(executor);
  const result: Record<string, unknown> = {
    configured: validAddress,
    address: validAddress ? executor : null,
    code_deployed: false,
    bytecode_hash: null,
    bytecode_size_bytes: 0,
    payout_recipient_address: null,
    payout_recipient_matches_generated_hot_wallet: false,
    pool_address: null,
    pool_matches_expected: false,
    matched_generated_wallet_id: null,
    source_verification: { checked: false, verified: false, match: null, runtime_match: null },
  };
  if (!validAddress) return result;
  try {
    const code = String(await readCode(executor));
    result.code_deployed = /^0x[0-9a-f]+$/i.test(code) && code.length > 2;
    result.bytecode_size_bytes = Math.max(0, (code.length - 2) / 2);
    result.bytecode_hash = code.length > 2 ? await sha256(code.toLowerCase()) : null;
  } catch (error) {
    result.code_error = error instanceof Error ? error.message : "executor_code_lookup_failed";
    return result;
  }
  if (result.code_deployed !== true) return result;

  try {
    const callData = encodeFunctionData({ abi: FLASH_EXECUTOR_PAYOUT_ABI, functionName: "HOT_WALLET" });
    const raw = String(await readCall(executor, callData));
    const recipient = decodeFunctionResult({
      abi: FLASH_EXECUTOR_PAYOUT_ABI,
      functionName: "HOT_WALLET",
      data: raw as `0x${string}`,
    }) as string;
    result.payout_recipient_address = recipient;
    const match = generatedWallets.find((wallet) =>
      wallet.chain === chain &&
      /^0x[a-fA-F0-9]{40}$/.test(wallet.address || "") &&
      wallet.address.toLowerCase() === recipient.toLowerCase()
    );
    result.payout_recipient_matches_generated_hot_wallet = !!match;
    result.matched_generated_wallet_id = match?.id || null;
    result.matched_generated_wallet_owner_id = match?.owner_id || null;
  } catch (error) {
    result.payout_recipient_read_error = error instanceof Error ? error.message : "executor_payout_getter_failed";
  }

  
  try {
    const poolCallData = encodeFunctionData({ abi: FLASH_EXECUTOR_PAYOUT_ABI, functionName: "POOL" });
    const poolRaw = String(await readCall(executor, poolCallData));
    const pool = decodeFunctionResult({
      abi: FLASH_EXECUTOR_PAYOUT_ABI,
      functionName: "POOL",
      data: poolRaw as `0x${string}`,
    }) as string;
    result.pool_address = pool;
    result.pool_matches_expected = pool.toLowerCase() === expectedPool.toLowerCase();
  } catch (error) {
    result.pool_read_error = error instanceof Error ? error.message : "executor_pool_getter_failed";
  }

  result.source_verification = await lookupSourcifyVerification(chainId, executor);
  result.payout_audited = result.code_deployed === true &&
    result.payout_recipient_matches_generated_hot_wallet === true &&
    result.pool_matches_expected === true &&
    (result.source_verification as any)?.verified === true;
  return result;
}

async function diagnoseFlashExecutor() {
  const result: Record<string, unknown> = {
    diagnostic_only: true,
    payout_behavior_verified: false,
    payout_audit_reason: "Payout routing is verified only when the deployed executor's immutable HOT_WALLET getter matches an active ArbiVault-generated trading hot wallet and source/bytecode are verified. End-to-end payout still requires a confirmed on-chain receipt and balance delta.",
    transaction_building_enabled: false,
    bnb: {
      network: "BNB Smart Chain mainnet",
      expected_chain_id: 56,
      aave_provider_address: BSC_AAVE_PROVIDER,
      payout_behavior_verified: false,
    },
    ethereum: {
      network: "Ethereum mainnet",
      expected_chain_id: 1,
      aave_provider_address: ETH_AAVE_PROVIDER,
      payout_behavior_verified: false,
    },
  };
  const bnb: any = result.bnb;
  const eth: any = result.ethereum;

  const { data: generatedWalletRows, error: generatedWalletError } = await supabase
    .from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,wallet_role")
    .in("chain", ["bnb", "ethereum"])
    .eq("status", "active")
    .eq("is_hot", true)
    .eq("wallet_role", "trading_hot");
  const generatedWallets = (generatedWalletRows || []).filter((wallet: any) =>
    /^0x[a-fA-F0-9]{40}$/.test(String(wallet.address || "")) &&
    ["bnb", "ethereum"].includes(wallet.chain)
  );
  result.generated_hot_wallet_lookup_ok = !generatedWalletError;
  result.active_generated_hot_wallet_count = generatedWallets.length;
  if (generatedWalletError) result.generated_hot_wallet_lookup_error = generatedWalletError.message;

  try {
    const chainId = String(await rpc("eth_chainId", [])).toLowerCase();
    bnb.rpc_chain_id = chainId;
    bnb.rpc_chain_ok = chainId === "0x38";
  } catch (error) {
    bnb.rpc_chain_ok = false;
    bnb.rpc_error = error instanceof Error ? error.message : "bsc_rpc_probe_failed";
  }
  try {
    bnb.aave_pool_address = await resolveBscAavePool();
    bnb.aave_pool_resolved = true;
  } catch (error) {
    bnb.aave_pool_resolved = false;
    bnb.aave_pool_error = error instanceof Error ? error.message : "aave_pool_resolution_failed";
  }
  bnb.executor = await verifyExecutor(
    "56",
    "bnb",
    BSC_FLASH_EXECUTOR,
    (address) => rpc("eth_getCode", [address, "latest"]),
    (address, data) => rpc("eth_call", [{ to: address, data }, "latest"]),
    generatedWallets,
    BSC_FLASH_EXPECTED_POOL,
  );
  bnb.ready_for_flash_transaction_test =
    bnb.rpc_chain_ok === true &&
    bnb.aave_pool_resolved === true &&
    (bnb.executor as any).configured === true &&
    (bnb.executor as any).code_deployed === true &&
    (bnb.executor as any).payout_recipient_matches_generated_hot_wallet === true &&
    (bnb.executor as any).source_verification?.verified === true &&
    BSC_FLASH_EXECUTOR_PAYOUT_AUDITED === true;

  try {
    const chainId = String(await ethereumRpc("eth_chainId", [])).toLowerCase();
    eth.rpc_chain_id = chainId;
    eth.rpc_chain_ok = chainId === "0x1";
  } catch (error) {
    eth.rpc_chain_ok = false;
    eth.rpc_error = error instanceof Error ? error.message : "ethereum_rpc_probe_failed";
  }
  try {
    eth.aave_pool_address = await resolveEthereumAavePool();
    eth.aave_pool_resolved = true;
  } catch (error) {
    eth.aave_pool_resolved = false;
    eth.aave_pool_error = error instanceof Error ? error.message : "ethereum_aave_pool_resolution_failed";
  }
  eth.executor = await verifyExecutor(
    "1",
    "ethereum",
    ETH_FLASH_EXECUTOR,
    (address) => ethereumRpc("eth_getCode", [address, "latest"]),
    (address, data) => ethereumRpc("eth_call", [{ to: address, data }, "latest"]),
    generatedWallets,
    ETH_FLASH_EXPECTED_POOL,
  );
  await persistExecutorAudit("bnb", bnb.executor as Record<string, any>);
  await persistExecutorAudit("ethereum", eth.executor as Record<string, any>);

  eth.ready_for_flash_transaction_test =
    eth.rpc_chain_ok === true &&
    eth.aave_pool_resolved === true &&
    (eth.executor as any).configured === true &&
    (eth.executor as any).code_deployed === true &&
    (eth.executor as any).payout_recipient_matches_generated_hot_wallet === true &&
    (eth.executor as any).source_verification?.verified === true &&
    ETH_FLASH_EXECUTOR_PAYOUT_AUDITED === true;

  result.ready_for_flash_transaction_test = bnb.ready_for_flash_transaction_test === true || eth.ready_for_flash_transaction_test === true;
  result.executor_configured = (bnb.executor as any).configured === true;
  result.bsc_flash_executor_payout_audited = BSC_FLASH_EXECUTOR_PAYOUT_AUDITED;
  result.executor_address = (bnb.executor as any).address || null;
  result.executor_code_deployed = (bnb.executor as any).code_deployed === true;
  result.executor_bytecode_hash = (bnb.executor as any).bytecode_hash || null;
  result.source_verification = (bnb.executor as any).source_verification;
  result.payout_recipient_address = (bnb.executor as any).payout_recipient_address || null;
  result.payout_recipient_matches_generated_hot_wallet = (bnb.executor as any).payout_recipient_matches_generated_hot_wallet === true;
  result.matched_generated_wallet_id = (bnb.executor as any).matched_generated_wallet_id || null;
  result.aave_pool_resolved = bnb.aave_pool_resolved === true;
  result.aave_pool_address = bnb.aave_pool_address || null;
  result.ethereum_flash_executor_configured = (eth.executor as any).configured === true;
  result.ethereum_flash_executor_payout_audited = ETH_FLASH_EXECUTOR_PAYOUT_AUDITED;
  result.ethereum_flash_executor_address = (eth.executor as any).address || null;
  result.ethereum_payout_behavior_verified = false;
  result.ethereum_payout_recipient_address = (eth.executor as any).payout_recipient_address || null;
  result.ethereum_payout_recipient_matches_generated_hot_wallet = (eth.executor as any).payout_recipient_matches_generated_hot_wallet === true;
  result.ethereum_matched_generated_wallet_id = (eth.executor as any).matched_generated_wallet_id || null;
  result.ethereum_aave_pool_resolved = eth.aave_pool_resolved === true;
  result.ethereum_aave_pool_address = eth.aave_pool_address || null;
  return result;
}

async function quoteFlashRouter(router: string, amountIn: bigint, path: string[]) {
  const calldata = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path as `0x${string}`[]],
  });
  const encoded = await rpc("eth_call", [{ to: router, data: calldata }, "latest"]);
  const amounts = decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    data: encoded as `0x${string}`,
  }) as readonly bigint[];
  if (amounts.length !== path.length || amounts[amounts.length - 1] <= 0n) {
    throw new Error("flash_quote_no_liquidity");
  }
  return amounts[amounts.length - 1];
}

async function buildFlashOpportunityQuote(
  asset: string,
  amountRaw: string,
  slippageBps: number,
) {
  const normalizedAsset = asset.toLowerCase();
  if (normalizedAsset !== WBNB.toLowerCase() && normalizedAsset !== BSC_USDT.toLowerCase()) {
    throw new Error("flash_asset_not_allowlisted");
  }
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
    throw new Error("flash_amount_invalid");
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error("slippage_out_of_bounds");
  }

  const routers = [PANCAKE_V2_ROUTER, BISWAP_ROUTER_V2];
  const codes = await Promise.all(routers.map((router) => rpc("eth_getCode", [router, "latest"])));
  if (codes.some((code) => typeof code !== "string" || String(code).length <= 2)) {
    throw new Error("flash_router_bytecode_missing");
  }
  const pool = await resolveBscAavePool();
  const premiumCall = encodeFunctionData({ abi: FLASH_PREMIUM_ABI, functionName: "FLASHLOAN_PREMIUM_TOTAL" });
  const premiumRaw = await rpc("eth_call", [{ to: pool, data: premiumCall }, "latest"]);
  const premiumBps = BigInt(decodeFunctionResult({
    abi: FLASH_PREMIUM_ABI,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
    data: premiumRaw as `0x${string}`,
  }) as bigint);
  const amount = BigInt(amountRaw);
  const premium = (amount * premiumBps + 9999n) / 10000n;
  const gasPrice = BigInt(String(await rpc("eth_gasPrice", [])));
  // Conservative pre-deployment estimate for the flash callback plus two router swaps.
  const gasCostWbnb = 550000n * gasPrice;
  const intermediate = normalizedAsset === WBNB.toLowerCase() ? BSC_USDT : WBNB;
  const pathOut = [normalizedAsset === WBNB.toLowerCase() ? WBNB : BSC_USDT, intermediate];
  const pathBack = [intermediate, normalizedAsset === WBNB.toLowerCase() ? WBNB : BSC_USDT];
  let gasCostAsset = gasCostWbnb;
  if (normalizedAsset === BSC_USDT.toLowerCase()) {
    gasCostAsset = await quoteFlashRouter(PANCAKE_V2_ROUTER, gasCostWbnb, [WBNB, BSC_USDT]);
  }

  const candidates: any[] = [];
  for (const firstRouter of routers) {
    const secondRouter = routers.find((router) => router.toLowerCase() !== firstRouter.toLowerCase())!;
    try {
      const firstOut = await quoteFlashRouter(firstRouter, amount, pathOut);
      const finalOut = await quoteFlashRouter(secondRouter, firstOut, pathBack);
      const minimumFirstOut = firstOut * BigInt(10000 - slippageBps) / 10000n;
      const minimumFinalOut = finalOut * BigInt(10000 - slippageBps) / 10000n;
      const grossProfit = finalOut - amount;
      const netProfit = finalOut - amount - premium - gasCostAsset;
      const minProfitRaw = gasCostAsset + 1000000000000000000n; // estimated gas plus at least 1 USDT
      const executorConfigured = /^0x[a-fA-F0-9]{40}$/.test(BSC_FLASH_EXECUTOR);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 30);
      let callData: string[] = [];
      if (executorConfigured) {
        callData = [
          encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [amount, minimumFirstOut, pathOut as `0x${string}`[], BSC_FLASH_EXECUTOR as `0x${string}`, deadline],
          }),
          encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [firstOut, minimumFinalOut, pathBack as `0x${string}`[], BSC_FLASH_EXECUTOR as `0x${string}`, deadline],
          }),
        ];
      }
      candidates.push({
        asset: normalizedAsset,
        amount_raw: amount.toString(),
        first_router: firstRouter,
        second_router: secondRouter,
        targets: [firstRouter, secondRouter],
        values_raw: ["0", "0"],
        data: callData,
        first_output_raw: firstOut.toString(),
        minimum_first_output_raw: minimumFirstOut.toString(),
        final_output_raw: finalOut.toString(),
        minimum_final_output_raw: minimumFinalOut.toString(),
        gross_profit_raw: grossProfit.toString(),
        flash_premium_bps: premiumBps.toString(),
        flash_premium_raw: premium.toString(),
        estimated_gas_cost_raw: gasCostAsset.toString(),
        min_profit_raw: minProfitRaw.toString(),
        estimated_net_profit_raw: netProfit.toString(),
        profitable_after_flash_premium_and_gas: netProfit >= 1000000000000000000n,
        executor_configured: executorConfigured,
        slippage_bps_per_leg: slippageBps,
        deadline: deadline.toString(),
      });
    } catch (error) {
      candidates.push({
        asset: normalizedAsset,
        first_router: firstRouter,
        second_router: secondRouter,
        profitable_after_flash_premium_and_gas: false,
        quote_error: error instanceof Error ? error.message : "flash_quote_failed",
      });
    }
  }
  const priced = candidates.filter((candidate) => candidate.estimated_net_profit_raw !== undefined);
  priced.sort((a, b) => {
    const av = BigInt(a.estimated_net_profit_raw);
    const bv = BigInt(b.estimated_net_profit_raw);
    return av > bv ? -1 : av < bv ? 1 : 0;
  });
  const best = priced[0] || null;
  return {
    ok: true,
    source: "live_bsc_router_quotes",
    quoted_at: new Date().toISOString(),
    chain: "bnb",
    pair: "BNB/USDT",
    flash_loan_pool: pool,
    premium_bps: premiumBps.toString(),
    estimated_gas_price_wei: gasPrice.toString(),
    gas_estimate_units: "550000",
    gas_estimate_method: "conservative_pre-deployment_estimate",
    candidate_count: candidates.length,
    candidates,
    best,
    profitable: best?.profitable_after_flash_premium_and_gas === true,
    executable_unsigned: !!best && best.profitable_after_flash_premium_and_gas === true && best.executor_configured === true && Array.isArray(best.data) && best.data.length === 2,
    executor_configured: /^0x[a-fA-F0-9]{40}$/.test(BSC_FLASH_EXECUTOR),
  };
}


async function quoteEthereumFlashRouter(router: string, amountIn: bigint, path: string[]) {
  const calldata = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path as `0x${string}`[]],
  });
  const encoded = await ethereumRpc("eth_call", [{ to: router, data: calldata }, "latest"]);
  const amounts = decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    data: encoded as `0x${string}`,
  }) as readonly bigint[];
  if (amounts.length !== path.length || amounts[amounts.length - 1] <= 0n) {
    throw new Error("ethereum_flash_quote_no_liquidity");
  }
  return amounts[amounts.length - 1];
}

async function buildEthereumFlashOpportunityQuote(
  asset: string,
  amountRaw: string,
  slippageBps: number,
) {
  const normalizedAsset = asset.toLowerCase();
  if (normalizedAsset !== ETH_USDC.toLowerCase()) {
    throw new Error("ethereum_flash_quote_asset_not_allowlisted");
  }
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
    throw new Error("ethereum_flash_amount_invalid");
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error("slippage_out_of_bounds");
  }

  const routers = [ETH_UNISWAP_V2_ROUTER, ETH_SUSHISWAP_V2_ROUTER];
  const codes = await Promise.all(routers.map((router) => ethereumRpc("eth_getCode", [router, "latest"])));
  if (codes.some((code) => typeof code !== "string" || String(code).length <= 2)) {
    throw new Error("ethereum_flash_router_bytecode_missing");
  }

  const pool = await resolveEthereumAavePool();
  const premiumCall = encodeFunctionData({ abi: FLASH_PREMIUM_ABI, functionName: "FLASHLOAN_PREMIUM_TOTAL" });
  const premiumRaw = await ethereumRpc("eth_call", [{ to: pool, data: premiumCall }, "latest"]);
  const premiumBps = BigInt(decodeFunctionResult({
    abi: FLASH_PREMIUM_ABI,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
    data: premiumRaw as `0x${string}`,
  }) as bigint);
  const amount = BigInt(amountRaw);
  const premium = (amount * premiumBps + 9999n) / 10000n;

  const gasPrice = BigInt(String(await ethereumRpc("eth_gasPrice", [])));
  const gasEstimateUnits = 650000n;
  const gasCostWeth = gasEstimateUnits * gasPrice;
  const gasCostAsset = await quoteEthereumFlashRouter(
    ETH_UNISWAP_V2_ROUTER,
    gasCostWeth,
    [ETH_WETH, ETH_USDC],
  );
  const pathOut = [ETH_USDC, ETH_WETH];
  const pathBack = [ETH_WETH, ETH_USDC];
  const candidates: any[] = [];

  for (const firstRouter of routers) {
    const secondRouter = routers.find((router) => router.toLowerCase() !== firstRouter.toLowerCase())!;
    try {
      const firstOut = await quoteEthereumFlashRouter(firstRouter, amount, pathOut);
      const finalOut = await quoteEthereumFlashRouter(secondRouter, firstOut, pathBack);
      const minimumFirstOut = firstOut * BigInt(10000 - slippageBps) / 10000n;
      const minimumFinalOut = finalOut * BigInt(10000 - slippageBps) / 10000n;
      const grossProfit = finalOut - amount;
      const estimatedNetProfit = finalOut - amount - premium - gasCostAsset;
      const minProfitRaw = gasCostAsset + 1000000n; // cover estimated gas and at least $1 USDC
      const executorConfigured = /^0x[a-fA-F0-9]{40}$/.test(ETH_FLASH_EXECUTOR);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 30);
      let callData: string[] = [];
      if (executorConfigured) {
        callData = [
          encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [amount, minimumFirstOut, pathOut as `0x${string}`[], ETH_FLASH_EXECUTOR as `0x${string}`, deadline],
          }),
          encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [firstOut, minimumFinalOut, pathBack as `0x${string}`[], ETH_FLASH_EXECUTOR as `0x${string}`, deadline],
          }),
        ];
      }
      candidates.push({
        asset: ETH_USDC,
        amount_raw: amount.toString(),
        first_router: firstRouter,
        second_router: secondRouter,
        targets: [firstRouter, secondRouter],
        values_raw: ["0", "0"],
        data: callData,
        first_output_raw: firstOut.toString(),
        minimum_first_output_raw: minimumFirstOut.toString(),
        final_output_raw: finalOut.toString(),
        minimum_final_output_raw: minimumFinalOut.toString(),
        gross_profit_raw: grossProfit.toString(),
        flash_premium_bps: premiumBps.toString(),
        flash_premium_raw: premium.toString(),
        estimated_gas_cost_raw: gasCostAsset.toString(),
        min_profit_raw: minProfitRaw.toString(),
        estimated_net_profit_raw: estimatedNetProfit.toString(),
        profitable_after_flash_premium_and_gas: estimatedNetProfit >= 1000000n,
        executor_configured: executorConfigured,
        slippage_bps_per_leg: slippageBps,
        deadline: deadline.toString(),
      });
    } catch (error) {
      candidates.push({
        asset: ETH_USDC,
        first_router: firstRouter,
        second_router: secondRouter,
        profitable_after_flash_premium_and_gas: false,
        quote_error: error instanceof Error ? error.message : "ethereum_flash_quote_failed",
      });
    }
  }

  const priced = candidates.filter((candidate) => candidate.estimated_net_profit_raw !== undefined);
  priced.sort((a, b) => {
    const av = BigInt(a.estimated_net_profit_raw);
    const bv = BigInt(b.estimated_net_profit_raw);
    return av > bv ? -1 : av < bv ? 1 : 0;
  });
  const best = priced[0] || null;
  return {
    ok: true,
    source: "live_ethereum_router_quotes",
    quoted_at: new Date().toISOString(),
    chain: "ethereum",
    pair: "ETH/USDC",
    flash_loan_pool: pool,
    premium_bps: premiumBps.toString(),
    estimated_gas_price_wei: gasPrice.toString(),
    gas_estimate_units: gasEstimateUnits.toString(),
    gas_estimate_method: "conservative_estimate_for_flash_callback_and_two_router_swaps",
    candidate_count: candidates.length,
    candidates,
    best,
    profitable: best?.profitable_after_flash_premium_and_gas === true,
    executable_unsigned: !!best && best.profitable_after_flash_premium_and_gas === true && best.executor_configured === true && Array.isArray(best.data) && best.data.length === 2,
    executor_configured: /^0x[a-fA-F0-9]{40}$/.test(ETH_FLASH_EXECUTOR),
  };
}

async function buildAtomicFlashLoan(
  chain: "bnb" | "ethereum",
  owner: string,
  asset: string,
  amountRaw: string,
  minProfitRaw: string,
  targets: string[],
  valuesRaw: string[],
  data: string[],
) {
  const executor = chain === "ethereum" ? ETH_FLASH_EXECUTOR : BSC_FLASH_EXECUTOR;
  const chainId = chain === "ethereum" ? "1" : "56";
  const expectedChainId = chain === "ethereum" ? 1 : 56;
  const executorRpc = chain === "ethereum" ? ethereumRpc : rpc;
  const payoutAudited = chain === "ethereum" ? ETH_FLASH_EXECUTOR_PAYOUT_AUDITED : BSC_FLASH_EXECUTOR_PAYOUT_AUDITED;
  const allowedTargets = chain === "ethereum" ? ETH_ATOMIC_ALLOWED_TARGETS : BSC_ATOMIC_ALLOWED_TARGETS;
  if (!executor || !/^0x[a-fA-F0-9]{40}$/.test(executor)) throw new Error("atomic_executor_not_configured");
  const executorCode = String(await executorRpc("eth_getCode", [executor, "latest"]));
  if (!/^0x[0-9a-f]+$/i.test(executorCode) || executorCode.length <= 2) {
    throw new Error("atomic_executor_code_missing");
  }
  const payoutGetterData = encodeFunctionData({ abi: FLASH_EXECUTOR_PAYOUT_ABI, functionName: "HOT_WALLET" });
  const payoutRaw = String(await executorRpc("eth_call", [{ to: executor, data: payoutGetterData }, "latest"]));
  const payoutWallet = decodeFunctionResult({
    abi: FLASH_EXECUTOR_PAYOUT_ABI,
    functionName: "HOT_WALLET",
    data: payoutRaw as `0x${string}`,
  }) as string;
  if (payoutWallet.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("flash_executor_payout_wallet_mismatch");
  }
  const payoutVerification = await lookupSourcifyVerification(chainId, executor);
  if (payoutVerification.verified !== true) throw new Error("flash_executor_source_unverified");
  if (!payoutAudited) {
    throw new Error("flash_executor_payout_unverified");
  }
  const aavePool = chain === "ethereum" ? await resolveEthereumAavePool() : await resolveBscAavePool();
  const allowedAssets = chain === "ethereum" ? [ETH_WETH, ETH_USDC] : [WBNB, BSC_USDT];
  if (!/^0x[a-fA-F0-9]{40}$/.test(asset) || !allowedAssets.some((token) => token.toLowerCase() === asset.toLowerCase())) throw new Error("flash_asset_not_allowlisted_for_chain");
  if (targets.length !== 2 || targets.length !== valuesRaw.length || targets.length !== data.length || targets[0].toLowerCase() === targets[1].toLowerCase()) throw new Error("atomic_leg_shape_invalid");
  for (const target of targets) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(target) || !allowedTargets.has(target.toLowerCase())) throw new Error("atomic_target_not_allowlisted");
  }
  for (const value of valuesRaw) if (!/^\d+$/.test(value)) throw new Error("atomic_value_invalid");
  for (const callData of data) {
    if (!/^0x[0-9a-fA-F]*$/.test(callData) || callData.length < 10) throw new Error("atomic_calldata_invalid");
  }
  const amount = BigInt(amountRaw);
  const minProfit = BigInt(minProfitRaw || "0");
  if (amount <= 0n || minProfit <= 0n) throw new Error("invalid_atomic_amounts");
  const encoded = encodeFunctionData({
    abi: FLASH_EXECUTOR_ABI,
    functionName: "executeFlashLoan",
    args: [
      asset as `0x${string}`,
      amount,
      minProfit,
      targets as `0x${string}`[],
      valuesRaw.map((v) => BigInt(v)),
      data as `0x${string}`[],
    ],
  });
  const nonce = toBigInt(await executorRpc("eth_getTransactionCount", [owner, "pending"]));
  const gasPrice = toBigInt(await executorRpc("eth_gasPrice", []));
  const gas = toBigInt(await executorRpc("eth_estimateGas", [{ from: owner, to: executor, data: encoded, value: "0x0" }]));
  const transaction = {
    chainId: expectedChainId, nonce: toHex(nonce), to: executor, value: "0x0",
    data: encoded, gas: toHex(gas), gasPrice: toHex(gasPrice), from: owner,
  };
  const serializedPayload = JSON.stringify(transaction);
  return {
    builder: "aave_v3_atomic_flash_loan_v1", chain, source: owner,
    executor: executor, flash_loan_pool: aavePool,
    flash_loan_asset: asset, flash_loan_amount: amount.toString(),
    minimum_profit: minProfit.toString(), targets, values: valuesRaw,
    leg_count: targets.length, transaction: serializedPayload,
    transaction_format: "evm_json",
    transaction_payload_hash: await sha256(serializedPayload),
    executable: true, atomic: true, builder_signs: false, builder_broadcasts: false,
    repayment_required_in_same_transaction: true,
    reference: chain === "ethereum" ? "Ethereum Aave V3 flashLoanSimple + Uniswap V2 ArbiVault executor" : "BNB Aave V3 flashLoanSimple + PancakeSwap V2/Biswap V2 ArbiVault executor",
  };
}
async function buildUniswap(
  taker: string,
  pair: string,
  side: string,
  amountRaw: string,
  slippageBps: number,
  quoteOnly = false,
) {
  if (pair !== "ETH/USDC" || !["buy", "sell"].includes(side)) {
    throw new Error("pair_not_allowlisted_for_uniswap_v2");
  }
  const amountIn = BigInt(amountRaw);
  if (amountIn <= 0n) throw new Error("invalid_amount_raw");
  const path = side === "sell" ? [ETH_WETH, ETH_USDC] : [ETH_USDC, ETH_WETH];
  const quoteData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path as `0x${string}`[]],
  });
  const quoteEncoded = await ethereumRpc("eth_call", [
    { to: ETH_UNISWAP_V2_ROUTER, data: quoteData },
    "latest",
  ]);
  const amounts = decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    data: quoteEncoded as `0x${string}`,
  }) as readonly bigint[];
  const expectedOut = amounts[amounts.length - 1];
  if (expectedOut <= 0n) throw new Error("uniswap_quote_no_liquidity");
  const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

  if (quoteOnly) {
    return {
      builder: "uniswap_v2",
      chain: "ethereum",
      pair,
      side,
      source: taker,
      transaction: null,
      transaction_format: "evm_json",
      transaction_payload_hash: null,
      expected_out: expectedOut.toString(),
      minimum_out: minOut.toString(),
      input_amount: amountRaw,
      slippage_bps: slippageBps,
      router: ETH_UNISWAP_V2_ROUTER,
      executable: false,
      quoted: true,
      broadcast_by_builder: false,
      reference: "Uniswap V2 router",
    };
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30);
  let data: string;
  let value = 0n;
  if (side === "sell") {
    data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [minOut, path as `0x${string}`[], taker as `0x${string}`, deadline],
    });
    value = amountIn;
  } else {
    const allowanceData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [taker as `0x${string}`, ETH_UNISWAP_V2_ROUTER as `0x${string}`],
    });
    const allowanceRaw = await ethereumRpc("eth_call", [
      { to: ETH_USDC, data: allowanceData },
      "latest",
    ]);
    if (BigInt(String(allowanceRaw)) < amountIn) {
      throw new Error("uniswap_router_allowance_insufficient_for_usdc_input");
    }
    data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForETH",
      args: [amountIn, minOut, path as `0x${string}`[], taker as `0x${string}`, deadline],
    });
  }

  const nonce = BigInt(String(await ethereumRpc("eth_getTransactionCount", [taker, "pending"])));
  const gasPrice = BigInt(String(await ethereumRpc("eth_gasPrice", [])));
  const gas = BigInt(String(await ethereumRpc("eth_estimateGas", [{
    from: taker,
    to: ETH_UNISWAP_V2_ROUTER,
    data,
    value: toHex(value),
  }])));
  if (gas <= 0n || gasPrice <= 0n) throw new Error("uniswap_fee_fields_invalid");
  const transaction = {
    chainId: 1,
    nonce: toHex(nonce),
    to: ETH_UNISWAP_V2_ROUTER,
    value: toHex(value),
    data,
    gas: toHex(gas),
    gasPrice: toHex(gasPrice),
    from: taker,
  };
  const serializedPayload = JSON.stringify(transaction);
  return {
    builder: "uniswap_v2",
    chain: "ethereum",
    pair,
    side,
    source: taker,
    transaction: serializedPayload,
    transaction_format: "evm_json",
    transaction_payload_hash: await sha256(serializedPayload),
    expected_out: expectedOut.toString(),
    minimum_out: minOut.toString(),
    input_amount: amountRaw,
    slippage_bps: slippageBps,
    router: ETH_UNISWAP_V2_ROUTER,
    executable: true,
    broadcast_by_builder: false,
    reference: "Uniswap V2 router",
  };
}

async function buildPancake(
  taker: string,
  pair: string,
  side: string,
  amountRaw: string,
  slippageBps: number,
  quoteOnly = false,
) {
  const assets = routeAssets("bnb", pair, side);
  if (!("inputToken" in assets) || !assets.inputToken || !assets.outputToken) {
    throw new Error("pancakeswap_route_assets_invalid");
  }
  const inputToken = assets.inputToken as `0x${string}`;
  const outputToken = assets.outputToken as `0x${string}`;
  const toAddress = taker as `0x${string}`;
  const amountIn = BigInt(amountRaw);

  const quoteData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [inputToken, outputToken]],
  });

  const quoteEncoded = await rpc("eth_call", [
    { to: PANCAKE_V2_ROUTER, data: quoteData },
    "latest",
  ]);

  const amounts = decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    data: quoteEncoded as `0x${string}`,
  }) as readonly bigint[];

  const expectedOut = amounts[amounts.length - 1];
  const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

  if (quoteOnly) {
    return {
      builder: "pancakeswap_v2",
      chain: "bnb",
      pair,
      side,
      source: taker,
      transaction: null,
      transaction_format: "evm_json",
      transaction_payload_hash: null,
      expected_out: expectedOut.toString(),
      minimum_out: minOut.toString(),
      input_amount: amountRaw,
      slippage_bps: slippageBps,
      router: PANCAKE_V2_ROUTER,
      executable: false,
      quoted: true,
      broadcast_by_builder: false,
      reference: "PancakeSwap V2 router",
    };
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30);
  const nonce = toBigInt(await rpc("eth_getTransactionCount", [taker, "pending"]));
  const gasPrice = toBigInt(await rpc("eth_gasPrice", []));

  let data: string;
  let value = 0n;

  if (side === "sell") {
    data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [minOut, [WBNB, BSC_USDT], toAddress, deadline],
    });
    value = amountIn;
  } else {
    if (!quoteOnly) {
      const allowanceCall = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [toAddress, PANCAKE_V2_ROUTER],
      });
      const allowanceRaw = await rpc("eth_call", [
        { to: BSC_USDT, data: allowanceCall },
        "latest",
      ]);
      if (toBigInt(allowanceRaw) < amountIn) {
        throw new Error("pancakeswap_router_allowance_insufficient_for_usdt_input");
      }
    }

    data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForETH",
      args: [amountIn, minOut, [BSC_USDT, WBNB], toAddress, deadline],
    });
  }

  const gas = toBigInt(
    await rpc("eth_estimateGas", [{
      from: taker,
      to: PANCAKE_V2_ROUTER,
      data,
      value: toHex(value),
    }]),
  );

  const transaction = {
    chainId: 56,
    nonce: toHex(nonce),
    to: PANCAKE_V2_ROUTER,
    value: toHex(value),
    data,
    gas: toHex(gas),
    gasPrice: toHex(gasPrice),
    from: taker,
  };

  const serializedPayload = JSON.stringify(transaction);

  return {
    builder: "pancakeswap_v2",
    chain: "bnb",
    pair,
    side,
    source: taker,
    transaction: serializedPayload,
    transaction_format: "evm_json",
    transaction_payload_hash: await sha256(serializedPayload),
    expected_out: expectedOut.toString(),
    minimum_out: minOut.toString(),
    input_amount: amountRaw,
    slippage_bps: slippageBps,
    router: PANCAKE_V2_ROUTER,
    executable: true,
    broadcast_by_builder: false,
    reference: "PancakeSwap V2 router",
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST" || !(await authorized(req))) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    await syncExecutorRegistry();
    const body = await req.json();
    if (body?.mode === "diagnostic") {
      return json(await diagnoseFlashExecutor());
    }
    const routeId = String(body.route_id || "");
    const sourceWalletId = String(body.source_wallet_id || "");
    const side = String(body.side || "sell").toLowerCase();
    const amountRaw = String(body.amount_raw || "");
    const slippageBps = Number(body.slippage_bps ?? 50);
    const priceImpactPct = Number(body.price_impact_pct ?? 0);
    const mode = body.mode === "quote" ? "quote" : "build";

    if (!routeId || !sourceWalletId || !amountRaw || !["buy", "sell"].includes(side)) {
      return json({ error: "invalid_request" }, 400);
    }
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
      return json({ error: "invalid_amount_raw" }, 400);
    }
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
      return json({ error: "slippage_out_of_bounds" }, 400);
    }
    if (Number.isFinite(priceImpactPct) && priceImpactPct > MAX_PRICE_IMPACT_PCT) {
      return json({
        error: "price_impact_above_execution_limit",
        max_price_impact_pct: MAX_PRICE_IMPACT_PCT,
        price_impact_pct: priceImpactPct,
      }, 409);
    }

    const { data: route, error: routeError } = await supabase
      .from("arbivault_strategy_routes")
      .select("id,strategy,strategy_family,chain,pair,dex_venue,route_type,enabled,discovery_only,builder_enabled,transaction_builder,strategy_bot_id")
      .eq("id", routeId)
      .maybeSingle();

    if (routeError) return json({ error: routeError.message }, 500);
    if (!route || route.enabled !== true) return json({ error: "route_not_enabled" }, 404);
    if (route.discovery_only === true) return json({ error: "discovery_only_route_cannot_execute" }, 409);
    const isAtomicFlashRoute =
      route.transaction_builder === "aave_v3_atomic_flash_loan_v1" &&
      route.route_type === "flash_liquidity";
    if (!builderRouteCompatible(route)) {
      return json({
        error: "route_builder_chain_pair_mismatch",
        chain: route.chain,
        pair: route.pair,
        route_type: route.route_type,
        transaction_builder: route.transaction_builder,
      }, 409);
    }
    const quoteOnlyMode = body.mode === "flash_quote" || body.mode === "quote";
    // Pending executor routes may continue read-only quotes while builder_enabled=false.
    // Every other request still fails closed until the route is explicitly enabled.
    if (
      !route.transaction_builder ||
      (route.builder_enabled !== true && !(quoteOnlyMode && isAtomicFlashRoute))
    ) {
      return json({ error: "transaction_builder_not_configured" }, 409);
    }
    if (!isAtomicFlashRoute && !["dex_cex","cyclic","multi_venue"].includes(route.route_type)) {
      return json({ error: "route_type_not_supported_by_spot_builder" }, 409);
    }

    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("id,owner_id,chain,address,status,is_hot,wallet_role,data_quality_status")
      .eq("id", sourceWalletId)
      .maybeSingle();

    if (walletError) return json({ error: "source_wallet_lookup_failed" }, 503);
    if (!wallet || wallet.status !== "active" || wallet.is_hot !== true || wallet.wallet_role !== "trading_hot") {
      return json({ error: "source_wallet_not_active_trading_hot" }, 403);
    }
    if (wallet.chain !== route.chain) return json({ error: "wallet_route_chain_mismatch" }, 403);

    // Read-only quotes can run without wallet approval; building an executable
    // payload requires verified provenance plus explicit owner-scoped approval.
    if (!quoteOnlyMode) {
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
      if (!approvedWallet) return json({ error: "source_wallet_not_approved" }, 403);
    }

    if (body.mode === "flash_quote") {
      if (!isAtomicFlashRoute) {
        return json({ error: "flash_quote_route_not_supported" }, 409);
      }
      let quote: any;
      if (route.chain === "bnb" && route.pair === "BNB/USDT") {
        quote = await buildFlashOpportunityQuote(
          String(body.flash_loan_asset || BSC_USDT),
          amountRaw,
          slippageBps,
        );
      } else if (route.chain === "ethereum" && route.pair === "ETH/USDC") {
        quote = await buildEthereumFlashOpportunityQuote(
          String(body.flash_loan_asset || ETH_USDC),
          amountRaw,
          slippageBps,
        );
      } else {
        return json({ error: "flash_quote_route_not_supported" }, 409);
      }
      return json({ route_id: route.id, source_wallet: wallet.address, mode: "flash_quote", ...quote });
    }

    const built = route.transaction_builder === "aave_v3_atomic_flash_loan_v1"
      ? await buildAtomicFlashLoan(
          route.chain === "ethereum" ? "ethereum" : "bnb",
          wallet.address,
          String(body.flash_loan_asset || ""),
          amountRaw,
          String(body.min_profit_raw || "0"),
          Array.isArray(body.targets) ? body.targets.map(String) : [],
          Array.isArray(body.values_raw) ? body.values_raw.map(String) : [],
          Array.isArray(body.data) ? body.data.map(String) : [],
        )
      : route.transaction_builder === "jupiter_swap_v2"
        ? await buildJupiter(wallet.address, route.pair, side, amountRaw, slippageBps)
        : route.transaction_builder === "pancakeswap_v2"
          ? await buildPancake(wallet.address, route.pair, side, amountRaw, slippageBps, mode === "quote")
          : route.transaction_builder === "uniswap_v2"
            ? await buildUniswap(wallet.address, route.pair, side, amountRaw, slippageBps, mode === "quote")
            : null;

    if (!built) return json({ error: "unsupported_transaction_builder" }, 409);

    return json({
      ok: true,
      route: {
        id: route.id,
        strategy: route.strategy,
        strategy_bot_id: route.strategy_bot_id,
        chain: route.chain,
        pair: route.pair,
        route_type: route.route_type,
        dex_venue: route.dex_venue,
        discovery_only: route.discovery_only,
        builder: route.transaction_builder,
      },
      mode,
      address_resolution: route.transaction_builder === "aave_v3_atomic_flash_loan_v1"
        ? {
            network: route.chain === "ethereum" ? "Ethereum mainnet" : "BNB Smart Chain mainnet",
            chain_id: route.chain === "ethereum" ? 1 : 56,
            executor_address: (route.chain === "ethereum" ? ETH_FLASH_EXECUTOR : BSC_FLASH_EXECUTOR) || null,
            aave_provider_address: route.chain === "ethereum" ? ETH_AAVE_PROVIDER : BSC_AAVE_PROVIDER,
            aave_pool_address: (built as any).flash_loan_pool || null,
            executor_configured: /^0x[a-fA-F0-9]{40}$/.test(route.chain === "ethereum" ? ETH_FLASH_EXECUTOR : BSC_FLASH_EXECUTOR),
            pool_resolved_on_chain: !!(built as any).flash_loan_pool,
          }
        : null,
      policy: {
        builder_creates_unsigned_only: true,
        builder_never_signs: true,
        builder_never_broadcasts: true,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        max_price_impact_pct: MAX_PRICE_IMPACT_PCT,
      },
      ...built,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "transaction_builder_error";
    return json({ error: message }, message === "flash_executor_payout_unverified" ? 409 : 500);
  }
});
