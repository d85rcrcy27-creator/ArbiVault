import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { Turnkey } from "npm:@turnkey/sdk-server@5.0.0";
import { parseTransaction } from "npm:viem@2.39.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

function sha256Hex(value: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((buf) =>
    Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

function requireConfig() {
  const required = [
    "TURNKEY_API_PUBLIC_KEY",
    "TURNKEY_API_PRIVATE_KEY",
    "TURNKEY_ORGANIZATION_ID",
    "ARBIVAULT_SIGNER_TOKEN",
  ];
  if (required.some((k) => !Deno.env.get(k))) throw new Error("signer_not_configured");
}

async function authorized(req: Request) {
  const expected = Deno.env.get("ARBIVAULT_SIGNER_TOKEN");
  const supplied = req.headers.get("x-arbivault-signer-token");
  return !!expected && !!supplied && supplied === expected;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    requireConfig();

    const body = await req.json();
    const mode = body.mode === "transfer" ? "transfer" : body.mode === "trade" ? "trade" : null;
    const adapterId = String(body.adapter_id || "");
    const sourceWalletId = String(body.source_wallet_id || "");
    const unsignedTransaction = String(body.unsigned_transaction || "");
    const chain = String(body.chain || "").toLowerCase();
    const amount = body.amount == null ? null : Number(body.amount);
    const destinationAddress = body.destination_address ? String(body.destination_address) : null;
    const transferAuthorizationId = body.transfer_authorization_id
      ? String(body.transfer_authorization_id)
      : null;

    if (!mode || !adapterId || !sourceWalletId || !unsignedTransaction) {
      return json({ error: "invalid_request" }, 400);
    }
    if (!["bnb", "ethereum", "solana", "bitcoin"].includes(chain)) {
      return json({ error: "unsupported_chain" }, 400);
    }
    if (unsignedTransaction.length > 200000) {
      return json({ error: "transaction_too_large" }, 413);
    }
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      return json({ error: "invalid_amount" }, 400);
    }

    const { data: adapter, error: adapterError } = await supabase
      .from("execution_adapters")
      .select("*")
      .eq("id", adapterId)
      .maybeSingle();

    if (adapterError) return json({ error: adapterError.message }, 500);
    if (!adapter || adapter.configured !== true || adapter.automatic_signing !== true ||
        adapter.can_broadcast !== true || adapter.signer_provider !== "turnkey") {
      return json({ error: "adapter_not_authorized" }, 403);
    }

    if (adapter.allowed_wallet_id !== sourceWalletId) {
      return json({ error: "wallet_not_bound_to_signer" }, 403);
    }

    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("id,owner_id,chain,address,status,is_hot,wallet_role")
      .eq("id", sourceWalletId)
      .maybeSingle();

    if (walletError) return json({ error: walletError.message }, 500);
    if (!wallet || wallet.status !== "active" || wallet.is_hot !== true) {
      return json({ error: "source_wallet_not_active_hot_wallet" }, 403);
    }
    if (wallet.chain !== chain) return json({ error: "chain_wallet_mismatch" }, 403);

    const signerAddress = String(adapter.signer_key_ref || "");
    if (!signerAddress || signerAddress.toLowerCase() !== String(wallet.address).toLowerCase()) {
      return json({ error: "signer_wallet_mismatch" }, 403);
    }

    if (amount != null && adapter.max_transaction_value != null &&
        amount > Number(adapter.max_transaction_value)) {
      return json({ error: "transaction_value_exceeds_adapter_limit" }, 403);
    }

    if (mode === "trade") {
      if (wallet.wallet_role !== "trading_hot" || adapter.signing_boundary === "withdrawal_signer") {
        return json({ error: "trade_requires_trading_hot_signer" }, 403);
      }
    }

    if (mode === "transfer") {
      if (adapter.signing_boundary !== "withdrawal_signer" || adapter.can_withdraw !== true) {
        return json({ error: "withdrawal_signer_required" }, 403);
      }
      if (!transferAuthorizationId || !destinationAddress) {
        return json({ error: "transfer_authorization_required" }, 400);
      }

      const { data: auth, error: authError } = await supabase
        .from("transfer_authorizations")
        .select("id,source_wallet_id,approved_wallet_id,destination_address,chain,biometric_required,biometric_verified,authorization_status,expires_at")
        .eq("id", transferAuthorizationId)
        .maybeSingle();

      if (authError) return json({ error: authError.message }, 500);
      if (!auth || auth.source_wallet_id !== sourceWalletId ||
          auth.authorization_status !== "authorized" ||
          auth.chain !== chain ||
          String(auth.destination_address).toLowerCase() !== destinationAddress.toLowerCase()) {
        return json({ error: "transfer_not_authorized" }, 403);
      }
      if (auth.expires_at && new Date(auth.expires_at) <= new Date()) {
        return json({ error: "transfer_authorization_expired" }, 403);
      }
      if (auth.biometric_required && !auth.biometric_verified) {
        return json({ error: "biometric_authorization_required" }, 403);
      }

      const { data: approved, error: approvedError } = await supabase
        .from("approved_wallets")
        .select("id,address,status,chain")
        .eq("id", auth.approved_wallet_id)
        .maybeSingle();

      if (approvedError) return json({ error: approvedError.message }, 500);
      if (!approved || approved.status !== "approved" || approved.chain !== chain ||
          String(approved.address).toLowerCase() !== destinationAddress.toLowerCase()) {
        return json({ error: "destination_not_approved" }, 403);
      }
    }

    if (chain === "bnb" || chain === "ethereum") {
      let parsed;
      try {
        parsed = parseTransaction(unsignedTransaction as `0x${string}`);
      } catch {
        return json({ error: "invalid_unsigned_evm_transaction" }, 400);
      }

      if (!parsed.to) return json({ error: "contract_creation_not_allowed" }, 403);
      if (parsed.from && parsed.from.toLowerCase() !== wallet.address.toLowerCase()) {
        return json({ error: "transaction_sender_mismatch" }, 403);
      }

      const allowedContracts = Array.isArray(adapter.allowed_contracts) ? adapter.allowed_contracts : [];
      const contractAllowed = allowedContracts.length === 0 ||
        allowedContracts.some((x: unknown) => String(x).toLowerCase() === parsed.to!.toLowerCase());

      if (mode === "trade" && !contractAllowed) {
        return json({ error: "destination_contract_not_allowlisted" }, 403);
      }
      if (mode === "transfer" && parsed.to!.toLowerCase() !== destinationAddress!.toLowerCase()) {
        return json({ error: "transfer_destination_mismatch" }, 403);
      }
    } else {
      return json({ error: "chain_parser_not_enabled", chain }, 503);
    }

    const payloadHash = await sha256Hex(unsignedTransaction);
    const { data: requestRow, error: requestError } = await supabase
      .from("signing_requests")
      .insert({
        owner_id: wallet.owner_id,
        signer_type: mode === "transfer" ? "withdrawal_signer" : "hot_wallet_signer",
        chain,
        source_wallet_id: sourceWalletId,
        destination_address: destinationAddress,
        payload_hash: payloadHash,
        status: "authorized",
        biometric_required: mode === "transfer",
        biometric_verified: mode === "transfer",
      })
      .select("id")
      .single();

    if (requestError) return json({ error: requestError.message }, 500);

    try {
      const turnkey = new Turnkey({
        apiBaseUrl: Deno.env.get("TURNKEY_BASE_URL") || "https://api.turnkey.com",
        apiPublicKey: Deno.env.get("TURNKEY_API_PUBLIC_KEY")!,
        apiPrivateKey: Deno.env.get("TURNKEY_API_PRIVATE_KEY")!,
        defaultOrganizationId: Deno.env.get("TURNKEY_ORGANIZATION_ID")!,
      });

      const result = await turnkey.apiClient().signTransaction({
        signWith: signerAddress,
        unsignedTransaction,
        type: "TRANSACTION_TYPE_ETHEREUM",
      });

      const signedTransaction = result.activity?.result?.signTransactionResult?.signedTransaction;
      if (!signedTransaction) throw new Error("turnkey_missing_signed_transaction");

      await supabase.from("signing_requests").update({
        status: "signed",
        signed_at: new Date().toISOString(),
      }).eq("id", requestRow.id);

      await supabase.from("execution_adapters").update({
        last_signed_at: new Date().toISOString(),
        health_status: "healthy",
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", adapter.id);

      return json({
        ok: true,
        signing_request_id: requestRow.id,
        provider: "turnkey",
        chain,
        mode,
        signed_transaction: signedTransaction,
        broadcast: "caller_must_broadcast_after_local_validation",
      });
    } catch (error) {
      await supabase.from("signing_requests").update({
        status: "rejected",
        expires_at: new Date().toISOString(),
      }).eq("id", requestRow.id);

      await supabase.from("execution_adapters").update({
        health_status: "degraded",
        last_error: "signing_provider_error",
        updated_at: new Date().toISOString(),
      }).eq("id", adapter.id);

      return json({ error: "signing_provider_error" }, 502);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "signer_not_configured") {
      return json({ error: "signer_not_configured" }, 503);
    }
    return json({ error: "signer_gateway_error" }, 500);
  }
});
