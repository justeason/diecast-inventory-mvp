'use server'

// 15H Part H/O — server action boundary for global admin search. Explicitly checks
// admin auth (section 43) rather than relying solely on middleware, matching the
// pattern used by every other admin action in this codebase.
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { searchAdmin, type AdminSearchResults } from '@/lib/adminSearchQuery'

export async function searchAdminAction(query: string): Promise<AdminSearchResults> {
  if (!(await isAdminAuthenticated())) return []
  return searchAdmin(query)
}
