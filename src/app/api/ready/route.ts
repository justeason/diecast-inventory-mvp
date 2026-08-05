import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isCriticalEnvReady } from '@/lib/env'
import { normalizeError } from '@/lib/errors'
import { getRequestId } from '@/lib/requestId'

export const dynamic = 'force-dynamic'

const DB_TIMEOUT_MS  = 5_000
const BLOB_HOSTNAME_RE = /^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/

type CheckResult = { name: string; status: 'ok' | 'fail'; detail?: string }

async function checkDatabase(requestId?: string): Promise<CheckResult> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`DB timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS)
      ),
    ])
    return { name: 'database', status: 'ok' }
  } catch (e) {
    normalizeError(e, { event: 'readiness.db_check_failed', route: '/api/ready', requestId })
    return { name: 'database', status: 'fail', detail: 'connectivity check failed' }
  }
}

function checkEnv(): CheckResult {
  return isCriticalEnvReady()
    ? { name: 'env', status: 'ok' }
    : { name: 'env', status: 'fail', detail: 'required variables missing' }
}

function checkBlobConfig(): CheckResult {
  const hostname = process.env.BLOB_TRUSTED_HOSTNAME ?? ''
  if (!hostname) return { name: 'blob', status: 'ok', detail: 'not configured (optional)' }
  const valid = BLOB_HOSTNAME_RE.test(hostname.toLowerCase().trim())
  return valid
    ? { name: 'blob', status: 'ok' }
    : { name: 'blob', status: 'fail', detail: 'BLOB_TRUSTED_HOSTNAME format invalid' }
}

export async function GET() {
  const requestId = await getRequestId()
  const [db, env, blob] = await Promise.all([
    checkDatabase(requestId),
    Promise.resolve(checkEnv()),
    Promise.resolve(checkBlobConfig()),
  ])

  const checks: CheckResult[] = [db, env, blob]
  const allOk = checks.every(c => c.status === 'ok')

  return NextResponse.json(
    { ready: allOk, checks },
    { status: allOk ? 200 : 503 },
  )
}
