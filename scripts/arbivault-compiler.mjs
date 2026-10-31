import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const reportDir = join(root, "artifacts");
mkdirSync(reportDir, { recursive: true });
const results = [];
const run = (name, command, args, options = {}) => {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, ...options });
  const record = { name, command: [command, ...args].join(" "), status: result.status === 0 ? "passed" : "failed", exitCode: result.status, durationMs: Date.now() - started, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  results.push(record);
  console.log(`\n[${record.status.toUpperCase()}] ${name} (${record.durationMs}ms)`);
  if (record.status !== "passed") console.error((record.stderr || record.stdout).slice(-5000));
  return record.status === "passed";
};
const suggestions = (record) => {
  const text = (record.stderr + "\n" + record.stdout).toLowerCase();
  const hints = [];
  if (/cannot find module|failed to resolve import|module not found/.test(text)) hints.push("Check import path, filename casing, package declaration, and lockfile consistency.");
  if (/typescript|ts\d{4}|type error/.test(text)) hints.push("Inspect the first TypeScript diagnostic and repair the source type or interface; do not suppress it globally.");
  if (/eslint|no-unused-vars|react-hooks/.test(text)) hints.push("Apply a narrowly scoped lint fix, then rerun lint and the complete compiler suite.");
  if (/audit|vulnerabilit/.test(text)) hints.push("Review the advisory and dependency path; update the smallest compatible package set and regenerate the lockfile.");
  if (/out of memory|heap/.test(text)) hints.push("Check build memory use and dependency duplication before increasing resource limits.");
  if (/vite|chunk|dynamic import|asset/.test(text)) hints.push("Check Vite output, dynamic import targets, base path, and stale HTML/CDN cache behavior.");
  if (/supabase|edge function|postgres|rls/.test(text)) hints.push("Validate deployed function contracts, schema/migrations, and RLS in a non-production environment.");
  if (/wallet|signer|transaction|rpc|nonce|gas/.test(text)) hints.push("Fail closed: verify chain, signer, nonce, fee estimate, destination and policy; never broadcast from CI.");
  return hints.length ? hints : ["Review the complete command output and fix the underlying cause; do not bypass the check."];
};

if (process.env.ARBIVAULT_ENABLE_SAFE_AUTOFIX === "true") {
  console.log("Safe autofix enabled: ESLint fixes only. No dependency, wallet, strategy, database, or transaction changes.");
  run("Narrow ESLint autofix", "pnpm", ["exec", "eslint", ".", "--fix"]);
}
run("TypeScript", "pnpm", ["typecheck"]);
run("ESLint", "pnpm", ["lint"]);
run("Production dependency audit", "pnpm", ["audit", "--prod", "--audit-level", "high"]);
run("Full dependency audit", "pnpm", ["audit", "--audit-level", "high"]);
run("Vite production compilation", "pnpm", ["build"]);

const distIndex = join(root, "dist", "index.html");
let assetCheck = false;
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, "utf8");
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)].map((m) => m[1]);
  const missing = refs.filter((ref) => !existsSync(join(root, "dist", ref.replace(/^\//, ""))));
  assetCheck = refs.length > 0 && missing.length === 0;
  results.push({ name: "Compiled entry asset integrity", status: assetCheck ? "passed" : "failed", assetReferences: refs, missingAssets: missing });
  console.log(`\n[${assetCheck ? "PASSED" : "FAILED"}] Compiled entry asset integrity: ${refs.length} assets referenced`);
} else {
  results.push({ name: "Compiled entry asset integrity", status: "failed", error: "dist/index.html not found" });
  console.error("\n[FAILED] dist/index.html not found");
}
for (const item of results.filter((x) => x.status === "failed")) item.suggestedNextSteps = suggestions(item);
const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, safeAutofixEnabled: process.env.ARBIVAULT_ENABLE_SAFE_AUTOFIX === "true", summary: { passed: results.filter((x) => x.status === "passed").length, failed: results.filter((x) => x.status === "failed").length }, results };
writeFileSync(join(reportDir, "arbivault-compiler-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\nCompiler summary: ${report.summary.passed} passed, ${report.summary.failed} failed. Report: artifacts/arbivault-compiler-report.json`);
if (report.summary.failed) process.exitCode = 1;
