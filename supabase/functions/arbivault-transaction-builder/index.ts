import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "npm:viem@2.39.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BSC_RPC = Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org";
const JUPITER_API_KEY = Deno.env.get("JUPITER_API_KEY") || "";

const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
]);

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
  const response = await fetch(BSC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  if (!response.ok) throw new Error(`bsc_rpc_http_${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`bsc_rpc_${body.error.code}`);
  return body.result;
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
  if (!body?.transaction) {
    throw new Error(body?.errorMessage || "jupiter_transaction_unavailable");
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

async function buildPancake(
  taker: string,
  pair: string,
  side: string,
  amountRaw: string,
  slippageBps: number,
  quoteOnly = false,
) {
  const assets = routeAssets("bnb", pair, side);
  const amountIn = BigInt(amountRaw);

  const quoteData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [assets.inputToken, assets.outputToken]],
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
      args: [minOut, [WBNB, BSC_USDT], taker, deadline],
    });
    value = amountIn;
  } else {
    if (!quoteOnly) {
      const allowanceCall = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [taker, PANCAKE_V2_ROUTER],
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
      args: [amountIn, minOut, [BSC_USDT, WBNB], taker, deadline],
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
    const body = await req.json();
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
    if (route.builder_enabled !== true || !route.transaction_builder) {
      return json({ error: "transaction_builder_not_configured" }, 409);
    }
    if (!["dex_cex","cyclic","multi_venue"].includes(route.route_type)) {
      return json({ error: "route_type_not_supported_by_spot_builder" }, 409);
    }

    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("id,chain,address,status,is_hot,wallet_role")
      .eq("id", sourceWalletId)
      .maybeSingle();

    if (walletError) return json({ error: walletError.message }, 500);
    if (!wallet || wallet.status !== "active" || wallet.is_hot !== true || wallet.wallet_role !== "trading_hot") {
      return json({ error: "source_wallet_not_active_trading_hot" }, 403);
    }
    if (wallet.chain !== route.chain) return json({ error: "wallet_route_chain_mismatch" }, 403);

    const built = route.transaction_builder === "jupiter_swap_v2"
      ? await buildJupiter(wallet.address, route.pair, side, amountRaw, slippageBps)
      : route.transaction_builder === "pancakeswap_v2"
        ? await buildPancake(wallet.address, route.pair, side, amountRaw, slippageBps, mode === "quote")
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
    return json({
      error: error instanceof Error ? error.message : "transaction_builder_error",
    }, 500);
  }
});
