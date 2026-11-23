import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { adminDb, hasAdminServiceAccount } from './firebase-admin.ts';
import { db as clientDb, withFirestoreTimeout } from './firebase.ts';
import { matchCategory } from './employee-drafts-store.ts';
import { upsertProduct } from '../db/products.ts';
import { invalidateFirestoreCatalogCache, syncFirestoreProduct } from './firestore-catalog.ts';
import type {
  BulkImportDraft,
  BulkImportImageStats,
  BulkImportSourceType,
  Product,
} from '../types.ts';

const FIRESTORE_DRAFTS_COLLECTION = 'supplier_ai_product_drafts';

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export function getBulkUploadsDir(): string {
  const dir = path.resolve(process.cwd(), 'uploads', 'bulk-import');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getDraftsFilePath(): string {
  if (isTestRuntime()) {
    return path.join(os.tmpdir(), 'amazon-duaa-bulk-import-drafts-test.json');
  }
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'bulk-import-drafts.json');
}

export function assertNoBase64Image(url: string, context = 'Firestore payload'): void {
  const trimmed = String(url || '').trim().toLowerCase();
  if (!trimmed) {
    throw new Error(`${context}: رابط الصورة فارغ.`);
  }
  if (trimmed.startsWith('data:') || trimmed.includes(';base64,')) {
    throw new Error(`${context}: ممنوع تخزين الصور بصيغة Base64 داخل Firestore.`);
  }
  if (trimmed.startsWith('blob:')) {
    throw new Error(`${context}: رابط blob المؤقت غير صالح للتخزين.`);
  }
}

