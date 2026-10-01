import { useState, useEffect, useCallback } from 'react';

const NOTIONAL = 10000;
const HISTORY_LEN = 30;
const TICK_MS = 1000;
const FEE_PCT = 0.1;

export const PAIRS = [
  { symbol: 'BTC', label: 'BTC/USDT' },
  { symbol: 'ETH', label: 'ETH/USDT' },
  { symbol: 'SOL', label: 'SOL/USDT' },
  { symbol: 'XRP', label: 'XRP/USDT' },
  { symbol: 'ADA', label: 'ADA/USDT' },
  { symbol: 'AVAX', label: 'AVAX/USDT' },
  { symbol: 'LINK', label: 'LINK/USDT' },
  { symbol: 'DOGE', label: 'DOGE/USDT' },
];

const VENUES = ['BIN', 'BYB', 'OKX'];

const rand = (min, max) => min + Math.random() * (max - min);

const makeHistory = (base) =>
  Array.from({ length: HISTORY_LEN }, () => +Math.max(0.01, base + rand(-0.15, 0.15)).toFixed(3));

const seedRoutes = () =>
  PAIRS.map((p, i) => {
    const buyIdx = i % VENUES.length;
    const sellIdx = (buyIdx + 1 + (i % 2)) % VENUES.length;
    const spreadPct = +rand(0.05, 0.9).toFixed(3);
    return {
      id: `${p.symbol}-${buyIdx}${sellIdx}`,
      symbol: p.symbol,
      pair: p.label,
      buyExchange: VENUES[buyIdx],
      sellExchange: VENUES[sellIdx],
      spreadPct,
      latency: Math.round(rand(20, 180)),
      volume: Math.round(rand(5000, 90000)),
      history: makeHistory(spreadPct),
    };
  });

export function useLiveMarketData() {
  const [routes, setRoutes] = useState(seedRoutes);
  const [trades, setTrades] = useState([]);
  const [engineStatus, setEngineStatus] = useState('ACTIVE');
  const [status, setStatus] = useState('connecting');
  const [connected, setConnected] = useState({ binance: false, bybit: false, okx: false });

  // Feed handshake: mark venues connected shortly after mount.
  useEffect(() => {
    const timer = setTimeout(() => {
      setConnected({ binance: true, bybit: true, okx: true });
      setStatus('live');
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  // Live tick — frozen while the engine is paused.
  useEffect(() => {
    if (engineStatus !== 'ACTIVE') return;
    const id = setInterval(() => {
      setRoutes((prev) =>
        prev.map((r) => {
          const spreadPct = +Math.max(0.01, r.spreadPct + rand(-0.08, 0.08)).toFixed(3);
          return {
            ...r,
            spreadPct,
            latency: Math.round(Math.max(10, Math.min(300, r.latency + rand(-15, 15)))),
            volume: Math.round(Math.max(1000, r.volume + rand(-4000, 4000))),
            history: [...r.history.slice(1), spreadPct],
          };
        })
      );
    }, TICK_MS);
    return () => clearInterval(id);
  }, [engineStatus]);

  const executeRoute = useCallback(
    (routeId, strategyName) => {
      const route = routes.find((r) => r.id === routeId);
      if (!route) return;
      const pnl = +((NOTIONAL * (route.spreadPct - FEE_PCT)) / 100).toFixed(2);
      const trade = {
        id: `${routeId}-${Date.now()}`,
        txid: `0x${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`,
        pair: route.pair,
        buyExchange: route.buyExchange,
        sellExchange: route.sellExchange,
        spreadPct: route.spreadPct,
        pnl,
        ts: Date.now(),
        strategy: strategyName || 'Manual',
      };
      setTrades((prev) => [trade, ...prev].slice(0, 100));
    },
    [routes]
  );

  const globalLatency = routes.length
    ? Math.round(routes.reduce((sum, r) => sum + r.latency, 0) / routes.length)
    : 0;
  const sessionPnL = +trades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2);

  return {
    routes,
    trades,
    globalLatency,
    sessionPnL,
    executeRoute,
    status,
    connected,
    engineStatus,
    setEngineStatus,
  };
}
