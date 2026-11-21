import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';

const { testAdminUser } = vi.hoisted(() => {
  const user = `smart_admin_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const pass = `SmartPass_${globalThis.crypto.randomUUID()}`;
  process.env.ADMIN_USERNAME = user;
  process.env.ADMIN_PASSWORD = pass;
  process.env.ADMIN_JWT_SECRET = globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID();
  return { testAdminUser: user };
});

import app from '../server.ts';
import { createAdminToken, createEmployeeToken } from '../src/middleware/auth.ts';

describe('Standalone AI Smart Assistant (المساعد الذكي الشامل) E2E', () => {
  const adminToken = createAdminToken(testAdminUser);
  const employeeToken = createEmployeeToken('EMP001');

  let imgSerum: Buffer;
  let imgOudFront: Buffer;
  let imgOudBack: Buffer;
  let baselineProducts: any[] = [];
  const createdDraftIds: string[] = [];
  const trackUploadUrls = new Set<string>();

  beforeAll(async () => {
    const makePatternPng = (svg: string) => sharp(Buffer.from(svg)).png().toBuffer();

    imgSerum = await makePatternPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">
        <rect width="160" height="160" fill="#fff1f2"/>
        <rect x="55" y="25" width="50" height="110" rx="10" fill="#e11d48"/>
        <rect x="68" y="10" width="24" height="20" fill="#1c1917"/>
      </svg>`
    );

    imgOudFront = await makePatternPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
        <rect width="180" height="180" fill="#fef3c7"/>
        <circle cx="90" cy="95" r="48" fill="#78350f"/>
        <rect x="75" y="25" width="30" height="25" fill="#d97706"/>
      </svg>`
    );

    imgOudBack = await makePatternPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
        <rect width="180" height="180" fill="#f5f5f4"/>
        <rect x="40" y="35" width="100" height="115" fill="#44403c"/>
        <line x1="55" y1="60" x2="125" y2="60" stroke="#fbbf24" stroke-width="6"/>
        <line x1="55" y1="90" x2="115" y2="90" stroke="#e7e5e4" stroke-width="4"/>
      </svg>`
    );

    const prodsRes = await request(app).get('/api/db/products');
    if (prodsRes.status === 200 && Array.isArray(prodsRes.body)) {
      baselineProducts = prodsRes.body;
    }
  });

  afterAll(() => {
    for (const url of trackUploadUrls) {
      if (url.startsWith('/uploads/bulk-import/')) {
        const p = path.resolve(process.cwd(), url.replace(/^\//, ''));
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {
            // Ignore cleanup failure
          }
        }
      }
    }
    for (const tmpName of [
      'amazon-duaa-smart-assistant-drafts-test.json',
      'amazon-duaa-smart-assistant-staged-test.json',
    ]) {
      const f = path.join(os.tmpdir(), tmpName);
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {
          // Ignore cleanup failure
        }
      }
    }
  });

  it('1. Enforces admin-only RBAC on all smart-assistant endpoints', async () => {
    const unauth = await request(app).get('/api/admin/smart-assistant/drafts');
    expect(unauth.status).toBe(401);

    const emp = await request(app)
      .get('/api/admin/smart-assistant/drafts')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(emp.status).toBe(403);
  });

  it('2. Ingests multi-images & ZIP archive, unpacks images, and stages them without publishing or pricing', async () => {
    const zip = new AdmZip();
    zip.addFile('catalog/perfume_oud_front.png', imgOudFront);
    zip.addFile('catalog/perfume_oud_back.png', imgOudBack);
    zip.addFile('__MACOSX/._perfume_oud_front.png', Buffer.from('junk'));
    zip.addFile('catalog/readme.txt', Buffer.from('ignored'));

    const ingestRes = await request(app)
      .post('/api/admin/smart-assistant/ingest')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('files', imgSerum, { filename: 'vitamin_c_serum.png', contentType: 'image/png' })
      .attach('files', zip.toBuffer(), { filename: 'supplier_bundle.zip', contentType: 'application/zip' });

    expect(ingestRes.status).toBe(200);
    expect(ingestRes.body.success).toBe(true);
    expect(ingestRes.body.staged_count).toBe(3);
    expect(ingestRes.body.zip_count).toBe(1);

    for (const s of ingestRes.body.staged) {
      trackUploadUrls.add(s.image_url);
      expect(s.image_url.startsWith('/uploads/bulk-import/')).toBe(true);
      expect(s.image_url.startsWith('data:')).toBe(false);
    }

    // Confirm storefront catalog untouched
    const prodsNow = await request(app).get('/api/db/products');
    expect(prodsNow.body.length).toBe(baselineProducts.length);
  });

  it('3. Conversational Arabic command "حلل هذه الصور" extracts products, groups same-product multi-angles, and leaves ALL prices null', async () => {
    const cmdRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'حلل هذه الصور وجهز المنتجات للمراجعة' });

    expect(cmdRes.status).toBe(200);
    expect(cmdRes.body.success).toBe(true);
    expect(cmdRes.body.actionExecuted).toBe('analyze_staged');

    const drafts = cmdRes.body.drafts as any[];
    // 3 uploaded images: vitamin_c_serum (1) + perfume_oud_front & perfume_oud_back grouped together (1) = 2 product cards!
    expect(drafts.length).toBe(2);

    const groupedOud = drafts.find((d) => d.gallery_images.length === 2);
    expect(groupedOud).toBeTruthy();

    for (const d of drafts) {
      createdDraftIds.push(d.id);
      d.gallery_images.forEach((u: string) => trackUploadUrls.add(u));
      expect(d.price).toBeNull();
      expect(d.original_price).toBeNull();
      expect(d.discount_price).toBeNull();
      expect(d.status).toBe('pending_review');
      expect(d.title_ar.length).toBeGreaterThan(2);
      expect(d.description_ar.length).toBeGreaterThan(10);
      expect(d.category_id).toBeTruthy();
    }
  });

  it('4. Refuses automatic pricing requests and preserves null prices across AI image enhancement & description commands', async () => {
    // Attempt to ask assistant to auto-set prices
    const refuseRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'اقترح وحدد الأسعار تلقائياً للمنتجات' });

    expect(refuseRes.status).toBe(200);
    expect(refuseRes.body.actionExecuted).toBe('refuse_auto_price');
    for (const d of refuseRes.body.drafts) {
      expect(d.original_price).toBeNull();
    }

    // Enhance product images via Arabic command
    const enhRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'حسّن صور المنتجات' });

    expect(enhRes.status).toBe(200);
    expect(enhRes.body.actionExecuted).toBe('enhance_images');
    for (const d of enhRes.body.drafts) {
      expect(d.enhanced).toBe(true);
      expect(d.original_price).toBeNull();
      d.gallery_images.forEach((u: string) => trackUploadUrls.add(u));
    }

    // Rewrite descriptions & classify via Arabic commands
    const descRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'عدّل أوصاف هذه المنتجات', selectedDraftIds: [createdDraftIds[0]] });
    expect(descRes.status).toBe(200);
    expect(descRes.body.actionExecuted).toBe('rewrite_descriptions');

    const clsRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'صنّف المنتجات حسب نوعها' });
    expect(clsRes.status).toBe(200);
    expect(clsRes.body.actionExecuted).toBe('classify_products');
  });

  it('5. Detects duplicate images across staged drafts and merges/removes duplicates cleanly', async () => {
    // Upload an exact duplicate image of imgSerum
    const dupRes = await request(app)
      .post('/api/admin/smart-assistant/analyze')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('files', imgSerum, { filename: 'duplicate_serum_copy.png', contentType: 'image/png' });

    expect(dupRes.status).toBe(200);
    const dupDraftId = dupRes.body.drafts[0].id;
    dupRes.body.drafts[0].gallery_images.forEach((u: string) => trackUploadUrls.add(u));

    const detectRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'راجع المنتجات واكتشف الصور المكررة' });

    expect(detectRes.status).toBe(200);
    expect(detectRes.body.actionExecuted).toBe('detect_duplicates');
    expect(detectRes.body.duplicateGroups.length).toBeGreaterThanOrEqual(1);

    const dedupRes = await request(app)
      .post('/api/admin/smart-assistant/command')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'احذف الصور المكررة' });

    expect(dedupRes.status).toBe(200);
    expect(dedupRes.body.actionExecuted).toBe('deduplicate_remove');
    // Still ensures duplicate draft was consolidated cleanly
    expect(dedupRes.body.drafts.some((d: any) => d.id === dupDraftId)).toBe(false);
  });

  it('6. Allows optional pricing (empty/0 or manual price) with explicit approval, rejects negative/invalid prices, and keeps baseline catalog intact', async () => {
    const listRes = await request(app)
      .get('/api/admin/smart-assistant/drafts')
      .set('Authorization', `Bearer ${adminToken}`);
    const drafts = listRes.body.drafts as any[];
    expect(drafts.length).toBe(2);

    const target = drafts[0];

    // Missing approve: true must still be blocked
    const noApprove = await request(app)
      .post(`/api/admin/smart-assistant/drafts/${encodeURIComponent(target.id)}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ original_price: 150 });
    expect(noApprove.status).toBe(400);

    // Negative or non-numeric price must be rejected
    const negativePrice = await request(app)
      .post(`/api/admin/smart-assistant/drafts/${encodeURIComponent(target.id)}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approve: true, original_price: -25 });
    expect(negativePrice.status).toBe(400);

    const badPrice = await request(app)
      .post(`/api/admin/smart-assistant/drafts/${encodeURIComponent(target.id)}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approve: true, original_price: 'abc' });
    expect(badPrice.status).toBe(400);

    // Single publish WITHOUT price (optional) succeeds when approve: true
    const unpricedSingle = await request(app)
      .post(`/api/admin/smart-assistant/drafts/${encodeURIComponent(target.id)}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approve: true, original_price: null });
    expect(unpricedSingle.status).toBe(200);
    expect(unpricedSingle.body.success).toBe(true);
    expect(unpricedSingle.body.product.original_price).toBe(0);
    expect(unpricedSingle.body.draft.status).toBe('approved_published');

    // Bulk publish supports mixing unpriced & manually priced drafts
    const bulkRes = await request(app)
      .post('/api/admin/smart-assistant/drafts/bulk-publish')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        approve: true,
        items: [
          { id: drafts[0].id, original_price: null },
          { id: drafts[1].id, original_price: 220 },
        ],
      });

    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.success).toBe(true);
    expect(bulkRes.body.publishedCount).toBe(2);
    expect(bulkRes.body.products[0].original_price).toBe(0);
    expect(bulkRes.body.products[1].original_price).toBe(220);

    // Confirm baseline products untouched & 2 new products published cleanly
    const prodsFinal = await request(app).get('/api/db/products');
    expect(prodsFinal.status).toBe(200);
    expect(prodsFinal.body.length).toBe(baselineProducts.length + 2);

    const publishedZero = prodsFinal.body.find(
      (p: any) => p.productId === bulkRes.body.products[0].id
    );
    expect(publishedZero).toBeTruthy();
    expect(publishedZero.originalPrice).toBe(0);

    for (const orig of baselineProducts) {
      const found = prodsFinal.body.find((p: any) => p.productId === orig.productId);
      expect(found).toBeTruthy();
      expect(found.titleAr).toBe(orig.titleAr);
      expect(found.originalPrice).toBe(orig.originalPrice);
    }
  });
});