export async function optimizeAndSaveBulkImage(
  rawBuffer: Buffer,
  originalFilename: string
): Promise<{
  imageUrl: string;
  optimizedBuffer: Buffer;
  stats: BulkImportImageStats;
}> {
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error('ملف الصورة فارغ أو غير صالح.');
  }

  const originalBytes = rawBuffer.length;
  const uploadsDir = getBulkUploadsDir();

  const { data: optimizedBuffer, info } = await sharp(rawBuffer)
    .rotate()
    .resize({
      width: 1200,
      height: 1200,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const safeSlug = originalFilename
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'product';

  const filename = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeSlug}.jpg`;
  const targetPath = path.join(uploadsDir, filename);
  fs.writeFileSync(targetPath, optimizedBuffer);

  const optimizedBytes = optimizedBuffer.length;
  const savedPercent =
    originalBytes > 0
      ? Math.max(0, Math.round(((originalBytes - optimizedBytes) / originalBytes) * 100))
      : 0;

  return {
    imageUrl: `/uploads/bulk-import/${filename}`,
    optimizedBuffer,
    stats: {
      original_bytes: originalBytes,
      optimized_bytes: optimizedBytes,
      width: info.width || 0,
      height: info.height || 0,
      format: 'jpeg',
      saved_percent: savedPercent,
    },
  };
}

const memoryBulkDrafts = new Map<string, BulkImportDraft>();
const memoryDeletedBulkDraftIds = new Set<string>();
let diskLoaded = false;

function loadDraftsFromDisk(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const filePath = getDraftsFilePath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item.id === 'string' && !memoryDeletedBulkDraftIds.has(item.id)) {
          memoryBulkDrafts.set(item.id, item);
        }
      }
    }
  } catch (err: any) {
    console.warn('[BulkImportStore] Failed to load persisted drafts from disk:', err?.message || err);
  }
}

function saveDraftsToDisk(): void {
  try {
    const filePath = getDraftsFilePath();
    const list = Array.from(memoryBulkDrafts.values());
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
  } catch (err: any) {
    console.warn('[BulkImportStore] Failed to write persisted drafts to disk:', err?.message || err);
  }
}

function normalizeBulkDraftRecord(id: string, raw: Record<string, any>): BulkImportDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.draft_kind && raw.draft_kind !== 'bulk_import') return null;
  const title = String(raw.title_ar || '').trim();
  const imageUrl = String(raw.image_url || '').trim();
  if (!title || !imageUrl) return null;
  if (imageUrl.toLowerCase().startsWith('data:') || imageUrl.toLowerCase().includes(';base64,')) {
    return null;
  }

  const cat = matchCategory(raw.category_id || raw.category_name);
  const status = raw.status === 'approved_published' ? 'approved_published' : 'pending_review';
  const origPrice =
    raw.original_price !== null &&
    raw.original_price !== undefined &&
    Number.isFinite(Number(raw.original_price)) &&
    Number(raw.original_price) > 0
      ? Number(raw.original_price)
      : null;

  const discPrice =
    raw.discount_price !== null &&
    raw.discount_price !== undefined &&
    Number.isFinite(Number(raw.discount_price)) &&
    Number(raw.discount_price) > 0 &&
    origPrice !== null &&
    Number(raw.discount_price) < origPrice
      ? Number(raw.discount_price)
      : null;

  const stats: BulkImportImageStats = {
    original_bytes: Number(raw.image_optimization?.original_bytes || 0),
    optimized_bytes: Number(raw.image_optimization?.optimized_bytes || 0),
    width: Number(raw.image_optimization?.width || 0),
    height: Number(raw.image_optimization?.height || 0),
    format: 'jpeg',
    saved_percent: Number(raw.image_optimization?.saved_percent || 0),
  };

  return {
    id,
    batch_id: String(raw.batch_id || 'batch-legacy'),
    source_filename: String(raw.source_filename || 'image.jpg'),
    source_type: raw.source_type === 'zip_archive' ? 'zip_archive' : 'multi_image',
    title_ar: title.slice(0, 300),
    description_ar: String(raw.description_ar || '').slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    brand: String(raw.brand || 'غير محدد').slice(0, 150),
    size_or_volume: String(raw.size_or_volume || 'قياسي').slice(0, 100),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 12) : [],
    image_url: imageUrl,
    image_optimization: stats,
    price: origPrice,
    original_price: origPrice,
    discount_price: discPrice,
    stock_quantity: Math.max(1, Math.floor(Number(raw.stock_quantity ?? 10) || 10)),
    status,
    published_product_id: raw.published_product_id || null,
    approved_by: raw.approved_by || null,
    approved_at: raw.approved_at || null,
    created_by: String(raw.created_by || 'admin'),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
  };
}

async function persistBulkDraftToFirestore(draft: BulkImportDraft): Promise<boolean> {
  // Enforce the strict no-Base64-in-Firestore rule before writing
  assertNoBase64Image(draft.image_url, 'BulkImportDraft');

  if (isTestRuntime()) return true;

  const payload: Record<string, any> = {
    id: draft.id,
    draft_kind: 'bulk_import',
    batch_id: draft.batch_id,
    source_filename: draft.source_filename,
    source_type: draft.source_type,
    title_ar: draft.title_ar,
    description_ar: draft.description_ar,
    category_id: draft.category_id,
    category_name: draft.category_name,
    brand: draft.brand,
    size_or_volume: draft.size_or_volume,
    tags: draft.tags,
    image_url: draft.image_url,
    image_optimization: draft.image_optimization,
    price: draft.price,
    original_price: draft.original_price,
    discount_price: draft.discount_price,
    stock_quantity: draft.stock_quantity,
    status: draft.status,
    published_product_id: draft.published_product_id || null,
    approved_by: draft.approved_by || null,
    approved_at: draft.approved_at || null,
    created_by: draft.created_by,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };

  if (hasAdminServiceAccount) {
    try {
      await withFirestoreTimeout(
        adminDb.collection(FIRESTORE_DRAFTS_COLLECTION).doc(draft.id).set(payload, { merge: true }),
        4000
      );
      return true;
    } catch {
      // Fallback to client SDK
    }
  }

  try {
    await withFirestoreTimeout(
      setDoc(doc(clientDb, FIRESTORE_DRAFTS_COLLECTION, draft.id), payload, { merge: true }),
      5000
    );
    return true;
  } catch (err: any) {
    console.warn(`[BulkImportStore] Firestore sync notice for ${draft.id}:`, err?.message || err);
    return false;
  }
}

export function validatePositivePrice(value: unknown): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error('يرجى تحديد السعر الأساسي (أكبر من صفر) أولاً قبل اعتماد ونشر المنتج في المتجر.');
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('يرجى تحديد السعر الأساسي (أكبر من صفر) أولاً قبل اعتماد ونشر المنتج في المتجر.');
  }
  return Math.round(num * 100) / 100;
}

export async function createBulkImportDraft(input: {
  batch_id: string;
  source_filename: string;
  source_type: BulkImportSourceType;
  title_ar: string;
  description_ar: string;
  category_id?: string;
  category_name?: string;
  brand?: string;
  size_or_volume?: string;
  tags?: string[];
  image_url: string;
  image_optimization: BulkImportImageStats;
  created_by?: string;
}): Promise<BulkImportDraft> {
  loadDraftsFromDisk();
  assertNoBase64Image(input.image_url, 'createBulkImportDraft');

  const title = String(input.title_ar || '').trim();
  if (!title) {
    throw new Error('اسم المنتج العربي مطلوب لحفظ المسودة.');
  }

  const now = new Date().toISOString();
  const id = `bulk-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const cat = matchCategory(input.category_id || input.category_name);

  // Strictly create in independent drafts area with null price & pending_review status
  const draft: BulkImportDraft = {
    id,
    batch_id: input.batch_id,
    source_filename: String(input.source_filename || 'product.jpg').slice(0, 200),
    source_type: input.source_type === 'zip_archive' ? 'zip_archive' : 'multi_image',
    title_ar: title.slice(0, 300),
    description_ar: String(
      input.description_ar || 'منتج مميز مستورد عبر نظام الاستيراد الذكي - متجر أمازون دعاء.'
    ).slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    brand: String(input.brand || 'غير محدد').slice(0, 150),
    size_or_volume: String(input.size_or_volume || 'قياسي').slice(0, 100),
    tags: Array.isArray(input.tags)
      ? input.tags.map(String).filter(Boolean).slice(0, 12)
      : ['استيراد_ذكي', 'جديد'],
    image_url: input.image_url,
    image_optimization: input.image_optimization,
    price: null,
    original_price: null,
    discount_price: null,
    stock_quantity: 10,
    status: 'pending_review',
    published_product_id: null,
    approved_by: null,
    approved_at: null,
    created_by: String(input.created_by || 'admin'),
    created_at: now,
    updated_at: now,
  };

  memoryDeletedBulkDraftIds.delete(draft.id);
  memoryBulkDrafts.set(draft.id, draft);
  saveDraftsToDisk();
  await persistBulkDraftToFirestore(draft);
  return draft;
}

