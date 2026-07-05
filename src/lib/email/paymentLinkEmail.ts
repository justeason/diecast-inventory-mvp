function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

type OrderItem = {
  price: number
  listing: { title: string }
}

type OrderSummary = {
  id: string
  buyerName: string
  buyerEmail: string
  estimatedShipping: number
  orderItems: OrderItem[]
}

export function buildPaymentLinkEmail(
  order: OrderSummary,
  checkoutUrl: string,
  appUrl: string
): { subject: string; html: string; text: string } {
  const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)
  const shipping = order.estimatedShipping
  const total = subtotal + shipping
  const shortId = order.id.slice(0, 8)

  const subject = `Your CollectNTrades order is reserved — complete payment to confirm`

  // ── HTML ──────────────────────────────────────────────────────────────────

  const itemRows = order.orderItems
    .map(
      (oi) => `
    <tr>
      <td style="padding:5px 0;font-size:13px;color:#374151;">${esc(oi.listing.title)}</td>
      <td style="padding:5px 0;font-size:13px;color:#111827;text-align:right;white-space:nowrap;">
        $${oi.price.toFixed(2)}
      </td>
    </tr>`
    )
    .join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;
             max-width:600px;margin:0 auto;padding:24px 16px;background:#fff;">

  <h1 style="font-size:20px;margin:0 0 4px;">CollectNTrades</h1>
  <p style="color:#6b7280;font-size:13px;margin:0 0 24px;">Order #${esc(shortId)}&hellip;</p>

  <p style="font-size:15px;margin:0 0 8px;">Hi ${esc(order.buyerName)},</p>
  <p style="font-size:14px;color:#374151;margin:0 0 24px;line-height:1.6;">
    Your order has been reviewed and your items are reserved.
    Use the button below to complete payment and confirm your order.
  </p>

  <!-- Order summary -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;
                border:1px solid #e5e7eb;border-radius:6px;">
    <thead>
      <tr style="background:#f9fafb;">
        <th style="padding:10px 14px;font-size:12px;text-align:left;color:#6b7280;
                   font-weight:600;border-bottom:1px solid #e5e7eb;">Item</th>
        <th style="padding:10px 14px;font-size:12px;text-align:right;color:#6b7280;
                   font-weight:600;border-bottom:1px solid #e5e7eb;">Price</th>
      </tr>
    </thead>
    <tbody style="padding:0 14px;">
      ${itemRows}
    </tbody>
    <tfoot>
      <tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:8px 14px;font-size:13px;color:#6b7280;">Subtotal</td>
        <td style="padding:8px 14px;font-size:13px;text-align:right;">$${subtotal.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:4px 14px;font-size:13px;color:#6b7280;">
          ${shipping === 0 ? 'Shipping (free)' : 'Estimated Shipping'}
        </td>
        <td style="padding:4px 14px;font-size:13px;text-align:right;">
          ${shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`}
        </td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;background:#f9fafb;">
        <td style="padding:10px 14px;font-size:14px;font-weight:600;">Total</td>
        <td style="padding:10px 14px;font-size:14px;font-weight:700;text-align:right;">
          $${total.toFixed(2)}
        </td>
      </tr>
    </tfoot>
  </table>

  <!-- CTA -->
  <div style="text-align:center;margin:32px 0;">
    <a href="${checkoutUrl}"
       style="display:inline-block;background:#111827;color:#fff;text-decoration:none;
              padding:14px 32px;border-radius:6px;font-size:15px;font-weight:600;
              letter-spacing:0.01em;">
      Complete Payment &rarr;
    </a>
  </div>

  <!-- Expiry notice -->
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin:0 0 24px;">
    This payment link expires in 23 hours. Your items are reserved until then.
  </p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

  <p style="font-size:12px;color:#9ca3af;margin:0;">
    You can also check your order status any time at
    <a href="${appUrl}/order-status" style="color:#6b7280;">${appUrl}/order-status</a>
    using your order ID and email address.<br /><br />
    Order ID: <span style="font-family:monospace;">${esc(order.id)}</span>
  </p>

</body>
</html>`

  // ── Plain text ─────────────────────────────────────────────────────────────

  const itemLines = order.orderItems
    .map((oi) => `  ${oi.listing.title.padEnd(40)} $${oi.price.toFixed(2)}`)
    .join('\n')

  const text = [
    `CollectNTrades — Order #${shortId}…`,
    ``,
    `Hi ${order.buyerName},`,
    ``,
    `Your order has been reviewed and your items are reserved.`,
    `Complete payment using the link below to confirm your order.`,
    ``,
    `─────────────────────────────────────────`,
    `ORDER SUMMARY`,
    `─────────────────────────────────────────`,
    itemLines,
    ``,
    `Subtotal:          $${subtotal.toFixed(2)}`,
    `Est. Shipping:     ${shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`}`,
    `Total:             $${total.toFixed(2)}`,
    `─────────────────────────────────────────`,
    ``,
    `PAYMENT LINK:`,
    checkoutUrl,
    ``,
    `This link expires in 23 hours. Your items are reserved until then.`,
    ``,
    `─────────────────────────────────────────`,
    `Check order status: ${appUrl}/order-status`,
    `Order ID: ${order.id}`,
  ].join('\n')

  return { subject, html, text }
}
