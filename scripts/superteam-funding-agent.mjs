#!/usr/bin/env node

const BASE_URL = "https://superteam.fun";
const API_KEY = process.env.SUPERTEAM_EARN_API_KEY;

function arg(name, fallback) {
  const prefix = "--" + name + "=";
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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function fetchListingDetails(item, headers) {
  if (!item.slug) {
    return {
      detailStatus: "skipped",
      detailError: "listing_slug_missing",
      detailsEndpoint: null,
      details: null,
    };
  }

  const detailsEndpoint = new URL(
    "/api/agents/listings/details/" + encodeURIComponent(item.slug),
    BASE_URL,
  ).toString();

  try {
    const response = await fetch(detailsEndpoint, {
      headers,
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      return {
        detailStatus: "failed",
        detailHttpStatus: response.status,
        detailError: "details_endpoint_http_error",
        detailsEndpoint,
        details: null,
      };
    }

    return {
      detailStatus: "fetched",
      detailHttpStatus: response.status,
      detailError: null,
      detailsEndpoint,
      details: await response.json(),
    };
  } catch (error) {
    return {
      detailStatus: "failed",
      detailHttpStatus: null,
      detailError: error?.name || "details_request_failed",
      detailsEndpoint,
      details: null,
    };
  }
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "SUPERTEAM_EARN_API_KEY is not set. Configure it in an approved local CLI/runtime secret environment; never commit it.",
    );
  }

  const take = Math.max(1, Math.min(100, Number(arg("take", "50")) || 50));
  const url = new URL("/api/agents/listings/live", BASE_URL);
  url.searchParams.set("take", String(take));
  url.searchParams.set("deadline", new Date().toISOString());

  const headers = {
    Authorization: "Bearer " + API_KEY,
    Accept: "application/json",
  };

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error("Superteam Earn API HTTP " + response.status);
  }

  const payload = await response.json();
  const eligibleRows = extractListings(payload).filter((item) =>
    ["AGENT_ALLOWED", "AGENT_ONLY"].includes(item.agentAccess),
  );

  const listings = await mapWithConcurrency(eligibleRows, 5, async (item) => {
    const detail = await fetchListingDetails(item, headers);
    return {
      id: item.id ?? item.listingId ?? null,
      slug: item.slug ?? null,
      title: item.title ?? item.name ?? "Untitled listing",
      type: item.type ?? "unknown",
      status: item.status ?? "unknown",
      agentAccess: item.agentAccess,
      deadline: item.deadline ?? null,
      reward: item.reward ?? item.rewardAmount ?? item.compensation ?? null,
      detailStatus: detail.detailStatus,
      detailHttpStatus: detail.detailHttpStatus ?? null,
      detailError: detail.detailError,
      detailsEndpoint: detail.detailsEndpoint,
      details: detail.details,
      trackingStatus: detail.detailStatus === "fetched" ? "verified" : "discovered",
    };
  });

  const report = {
    agentName: "Draco",
    agentHandle: "chatgptagent-aqua-46",
    organization: "KingAlpha",
    turnkeyAccount: "Trust",
    mode: "read-only-scout",
    checkedAt: new Date().toISOString(),
    count: listings.length,
    detailsFetched: listings.filter((item) => item.detailStatus === "fetched").length,
    detailsFailed: listings.filter((item) => item.detailStatus !== "fetched").length,
    listings,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Superteam Earn scout — " + report.agentName + " / " + report.organization);
  console.log("Turnkey account: " + report.turnkeyAccount);
  console.log("Eligible listings: " + report.count);
  console.log("Listing details fetched: " + report.detailsFetched);
  console.log("Listing details unavailable: " + report.detailsFailed);

  for (const listing of listings) {
    console.log("\n[" + listing.agentAccess + "] " + listing.title);
    console.log("  " + listing.type + " | status: " + listing.status + " | deadline: " + (listing.deadline ?? "not listed"));
    console.log("  Detail status: " + listing.detailStatus);
    if (listing.reward !== null) console.log("  Reward: " + JSON.stringify(listing.reward));
    if (listing.detailsEndpoint) console.log("  Details: " + listing.detailsEndpoint);
    if (listing.details !== null) console.log("  Detail payload: " + JSON.stringify(listing.details));
  }

  console.log("\nRead-only scan complete. No applications were submitted and no funds were moved.");
}

main().catch((error) => {
  console.error("Superteam scout failed: " + error.message);
  process.exitCode = 1;
});
