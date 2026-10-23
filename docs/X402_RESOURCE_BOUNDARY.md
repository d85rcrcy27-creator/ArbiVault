# ArbiVault x402 Resource Boundary

## Purpose

x402 is the payment boundary between ArbiVault and independently operated Internet resources. It is not a resource-hosting API, an internal proxy, a trading executor, or an on-chain trading settlement protocol.

## Required request flow

1. An ArbiVault worker or app component requests an allowlisted external HTTPS resource.
2. The external resource returns its x402 payment requirements (HTTP 402).
3. ArbiVault validates the resource origin, network, asset, recipient, exact amount, and per-agent budget against policy.
4. The payment authorization is created through the approved Turnkey signer adapter. Do not load raw private keys into browser code, CI, or this integration.
5. ArbiVault's x402 client retries the request with the protocol's payment payload.
6. The external resource/facilitator performs the protocol's verification and settlement. ArbiVault accepts the resource response only when the provider's protocol response indicates success.
7. ArbiVault records a redacted audit event: resource origin, agent identity, selected network/asset, amount, result, and timestamp. Never log signing material or payment payloads.

## Isolation rules

- External resources remain owned and served by their providers.
- Do not add an ArbiVault Edge Function that proxies arbitrary resource URLs or returns provider bodies.
- Do not expose Turnkey credentials or signing keys to the browser.
- Do not treat a user-supplied payment signature as proof of settlement.
- Do not accept arbitrary hosts, redirects, networks, tokens, recipients, or unbounded payment amounts.
- Do not route x402 resource payments through flash-loan executors or trading settlement code.
- Missing policy, signer support, or verifiable settlement must fail closed.

## Implementation status

This document records the intended boundary only. The initial proxy-style Edge Function was removed because it conflated resource fetching with an application-hosted proxy and did not integrate the production Turnkey signer. The x402 client and Turnkey signing adapter must be implemented and tested as separate modules before enabling live resource payments. No production payments are enabled by this change.

## Flash-loan fee attribution

Flash-loan accounting keeps three costs separate:

- The flash-loan premium, reported in the same USD-equivalent unit as the USDT/USDC profit estimate.
- Network gas, stored as the exact native fee (BNB, ETH, SOL, or BTC) and valued separately in USD when a live asset price is available. If a price is unavailable, P&L must not subtract a native-token number from USD profit; the preflight USD estimate may be shown explicitly as a fallback.
- A paid x402 resource charge, included only when the payment is explicitly attributable to that execution attempt. Free gas/block/token-safety previews are not x402 charges. No fixed $0.008 fee is imputed to every flash-loan transaction.

The flash-loan preflight rejects the candidate when the network-fee estimate exceeds the strategy bot's max_gas_budget (USD-equivalent budget) or when the estimated net profit is below min_profit_threshold. The default network-fee budget is $5 USD when no per-bot budget is configured; operators can override it with ARBIVAULT_MAX_NETWORK_FEE_USD. A per-bot value takes precedence.

x402 resource payment is not gas sponsorship. The transaction sender must still have native gas assets (or use a separately configured, supported gas-sponsorship system). Accounting for gas against net profit prevents over-reporting earnings but does not remove the network's native-token fee requirement.

Actual network fees are captured from receipts/status metadata where supported. Flash-loan executor receipts use the emitted settlement event for the premium/profit values; the UI/database must still mark wallet-balance reconciliation as unverified until token balance deltas are checked. When fee inputs are missing, net profit remains unknown (NULL) rather than displaying fabricated zero profit.
## Single-style operation and evidence-backed P&L

ArbiVault's selected trading style is atomic Aave V3 flash-loan round-trip arbitrage. Other execution strategies remain disabled under the single-style configuration. Until a mainnet executor has verified bytecode, signer binding, source verification, and payout behavior, the flash routes remain discovery-only: they may collect live quotes and estimated fee data, but cannot create new signing requests or broadcast trades.

Realized flash-loan gross profit is written only when the confirmed receipt contains the executor's `FlashLoanSettled` event. If settlement evidence is missing, realized gross and net profit stay unknown rather than being copied from the preflight estimate. Confirmed native gas is recorded in its own asset and its USD equivalent is used only when a live spot price is available; estimates remain in the separate estimate field.

The current stop-loss budget is `-5 USD`, paired with a maximum preflight gas budget of `5 USD` and a minimum estimated net profit target of `2 USD`. The flash worker checks the worst-case gas amount implied by the unsigned transaction's gas limit and legacy gas price, converted at live native-token spot with 10% valuation headroom. If it cannot value that cap, or the cap exceeds the budget, it rejects the candidate. This limits modeled failed-transaction gas loss; USD loss can still move with the native asset price, and this is not a position-level stop order.
