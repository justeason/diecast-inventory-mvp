import { PrismaClient } from '@prisma/client'
import { PACKAGING_TYPES } from '../src/lib/marketVariant'

const prisma = new PrismaClient()

async function main() {
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.listing.deleteMany()
  await prisma.photo.deleteMany()
  await prisma.itemInstance.deleteMany()
  await prisma.storageLocation.deleteMany()
  await prisma.catalogModel.deleteMany()

  const [locA, locB, locC] = await Promise.all([
    prisma.storageLocation.create({ data: { label: 'Shelf A, Bin 1' } }),
    prisma.storageLocation.create({ data: { label: 'Shelf B, Bin 3' } }),
    prisma.storageLocation.create({ data: { label: 'Shelf C, Bin 2' } }),
  ])

  const [camaro, twinMill, fordF100, deoraII, viper, camaro67, jeep] = await Promise.all([
    prisma.catalogModel.create({
      data: { brand: 'Hot Wheels', name: 'Custom Camaro', series: 'Classics', year: 1968, color: 'Red', scale: '1:64' },
    }),
    prisma.catalogModel.create({
      data: { brand: 'Hot Wheels', name: 'Twin Mill', series: 'Vintage', year: 1969, color: 'Orange', scale: '1:64' },
    }),
    prisma.catalogModel.create({
      data: { brand: 'Matchbox', name: 'Ford F-100', series: 'Series 1', year: 1956, color: 'Blue', scale: '1:64' },
    }),
    prisma.catalogModel.create({
      data: { brand: 'Hot Wheels', name: 'Deora II', series: 'Special Edition', year: 2000, color: 'Silver', scale: '1:64' },
    }),
    prisma.catalogModel.create({
      data: { brand: 'Matchbox', name: 'Dodge Viper RT/10', series: 'Series 2', year: 1992, color: 'Yellow', scale: '1:64' },
    }),
    prisma.catalogModel.create({
      data: { brand: 'Hot Wheels', name: "'67 Camaro", series: 'Heritage', year: 1967, color: 'Green', scale: '1:64' },
    }),
    prisma.catalogModel.create({
      data: { brand: 'Matchbox', name: 'Jeep 4x4', series: 'Off Road', year: 1985, color: 'Orange', scale: '1:64' },
    }),
  ])

  // 21B: every CatalogModel gets exactly Carded + Loose MarketVariant rows.
  const catalogModels = [camaro, twinMill, fordF100, deoraII, viper, camaro67, jeep]
  const variantsByCatalog = new Map<string, Record<(typeof PACKAGING_TYPES)[number], string>>()
  for (const cm of catalogModels) {
    const created = await Promise.all(
      PACKAGING_TYPES.map((packagingType) =>
        prisma.marketVariant.create({ data: { catalogModelId: cm.id, packagingType } })
      )
    )
    variantsByCatalog.set(cm.id, {
      carded: created.find((v) => v.packagingType === 'carded')!.id,
      loose:  created.find((v) => v.packagingType === 'loose')!.id,
    })
  }
  function variantId(catalogId: string, packaging: 'carded' | 'loose'): string {
    return variantsByCatalog.get(catalogId)![packaging]
  }

  await prisma.itemInstance.createMany({
    data: [
      { sku: 'HW-001', catalogId: camaro.id,   marketVariantId: variantId(camaro.id, 'carded'),   locationId: locA.id, cardedOrLoose: 'carded', condition: 'mint',     purchasePrice: 4.00, listPrice: 8.00,  status: 'available'   },
      { sku: 'HW-002', catalogId: twinMill.id, marketVariantId: variantId(twinMill.id, 'loose'),  locationId: locA.id, cardedOrLoose: 'loose',  condition: 'good',     purchasePrice: 2.00, listPrice: 4.00,  status: 'available'   },
      { sku: 'MB-001', catalogId: fordF100.id, marketVariantId: variantId(fordF100.id, 'carded'), locationId: locB.id, cardedOrLoose: 'carded', condition: 'near_mint',purchasePrice: 6.00, listPrice: 12.00, status: 'available'   },
      { sku: 'HW-003', catalogId: deoraII.id,  marketVariantId: variantId(deoraII.id, 'loose'),   locationId: locB.id, cardedOrLoose: 'loose',  condition: 'fair',     purchasePrice: 1.50, listPrice: 3.00,  status: 'available'   },
      { sku: 'MB-002', catalogId: viper.id,    marketVariantId: variantId(viper.id, 'carded'),    locationId: locC.id, cardedOrLoose: 'carded', condition: 'mint',     purchasePrice: 5.00, listPrice: 10.00, status: 'available'   },
      { sku: 'HW-004', catalogId: camaro67.id, marketVariantId: variantId(camaro67.id, 'carded'), locationId: locA.id, cardedOrLoose: 'carded', condition: 'near_mint',purchasePrice: 4.50, listPrice: 9.00,  status: 'draft'       },
      { sku: 'MB-003', catalogId: jeep.id,     marketVariantId: variantId(jeep.id, 'loose'),      locationId: locC.id, cardedOrLoose: 'loose',  condition: 'poor',     purchasePrice: 1.00, listPrice: null,  status: 'not_for_sale'},
      { sku: 'HW-005', catalogId: camaro.id,   marketVariantId: variantId(camaro.id, 'loose'),    locationId: locB.id, cardedOrLoose: 'loose',  condition: 'damaged',  purchasePrice: 0.75, listPrice: 1.50,  status: 'draft'       },
      { sku: 'HW-006', catalogId: twinMill.id, marketVariantId: variantId(twinMill.id, 'carded'), locationId: locC.id, cardedOrLoose: 'carded', condition: 'good',     purchasePrice: 2.50, listPrice: 5.00,  status: 'reserved'    },
      { sku: 'MB-004', catalogId: fordF100.id, marketVariantId: variantId(fordF100.id, 'carded'), locationId: locA.id, cardedOrLoose: 'carded', condition: 'mint',     purchasePrice: 7.50, listPrice: 15.00, status: 'sold'        },
    ],
  })

  console.log('Seeded: 3 locations, 7 catalog models, 14 market variants, 10 item instances')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
