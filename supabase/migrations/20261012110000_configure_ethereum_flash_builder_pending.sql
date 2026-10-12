-- Configure the known Ethereum atomic builder while keeping the route disabled.
-- This does not enable live execution. The route remains blocked until the executor is
-- deployed, the immutable payout wallet/source are verified, and the payout audit passes.

update public.arbivault_strategy_routes
set transaction_builder = 'aave_v3_atomic_flash_loan_v1',
    builder_enabled = false,
    builder_status = 'ethereum_executor_deployment_pending',
    updated_at = now()
where chain = 'ethereum'
  and pair = 'ETH/USDC'
  and strategy = 'flash_loan_arbitrage'
  and route_type = 'flash_liquidity'
  and enabled = true
  and (transaction_builder is distinct from 'aave_v3_atomic_flash_loan_v1'
       or builder_enabled is distinct from false
       or builder_status is distinct from 'ethereum_executor_deployment_pending');

notify pgrst, 'reload schema';
