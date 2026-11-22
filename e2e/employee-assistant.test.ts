import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

const { testAdminUser, testAdminPass } = vi.hoisted(() => {
  const user = `sec_admin_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const pass = `SecPass_${globalThis.crypto.randomUUID()}`;
  process.env.ADMIN_USERNAME = user;
  process.env.ADMIN_PASSWORD = pass;
  process.env.ADMIN_JWT_SECRET = globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID();
  return { testAdminUser: user, testAdminPass: pass };
});

import app from '../server.ts';
import { createAdminToken } from '../src/middleware/auth.ts';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Smart Employee Assistant (EMP001..EMP008) & Admin Draft Review E2E', () => {
  const adminToken = createAdminToken(testAdminUser);
  let emp001Token = '';
  let emp002Token = '';
  let createdSingleDraftId = '';
  let createdBatchDraftId = '';
  let baselineProductsCount = 0;

  beforeAll(async () => {
    const prodsRes = await request(app).get('/api/db/products');
    if (prodsRes.status === 200 && Array.isArray(prodsRes.body)) {
      baselineProductsCount = prodsRes.body.length;
    }
  });

  it('1. Employee login succeeds with EMP001..EMP008 without PIN/password and rejects invalid codes', async () => {
    for (const code of ['EMP001', 'EMP002', 'EMP008']) {
      const res = await request(app).post('/api/employee/login').send({ employeeCode: code });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.employee.code).toBe(code);
      expect(res.body.employee.role).toBe('employee');
      expect(typeof res.body.token).toBe('string');
      if (code === 'EMP001') emp001Token = res.body.token;
      if (code === 'EMP002') emp002Token = res.body.token;
    }

    for (const badCode of ['EMP000', 'EMP009', 'ADMIN', '']) {
      const res = await request(app).post('/api/employee/login').send({ employeeCode: badCode });
      expect(res.status).toBe(401);
    }
  });

  it('2. Single image upload analysis returns extracted draft with price = null & no auto-publish', async () => {
    const res = await request(app)
      .post('/api/employee-assistant/analyze')
      .set('Authorization', `Bearer ${emp001Token}`)
      .send({
        mode: 'single_image',
        chatText: 'سيروم فيتامين سي للوجه 30 مل',
        images: [TINY_PNG_DATA_URL],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.drafts)).toBe(true);
    expect(res.body.drafts.length).toBe(1);

    const draft = res.body.drafts[0];
    expect(draft.title_ar).toBeTruthy();
    expect(draft.description_ar).toBeTruthy();
    expect(draft.category_id).toBeTruthy();
    expect(draft.ingredients).toBeTruthy();
    expect(draft.how_to_use).toBeTruthy();
    expect(draft.price).toBeNull();
    expect(draft.original_price).toBeNull();
    expect(draft.discount_price).toBeNull();
    expect(draft.status).toBe('pending_pricing');
    expect(draft.pricing_status_label).toBe('بانتظار التسعير من الإدارة');
  });

  it('3. Multiple images for the same product keeps all gallery_images in one unpriced draft', async () => {
    const res = await request(app)
      .post('/api/employee-assistant/analyze')
      .set('Authorization', `Bearer ${emp001Token}`)
      .send({
        mode: 'multi_image_single_product',
        chatText: 'كريم ترطيب ليلي فاخر من عدة زوايا',
        images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
      });

    expect(res.status).toBe(200);
    expect(res.body.drafts.length).toBe(1);
    expect(res.body.drafts[0].gallery_images.length).toBe(3);
    expect(res.body.drafts[0].price).toBeNull();
    expect(res.body.drafts[0].status).toBe('pending_pricing');
  });

  it('4. Batch images and WhatsApp chat paste extract multiple unpriced drafts (price = null)', async () => {
    const batchRes = await request(app)
      .post('/api/employee-assistant/analyze')
      .set('Authorization', `Bearer ${emp001Token}`)
      .send({
        mode: 'batch_images',
        images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
      });

    expect(batchRes.status).toBe(200);
    expect(batchRes.body.drafts.length).toBe(2);
    for (const d of batchRes.body.drafts) {
      expect(d.price).toBeNull();
      expect(d.status).toBe('pending_pricing');
    }

    const waRes = await request(app)
      .post('/api/employee-assistant/analyze')
      .set('Authorization', `Bearer ${emp001Token}`)
      .send({
        mode: 'whatsapp_chat',
        chatText: '1- سيروم النياسيناميد 30 مل 85 ريال\n2- ماسك الكولاجين الذهبي 120 ريال',
      });

    expect(waRes.status).toBe(200);
    expect(waRes.body.drafts.length).toBe(2);
    for (const d of waRes.body.drafts) {
      expect(d.price).toBeNull();
      expect(d.original_price).toBeNull();
      expect(d.status).toBe('pending_pricing');
    }
  });

  it('5. Creating draft stores in ai_employee_drafts with pending_pricing & forces price = null', async () => {
    const createRes = await request(app)
      .post('/api/employee-assistant/drafts')
      .set('Authorization', `Bearer ${emp001Token}`)
      .send({
        title_ar: 'تونر الورد الطبيعي للموظفة الأولى',
        description_ar: 'تونر مرطب خالي من الكحول',
        category_id: 'skincare',
        brand: 'RoseAtelier',
        size_or_volume: '200 مل',
        ingredients: 'ماء الورد الدمشقي، جلسرين',
        how_to_use: 'يمسح بقطنة صباحاً ومساءً',
        tags: ['تونر', 'عناية_بالبشرة'],
        image_url: TINY_PNG_DATA_URL,
        gallery_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
        source_type: 'multi_image_single_product',
        // Attempted client bypass values must be ignored by server:
        price: 999,
        original_price: 999,
        status: 'published',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    const saved = createRes.body.draft;
    createdSingleDraftId = saved.id;
    expect(saved.employee_code).toBe('EMP001');
    expect(saved.price).toBeNull();
    expect(saved.original_price).toBeNull();
    expect(saved.discount_price).toBeNull();
    expect(saved.status).toBe('pending_pricing');
    expect(saved.pricing_status_label).toBe('بانتظار التسعير من الإدارة');
    expect(saved.gallery_images.length).toBe(2);

    // Create another draft under EMP002 to verify employee isolation & batch deletion later
    const emp2Res = await request(app)
      .post('/api/employee-assistant/drafts')
      .set('Authorization', `Bearer ${emp002Token}`)
      .send({
        title_ar: 'عطر مسك أبيض - مسودة ثانية',
        category_id: 'perfumes',
        image_url: TINY_PNG_DATA_URL,
        source_type: 'single_image',
      });
    expect(emp2Res.status).toBe(201);
    createdBatchDraftId = emp2Res.body.draft.id;

    // EMP001 only sees their own drafts
    const emp1List = await request(app)
      .get('/api/employee-assistant/drafts')
      .set('Authorization', `Bearer ${emp001Token}`);
    expect(emp1List.status).toBe(200);
    expect(emp1List.body.drafts.every((d: any) => d.employee_code === 'EMP001')).toBe(true);
  });

  it('6. Employee cannot publish directly, modify prices, delete products, view orders, or open admin endpoints (403)', async () => {
    const blockedRequests = await Promise.all([
      request(app)
        .post('/api/db/products')
        .set('Authorization', `Bearer ${emp001Token}`)
        .send({ id: 'emp-hack-prod', title_ar: 'منتج غير مسموح', original_price: 50 }),
      request(app)
        .patch('/api/db/products/prod-1/status')
        .set('Authorization', `Bearer ${emp001Token}`)
        .send({ status: 'published' }),
      request(app)
        .delete('/api/db/products/prod-1')
        .set('Authorization', `Bearer ${emp001Token}`),
      request(app)
        .get('/api/db/orders')
        .set('Authorization', `Bearer ${emp001Token}`),
      request(app)
        .get('/api/admin/verify')
        .set('Authorization', `Bearer ${emp001Token}`),
      request(app)
        .get('/api/employee-assistant/drafts/count')
        .set('Authorization', `Bearer ${emp001Token}`),
      request(app)
        .patch(`/api/employee-assistant/drafts/${createdSingleDraftId}`)
        .set('Authorization', `Bearer ${emp001Token}`)
        .send({ original_price: 100 }),
      request(app)
        .post(`/api/employee-assistant/drafts/${createdSingleDraftId}/publish`)
        .set('Authorization', `Bearer ${emp001Token}`)
        .send({ original_price: 100 }),
      request(app)
        .delete(`/api/employee-assistant/drafts/${createdSingleDraftId}`)
        .set('Authorization', `Bearer ${emp001Token}`),
    ]);

    for (const res of blockedRequests) {
      expect(res.status).toBe(403);
    }

    // Storefront products count must remain unchanged (no direct publish)
    const prodsAfter = await request(app).get('/api/db/products?fresh=1');
    expect(prodsAfter.status).toBe(200);
    expect(prodsAfter.body.length).toBe(baselineProductsCount);
  });

  it('7. Admin reviews Pending Employee Drafts counter, edits, sets price, publishes, and deletes cleanly', async () => {
    // 7a. Admin sees pending count >= 2
    const countBefore = await request(app)
      .get('/api/employee-assistant/drafts/count')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(countBefore.status).toBe(200);
    expect(countBefore.body.pendingCount).toBeGreaterThanOrEqual(2);

    // 7b. Admin cannot publish without setting a valid positive price
    const noPriceRes = await request(app)
      .post(`/api/employee-assistant/drafts/${createdSingleDraftId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ original_price: 0 });
    expect(noPriceRes.status).toBe(400);

    // 7c. Admin edits draft details
    const editRes = await request(app)
      .patch(`/api/employee-assistant/drafts/${createdSingleDraftId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title_ar: 'تونر الورد الفاخر - معتمد من الإدارة' });
    expect(editRes.status).toBe(200);
    expect(editRes.body.draft.title_ar).toBe('تونر الورد الفاخر - معتمد من الإدارة');
    expect(editRes.body.draft.status).toBe('pending_pricing');

    // 7d. Admin sets price and publishes draft to catalog
    const publishRes = await request(app)
      .post(`/api/employee-assistant/drafts/${createdSingleDraftId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        original_price: 140,
        discount_price: 115,
        stock_quantity: 12,
      });

    expect(publishRes.status).toBe(200);
    expect(publishRes.body.success).toBe(true);
    expect(publishRes.body.draft.status).toBe('published');
    expect(publishRes.body.draft.original_price).toBe(140);
    expect(publishRes.body.product.title_ar).toBe('تونر الورد الفاخر - معتمد من الإدارة');
    expect(publishRes.body.product.original_price).toBe(140);
    expect(publishRes.body.product.discount_price).toBe(115);
    expect(publishRes.body.product.status).toBe('published');

    // Confirm published product is now returned by storefront catalog API
    const prodsAfterPublish = await request(app).get('/api/db/products?fresh=1');
    expect(prodsAfterPublish.status).toBe(200);
    expect(
      (prodsAfterPublish.body as any[]).some(
        (p) => p.productId === publishRes.body.product.id
      )
    ).toBe(true);

    // 7e. Admin deletes the second draft
    const deleteRes = await request(app)
      .delete(`/api/employee-assistant/drafts/${createdBatchDraftId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    const countAfter = await request(app)
      .get('/api/employee-assistant/drafts/count')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(countAfter.status).toBe(200);
    expect(countAfter.body.pendingCount).toBe(countBefore.body.pendingCount - 2);
  });

  it(
    '8. Cookie-authenticated Admin sees employee drafts directly, edits all fields (images/stock/category/price), publishes to Storefront, and hides unapproved drafts from customers',
    async () => {
      // 8a. Sign in as Admin via HttpOnly Cookie login endpoint
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send({ username: testAdminUser, password: testAdminPass });
    expect(loginRes.status).toBe(200);
    const setCookies = loginRes.headers['set-cookie'];
    expect(Array.isArray(setCookies) && setCookies.length > 0).toBe(true);
    const cookieHeader = (setCookies as string[]).map((c) => c.split(';')[0]).join('; ');

    // 8b. Employee creates a new incomplete draft (missing description & price)
    const empCreateRes = await request(app)
      .post('/api/employee-assistant/drafts')
      .set('Authorization', `Bearer ${emp001Token}`)
      .send({
        title_ar: 'سيروم الهيالورونيك المكثف - اختبار مباشر',
        category_id: 'skincare',
        image_url: TINY_PNG_DATA_URL,
        source_type: 'single_image',
      });
    expect(empCreateRes.status).toBe(201);
    const liveDraftId = empCreateRes.body.draft.id as string;

    // 8c. Draft must NOT appear in public storefront catalog while pending_pricing
    const publicBefore = await request(app).get('/api/db/products?fresh=1');
    expect(publicBefore.status).toBe(200);
    expect(
      (publicBefore.body as any[]).some((p) =>
        String(p.titleAr || p.title_ar || '').includes('سيروم الهيالورونيك المكثف - اختبار مباشر')
      )
    ).toBe(false);

    // 8d. Cookie-authenticated Admin immediately sees the draft in «منتجات مساعد الموظفين» endpoint
    const adminListRes = await request(app)
      .get('/api/employee-assistant/drafts')
      .set('Cookie', cookieHeader);
    expect(adminListRes.status).toBe(200);
    const foundDraft = (adminListRes.body.drafts as any[]).find((d) => d.id === liveDraftId);
    expect(foundDraft).toBeTruthy();
    expect(foundDraft.status).toBe('pending_pricing');

    // 8e. Publishing before setting original_price fails (400), and publishing with empty description_ar fails (400)
    const noPriceYetPub = await request(app)
      .post(`/api/employee-assistant/drafts/${liveDraftId}/publish`)
      .set('Cookie', cookieHeader)
      .send({});
    expect(noPriceYetPub.status).toBe(400);

    await request(app)
      .patch(`/api/employee-assistant/drafts/${liveDraftId}`)
      .set('Cookie', cookieHeader)
      .send({ description_ar: '' });
    const incompletePub = await request(app)
      .post(`/api/employee-assistant/drafts/${liveDraftId}/publish`)
      .set('Cookie', cookieHeader)
      .send({ original_price: 150 });
    expect(incompletePub.status).toBe(400);

    // 8f. Invalid discount_price >= original_price is rejected (400)
    const badDiscountEdit = await request(app)
      .patch(`/api/employee-assistant/drafts/${liveDraftId}`)
      .set('Cookie', cookieHeader)
      .send({ original_price: 150, discount_price: 160 });
    expect(badDiscountEdit.status).toBe(400);

    // 8g. Admin edits ALL fields (title, description, category, images, stock, tags, pricing)
    const updatedImg = 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=800&q=80';
    const galleryImg2 = 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80';
    const fullEditRes = await request(app)
      .patch(`/api/employee-assistant/drafts/${liveDraftId}`)
      .set('Cookie', cookieHeader)
      .send({
        title_ar: 'سيروم الهيالورونيك النقي المعتمد',
        description_ar: 'سيروم ترطيب عميق بحمض الهيالورونيك النقي للبشرة الحساسة.',
        category_id: 'skincare',
        brand: 'DuaaPure',
        size_or_volume: '50 مل',
        ingredients: 'حمض الهيالورونيك، بانثينول، ماء الورد',
        how_to_use: 'يوضع صباحاً ومساءً على بشرة رطبة.',
        tags: ['هيالورونيك', 'ترطيب_عميق'],
        image_url: updatedImg,
        gallery_images: [updatedImg, galleryImg2],
        stock_quantity: 25,
        original_price: 185,
        discount_price: 149,
      });
    expect(fullEditRes.status).toBe(200);
    expect(fullEditRes.body.draft.stock_quantity).toBe(25);
    expect(fullEditRes.body.draft.image_url).toBe(updatedImg);
    expect(fullEditRes.body.draft.gallery_images).toEqual([updatedImg, galleryImg2]);
    expect(fullEditRes.body.draft.original_price).toBe(185);
    expect(fullEditRes.body.draft.discount_price).toBe(149);
    expect(fullEditRes.body.draft.status).toBe('pending_pricing');

    // 8h. Admin publishes the completed draft via cookie auth
    const pubRes = await request(app)
      .post(`/api/employee-assistant/drafts/${liveDraftId}/publish`)
      .set('Cookie', cookieHeader)
      .send({});
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.success).toBe(true);
    expect(pubRes.body.draft.status).toBe('published');
    expect(pubRes.body.product.status).toBe('published');
    expect(pubRes.body.product.stock_quantity).toBe(25);
    expect(pubRes.body.product.image_url).toBe(updatedImg);
    expect(pubRes.body.product.gallery_images).toEqual([updatedImg, galleryImg2]);

    // 8i. Published product immediately appears in public Storefront catalog with edited fields
    const publicAfter = await request(app).get('/api/db/products?fresh=1');
    expect(publicAfter.status).toBe(200);
    const liveProduct = (publicAfter.body as any[]).find((p) => p.productId === pubRes.body.product.id);
    expect(liveProduct).toBeTruthy();
    expect(liveProduct.titleAr).toBe('سيروم الهيالورونيك النقي المعتمد');
    expect(liveProduct.stockQuantity).toBe(25);
    expect(liveProduct.imageUrl).toBe(updatedImg);
    expect(liveProduct.originalPrice).toBe(185);
    expect(liveProduct.discountPrice).toBe(149);
    expect(liveProduct.status).toBe('published');

    // 8j. Unapproved draft product in products table is hidden from customers & blocked at checkout
    const draftProdId = `unapproved-draft-${Date.now()}`;
    const createDraftProd = await request(app)
      .post('/api/db/products')
      .set('Cookie', cookieHeader)
      .send({
        id: draftProdId,
        title_ar: 'منتج مسودة غير منشور للعملاء',
        description_ar: 'مسودة داخلية',
        original_price: 99,
        stock_quantity: 5,
        category_id: 'skincare',
        image_url: TINY_PNG_DATA_URL,
        status: 'draft',
      });
    expect(createDraftProd.status).toBe(200);

    // Public catalog MUST NOT return status === 'draft'
    const guestProds = await request(app).get('/api/db/products?fresh=1');
    expect(guestProds.status).toBe(200);
    expect((guestProds.body as any[]).some((p) => p.productId === draftProdId)).toBe(false);

    // Admin catalog DOES return status === 'draft'
    const adminProds = await request(app)
      .get('/api/db/products?fresh=1')
      .set('Cookie', cookieHeader);
    expect(adminProds.status).toBe(200);
    expect((adminProds.body as any[]).some((p) => p.productId === draftProdId)).toBe(true);

    // Customer checkout MUST reject unapproved/draft product
    const blockedCheckout = await request(app)
      .post('/api/orders/checkout')
      .send({
        customer_name: 'اختبار أمان',
        customer_phone: '0501234567',
        shipping_address: 'الرياض',
        items: [{ productId: draftProdId, quantity: 1 }],
      });
    expect(blockedCheckout.status).toBe(400);

    // Cleanup test draft product
    await request(app)
      .delete(`/api/db/products/${draftProdId}`)
      .set('Cookie', cookieHeader);
  }, 25000);

  it('9. Sets Secure; SameSite=None cookie behind HTTPS reverse proxy even when X-Forwarded-Proto is http, and falls back to valid Admin cookie if Bearer token is stale/invalid', async () => {
    const proxyHost = 'ais-dev-example.europe-west2.run.app';
    const proxyLogin = await request(app)
      .post('/api/admin/login')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Forwarded-Host', proxyHost)
      .set('Origin', `https://${proxyHost}`)
      .send({ username: testAdminUser, password: testAdminPass });

    expect(proxyLogin.status).toBe(200);
    expect(typeof proxyLogin.body.token).toBe('string');

    const cookies = proxyLogin.headers['set-cookie'] as string[];
    expect(Array.isArray(cookies) && cookies.length > 0).toBe(true);
    const cookieStr = cookies[0];
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('Secure');
    expect(cookieStr.toLowerCase()).toContain('samesite=none');

    const cookiePair = cookieStr.split(';')[0];

    // Even if a stale/expired/customer Bearer token is also sent, valid Admin cookie still loads drafts & verifies admin
    const draftsWithDualAuth = await request(app)
      .get('/api/employee-assistant/drafts')
      .set('Cookie', cookiePair)
      .set('Authorization', 'Bearer invalid.jwt.token');
    expect(draftsWithDualAuth.status).toBe(200);
    expect(Array.isArray(draftsWithDualAuth.body.drafts)).toBe(true);

    const verifyWithDualAuth = await request(app)
      .get('/api/admin/verify')
      .set('Cookie', cookiePair)
      .set('Authorization', 'Bearer invalid.jwt.token');
    expect(verifyWithDualAuth.status).toBe(200);
    expect(verifyWithDualAuth.body.ok).toBe(true);

    // Bearer token returned by login also works directly if 3P cookies are disabled
    const draftsWithBearer = await request(app)
      .get('/api/employee-assistant/drafts')
      .set('Authorization', `Bearer ${proxyLogin.body.token}`);
    expect(draftsWithBearer.status).toBe(200);
  }, 25000);
});
