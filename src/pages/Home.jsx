import { useState } from 'react';
import { ChevronUp, X, AlertTriangle } from 'lucide-react';
import UtilityBar from '@/components/arbitrage/UtilityBar';
import PulseMatrix from '@/components/arbitrage/PulseMatrix';
import SkillsCreator from '@/components/arbitrage/SkillsCreator';
import TradeLog from '@/components/arbitrage/TradeLog';
import { useLiveMarketData } from '@/hooks/useLiveMarketData';
import { useIsMobile } from '@/hooks/use-mobile';

export default function Home() {
  const isMobile = useIsMobile();
  const { routes, trades, globalLatency, sessionPnL, executeRoute, status, connected, engineStatus, setEngineStatus } =
    useLiveMarketData();
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState('matrix');

  const toggleEngine = () => setEngineStatus((s) => (s === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'));