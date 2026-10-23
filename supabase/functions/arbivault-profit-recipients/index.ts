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


function normalizeEvmPrivateKey(secret: string): `0x${string}` {
  const key = secret.startsWith("0x") ? secret : `0x${secret}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("vault_private_key_format_invalid");
  return key as `0x${string}`;
}

// A Supabase wallet row is not sufficient by itself: retrieve the protected
// secret and prove that it derives the exact stored payout address.
async function verifySupabaseVaultWallet(ownerId: string, walletId: string, chain: string, expectedAddress: string) {
  const { data: wallet, error: walletError } = await admin.from("wallets")
    .select("id,owner_id,chain,address,status,is_hot,custody_type,wallet_role,data_quality_status,secret_ref")
    .eq("id", walletId).eq("owner_id", ownerId).maybeSingle();

  if (walletError || !wallet || wallet.status !== "active" ||
      wallet.chain !== chain || wallet.is_hot !== false ||
      wallet.custody_type !== "server_vault" ||
      wallet.wallet_role !== "profit_recipient" ||
      wallet.data_quality_status !== "verified" || !wallet.secret_ref ||
      !/^0x[a-fA-F0-9]{40}$/.test(String(wallet.address || "")) ||
      String(wallet.address).toLowerCase() !== expectedAddress.toLowerCase()) {
    return false;
  }

  const { data: secret, error: secretError } = await admin.rpc("get_wallet_secret", {
    p_wallet_id: walletId,
  });
  if (secretError || typeof secret !== "string" || !secret) return false;

  try {
    const derivedAddress = privateKeyToAccount(normalizeEvmPrivateKey(secret)).address;
    return derivedAddress.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
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
      const chain = String(body.chain || "").toLowerCase();
      const asset = String(body.asset || "").toUpperCase();
      if (!(chain in assets) || !assets[chain].includes(asset)) {
        return json({ error: "unsupported_chain_or_asset", supported_assets: assets }, 400);
      }

      const { data: existing, error: existingError } = await admin
        .from("profit_recipient_profiles")
        .select("id,wallet_id,chain,asset,status,activation_at,verified_at,created_at")
        .eq("owner_id", user.id)
        .eq("chain", chain)
        .eq("asset", asset)
        .in("status", ["pending", "active"])
        .maybeSingle();
      if (existingError) return json({ error: "profit_recipient_lookup_failed" }, 500);
      if (existing) {
        const { data: existingWallet } = await admin.from("wallets")
          .select("id,chain,address,label,status,last_balance,balance_usd,last_balance_at,last_verified_at")
          .eq("id", existing.wallet_id).eq("owner_id", user.id).maybeSingle();
        return json({ ok: true, existing: true, recipient: { ...existing, wallet: existingWallet || null } });
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

      if (walletError || !wallet) return json({ error: "profit_recipient_wallet_create_failed" }, 500);

      const { data: secretRef, error: secretError } = await admin.rpc("store_wallet_secret", {
        p_wallet_id: wallet.id,
        p_secret: privateKey,
      });
      // Erase local references as soon as the vault write has completed; neither value is returned or logged.
      if (secretError || !secretRef) {
        await admin.from("wallets").update({ status: "quarantined" }).eq("id", wallet.id).eq("owner_id", user.id);
        return json({ error: "profit_recipient_secret_storage_failed", quarantined: true }, 500);
      }

      const { error: referenceError } = await admin.from("wallets")
        .update({ secret_ref: secretRef, updated_at: new Date().toISOString() })
        .eq("id", wallet.id).eq("owner_id", user.id);
      if (referenceError) {
        await admin.from("wallets").update({ status: "quarantined" }).eq("id", wallet.id).eq("owner_id", user.id);
        return json({ error: "profit_recipient_secret_reference_failed", quarantined: true }, 500);
      }

      const walletVerified = await verifySupabaseVaultWallet(user.id, wallet.id, chain, wallet.address);
      if (!walletVerified) {
        await admin.from("wallets").update({ status: "quarantined", updated_at: new Date().toISOString() })
          .eq("id", wallet.id).eq("owner_id", user.id);
        return json({ error: "profit_recipient_vault_address_verification_failed", quarantined: true }, 409);
      }

      const activatedAt = new Date().toISOString();
      const { data: profile, error: profileError } = await admin.from("profit_recipient_profiles").insert({
        owner_id: user.id,
        wallet_id: wallet.id,
        chain,
        asset,
        status: "active",
        activation_at: activatedAt,
        verified_at: activatedAt,
        verification_source: "supabase_vault_key_matches_address",
      }).select("id,owner_id,wallet_id,chain,asset,status,activation_at,verified_at,verification_source,created_at,updated_at").single();

      if (profileError || !profile) {
        await admin.from("wallets").update({ status: "quarantined" }).eq("id", wallet.id).eq("owner_id", user.id);
        return json({ error: "profit_recipient_profile_create_failed", quarantined: true }, 500);
      }

      await recordEvent(user.id, profile.id, "created", chain, asset, {
        custody: "server_vault",
        secret_reference_saved: true,
        payout_wallet_verified: true,
        verification_method: "vault_secret_derives_stored_address",
        activation_delay_hours: 0,
        private_key_returned: false,
      });
      await recordEvent(user.id, profile.id, "verified", chain, asset, {
        custody: "server_vault",
        payout_wallet_verified: true,
      });
      await recordEvent(user.id, profile.id, "activated", chain, asset, {
        activation_delay_hours: 0,
        payout_wallet_verified: true,
        live_routing_enabled: false,
      });

      return json({
        ok: true,
        recipient: {
          ...profile,
          wallet: {
            id: wallet.id, chain: wallet.chain, address: wallet.address, label: wallet.label,
            status: wallet.status, last_balance: null, balance_usd: null,
            last_balance_at: null, last_verified_at: null,
          },
        },
        security: {
          private_key_returned: false,
          payout_wallet_verified: true,
          verification_method: "supabase_vault_key_matches_address",
          signer_configured: false,
          live_transfer_enabled: false,
        },
      }, 201);
    }

    if (action === "activate") {
      const recipientId = String(body.recipient_id || "");
      if (!recipientId) return json({ error: "recipient_id_required" }, 400);
      const { data: recipient, error: lookupError } = await admin.from("profit_recipient_profiles")
        .select("id,owner_id,wallet_id,chain,asset,status,activation_at")
        .eq("id", recipientId).eq("owner_id", user.id).maybeSingle();
      if (lookupError) return json({ error: "profit_recipient_lookup_failed" }, 500);
      if (!recipient) return json({ error: "profit_recipient_not_found" }, 404);
      if (recipient.status === "revoked" || recipient.status === "quarantined") return json({ error: "profit_recipient_not_activatable" }, 409);
      if (recipient.status === "active") return json({ ok: true, already_active: true, recipient_id: recipient.id });
      const { data: wallet, error: walletError } = await admin.from("wallets")
        .select("id,owner_id,chain,address,status,is_hot,custody_type,wallet_role,data_quality_status,secret_ref")
        .eq("id", recipient.wallet_id).eq("owner_id", user.id).maybeSingle();
      if (walletError) return json({ error: "profit_recipient_wallet_lookup_failed" }, 500);
      if (!wallet || wallet.status !== "active" || wallet.is_hot !== false ||
          wallet.wallet_role !== "profit_recipient" || wallet.custody_type !== "server_vault" ||
          wallet.data_quality_status !== "verified" || wallet.chain !== recipient.chain || !wallet.secret_ref ||
          !/^0x[a-fA-F0-9]{40}$/.test(String(wallet.address || ""))) {
        await admin.from("profit_recipient_profiles").update({ status: "quarantined", updated_at: new Date().toISOString() })
          .eq("id", recipient.id).eq("owner_id", user.id);
        if (wallet?.id) await admin.from("wallets").update({ status: "quarantined", updated_at: new Date().toISOString() })
          .eq("id", wallet.id).eq("owner_id", user.id);
        await recordEvent(user.id, recipient.id, "quarantined", recipient.chain, recipient.asset, { reason: "recipient_integrity_check_failed" });
        return json({ error: "profit_recipient_integrity_check_failed", quarantined: true }, 409);
      }
      const walletVerified = await verifySupabaseVaultWallet(user.id, wallet.id, recipient.chain, wallet.address);
      if (!walletVerified) {
        await admin.from("profit_recipient_profiles").update({
          status: "quarantined", updated_at: new Date().toISOString(),
          verification_source: "supabase_vault_address_verification_failed",
        }).eq("id", recipient.id).eq("owner_id", user.id);
        await admin.from("wallets").update({ status: "quarantined", updated_at: new Date().toISOString() })
          .eq("id", wallet.id).eq("owner_id", user.id);
        await recordEvent(user.id, recipient.id, "quarantined", recipient.chain, recipient.asset, {
          reason: "supabase_vault_secret_does_not_match_payout_address",
        });
        return json({ error: "profit_recipient_vault_address_verification_failed", quarantined: true }, 409);
      }

      const activatedAt = new Date().toISOString();
      const { error: updateError } = await admin.from("profit_recipient_profiles")
        .update({
          status: "active",
          activation_at: activatedAt,
          verified_at: activatedAt,
          updated_at: activatedAt,
          verification_source: "supabase_vault_key_matches_address",
        })
        .eq("id", recipient.id).eq("owner_id", user.id);
      if (updateError) return json({ error: "profit_recipient_activation_failed" }, 500);
      await recordEvent(user.id, recipient.id, "verified", recipient.chain, recipient.asset, {
        custody: "server_vault",
        payout_wallet_verified: true,
        verification_method: "vault_secret_derives_stored_address",
      });
      await recordEvent(user.id, recipient.id, "activated", recipient.chain, recipient.asset, {
        activation_delay_hours: 0,
        payout_wallet_verified: true,
        payout_compatibility_verified: false,
        live_routing_enabled: false,
      });
      return json({
        ok: true,
        recipient_id: recipient.id,
        status: "active",
        payout_wallet_verified: true,
        verification_method: "supabase_vault_key_matches_address",
        payout_compatibility_verified: false,
        live_routing_enabled: false,
      });
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