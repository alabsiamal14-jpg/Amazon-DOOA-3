import { describe, it, expect } from 'vitest';
import app from '../server.ts';
import request from 'supertest';
import { createAdminToken } from '../src/middleware/auth.ts';

describe('Amazon Duaa API Health & Security Audit', () => {
  const validAdminToken = createAdminToken('admin');

  it('GET /api/db/products remains publicly accessible for storefront', async () => {
    const res = await request(app).get('/api/db/products');
    expect([200, 500]).toContain(res.status);
  });

  it('GET /api/nonexistent returns 404 JSON', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('Unauthenticated requests to protected admin/order endpoints return 401', async () => {
    const checks = await Promise.all([
      request(app).get('/api/admin/firebase-health'),
      request(app).get('/api/admin/verify'),
      request(app).get('/api/admin/orders/sync-status'),
      request(app).get('/api/admin/orders/outbox-status'),
      request(app).get('/api/db/orders'),
      request(app).get('/api/db/orders/NONEXISTENT-123'),
      request(app).post('/api/db/products').send({ id: 'hack', title_ar: 'hack' }),
      request(app).delete('/api/db/products/nonexistent-id'),
      request(app).patch('/api/db/orders/NONEXISTENT-123/status').send({ status: 'cancelled' }),
      request(app).patch('/api/db/orders/NONEXISTENT-123/driver').send({ driverName: 'x', driverPhone: '123' }),
      request(app).patch('/api/db/orders/NONEXISTENT-123/delivery').send({ status: 'delivered' }),
      request(app).post('/api/ai/copilot').send({ message: 'test' }),
      request(app).post('/api/generate-product-content').send({ imageBase64: 'abc' }),
    ]);

    for (const res of checks) {
      expect(res.status).toBe(401);
    }
  });

  it('Forged Bearer token is rejected with 401', async () => {
    const res = await request(app)
      .get('/api/db/orders')
      .set('Authorization', 'Bearer fake.forged.token');
    expect(res.status).toBe(401);
  });

  it('POST /api/admin/login rejects invalid credentials with 401', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'wrong-password-123' });
    expect(res.status).toBe(401);
  });

  it('POST /api/admin/login succeeds with valid credentials and returns signed token', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toHaveProperty('role', 'superadmin');
  });

  it('GET /api/admin/verify succeeds with valid signed token', async () => {
    const res = await request(app)
      .get('/api/admin/verify')
      .set('Authorization', `Bearer ${validAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('GET /api/admin/firebase-health returns 200 with admin token', async () => {
    const res = await request(app)
      .get('/api/admin/firebase-health')
      .set('Authorization', `Bearer ${validAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('GET /api/admin/orders/sync-status returns 200 with admin token', async () => {
    const res = await request(app)
      .get('/api/admin/orders/sync-status')
      .set('Authorization', `Bearer ${validAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('postgresOrdersCount');
  });

  it('GET /api/admin/orders/outbox-status returns 200 with admin token', async () => {
    const res = await request(app)
      .get('/api/admin/orders/outbox-status')
      .set('Authorization', `Bearer ${validAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('totalOutboxEvents');
  });
});
