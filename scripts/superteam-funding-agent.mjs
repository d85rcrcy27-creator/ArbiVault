#!/usr/bin/env node

const BASE_URL = "https://superteam.fun";
const API_KEY = process.env.SUPERTEAM_EARN_API_KEY;

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function extractListings(payload) {
  if (Array.isArray(payload)) return payload;
  for (const candidate of [payload?.listings, payload?.data, payload?.result]) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.items)) return candidate.items;
    if (Array.isArray(candidate?.listings)) return candidate.listings;
  }
  return [];
}

async function main() {
  if (!API_KEY) {
    throw new Error("SUPERTEAM_EARN_API_KEY is not set. Configure it in your local CLI secret environment; never commit it.");
  }

  const take = Math.max(1, Math.min(100, Number(arg("take", "50")) || 50));
  const url = new URL("/api/agents/listings/live", BASE_URL);
  url.searchParams.set("take", String(take));
  url.searchParams.set("deadline", new Date().toISOString());

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`Superteam Earn API HTTP ${response.status}: ${detail}`);
  }

  const payload = await response.json();
  const listings = extractListings(payload)
    .filter((item) => ["AGENT_ALLOWED", "AGENT_ONLY"].includes(item.agentAccess))
    .map((item) => ({
      id: item.id ?? item.listingId ?? null,
      slug: item.slug ?? null,
      title: item.title ?? item.name ?? "Untitled listing",
      type: item.type ?? "unknown",
      status: item.status ?? "unknown",
      agentAccess: item.agentAccess,
      deadline: item.deadline ?? null,
      reward: item.reward ?? item.rewardAmount ?? item.compensation ?? null,
      detailsEndpoint: item.slug
        ? new URL(`/api/agents/listings/details/${encodeURIComponent(item.slug)}`, BASE_URL).toString()
        : null,
    }));

  const report = {
    agentName: "Draco",
    agentHandle: "chatgptagent-aqua-46",
    organization: "KingAlpha",
    turnkeyAccount: "Trust",
    mode: "read-only-scout",
    checkedAt: new Date().toISOString(),
    count: listings.length,
    listings,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Superteam Earn scout — ${report.agentName} / ${report.organization}`);
  console.log(`Turnkey account: ${report.turnkeyAccount} | Eligible listings: ${report.count}`);
  for (const listing of listings) {
    console.log(`\n[${listing.agentAccess}] ${listing.title}`);
    console.log(`  ${listing.type} | status: ${listing.status} | deadline: ${listing.deadline ?? "not listed"}`);
    if (listing.reward !== null) console.log(`  Reward: ${JSON.stringify(listing.reward)}`);
    if (listing.detailsEndpoint) console.log(`  Details: ${listing.detailsEndpoint}`);
  }
  console.log("\nRead-only scan complete. No applications were submitted and no funds were moved.");
}

main().catch((error) => {
  console.error(`Superteam scout failed: ${error.message}`);
  process.exitCode = 1;
});
