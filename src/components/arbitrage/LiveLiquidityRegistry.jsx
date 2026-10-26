import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'

const DEX_CHAIN_IDS = { ethereum: 'ethereum', bnb: 'bsc', solana: 'solana' }
const tokenPair = (pair) => String(pair || '').split('/').map((v) => v.trim().toUpperCase()).filter(Boolean)
const amount = (value) => {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 8 }) : 'Unavailable'
}
const usd = (value) => {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) : 'Unavailable'
}
async function fetchPairSearch(pair) {
  const symbols = tokenPair(pair.pair)
  if (symbols.length !== 2 || !DEX_CHAIN_IDS[pair.chain] || String(pair.dex_venue || '').toLowerCase() === 'cex') return []
  const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(symbols.join('/')), {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('Pool data provider returned HTTP ' + response.status)
  const body = await response.json()
  const chainId = DEX_CHAIN_IDS[pair.chain]
  return (Array.isArray(body?.pairs) ? body.pairs : [])
    .filter((pool) => {
      if (String(pool?.chainId || '').toLowerCase() !== chainId) return false
      const base = String(pool?.baseToken?.symbol || '').toUpperCase()
      const quote = String(pool?.quoteToken?.symbol || '').toUpperCase()
      return (base === symbols[0] && quote === symbols[1]) || (base === symbols[1] && quote === symbols[0])
    })
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))
    .map((pool) => ({
      id: String(pool.pairAddress || pool.url || pool.dexId + ':' + pool.baseToken?.symbol + ':' + pool.quoteToken?.symbol),
      address: pool.pairAddress || null,
      dex: pool.dexId || 'Unknown DEX',
      baseSymbol: pool.baseToken?.symbol || '—',
      quoteSymbol: pool.quoteToken?.symbol || '—',
      baseReserve: pool.liquidity?.base ?? null,
      quoteReserve: pool.liquidity?.quote ?? null,
      liquidityUsd: pool.liquidity?.usd ?? null,
      priceUsd: pool.priceUsd ?? null,
      url: pool.url || null,
      pairCreatedAt: pool.pairCreatedAt || null,
      dataSource: 'DexScreener public market-data API',
    }))
}
export default function LiveLiquidityRegistry({ routes = [] }) {
  const [poolsByKey, setPoolsByKey] = useState({})
  const [errorsByKey, setErrorsByKey] = useState({})
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(null)
  const poolRoutes = useMemo(() => {
    const unique = new Map()
    routes.forEach((route) => {
      const key = String(route.chain || '') + '|' + String(route.pair || '') + '|' + String(route.dex_venue || '')
      if (!unique.has(key)) unique.set(key, route)
    })
    return [...unique.entries()].map(([key, route]) => ({ key, route }))
  }, [routes])
  const refresh = async () => {
    setLoading(true)
    const nextPools = {}
    const nextErrors = {}
    await Promise.all(poolRoutes.map(async ({ key, route }) => {
      try {
        nextPools[key] = await fetchPairSearch(route)
      } catch (error) {
        nextPools[key] = []
        nextErrors[key] = error instanceof Error ? error.message : 'Pool lookup failed'
      }
    }))
    setPoolsByKey(nextPools)
    setErrorsByKey(nextErrors)
    setUpdatedAt(new Date())
    setLoading(false)
  }
  useEffect(() => { refresh() }, [poolRoutes])
  const totalPools = Object.values(poolsByKey).reduce((n, pools) => n + pools.length, 0)
  return (
    <section className="overflow-hidden rounded border border-[#232738] bg-[#0C0E16]">
      <div className="flex flex-col gap-3 border-b border-[#232738] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Liquidity pairs & atomic-builder route registry</h2>
          <p className="mt-2 text-xs text-[#8a90b0]">Route configuration from Supabase; public DEX pool addresses, reserve-side liquidity, USD liquidity and pair links from live provider responses. Reserves are provider-reported estimates, not a substitute for on-chain state reads.</p>
          <p className="mt-1 text-[10px] text-[#5a6080]">{updatedAt ? 'Pool data refreshed ' + updatedAt.toLocaleTimeString() : 'Pool data not yet refreshed'} · {totalPools} matching pools returned</p>
        </div>
        <button onClick={refresh} disabled={loading} className="inline-flex shrink-0 items-center justify-center gap-2 rounded border border-[#30364b] px-3 py-2 font-mono text-[10px] hover:border-[#00F0FF] disabled:opacity-50"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> REFRESH POOLS</button>
      </div>
      {routes.length === 0 ? <p className="p-6 text-sm text-[#8a90b0]">No route configuration is available.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1550px] text-left text-xs">
            <thead className="bg-[#090A0F] font-mono uppercase text-[#8a90b0]"><tr>{['Chain / pair','Venue / route','Builder registry','Route status','Pool contract / DEX','Reserve base token','Reserve quote token','Liquidity USD','Token price USD','Source / link'].map((h) => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {poolRoutes.map(({ key, route }) => {
                const pools = poolsByKey[key] || []
                const routeStatus = route.enabled && !route.discovery_only ? 'Enabled in registry' : route.discovery_only ? 'Discovery only' : 'Disabled'
                const builderStatus = route.transaction_builder ? (route.builder_enabled ? 'Builder enabled in registry' : 'Builder disabled') : 'No builder assigned'
                const isCex = String(route.dex_venue || '').toLowerCase() === 'cex'
                const rows = pools.length ? pools : [null]
                return rows.map((pool, index) => (
                  <tr key={key + ':' + (pool?.id || 'empty')} className="border-t border-[#232738] align-top">
                    <td className="px-3 py-3"><div className="uppercase">{route.chain || '—'}</div><div className="mt-1 font-mono text-[#00F0FF]">{route.pair || '—'}</div><div className="mt-1 text-[10px] text-[#5a6080]">{route.strategy || route.strategy_family || '—'}</div></td>
                    <td className="px-3 py-3"><div>{route.dex_venue || '—'}</div><div className="mt-1 text-[#8a90b0]">{route.route_type || '—'}</div></td>
                    <td className="px-3 py-3"><div>{route.transaction_builder || '—'}</div><div className={route.builder_enabled ? 'mt-1 text-[#00FF87]' : 'mt-1 text-[#FFB800]'}>{builderStatus}</div></td>
                    <td className="px-3 py-3"><div>{routeStatus}</div><div className="mt-1 text-[#5a6080]">enabled={String(Boolean(route.enabled))}; discovery_only={String(Boolean(route.discovery_only))}</div></td>
                    <td className="px-3 py-3"><div>{pool?.dex || (isCex ? 'CEX route — no on-chain DEX pool' : errorsByKey[key] ? 'Lookup failed' : loading ? 'Loading live pools…' : 'No matching pool returned')}</div><div className="mt-1 max-w-[220px] break-all font-mono text-[10px] text-[#8a90b0]">{pool?.address || 'Pool address unavailable'}</div>{pool?.pairCreatedAt ? <div className="mt-1 text-[10px] text-[#5a6080]">Created {new Date(pool.pairCreatedAt).toLocaleDateString()}</div> : null}</td>
                    <td className="px-3 py-3 font-mono"><div>{pool ? amount(pool.baseReserve) + ' ' + pool.baseSymbol : 'Unavailable'}</div></td>
                    <td className="px-3 py-3 font-mono"><div>{pool ? amount(pool.quoteReserve) + ' ' + pool.quoteSymbol : 'Unavailable'}</div></td>
                    <td className="px-3 py-3 font-mono">{pool ? usd(pool.liquidityUsd) : 'Unavailable'}</td>
                    <td className="px-3 py-3 font-mono">{pool ? usd(pool.priceUsd) : 'Unavailable'}</td>
                    <td className="px-3 py-3">{pool?.url ? <a className="inline-flex items-center gap-1 text-[#00F0FF] hover:underline" href={pool.url} target="_blank" rel="noreferrer">{pool.dataSource} <ExternalLink size={11} /></a> : <div><div>{isCex ? 'Not applicable' : errorsByKey[key] || 'No live pool match'}</div>{!isCex && <div className="mt-1 text-[10px] text-[#5a6080]">No values invented</div>}</div>}</td>
                  </tr>
                ))
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-[#232738] px-4 py-3 text-[11px] leading-5 text-[#8a90b0]">This panel does not enable routes or broadcast transactions. Pool matches are symbol-and-chain filtered and can still include unrelated token contracts with identical symbols; verify token addresses and query reserves directly on the relevant chain before any transaction is eligible. Flash-loan executors remain unavailable until their deployed address, bytecode, repayment behavior and payout audit are verified.</p>
    </section>
  )
}
