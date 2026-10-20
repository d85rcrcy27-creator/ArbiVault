import test from "node:test";
import assert from "node:assert/strict";
import app from "../server.js";

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health fails closed when production configuration is absent", async () => {
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SOLANA_RPC_URL",
    "SOLANA_TREASURY_ADDRESS",
    "SOLANA_REPORT_PRICE_LAMPORTS",
  ]) delete process.env[key];
  delete process.env.SOLANA_NETWORK;

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, configured: false });
  });
});

test("invoice creation refuses to run when treasury/payment configuration is absent", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_TREASURY_ADDRESS;
  delete process.env.SOLANA_REPORT_PRICE_LAMPORTS;
  delete process.env.SOLANA_NETWORK;

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/invoices`, { method: "POST" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Revenue service is not ready" });
  });
});
