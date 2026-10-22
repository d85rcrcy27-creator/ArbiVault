import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { decodeEventLog, parseAbi } from "npm:viem@2.39.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FLASH_SETTLED_ABI = parseAbi([
  "event FlashLoanSettled(address indexed asset,uint256 amount,uint256 premium,uint256 profitPaid,address indexed hotWallet)",
]);

const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
const ETH_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BSC_WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const ETH_WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

async function authorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data } = await supabase.rpc("get_bot_cron_token");
  return !!data && supplied === data;
}

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("rpc_http_" + response.status);
  const body = await response.json();
  if (body.error) throw new Error("rpc_" + (body.error.code || "error"));
  return body.result;
}

function decodeFlashSettlement(receipt: any): Record<string, string> | null {
  for (const log of Array.isArray(receipt?.logs) ? receipt.logs : []) {
    try {
      const decoded: any = decodeEventLog({
        abi: FLASH_SETTLED_ABI,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded.eventName !== "FlashLoanSettled") continue;
      const args = decoded.args || {};
      return {
        asset: String(args.asset || ""),
        amount_raw: String(args.amount ?? ""),
        premium_raw: String(args.premium ?? ""),
        profit_paid_raw: String(args.profitPaid ?? ""),
        hot_wallet: String(args.hotWallet || ""),
      };
    } catch {
      // Most receipt logs are unrelated token/router logs. Continue until the
      // executor's known settlement event is found.
    }
  }
  return null;
}

async function checkConfirmation(chain: string, txHash: string) {
  if (chain === "bnb" || chain === "ethereum") {
    const endpoint = chain === "ethereum"
      ? Deno.env.get("ETHEREUM_RPC_URL") || "https://ethereum-rpc.publicnode.com"
      : Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org";
    const receipt: any = await rpc(endpoint, "eth_getTransactionReceipt", [txHash]);
    if (!receipt) return { confirmed: false, pending: true };
    const gasUsed = BigInt(receipt.gasUsed || "0x0");
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice || receipt.gasPrice || "0x0");
    const feeRaw = gasUsed * effectiveGasPrice;
    const succeeded = receipt.status === "0x1";
    return {
      confirmed: true,
      succeeded,
      failure_reason: succeeded ? null : "transaction_reverted",
      fee_native_raw: feeRaw.toString(),
      fee_native: Number(feeRaw) / 1e18,
      fee_asset: chain === "bnb" ? "BNB" : "ETH",
      block_number: receipt.blockNumber || null,
      flash_settlement: succeeded ? decodeFlashSettlement(receipt) : null,
    };
  }

  if (chain === "solana") {
    const endpoint = Deno.env.get("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
    const statuses = await rpc(
      endpoint,
      "getSignatureStatuses",
      [[txHash], { searchTransactionHistory: true }],
    );
    const status = statuses?.value?.[0];
    if (!status) return { confirmed: false, pending: true };
    const finalized = status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
    if (!finalized) return { confirmed: false, pending: true, slot: status.slot || null };

    let feeRaw: bigint | null = null;
    try {
      const tx: any = await rpc(endpoint, "getTransaction", [
        txHash,
        { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (tx?.meta?.fee != null) feeRaw = BigInt(tx.meta.fee);
    } catch {
      // Confirmation remains valid if transaction history is lagging; fee stays unknown.
    }
    const succeeded = status.err == null;
    return {
      confirmed: true,
      succeeded,
      failure_reason: succeeded ? null : "transaction_reverted",
      error: status.err || null,
      slot: status.slot || null,
      fee_native_raw: feeRaw?.toString() ?? null,
      fee_native: feeRaw === null ? null : Number(feeRaw) / 1e9,
      fee_asset: "SOL",
    };
  }

  if (chain === "bitcoin") {
    const response = await fetch(
      "https://mempool.space/api/tx/" + encodeURIComponent(txHash),
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) },
    );
    if (response.status === 404) return { confirmed: false, pending: true };
    if (!response.ok) throw new Error("bitcoin_tx_http_" + response.status);
    const tx = await response.json();
    const confirmed = !!tx?.status?.confirmed;
    if (!confirmed) return { confirmed: false, pending: true };
    const feeSats = tx?.fee == null ? null : BigInt(tx.fee);
    return {
      confirmed: true,
      succeeded: true,
      block_height: tx?.status?.block_height ?? null,
      fee_native_raw: feeSats?.toString() ?? null,
      fee_native: feeSats === null ? null : Number(feeSats) / 1e8,
      fee_asset: "BTC",
    };
  }

  throw new Error("confirmation_chain_not_supported");
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rawTokenAmountUsd(raw: string, decimals: number, usdPrice: number): number | null {
  if (!/^\d+$/.test(raw) || !Number.isFinite(usdPrice) || usdPrice <= 0) return null;
  return (Number(BigInt(raw)) / (10 ** decimals)) * usdPrice;
}

async function assetPriceUsd(asset: string): Promise<number | null> {
  const symbols: Record<string, string> = {
    BNB: "BNBUSDT",
    ETH: "ETHUSDT",
    SOL: "SOLUSDT",
    BTC: "BTCUSDT",
  };
  const symbol = symbols[asset];
  if (!symbol) return null;
  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=" + symbol,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) return null;
    const result = await response.json();
    const price = Number(result?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function valueNetworkFeeUsd(chain: string, confirmation: any, estimatedFeeUsd: number | null) {
  const feeNative = finiteNumber(confirmation?.fee_native);
  const feeAsset = String(confirmation?.fee_asset || (chain === "bnb" ? "BNB" : chain === "ethereum" ? "ETH" : chain === "solana" ? "SOL" : chain === "bitcoin" ? "BTC" : ""));
  if (feeNative !== null && feeAsset) {
    const price = await assetPriceUsd(feeAsset);
    if (price !== null) {
      return {
        network_fee_usd: feeNative * price,
        network_fee_valuation_source: "confirmed_native_fee_times_live_" + feeAsset + "_spot_price",
      };
    }
  }
  if (estimatedFeeUsd !== null) {
    return {
      network_fee_usd: estimatedFeeUsd,
      network_fee_valuation_source: feeNative === null
        ? "preflight_estimate_fallback_actual_fee_unavailable"
        : "preflight_estimate_fallback_spot_price_unavailable",
    };
  }
  return {
    network_fee_usd: null,
    network_fee_valuation_source: "unavailable_fee_or_price",
  };
}

async function flashSettlementUsd(chain: string, settlement: any) {
  if (!settlement?.asset || !/^\d+$/.test(settlement.premium_raw) || !/^\d+$/.test(settlement.profit_paid_raw)) {
    return null;
  }
  const asset = settlement.asset.toLowerCase();
  if (chain === "bnb" && asset === BSC_USDT) {
    return {
      flash_loan_fee_usd: rawTokenAmountUsd(settlement.premium_raw, 18, 1),
      gross_profit_usd: rawTokenAmountUsd(
        (BigInt(settlement.premium_raw) + BigInt(settlement.profit_paid_raw)).toString(), 18, 1,
      ),
      settlement_asset: "USDT",
      settlement_source: "confirmed_flash_loan_settled_event",
    };
  }
  if (chain === "ethereum" && asset === ETH_USDC) {
    return {
      flash_loan_fee_usd: rawTokenAmountUsd(settlement.premium_raw, 6, 1),
      gross_profit_usd: rawTokenAmountUsd(
        (BigInt(settlement.premium_raw) + BigInt(settlement.profit_paid_raw)).toString(), 6, 1,
      ),
      settlement_asset: "USDC",
      settlement_source: "confirmed_flash_loan_settled_event",
    };
  }
  if ((chain === "bnb" && asset === BSC_WBNB) || (chain === "ethereum" && asset === ETH_WETH)) {
    const native = chain === "bnb" ? "BNB" : "ETH";
    const price = await assetPriceUsd(native);
    if (price === null) return null;
    return {
      flash_loan_fee_usd: rawTokenAmountUsd(settlement.premium_raw, 18, price),
      gross_profit_usd: rawTokenAmountUsd(
        (BigInt(settlement.premium_raw) + BigInt(settlement.profit_paid_raw)).toString(), 18, price,
      ),
      settlement_asset: native,
      settlement_source: "confirmed_flash_loan_settled_event_and_live_spot_price",
    };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" || !(await authorized(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const attemptId = String(body.execution_attempt_id || "");
    const txHash = String(body.tx_hash || "");

    if (!attemptId || !txHash) {
      return Response.json({ error: "execution_attempt_id_and_tx_hash_required" }, { status: 400 });
    }

    const { data: attempt, error: attemptError } = await supabase
      .from("execution_attempts")
      .select("id,owner_id,adapter_id,strategy_bot_id,chain,tx_hash,status,wallet_id,gross_profit,net_profit,gas_fee,gas_asset,estimated_network_fee_usd,network_fee_usd,flash_loan_fee_usd,x402_resource_fee_usd,pnl_currency,fee_breakdown,execution_route_id,capital_used,created_at,broadcast_at")
      .eq("id", attemptId)
      .maybeSingle();

    if (attemptError) return Response.json({ error: attemptError.message }, { status: 500 });
    if (!attempt) return Response.json({ error: "execution_attempt_not_found" }, { status: 404 });
    if (attempt.tx_hash && attempt.tx_hash !== txHash) {
      return Response.json({ error: "tx_hash_mismatch" }, { status: 409 });
    }

    const confirmation: any = await checkConfirmation(attempt.chain, txHash);
    if (!confirmation.confirmed) {
      return Response.json({ ok: true, status: "pending", confirmation });
    }

    const now = new Date().toISOString();
    const estimatedNetworkFeeUsd = finiteNumber(attempt.estimated_network_fee_usd);
    const feeValue = await valueNetworkFeeUsd(attempt.chain, confirmation, estimatedNetworkFeeUsd);
    const networkFeeUsd = feeValue.network_fee_usd;
    const feeNative = confirmation.fee_native ?? attempt.gas_fee ?? null;
    const feeAsset = confirmation.fee_asset || attempt.gas_asset || null;
    const x402FeeUsd = finiteNumber(attempt.x402_resource_fee_usd) ?? 0;
    const oldBreakdown = attempt.fee_breakdown && typeof attempt.fee_breakdown === "object"
      ? attempt.fee_breakdown
      : {};

    if (confirmation.succeeded !== true) {
      const failureBreakdown = {
        ...oldBreakdown,
        pnl_currency: "USD",
        network_fee_usd: networkFeeUsd,
        network_fee_native: feeNative,
        network_fee_asset: feeAsset,
        network_fee_valuation_source: feeValue.network_fee_valuation_source,
        flash_loan_fee_usd: 0,
        x402_resource_fee_usd: x402FeeUsd,
        total_fee_usd: networkFeeUsd === null ? null : networkFeeUsd + x402FeeUsd,
        fee_accounting_status: networkFeeUsd === null ? "failed_tx_fee_usd_unavailable" : "failed_tx_network_cost_recorded",
      };
      const { error: failedUpdateError } = await supabase.from("execution_attempts").update({
        status: "failed",
        confirmed_at: now,
        updated_at: now,
        failure_reason: confirmation.failure_reason || "transaction_reverted",
        gas_fee: feeNative,
        gas_asset: feeAsset,
        network_fee_usd: networkFeeUsd,
        flash_loan_fee_usd: 0,
        x402_resource_fee_usd: x402FeeUsd,
        fee_breakdown: failureBreakdown,
        pnl_currency: "USD",
        gross_profit: null,
        net_profit: networkFeeUsd === null ? null : -(networkFeeUsd + x402FeeUsd),
      }).eq("id", attempt.id);
      if (failedUpdateError) return Response.json({ error: failedUpdateError.message }, { status: 500 });

      await supabase.from("signing_requests").update({
        status: "failed",
        confirmed_at: now,
        updated_at: now,
      }).eq("execution_attempt_id", attempt.id).eq("tx_hash", txHash);

      return Response.json({
        ok: true,
        status: "reverted",
        tx_hash: txHash,
        network_fee_native: feeNative,
        network_fee_asset: feeAsset,
        network_fee_usd: networkFeeUsd,
        confirmation,
      });
    }

    const { data: route } = await supabase
      .from("arbivault_strategy_routes")
      .select("strategy,pair,strategy_bot_id,route_type")
      .eq("id", attempt.execution_route_id)
      .maybeSingle();

    const settlementPnl = await flashSettlementUsd(attempt.chain, confirmation.flash_settlement);
    const preflightGross = finiteNumber(attempt.gross_profit);
    const gross = settlementPnl?.gross_profit_usd ?? preflightGross;
    const premiumUsd = settlementPnl?.flash_loan_fee_usd
      ?? finiteNumber(attempt.flash_loan_fee_usd)
      ?? (route?.route_type === "flash_liquidity" ? null : 0);
    const net = gross === null || networkFeeUsd === null || premiumUsd === null
      ? null
      : gross - premiumUsd - networkFeeUsd - x402FeeUsd;
    const totalFeesUsd = networkFeeUsd === null || premiumUsd === null
      ? null
      : networkFeeUsd + premiumUsd + x402FeeUsd;
    const strategy = route?.strategy || "on_chain_execution";
    const pair = route?.pair || null;

    const feeBreakdown = {
      ...oldBreakdown,
      pnl_currency: "USD",
      gross_profit_usd: gross,
      flash_loan_fee_usd: premiumUsd,
      network_fee_native: feeNative,
      network_fee_asset: feeAsset,
      network_fee_usd: networkFeeUsd,
      network_fee_valuation_source: feeValue.network_fee_valuation_source,
      estimated_network_fee_usd: estimatedNetworkFeeUsd,
      x402_resource_fee_usd: x402FeeUsd,
      x402_fee_source: x402FeeUsd > 0
        ? "explicitly_attributed_to_execution_attempt"
        : "no_paid_x402_resource_call_attributed_to_execution_attempt",
      total_fee_usd: totalFeesUsd,
      net_profit_usd: net,
      pnl_basis: settlementPnl
        ? settlementPnl.settlement_source
        : gross !== null
          ? "preflight_gross_profit_estimate_plus_confirmed_network_fee"
          : "profit_inputs_unavailable",
      realized_pnl_verified: false,
      fee_accounting_status: net === null
        ? "net_profit_unavailable_missing_fee_or_profit_inputs"
        : settlementPnl
          ? "settlement_event_and_confirmed_network_fee_accounted"
          : "preflight_pnl_and_confirmed_network_fee_accounted",
    };

    let skillId: string | null = null;
    const { data: skill } = await supabase
      .from("bot_skills")
      .select("id")
      .eq("strategy_bot_id", attempt.strategy_bot_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    skillId = skill?.id || null;

    let botConfigId: string | null = null;
    const { data: botConfig } = await supabase
      .from("bot_configs")
      .select("id")
      .eq("owner_id", attempt.owner_id)
      .eq("bot_role", "execution")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    botConfigId = botConfig?.id || null;

    const metadata = {
      confirmation_source: "arbivault-execution-confirm",
      ...feeBreakdown,
      confirmation,
      flash_settlement: confirmation.flash_settlement || null,
      execution_route_id: attempt.execution_route_id,
    };

    const { data: existing } = await supabase
      .from("trades")
      .select("id")
      .eq("owner_id", attempt.owner_id)
      .eq("tx_hash", txHash)
      .limit(1)
      .maybeSingle();

    let trade = null;
    if (existing?.id) {
      const { data, error } = await supabase
        .from("trades")
        .update({
          status: "executed",
          confirmed_at: now,
          fees_paid: totalFeesUsd,
          network_fee_usd: networkFeeUsd,
          estimated_network_fee_usd: estimatedNetworkFeeUsd,
          flash_loan_fee_usd: premiumUsd,
          x402_resource_fee_usd: x402FeeUsd,
          pnl_currency: "USD",
          fee_breakdown: feeBreakdown,
          net_profit: net,
          gross_profit: gross,
          execution_attempt_id: attempt.id,
          wallet_id: attempt.wallet_id,
          metadata,
          updated_at: now,
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      trade = data;
    } else {
      const { data, error } = await supabase
        .from("trades")
        .insert({
          owner_id: attempt.owner_id,
          bot_config_id: botConfigId,
          bot_skill_id: skillId,
          chain: attempt.chain,
          strategy,
          pair,
          borrowed_amount: null,
          notional_amount: attempt.capital_used || null,
          gross_profit: gross,
          fees_paid: totalFeesUsd,
          network_fee_usd: networkFeeUsd,
          estimated_network_fee_usd: estimatedNetworkFeeUsd,
          flash_loan_fee_usd: premiumUsd,
          x402_resource_fee_usd: x402FeeUsd,
          pnl_currency: "USD",
          fee_breakdown: feeBreakdown,
          net_profit: net,
          execution_time_ms: attempt.broadcast_at && attempt.created_at
            ? Math.max(0, Date.parse(now) - Date.parse(attempt.created_at))
            : null,
          status: "executed",
          execution_mode: "on_chain",
          tx_hash: txHash,
          explorer_url: attempt.chain === "bnb"
            ? "https://bscscan.com/tx/" + txHash
            : attempt.chain === "ethereum"
              ? "https://etherscan.io/tx/" + txHash
              : attempt.chain === "solana"
                ? "https://solscan.io/tx/" + txHash
                : attempt.chain === "bitcoin"
                  ? "https://mempool.space/tx/" + txHash
                  : null,
          metadata,
          confirmed_at: now,
          wallet_id: attempt.wallet_id,
          execution_attempt_id: attempt.id,
        })
        .select()
        .single();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      trade = data;
    }

    const { error: attemptUpdateError } = await supabase.from("execution_attempts").update({
      status: "confirmed",
      confirmed_at: now,
      updated_at: now,
      gas_fee: feeNative,
      gas_asset: feeAsset,
      network_fee_usd: networkFeeUsd,
      flash_loan_fee_usd: premiumUsd,
      x402_resource_fee_usd: x402FeeUsd,
      estimated_network_fee_usd: estimatedNetworkFeeUsd,
      pnl_currency: "USD",
      fee_breakdown: feeBreakdown,
      gross_profit: gross,
      net_profit: net,
      failure_reason: null,
    }).eq("id", attempt.id);
    if (attemptUpdateError) return Response.json({ error: attemptUpdateError.message }, { status: 500 });

    await supabase.from("signing_requests").update({
      status: "confirmed",
      confirmed_at: now,
      updated_at: now,
    }).eq("execution_attempt_id", attempt.id).eq("tx_hash", txHash);

    return Response.json({
      ok: true,
      status: "confirmed",
      tx_hash: txHash,
      trade_id: trade?.id || null,
      gross_profit: gross,
      flash_loan_fee_usd: premiumUsd,
      network_fee_native: feeNative,
      network_fee_asset: feeAsset,
      network_fee_usd: networkFeeUsd,
      x402_resource_fee_usd: x402FeeUsd,
      fees_paid: totalFeesUsd,
      net_profit: net,
      pnl_currency: "USD",
      realized_pnl_verified: false,
      confirmation,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
});
