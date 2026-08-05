import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { prisma } from '@/lib/prisma'
import { getEnvStatus } from '@/lib/env'
import { ALGORITHM_VERSION } from '@/lib/catalogImageFingerprint'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'System Health | Admin' }

type DepStatus = { name: string; status: 'ok' | 'fail' | 'unconfigured'; note?: string }

async function checkDb(): Promise<DepStatus> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    return { name: 'Database', status: 'ok' }
  } catch {
    return { name: 'Database', status: 'fail', note: 'connectivity check failed' }
  }
}

function depStatus(name: string, envKey: string): DepStatus {
  return process.env[envKey]
    ? { name, status: 'ok' }
    : { name, status: 'unconfigured' }
}

export default async function SystemHealthPage() {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const [db] = await Promise.all([checkDb()])

  const deps: DepStatus[] = [
    db,
    depStatus('Vercel Blob',    'BLOB_READ_WRITE_TOKEN'),
    depStatus('Email (Resend)', 'RESEND_API_KEY'),
    depStatus('Stripe',         'STRIPE_SECRET_KEY'),
    depStatus('Anthropic AI',   'ANTHROPIC_API_KEY'),
  ]

  const envStatus = getEnvStatus()
  const missingRequired = envStatus.filter(e => e.required && !e.configured)

  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA
  const envName   = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'

  const STATUS_COLORS: Record<string, string> = {
    ok:           'text-green-700 bg-green-50 border-green-200',
    fail:         'text-red-700   bg-red-50   border-red-200',
    unconfigured: 'text-gray-500  bg-gray-50  border-gray-200',
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">System Health</h1>
        <p className="text-sm text-gray-500 mt-1">Operational diagnostics — no secret values shown.</p>
      </div>

      {/* Runtime info */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Runtime</h2>
        <dl className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100 text-sm">
          {[
            ['Environment',          envName],
            ['Commit SHA',           commitSha ? commitSha.slice(0, 12) : 'not available'],
            ['Fingerprint algorithm', ALGORITHM_VERSION],
            ['Node.js',              process.version],
          ].map(([label, value]) => (
            <div key={label} className="flex gap-4 px-4 py-2">
              <dt className="w-52 font-medium text-gray-600 shrink-0">{label}</dt>
              <dd className="font-mono text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Dependency health */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Dependencies</h2>
        <div className="space-y-1.5">
          {deps.map(dep => (
            <div
              key={dep.name}
              className={`flex items-center justify-between rounded-md border px-4 py-2.5 text-sm ${STATUS_COLORS[dep.status]}`}
            >
              <span className="font-medium">{dep.name}</span>
              <span className="capitalize">{dep.status}{dep.note ? ` — ${dep.note}` : ''}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Required env vars */}
      {missingRequired.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">Missing Required Config</h2>
          <ul className="rounded-md border border-red-200 bg-red-50 divide-y divide-red-100 text-sm">
            {missingRequired.map(e => (
              <li key={e.name} className="px-4 py-2 font-mono text-red-700">{e.name}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Optional env summary */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Optional Config</h2>
        <div className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100 text-sm">
          {envStatus.filter(e => !e.required).map(e => (
            <div key={e.name} className="flex items-center justify-between px-4 py-2">
              <span className="font-mono text-gray-600">{e.name}</span>
              <span className={e.configured ? 'text-green-700' : 'text-gray-400'}>
                {e.configured ? 'set' : 'not set'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
