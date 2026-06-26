'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { CatalogModel } from '@prisma/client'
import { createCatalogModel, updateCatalogModel, CatalogActionState } from '@/lib/actions/catalog'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'

type Props = { model?: CatalogModel }

export function CatalogModelForm({ model }: Props) {
  const action = model ? updateCatalogModel.bind(null, model.id) : createCatalogModel
  const [state, formAction, isPending] = useActionState<CatalogActionState, FormData>(action, null)

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <Input label="Brand" name="brand" required defaultValue={model?.brand ?? ''} error={state?.errors?.brand?.[0]} />
      <Input label="Name" name="name" required defaultValue={model?.name ?? ''} error={state?.errors?.name?.[0]} />
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
