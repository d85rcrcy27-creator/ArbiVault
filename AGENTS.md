# AGENTS.md

## Project Context

ArbiVault — a Vite + React 18 frontend deployed to Vercel. Authentication is Supabase Auth and payments are Stripe. There is no server component: everything is client-side (`src/`), built by Vite into `dist/`.

## Local Development (Base44 sandbox)

- `docker compose -f docker-compose.base44.yml up -d` starts the dev server on host port 3000.
- The container runs `pnpm install --frozen-lockfile` then `pnpm dev`. Source is bind-mounted; edits hot-reload.
- `vite.config.js` sets `server.host: true` (required so Docker's published port can reach the dev server). The preview host is allowed via the platform-provided `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`.

## Environment

- `.env.base44-defaults` holds non-secret development placeholders so the app boots without credentials.
- Real values (Supabase URL/anon key, Stripe public key) are delivered to `/run/base44/app.env`, which is listed last in compose `env_file` so it overrides the defaults.
- Vite only exposes variables prefixed with `VITE_` to client code.

## Build

- `pnpm build` (Vite). Vercel runs `pnpm install --frozen-lockfile` + `pnpm build` per `vercel.json`.
- The lockfile must stay in sync with `package.json` or both the Vercel build and the frozen install fail — after changing dependencies run `pnpm install --no-frozen-lockfile` to regenerate `pnpm-lock.yaml`.
- `build.minify` is `terser`, so `terser` must remain a devDependency.
- `build.rollupOptions.output.manualChunks` must be a **function** (Vite 8 / rolldown rejects the object form).

## Vault lock (login)

- `/login` is the biometric + PIN unlock screen (`src/pages/LockScreen.jsx`), not an email/password form. It gates the app through `AuthContext.isUnlocked` (see `src/components/ProtectedRoute.jsx`).
- First run has no stored config, so the screen shows PIN creation. `src/lib/security.js` stores the PIN in `localStorage` under `arbivault.security` as PBKDF2-SHA256 (310k iterations, random salt, format `pbkdf2$<iter>$<saltB64>$<hashB64>`); `verifyPin` also accepts the legacy unsalted SHA-256 format and transparently re-stores it as PBKDF2 on first successful unlock.
- `src/components/wallet/WalletActions.jsx` is the wallet action bar on Home (Send, Receive, Swap, Trade, Bridge, Buy, Withdraw, TX Hash). Actions are simulated like the rest of the live feed — no real keys or chain calls.
- Biometric uses the platform authenticator (WebAuthn). It is unavailable inside a cross-origin iframe, so the sandbox preview falls back to PIN only — test biometric on the deployed site.
- Three wrong PINs lock the vault for 30 minutes (`arbivault.lockout`); a successful unlock lasts for the tab session (`sessionStorage.arbivault.unlocked`).
- Supabase auth (`src/lib/AuthContext.jsx`, `/register`, `/forgot-password`, `/reset-password`) still exists but no longer gates the app.

## Quirks

- `src/lib/supabase.js` and `src/lib/stripe.js` throw at import time when their `VITE_*` variables are missing — the app will not render without the placeholders or real values.
- Several source files in this repo were generated truncated mid-expression by an earlier tool and had to be completed by hand (`src/pages/{Home,Login,Register}.jsx`, `src/hooks/useLiveMarketData.js`, `src/components/arbitrage/{PulseMatrix,TradeLog,TradeRow,SpreadDepthChart}.jsx`, `src/lib/utils.js`, `src/lib/app-params.js`). If a file ends mid-JSX or exports the wrong symbol, it is one of these.
- `src/lib/utils.js` must export `cn` (clsx + tailwind-merge) — every `src/components/ui/*` primitive imports it.

## Verification

- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` → `200`.
- `docker compose -f docker-compose.base44.yml exec -T web sh -c "cd /app && pnpm build"` → succeeds.
