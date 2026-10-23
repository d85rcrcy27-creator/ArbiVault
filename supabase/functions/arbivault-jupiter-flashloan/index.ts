import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "npm:@solana/web3.js@1.98.4";
import BN from "npm:bn.js@5.2.2";
import bs58 from "npm:bs58@6.0.0";
import { Buffer } from "node:buffer";
import { getFlashloanIx } from "npm:@jup-ag/lend@0.4.0/flashloan";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SOLANA_RPC = Deno.env.get("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
const JUPITER_API_KEY = Deno.env.get("JUPITER_API_KEY") || "";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const MIN_SIMULATION_USDC_RAW = 1_000_000n;       // 1 USDC
const MAX_SIMULATION_USDC_RAW = 100_000_000n;     // 100 USDC
const MAX_SLIPPAGE_BPS = 30;
const MAX_COMPUTE_UNITS = 1_400_000;

type ApiInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

type JupiterBuild = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode?: string;
  slippageBps?: number;
  computeBudgetInstructions?: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
};

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

async function cronAuthorized(req: Request) {
  const supplied = req.headers.get("x-arbivault-cron-token");
  if (!supplied) return false;
  const { data, error } = await supabase.rpc("get_bot_cron_token");
  return !error && !!data && supplied === String(data);
}

async function authorize(req: Request) {
  if (await cronAuthorized(req)) return { kind: "cron" as const, ownerId: null };
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { kind: "user" as const, ownerId: data.user.id };
}

