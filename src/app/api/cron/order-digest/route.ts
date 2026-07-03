import { Resend } from 'resend'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─── Labels ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending:  'Pending',
  paid:     'Paid',
  picking:  'Picking',
  shipped:  'Shipped',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid:    'Unpaid',
  requested: 'Payment Requested',
  paid:      'Paid',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Email builders ───────────────────────────────────────────────────────────

type OrderWithItems = Awaited<ReturnType<typeof fetchOrders>>[number]

function buildOrderHtml(order: OrderWithItems, appUrl: string): string {
  const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)
  const hasShipping = order.estimatedShipping != null
  const total = subtotal + (order.estimatedShipping ?? 0)
  const titles = order.orderItems.map((oi) => esc(oi.listing.title)).join(', ')
  const shortId = order.id.slice(0, 8)
  const adminLink = `${appUrl}/admin/orders/${order.id}`

  const row = (label: string, value: string) =>
    `<tr>
      <td style="color:#6b7280;padding:3px 12px 3px 0;width:148px;vertical-align:top;font-size:13px;">${label}</td>
      <td style="font-size:13px;color:#111827;">${value}</td>
    </tr>`

  const phoneStr = order.buyerPhone ? ` · ${esc(order.buyerPhone)}` : ''

  return `
  <div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:12px 0;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
      <span style="font-weight:600;font-size:14px;font-family:monospace;">
        #${shortId}&hellip;
      </span>
      <span style="color:#9ca3af;font-size:12px;">${esc(fmt(order.createdAt))}</span>
    </div>
    <table style="border-collapse:collapse;width:100%;margin-bottom:12px;">
      ${row('Buyer', `${esc(order.buyerName)} &lt;${esc(order.buyerEmail)}&gt;${phoneStr}`)}
      ${row('Order Status', esc(STATUS_LABELS[order.status] ?? order.status))}
      ${row('Payment', esc(PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus))}
      ${row(`Items (${order.orderItems.length})`, titles || '—')}
      ${row('Subtotal', `$${subtotal.toFixed(2)}`)}
      ${hasShipping ? row('Est. Shipping', `$${order.estimatedShipping!.toFixed(2)}`) : ''}
      ${hasShipping ? row('Est. Total', `<strong>$${total.toFixed(2)}</strong>`) : ''}
    </table>
    <a href="${adminLink}"
       style="display:inline-block;background:#111827;color:#fff;text-decoration:none;
              padding:7px 14px;border-radius:4px;font-size:13px;font-weight:500;">
      View Order &rarr;
    </a>
  </div>`
}

function buildOrderText(order: OrderWithItems, appUrl: string): string {
  const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)
  const hasShipping = order.estimatedShipping != null
  const total = subtotal + (order.estimatedShipping ?? 0)
  const titles = order.orderItems.map((oi) => oi.listing.title).join(', ')
  const shortId = order.id.slice(0, 8)
  const adminLink = `${appUrl}/admin/orders/${order.id}`
  const phoneStr = order.buyerPhone ? ` · ${order.buyerPhone}` : ''

  const lines = [
    `─────────────────────────────────────────`,
    `Order #${shortId}…  |  Submitted: ${fmt(order.createdAt)}`,
    `Buyer:          ${order.buyerName} <${order.buyerEmail}>${phoneStr}`,
    `Order Status:   ${STATUS_LABELS[order.status] ?? order.status}`,
    `Payment:        ${PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}`,
    `Items (${order.orderItems.length}):       ${titles || '—'}`,
    `Subtotal:       $${subtotal.toFixed(2)}`,
  ]
  if (hasShipping) {
    lines.push(`Est. Shipping:  $${order.estimatedShipping!.toFixed(2)}`)
    lines.push(`Est. Total:     $${total.toFixed(2)}`)
  }
  lines.push(`Link:           ${adminLink}`)
  return lines.join('\n')
}

function buildHtml(orders: OrderWithItems[], appUrl: string): string {
  const count = orders.length
  const heading = `${count} order${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} attention`
  const ordersHtml = orders.map((o) => buildOrderHtml(o, appUrl)).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;
             max-width:680px;margin:0 auto;padding:24px 16px;background:#fff;">
  <h1 style="font-size:20px;margin:0 0 4px;">CollectNTrades — Order Digest</h1>
  <p style="color:#6b7280;margin:0 0 20px;font-size:14px;">
    ${esc(heading)} &middot; ${esc(fmt(new Date()))}
  </p>
  ${ordersHtml}
  <p style="margin-top:28px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:16px;">
    <a href="${appUrl}/admin/orders" style="color:#111827;">View all orders &rarr;</a>
  </p>
</body>
</html>`
}

function buildText(orders: OrderWithItems[], appUrl: string): string {
  const count = orders.length
  const heading = `${count} order${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} attention`
  const ordersText = orders.map((o) => buildOrderText(o, appUrl)).join('\n\n')

  return [
    `CollectNTrades — Order Digest`,
    `${heading} · ${fmt(new Date())}`,
    ``,
    ordersText,
    ``,
    `─────────────────────────────────────────`,
    `View all orders: ${appUrl}/admin/orders`,
  ].join('\n')
}

// ─── Query ────────────────────────────────────────────────────────────────────

async function fetchOrders() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  return prisma.order.findMany({
    where: {
      status: { notIn: ['complete', 'cancelled'] },
      OR: [
        { createdAt: { gte: twentyFourHoursAgo } },
        { status: 'pending' },
        { paymentStatus: { in: ['unpaid', 'requested'] } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    include: {
      orderItems: {
        select: {
          price: true,
          listing: { select: { title: true } },
        },
      },
    },
  })
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  // 1. Auth
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Required env vars
  for (const varName of ['RESEND_API_KEY', 'ORDER_DIGEST_TO_EMAIL', 'ORDER_DIGEST_FROM_EMAIL']) {
    if (!process.env[varName]) {
      return Response.json(
        { ok: false, error: `Missing required environment variable: ${varName}` },
        { status: 500 }
      )
    }
  }

  const appUrl = (process.env.APP_URL ?? 'https://collectntrades.com').replace(/\/$/, '')

  // 3. Query
  const orders = await fetchOrders()

  if (orders.length === 0) {
    return Response.json({ ok: true, sent: false, reason: 'no_orders_need_attention' })
  }

  // 4. Build email
  const count = orders.length
  const subject = `[CollectNTrades] Daily Order Digest — ${count} order${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} attention`
  const html = buildHtml(orders, appUrl)
  const text = buildText(orders, appUrl)

  // 5. Send
  const resend = new Resend(process.env.RESEND_API_KEY)
  const { error } = await resend.emails.send({
    from: process.env.ORDER_DIGEST_FROM_EMAIL!,
    to:   process.env.ORDER_DIGEST_TO_EMAIL!,
    subject,
    html,
    text,
  })

  if (error) {
    console.error('[order-digest] Resend error:', error.name)
    return Response.json({ ok: false, error: 'Resend send failed' }, { status: 500 })
  }

  return Response.json({ ok: true, sent: true, count })
}
