import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { adminDb, hasAdminServiceAccount } from './firebase-admin.ts';
import { db as clientDb, withFirestoreTimeout } from './firebase.ts';
import { INITIAL_CATEGORIES } from '../data/initialData.ts';
import { upsertProduct } from '../db/products.ts';
import { invalidateFirestoreCatalogCache, syncFirestoreProduct } from './firestore-catalog.ts';
import type { EmployeeDraft, EmployeeDraftSourceType, Product } from '../types.ts';

const DEFAULT_DRAFT_IMAGE =
  'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80';

const memoryDrafts = new Map<string, EmployeeDraft>();
const memoryDeletedDraftIds = new Set<string>();

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export function matchCategory(categoryInput?: string): { id: string; name_ar: string } {
  const raw = String(categoryInput || '').trim().toLowerCase();
  if (raw) {
    const exact = INITIAL_CATEGORIES.find(
      (c) => c.id.toLowerCase() === raw || c.name_ar.toLowerCase() === raw
    );
    if (exact) return { id: exact.id, name_ar: exact.name_ar };

    const partial = INITIAL_CATEGORIES.find(
      (c) =>
        raw.includes(c.name_ar.toLowerCase()) ||
        c.name_ar.toLowerCase().includes(raw) ||
        raw.includes(c.id.toLowerCase())
    );
    if (partial) return { id: partial.id, name_ar: partial.name_ar };

    if (raw.includes('عطر') || raw.includes('perfume') || raw.includes('عود')) {
      return { id: 'perfumes', name_ar: 'عطور فاخرة' };
    }
    if (raw.includes('مكياج') || raw.includes('makeup') || raw.includes('أحمر')) {
      return { id: 'makeup', name_ar: 'مكياج احترافي' };
    }
    if (raw.includes('شعر') || raw.includes('hair')) {
      return { id: 'haircare', name_ar: 'عناية بالشعر' };
    }
    if (raw.includes('جهاز') || raw.includes('إلكترون') || raw.includes('device')) {
      return { id: 'devices', name_ar: 'أجهزة العناية' };
    }
  }
  return { id: INITIAL_CATEGORIES[0].id, name_ar: INITIAL_CATEGORIES[0].name_ar };
}

function normalizeDraftRecord(id: string, raw: Record<string, any>): EmployeeDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title_ar || '').trim();
  if (!title) return null;

  const cat = matchCategory(raw.category_id || raw.category_name);
  const gallery = Array.isArray(raw.gallery_images)
    ? raw.gallery_images.filter((g) => typeof g === 'string' && g.trim() && !g.startsWith('blob:'))
    : [];
  let imageUrl = typeof raw.image_url === 'string' && !raw.image_url.startsWith('blob:') ? raw.image_url.trim() : '';
  if (!imageUrl) {
    imageUrl = gallery[0] || DEFAULT_DRAFT_IMAGE;
  }
  const normalizedGallery = gallery.length > 0 ? gallery : [imageUrl];
  const status = raw.status === 'published' ? 'published' : 'pending_pricing';
  const origPrice =
    status === 'published' && raw.original_price !== null && raw.original_price !== undefined && Number(raw.original_price) > 0
      ? Number(raw.original_price)
      : null;
  const discPrice =
    status === 'published' && raw.discount_price !== null && raw.discount_price !== undefined && Number(raw.discount_price) > 0
      ? Number(raw.discount_price)
      : null;

  return {
    id,
    employee_code: String(raw.employee_code || 'EMP001').toUpperCase(),
    title_ar: title.slice(0, 300),
    description_ar: String(raw.description_ar || '').slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    brand: String(raw.brand || 'غير محدد').slice(0, 150),
    size_or_volume: String(raw.size_or_volume || 'قياسي').slice(0, 100),
    ingredients: String(raw.ingredients || 'مكونات أصلية معتمدة').slice(0, 2000),
    how_to_use: String(raw.how_to_use || 'يُستخدم حسب الإرشادات الموضحة على العبوة').slice(0, 2000),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 12) : [],
    image_url: imageUrl,
    gallery_images: normalizedGallery,
    source_type: (raw.source_type as EmployeeDraftSourceType) || 'single_image',
    price: origPrice,
    original_price: origPrice,
    discount_price: discPrice,
    pricing_status_label:
      status === 'published' ? 'تم التسعير والنشر' : 'بانتظار التسعير من الإدارة',
    status,
    published_product_id: raw.published_product_id || null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
  };
}

