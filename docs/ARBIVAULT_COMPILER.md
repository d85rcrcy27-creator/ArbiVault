# ArbiVault Compiler & Repair Guard

The compiler is a fail-closed CI quality gate for the ArbiVault Vite/React application.

## Checks
- TypeScript project check
- ESLint
- Production dependency audit (high severity and above)
- Full production + development dependency audit (high severity and above)
- Vite production build
- Compiled HTML entry asset integrity (detects missing fingerprinted JS/CSS files)
- JSON report with diagnostic heuristics and suggested investigation steps

## Run locally
`pnpm install --frozen-lockfile`
`pnpm doctor`

## Narrow safe autofix
`pnpm doctor:fix` enables ESLint's automatic fixes only, then runs the complete check suite. Review the resulting diff before committing.

## Safety boundaries
- CI never signs, broadcasts, submits, or simulates a live wallet transaction.
- CI does not read wallet secrets or production balances.
- No automated dependency upgrades, schema changes, strategy changes, signer changes, or wallet permission changes.
- A failed check fails the job. Repairs must be reviewed in a branch and pass the entire suite.
- This tool cannot guarantee zero future defects; it continuously detects known classes of issues and records evidence.

## Extending diagnostics
Add deterministic, read-only checks to `scripts/arbivault-compiler.mjs`. Keep checks reproducible and do not add AI-generated patches to the production branch. Any future reasoning/repair agent should create isolated proposals and require all checks plus human approval before merge.
