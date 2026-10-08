import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { parseTransaction } from "npm:viem@2.39.0";
import { privateKeyToAccount } from "npm:viem@2.39.0/accounts";
import * as bitcoin from "npm:bitcoinjs-lib@7.0.0";
import * as ecc from "npm:tiny-secp256k1@2.2.3";
import { ECPairFactory } from "npm:ecpair@3.0.0";
import { VersionedTransaction, Transaction, Keypair } from "npm:@solana/web3.js@1.98.4";

const ECPair = ECPairFactory(ecc);
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const json = (x: unknown, s = 200) =>
  Response.json(x, { status: s, headers: { "cache-control": "no-store" } });

async function authorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data } = await supabase.rpc("get_bot_cron_token");
  return !!data && supplied === data;
}

async function hash(v: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}

const BSC_RPC = Deno.env.get("BSC_RPC_URL") || "https://bsc-dataseed.binance.org";
const SOLANA_RPC = Deno.env.get("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!response.ok) throw new Error("broadcast_rpc_http_" + response.status);
  const body = await response.json();
  if (body.error) throw new Error("broadcast_rpc_" + (body.error.code || "error"));
  return body.result;
}

async function broadcastSigned(chain: string, signed: string) {
  // Broadcast only serialized, signed transactions. Never accept unsigned payloads here.
  if (chain === "bnb") {
    const txHash = await rpc(BSC_RPC, "eth_sendRawTransaction", [signed]);
    if (!txHash) throw new Error("bsc_broadcast_missing_tx_hash");
    return String(txHash);
  }
  if (chain === "solana") {
    const txHash = await rpc(SOLANA_RPC, "sendTransaction", [signed, { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
    if (!txHash) throw new Error("solana_broadcast_missing_signature");
    return String(txHash);
  }
  if (chain === "bitcoin") {
    // bitcoinjs-lib returns a finalized PSBT; extract the raw network transaction
    // before submitting to a public Bitcoin relay.
    const psbt = bitcoin.Psbt.fromBase64(signed, { network: bitcoin.networks.bitcoin });
    const txHex = psbt.extractTransaction().toHex();
    const response = await fetch("https://mempool.space/api/tx", {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "text/plain" },
      body: txHex,
    });
    const body = (await response.text()).trim();
    if (!response.ok) throw new Error(`bitcoin_broadcast_http_${response.status}${body ? `_${body.slice(0, 160)}` : ""}`);
    if (!body) throw new Error("bitcoin_broadcast_missing_tx_hash");
    return body;
  }
  throw new Error("broadcast_chain_not_configured");
}

async function getSecret(id: string) {
  const { data, error } = await supabase.rpc("get_wallet_secret", { p_wallet_id: id });
  if (error || !data) throw new Error("wallet_secret_unavailable");
  return String(data);
}

function decode64(v: string) {
  return Uint8Array.from(atob(v), c => c.charCodeAt(0));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    const b = await req.json();
    const adapterId = String(b.adapter_id || "");
    const walletId = String(b.source_wallet_id || "");
    const signingRequestId = String(b.signing_request_id || "");
    const chain = String(b.chain || "").toLowerCase();
    const unsigned = String(b.unsigned_transaction || "");
    const mode = b.mode === "transfer" ? "transfer" : "trade";

    if (
      !adapterId ||
      !walletId ||
      !signingRequestId ||
      !unsigned ||
      !["bnb", "solana", "bitcoin"].includes(chain)
    ) {
      return json({ error: "invalid_request" }, 400);
    }

    const { data: adapter, error: ae } = await supabase
      .from("execution_adapters")
      .select("*")
      .eq("id", adapterId)
      .maybeSingle();
    if (ae) return json({ error: ae.message }, 500);
    if (
      !adapter ||
      adapter.configured !== true ||
      adapter.automatic_signing !== true ||
      adapter.can_broadcast !== true ||
      adapter.signer_provider !== "internal_vault"
    ) {
      return json({ error: "adapter_not_authorized" }, 403);
    }

    if (
      adapter.allowed_wallet_id !== walletId ||
      adapter.signing_boundary !== "internal_vault"
    ) {
      return json({ error: "wallet_not_bound_to_internal_signer" }, 403);
    }

    const { data: wallet, error: we } = await supabase
      .from("wallets")
      .select("id,owner_id,chain,address,status,is_hot,wallet_role")
      .eq("id", walletId)
      .maybeSingle();
    if (we) return json({ error: we.message }, 500);
    if (
      !wallet ||
      wallet.status !== "active" ||
      wallet.is_hot !== true ||
      wallet.wallet_role !== "trading_hot" ||
      wallet.chain !== chain
    ) {
      return json({ error: "source_wallet_not_active_trading_hot" }, 403);
    }

    if (String(adapter.signer_key_ref || "").toLowerCase() !== String(wallet.address).toLowerCase()) {
      return json({ error: "signer_wallet_mismatch" }, 403);
    }

    if (mode === "transfer") {
      return json({ error: "withdrawal_requires_human_approval" }, 403);
    }

    const payloadHash = await hash(unsigned);
    const { data: requestRow, error: re } = await supabase
      .from("signing_requests")
      .select(
        "id,owner_id,execution_attempt_id,chain,source_wallet_id,payload_hash,status,biometric_required,biometric_verified,approval_method,approval_expires_at"
      )
      .eq("id", signingRequestId)
      .maybeSingle();

    if (re) return json({ error: re.message }, 500);
    if (!requestRow) return json({ error: "signing_request_not_found" }, 404);
    if (requestRow.owner_id !== wallet.owner_id) {
      return json({ error: "authorization_owner_mismatch" }, 403);
    }
    if (requestRow.source_wallet_id !== walletId || requestRow.chain !== chain) {
      return json({ error: "signing_request_wallet_mismatch" }, 403);
    }
    if (requestRow.payload_hash !== payloadHash) {
      return json({ error: "signing_payload_mismatch" }, 403);
    }
    if (requestRow.status !== "authorized") {
      return json({ error: "human_approval_required" }, 403);
    }
    if (requestRow.biometric_required && requestRow.biometric_verified !== true) {
      return json({ error: "biometric_approval_required" }, 403);
    }
    if (requestRow.approval_expires_at && new Date(requestRow.approval_expires_at) <= new Date()) {
      return json({ error: "signing_approval_expired" }, 410);
    }

    const sv = await getSecret(walletId);
    let signed = "";

    if (chain === "bnb") {
      const account = privateKeyToAccount(sv as `0x${string}`);
      let tx: any;
      try {
        const parsedCandidate = JSON.parse(unsigned);
        if (!parsedCandidate || typeof parsedCandidate !== "object") throw new Error("evm_json_not_object");
        const to = String(parsedCandidate.to || "");
        if (!/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error("evm_destination_invalid");
        if (parsedCandidate.from && String(parsedCandidate.from).toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error("transaction_sender_mismatch");
        }
        const allowed = Array.isArray(adapter.allowed_contracts) ? adapter.allowed_contracts : [];
        if (
          allowed.length &&
          !allowed.some((x: any) => String(x).toLowerCase() === to.toLowerCase())
        ) {
          return json({ error: "destination_contract_not_allowlisted" }, 403);
        }
        if (parsedCandidate.chainId !== undefined && Number(parsedCandidate.chainId) !== 56) {
          throw new Error("transaction_chain_id_mismatch");
        }
        const toBigInt = (name: string, value: unknown) => {
          if (value === undefined || value === null) return undefined;
          const s = String(value);
          if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
          if (/^\\d+$/.test(s)) return BigInt(s);
          throw new Error(`evm_${name}_invalid`);
        };
        tx = {
          chainId: 56,
          nonce: toBigInt("nonce", parsedCandidate.nonce),
          to,
          value: toBigInt("value", parsedCandidate.value) ?? 0n,
          data: parsedCandidate.data ? String(parsedCandidate.data) as `0x${string}` : undefined,
          gas: toBigInt("gas", parsedCandidate.gas),
          gasPrice: toBigInt("gasPrice", parsedCandidate.gasPrice),
        };
        if (tx.nonce === undefined || tx.gas === undefined || tx.gasPrice === undefined) {
          throw new Error("evm_transaction_fee_fields_missing");
        }
        // requestRow.payload_hash already commits to the exact unsigned payload
        // that was authorized. The builder's JSON is signed without rewriting it.
      } catch (e) {
        try {
          const parsed: any = parseTransaction(unsigned as `0x${string}`);
          if (!parsed.to) return json({ error: "contract_creation_not_allowed" }, 403);
          if (parsed.from && parsed.from.toLowerCase() !== wallet.address.toLowerCase()) {
            return json({ error: "transaction_sender_mismatch" }, 403);
          }
          tx = parsed;
        } catch {
          return json({ error: e instanceof Error ? e.message : "evm_transaction_decode_failed" }, 400);
        }
      }
      signed = await account.signTransaction(tx);
    } else if (chain === "solana") {
      const raw = decode64(unsigned);
      const kp = Keypair.fromSecretKey(
        Uint8Array.from((sv.match(/.{1,2}/g) || []).map(x => parseInt(x, 16)))
      );
      let tx: any;
      try {
        tx = VersionedTransaction.deserialize(raw);
        tx.sign([kp]);
      } catch {
        tx = Transaction.from(raw);
        tx.partialSign(kp);
      }
      signed = btoa(String.fromCharCode(...tx.serialize()));
    } else {
      const psbt = bitcoin.Psbt.fromBase64(unsigned, { network: bitcoin.networks.bitcoin });
      const key = ECPair.fromWIF(sv, bitcoin.networks.bitcoin);
      psbt.signAllInputs(key);
      if (!psbt.validateSignaturesOfAllInputs()) {
        return json({ error: "bitcoin_signature_validation_failed" }, 500);
      }
      psbt.finalizeAllInputs();
      signed = psbt.toBase64();
    }

    const now = new Date().toISOString();

    // Idempotency: once a signing request has a broadcast tx hash, return it
    // instead of attempting to submit the same transaction again.
    const { data: latestRequest } = await supabase
      .from("signing_requests")
      .select("status,tx_hash,broadcast_at")
      .eq("id", requestRow.id)
      .maybeSingle();
    if (latestRequest?.status === "broadcast" && latestRequest.tx_hash) {
      return json({
        ok: true,
        signing_request_id: requestRow.id,
        provider: "internal_vault",
        chain,
        mode,
        tx_hash: String(latestRequest.tx_hash),
        signed: true,
        broadcast: true,
        idempotent_replay: true,
      });
    }

    const txHash = await broadcastSigned(chain, signed);
    const broadcastAt = new Date().toISOString();

    const { error: markError } = await supabase
      .from("signing_requests")
      .update({ status: "broadcast", signed_at: now, broadcast_at: broadcastAt, tx_hash: txHash })
      .eq("id", requestRow.id)
      .eq("status", "authorized");

    if (markError) {
      // The network broadcast already succeeded. Persist the execution attempt too,
      // then return success with an explicit persistence warning instead of causing
      // the caller to retry and potentially rebroadcast the same nonce.
      if (requestRow.execution_attempt_id) {
        await supabase.from("execution_attempts").update({
          status: "broadcast",
          tx_hash: txHash,
          signed_at: now,
          broadcast_at: broadcastAt,
          updated_at: broadcastAt,
          failure_reason: null,
        }).eq("id", requestRow.execution_attempt_id);
      }
      return json({
        ok: true,
        signing_request_id: requestRow.id,
        provider: "internal_vault",
        chain,
        mode,
        tx_hash: txHash,
        signed: true,
        broadcast: true,
        state_persisted: false,
      }, 202);
    }

    await supabase
      .from("execution_adapters")
      .update({
        last_signed_at: now,
        last_broadcast_at: broadcastAt,
        health_status: "healthy",
        last_error: null,
        updated_at: broadcastAt,
      })
      .eq("id", adapter.id);

    return json({
      ok: true,
      signing_request_id: requestRow.id,
      provider: "internal_vault",
      chain,
      mode,
      tx_hash: txHash,
      signed: true,
      broadcast: true,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "internal_signer_error" }, 500);
  }
});