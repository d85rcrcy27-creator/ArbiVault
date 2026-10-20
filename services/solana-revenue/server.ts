import express from "express";
import rateLimit from "express-rate-limit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { address, generateKeyPair, getAddressFromPublicKey } from "@solana/kit";
import { createMerchantClient } from "@solana/pay";
import { randomUUID } from "node:crypto";

type Invoice = {
  id: string;
  product_id: "premium_opportunity_report";
  reference_address: string;
  treasury_address: string;
  expected_lamports: number | string;
  status: "pending" | "paid" | "expired" | "refunded";
  tx_signature: string | null;
  report_snapshot: unknown[];
  expires_at: string;
  verified_at: string | null;
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb", strict: true }));
app.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));

function config() {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  const treasuryText = process.env.SOLANA_TREASURY_ADDRESS?.trim();
  const priceText = process.env.SOLANA_REPORT_PRICE_LAMPORTS?.trim();
  const network = process.env.SOLANA_NETWORK?.trim();
  const ttl = Number(process.env.SOLANA_INVOICE_TTL_SECONDS ?? "900");
  if (!url || !serviceKey || !rpcUrl || !treasuryText || !priceText) throw new Error("Revenue service is not configured");
  if (network !== "mainnet-beta") throw new Error("SOLANA_NETWORK must be mainnet-beta for this service");
  if (!/^\d+$/.test(priceText) || BigInt(priceText) <= 0n || BigInt(priceText) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("SOLANA_REPORT_PRICE_LAMPORTS must be a positive integer");
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new Error("SOLANA_INVOICE_TTL_SECONDS must be 60..3600");
  const treasury = address(treasuryText);
  const lamports = Number(priceText);
  const amountSol = lamports / 1_000_000_000;
  if (!Number.isFinite(amountSol) || amountSol <= 0) throw new Error("Invalid SOL price");
  return { url, serviceKey, rpcUrl, treasury, lamports, amountSol, ttl };
}

function clients() {
  const cfg = config();
  const db = createClient(cfg.url, cfg.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Application-Name": "ArbiVault-Solana-Revenue" } },
  });
  const merchant = createMerchantClient({ rpcUrl: cfg.rpcUrl });
  return { cfg, db, merchant };
}

function safeError(res: express.Response, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message === "Revenue service is not configured" || message.startsWith("SOLANA_")) {
    return res.status(503).json({ error: "Revenue service is not ready" });
  }
  // Do not expose database, RPC, or SDK internals to clients.
  return res.status(500).json({ error: "Request could not be completed" });
}

async function loadRealReport(db: SupabaseClient) {
  const { data, error } = await db
    .from("opportunities")
    .select("title,description,opportunity_type,score,discovered_at,source_url,expected_duration_minutes,payment_speed")
    .eq("compliance_status", "eligible")
    .order("discovered_at", { ascending: false })
    .limit(10);
  if (error) throw new Error("Could not load source report");
  if (!data || data.length === 0) throw new Error("No eligible report data");
  return data;
}

app.get("/health", (_req, res) => {
  try {
    config();
    return res.json({ ok: true, configured: true, network: "mainnet-beta", product: "premium_opportunity_report" });
  } catch {
    return res.status(503).json({ ok: false, configured: false });
  }
});

