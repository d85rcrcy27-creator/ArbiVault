import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2.39.0/accounts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(url, serviceKey);
const cors = {
  "Access-Control-Allow-Origin": "https://arbivault.vercel.app",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

async function userFromRequest(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await client.auth.getUser();
  return error || !data.user ? null : data.user;
}


async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type VaultBindingStatus =
  | "verified"
  | "missing_binding"
  | "secret_missing"
  | "commitment_mismatch"
  | "address_binding_mismatch"
  | "wallet_mismatch";

// Verification is performed inside Postgres/Vault. The decrypted secret is never
// returned to this Edge Function during activation or recipient verification.
async function verifySupabaseVaultWallet(
  ownerId: string,
  walletId: string,
  chain: string,
  expectedAddress: string,
): Promise<VaultBindingStatus> {
  const { data, error } = await admin.rpc("verify_profit_recipient_vault_binding", {
    p_wallet_id: walletId,
    p_owner_id: ownerId,
    p_chain: chain,
    p_expected_address: expectedAddress,
  });
  if (error) return "wallet_mismatch";
  const allowed: VaultBindingStatus[] = [
    "verified", "missing_binding", "secret_missing",
    "commitment_mismatch", "address_binding_mismatch", "wallet_mismatch",
  ];
  return allowed.includes(data as VaultBindingStatus) ? data as VaultBindingStatus : "wallet_mismatch";
}

const assets: Record<string, string[]> = {
  // ALL designates one chain-specific payout address usable for the executor's supported profit assets.
  ethereum: ["ALL", "ETH", "WETH", "USDC"],
  bnb: ["ALL", "BNB", "WBNB", "USDT"],
};

async function recordEvent(ownerId: string, recipientId: string | null, eventType: string, chain: string | null, asset: string | null, details: Record<string, unknown> = {}) {
  const { error } = await admin.from("profit_recipient_audit_events").insert({
    owner_id: ownerId, recipient_id: recipientId, event_type: eventType,
    chain, asset, details,
  });
  if (error) throw new Error("profit_recipient_audit_write_failed");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const user = await userFromRequest(req);
  if (!user) return json({ error: "authentication_required" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "list") {
      const { data: profiles, error } = await admin
        .from("profit_recipient_profiles")
        .select("id,owner_id,wallet_id,chain,asset,status,activation_at,verified_at,verification_source,created_at,updated_at")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: false });
      if (error) return json({ error: "profit_recipient_list_failed" }, 500);

      const walletIds = (profiles || []).map((p: any) => p.wallet_id);
      const { data: wallets, error: walletError } = walletIds.length
        ? await admin.from("wallets").select("id,chain,address,label,status,last_balance,balance_usd,last_balance_at,last_verified_at").eq("owner_id", user.id).in("id", walletIds)
        : { data: [], error: null };
      if (walletError) return json({ error: "profit_recipient_wallet_lookup_failed" }, 500);
      const walletMap = new Map((wallets || []).map((w: any) => [w.id, w]));
      const recipients = (profiles || []).map((p: any) => ({
        ...p,
        wallet: walletMap.get(p.wallet_id) || null,
      }));
      const { data: events, error: eventError } = await admin
        .from("profit_recipient_audit_events")
        .select("id,recipient_id,event_type,chain,asset,amount,destination_address,tx_hash,details,created_at")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (eventError) return json({ error: "profit_recipient_events_lookup_failed" }, 500);
      return json({ ok: true, recipients, events: events || [] });
    }

    if (action === "create") {
      // Fail closed: do not generate an internal Supabase-Vault key as a payout
      // destination. The requested policy requires a verified Turnkey-managed wallet.
      return json({
        error: "turnkey_profit_destination_integration_required",
        message: "No payout destination was created. Configure and verify a Turnkey-managed wallet for this chain first.",
        live_transfer_enabled: false,
      }, 409);
    }

    if (action === "activate") {
      // Do not activate legacy server-vault recipients. Turnkey address/account
      // lookup and signer-control verification must exist before activation.
      return json({
        error: "turnkey_profit_destination_verification_required",
        message: "Activation is blocked until Turnkey wallet identity and signing control are verified.",
        live_transfer_enabled: false,
      }, 409);
    }

    if (action === "revoke") {
      const recipientId = String(body.recipient_id || "");
      if (!recipientId) return json({ error: "recipient_id_required" }, 400);
      const { data: recipient, error: lookupError } = await admin.from("profit_recipient_profiles")
        .select("id,owner_id,wallet_id,chain,asset,status")
        .eq("id", recipientId).eq("owner_id", user.id).maybeSingle();
      if (lookupError) return json({ error: "profit_recipient_lookup_failed" }, 500);
      if (!recipient) return json({ error: "profit_recipient_not_found" }, 404);
      if (recipient.status === "revoked") return json({ ok: true, already_revoked: true });
      const { error: updateError } = await admin.from("profit_recipient_profiles")
        .update({ status: "revoked", updated_at: new Date().toISOString() })
        .eq("id", recipient.id).eq("owner_id", user.id);
      if (updateError) return json({ error: "profit_recipient_revoke_failed" }, 500);
      await recordEvent(user.id, recipient.id, "revoked", recipient.chain, recipient.asset, {
        note: "Recipient disabled for future routing; existing funds remain on-chain.",
      });
      return json({ ok: true, recipient_id: recipient.id, status: "revoked", funds_moved: false });
    }

    return json({ error: "unknown_action" }, 400);
  } catch {
    return json({ error: "profit_recipient_request_failed" }, 500);
  }
});