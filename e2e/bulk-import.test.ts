import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';

const { testAdminUser } = vi.hoisted(() => {
  const user = `bulk_admin_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const pass = `BulkPass_${globalThis.crypto.randomUUID()}`;
  process.env.ADMIN_USERNAME = user;
  process.env.ADMIN_PASSWORD = pass;
  process.env.ADMIN_JWT_SECRET = globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID();
  return { testAdminUser: user };
});

import app from '../server.ts';
import { createAdminToken, createEmployeeToken } from '../src/middleware/auth.ts';
import { assertNoBase64Image } from '../src/lib/bulk-import-store.ts';

describe('Phase 1 Smart Bulk Product Import E2E', () => {
  const adminToken = createAdminToken(testAdminUser);
  const employeeToken = createEmployeeToken('EMP001');

  let samplePngBuffer1: Buffer;
  let samplePngBuffer2: Buffer;
  let baselineProducts: any[] = [];
  const createdUploadUrls: string[] = [];
  const multiDraftIds: string[] = [];
  const zipDraftIds: string[] = [];

  beforeAll(async () => {
    samplePngBuffer1 = await sharp({
      create: {
        width: 160,
        height: 160,
        channels: 3,
        background: { r: 225, g: 29, b: 72 },
      },
    })
      .png()
      .toBuffer();

    samplePngBuffer2 = await sharp({
      create: {
        width: 180,
        height: 120,
        channels: 3,
        background: { r: 16, g: 185, b: 129 },
      },
    })
      .png()
      .toBuffer();

    const prodsRes = await request(app).get('/api/db/products');
    if (prodsRes.status === 200 && Array.isArray(prodsRes.body)) {
      baselineProducts = prodsRes.body;
    }
  });

  afterAll(() => {
    for (const url of createdUploadUrls) {
      if (url.startsWith('/uploads/bulk-import/')) {
        const filePath = path.resolve(process.cwd(), url.replace(/^\//, ''));
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore cleanup failure
          }
        }
      }
    }
    const testStoreFile = path.join(os.tmpdir(), 'amazon-duaa-bulk-import-drafts-test.json');
    if (fs.existsSync(testStoreFile)) {
      try {
        fs.unlinkSync(testStoreFile);
      } catch {
        // Ignore cleanup failure
      }
    }
  });

  it('1. Rejects unauthenticated and non-admin (employee) access to bulk import routes', async () => {
    const unauthRes = await request(app).get('/api/admin/bulk-import/drafts');
    expect(unauthRes.status).toBe(401);

    const empRes = await request(app)
      .get('/api/admin/bulk-import/drafts')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(empRes.status).toBe(403);
  });

  it('2. Blocks Base64 image payloads from ever passing Firestore guard', () => {
    expect(() =>
      assertNoBase64Image('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/')
    ).toThrow();
    expect(() => assertNoBase64Image('/uploads/bulk-import/sample.jpg')).not.toThrow();
  });

  it('3. Multi-image upload optimizes images, extracts Arabic metadata, creates independent unpriced drafts (no Base64, not published)', async () => {
    const res = await request(app)
      .post('/api/admin/bulk-import/analyze')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('files', samplePngBuffer1, { filename: 'serum_vitamin_c.png', contentType: 'image/png' })
      .attach('files', samplePngBuffer2, { filename: 'luxury_perfume.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.imported_count).toBe(2);
    expect(Array.isArray(res.body.drafts)).toBe(true);

    for (const draft of res.body.drafts) {
      multiDraftIds.push(draft.id);
      createdUploadUrls.push(draft.image_url);

      // Must be unpriced & pending_review
      expect(draft.price).toBeNull();
      expect(draft.original_price).toBeNull();
      expect(draft.status).toBe('pending_review');

      // Must have Arabic title, description, category
      expect(typeof draft.title_ar).toBe('string');
      expect(draft.title_ar.length).toBeGreaterThan(2);
      expect(typeof draft.description_ar).toBe('string');
      expect(draft.description_ar.length).toBeGreaterThan(5);
      expect(draft.category_id).toBeTruthy();
      expect(draft.category_name).toBeTruthy();

      // Must NOT contain Base64 and must be served from /uploads/bulk-import/*.jpg
      expect(draft.image_url.startsWith('data:')).toBe(false);
      expect(draft.image_url.startsWith('/uploads/bulk-import/')).toBe(true);
      expect(draft.image_url.endsWith('.jpg')).toBe(true);
      expect(draft.image_optimization.format).toBe('jpeg');
      expect(draft.image_optimization.optimized_bytes).toBeGreaterThan(0);

      // Verify static image URL is served cleanly
      const imgGet = await request(app).get(draft.image_url);
      expect(imgGet.status).toBe(200);
      expect(imgGet.headers['content-type']).toContain('image/jpeg');
    }

    // Confirm none of the drafts leaked into published catalog
    const prodsAfter = await request(app).get('/api/db/products');
    expect(prodsAfter.status).toBe(200);
    expect(prodsAfter.body.length).toBe(baselineProducts.length);
  });

  it('4. ZIP archive upload extracts valid product images, ignores __MACOSX & text files, and stages independent drafts', async () => {
    const zip = new AdmZip();
    zip.addFile('products/hair_oil.png', samplePngBuffer1);
    zip.addFile('products/lipstick_matte.png', samplePngBuffer2);
    zip.addFile('__MACOSX/._hair_oil.png', Buffer.from('junk'));
    zip.addFile('products/notes.txt', Buffer.from('not an image'));
    const zipBuffer = zip.toBuffer();

    const res = await request(app)
      .post('/api/admin/bulk-import/analyze')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('files', zipBuffer, {
        filename: 'supplier_catalog.zip',
        contentType: 'application/zip',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.imported_count).toBe(2);

    for (const draft of res.body.drafts) {
      zipDraftIds.push(draft.id);
      createdUploadUrls.push(draft.image_url);
      expect(draft.source_type).toBe('zip_archive');
      expect(draft.price).toBeNull();
      expect(draft.original_price).toBeNull();
      expect(draft.status).toBe('pending_review');
      expect(draft.image_url.startsWith('/uploads/bulk-import/')).toBe(true);
      expect(draft.image_url.startsWith('data:')).toBe(false);
    }
  });

  it('5. Persists drafts across subsequent GET requests and supports editing with optional/empty/zero price before publishing', async () => {
    const listRes = await request(app)
      .get('/api/admin/bulk-import/drafts')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    const allIds = listRes.body.drafts.map((d: any) => d.id);
    expect(allIds).toEqual(expect.arrayContaining([...multiDraftIds, ...zipDraftIds]));

    for (const optionalPrice of [undefined, null, '', 0]) {
      const editRes = await request(app)
        .patch(`/api/admin/bulk-import/drafts/${encodeURIComponent(multiDraftIds[0])}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title_ar: 'سيروم فيتامين سي المطور - مسودة مراجعة',
          description_ar: 'وصف تسويقي معدل من لوحة الإدارة.',
          category_id: 'skincare',
          brand: 'كود-تاجر-A12',
          stock_quantity: 20,
          ...(optionalPrice !== undefined ? { original_price: optionalPrice } : {}),
        });

      expect(editRes.status).toBe(200);
      expect(editRes.body.draft.title_ar).toBe('سيروم فيتامين سي المطور - مسودة مراجعة');
      expect(editRes.body.draft.brand).toBe('كود-تاجر-A12');
      expect(editRes.body.draft.status).toBe('pending_review');
      expect(editRes.body.draft.original_price).toBeNull();
    }

    const reloadRes = await request(app)
      .get('/api/admin/bulk-import/drafts')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reloadRes.status).toBe(200);
    const reloaded = reloadRes.body.drafts.find((d: any) => d.id === multiDraftIds[0]);
    expect(reloaded).toBeTruthy();
    expect(reloaded.title_ar).toBe('سيروم فيتامين سي المطور - مسودة مراجعة');
    expect(reloaded.description_ar).toBe('وصف تسويقي معدل من لوحة الإدارة.');
    expect(reloaded.brand).toBe('كود-تاجر-A12');
    expect(reloaded.image_url).toMatch(/^\/uploads\/bulk-import\/.+\.jpg$/);
  });

  it('6. Strictly blocks publishing without valid price > 0 OR without explicit admin approval (even directly via API)', async () => {
    const targetId = multiDraftIds[0];

    // Missing explicit approve: true
    const noApproveRes = await request(app)
      .post(`/api/admin/bulk-import/drafts/${encodeURIComponent(targetId)}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ original_price: 120 });
    expect(noApproveRes.status).toBe(400);

    // Invalid prices (null, 0, -25, empty string)
    for (const badPrice of [null, 0, -25, '', 'abc']) {
      const badRes = await request(app)
        .post(`/api/admin/bulk-import/drafts/${encodeURIComponent(targetId)}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approve: true, original_price: badPrice });

      expect(badRes.status).toBe(400);
    }

    // Bulk publish attempt where one item has a valid price and another has 0/missing price -> must block ALL!
    const mixedBulkRes = await request(app)
      .post('/api/admin/bulk-import/drafts/bulk-publish')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        approve: true,
        items: [
          { id: multiDraftIds[0], original_price: 95 },
          { id: multiDraftIds[1], original_price: 0 },
        ],
      });

    expect(mixedBulkRes.status).toBe(400);
    expect(Array.isArray(mixedBulkRes.body.invalidItems)).toBe(true);
    expect(mixedBulkRes.body.invalidItems.some((it: any) => it.id === multiDraftIds[1])).toBe(true);

    // Confirm catalog is STILL untouched
    const prodsAfter = await request(app).get('/api/db/products');
    expect(prodsAfter.body.length).toBe(baselineProducts.length);
  });

  it('7. Allows individual & bulk publish once valid prices > 0 and explicit approval are provided, leaving existing products untouched', async () => {
    // 1. Individual publish of multiDraftIds[0]
    const singlePub = await request(app)
      .post(`/api/admin/bulk-import/drafts/${encodeURIComponent(multiDraftIds[0])}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        approve: true,
        original_price: 145,
        discount_price: 119,
        stock_quantity: 20,
      });

    expect(singlePub.status).toBe(200);
    expect(singlePub.body.success).toBe(true);
    expect(singlePub.body.draft.status).toBe('approved_published');
    expect(singlePub.body.product.original_price).toBe(145);
    expect(singlePub.body.product.status).toBe('published');

    // 2. Bulk publish of multiDraftIds[1] + zipDraftIds[0] with individual prices
    const bulkPub = await request(app)
      .post('/api/admin/bulk-import/drafts/bulk-publish')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        approve: true,
        items: [
          { id: multiDraftIds[1], original_price: 210, stock_quantity: 12 },
          { id: zipDraftIds[0], original_price: 88, stock_quantity: 15 },
        ],
      });

    expect(bulkPub.status).toBe(200);
    expect(bulkPub.body.success).toBe(true);
    expect(bulkPub.body.publishedCount).toBe(2);

    // 3. Delete remaining unpublished draft zipDraftIds[1]
    const delRes = await request(app)
      .delete(`/api/admin/bulk-import/drafts/${encodeURIComponent(zipDraftIds[1])}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.status).toBe(200);

    // 4. Verify catalog has baseline + 3 newly published products, and all baseline products remain intact
    const prodsFinal = await request(app).get('/api/db/products');
    expect(prodsFinal.status).toBe(200);
    expect(prodsFinal.body.length).toBe(baselineProducts.length + 3);

    for (const orig of baselineProducts) {
      const found = prodsFinal.body.find((p: any) => p.productId === orig.productId);
      expect(found).toBeTruthy();
      expect(found.titleAr).toBe(orig.titleAr);
      expect(found.originalPrice).toBe(orig.originalPrice);
    }
  });
});
