import { CaptureWizard } from '@/components/store/CaptureWizard'

export const metadata = { title: 'Quick Capture' }

export default function CapturePage() {
  return (
    <div className="max-w-lg mx-auto py-4 px-4">
      <CaptureWizard />
    </div>
  )
}
