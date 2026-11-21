import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFirestore = vi.hoisted(() => ({
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocFromServer: vi.fn(),
  onSnapshot: vi.fn(),
  doc: vi.fn((_db: any, ...segments: string[]) => ({
    __path: segments.join('/'),
    id: segments[segments.length - 1],
  })),
  collection: vi.fn((_db: any, ...segments: string[]) => ({
    __path: segments.join('/'),
  })),
  query: vi.fn((col: any, ...constraints: any[]) => ({ ...col, constraints })),
  where: vi.fn((field: string, op: string, value: any) => ({ field, op, value })),
  initializeFirestore: vi.fn(() => ({ __mockDb: true })),
  getFirestore: vi.fn(() => ({ __mockDb: true })),
  setLogLevel: vi.fn(),
}));

const mockAuthState = vi.hoisted(() => ({
  currentUser: {
    uid: 'user-sync-1',
    email: 'customer@example.com',
    emailVerified: true,
    isAnonymous: false,
    tenantId: null,
    providerData: [],
    getIdToken: vi.fn(async () => 'mock-id-token'),
  },
}));

vi.mock('firebase/firestore', () => mockFirestore);
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => mockAuthState),
  GoogleAuthProvider: class {
    addScope() {}
    static credentialFromResult() {
      return null;
    }
  },
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  updateProfile: vi.fn(),
  onAuthStateChanged: vi.fn(() => () => {}),
  onIdTokenChanged: vi.fn(() => () => {}),
}));

// Provide in-memory localStorage for Node environment
const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memStorage.set(k, v);
    },
    removeItem: (k: string) => {
      memStorage.delete(k);
    },
    clear: () => {
      memStorage.clear();
    },
  },
  configurable: true,
});

import {
  saveCartItemFirestore,
  removeCartItemFirestore,
  clearCartFirestore,
  mergeCartOnLogin,
  subscribeToCartFirestore,
  addWishlistFirestore,
  removeWishlistFirestore,
  fetchProductsFirestore,
  fetchOrdersFirestore,
  createOrderFirestore,
  updateOrderStatusFirestore,
  updateOrderDriverFirestore,
  testConnection,
  getFriendlyFirebaseErrorMessage,
} from '../src/lib/firebase';
import {
  fetchFirestoreCatalog,
  getLastFirestoreCatalogError,
  invalidateFirestoreCatalogCache,
} from '../src/lib/firestore-catalog';
import type { Order, Product } from '../src/types';

function makeSnapshot(docsList: Array<{ id: string; data: Record<string, any> }>) {
  return {
    empty: docsList.length === 0,
    docs: docsList.map((entry) => ({
      id: entry.id,
      ref: { __path: `doc/${entry.id}` },
      data: () => entry.data,
    })),
    forEach: (cb: (item: any) => void) => {
      for (const entry of docsList) {
        cb({
          id: entry.id,
          ref: { __path: `doc/${entry.id}` },
          data: () => entry.data,
        });
      }
    },
  };
}

const sampleProduct: Product = {
  id: 'prod-sync-1',
  title_ar: 'سيروم فيتامين سي',
  description_ar: 'وصف المنتج',
  original_price: 120,
  discount_price: 99,
  stock_quantity: 10,
  category_id: 'skincare',
  category_name: 'عناية بالبشرة',
  tags: [],
  image_url: 'https://example.com/serum.jpg',
  ai_generated: false,
  status: 'published',
  created_at: new Date().toISOString(),
};

const sampleOrder: Order = {
  id: 'ord-sync-1',
  order_number: 'ORD-SYNC-100',
  userId: 'user-sync-1',
  customer_name: 'سارة',
  customer_phone: '0500000001',
  city: 'الرياض',
  address: 'حي النرجس',
  items: [
    {
      product_id: sampleProduct.id,
      title_ar: sampleProduct.title_ar,
      price: 99,
      quantity: 1,
      image_url: sampleProduct.image_url,
    },
  ],
  subtotal: 99,
  discount_amount: 0,
  delivery_fee: 25,
  total_amount: 124,
  status: 'pending',
  whatsapp_sent: true,
  created_at: new Date().toISOString(),
};

