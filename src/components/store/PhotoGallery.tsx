'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'

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
          className="relative block w-full aspect-[4/3] rounded-lg overflow-hidden bg-gray-100 cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <Image
            src={current.url}
            alt={`${current.type} view — ${title}`}
            fill
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-contain"
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
                className={`relative shrink-0 w-16 h-16 rounded overflow-hidden border-2 transition-colors ${
                  i === selectedIndex
                    ? 'border-gray-900'
                    : 'border-transparent hover:border-gray-300'
                }`}
              >
                <Image
                  src={photo.url}
                  alt={`${photo.type} view`}
                  fill
                  sizes="64px"
                  className="object-cover"
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
              className="absolute -top-11 right-0 flex h-11 w-11 items-center justify-center text-white/80 hover:text-white text-xl leading-none"
            >
              ✕
            </button>

            {/* 37B: intentionally left as a raw <img>, not next/image — Photo
                has no stored width/height, and this element relies on the
                browser's natural intrinsic-sizing (shrink-to-fit within
                85vw/85vh, preserving the image's own aspect ratio) rather than
                filling a pre-sized box. next/image's `fill` mode stretches to
                its parent's box via object-fit and cannot replicate that
                without either fabricated dimensions or a second JS-measured
                sizing pass — a real incompatibility, not a lint workaround. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
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
