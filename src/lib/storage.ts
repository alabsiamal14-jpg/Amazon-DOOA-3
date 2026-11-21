import { Product, StoreSettings, CartItem, Order, AdminUser, EmployeeSession } from '../types';
import { INITIAL_PRODUCTS, INITIAL_SETTINGS } from '../data/initialData';

const PRODUCTS_KEY = 'elen_beauty_products_v1';
const SETTINGS_KEY = 'elen_beauty_settings_v1';
const CART_KEY = 'elen_beauty_cart_v1';
const WISHLIST_KEY = 'amazon_duaa_wishlist_v1';
const ORDERS_KEY = 'elen_beauty_orders_v1';

export function getStoredWishlist(): string[] {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error loading wishlist from storage:', e);
    return [];
  }
}

export function saveStoredWishlist(wishlistIds: string[]): void {
  try {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlistIds));
  } catch (e) {
    console.error('Error saving wishlist to storage:', e);
  }
}
const ADMIN_SESSION_KEY = 'elen_beauty_admin_session_v1';

export function getStoredProducts(): Product[] {
  try {
    const raw = localStorage.getItem(PRODUCTS_KEY);
    if (!raw) return INITIAL_PRODUCTS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Merge any new INITIAL_PRODUCTS that don't exist yet in the saved array
      const existingIds = new Set(parsed.map((p: Product) => p.id));
      const missingInitial = INITIAL_PRODUCTS.filter((ip) => !existingIds.has(ip.id));
      if (missingInitial.length > 0) {
        const merged = [...parsed, ...missingInitial];
        localStorage.setItem(PRODUCTS_KEY, JSON.stringify(merged));
        return merged;
      }
      return parsed;
    }
    return INITIAL_PRODUCTS;
  } catch (e) {
    console.error('Error loading products from storage:', e);
    return INITIAL_PRODUCTS;
  }
}

export function saveStoredProducts(products: Product[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products));
  } catch (e) {
    console.warn('Error saving products to storage (retrying with compact cache):', e);
    const fallbackImg = 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80';
    for (const keepCount of [25, 10, 3, 0]) {
      try {
        const compacted = products.map((p, idx) => {
          const stripImage =
            idx >= keepCount && typeof p.image_url === 'string' && p.image_url.startsWith('data:image/');
          const stripGallery =
            idx >= keepCount && Array.isArray(p.gallery_images)
              ? p.gallery_images.filter((g) => typeof g === 'string' && !g.startsWith('data:image/'))
              : p.gallery_images;
          if (!stripImage && stripGallery === p.gallery_images) return p;
          return {
            ...p,
            ...(stripImage ? { image_url: fallbackImg } : {}),
            ...(stripGallery !== p.gallery_images ? { gallery_images: stripGallery } : {}),
          };
        });
        localStorage.setItem(PRODUCTS_KEY, JSON.stringify(compacted));
        return;
      } catch {
        // Try smaller keepCount
      }
    }
    console.error('Failed to save compact products cache after stripping data URLs.');
  }
}

export function upsertStoredProduct(product: Product): void {
  if (typeof localStorage === 'undefined' || !product?.id) return;
  const current = getStoredProducts();
  const exists = current.some((p) => p.id === product.id);
  const next = exists
    ? current.map((p) => (p.id === product.id ? product : p))
    : [product, ...current];
  saveStoredProducts(next);
}

export function upsertStoredProducts(newProducts: Product[]): void {
  if (typeof localStorage === 'undefined' || !Array.isArray(newProducts) || newProducts.length === 0) return;
  const current = getStoredProducts();
  const byId = new Map<string, Product>();
  for (const p of newProducts) {
    if (p?.id) byId.set(p.id, p);
  }
  for (const p of current) {
    if (p?.id && !byId.has(p.id)) {
      byId.set(p.id, p);
    }
  }
  saveStoredProducts(Array.from(byId.values()));
}

export function removeStoredProduct(productId: string): void {
  if (typeof localStorage === 'undefined' || !productId) return;
  const current = getStoredProducts();
  saveStoredProducts(current.filter((p) => p.id !== productId));
}

