# ArbiVault

A modern arbitrage vault trading platform built with React, Vite, Supabase, and Stripe.

## Stack

- **Frontend**: Vite + React 18
- **Hosting**: Vercel
- **Authentication**: Supabase Auth
- **Database**: Supabase PostgreSQL
- **Payments**: Stripe
- **Styling**: Tailwind CSS + Radix UI

## Prerequisites

- Node.js 20.19.0 or higher
- pnpm 10.17.1 or higher
- Supabase project
- Stripe account

## Setup

1. Clone the repository
   ```bash
   git clone https://github.com/d85rcrcy27-creator/ArbiVault.git
   cd ArbiVault
   ```

2. Install dependencies
   ```bash
   pnpm install
   ```

3. Configure environment variables
   ```bash
   cp .env.example .env.local
   ```
   
   Add your credentials:
   - `VITE_SUPABASE_URL`: Your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY`: Your Supabase anonymous key
   - `VITE_STRIPE_PUBLIC_KEY`: Your Stripe publishable key

4. Start development server
   ```bash
   pnpm dev
   ```

5. Build for production
   ```bash
   pnpm build
   ```

6. Preview production build
   ```bash
   pnpm preview
   ```

## Scripts

- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Fix linting issues
- `pnpm typecheck` - Run TypeScript checks
- `pnpm preview` - Preview production build

## Security

- All environment variables are prefixed with `VITE_` and exposed only to frontend
- Never commit `.env.local` or secrets
- Use Supabase RLS policies for database security
- All API calls use HTTPS
- Stripe integration uses secure tokenization

## Deployment

The app is configured for Vercel deployment:

1. Push to GitHub
2. Connect repo to Vercel
3. Add environment variables in Vercel dashboard
4. Deploy automatically on push to main

## Architecture

### Frontend (Vercel)
- Static SPA built with Vite
- React Router for client-side routing
- TanStack Query for server state
- Supabase client for API calls

### Backend (Supabase)
- PostgreSQL database
- Authentication with JWT
- Realtime subscriptions
- Edge functions for server logic

### Payments (Stripe)
- Stripe.js for secure payment processing
- Webhook handlers for payment events

## License

GPL-3.0
