import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_PAYMENT_HEADER_BYTES = 32_768;
const ALLOWED_METHODS = new Set(["GET"]);

type PaymentRequirement = {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  amount?: unknown;
  maxAmountRequired?: unknown;
  payTo?: unknown;
  [key: string]: unknown;
};

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

function envList(name: string): string[] {
  return (Deno.env.get(name) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requiredPolicy() {
  const allowedHosts = envList("X402_ALLOWED_HOSTS").map((value) => value.toLowerCase());
  const allowedNetworks = new Set(envList("X402_ALLOWED_NETWORKS"));
  const allowedAssets = new Set(envList("X402_ALLOWED_ASSETS").map((value) => value.toLowerCase()));
  const allowedRecipients = new Set(envList("X402_ALLOWED_RECIPIENTS").map((value) => value.toLowerCase()));
  let maxByAsset: Record<string, string> = {};
  try {
    maxByAsset = JSON.parse(Deno.env.get("X402_MAX_AMOUNT_ATOMIC_BY_ASSET") || "{}");
  } catch {
    throw new Error("x402_amount_policy_invalid_json");
  }
  if (
    allowedHosts.length === 0 ||
    allowedNetworks.size === 0 ||
    allowedAssets.size === 0 ||
    allowedRecipients.size === 0 ||
    !maxByAsset ||
    typeof maxByAsset !== "object" ||
    Array.isArray(maxByAsset) ||
    Object.keys(maxByAsset).length === 0
  ) {
    throw new Error("x402_policy_not_configured");
  }
  return { allowedHosts, allowedNetworks, allowedAssets, allowedRecipients, maxByAsset };
}

function parseResourceUrl(value: unknown, allowedHosts: string[]): URL {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("resource_url_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("resource_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new Error("resource_host_not_allowlisted");
  }
  return url;
}

function decodePaymentRequired(response: Response, bodyText: string): any | null {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (header) {
    try {
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(header), (character) => character.charCodeAt(0)),
      );
      return JSON.parse(decoded);
    } catch {
      throw new Error("x402_payment_required_header_invalid");
    }
  }
  if (bodyText) {
    try {
      const body = JSON.parse(bodyText);
      if (body && typeof body === "object" && (body.x402Version || body.accepts || body.paymentRequired)) {
        return body.paymentRequired || body;
      }
    } catch {
      // Non-JSON 402 bodies are valid HTTP responses but cannot be safely paid.
    }
  }
  return null;
}

function safeAccepts(requirements: any, policy: ReturnType<typeof requiredPolicy>) {
  const accepts = Array.isArray(requirements?.accepts) ? requirements.accepts : [];
  const safe = accepts.filter((item: PaymentRequirement) => {
    if (!item || typeof item !== "object") return false;
    const network = typeof item.network === "string" ? item.network : "";
    const asset = typeof item.asset === "string" ? item.asset.toLowerCase() : "";
    const payTo = typeof item.payTo === "string" ? item.payTo.toLowerCase() : "";
    const rawAmount = item.amount ?? item.maxAmountRequired;
    if (
      !network ||
      !policy.allowedNetworks.has(network) ||
      !asset ||
      !policy.allowedAssets.has(asset) ||
      !payTo ||
      !policy.allowedRecipients.has(payTo) ||
      typeof rawAmount !== "string" ||
      !/^[0-9]+$/.test(rawAmount)
    ) return false;

    const capKey = `${network}:${asset}`;
    const cap = policy.maxByAsset[capKey];
    if (typeof cap !== "string" || !/^[0-9]+$/.test(cap)) return false;
    try {
      return BigInt(rawAmount) > 0n && BigInt(rawAmount) <= BigInt(cap);
    } catch {
      return false;
    }
  });
  return safe;
}

function validatePaymentSignature(signature: string, safeOptions: PaymentRequirement[]) {
  let payment: any;
  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)),
    );
    payment = JSON.parse(decoded);
  } catch {
    throw new Error("x402_payment_signature_invalid");
  }

  // x402 v2 PaymentPayload binds the signed payload to an accepted requirement.
  // Do not forward opaque signatures: inspect the selected terms before allowing
  // the resource server to verify/settle them.
  const accepted = payment?.accepted;
  if (!accepted || typeof accepted !== "object") {
    throw new Error("x402_payment_signature_terms_missing");
  }
  const matches = safeOptions.some((option) =>
    option.scheme === accepted.scheme &&
    option.network === accepted.network &&
    String(option.asset || "").toLowerCase() === String(accepted.asset || "").toLowerCase() &&
    String(option.payTo || "").toLowerCase() === String(accepted.payTo || "").toLowerCase() &&
    String(option.amount ?? option.maxAmountRequired ?? "") === String(accepted.amount ?? accepted.maxAmountRequired ?? "")
  );
  if (!matches) throw new Error("x402_payment_signature_terms_not_approved");
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("x402_resource_response_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("x402_resource_response_too_large");
  }
  return bytes;
}

