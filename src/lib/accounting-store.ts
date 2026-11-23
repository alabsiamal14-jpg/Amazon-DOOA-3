import fs from 'fs';
import os from 'os';
import path from 'path';
import { adminDb, hasAdminServiceAccount } from './firebase-admin.ts';
import {
  addAccountingExpense,
  addAccountingProduct,
  addAccountingSale,
  addAccountingSupplierTx,
  addManualLedgerEntry,
  createEmptyAccountingState,
  deleteAccountingRecord,
  normalizeAccountingState,
  syncStoreOrdersIntoAccounting,
  type AddExpenseInput,
  type AddManualLedgerInput,
  type AddProductInput,
  type AddSaleInput,
  type AddSupplierTxInput,
} from './accounting.ts';
import type {
  AccountingDatabaseState,
  AccountingRates,
  Order,
  Product,
} from '../types.ts';

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export function getAccountingStateFilePath(): string {
  if (isTestRuntime()) {
    return path.join(os.tmpdir(), 'amazon-duaa-accounting-test.json');
  }
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'accounting-state.json');
}

function sanitizeForFirestore<T extends Record<string, any>>(obj: T): T {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean as T;
}

export function readAccountingStateFromDisk(): AccountingDatabaseState {
  const filePath = getAccountingStateFilePath();
  if (!fs.existsSync(filePath)) {
    return createEmptyAccountingState();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return createEmptyAccountingState();
    return normalizeAccountingState(JSON.parse(raw));
  } catch (err) {
    console.warn('[AccountingStore] Failed reading JSON state, falling back to empty:', err);
    return createEmptyAccountingState();
  }
}

