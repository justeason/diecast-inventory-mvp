'use client'

import { useEffect } from 'react'
import { useActionState } from 'react'
import Link from 'next/link'
import { useCart } from '@/lib/use-cart'
import { createOrder, type OrderActionState } from '@/lib/actions/orders'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

export function CartPage() {
  const { items, remove, clear } = useCart()
  const [state, formAction, isPending] = useActionState<OrderActionState, FormData>(
    createOrder,
    null
  )

  useEffect(() => {
    if (state && 'success' in state && state.success) {
      clear()
      window.dispatchEvent(new Event('cart-updated'))
    }
  }, [state, clear])

  if (state && 'success' in state && state.success) {
    return (
      <div className="max-w-lg">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Order Request Submitted</h1>
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 space-y-3">
          <h2 className="text-lg font-semibold text-green-900">Thank you!</h2>
          <p className="text-sm text-green-800">
            Your order request has been received. This is{' '}
            <strong>not a confirmed purchase</strong> — we&apos;ll contact you by email to
            confirm availability and arrange payment.
          </p>
          <p className="text-sm text-green-700">
            Order reference:{' '}
            <span className="font-mono text-xs break-all">{state.orderId}</span>
          </p>
        </div>
        <div className="mt-6">
          <Link
            href="/browse"
            className="text-sm font-medium text-gray-900 hover:underline underline-offset-2"
          >
            ← Continue browsing
          </Link>
        </div>
      </div>
    )
  }

  const formErrors = state && 'errors' in state ? state.errors : {}
  const subtotal = items.reduce((sum, item) => sum + item.price, 0)

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Your Cart</h1>

      {items.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Your cart is empty.</p>
          <Link
            href="/browse"
            className="inline-block text-sm font-medium text-gray-900 hover:underline underline-offset-2"
          >
            Browse listings →
          </Link>
        </div>
      ) : (
        <form action={formAction}>
          {items.map((item) => (
            <input key={item.listingId} type="hidden" name="listingIds" value={item.listingId} />
          ))}

          <div className="overflow-x-auto rounded-md border border-gray-200 mb-8">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium w-14"></th>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Condition</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">Price</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => (
                  <tr key={item.listingId}>
                    <td className="px-4 py-3">
                      <PhotoThumbnail photoUrl={item.photoUrl ?? null} alt={item.title} size="sm" />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{item.title}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{item.sku}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {CONDITION_LABELS[item.condition] ?? item.condition}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {item.cardedOrLoose === 'carded' ? 'Carded' : 'Loose'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      ${item.price.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          remove(item.listingId)
                          window.dispatchEvent(new Event('cart-updated'))
                        }}
                        className="text-sm text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200 bg-gray-50">
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-3 text-right font-semibold text-gray-900"
                  >
                    Subtotal
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    ${subtotal.toFixed(2)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {formErrors.form && (
            <p className="mb-4 text-sm text-red-600">{formErrors.form[0]}</p>
          )}

          <div className="max-w-md space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Request this order</h2>
              <p className="mt-1 text-sm text-gray-500">
                This is an order request, not a payment checkout. We&apos;ll contact you to
                confirm availability and arrange payment.
              </p>
            </div>

            <div>
              <label htmlFor="buyerName" className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                id="buyerName"
                name="buyerName"
                type="text"
                required
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              {formErrors.buyerName && (
                <p className="mt-1 text-xs text-red-600">{formErrors.buyerName[0]}</p>
              )}
            </div>

            <div>
              <label htmlFor="buyerEmail" className="block text-sm font-medium text-gray-700 mb-1">
                Email <span className="text-red-500">*</span>
              </label>
              <input
                id="buyerEmail"
                name="buyerEmail"
                type="email"
                required
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              {formErrors.buyerEmail && (
                <p className="mt-1 text-xs text-red-600">{formErrors.buyerEmail[0]}</p>
              )}
            </div>

            <div>
              <label htmlFor="buyerPhone" className="block text-sm font-medium text-gray-700 mb-1">
                Phone{' '}
                <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id="buyerPhone"
                name="buyerPhone"
                type="tel"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <div>
              <label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1">
                Notes{' '}
                <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={3}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-gray-900 px-6 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? 'Submitting…' : 'Request Order'}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