async function persistDraftToFirestore(draft: EmployeeDraft): Promise<boolean> {
  if (isTestRuntime()) return true;

  const payload: Record<string, any> = {
    id: draft.id,
    employee_code: draft.employee_code,
    title_ar: draft.title_ar,
    description_ar: draft.description_ar,
    category_id: draft.category_id,
    category_name: draft.category_name,
    brand: draft.brand,
    size_or_volume: draft.size_or_volume,
    ingredients: draft.ingredients,
    how_to_use: draft.how_to_use,
    tags: draft.tags,
    image_url: draft.image_url,
    gallery_images: draft.gallery_images,
    source_type: draft.source_type,
    price: draft.price,
    original_price: draft.original_price,
    discount_price: draft.discount_price,
    pricing_status_label: draft.pricing_status_label,
    status: draft.status,
    published_product_id: draft.published_product_id || null,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };

  if (hasAdminServiceAccount) {
    try {
      await withFirestoreTimeout(
        adminDb.collection('ai_employee_drafts').doc(draft.id).set(payload, { merge: true }),
        4000
      );
      return true;
    } catch {
      // Fallback to client SDK
    }
  }

  try {
    await withFirestoreTimeout(
      setDoc(doc(clientDb, 'ai_employee_drafts', draft.id), payload, { merge: true }),
      5000
    );
    return true;
  } catch (err: any) {
    console.warn(`[Employee Drafts] Firestore sync notice for ${draft.id}:`, err?.message || err);
    return false;
  }
}

