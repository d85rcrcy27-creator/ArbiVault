-- Fail closed on live flash-loan transaction building until the corresponding
-- mainnet executor is deployed, source-verified and the immutable payout is audited.
-- Routes remain enabled for quote/discovery diagnostics only.

update public.arbivault_strategy_routes
set builder_enabled = false,
    builder_status = 'executor_deployment_pending',
    updated_at = now()
where (chain = 'bnb' and pair = 'BNB/USDT' and route_type = 'flash_liquidity')
   or (chain = 'ethereum' and pair = 'ETH/USDC' and route_type = 'flash_liquidity');

notify pgrst, 'reload schema';
