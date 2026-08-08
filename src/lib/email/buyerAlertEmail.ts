// 14A: Wanted-model alert email builders. Pure functions — no send logic here
// (mirrors magicLinkEmail.ts / paymentLinkEmail.ts). Safe marketplace data only:
// model name, price, listing link. No seller name/email/address.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtUsd(dollars: number): string {
  return `$${dollars.toFixed(2)}`
}

function shell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;
             max-width:600px;margin:0 auto;padding:24px 16px;background:#fff;">
  <h1 style="font-size:20px;margin:0 0 24px;">CollectNTrades</h1>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
  <p style="font-size:12px;color:#9ca3af;margin:0;">
    You're receiving this because you added this model to your wanted list.
    Manage alert preferences in your account at any time.
  </p>
</body>
</html>`
}

type AvailableInput = {
  modelName:  string
  priceDollars: number
  listingUrl: string
}

export function buildWantedAvailableEmail(input: AvailableInput): { subject: string; html: string; text: string } {
  const { modelName, priceDollars, listingUrl } = input
  const subject = `Now available: ${modelName}`

  const html = shell(subject, `
  <p style="font-size:15px;margin:0 0 8px;">Good news — a model on your wanted list is now available.</p>
  <p style="font-size:16px;font-weight:600;margin:16px 0 4px;">${esc(modelName)}</p>
  <p style="font-size:14px;color:#374151;margin:0 0 24px;">Asking price: <strong>${fmtUsd(priceDollars)}</strong></p>
  <div style="text-align:center;margin:32px 0;">
    <a href="${esc(listingUrl)}"
       style="display:inline-block;background:#111827;color:#fff;text-decoration:none;
              padding:14px 32px;border-radius:6px;font-size:15px;font-weight:600;">
      View Listing &rarr;
    </a>
  </div>`)

  const text = [
    `CollectNTrades`, ``,
    `Good news — a model on your wanted list is now available.`, ``,
    modelName,
    `Asking price: ${fmtUsd(priceDollars)}`, ``,
    listingUrl,
  ].join('\n')

  return { subject, html, text }
}

type PriceChangeInput = {
  modelName: string
  previousPriceDollars: number
  currentPriceDollars: number
  listingUrl: string
  direction: 'decrease' | 'increase'
}

export function buildWantedPriceChangeEmail(input: PriceChangeInput): { subject: string; html: string; text: string } {
  const { modelName, previousPriceDollars, currentPriceDollars, listingUrl, direction } = input
  const diff = currentPriceDollars - previousPriceDollars
  const pct = previousPriceDollars > 0 ? (Math.abs(diff) / previousPriceDollars) * 100 : 0
  const verb = direction === 'decrease' ? 'dropped' : 'increased'
  const subject = `Price ${verb}: ${modelName}`

  const html = shell(subject, `
  <p style="font-size:15px;margin:0 0 8px;">The asking price for a model on your wanted list has ${verb}.</p>
  <p style="font-size:16px;font-weight:600;margin:16px 0 4px;">${esc(modelName)}</p>
  <p style="font-size:14px;color:#374151;margin:0 0 4px;">
    Previous price: <span style="text-decoration:line-through;color:#9ca3af;">${fmtUsd(previousPriceDollars)}</span>
  </p>
  <p style="font-size:14px;color:#374151;margin:0 0 24px;">
    New price: <strong>${fmtUsd(currentPriceDollars)}</strong>
    <span style="color:#6b7280;">(${direction === 'decrease' ? '-' : '+'}${pct.toFixed(1)}%)</span>
  </p>
  <div style="text-align:center;margin:32px 0;">
    <a href="${esc(listingUrl)}"
       style="display:inline-block;background:#111827;color:#fff;text-decoration:none;
              padding:14px 32px;border-radius:6px;font-size:15px;font-weight:600;">
      View Listing &rarr;
    </a>
  </div>`)

  const text = [
    `CollectNTrades`, ``,
    `The asking price for a model on your wanted list has ${verb}.`, ``,
    modelName,
    `Previous price: ${fmtUsd(previousPriceDollars)}`,
    `New price: ${fmtUsd(currentPriceDollars)} (${direction === 'decrease' ? '-' : '+'}${pct.toFixed(1)}%)`, ``,
    listingUrl,
  ].join('\n')

  return { subject, html, text }
}
