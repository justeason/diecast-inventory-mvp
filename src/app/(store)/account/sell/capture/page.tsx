import { CaptureWizard } from '@/components/store/CaptureWizard'

export const metadata = { title: 'Capture Items to Sell' }

export default function SellCapturePage() {
  return (
    <div className="max-w-lg mx-auto py-4 px-4">
      <CaptureWizard presetDestination="sell" />
    </div>
  )
}
