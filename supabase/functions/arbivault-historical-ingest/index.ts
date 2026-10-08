import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DATASET_KEY = "crypto_cross_venue_2024_2025";
const START = Date.parse("2024-01-01T00:00:00Z");
const END = Date.parse("2025-12-31T23:59:59Z");
const ASSETS = [
  { symbol: "BTC/USD", coinbase: "BTC-USD", kraken: "XBTUSD" },
  { symbol: "ETH/USD", coinbase: "ETH-USD", kraken: "ETHUSD" },
  { symbol: "SOL/USD", coinbase: "SOL-USD", kraken: "SOLUSD" },
];

async function authorized(req: Request) {
  const token = req.headers.get("x-arbivault-cron-token");
  if (!token) return false;
  const { data } = await admin.rpc("get_bot_cron_token");
  return !!data && token === data;
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`historical_http_${response.status}`);
  return response.json();
}

async function coinbaseDaily(product: string) {
  const out: any[] = [];
  const DAY = 86400000;
  let cursor = START;
  while (cursor <= END) {
    const windowEnd = Math.min(END, cursor + 299 * DAY + (DAY - 1));
    const rows = await fetchJson(
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${encodeURIComponent(new Date(cursor).toISOString())}&end=${encodeURIComponent(new Date(windowEnd).toISOString())}`,
    );
    for (const row of rows || []) {
      const ts = Number(row[0]) * 1000;
      const close = Number(row[4]);
      const volume = Number(row[5]);
      if (Number.isFinite(close)) out.push({ ts, close, volume });
    }
    cursor = windowEnd + 1;
  }
  const unique = new Map<string, { ts: number; close: number; volume: number }>();
  for (const row of out) unique.set(dayKey(row.ts), row);
  return [...unique.values()].sort((a, b) => a.ts - b.ts);
}

async function krakenDaily(pair: string) {
  const out: any[] = [];
  const oneYear = 366 * 86400;
  // Kraken's OHLC endpoint caps rows; two year-sized windows cover 2024-2025.
  for (const since of [START / 1000, Date.parse("2025-01-01T00:00:00Z") / 1000]) {
    const body = await fetchJson(
      `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440&since=${Math.floor(since)}`,
    );
    if (Array.isArray(body?.error) && body.error.length) throw new Error(`kraken_${body.error.join("_")}`);
    const key = Object.keys(body?.result || {}).find((k) => k !== "last");
    for (const row of (key ? body.result[key] : []) || []) {
      const ts = Number(row[0]) * 1000;
      const close = Number(row[4]);
      const volume = Number(row[6]);
      if (ts >= START && ts <= END && Number.isFinite(close)) out.push({ ts, close, volume });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const unique = new Map<string, { ts: number; close: number; volume: number }>();
  for (const row of out) unique.set(dayKey(row.ts), row);
  return [...unique.values()].sort((a, b) => a.ts - b.ts);
}

function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function upsertBatched(rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("strategy_training_observations").upsert(rows.slice(i, i + 500), {
      onConflict: "dataset_id,source_key,symbol,metric,observed_at",
    });
    if (error) throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST" || !(await authorized(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { data: dataset, error: datasetError } = await admin
      .from("strategy_training_datasets")
      .select("id,dataset_key")
      .eq("dataset_key", DATASET_KEY)
      .single();
    if (datasetError || !dataset) {
      return Response.json({ error: datasetError?.message || "dataset_missing" }, { status: 500 });
    }

    let inserted = 0;
    const summaries: any[] = [];

    for (const asset of ASSETS) {
      let coinbase: any[] = [];
      let kraken: any[] = [];
      try {
        [coinbase, kraken] = await Promise.all([
          coinbaseDaily(asset.coinbase),
          krakenDaily(asset.kraken),
        ]);
      } catch (error) {
        console.error("historical_asset_fetch_failed", {
          symbol: asset.symbol,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const c = new Map(coinbase.map((r: any) => [dayKey(r.ts), r]));
      const k = new Map(kraken.map((r: any) => [dayKey(r.ts), r]));

      const raw: any[] = [
        ...coinbase.map((r: any) => ({
          dataset_id: dataset.id,
          source_key: "coinbase_historical",
          symbol: asset.symbol,
          metric: "daily_close_usd",
          value: r.close,
          observed_at: new Date(r.ts).toISOString(),
          metadata: { venue: "coinbase", interval: "1d", volume_base: r.volume },
        })),
        ...kraken.map((r: any) => ({
          dataset_id: dataset.id,
          source_key: "kraken_historical",
          symbol: asset.symbol,
          metric: "daily_close_usd",
          value: r.close,
          observed_at: new Date(r.ts).toISOString(),
          metadata: { venue: "kraken", interval: "1d", volume_base: r.volume },
        })),
      ];

      const sharedDays = [...c.keys()].filter((d) => k.has(d)).sort();
      const spreads = sharedDays.map((d) => {
        const cp = c.get(d)!.close;
        const kp = k.get(d)!.close;
        const buy = cp <= kp ? "coinbase" : "kraken";
        const sell = cp <= kp ? "kraken" : "coinbase";
        const low = Math.min(cp, kp);
        const high = Math.max(cp, kp);
        return {
          dataset_id: dataset.id,
          source_key: "historical_cross_venue",
          symbol: asset.symbol,
          metric: "spread_pct",
          value: ((high - low) / low) * 100,
          observed_at: new Date(`${d}T00:00:00Z`).toISOString(),
          metadata: {
            interval: "1d",
            buy_exchange: buy,
            sell_exchange: sell,
            coinbase_close: cp,
            kraken_close: kp,
            methodology: "aligned_daily_close",
          },
        };
      });

      await upsertBatched([...raw, ...spreads]);
      inserted += raw.length + spreads.length;
      summaries.push({
        symbol: asset.symbol,
        coinbase_days: coinbase.length,
        kraken_days: kraken.length,
        shared_days: sharedDays.length,
        spread_samples: spreads.length,
      });
    }

    await admin.from("strategy_training_datasets").update({
      last_ingested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", dataset.id);

    return Response.json({
      ok: true,
      dataset_key: DATASET_KEY,
      start: "2024-01-01",
      end: "2025-12-31",
      inserted,
      summaries,
      live_feed_tables_untouched: true,
    });
  } catch (error) {
    console.error("historical_ingest_failed", error);
    return Response.json({
      error: error instanceof Error ? error.message : "historical_ingest_error",
    }, { status: 500 });
  }
});