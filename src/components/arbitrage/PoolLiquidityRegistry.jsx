import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react'

const LOOKUPS = [
  {
    chainId: 'ethereum',
    chainLabel: 'Ethereum',
    queryToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    allowedPairs: [
      { pair: 'ETH/USDC', a: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', b: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      { pair: 'ETH/USDT', a: '0xc02aaa39b223fe8d0a0e5c4f27eAD9083C756Cc2', b: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
      { pair: 'ETH/DAI', a: '0xc02aaa39b223fe8d0a0e5c4f27eAD9083C756Cc2', b: '0x6b175474e89094c44da98b954eedeac495271d0f' },
      { pair: 'WBTC/ETH', a: '0x2260fac5e5542a773a44fbcfedf7c193bc2c599', b: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
    ],
  },
  {
    chainId: 'ethereum',
    chainLabel: 'Ethereum',
    queryToken: '0x2260fac5e5542a773a44fbcfedf7c193bc2c599',
    allowedPairs: [
      { pair: 'WBTC/ETH', a: '0x2260fac5e5542a773a44fbcfedf7c193bc2c599', b: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
      { pair: 'WBTC/USDC', a: '0x2260fac5e5542a773a44fbcfedf7c193bc2c599', b: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    ],
  },
  {
    chainId: 'bsc',
    chainLabel: 'BNB Chain',
    queryToken: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    allowedPairs: [
      { pair: 'BNB/USDT', a: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', b: '0x55d398326f99059ff775485246999027b3197955' },
      { pair: 'BNB/USDC', a: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', b: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
      { pair: 'BTCB/BNB', a: '0x7130d2a12b9bc bfae4f2634d864a1ee1ce3ead9c'.replaceAll(' ', ''), b: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
    ],
  },
  {
    chainId: 'bsc',
    chainLabel: 'BNB Chain',
    queryToken: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    allowedPairs: [
      { pair: 'BTCB/BNB', a: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', b: '0xbb4cdb9cb d36b01bd1cbaebf2de08d9173bc095c'.replaceAll(' ', '') },
      { pair: 'BTCB/USDT', a: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', b: '0x55d398326f99059ff775485246999027b3197955' },
    ],
  },
  {
    chainId: 'solana',
    chainLabel: 'Solana',
    queryToken: 'So11111111111111111111111111111111111111112',
    allowedPairs: [
      { pair: 'SOL/USDC', a: 'So11111111111111111111111111111111111111112', b: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      { pair: 'SOL/USDT', a: 'So11111111111111111111111111111111111111112', b: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
    ],
  },
]

function fmt(value, digits = 6) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'
}

function sameAddress(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

export default function PoolLiquidityRegistry() {
  const [pools, setPools] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const responses = await Promise.all(LOOKUPS.map(async (lookup) => {
        const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${lookup.chainId}/${lookup.queryToken}`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`${lookup.chainLabel} pool lookup returned HTTP ${response.status}`)
        const data = await response.json()
        if (!Array.isArray(data)) throw new Error(`${lookup.chainLabel} pool lookup returned an unexpected response`)
        return { lookup, data }
      }))

      const byPool = new Map()
      for (const { lookup, data } of responses) {
        for (const pool of data) {
          if (String(pool.chainId || '').toLowerCase() !== lookup.chainId) continue
          const base = String(pool.baseToken?.address || '').toLowerCase()
          const quote = String(pool.quoteToken?.address || '').toLowerCase()
          const matched = lookup.allowedPairs.find((item) =>
            (sameAddress(base, item.a) && sameAddress(quote, item.b)) ||
            (sameAddress(base, item.b) && sameAddress(quote, item.a))
          )
          if (!matched || !pool.pairAddress) continue
          const key = `${lookup.chainId}:${String(pool.pairAddress).toLowerCase()}`
          const baseIsA = sameAddress(base, matched.a)
          byPool.set(key, {
            key,
            chainId: lookup.chainId,
            chainLabel: lookup.chainLabel,
            pair: matched.pair,
            dex: pool.dexId || 'Unknown DEX',
            address: pool.pairAddress,
            url: pool.url || `https://dexscreener.com/${lookup.chainId}/${pool.pairAddress}`,
            baseSymbol: pool.baseToken?.symbol || 'Token A',
            quoteSymbol: pool.quoteToken?.symbol || 'Token B',
            baseAmount: pool.liquidity?.base,
            quoteAmount: pool.liquidity?.quote,
            liquidityUsd: pool.liquidity?.usd,
            priceUsd: pool.priceUsd,
            volume24h: pool.volume?.h24,
            priceChange24h: pool.priceChange?.h24,
            txns24h: pool.txns?.h24,
            matchedTokenOrder: baseIsA ? 'canonical order' : 'reversed token order',
          })
        }
      }

      const nextPools = [...byPool.values()].sort((a, b) => {
        const left = Number(a.liquidityUsd)
        const right = Number(b.liquidityUsd)
        return (Number.isFinite(right) ? right : -1) - (Number.isFinite(left) ? left : -1)
      })
      setPools(nextPools)
      setUpdatedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Live pool lookup failed.')
      setPools([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const poolCounts = useMemo(() => {
    return pools.reduce((acc, pool) => {
      acc[pool.pair] = (acc[pool.pair] || 0) + 1
      return acc
    }, {})
  }, [pools])

  return (
    <section className="overflow-hidden rounded border border-[#232738] bg-[#0C0E16]">
      <div className="flex flex-col gap-3 border-b border-[#232738] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Live liquidity pools & reserve data</h2>
          <p className="mt-2 max-w-4xl text-xs leading-5 text-[#8a90b0]">
            Live DEX Screener discovery, restricted to canonical token contract/mint pairs used by the builder. Amounts below are provider-reported pool liquidity quantities, not a universal on-chain reserve format; concentrated-liquidity and Solana pools require venue-specific state decoding for exact reserves.
          </p>
        </div>
        <button onClick={refresh} disabled={loading} className="inline-flex shrink-0 items-center justify-center gap-2 rounded border border-[#30364b] px-3 py-2 font-mono text-[10px] hover:border-[#00F0FF] disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> REFRESH POOLS
        </button>
      </div>
      <div className="grid gap-2 border-b border-[#232738] p-3 sm:grid-cols-4">
        {['ETH/USDC', 'ETH/USDT', 'ETH/DAI', 'WBTC/ETH', 'WBTC/USDC', 'BNB/USDT', 'BNB/USDC', 'BTCB/BNB', 'BTCB/USDT', 'SOL/USDC', 'SOL/USDT'].map((pair) => (
          <div key={pair} className="rounded border border-[#232738] bg-[#090A0F] p-3">
            <div className="font-mono text-[10px] text-[#8a90b0]">{pair}</div>
            <div className="mt-1 font-mono text-lg">{loading ? '…' : (poolCounts[pair] || 0)}</div>
            <div className="text-[10px] text-[#5a6080]">matching pools found</div>
          </div>
        ))}
      </div>
      {error && <div role="alert" className="flex items-start gap-2 border-b border-red-500/30 px-4 py-3 text-xs text-red-200"><ShieldAlert size={14} className="mt-0.5 shrink-0" />{error}. No substitute or sample pool data is shown.</div>}
      {loading && pools.length === 0 ? <p className="p-6 text-sm text-[#8a90b0]">Querying live pool listings…</p> : pools.length === 0 ? (
        <div className="p-6 text-sm text-[#8a90b0]">No matching pools returned for the configured canonical token pairs. This does not imply that the pairs have no liquidity; the data provider may be unavailable or may not index a venue.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1500px] text-left text-xs">
            <thead className="bg-[#090A0F] font-mono uppercase text-[#8a90b0]">
              <tr>{['Chain / pair', 'DEX / pool address', 'Liquidity amount A', 'Liquidity amount B', 'Liquidity USD', 'Token price USD', '24h volume USD', '24h change', '24h transactions', 'Source'].map((heading) => <th key={heading} className="px-3 py-3 font-medium">{heading}</th>)}</tr>
            </thead>
            <tbody>
              {pools.map((pool) => (
                <tr key={pool.key} className="border-t border-[#232738] align-top">
                  <td className="px-3 py-3"><div>{pool.chainLabel}</div><div className="mt-1 font-mono text-[#00F0FF]">{pool.pair}</div></td>
                  <td className="px-3 py-3"><div>{pool.dex}</div><div className="mt-1 max-w-[220px] break-all font-mono text-[10px] text-[#8a90b0]">{pool.address}</div></td>
                  <td className="px-3 py-3 font-mono">{fmt(pool.baseAmount)} <span className="text-[#8a90b0]">{pool.baseSymbol}</span></td>
                  <td className="px-3 py-3 font-mono">{fmt(pool.quoteAmount)} <span className="text-[#8a90b0]">{pool.quoteSymbol}</span></td>
                  <td className="px-3 py-3 font-mono">{pool.liquidityUsd == null ? 'Not reported' : '$' + fmt(pool.liquidityUsd, 2)}</td>
                  <td className="px-3 py-3 font-mono">{pool.priceUsd == null ? 'Not reported' : '$' + fmt(pool.priceUsd, 8)}</td>
                  <td className="px-3 py-3 font-mono">{pool.volume24h == null ? 'Not reported' : '$' + fmt(pool.volume24h, 2)}</td>
                  <td className="px-3 py-3 font-mono">{pool.priceChange24h == null ? '—' : fmt(pool.priceChange24h, 2) + '%'}</td>
                  <td className="px-3 py-3 font-mono">{pool.txns24h ? fmt(Number(pool.txns24h.buys || 0) + Number(pool.txns24h.sells || 0), 0) : '—'}</td>
                  <td className="px-3 py-3"><a className="inline-flex items-center gap-1 text-[#00F0FF] hover:underline" href={pool.url} target="_blank" rel="noreferrer">DEX Screener <ExternalLink size={11} /></a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-[#232738] px-4 py-3 text-[10px] leading-5 text-[#5a6080]">
        {updatedAt ? `Last successful provider response: ${updatedAt.toLocaleString()}.` : 'Live data timestamp will appear after a successful response.'} Pool discovery is read-only and does not enable routes, sign transactions, or broadcast trades. Missing fields remain unreported rather than being inferred.
      </p>
    </section>
  )
}
