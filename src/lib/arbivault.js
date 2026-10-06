import { supabase } from '@/lib/supabase'

export async function currentUserId() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  if (!data.user) throw new Error('Authentication required')
  return data.user.id
}

export async function ensureBotFleet() {
  // Force the authenticated Supabase session to be resolved before invoking the RPC.
  // Calling the RPC while the client is still anonymous produces a misleading
  // "permission denied for function" error because EXECUTE is intentionally
  // restricted to authenticated users.
  await currentUserId()
  const { data, error } = await supabase.rpc('ensure_arbivault_bots')
  if (error) throw error
  return data || []
}
export async function listBotFleet() {
  const { data, error } = await supabase.from('bot_configs').select('*').in('bot_role', ['execution','sync','payment']).order('bot_role')
  if (error) throw error
  return data || []
}
export async function updateBotConfig(id, updates) {
  const { data, error } = await supabase.from('bot_configs').update(updates).eq('id', id).select().single()
  if (error) throw error
  return data
}
export async function createBotSkill({ botConfigId = null, name, description = '', conditions = [], actions = [], riskLimits = {}, cooldownSeconds = 30 }) {
  const ownerId = await currentUserId()
  const { data, error } = await supabase.from('bot_skills').insert({ owner_id: ownerId, bot_config_id: botConfigId, name, description, conditions, actions, risk_limits: riskLimits, cooldown_seconds: cooldownSeconds }).select().single()
  if (error) throw error
  return data
}
export async function updateBotSkill(id, updates) {
  const { data, error } = await supabase.from('bot_skills').update(updates).eq('id', id).select().single()
  if (error) throw error
  return data
}
export async function deleteBotSkill(id) {
  const { error } = await supabase.from('bot_skills').delete().eq('id', id)
  if (error) throw error
}
export async function listBotSkills() {
  const { data, error } = await supabase.from('bot_skills').select('*').order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Simulations are explicitly labeled and can never supply a blockchain tx hash.
export async function recordSimulatedTrade(trade) {
  const ownerId = await currentUserId()
  const { data, error } = await supabase.from('trades').insert({ owner_id: ownerId, bot_config_id: trade.botConfigId || null, bot_skill_id: trade.botSkillId || null, chain: trade.chain || 'bnb', strategy: trade.strategy || 'liquidity_fragmentation', pair: trade.pair, notional_amount: trade.notionalAmount ?? null, borrowed_amount: trade.borrowedAmount ?? null, gross_profit: trade.grossProfit ?? null, fees_paid: trade.feesPaid ?? null, net_profit: trade.pnl ?? 0, execution_time_ms: trade.executionTimeMs ?? null, status: 'simulated', execution_mode: 'simulated', tx_hash: null, metadata: { buyExchange: trade.buyExchange, sellExchange: trade.sellExchange, spreadPct: trade.spreadPct } }).select().single()
  if (error) throw error
  return data
}
export async function listTrades(limit = 100) {
  const { data, error } = await supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}
