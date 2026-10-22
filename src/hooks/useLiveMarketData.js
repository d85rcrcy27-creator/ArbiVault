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
  { symbol: 'BNB', label: 'BNB/USDT' },
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
    pnl: row.net_profit === null || row.net_profit === undefined || row.metadata?.pnl_basis === 'realized_only' && row.net_profit === null ? null : Number(row.net_profit),
    ts: new Date(row.created_at).getTime(),
    strategy: row.strategy || 'Unknown',
    executionMode: row.execution_mode,
    status: row.status,
  }
}

export function useLiveMarketData() {
  const [routes, setRoutes] = useState(EMPTY_ROUTES)
  const [marketSnapshot, setMarketSnapshot] = useState([])
  const [chainRpcHealth, setChainRpcHealth] = useState([])
  const [signerHealth, setSignerHealth] = useState([])
  const [testnetHealth, setTestnetHealth] = useState(null)
  const [trades, setTrades] = useState([])
  const [engineStatus, setEngineStatus] = useState('UNKNOWN')
  const [engineStatusDetail, setEngineStatusDetail] = useState('Reading server-side execution status…')
  const [status, setStatus] = useState('connecting')
  const [connected, setConnected] = useState({ binance: false, bybit: false, okx: false, kraken: false, kucoin: false, gateio: false })
  const [globalLatency, setGlobalLatency] = useState(0)
  const [marketControls, setMarketControlsState] = useState(loadMarketControls)

  const refreshTrades = useCallback(async () => {
    try {
      const rows = await listTrades(100)
      setTrades(rows.map(normalizeTrade))
    } catch {}
  }, [])

  useEffect(() => {
    refreshTrades().catch(() => {})
  }, [refreshTrades])

  const loadTestnetHealth = useCallback(async () => {
    const { data: { user } = {} } = await supabase.auth.getUser()
    if (!user) {
      setTestnetHealth(null)
      return
    }
    const { data, error } = await supabase
      .from('bot_execution_runs')
      .select('started_at,output')
      .eq('owner_id', user.id)
      .eq('workflow', 'execution')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    const diagnostic = data?.output?.controls?.testnet_backend_diagnostic
    setTestnetHealth(diagnostic ? { ...diagnostic, recorded_at: data.started_at } : null)
  }, [])

  useEffect(() => {
    const refresh = () => loadTestnetHealth().catch(() => {
      setTestnetHealth({ ok: false, reason: 'testnet_diagnostic_read_failed' })
    })
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => clearInterval(timer)
  }, [loadTestnetHealth])

  const setMarketControls = useCallback((updates) => {
    setMarketControlsState((prev) => {
      const next = { ...prev, ...updates }
      try { localStorage.setItem('arbivault.market_controls', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const refreshExecutionStatus = useCallback(async () => {
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError || !authData?.user?.id) throw new Error('Sign in to read execution status')

      const { data: routeResponse, error: routeError } = await supabase.functions.invoke('arbivault-route-control', {
        body: { action: 'list' },
      })
      if (routeError) throw routeError
      if (!routeResponse?.ok) throw new Error(routeResponse?.error || 'Route status unavailable')

      const strategy = routeResponse.strategy || null
      const routes = Array.isArray(routeResponse.routes) ? routeResponse.routes : []
      const routeIds = routes.map((route) => route.id).filter(Boolean)
      let attempts = []
      if (routeIds.length) {
        const { data, error } = await supabase
          .from('execution_attempts')
          .select('id,execution_route_id,status,tx_hash,failure_reason,created_at,broadcast_at,confirmed_at')
          .eq('owner_id', authData.user.id)
          .eq('execution_mode', 'on_chain')
          .in('execution_route_id', routeIds)
          .order('created_at', { ascending: false })
          .limit(100)
        if (error) throw error
        attempts = data || []
      }

      const { data: runs, error: runError } = await supabase
        .from('bot_execution_runs')
        .select('started_at,completed_at,status,output,error')
        .eq('owner_id', authData.user.id)
        .eq('workflow', 'execution')
        .order('started_at', { ascending: false })
        .limit(1)
      if (runError) throw runError
      const latestRun = runs?.[0] || null

      const strategyActive = strategy?.enabled === true &&
        strategy?.execution_enabled === true &&
        strategy?.flash_loan_enabled === true
      const activeRoute = strategyActive
        ? routes.find((route) => route.enabled === true &&
          route.discovery_only !== true &&
          route.builder_enabled === true)
        : null

      if (!strategy) {
        setEngineStatus('NO ROUTE')
        setEngineStatusDetail('No flash-loan route is configured for this account.')
        return
      }

      if (!strategyActive) {
        setEngineStatus('PAUSED')
        setEngineStatusDetail('The server-side flash-loan strategy is paused. Market quotes may still be visible; they do not indicate trading.')
        return
      }

      if (!activeRoute) {
        setEngineStatus('NO ROUTE')
        setEngineStatusDetail('The strategy is enabled, but no execution route is armed.')
        return
      }

      const latestAttempt = attempts.find((attempt) => attempt.execution_route_id === activeRoute.id)
      if (latestAttempt?.tx_hash && latestAttempt.status === 'broadcast') {
        setEngineStatus('BROADCAST')
        setEngineStatusDetail(`${activeRoute.chain.toUpperCase()} ${activeRoute.pair}: transaction hash recorded; waiting for chain confirmation.`)
        return
      }
      if (latestAttempt?.tx_hash && latestAttempt.status === 'confirmed') {
        setEngineStatus('LAST TX CONFIRMED')
        setEngineStatusDetail(`${activeRoute.chain.toUpperCase()} ${activeRoute.pair}: last recorded transaction has a confirmed status. This is history, not a claim a new trade is running.`)
        return
      }
      if (latestAttempt?.tx_hash) {
        setEngineStatus('TX HASH RECORDED')
        setEngineStatusDetail(`${activeRoute.chain.toUpperCase()} ${activeRoute.pair}: transaction hash exists with status ${latestAttempt.status || 'unknown'}; check the explorer for the latest chain state.`)
        return
      }

      const runAgeMs = latestRun?.started_at ? Date.now() - new Date(latestRun.started_at).getTime() : Infinity
      const results = Array.isArray(latestRun?.output?.results) ? latestRun.output.results : []
      let opportunity = null
      for (const result of results) {
        const found = (Array.isArray(result?.opportunities) ? result.opportunities : [])
          .find((item) => item?.execution_route_id === activeRoute.id)
        if (found) {
          opportunity = found
          break
        }
      }

      if (opportunity?.broadcast === 'awaiting_authorized_signing' ||
          opportunity?.signing === 'pending_human_authorization') {
        setEngineStatus('WAITING SIGNER')
        setEngineStatusDetail('The worker prepared a candidate but no transaction has been broadcast. This is not a live trade.')
        return
      }

      const blocker = opportunity?.execution_gate && opportunity.execution_gate !== 'eligible'
        ? opportunity.execution_gate
        : activeRoute.builder_status && activeRoute.builder_status !== 'ready_for_explicit_preflight'
          ? activeRoute.builder_status
          : null
      if (blocker) {
        setEngineStatus('BLOCKED')
        setEngineStatusDetail(`${activeRoute.chain.toUpperCase()} ${activeRoute.pair}: ${String(blocker).replace(/_/g, ' ')}. No live transaction was confirmed.`)
        return
      }

      if (!Number.isFinite(runAgeMs) || runAgeMs > 90000) {
        setEngineStatus('WORKER STALE')
        setEngineStatusDetail(`Route is armed, but no recent worker heartbeat is visible${latestRun?.started_at ? ` (last seen ${new Date(latestRun.started_at).toLocaleTimeString()})` : ''}. No live trade is confirmed.`)
        return
      }

      setEngineStatus('ARMED')
      setEngineStatusDetail(`${activeRoute.chain.toUpperCase()} ${activeRoute.pair} is selected. The worker is checking live quotes and preflight; no transaction hash means no live trade yet.`)
    } catch (error) {
      setEngineStatus('UNKNOWN')
      setEngineStatusDetail(error instanceof Error ? error.message : 'Unable to read server-side execution status.')
    }
  }, [])

  useEffect(() => {
    refreshExecutionStatus()
    const timer = window.setInterval(refreshExecutionStatus, 10000)
    return () => window.clearInterval(timer)
  }, [refreshExecutionStatus])

  const loadMarket = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('arbivault-market-scout', {
        body: {},
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
      setChainRpcHealth(Array.isArray(data?.chain_rpc_health) ? data.chain_rpc_health : [])
      setSignerHealth(Array.isArray(data?.signer_health) ? data.signer_health : [])
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
      setChainRpcHealth([])
      setSignerHealth([])
      setStatus('degraded')
    }
  }, [marketControls.minSpreadPct, marketControls.maxRoutes])

  useEffect(() => {
    loadMarket()
    refreshTrades()
    const marketId = setInterval(loadMarket, marketControls.pollMs)
    const tradeId = setInterval(refreshTrades, 3000)
    return () => { clearInterval(marketId); clearInterval(tradeId) }
  }, [loadMarket, refreshTrades, marketControls.pollMs])


  // No browser-generated prices, spreads, volumes, latency, P/L, or fake fills.
  // Live opportunities must come from the server-side market/RPC adapters.
  const executeRoute = useCallback(async () => {
    throw new Error('Browser execution is disabled; use the server-side execution bot')
  }, [])

  // Only confirmed live trades with independently recorded P&L contribute to the total.
  const pnlVerifiedTrades = trades.filter((trade) =>
    trade.status === 'executed' &&
    trade.executionMode === 'on_chain' &&
    !!trade.txid &&
    Number.isFinite(trade.pnl)
  )
  const livePnl = pnlVerifiedTrades.length
    ? Number(pnlVerifiedTrades.reduce((sum, trade) => sum + trade.pnl, 0).toFixed(2))
    : null

  return { routes, marketSnapshot, chainRpcHealth, signerHealth, testnetHealth, trades, globalLatency, livePnl, executeRoute, status, connected, engineStatus, engineStatusDetail, marketControls, setMarketControls, refreshMarket: loadMarket }
}
