import { Router, Response } from 'express';
import { requireAdmin, AuthRequest } from '../../middleware/auth.ts';
import {
  createExpenseOnServer,
  createManualLedgerOnServer,
  createProductOnServer,
  createSaleOnServer,
  createSupplierTxOnServer,
  deleteAccountingRecordOnServer,
  getAccountingState,
  restoreAccountingStateOnServer,
  syncOrdersOnServer,
  updateAccountingRatesOnServer,
} from '../../lib/accounting-store.ts';
import { computeAccountingSummary } from '../../lib/accounting.ts';

const router = Router();
router.use(requireAdmin);

function actorFromReq(req: AuthRequest): string {
  return req.user?.username || req.user?.email || 'admin';
}

router.get('/state', async (_req: AuthRequest, res: Response) => {
  try {
    const state = await getAccountingState();
    return res.json({
      success: true,
      state,
      summary: computeAccountingSummary(state),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'فشل تحميل السجل المحاسبي' });
  }
});

router.put('/rates', async (req: AuthRequest, res: Response) => {
  try {
    const state = await updateAccountingRatesOnServer(req.body || {});
    return res.json({ success: true, state });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل تحديث أسعار الصرف' });
  }
});

router.post('/products', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'اسم المنتج مطلوب' });
    }
    const result = await createProductOnServer({
      ...body,
      qty: Number(body.qty),
      buyPrice: Number(body.buyPrice),
      shippingTotal: Number(body.shippingTotal || 0),
      sellPrice: Number(body.sellPrice),
      createdBy: actorFromReq(req),
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل حفظ المنتج المحاسبي' });
  }
});

router.post('/sales', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const qty = Number(body.qty);
    const unitPrice = Number(body.unitPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'الكمية المباعة يجب أن تكون أكبر من صفر' });
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ error: 'سعر البيع غير صالح' });
    }
    const result = await createSaleOnServer({
      ...body,
      qty,
      unitPrice,
      fees: Number(body.fees || 0),
      status: body.status === 'returned' ? 'returned' : 'completed',
      createdBy: actorFromReq(req),
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل ترحيل الفاتورة' });
  }
});

router.post('/expenses', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: 'بيان المصروف مطلوب' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'مبلغ المصروف يجب أن يكون أكبر من صفر' });
    }
    const result = await createExpenseOnServer({
      ...body,
      amount,
      createdBy: actorFromReq(req),
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل تسجيل المصروف' });
  }
});

router.post('/suppliers', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!body.code || !String(body.code).trim()) {
      return res.status(400).json({ error: 'اسم أو رمز المورد مطلوب' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });
    }
    const result = await createSupplierTxOnServer({
      ...body,
      type: body.type === 'payment' ? 'payment' : 'purchase',
      amount,
      createdBy: actorFromReq(req),
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل تسجيل حركة المورد' });
  }
});

router.post('/ledger', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!body.sourceParty || !String(body.sourceParty).trim()) {
      return res.status(400).json({ error: 'المصدر / الجهة مطلوب لتدقيق الحركة' });
    }
    if (!body.referenceId || !String(body.referenceId).trim()) {
      return res.status(400).json({ error: 'رقم المرجع / السند مطلوب لتدقيق الحركة' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });
    }
    const result = await createManualLedgerOnServer({
      ...body,
      direction: body.direction === 'in' ? 'in' : 'out',
      amount,
      createdBy: actorFromReq(req),
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل قيد الحركة المالية' });
  }
});

router.post('/sync-orders', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const orders = Array.isArray(body.orders) ? body.orders : [];
    const products = Array.isArray(body.products) ? body.products : [];
    const result = await syncOrdersOnServer(orders, products, {
      onlyDeliveredOrCollected: Boolean(body.onlyDeliveredOrCollected),
      createdBy: actorFromReq(req),
    });
    return res.json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل مزامنة طلبات المتجر' });
  }
});

router.post('/restore', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const state = await restoreAccountingStateOnServer(body);
    return res.json({ success: true, state });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل استعادة النسخة الاحتياطية' });
  }
});

router.delete('/records/:target/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { target, id } = req.params;
    const validTargets = ['products', 'sales', 'expenses', 'suppliers', 'ledger'] as const;
    if (!validTargets.includes(target as any)) {
      return res.status(400).json({ error: 'نوع السجل غير صالح' });
    }
    const state = await deleteAccountingRecordOnServer(target as any, id);
    return res.json({ success: true, state });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'فشل حذف السجل' });
  }
});

export default router;
