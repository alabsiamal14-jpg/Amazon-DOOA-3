import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Filter,
  Landmark,
  Layers,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingBag,
  Trash2,
  TrendingUp,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import {
  ACCOUNTING_EXPENSE_CATEGORIES,
  ACCOUNTING_MANUAL_CATEGORIES_IN,
  ACCOUNTING_MANUAL_CATEGORIES_OUT,
  ACCOUNTING_PAYMENT_CHANNELS,
  addAccountingExpense,
  addAccountingProduct,
  addAccountingSale,
  addAccountingSupplierTx,
  addManualLedgerEntry,
  buildLedgerCsv,
  buildSalesCsv,
  computeAccountingSummary,
  createEmptyAccountingState,
  deleteAccountingRecord,
  filterLedgerEntries,
  formatAccountingMoney,
  normalizeAccountingState,
  syncStoreOrdersIntoAccounting,
  toSarAmount,
  todayIsoDate,
} from '../lib/accounting';
import {
  deleteDocFromFirestore,
  loadAccountingStateHydrated,
  postAccountingAction,
  saveLocalAccountingState,
  syncAccountingDeltaToFirestore,
} from '../lib/firebase-accounting';
import type {
  AccountingDatabaseState,
  AccountingDirection,
  AccountingPaymentChannel,
  AccountingRates,
  Order,
  Product,
  StoreSettings,
} from '../types';

interface AdminAccountingSystemProps {
  orders: Order[];
  products: Product[];
  settings: StoreSettings;
  adminName?: string;
}

type AccountingSectionTab =
  | 'ledger'
  | 'dashboard'
  | 'products'
  | 'sales'
  | 'expenses'
  | 'suppliers'
  | 'backup';

const DISPLAY_CURRENCY_OPTIONS = [
  { code: 'SAR', label: 'ريال سعودي (ر.س — الأساس)' },
  { code: 'YER_OLD', label: 'ريال يمني قديم (صنعاء)' },
  { code: 'YER_NEW', label: 'ريال يمني جديد (عدن)' },
  { code: 'USD', label: 'دولار أمريكي ($)' },
] as const;

