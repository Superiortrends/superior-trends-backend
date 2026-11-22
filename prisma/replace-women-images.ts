/**
 * Replaces the images of the old women products with photos from the
 * "Al Alisha" folder (uploaded to ImageKit) and sets price to 15 OMR.
 * Usage: npx tsx prisma/replace-women-images.ts "<Al Alisha folder>" [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { uploadOnImageKit } from '../src/config/imagekit.js';

const prisma = new PrismaClient();
const PRICE_OMR = 15;

// product name -> list of files (assigned in createdAt order when a name repeats)
const PLAN: { name: string; file: string }[] = [
  // done in an earlier run: Anarkali, Palazzo Set, Kurta Set (ST-W-001)
  // The 2nd kurta row has a stray trailing tab in its sku/name, so match loosely:
  { name: 'Embroidered Cotton Kurta Set', file: 'WhatsApp Image 2026-05-16 at 1.00.53 PM.jpeg' },
  { name: 'Party Wear Sequin Top', file: 'WhatsApp Image 2026-05-16 at 12.59.32 PM.jpeg' },
];

const slugify = (t: string) =>
  t.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/-+/g, '-');

async function main() {
  const dir = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: npx tsx prisma/replace-women-images.ts "<folder>" [--dry-run]');
    process.exit(1);
  }

  const used = new Map<string, number>();
  for (const step of PLAN) {
    const nth = 0;
    used.set(step.name, nth + 1);
    const matches = await prisma.product.findMany({
      where: {
        name: { startsWith: step.name },
        sku: { not: { startsWith: 'ST-CS-' } },
        // exclude the clean "ST-W-001" row already handled
        NOT: { sku: 'ST-W-001' },
      },
      orderBy: { createdAt: 'asc' },
    });
    const product = matches[nth];
    if (!product) {
      console.error(`❌ Product "${step.name}" #${nth + 1} not found`);
      process.exit(1);
    }
    const filePath = path.join(dir, step.file);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Missing file ${step.file}`);
      process.exit(1);
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}${JSON.stringify(product.sku)} ${product.name}  ←  ${step.file}`);
    if (dryRun) continue;

    const upload = await uploadOnImageKit(fs.readFileSync(filePath), {
      folder: '/superior_trends/women',
      fileName: `${slugify(product.name)}.jpeg`,
      mimeType: 'image/jpeg',
    });
    if (!upload) {
      console.error('❌ Upload failed — stopping.');
      process.exit(1);
    }

    await prisma.$transaction([
      prisma.productImage.deleteMany({ where: { productId: product.id } }),
      prisma.productImage.create({
        data: { productId: product.id, imageUrl: upload.url, isMain: true, sortOrder: 0 },
      }),
      prisma.product.update({
        where: { id: product.id },
        data: { mrp: PRICE_OMR, salePrice: PRICE_OMR },
      }),
    ]);
    console.log(`✅ ${product.name} → ${upload.url}`);
  }
}

main()
  .catch((e) => {
    console.error('Failed:', (e as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
