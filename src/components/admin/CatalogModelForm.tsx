'use client'

import { useState, useEffect, useRef } from 'react'
import { useActionState } from 'react'
import Link from 'next/link'
import { CatalogModel } from '@prisma/client'
import { createCatalogModel, updateCatalogModel, CatalogActionState } from '@/lib/actions/catalog'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { DUPLICATE_SCORE_THRESHOLD } from '@/lib/catalogMatching'
import type { CatalogMatchResult } from '@/lib/catalogMatching'

type Props = { model?: CatalogModel }

export function CatalogModelForm({ model }: Props) {
  const action = model ? updateCatalogModel.bind(null, model.id) : createCatalogModel
  const [state, formAction, isPending] = useActionState<CatalogActionState, FormData>(action, null)

  const [brand, setBrand] = useState(model?.brand ?? '')
  const [name, setName] = useState(model?.name ?? '')
  const [dupWarning, setDupWarning] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const q = [brand, name].filter(Boolean).join(' ').trim()
      if (q.length < 3) { setDupWarning(null); return }
      void (async () => {
        try {
          const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`)
          if (!res.ok) return
          const data: CatalogMatchResult[] = await res.json()
          const top = data[0]
          if (top && top.score >= DUPLICATE_SCORE_THRESHOLD && (!model || top.id !== model.id)) {
            setDupWarning(`Potential duplicate: ${top.brand} ${top.name} (score ${top.score}/100)`)
          } else {
            setDupWarning(null)
          }
        } catch { /* ignore */ }
      })()
    }, 400)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [brand, name, model])

  const serverDuplicateError = state?.errors?._duplicate?.[0] ?? null

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      {(dupWarning || serverDuplicateError) && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-2">
          <p>{serverDuplicateError ?? dupWarning}. Review the{' '}
            <Link href="/admin/catalog" className="underline hover:no-underline">catalog</Link>{' '}
            before saving.
          </p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" name="createAnyway" value="true" className="mt-0.5 h-3.5 w-3.5 accent-amber-800" />
            <span>I have reviewed the catalog — this is a genuinely distinct model. Create anyway.</span>
          </label>
        </div>
      )}
      <Input label="Brand" name="brand" required value={brand} onChange={(e) => setBrand(e.target.value)} error={state?.errors?.brand?.[0]} />
      <Input label="Name" name="name" required value={name} onChange={(e) => setName(e.target.value)} error={state?.errors?.name?.[0]} />
      <Input label="Series" name="series" defaultValue={model?.series ?? ''} error={state?.errors?.series?.[0]} />
      <Input label="Year" name="year" type="number" defaultValue={model?.year ?? ''} error={state?.errors?.year?.[0]} />
      <Input label="Color" name="color" defaultValue={model?.color ?? ''} error={state?.errors?.color?.[0]} />
      <Input label="Scale" name="scale" placeholder="e.g. 1:64" defaultValue={model?.scale ?? ''} error={state?.errors?.scale?.[0]} />
      <Input label="Notes" name="notes" defaultValue={model?.notes ?? ''} error={state?.errors?.notes?.[0]} />

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : model ? 'Update Model' : 'Create Model'}
        </Button>
        <Link href="/admin/catalog">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}
