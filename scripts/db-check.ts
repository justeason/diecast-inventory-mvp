/**
 * Safe database diagnostic — prints counts only, no credentials.
 * Usage: npx tsx scripts/db-check.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  let host = '(unknown)'
  let dbName = '(unknown)'
  try {
    const u = new URL(dbUrl)
    host   = u.hostname
    dbName = u.pathname.replace(/^\//, '') || '(none)'
  } catch { /* unparseable */ }

  const [orderCount, profileCount, nullProfileCount] = await Promise.all([
    prisma.order.count(),
    prisma.customerProfile.count(),
    prisma.order.count({ where: { customerProfileId: null } }),
  ])

  console.log('─── Database connection ───────────────────────────')
  console.log('Host:                        ', host)
  console.log('Database name:               ', dbName)
  console.log('─── Counts ────────────────────────────────────────')
  console.log('Orders (total):              ', orderCount)
  console.log('CustomerProfiles (total):    ', profileCount)
  console.log('Orders with null profileId:  ', nullProfileCount)
  console.log('───────────────────────────────────────────────────')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