export function getStoredSettings(): StoreSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return INITIAL_SETTINGS;
    const parsed = JSON.parse(raw);
    delete parsed.adminPassword; // Purge legacy plaintext password
    if (parsed.whatsappNumber === '966500000000' || parsed.storeName?.includes('إيلين')) {
      parsed.whatsappNumber = INITIAL_SETTINGS.whatsappNumber;
      parsed.storeName = INITIAL_SETTINGS.storeName;
      parsed.tagline = INITIAL_SETTINGS.tagline;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...INITIAL_SETTINGS, ...parsed }));
    }
    return { ...INITIAL_SETTINGS, ...parsed };
  } catch (e) {
    console.error('Error loading settings from storage:', e);
    return INITIAL_SETTINGS;
  }
}

export function saveStoredSettings(settings: StoreSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Error saving settings to storage:', e);
  }
}

export function getStoredCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error loading cart from storage:', e);
    return [];
  }
}

export function saveStoredCart(cart: CartItem[]): void {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (e) {
    console.error('Error saving cart to storage:', e);
  }
}

export function getStoredOrders(): Order[] {
  try {
    const raw = localStorage.getItem(ORDERS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error loading orders from storage:', e);
    return [];
  }
}

export function saveStoredOrders(orders: Order[]): void {
  try {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  } catch (e) {
    console.error('Error saving orders to storage:', e);
  }
}

const ADMIN_TOKEN_KEY = 'amazon_duaa_admin_token_v1';
let cachedFirebaseIdToken: string | null = null;
let cachedAdminSessionToken: string | null = null;
let firebaseTokenProvider: (() => Promise<string | null>) | null = null;

function isJwtTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (typeof payload?.exp === 'number') {
      const expMs = payload.exp < 1e12 ? payload.exp * 1000 : payload.exp;
      return Date.now() >= expMs;
    }
    return false;
  } catch {
    return true;
  }
}

export function setFirebaseIdToken(token: string | null): void {
  cachedFirebaseIdToken =
    token && token !== 'undefined' && token !== 'null' && !isJwtTokenExpired(token)
      ? token
      : null;
}

export function registerFirebaseTokenProvider(provider: () => Promise<string | null>): void {
  firebaseTokenProvider = provider;
}

