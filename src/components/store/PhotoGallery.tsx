'use client'

import { useState, useEffect, useRef } from 'react'

type Photo = {
  url: string
  type: string
}

type Props = {
  photos: Photo[]
  title: string
}

export function PhotoGallery({ photos, title }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (lightboxOpen) closeRef.current?.focus()
  }, [lightboxOpen])

  useEffect(() => {
    if (!lightboxOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false)
      if (photos.length > 1 && e.key === 'ArrowLeft')
        setSelectedIndex((i) => (i - 1 + photos.length) % photos.length)
      if (photos.length > 1 && e.key === 'ArrowRight')
        setSelectedIndex((i) => (i + 1) % photos.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxOpen, photos.length])

  if (photos.length === 0) {
    return (
      <div className="aspect-[4/3] rounded-lg bg-gray-100 flex items-center justify-center">
        <span className="text-sm text-gray-400">No photo available</span>
      </div>
    )
  }

  const current = photos[selectedIndex]

  return (
    <>
      <div className="space-y-3">
        {/* Main image — click opens lightbox */}
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          aria-label={`View larger — ${current.type}`}
          className="block w-full aspect-[4/3] rounded-lg overflow-hidden bg-gray-100 cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <img
            src={current.url}
            alt={`${current.type} view — ${title}`}
            className="w-full h-full object-contain"
          />
        </button>

        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="text-xs text-gray-500 hover:text-gray-900 underline underline-offset-2"
        >
          View larger
        </button>

        {/* Thumbnail strip — only when 2+ photos */}
        {photos.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {photos.map((photo, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelectedIndex(i)}
                aria-pressed={i === selectedIndex}
                aria-label={`${photo.type} view`}
                className={`shrink-0 w-16 h-16 rounded overflow-hidden border-2 transition-colors ${
                  i === selectedIndex
                    ? 'border-gray-900'
                    : 'border-transparent hover:border-gray-300'
                }`}
              >
                <img
                  src={photo.url}
                  alt={`${photo.type} view`}
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lightbox overlay */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightboxOpen(false)
          }}
        >
          {/* Prev button */}
          {photos.length > 1 && (
            <button
              type="button"
              onClick={() => setSelectedIndex((i) => (i - 1 + photos.length) % photos.length)}
              aria-label="Previous photo"
              className="absolute left-4 top-1/2 -translate-y-1/2 px-3 py-4 text-white/70 hover:text-white text-3xl leading-none"
            >
              ←
            </button>
          )}

          {/* Image + close + label */}
          <div className="relative flex flex-col items-center">
            <button
              ref={closeRef}
              type="button"
              onClick={() => setLightboxOpen(false)}
              aria-label="Close image"
              className="absolute -top-9 right-0 flex h-8 w-8 items-center justify-center text-white/80 hover:text-white text-xl leading-none"
            >
              ✕
            </button>

            <img
              src={current.url}
              alt={`${current.type} view — ${title}`}
              className="max-w-[85vw] max-h-[85vh] object-contain rounded"
            />

            <p className="mt-2 text-xs text-white/60 capitalize">{current.type}</p>
          </div>

          {/* Next button */}
          {photos.length > 1 && (
            <button
              type="button"
              onClick={() => setSelectedIndex((i) => (i + 1) % photos.length)}
              aria-label="Next photo"
              className="absolute right-4 top-1/2 -translate-y-1/2 px-3 py-4 text-white/70 hover:text-white text-3xl leading-none"
            >
              →
            </button>
          )}
        </div>
      )}
    </>
  )
}
