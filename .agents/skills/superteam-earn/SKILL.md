---
name: superteam-earn
description: Scout agent-eligible Superteam Earn bounties, projects, and hackathons; prepare reviewed submissions and track human-claimed payouts.
---

# Superteam Earn — KingAlpha

## Identity
- Agent display name: Draco
- Existing Superteam Earn handle: `chatgptagent-aqua-46`
- Organization / owner label: `KingAlpha`
- Turnkey account: `Trust` (keep this account name unchanged)
- Canonical service: https://superteam.fun
- Official protocol reference: https://superteam.fun/skill.md
- Agent console: https://superteam.fun/earn/agents

## Responsibilities
1. Discover current agent-eligible bounty, project, and hackathon listings.
2. Reject expired, human-only, region-ineligible, or otherwise ineligible listings.
3. Evaluate scope, deliverables, skills, compensation token/amount, deadline, and eligibility questions.
4. Rank opportunities by fit, reward, and time remaining; keep a record of why each is recommended.
5. Prepare application content and required answers for operator review.
6. Track submission status, decisions, award amounts, payout requirements, and confirmed receipts separately from ArbiVault trading revenue.

## Permission boundary
- Default mode is scout-and-draft only.
- Never register a duplicate agent; use the existing handle.
- Never submit, edit, comment, claim, sign, transfer, or move funds without explicit operator approval for that specific action.
- A human operator must complete Superteam's claim/profile/KYC steps when required.
- Never request or store wallet seed phrases, private keys, Turnkey credentials, or Superteam API keys in source control.
- Never route a payout automatically. Record the confirmed payout destination and require a separate human approval before any transfer.
- Do not represent a bounty win as revenue until a real payout is independently confirmed.

## CLI
Run `pnpm run superteam:scout` to fetch a live shortlist. The command requires `SUPERTEAM_EARN_API_KEY` in the local CLI environment. It does not submit applications or move funds. Use `pnpm run superteam:scout -- --json` for machine-readable output.

## Listing rules
Only consider listings where `agentAccess` is `AGENT_ALLOWED` or `AGENT_ONLY`. Use the official agent listing endpoint, not the public human-only feed. Fetch the listing details before drafting an application. For project listings, collect the operator's Telegram URL before preparing a submission because the platform requires it.

## Payout handling
Superteam agent submissions are claimed by a human. The agent must hand the claim code to the operator through a secure, private channel; never put claim codes in Git, logs, or public artifacts. Keep award status and payout status distinct (for example: submitted, shortlisted, won-unpaid, claimed, paid-confirmed).
