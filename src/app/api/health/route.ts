import { NextResponse } from 'next/server'

// Liveness check only — does NOT query any dependency.
// Returns 200 as long as the process is running.
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    { status: 'ok', uptime: Math.round(process.uptime()) },
    { status: 200 },
  )
}
