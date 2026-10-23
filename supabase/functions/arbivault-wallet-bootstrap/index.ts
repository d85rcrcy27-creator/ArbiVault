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
async function ensureWallet(userId:string,chain:'bnb'|'solana'|'bitcoin'|'ethereum'|'xrp'){
 const {data:activeRows,error:existingError}=await admin.from('wallets').select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref').eq('owner_id',userId).eq('chain',chain).eq('wallet_role','trading_hot').eq('status','active').order('created_at',{ascending:false}).limit(2)
 if(existingError)throw new Error('active_wallet_lookup_failed:'+String(existingError.code||'db_error'))
 if((activeRows||[]).length>1)throw new Error('multiple_active_trading_wallets_detected:'+chain)
 const existing=(activeRows||[])[0]||null
 let replacedWalletId:string|null=null
 let contractCodeDetected=false
 if(existing?.address&&(chain==='bnb'||chain==='ethereum'))contractCodeDetected=await walletAddressHasContractCode(chain,existing.address)
 if(existing?.secret_ref&&!contractCodeDetected)return existing
 if(existing?.id){
  replacedWalletId=existing.id
  const {error:quarantineError}=await admin.from('wallets').update({status:'quarantined'}).eq('id',existing.id).eq('owner_id',userId)
  if(quarantineError)throw new Error('wallet_orphan_quarantine_failed')
 }
 let address='',secret='',derivation_path:string|null=null
 if(chain==='bnb'||chain==='ethereum'){const pk=generatePrivateKey(),account=privateKeyToAccount(pk);address=account.address;secret=pk;derivation_path='internal-random-secp256k1'}
 else if(chain==='solana'){const kp=Keypair.generate();address=kp.publicKey.toBase58();secret=Array.from(kp.secretKey).map(b=>b.toString(16).padStart(2,'0')).join('');derivation_path='internal-random-ed25519'}
 else if(chain==='xrp'){const xrplWallet=XrplWallet.generate();if(!xrplWallet.seed)throw new Error('xrp_seed_generation_failed');address=xrplWallet.address;secret=xrplWallet.seed;derivation_path='internal-random-xrpl-secp256k1'}
 else{const key=ECPair.makeRandom(),payment=bitcoin.payments.p2wpkh({pubkey:key.publicKey,network:bitcoin.networks.bitcoin});if(!payment.address)throw new Error('bitcoin_address_derivation_failed');address=payment.address;secret=key.toWIF();derivation_path='internal-random-secp256k1-p2wpkh'}
 const {data:wallet,error}=await admin.from('wallets').insert({owner_id:userId,chain,address,label:'ArbiVault '+chain.toUpperCase()+' trading hot wallet',status:'active',is_hot:true,custody_type:'server_vault',wallet_role:'trading_hot',verification_source:'arbivault-wallet-bootstrap',data_quality_status:'verified',derivation_path}).select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref').single()
 if(error||!wallet)throw new Error(error?.message||'wallet_create_failed')
 const {data:secretRef,error:se}=await admin.rpc('store_wallet_secret',{p_wallet_id:wallet.id,p_secret:secret})
 if(se||!secretRef){
  await admin.from('wallets').update({status:'quarantined'}).eq('id',wallet.id).eq('owner_id',userId)
  throw new Error('wallet_secret_storage_failed')
 }
 const {error:refError}=await admin.from('wallets').update({secret_ref:secretRef,updated_at:new Date().toISOString()}).eq('id',wallet.id).eq('owner_id',userId)
 if(refError){
  await admin.from('wallets').update({status:'quarantined'}).eq('id',wallet.id).eq('owner_id',userId)
  throw new Error('wallet_secret_reference_persist_failed')
 }
 if(replacedWalletId){
  const {error:bindingError}=await admin.from('bot_wallet_bindings').update({wallet_id:wallet.id}).eq('owner_id',userId).eq('wallet_id',replacedWalletId)
  if(bindingError)throw new Error('wallet_binding_rotation_failed')
  const {error:adapterError}=await admin.from('execution_adapters').update({configured:false,automatic_signing:false,can_broadcast:false,last_error:contractCodeDetected?'wallet_address_contains_contract_code':'wallet_secret_reference_missing',updated_at:new Date().toISOString()}).eq('allowed_wallet_id',replacedWalletId)
  if(adapterError)throw new Error('old_wallet_signer_disable_failed')
 }
 await admin.rpc('record_reconciliation_event',{p_wallet_id:wallet.id,p_chain:chain,p_tx_hash:null,p_payment_id:null,p_trade_id:null,p_event_type:'wallet_created',p_status:'verified',p_source:'arbivault-wallet-bootstrap',p_details:{custody:'server_vault',wallet_role:'trading_hot',secret_ref_saved:true,replaced_wallet_id:replacedWalletId,rotation_reason:contractCodeDetected?'contract_code_detected':'missing_secret_reference'}})
 return wallet
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
  const patch={configured:false,health_status:'unconfigured',read_only:true,signing_boundary:'internal_vault',can_broadcast:false,can_withdraw:false,automatic_signing:false,allowed_wallet_id:w.id,signer_key_ref:w.address,policy_version:'arbivault-internal-v3-pending-approval',last_error:'awaiting_explicit_wallet_approval_and_verified_executor',allowed_contracts:allowedContracts,allowed_programs:[],max_transaction_value:0,updated_at:new Date().toISOString()}
  if(adapter){
   const {error:updateError}=await admin.from('execution_adapters').update(patch).eq('id',adapter.id)
   if(updateError)throw new Error('signer_adapter_refresh_failed')
  }else{
   const adapterName='ArbiVault Internal Vault '+chain.toUpperCase()+' Trading Signer'
   const {error:insertError}=await admin.from('execution_adapters').insert({...patch,name:adapterName,adapter_type:'dex_router',endpoint:'supabase://arbivault-signer',chain,signer_provider:'internal_vault',max_transaction_value:0,allowed_programs:[]})
   if(insertError){
    // Recover idempotently from a concurrent insert or the table's unique-name constraint.
    const {data:byName,error:lookupError}=await admin.from('execution_adapters').select('id').eq('name',adapterName).maybeSingle()
    if(lookupError||!byName)throw new Error('signer_adapter_create_failed')
    const {error:refreshError}=await admin.from('execution_adapters').update(patch).eq('id',byName.id)
    if(refreshError)throw new Error('signer_adapter_refresh_failed')
   }
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

async function verifyExistingWalletKeys(userId:string, requestedIds:string[]){
 const targets:any={
  'aaf3f8c2-0a5a-4a9a-ad58-1ec503fe0c94':{chain:'bitcoin',address:'bc1qnghkuy4nktkxtkau9u8hn06h02te3my33m8cun'},
  '43a50a7d-f018-4d36-9ada-5dd7e02efe47':{chain:'bnb',address:'0xEa37838f3361b80601756f7B0D770A5F5f38c486'},
  '509ca4ab-bc96-4e2c-a257-ff44a8beb8d1':{chain:'solana',address:'3r8sJEVtWs5DAr7EntqmFZdJ7PENVkiNRDUtpJb4b3JF'}
 }
 if(requestedIds.length===0||requestedIds.some(id=>!targets[id]))throw new Error('wallet_id_not_allowlisted')
 const results=[]
 for(const id of requestedIds){
  const expected=targets[id]
  const {data:w,error:we}=await admin.from('wallets').select('id,owner_id,chain,address,status,custody_type,secret_ref').eq('id',id).maybeSingle()
  if(we||!w||w.owner_id!==userId){results.push({wallet_id:id,chain:expected.chain,address:expected.address,key_match:false,result:'wallet_not_found_or_not_owned'});continue}
  if(w.chain!==expected.chain||w.address!==expected.address||w.status!=='active'||w.custody_type!=='server_vault'){results.push({wallet_id:id,chain:expected.chain,address:expected.address,key_match:false,result:'wallet_record_mismatch_or_inactive'});continue}
  if(!w.secret_ref){results.push({wallet_id:id,chain:expected.chain,address:expected.address,key_match:false,result:'secret_reference_missing'});continue}
  const {data:secret,error:se}=await admin.rpc('get_wallet_secret',{p_wallet_id:id})
  if(se||typeof secret!=='string'||!secret){results.push({wallet_id:id,chain:expected.chain,address:expected.address,key_match:false,result:'vault_secret_unavailable'});continue}
  try{
   let keyMatch=false
   if(expected.chain==='bnb'){
    const normalized=secret.startsWith('0x')?secret:'0x'+secret
    keyMatch=privateKeyToAccount(normalized as `0x${string}`).address.toLowerCase()===expected.address.toLowerCase()
   }else if(expected.chain==='solana'){
    if(/^(?:[0-9a-fA-F]{2})+$/.test(secret)){
     const bytes=Uint8Array.from((secret.match(/.{2}/g)||[]).map((x:string)=>Number.parseInt(x,16)))
     keyMatch=Keypair.fromSecretKey(bytes).publicKey.toBase58()===expected.address
    }
   }else if(expected.chain==='bitcoin'){
    const key=ECPair.fromWIF(secret,bitcoin.networks.bitcoin)
    const network=bitcoin.networks.bitcoin
    const p2wpkh=bitcoin.payments.p2wpkh({pubkey:key.publicKey,network})
    const possible=[bitcoin.payments.p2pkh({pubkey:key.publicKey,network}).address,p2wpkh.address,bitcoin.payments.p2sh({redeem:p2wpkh,network}).address].filter((x:any):x is string=>typeof x==='string')
    keyMatch=possible.includes(expected.address)
   }
   results.push({wallet_id:id,chain:expected.chain,address:expected.address,key_match:keyMatch,result:keyMatch?'match':'address_mismatch'})
  }catch{
   results.push({wallet_id:id,chain:expected.chain,address:expected.address,key_match:false,result:'secret_format_or_derivation_error'})
  }
 }
 return {ok:results.every((r:any)=>r.key_match),verification_scope:'private-key-to-public-address correspondence only; no chain balance check; no signing or broadcast',checked_at:new Date().toISOString(),results}
}

Deno.serve(async(req)=>{if(req.method==='OPTIONS')return new Response('ok',{status:200,headers:corsHeaders});if(req.method!=='POST')return json({error:'method_not_allowed'},405);try{const client=auth(req),{data:{user},error}=await client.auth.getUser();if(error||!user)return json({error:'authentication_required'},401);const body=await req.json().catch(()=>({}));if(body?.mode==='verify_keys'){const ids=Array.isArray(body.wallet_ids)?body.wallet_ids.map(String):['aaf3f8c2-0a5a-4a9a-ad58-1ec503fe0c94','43a50a7d-f018-4d36-9ada-5dd7e02efe47','509ca4ab-bc96-4e2c-a257-ff44a8beb8d1'];try{return json(await verifyExistingWalletKeys(user.id,ids))}catch(e){return json({error:e instanceof Error?e.message:'wallet_key_verification_failed'},400)}}const requested=Array.isArray(body.chains)?body.chains:['bnb','solana','ethereum','bitcoin','xrp'];const chains=['bnb','solana','ethereum','bitcoin','xrp'].filter(x=>requested.includes(x)) as ('bnb'|'solana'|'ethereum'|'bitcoin'|'xrp')[];const wallets=[];for(const chain of chains)wallets.push(await ensureWallet(user.id,chain));const bot=await ensureBindings(user.id,wallets);return json({ok:true,wallets,bot:{id:bot.id,role:bot.bot_role},signer:{provider:'internal_vault',custody:'server_vault',turnkey_required:false}},201)}catch(e){return json({error:e instanceof Error?e.message:'wallet_bootstrap_failed'},500)}})
