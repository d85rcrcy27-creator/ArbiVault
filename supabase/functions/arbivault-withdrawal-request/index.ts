import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, serviceKey);

const cors = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "https://arbivault.vercel.app",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: cors });

async function userFromRequest(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const client = createClient(url, serviceKey, { global: { headers: { Authorization: auth } } });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validAddress(chain: string, address: string) {
  if (chain === "bnb") return /^0x[a-fA-F0-9]{40}$/.test(address);
  if (chain === "bitcoin") return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,90}$/.test(address);
  if (chain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await userFromRequest(req);
  if (!user) return json({ error: "authentication_required" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "add_destination") {
      const chain = String(body.chain || "").toLowerCase();
      const address = String(body.address || "").trim();
      const label = String(body.label || "").trim() || null;
      const makePrimary = body.make_primary === true;

      if (!["bitcoin", "bnb", "solana"].includes(chain) || !validAddress(chain, address)) {
        return json({ error: "invalid_destination" }, 400);
      }

      const { data: existing, error: lookupError } = await admin
        .from("approved_wallets")
        .select("*")
        .eq("owner_id", user.id)
        .eq("chain", chain)
        .eq("address", address)
        .maybeSingle();

      if (lookupError) return json({ error: "destination_lookup_failed" }, 500);
      if (existing) return json({ ok: true, destination: existing, existing: true });

      const activationAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await admin
        .from("approved_wallets")
        .insert({
          owner_id: user.id,
          chain,
          address,
          label,
          status: "pending",
          activation_at: activationAt,
          is_primary: false,
          approval_note: makePrimary ? "Primary requested after activation" : "Added from Wallets page",
        })
        .select("*")
        .single();

      if (error) return json({ error: "destination_create_failed", detail: error.message }, 500);
      return json({ ok: true, destination: data, activation_at: activationAt });
    }

    if (action === "activate_destination") {
      const destinationId = String(body.destination_id || "");
      if (!destinationId) return json({ error: "invalid_request" }, 400);

      const { data: destination, error: lookupError } = await admin
        .from("approved_wallets")
        .select("*")
        .eq("id", destinationId)
        .eq("owner_id", user.id)
        .maybeSingle();

      if (lookupError) return json({ error: "destination_lookup_failed" }, 500);
      if (!destination) return json({ error: "destination_not_found" }, 404);
      if (destination.status === "revoked") return json({ error: "destination_revoked" }, 409);
      if (!destination.activation_at || new Date(destination.activation_at) > new Date()) {
        return json({ error: "destination_activation_pending", activation_at: destination.activation_at }, 409);
      }

      const makePrimary = body.make_primary === true;
      if (makePrimary) {
        await admin.from("approved_wallets").update({ is_primary: false }).eq("owner_id", user.id).eq("chain", destination.chain);
      }

      const { data, error } = await admin
        .from("approved_wallets")
        .update({
          status: "approved",
          approved_at: new Date().toISOString(),
          is_primary: makePrimary,
          approval_note: "Activated after required delay",
        })
        .eq("id", destinationId)
        .eq("owner_id", user.id)
        .select("*")
        .single();

      if (error) return json({ error: "destination_activation_failed", detail: error.message }, 500);
      return json({ ok: true, destination: data });
    }

    if (action === "create_withdrawal") {
      const sourceWalletId = String(body.source_wallet_id || "");
      const destinationId = String(body.destination_id || "");
      const amount = Number(body.amount);
      const asset = String(body.asset || "").toUpperCase();

      if (!sourceWalletId || !destinationId || !Number.isFinite(amount) || amount <= 0) {
        return json({ error: "invalid_withdrawal_request" }, 400);
      }

      const { data: wallet, error: walletError } = await admin
        .from("wallets")
        .select("id,owner_id,chain,address,status,is_hot,wallet_role")
        .eq("id", sourceWalletId)
        .eq("owner_id", user.id)
        .maybeSingle();

      if (walletError) return json({ error: "wallet_lookup_failed" }, 500);
      if (!wallet || wallet.status !== "active" || wallet.wallet_role !== "trading_hot" || wallet.is_hot !== true) {
        return json({ error: "source_wallet_not_authorized" }, 403);
      }

      const { data: destination, error: destinationError } = await admin
        .from("approved_wallets")
        .select("id,owner_id,chain,address,status,activation_at")
        .eq("id", destinationId)
        .eq("owner_id", user.id)
        .maybeSingle();

      if (destinationError) return json({ error: "destination_lookup_failed" }, 500);
      if (!destination || destination.status !== "approved") {
        return json({ error: "destination_not_active" }, 403);
      }
      if (destination.chain !== wallet.chain) {
        return json({ error: "chain_mismatch" }, 400);
      }
      if (!destination.activation_at || new Date(destination.activation_at) > new Date()) {
        return json({ error: "destination_activation_pending", activation_at: destination.activation_at }, 409);
      }

      const normalizedAsset = asset || (wallet.chain === "bitcoin" ? "BTC" : wallet.chain === "solana" ? "SOL" : "BNB");
      const snapshot = {
        source_wallet_id: wallet.id,
        source_address: wallet.address,
        destination_id: destination.id,
        destination_address: destination.address,
        chain: wallet.chain,
        asset: normalizedAsset,
        amount,
      };
      const payloadHash = await hash(JSON.stringify(snapshot));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data: tx, error: txError } = await admin
        .from("wallet_transactions")
        .insert({
          owner_id: user.id,
          source_wallet_id: wallet.id,
          approved_wallet_id: destination.id,
          destination_address: destination.address,
          chain: wallet.chain,
          asset: normalizedAsset,
          amount,
          status: "requested",
          requested_at: new Date().toISOString(),
          transaction_class: "withdrawal",
          transaction_payload: snapshot,
        })
        .select("id,chain,asset,amount,status,destination_address,requested_at")
        .single();

      if (txError) return json({ error: "withdrawal_record_failed", detail: txError.message }, 500);

      const { data: authorization, error: authError } = await admin
        .from("transfer_authorizations")
        .insert({
          owner_id: user.id,
          wallet_transaction_id: tx.id,
          source_wallet_id: wallet.id,
          approved_wallet_id: destination.id,
          destination_address: destination.address,
          chain: wallet.chain,
          asset: normalizedAsset,
          amount,
          payload_hash: payloadHash,
          biometric_required: true,
          biometric_verified: false,
          authorization_status: "pending",
          immutable_snapshot: true,
          expires_at: expiresAt,
        })
        .select("id,authorization_status,expires_at")
        .single();

      if (authError) return json({ error: "transfer_authorization_failed", detail: authError.message }, 500);

      const rawToken = randomToken();
      const challengeHash = await hash(rawToken);
      const { data: signingRequest, error: signingError } = await admin
        .from("signing_requests")
        .insert({
          owner_id: user.id,
          wallet_transaction_id: tx.id,
          signer_type: "withdrawal_signer",
          chain: wallet.chain,
          source_wallet_id: wallet.id,
          destination_address: destination.address,
          payload_hash: payloadHash,
          status: "pending",
          biometric_required: true,
          biometric_verified: false,
          approval_challenge_hash: challengeHash,
          approval_expires_at: expiresAt,
          expires_at: expiresAt,
          approval_method: "passkey_qr",
        })
        .select("id,status,chain,destination_address,approval_expires_at")
        .single();

      if (signingError) return json({ error: "signing_request_failed", detail: signingError.message }, 500);

      return json({
        ok: true,
        transaction: tx,
        authorization,
        signing_request: signingRequest,
        approval_uri: `arbivault://approve/${signingRequest.id}?token=${rawToken}`,
        message: "Withdrawal created. Human approval is required before signing or broadcast.",
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "withdrawal_request_failed" }, 500);
  }
});
