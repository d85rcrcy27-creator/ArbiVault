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