export async function listBulkImportDrafts(statusFilter?: string): Promise<BulkImportDraft[]> {
  loadDraftsFromDisk();
  const byId = new Map<string, BulkImportDraft>();

  if (!isTestRuntime()) {
    try {
      const snap = hasAdminServiceAccount
        ? await withFirestoreTimeout(adminDb.collection(FIRESTORE_DRAFTS_COLLECTION).get(), 5000)
        : await withFirestoreTimeout(getDocs(collection(clientDb, FIRESTORE_DRAFTS_COLLECTION)), 5000);
      snap.forEach((docSnap: any) => {
        if (!memoryDeletedBulkDraftIds.has(docSnap.id) && docSnap.id.startsWith('bulk-draft-')) {
          const normalized = normalizeBulkDraftRecord(docSnap.id, docSnap.data());
          if (normalized) byId.set(normalized.id, normalized);
        }
      });
    } catch (err: any) {
      console.warn('[BulkImportStore] Firestore list fallback to persisted local store:', err?.message || err);
    }
  }

  for (const [id, d] of memoryBulkDrafts.entries()) {
    if (!memoryDeletedBulkDraftIds.has(id)) {
      byId.set(id, d);
    }
  }

  let items = Array.from(byId.values());
  if (statusFilter === 'pending_review' || statusFilter === 'approved_published') {
    items = items.filter((d) => d.status === statusFilter);
  }

  return items.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function getBulkImportDraftById(draftId: string): Promise<BulkImportDraft | null> {
  loadDraftsFromDisk();
  if (!draftId || memoryDeletedBulkDraftIds.has(draftId)) return null;
  const inMem = memoryBulkDrafts.get(draftId);
  if (inMem) return inMem;

  if (!isTestRuntime()) {
    try {
      const snap = hasAdminServiceAccount
        ? await withFirestoreTimeout(adminDb.collection(FIRESTORE_DRAFTS_COLLECTION).doc(draftId).get(), 4000)
        : await withFirestoreTimeout(getDoc(doc(clientDb, FIRESTORE_DRAFTS_COLLECTION, draftId)), 4000);
      const exists = typeof snap.exists === 'function' ? snap.exists() : Boolean(snap.exists);
      if (exists) {
        const normalized = normalizeBulkDraftRecord(snap.id, snap.data() || {});
        if (normalized) {
          memoryBulkDrafts.set(normalized.id, normalized);
          return normalized;
        }
      }
    } catch {
      // Ignore transient Firestore error
    }
  }
  return null;
}

export async function updateBulkImportDraft(
  draftId: string,
  updates: Partial<{
    title_ar: string;
    description_ar: string;
    category_id: string;
    category_name: string;
    brand: string;
    size_or_volume: string;
    tags: string[];
    stock_quantity: number;
    original_price: number | null;
    discount_price: number | null;
  }>
): Promise<BulkImportDraft> {
  const existing = await getBulkImportDraftById(draftId);
  if (!existing) {
    throw new Error('المسودة المطلوبة غير موجودة.');
  }

  const cat =
    updates.category_id || updates.category_name
      ? matchCategory(updates.category_id || updates.category_name)
      : { id: existing.category_id, name_ar: existing.category_name };

  let nextPrice = existing.original_price;
  if (updates.original_price !== undefined) {
    if (updates.original_price === null || updates.original_price === ('' as any)) {
      nextPrice = null;
    } else {
      const parsed = Number(updates.original_price);
      nextPrice = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
    }
  }

  let nextDiscount = existing.discount_price;
  if (updates.discount_price !== undefined) {
    if (updates.discount_price === null || updates.discount_price === ('' as any)) {
      nextDiscount = null;
    } else {
      const parsedDisc = Number(updates.discount_price);
      nextDiscount =
        Number.isFinite(parsedDisc) && parsedDisc > 0 && nextPrice !== null && parsedDisc < nextPrice
          ? Math.round(parsedDisc * 100) / 100
          : null;
    }
  } else if (nextDiscount !== null && (nextPrice === null || nextDiscount >= nextPrice)) {
    nextDiscount = null;
  }

  const nextStock =
    updates.stock_quantity !== undefined
      ? Math.max(1, Math.floor(Number(updates.stock_quantity) || 10))
      : existing.stock_quantity;

  const updated: BulkImportDraft = {
    ...existing,
    title_ar:
      updates.title_ar !== undefined && String(updates.title_ar).trim()
        ? String(updates.title_ar).trim().slice(0, 300)
        : existing.title_ar,
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
    tags: Array.isArray(updates.tags) ? updates.tags.map(String).filter(Boolean).slice(0, 12) : existing.tags,
    stock_quantity: nextStock,
    price: nextPrice,
    original_price: nextPrice,
    discount_price: nextDiscount,
    updated_at: new Date().toISOString(),
  };

  memoryBulkDrafts.set(draftId, updated);
  saveDraftsToDisk();
  await persistBulkDraftToFirestore(updated);
  return updated;
}

export async function deleteBulkImportDraft(draftId: string): Promise<boolean> {
  loadDraftsFromDisk();
  if (!draftId) return false;
  const existing = memoryBulkDrafts.get(draftId);
  memoryDeletedBulkDraftIds.add(draftId);
  const deletedFromMem = memoryBulkDrafts.delete(draftId);
  saveDraftsToDisk();

  // Remove orphaned local image ONLY if draft was NOT yet published
  if (existing && !existing.published_product_id && existing.image_url.startsWith('/uploads/bulk-import/')) {
    try {
      const imgPath = path.resolve(process.cwd(), existing.image_url.replace(/^\//, ''));
      if (imgPath.startsWith(getBulkUploadsDir()) && fs.existsSync(imgPath)) {
        fs.unlinkSync(imgPath);
      }
    } catch {
      // Ignore file cleanup issue
    }
  }

  if (!isTestRuntime()) {
    try {
      if (hasAdminServiceAccount) {
        await withFirestoreTimeout(
          adminDb.collection(FIRESTORE_DRAFTS_COLLECTION).doc(draftId).delete(),
          4000
        );
      } else {
        await withFirestoreTimeout(deleteDoc(doc(clientDb, FIRESTORE_DRAFTS_COLLECTION, draftId)), 4000);
      }
    } catch {
      // Ignore Firestore delete error
    }
  }
  return deletedFromMem || true;
}

export interface BulkApproveItemInput {
  id: string;
  original_price?: number | null;
  discount_price?: number | null;
  stock_quantity?: number;
  title_ar?: string;
  description_ar?: string;
  category_id?: string;
  brand?: string;
  size_or_volume?: string;
}

export async function publishBulkImportDraft(
  draftId: string,
  adminUsername: string,
  input: Omit<BulkApproveItemInput, 'id'> & { approve?: boolean }
): Promise<{ draft: BulkImportDraft; product: Product }> {
  if (input.approve !== true) {
    throw new Error('لا يُسمح بالنشر إلا بعد موافقة إدارية صريحة (approve: true).');
  }

  const existing = await getBulkImportDraftById(draftId);
  if (!existing) {
    throw new Error('المسودة المطلوبة غير موجودة.');
  }

  const effectivePriceRaw =
    input.original_price !== undefined ? input.original_price : existing.original_price;
  const validPrice = validatePositivePrice(effectivePriceRaw);

  const rawDisc =
    input.discount_price !== undefined ? input.discount_price : existing.discount_price;
  const validDiscount =
    rawDisc !== null &&
    rawDisc !== undefined &&
    Number.isFinite(Number(rawDisc)) &&
    Number(rawDisc) > 0 &&
    Number(rawDisc) < validPrice
      ? Math.round(Number(rawDisc) * 100) / 100
      : null;

  assertNoBase64Image(existing.image_url, 'publishBulkImportDraft');

  const updatedDraft = await updateBulkImportDraft(draftId, {
    title_ar: input.title_ar,
    description_ar: input.description_ar,
    category_id: input.category_id,
    brand: input.brand,
    size_or_volume: input.size_or_volume,
    stock_quantity: input.stock_quantity,
    original_price: validPrice,
    discount_price: validDiscount,
  });

  const now = new Date().toISOString();
  const productId =
    updatedDraft.published_product_id ||
    `prod-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const product: Product = {
    id: productId,
    title_ar: updatedDraft.title_ar,
    description_ar: updatedDraft.description_ar,
    original_price: validPrice,
    discount_price: validDiscount,
    stock_quantity: updatedDraft.stock_quantity,
    category_id: updatedDraft.category_id,
    category_name: updatedDraft.category_name,
    tags: updatedDraft.tags,
    image_url: updatedDraft.image_url,
    gallery_images: [updatedDraft.image_url],
    size_or_volume: updatedDraft.size_or_volume,
    ai_generated: true,
    rating: 5.0,
    reviews_count: 1,
    featured: true,
    status: 'published',
    creator_id: adminUsername || 'admin',
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
    ai_generated: true,
    rating: 5.0,
    reviews_count: 1,
    featured: true,
    status: 'published',
    creator_id: product.creator_id,
    created_at: now,
    createdAt: now,
    updatedAt: now,
  });
  invalidateFirestoreCatalogCache();

  const publishedDraft: BulkImportDraft = {
    ...updatedDraft,
    price: validPrice,
    original_price: validPrice,
    discount_price: validDiscount,
    status: 'approved_published',
    published_product_id: product.id,
    approved_by: adminUsername || 'admin',
    approved_at: now,
    updated_at: now,
  };

  memoryBulkDrafts.set(draftId, publishedDraft);
  saveDraftsToDisk();
  await persistBulkDraftToFirestore(publishedDraft);

  return { draft: publishedDraft, product };
}

export class BulkValidationError extends Error {
  invalidItems: Array<{ id: string; title_ar: string; reason: string }>;
  constructor(
    message: string,
    invalidItems: Array<{ id: string; title_ar: string; reason: string }>
  ) {
    super(message);
    this.invalidItems = invalidItems;
  }
}

export async function bulkPublishBulkImportDrafts(
  items: BulkApproveItemInput[],
  adminUsername: string,
  approve: boolean
): Promise<{ drafts: BulkImportDraft[]; products: Product[] }> {
  if (approve !== true) {
    throw new Error('لا يُسمح بالنشر الجماعي إلا بعد موافقة إدارية صريحة (approve: true).');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('يرجى تحديد منتج واحد على الأقل للاعتماد والنشر.');
  }

  // Step 1: Validate every single product's existence & price individually BEFORE publishing any
  const invalidItems: Array<{ id: string; title_ar: string; reason: string }> = [];

  for (const item of items) {
    const existing = await getBulkImportDraftById(item.id);
    if (!existing) {
      invalidItems.push({
        id: item.id,
        title_ar: item.title_ar || item.id,
        reason: 'المسودة غير موجودة.',
      });
      continue;
    }

    const effectivePrice =
      item.original_price !== undefined ? item.original_price : existing.original_price;
    try {
      validatePositivePrice(effectivePrice);
    } catch (priceErr: any) {
      invalidItems.push({
        id: item.id,
        title_ar: item.title_ar || existing.title_ar,
        reason: priceErr?.message || 'السعر غير صالح.',
      });
    }
  }

  if (invalidItems.length > 0) {
    throw new BulkValidationError(
      `تعذر النشر الجماعي: يوجد (${invalidItems.length}) منتج بدون سعر صحيح أكبر من صفر. السعر حقل إلزامي لكل منتج على حدة.`,
      invalidItems
    );
  }

  // Step 2: Publish each individually validated draft
  const publishedDrafts: BulkImportDraft[] = [];
  const publishedProducts: Product[] = [];

  for (const item of items) {
    const result = await publishBulkImportDraft(item.id, adminUsername, {
      ...item,
      approve: true,
    });
    publishedDrafts.push(result.draft);
    publishedProducts.push(result.product);
  }

  return { drafts: publishedDrafts, products: publishedProducts };
}
