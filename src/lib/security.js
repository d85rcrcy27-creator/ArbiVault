// Local vault lock: a 6-digit PIN, hashed with PBKDF2 and kept client-side only.
// The PIN gates the UI; it is not a Supabase credential, so data access still
// depends on whatever Supabase session AuthContext holds.

const CONFIG_KEY = 'arbivault.security';
const LOCKOUT_KEY = 'arbivault.lockout';
const UNLOCK_KEY = 'arbivault.unlocked';

export const PIN_LENGTH = 6;
export const MAX_ATTEMPTS = 3;
export const LOCKOUT_MS = 30 * 60 * 1000;

// A 6-digit PIN under a single SHA-256 round is brute-forceable in milliseconds;
// PBKDF2 with a random per-PIN salt makes each guess computationally expensive.
const PBKDF2_ITERATIONS = 310_000;

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

// Constant-time compare — prevents leaking the hash through response timing.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

// Hash a PIN for storage as "pbkdf2$<iterations>$<saltB64>$<hashB64>".
export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPin(pin, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterations, salt, hash] = stored.split('$');
  const candidate = await pbkdf2(pin, fromB64(salt), Number(iterations));
  return timingSafeEqual(toB64(candidate), hash);
}

export function getSecurityConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSecurityConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function getLockoutState() {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY);
    return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

export function saveLockoutState(state) {
  localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state));
}

export function resetLockoutState() {
  localStorage.removeItem(LOCKOUT_KEY);
}

// An unlock lasts for the browser tab session.
export function isUnlocked() {
  return sessionStorage.getItem(UNLOCK_KEY) === '1';
}

export function setUnlocked(value) {
  if (value) sessionStorage.setItem(UNLOCK_KEY, '1');
  else sessionStorage.removeItem(UNLOCK_KEY);
}
