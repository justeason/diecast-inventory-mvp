import { redirect } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCaptureSession } from '@/lib/actions/mobileCapture'
import { CaptureReview } from '@/components/store/CaptureReview'

export const metadata = { title: 'Review Capture Queue' }

type Props = { searchParams: Promise<{ session?: string }> }

export default async function CaptureReviewPage({ searchParams }: Props) {
  const { session: sessionId } = await searchParams
  if (!sessionId) redirect('/account/capture')

  const buyer = await getBuyerSession()
  if (!buyer) redirect('/account/orders')

  const res = await getCaptureSession(sessionId)
  if (!res.ok) redirect('/account/capture')

  return (
    <div className="max-w-lg mx-auto py-4 px-4">
      <CaptureReview session={res.data} />
    </div>
  )
}
