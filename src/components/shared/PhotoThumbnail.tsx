// size="sm"   → fixed 40×40, for table rows
// size="fill" → fills parent container (place inside an aspect-ratio wrapper)

type Props = {
  photoUrl?: string | null
  alt: string
  size?: 'sm' | 'fill'
}

const SIZE: Record<'sm' | 'fill', string> = {
  sm:   'h-10 w-10 shrink-0 rounded',
  fill: 'w-full h-full',
}

export function PhotoThumbnail({ photoUrl, alt, size = 'fill' }: Props) {
  const cls = SIZE[size]

  if (!photoUrl) {
    return (
      <div className={`${cls} bg-gray-100 flex items-center justify-center`}>
        <span className="text-gray-400 text-xs select-none">No photo</span>
      </div>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={photoUrl} alt={alt} className={`${cls} object-cover bg-gray-100`} />
  )
}
