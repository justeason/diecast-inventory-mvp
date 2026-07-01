import { prisma } from '@/lib/prisma'

const HW_SKU_RE = /^HW-(\d{4})$/

export async function getNextHwSku(): Promise<string> {
  const items = await prisma.itemInstance.findMany({
    where: { sku: { startsWith: 'HW-' } },
    select: { sku: true },
  })
  const nums = items
    .map((i) => {
      const m = HW_SKU_RE.exec(i.sku)
      return m ? parseInt(m[1], 10) : NaN
    })
    .filter((n): n is number => !isNaN(n))
  const max = nums.length > 0 ? Math.max(...nums) : 0
  return `HW-${String(max + 1).padStart(4, '0')}`
}
