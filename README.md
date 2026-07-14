# Diecast Inventory MVP — CollectNTrades

A Next.js inventory and order management system for a diecast model car shop. Buyers browse listings and submit order requests; admins manage inventory, generate Stripe payment links, and track orders through fulfilment.

See also:
- [Architecture overview](docs/ARCHITECTURE.md) — stack, auth model, business rules, state machines
- [Deployment guide](docs/DEPLOYMENT.md) — environment setup, Vercel, Neon, Stripe, Resend
- [Environment variables](.env.example) — annotated template for all required variables

## Local development

```bash
npm install
cp .env.example .env.local   # fill in real values
npx prisma generate
npm run dev
```

## Build

```bash
npm run build   # prisma generate + prisma migrate deploy + next build
```
