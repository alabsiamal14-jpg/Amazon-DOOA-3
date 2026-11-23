import type {
  AccountingDatabaseState,
  AccountingDirection,
  AccountingExpense,
  AccountingLedgerEntry,
  AccountingPaymentChannel,
  AccountingProduct,
  AccountingRates,
  AccountingReferenceType,
  AccountingSale,
  AccountingSupplierTx,
  Order,
  Product,
  StoreSettings,
} from '../types.ts';
import { FALLBACK_CURRENCIES } from './currency.ts';

export const DEFAULT_ACCOUNTING_RATES: AccountingRates = {
  SAR: 1,
  YER_OLD: FALLBACK_CURRENCIES.YER_OLD.rate,
  YER_NEW: FALLBACK_CURRENCIES.YER_NEW.rate,
  USD: FALLBACK_CURRENCIES.USD.rate,
};

export const ACCOUNTING_EXPENSE_CATEGORIES = [
  'إعلانات وتسويق',
  'تغليف ومستلزمات',
  'شحن ونقل داخلي',
  'اشتراكات وأدوات',
  'رواتب وعمولات',
  'إيجار ومرافق',
  'مصاريف إدارية أخرى',
] as const;

export const ACCOUNTING_MANUAL_CATEGORIES_IN = [
  'رأس مال',
  'إيراد إضافي',
  'تحصيل متأخرات',
  'تعويض شركة شحن',
  'تسوية جرد موجب',
] as const;

export const ACCOUNTING_MANUAL_CATEGORIES_OUT = [
  'مسحوبات شخصية',
  'إعلانات وتسويق',
  'شحن ونقل داخلي',
  'تغليف ومستلزمات',
  'مرتجع عميل',
  'رسوم بنكية وتحويل',
  'مصاريف إدارية أخرى',
] as const;

export const ACCOUNTING_PAYMENT_CHANNELS: AccountingPaymentChannel[] = [
  'نقد',
  'حوالة الكريمي',
  'تحويل بنكي',
  'دفع عند الاستلام',
  'بطاقة مدى / إلكتروني',
  'رأس مال',
];

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function roundMoney(val: number, decimals = 2): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

export function createEmptyAccountingState(settings?: Partial<StoreSettings>): AccountingDatabaseState {
  return {
    rates: extractRatesFromSettings(settings),
    products: [],
    sales: [],
    expenses: [],
    suppliers: [],
    ledger: [],
    updated_at: new Date().toISOString(),
  };
}

export function extractRatesFromSettings(settings?: Partial<StoreSettings>): AccountingRates {
  const cur = settings?.currencies;
  return {
    SAR: 1,
    YER_OLD:
      Number(cur?.YER_OLD?.rate) > 0
        ? Number(cur!.YER_OLD.rate)
        : DEFAULT_ACCOUNTING_RATES.YER_OLD,
    YER_NEW:
      Number(cur?.YER_NEW?.rate) > 0
        ? Number(cur!.YER_NEW.rate)
        : DEFAULT_ACCOUNTING_RATES.YER_NEW,
    USD:
      Number(cur?.USD?.rate) > 0
        ? Number(cur!.USD.rate)
        : DEFAULT_ACCOUNTING_RATES.USD,
  };
}

export function getRateForCurrency(code: string, rates: AccountingRates): number {
  switch (code) {
    case 'SAR':
      return 1;
    case 'YER_OLD':
      return rates.YER_OLD > 0 ? rates.YER_OLD : DEFAULT_ACCOUNTING_RATES.YER_OLD;
    case 'YER_NEW':
      return rates.YER_NEW > 0 ? rates.YER_NEW : DEFAULT_ACCOUNTING_RATES.YER_NEW;
    case 'USD':
      return rates.USD > 0 ? rates.USD : DEFAULT_ACCOUNTING_RATES.USD;
    default:
      return 1;
  }
}

export function toSarAmount(amount: number, currencyCode: string, rates: AccountingRates): number {
  const clean = Number(amount);
  if (!Number.isFinite(clean) || clean < 0) return 0;
  const rate = getRateForCurrency(currencyCode, rates);
  return roundMoney(clean / rate, 2);
}

export function fromSarAmount(amountSar: number, currencyCode: string, rates: AccountingRates): number {
  const clean = Number(amountSar);
  if (!Number.isFinite(clean)) return 0;
  const rate = getRateForCurrency(currencyCode, rates);
  const converted = clean * rate;
  if (currencyCode === 'YER_OLD' || currencyCode === 'YER_NEW') {
    return Math.round(converted);
  }
  return roundMoney(converted, 2);
}

export function formatAccountingMoney(
  amountSar: number,
  currencyCode: string,
  rates: AccountingRates
): string {
  const val = fromSarAmount(amountSar, currencyCode, rates);
  const decimals = currencyCode === 'YER_OLD' || currencyCode === 'YER_NEW' ? 0 : 2;
  const formatted = val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const suffixMap: Record<string, string> = {
    SAR: 'ر.س',
    YER_OLD: 'ر.ي (صنعاء)',
    YER_NEW: 'ر.ي (عدن)',
    USD: '$',
  };
  return `${formatted} ${suffixMap[currencyCode] || currencyCode}`;
}

