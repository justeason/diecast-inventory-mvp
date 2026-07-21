// size="sm"   → fixed 40×40, for table rows
// size="fill" → fills parent container (parent must have position: relative)

import Image from 'next/image'

type Props = {
  photoUrl?: string | null
  alt: string
  size?: 'sm' | 'fill'
}

const PLACEHOLDER_CLS: Record<'sm' | 'fill', string> = {
  sm:   'h-10 w-10 shrink-0 rounded',
  fill: 'w-full h-full',
}

export function PhotoThumbnail({ photoUrl, alt, size = 'fill' }: Props) {
  if (!photoUrl) {
    return (
      <div className={`${PLACEHOLDER_CLS[size]} bg-gray-100 flex items-center justify-center`}>
        <span className="text-gray-400 text-xs select-none">No photo</span>
      </div>
    )
  }

  if (size === 'sm') {
    return (
      <Image
        src={photoUrl}
        alt={alt}
        width={40}
        height={40}
        className="h-10 w-10 shrink-0 rounded object-cover bg-gray-100"
      />
    )
  }

  return (
    <Image
      src={photoUrl}
      alt={alt}
      fill
      className="object-cover bg-gray-100"
    />
  )
}
