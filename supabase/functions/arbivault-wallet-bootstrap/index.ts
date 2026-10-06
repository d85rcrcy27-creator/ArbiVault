import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { privateKeyToAccount, generatePrivateKey } from 'npm:viem@2.39.0/accounts'
import * as bitcoin from 'npm:bitcoinjs-lib@7.0.0'
import * as ecc from 'npm:tiny-secp256k1@2.2.3'
import { ECPairFactory } from 'npm:ecpair@3.0.0'
import { Keypair } from 'npm:@solana/web3.js@1.98.4'
const ECPair=ECPairFactory(ecc)
const url=Deno.env.get('SUPABASE_URL')!, serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin=createClient(url,serviceKey)
const auth=(req:Request)=>createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:req.headers.get('Authorization')??''}}})
const json=(x:unknown,s=200)=>Response.json(x,{status:s,headers:{'cache-control':'no-store'}})
async function ensureWallet(userId:string,chain:'bnb'|'solana'|'bitcoin'){
 const {data:existing}=await admin.from('wallets').select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref').eq('owner_id',userId).eq('chain',chain).eq('wallet_role','trading_hot').eq('status','active').maybeSingle()
 if(existing?.secret_ref)return existing
 let address='',secret='',derivation_path:string|null=null
 if(chain==='bnb'){const pk=generatePrivateKey(),account=privateKeyToAccount(pk);address=account.address;secret=pk;derivation_path='internal-random-secp256k1'}
 else if(chain==='solana'){const kp=Keypair.generate();address=kp.publicKey.toBase58();secret=Array.from(kp.secretKey).map(b=>b.toString(16).padStart(2,'0')).join('');derivation_path='internal-random-ed25519'}
 else{const key=ECPair.makeRandom(),payment=bitcoin.payments.p2wpkh({pubkey:Buffer.from(key.publicKey),network:bitcoin.networks.bitcoin});if(!payment.address)throw new Error('bitcoin_address_derivation_failed');address=payment.address;secret=key.toWIF();derivation_path='internal-random-secp256k1-p2wpkh'}
 const {data:wallet,error}=await admin.from('wallets').insert({owner_id:userId,chain,address,label:'ArbiVault '+chain.toUpperCase()+' trading hot wallet',status:'active',is_hot:true,custody_type:'server_vault',wallet_role:'trading_hot',verification_source:'arbivault-wallet-bootstrap',data_quality_status:'verified',derivation_path}).select('id,owner_id,chain,address,label,status,is_hot,custody_type,wallet_role,created_at,secret_ref').single()
 if(error||!wallet)throw new Error(error?.message||'wallet_create_failed')
 const {error:se}=await admin.rpc('store_wallet_secret',{p_wallet_id:wallet.id,p_secret:secret})
 if(se){await admin.from('wallets').delete().eq('id',wallet.id).eq('owner_id',userId);throw new Error('wallet_secret_storage_failed')}
 await admin.rpc('record_reconciliation_event',{p_wallet_id:wallet.id,p_chain:chain,p_tx_hash:null,p_payment_id:null,p_trade_id:null,p_event_type:'wallet_created',p_status:'verified',p_source:'arbivault-wallet-bootstrap',p_details:{custody:'server_vault',wallet_role:'trading_hot'}})
 return wallet
}
async function ensureBindings(userId:string,wallets:any[]){
 const botDefaults=[
  {name:'ArbiVault Execution Bot',strategy:'liquidity_fragmentation',chains:['bnb','solana'],enabled:false,min_profit_threshold:0.50,max_gas_budget:0.01,max_trade_size:10000,slippage_tolerance:0.50,autonomy_enabled:true,autonomy_mode:'observe_only',requires_human_approval:false,max_autonomous_transaction:0,allowed_payment_methods:['crypto','stripe'],bot_role:'execution'},
  {name:'ArbiVault Sync Bot',strategy:'global',chains:['bitcoin','ethereum','bnb','solana'],enabled:true,autonomy_enabled:true,autonomy_mode:'bounded',bot_role:'sync',allowed_payment_methods:['crypto','stripe']},
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
  const {data:adapter}=await admin.from('execution_adapters').select('id').eq('chain',chain).eq('allowed_wallet_id',w.id).eq('signer_provider','internal_vault').maybeSingle()
  const patch={configured:true,health_status:'healthy',read_only:false,signing_boundary:'internal_vault',can_broadcast:true,can_withdraw:false,automatic_signing:true,allowed_wallet_id:w.id,signer_key_ref:w.address,policy_version:'arbivault-internal-v1',last_error:null,updated_at:new Date().toISOString()}
  if(adapter)await admin.from('execution_adapters').update(patch).eq('id',adapter.id)
  else await admin.from('execution_adapters').insert({...patch,name:'ArbiVault Internal Vault '+chain.toUpperCase()+' Trading Signer',adapter_type:'dex_router',endpoint:'supabase://arbivault-signer',chain,signer_provider:'internal_vault',max_transaction_value:0,allowed_contracts:[],allowed_programs:[]})
 }
 return bot
}
Deno.serve(async(req)=>{if(req.method==='OPTIONS')return new Response('ok');if(req.method!=='POST')return json({error:'method_not_allowed'},405);try{const client=auth(req),{data:{user},error}=await client.auth.getUser();if(error||!user)return json({error:'authentication_required'},401);const body=await req.json().catch(()=>({}));const requested=Array.isArray(body.chains)?body.chains:['bnb','solana','bitcoin'];const chains=['bnb','solana','bitcoin'].filter(x=>requested.includes(x)) as ('bnb'|'solana'|'bitcoin')[];const wallets=[];for(const chain of chains)wallets.push(await ensureWallet(user.id,chain));const bot=await ensureBindings(user.id,wallets);return json({ok:true,wallets,bot:{id:bot.id,role:bot.bot_role},signer:{provider:'internal_vault',custody:'server_vault',turnkey_required:false}},201)}catch(e){return json({error:e instanceof Error?e.message:'wallet_bootstrap_failed'},500)}})
