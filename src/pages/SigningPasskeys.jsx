import { useCallback, useEffect, useState } from "react";
import { Fingerprint, RefreshCw, ShieldCheck, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

const fromB64Url = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
const toB64Url = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
function registrationOptions(options) {
  return {
    ...options,
    challenge: fromB64Url(options.challenge),
    user: { ...options.user, id: fromB64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: fromB64Url(item.id) })),
  };
}
function authenticationOptions(options) {
  return {
    ...options,
    challenge: fromB64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: fromB64Url(item.id) })),
  };
}
function serializeCredential(credential) {
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: toB64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    response: { clientDataJSON: toB64Url(response.clientDataJSON) },
  };
  if (response.attestationObject) {
    common.response.attestationObject = toB64Url(response.attestationObject);
    common.response.transports = response.getTransports?.() || [];
  } else {
    common.response.authenticatorData = toB64Url(response.authenticatorData);
    common.response.signature = toB64Url(response.signature);
    common.response.userHandle = response.userHandle ? toB64Url(response.userHandle) : null;
  }
  return common;
}
async function invoke(action, extra = {}) {
  const { data, error } = await supabase.functions.invoke("arbivault-webauthn", { body: { action, ...extra } });
  if (error) {
    let message = error.message || "Passkey request failed";
    try {
      const detail = await error.context?.json?.();
      if (detail?.error) message = detail.error;
    } catch (parseError) {
      message = message || String(parseError);
    }
    throw new Error(message);
  }
  if (!data?.ok) throw new Error(data?.error || "Passkey request failed");
  return data;
}
const short = (value) => value ? (value.length > 24 ? value.slice(0, 12) + "…" + value.slice(-8) : value) : "—";

export default function SigningPasskeys() {
  const [credentials, setCredentials] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await invoke("list");
      setCredentials(result.credentials || []);
      setPending(result.pending_requests || []);
    } catch (e) {
      setError(e.message || "Unable to load passkey security state");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const enroll = async () => {
    if (!window.PublicKeyCredential || !navigator.credentials?.create) {
      setError("This browser does not support WebAuthn passkeys.");
      return;
    }
    setBusy("enroll"); setError(""); setNotice("");
    try {
      const challenge = await invoke("registration_options");
      const credential = await navigator.credentials.create({ publicKey: registrationOptions(challenge.options) });
      if (!credential) throw new Error("Passkey registration was cancelled.");
      const result = await invoke("registration_verify", { challenge_id: challenge.challenge_id, response: serializeCredential(credential) });
      setNotice("Passkey registered and verified on the server.");
      await load();
      if (!result.credential) throw new Error("Passkey was not confirmed by the server.");
    } catch (e) {
      setError(e.message || "Passkey registration failed");
    } finally {
      setBusy("");
    }
  };

  const approve = async (request) => {
    if (!navigator.credentials?.get) {
      setError("This browser does not support WebAuthn passkeys.");
      return;
    }
    setBusy(request.id); setError(""); setNotice("");
    try {
      const challenge = await invoke("approval_options", { signing_request_id: request.id });
      const assertion = await navigator.credentials.get({ publicKey: authenticationOptions(challenge.options) });
      if (!assertion) throw new Error("Passkey approval was cancelled.");
      const result = await invoke("approve", { signing_request_id: request.id, challenge_id: challenge.challenge_id, response: serializeCredential(assertion) });
      setNotice(result.warning ? "Passkey verified; authorization record needs reconciliation." : "Passkey verified. Signing request is authorized; network broadcast is a separate step.");
      await load();
    } catch (e) {
      setError(e.message || "Transaction approval failed");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
            <div><h1 className="text-lg font-semibold">Transaction passkeys</h1><p className="text-xs text-muted-foreground">WebAuthn authorization · separate from account sign-in</p></div>
          </div>
          <button type="button" onClick={load} disabled={loading || !!busy} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"><RefreshCw className="h-4 w-4" /> Refresh</button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        {error && <div role="alert" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
        {notice && <div role="status" className="flex gap-2 rounded-md border border-primary/30 p-3 text-sm"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div>}
        <section className="rounded-lg border border-border p-4 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="font-semibold">Enrolled transaction credentials</h2><p className="mt-1 text-sm text-muted-foreground">A passkey must be enrolled here before it can approve a transfer or trade. Face ID/Touch ID confirms use of the private credential; the server verifies the signed assertion.</p></div>
            <button type="button" onClick={enroll} disabled={!!busy || loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {busy === "enroll" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
              {busy === "enroll" ? "Registering…" : credentials.length ? "Add passkey" : "Register passkey"}
            </button>
          </div>
          {loading ? <p className="mt-4 text-sm text-muted-foreground">Loading security state…</p> : credentials.length ? (
            <ul className="mt-4 divide-y divide-border">{credentials.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span className="font-mono">{short(item.credential_id)}</span><span className="text-muted-foreground">{item.device_type || "Passkey"}{item.backed_up ? " · synced" : ""}</span><span className="text-xs text-muted-foreground">{item.last_used_at ? "Last used " + new Date(item.last_used_at).toLocaleString() : "Not used yet"}</span></li>)}</ul>
          ) : <p className="mt-4 rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No transaction passkeys are enrolled. Register one to enable cryptographic approval.</p>}
        </section>
        <section className="rounded-lg border border-border p-4 md:p-6">
          <h2 className="font-semibold">Pending transaction approvals</h2>
          <p className="mt-1 text-sm text-muted-foreground">Review the destination and payload hash before approving. Approval authorizes the signer; it does not claim the transaction was broadcast or confirmed.</p>
          {loading ? <p className="mt-4 text-sm text-muted-foreground">Loading pending requests…</p> : pending.length ? (
            <div className="mt-4 space-y-3">{pending.map((item) => <article key={item.id} className="rounded-md border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium">{String(item.chain || "unknown").toUpperCase()} · {item.transaction?.transaction_class === "transfer" ? "Internal transfer" : item.transaction?.transaction_class === "withdrawal" ? "Withdrawal" : "Pending authorization"}</div><div className="mt-1 text-sm text-foreground">Amount: {item.transaction ? Number(item.transaction.amount).toLocaleString("en-US", { maximumFractionDigits: 8 }) + " " + item.transaction.asset : "See payload hash"}</div><div className="mt-1 break-all text-sm text-muted-foreground">Destination: {item.destination_address || "Not provided"}</div></div>
                <button type="button" onClick={() => approve(item)} disabled={!!busy || !credentials.length} className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}{busy === item.id ? "Verifying…" : "Approve with passkey"}</button>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">Request: <span className="font-mono">{item.id}</span></div>
              <div className="mt-1 break-all text-xs text-muted-foreground">Payload SHA-256: <span className="font-mono">{item.payload_hash}</span></div>
              <div className="mt-1 text-xs text-muted-foreground">Expires: {item.approval_expires_at ? new Date(item.approval_expires_at).toLocaleString() : "Not specified"}</div>
            </article>)}</div>
          ) : <p className="mt-4 rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No unexpired pending requests require passkey approval.</p>}
          {!credentials.length && !loading && pending.length > 0 && <p className="mt-3 text-sm text-muted-foreground">Register a transaction passkey above before approving requests.</p>}
        </section>
      </main>
    </div>
  );
}
