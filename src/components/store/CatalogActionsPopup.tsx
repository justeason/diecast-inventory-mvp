'use client'

import { useEffect, useId, useRef, useState } from 'react'

// 16G Final: ARIA Disclosure (show/hide) pattern — not a menu. This only reveals
// or hides a region of ordinary buttons/links; it does not implement menu
// keyboard navigation (arrow keys, roving tabindex, typeahead), so it must not
// claim role="menu"/"menuitem" — that would promise behavior it doesn't provide.
// Used only below the `md` breakpoint (see CatalogActions.tsx) — desktop uses a
// plain CSS hover/focus-within reveal instead, which needs no open/closed JS
// state at all and therefore can never disagree with an ARIA state.
//
// Closed state is a genuine unmount (`{open && (...)}`), never opacity/pointer-
// events-only — so a closed popup's controls are never in the tab order, and
// aria-expanded can never disagree with what's actually present/interactive.
export function CatalogActionsPopup({
  triggerLabel,
  children,
}: {
  triggerLabel: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onOutsideClick(e: MouseEvent | TouchEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        // Focus would otherwise be dropped to <body> once the panel unmounts —
        // return it to the trigger, never leave it stranded.
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onOutsideClick)
    document.addEventListener('touchstart', onOutsideClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onOutsideClick)
      document.removeEventListener('touchstart', onOutsideClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
      >
        Actions ⋯
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 bottom-full mb-1 z-20 min-w-[170px] rounded-md border border-gray-200 bg-white py-1 shadow-lg text-xs"
        >
          {children}
        </div>
      )}
    </div>
  )
}
