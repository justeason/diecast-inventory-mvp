import { put } from '@vercel/blob'

export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
}

export const MAX_BLOB_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

export function validateBlobFile(
  file: File
): { valid: true } | { valid: false; error: string } {
  if (!ALLOWED_MIME[file.type]) {
    return { valid: false, error: 'Only JPEG, PNG, and WebP images are allowed.' }
  }
  if (file.size > MAX_BLOB_FILE_SIZE) {
    return { valid: false, error: 'File must be 5 MB or smaller.' }
  }
  return { valid: true }
}

// Uploads a file to Vercel Blob. Returns the public URL, or null on failure.
export async function uploadToBlob(pathname: string, file: File): Promise<string | null> {
  try {
    const blob = await put(pathname, file, { access: 'public', contentType: file.type })
    return blob.url
  } catch (err) {
    console.error(
      '[uploadToBlob] Failed to upload:',
      pathname,
      err instanceof Error ? err.message : 'UnknownError'
    )
    return null
  }
}
