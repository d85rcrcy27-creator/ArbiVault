/**
 * Jupiter Lend Solana flashloan transaction builder for ArbiVault.
 *
 * Dependencies required in the execution environment:
 *   pnpm add @jup-ag/lend @solana/web3.js bn.js
 *
 * This builds an UNSIGNED transaction only. It never loads keys, signs, sends,
 * or claims a route is profitable. Caller-provided custom instructions must
 * enforce on-chain slippage/min-output and repayment/profit constraints.
 *
 * Jupiter Lend flashloans are Solana-only. They cannot be atomically combined
 * with Ethereum or BSC transactions.
 */
import BN from "bn.js";
import { getFlashloanIx } from "@jup-ag/lend/flashloan";
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * @param {object} args
 * @param {import("@solana/web3.js").Connection} args.connection Solana RPC connection.
 * @param {import("@solana/web3.js").PublicKey} args.signer Transaction fee payer / flashloan signer.
 * @param {import("@solana/web3.js").PublicKey} args.asset SPL token mint to borrow.
 * @param {string|number|bigint} args.amountBaseUnits Positive integer in token base units.
 * @param {import("@solana/web3.js").TransactionInstruction[]} args.customInstructions
 *   Custom swap/routing instructions, placed between borrow and payback.
 * @param {number} [args.computeUnitLimit=1000000]
 * @param {import("@solana/web3.js").AddressLookupTableAccount[]} [args.addressLookupTableAccounts=[]]
 * @returns {Promise<{transaction: import("@solana/web3.js").VersionedTransaction, blockhash: string, lastValidBlockHeight: number, instructionOrder: string[]}>}
 */
export async function buildJupiterLendFlashloanTransaction({
  connection,
  signer,
  asset,
  amountBaseUnits,
  customInstructions,
  computeUnitLimit = 1_000_000,
  addressLookupTableAccounts = [],
}) {
  if (!connection || !signer || !asset) {
    throw new Error("connection, signer, and asset are required");
  }
  if (!Array.isArray(customInstructions) || customInstructions.length === 0) {
    throw new Error("At least one explicit custom routing instruction is required");
  }
  if (!Number.isInteger(computeUnitLimit) || computeUnitLimit < 1 || computeUnitLimit > 1_400_000) {
    throw new Error("computeUnitLimit must be an integer from 1 to 1400000");
  }

  const amountString = String(amountBaseUnits);
  if (!/^[1-9][0-9]*$/.test(amountString)) {
    throw new Error("amountBaseUnits must be a positive integer string in base units");
  }

  const { borrowIx, paybackIx } = await getFlashloanIx({
    connection,
    signer,
    asset,
    amount: new BN(amountString, 10),
  });

  // Solana instruction ordering is essential: borrow -> custom logic -> payback.
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    borrowIx,
    ...customInstructions,
    paybackIx,
  ];

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  return {
    transaction: new VersionedTransaction(message),
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    instructionOrder: [
      "compute_budget",
      "jupiter_lend_borrow",
      ...customInstructions.map((_, index) => `custom_route_${index + 1}`),
      "jupiter_lend_payback",
    ],
  };
}
