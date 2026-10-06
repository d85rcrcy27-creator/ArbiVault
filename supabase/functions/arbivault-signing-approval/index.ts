import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, serviceKey);

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type",
    },
  });

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function userFromRequest(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const client = createClient(url, serviceKey, {
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await userFromRequest(req);
  if (!user) return json({ error: "authentication_required" }, 401);

  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "create") {
      const sourceWalletId = String(body.source_wallet_id || "");
      const chain = String(body.chain || "").toLowerCase();
      const payloadHash = String(body.payload_hash || "");
      const destinationAddress = body.destination_address ? String(body.destination_address) : null;
      const executionAttemptId = body.execution_attempt_id ? String(body.execution_attempt_id) : null;

      if (!sourceWalletId || !payloadHash || !["bitcoin", "bnb", "ethereum", "solana"].includes(chain)) {
        return json({ error: "invalid_request" }, 400);
      }

      const { data: wallet, error: walletError } = await admin
        .from("wallets")
        .select("id,owner_id,chain,address,status,is_hot,wallet_role")
        .eq("id", sourceWalletId)
        .eq("owner_id", user.id)
        .maybeSingle();

      if (walletError) return json({ error: "wallet_lookup_failed" }, 500);
      if (!wallet || wallet.status !== "active" || wallet.chain !== chain) {
        return json({ error: "wallet_not_authorized" }, 403);
      }

      const rawToken = randomToken();
      const challengeHash = await hash(rawToken);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { data: requestRow, error } = await admin
        .from("signing_requests")
        .insert({
          owner_id: user.id,
          execution_attempt_id: executionAttemptId,
          signer_type: "hot_wallet_signer",
          chain,
          source_wallet_id: sourceWalletId,
          destination_address: destinationAddress,
          payload_hash: payloadHash,
          status: "pending",
          biometric_required: true,
          biometric_verified: false,
          approval_challenge_hash: challengeHash,
          approval_expires_at: expiresAt,
          expires_at: expiresAt,
          approval_method: "passkey_qr",
        })
        .select("id,chain,source_wallet_id,destination_address,payload_hash,status,approval_expires_at")
        .single();

      if (error) return json({ error: "signing_request_create_failed" }, 500);

      return json({
        ok: true,
        signing_request: requestRow,
        qr_payload: `arbivault://approve/${requestRow.id}?token=${rawToken}`,
        expires_at: expiresAt,
      });
    }

    if (action === "get") {
      const requestId = String(body.signing_request_id || "");
      const token = String(body.token || "");
      if (!requestId || !token) return json({ error: "invalid_request" }, 400);

      const challengeHash = await hash(token);
      const { data: row, error } = await admin
        .from("signing_requests")
        .select("id,owner_id,chain,source_wallet_id,destination_address,payload_hash,status,biometric_required,biometric_verified,approval_expires_at,created_at")
        .eq("id", requestId)
        .eq("approval_challenge_hash", challengeHash)
        .maybeSingle();

      if (error) return json({ error: "lookup_failed" }, 500);
      if (!row) return json({ error: "invalid_or_expired_challenge" }, 404);
      if (row.owner_id !== user.id) return json({ error: "authorization_owner_mismatch" }, 403);
      if (!row.approval_expires_at || new Date(row.approval_expires_at) <= new Date()) {
        return json({ error: "challenge_expired" }, 410);
      }

      return json({ ok: true, signing_request: row });
    }

    if (action === "approve" || action === "reject") {
      const requestId = String(body.signing_request_id || "");
      const token = String(body.token || "");
      if (!requestId || !token) return json({ error: "invalid_request" }, 400);

      const challengeHash = await hash(token);
      const { data: row, error: lookupError } = await admin
        .from("signing_requests")
        .select("id,owner_id,status,approval_expires_at,approval_challenge_hash")
        .eq("id", requestId)
        .eq("approval_challenge_hash", challengeHash)
        .maybeSingle();

      if (lookupError) return json({ error: "lookup_failed" }, 500);
      if (!row) return json({ error: "invalid_or_expired_challenge" }, 404);
      if (row.owner_id !== user.id) return json({ error: "authorization_owner_mismatch" }, 403);
      if (row.status !== "pending") return json({ error: "request_not_pending" }, 409);
      if (!row.approval_expires_at || new Date(row.approval_expires_at) <= new Date()) {
        return json({ error: "challenge_expired" }, 410);
      }

      const now = new Date().toISOString();
      const update = action === "approve"
        ? {
            status: "authorized",
            biometric_verified: true,
            authorization_credential_id: "supabase-passkey",
            approved_at: now,
            approval_method: "passkey_qr",
          }
        : {
            status: "rejected",
            rejected_at: now,
            expires_at: now,
          };

      const { data: updated, error: updateError } = await admin
        .from("signing_requests")
        .update(update)
        .eq("id", requestId)
        .eq("status", "pending")
        .select("id,status,approved_at,rejected_at,biometric_verified")
        .single();

      if (updateError) return json({ error: "authorization_update_failed" }, 500);

      return json({ ok: true, signing_request: updated });
    }

    return json({ error: "unknown_action" }, 400);
  } catch {
    return json({ error: "signing_approval_gateway_error" }, 500);
  }
});