function audit(event: Record<string, unknown>) {
  // Never log signatures, authorization headers, query values, or response bodies.
  console.log(JSON.stringify({
    component: "arbivault-x402-resource",
    timestamp: new Date().toISOString(),
    ...event,
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: "authentication_required" }, 401);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) return json({ error: "auth_service_not_configured" }, 503);
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await authClient.auth.getUser();
    if (authError || !userData.user) return json({ error: "authentication_invalid" }, 401);

    const contentLength = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return json({ error: "request_too_large" }, 413);
    }
    const bodyText = await req.text();
    if (new TextEncoder().encode(bodyText).byteLength > MAX_REQUEST_BYTES) {
      return json({ error: "request_too_large" }, 413);
    }

    let input: any;
    try {
      input = JSON.parse(bodyText);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const method = String(input?.method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) return json({ error: "resource_method_not_allowed" }, 405);

    const policy = requiredPolicy();
    const url = parseResourceUrl(input?.resource_url, policy.allowedHosts);
    const suppliedSignature = typeof input?.payment_signature === "string" ? input.payment_signature.trim() : "";
    if (suppliedSignature.length > MAX_PAYMENT_HEADER_BYTES) {
      return json({ error: "payment_signature_too_large" }, 413);
    }

    // Always fetch the unpaid resource first. This binds every supplied payment
    // signature to current payment requirements instead of trusting client claims.
    const unpaid = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (unpaid.status >= 300 && unpaid.status < 400) {
      return json({ error: "resource_redirect_blocked" }, 502);
    }

    const unpaidBytes = await readLimited(unpaid);
    if (unpaid.status !== 402) {
      audit({ user_id: userData.user.id, host: url.hostname, state: "resource_fetched", status: unpaid.status });
      return new Response(unpaidBytes, {
        status: unpaid.status,
        headers: {
          "cache-control": "no-store",
          "content-type": unpaid.headers.get("content-type") || "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const unpaidText = new TextDecoder().decode(unpaidBytes);
    const paymentRequired = decodePaymentRequired(unpaid, unpaidText);
    if (!paymentRequired) {
      audit({ user_id: userData.user.id, host: url.hostname, state: "payment_terms_unparseable" });
      return json({ error: "x402_payment_terms_unparseable" }, 502);
    }
    const accepts = safeAccepts(paymentRequired, policy);
    if (accepts.length === 0) {
      audit({ user_id: userData.user.id, host: url.hostname, state: "payment_terms_rejected" });
      return json({ error: "x402_payment_terms_outside_policy" }, 403);
    }

    if (!suppliedSignature) {
      audit({
        user_id: userData.user.id,
        host: url.hostname,
        state: "payment_required",
        accepted_options: accepts.length,
      });
      // Return only the payment options that pass ArbiVault's allowlists and caps.
      return json({
        x402Version: paymentRequired.x402Version ?? 2,
        resource: url.origin + url.pathname,
        accepts,
        message: "Payment authorization required. Sign only one of these approved options, then retry with payment_signature.",
      }, 402);
    }

    try {
      validatePaymentSignature(suppliedSignature, accepts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "x402_payment_signature_invalid";
      audit({ user_id: userData.user.id, host: url.hostname, state: "payment_signature_rejected", reason });
      return json({ error: reason }, 403);
    }

    const paid = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json, text/plain, */*",
        "PAYMENT-SIGNATURE": suppliedSignature,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (paid.status >= 300 && paid.status < 400) {
      return json({ error: "resource_redirect_blocked" }, 502);
    }
    const paidBytes = await readLimited(paid);
    if (paid.status === 402) {
      audit({ user_id: userData.user.id, host: url.hostname, state: "payment_rejected" });
      return json({ error: "x402_payment_rejected_or_unsettled" }, 402);
    }

    const paymentResponse = paid.headers.get("PAYMENT-RESPONSE");
    audit({
      user_id: userData.user.id,
      host: url.hostname,
      state: paid.ok ? "resource_fetched_after_payment" : "resource_returned_error_after_payment",
      status: paid.status,
      payment_response_present: Boolean(paymentResponse),
    });
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": paid.headers.get("content-type") || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    if (paymentResponse) headers.set("PAYMENT-RESPONSE", paymentResponse);
    return new Response(paidBytes, { status: paid.status, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "x402_resource_request_failed";
    const safeErrors = new Set([
      "x402_policy_not_configured",
      "x402_amount_policy_invalid_json",
      "resource_url_invalid",
      "resource_host_not_allowlisted",
      "x402_payment_required_header_invalid",
      "x402_resource_response_too_large",
    ]);
    audit({ state: "failed", error: safeErrors.has(message) ? message : "x402_resource_request_failed" });
    const status = message === "x402_policy_not_configured" ? 503
      : message === "resource_host_not_allowlisted" ? 403
      : message === "resource_url_invalid" ? 400
      : 502;
    return json({ error: safeErrors.has(message) ? message : "x402_resource_request_failed" }, status);
  }
});