function sha256Hex(value: Uint8Array) {
  // Use a dedicated ArrayBuffer to satisfy the WebCrypto BufferSource types
  // and avoid passing a view whose backing type may be SharedArrayBuffer.
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return crypto.subtle.digest("SHA-256", copy).then((hash) =>
    Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function fromApiInstruction(ix: ApiInstruction): TransactionInstruction {
  if (
    !ix ||
    typeof ix.programId !== "string" ||
    !Array.isArray(ix.accounts) ||
    typeof ix.data !== "string"
  ) {
    throw new Error("jupiter_instruction_shape_invalid");
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(ix.programId);
    for (const account of ix.accounts) new PublicKey(account.pubkey);
  } catch {
    throw new Error("jupiter_instruction_address_invalid");
  }
  if (ix.accounts.some((account) =>
    typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean"
  )) {
    throw new Error("jupiter_instruction_account_flags_invalid");
  }
  let data: Uint8Array;
  try {
    data = Uint8Array.from(atob(ix.data), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("jupiter_instruction_data_invalid");
  }
  return new TransactionInstruction({
    programId,
    keys: ix.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(data),
  });
}

function instructionKey(ix: TransactionInstruction) {
  return [
    ix.programId.toBase58(),
    ...ix.keys.map((key) => `${key.pubkey.toBase58()}:${Number(key.isSigner)}:${Number(key.isWritable)}`),
    Buffer.from(ix.data).toString("hex"),
  ].join("|");
}

function dedupeInstructions(instructions: TransactionInstruction[]) {
  const seen = new Set<string>();
  return instructions.filter((instruction) => {
    const key = instructionKey(instruction);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadLookupTables(connection: Connection, builds: JupiterBuild[]) {
  // Never synthesize AddressLookupTableAccount state from off-chain API data.
  // Load the actual lookup table from Solana and confirm every API-referenced
  // address is present in that on-chain table.
  const required = new Map<string, Set<string>>();
  for (const build of builds) {
    for (const [tableAddress, addresses] of Object.entries(build.addressesByLookupTableAddress || {})) {
      const addressSet = required.get(tableAddress) || new Set<string>();
      for (const address of addresses) {
        new PublicKey(address);
        addressSet.add(address);
      }
      required.set(tableAddress, addressSet);
    }
  }
  const currentSlot = BigInt(await connection.getSlot("confirmed"));
  const tables: AddressLookupTableAccount[] = [];
  for (const [tableAddress, expectedAddresses] of required.entries()) {
    const result = await connection.getAddressLookupTable(new PublicKey(tableAddress), {
      commitment: "confirmed",
    });
    const table = result.value;
    if (!table) throw new Error("jupiter_lookup_table_not_found_on_chain");
    if (table.state.deactivationSlot <= currentSlot) {
      throw new Error("jupiter_lookup_table_deactivated");
    }
    const onChainAddresses = new Set(table.state.addresses.map((address) => address.toBase58()));
    for (const expectedAddress of expectedAddresses) {
      if (!onChainAddresses.has(expectedAddress)) {
        throw new Error("jupiter_lookup_table_address_mismatch");
      }
    }
    tables.push(table);
  }
  return tables;
}

async function getJupiterBuild(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountRaw: string,
  taker: PublicKey,
  slippageBps: number,
): Promise<JupiterBuild> {
  if (!JUPITER_API_KEY) throw new Error("jupiter_api_key_not_configured");
  const query = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: amountRaw,
    taker: taker.toBase58(),
    slippageBps: String(slippageBps),
  });
  const response = await fetch(`https://api.jup.ag/swap/v2/build?${query.toString()}`, {
    method: "GET",
    headers: { accept: "application/json", "x-api-key": JUPITER_API_KEY },
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`jupiter_build_http_${response.status}`);
  if (
    !body ||
    body.inputMint !== inputMint.toBase58() ||
    body.outputMint !== outputMint.toBase58() ||
    String(body.inAmount || "") !== amountRaw ||
    !/^\d+$/.test(String(body.outAmount || "")) ||
    !/^\d+$/.test(String(body.otherAmountThreshold || "")) ||
    !Array.isArray(body.setupInstructions) ||
    !body.swapInstruction ||
    !body.blockhashWithMetadata ||
    !Array.isArray(body.blockhashWithMetadata.blockhash) ||
    body.blockhashWithMetadata.blockhash.some((byte: unknown) =>
      typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255
    ) ||
    !Number.isSafeInteger(Number(body.blockhashWithMetadata.lastValidBlockHeight))
  ) {
    throw new Error("jupiter_build_response_invalid");
  }
  const outputAmount = BigInt(String(body.outAmount));
  const minimumOutput = BigInt(String(body.otherAmountThreshold));
  if (outputAmount <= 0n || minimumOutput <= 0n || minimumOutput > outputAmount) {
    throw new Error("jupiter_output_threshold_invalid");
  }
  if (
    (body.otherInstructions !== undefined && !Array.isArray(body.otherInstructions)) ||
    (body.otherInstructions || []).length > 0 ||
    body.tipInstruction
  ) {
    throw new Error("jupiter_unreviewed_extra_instruction_blocked");
  }
  // Jupiter's documented /build response guarantees quote output and the
  // minimum output threshold, but not a distinct priceImpactPct field. This
  // preflight screens the actual quoted round-trip outputs and enforces the
  // slippage bound instead of treating a missing impact value as zero.
  return body as JupiterBuild;
}

function validateAmount(amountRaw: string) {
  if (!/^\d+$/.test(amountRaw)) throw new Error("flashloan_amount_invalid");
  const amount = BigInt(amountRaw);
  if (amount < MIN_SIMULATION_USDC_RAW) throw new Error("flashloan_amount_below_simulation_minimum");
  if (amount > MAX_SIMULATION_USDC_RAW) throw new Error("flashloan_amount_above_simulation_cap");
  return amount;
}

async function simulateRoundTrip(walletAddress: string, amountRaw: string, slippageBps: number) {
  const signer = new PublicKey(walletAddress);
  const connection = new Connection(SOLANA_RPC, { commitment: "confirmed" });
  const [genesisHash, slot] = await Promise.all([
    connection.getGenesisHash(),
    connection.getSlot("confirmed"),
  ]);
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error("solana_rpc_not_mainnet");
  }

  const first = await getJupiterBuild(USDC_MINT, WSOL_MINT, amountRaw, signer, slippageBps);
  // Use the first leg's quoted output as the exact second-leg input. If
  // actual output falls below this, the entire Solana transaction reverts; this
  // is safer than knowingly leaving intermediate WSOL unaccounted for.
  const secondInputRaw = String(first.outAmount);
  if (
    !/^\d+$/.test(secondInputRaw) ||
    BigInt(secondInputRaw) <= 0n ||
    BigInt(String(first.otherAmountThreshold)) <= 0n ||
    BigInt(String(first.otherAmountThreshold)) > BigInt(secondInputRaw)
  ) {
    throw new Error("jupiter_first_leg_quote_invalid");
  }
  const second = await getJupiterBuild(WSOL_MINT, USDC_MINT, secondInputRaw, signer, slippageBps);
  const feeQuote = await getJupiterBuild(
    WSOL_MINT,
    USDC_MINT,
    String(10n ** BigInt(SOL_DECIMALS)),
    signer,
    slippageBps,
  );

  const {
    setupIxs: flashloanSetupIxs,
    borrowIx,
    paybackIx,
    cleanupIxs: flashloanCleanupIxs,
    feeAmount,
  } = await getFlashloanIx({
    connection,
    signer,
    asset: USDC_MINT,
    amount: new BN(amountRaw),
  });
  const flashloanFeeRaw = BigInt(String(feeAmount));
  if (flashloanFeeRaw < 0n) throw new Error("jupiter_flashloan_fee_invalid");

  const setupInstructions = dedupeInstructions([
    ...flashloanSetupIxs,
    ...first.setupInstructions.map(fromApiInstruction),
    ...second.setupInstructions.map(fromApiInstruction),
  ]);
  const swapOne = fromApiInstruction(first.swapInstruction);
  const swapTwo = fromApiInstruction(second.swapInstruction);
  // Do not include first.cleanupInstruction: it could close the wrapped-SOL
  // account that the second leg needs. Clean up only after the second swap.
  const cleanupAfterRoundTrip = second.cleanupInstruction
    ? [fromApiInstruction(second.cleanupInstruction)]
    : [];
  const lookupTables = await loadLookupTables(connection, [first, second]);
  const blockhashBytes = Uint8Array.from(first.blockhashWithMetadata.blockhash);
  if (blockhashBytes.length !== 32) throw new Error("jupiter_blockhash_invalid");
  const blockhash = bs58.encode(Buffer.from(blockhashBytes));
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
    ...setupInstructions,
    borrowIx,
    swapOne,
    swapTwo,
    paybackIx,
    ...cleanupAfterRoundTrip,
    ...flashloanCleanupIxs,
  ];
  const message = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);

  const [simulation, feeResult] = await Promise.all([
    connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    }),
    connection.getFeeForMessage(message, "confirmed"),
  ]);

  const feeLamports = feeResult.value === null ? null : BigInt(feeResult.value);
  const oneSolUsdcRaw = BigInt(String(feeQuote.outAmount));
  const estimatedNetworkFeeUsdcRaw = feeLamports === null
    ? null
    : (feeLamports * oneSolUsdcRaw + 999_999_999n) / 1_000_000_000n;
  const conservativeReturnRaw = BigInt(String(second.otherAmountThreshold));
  const grossProfitRaw = BigInt(String(second.outAmount)) - BigInt(amountRaw);
  const conservativeProfitRaw = conservativeReturnRaw - BigInt(amountRaw);
  const netProfitRaw = estimatedNetworkFeeUsdcRaw === null
    ? null
    : conservativeProfitRaw - flashloanFeeRaw - estimatedNetworkFeeUsdcRaw;
  const simulationOk = simulation.value.err === null;
  const netProfitable = simulationOk && netProfitRaw !== null && netProfitRaw > 0n;

  return {
    ok: true,
    mode: "simulate",
    builder: "jupiter_lend_atomic_flashloan_v1",
    chain: "solana",
    network: "Solana mainnet",
    source_wallet: walletAddress,
    flashloan_asset: USDC_MINT.toBase58(),
    flashloan_amount_raw: amountRaw,
    flashloan_amount_usdc: (Number(amountRaw) / 10 ** USDC_DECIMALS).toFixed(6),
    slippage_bps_per_swap: slippageBps,
    latest_confirmed_slot: slot,
    quote: {
      first_leg_out_raw: first.outAmount,
      first_leg_minimum_out_raw: first.otherAmountThreshold,
      second_leg_out_raw: second.outAmount,
      second_leg_minimum_out_raw: second.otherAmountThreshold,
      conservative_round_trip_profit_raw: conservativeProfitRaw.toString(),
      gross_round_trip_profit_raw: grossProfitRaw.toString(),
      flashloan_fee_usdc_raw: flashloanFeeRaw.toString(),
      estimated_network_fee_lamports: feeLamports?.toString() ?? null,
      estimated_network_fee_usdc_raw: estimatedNetworkFeeUsdcRaw?.toString() ?? null,
      estimated_net_profit_usdc_raw: netProfitRaw?.toString() ?? null,
      profitable_after_estimated_fee: netProfitable,
      price_impact_fraction_first_leg: null,
      price_impact_fraction_second_leg: null,
      price_impact_note: "Jupiter /build response does not guarantee a separate priceImpactPct field; quoted outputs and minimum-output thresholds are used for screening.",
    },
    simulation: {
      ok: simulationOk,
      error: simulation.value.err,
      units_consumed: simulation.value.unitsConsumed ?? null,
      logs_tail: (simulation.value.logs || []).slice(-12),
    },
    transaction_payload_hash: await sha256Hex(transaction.serialize()),
    transaction_created: true,
    transaction_signed: false,
    broadcast_attempted: false,
    ready_for_signing: false,
    execution_gate: simulationOk && netProfitable
      ? "blocked_pending_signer_policy_and_execution_route_review"
      : "blocked_simulation_or_profitability_check",
    notes: [
      "The transaction is composed in memory only; no signed transaction is returned.",
      "This function never signs, creates a signing request, or broadcasts.",
      "A successful RPC simulation is not a guarantee of execution profitability.",
      "The existing strategy route and automatic execution flags remain unchanged.",
    ],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const actor = await authorize(req);
  if (!actor) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const mode = String(body?.mode || "diagnostic");
  if (!["diagnostic", "simulate"].includes(mode)) {
    return json({ error: "unsupported_mode", supported_modes: ["diagnostic", "simulate"] }, 400);
  }

  try {
    if (mode === "diagnostic") {
      const connection = new Connection(SOLANA_RPC, { commitment: "confirmed" });
      const [genesisHash, slot] = await Promise.all([
        connection.getGenesisHash(),
        connection.getSlot("confirmed"),
      ]);
      return json({
        ok: genesisHash === MAINNET_GENESIS && !!JUPITER_API_KEY,
        mode: "diagnostic",
        builder: "jupiter_lend_atomic_flashloan_v1",
        chain: "solana",
        network: genesisHash === MAINNET_GENESIS ? "Solana mainnet" : "unknown_or_non_mainnet",
        rpc_configured: true,
        jupiter_api_key_configured: !!JUPITER_API_KEY,
        latest_confirmed_slot: slot,
        flashloan_sdk_loaded: typeof getFlashloanIx === "function",
        signing_enabled: false,
        broadcast_enabled: false,
        reason: !JUPITER_API_KEY ? "jupiter_api_key_not_configured"
          : genesisHash !== MAINNET_GENESIS ? "solana_rpc_not_mainnet"
          : null,
      });
    }

    const sourceWalletId = String(body?.source_wallet_id || "");
    if (!sourceWalletId) return json({ error: "source_wallet_id_required" }, 400);
    const amountRaw = String(body?.amount_raw || "10000000"); // 10 USDC default
    validateAmount(amountRaw);
    const slippageBps = Number(body?.slippage_bps ?? 30);
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
      return json({ error: "slippage_out_of_bounds", max_slippage_bps: MAX_SLIPPAGE_BPS }, 400);
    }

    const { data: wallet, error } = await supabase
      .from("wallets")
      .select("id,owner_id,chain,address,status,is_hot,wallet_role")
      .eq("id", sourceWalletId)
      .maybeSingle();
    if (error) return json({ error: "source_wallet_lookup_failed" }, 503);
    if (!wallet || wallet.chain !== "solana" || wallet.status !== "active" ||
        wallet.is_hot !== true || wallet.wallet_role !== "trading_hot" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(wallet.address || ""))) {
      return json({ error: "source_wallet_not_active_solana_trading_hot" }, 403);
    }
    if (actor.kind === "user" && actor.ownerId !== wallet.owner_id) {
      return json({ error: "source_wallet_owner_mismatch" }, 403);
    }

    const result = await simulateRoundTrip(String(wallet.address), amountRaw, slippageBps);
    return json({ ...result, source_wallet_id: wallet.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "jupiter_flashloan_preflight_failed";
    const knownBlocker = [
      "jupiter_api_key_not_configured",
      "solana_rpc_not_mainnet",
      "jupiter_build_response_invalid",
      "jupiter_unreviewed_extra_instruction_blocked",
      "jupiter_output_threshold_invalid",
      "jupiter_blockhash_invalid",
      "jupiter_lookup_table_not_found_on_chain",
      "jupiter_lookup_table_deactivated",
      "jupiter_lookup_table_address_mismatch",
      "jupiter_flashloan_fee_invalid",
      "flashloan_amount_invalid",
      "flashloan_amount_below_simulation_minimum",
      "flashloan_amount_above_simulation_cap",
    ].includes(message);
    return json({
      ok: false,
      mode,
      builder: "jupiter_lend_atomic_flashloan_v1",
      chain: "solana",
      error: message,
      transaction_signed: false,
      broadcast_attempted: false,
      ready_for_signing: false,
    }, knownBlocker ? 409 : 502);
  }
});
