# Architecture Overview

This document describes the technical structure, data flow, and critical business rules of the CollectNTrades / Diecast Inventory MVP.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), TypeScript |
| UI | React 19, Tailwind CSS 4 |
| ORM | Prisma 5 |
| Database | Neon PostgreSQL (serverless) |
| Hosting | Vercel |
| File storage | Vercel Blob |
| Email | Resend |
| Payments | Stripe Checkout Sessions |
| AI extraction | Anthropic Vision API (claude-haiku) |

---

## Route groups

```
src/app/
├── (store)/          # Public storefront — no auth required
│   ├── browse/       # Listing gallery
│   ├── cart/         # Cart page (localStorage-backed)
│   ├── checkout/     # Order submission form
│   ├── order-confirmation/[id]/
│   ├── order-status/ # Single-order lookup by order ID + email
│   └── account/orders/  # Buyer order history (magic-link auth)
│       └── verify/   # Token consumption page (scanner-safe)
│
├── (admin)/admin/    # Protected admin area — requires admin session cookie
│   ├── orders/       # Order management
│   ├── inventory/    # Item and listing management
│   ├── customers/    # Customer profiles
│   ├── intake/       # AI-assisted inventory intake
│   └── export/[type]/  # CSV export (auth required)
│
└── api/
    ├── webhooks/stripe/  # Stripe Checkout webhook (signature verified)
    └── cron/order-digest/  # Daily admin email digest (CRON_SECRET protected)
```

---

## Auth model

### Admin auth

- `ADMIN_PASSWORD` from environment is never stored directly.
- An HMAC-SHA256 of the password (keyed against a fixed string) produces a session token.
- The token is stored in an `httpOnly`, `sameSite: lax` cookie (`admin_session`).
- Middleware (`src/proxy.ts`) protects all `/admin/*` routes by verifying the cookie on every request.
- Route-level auth (`src/lib/adminAuth.ts`) applies `crypto.timingSafeEqual` for cookie comparison — not `===`.

### Buyer auth (magic-link)

1. Buyer submits their email at `/account/orders`.
2. A one-time `CustomerLoginToken` is created: a raw random token is generated, its SHA-256 hash is stored in the database, and the raw token is embedded in a verify URL emailed via Resend.
3. Email scanners and link-preview bots may GET the verify URL. The GET handler performs only a regex format check — it does not query or consume the token.
4. The buyer clicks a button on the verify page. The form POSTs via a Server Action, which atomically consumes the token (`updateMany` with `usedAt = null` guard) and creates a `CustomerSession`.
5. The `CustomerSession` stores a SHA-256 hash of a new random session token. The raw session token is set as an `httpOnly` cookie (`buyer_session`, 7-day max-age).
6. The raw token never exists in the database. The account email is never confirmed or denied to the requesting party — the "check your email" response is always shown.

### Session lookup pattern

- Admin: middleware checks cookie on every request to `/admin/*`.
- Buyer: `getBuyerSession()` is called server-side on pages that require identity. It hashes the cookie value and performs a single DB query. The `profileId` returned is used directly for all DB queries — it is never sourced from request input.

---

## Core business flow

```
Buyer browses listings
  → adds items to localStorage cart
  → submits order request (name, email, notes)
      → ItemInstance status: available → reserved
      → Listing status: stays active
      → Order created with status: pending

Admin reviews order
  → sets estimated shipping
  → generates Stripe Checkout Session (line items from DB order data, not client input)
  → sends payment link email to buyer

Buyer pays via Stripe Checkout
  → Stripe sends checkout.session.completed webhook
  → Webhook marks Order: paymentStatus = paid, status = paid (if still pending)
  → ItemInstance status: stays reserved
  → Listing status: stays active

Admin reviews paid order
  → marks order complete
      → ItemInstance status: reserved → sold
      → Listing status: active → sold
      → Order status: complete
```

---

## Critical business rule

**Stripe payment received ≠ order complete.**
**Stripe payment received ≠ item or listing sold.**

The Stripe webhook handler (`/api/webhooks/stripe`) updates only `Order.paymentStatus` and `Order.status`. It never touches `ItemInstance.status` or `Listing.status`.

Inventory transitions to `sold` only when an admin explicitly marks the order as complete. This is intentional — it allows the admin to cancel or issue refunds after payment but before fulfilment, without corrupting inventory state.

**Do not add logic to the webhook handler that marks items or listings as sold.**

