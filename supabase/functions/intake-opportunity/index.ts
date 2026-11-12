import { createClient } from "jsr:@supabase/supabase-js@2";

const TASK_TYPES = [
  "website_audit",
  "seo_analysis",
  "content_generation",
  "competitor_analysis",
  "listing_optimization",
] as const;

type TaskType = (typeof TASK_TYPES)[number];

type Payload = {
  business_name: string;
  industry?: string;
  location?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  website_url?: string;
  contact_source_url: string;
  contact_source_name?: string;
  tech_maturity_score?: number;
  recommended_service: string;
  task_type?: string;
  estimated_value?: number;
  data_source: string;
  analysis_notes?: string;
  is_synthetic_test?: boolean;
};

const jsonHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function badRequest(message: string) {
  return jsonResponse({ error: message }, 400);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeTaskType(value: string): TaskType | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TASK_TYPES.includes(normalized as TaskType) ? normalized as TaskType : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST only" }, 405);
  }

  const secret = Deno.env.get("INTAKE_BOT_SECRET");
  const provided = req.headers.get("x-bot-secret");
  if (!secret) {
    return jsonResponse({ error: "INTAKE_BOT_SECRET not configured" }, 500);
  }
  if (!provided || provided !== secret) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }

  if (!body.business_name?.trim()) return badRequest("business_name is required");
  if (!body.recommended_service?.trim()) return badRequest("recommended_service is required");
  if (!body.data_source?.trim()) return badRequest("data_source is required");
  if (!body.contact_source_url?.trim()) {
    return badRequest("contact_source_url is required for provenance");
  }
  if (!isHttpUrl(body.contact_source_url.trim())) {
    return badRequest("contact_source_url must be an HTTP or HTTPS URL");
  }
  if (body.website_url && !isHttpUrl(body.website_url.trim())) {
    return badRequest("website_url must be an HTTP or HTTPS URL");
  }
  if (!body.contact_email?.trim() && !body.contact_phone?.trim() && !body.website_url?.trim()) {
    return badRequest("at least one public customer contact channel is required");
  }
  if (body.is_synthetic_test === true) {
    return badRequest("synthetic test records are not accepted by the production intake endpoint");
  }
  if (body.tech_maturity_score !== undefined &&
      (typeof body.tech_maturity_score !== "number" ||
       !Number.isFinite(body.tech_maturity_score) ||
       body.tech_maturity_score < 0 ||
       body.tech_maturity_score > 100)) {
    return badRequest("tech_maturity_score must be a number between 0 and 100");
  }
  if (body.estimated_value !== undefined &&
      (typeof body.estimated_value !== "number" ||
       !Number.isFinite(body.estimated_value) ||
       body.estimated_value < 0)) {
    return badRequest("estimated_value must be a finite non-negative number");
  }

  const taskType = normalizeTaskType(body.task_type ?? body.recommended_service);
  if (!taskType) {
    return badRequest("task_type must match one of: " + TASK_TYPES.join(", "));
  }

  const businessName = body.business_name.trim();
  const sourceUrl = body.contact_source_url.trim();
  const dataSource = body.data_source.trim();
  const recommendedService = body.recommended_service.trim();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // The canonical opportunities schema has no business_name or recommended_service columns.
  // Use source_url + title as a best-effort duplicate guard for retried intake requests.
  const { data: existing, error: lookupError } = await supabase
    .from("opportunities")
    .select("id,status")
    .eq("source_url", sourceUrl)
    .eq("title", businessName)
    .maybeSingle();

  if (lookupError) {
    console.error("opportunity_intake_duplicate_check_failed", lookupError.message);
    return jsonResponse({ error: "opportunity lookup failed" }, 500);
  }
  if (existing) {
    return jsonResponse({
      id: existing.id,
      status: existing.status,
      duplicate: true,
      compliance_status: "review",
    });
  }

  const description = [
    "Recommended service: " + recommendedService,
    body.industry?.trim() ? "Industry: " + body.industry.trim() : null,
    body.analysis_notes?.trim() || null,
  ].filter(Boolean).join("\n\n");

  const { data, error } = await supabase
    .from("opportunities")
    .insert({
      owner_id: null,
      source: dataSource,
      source_url: sourceUrl,
      title: businessName,
      description,
      opportunity_type: taskType,
      jurisdiction: body.location?.trim() || null,
      estimated_value: body.estimated_value ?? null,
      compliance_status: "review",
      status: "new",
      contact_name: body.contact_name?.trim() || null,
      contact_email: body.contact_email?.trim() || null,
      contact_phone: body.contact_phone?.trim() || null,
      website_url: body.website_url?.trim() || null,
      contact_source_url: sourceUrl,
      contact_source_name: body.contact_source_name?.trim() || dataSource,
      contact_verified_at: null,
    })
    .select("id,status")
    .single();

  if (error || !data) {
    console.error("opportunity_intake_insert_failed", error?.message ?? "no row returned");
    return jsonResponse({ error: "opportunity insert failed" }, 500);
  }

  const { error: auditError } = await supabase.from("audit_events").insert({
    actor_id: null,
    event_type: "opportunity.intake",
    resource_type: "opportunity",
    resource_id: data.id,
    outcome: "success",
    metadata: {
      data_source: dataSource,
      contact_source_url: sourceUrl,
      task_type: taskType,
      industry: body.industry?.trim() || null,
      tech_maturity_score: body.tech_maturity_score ?? null,
      has_email: !!body.contact_email?.trim(),
      has_phone: !!body.contact_phone?.trim(),
      has_website: !!body.website_url?.trim(),
      data_quality_status: "needs_review",
    },
  });

  if (auditError) {
    console.error("opportunity_intake_audit_failed", auditError.message);
  }

  return jsonResponse({
    id: data.id,
    status: data.status,
    compliance_status: "review",
    duplicate: false,
    audit_event_recorded: !auditError,
  }, 201);
});