app.post("/invoices", async (_req, res) => {
  try {
    const { cfg, db, merchant } = clients();
    let reportSnapshot: unknown[];
    try {
      reportSnapshot = await loadRealReport(db);
    } catch {
      return res.status(503).json({ error: "A current eligible report is unavailable; no invoice was created" });
    }

    // Only the public key is used as a unique reference. No wallet signer is created or retained.
    const referenceKeyPair = await generateKeyPair();
    const reference = await getAddressFromPublicKey(referenceKeyPair.publicKey);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + cfg.ttl * 1000).toISOString();
    const { data: inserted, error: insertError } = await db
      .from("paid_report_invoices")
      .insert({
        id,
        product_id: "premium_opportunity_report",
        reference_address: reference,
        treasury_address: cfg.treasury,
        expected_lamports: String(cfg.lamports),
        status: "pending",
        report_snapshot: reportSnapshot,
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (insertError || !inserted) throw new Error("Could not create invoice");

    const paymentUrl = merchant.pay.encodeURL({
      recipient: cfg.treasury,
      amount: cfg.amountSol,
      reference,
      label: "ArbiVault",
      message: "Premium opportunity report",
      memo: id,
    }).toString();

    const { error: updateError } = await db
      .from("paid_report_invoices")
      .update({ payment_url: paymentUrl })
      .eq("id", id)
      .eq("status", "pending");
    if (updateError) throw new Error("Could not save invoice URL");

    return res.status(201).json({
      invoiceId: id,
      product: "premium_opportunity_report",
      network: "mainnet-beta",
      asset: "SOL",
      amountLamports: cfg.lamports,
      amountSOL: cfg.amountSol.toFixed(9),
      recipient: cfg.treasury,
      expiresAt,
      paymentUrl,
      instructions: "Pay the exact amount to the displayed recipient. Then submit the transaction signature to POST /verify.",
    });
  } catch (error) {
    return safeError(res, error);
  }
});

app.post("/verify", async (req, res) => {
  const invoiceId = typeof req.body?.invoiceId === "string" ? req.body.invoiceId : "";
  const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId) || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) {
    return res.status(400).json({ error: "Valid invoiceId and transaction signature are required" });
  }

  try {
    const { cfg, db, merchant } = clients();
    const { data: invoice, error: invoiceError } = await db
      .from("paid_report_invoices")
      .select("*")
      .eq("id", invoiceId)
      .maybeSingle();
    if (invoiceError || !invoice) return res.status(404).json({ error: "Invoice not found" });
    const row = invoice as Invoice;

    if (row.status === "paid") {
      if (row.tx_signature === signature) return res.json({ verified: true, invoiceId, signature, idempotent: true });
      return res.status(409).json({ error: "Invoice has already been paid with another transaction" });
    }
    if (row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) {
      if (row.status === "pending") await db.from("paid_report_invoices").update({ status: "expired" }).eq("id", invoiceId).eq("status", "pending");
      return res.status(410).json({ error: "Invoice is no longer payable" });
    }
    if (row.treasury_address !== cfg.treasury) return res.status(409).json({ error: "Invoice recipient does not match configured treasury" });

    const reference = address(row.reference_address);
    // A reference lookup alone is insufficient; validateTransfer also checks the recipient,
    // exact SOL amount, reference, and successful transaction.
    const found = await merchant.pay.findReference(reference);
    if (found.signature !== signature) return res.status(400).json({ error: "Transaction does not match this invoice reference" });
    await merchant.pay.validateTransfer(signature, {
      recipient: cfg.treasury,
      amount: cfg.amountSol,
      reference,
    });

    const { data: updated, error: updateError } = await db
      .from("paid_report_invoices")
      .update({ status: "paid", tx_signature: signature, verified_at: new Date().toISOString() })
      .eq("id", invoiceId)
      .eq("status", "pending")
      .is("tx_signature", null)
      .select("id")
      .maybeSingle();

    if (updateError) {
      if (updateError.code === "23505") return res.status(409).json({ error: "Transaction signature has already been consumed" });
      throw new Error("Could not record verified payment");
    }
    if (!updated) return res.status(409).json({ error: "Invoice changed during verification; reload its status" });

    return res.json({ verified: true, invoiceId, signature, network: "mainnet-beta", asset: "SOL", recipient: cfg.treasury });
  } catch {
    return res.status(400).json({ error: "Payment could not be verified for this invoice" });
  }
});

app.get("/report/:invoiceId", async (req, res) => {
  const invoiceId = req.params.invoiceId;
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) return res.status(400).json({ error: "Invalid invoice ID" });
  try {
    const { db } = clients();
    const { data, error } = await db
      .from("paid_report_invoices")
      .select("id,status,report_snapshot,verified_at,tx_signature")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error) throw new Error("Could not read report");
    if (!data) return res.status(404).json({ error: "Report not found" });
    if (data.status !== "paid" || !data.verified_at || !data.tx_signature) return res.status(402).json({ error: "Payment required" });
    return res.json({
      product: "premium_opportunity_report",
      verifiedAt: data.verified_at,
      transactionSignature: data.tx_signature,
      records: data.report_snapshot,
      disclaimer: "This report reflects source records at invoice creation time. It is not investment advice or a guarantee of profit or execution.",
    });
  } catch (error) {
    return safeError(res, error);
  }
});

if (process.env.VERCEL !== "1" && process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? "4567");
  app.listen(port, "127.0.0.1", () => {
    console.log(`ArbiVault native SOL revenue API listening on http://127.0.0.1:${port}`);
  });
}

export default app;
