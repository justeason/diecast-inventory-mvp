import { PrismaClient, Prisma } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// 15K (execution-snapshot pass): shared alias for "the global client OR an open
// transaction" — used by query helpers (14C's advancedValuationQuery.ts,
// externalMarketResearch.ts, pricingIntelligenceQuery.ts) that accept an optional
// trailing client param so a caller holding a transaction (e.g. auto-listing
// execution) can make those reads participate in its own transaction/isolation
// snapshot, while every existing non-transactional caller is unaffected (the param
// defaults to the plain global `prisma` client above).
export type DbClient = PrismaClient | Prisma.TransactionClient
