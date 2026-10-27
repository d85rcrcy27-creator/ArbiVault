# Mad Man shared revenue stream

The `mad-man-revenue-stream` Edge Function reads the authenticated user's ArbiVault records and, when configured, joins Quantum Lead AI records by exact account email match. It never writes trades, submits paid tasks, or moves funds.

## Required server-side secret

Set `QUANTUM_SUPABASE_SERVICE_ROLE_KEY` as a Supabase Edge Function secret on the **ArbiVault Shared Backend** project. The Quantum Lead AI project URL is the public endpoint already configured in the function. The service-role key must never be added to Vercel client variables or frontend source.

The function returns Quantum as disconnected until the secret is configured and a matching account email exists in both projects. It only counts records with explicit payment / trade confirmation evidence, and currency totals only include records whose currency is explicitly USD.

## Realtime behavior

ArbiVault changes trigger Supabase Realtime refreshes. Quantum Lead AI's source tables are enabled for Realtime in its own backend, while the current dashboard periodically refreshes the cross-project read because the two projects have separate auth and Realtime channels.
