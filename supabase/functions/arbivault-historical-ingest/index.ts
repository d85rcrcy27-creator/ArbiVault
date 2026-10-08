import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DATASET_KEY = "crypto_cross_venue_2024_2025";
const START = Date.parse("2024-01-01T00:00:00Z");
const END = Date.parse("2025-12-31T23:59:59Z");
const ASSETS = [
  { symbol: "BTC/USD", binance: "BTCUSDT", coinbase: "BTC-USD" },
  { symbol: "ETH/USD", binance: "ETHUSDT", coinbase: "ETH-USD" },
  { symbol: "SOL/USD", binance: "SOLUSDT", coinbase: "SOL-USD" },
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

async function binanceDaily(symbol: string) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${START}&endTime=${END}&limit=1000`;
  const rows = await fetchJson(url);
  return (rows || []).map((row: any[]) => ({
    ts: Number(row[0]),
    close: Number(row[4]),
    volume: Number(row[7]),
  })).filter((r: any) => Number.isFinite(r.close));
}

async function coinbaseDaily(product: string) {
  const out: any[] = [];
  const DAY = 86400000;
  let cursor = START;
  while (cursor <= END) {
    const windowEnd = Math.min(END, cursor + 249 * DAY + (DAY - 1));
    const startIso = new Date(cursor).toISOString();
    const endIso = new Date(windowEnd).toISOString();
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
    const rows = await fetchJson(url);
    for (const row of rows || []) {
      const ts = Number(row[0]) * 1000;
      const close = Number(row[4]);
      const volume = Number(row[5]);
      if (Number.isFinite(close)) out.push({ ts, close, volume });
    }
    cursor = windowEnd + 1;
  }
  return out;
}

function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function upsertBatched(rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin
      .from("strategy_training_observations")
      .upsert(rows.slice(i, i + 500), {
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
      const [binance, coinbase] = await Promise.all([
        binanceDaily(asset.binance),
        coinbaseDaily(asset.coinbase),
      ]);

      const b = new Map(binance.map((r: any) => [dayKey(r.ts), r]));
      const c = new Map(coinbase.map((r: any) => [dayKey(r.ts), r]));

      const raw: any[] = [];
      for (const r of binance) {
        raw.push({
          dataset_id: dataset.id,
          source_key: "binance_historical",
          symbol: asset.symbol,
          metric: "daily_close_usd",
          value: r.close,
          observed_at: new Date(r.ts).toISOString(),
          metadata: { venue: "binance", interval: "1d", volume_quote: r.volume },
        });
      }
      for (const r of coinbase) {
        raw.push({
          dataset_id: dataset.id,
          source_key: "coinbase_historical",
          symbol: asset.symbol,
          metric: "daily_close_usd",
          value: r.close,
          observed_at: new Date(r.ts).toISOString(),
          metadata: { venue: "coinbase", interval: "1d", volume_base: r.volume },
        });
      }

      const sharedDays = [...b.keys()].filter((d) => c.has(d)).sort();
      const spreads = sharedDays.map((d) => {
        const bp = b.get(d)!.close;
        const cp = c.get(d)!.close;
        const buy = bp <= cp ? "binance" : "coinbase";
        const sell = bp <= cp ? "coinbase" : "binance";
        const low = Math.min(bp, cp);
        const high = Math.max(bp, cp);
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
            binance_close: bp,
            coinbase_close: cp,
            methodology: "aligned_daily_close",
          },
        };
      });

      await upsertBatched([...raw, ...spreads]);
      inserted += raw.length + spreads.length;
      summaries.push({
        symbol: asset.symbol,
        binance_days: binance.length,
        coinbase_days: coinbase.length,
        shared_days: sharedDays.length,
        spread_samples: spreads.length,
      });
    }

    await admin
      .from("strategy_training_datasets")
      .update({ last_ingested_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", dataset.id);

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
    return Response.json(
      { error: error instanceof Error ? error.message : "historical_ingest_error" },
      { status: 500 },
    );
  }
});