const YIELDS_API = "https://yields.llama.fi/pools";
const ARBITRUM_CHAIN = "Arbitrum";
const MAX_RESPONSE_AGE_MS = 30 * 60 * 1000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fetches live third-party yield observations. This is discovery data only:
 * it does not imply protocol endorsement, audited safety, or executable routes.
 */
export async function fetchArbitrumYieldOpportunities({ signal } = {}) {
  const response = await fetch(YIELDS_API, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Yield data provider returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.data)) {
    throw new Error("Yield data provider returned an unexpected response");
  }

  const fetchedAt = Date.now();
  return payload.data
    .filter((row) => row?.chain === ARBITRUM_CHAIN)
    .map((row) => ({
      id: typeof row.pool === "string" ? row.pool : null,
      protocol: typeof row.project === "string" ? row.project : null,
      chain: row.chain,
      assets: typeof row.symbol === "string" ? row.symbol : "Unknown",
      tvlUsd: finiteNumber(row.tvlUsd),
      apy: finiteNumber(row.apy),
      apyBase: finiteNumber(row.apyBase),
      apyReward: finiteNumber(row.apyReward),
      stablecoin: row.stablecoin === true,
      exposure: typeof row.exposure === "string" ? row.exposure : "unknown",
      poolMeta: typeof row.poolMeta === "string" ? row.poolMeta : null,
      source: "DefiLlama Yields",
      sourceUrl: "https://defillama.com/yields",
      observedAt: fetchedAt,
      sourceUpdatedAt: typeof row.timestamp === "string" ? row.timestamp : null,
      dataQuality: "unverified-third-party-observation",
    }))
    .filter((row) => row.id && row.protocol && row.tvlUsd !== null && row.apy !== null)
    .sort((a, b) => b.apy - a.apy);
}

/**
 * Computes a transparent estimate for a user's own deposit size and expected
 * annual gas/transaction cost. It deliberately does not invent gas prices.
 * Values are estimates, not guaranteed returns or execution quotes.
 */
export function estimateNetYield(opportunity, {
  depositUsd,
  annualGasCostUsd,
  protocolFeeUsd = 0,
} = {}) {
  const deposit = finiteNumber(depositUsd);
  const gas = finiteNumber(annualGasCostUsd);
  const fees = finiteNumber(protocolFeeUsd);
  const apy = finiteNumber(opportunity?.apy);

  if (deposit === null || deposit <= 0 || gas === null || gas < 0 ||
      fees === null || fees < 0 || apy === null) {
    throw new Error("Provide a positive deposit and valid non-negative annual costs");
  }

  const grossAnnualYieldUsd = deposit * (apy / 100);
  const netAnnualYieldUsd = grossAnnualYieldUsd - gas - fees;
  return {
    grossAnnualYieldUsd,
    annualGasCostUsd: gas,
    protocolFeeUsd: fees,
    netAnnualYieldUsd,
    netApy: (netAnnualYieldUsd / deposit) * 100,
    costAssumptionsProvidedByUser: true,
  };
}

/** Returns true only when the cached observation is recent enough to display. */
export function isYieldObservationFresh(opportunity, now = Date.now()) {
  return Number.isFinite(opportunity?.observedAt) &&
    now >= opportunity.observedAt &&
    now - opportunity.observedAt <= MAX_RESPONSE_AGE_MS;
}
