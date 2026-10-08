import { getAuthenticatedSession, supabase } from '@/lib/supabase'

export async function currentUserId() {
  const session = await getAuthenticatedSession()
  if (!session?.user) throw new Error('Auth session missing: please sign in again')
  const { data, error } = await supabase.auth.getUser(session.access_token)
  if (error || !data.user) throw new Error(`Auth session missing: ${error?.message || 'user not found'}`)
  return data.user.id
}

export async function ensureBotFleet() {
  // Let supabase-js attach the current JWT to the RPC request. The database
  // function itself derives auth.uid(), avoiding a second client-side
  // getSession/refresh race immediately before the RPC.
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
export async function createBotSkill({ botConfigId = null, name, description = '', conditions = [], actions = [], riskLimits = {}, cooldownSeconds = 30, strategyFamily = null, dataSources = [], observationOnly = true, discoveryEnabled = false }) {
  const ownerId = await currentUserId()
  const { data, error } = await supabase.from('bot_skills').insert({
    owner_id: ownerId,
    bot_config_id: botConfigId,
    name,
    description,
    conditions,
    actions,
    risk_limits: riskLimits,
    cooldown_seconds: cooldownSeconds,
    strategy_family: strategyFamily,
    data_sources: dataSources,
    observation_only: observationOnly,
    discovery_enabled: discoveryEnabled,
  }).select().single()
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


export async function scoutPublicData({ sources = [], skillId = null, persist = false, params = {} } = {}) {
  const { data, error } = await supabase.functions.invoke('arbivault-public-scout', {
    body: { sources, skill_id: skillId, persist, params },
  })
  if (error) throw error
  return data
}


export async function addApprovedDestination({ chain, address, label, makePrimary = false }) {
  const { data, error } = await supabase.functions.invoke('arbivault-withdrawal-request', {
    body: { action: 'add_destination', chain, address, label, make_primary: makePrimary },
  })
  if (error) throw error
  if (!data?.ok) throw new Error(data?.error || 'Unable to add destination')
  return data
}

export async function activateApprovedDestination(destinationId, makePrimary = false) {
  const { data, error } = await supabase.functions.invoke('arbivault-withdrawal-request', {
    body: { action: 'activate_destination', destination_id: destinationId, make_primary: makePrimary },
  })
  if (error) throw error
  if (!data?.ok) throw new Error(data?.error || 'Unable to activate destination')
  return data
}

export async function createWithdrawal({ sourceWalletId, destinationId, amount, asset }) {
  const { data, error } = await supabase.functions.invoke('arbivault-withdrawal-request', {
    body: {
      action: 'create_withdrawal',
      source_wallet_id: sourceWalletId,
      destination_id: destinationId,
      amount: Number(amount),
      asset,
    },
  })
  if (error) throw error
  if (!data?.ok) throw new Error(data?.error || 'Unable to create withdrawal')
  return data
}
