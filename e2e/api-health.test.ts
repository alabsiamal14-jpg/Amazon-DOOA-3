import { describe, it, expect } from 'vitest';
import app from './server.ts';
import request from 'supertest';

describe('Amazon Duaa API Health Check', () => {
  it('GET /api/admin/firebase-health returns 200 and json', async () => {
    const res = await request(app).get('/api/admin/firebase-health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('GET /api/db/products returns 200 or 500 without crashing process', async () => {
    const res = await request(app).get('/api/db/products');
    expect([200, 500]).toContain(res.status);
  });

  it('GET /api/nonexistent returns 404 JSON', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('GET /api/admin/orders/sync-status returns 200 and json', async () => {
    const res = await request(app).get('/api/admin/orders/sync-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('postgresOrdersCount');
  });

  it('GET /api/admin/orders/outbox-status returns 200 and json', async () => {
    const res = await request(app).get('/api/admin/orders/outbox-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('totalOutboxEvents');
  });
});
