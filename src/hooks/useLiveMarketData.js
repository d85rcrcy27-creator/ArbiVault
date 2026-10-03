import { useState, useEffect, useCallback } from 'react'
import { listTrades } from '@/lib/arbivault'

const EMPTY_ROUTES = []
const TICK_MS = 1000

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
  const [trades, setTrades] = useState([])
  const [engineStatus, setEngineStatus] = useState('ACTIVE')
  const [status, setStatus] = useState('connecting')
  const [connected, setConnected] = useState({ binance: false, bybit: false, okx: false })

  useEffect(() => {
    let active = true
    listTrades(100).then((rows) => {
      if (active) setTrades(rows.map(normalizeTrade))
    }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      setStatus((current) => current === 'live' ? current : 'live')
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  // No browser-generated prices, spreads, volumes, latency, P/L, or fake fills.
  // Live opportunities must come from the server-side market/RPC adapters.
  const executeRoute = useCallback(async () => {
    throw new Error('Browser execution is disabled; use the server-side execution bot')
  }, [])

  const globalLatency = 0
  const sessionPnL = +trades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2)

  return { routes, trades, globalLatency, sessionPnL, executeRoute, status, connected, engineStatus, setEngineStatus }
}
