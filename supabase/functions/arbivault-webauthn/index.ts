import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "npm:@simplewebauthn/server@13.2.2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, serviceKey);
const rpID = (Deno.env.get("PASSKEY_RP_ID") || "arbivault.vercel.app").trim();
const origin = (Deno.env.get("PASSKEY_ORIGIN") || "https://arbivault.vercel.app").trim().replace(/\/$/, "");
const cors = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "POST, OPTIONS", "vary": "Origin" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const b64url = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); };
const unb64url = (value: string) => { const s = value.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); };
async function getUser(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const client = createClient(url, serviceKey, { global: { headers: { Authorization: auth } } });
  const { data, error } = await client.auth.getUser();
  return error || !data.user ? null : data.user;
}
async function credentials(ownerId: string) {
  const { data, error } = await admin.from("arbivault_passkey_credentials").select("id,credential_id,public_key_b64url,sign_count,transports,device_type,backed_up,created_at,last_used_at").eq("owner_id", ownerId);
  if (error) throw new Error("passkey_credential_lookup_failed");
  return data || [];
}
async function saveChallenge(ownerId: string, requestId: string | null, value: string, type: string, payloadHash: string | null = null) {
  const { data, error } = await admin.from("arbivault_signing_auth_challenges").insert({ owner_id: ownerId, signing_request_id: requestId, challenge: value, challenge_type: type, payload_hash: payloadHash, expires_at: new Date(Date.now() + 120000).toISOString(), attempts: 0 }).select("id,expires_at").single();
  if (error || !data) throw new Error("passkey_challenge_create_failed");
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (req.headers.get("origin") && req.headers.get("origin") !== origin) return json({ error: "origin_not_allowed" }, 403);
  const user = await getUser(req);
  if (!user) return json({ error: "authentication_required" }, 401);
  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "list") {
      const [pendingResult, credentialRows] = await Promise.all([
        admin.from("signing_requests").select("id,chain,destination_address,payload_hash,status,biometric_verified,approval_expires_at,created_at,wallet_transaction_id").eq("owner_id", user.id).eq("status", "pending").eq("biometric_required", true).gt("approval_expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(50),
        admin.from("arbivault_passkey_credentials").select("id,credential_id,created_at,last_used_at,device_type,backed_up,transports").eq("owner_id", user.id).order("created_at", { ascending: true }),
      ]);
      if (pendingResult.error || credentialRows.error) return json({ error: "passkey_inventory_lookup_failed" }, 500);
      const requestRows = pendingResult.data || [];
      const transactionIds = requestRows.map((row: any) => row.wallet_transaction_id).filter(Boolean);
      let transactions: any[] = [];
      if (transactionIds.length) {
        const { data, error } = await admin.from("wallet_transactions").select("id,amount,asset,transaction_class,chain,source_wallet_id").in("id", transactionIds).eq("owner_id", user.id);
        if (error) return json({ error: "transaction_details_lookup_failed" }, 500);
        transactions = data || [];
      }
      const transactionMap = new Map(transactions.map((row: any) => [row.id, row]));
      return json({ ok: true, pending_requests: requestRows.map((row: any) => ({ ...row, transaction: transactionMap.get(row.wallet_transaction_id) || null })), credentials: credentialRows.data || [] });
    }

    if (action === "registration_options") {
      const enrolled = await credentials(user.id);
      const options = await generateRegistrationOptions({
        rpName: "ArbiVault", rpID, userID: new TextEncoder().encode(user.id),
        userName: user.email || user.id, userDisplayName: user.email || "ArbiVault user",
        attestationType: "none", timeout: 120000,
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        excludeCredentials: enrolled.map((c: any) => ({ id: c.credential_id, transports: c.transports || [] })),
      });
      const challenge = await saveChallenge(user.id, null, options.challenge, "registration");
      return json({ ok: true, options, challenge_id: challenge.id, expires_at: challenge.expires_at });
    }

    if (action === "registration_verify") {
      const challengeId = String(body.challenge_id || "");
      if (!challengeId || !body.response) return json({ error: "invalid_request" }, 400);
      const { data: challenge, error } = await admin.from("arbivault_signing_auth_challenges").select("id,owner_id,challenge,challenge_type,expires_at,used_at").eq("id", challengeId).eq("owner_id", user.id).maybeSingle();
      if (error) return json({ error: "challenge_lookup_failed" }, 500);
      if (!challenge || challenge.challenge_type !== "registration" || challenge.used_at || new Date(challenge.expires_at).getTime() <= Date.now()) return json({ error: "registration_challenge_invalid_or_expired" }, 409);
      const result = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!result.verified || !result.registrationInfo) return json({ error: "passkey_registration_verification_failed" }, 403);
      const info: any = result.registrationInfo;
      const credential = info.credential || { id: body.response.id, publicKey: info.credentialPublicKey, counter: info.counter, transports: body.response.response?.transports || [] };
      if (!credential.id || !(credential.publicKey instanceof Uint8Array) || credential.publicKey.length < 32) return json({ error: "passkey_registration_data_invalid" }, 400);
      const { data: consumed, error: consumeError } = await admin.from("arbivault_signing_auth_challenges").update({ used_at: new Date().toISOString() }).eq("id", challengeId).eq("owner_id", user.id).is("used_at", null).select("id").maybeSingle();
      if (consumeError || !consumed) return json({ error: "registration_challenge_already_used" }, 409);
      const { data: saved, error: saveError } = await admin.from("arbivault_passkey_credentials").insert({
        owner_id: user.id, credential_id: String(credential.id), public_key_b64url: b64url(credential.publicKey),
        sign_count: Number(credential.counter ?? info.counter ?? 0), transports: credential.transports || body.response.response?.transports || [],
        device_type: info.credentialDeviceType || null, backed_up: info.credentialBackedUp === true,
      }).select("id,credential_id,created_at,device_type,backed_up").single();
      if (saveError || !saved) return json({ error: "passkey_credential_store_failed" }, 500);
      return json({ ok: true, credential: saved });
    }

    if (action === "approval_options") {
      const requestId = String(body.signing_request_id || "");
      if (!requestId) return json({ error: "signing_request_id_required" }, 400);
      const enrolled = await credentials(user.id);
      if (!enrolled.length) return json({ error: "passkey_enrollment_required" }, 409);
      const credentialId = String(body.credential_id || "");
      const selectedCredential = enrolled.find((credential: any) => credential.credential_id === credentialId);
      if (!selectedCredential) return json({ error: "credential_not_registered_for_user" }, 403);
      const { data: request, error } = await admin.from("signing_requests").select("id,owner_id,status,biometric_required,biometric_verified,payload_hash,approval_expires_at").eq("id", requestId).eq("owner_id", user.id).maybeSingle();
      if (error) return json({ error: "signing_request_lookup_failed" }, 500);
      if (!request || request.status !== "pending" || request.biometric_required !== true || request.biometric_verified || !request.approval_expires_at || new Date(request.approval_expires_at).getTime() <= Date.now()) return json({ error: "signing_request_not_approvable" }, 409);
      if (!challenge.payload_hash || challenge.payload_hash !== request.payload_hash) return json({ error: "transaction_payload_changed_after_challenge" }, 409);
      const options = await generateAuthenticationOptions({ rpID, timeout: 120000, userVerification: "required", allowCredentials: [{ id: selectedCredential.credential_id, transports: selectedCredential.transports || [] }] });
      const challenge = await saveChallenge(user.id, requestId, options.challenge, "transaction_approval", request.payload_hash);
      return json({ ok: true, options, challenge_id: challenge.id, expires_at: challenge.expires_at, transaction: { id: request.id, payload_hash: request.payload_hash, expires_at: request.approval_expires_at } });
    }

    if (action === "approve") {
      const requestId = String(body.signing_request_id || "");
      const challengeId = String(body.challenge_id || "");
      if (!requestId || !challengeId || !body.response) return json({ error: "invalid_request" }, 400);
      const { data: challenge, error: challengeError } = await admin.from("arbivault_signing_auth_challenges").select("id,owner_id,signing_request_id,challenge,challenge_type,payload_hash,expires_at,used_at,attempts").eq("id", challengeId).eq("owner_id", user.id).maybeSingle();
      if (challengeError) return json({ error: "challenge_lookup_failed" }, 500);
      if (!challenge || challenge.challenge_type !== "transaction_approval" || challenge.signing_request_id !== requestId || challenge.used_at || new Date(challenge.expires_at).getTime() <= Date.now()) return json({ error: "approval_challenge_invalid_or_expired" }, 409);
      const enrolled = await credentials(user.id);
      const credential = enrolled.find((c: any) => c.credential_id === body.response.id);
      if (!credential) return json({ error: "credential_not_registered_for_user" }, 403);
      const { data: request, error: requestError } = await admin.from("signing_requests").select("id,owner_id,status,biometric_required,biometric_verified,payload_hash,approval_expires_at,wallet_transaction_id").eq("id", requestId).eq("owner_id", user.id).maybeSingle();
      if (requestError) return json({ error: "signing_request_lookup_failed" }, 500);
      if (!request || request.status !== "pending" || request.biometric_required !== true || request.biometric_verified || !request.approval_expires_at || new Date(request.approval_expires_at).getTime() <= Date.now()) return json({ error: "signing_request_not_approvable" }, 409);
      const verified = await verifyAuthenticationResponse({
        response: body.response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: credential.credential_id, publicKey: unb64url(credential.public_key_b64url), counter: Number(credential.sign_count), transports: credential.transports || [] },
      });
      if (!verified.verified) return json({ error: "passkey_assertion_verification_failed" }, 403);
      const now = new Date().toISOString();
      const { data: consumed, error: consumeError } = await admin.from("arbivault_signing_auth_challenges").update({ used_at: now, attempts: Number(challenge.attempts || 0) + 1 }).eq("id", challengeId).eq("owner_id", user.id).is("used_at", null).select("id").maybeSingle();
      if (consumeError || !consumed) return json({ error: "approval_challenge_already_used" }, 409);
      if (request.wallet_transaction_id) {
        const { data: transferAuth, error: syncError } = await admin.from("transfer_authorizations").update({ authorization_status: "authorized", biometric_verified: true, biometric_verified_at: now }).eq("wallet_transaction_id", request.wallet_transaction_id).eq("owner_id", user.id).eq("payload_hash", request.payload_hash).eq("authorization_status", "pending").select("id").maybeSingle();
        if (syncError || !transferAuth) return json({ error: "transfer_authorization_not_pending_or_sync_failed" }, 409);
      }
      const { data: authorized, error: authError } = await admin.from("signing_requests").update({ status: "authorized", biometric_verified: true, approved_at: now, authorization_credential_id: credential.credential_id, approval_method: "webauthn_transaction_bound" }).eq("id", requestId).eq("owner_id", user.id).eq("status", "pending").eq("biometric_verified", false).select("id,status,biometric_verified,approved_at,authorization_credential_id").maybeSingle();
      if (authError || !authorized) return json({ error: "signing_request_authorization_race_or_failure" }, 409);
      await admin.from("arbivault_passkey_credentials").update({ sign_count: Number(verified.authenticationInfo.newCounter), last_used_at: now }).eq("id", credential.id).eq("owner_id", user.id);
      return json({ ok: true, signing_request: authorized });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    console.error("webauthn handler failed", error);
    return json({ error: "webauthn_request_failed" }, 500);
  }
});
