import { collection, deleteDoc, doc, getDocs, setDoc } from 'firebase/firestore';
import { auth, db, withFirestoreTimeout } from './firebase';
import { getAuthHeadersAsync } from './storage';
import {
  createEmptyAccountingState,
  normalizeAccountingState,
} from './accounting';
import type {
  AccountingDatabaseState,
  AccountingLedgerEntry,
  StoreSettings,
} from '../types';

const ACCOUNTING_LOCAL_KEY = 'amazon_duaa_accounting_v2';

export function getLocalAccountingState(settings?: Partial<StoreSettings>): AccountingDatabaseState {
  try {
    if (typeof localStorage === 'undefined') return createEmptyAccountingState(settings);
    const raw = localStorage.getItem(ACCOUNTING_LOCAL_KEY);
    if (!raw) return createEmptyAccountingState(settings);
    return normalizeAccountingState(JSON.parse(raw), settings);
  } catch {
    return createEmptyAccountingState(settings);
  }
}

export function saveLocalAccountingState(state: AccountingDatabaseState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ACCOUNTING_LOCAL_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[Accounting] Failed saving local cache:', e);
  }
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean as T;
}

async function fetchAccountingFromFirestore(
  settings?: Partial<StoreSettings>
): Promise<Partial<AccountingDatabaseState> | null> {
  if (!auth.currentUser) return null;
  try {
    const [prodSnap, saleSnap, expSnap, supSnap, ledSnap] = await withFirestoreTimeout(
      Promise.all([
        getDocs(collection(db, 'accounting_products')),
        getDocs(collection(db, 'accounting_sales')),
        getDocs(collection(db, 'accounting_expenses')),
        getDocs(collection(db, 'accounting_suppliers')),
        getDocs(collection(db, 'accounting_ledger')),
      ]),
      4500
    );

    const data: Partial<AccountingDatabaseState> = {
      rates: createEmptyAccountingState(settings).rates,
      products: prodSnap.docs.map((d) => d.data() as any),
      sales: saleSnap.docs.map((d) => d.data() as any),
      expenses: expSnap.docs.map((d) => d.data() as any),
      suppliers: supSnap.docs.map((d) => d.data() as any),
      ledger: ledSnap.docs.map((d) => d.data() as any),
    };

    const hasAny =
      (data.products?.length || 0) > 0 ||
      (data.sales?.length || 0) > 0 ||
      (data.expenses?.length || 0) > 0 ||
      (data.suppliers?.length || 0) > 0 ||
      (data.ledger?.length || 0) > 0;

    return hasAny ? data : null;
  } catch (err: any) {
    const msg = String(err?.code || err?.message || '');
    if (!msg.includes('permission-denied') && !msg.includes('resource-exhausted')) {
      console.warn('[Accounting Firestore] Read skipped:', msg);
    }
    return null;
  }
}

export async function syncDocToFirestore(
  collectionName:
    | 'accounting_products'
    | 'accounting_sales'
    | 'accounting_expenses'
    | 'accounting_suppliers'
    | 'accounting_ledger',
  record: { id: string } & Record<string, any>
): Promise<void> {
  if (!auth.currentUser || !record?.id) return;
  try {
    await withFirestoreTimeout(
      setDoc(doc(db, collectionName, record.id), stripUndefined(record), { merge: true }),
      4000
    );
  } catch (err: any) {
    const msg = String(err?.code || err?.message || '');
    if (!msg.includes('permission-denied') && !msg.includes('resource-exhausted')) {
      console.warn(`[Accounting Firestore] Write warning (${collectionName}):`, msg);
    }
  }
}

export async function deleteDocFromFirestore(
  collectionName:
    | 'accounting_products'
    | 'accounting_sales'
    | 'accounting_expenses'
    | 'accounting_suppliers'
    | 'accounting_ledger',
  id: string
): Promise<void> {
  if (!auth.currentUser || !id) return;
  try {
    await withFirestoreTimeout(deleteDoc(doc(db, collectionName, id)), 4000);
  } catch {
    // Graceful fallback when server JSON is primary
  }
}

export async function loadAccountingStateHydrated(
  settings?: Partial<StoreSettings>
): Promise<{
  state: AccountingDatabaseState;
  source: 'server' | 'firestore' | 'local';
}> {
  const local = getLocalAccountingState(settings);

  try {
    const headers = await getAuthHeadersAsync();
    const res = await fetch('/api/admin/accounting/state', {
      headers,
      credentials: 'include',
    });
    if (res.ok) {
      const json = await res.json();
      if (json?.state) {
        const serverState = normalizeAccountingState(json.state, settings);
        const serverCount =
          serverState.products.length +
          serverState.sales.length +
          serverState.expenses.length +
          serverState.suppliers.length +
          serverState.ledger.length;

        if (serverCount > 0) {
          saveLocalAccountingState(serverState);
          return { state: serverState, source: 'server' };
        }
      }
    }
  } catch {
    // Fall through to Firestore / localStorage
  }

  const fbData = await fetchAccountingFromFirestore(settings);
  if (fbData) {
    const hydrated = normalizeAccountingState(fbData, settings);
    saveLocalAccountingState(hydrated);
    return { state: hydrated, source: 'firestore' };
  }

  return { state: local, source: 'local' };
}

export async function postAccountingAction<T = any>(
  endpoint: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const authHeaders = await getAuthHeadersAsync();
    const headers: Record<string, string> = { ...authHeaders };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`/api/admin/accounting${endpoint}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: json?.error || `HTTP ${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'تعذر الاتصال بالخادم' };
  }
}

export async function syncAccountingDeltaToFirestore(params: {
  products?: any[];
  sales?: any[];
  expenses?: any[];
  suppliers?: any[];
  ledger?: AccountingLedgerEntry[];
}): Promise<void> {
  if (!auth.currentUser) return;
  const tasks: Promise<void>[] = [];
  for (const p of params.products || []) tasks.push(syncDocToFirestore('accounting_products', p));
  for (const s of params.sales || []) tasks.push(syncDocToFirestore('accounting_sales', s));
  for (const e of params.expenses || []) tasks.push(syncDocToFirestore('accounting_expenses', e));
  for (const st of params.suppliers || []) tasks.push(syncDocToFirestore('accounting_suppliers', st));
  for (const l of params.ledger || []) tasks.push(syncDocToFirestore('accounting_ledger', l));
  await Promise.all(tasks);
}