export async function createEmployeeDraft(input: {
  employee_code: string;
  title_ar: string;
  description_ar?: string;
  category_id?: string;
  category_name?: string;
  brand?: string;
  size_or_volume?: string;
  ingredients?: string;
  how_to_use?: string;
  tags?: string[];
  image_url?: string;
  gallery_images?: string[];
  source_type?: EmployeeDraftSourceType;
}): Promise<EmployeeDraft> {
  const title = String(input.title_ar || '').trim();
  if (!title) {
    throw new Error('اسم المنتج مطلوب لإنشاء المسودة.');
  }

  const now = new Date().toISOString();
  const id = `emp-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const cat = matchCategory(input.category_id || input.category_name);
  const gallery = Array.isArray(input.gallery_images)
    ? input.gallery_images.filter((g) => typeof g === 'string' && g.trim() && !g.startsWith('blob:'))
    : [];
  const primaryImg =
    typeof input.image_url === 'string' && input.image_url.trim() && !input.image_url.startsWith('blob:')
      ? input.image_url.trim()
      : gallery[0] || DEFAULT_DRAFT_IMAGE;

  // Strictly enforce null price and pending_pricing status on creation
  const draft: EmployeeDraft = {
    id,
    employee_code: String(input.employee_code || 'EMP001').trim().toUpperCase(),
    title_ar: title.slice(0, 300),
    description_ar: String(input.description_ar || 'مسودة منتج مستخرجة عبر مساعد الموظفين الذكي.').slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    brand: String(input.brand || 'غير محدد').slice(0, 150),
    size_or_volume: String(input.size_or_volume || 'قياسي').slice(0, 100),
    ingredients: String(input.ingredients || 'مكونات طبيعية وآمنة للبشرة').slice(0, 2000),
    how_to_use: String(input.how_to_use || 'يُستخدم حسب التعليمات المرفقة على العبوة').slice(0, 2000),
    tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean).slice(0, 12) : ['مسودة_موظف'],
    image_url: primaryImg,
    gallery_images: gallery.length > 0 ? gallery : [primaryImg],
    source_type: input.source_type || 'single_image',
    price: null,
    original_price: null,
    discount_price: null,
    pricing_status_label: 'بانتظار التسعير من الإدارة',
    status: 'pending_pricing',
    published_product_id: null,
    created_at: now,
    updated_at: now,
  };

  memoryDeletedDraftIds.delete(draft.id);
  memoryDrafts.set(draft.id, draft);
  await persistDraftToFirestore(draft);
  return draft;
}

export async function listEmployeeDrafts(filterEmployeeCode?: string): Promise<EmployeeDraft[]> {
  const byId = new Map<string, EmployeeDraft>();

  if (!isTestRuntime()) {
    try {
      const snap = hasAdminServiceAccount
        ? await withFirestoreTimeout(adminDb.collection('ai_employee_drafts').get(), 6000)
        : await withFirestoreTimeout(getDocs(collection(clientDb, 'ai_employee_drafts')), 7000);
      snap.forEach((docSnap: any) => {
        if (!memoryDeletedDraftIds.has(docSnap.id)) {
          const normalized = normalizeDraftRecord(docSnap.id, docSnap.data());
          if (normalized) byId.set(normalized.id, normalized);
        }
      });
    } catch (err: any) {
      console.warn('[Employee Drafts] Firestore list fallback to memory:', err?.message || err);
    }
  }

  for (const [id, d] of memoryDrafts.entries()) {
    if (!memoryDeletedDraftIds.has(id)) {
      byId.set(id, d);
    }
  }

  let items = Array.from(byId.values());
  if (filterEmployeeCode) {
    const normalizedCode = filterEmployeeCode.trim().toUpperCase();
    items = items.filter((d) => d.employee_code === normalizedCode);
  }

  return items.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function getEmployeeDraftById(draftId: string): Promise<EmployeeDraft | null> {
  if (!draftId || memoryDeletedDraftIds.has(draftId)) return null;
  const inMem = memoryDrafts.get(draftId);
  if (inMem) return inMem;

  if (!isTestRuntime()) {
    try {
      const snap = hasAdminServiceAccount
        ? await withFirestoreTimeout(adminDb.collection('ai_employee_drafts').doc(draftId).get(), 4000)
        : await withFirestoreTimeout(getDoc(doc(clientDb, 'ai_employee_drafts', draftId)), 4000);
      const exists = typeof snap.exists === 'function' ? snap.exists() : Boolean(snap.exists);
      if (exists) {
        const normalized = normalizeDraftRecord(snap.id, snap.data() || {});
        if (normalized) {
          memoryDrafts.set(normalized.id, normalized);
          return normalized;
        }
      }
    } catch {
      // Ignore transient read error
    }
  }
  return null;
}

export async function updateEmployeeDraft(
  draftId: string,
  updates: Partial<{
    title_ar: string;
    description_ar: string;
    category_id: string;
    category_name: string;
    brand: string;
    size_or_volume: string;
    ingredients: string;
    how_to_use: string;
    tags: string[];
    original_price: number | null;
    discount_price: number | null;
  }>
): Promise<EmployeeDraft> {
  const existing = await getEmployeeDraftById(draftId);
  if (!existing) {
    throw new Error('المسودة المطلوبة غير موجودة.');
  }

  const cat =
    updates.category_id || updates.category_name
      ? matchCategory(updates.category_id || updates.category_name)
      : { id: existing.category_id, name_ar: existing.category_name };

  const nextPrice =
    updates.original_price !== undefined
      ? updates.original_price !== null && Number(updates.original_price) > 0
        ? Number(updates.original_price)
        : null
      : existing.original_price;

  const nextDiscount =
    updates.discount_price !== undefined
      ? updates.discount_price !== null && Number(updates.discount_price) > 0
        ? Number(updates.discount_price)
        : null
      : existing.discount_price;

  const updated: EmployeeDraft = {
    ...existing,
    title_ar: updates.title_ar ? String(updates.title_ar).trim().slice(0, 300) : existing.title_ar,
    description_ar:
      updates.description_ar !== undefined
        ? String(updates.description_ar).slice(0, 4000)
        : existing.description_ar,
    category_id: cat.id,
    category_name: cat.name_ar,
    brand: updates.brand !== undefined ? String(updates.brand).slice(0, 150) : existing.brand,
    size_or_volume:
      updates.size_or_volume !== undefined
        ? String(updates.size_or_volume).slice(0, 100)
        : existing.size_or_volume,
    ingredients:
      updates.ingredients !== undefined
        ? String(updates.ingredients).slice(0, 2000)
        : existing.ingredients,
    how_to_use:
      updates.how_to_use !== undefined
        ? String(updates.how_to_use).slice(0, 2000)
        : existing.how_to_use,
    tags: Array.isArray(updates.tags) ? updates.tags.map(String).slice(0, 12) : existing.tags,
    price: nextPrice,
    original_price: nextPrice,
    discount_price: nextDiscount,
    updated_at: new Date().toISOString(),
  };

  memoryDrafts.set(draftId, updated);
  await persistDraftToFirestore(updated);
  return updated;
}

export async function publishEmployeeDraft(
  draftId: string,
  adminInput: {
    original_price: number;
    discount_price?: number | null;
    stock_quantity?: number;
    title_ar?: string;
    description_ar?: string;
    category_id?: string;
    category_name?: string;
    brand?: string;
    size_or_volume?: string;
    ingredients?: string;
    how_to_use?: string;
    tags?: string[];
  }
): Promise<{ draft: EmployeeDraft; product: Product }> {
  const existing = await getEmployeeDraftById(draftId);
  if (!existing) {
    throw new Error('المسودة المطلوبة غير موجودة.');
  }

  const numericPrice = Number(adminInput.original_price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new Error('يرجى تحديد سعر أصلي صحيح أكبر من صفر قبل نشر المنتج.');
  }

  const numericDiscount =
    adminInput.discount_price !== null &&
    adminInput.discount_price !== undefined &&
    Number(adminInput.discount_price) > 0 &&
    Number(adminInput.discount_price) < numericPrice
      ? Number(adminInput.discount_price)
      : null;

  const stockQty = Math.max(1, Math.floor(Number(adminInput.stock_quantity ?? 10) || 10));
  const updatedDraft = await updateEmployeeDraft(draftId, {
    ...adminInput,
    original_price: numericPrice,
    discount_price: numericDiscount,
  });

  const now = new Date().toISOString();
  const productId = updatedDraft.published_product_id || `prod-emp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tagsWithBrand = Array.from(
    new Set([
      ...(updatedDraft.tags || []),
      ...(updatedDraft.brand && updatedDraft.brand !== 'غير محدد' ? [updatedDraft.brand] : []),
    ])
  ).slice(0, 12);

  const product: Product = {
    id: productId,
    title_ar: updatedDraft.title_ar,
    description_ar: updatedDraft.description_ar,
    original_price: numericPrice,
    discount_price: numericDiscount,
    stock_quantity: stockQty,
    category_id: updatedDraft.category_id,
    category_name: updatedDraft.category_name,
    tags: tagsWithBrand,
    image_url: updatedDraft.image_url,
    gallery_images: updatedDraft.gallery_images,
    size_or_volume: updatedDraft.size_or_volume,
    how_to_use: updatedDraft.how_to_use,
    ingredients: updatedDraft.ingredients,
    ai_generated: true,
    rating: 5.0,
    reviews_count: 1,
    featured: true,
    status: 'published',
    creator_id: updatedDraft.employee_code,
    created_at: now,
  };

  await upsertProduct(product);
  await syncFirestoreProduct(product.id, {
    id: product.id,
    title_ar: product.title_ar,
    description_ar: product.description_ar,
    original_price: product.original_price,
    discount_price: product.discount_price,
    stock_quantity: product.stock_quantity,
    category_id: product.category_id,
    category_name: product.category_name,
    image_url: product.image_url,
    gallery_images: product.gallery_images,
    tags: product.tags,
    size_or_volume: product.size_or_volume,
    how_to_use: product.how_to_use,
    ingredients: product.ingredients,
    ai_generated: true,
    rating: 5.0,
    reviews_count: 1,
    featured: true,
    status: 'published',
    creator_id: updatedDraft.employee_code,
    created_at: now,
    createdAt: now,
    updatedAt: now,
  });
  invalidateFirestoreCatalogCache();

  const publishedDraft: EmployeeDraft = {
    ...updatedDraft,
    price: numericPrice,
    original_price: numericPrice,
    discount_price: numericDiscount,
    status: 'published',
    pricing_status_label: 'تم التسعير والنشر',
    published_product_id: product.id,
    updated_at: now,
  };
  memoryDrafts.set(draftId, publishedDraft);
  await persistDraftToFirestore(publishedDraft);

  return { draft: publishedDraft, product };
}

export async function deleteEmployeeDraft(draftId: string): Promise<boolean> {
  if (!draftId) return false;
  memoryDeletedDraftIds.add(draftId);
  const existedInMemory = memoryDrafts.delete(draftId);

  if (!isTestRuntime()) {
    try {
      if (hasAdminServiceAccount) {
        await withFirestoreTimeout(adminDb.collection('ai_employee_drafts').doc(draftId).delete(), 4000);
      } else {
        await withFirestoreTimeout(deleteDoc(doc(clientDb, 'ai_employee_drafts', draftId)), 4000);
      }
      return true;
    } catch {
      return existedInMemory;
    }
  }
  return existedInMemory || true;
}

export async function getPendingEmployeeDraftsCount(): Promise<number> {
  const all = await listEmployeeDrafts();
  return all.filter((d) => d.status === 'pending_pricing').length;
}
