import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { parseTransaction } from "npm:viem@2.39.0";
import { privateKeyToAccount } from "npm:viem@2.39.0/accounts";
import * as bitcoin from "npm:bitcoinjs-lib@7.0.0";
import * as ecc from "npm:tiny-secp256k1@2.2.3";
import { ECPairFactory } from "npm:ecpair@3.0.0";
import { VersionedTransaction, Transaction, Keypair } from "npm:@solana/web3.js@1.98.4";
const ECPair=ECPairFactory(ecc),supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json=(x:unknown,s=200)=>Response.json(x,{status:s,headers:{"cache-control":"no-store"}});
async function authorized(req:Request){const supplied=req.headers.get("x-arbivault-cron-token");if(!supplied)return false;const {data}=await supabase.rpc("get_bot_cron_token");return !!data&&supplied===data}
async function hash(v:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("")}
async function getSecret(id:string){const {data,error}=await supabase.rpc("get_wallet_secret",{p_wallet_id:id});if(error||!data)throw new Error("wallet_secret_unavailable");return String(data)}
function decode64(v:string){return Uint8Array.from(atob(v),c=>c.charCodeAt(0))}
Deno.serve(async(req)=>{if(req.method!=="POST")return json({error:"method_not_allowed"},405);if(!(await authorized(req)))return json({error:"unauthorized"},401);try{
 const b=await req.json(),adapterId=String(b.adapter_id||""),walletId=String(b.source_wallet_id||""),chain=String(b.chain||"").toLowerCase(),unsigned=String(b.unsigned_transaction||""),mode=b.mode==="transfer"?"transfer":"trade";
 if(!adapterId||!walletId||!unsigned||!["bnb","solana","bitcoin"].includes(chain))return json({error:"invalid_request"},400);
 const {data:adapter,error:ae}=await supabase.from("execution_adapters").select("*").eq("id",adapterId).maybeSingle();if(ae)return json({error:ae.message},500);
 if(!adapter||adapter.configured!==true||adapter.automatic_signing!==true||adapter.can_broadcast!==true||adapter.signer_provider!=="internal_vault")return json({error:"adapter_not_authorized"},403);
 if(adapter.allowed_wallet_id!==walletId||adapter.signing_boundary!=="internal_vault")return json({error:"wallet_not_bound_to_internal_signer"},403);
 const {data:wallet,error:we}=await supabase.from("wallets").select("id,owner_id,chain,address,status,is_hot,wallet_role").eq("id",walletId).maybeSingle();if(we)return json({error:we.message},500);
 if(!wallet||wallet.status!=="active"||wallet.is_hot!==true||wallet.wallet_role!=="trading_hot"||wallet.chain!==chain)return json({error:"source_wallet_not_active_trading_hot"},403);
 if(String(adapter.signer_key_ref||"").toLowerCase()!==String(wallet.address).toLowerCase())return json({error:"signer_wallet_mismatch"},403);
 if(mode==="transfer")return json({error:"withdrawal_requires_human_approval"},403);
 const payloadHash=await hash(unsigned);const {data:reqRow,error:re}=await supabase.from("signing_requests").insert({owner_id:wallet.owner_id,signer_type:"hot_wallet_signer",chain,source_wallet_id:walletId,payload_hash:payloadHash,status:"authorized",biometric_required:false,biometric_verified:false}).select("id").single();if(re)return json({error:re.message},500);
 const sv=await getSecret(walletId);let signed="";
 if(chain==="bnb"){const account=privateKeyToAccount(sv as `0x${string}`),parsed:any=parseTransaction(unsigned as `0x${string}`);if(!parsed.to)return json({error:"contract_creation_not_allowed"},403);if(parsed.from&&parsed.from.toLowerCase()!==wallet.address.toLowerCase())return json({error:"transaction_sender_mismatch"},403);const allowed=Array.isArray(adapter.allowed_contracts)?adapter.allowed_contracts:[];if(allowed.length&&!allowed.some((x:any)=>String(x).toLowerCase()===String(parsed.to).toLowerCase()))return json({error:"destination_contract_not_allowlisted"},403);signed=await account.signTransaction(parsed)}
 else if(chain==="solana"){const raw=decode64(unsigned),kp=Keypair.fromSecretKey(Uint8Array.from((sv.match(/.{1,2}/g)||[]).map(x=>parseInt(x,16))));let tx:any;try{tx=VersionedTransaction.deserialize(raw);tx.sign([kp])}catch{tx=Transaction.from(raw);tx.partialSign(kp)};signed=btoa(String.fromCharCode(...tx.serialize()))}
 else {const psbt=bitcoin.Psbt.fromBase64(unsigned,{network:bitcoin.networks.bitcoin}),key=ECPair.fromWIF(sv,bitcoin.networks.bitcoin);psbt.signAllInputs(key);if(!psbt.validateSignaturesOfAllInputs())return json({error:"bitcoin_signature_validation_failed"},500);psbt.finalizeAllInputs();signed=psbt.toBase64()}
 await supabase.from("signing_requests").update({status:"signed",signed_at:new Date().toISOString()}).eq("id",reqRow.id);await supabase.from("execution_adapters").update({last_signed_at:new Date().toISOString(),health_status:"healthy",last_error:null,updated_at:new Date().toISOString()}).eq("id",adapter.id);
 return json({ok:true,signing_request_id:reqRow.id,provider:"internal_vault",chain,mode,signed_transaction:signed,broadcast:"caller_must_broadcast_after_policy_validation"})
}catch(e){return json({error:e instanceof Error?e.message:"internal_signer_error"},500)}})
