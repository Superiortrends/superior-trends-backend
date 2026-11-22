/**
 * Uploads co-ord set photos to ImageKit and creates one product per photo.
 *
 * Usage:  npx tsx prisma/seed-cordsets.ts "<folder-with-images>" [--dry-run]
 *
 * - Safe to re-run: products are keyed by SKU; a product that already has an
 *   image is skipped (no duplicate uploads).
 * - Uses the same server-side ImageKit helper as the admin upload route.
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { uploadOnImageKit } from '../src/config/imagekit.js';

const prisma = new PrismaClient();

const PRICE_OMR = 15;
const CATEGORY_SLUG = 'women-cord-sets';
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

// Order = alphabetical order of the files in the folder (WhatsApp timestamp order).
const ITEMS: { name: string; color: { name: string; hex: string } }[] = [
  { name: 'Mint Green Leaf Print Co-ord Set', color: { name: 'Mint Green', hex: '#5fbf9f' } },
  { name: 'Abstract Multicolor Print Co-ord Set', color: { name: 'Multicolor', hex: '#e2574c' } },
  { name: 'Tropical Island Print Co-ord Set', color: { name: 'Black', hex: '#1d3b34' } },
  { name: 'Emerald Floral Print Co-ord Set', color: { name: 'Emerald', hex: '#2f5d3a' } },
  { name: 'Rust Paisley Print Co-ord Set', color: { name: 'Rust', hex: '#b5651d' } },
  { name: 'Ikat Print Co-ord Set', color: { name: 'Pink', hex: '#d6336c' } },
  { name: 'Pastel Floral Print Co-ord Set', color: { name: 'Pastel', hex: '#f4a6a6' } },
  { name: 'Navy Tulip Print Co-ord Set', color: { name: 'Navy', hex: '#2b2d5a' } },
  { name: 'Patchwork Block Print Co-ord Set', color: { name: 'Red', hex: '#c0392b' } },
  { name: 'Purple Garden Print Co-ord Set', color: { name: 'Purple', hex: '#5b4a9e' } },
  { name: 'Blue Jaal Floral Co-ord Set', color: { name: 'Blue', hex: '#2e4fa3' } },
  { name: 'Mustard Floral Print Co-ord Set', color: { name: 'Mustard', hex: '#d9b52b' } },
  { name: 'Pink Block Floral Co-ord Set', color: { name: 'Pink', hex: '#e8457a' } },
];

const slugify = (t: string) =>
  t.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/-+/g, '-');

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function main() {
  const dir = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: npx tsx prisma/seed-cordsets.ts "<image-folder>" [--dry-run]');
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => MIME[path.extname(f).toLowerCase()])
    .sort(); // plain code-unit order: "... PM (1).jpeg" comes before "... PM.jpeg"

  if (files.length !== ITEMS.length) {
    console.error(`Expected ${ITEMS.length} images, found ${files.length}. Aborting.`);
    process.exit(1);
  }

  const category = await prisma.category.findUnique({ where: { slug: CATEGORY_SLUG } });
  if (!category) {
    console.error(`Category "${CATEGORY_SLUG}" not found. Run: npm run seed`);
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const item = ITEMS[i];
    const file = files[i];
    const sku = `ST-CS-${String(i + 1).padStart(3, '0')}`;

    const existing = await prisma.product.findUnique({
      where: { sku },
      include: { images: true },
    });
    if (existing && existing.images.length > 0) {
      console.log(`⏭  ${sku} already exists with image — skipped`);
      skipped++;
      continue;
    }

    console.log(`${dryRun ? '[dry-run] ' : ''}${sku}  ${item.name}  ←  ${file}`);
    if (dryRun) continue;

    const ext = path.extname(file).toLowerCase();
    const upload = await uploadOnImageKit(fs.readFileSync(path.join(dir, file)), {
      folder: '/superior_trends/cord-sets',
      fileName: `${slugify(item.name)}${ext}`,
      mimeType: MIME[ext],
    });
    if (!upload) {
      console.error(`❌ Upload failed for ${file} — stopping (re-run to resume).`);
      process.exit(1);
    }

    const data = {
      name: item.name,
      slug: slugify(`${item.name}-${sku}`),
      sku,
      shortDescription: 'Printed two-piece co-ord set — top with matching pants.',
      longDescription:
        'Comfortable printed co-ord set made of soft, breathable fabric. Includes top and matching pants. Easy to wear for daily and casual outings. Machine wash cold, gentle cycle.',
      categoryId: category.id,
      mrp: PRICE_OMR,
      salePrice: PRICE_OMR,
      stock: 50,
      status: true,
      featured: i < 4,
      trending: i % 3 === 0,
      sizes: SIZES,
      colors: [item.color],
    };

    const product = existing
      ? await prisma.product.update({ where: { sku }, data })
      : await prisma.product.create({ data });

    await prisma.productImage.create({
      data: { productId: product.id, imageUrl: upload.url, isMain: true, sortOrder: 0 },
    });

    console.log(`✅ ${sku} → ${upload.url}`);
    created++;
  }

  console.log(`\nDone — ${created} created, ${skipped} skipped.`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', (e as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
