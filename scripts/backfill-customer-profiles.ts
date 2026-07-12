/**
 * ONE-TIME BACKFILL SCRIPT
 *
 * Links existing orders to CustomerProfile records created from their buyerEmail.
 *
 * Idempotent: only processes orders where customerProfileId IS NULL.
 * Safe to re-run if interrupted, but intended to be run once after the
 * add_customer_profiles migration.
 *
 * Usage:
 *   npx tsx scripts/backfill-customer-profiles.ts
 *
 * Requires DATABASE_URL and DIRECT_URL in .env (same as the app).
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { customerProfileId: null },
    select: { id: true, buyerEmail: true, buyerName: true, buyerPhone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`Found ${orders.length} orders without a customer profile.`)
  if (orders.length === 0) {
    console.log('Nothing to do.')
    return
  }

  // Group by normalized email; skip blank or invalid emails
  const groups = new Map<string, typeof orders>()
  let skipped = 0

  for (const order of orders) {
    const normalized = normalizeEmail(order.buyerEmail ?? '')
    if (!normalized || !normalized.includes('@')) {
      console.warn(`  [SKIP] order ${order.id}: invalid email "${order.buyerEmail}"`)
      skipped++
      continue
    }
    const group = groups.get(normalized) ?? []
    group.push(order)
    groups.set(normalized, group)
  }

  console.log(`Processing ${groups.size} unique email(s), skipping ${skipped} invalid.`)

  let linked = 0
  for (const [email, groupOrders] of groups) {
    // Use the most recent order's name/phone (most current contact info)
    const latest = groupOrders[groupOrders.length - 1]

    const profile = await prisma.customerProfile.upsert({
      where:  { email },
      update: { name: latest.buyerName, phone: latest.buyerPhone ?? null },
      create: { email, name: latest.buyerName, phone: latest.buyerPhone ?? null },
      select: { id: true },
    })

    const ids = groupOrders.map((o) => o.id)
    await prisma.order.updateMany({
      where: { id: { in: ids }, customerProfileId: null },
      data:  { customerProfileId: profile.id },
    })

    linked += ids.length
    console.log(`  [${email}] profile ${profile.id} → ${ids.length} order(s)`)
  }

  console.log(`\nDone. Linked ${linked} order(s) to ${groups.size} customer profile(s).`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
