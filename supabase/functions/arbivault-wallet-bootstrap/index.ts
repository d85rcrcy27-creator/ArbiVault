import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { privateKeyToAccount, generatePrivateKey } from 'npm:viem@2.39.0/accounts'
import * as bitcoin from 'npm:bitcoinjs-lib@7.0.0'
import * as ecc from 'npm:tiny-secp256k1@2.2.3'
import { ECPairFactory } from 'npm:ecpair@3.0.0'
import { Keypair } from 'npm:@solana/web3.js@1.98.4'
import { Wallet as XrplWallet } from 'npm:xrpl@4.2.5'
const ECPair=ECPairFactory(ecc)
const BSC_PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E"
const ETH_UNISWAP_V2_ROUTER = "0x7a250d5630B4cf539739dF2C5dAcb4c659F2488D"
const url=Deno.env.get('SUPABASE_URL')!, serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin=createClient(url,serviceKey)
const auth=(req:Request)=>createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:req.headers.get('Authorization')??''}}})
const corsHeaders={
 'Access-Control-Allow-Origin':'https://arbivault.vercel.app',
 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
 'Access-Control-Allow-Methods':'POST, OPTIONS',
 'Vary':'Origin'
}
const json=(x:unknown,s=200)=>Response.json(x,{status:s,headers:{...corsHeaders,'cache-control':'no-store'}})
async function walletAddressHasContractCode(chain:'bnb'|'ethereum',address:string){
 const endpoint=chain==='bnb'?(Deno.env.get('BSC_RPC_URL')||'https://bsc-dataseed.binance.org'):(Deno.env.get('ETHEREUM_RPC_URL')||'https://ethereum-rpc.publicnode.com')
 const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'eth_getCode',params:[address,'latest']})})
 if(!response.ok)throw new Error('wallet_contract_detection_rpc_failed')
 const body=await response.json()
 if(body.error||typeof body.result!=='string')throw new Error('wallet_contract_detection_rpc_failed')
 return body.result!=='0x'&&body.result!=='0x0'
}
function expectedDerivationPath(chain:'bnb'|'solana'|'bitcoin'|'ethereum'|'xrp') {
  if (chain === 'bnb' || chain === 'ethereum') return 'internal-random-secp256k1'
  if (chain === 'solana') return 'internal-random-ed25519'
  if (chain === 'bitcoin') return 'internal-random-secp256k1-p2wpkh'
  return 'internal-random-xrpl-secp256k1'
}

async function getStoredWalletSecret(walletId:string) {
  const {data,error}=await admin.rpc('get_wallet_secret',{p_wallet_id:walletId})
  if(error||typeof data!=='string'||!data)throw new Error('wallet_secret_readback_failed')
  return data
}

function deriveAddressFromSecret(chain:'bnb'|'solana'|'bitcoin'|'ethereum'|'xrp',secret:string) {
  if(chain==='bnb'||chain==='ethereum'){
    if(!/^0x[0-9a-fA-F]{64}$/.test(secret))throw new Error('evm_secret_format_invalid')
    return privateKeyToAccount(secret as `0x${string}`).address
  }
  if(chain==='solana'){
    if(!/^[0-9a-fA-F]{128}$/.test(secret))throw new Error('solana_secret_format_invalid')
    const bytes=Uint8Array.from(secret.match(/.{2}/g)||[],byte=>Number.parseInt(byte,16))
    return Keypair.fromSecretKey(bytes).publicKey.toBase58()
  }
  if(chain==='bitcoin'){
    const key=ECPair.fromWIF(secret,bitcoin.networks.bitcoin)
    const address=bitcoin.payments.p2wpkh({pubkey:key.publicKey,network:bitcoin.networks.bitcoin}).address
    if(!address)throw new Error('bitcoin_address_derivation_failed')
    return address
  }
  return XrplWallet.fromSeed(secret).address
}

