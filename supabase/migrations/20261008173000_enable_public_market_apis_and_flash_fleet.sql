-- Public market-data adapters are read-only discovery inputs.
-- Keep execution/signing/broadcast functions behind ArbiVault's private auth boundary.
update public.arbivault_market_adapters
set enabled = true,
    read_only = true,
    updated_at = now()
where public_api = true;

-- Enable the existing flash-loan strategy bots for the chains they are configured to support.
update public.arbivault_strategy_bots
set enabled = true,
    execution_enabled = true,
    flash_loan_enabled = true,
    chains = array['bnb','ethereum'],
    updated_at = now()
where strategy in ('flash_loan','flash_loan_arbitrage');

-- Register the BNB route against the atomic builder, but fail closed until the
-- separately deployed executor contract and runtime addresses are configured.
update public.arbivault_strategy_routes
set enabled = true,
    discovery_only = false,
    transaction_builder = 'aave_v3_atomic_flash_loan_v1',
    builder_enabled = false,
    builder_status = 'awaiting_atomic_executor',
    updated_at = now()
where id = '0634e723-5817-44cc-926e-154e2b32d091';

-- Do not attach the BNB builder to the Ethereum flash route; the current atomic
-- builder implementation is BNB-specific and must not construct a mismatched chain transaction.
update public.arbivault_strategy_routes
set enabled = true,
    discovery_only = false,
    transaction_builder = null,
    builder_enabled = false,
    builder_status = 'unconfigured',
    updated_at = now()
where id = 'f6edc068-ff01-4d3c-832f-5dfa8e7210c7';
