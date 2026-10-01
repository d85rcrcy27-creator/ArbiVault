import { loadStripe } from '@stripe/stripe-js'

const stripePublicKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY

if (!stripePublicKey) {
  throw new Error('Missing Stripe public key')
}

export const stripePromise = loadStripe(stripePublicKey)