export const AdminAccountingSystem: React.FC<AdminAccountingSystemProps> = ({
  orders,
  products: storeProducts,
  settings,
  adminName = 'admin',
}) => {
  const [state, setState] = useState<AccountingDatabaseState>(() =>
    createEmptyAccountingState(settings)
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<AccountingSectionTab>('ledger');
  const [displayCurrency, setDisplayCurrency] = useState<string>('SAR');
  const [showRatesEditor, setShowRatesEditor] = useState(false);
  const [rateDraft, setRateDraft] = useState<AccountingRates>(state.rates);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    target: 'products' | 'sales' | 'expenses' | 'suppliers' | 'ledger';
    id: string;
    label: string;
  } | null>(null);

  // Sync Store Orders Mode
  const [syncDeliveredOnly, setSyncDeliveredOnly] = useState(false);

  // Ledger Filters
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerDirection, setLedgerDirection] = useState<'all' | 'in' | 'out'>('all');
  const [ledgerCategory, setLedgerCategory] = useState('all');
  const [ledgerChannel, setLedgerChannel] = useState('all');
  const [ledgerDateFrom, setLedgerDateFrom] = useState('');
  const [ledgerDateTo, setLedgerDateTo] = useState('');
  const [showManualForm, setShowManualForm] = useState(false);

  // Manual Ledger Form
  const [manualDir, setManualDir] = useState<AccountingDirection>('in');
  const [manualCategory, setManualCategory] = useState<string>(ACCOUNTING_MANUAL_CATEGORIES_IN[0]);
  const [manualRef, setManualRef] = useState('');
  const [manualSource, setManualSource] = useState('');
  const [manualChannel, setManualChannel] = useState<AccountingPaymentChannel>('رأس مال');
  const [manualAmount, setManualAmount] = useState('');
  const [manualCurrency, setManualCurrency] = useState<string>('SAR');
  const [manualDate, setManualDate] = useState(todayIsoDate());
  const [manualNotes, setManualNotes] = useState('');

  // Product Form
  const [prodStoreRef, setProdStoreRef] = useState('');
  const [prodName, setProdName] = useState('');
  const [prodVendorCode, setProdVendorCode] = useState('');
  const [prodSupplierCode, setProdSupplierCode] = useState('');
  const [prodQty, setProdQty] = useState('10');
  const [prodBuyPrice, setProdBuyPrice] = useState('');
  const [prodShipping, setProdShipping] = useState('0');
  const [prodSellPrice, setProdSellPrice] = useState('');
  const [prodCurrency, setProdCurrency] = useState('SAR');
  const [prodPurchaseMode, setProdPurchaseMode] = useState<'cash' | 'credit'>('cash');
  const [prodChannel, setProdChannel] = useState<AccountingPaymentChannel>('حوالة الكريمي');
  const [prodRefId, setProdRefId] = useState('');
  const [prodDate, setProdDate] = useState(todayIsoDate());

  // Sale Form
  const [saleProductId, setSaleProductId] = useState('');
  const [saleCustomName, setSaleCustomName] = useState('');
  const [saleQty, setSaleQty] = useState('1');
  const [saleUnitPrice, setSaleUnitPrice] = useState('');
  const [saleFees, setSaleFees] = useState('0');
  const [saleCurrency, setSaleCurrency] = useState('SAR');
  const [saleStatus, setSaleStatus] = useState<'completed' | 'returned'>('completed');
  const [saleChannel, setSaleChannel] = useState<AccountingPaymentChannel>('نقد');
  const [saleCustomer, setSaleCustomer] = useState('');
  const [saleRefId, setSaleRefId] = useState('');
  const [saleDate, setSaleDate] = useState(todayIsoDate());
  const [saleNote, setSaleNote] = useState('');

  // Expense Form
  const [expTitle, setExpTitle] = useState('');
  const [expCategory, setExpCategory] = useState<string>(ACCOUNTING_EXPENSE_CATEGORIES[0]);
  const [expAmount, setExpAmount] = useState('');
  const [expCurrency, setExpCurrency] = useState('SAR');
  const [expChannel, setExpChannel] = useState<AccountingPaymentChannel>('نقد');
  const [expSource, setExpSource] = useState('');
  const [expRefId, setExpRefId] = useState('');
  const [expDate, setExpDate] = useState(todayIsoDate());
  const [expNote, setExpNote] = useState('');

  // Supplier Tx Form
  const [supCode, setSupCode] = useState('');
  const [supType, setSupType] = useState<'purchase' | 'payment'>('payment');
  const [supAmount, setSupAmount] = useState('');
  const [supCurrency, setSupCurrency] = useState('SAR');
  const [supChannel, setSupChannel] = useState<AccountingPaymentChannel>('حوالة الكريمي');
  const [supRefId, setSupRefId] = useState('');
  const [supDate, setSupDate] = useState(todayIsoDate());
  const [supNote, setSupNote] = useState('');

  const showNotify = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  };

  useEffect(() => {
    let mounted = true;
    loadAccountingStateHydrated(settings).then(({ state: loaded }) => {
      if (!mounted) return;
      setState(loaded);
      setRateDraft(loaded.rates);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (state.products.length > 0 && !saleProductId) {
      setSaleProductId(state.products[0].id);
      setSaleUnitPrice(String(state.products[0].sellPriceSar));
    }
  }, [state.products, saleProductId]);

  const summary = useMemo(() => computeAccountingSummary(state), [state]);

  // Count how many live store orders have NOT yet been imported into the accounting ledger
  const pendingImportOrders = useMemo(() => {
    const existingRefs = new Set([
      ...state.sales.map((s) => String(s.referenceId || '').trim().toUpperCase()),
      ...state.ledger.map((l) => String(l.reference_id || '').trim().toUpperCase()),
    ]);
    return orders.filter((o) => {
      if (!o || o.status === 'cancelled') return false;
      if (syncDeliveredOnly && o.status !== 'delivered' && !o.cod_collected) return false;
      const ref = String(o.order_number || o.id).trim().toUpperCase();
      return Boolean(ref) && !existingRefs.has(ref);
    });
  }, [orders, state.sales, state.ledger, syncDeliveredOnly]);

  const distinctLedgerCategories = useMemo(() => {
    const set = new Set<string>(state.ledger.map((l) => l.category).filter(Boolean));
    return Array.from(set);
  }, [state.ledger]);

  const filteredLedger = useMemo(() => {
    const matching = filterLedgerEntries(state.ledger, {
      search: ledgerSearch,
      direction: ledgerDirection,
      category: ledgerCategory,
      paymentChannel: ledgerChannel,
      dateFrom: ledgerDateFrom,
      dateTo: ledgerDateTo,
    });
    // Display newest chronological entries first while preserving their cumulative balance_after_sar
    return [...matching].reverse();
  }, [
    state.ledger,
    ledgerSearch,
    ledgerDirection,
    ledgerCategory,
    ledgerChannel,
    ledgerDateFrom,
    ledgerDateTo,
  ]);

  const fmt = (sar: number) => formatAccountingMoney(sar, displayCurrency, state.rates);

  const commitLocalAndSync = (nextState: AccountingDatabaseState) => {
    setState(nextState);
    saveLocalAccountingState(nextState);
  };

  const handleSaveRates = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const updatedRates: AccountingRates = {
      SAR: 1,
      YER_OLD: Number(rateDraft.YER_OLD) > 0 ? Number(rateDraft.YER_OLD) : state.rates.YER_OLD,
      YER_NEW: Number(rateDraft.YER_NEW) > 0 ? Number(rateDraft.YER_NEW) : state.rates.YER_NEW,
      USD: Number(rateDraft.USD) > 0 ? Number(rateDraft.USD) : state.rates.USD,
    };
    const nextLocal = normalizeAccountingState({ ...state, rates: updatedRates }, settings);
    commitLocalAndSync(nextLocal);
    const apiRes = await postAccountingAction('/rates', 'PUT', updatedRates);
    setSaving(false);
    setShowRatesEditor(false);
    showNotify(
      'success',
      apiRes.ok ? 'تم تحديث أسعار الصرف وحفظها.' : 'تم تحديث أسعار الصرف محلياً.'
    );
  };

  const handleSyncOrders = async () => {
    if (pendingImportOrders.length === 0) {
      showNotify('success', 'جميع الطلبات النشطة مزامنة بالفعل في السجل المالي.');
      return;
    }
    setSaving(true);
    const localSync = syncStoreOrdersIntoAccounting(state, orders, storeProducts, {
      onlyDeliveredOrCollected: syncDeliveredOnly,
      createdBy: adminName,
    });

    const apiRes = await postAccountingAction<{ state: AccountingDatabaseState; importedCount: number }>(
      '/sync-orders',
      'POST',
      { orders, products: storeProducts, onlyDeliveredOrCollected: syncDeliveredOnly }
    );

    if (apiRes.ok && apiRes.data?.state) {
      const serverNormalized = normalizeAccountingState(apiRes.data.state, settings);
      commitLocalAndSync(serverNormalized);
      await syncAccountingDeltaToFirestore({
        sales: localSync.importedSales,
        ledger: localSync.createdLedgers,
      });
      showNotify(
        'success',
        `تم استيراد ${apiRes.data.importedCount} طلب/طلبات إلى دفتر المبيعات وسجل الحركات المالية.`
      );
    } else {
      commitLocalAndSync(localSync.nextState);
      await syncAccountingDeltaToFirestore({
        sales: localSync.importedSales,
        ledger: localSync.createdLedgers,
      });
      showNotify(
        'success',
        `تم ترحيل ${localSync.importedCount} طلب/طلبات محلياً إلى السجل المالي.`
      );
    }
    setSaving(false);
  };

  const handleAddManualLedger = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountVal = Number(manualAmount);
    if (!Number.isFinite(amountVal) || amountVal <= 0) {
      showNotify('error', 'يرجى إدخال مبلغ صحيح أكبر من صفر.');
      return;
    }
    if (!manualRef.trim() || !manualSource.trim()) {
      showNotify('error', 'رقم المرجع والمصدر/الجهة مطلوبان لمراجعة أي ريال دخل أو خرج.');
      return;
    }

    setSaving(true);
    const payload = {
      date: manualDate,
      direction: manualDir,
      category: manualCategory,
      referenceId: manualRef.trim(),
      sourceParty: manualSource.trim(),
      paymentChannel: manualChannel,
      amount: amountVal,
      currencyCode: manualCurrency,
      notes: manualNotes.trim(),
      createdBy: adminName,
    };

    const localRes = addManualLedgerEntry(state, payload);
    const apiRes = await postAccountingAction<{ state: AccountingDatabaseState; entry: any }>(
      '/ledger',
      'POST',
      payload
    );

    const finalState =
      apiRes.ok && apiRes.data?.state
        ? normalizeAccountingState(apiRes.data.state, settings)
        : localRes.nextState;

    commitLocalAndSync(finalState);
    await syncAccountingDeltaToFirestore({ ledger: [apiRes.data?.entry || localRes.entry] });

    setManualRef('');
    setManualSource('');
    setManualAmount('');
    setManualNotes('');
    setShowManualForm(false);
    setSaving(false);
    showNotify(
      'success',
      `تم توثيق القيد ${apiRes.data?.entry?.tx_number || localRes.entry.tx_number} في السجل المالي.`
    );
  };

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const qtyVal = Number(prodQty);
    const buyVal = Number(prodBuyPrice);
    const shipVal = Number(prodShipping || 0);
    const sellVal = Number(prodSellPrice);

    if (!prodName.trim() || !prodVendorCode.trim() || qtyVal <= 0 || buyVal < 0 || sellVal < 0) {
      showNotify('error', 'يرجى استكمال اسم المنتج وكود المورد والكمية والأسعار بشكل صحيح.');
      return;
    }

    setSaving(true);
    const payload = {
      name: prodName.trim(),
      vendorCode: prodVendorCode.trim(),
      supplierCode: prodSupplierCode.trim() || prodVendorCode.trim(),
      qty: qtyVal,
      buyPrice: buyVal,
      shippingTotal: shipVal,
      sellPrice: sellVal,
      currencyCode: prodCurrency,
      purchaseMode: prodPurchaseMode,
      paymentChannel: prodChannel,
      referenceId: prodRefId.trim() || undefined,
      date: prodDate,
      storeProductId: prodStoreRef || undefined,
      createdBy: adminName,
    };

    const localRes = addAccountingProduct(state, payload);
    const apiRes = await postAccountingAction<{ state: AccountingDatabaseState; product: any; createdLedger?: any }>(
      '/products',
      'POST',
      payload
    );

    const finalState =
      apiRes.ok && apiRes.data?.state
        ? normalizeAccountingState(apiRes.data.state, settings)
        : localRes.nextState;
    commitLocalAndSync(finalState);

    await syncAccountingDeltaToFirestore({
      products: [apiRes.data?.product || localRes.product],
      suppliers: localRes.createdSupplierTx ? [localRes.createdSupplierTx] : [],
      ledger: localRes.createdLedger ? [localRes.createdLedger] : [],
    });

    setProdName('');
    setProdVendorCode('');
    setProdSupplierCode('');
    setProdQty('10');
    setProdBuyPrice('');
    setProdShipping('0');
    setProdSellPrice('');
    setProdRefId('');
    setProdStoreRef('');
    setSaving(false);
    showNotify('success', 'تم حفظ دفعة المخزون واحتساب التكلفة الواصلة في الدفتر.');
  };

  const handleAddSale = async (e: React.FormEvent) => {
    e.preventDefault();
    const qtyVal = Number(saleQty);
    const priceVal = Number(saleUnitPrice);
    const feesVal = Number(saleFees || 0);

    if (!Number.isFinite(qtyVal) || qtyVal <= 0 || !Number.isFinite(priceVal) || priceVal < 0) {
      showNotify('error', 'يرجى التحقق من الكمية وسعر البيع.');
      return;
    }
    if (!saleProductId && !saleCustomName.trim()) {
      showNotify('error', 'يرجى اختيار منتج من المخزون أو كتابة اسم الصنف.');
      return;
    }

    setSaving(true);
    const payload = {
      productId: saleProductId || undefined,
      productName: saleCustomName.trim() || undefined,
      qty: qtyVal,
      unitPrice: priceVal,
      fees: feesVal,
      currencyCode: saleCurrency,
      status: saleStatus,
      paymentChannel: saleChannel,
      sourceParty: saleCustomer.trim() || 'عميل مباشر',
      referenceId: saleRefId.trim() || undefined,
      date: saleDate,
      note: saleNote.trim() || undefined,
      createdBy: adminName,
    };

    const localRes = addAccountingSale(state, payload);
    const apiRes = await postAccountingAction<{ state: AccountingDatabaseState; sale: any; createdLedgers?: any[] }>(
      '/sales',
      'POST',
      payload
    );

    const finalState =
      apiRes.ok && apiRes.data?.state
        ? normalizeAccountingState(apiRes.data.state, settings)
        : localRes.nextState;
    commitLocalAndSync(finalState);

    await syncAccountingDeltaToFirestore({
      sales: [apiRes.data?.sale || localRes.sale],
      ledger: apiRes.data?.createdLedgers || localRes.createdLedgers,
    });

    setSaleCustomName('');
    setSaleQty('1');
    setSaleFees('0');
    setSaleCustomer('');
    setSaleRefId('');
    setSaleNote('');
    setSaving(false);
    showNotify('success', 'تم ترحيل الفاتورة وتحديث الرصيد في سجل التدقيق المالي.');
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountVal = Number(expAmount);
    if (!expTitle.trim() || !Number.isFinite(amountVal) || amountVal <= 0) {
      showNotify('error', 'يرجى إدخال بيان المصروف ومبلغ أكبر من صفر.');
      return;
    }

    setSaving(true);
    const payload = {
      title: expTitle.trim(),
      category: expCategory,
      amount: amountVal,
      currencyCode: expCurrency,
      paymentChannel: expChannel,
      sourceParty: expSource.trim() || expCategory,
      referenceId: expRefId.trim() || undefined,
      date: expDate,
      note: expNote.trim() || undefined,
      createdBy: adminName,
    };

    const localRes = addAccountingExpense(state, payload);
    const apiRes = await postAccountingAction<{ state: AccountingDatabaseState; expense: any; createdLedger?: any }>(
      '/expenses',
      'POST',
      payload
    );

    const finalState =
      apiRes.ok && apiRes.data?.state
        ? normalizeAccountingState(apiRes.data.state, settings)
        : localRes.nextState;
    commitLocalAndSync(finalState);

    await syncAccountingDeltaToFirestore({
      expenses: [apiRes.data?.expense || localRes.expense],
      ledger: [apiRes.data?.createdLedger || localRes.createdLedger],
    });

    setExpTitle('');
    setExpAmount('');
    setExpSource('');
    setExpRefId('');
    setExpNote('');
    setSaving(false);
    showNotify('success', 'تم قيد المصروف وتوثيق خروجه في السجل المالي.');
  };

  const handleAddSupplierTx = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountVal = Number(supAmount);
    if (!supCode.trim() || !Number.isFinite(amountVal) || amountVal <= 0) {
      showNotify('error', 'يرجى إدخال رمز/اسم المورد ومبلغ صحيح.');
      return;
    }

    setSaving(true);
    const payload = {
      code: supCode.trim(),
      type: supType,
      amount: amountVal,
      currencyCode: supCurrency,
      paymentChannel: supChannel,
      referenceId: supRefId.trim() || undefined,
      date: supDate,
      note: supNote.trim() || undefined,
      createdBy: adminName,
    };

    const localRes = addAccountingSupplierTx(state, payload);
    const apiRes = await postAccountingAction<{
      state: AccountingDatabaseState;
      supplierTx: any;
      createdLedger?: any;
    }>('/suppliers', 'POST', payload);

    const finalState =
      apiRes.ok && apiRes.data?.state
        ? normalizeAccountingState(apiRes.data.state, settings)
        : localRes.nextState;
    commitLocalAndSync(finalState);

    await syncAccountingDeltaToFirestore({
      suppliers: [apiRes.data?.supplierTx || localRes.supplierTx],
      ledger: localRes.createdLedger ? [localRes.createdLedger] : [],
    });

    setSupCode('');
    setSupAmount('');
    setSupRefId('');
    setSupNote('');
    setSaving(false);
    showNotify(
      'success',
      supType === 'payment'
        ? 'تم تسجيل سداد المورد وتوثيق الحوالة في سجل الصادر المالي.'
        : 'تم قيد مشتريات بالآجل وزيادة مستحقات المورد.'
    );
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const { target, id } = pendingDelete;
    setSaving(true);
    const localDel = deleteAccountingRecord(state, target, id);
    const apiRes = await postAccountingAction<{ state: AccountingDatabaseState }>(
      `/records/${target}/${encodeURIComponent(id)}`,
      'DELETE'
    );
    const finalState =
      apiRes.ok && apiRes.data?.state
        ? normalizeAccountingState(apiRes.data.state, settings)
        : localDel.nextState;
    commitLocalAndSync(finalState);

    const colMap = {
      products: 'accounting_products',
      sales: 'accounting_sales',
      expenses: 'accounting_expenses',
      suppliers: 'accounting_suppliers',
      ledger: 'accounting_ledger',
    } as const;
    await deleteDocFromFirestore(colMap[target], id);
    if (target !== 'ledger') {
      await Promise.all(
        localDel.removedLedgerIds.map((lid) => deleteDocFromFirestore('accounting_ledger', lid))
      );
    }

    setPendingDelete(null);
    setSaving(false);
    showNotify('success', 'تم حذف السجل وإعادة احتساب الأرصدة التراكمية بدقة.');
  };

  const triggerDownload = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') {
        showNotify('error', 'صيغة ملف النسخة الاحتياطية غير صالحة.');
        return;
      }
      setSaving(true);
      const normalized = normalizeAccountingState(parsed, settings);
      const apiRes = await postAccountingAction<{ state: AccountingDatabaseState }>(
        '/restore',
        'POST',
        normalized
      );
      const finalState =
        apiRes.ok && apiRes.data?.state
          ? normalizeAccountingState(apiRes.data.state, settings)
          : normalized;
      commitLocalAndSync(finalState);
      await syncAccountingDeltaToFirestore({
        products: finalState.products,
        sales: finalState.sales,
        expenses: finalState.expenses,
        suppliers: finalState.suppliers,
        ledger: finalState.ledger,
      });
      setSaving(false);
      showNotify('success', 'تمت استعادة النسخة الاحتياطية المحاسبية وإعادة احتساب الأرصدة.');
    } catch {
      showNotify('error', 'فشل قراءة ملف JSON للنسخة الاحتياطية.');
    } finally {
      e.target.value = '';
    }
  };

  const landedUnitPreviewSar = useMemo(() => {
    const qty = Math.max(1, Number(prodQty) || 1);
    const buySar = toSarAmount(Number(prodBuyPrice) || 0, prodCurrency, state.rates);
    const shipSar = toSarAmount(Number(prodShipping) || 0, prodCurrency, state.rates);
    return buySar + shipSar / qty;
  }, [prodQty, prodBuyPrice, prodShipping, prodCurrency, state.rates]);

  const tabItems: Array<{ id: AccountingSectionTab; label: string; badge?: number }> = [
    { id: 'ledger', label: 'دفتر التدقيق المالي', badge: state.ledger.length },
    { id: 'dashboard', label: 'المؤشرات وقائمة الدخل' },
    { id: 'products', label: 'المخزون والتكلفة الواصلة', badge: state.products.length },
    { id: 'sales', label: 'سجل المبيعات', badge: state.sales.length },
    { id: 'expenses', label: 'المصاريف التشغيلية', badge: state.expenses.length },
    { id: 'suppliers', label: 'الموردين والذمم', badge: summary.supplierBalances.length },
    { id: 'backup', label: 'التصدير والنسخ الاحتياطي' },
  ];

  if (loading) {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center text-stone-500 font-bold">
        جاري تهيئة الدفاتر المحاسبية وسجل التدقيق المالي...
      </div>
    );
  }

  return (
    <div className="space-y-5 text-stone-900" dir="rtl">
      {/* Notification Toast */}
      {toast && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-sm font-bold ${
            toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{toast.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-stone-500 hover:text-stone-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Inline Delete Confirmation Dialog */}
      {pendingDelete && (
        <div className="bg-rose-50 border border-rose-300 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-bold text-rose-950">
            تأكيد الحذف: سيتم حذف «{pendingDelete.label}» وأي قيود مالية مرتبطة به وإعادة احتساب الأرصدة التراكمية.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={handleConfirmDelete}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer disabled:opacity-50"
            >
              تأكيد الحذف النهائي
            </button>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="px-4 py-2 rounded-xl bg-white border border-stone-300 text-stone-700 text-xs font-bold cursor-pointer"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      {/* Header Bar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-stone-900 text-white flex items-center justify-center">
                <Landmark className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-black text-stone-900">
                  النظام المحاسبي المتكامل وسجل التدقيق المالي
                </h2>
                <p className="text-xs text-stone-500 font-medium">
                  حفظ وتدقيق كل حركة مالية بتاريخها ورقم مرجعها ومصدرها — عملة القيد الأساسية: الريال السعودي (SAR)
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={displayCurrency}
              onChange={(e) => setDisplayCurrency(e.target.value)}
              className="px-3 py-2 rounded-xl border border-stone-300 bg-stone-50 text-xs font-bold text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900"
            >
              {DISPLAY_CURRENCY_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  العرض: {opt.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => {
                setRateDraft(state.rates);
                setShowRatesEditor((v) => !v);
              }}
              className="px-3 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-xs font-bold text-stone-700 cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>أسعار الصرف</span>
            </button>
          </div>
        </div>

        {/* Collapsible Exchange Rates Bar */}
        {showRatesEditor && (
          <form
            onSubmit={handleSaveRates}
            className="mt-4 pt-4 border-t border-stone-200 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
          >
            <div>
              <label className="block text-[11px] font-bold text-stone-600 mb-1">
                1 ر.س = يمني قديم (صنعاء)
              </label>
              <input
                type="number"
                step="0.01"
                min="1"
                value={rateDraft.YER_OLD}
                onChange={(e) => setRateDraft({ ...rateDraft, YER_OLD: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-stone-600 mb-1">
                1 ر.س = يمني جديد (عدن)
              </label>
              <input
                type="number"
                step="0.01"
                min="1"
                value={rateDraft.YER_NEW}
                onChange={(e) => setRateDraft({ ...rateDraft, YER_NEW: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-stone-600 mb-1">
                1 ر.س = دولار ($)
              </label>
              <input
                type="number"
                step="0.0001"
                min="0.01"
                value={rateDraft.USD}
                onChange={(e) => setRateDraft({ ...rateDraft, USD: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono tabular-nums"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-extrabold cursor-pointer"
            >
              حفظ أسعار الصرف
            </button>
          </form>
        )}

        {/* Store Orders Sync Strip */}
        <div className="mt-4 pt-4 border-t border-stone-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-bold text-stone-700">
              ربط طلبات المتجر الحيّة:
            </span>
            <span className="text-stone-600 font-medium tabular-nums">
              {pendingImportOrders.length > 0
                ? `${pendingImportOrders.length} طلب غير مُرحّل محاسبياً حتى الآن`
                : `كافة الطلبات النشطة (${orders.filter((o) => o.status !== 'cancelled').length}) مُرحّلة وموثقة`}
            </span>
            <label className="inline-flex items-center gap-1.5 text-stone-600 font-medium cursor-pointer select-none">
              <input
                type="checkbox"
                checked={syncDeliveredOnly}
                onChange={(e) => setSyncDeliveredOnly(e.target.checked)}
                className="rounded border-stone-300"
              />
              <span>المسلمة / المحصّلة فقط</span>
            </label>
          </div>

          <button
            type="button"
            disabled={saving || pendingImportOrders.length === 0}
            onClick={handleSyncOrders}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>ترحيل طلبات المتجر للسجل المالي ({pendingImportOrders.length})</span>
          </button>
        </div>
      </div>

      {/* Sub-Navigation Bar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-2 overflow-x-auto">
        <div className="flex items-center gap-1.5 min-w-max">
          {tabItems.map((tab) => {
            const active = activeSection === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSection(tab.id)}
                className={`whitespace-nowrap shrink-0 px-3.5 py-2 rounded-xl text-xs font-extrabold transition-colors cursor-pointer flex items-center gap-2 ${
                  active
                    ? 'bg-stone-900 text-white'
                    : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
                }`}
              >
                <span>{tab.label}</span>
                {typeof tab.badge === 'number' && (
                  <span
                    className={`tabular-nums text-[11px] font-mono ${
                      active ? 'text-stone-300' : 'text-stone-400'
                    }`}
                  >
                    ({tab.badge})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* TAB 1: AUDIT LEDGER (كل حركة مالية بتاريخها ومرجعها ومصدرها) */}
      {/* ===================================================================== */}
      {activeSection === 'ledger' && (
        <div className="space-y-5">
          {/* Cashflow KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>إجمالي المبالغ الداخلة (وارد +)</span>
                <ArrowDownLeft className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="text-2xl font-black text-emerald-700 font-mono tabular-nums">
                +{fmt(summary.totalCashInSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">مبيعات + رأس مال + إيرادات</p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>إجمالي المبالغ الخارجة (صادر -)</span>
                <ArrowUpRight className="w-4 h-4 text-rose-600" />
              </div>
              <div className="text-2xl font-black text-rose-700 font-mono tabular-nums">
                -{fmt(summary.totalCashOutSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">مخزون + مصاريف + سداد موردين</p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>الرصيد النقدي المتاح فعلياً</span>
                <Wallet className="w-4 h-4 text-stone-800" />
              </div>
              <div
                className={`text-2xl font-black font-mono tabular-nums ${
                  summary.cashBalanceSar >= 0 ? 'text-stone-900' : 'text-rose-700'
                }`}
              >
                {fmt(summary.cashBalanceSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">صافي الخزينة والبنك التراكمي</p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>الحركات الموثقة بالدفتر</span>
                <BookOpen className="w-4 h-4 text-sky-600" />
              </div>
              <div className="text-2xl font-black text-stone-900 font-mono tabular-nums">
                {summary.ledgerCount}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">كل حركة محفوظة بمرجعها ومصدرها</p>
            </div>
          </div>

          {/* Action Bar & Filters */}
          <div className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-black text-stone-900">
                سجل كل حركة مالية (وارد / صادر) للمراجعة والتدقيق
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowManualForm((v) => !v)}
                  className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-extrabold cursor-pointer flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{showManualForm ? 'إخفاء نموذج القيد اليدوي' : 'إضافة قيد مالي يدوي'}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    triggerDownload(
                      buildLedgerCsv(state.ledger),
                      `Amazon_Duaa_Audit_Ledger_${todayIsoDate()}.csv`,
                      'text/csv;charset=utf-8;'
                    )
                  }
                  className="px-3.5 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-xs font-bold text-stone-700 cursor-pointer flex items-center gap-1.5"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                  <span>تصدير الدفتر CSV</span>
                </button>
              </div>
            </div>

            {/* Manual Entry Form */}
            {showManualForm && (
              <form
                onSubmit={handleAddManualLedger}
                className="p-4 rounded-2xl bg-stone-50 border border-stone-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end"
              >
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">اتجاه الحركة</label>
                  <select
                    value={manualDir}
                    onChange={(e) => {
                      const d = e.target.value as AccountingDirection;
                      setManualDir(d);
                      setManualCategory(
                        d === 'in'
                          ? ACCOUNTING_MANUAL_CATEGORIES_IN[0]
                          : ACCOUNTING_MANUAL_CATEGORIES_OUT[0]
                      );
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs font-bold"
                  >
                    <option value="in">وارد (+) — إيداع / تحصيل أموال</option>
                    <option value="out">صادر (-) — سحب / دفع أموال</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">التصنيف</label>
                  <select
                    value={manualCategory}
                    onChange={(e) => setManualCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs font-bold"
                  >
                    {(manualDir === 'in'
                      ? ACCOUNTING_MANUAL_CATEGORIES_IN
                      : ACCOUNTING_MANUAL_CATEGORIES_OUT
                    ).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    رقم المرجع / السند *
                  </label>
                  <input
                    type="text"
                    required
                    value={manualRef}
                    onChange={(e) => setManualRef(e.target.value)}
                    placeholder="مثال: CAP-001 أو سند #554"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    المصدر / الجهة المستلمة *
                  </label>
                  <input
                    type="text"
                    required
                    value={manualSource}
                    onChange={(e) => setManualSource(e.target.value)}
                    placeholder="مثال: المالك / بنك الكريمي / عميل"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">قناة الدفع</label>
                  <select
                    value={manualChannel}
                    onChange={(e) => setManualChannel(e.target.value as AccountingPaymentChannel)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs font-bold"
                  >
                    {ACCOUNTING_PAYMENT_CHANNELS.map((ch) => (
                      <option key={ch} value={ch}>
                        {ch}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[11px] font-bold text-stone-600 mb-1">المبلغ *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={manualAmount}
                      onChange={(e) => setManualAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-stone-600 mb-1">العملة</label>
                    <select
                      value={manualCurrency}
                      onChange={(e) => setManualCurrency(e.target.value)}
                      className="w-full px-2 py-2 rounded-xl border border-stone-300 bg-white text-xs font-bold"
                    >
                      <option value="SAR">SAR</option>
                      <option value="YER_OLD">صنعاء</option>
                      <option value="YER_NEW">عدن</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">التاريخ</label>
                  <input
                    type="date"
                    required
                    value={manualDate}
                    onChange={(e) => setManualDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs font-mono tabular-nums"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">البيان التفصيلي</label>
                  <input
                    type="text"
                    value={manualNotes}
                    onChange={(e) => setManualNotes(e.target.value)}
                    placeholder="توضيح سبب الحركة المالية..."
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-xs"
                  />
                </div>

                <div className="sm:col-span-2 lg:col-span-4 flex items-center justify-between pt-1">
                  <span className="text-[11px] text-stone-500 font-mono tabular-nums">
                    المعادل الأساسي: {toSarAmount(Number(manualAmount) || 0, manualCurrency, state.rates)} ر.س
                  </span>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer"
                  >
                    حفظ وتوثيق القيد المالي
                  </button>
                </div>
              </form>
            )}

            {/* Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
              <div className="lg:col-span-2 relative">
                <Search className="w-4 h-4 text-stone-400 absolute right-3 top-2.5" />
                <input
                  type="text"
                  value={ledgerSearch}
                  onChange={(e) => setLedgerSearch(e.target.value)}
                  placeholder="بحث بالمرجع، رقم القيد، المصدر، البيان..."
                  className="w-full pr-9 pl-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <select
                value={ledgerDirection}
                onChange={(e) => setLedgerDirection(e.target.value as any)}
                className="px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
              >
                <option value="all">الاتجاه: الكل</option>
                <option value="in">وارد (+) فقط</option>
                <option value="out">صادر (-) فقط</option>
              </select>

              <select
                value={ledgerCategory}
                onChange={(e) => setLedgerCategory(e.target.value)}
                className="px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
              >
                <option value="all">كل التصنيفات</option>
                {distinctLedgerCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                value={ledgerChannel}
                onChange={(e) => setLedgerChannel(e.target.value)}
                className="px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
              >
                <option value="all">كل قنوات الدفع</option>
                {ACCOUNTING_PAYMENT_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={ledgerDateFrom}
                  onChange={(e) => setLedgerDateFrom(e.target.value)}
                  title="من تاريخ"
                  className="w-full px-2 py-2 rounded-xl border border-stone-300 text-[11px] font-mono tabular-nums"
                />
                <input
                  type="date"
                  value={ledgerDateTo}
                  onChange={(e) => setLedgerDateTo(e.target.value)}
                  title="إلى تاريخ"
                  className="w-full px-2 py-2 rounded-xl border border-stone-300 text-[11px] font-mono tabular-nums"
                />
                {(ledgerSearch ||
                  ledgerDirection !== 'all' ||
                  ledgerCategory !== 'all' ||
                  ledgerChannel !== 'all' ||
                  ledgerDateFrom ||
                  ledgerDateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      setLedgerSearch('');
                      setLedgerDirection('all');
                      setLedgerCategory('all');
                      setLedgerChannel('all');
                      setLedgerDateFrom('');
                      setLedgerDateTo('');
                    }}
                    title="تصفير الفلاتر"
                    className="p-2 rounded-xl border border-stone-300 hover:bg-stone-100 text-stone-600 cursor-pointer shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Audit Ledger Table */}
            <div className="overflow-x-auto border border-stone-200 rounded-xl">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 text-stone-700 font-extrabold">
                    <th className="py-3 px-3 whitespace-nowrap">رقم القيد والتاريخ</th>
                    <th className="py-3 px-3 whitespace-nowrap">المرجع</th>
                    <th className="py-3 px-3">المصدر / الجهة</th>
                    <th className="py-3 px-3">التصنيف والقناة</th>
                    <th className="py-3 px-3">البيان</th>
                    <th className="py-3 px-3 whitespace-nowrap">وارد (+)</th>
                    <th className="py-3 px-3 whitespace-nowrap">صادر (-)</th>
                    <th className="py-3 px-3 whitespace-nowrap">الرصيد التراكمي</th>
                    <th className="py-3 px-3 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {filteredLedger.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-10 text-center text-stone-500 font-medium">
                        لا توجد حركات مالية مطابقة حالياً. أضف قيداً يدوياً أو قم بمزامنة طلبات المتجر أو تسجيل مبيعات/مصاريف.
                      </td>
                    </tr>
                  ) : (
                    filteredLedger.map((entry) => (
                      <tr key={entry.id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-mono font-bold text-stone-900 tabular-nums">
                            {entry.tx_number}
                          </div>
                          <div className="text-[11px] font-mono text-stone-500 tabular-nums">
                            {entry.date}
                          </div>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap font-mono font-bold text-stone-800">
                          {entry.reference_id}
                        </td>
                        <td className="py-3 px-3 font-bold text-stone-800 max-w-[180px]">
                          {entry.source_party}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-bold text-stone-800">{entry.category}</div>
                          <div className="text-[11px] text-stone-500">{entry.payment_channel}</div>
                        </td>
                        <td className="py-3 px-3 text-stone-600 max-w-[260px]">
                          <div>{entry.notes}</div>
                          {entry.currency_code !== 'SAR' && (
                            <div className="text-[10px] font-mono text-stone-400 tabular-nums mt-0.5">
                              الأصل: {entry.original_amount} {entry.currency_code}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap font-mono font-black tabular-nums text-emerald-700">
                          {entry.direction === 'in' ? `+${fmt(entry.amount_sar)}` : '—'}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap font-mono font-black tabular-nums text-rose-700">
                          {entry.direction === 'out' ? `-${fmt(entry.amount_sar)}` : '—'}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap font-mono font-extrabold tabular-nums text-stone-900">
                          {fmt(entry.balance_after_sar)}
                        </td>
                        <td className="py-3 px-3 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setPendingDelete({
                                target: 'ledger',
                                id: entry.id,
                                label: `${entry.tx_number} (${entry.reference_id})`,
                              })
                            }
                            className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                            title="حذف القيد"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: DASHBOARD & P&L */}
      {/* ===================================================================== */}
      {activeSection === 'dashboard' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>إجمالي المبيعات (Revenue)</span>
                <TrendingUp className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="text-2xl font-black text-stone-900 font-mono tabular-nums">
                {fmt(summary.totalRevenueSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1 tabular-nums">
                {summary.completedOrdersCount} طلب مكتمل · {summary.returnedOrdersCount} مرتجع
              </p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>تكلفة البضاعة ورسوم الشحن</span>
                <Package className="w-4 h-4 text-amber-600" />
              </div>
              <div className="text-2xl font-black text-stone-900 font-mono tabular-nums">
                {fmt(summary.directCostsSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">تشمل تكلفة الشراء والتوصيل</p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>المصاريف التشغيلية والإعلانات</span>
                <Receipt className="w-4 h-4 text-rose-600" />
              </div>
              <div className="text-2xl font-black text-stone-900 font-mono tabular-nums">
                {fmt(summary.totalOpexSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">إعلانات، تغليف، اشتراكات</p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>صافي الربح الحقيقي (Net Profit)</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              </div>
              <div
                className={`text-2xl font-black font-mono tabular-nums ${
                  summary.netProfitSar >= 0 ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {fmt(summary.netProfitSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1 tabular-nums">
                هامش الربح الصافي: {summary.profitMarginPct}%
              </p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>قيمة المخزون الحالي بالمستودع</span>
                <Layers className="w-4 h-4 text-sky-600" />
              </div>
              <div className="text-2xl font-black text-stone-900 font-mono tabular-nums">
                {fmt(summary.inventoryValueSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1 tabular-nums">
                {summary.inventoryUnits} قطعة متوفرة بالتكلفة الواصلة
              </p>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <div className="flex items-center justify-between text-xs font-bold text-stone-500 mb-2">
                <span>مستحقات الموردين المتبقية</span>
                <Building2 className="w-4 h-4 text-rose-600" />
              </div>
              <div className="text-2xl font-black text-rose-700 font-mono tabular-nums">
                {fmt(summary.supplierDebtSar)}
              </div>
              <p className="text-[11px] text-stone-500 mt-1">الرصيد الواجب سداده للتجار</p>
            </div>
          </div>

          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <h3 className="text-base font-black text-stone-900 mb-4">
              قائمة الدخل التفصيلية (Profit &amp; Loss Statement)
            </h3>
            <div className="overflow-x-auto border border-stone-200 rounded-xl">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 font-extrabold text-stone-700">
                    <th className="py-3 px-4">البند المحاسبي</th>
                    <th className="py-3 px-4">القيمة بالعملة المعروضة</th>
                    <th className="py-3 px-4">النسبة من المبيعات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  <tr>
                    <td className="py-3 px-4 font-bold">إجمالي إيرادات المبيعات</td>
                    <td className="py-3 px-4 font-mono font-bold tabular-nums">
                      {fmt(summary.totalRevenueSar)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">100.0%</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-4 text-stone-600">(-) تكلفة البضاعة المباعة (COGS)</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-rose-700">
                      -{fmt(summary.totalCogsSar)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {summary.totalRevenueSar > 0
                        ? ((summary.totalCogsSar / summary.totalRevenueSar) * 100).toFixed(1)
                        : '0.0'}
                      %
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 px-4 text-stone-600">(-) رسوم الشحن والتوصيل للمبيعات</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-rose-700">
                      -{fmt(summary.totalSalesFeesSar)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {summary.totalRevenueSar > 0
                        ? ((summary.totalSalesFeesSar / summary.totalRevenueSar) * 100).toFixed(1)
                        : '0.0'}
                      %
                    </td>
                  </tr>
                  <tr className="bg-stone-50 font-extrabold">
                    <td className="py-3 px-4">(=) مجمل الربح (Gross Profit)</td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {fmt(summary.grossProfitSar)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {summary.totalRevenueSar > 0
                        ? ((summary.grossProfitSar / summary.totalRevenueSar) * 100).toFixed(1)
                        : '0.0'}
                      %
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 px-4 text-stone-600">(-) المصاريف التشغيلية والإعلانات</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-rose-700">
                      -{fmt(summary.totalOpexSar)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {summary.totalRevenueSar > 0
                        ? ((summary.totalOpexSar / summary.totalRevenueSar) * 100).toFixed(1)
                        : '0.0'}
                      %
                    </td>
                  </tr>
                  <tr className="bg-emerald-50/70 font-black">
                    <td className="py-3 px-4 text-stone-900">(=) صافي الربح النهائي (Net Profit)</td>
                    <td
                      className={`py-3 px-4 font-mono tabular-nums ${
                        summary.netProfitSar >= 0 ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {fmt(summary.netProfitSar)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">{summary.profitMarginPct}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: PRODUCTS & LANDED COST */}
      {/* ===================================================================== */}
      {activeSection === 'products' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddProduct}
            className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-black text-stone-900">
                إضافة دفعة مخزون وحساب التكلفة الواصلة الفعلية (Landed Cost)
              </h3>
              <span className="text-xs font-mono font-bold text-stone-600 tabular-nums">
                التكلفة الواصلة المتوقعة للقطعة: {fmt(landedUnitPreviewSar)}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  ربط بمنتج من المتجر (اختياري)
                </label>
                <select
                  value={prodStoreRef}
                  onChange={(e) => {
                    const pid = e.target.value;
                    setProdStoreRef(pid);
                    const found = storeProducts.find((p) => p.id === pid);
                    if (found) {
                      setProdName(found.title_ar);
                      setProdSellPrice(String(found.discount_price || found.original_price));
                    }
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs bg-white"
                >
                  <option value="">-- إدخال منتج جديد يدوياً --</option>
                  {storeProducts.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.title_ar}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">اسم المنتج *</label>
                <input
                  type="text"
                  required
                  value={prodName}
                  onChange={(e) => setProdName(e.target.value)}
                  placeholder="مثال: سيروم فيتامين سي"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  كود الصنف الداخلي *
                </label>
                <input
                  type="text"
                  required
                  value={prodVendorCode}
                  onChange={(e) => setProdVendorCode(e.target.value)}
                  placeholder="مثال: 1A-101"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">اسم/رمز المورد</label>
                <input
                  type="text"
                  value={prodSupplierCode}
                  onChange={(e) => setProdSupplierCode(e.target.value)}
                  placeholder="مثال: وان ثاوزن"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">الكمية *</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={prodQty}
                  onChange={(e) => setProdQty(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  سعر شراء القطعة *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={prodBuyPrice}
                  onChange={(e) => setProdBuyPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  الشحن والجمارك للدفعة
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={prodShipping}
                  onChange={(e) => setProdShipping(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    سعر البيع للقطعة *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={prodSellPrice}
                    onChange={(e) => setProdSellPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">العملة</label>
                  <select
                    value={prodCurrency}
                    onChange={(e) => setProdCurrency(e.target.value)}
                    className="w-full px-2 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                  >
                    <option value="SAR">SAR</option>
                    <option value="USD">USD</option>
                    <option value="YER_OLD">صنعاء</option>
                    <option value="YER_NEW">عدن</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">طريقة السداد</label>
                <select
                  value={prodPurchaseMode}
                  onChange={(e) => setProdPurchaseMode(e.target.value as 'cash' | 'credit')}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  <option value="cash">مدفوعة فوراً (تُقيد صادر بالدفتر)</option>
                  <option value="credit">بالآجل (تُقيد ذمة على المورد)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">قناة الدفع</label>
                <select
                  value={prodChannel}
                  onChange={(e) => setProdChannel(e.target.value as AccountingPaymentChannel)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  {ACCOUNTING_PAYMENT_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  رقم فاتورة الشراء / المرجع
                </label>
                <input
                  type="text"
                  value={prodRefId}
                  onChange={(e) => setProdRefId(e.target.value)}
                  placeholder="مثال: PO-2026-10"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono"
                />
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">التاريخ</label>
                  <input
                    type="date"
                    required
                    value={prodDate}
                    onChange={(e) => setProdDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-extrabold cursor-pointer shrink-0"
                >
                  حفظ المخزون
                </button>
              </div>
            </div>
          </form>

          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <h3 className="text-base font-black text-stone-900 mb-4">سجل المنتجات والتكلفة الواصلة</h3>
            <div className="overflow-x-auto border border-stone-200 rounded-xl">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 font-extrabold text-stone-700">
                    <th className="py-3 px-3">الكود والمرجع</th>
                    <th className="py-3 px-3">اسم المنتج</th>
                    <th className="py-3 px-3">المتوفر</th>
                    <th className="py-3 px-3">التكلفة الواصلة</th>
                    <th className="py-3 px-3">سعر البيع</th>
                    <th className="py-3 px-3">ربح القطعة</th>
                    <th className="py-3 px-3 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {state.products.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-stone-500">
                        لا توجد أصناف مخزونة محاسبياً بعد.
                      </td>
                    </tr>
                  ) : (
                    state.products.map((p) => {
                      const unitProfit = p.sellPriceSar - p.landedCostSar;
                      return (
                        <tr key={p.id} className="hover:bg-stone-50">
                          <td className="py-3 px-3 font-mono font-bold">
                            <div>{p.vendorCode}</div>
                            {p.referenceId && (
                              <div className="text-[11px] text-stone-400">{p.referenceId}</div>
                            )}
                          </td>
                          <td className="py-3 px-3 font-bold">{p.name}</td>
                          <td
                            className={`py-3 px-3 font-mono font-black tabular-nums ${
                              p.qty > 3 ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {p.qty}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums">{fmt(p.landedCostSar)}</td>
                          <td className="py-3 px-3 font-mono tabular-nums">{fmt(p.sellPriceSar)}</td>
                          <td
                            className={`py-3 px-3 font-mono font-bold tabular-nums ${
                              unitProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {fmt(unitProfit)}
                          </td>
                          <td className="py-3 px-3 text-center">
                            <button
                              type="button"
                              onClick={() =>
                                setPendingDelete({
                                  target: 'products',
                                  id: p.id,
                                  label: p.name,
                                })
                              }
                              className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 4: SALES REGISTER */}
      {/* ===================================================================== */}
      {activeSection === 'sales' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddSale}
            className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4"
          >
            <h3 className="text-base font-black text-stone-900">تسجيل عملية بيع وترحيلها للسجل المالي</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">اختر المنتج</label>
                <select
                  value={saleProductId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSaleProductId(id);
                    const p = state.products.find((item) => item.id === id);
                    if (p) setSaleUnitPrice(String(p.sellPriceSar));
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs bg-white"
                >
                  <option value="">-- بيع حر / بدون مخزون --</option>
                  {state.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} [{p.vendorCode}] · متوفر: {p.qty}
                    </option>
                  ))}
                </select>
              </div>

              {!saleProductId && (
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    اسم الصنف المباع *
                  </label>
                  <input
                    type="text"
                    required
                    value={saleCustomName}
                    onChange={(e) => setSaleCustomName(e.target.value)}
                    placeholder="اكتب وصف المبيع..."
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  رقم الفاتورة / المرجع
                </label>
                <input
                  type="text"
                  value={saleRefId}
                  onChange={(e) => setSaleRefId(e.target.value)}
                  placeholder="مثال: INV-2040"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  العميل / المصدر
                </label>
                <input
                  type="text"
                  value={saleCustomer}
                  onChange={(e) => setSaleCustomer(e.target.value)}
                  placeholder="اسم العميل أو القناة"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">الكمية *</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={saleQty}
                  onChange={(e) => setSaleQty(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    سعر البيع للقطعة *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={saleUnitPrice}
                    onChange={(e) => setSaleUnitPrice(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">العملة</label>
                  <select
                    value={saleCurrency}
                    onChange={(e) => setSaleCurrency(e.target.value)}
                    className="w-full px-2 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                  >
                    <option value="SAR">SAR</option>
                    <option value="YER_OLD">صنعاء</option>
                    <option value="YER_NEW">عدن</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  رسوم التوصيل / المنصة
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={saleFees}
                  onChange={(e) => setSaleFees(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">قناة التحصيل</label>
                <select
                  value={saleChannel}
                  onChange={(e) => setSaleChannel(e.target.value as AccountingPaymentChannel)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  {ACCOUNTING_PAYMENT_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">الحالة</label>
                <select
                  value={saleStatus}
                  onChange={(e) => setSaleStatus(e.target.value as 'completed' | 'returned')}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  <option value="completed">مكتمل ومحصّل (يُقيد وارد)</option>
                  <option value="returned">مرتجع (يُعاد للمخزون ويُقيد صادر)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">التاريخ</label>
                <input
                  type="date"
                  required
                  value={saleDate}
                  onChange={(e) => setSaleDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div className="sm:col-span-2 flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">ملاحظات</label>
                  <input
                    type="text"
                    value={saleNote}
                    onChange={(e) => setSaleNote(e.target.value)}
                    placeholder="ملاحظات إضافية..."
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                  />
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer shrink-0"
                >
                  ترحيل الفاتورة
                </button>
              </div>
            </div>
          </form>

          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <h3 className="text-base font-black text-stone-900 mb-4">دفتر المبيعات اليومية</h3>
            <div className="overflow-x-auto border border-stone-200 rounded-xl">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 font-extrabold text-stone-700">
                    <th className="py-3 px-3">التاريخ والمرجع</th>
                    <th className="py-3 px-3">المنتج / المصدر</th>
                    <th className="py-3 px-3">الكمية</th>
                    <th className="py-3 px-3">إجمالي البيع</th>
                    <th className="py-3 px-3">التكلفة + الرسوم</th>
                    <th className="py-3 px-3">صافي الربح</th>
                    <th className="py-3 px-3">الحالة</th>
                    <th className="py-3 px-3 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {state.sales.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-stone-500">
                        لا توجد مبيعات مسجلة بعد. يمكنك ترحيل طلبات المتجر تلقائياً من الشريط العلوي.
                      </td>
                    </tr>
                  ) : (
                    [...state.sales].reverse().map((s) => {
                      const rev = s.status === 'completed' ? s.qty * s.unitPriceSar : 0;
                      const cost = s.status === 'completed' ? s.qty * s.unitCostSar : 0;
                      const net = rev - cost - (s.feesSar || 0);
                      return (
                        <tr key={s.id} className="hover:bg-stone-50">
                          <td className="py-3 px-3 whitespace-nowrap font-mono">
                            <div className="font-bold text-stone-900">{s.referenceId}</div>
                            <div className="text-[11px] text-stone-500 tabular-nums">{s.date}</div>
                          </td>
                          <td className="py-3 px-3">
                            <div className="font-bold text-stone-900">{s.productName}</div>
                            <div className="text-[11px] text-stone-500">
                              {s.sourceParty || '-'} · {s.paymentChannel}
                            </div>
                          </td>
                          <td className="py-3 px-3 font-mono font-bold tabular-nums">{s.qty}</td>
                          <td className="py-3 px-3 font-mono font-bold tabular-nums">{fmt(rev)}</td>
                          <td className="py-3 px-3 font-mono tabular-nums text-stone-600">
                            {fmt(cost + (s.feesSar || 0))}
                          </td>
                          <td
                            className={`py-3 px-3 font-mono font-black tabular-nums ${
                              net >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {fmt(net)}
                          </td>
                          <td className="py-3 px-3 font-bold">
                            <span
                              className={
                                s.status === 'completed' ? 'text-emerald-700' : 'text-amber-700'
                              }
                            >
                              {s.status === 'completed' ? 'مكتمل' : 'مرتجع'}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-center">
                            <button
                              type="button"
                              onClick={() =>
                                setPendingDelete({
                                  target: 'sales',
                                  id: s.id,
                                  label: `فاتورة ${s.referenceId}`,
                                })
                              }
                              className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 5: OPERATING EXPENSES */}
      {/* ===================================================================== */}
      {activeSection === 'expenses' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddExpense}
            className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4"
          >
            <h3 className="text-base font-black text-stone-900">
              تسجيل مصروف تشغيلي أو حملة إعلانية (يُقيد صادر بالتدقيق المالي)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">بند المصروف *</label>
                <input
                  type="text"
                  required
                  value={expTitle}
                  onChange={(e) => setExpTitle(e.target.value)}
                  placeholder="مثال: حملة إعلانات تيك توك"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">التصنيف</label>
                <select
                  value={expCategory}
                  onChange={(e) => setExpCategory(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  {ACCOUNTING_EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  رقم الفاتورة / الإيصال
                </label>
                <input
                  type="text"
                  value={expRefId}
                  onChange={(e) => setExpRefId(e.target.value)}
                  placeholder="مثال: EXP-302"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">الجهة المستفيدة</label>
                <input
                  type="text"
                  value={expSource}
                  onChange={(e) => setExpSource(e.target.value)}
                  placeholder="مثال: Meta Ads / شركة تغليف"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">المبلغ *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={expAmount}
                    onChange={(e) => setExpAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">العملة</label>
                  <select
                    value={expCurrency}
                    onChange={(e) => setExpCurrency(e.target.value)}
                    className="w-full px-2 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                  >
                    <option value="SAR">SAR</option>
                    <option value="USD">USD</option>
                    <option value="YER_OLD">صنعاء</option>
                    <option value="YER_NEW">عدن</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">قناة الدفع</label>
                <select
                  value={expChannel}
                  onChange={(e) => setExpChannel(e.target.value as AccountingPaymentChannel)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  {ACCOUNTING_PAYMENT_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">التاريخ</label>
                <input
                  type="date"
                  required
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">ملاحظة</label>
                  <input
                    type="text"
                    value={expNote}
                    onChange={(e) => setExpNote(e.target.value)}
                    placeholder="تفصيل إضافي"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                  />
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-extrabold cursor-pointer shrink-0"
                >
                  قيد المصروف
                </button>
              </div>
            </div>
          </form>

          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <h3 className="text-base font-black text-stone-900 mb-4">سجل المصروفات التشغيلية</h3>
            <div className="overflow-x-auto border border-stone-200 rounded-xl">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 font-extrabold text-stone-700">
                    <th className="py-3 px-3">التاريخ والمرجع</th>
                    <th className="py-3 px-3">البيان والجهة</th>
                    <th className="py-3 px-3">التصنيف والقناة</th>
                    <th className="py-3 px-3">المبلغ</th>
                    <th className="py-3 px-3 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {state.expenses.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-stone-500">
                        لا توجد مصروفات مسجلة حتى الآن.
                      </td>
                    </tr>
                  ) : (
                    [...state.expenses].reverse().map((ex) => (
                      <tr key={ex.id} className="hover:bg-stone-50">
                        <td className="py-3 px-3 whitespace-nowrap font-mono">
                          <div className="font-bold">{ex.referenceId}</div>
                          <div className="text-[11px] text-stone-500 tabular-nums">{ex.date}</div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-bold text-stone-900">{ex.title}</div>
                          <div className="text-[11px] text-stone-500">{ex.sourceParty || '-'}</div>
                        </td>
                        <td className="py-3 px-3">
                          <div>{ex.category}</div>
                          <div className="text-[11px] text-stone-500">{ex.paymentChannel}</div>
                        </td>
                        <td className="py-3 px-3 font-mono font-black tabular-nums text-rose-700">
                          -{fmt(ex.amountSar)}
                        </td>
                        <td className="py-3 px-3 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setPendingDelete({
                                target: 'expenses',
                                id: ex.id,
                                label: ex.title,
                              })
                            }
                            className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 6: SUPPLIERS LEDGER */}
      {/* ===================================================================== */}
      {activeSection === 'suppliers' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddSupplierTx}
            className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4"
          >
            <h3 className="text-base font-black text-stone-900">
              تسجيل حركة مالية مع مورد (توريد آجل أو سداد حوالة)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  اسم / رمز المورد *
                </label>
                <input
                  type="text"
                  required
                  value={supCode}
                  onChange={(e) => setSupCode(e.target.value)}
                  placeholder="مثال: 1A - وان ثاوزن"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">نوع الحركة</label>
                <select
                  value={supType}
                  onChange={(e) => setSupType(e.target.value as 'purchase' | 'payment')}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  <option value="payment">سداد حوالة/نقد للمورد (يُقيد صادر بالدفتر)</option>
                  <option value="purchase">شراء بضاعة بالآجل (يزيد المستحق للمورد)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  رقم الحوالة / السند
                </label>
                <input
                  type="text"
                  value={supRefId}
                  onChange={(e) => setSupRefId(e.target.value)}
                  placeholder="مثال: حوالة كريمي 88921"
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">قناة الدفع</label>
                <select
                  value={supChannel}
                  onChange={(e) => setSupChannel(e.target.value as AccountingPaymentChannel)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                >
                  {ACCOUNTING_PAYMENT_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">المبلغ *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={supAmount}
                    onChange={(e) => setSupAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">العملة</label>
                  <select
                    value={supCurrency}
                    onChange={(e) => setSupCurrency(e.target.value)}
                    className="w-full px-2 py-2 rounded-xl border border-stone-300 text-xs font-bold bg-white"
                  >
                    <option value="SAR">SAR</option>
                    <option value="USD">USD</option>
                    <option value="YER_OLD">صنعاء</option>
                    <option value="YER_NEW">عدن</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">التاريخ</label>
                <input
                  type="date"
                  required
                  value={supDate}
                  onChange={(e) => setSupDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-mono tabular-nums"
                />
              </div>

              <div className="sm:col-span-2 flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    ملاحظات السند
                  </label>
                  <input
                    type="text"
                    value={supNote}
                    onChange={(e) => setSupNote(e.target.value)}
                    placeholder="تفاصيل الشحنة أو الحوالة..."
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
                  />
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-extrabold cursor-pointer shrink-0"
                >
                  قيد الحركة
                </button>
              </div>
            </div>
          </form>

          {/* Per-supplier Balance Summary */}
          {summary.supplierBalances.length > 0 && (
            <div className="bg-white border border-stone-200 rounded-2xl p-5">
              <h3 className="text-base font-black text-stone-900 mb-4">ملخص الأرصدة لكل مورد</h3>
              <div className="overflow-x-auto border border-stone-200 rounded-xl">
                <table className="w-full text-right text-xs border-collapse">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 font-extrabold text-stone-700">
                      <th className="py-3 px-3">المورد</th>
                      <th className="py-3 px-3">إجمالي المشتريات</th>
                      <th className="py-3 px-3">إجمالي المدفوعات</th>
                      <th className="py-3 px-3">الرصيد المتبقي</th>
                      <th className="py-3 px-3">آخر حركة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-200">
                    {summary.supplierBalances.map((row) => (
                      <tr key={row.code} className="hover:bg-stone-50">
                        <td className="py-3 px-3 font-extrabold text-stone-900">{row.code}</td>
                        <td className="py-3 px-3 font-mono tabular-nums">{fmt(row.purchasesSar)}</td>
                        <td className="py-3 px-3 font-mono tabular-nums text-emerald-700">
                          {fmt(row.paymentsSar)}
                        </td>
                        <td
                          className={`py-3 px-3 font-mono font-black tabular-nums ${
                            row.balanceSar > 0 ? 'text-rose-700' : 'text-emerald-700'
                          }`}
                        >
                          {fmt(row.balanceSar)}
                        </td>
                        <td className="py-3 px-3 font-mono text-stone-500 tabular-nums">
                          {row.lastTxDate || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Detailed Supplier Ledger */}
          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <h3 className="text-base font-black text-stone-900 mb-4">كشف حركات الموردين التفصيلي</h3>
            <div className="overflow-x-auto border border-stone-200 rounded-xl">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 font-extrabold text-stone-700">
                    <th className="py-3 px-3">التاريخ والمرجع</th>
                    <th className="py-3 px-3">المورد</th>
                    <th className="py-3 px-3">نوع الحركة</th>
                    <th className="py-3 px-3">المبلغ</th>
                    <th className="py-3 px-3">البيان</th>
                    <th className="py-3 px-3 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {state.suppliers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-stone-500">
                        لا توجد حركات موردين مسجلة بعد.
                      </td>
                    </tr>
                  ) : (
                    [...state.suppliers].reverse().map((st) => (
                      <tr key={st.id} className="hover:bg-stone-50">
                        <td className="py-3 px-3 whitespace-nowrap font-mono">
                          <div className="font-bold">{st.referenceId}</div>
                          <div className="text-[11px] text-stone-500 tabular-nums">{st.date}</div>
                        </td>
                        <td className="py-3 px-3 font-bold">{st.code}</td>
                        <td className="py-3 px-3 font-bold">
                          <span
                            className={
                              st.type === 'purchase' ? 'text-amber-700' : 'text-emerald-700'
                            }
                          >
                            {st.type === 'purchase' ? 'شراء بالآجل' : 'سداد للمورد'}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono font-black tabular-nums">
                          {fmt(st.amountSar)}
                        </td>
                        <td className="py-3 px-3 text-stone-600">{st.note || '-'}</td>
                        <td className="py-3 px-3 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setPendingDelete({
                                target: 'suppliers',
                                id: st.id,
                                label: `${st.code} (${st.referenceId})`,
                              })
                            }
                            className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 7: BACKUP & EXPORT */}
      {/* ===================================================================== */}
      {activeSection === 'backup' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-base font-black text-stone-900">
              التصدير والنسخ الاحتياطي للنظام المحاسبي
            </h3>
            <p className="text-xs text-stone-500 mt-1">
              يتم حفظ جميع القيود المالية في قاعدة بيانات المتجر والخادم (مع نسخة سحابية في Firestore). يمكنك تصدير كشوف الحساب أو استعادة نسخة احتياطية كاملة في أي وقت.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() =>
                triggerDownload(
                  buildLedgerCsv(state.ledger),
                  `Amazon_Duaa_Audit_Ledger_${todayIsoDate()}.csv`,
                  'text/csv;charset=utf-8;'
                )
              }
              className="px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-extrabold cursor-pointer flex items-center gap-2"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>تصدير سجل كل الحركات المالية (CSV)</span>
            </button>

            <button
              type="button"
              onClick={() =>
                triggerDownload(
                  buildSalesCsv(state.sales),
                  `Amazon_Duaa_Sales_Report_${todayIsoDate()}.csv`,
                  'text/csv;charset=utf-8;'
                )
              }
              className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer flex items-center gap-2"
            >
              <ShoppingBag className="w-4 h-4" />
              <span>تصدير تقرير المبيعات (CSV)</span>
            </button>

            <button
              type="button"
              onClick={() =>
                triggerDownload(
                  JSON.stringify(state, null, 2),
                  `Amazon_Duaa_Accounting_Backup_${todayIsoDate()}.json`,
                  'application/json'
                )
              }
              className="px-4 py-2.5 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 text-xs font-extrabold cursor-pointer flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              <span>تحميل نسخة احتياطية كاملة (JSON)</span>
            </button>

            <label className="px-4 py-2.5 rounded-xl border border-stone-300 bg-stone-50 hover:bg-stone-100 text-stone-800 text-xs font-extrabold cursor-pointer flex items-center gap-2">
              <Upload className="w-4 h-4" />
              <span>استعادة نسخة احتياطية (JSON)</span>
              <input
                type="file"
                accept=".json"
                onChange={handleImportJson}
                className="hidden"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminAccountingSystem;
