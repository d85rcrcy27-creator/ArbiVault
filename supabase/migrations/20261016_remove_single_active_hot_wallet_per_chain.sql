-- Allow multiple active trading hot wallets for the same owner and chain.
-- Wallet-level verification, approval, signer mapping, and route policies remain enforced separately.
DROP INDEX IF EXISTS public.wallets_one_active_hot_per_chain;