export function generateRecordId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}_${Date.now()}_${rand}`;
}

export function generateNextTxNumber(ledger: AccountingLedgerEntry[], dateStr?: string): string {
  const year = (dateStr || todayIsoDate()).slice(0, 4) || new Date().getFullYear().toString();
  let maxSeq = 0;
  for (const entry of ledger) {
    const match = String(entry.tx_number || '').match(/(\d+)$/);
    if (match) {
      const seq = Number(match[1]);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  const next = String(maxSeq + 1).padStart(4, '0');
  return `TX-${year}-${next}`;
}

export function recomputeLedgerBalances(entries: AccountingLedgerEntry[]): AccountingLedgerEntry[] {
  const sortedAsc = [...entries].sort((a, b) => {
    const dateCmp = String(a.date || '').localeCompare(String(b.date || ''));
    if (dateCmp !== 0) return dateCmp;
    const createdCmp = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    if (createdCmp !== 0) return createdCmp;
    return String(a.tx_number || a.id).localeCompare(String(b.tx_number || b.id));
  });

  let running = 0;
  const withBalances = sortedAsc.map((entry) => {
    const amt = Math.max(0, roundMoney(entry.amount_sar, 2));
    running = roundMoney(entry.direction === 'in' ? running + amt : running - amt, 2);
    return {
      ...entry,
      amount_sar: amt,
      balance_after_sar: running,
    };
  });

  return withBalances;
}

export function normalizeAccountingState(
  raw: Partial<AccountingDatabaseState> | null | undefined,
  settings?: Partial<StoreSettings>
): AccountingDatabaseState {
  const fallbackRates = extractRatesFromSettings(settings);
  const rates: AccountingRates = {
    SAR: 1,
    YER_OLD: Number(raw?.rates?.YER_OLD) > 0 ? Number(raw!.rates!.YER_OLD) : fallbackRates.YER_OLD,
    YER_NEW: Number(raw?.rates?.YER_NEW) > 0 ? Number(raw!.rates!.YER_NEW) : fallbackRates.YER_NEW,
    USD: Number(raw?.rates?.USD) > 0 ? Number(raw!.rates!.USD) : fallbackRates.USD,
  };

  return {
    rates,
    products: Array.isArray(raw?.products) ? raw!.products : [],
    sales: Array.isArray(raw?.sales) ? raw!.sales : [],
    expenses: Array.isArray(raw?.expenses) ? raw!.expenses : [],
    suppliers: Array.isArray(raw?.suppliers) ? raw!.suppliers : [],
    ledger: recomputeLedgerBalances(Array.isArray(raw?.ledger) ? raw!.ledger : []),
    updated_at: raw?.updated_at || new Date().toISOString(),
  };
}

export interface AddProductInput {
  name: string;
  vendorCode: string;
  qty: number;
  buyPrice: number;
  shippingTotal: number;
  sellPrice: number;
  currencyCode?: string;
  purchaseMode?: 'cash' | 'credit';
  paymentChannel?: AccountingPaymentChannel;
  supplierCode?: string;
  referenceId?: string;
  date?: string;
  storeProductId?: string;
  createdBy?: string;
}

export function addAccountingProduct(
  state: AccountingDatabaseState,
  input: AddProductInput
): {
  nextState: AccountingDatabaseState;
  product: AccountingProduct;
  createdSupplierTx?: AccountingSupplierTx;
  createdLedger?: AccountingLedgerEntry;
} {
  const currency = input.currencyCode || 'SAR';
  const rate = getRateForCurrency(currency, state.rates);
  const qty = Math.max(1, Math.round(Number(input.qty) || 1));
  const buyPriceSar = toSarAmount(input.buyPrice, currency, state.rates);
  const shippingTotalSar = toSarAmount(input.shippingTotal, currency, state.rates);
  const landedCostSar = roundMoney(buyPriceSar + shippingTotalSar / qty, 2);
  const sellPriceSar = toSarAmount(input.sellPrice, currency, state.rates);
  const now = new Date().toISOString();
  const date = input.date || todayIsoDate();
  const id = generateRecordId('aprod');
  const referenceId = (input.referenceId || '').trim() || `STK-${id.slice(-5)}`;
  const purchaseMode = input.purchaseMode || 'cash';
  const paymentChannel = input.paymentChannel || 'نقد';

  const product: AccountingProduct = {
    id,
    name: input.name.trim(),
    vendorCode: input.vendorCode.trim(),
    qty,
    buyPriceSar,
    shippingTotalSar,
    landedCostSar,
    sellPriceSar,
    purchaseMode,
    paymentChannel,
    supplierCode: (input.supplierCode || '').trim() || undefined,
    referenceId,
    storeProductId: input.storeProductId,
    createdAt: now,
    updatedAt: now,
  };

  const totalBatchCostSar = roundMoney(buyPriceSar * qty + shippingTotalSar, 2);
  let createdSupplierTx: AccountingSupplierTx | undefined;
  let createdLedger: AccountingLedgerEntry | undefined;
  let nextSuppliers = [...state.suppliers];
  let nextLedger = [...state.ledger];

  if (totalBatchCostSar > 0) {
    if (purchaseMode === 'credit') {
      const txNumber = generateNextTxNumber(nextLedger, date);
      createdSupplierTx = {
        id: generateRecordId('asup'),
        txNumber,
        referenceId,
        code: (input.supplierCode || input.vendorCode).trim(),
        type: 'purchase',
        amountSar: totalBatchCostSar,
        note: `توريد مخزون بالآجل: ${product.name} (${qty} قطعة)`,
        date,
        createdAt: now,
      };
      nextSuppliers.push(createdSupplierTx);
    } else {
      const txNumber = generateNextTxNumber(nextLedger, date);
      createdLedger = {
        id: generateRecordId('aled'),
        tx_number: txNumber,
        date,
        direction: 'out',
        category: 'شراء مخزون',
        reference_type: 'stock_purchase',
        reference_id: referenceId,
        source_party: (input.supplierCode || input.vendorCode || 'مورد مخزون').trim(),
        payment_channel: paymentChannel,
        amount_sar: totalBatchCostSar,
        original_amount: roundMoney(input.buyPrice * qty + input.shippingTotal, 2),
        currency_code: currency,
        exchange_rate: rate,
        balance_after_sar: 0,
        notes: `شراء دفعة مخزون: ${product.name} (${qty} قطعة × تكلفة واصلة ${landedCostSar} ر.س)`,
        linked_record_id: id,
        is_manual: false,
        created_by: input.createdBy || 'admin',
        created_at: now,
      };
      nextLedger.push(createdLedger);
    }
  }

  nextLedger = recomputeLedgerBalances(nextLedger);
  const syncedLedger = createdLedger
    ? nextLedger.find((l) => l.id === createdLedger!.id)
    : undefined;

  return {
    nextState: {
      ...state,
      products: [...state.products, product],
      suppliers: nextSuppliers,
      ledger: nextLedger,
      updated_at: now,
    },
    product,
    createdSupplierTx,
    createdLedger: syncedLedger,
  };
}

export interface AddSaleInput {
  productId?: string;
  productName?: string;
  vendorCode?: string;
  qty: number;
  unitPrice: number;
  unitCostOverrideSar?: number;
  fees?: number;
  currencyCode?: string;
  status: 'completed' | 'returned';
  paymentChannel?: AccountingPaymentChannel;
  sourceParty?: string;
  referenceId?: string;
  date?: string;
  note?: string;
  createdBy?: string;
}

export function addAccountingSale(
  state: AccountingDatabaseState,
  input: AddSaleInput
): {
  nextState: AccountingDatabaseState;
  sale: AccountingSale;
  createdLedgers: AccountingLedgerEntry[];
} {
  const currency = input.currencyCode || 'SAR';
  const rate = getRateForCurrency(currency, state.rates);
  const qty = Math.max(1, Math.round(Number(input.qty) || 1));
  const prodIndex = input.productId
    ? state.products.findIndex((p) => p.id === input.productId)
    : -1;
  const matchedProd = prodIndex >= 0 ? state.products[prodIndex] : null;

  const productName = (matchedProd?.name || input.productName || 'منتج متنوع').trim();
  const vendorCode = (matchedProd?.vendorCode || input.vendorCode || 'DIRECT').trim();
  const unitPriceSar = toSarAmount(input.unitPrice, currency, state.rates);
  const unitCostSar =
    typeof input.unitCostOverrideSar === 'number' && input.unitCostOverrideSar >= 0
      ? roundMoney(input.unitCostOverrideSar, 2)
      : matchedProd?.landedCostSar || 0;
  const feesSar = toSarAmount(input.fees || 0, currency, state.rates);
  const date = input.date || todayIsoDate();
  const now = new Date().toISOString();
  const id = generateRecordId('asale');
  const referenceId = (input.referenceId || '').trim() || `INV-${id.slice(-5)}`;
  const paymentChannel = input.paymentChannel || 'نقد';
  const sourceParty = (input.sourceParty || '').trim() || 'عميل مباشر';

  const nextProducts = [...state.products];
  if (matchedProd && prodIndex >= 0) {
    nextProducts[prodIndex] = {
      ...matchedProd,
      qty:
        input.status === 'completed'
          ? Math.max(0, matchedProd.qty - qty)
          : matchedProd.qty + qty,
      updatedAt: now,
    };
  }

  let nextLedger = [...state.ledger];
  const txNumber = generateNextTxNumber(nextLedger, date);
  const createdIds: string[] = [];

  const sale: AccountingSale = {
    id,
    txNumber,
    referenceId,
    productId: matchedProd?.id || input.productId || 'direct',
    productName,
    vendorCode,
    qty,
    unitPriceSar,
    unitCostSar,
    feesSar,
    status: input.status,
    paymentChannel,
    sourceParty,
    date,
    note: (input.note || '').trim() || undefined,
    createdAt: now,
  };

  const totalRevenueSar = roundMoney(qty * unitPriceSar, 2);

  if (input.status === 'completed' && totalRevenueSar > 0) {
    const revId = generateRecordId('aled');
    createdIds.push(revId);
    nextLedger.push({
      id: revId,
      tx_number: txNumber,
      date,
      direction: 'in',
      category: 'مبيعات',
      reference_type: referenceId.startsWith('#') || referenceId.startsWith('ELEN') ? 'order' : 'sale',
      reference_id: referenceId,
      source_party: sourceParty,
      payment_channel: paymentChannel,
      amount_sar: totalRevenueSar,
      original_amount: roundMoney(qty * input.unitPrice, 2),
      currency_code: currency,
      exchange_rate: rate,
      balance_after_sar: 0,
      notes: input.note?.trim() || `تحصيل فاتورة مبيعات: ${productName} (الكمية: ${qty})`,
      linked_record_id: id,
      is_manual: false,
      created_by: input.createdBy || 'admin',
      created_at: now,
    });
  } else if (input.status === 'returned' && totalRevenueSar > 0) {
    const retId = generateRecordId('aled');
    createdIds.push(retId);
    nextLedger.push({
      id: retId,
      tx_number: txNumber,
      date,
      direction: 'out',
      category: 'مرتجع عميل',
      reference_type: 'sale',
      reference_id: referenceId,
      source_party: sourceParty,
      payment_channel: paymentChannel,
      amount_sar: totalRevenueSar,
      original_amount: roundMoney(qty * input.unitPrice, 2),
      currency_code: currency,
      exchange_rate: rate,
      balance_after_sar: 0,
      notes: input.note?.trim() || `إرجاع مبلغ فاتورة: ${productName} (الكمية: ${qty})`,
      linked_record_id: id,
      is_manual: false,
      created_by: input.createdBy || 'admin',
      created_at: now,
    });
  }

  if (feesSar > 0) {
    const feeTxNumber = generateNextTxNumber(nextLedger, date);
    const feeId = generateRecordId('aled');
    createdIds.push(feeId);
    nextLedger.push({
      id: feeId,
      tx_number: feeTxNumber,
      date,
      direction: 'out',
      category: 'رسوم توصيل',
      reference_type: 'sale',
      reference_id: referenceId,
      source_party: 'شركة التوصيل / رسوم منصة',
      payment_channel: paymentChannel,
      amount_sar: feesSar,
      original_amount: roundMoney(input.fees || 0, 2),
      currency_code: currency,
      exchange_rate: rate,
      balance_after_sar: 0,
      notes: `رسوم توصيل/منصة للفاتورة ${referenceId} (${productName})`,
      linked_record_id: id,
      is_manual: false,
      created_by: input.createdBy || 'admin',
      created_at: new Date(Date.now() + 1).toISOString(),
    });
  }

  nextLedger = recomputeLedgerBalances(nextLedger);
  const createdLedgers = nextLedger.filter((l) => createdIds.includes(l.id));

  return {
    nextState: {
      ...state,
      products: nextProducts,
      sales: [...state.sales, sale],
      ledger: nextLedger,
      updated_at: now,
    },
    sale,
    createdLedgers,
  };
}

export interface AddExpenseInput {
  title: string;
  category: string;
  amount: number;
  currencyCode?: string;
  paymentChannel?: AccountingPaymentChannel;
  sourceParty?: string;
  referenceId?: string;
  date?: string;
  note?: string;
  createdBy?: string;
}

export function addAccountingExpense(
  state: AccountingDatabaseState,
  input: AddExpenseInput
): {
  nextState: AccountingDatabaseState;
  expense: AccountingExpense;
  createdLedger: AccountingLedgerEntry;
} {
  const currency = input.currencyCode || 'SAR';
  const rate = getRateForCurrency(currency, state.rates);
  const amountSar = Math.max(0.01, toSarAmount(input.amount, currency, state.rates));
  const date = input.date || todayIsoDate();
  const now = new Date().toISOString();
  const id = generateRecordId('aexp');
  const referenceId = (input.referenceId || '').trim() || `EXP-${id.slice(-5)}`;
  const paymentChannel = input.paymentChannel || 'نقد';
  const sourceParty = (input.sourceParty || '').trim() || input.category;

  let nextLedger = [...state.ledger];
  const txNumber = generateNextTxNumber(nextLedger, date);

  const expense: AccountingExpense = {
    id,
    txNumber,
    referenceId,
    title: input.title.trim(),
    category: input.category.trim(),
    amountSar,
    paymentChannel,
    sourceParty,
    date,
    note: (input.note || '').trim() || undefined,
    createdAt: now,
  };

  const ledgerId = generateRecordId('aled');
  const ledgerEntry: AccountingLedgerEntry = {
    id: ledgerId,
    tx_number: txNumber,
    date,
    direction: 'out',
    category: expense.category,
    reference_type: 'expense',
    reference_id: referenceId,
    source_party: sourceParty,
    payment_channel: paymentChannel,
    amount_sar: amountSar,
    original_amount: roundMoney(input.amount, 2),
    currency_code: currency,
    exchange_rate: rate,
    balance_after_sar: 0,
    notes: `${expense.title}${expense.note ? ` — ${expense.note}` : ''}`,
    linked_record_id: id,
    is_manual: false,
    created_by: input.createdBy || 'admin',
    created_at: now,
  };

  nextLedger = recomputeLedgerBalances([...nextLedger, ledgerEntry]);
  const createdLedger = nextLedger.find((l) => l.id === ledgerId)!;

  return {
    nextState: {
      ...state,
      expenses: [...state.expenses, expense],
      ledger: nextLedger,
      updated_at: now,
    },
    expense,
    createdLedger,
  };
}

export interface AddSupplierTxInput {
  code: string;
  type: 'purchase' | 'payment';
  amount: number;
  currencyCode?: string;
  paymentChannel?: AccountingPaymentChannel;
  referenceId?: string;
  note?: string;
  date?: string;
  createdBy?: string;
}

export function addAccountingSupplierTx(
  state: AccountingDatabaseState,
  input: AddSupplierTxInput
): {
  nextState: AccountingDatabaseState;
  supplierTx: AccountingSupplierTx;
  createdLedger?: AccountingLedgerEntry;
} {
  const currency = input.currencyCode || 'SAR';
  const rate = getRateForCurrency(currency, state.rates);
  const amountSar = Math.max(0.01, toSarAmount(input.amount, currency, state.rates));
  const date = input.date || todayIsoDate();
  const now = new Date().toISOString();
  const id = generateRecordId('asup');
  const referenceId = (input.referenceId || '').trim() || `SUP-${id.slice(-5)}`;
  const paymentChannel = input.paymentChannel || 'حوالة الكريمي';

  let nextLedger = [...state.ledger];
  const txNumber = generateNextTxNumber(nextLedger, date);

  const supplierTx: AccountingSupplierTx = {
    id,
    txNumber,
    referenceId,
    code: input.code.trim(),
    type: input.type,
    amountSar,
    paymentChannel: input.type === 'payment' ? paymentChannel : undefined,
    note: (input.note || '').trim(),
    date,
    createdAt: now,
  };

  let createdLedgerId: string | null = null;
  if (input.type === 'payment') {
    createdLedgerId = generateRecordId('aled');
    nextLedger.push({
      id: createdLedgerId,
      tx_number: txNumber,
      date,
      direction: 'out',
      category: 'سداد مورد',
      reference_type: 'supplier',
      reference_id: referenceId,
      source_party: supplierTx.code,
      payment_channel: paymentChannel,
      amount_sar: amountSar,
      original_amount: roundMoney(input.amount, 2),
      currency_code: currency,
      exchange_rate: rate,
      balance_after_sar: 0,
      notes: supplierTx.note || `سداد دفعة للمورد (${supplierTx.code})`,
      linked_record_id: id,
      is_manual: false,
      created_by: input.createdBy || 'admin',
      created_at: now,
    });
  }

  nextLedger = recomputeLedgerBalances(nextLedger);
  const createdLedger = createdLedgerId
    ? nextLedger.find((l) => l.id === createdLedgerId)
    : undefined;

  return {
    nextState: {
      ...state,
      suppliers: [...state.suppliers, supplierTx],
      ledger: nextLedger,
      updated_at: now,
    },
    supplierTx,
    createdLedger,
  };
}

export interface AddManualLedgerInput {
  date?: string;
  direction: AccountingDirection;
  category: string;
  referenceId: string;
  sourceParty: string;
  paymentChannel: AccountingPaymentChannel;
  amount: number;
  currencyCode?: string;
  notes?: string;
  referenceType?: AccountingReferenceType;
  createdBy?: string;
}

export function addManualLedgerEntry(
  state: AccountingDatabaseState,
  input: AddManualLedgerInput
): {
  nextState: AccountingDatabaseState;
  entry: AccountingLedgerEntry;
} {
  const currency = input.currencyCode || 'SAR';
  const rate = getRateForCurrency(currency, state.rates);
  const amountSar = Math.max(0.01, toSarAmount(input.amount, currency, state.rates));
  const date = input.date || todayIsoDate();
  const now = new Date().toISOString();
  const id = generateRecordId('aled');
  const txNumber = generateNextTxNumber(state.ledger, date);

  const newEntry: AccountingLedgerEntry = {
    id,
    tx_number: txNumber,
    date,
    direction: input.direction,
    category: input.category.trim() || (input.direction === 'in' ? 'إيراد إضافي' : 'مصاريف إدارية أخرى'),
    reference_type: input.referenceType || 'manual',
    reference_id: input.referenceId.trim() || txNumber,
    source_party: input.sourceParty.trim() || 'قيد مباشر',
    payment_channel: input.paymentChannel || 'نقد',
    amount_sar: amountSar,
    original_amount: roundMoney(input.amount, 2),
    currency_code: currency,
    exchange_rate: rate,
    balance_after_sar: 0,
    notes: (input.notes || '').trim() || 'حركة مالية مسجلة بالدفتر',
    linked_record_id: null,
    is_manual: true,
    created_by: input.createdBy || 'admin',
    created_at: now,
  };

  const nextLedger = recomputeLedgerBalances([...state.ledger, newEntry]);
  const entry = nextLedger.find((l) => l.id === id)!;

  return {
    nextState: {
      ...state,
      ledger: nextLedger,
      updated_at: now,
    },
    entry,
  };
}

function mapOrderPaymentChannel(paymentMethod?: string): AccountingPaymentChannel {
  switch (paymentMethod) {
    case 'bank_transfer':
      return 'تحويل بنكي';
    case 'mada':
      return 'بطاقة مدى / إلكتروني';
    case 'cod':
    default:
      return 'دفع عند الاستلام';
  }
}

export function syncStoreOrdersIntoAccounting(
  state: AccountingDatabaseState,
  storeOrders: Order[],
  storeProducts: Product[] = [],
  options: { onlyDeliveredOrCollected?: boolean; createdBy?: string } = {}
): {
  nextState: AccountingDatabaseState;
  importedCount: number;
  importedSales: AccountingSale[];
  createdLedgers: AccountingLedgerEntry[];
} {
  const existingRefs = new Set<string>([
    ...state.sales.map((s) => String(s.referenceId || '').trim().toUpperCase()),
    ...state.ledger.map((l) => String(l.reference_id || '').trim().toUpperCase()),
  ]);

  let current = state;
  const importedSales: AccountingSale[] = [];
  const createdLedgers: AccountingLedgerEntry[] = [];

  for (const order of storeOrders) {
    if (!order || order.status === 'cancelled') continue;
    if (options.onlyDeliveredOrCollected && order.status !== 'delivered' && !order.cod_collected) {
      continue;
    }

    const ref = String(order.order_number || order.id).trim();
    if (!ref || existingRefs.has(ref.toUpperCase())) continue;

    existingRefs.add(ref.toUpperCase());

    const totalQty = Math.max(
      1,
      (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)
    );
    const itemsSummary = (order.items || [])
      .map((i) => `${i.title_ar} (×${i.quantity})`)
      .join(' + ');

    // Match inventory landed cost if an AccountingProduct links to a store product
    let estimatedTotalCostSar = 0;
    for (const item of order.items || []) {
      const accProd = current.products.find(
        (ap) =>
          (ap.storeProductId && ap.storeProductId === item.product_id) ||
          ap.name.trim() === String(item.title_ar || '').trim()
      );
      if (accProd) {
        estimatedTotalCostSar += accProd.landedCostSar * (Number(item.quantity) || 1);
      } else {
        const sp = storeProducts.find((p) => p.id === item.product_id);
        // fallback 0 cost unless landed cost exists so cash figures stay unfabricated
        if (sp) estimatedTotalCostSar += 0;
      }
    }

    const totalSar = Math.max(0, roundMoney(Number(order.total_amount) || 0, 2));
    const unitPriceSar = roundMoney(totalSar / totalQty, 2);
    const unitCostSar = roundMoney(estimatedTotalCostSar / totalQty, 2);
    const orderDate = String(order.delivered_at || order.created_at || todayIsoDate()).slice(0, 10);
    const sourceParty = `${order.customer_name || 'عميل المتجر'}${order.city ? ` (${order.city})` : ''}`;

    const result = addAccountingSale(current, {
      productName: itemsSummary || `طلب رقم ${ref}`,
      vendorCode: 'STORE-ORDER',
      qty: totalQty,
      unitPrice: unitPriceSar,
      unitCostOverrideSar: unitCostSar,
      fees: 0,
      currencyCode: 'SAR',
      status: 'completed',
      paymentChannel: mapOrderPaymentChannel(order.payment_method),
      sourceParty,
      referenceId: ref,
      date: orderDate,
      note: `استيراد آلي من طلبات المتجر — ${order.customer_phone || ''}${
        order.currencyInfo ? ` | الدفع بالمتجر: ${order.currencyInfo.totalInSelectedCurrency} ${order.currencyInfo.symbol}` : ''
      }`.trim(),
      createdBy: options.createdBy || 'auto-sync',
    });

    current = result.nextState;
    importedSales.push(result.sale);
    createdLedgers.push(...result.createdLedgers);
  }

  return {
    nextState: current,
    importedCount: importedSales.length,
    importedSales,
    createdLedgers,
  };
}

export function deleteAccountingRecord(
  state: AccountingDatabaseState,
  target: 'products' | 'sales' | 'expenses' | 'suppliers' | 'ledger',
  id: string
): {
  nextState: AccountingDatabaseState;
  removedLedgerIds: string[];
} {
  const now = new Date().toISOString();
  let removedLedgerIds: string[] = [];

  if (target === 'ledger') {
    removedLedgerIds = state.ledger.filter((l) => l.id === id).map((l) => l.id);
    const nextLedger = recomputeLedgerBalances(state.ledger.filter((l) => l.id !== id));
    return {
      nextState: { ...state, ledger: nextLedger, updated_at: now },
      removedLedgerIds,
    };
  }

  const nextProducts =
    target === 'products' ? state.products.filter((p) => p.id !== id) : state.products;
  const nextSales =
    target === 'sales' ? state.sales.filter((s) => s.id !== id) : state.sales;
  const nextExpenses =
    target === 'expenses' ? state.expenses.filter((e) => e.id !== id) : state.expenses;
  const nextSuppliers =
    target === 'suppliers' ? state.suppliers.filter((st) => st.id !== id) : state.suppliers;

  removedLedgerIds = state.ledger
    .filter((l) => l.linked_record_id === id)
    .map((l) => l.id);

  const nextLedger = recomputeLedgerBalances(
    state.ledger.filter((l) => l.linked_record_id !== id)
  );

  return {
    nextState: {
      ...state,
      products: nextProducts,
      sales: nextSales,
      expenses: nextExpenses,
      suppliers: nextSuppliers,
      ledger: nextLedger,
      updated_at: now,
    },
    removedLedgerIds,
  };
}

export interface SupplierBalanceRow {
  code: string;
  purchasesSar: number;
  paymentsSar: number;
  balanceSar: number;
  lastTxDate: string;
}

export interface AccountingSummary {
  totalRevenueSar: number;
  totalCogsSar: number;
  totalSalesFeesSar: number;
  directCostsSar: number;
  grossProfitSar: number;
  totalOpexSar: number;
  netProfitSar: number;
  profitMarginPct: number;
  completedOrdersCount: number;
  returnedOrdersCount: number;
  inventoryValueSar: number;
  inventoryUnits: number;
  supplierPurchasesSar: number;
  supplierPaymentsSar: number;
  supplierDebtSar: number;
  totalCashInSar: number;
  totalCashOutSar: number;
  cashBalanceSar: number;
  ledgerCount: number;
  supplierBalances: SupplierBalanceRow[];
}

export function computeAccountingSummary(state: AccountingDatabaseState): AccountingSummary {
  let totalRevenueSar = 0;
  let totalCogsSar = 0;
  let totalSalesFeesSar = 0;
  let completedOrdersCount = 0;
  let returnedOrdersCount = 0;

  for (const s of state.sales) {
    if (s.status === 'completed') {
      totalRevenueSar += (s.qty || 0) * (s.unitPriceSar || 0);
      totalCogsSar += (s.qty || 0) * (s.unitCostSar || 0);
      completedOrdersCount += 1;
    } else {
      returnedOrdersCount += 1;
    }
    totalSalesFeesSar += s.feesSar || 0;
  }

  let totalOpexSar = 0;
  for (const ex of state.expenses) {
    totalOpexSar += ex.amountSar || 0;
  }

  let inventoryValueSar = 0;
  let inventoryUnits = 0;
  for (const p of state.products) {
    const qty = Math.max(0, p.qty || 0);
    inventoryUnits += qty;
    inventoryValueSar += qty * (p.landedCostSar || 0);
  }

  const supplierMap = new Map<string, SupplierBalanceRow>();
  let supplierPurchasesSar = 0;
  let supplierPaymentsSar = 0;

  for (const st of state.suppliers) {
    const code = String(st.code || 'غير محدد').trim();
    const row = supplierMap.get(code) || {
      code,
      purchasesSar: 0,
      paymentsSar: 0,
      balanceSar: 0,
      lastTxDate: st.date || '',
    };
    if (st.type === 'purchase') {
      row.purchasesSar = roundMoney(row.purchasesSar + (st.amountSar || 0), 2);
      supplierPurchasesSar += st.amountSar || 0;
    } else {
      row.paymentsSar = roundMoney(row.paymentsSar + (st.amountSar || 0), 2);
      supplierPaymentsSar += st.amountSar || 0;
    }
    row.balanceSar = roundMoney(row.purchasesSar - row.paymentsSar, 2);
    if (st.date > row.lastTxDate) row.lastTxDate = st.date;
    supplierMap.set(code, row);
  }

  let totalCashInSar = 0;
  let totalCashOutSar = 0;
  for (const l of state.ledger) {
    if (l.direction === 'in') totalCashInSar += l.amount_sar || 0;
    else totalCashOutSar += l.amount_sar || 0;
  }

  const directCostsSar = roundMoney(totalCogsSar + totalSalesFeesSar, 2);
  const grossProfitSar = roundMoney(totalRevenueSar - directCostsSar, 2);
  const netProfitSar = roundMoney(grossProfitSar - totalOpexSar, 2);
  const profitMarginPct =
    totalRevenueSar > 0 ? roundMoney((netProfitSar / totalRevenueSar) * 100, 1) : 0;

  return {
    totalRevenueSar: roundMoney(totalRevenueSar, 2),
    totalCogsSar: roundMoney(totalCogsSar, 2),
    totalSalesFeesSar: roundMoney(totalSalesFeesSar, 2),
    directCostsSar,
    grossProfitSar,
    totalOpexSar: roundMoney(totalOpexSar, 2),
    netProfitSar,
    profitMarginPct,
    completedOrdersCount,
    returnedOrdersCount,
    inventoryValueSar: roundMoney(inventoryValueSar, 2),
    inventoryUnits,
    supplierPurchasesSar: roundMoney(supplierPurchasesSar, 2),
    supplierPaymentsSar: roundMoney(supplierPaymentsSar, 2),
    supplierDebtSar: Math.max(0, roundMoney(supplierPurchasesSar - supplierPaymentsSar, 2)),
    totalCashInSar: roundMoney(totalCashInSar, 2),
    totalCashOutSar: roundMoney(totalCashOutSar, 2),
    cashBalanceSar: roundMoney(totalCashInSar - totalCashOutSar, 2),
    ledgerCount: state.ledger.length,
    supplierBalances: Array.from(supplierMap.values()).sort((a, b) => b.balanceSar - a.balanceSar),
  };
}

export interface LedgerFilterOptions {
  search?: string;
  direction?: 'all' | 'in' | 'out';
  category?: string;
  paymentChannel?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function filterLedgerEntries(
  ledger: AccountingLedgerEntry[],
  filters: LedgerFilterOptions
): AccountingLedgerEntry[] {
  const q = (filters.search || '').trim().toLowerCase();
  return ledger.filter((entry) => {
    if (filters.direction && filters.direction !== 'all' && entry.direction !== filters.direction) {
      return false;
    }
    if (filters.category && filters.category !== 'all' && entry.category !== filters.category) {
      return false;
    }
    if (
      filters.paymentChannel &&
      filters.paymentChannel !== 'all' &&
      entry.payment_channel !== filters.paymentChannel
    ) {
      return false;
    }
    if (filters.dateFrom && entry.date < filters.dateFrom) return false;
    if (filters.dateTo && entry.date > filters.dateTo) return false;
    if (q) {
      const hay = [
        entry.tx_number,
        entry.reference_id,
        entry.source_party,
        entry.category,
        entry.payment_channel,
        entry.notes,
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function escapeCsvCell(val: unknown): string {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildLedgerCsv(ledger: AccountingLedgerEntry[]): string {
  const header =
    '\uFEFFرقم القيد,التاريخ,نوع الحركة,رقم المرجع,المصدر / الجهة,التصنيف,قناة الدفع,وارد (SAR),صادر (SAR),المبلغ الأصلي,العملة,الرصيد التراكمي (SAR),البيان';
  const rows = ledger.map((l) =>
    [
      l.tx_number,
      l.date,
      l.direction === 'in' ? 'وارد (+)' : 'صادر (-)',
      l.reference_id,
      l.source_party,
      l.category,
      l.payment_channel,
      l.direction === 'in' ? l.amount_sar : 0,
      l.direction === 'out' ? l.amount_sar : 0,
      l.original_amount,
      l.currency_code,
      l.balance_after_sar,
      l.notes,
    ]
      .map(escapeCsvCell)
      .join(',')
  );
  return [header, ...rows].join('\n');
}

export function buildSalesCsv(sales: AccountingSale[]): string {
  const header =
    '\uFEFFالتاريخ,المرجع,المنتج,كود المورد,الكمية,سعر البيع (SAR),التكلفة (SAR),الرسوم (SAR),الصافي (SAR),قناة الدفع,المصدر,الحالة';
  const rows = sales.map((s) => {
    const rev = s.status === 'completed' ? s.qty * s.unitPriceSar : 0;
    const cost = s.status === 'completed' ? s.qty * s.unitCostSar : 0;
    const net = roundMoney(rev - cost - (s.feesSar || 0), 2);
    return [
      s.date,
      s.referenceId,
      s.productName,
      s.vendorCode,
      s.qty,
      s.unitPriceSar,
      s.unitCostSar,
      s.feesSar,
      net,
      s.paymentChannel,
      s.sourceParty || '-',
      s.status === 'completed' ? 'مكتمل' : 'مرتجع',
    ]
      .map(escapeCsvCell)
      .join(',');
  });
  return [header, ...rows].join('\n');
}
