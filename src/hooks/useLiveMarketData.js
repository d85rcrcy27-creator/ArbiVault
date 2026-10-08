import { useState, useEffect, useCallback } from 'react'
import { listTrades } from '@/lib/arbivault'
import { supabase } from '@/lib/supabase'

const EMPTY_ROUTES = []
const DEFAULT_MARKET_CONTROLS = {
  pollMs: 5000,
  minSpreadPct: 0.5,
  maxRoutes: 12,
}

function loadMarketControls() {
  try {
    const saved = JSON.parse(localStorage.getItem('arbivault.market_controls') || '{}')
    return {
      pollMs: Number(saved.pollMs) >= 2000 ? Number(saved.pollMs) : DEFAULT_MARKET_CONTROLS.pollMs,
      minSpreadPct: Number(saved.minSpreadPct) >= 0.05 ? Number(saved.minSpreadPct) : DEFAULT_MARKET_CONTROLS.minSpreadPct,
      maxRoutes: Number(saved.maxRoutes) >= 1 ? Number(saved.maxRoutes) : DEFAULT_MARKET_CONTROLS.maxRoutes,
    }
  } catch {
    return DEFAULT_MARKET_CONTROLS
  }
}

export const PAIRS = [
  { symbol: 'BTC', label: 'BTC/USDT' },
  { symbol: 'ETH', label: 'ETH/USDT' },
  { symbol: 'SOL', label: 'SOL/USDT' },
  { symbol: 'XRP', label: 'XRP/USDT' },
  { symbol: 'ADA', label: 'ADA/USDT' },
  { symbol: 'AVAX', label: 'AVAX/USDT' },
  { symbol: 'LINK', label: 'LINK/USDT' },
  { symbol: 'DOGE', label: 'DOGE/USDT' },
]

function normalizeTrade(row) {
  return {
    id: row.id,
    txid: row.tx_hash || null,
    pair: row.pair || '—',
    buyExchange: row.metadata?.buyExchange || '—',
    sellExchange: row.metadata?.sellExchange || '—',
    spreadPct: Number(row.metadata?.spreadPct || 0),
    pnl: Number(row.net_profit || 0),
    ts: new Date(row.created_at).getTime(),
    strategy: row.strategy || 'Unknown',
    executionMode: row.execution_mode,
  }
}

export function useLiveMarketData() {
  const [routes, setRoutes] = useState(EMPTY_ROUTES)
  const [marketSnapshot, setMarketSnapshot] = useState([])
  const [trades, setTrades] = useState([])
  const [engineStatus, setEngineStatus] = useState('ACTIVE')
  const [status, setStatus] = useState('connecting')
  const [connected, setConnected] = useState({ binance: false, bybit: false, okx: false, kraken: false, kucoin: false, gateio: false })
  const [globalLatency, setGlobalLatency] = useState(0)
  const [marketControls, setMarketControlsState] = useState(loadMarketControls)

  useEffect(() => {
    let active = true
    listTrades(100).then((rows) => {
      if (active) setTrades(rows.map(normalizeTrade))
    }).catch(() => {})
    return () => { active = false }
  }, [])

  const setMarketControls = useCallback((updates) => {
    setMarketControlsState((prev) => {
      const next = { ...prev, ...updates }
      try { localStorage.setItem('arbivault.market_controls', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const loadMarket = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('arbivault-market-scout', {
        body: { qualifying_spread_pct: marketControls.minSpreadPct },
      })
      if (error) throw error
      const nextRoutes = Array.isArray(data?.routes)
        ? data.routes.slice().sort((a, b) => Number(b.spreadPct || 0) - Number(a.spreadPct || 0)).slice(0, marketControls.maxRoutes)
        : []
      const nextSnapshot = Array.isArray(data?.market_snapshot)
        ? data.market_snapshot
        : []
      setRoutes(nextRoutes)
      setMarketSnapshot(nextSnapshot)
      setGlobalLatency(Number(data?.latency_ms) || 0)
      setConnected({
        binance: Array.isArray(data?.feeds) && data.feeds.includes('binance'),
        bybit: Array.isArray(data?.feeds) && data.feeds.includes('bybit'),
        okx: Array.isArray(data?.feeds) && data.feeds.includes('okx'),
        kraken: Array.isArray(data?.feeds) && data.feeds.includes('kraken'),
        kucoin: Array.isArray(data?.feeds) && data.feeds.includes('kucoin'),
        gateio: Array.isArray(data?.feeds) && data.feeds.includes('gateio'),
      })
      setStatus('live')
    } catch {
      setConnected({ binance: false, bybit: false, okx: false, kraken: false, kucoin: false, gateio: false })
      setGlobalLatency(0)
      setMarketSnapshot([])
      setStatus('degraded')
    }
  }, [marketControls.minSpreadPct, marketControls.maxRoutes])

  useEffect(() => {
    loadMarket()
    const id = setInterval(loadMarket, marketControls.pollMs)
    return () => clearInterval(id)
  }, [loadMarket])


  // No browser-generated prices, spreads, volumes, latency, P/L, or fake fills.
  // Live opportunities must come from the server-side market/RPC adapters.
  const executeRoute = useCallback(async () => {
    throw new Error('Browser execution is disabled; use the server-side execution bot')
  }, [])

  const sessionPnL = +trades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2)

  return { routes, marketSnapshot, trades, globalLatency, sessionPnL, executeRoute, status, connected, engineStatus, setEngineStatus, marketControls, setMarketControls, refreshMarket: loadMarket }
}
