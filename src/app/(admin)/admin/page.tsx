import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getCommandCenterData } from '@/lib/adminOperationsQuery'
import { activeAttentionItems, attentionBand, type AttentionItemCode } from '@/lib/adminOperations'

export const dynamic = 'force-dynamic'

// 15H: the admin homepage is the daily operations command center — Needs Attention,
// then Work Queues, then a small Business Pulse strip (Part B/E). It intentionally
// does NOT lead with GMV/charts, and every card here is a read-only link into an
// existing authoritative workflow (Part J section 34) — nothing on this page can
// resolve an exception, approve a request, mark a payout paid, or list an item.

export default async function AdminDashboardPage() {
  const [data, locationCount, catalogCount, totalItems, activeListings] = await Promise.all([
    getCommandCenterData(),
    prisma.storageLocation.count(),
    prisma.catalogModel.count(),
    prisma.itemInstance.count(),
    prisma.listing.count({ where: { status: 'active' } }),
  ])

  const showSetup = locationCount === 0 || catalogCount === 0 || totalItems === 0 || activeListings === 0
  const attentionItems = activeAttentionItems(data.needsAttention)

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Admin Operations</h1>
      <p className="text-sm text-gray-500 mb-6">What needs attention right now.</p>

      {showSetup && (
        <SetupChecklist
          locationCount={locationCount}
          catalogCount={catalogCount}
          totalItems={totalItems}
          activeListings={activeListings}
        />
      )}

      {/* ── Needs Attention ─────────────────────────────────────────────────── */}
      <Section title="Needs Attention">
        {attentionItems.length === 0 ? (
          <HealthyState text="No urgent items need attention." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {attentionItems.map((item) => (
              <AttentionCard key={item.code} {...item} />
            ))}
          </div>
        )}
      </Section>

      {/* ── Work Queues ──────────────────────────────────────────────────────── */}
      <Section title="Work Queue">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <QueueCard
            label="Ready for Intake"
            primary={`${data.workQueues.readyForIntake.shipments} shipment${data.workQueues.readyForIntake.shipments !== 1 ? 's' : ''}`}
            secondary={`${data.workQueues.readyForIntake.units} recorded unit${data.workQueues.readyForIntake.units !== 1 ? 's' : ''}`}
            href={data.workQueues.readyForIntake.href}
            emptyText="No shipments are ready for intake."
            isEmpty={data.workQueues.readyForIntake.shipments === 0}
          />
          <QueueCard
            label="Intake In Progress"
            primary={`${data.workQueues.intakeInProgress.shipments} shipment${data.workQueues.intakeInProgress.shipments !== 1 ? 's' : ''}`}
            href={data.workQueues.intakeInProgress.href}
            emptyText="No intake currently in progress."
            isEmpty={data.workQueues.intakeInProgress.shipments === 0}
          />
          <QueueCard
            label="Available, Not Listed"
            primary={`${data.workQueues.availableNotListed.count} item${data.workQueues.availableNotListed.count !== 1 ? 's' : ''}`}
            href={data.workQueues.availableNotListed.href}
            emptyText="Everything available is already listed."
            isEmpty={data.workQueues.availableNotListed.count === 0}
            footerHref={data.workQueues.availableNotListed.readinessHref}
            footerLabel="Review Listing Readiness →"
          />
          <QueueCard
            label="Open Orders"
            primary={`${data.workQueues.openOrders.count} order${data.workQueues.openOrders.count !== 1 ? 's' : ''}`}
            href={data.workQueues.openOrders.href}
            emptyText="No open orders."
            isEmpty={data.workQueues.openOrders.count === 0}
          />
          <QueueCard
            label="Payout Ready"
            primary={`${data.workQueues.payoutReady.count} payout${data.workQueues.payoutReady.count !== 1 ? 's' : ''}`}
            href={data.workQueues.payoutReady.href}
            emptyText="No payouts ready to send."
            isEmpty={data.workQueues.payoutReady.count === 0}
          />
        </div>
      </Section>

      {/* ── Recent Business Pulse ────────────────────────────────────────────── */}
      <Section title="Today">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <PulseCard label="Items Processed" value={String(data.businessPulse.itemsProcessedToday)} />
          <PulseCard label="Items Listed" value={String(data.businessPulse.itemsListedToday)} />
          <PulseCard label="Units Sold" value={String(data.businessPulse.unitsSoldToday)} />
          <PulseCard label="Orders Completed" value={String(data.businessPulse.completedOrdersToday)} />
          <PulseCard label="GMV" value={data.businessPulse.gmvToday} />
        </div>
        <p className="mt-2 text-xs text-gray-400">
          UTC calendar day. Full trends and revenue breakdowns are in{' '}
          <Link href="/admin/analytics" className="text-blue-600 hover:underline">Business Analytics →</Link>
        </p>
      </Section>

      {/* ── Quick create / export (secondary) ────────────────────────────────── */}
      <section className="mt-4 rounded-md border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Quick create</span>
          {[
            { label: 'Intake Draft', href: '/admin/intake/new' },
            { label: 'Catalog Model', href: '/admin/catalog/new' },
            { label: 'Item', href: '/admin/items/new' },
            { label: 'Listing', href: '/admin/listings/new' },
          ].map((a) => (
            <Link key={a.href} href={a.href} className="text-sm text-blue-600 hover:underline">
              {a.label} +
            </Link>
          ))}
          <span className="ml-auto text-xs text-gray-400">
            <Link href="/admin/export/items" className="hover:text-gray-700">Data export →</Link>
          </span>
        </div>
      </section>
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  )
}

function HealthyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
      {text}
    </div>
  )
}

const ATTENTION_STYLES: Record<'critical' | 'operational' | 'data_quality', string> = {
  critical: 'border-red-200 bg-red-50 text-red-900',
  operational: 'border-amber-200 bg-amber-50 text-amber-900',
  data_quality: 'border-gray-200 bg-gray-50 text-gray-700',
}

function AttentionCard({
  code,
  label,
  count,
  detail,
  href,
}: {
  code: AttentionItemCode
  label: string
  count: number | null
  detail?: string
  href: string
}) {
  const style = ATTENTION_STYLES[attentionBand(code)]
  return (
    <Link href={href} className={`block rounded-md border p-4 hover:opacity-80 transition-opacity ${style}`}>
      <p className="text-2xl font-bold tabular-nums">{count === null ? 'Review' : count}</p>
      <p className="text-sm font-medium mt-1">{label}</p>
      {detail && <p className="text-xs opacity-75 mt-0.5">{detail}</p>}
    </Link>
  )
}

function QueueCard({
  label,
  primary,
  secondary,
  href,
  emptyText,
  isEmpty,
  footerHref,
  footerLabel,
}: {
  label: string
  primary: string
  secondary?: string
  href: string
  emptyText: string
  isEmpty: boolean
  footerHref?: string
  footerLabel?: string
}) {
  if (isEmpty) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <p className="text-xs text-gray-400 mt-1">{emptyText}</p>
        {footerHref && footerLabel && (
          <Link href={footerHref} className="mt-1 inline-block text-xs text-blue-600 hover:underline">{footerLabel}</Link>
        )}
      </div>
    )
  }
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 hover:bg-gray-50 transition-colors">
      <Link href={href} className="block">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <p className="text-lg font-bold text-gray-900 mt-1">{primary}</p>
        {secondary && <p className="text-xs text-gray-400">{secondary}</p>}
      </Link>
      {footerHref && footerLabel && (
        <Link href={footerHref} className="mt-1 inline-block text-xs text-blue-600 hover:underline">{footerLabel}</Link>
      )}
    </div>
  )
}

function PulseCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xl font-bold text-gray-900 tabular-nums">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  )
}

function SetupChecklist({
  locationCount,
  catalogCount,
  totalItems,
  activeListings,
}: {
  locationCount: number
  catalogCount: number
  totalItems: number
  activeListings: number
}) {
  const steps = [
    { label: 'Create a storage location', href: '/admin/locations/new', done: locationCount >= 1, count: locationCount },
    { label: 'Create a catalog model', href: '/admin/catalog/new', done: catalogCount >= 1, count: catalogCount },
    { label: 'Create your first item', href: '/admin/items/new', done: totalItems >= 1, count: totalItems },
    { label: 'Create your first listing', href: '/admin/listings/new', done: activeListings >= 1, count: activeListings },
  ]
  return (
    <section className="mb-8 rounded-md border border-amber-200 bg-amber-50 p-5">
      <h2 className="text-sm font-semibold text-amber-900 mb-1">Production Setup</h2>
      <p className="text-sm text-amber-700 mb-4">
        This is your production database. Complete the steps below to initialize your store.
      </p>
      <ol className="space-y-2">
        {steps.map((step) => (
          <li key={step.href} className="flex items-center gap-3 text-sm">
            {step.done ? (
              <>
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-white text-xs font-bold shrink-0">✓</span>
                <span className="text-gray-500 line-through">{step.label}</span>
                <span className="text-xs text-gray-400">({step.count})</span>
              </>
            ) : (
              <>
                <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-gray-300 shrink-0" />
                <Link href={step.href} className="text-gray-900 font-medium hover:underline">{step.label} →</Link>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
