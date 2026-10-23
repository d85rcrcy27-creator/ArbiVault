import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ALLOWED_ORIGINS = new Set([
  "https://arbivault.vercel.app",
  "https://www.arbivault.vercel.app",
  "https://arbivault-kh6lktmz-kingalpha.vercel.app",
]);

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://arbivault.vercel.app";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, origin);
  }

  // Supabase platform JWT verification is enabled for this function. Also verify
  // the bearer belongs to a real signed-in user before using privileged credentials.
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: "unauthorized" }, 401, origin);

  const { data: userData, error: userError } = await supabase.auth.getUser(match[1]);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401, origin);

  try {
    // Retrieve the existing backend-only cron token; never return or log it.
    const { data: cronToken, error: tokenError } = await supabase.rpc("get_bot_cron_token");
    if (tokenError || typeof cronToken !== "string" || cronToken.length < 16) {
      return json({ error: "diagnostic_authorization_unavailable" }, 503, origin);
    }

    // Hard-code diagnostic mode. No caller-supplied mode or transaction payload
    // is forwarded to the transaction builder.
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/arbivault-transaction-builder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "apikey": SERVICE_ROLE_KEY,
          "authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "x-arbivault-cron-token": cronToken,
        },
        body: JSON.stringify({ mode: "diagnostic" }),
        signal: AbortSignal.timeout(25000),
      },
    );

    const raw = await response.json().catch(() => null);
    if (!response.ok || !raw || typeof raw !== "object") {
      return json({
        error: "diagnostic_backend_failed",
        upstream_status: response.status,
      }, 502, origin);
    }

    // Minimize cross-account metadata in the response.
    const result = structuredClone(raw) as Record<string, unknown>;
    const scrub = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(scrub);
        return;
      }
      const obj = value as Record<string, unknown>;
      delete obj.matched_generated_wallet_owner_id;
      delete obj.matched_generated_wallet_id;
      for (const child of Object.values(obj)) scrub(child);
    };
    scrub(result);

    return json({ ok: true, authenticated: true, diagnostic: result }, 200, origin);
  } catch {
    // Do not echo tokens, upstream bodies, or internal exceptions.
    return json({ error: "diagnostic_request_failed" }, 502, origin);
  }
});
