import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import process from 'node:process';
import dotenv from 'dotenv';
import { uploadOnImageKit } from '../src/config/imagekit.js';
dotenv.config();
const base = process.env.DATABASE_URL!;
const p = new PrismaClient({ datasourceUrl: base + (base.includes('?') ? '&' : '?') + 'connection_limit=1&pool_timeout=30' });
const I = process.argv[2];
const SKU = 'ST-CS-014';

let tries = 0;
for (;;) {
  try { await p.$queryRaw`SELECT 1`; break; }
  catch (e) { if (++tries > 8) { console.error('RESULT db unreachable:', (e as Error).message.split('\n').pop()); process.exit(1); } await new Promise(r => setTimeout(r, 15000)); }
}
console.log('RESULT db connected after', tries, 'retries');

if (await p.product.findUnique({ where: { sku: SKU } })) { console.error('RESULT already exists — aborting'); process.exit(1); }
const cat = await p.category.findUnique({ where: { slug: 'women-cord-sets' } });
if (!cat) { console.error('RESULT category missing'); process.exit(1); }

const files = [['18.png', 'korean-cord-set-blue'], ['19.png', 'korean-cord-set-beige']];
const urls: string[] = [];
for (const [f, name] of files) {
  const up = await uploadOnImageKit(fs.readFileSync(`${I}/${f}`), { folder: '/superior_trends/cord-sets', fileName: `${name}.png`, mimeType: 'image/png' });
  if (!up) { console.error('RESULT upload failed', f); process.exit(1); }
  urls.push(up.url);
  console.log('RESULT uploaded', up.url);
}

const product = await p.product.create({ data: {
  name: 'Korean Cord Set',
  slug: 'korean-cord-set-st-cs-014',
  sku: SKU,
  type: 'SIMPLE',
  shortDescription: 'Korean-style two-piece co-ord set: relaxed short-sleeve collared shirt with matching wide-leg pants in a palm and leopard print.',
  longDescription: [
    'A relaxed Korean-style co-ord set made to be worn together or mixed and matched.',
    'The set includes an oversized short-sleeve collared shirt with a button-front and a high-low hem, and matching wide-leg pants with an elasticated waist for an easy, comfortable fit.',
    'Features a hand-painted look palm tree and leopard print placed along the shirt front, sleeves and pant hems, on a soft cream base.',
    'Styling tip: wear the set together for a polished look, or pair the shirt with jeans and the pants with a plain top. Add flat sandals or heels, and simple jewellery.',
    'Sizes: S, M, L, XL, XXL. Check the size guide before ordering. Colours shown: Navy Blue and Beige Brown.',
    'Care: machine wash cold on a gentle cycle, wash separately, do not bleach, iron on low heat.',
  ].join('\n\n'),
  categoryId: cat.id,
  brand: 'Superior Trends',
  mrp: 15,
  salePrice: 15,
  stock: 50,
  status: true,
  featured: true,
  trending: true,
  sizes: ['S', 'M', 'L', 'XL', 'XXL'],
  colors: [{ name: 'Navy Blue', hex: '#1f3a8a' }, { name: 'Beige Brown', hex: '#b9835a' }],
  weight: 0.6,
  seoTitle: 'Korean Cord Set — Palm Print Co-ord Set | Superior Trends',
  seoDescription: 'Shop the Korean Cord Set: a relaxed shirt and wide-leg pants co-ord in a palm and leopard print. Sizes S to XXL.',
} });
await p.productImage.createMany({ data: urls.map((u, i) => ({ productId: product.id, imageUrl: u, isMain: i === 0, sortOrder: i })) });
const check = await p.product.findUnique({ where: { id: product.id }, include: { images: { orderBy: { sortOrder: 'asc' } }, category: true } });
console.log('RESULT created', check!.name, '|', check!.sku, '| OMR', check!.salePrice?.toString(), '| sizes', check!.sizes.join(','), '| images', check!.images.length, '| category', check!.category?.slug);
await p.$disconnect(); process.exit(0);
