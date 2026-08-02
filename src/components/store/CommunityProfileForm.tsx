'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { saveCommunityProfile, type CommunityProfileState } from '@/lib/actions/community'

type Existing = {
  handle: string
  displayName: string
  bio: string | null
  isPublic: boolean
  showOnLeaderboards: boolean
} | null

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Saving…' : 'Save profile'}
    </button>
  )
}

export function CommunityProfileForm({ existing }: { existing: Existing }) {
  const [state, formAction] = useActionState<CommunityProfileState, FormData>(
    saveCommunityProfile,
    null,
  )

  return (
    <form action={formAction} className="space-y-6">
      {state?.success && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Profile saved.
        </p>
      )}
      {state?.errors?._form && (
        <p className="text-sm text-red-600">{state.errors._form[0]}</p>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-900 mb-1">Handle</label>
        <p className="text-xs text-gray-500 mb-2">
          3–24 characters, lowercase letters/numbers/underscores. Public URL: /community/yourhandle
        </p>
        <input
          name="handle"
          type="text"
          defaultValue={existing?.handle ?? ''}
          placeholder="yourhandle"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.handle && (
          <p className="mt-1 text-xs text-red-600">{state.errors.handle[0]}</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-900 mb-1">Display name</label>
        <input
          name="displayName"
          type="text"
          defaultValue={existing?.displayName ?? ''}
          placeholder="Collector Name"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.displayName && (
          <p className="mt-1 text-xs text-red-600">{state.errors.displayName[0]}</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-900 mb-1">
          Bio{' '}
          <span className="font-normal text-gray-400">(optional, max 160 characters)</span>
        </label>
        <textarea
          name="bio"
          defaultValue={existing?.bio ?? ''}
          rows={3}
          placeholder="A short description of your collection…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.bio && (
          <p className="mt-1 text-xs text-red-600">{state.errors.bio[0]}</p>
        )}
      </div>

      <div className="space-y-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            name="isPublic"
            type="checkbox"
            value="true"
            defaultChecked={existing?.isPublic ?? false}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm text-gray-900">
            Make profile public
            <span className="block text-xs text-gray-500 mt-0.5">
              Your handle, display name, bio, and catalog collection visible to anyone.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            name="showOnLeaderboards"
            type="checkbox"
            value="true"
            defaultChecked={existing?.showOnLeaderboards ?? false}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm text-gray-900">
            Include in leaderboards
            <span className="block text-xs text-gray-500 mt-0.5">
              Requires a public profile. Opt in to appear on community collection rankings.
            </span>
          </span>
        </label>
      </div>

      <SubmitButton />
    </form>
  )
}
