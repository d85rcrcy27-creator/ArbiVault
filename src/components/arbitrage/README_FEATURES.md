Feature wiring lives in `arbivault.js`, `WalletCenter.jsx`, `SkillsCreator.jsx`, `useLiveMarketData.js`, and `TradeRow.jsx`.

WalletCenter uses the existing owner-scoped Supabase tables and never handles private keys. Skills and simulated trades are persisted. Simulated trade rows explicitly show that no transaction hash exists.
