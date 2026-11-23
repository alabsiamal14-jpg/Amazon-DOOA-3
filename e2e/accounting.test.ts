import fs from 'fs';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

const { testAdminUser } = vi.hoisted(() => {
  const user = `acc_admin_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const pass = `AccPass_${globalThis.crypto.randomUUID()}`;
  process.env.ADMIN_USERNAME = user;
  process.env.ADMIN_PASSWORD = pass;
  process.env.ADMIN_JWT_SECRET = globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID();
  return { testAdminUser: user };
});

import app from '../server.ts';
import { createAdminToken } from '../src/middleware/auth.ts';
import { getAccountingStateFilePath } from '../src/lib/accounting-store.ts';
import {
  addAccountingExpense,
  addAccountingProduct,
  addAccountingSale,
  addAccountingSupplierTx,
  addManualLedgerEntry,
  buildLedgerCsv,
  computeAccountingSummary,
  createEmptyAccountingState,
  deleteAccountingRecord,
  filterLedgerEntries,
  syncStoreOrdersIntoAccounting,
} from '../src/lib/accounting.ts';
import type { Order } from '../src/types.ts';

describe('Integrated Accounting & Financial Audit System', () => {
  const adminToken = createAdminToken(testAdminUser);
  const testFilePath = getAccountingStateFilePath();

  beforeAll(() => {
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
  });

  afterAll(() => {
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
  });

  it('1. Tracks every inflow & outflow with date, reference, source, channel and exact running balance', () => {
    let state = createEmptyAccountingState();

    // 1) Deposit opening capital: +10,000 SAR
    const cap = addManualLedgerEntry(state, {
      date: '2026-05-01',
      direction: 'in',
      category: 'رأس مال',
      referenceId: 'CAP-2026-01',
      sourceParty: 'المالك - رأس مال افتتاحي',
      paymentChannel: 'رأس مال',
      amount: 10000,
      currencyCode: 'SAR',
      notes: 'إيداع رأس المال الافتتاحي للمتجر',
    });
    state = cap.nextState;
    expect(cap.entry.tx_number).toBe('TX-2026-0001');
    expect(cap.entry.balance_after_sar).toBe(10000);

    // 2) Buy stock batch in cash: 10 units @ 50 SAR + 100 SAR shipping = 600 SAR total OUT (60 SAR landed/unit)
    const prodRes = addAccountingProduct(state, {
      name: 'سيروم نياسيناميد',
      vendorCode: '1A-105',
      supplierCode: 'وان ثاوزن',
      qty: 10,
      buyPrice: 50,
      shippingTotal: 100,
      sellPrice: 120,
      currencyCode: 'SAR',
      purchaseMode: 'cash',
      paymentChannel: 'حوالة الكريمي',
      referenceId: 'PO-105',
      date: '2026-05-02',
    });
    state = prodRes.nextState;
    expect(prodRes.product.landedCostSar).toBe(60);
    expect(prodRes.createdLedger?.direction).toBe('out');
    expect(prodRes.createdLedger?.amount_sar).toBe(600);
    expect(prodRes.createdLedger?.reference_id).toBe('PO-105');
    expect(prodRes.createdLedger?.balance_after_sar).toBe(9400);

    // 3) Sell 2 units @ 120 SAR + 20 SAR delivery fee -> +240 IN, -20 OUT => 9620 SAR balance
    const saleRes = addAccountingSale(state, {
      productId: prodRes.product.id,
      qty: 2,
      unitPrice: 120,
      fees: 20,
      currencyCode: 'SAR',
      status: 'completed',
      paymentChannel: 'دفع عند الاستلام',
      sourceParty: 'أمل علي (صنعاء)',
      referenceId: 'INV-5001',
      date: '2026-05-03',
    });
    state = saleRes.nextState;
    expect(state.products[0].qty).toBe(8);
    expect(saleRes.createdLedgers).toHaveLength(2);
    expect(saleRes.createdLedgers[0].direction).toBe('in');
    expect(saleRes.createdLedgers[0].amount_sar).toBe(240);
    expect(saleRes.createdLedgers[1].direction).toBe('out');
    expect(saleRes.createdLedgers[1].amount_sar).toBe(20);

    // 4) Operating expense in YER_OLD (14,200 YER_OLD @ 142 = 100 SAR OUT)
    const expRes = addAccountingExpense(state, {
      title: 'إعلانات تيك توك',
      category: 'إعلانات وتسويق',
      amount: 14200,
      currencyCode: 'YER_OLD',
      paymentChannel: 'نقد',
      sourceParty: 'TikTok Ads',
      referenceId: 'EXP-99',
      date: '2026-05-04',
    });
    state = expRes.nextState;
    expect(expRes.createdLedger.amount_sar).toBe(100);
    expect(expRes.createdLedger.original_amount).toBe(14200);
    expect(expRes.createdLedger.currency_code).toBe('YER_OLD');
    expect(expRes.createdLedger.balance_after_sar).toBe(9520);

    // 5) Supplier credit purchase 500 SAR + payment 200 SAR -> debt = 300 SAR, cash = 9320 SAR
    const supPurchase = addAccountingSupplierTx(state, {
      code: 'مورد الخليج',
      type: 'purchase',
      amount: 500,
      referenceId: 'SUP-INV-1',
      date: '2026-05-05',
      note: 'بضاعة بالآجل',
    });
    state = supPurchase.nextState;
    expect(supPurchase.createdLedger).toBeUndefined();

    const supPayment = addAccountingSupplierTx(state, {
      code: 'مورد الخليج',
      type: 'payment',
      amount: 200,
      paymentChannel: 'تحويل بنكي',
      referenceId: 'TR-7741',
      date: '2026-05-06',
      note: 'دفعة أولى للمورد',
    });
    state = supPayment.nextState;
    expect(supPayment.createdLedger?.direction).toBe('out');
    expect(supPayment.createdLedger?.amount_sar).toBe(200);
    expect(supPayment.createdLedger?.balance_after_sar).toBe(9320);

    const summary = computeAccountingSummary(state);
    expect(summary.totalCashInSar).toBe(10240);
    expect(summary.totalCashOutSar).toBe(920);
    expect(summary.cashBalanceSar).toBe(9320);
    expect(summary.supplierDebtSar).toBe(300);
    // Revenue = 240, COGS = 2 * 60 = 120, Fees = 20, Opex = 100 => Net Profit = 0
    expect(summary.totalRevenueSar).toBe(240);
    expect(summary.netProfitSar).toBe(0);
    expect(summary.inventoryValueSar).toBe(480); // 8 * 60

    // Filter & CSV checks
    const onlyKarimi = filterLedgerEntries(state.ledger, { paymentChannel: 'حوالة الكريمي' });
    expect(onlyKarimi).toHaveLength(1);
    expect(onlyKarimi[0].reference_id).toBe('PO-105');

    const csv = buildLedgerCsv(state.ledger);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('CAP-2026-01');
    expect(csv).toContain('TR-7741');

    // Cascade delete of supplier payment restores balance back to 9520
    const afterDel = deleteAccountingRecord(state, 'suppliers', supPayment.supplierTx.id);
    expect(afterDel.removedLedgerIds).toHaveLength(1);
    expect(computeAccountingSummary(afterDel.nextState).cashBalanceSar).toBe(9520);
  });

  it('2. Idempotently imports active Store Orders into sales & audit ledger without duplicates', () => {
    let state = createEmptyAccountingState();
    const orders: Order[] = [
      {
        id: 'ord_1',
        order_number: 'ELEN-9001',
        customer_name: 'سارة محمد',
        customer_phone: '777111222',
        city: 'صنعاء',
        address: 'شارع حدة',
        items: [{ product_id: 'p1', title_ar: 'مرطب كوري', price: 150, quantity: 2, image_url: '' }],
        subtotal: 300,
        discount_amount: 0,
        delivery_fee: 0,
        total_amount: 300,
        status: 'delivered',
        whatsapp_sent: true,
        payment_method: 'cod',
        created_at: '2026-05-10T10:00:00.000Z',
      },
      {
        id: 'ord_2',
        order_number: 'ELEN-9002',
        customer_name: 'ملغي',
        customer_phone: '777000000',
        city: 'عدن',
        address: 'كريتر',
        items: [{ product_id: 'p1', title_ar: 'مرطب كوري', price: 150, quantity: 1, image_url: '' }],
        subtotal: 150,
        discount_amount: 0,
        delivery_fee: 0,
        total_amount: 150,
        status: 'cancelled',
        whatsapp_sent: false,
        created_at: '2026-05-10T11:00:00.000Z',
      },
    ];

    const first = syncStoreOrdersIntoAccounting(state, orders);
    expect(first.importedCount).toBe(1);
    expect(first.nextState.ledger).toHaveLength(1);
    expect(first.nextState.ledger[0].reference_id).toBe('ELEN-9001');
    expect(first.nextState.ledger[0].source_party).toBe('سارة محمد (صنعاء)');
    expect(first.nextState.ledger[0].amount_sar).toBe(300);

    // Repeat sync must import 0
    const second = syncStoreOrdersIntoAccounting(first.nextState, orders);
    expect(second.importedCount).toBe(0);
    expect(second.nextState.ledger).toHaveLength(1);
  });

  it('3. Protects /api/admin/accounting with requireAdmin and persists ledger entries across requests', async () => {
    const unauth = await request(app).get('/api/admin/accounting/state');
    expect(unauth.status).toBe(401);

    const postLedger = await request(app)
      .post('/api/admin/accounting/ledger')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        direction: 'in',
        category: 'رأس مال',
        referenceId: 'CAP-API-1',
        sourceParty: 'إيداع بنكي',
        paymentChannel: 'تحويل بنكي',
        amount: 2500,
        currencyCode: 'SAR',
        date: '2026-05-15',
        notes: 'تغطية رصيد الموردين',
      });

    expect(postLedger.status).toBe(201);
    expect(postLedger.body.success).toBe(true);
    expect(postLedger.body.entry.reference_id).toBe('CAP-API-1');
    expect(postLedger.body.entry.balance_after_sar).toBe(2500);

    const getState = await request(app)
      .get('/api/admin/accounting/state')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getState.status).toBe(200);
    expect(getState.body.state.ledger).toHaveLength(1);
    expect(getState.body.summary.cashBalanceSar).toBe(2500);
  });
});
