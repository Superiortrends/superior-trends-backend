/**
 * Replaces images of the old men/accessories products with new photos
 * (uploaded to ImageKit). Price is NOT changed.
 * Usage: npx tsx prisma/replace-men-acc-images.ts "<image-folder>" [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { uploadOnImageKit } from '../src/config/imagekit.js';

const prisma = new PrismaClient();

const PLAN: { sku: string; file: string; folder: string }[] = [
  { sku: 'ST-M-003', file: '2.png', folder: 'men' }, // Kurta Pajama Set
  { sku: 'ST-M-004', file: '3.png', folder: 'men' }, // Polo T-Shirt
  { sku: 'ST-M-001', file: '4.png', folder: 'men' }, // Denim Jeans
  { sku: 'ST-M-002', file: '5.png', folder: 'men' }, // Formal Shirt
  { sku: 'ST-A-001', file: '6.png', folder: 'accessories' }, // Crossbody Bag
  { sku: 'ST-A-002', file: '7.png', folder: 'accessories' }, // Jhumka Earrings
  { sku: 'ST-A-003', file: '8.png', folder: 'accessories' }, // Silk Scarf
];

async function main() {
  const dir = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: npx tsx prisma/replace-men-acc-images.ts "<folder>" [--dry-run]');
    process.exit(1);
  }

  for (const step of PLAN) {
    const product = await prisma.product.findUnique({ where: { sku: step.sku } });
    const filePath = path.join(dir, step.file);
    if (!product || !fs.existsSync(filePath)) {
      console.error(`❌ ${step.sku}: product or file ${step.file} missing`);
      process.exit(1);
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}${step.sku} ${product.name}  ←  ${step.file}`);
    if (dryRun) continue;

    const slug = product.name.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    const upload = await uploadOnImageKit(fs.readFileSync(filePath), {
      folder: `/superior_trends/${step.folder}`,
      fileName: `${slug}.png`,
      mimeType: 'image/png',
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