export function writeAccountingStateToDisk(state: AccountingDatabaseState): AccountingDatabaseState {
  const normalized = normalizeAccountingState(state);
  const filePath = getAccountingStateFilePath();
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

async function mirrorCollectionDocsToFirestore(
  collectionName: string,
  docs: Array<{ id: string } & Record<string, any>>
): Promise<void> {
  if (!hasAdminServiceAccount || isTestRuntime() || docs.length === 0) return;
  try {
    await Promise.all(
      docs.map((item) =>
        adminDb.collection(collectionName).doc(item.id).set(sanitizeForFirestore(item), { merge: true })
      )
    );
  } catch (err: any) {
    console.warn(`[AccountingStore] Firestore mirror warning (${collectionName}):`, err?.message || err);
  }
}

async function deleteCollectionDocsFromFirestore(
  collectionName: string,
  ids: string[]
): Promise<void> {
  if (!hasAdminServiceAccount || isTestRuntime() || ids.length === 0) return;
  try {
    await Promise.all(ids.map((id) => adminDb.collection(collectionName).doc(id).delete()));
  } catch (err: any) {
    console.warn(`[AccountingStore] Firestore delete warning (${collectionName}):`, err?.message || err);
  }
}

export async function getAccountingState(): Promise<AccountingDatabaseState> {
  const local = readAccountingStateFromDisk();
  if (!hasAdminServiceAccount || isTestRuntime()) {
    return local;
  }

  // Only hydrate from Firestore if local disk has no records yet, keeping disk fast & quota-safe
  const isLocalEmpty =
    local.products.length === 0 &&
    local.sales.length === 0 &&
    local.expenses.length === 0 &&
    local.suppliers.length === 0 &&
    local.ledger.length === 0;

  if (!isLocalEmpty) return local;

  try {
    const [prodSnap, saleSnap, expSnap, supSnap, ledSnap] = await Promise.all([
      adminDb.collection('accounting_products').get(),
      adminDb.collection('accounting_sales').get(),
      adminDb.collection('accounting_expenses').get(),
      adminDb.collection('accounting_suppliers').get(),
      adminDb.collection('accounting_ledger').get(),
    ]);

    const merged = normalizeAccountingState({
      rates: local.rates,
      products: prodSnap.docs.map((d) => d.data() as any),
      sales: saleSnap.docs.map((d) => d.data() as any),
      expenses: expSnap.docs.map((d) => d.data() as any),
      suppliers: supSnap.docs.map((d) => d.data() as any),
      ledger: ledSnap.docs.map((d) => d.data() as any),
    });

    if (
      merged.products.length > 0 ||
      merged.sales.length > 0 ||
      merged.expenses.length > 0 ||
      merged.suppliers.length > 0 ||
      merged.ledger.length > 0
    ) {
      writeAccountingStateToDisk(merged);
    }
    return merged;
  } catch (err: any) {
    console.warn('[AccountingStore] Firestore initial load skipped:', err?.message || err);
    return local;
  }
}

export async function updateAccountingRatesOnServer(
  rates: Partial<AccountingRates>
): Promise<AccountingDatabaseState> {
  const current = await getAccountingState();
  const next: AccountingDatabaseState = {
    ...current,
    rates: {
      SAR: 1,
      YER_OLD: Number(rates.YER_OLD) > 0 ? Number(rates.YER_OLD) : current.rates.YER_OLD,
      YER_NEW: Number(rates.YER_NEW) > 0 ? Number(rates.YER_NEW) : current.rates.YER_NEW,
      USD: Number(rates.USD) > 0 ? Number(rates.USD) : current.rates.USD,
    },
    updated_at: new Date().toISOString(),
  };
  return writeAccountingStateToDisk(next);
}

export async function createProductOnServer(input: AddProductInput) {
  const current = await getAccountingState();
  const res = addAccountingProduct(current, input);
  const saved = writeAccountingStateToDisk(res.nextState);
  await Promise.all([
    mirrorCollectionDocsToFirestore('accounting_products', [res.product]),
    res.createdSupplierTx
      ? mirrorCollectionDocsToFirestore('accounting_suppliers', [res.createdSupplierTx])
      : Promise.resolve(),
    res.createdLedger
      ? mirrorCollectionDocsToFirestore('accounting_ledger', [res.createdLedger])
      : Promise.resolve(),
  ]);
  return { state: saved, product: res.product, createdLedger: res.createdLedger };
}

export async function createSaleOnServer(input: AddSaleInput) {
  const current = await getAccountingState();
  const res = addAccountingSale(current, input);
  const saved = writeAccountingStateToDisk(res.nextState);
  const updatedProduct = saved.products.find((p) => p.id === res.sale.productId);
  await Promise.all([
    mirrorCollectionDocsToFirestore('accounting_sales', [res.sale]),
    updatedProduct
      ? mirrorCollectionDocsToFirestore('accounting_products', [updatedProduct])
      : Promise.resolve(),
    mirrorCollectionDocsToFirestore('accounting_ledger', res.createdLedgers),
  ]);
  return { state: saved, sale: res.sale, createdLedgers: res.createdLedgers };
}

export async function createExpenseOnServer(input: AddExpenseInput) {
  const current = await getAccountingState();
  const res = addAccountingExpense(current, input);
  const saved = writeAccountingStateToDisk(res.nextState);
  await Promise.all([
    mirrorCollectionDocsToFirestore('accounting_expenses', [res.expense]),
    mirrorCollectionDocsToFirestore('accounting_ledger', [res.createdLedger]),
  ]);
  return { state: saved, expense: res.expense, createdLedger: res.createdLedger };
}

export async function createSupplierTxOnServer(input: AddSupplierTxInput) {
  const current = await getAccountingState();
  const res = addAccountingSupplierTx(current, input);
  const saved = writeAccountingStateToDisk(res.nextState);
  await Promise.all([
    mirrorCollectionDocsToFirestore('accounting_suppliers', [res.supplierTx]),
    res.createdLedger
      ? mirrorCollectionDocsToFirestore('accounting_ledger', [res.createdLedger])
      : Promise.resolve(),
  ]);
  return { state: saved, supplierTx: res.supplierTx, createdLedger: res.createdLedger };
}

export async function createManualLedgerOnServer(input: AddManualLedgerInput) {
  const current = await getAccountingState();
  const res = addManualLedgerEntry(current, input);
  const saved = writeAccountingStateToDisk(res.nextState);
  await mirrorCollectionDocsToFirestore('accounting_ledger', [res.entry]);
  return { state: saved, entry: res.entry };
}

export async function syncOrdersOnServer(
  orders: Order[],
  products: Product[] = [],
  options: { onlyDeliveredOrCollected?: boolean; createdBy?: string } = {}
) {
  const current = await getAccountingState();
  const res = syncStoreOrdersIntoAccounting(current, orders, products, options);
  const saved = writeAccountingStateToDisk(res.nextState);
  await Promise.all([
    mirrorCollectionDocsToFirestore('accounting_sales', res.importedSales),
    mirrorCollectionDocsToFirestore('accounting_ledger', res.createdLedgers),
  ]);
  return {
    state: saved,
    importedCount: res.importedCount,
  };
}

export async function restoreAccountingStateOnServer(
  payload: Partial<AccountingDatabaseState>
): Promise<AccountingDatabaseState> {
  const normalized = normalizeAccountingState(payload);
  const saved = writeAccountingStateToDisk(normalized);
  await Promise.all([
    mirrorCollectionDocsToFirestore('accounting_products', saved.products),
    mirrorCollectionDocsToFirestore('accounting_sales', saved.sales),
    mirrorCollectionDocsToFirestore('accounting_expenses', saved.expenses),
    mirrorCollectionDocsToFirestore('accounting_suppliers', saved.suppliers),
    mirrorCollectionDocsToFirestore('accounting_ledger', saved.ledger),
  ]);
  return saved;
}

export async function deleteAccountingRecordOnServer(
  target: 'products' | 'sales' | 'expenses' | 'suppliers' | 'ledger',
  id: string
): Promise<AccountingDatabaseState> {
  const current = await getAccountingState();
  const res = deleteAccountingRecord(current, target, id);
  const saved = writeAccountingStateToDisk(res.nextState);

  const collectionMap: Record<typeof target, string> = {
    products: 'accounting_products',
    sales: 'accounting_sales',
    expenses: 'accounting_expenses',
    suppliers: 'accounting_suppliers',
    ledger: 'accounting_ledger',
  };

  await Promise.all([
    deleteCollectionDocsFromFirestore(collectionMap[target], [id]),
    target !== 'ledger'
      ? deleteCollectionDocsFromFirestore('accounting_ledger', res.removedLedgerIds)
      : Promise.resolve(),
  ]);

  return saved;
}
