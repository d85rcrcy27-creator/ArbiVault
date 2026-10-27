import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, ExternalLink, RefreshCw, Search, ShieldAlert, TrendingUp } from 'lucide-react'

const POOLS_URL = 'https://yields.llama.fi/pools'
const EXPLORER_URL = 'https://defillama.com/yields'

function formatUsd(value) {
  if (!Number.isFinite(Number(value))) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(Number(value))
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : '—'
}

export default function ArbitrumYieldAggregator() {
  const [pools, setPools] = useState([])
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState('all')
  const [sortBy, setSortBy] = useState('tvl')
  const [refreshedAt, setRefreshedAt] = useState(null)

  const loadPools = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const response = await fetch(POOLS_URL, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Yield data provider returned HTTP ${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload?.data)) throw new Error('The yield data provider returned an unexpected response.')
      const arbitrumPools = payload.data.filter((pool) =>
        String(pool.chain || '').toLowerCase() === 'arbitrum' &&
        Number.isFinite(Number(pool.tvlUsd)) &&
        Number(pool.tvlUsd) > 0
      )
      setPools(arbitrumPools)
      setRefreshedAt(new Date())
      setStatus('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load live yield data.')
      setStatus('error')
    }
  }, [])

  useEffect(() => { loadPools() }, [loadPools])

  const protocols = useMemo(() => [...new Set(pools.map((pool) => pool.project).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [pools])

  const visiblePools = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return pools
      .filter((pool) => protocol === 'all' || pool.project === protocol)
      .filter((pool) => !needle || [pool.symbol, pool.project, pool.pool, pool.underlyingTokens?.join(' ')].some((value) => String(value || '').toLowerCase().includes(needle)))
      .sort((a, b) => sortBy === 'apy'
        ? (Number(b.apy) || -Infinity) - (Number(a.apy) || -Infinity)
        : (Number(b.tvlUsd) || 0) - (Number(a.tvlUsd) || 0))
  }, [pools, query, protocol, sortBy])

  const totalTvl = useMemo(() => pools.reduce((sum, pool) => sum + (Number(pool.tvlUsd) || 0), 0), [pools])
  const protocolCount = useMemo(() => new Set(pools.map((pool) => pool.project).filter(Boolean)).size, [pools])

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-400">ArbiVault · DeFi Research</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Arbitrum Yield Aggregator</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">Compare publicly reported lending and liquidity-pool yields across Arbitrum protocols, with TVL and source links in one view.</p>
          </div>
          <button onClick={loadPools} disabled={status === 'loading'} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium hover:border-cyan-500 disabled:cursor-wait disabled:opacity-60">
            <RefreshCw size={16} className={status === 'loading' ? 'animate-spin' : ''} />
            Refresh live data
          </button>
        </header>

        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <p className="text-sm text-slate-400">Arbitrum pools indexed</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{status === 'ready' ? pools.length.toLocaleString() : '—'}</p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <p className="text-sm text-slate-400">Combined reported TVL</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{status === 'ready' ? formatUsd(totalTvl) : '—'}</p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <p className="text-sm text-slate-400">Protocols indexed</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{status === 'ready' ? protocolCount.toLocaleString() : '—'}</p>
          </div>
        </section>

        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber-300" />
            <div>
              <p className="text-sm font-semibold text-amber-100">Research-only mode</p>
              <p className="mt-1 text-sm leading-6 text-slate-300">APY is variable and may be estimated by the data provider. This page compares reported pools only; it does not deposit funds, connect a wallet, execute transactions, or guarantee returns. Check pool contracts, incentives, withdrawal conditions, and impermanent-loss risk before using a protocol.</p>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row">
            <label className="relative flex-1">
              <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token, pool, or protocol" className="w-full rounded-xl border border-slate-700 bg-slate-950 py-3 pl-10 pr-3 text-sm outline-none focus:border-cyan-500" />
            </label>
            <select value={protocol} onChange={(event) => setProtocol(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm outline-none focus:border-cyan-500">
              <option value="all">All protocols</option>
              {protocols.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button onClick={() => setSortBy((value) => value === 'tvl' ? 'apy' : 'tvl')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-3 text-sm hover:border-cyan-500">
              <ArrowDownUp size={16} /> Sort by {sortBy === 'tvl' ? 'TVL' : 'APY'}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>{status === 'ready' ? `Showing ${visiblePools.length.toLocaleString()} of ${pools.length.toLocaleString()} Arbitrum pools` : 'Waiting for live provider data'}</span>
            <span>{refreshedAt ? `Updated ${refreshedAt.toLocaleTimeString()}` : 'No successful refresh yet'}</span>
          </div>

          {status === 'loading' && <div className="rounded-xl border border-slate-800 p-10 text-center text-sm text-slate-400">Loading live yield data…</div>}
          {status === 'error' && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-5 text-sm text-rose-200"><p className="font-semibold">Live data unavailable</p><p className="mt-1">{error}</p><button onClick={loadPools} className="mt-3 underline underline-offset-4">Try again</button></div>}
          {status === 'ready' && visiblePools.length === 0 && <div className="rounded-xl border border-slate-800 p-10 text-center text-sm text-slate-400">No pools match these filters.</div>}

          {status === 'ready' && visiblePools.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead><tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500"><th className="px-3 py-3 font-medium">Pool / asset</th><th className="px-3 py-3 font-medium">Protocol</th><th className="px-3 py-3 text-right font-medium">Reported APY</th><th className="px-3 py-3 text-right font-medium">Base / rewards</th><th className="px-3 py-3 text-right font-medium">TVL</th><th className="px-3 py-3 text-right font-medium">Source</th></tr></thead>
                <tbody>
                  {visiblePools.map((pool) => (
                    <tr key={pool.pool} className="border-b border-slate-800/70 last:border-0 hover:bg-slate-800/30">
                      <td className="px-3 py-4"><div className="font-semibold text-slate-100">{pool.symbol || 'Unknown asset'}</div><div className="mt-1 max-w-[260px] truncate text-xs text-slate-500">{pool.underlyingTokens?.join(' / ') || pool.pool}</div>{pool.stablecoin && <span className="mt-2 inline-block rounded-md bg-slate-800 px-2 py-1 text-[10px] text-slate-300">Stablecoin pool</span>}</td>
                      <td className="px-3 py-4"><div className="font-medium">{pool.project || 'Unknown'}</div><div className="mt-1 text-xs text-slate-500">{pool.exposure || 'Pool'}</div></td>
                      <td className="px-3 py-4 text-right"><div className="inline-flex items-center justify-end gap-1 font-semibold text-emerald-300"><TrendingUp size={14} />{formatPercent(pool.apy)}</div><div className="mt-1 text-xs text-slate-500">Variable</div></td>
                      <td className="px-3 py-4 text-right tabular-nums"><div>{formatPercent(pool.apyBase)}</div><div className="mt-1 text-xs text-slate-500">Rewards {formatPercent(pool.apyReward)}</div></td>
                      <td className="px-3 py-4 text-right font-medium tabular-nums">{formatUsd(pool.tvlUsd)}</td>
                      <td className="px-3 py-4 text-right"><a href={pool.url || EXPLORER_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200">View <ExternalLink size={13} /></a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <footer className="flex flex-col gap-2 border-t border-slate-800 pt-4 text-xs leading-5 text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>Data source: DefiLlama Yields API · Chain filter: Arbitrum</span>
          <a href={EXPLORER_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-slate-300">Open yield explorer <ExternalLink size={12} /></a>
        </footer>
      </div>
    </main>
  )
}