describe('Firebase / Firestore Synchronization Resilience Audit Fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memStorage.clear();
    invalidateFirestoreCatalogCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Distinguishes Firestore quota exhaustion from document-size limit errors', () => {
    const quotaErr = {
      code: 'resource-exhausted',
      message: 'Quota exceeded: Free daily read units per project (free tier database)',
    };
    const sizeErr = {
      code: 'resource-exhausted',
      message: 'Document exceeds maximum allowed size of 1 MiB',
    };

    expect(getFriendlyFirebaseErrorMessage(quotaErr)).toContain('الحصة اليومية المجانية');
    expect(getFriendlyFirebaseErrorMessage(sizeErr)).toContain('1 ميجابايت');
  });

  it('2. Cart, wishlist, and order writes throw explicit errors instead of swallowing Firestore failures', async () => {
    const permissionErr = Object.assign(new Error('Missing or insufficient permissions'), {
      code: 'permission-denied',
    });

    mockFirestore.setDoc.mockRejectedValue(permissionErr);
    mockFirestore.deleteDoc.mockRejectedValue(permissionErr);
    mockFirestore.getDocs.mockRejectedValue(permissionErr);
    mockFirestore.updateDoc.mockRejectedValue(permissionErr);

    await expect(
      saveCartItemFirestore('user-sync-1', { product: sampleProduct, quantity: 2 })
    ).rejects.toThrow('ليس لديك الصلاحيات الكافية');

    await expect(removeCartItemFirestore('user-sync-1', sampleProduct.id)).rejects.toThrow(
      'ليس لديك الصلاحيات الكافية'
    );

    await expect(clearCartFirestore('user-sync-1')).rejects.toThrow('ليس لديك الصلاحيات الكافية');

    await expect(addWishlistFirestore('user-sync-1', sampleProduct)).rejects.toThrow(
      'ليس لديك الصلاحيات الكافية'
    );

    await expect(removeWishlistFirestore('user-sync-1', sampleProduct.id)).rejects.toThrow(
      'ليس لديك الصلاحيات الكافية'
    );

    await expect(createOrderFirestore(sampleOrder, 'user-sync-1')).rejects.toThrow(
      'ليس لديك الصلاحيات الكافية'
    );

    await expect(updateOrderStatusFirestore(sampleOrder.id, 'processing')).rejects.toThrow(
      'ليس لديك الصلاحيات الكافية'
    );

    await expect(
      updateOrderDriverFirestore(sampleOrder.id, { driver_name: 'أحمد', driver_phone: '0551112223' })
    ).rejects.toThrow('ليس لديك الصلاحيات الكافية');
  });

  it('3. updateOrderStatusFirestore rolls back localStorage if Firestore updateDoc fails', async () => {
    memStorage.set('elen_beauty_orders_v1', JSON.stringify([sampleOrder]));
    mockFirestore.updateDoc.mockRejectedValueOnce(
      Object.assign(new Error('Service unavailable'), { code: 'unavailable' })
    );

    await expect(updateOrderStatusFirestore(sampleOrder.id, 'delivered')).rejects.toThrow();

    const storedAfterFail = JSON.parse(memStorage.get('elen_beauty_orders_v1') || '[]');
    expect(storedAfterFail[0].status).toBe('pending');
  });

  it('4. fetchProductsFirestore and fetchOrdersFirestore expose error reason when Firestore fails', async () => {
    const quotaErr = Object.assign(
      new Error('Quota exceeded: Free daily read units per project'),
      { code: 'resource-exhausted' }
    );
    mockFirestore.getDocs.mockRejectedValueOnce(quotaErr);

    const prodFail = await fetchProductsFirestore();
    expect(prodFail.isFirebase).toBe(false);
    expect(prodFail.error).toContain('الحصة اليومية المجانية');

    mockFirestore.getDocs.mockRejectedValueOnce(quotaErr);
    const orderFail = await fetchOrdersFirestore('user-sync-1', false);
    expect(orderFail.isFirebase).toBe(false);
    expect(orderFail.error).toContain('الحصة اليومية المجانية');

    mockFirestore.getDocs.mockResolvedValueOnce(
      makeSnapshot([
        {
          id: sampleProduct.id,
          data: {
            title_ar: sampleProduct.title_ar,
            original_price: sampleProduct.original_price,
            stock_quantity: sampleProduct.stock_quantity,
            image_url: sampleProduct.image_url,
          },
        },
      ])
    );
    const prodOk = await fetchProductsFirestore();
    expect(prodOk.isFirebase).toBe(true);
    expect(prodOk.error).toBeUndefined();
    expect(prodOk.products.some((p) => p.id === sampleProduct.id)).toBe(true);
  });

  it('5. mergeCartOnLogin merges guest + server items without duplication and propagates sync errors', async () => {
    mockFirestore.getDocs.mockResolvedValueOnce(
      makeSnapshot([
        {
          id: sampleProduct.id,
          data: {
            productId: sampleProduct.id,
            quantity: 3,
            title_ar: sampleProduct.title_ar,
            price: 99,
            image_url: sampleProduct.image_url,
          },
        },
      ])
    );
    mockFirestore.setDoc.mockResolvedValue(undefined);

    const merged = await mergeCartOnLogin(
      'user-sync-1',
      [{ product: sampleProduct, quantity: 1 }],
      [sampleProduct]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe(3);
    expect(mockFirestore.setDoc).toHaveBeenCalledTimes(1);

    mockFirestore.getDocs.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'permission-denied' })
    );
    await expect(
      mergeCartOnLogin('user-sync-1', [{ product: sampleProduct, quantity: 1 }], [sampleProduct])
    ).rejects.toThrow('ليس لديك الصلاحيات الكافية');
  });

  it('6. subscribeToCartFirestore delivers snapshot items, forwards errors to onError, and unsubscribes cleanly', () => {
    const unsubSpy = vi.fn();
    let capturedOnNext: ((snap: any) => void) | null = null;
    let capturedOnError: ((err: Error) => void) | null = null;

    mockFirestore.onSnapshot.mockImplementation((_col: any, onNext: any, onErr: any) => {
      capturedOnNext = onNext;
      capturedOnError = onErr;
      return unsubSpy;
    });

    const onUpdate = vi.fn();
    const onError = vi.fn();
    const unsub = subscribeToCartFirestore('user-sync-1', [sampleProduct], onUpdate, onError);

    capturedOnNext?.(
      makeSnapshot([
        {
          id: sampleProduct.id,
          data: { productId: sampleProduct.id, quantity: 2 },
        },
      ])
    );
    expect(onUpdate).toHaveBeenCalledWith([{ product: sampleProduct, quantity: 2 }]);

    const snapErr = new Error('Listen stream failed');
    capturedOnError?.(snapErr);
    expect(onError).toHaveBeenCalledWith(snapErr);

    unsub();
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });

  it('7. testConnection verifies test/connection doc and reports offline state cleanly', async () => {
    mockFirestore.getDocFromServer.mockResolvedValueOnce({ exists: () => false });
    expect(await testConnection()).toBe(true);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFirestore.getDocFromServer.mockRejectedValueOnce(
      new Error('Failed to get document because the client is offline.')
    );
    expect(await testConnection()).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('8. fetchFirestoreCatalog records lastFirestoreCatalogError on failure and clears it on recovery', async () => {
    mockFirestore.getDocs.mockRejectedValueOnce(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded'));
    const emptyFallback = await fetchFirestoreCatalog(true);
    expect(emptyFallback).toEqual([]);
    expect(getLastFirestoreCatalogError()).toContain('RESOURCE_EXHAUSTED');

    mockFirestore.getDocs.mockResolvedValueOnce(
      makeSnapshot([
        {
          id: sampleProduct.id,
          data: {
            title_ar: sampleProduct.title_ar,
            original_price: sampleProduct.original_price,
            stock_quantity: 5,
            image_url: sampleProduct.image_url,
          },
        },
      ])
    );
    const recovered = await fetchFirestoreCatalog(true);
    expect(recovered).toHaveLength(1);
    expect(getLastFirestoreCatalogError()).toBeNull();
  });
});
