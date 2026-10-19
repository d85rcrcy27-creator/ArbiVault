# ArbiVault Ethereum Sepolia executor testnet track

This is an isolated testnet implementation. It does not modify the production Ethereum or BSC executor, wallet settings, Supabase deployment registry, or mainnet deployment workflows.

## Network and protocol configuration

- Network: Ethereum Sepolia (chain ID 11155111)
- Aave V3 Pool: `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`
- Uniswap V2 Router02: `0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3`
- SushiSwap V2 Router02: `0xeaBcE3E74EF41FB40024a21Cc2ee2F5dDc615791`
- Aave Sepolia WETH: `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c`
- Aave Sepolia USDC: `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`

Aave and Uniswap addresses are from their public deployment registries. The SushiSwap Sepolia router must still be independently checked for live bytecode and usable WETH/USDC liquidity before any transaction execution. Addresses alone do not prove that a flash-loan route is executable.

## Deployment safety

- This branch is not production.
- Do not reuse the mainnet deployment signer or mainnet deployment workflow.
- Before broadcast, implement a separate testnet signer/deployer path, confirm signer address and Sepolia balance, query `eth_estimateGas` for the exact init code, and independently verify runtime bytecode and constructor immutables.
- No funds should be sent to an address until the testnet signer is read from the controlled deployment registry and verified against the live RPC.
- BSC Testnet is not configured here. The existing BSC executor depends on the BSC mainnet Aave V3 pool and mainnet token/router addresses. Do not deploy it unchanged to chain ID 97. A compatible testnet flash-loan provider and assets must be confirmed first.

## Test scope

The Foundry unit tests verify constructor chain guarding, router allowlisting, and argument rejection using local test code. They do not simulate a live Aave loan or prove that Sepolia router pools have liquidity.
