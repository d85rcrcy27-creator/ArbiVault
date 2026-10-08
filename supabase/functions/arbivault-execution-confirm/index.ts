import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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
  });
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`rpc_${body.error.code || "error"}`);
  return body.result;
}

async function checkConfirmation(chain: string, txHash: string) {
  if (chain === "bnb") {
    const receipt = await rpc(
      Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org",
      "eth_getTransactionReceipt",
      [txHash],
    );
    if (!receipt) return { confirmed: false, pending: true };
    const success = receipt.status === "0x1";
    if (!success) return { confirmed: true, succeeded: false, failure_reason: "transaction_reverted" };
    const gasUsed = BigInt(receipt.gasUsed || "0x0");
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice || "0x0");
    return {
      confirmed: true,
      succeeded: true,
      fee_native: Number(gasUsed * effectiveGasPrice) / 1e18,
      block_number: receipt.blockNumber || null,
    };
  }

  if (chain === "solana") {
    const statuses = await rpc(
      Deno.env.get("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com",
      "getSignatureStatuses",
      [[txHash], { searchTransactionHistory: true }],
    );
    const status = statuses?.value?.[0];
    if (!status) return { confirmed: false, pending: true };
    if (status.err) return { confirmed: true, succeeded: false, failure_reason: "transaction_reverted", error: status.err };
    return {
      confirmed: status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized",
      succeeded: status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized",
      slot: status.slot || null,
    };
  }

  if (chain === "bitcoin") {
    const response = await fetch(
      `https://mempool.space/api/tx/${encodeURIComponent(txHash)}`,
      { headers: { accept: "application/json" } },
    );
    if (response.status === 404) return { confirmed: false, pending: true };
    if (!response.ok) throw new Error(`bitcoin_tx_http_${response.status}`);
    const tx = await response.json();
    const confirmed = !!tx?.status?.confirmed;
    return { confirmed, pending: !confirmed, succeeded: confirmed, block_height: tx?.status?.block_height ?? null };
  }

  throw new Error("confirmation_chain_not_supported");
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
      .select("id,owner_id,adapter_id,strategy_bot_id,chain,tx_hash,status,wallet_id,gross_profit,net_profit,gas_fee,execution_route_id,capital_used,created_at,broadcast_at")
      .eq("id", attemptId)
      .maybeSingle();

    if (attemptError) return Response.json({ error: attemptError.message }, { status: 500 });
    if (!attempt) return Response.json({ error: "execution_attempt_not_found" }, { status: 404 });
    if (attempt.tx_hash && attempt.tx_hash !== txHash) {
      return Response.json({ error: "tx_hash_mismatch" }, { status: 409 });
    }

    const confirmation = await checkConfirmation(attempt.chain, txHash);
    if (!confirmation.confirmed) {
      return Response.json({ ok: true, status: "pending", confirmation });
    }

    const now = new Date().toISOString();

    if (confirmation.succeeded !== true) {
      await supabase.from("execution_attempts").update({
        status: "failed",
        confirmed_at: now,
        updated_at: now,
        failure_reason: confirmation.failure_reason || "transaction_reverted",
      }).eq("id", attempt.id);

      await supabase.from("signing_requests").update({
        status: "failed",
        confirmed_at: now,
        updated_at: now,
      }).eq("execution_attempt_id", attempt.id).eq("tx_hash", txHash);

      return Response.json({ ok: true, status: "reverted", tx_hash: txHash, confirmation });
    }

    const { data: route } = await supabase
      .from("arbivault_strategy_routes")
      .select("strategy,pair,strategy_bot_id")
      .eq("id", attempt.execution_route_id)
      .maybeSingle();

    const fee = confirmation.fee_native ?? attempt.gas_fee ?? 0;
    const gross = Number(attempt.gross_profit ?? 0);
    const net = Number(attempt.net_profit ?? (gross - fee));
    const strategy = route?.strategy || "on_chain_execution";
    const pair = route?.pair || null;

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
      pnl_basis: gross !== 0 || attempt.net_profit != null ? "execution_attempt_realized_values" : "realized_only",
      confirmation,
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
      const { data } = await supabase
        .from("trades")
        .update({
          status: "executed",
          confirmed_at: now,
          fees_paid: fee,
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
          fees_paid: fee,
          net_profit: net,
          execution_time_ms: attempt.broadcast_at && attempt.created_at
            ? Math.max(0, Date.parse(now) - Date.parse(attempt.created_at))
            : null,
          status: "executed",
          execution_mode: "on_chain",
          tx_hash: txHash,
          explorer_url: attempt.chain === "bnb"
            ? `https://bscscan.com/tx/${txHash}`
            : attempt.chain === "solana"
              ? `https://solscan.io/tx/${txHash}`
              : attempt.chain === "bitcoin"
                ? `https://mempool.space/tx/${txHash}`
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

    await supabase.from("execution_attempts").update({
      status: "confirmed",
      confirmed_at: now,
      updated_at: now,
      gas_fee: fee,
      gross_profit: gross,
      net_profit: net,
      failure_reason: null,
    }).eq("id", attempt.id);

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
      fees_paid: fee,
      net_profit: net,
      confirmation,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
});