---

## Inventory and listing state model

### ItemInstance status

```
draft → available → reserved → sold
                ↑       |
                └───────┘  (cancel: reserved → available)
```

- `draft`: item entered but not yet listed
- `available`: item visible/active on a listing
- `reserved`: item is in an open, non-cancelled order
- `sold`: item permanently sold (order completed by admin)

### Listing status

```
active → sold
active → archived
```

- `active`: visible on the storefront
- `sold`: no longer available (all items sold)
- `archived`: hidden, not sold

On order creation, the listing stays `active` even though the item is `reserved`. This is intentional — the admin controls when a listing is marked sold, not the checkout flow.

Order cancellation returns ItemInstance to `available` but leaves Listing as `active`.

---

## Cart

- Cart contents are stored in `localStorage` on the client.
- At order creation (Server Action), the server re-fetches all listing prices and availability from the database. Client-submitted prices are never trusted.
- If an item is no longer available, the order is rejected.

---

## Payments

- Stripe Checkout Sessions are created server-side by the admin (not triggered automatically by the buyer's cart).
- Line items are computed from `Order.orderItems` in the database — never from client input.
- Stripe success and cancel URLs include `APP_URL` from the environment.
- Webhook signature is always verified via `stripe.webhooks.constructEvent`. Requests with invalid or missing signatures return 400.
- The app does not use Stripe Elements, custom card forms, or fixed Stripe Price IDs.

---

## Email

All email is sent via Resend.

| Email | Trigger | Sender |
|---|---|---|
| Payment link | Admin generates Stripe link | `ORDER_DIGEST_FROM_EMAIL` |
| Magic-link sign-in | Buyer requests order access | `ORDER_DIGEST_FROM_EMAIL` |
| Admin order digest | Vercel Cron daily at 1pm UTC | `ORDER_DIGEST_FROM_EMAIL` |

Email failures in the buyer magic-link flow are logged but do not expose whether the email address is associated with an account. The "check your email" response is always shown, regardless of whether a profile exists or whether the email sent successfully.

---

## AI-assisted intake

- The admin intake flow accepts photos and uses the Anthropic Vision API to extract item fields (brand, model, series, condition, etc.).
- AI-extracted fields populate the intake form; the admin reviews and corrects before saving.
- If `ANTHROPIC_API_KEY` is not set, the extraction step is skipped silently and the form works manually.
- The AI does not create final inventory records — admin review and explicit save are always required.

---

## Key modules

```
src/
├── proxy.ts                     # Admin middleware (named export `proxy`)
├── lib/
│   ├── prisma.ts                # Prisma client singleton
│   ├── stripe.ts                # Stripe client factory (lazy, validates key)
│   ├── adminAuth.ts             # isAdminAuthenticated() — timingSafeEqual
│   ├── buyerSession.ts          # hashToken, createBuyerSession, getBuyerSession, clearBuyerSession
│   ├── normalizeEmail.ts        # email.toLowerCase().trim()
│   ├── sku.ts                   # SKU generation (DB-assisted)
│   ├── actions/
│   │   ├── auth.ts              # Admin login/logout Server Actions
│   │   ├── buyerAuth.ts         # requestBuyerOrderLink, verifyBuyerLoginToken, signOutBuyer
│   │   ├── stripe.ts            # createStripeCheckoutSession, sendPaymentLinkEmail
│   │   ├── intake.ts            # AI photo extraction, item/listing creation
│   │   └── order.ts             # Order completion, cancellation
│   └── email/
│       ├── magicLinkEmail.ts    # buildMagicLinkEmail() — pure function
│       └── paymentLinkEmail.ts  # buildPaymentLinkEmail() — pure function
```

---

## Deployment assumptions

- Production domain: `https://www.collectntrades.com`
- Migrations run during the Vercel build via `prisma migrate deploy` (part of `npm run build`).
- Local development uses a separate Neon database branch or a local PostgreSQL instance. Production and local databases are not shared.
- `APP_URL` in production must be `https://www.collectntrades.com` (no trailing slash).

---

## Roadmap note

Larger future features — seller intake, collection tracking, pricing assistant, bid/ask marketplace — should not change the payment or inventory rules described above without careful design. In particular:

- The split between "payment received" and "order complete" is a deliberate business rule, not a technical accident.
- Any feature that automatically transitions inventory status should be reviewed against the current state machine before implementation.
