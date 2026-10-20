import { createPublicClient, http, parseAbi, formatUnits, isAddress } from "npm:viem@2.39.0";
import { base } from "npm:viem@2.39.0/chains";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const X402_BASE_URL = Deno.env.get("X402_BASE_URL") || "https://x402-data-api.sigrunner.workers.dev";
const BASE_RPC_URL = Deno.env.get("BASE_RPC_URL") || "https://mainnet.base.org";
const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return json({ error: "authentication_required" }, 401);
  }

  // Verify the caller's Supabase JWT; do not expose the service-role key to clients.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: authError } = await userClient.auth.getUser();
  if (authError || !userData.user) return json({ error: "invalid_session" }, 401);

  let input: { wallets?: unknown; tokens?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const wallets = Array.isArray(input.wallets) ? input.wallets : [];
  const tokens = Array.isArray(input.tokens) ? input.tokens : [];
  if (wallets.length < 1 || wallets.length > 50) {
    return json({ error: "wallets_must_contain_1_to_50_addresses" }, 400);
  }
  if (tokens.length > 100) return json({ error: "maximum_100_tokens_per_run" }, 400);
  if (!wallets.every((value) => typeof value === "string" && isAddress(value))) {
    return json({ error: "invalid_wallet_address" }, 400);
  }
  if (!tokens.every((value) => typeof value === "string" && isAddress(value))) {
    return json({ error: "invalid_erc20_contract_address" }, 400);
  }

  try {
    const client = createPublicClient({ chain: base, transport: http(BASE_RPC_URL, { timeout: 10000, retryCount: 1 }) });

    // These two preview endpoints are free and do not trigger an x402 payment challenge.
    const [gasPreview, blockPreview] = await Promise.all([
      (async () => {
        try {
          const response = await fetch(`${X402_BASE_URL}/chain/gas-price/preview`, {
            headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000),
          });
          if (!response.ok) throw new Error(`gas_preview_http_${response.status}`);
          return await response.json() as Record<string, unknown>;
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          const response = await fetch(`${X402_BASE_URL}/chain/block-number/preview`, {
            headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000),
          });
          if (!response.ok) throw new Error(`block_preview_http_${response.status}`);
          return await response.json() as Record<string, unknown>;
        } catch {
          return null;
        }
      })(),
    ]);

    const [blockNumber, gasPrice, baseFeePerGas, priorityFeePerGas, ethUsd] = await Promise.all([
      client.getBlockNumber(),
      client.getGasPrice(),
      client.getBlock().then((block) => block.baseFeePerGas ?? null),
      client.estimateMaxPriorityFeePerGas().catch(() => null),
      (async () => {
        // Public price lookup is only for USD display; balances themselves come from Base RPC.
        try {
          const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) return null;
          const body = await response.json();
          const value = Number(body?.data?.amount);
          return Number.isFinite(value) && value > 0 ? value : null;
        } catch {
          return null;
        }
      })(),
    ]);

    const walletResults = await Promise.all(wallets.map(async (walletAddress: string) => {
      const nativeRaw = await client.getBalance({ address: walletAddress as `0x${string}` });
      const native = Number(formatUnits(nativeRaw, 18));
      const tokensForWallet = await Promise.all(tokens.map(async (tokenAddress: string) => {
        try {
          const [rawBalance, decimals, symbol] = await Promise.all([
            client.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [walletAddress as `0x${string}`] }),
            client.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" }),
            client.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }),
          ]);
          return {
            contract_address: tokenAddress,
            symbol: String(symbol),
            decimals: Number(decimals),
            balance_raw: rawBalance.toString(),
            balance_formatted: formatUnits(rawBalance, Number(decimals)),
            source: "Base public RPC",
          };
        } catch {
          return { contract_address: tokenAddress, error: "token_query_failed", source: "Base public RPC" };
        }
      }));
      return {
        address: walletAddress,
        balance_wei: nativeRaw.toString(),
        balance_eth: formatUnits(nativeRaw, 18),
        balance_usd: ethUsd === null ? null : Number((native * ethUsd).toFixed(2)),
        eth_usd_price: ethUsd,
        tokens: tokensForWallet,
        source: "Base public RPC",
      };
    }));

    const previewNumber = (source: Record<string, unknown> | null, ...keys: string[]) => {
      for (const key of keys) {
        const value = source?.[key];
        if (typeof value === "string" || typeof value === "number") {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) return parsed;
        }
      }
      return null;
    };
    const gasPriceGwei = Number(formatUnits(gasPrice, 9));
    const previewGasWei = gasPreview?.gas_price_wei;
    const gasPriceWeiText = typeof previewGasWei === "string" && previewGasWei.length > 0 ? previewGasWei : gasPrice.toString();
    const previewBlock = previewNumber(blockPreview, "block_number", "latest_block_number");
    const gasPriceUsd = ethUsd === null ? null : Number((Number(formatUnits(gasPrice, 18)) * ethUsd).toFixed(8));

    return json({
      ok: true,
      chain: "Base",
      chain_id: 8453,
      run_cost_usd: 0.001,
      run_cost_note: "Configured estimate per batch run; no per-wallet or per-token RPC markup. No payment is collected by this function.",
      checked_at: new Date().toISOString(),
      network: {
        block_number: previewBlock ?? Number(blockNumber),
        gas_price_wei: gasPriceWeiText,
        gas_price_gwei: previewNumber(gasPreview, "gas_price_gwei") ?? gasPriceGwei,
        base_fee_wei: baseFeePerGas?.toString() ?? null,
        base_fee_gwei: previewNumber(gasPreview, "base_fee_gwei") ?? (baseFeePerGas === null ? null : Number(formatUnits(baseFeePerGas, 9))),
        max_priority_fee_wei: priorityFeePerGas?.toString() ?? null,
        max_priority_fee_gwei: previewNumber(gasPreview, "priority_fee_gwei", "max_priority_fee_gwei") ?? (priorityFeePerGas === null ? null : Number(formatUnits(priorityFeePerGas, 9))),
        gas_price_usd: previewNumber(gasPreview, "gas_price_usd") ?? gasPriceUsd,
        gas_source: gasPreview && gasPreview.gas_price_gwei !== undefined ? "x402 free preview" : "Base public RPC fallback",
        block_source: blockPreview && (blockPreview.block_number !== undefined || blockPreview.latest_block_number !== undefined) ? "x402 free preview" : "Base public RPC fallback",
        preview_verdict: null,
        preview_decision: null,
        preview_risk_score: null,
        preview_status: gasPreview && blockPreview ? "available" : "partial_or_fallback",
        eth_usd_price: ethUsd,
        eth_usd_source: ethUsd === null ? null : "Coinbase public spot price",
      },
      wallets: walletResults,
      execution_authorized: false,
      transaction_broadcast: false,
    });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "base_wallet_snapshot_failed",
      transaction_broadcast: false,
    }, 502);
  }
});
