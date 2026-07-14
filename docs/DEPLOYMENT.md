# Deployment Guide

This document covers the end-to-end setup and deployment process for the CollectNTrades / Diecast Inventory MVP.

---

## Overview

The app is a Next.js application deployed to Vercel, backed by Neon PostgreSQL. It relies on five external services:

| Service | Purpose |
|---|---|
| Vercel | Hosting, Cron, Blob storage |
| Neon PostgreSQL | Primary database |
| Resend | Transactional email |
| Stripe | Checkout Session payments |
| Domain.com DNS | Custom domain routing |

---

## Required services

### Vercel

- Create a Vercel project connected to the GitHub repository.
- Set the production branch to `main`.
- Set all environment variables in the Vercel dashboard (see **Environment variables** below).
- Do not use the Vercel CLI `env pull` command with live secrets — this writes them to disk.

### Neon PostgreSQL

- Create a Neon project and a database.
- Two connection strings are needed: **pooled** (runtime) and **direct** (migrations).
- Both are available in the Neon dashboard → Connection Details.
- Local and production are separate databases. Before running any backfill or data script, verify which database your connection string points to by checking the host or running a row count query.

### Vercel Blob

- In the Vercel dashboard → Storage → Blob, create a store and link it to the project.
- This generates a `BLOB_READ_WRITE_TOKEN` automatically. Copy it into the project's environment variables.
- Required for photo uploads in admin intake. Without it, uploads will fail at runtime.

### Resend

- Create a Resend account and add/verify your sender domain.
- `ORDER_DIGEST_FROM_EMAIL` must be an address on a verified domain.
- Generate an API key from the Resend dashboard and set it as `RESEND_API_KEY`.

### Stripe

- Use the Stripe Dashboard to obtain a secret key (`sk_live_...` for production).
- Register a webhook endpoint (see **Stripe webhook** below) and copy the signing secret.
- The app uses Checkout Sessions with dynamically computed line items derived from order data. No fixed Stripe Price ID is used.

### Domain.com DNS

- The production domain is `https://www.collectntrades.com`.
- Non-www (`collectntrades.com`) redirects to www. This redirect is intentional for end users.
- **Do not** register Stripe webhooks or trust inbound traffic at the non-www URL — redirects can break webhook delivery (see **Stripe webhook** below).

---

## Environment variables

Copy `.env.example` from the project root. Set every variable in the Vercel dashboard under Project → Settings → Environment Variables.

**Important:** When entering values in Vercel, paste only the raw value — not the full `KEY=value` line. Pasting `DATABASE_URL=postgresql://...` as the value will cause the connection to fail.

See `.env.example` for the full variable list, what each one does, and which are required.

---

## Neon database setup

1. Obtain the **pooled** connection string from Neon and set it as `DATABASE_URL`.
2. Obtain the **direct** connection string from Neon and set it as `DIRECT_URL`.
3. Migrations run automatically during the Vercel build step via `prisma migrate deploy` (see **Build command** below). No manual migration step is needed after the first deploy.
4. For local development, you may use a separate local Neon branch or a local PostgreSQL instance. Ensure your local `DATABASE_URL` and `DIRECT_URL` point to the local/dev database — not the production database.
5. Before running any backfill or one-off data script, confirm which database you are connected to by inspecting the host name in the connection string or running a sanity query (`SELECT COUNT(*) FROM "Order"`).

---

## Vercel deployment

### Build command

The `build` script in `package.json` is:

```
prisma generate && prisma migrate deploy && next build
```

This runs on every Vercel build. It generates the Prisma client, applies any pending migrations to the production database, then builds the Next.js app. **Do not remove any step from this command.**

### Deploying

Pushing to `main` triggers an automatic Vercel deployment. If a commit is visible on GitHub but Vercel does not deploy it (e.g. after a forced push or a configuration change), trigger a redeploy with an empty commit:

```bash
git commit --allow-empty -m "chore: trigger Vercel redeploy"
git push origin main
```

### Environment variable changes

Changing an environment variable in the Vercel dashboard does **not** redeploy the app. A new deployment is required for the change to take effect. Use the **Redeploy** button in the Vercel dashboard, or push a new commit.

---

## Canonical production domain

```
https://www.collectntrades.com
```

All email links, magic-link verify URLs, and Stripe success/cancel URLs must use `www`. The `APP_URL` environment variable must be set to `https://www.collectntrades.com` in production (no trailing slash).

---

## Stripe webhook

### Endpoint

Register this exact URL in the Stripe Dashboard → Developers → Webhooks → Add endpoint:

```
https://www.collectntrades.com/api/webhooks/stripe
```

**Do not** use `https://collectntrades.com/api/webhooks/stripe`. The non-www domain returns an HTTP 308 redirect, which Stripe does not follow. If registered without `www`, webhook events will be delivered to a redirecting URL and silently fail.

### Required events

Select exactly these two events when registering the webhook:

- `checkout.session.completed`
- `checkout.session.expired`

No other events are currently handled by the webhook.

### Signing secret

After creating the webhook endpoint, copy the **Signing secret** (`whsec_...`) from the Stripe dashboard and set it as `STRIPE_WEBHOOK_SECRET`.

---

## Vercel Cron

The cron job is defined in `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cron/order-digest",
    "schedule": "0 13 * * *"
  }]
}
```

This runs daily at 1:00 PM UTC. Vercel sends a `Bearer <CRON_SECRET>` Authorization header; the route rejects any request that does not include it. No extra Vercel configuration is needed beyond setting `CRON_SECRET` as an environment variable.

---

## Production smoke test checklist

Run these checks after every production deploy that touches auth, payments, or inventory.

### Public storefront

- [ ] `/browse` loads and shows listings
- [ ] A listing detail page loads

### Admin

- [ ] `/admin` redirects to login when not logged in
- [ ] Admin login with correct password sets session and loads `/admin`
- [ ] `/admin/export/orders` returns 401 when logged out
- [ ] `/admin/export/orders` returns CSV when logged in

### Buyer auth

- [ ] `/account/orders` shows the email request form when not signed in
- [ ] Submitting a valid email shows the "check your email" message
- [ ] The magic-link email arrives and the verify URL loads the confirmation page
- [ ] Clicking "View My Orders" on the verify page signs in and shows order history
- [ ] "Sign out" clears the session and returns to the email form

### Orders and payments

- [ ] An order request can be submitted from the storefront
- [ ] The order appears in `/admin/orders`
- [ ] Admin can generate a Stripe payment link for the order
- [ ] The payment link email arrives with the correct checkout URL
- [ ] Completing the Stripe Checkout flow marks the order `paymentStatus = paid`
- [ ] After Stripe payment, the item's status remains `reserved` (not `sold`)
- [ ] After Stripe payment, the listing remains `active` (not `sold`)
- [ ] Admin completing the order marks the item `sold` and the listing `sold`

### Critical business rule

Stripe payment received does **not** mark an item or listing as sold. Inventory becomes sold only when an admin explicitly completes the order. Verify this after any change to the order, webhook, or inventory code.

---

## Secret safety

Never paste the following values into a chat, GitHub comment, pull request, or any non-secret store:

- `DATABASE_URL` or `DIRECT_URL`
- `ADMIN_PASSWORD`
- `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ANTHROPIC_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `CRON_SECRET`
- Any token, cookie value, or magic-link URL

If a secret is accidentally exposed, rotate it immediately in the relevant service dashboard and update the Vercel environment variables.
