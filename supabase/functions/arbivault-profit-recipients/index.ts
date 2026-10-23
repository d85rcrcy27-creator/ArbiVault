import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2.39.0/accounts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(url, serviceKey);
const ALLOWED_ORIGINS = new Set([
  "https://arbivault-kh6lktmz-kingalpha.vercel.app",
  "https://arbivault.vercel.app",
]);
function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://arbivault-kh6lktmz-kingalpha.vercel.app",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  Response.json(body, { status, headers: corsHeaders(req) });

async function userFromRequest(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await client.auth.getUser();
  return error || !data.user ? null : data.user;
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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const user = await userFromRequest(req);
  if (!user) return json(req, { error: "authentication_required" }, 401);

  try {
    const body = await req.json(req, ).catch(() => ({}));
    const action = String(body.action || "");

    if (action === "list") {
      const { data: profiles, error } = await admin
        .from("profit_recipient_profiles")
        .select("id,owner_id,wallet_id,chain,asset,status,activation_at,verified_at,verification_source,created_at,updated_at")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: false });
      if (error) return json(req, { error: "profit_recipient_list_failed" }, 500);

      const walletIds = (profiles || []).map((p: any) => p.wallet_id);
      const { data: wallets, error: walletError } = walletIds.length
        ? await admin.from("wallets").select("id,chain,address,label,status,last_balance,balance_usd,last_balance_at,last_verified_at").eq("owner_id", user.id).in("id", walletIds)
        : { data: [], error: null };
      if (walletError) return json(req, { error: "profit_recipient_wallet_lookup_failed" }, 500);
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
      if (eventError) return json(req, { error: "profit_recipient_events_lookup_failed" }, 500);
      return json(req, { ok: true, recipients, events: events || [] });
    }

    if (action === "create") {
      const chain = String(body.chain || "").toLowerCase();
      const asset = String(body.asset || "").toUpperCase();
      if (!(chain in assets) || !assets[chain].includes(asset)) {
        return json(req, { error: "unsupported_chain_or_asset", supported_assets: assets }, 400);
      }

      const { data: existing, error: existingError } = await admin
        .from("profit_recipient_profiles")
        .select("id,wallet_id,chain,asset,status,activation_at,verified_at,created_at")
        .eq("owner_id", user.id)
        .eq("chain", chain)
        .eq("asset", asset)
        .in("status", ["pending", "active"])
        .maybeSingle();
      if (existingError) return json(req, { error: "profit_recipient_lookup_failed" }, 500);
      if (existing) {
        const { data: existingWallet } = await admin.from("wallets")
          .select("id,chain,address,label,status,last_balance,balance_usd,last_balance_at,last_verified_at")
          .eq("id", existing.wallet_id).eq("owner_id", user.id).maybeSingle();
        return json(req, { ok: true, existing: true, recipient: { ...existing, wallet: existingWallet || null } });
      }

      // This creates an independent recipient key. It never reads, rotates, or rebinds trading wallets.
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const { data: wallet, error: walletError } = await admin.from("wallets").insert({
        owner_id: user.id,
        chain,
        address: account.address,
        label: "ArbiVault Profit Recipient · " + chain.toUpperCase() + " · " + asset,
        status: "active",
        is_hot: false,
        custody_type: "server_vault",
        wallet_role: "profit_recipient",
        verification_source: "arbivault-profit-recipients",
        data_quality_status: "verified",
        derivation_path: "internal-random-secp256k1",
      }).select("id,owner_id,chain,address,label,status").single();

      if (walletError || !wallet) return json(req, { error: "profit_recipient_wallet_create_failed" }, 500);

      const { data: secretRef, error: secretError } = await admin.rpc("store_wallet_secret", {
        p_wallet_id: wallet.id,
        p_secret: privateKey,
      });
      // Erase local references as soon as the vault write has completed; neither value is returned or logged.
      if (secretError || !secretRef) {
        await admin.from("wallets").update({ status: "quarantined" }).eq("id", wallet.id).eq("owner_id", user.id);
        return json(req, { error: "profit_recipient_secret_storage_failed", quarantined: true }, 500);
      }

      const { error: referenceError } = await admin.from("wallets")
        .update({ secret_ref: secretRef, updated_at: new Date().toISOString() })
        .eq("id", wallet.id).eq("owner_id", user.id);
      if (referenceError) {
        await admin.from("wallets").update({ status: "quarantined" }).eq("id", wallet.id).eq("owner_id", user.id);
        return json(req, { error: "profit_recipient_secret_reference_failed", quarantined: true }, 500);
      }

      const activationAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { data: profile, error: profileError } = await admin.from("profit_recipient_profiles").insert({
        owner_id: user.id,
        wallet_id: wallet.id,
        chain,
        asset,
        status: "pending",
        activation_at: activationAt,
        verification_source: "server_vault_secret_reference_saved",
      }).select("id,owner_id,wallet_id,chain,asset,status,activation_at,verified_at,verification_source,created_at,updated_at").single();

      if (profileError || !profile) {
        await admin.from("wallets").update({ status: "quarantined" }).eq("id", wallet.id).eq("owner_id", user.id);
        return json(req, { error: "profit_recipient_profile_create_failed", quarantined: true }, 500);
      }

      await recordEvent(user.id, profile.id, "created", chain, asset, {
        custody: "server_vault",
        secret_reference_saved: true,
        activation_delay_hours: 24,
        private_key_returned: false,
      });

      return json(req, {
        ok: true,
        recipient: {
          ...profile,
          wallet: {
            id: wallet.id, chain: wallet.chain, address: wallet.address, label: wallet.label,
            status: wallet.status, last_balance: null, balance_usd: null,
            last_balance_at: null, last_verified_at: null,
          },
        },
        security: { private_key_returned: false, signer_configured: false, live_transfer_enabled: false },
      }, 201);
    }

    if (action === "activate") {
      const recipientId = String(body.recipient_id || "");
      if (!recipientId) return json(req, { error: "recipient_id_required" }, 400);
      const { data: recipient, error: lookupError } = await admin.from("profit_recipient_profiles")
        .select("id,owner_id,wallet_id,chain,asset,status,activation_at")
        .eq("id", recipientId).eq("owner_id", user.id).maybeSingle();
      if (lookupError) return json(req, { error: "profit_recipient_lookup_failed" }, 500);
      if (!recipient) return json(req, { error: "profit_recipient_not_found" }, 404);
      if (recipient.status === "revoked" || recipient.status === "quarantined") return json(req, { error: "profit_recipient_not_activatable" }, 409);
      if (recipient.status === "active") return json(req, { ok: true, already_active: true, recipient_id: recipient.id });
      if (!recipient.activation_at || new Date(recipient.activation_at).getTime() > Date.now()) {
        return json(req, { error: "activation_delay_pending", activation_at: recipient.activation_at }, 409);
      }
      const { data: wallet, error: walletError } = await admin.from("wallets")
        .select("id,chain,address,status,wallet_role,secret_ref")
        .eq("id", recipient.wallet_id).eq("owner_id", user.id).maybeSingle();
      if (walletError) return json(req, { error: "profit_recipient_wallet_lookup_failed" }, 500);
      if (!wallet || wallet.status !== "active" || wallet.wallet_role !== "profit_recipient" ||
          wallet.chain !== recipient.chain || !wallet.secret_ref ||
          !/^0x[a-fA-F0-9]{40}$/.test(String(wallet.address || ""))) {
        await admin.from("profit_recipient_profiles").update({ status: "quarantined", updated_at: new Date().toISOString() })
          .eq("id", recipient.id).eq("owner_id", user.id);
        if (wallet?.id) await admin.from("wallets").update({ status: "quarantined", updated_at: new Date().toISOString() })
          .eq("id", wallet.id).eq("owner_id", user.id);
        await recordEvent(user.id, recipient.id, "quarantined", recipient.chain, recipient.asset, { reason: "recipient_integrity_check_failed" });
        return json(req, { error: "profit_recipient_integrity_check_failed", quarantined: true }, 409);
      }
      const { error: updateError } = await admin.from("profit_recipient_profiles")
        .update({ status: "active", updated_at: new Date().toISOString(), verification_source: "server_vault_reference_verified" })
        .eq("id", recipient.id).eq("owner_id", user.id);
      if (updateError) return json(req, { error: "profit_recipient_activation_failed" }, 500);
      await recordEvent(user.id, recipient.id, "activated", recipient.chain, recipient.asset, {
        vault_reference_present: true,
        payout_compatibility_verified: false,
        live_routing_enabled: false,
      });
      return json(req, { ok: true, recipient_id: recipient.id, status: "active", payout_compatibility_verified: false, live_routing_enabled: false });
    }

    if (action === "revoke") {
      const recipientId = String(body.recipient_id || "");
      if (!recipientId) return json(req, { error: "recipient_id_required" }, 400);
      const { data: recipient, error: lookupError } = await admin.from("profit_recipient_profiles")
        .select("id,owner_id,wallet_id,chain,asset,status")
        .eq("id", recipientId).eq("owner_id", user.id).maybeSingle();
      if (lookupError) return json(req, { error: "profit_recipient_lookup_failed" }, 500);
      if (!recipient) return json(req, { error: "profit_recipient_not_found" }, 404);
      if (recipient.status === "revoked") return json(req, { ok: true, already_revoked: true });
      const { error: updateError } = await admin.from("profit_recipient_profiles")
        .update({ status: "revoked", updated_at: new Date().toISOString() })
        .eq("id", recipient.id).eq("owner_id", user.id);
      if (updateError) return json(req, { error: "profit_recipient_revoke_failed" }, 500);
      await recordEvent(user.id, recipient.id, "revoked", recipient.chain, recipient.asset, {
        note: "Recipient disabled for future routing; existing funds remain on-chain.",
      });
      return json(req, { ok: true, recipient_id: recipient.id, status: "revoked", funds_moved: false });
    }

    return json(req, { error: "unknown_action" }, 400);
  } catch {
    return json(req, { error: "profit_recipient_request_failed" }, 500);
  }
});