export function getAdminToken(): string | null {
  try {
    // Admin JWT is never stored in localStorage; purge any legacy localStorage token.
    if (typeof localStorage !== 'undefined' && localStorage.getItem(ADMIN_TOKEN_KEY) !== null) {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
  if (cachedAdminSessionToken && isJwtTokenExpired(cachedAdminSessionToken)) {
    cachedAdminSessionToken = null;
  }
  return cachedAdminSessionToken;
}

export function getAdminSession(): AdminUser | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    if (localStorage.getItem(ADMIN_TOKEN_KEY) !== null) {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { token: _ignoredToken, ...safeMetadata } = parsed;
    return safeMetadata as AdminUser;
  } catch {
    return null;
  }
}

export function setAdminSession(user: AdminUser, token?: string): void {
  if (token && token !== 'undefined' && token !== 'null' && !isJwtTokenExpired(token)) {
    cachedAdminSessionToken = token;
  }
  try {
    if (typeof localStorage === 'undefined') return;
    const { token: _ignoredToken, ...safeMetadata } = user || ({} as AdminUser);
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(safeMetadata));
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch (e) {
    console.error('Error setting admin session:', e);
  }
}

export function clearAdminSession(): void {
  cachedAdminSessionToken = null;
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch (e) {
    console.error('Error clearing admin session:', e);
  }
}

export function hasActiveAuthSession(): boolean {
  if (cachedAdminSessionToken && isJwtTokenExpired(cachedAdminSessionToken)) {
    cachedAdminSessionToken = null;
  }
  if (cachedFirebaseIdToken && isJwtTokenExpired(cachedFirebaseIdToken)) {
    cachedFirebaseIdToken = null;
  }
  return Boolean(cachedAdminSessionToken || cachedFirebaseIdToken || getAdminSession());
}

export async function hasActiveAuthSessionAsync(): Promise<boolean> {
  if (cachedAdminSessionToken && !isJwtTokenExpired(cachedAdminSessionToken)) {
    return true;
  }
  if (firebaseTokenProvider) {
    try {
      const freshToken = await firebaseTokenProvider();
      if (freshToken && freshToken !== 'undefined' && freshToken !== 'null') {
        cachedFirebaseIdToken = freshToken;
        return true;
      }
    } catch {
      // Fall back to cached token or HttpOnly admin session metadata
    }
  }
  return hasActiveAuthSession();
}

export function getAuthHeaders(): Record<string, string> {
  if (cachedAdminSessionToken && isJwtTokenExpired(cachedAdminSessionToken)) {
    cachedAdminSessionToken = null;
  }
  if (cachedAdminSessionToken) {
    return { Authorization: `Bearer ${cachedAdminSessionToken}` };
  }
  if (cachedFirebaseIdToken && isJwtTokenExpired(cachedFirebaseIdToken)) {
    cachedFirebaseIdToken = null;
  }
  if (cachedFirebaseIdToken && cachedFirebaseIdToken !== 'undefined' && cachedFirebaseIdToken !== 'null') {
    return { Authorization: `Bearer ${cachedFirebaseIdToken}` };
  }
  return {};
}

export async function getAuthHeadersAsync(): Promise<Record<string, string>> {
  if (cachedAdminSessionToken && !isJwtTokenExpired(cachedAdminSessionToken)) {
    return { Authorization: `Bearer ${cachedAdminSessionToken}` };
  }
  cachedAdminSessionToken = null;
  if (firebaseTokenProvider) {
    try {
      const freshToken = await firebaseTokenProvider();
      if (freshToken && freshToken !== 'undefined' && freshToken !== 'null') {
        cachedFirebaseIdToken = freshToken;
        return { Authorization: `Bearer ${freshToken}` };
      }
    } catch {
      // Fall back to cached Firebase ID token; HttpOnly admin cookie is sent automatically by browser
    }
  }
  return getAuthHeaders();
}

export function resetToDefaults(): void {
  try {
    localStorage.removeItem(PRODUCTS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(CART_KEY);
    localStorage.removeItem(ORDERS_KEY);
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch (e) {
    console.error('Error resetting storage:', e);
  }
}

// =========================================================================
// EMPLOYEE ASSISTANT SESSION STORAGE (ISOLATED FROM ADMIN SESSION)
// =========================================================================
const EMPLOYEE_SESSION_KEY = 'amazon_duaa_employee_session_v1';

export function getEmployeeSession(): EmployeeSession | null {
  try {
    const raw = localStorage.getItem(EMPLOYEE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EmployeeSession;
    if (!parsed?.token || !parsed?.code || isJwtTokenExpired(parsed.token)) {
      localStorage.removeItem(EMPLOYEE_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setEmployeeSession(session: EmployeeSession): void {
  try {
    localStorage.setItem(EMPLOYEE_SESSION_KEY, JSON.stringify(session));
  } catch (e) {
    console.error('Error saving employee session:', e);
  }
}

export function clearEmployeeSession(): void {
  try {
    localStorage.removeItem(EMPLOYEE_SESSION_KEY);
  } catch (e) {
    console.error('Error clearing employee session:', e);
  }
}

export function getEmployeeAuthHeaders(): Record<string, string> {
  const emp = getEmployeeSession();
  if (emp?.token) {
    return { Authorization: `Bearer ${emp.token}` };
  }
  return {};
}

// =========================================================================
// PRODUCT FORM DRAFT / AUTO-SAVE
// =========================================================================
const PRODUCT_FORM_DRAFT_KEY = 'amazon_duaa_product_form_draft_v1';

export interface ProductFormDraft {
  formData: {
    title_ar: string;
    description_ar: string;
    original_price: string;
    discount_price: string;
    stock_quantity: string;
    category_id: string;
    tags: string[];
    tagsInput: string;
    how_to_use: string;
    ingredients: string;
  };
  imagePreview?: string;
  activeMode?: 'batch' | 'video' | 'single';
  savedAt: string;
}

export function getProductFormDraft(): ProductFormDraft | null {
  try {
    const raw = localStorage.getItem(PRODUCT_FORM_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error loading product form draft from storage:', e);
    return null;
  }
}

export function saveProductFormDraft(draft: ProductFormDraft): void {
  try {
    localStorage.setItem(PRODUCT_FORM_DRAFT_KEY, JSON.stringify(draft));
  } catch (e) {
    console.warn('Error saving product form draft to storage (possibly quota exceeded with image):', e);
    // If saving failed due to image size, try saving without the imagePreview
    try {
      const fallbackDraft = { ...draft, imagePreview: undefined };
      localStorage.setItem(PRODUCT_FORM_DRAFT_KEY, JSON.stringify(fallbackDraft));
    } catch (fallbackErr) {
      console.error('Failed to save fallback draft:', fallbackErr);
    }
  }
}

export function clearProductFormDraft(): void {
  try {
    localStorage.removeItem(PRODUCT_FORM_DRAFT_KEY);
  } catch (e) {
    console.error('Error clearing product form draft from storage:', e);
  }
}

