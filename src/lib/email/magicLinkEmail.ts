function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

type MagicLinkInput = {
  name?: string | null
  verifyUrl: string
  appUrl: string
}

export function buildMagicLinkEmail(
  input: MagicLinkInput
): { subject: string; html: string; text: string } {
  const { name, verifyUrl, appUrl } = input
  const greeting = name ? `Hi ${esc(name)},` : 'Hi there,'

  const subject = 'Sign in to view your CollectNTrades orders'

  // ── HTML ──────────────────────────────────────────────────────────────────

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;
             max-width:600px;margin:0 auto;padding:24px 16px;background:#fff;">

  <h1 style="font-size:20px;margin:0 0 24px;">CollectNTrades</h1>

  <p style="font-size:15px;margin:0 0 8px;">${greeting}</p>
  <p style="font-size:14px;color:#374151;margin:0 0 24px;line-height:1.6;">
    Click the button below to view your order history.<br />
    This link is valid for <strong>15 minutes</strong> and can only be used once.
  </p>

  <!-- CTA -->
  <div style="text-align:center;margin:32px 0;">
    <a href="${esc(verifyUrl)}"
       style="display:inline-block;background:#111827;color:#fff;text-decoration:none;
              padding:14px 32px;border-radius:6px;font-size:15px;font-weight:600;
              letter-spacing:0.01em;">
      View My Orders &rarr;
    </a>
  </div>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

  <p style="font-size:12px;color:#9ca3af;margin:0 0 8px;">
    If you didn&rsquo;t request this, you can ignore this email. Your account is not at risk.
  </p>
  <p style="font-size:12px;color:#9ca3af;margin:0;">
    Or copy this link into your browser:<br />
    <span style="color:#6b7280;word-break:break-all;">${esc(verifyUrl)}</span>
  </p>

</body>
</html>`

  // ── Plain text ─────────────────────────────────────────────────────────────

  const text = [
    `CollectNTrades`,
    ``,
    greeting.replace(/,$/, ','),
    ``,
    `Click the link below to view your order history.`,
    `This link is valid for 15 minutes and can only be used once.`,
    ``,
    verifyUrl,
    ``,
    `─────────────────────────────────────────`,
    `If you didn't request this, you can ignore this email.`,
    `Your account is not at risk.`,
    ``,
    `CollectNTrades — ${appUrl}`,
  ].join('\n')

  return { subject, html, text }
}
