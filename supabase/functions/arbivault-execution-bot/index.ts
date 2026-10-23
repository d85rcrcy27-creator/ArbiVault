// Retired by the flash-loan-only strategy migration.
// No trades, wallet changes, synchronization, or payments are performed here.
Deno.serve(async (_req: Request) => {
  return Response.json(
    {
      ok: false,
      retired: true,
      error: "bot_retired",
      replacement: "arbivault-flash-loan-strategy",
      side_effects_performed: false,
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
});