function walletAddressesMatch(chain:'bnb'|'solana'|'bitcoin'|'ethereum'|'xrp',expected:string,derived:string) {
  return chain==='bnb'||chain==='ethereum'||chain==='bitcoin'
    ? expected.toLowerCase()===derived.toLowerCase()
    : expected===derived
}

async function disableWalletAdapters(walletId:string,reason:string) {
  const {error}=await admin.from('execution_adapters').update({
    configured:false,
    automatic_signing:false,
    can_broadcast:false,
    read_only:true,
    last_error:reason,
    updated_at:new Date().toISOString()
  }).eq('allowed_wallet_id',walletId)
  if(error)throw new Error('wallet_adapter_fail_closed_update_failed')
}

async function ensureWallet(userId:string,chain:'bnb'|'solana'|'bitcoin'|'ethereum'|'xrp'){
  const derivationPath=expectedDerivationPath(chain)
  const {data:existingRows,error:existingError}=await admin
    .from('wallets')
    .select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref,derivation_path,data_quality_status,verification_source')
    .eq('owner_id',userId)
    .eq('chain',chain)
    .eq('wallet_role','trading_hot')
    .order('created_at',{ascending:false})
    .limit(20)
  if(existingError)throw new Error('trading_wallet_lookup_failed')

  // Prefer the wallet ArbiVault previously generated and stored, rather than
  // silently creating a replacement or redirecting bot bindings to a new address.
  const candidates=(existingRows||[]).filter((wallet:any)=>
    wallet.custody_type==='server_vault' &&
    wallet.verification_source==='arbivault-wallet-bootstrap' &&
    wallet.data_quality_status==='verified' &&
    wallet.secret_ref &&
    wallet.derivation_path===derivationPath
  )
  if(candidates.length>1)throw new Error('multiple_verified_generated_wallets_require_manual_reconciliation')

  let existing=candidates[0]||null
  if(!existing && (existingRows||[]).length>0){
    // Existing records without a uniquely verifiable secret reference must be
    // reconciled in place. Never create a second wallet or move bindings/funds.
    for(const wallet of existingRows||[])await disableWalletAdapters(wallet.id,'wallet_secret_or_provenance_requires_manual_review')
    throw new Error('existing_wallet_requires_secret_and_provenance_verification')
  }

  if(existing){
    if(chain==='bnb'||chain==='ethereum'){
      const contractCodeDetected=await walletAddressHasContractCode(chain,existing.address)
      if(contractCodeDetected){
        await disableWalletAdapters(existing.id,'contract_wallet_requires_safe_adapter_review')
        throw new Error('wallet_address_contains_contract_code_manual_review_required')
      }
    }
    let storedSecret:string
    try{
      storedSecret=await getStoredWalletSecret(existing.id)
    }catch{
      await disableWalletAdapters(existing.id,'wallet_secret_readback_failed')
      throw new Error('wallet_secret_readback_failed')
    }
    let derivedAddress:string
    try{
      derivedAddress=deriveAddressFromSecret(chain,storedSecret)
    }catch{
      await admin.from('wallets').update({status:'quarantined',data_quality_status:'needs_review',updated_at:new Date().toISOString()}).eq('id',existing.id).eq('owner_id',userId)
      await disableWalletAdapters(existing.id,'wallet_secret_derivation_failed')
      throw new Error('wallet_secret_derivation_failed')
    }
    if(!walletAddressesMatch(chain,existing.address,derivedAddress)){
      await admin.from('wallets').update({status:'quarantined',data_quality_status:'needs_review',updated_at:new Date().toISOString()}).eq('id',existing.id).eq('owner_id',userId)
      await disableWalletAdapters(existing.id,'wallet_address_secret_mismatch')
      throw new Error('wallet_address_secret_mismatch')
    }
    if(existing.status==='quarantined' && existing.verification_source!=='arbivault-wallet-bootstrap'){
      throw new Error('quarantined_wallet_requires_manual_reconciliation')
    }
    const {data:verifiedWallet,error:verifyError}=await admin.from('wallets').update({
      status:'active',
      data_quality_status:'verified',
      verification_source:'arbivault-wallet-bootstrap',
      updated_at:new Date().toISOString()
    }).eq('id',existing.id).eq('owner_id',userId)
      .select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref,derivation_path,data_quality_status,verification_source')
      .single()
    if(verifyError||!verifiedWallet)throw new Error('wallet_verification_state_update_failed')
    await admin.rpc('record_reconciliation_event',{
      p_wallet_id:verifiedWallet.id,
      p_chain:chain,
      p_tx_hash:null,
      p_payment_id:null,
      p_trade_id:null,
      p_event_type:'wallet_key_address_verified',
      p_status:'verified',
      p_source:'arbivault-wallet-bootstrap',
      p_details:{custody:'server_vault',secret_ref_saved:true,secret_readback_verified:true,address_secret_match:true,onchain_balance_checked:false,reactivated_from:existing.status}
    })
    return verifiedWallet
  }

  let address='',secret=''
  if(chain==='bnb'||chain==='ethereum'){
    secret=generatePrivateKey()
    address=privateKeyToAccount(secret as `0x${string}`).address
  }else if(chain==='solana'){
    const keypair=Keypair.generate()
    address=keypair.publicKey.toBase58()
    secret=Array.from(keypair.secretKey).map(byte=>byte.toString(16).padStart(2,'0')).join('')
  }else if(chain==='xrp'){
    const xrplWallet=XrplWallet.generate()
    address=xrplWallet.address
    secret=xrplWallet.seed
  }else{
    const key=ECPair.makeRandom()
    const payment=bitcoin.payments.p2wpkh({pubkey:key.publicKey,network:bitcoin.networks.bitcoin})
    if(!payment.address)throw new Error('bitcoin_address_derivation_failed')
    address=payment.address
    secret=key.toWIF()
  }

  const {data:wallet,error}=await admin.from('wallets').insert({
    owner_id:userId,
    chain,
    address,
    label:'ArbiVault '+chain.toUpperCase()+' trading hot wallet',
    status:'quarantined',
    is_hot:true,
    custody_type:'server_vault',
    wallet_role:'trading_hot',
    verification_source:'arbivault-wallet-bootstrap',
    data_quality_status:'needs_review',
    derivation_path:derivationPath
  }).select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref,derivation_path,data_quality_status,verification_source').single()
  if(error||!wallet)throw new Error(error?.message||'wallet_create_failed')

  const {data:secretRef,error:storeError}=await admin.rpc('store_wallet_secret',{p_wallet_id:wallet.id,p_secret:secret})
  if(storeError||!secretRef){
    await admin.from('wallets').update({status:'quarantined',data_quality_status:'needs_review'}).eq('id',wallet.id).eq('owner_id',userId)
    throw new Error('wallet_secret_storage_failed')
  }
  const {error:refError}=await admin.from('wallets').update({secret_ref:secretRef,updated_at:new Date().toISOString()}).eq('id',wallet.id).eq('owner_id',userId)
  if(refError){
    await admin.from('wallets').update({status:'quarantined',data_quality_status:'needs_review'}).eq('id',wallet.id).eq('owner_id',userId)
    throw new Error('wallet_secret_reference_persist_failed')
  }

  let storedSecret:string
  try{
    storedSecret=await getStoredWalletSecret(wallet.id)
  }catch{
    await disableWalletAdapters(wallet.id,'wallet_secret_readback_failed')
    throw new Error('wallet_secret_readback_failed')
  }
  let derivedAddress:string
  try{
    derivedAddress=deriveAddressFromSecret(chain,storedSecret)
  }catch{
    await disableWalletAdapters(wallet.id,'wallet_secret_derivation_failed')
    throw new Error('wallet_secret_derivation_failed')
  }
  if(!walletAddressesMatch(chain,address,derivedAddress)){
    await admin.from('wallets').update({status:'quarantined',data_quality_status:'needs_review'}).eq('id',wallet.id).eq('owner_id',userId)
    await disableWalletAdapters(wallet.id,'wallet_address_secret_mismatch')
    throw new Error('wallet_address_secret_mismatch')
  }

  const {data:verifiedWallet,error:verifyError}=await admin.from('wallets').update({
    status:'active',
    data_quality_status:'verified',
    verification_source:'arbivault-wallet-bootstrap',
    updated_at:new Date().toISOString()
  }).eq('id',wallet.id).eq('owner_id',userId)
    .select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref,derivation_path,data_quality_status,verification_source')
    .single()
  if(verifyError||!verifiedWallet)throw new Error('wallet_verification_state_update_failed')
  await admin.rpc('record_reconciliation_event',{
    p_wallet_id:verifiedWallet.id,
    p_chain:chain,
    p_tx_hash:null,
    p_payment_id:null,
    p_trade_id:null,
    p_event_type:'wallet_created_and_key_address_verified',
    p_status:'verified',
    p_source:'arbivault-wallet-bootstrap',
    p_details:{custody:'server_vault',secret_ref_saved:true,secret_readback_verified:true,address_secret_match:true,onchain_balance_checked:false}
  })
  return verifiedWallet
}
async function ensureBindings(userId:string,wallets:any[]){
 const botDefaults=[
  {name:'ArbiVault Execution Bot',strategy:'liquidity_fragmentation',chains:['bnb','solana','xrp'],enabled:false,min_profit_threshold:0.50,max_gas_budget:0.01,max_trade_size:10000,slippage_tolerance:0.50,autonomy_enabled:true,autonomy_mode:'observe_only',requires_human_approval:false,max_autonomous_transaction:0,allowed_payment_methods:['crypto','stripe'],bot_role:'execution'},
  {name:'ArbiVault Sync Bot',strategy:'global',chains:['bitcoin','ethereum','bnb','solana','xrp'],enabled:true,autonomy_enabled:true,autonomy_mode:'bounded',bot_role:'sync',allowed_payment_methods:['crypto','stripe']},
  {name:'ArbiVault Payment Processing Bot',strategy:'global',chains:['bitcoin','ethereum','bnb','solana'],enabled:true,autonomy_enabled:true,autonomy_mode:'bounded',bot_role:'payment',allowed_payment_methods:['crypto','stripe']}
 ]
 for(const spec of botDefaults){
  const {data:existing,error:findError}=await admin.from('bot_configs').select('id,bot_role,chains').eq('owner_id',userId).eq('bot_role',spec.bot_role).maybeSingle()
  if(findError)throw findError
  if(!existing){
   const {data:created,error:createError}=await admin.from('bot_configs').insert({...spec,owner_id:userId}).select('id,bot_role,chains').single()
   if(createError)throw createError
  }
 }
 const {data:bots,error:be}=await admin.from('bot_configs').select('id,bot_role,chains').eq('owner_id',userId).eq('bot_role','execution').maybeSingle()
 if(be)throw be
 const bot=bots
 if(!bot)throw new Error('execution_bot_not_initialized')
 for(const w of wallets){
  const {data:binding}=await admin.from('bot_wallet_bindings').select('id').eq('owner_id',userId).eq('bot_config_id',bot.id).eq('wallet_id',w.id).eq('role','execution').maybeSingle()
  if(!binding)await admin.from('bot_wallet_bindings').insert({owner_id:userId,bot_config_id:bot.id,wallet_id:w.id,role:'execution'})
  const chain=w.chain
  // Only create adapters for chains supported by the current internal-vault signer.
  // Ethereum is not supported by the deployed signer and must not create a stale blocker row.
  if(!['ethereum','bnb','solana','bitcoin'].includes(chain)) continue
  const {data:adapter}=await admin.from('execution_adapters').select('id').eq('chain',chain).eq('allowed_wallet_id',w.id).eq('signer_provider','internal_vault').maybeSingle()
  const allowedContracts = chain === 'ethereum'
   ? [ETH_UNISWAP_V2_ROUTER]
   : chain === 'bnb' ? [BSC_PANCAKE_V2_ROUTER] : []
  const patch={configured:true,health_status:'healthy',read_only:false,signing_boundary:'internal_vault',can_broadcast:true,can_withdraw:false,automatic_signing:true,allowed_wallet_id:w.id,signer_key_ref:w.address,policy_version:'arbivault-internal-v2',last_error:null,allowed_contracts:allowedContracts,updated_at:new Date().toISOString()}
  if(adapter){
   const {error:updateError}=await admin.from('execution_adapters').update(patch).eq('id',adapter.id)
   if(updateError)throw new Error('signer_adapter_refresh_failed')
  }else{
   const {error:insertError}=await admin.from('execution_adapters').insert({...patch,name:'ArbiVault Internal Vault '+chain.toUpperCase()+' Trading Signer',adapter_type:'dex_router',endpoint:'supabase://arbivault-signer',chain,signer_provider:'internal_vault',max_transaction_value:0,allowed_programs:[]})
   if(insertError)throw new Error('signer_adapter_create_failed')
  }
 }

 const walletByChain=new Map(wallets.map((w:any)=>[w.chain,w]))
 const {data:strategyBots,error:sbe}=await admin
  .from('arbivault_strategy_bots')
  .select('id')
  .eq('owner_id',userId)
  .eq('enabled',true)
  .eq('execution_enabled',true)
 if(sbe)throw sbe

 for(const strategyBot of strategyBots||[]){
  const {data:strategyRoutes,error:sre}=await admin
   .from('arbivault_strategy_routes')
   .select('chain')
   .eq('strategy_bot_id',strategyBot.id)
   .eq('enabled',true)
  if(sre)throw sre
  const chains=[...new Set((strategyRoutes||[]).map((r:any)=>r.chain))]
  for(const chain of chains){
   const wallet=walletByChain.get(chain)||null
   const values={owner_id:userId,strategy_bot_id:strategyBot.id,chain,wallet_id:wallet?.id||null,purpose:'strategy_execution',status:wallet?'assigned':'unassigned',destination_policy:'approved_only',updated_at:new Date().toISOString()}
   const {data:existing,error:ee}=await admin.from('arbivault_strategy_wallets').select('id').eq('strategy_bot_id',strategyBot.id).eq('chain',chain).maybeSingle()
   if(ee)throw ee
   if(existing?.id){
    const {error:e}=await admin.from('arbivault_strategy_wallets').update(values).eq('id',existing.id)
    if(e)throw e
   }else{
    const {error:e}=await admin.from('arbivault_strategy_wallets').insert(values)
    if(e)throw e
   }
  }
 }
 return bot
}
Deno.serve(async(req)=>{if(req.method==='OPTIONS')return new Response('ok',{status:200,headers:corsHeaders});if(req.method!=='POST')return json({error:'method_not_allowed'},405);try{const client=auth(req),{data:{user},error}=await client.auth.getUser();if(error||!user)return json({error:'authentication_required'},401);const body=await req.json().catch(()=>({}));const requested=Array.isArray(body.chains)?body.chains:['bnb','solana','ethereum','bitcoin','xrp'];const chains=['bnb','solana','ethereum','bitcoin','xrp'].filter(x=>requested.includes(x)) as ('bnb'|'solana'|'ethereum'|'bitcoin'|'xrp')[];const wallets=[];for(const chain of chains)wallets.push(await ensureWallet(user.id,chain));const bot=await ensureBindings(user.id,wallets);return json({ok:true,wallets,bot:{id:bot.id,role:bot.bot_role},signer:{provider:'internal_vault',custody:'server_vault',turnkey_required:false}},201)}catch(e){return json({error:e instanceof Error?e.message:'wallet_bootstrap_failed'},500)}})
