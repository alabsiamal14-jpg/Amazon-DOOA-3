import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { adminDb, hasAdminServiceAccount } from './firebase-admin.ts';
import { db as clientDb, withFirestoreTimeout } from './firebase.ts';
import { matchCategory } from './employee-drafts-store.ts';
import {
  assertNoBase64Image,
  BulkValidationError,
  getBulkUploadsDir,
  optimizeAndSaveBulkImage,
} from './bulk-import-store.ts';
import { upsertProduct } from '../db/products.ts';
import { invalidateFirestoreCatalogCache, syncFirestoreProduct } from './firestore-catalog.ts';
import type {
  BulkImportImageStats,
  Product,
  SmartAssistantDraft,
  SmartAssistantDuplicateGroup,
  SmartAssistantSourceType,
  SmartAssistantStagedMedia,
} from '../types.ts';

const FIRESTORE_DRAFTS_COLLECTION = 'supplier_ai_product_drafts';

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

function getDraftsFilePath(): string {
  if (isTestRuntime()) {
    return path.join(os.tmpdir(), 'amazon-duaa-smart-assistant-drafts-test.json');
  }
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'smart-assistant-drafts.json');
}

function getStagedMediaFilePath(): string {
  if (isTestRuntime()) {
    return path.join(os.tmpdir(), 'amazon-duaa-smart-assistant-staged-test.json');
  }
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'smart-assistant-staged.json');
}

export function resolveLocalBulkUploadPath(imageUrl: string): string | null {
  if (!imageUrl || !imageUrl.startsWith('/uploads/bulk-import/')) {
    return null;
  }
  const resolved = path.resolve(process.cwd(), imageUrl.replace(/^\//, ''));
  const uploadsRoot = getBulkUploadsDir();
  if (!resolved.startsWith(uploadsRoot)) {
    return null;
  }
  return resolved;
}

export async function computeImageSignatures(
  buffer: Buffer
): Promise<{ sha256: string; dhash: string }> {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  try {
    const { data } = await sharp(buffer)
      .rotate()
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let bits = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = data[y * 9 + x] ?? 0;
        const right = data[y * 9 + x + 1] ?? 0;
        bits += left < right ? '1' : '0';
      }
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return { sha256, dhash: hex };
  } catch {
    return { sha256, dhash: sha256.slice(0, 16) };
  }
}

export function dhashHammingDistance(hexA: string, hexB: string): number {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 64;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    if (Number.isNaN(xor)) return 64;
    dist += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
  }
  return dist;
}

export async function ingestAndOptimizeSmartImage(
  rawBuffer: Buffer,
  originalFilename: string
): Promise<{
  imageUrl: string;
  optimizedBuffer: Buffer;
  stats: BulkImportImageStats;
  imageHash: string;
  dhash: string;
}> {
  const { sha256: rawHash, dhash } = await computeImageSignatures(rawBuffer);
  const { imageUrl, optimizedBuffer, stats } = await optimizeAndSaveBulkImage(
    rawBuffer,
    originalFilename
  );
  return {
    imageUrl,
    optimizedBuffer,
    stats,
    imageHash: rawHash,
    dhash,
  };
}

export async function cropSmartSubImage(
  sourceImageUrl: string,
  box2d: [number, number, number, number],
  slugHint: string
): Promise<{
  imageUrl: string;
  stats: BulkImportImageStats;
  imageHash: string;
  dhash: string;
} | null> {
  const sourcePath = resolveLocalBulkUploadPath(sourceImageUrl);
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;

  const rawBuf = fs.readFileSync(sourcePath);
  const meta = await sharp(rawBuf).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (imgW < 60 || imgH < 60) return null;

  const [ymin, xmin, ymax, xmax] = box2d.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)));
  const left = Math.max(0, Math.floor((xmin / 1000) * imgW));
  const top = Math.max(0, Math.floor((ymin / 1000) * imgH));
  const width = Math.min(imgW - left, Math.max(40, Math.ceil(((xmax - xmin) / 1000) * imgW)));
  const height = Math.min(imgH - top, Math.max(40, Math.ceil(((ymax - ymin) / 1000) * imgH)));

  if (width < 40 || height < 40) return null;

  // If bounding box covers almost the entire image (>92% area), no need to create duplicate crop
  const areaRatio = (width * height) / (imgW * imgH);
  if (areaRatio > 0.92) return null;

  const croppedBuf = await sharp(rawBuf)
    .extract({ left, top, width, height })
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();

  const { imageUrl, stats, imageHash, dhash } = await ingestAndOptimizeSmartImage(
    croppedBuf,
    `crop-${slugHint || 'item'}.jpg`
  );
  return { imageUrl, stats, imageHash, dhash };
}

export async function enhanceStoredSmartImage(
  sourceImageUrl: string
): Promise<{
  imageUrl: string;
  stats: BulkImportImageStats;
  imageHash: string;
  dhash: string;
}> {
  const sourcePath = resolveLocalBulkUploadPath(sourceImageUrl);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('تعذر العثور على ملف الصورة المطلوب تحسينه.');
  }
  const rawBuf = fs.readFileSync(sourcePath);
  const originalBytes = rawBuf.length;

  const { data: enhancedBuffer, info } = await sharp(rawBuf)
    .rotate()
    .normalize()
    .modulate({ brightness: 1.04, saturation: 1.08 })
    .sharpen({ sigma: 1.15 })
    .resize({
      width: 1200,
      height: 1200,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const uploadsDir = getBulkUploadsDir();
  const baseSlug = path
    .basename(sourcePath, path.extname(sourcePath))
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .slice(0, 36);
  const filename = `enhanced-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${baseSlug}.jpg`;
  const targetPath = path.join(uploadsDir, filename);
  fs.writeFileSync(targetPath, enhancedBuffer);

  const { sha256: imageHash, dhash } = await computeImageSignatures(enhancedBuffer);
  const optimizedBytes = enhancedBuffer.length;
  const savedPercent =
    originalBytes > 0
      ? Math.max(0, Math.round(((originalBytes - optimizedBytes) / originalBytes) * 100))
      : 0;

  return {
    imageUrl: `/uploads/bulk-import/${filename}`,
    stats: {
      original_bytes: originalBytes,
      optimized_bytes: optimizedBytes,
      width: info.width || 0,
      height: info.height || 0,
      format: 'jpeg',
      saved_percent: savedPercent,
    },
    imageHash,
    dhash,
  };
}

// ============================================================================
// Staged Media Persistence (Uploaded Images & Extracted ZIP Entries)
// ============================================================================
const memoryStagedMedia = new Map<string, SmartAssistantStagedMedia>();
let stagedLoaded = false;

function loadStagedMediaFromDisk(): void {
  if (stagedLoaded) return;
  stagedLoaded = true;
  try {
    const filePath = getStagedMediaFilePath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item.id === 'string') {
          memoryStagedMedia.set(item.id, item);
        }
      }
    }
  } catch (err: any) {
    console.warn('[SmartAssistant] Failed to load staged media:', err?.message || err);
  }
}

function saveStagedMediaToDisk(): void {
  try {
    const filePath = getStagedMediaFilePath();
    fs.writeFileSync(
      filePath,
      JSON.stringify(Array.from(memoryStagedMedia.values()), null, 2),
      'utf8'
    );
  } catch (err: any) {
    console.warn('[SmartAssistant] Failed to save staged media:', err?.message || err);
  }
}

export function addStagedMediaItem(
  input: Omit<SmartAssistantStagedMedia, 'id' | 'analyzed' | 'created_at'>
): SmartAssistantStagedMedia {
  loadStagedMediaFromDisk();
  const item: SmartAssistantStagedMedia = {
    ...input,
    id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    analyzed: false,
    created_at: new Date().toISOString(),
  };
  memoryStagedMedia.set(item.id, item);
  saveStagedMediaToDisk();
  return item;
}

export function listStagedMedia(onlyUnanalyzed = false): SmartAssistantStagedMedia[] {
  loadStagedMediaFromDisk();
  let items = Array.from(memoryStagedMedia.values());
  if (onlyUnanalyzed) {
    items = items.filter((m) => !m.analyzed);
  }
  return items.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export function markStagedMediaAnalyzed(mediaIds: string[]): void {
  loadStagedMediaFromDisk();
  for (const id of mediaIds) {
    const existing = memoryStagedMedia.get(id);
    if (existing) {
      memoryStagedMedia.set(id, { ...existing, analyzed: true });
    }
  }
  saveStagedMediaToDisk();
}

export function removeStagedMediaItem(mediaId: string): boolean {
  loadStagedMediaFromDisk();
  const deleted = memoryStagedMedia.delete(mediaId);
  if (deleted) saveStagedMediaToDisk();
  return deleted;
}

// ============================================================================
// Smart Assistant Drafts Persistence (Isolated from legacy bulk-import drafts)
// ============================================================================
const memorySmartDrafts = new Map<string, SmartAssistantDraft>();
const memoryDeletedSmartDraftIds = new Set<string>();
let draftsLoaded = false;

function loadDraftsFromDisk(): void {
  if (draftsLoaded) return;
  draftsLoaded = true;
  try {
    const filePath = getDraftsFilePath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item.id === 'string' && !memoryDeletedSmartDraftIds.has(item.id)) {
          memorySmartDrafts.set(item.id, item);
        }
      }
    }
  } catch (err: any) {
    console.warn('[SmartAssistant] Failed to load drafts from disk:', err?.message || err);
  }
}

function saveDraftsToDisk(): void {
  try {
    const filePath = getDraftsFilePath();
    fs.writeFileSync(
      filePath,
      JSON.stringify(Array.from(memorySmartDrafts.values()), null, 2),
      'utf8'
    );
  } catch (err: any) {
    console.warn('[SmartAssistant] Failed to save drafts to disk:', err?.message || err);
  }
}

function normalizeSmartDraftRecord(
  id: string,
  raw: Record<string, any>
): SmartAssistantDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.draft_kind && raw.draft_kind !== 'smart_assistant') return null;
  const title = String(raw.title_ar || '').trim();
  const gallery = Array.isArray(raw.gallery_images)
    ? raw.gallery_images.map(String).filter((u) => u && !u.startsWith('data:') && !u.startsWith('blob:'))
    : [];
  const primaryImage = String(raw.image_url || gallery[0] || '').trim();
  if (!title || !primaryImage) return null;
  if (primaryImage.toLowerCase().startsWith('data:') || primaryImage.toLowerCase().includes(';base64,')) {
    return null;
  }

  const finalGallery = gallery.length > 0 ? Array.from(new Set([primaryImage, ...gallery])) : [primaryImage];
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

  const sourceType: SmartAssistantSourceType =
    raw.source_type === 'zip_archive' || raw.source_type === 'cropped_from_batch'
      ? raw.source_type
      : 'multi_image';

  return {
    id,
    batch_id: String(raw.batch_id || 'smart-batch'),
    source_filename: String(raw.source_filename || 'product.jpg'),
    source_type: sourceType,
    title_ar: title.slice(0, 300),
    description_ar: String(raw.description_ar || '').slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    product_type: String(raw.product_type || 'مستحضر عناية وتجميل').slice(0, 120),
    brand: String(raw.brand || 'غير محدد').slice(0, 150),
    size_or_volume: String(raw.size_or_volume || 'قياسي').slice(0, 100),
    visual_details: String(raw.visual_details || '').slice(0, 1000),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 12) : [],
    image_url: finalGallery[0],
    gallery_images: finalGallery,
    image_hashes: Array.isArray(raw.image_hashes) ? raw.image_hashes.map(String).filter(Boolean) : [],
    dhashes: Array.isArray(raw.dhashes) ? raw.dhashes.map(String).filter(Boolean) : [],
    image_optimization: stats,
    enhanced: Boolean(raw.enhanced),
    duplicate_group_id: raw.duplicate_group_id ? String(raw.duplicate_group_id) : null,
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

async function persistSmartDraftToFirestore(draft: SmartAssistantDraft): Promise<boolean> {
  assertNoBase64Image(draft.image_url, 'SmartAssistantDraft');
  for (const img of draft.gallery_images) {
    assertNoBase64Image(img, 'SmartAssistantDraft.gallery');
  }

  if (isTestRuntime()) return true;

  const payload: Record<string, any> = {
    ...draft,
    draft_kind: 'smart_assistant',
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
    console.warn(`[SmartAssistant] Firestore sync notice for ${draft.id}:`, err?.message || err);
    return false;
  }
}

export async function createSmartDraft(input: {
  batch_id: string;
  source_filename: string;
  source_type: SmartAssistantSourceType;
  title_ar: string;
  description_ar: string;
  category_id?: string;
  category_name?: string;
  product_type?: string;
  brand?: string;
  size_or_volume?: string;
  visual_details?: string;
  tags?: string[];
  image_url: string;
  gallery_images?: string[];
  image_hashes?: string[];
  dhashes?: string[];
  image_optimization: BulkImportImageStats;
  created_by?: string;
}): Promise<SmartAssistantDraft> {
  loadDraftsFromDisk();
  const gallery = Array.from(
    new Set([input.image_url, ...(input.gallery_images || [])].filter(Boolean))
  );
  for (const img of gallery) {
    assertNoBase64Image(img, 'createSmartDraft');
  }

  const title = String(input.title_ar || '').trim();
  if (!title) {
    throw new Error('اسم المنتج العربي مطلوب لحفظ المسودة.');
  }

  const cat = matchCategory(input.category_id || input.category_name);
  const now = new Date().toISOString();
  const id = `smart-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // STRICT RULE: Price MUST always start completely empty (null)
  const draft: SmartAssistantDraft = {
    id,
    batch_id: input.batch_id,
    source_filename: String(input.source_filename || 'product.jpg').slice(0, 200),
    source_type: input.source_type,
    title_ar: title.slice(0, 300),
    description_ar: String(
      input.description_ar || 'منتج مميز مجهز بالذكاء الاصطناعي - بانتظار المراجعة وتحديد السعر.'
    ).slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    product_type: String(input.product_type || 'مستحضر عناية وتجميل').slice(0, 120),
    brand: String(input.brand || 'غير محدد').slice(0, 150),
    size_or_volume: String(input.size_or_volume || 'قياسي').slice(0, 100),
    visual_details: String(input.visual_details || '').slice(0, 1000),
    tags: Array.isArray(input.tags)
      ? input.tags.map(String).filter(Boolean).slice(0, 12)
      : ['المساعد_الذكي', cat.name_ar.replace(/\s+/g, '_')],
    image_url: gallery[0],
    gallery_images: gallery,
    image_hashes: Array.isArray(input.image_hashes) ? input.image_hashes : [],
    dhashes: Array.isArray(input.dhashes) ? input.dhashes : [],
    image_optimization: input.image_optimization,
    enhanced: false,
    duplicate_group_id: null,
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

  memoryDeletedSmartDraftIds.delete(draft.id);
  memorySmartDrafts.set(draft.id, draft);
  saveDraftsToDisk();
  await persistSmartDraftToFirestore(draft);
  return draft;
}

export async function listSmartDrafts(statusFilter?: string): Promise<SmartAssistantDraft[]> {
  loadDraftsFromDisk();
  const byId = new Map<string, SmartAssistantDraft>();

  if (!isTestRuntime()) {
    try {
      const snap = hasAdminServiceAccount
        ? await withFirestoreTimeout(adminDb.collection(FIRESTORE_DRAFTS_COLLECTION).get(), 5000)
        : await withFirestoreTimeout(getDocs(collection(clientDb, FIRESTORE_DRAFTS_COLLECTION)), 5000);
      snap.forEach((docSnap: any) => {
        if (!memoryDeletedSmartDraftIds.has(docSnap.id) && docSnap.id.startsWith('smart-draft-')) {
          const normalized = normalizeSmartDraftRecord(docSnap.id, docSnap.data());
          if (normalized) byId.set(normalized.id, normalized);
        }
      });
    } catch (err: any) {
      console.warn('[SmartAssistant] Firestore list fallback to persisted local store:', err?.message || err);
    }
  }

  for (const [id, d] of memorySmartDrafts.entries()) {
    if (!memoryDeletedSmartDraftIds.has(id)) {
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

export async function getSmartDraftById(draftId: string): Promise<SmartAssistantDraft | null> {
  loadDraftsFromDisk();
  if (!draftId || memoryDeletedSmartDraftIds.has(draftId)) return null;
  const inMem = memorySmartDrafts.get(draftId);
  if (inMem) return inMem;

  if (!isTestRuntime()) {
    try {
      const snap = hasAdminServiceAccount
        ? await withFirestoreTimeout(adminDb.collection(FIRESTORE_DRAFTS_COLLECTION).doc(draftId).get(), 4000)
        : await withFirestoreTimeout(getDoc(doc(clientDb, FIRESTORE_DRAFTS_COLLECTION, draftId)), 4000);
      const exists = typeof snap.exists === 'function' ? snap.exists() : Boolean(snap.exists);
      if (exists) {
        const normalized = normalizeSmartDraftRecord(snap.id, snap.data() || {});
        if (normalized) {
          memorySmartDrafts.set(normalized.id, normalized);
          return normalized;
        }
      }
    } catch {
      // Ignore transient Firestore error
    }
  }
  return null;
}

export async function updateSmartDraft(
  draftId: string,
  updates: Partial<{
    title_ar: string;
    description_ar: string;
    category_id: string;
    category_name: string;
    product_type: string;
    brand: string;
    size_or_volume: string;
    visual_details: string;
    tags: string[];
    image_url: string;
    gallery_images: string[];
    image_hashes: string[];
    dhashes: string[];
    image_optimization: BulkImportImageStats;
    enhanced: boolean;
    duplicate_group_id: string | null;
    stock_quantity: number;
    original_price: number | null;
    discount_price: number | null;
  }>,
  options: { allowPriceUpdate?: boolean } = { allowPriceUpdate: true }
): Promise<SmartAssistantDraft> {
  const existing = await getSmartDraftById(draftId);
  if (!existing) {
    throw new Error('المسودة المطلوبة غير موجودة.');
  }

  const cat =
    updates.category_id || updates.category_name
      ? matchCategory(updates.category_id || updates.category_name)
      : { id: existing.category_id, name_ar: existing.category_name };

  let nextPrice = existing.original_price;
  let nextDiscount = existing.discount_price;

  // Never allow AI actions (allowPriceUpdate: false) to set or alter pricing
  if (options.allowPriceUpdate !== false) {
    if (updates.original_price !== undefined) {
      if (updates.original_price === null || updates.original_price === ('' as any)) {
        nextPrice = null;
      } else {
        const parsed = Number(updates.original_price);
        nextPrice = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
      }
    }

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
  }

  let nextGallery = existing.gallery_images;
  if (Array.isArray(updates.gallery_images) && updates.gallery_images.length > 0) {
    const clean = Array.from(new Set(updates.gallery_images.map(String).filter(Boolean)));
    for (const img of clean) {
      assertNoBase64Image(img, 'updateSmartDraft.gallery_images');
    }
    nextGallery = clean;
  }

  let nextPrimaryImage = nextGallery[0] || existing.image_url;
  if (updates.image_url !== undefined && updates.image_url.trim()) {
    assertNoBase64Image(updates.image_url, 'updateSmartDraft.image_url');
    nextPrimaryImage = updates.image_url.trim();
    nextGallery = Array.from(new Set([nextPrimaryImage, ...nextGallery]));
  }

  const nextStock =
    updates.stock_quantity !== undefined
      ? Math.max(1, Math.floor(Number(updates.stock_quantity) || 10))
      : existing.stock_quantity;

  const updated: SmartAssistantDraft = {
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
    product_type:
      updates.product_type !== undefined
        ? String(updates.product_type).slice(0, 120)
        : existing.product_type,
    brand: updates.brand !== undefined ? String(updates.brand).slice(0, 150) : existing.brand,
    size_or_volume:
      updates.size_or_volume !== undefined
        ? String(updates.size_or_volume).slice(0, 100)
        : existing.size_or_volume,
    visual_details:
      updates.visual_details !== undefined
        ? String(updates.visual_details).slice(0, 1000)
        : existing.visual_details,
    tags: Array.isArray(updates.tags) ? updates.tags.map(String).filter(Boolean).slice(0, 12) : existing.tags,
    image_url: nextPrimaryImage,
    gallery_images: nextGallery,
    image_hashes: Array.isArray(updates.image_hashes) ? updates.image_hashes : existing.image_hashes,
    dhashes: Array.isArray(updates.dhashes) ? updates.dhashes : existing.dhashes,
    image_optimization: updates.image_optimization || existing.image_optimization,
    enhanced: updates.enhanced !== undefined ? updates.enhanced : existing.enhanced,
    duplicate_group_id:
      updates.duplicate_group_id !== undefined ? updates.duplicate_group_id : existing.duplicate_group_id,
    stock_quantity: nextStock,
    price: nextPrice,
    original_price: nextPrice,
    discount_price: nextDiscount,
    updated_at: new Date().toISOString(),
  };

  memorySmartDrafts.set(draftId, updated);
  saveDraftsToDisk();
  await persistSmartDraftToFirestore(updated);
  return updated;
}

function isImageUrlReferencedElsewhere(imageUrl: string, excludingDraftId: string): boolean {
  for (const [id, d] of memorySmartDrafts.entries()) {
    if (id === excludingDraftId) continue;
    if (d.image_url === imageUrl || d.gallery_images.includes(imageUrl)) {
      return true;
    }
  }
  return false;
}

export async function deleteSmartDraft(draftId: string, preserveFiles = false): Promise<boolean> {
  loadDraftsFromDisk();
  if (!draftId) return false;
  const existing = memorySmartDrafts.get(draftId);
  memoryDeletedSmartDraftIds.add(draftId);
  const deletedFromMem = memorySmartDrafts.delete(draftId);
  saveDraftsToDisk();

  if (!preserveFiles && existing && !existing.published_product_id) {
    const urls = Array.from(new Set([existing.image_url, ...existing.gallery_images]));
    for (const url of urls) {
      if (!isImageUrlReferencedElsewhere(url, draftId)) {
        const localPath = resolveLocalBulkUploadPath(url);
        if (localPath && fs.existsSync(localPath)) {
          try {
            fs.unlinkSync(localPath);
          } catch {
            // Ignore cleanup failure
          }
        }
      }
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

export async function mergeSmartDrafts(draftIds: string[]): Promise<SmartAssistantDraft | null> {
  if (!Array.isArray(draftIds) || draftIds.length < 2) return null;
  const loaded: SmartAssistantDraft[] = [];
  for (const id of draftIds) {
    const d = await getSmartDraftById(id);
    if (d && d.status === 'pending_review') loaded.push(d);
  }
  if (loaded.length < 2) return null;

  const primary = loaded[0];
  const mergedGallery = Array.from(
    new Set(loaded.flatMap((d) => [d.image_url, ...d.gallery_images]).filter(Boolean))
  );
  const mergedHashes = Array.from(new Set(loaded.flatMap((d) => d.image_hashes).filter(Boolean)));
  const mergedDhashes = Array.from(new Set(loaded.flatMap((d) => d.dhashes).filter(Boolean)));
  const mergedTags = Array.from(new Set(loaded.flatMap((d) => d.tags).filter(Boolean))).slice(0, 12);

  // Pick longest meaningful description
  const bestDesc = loaded
    .map((d) => d.description_ar)
    .sort((a, b) => b.length - a.length)[0];

  const updatedPrimary = await updateSmartDraft(
    primary.id,
    {
      description_ar: bestDesc,
      gallery_images: mergedGallery,
      image_url: mergedGallery[0],
      image_hashes: mergedHashes,
      dhashes: mergedDhashes,
      tags: mergedTags,
      duplicate_group_id: null,
    },
    { allowPriceUpdate: false }
  );

  for (const secondary of loaded.slice(1)) {
    await deleteSmartDraft(secondary.id, true);
  }

  return updatedPrimary;
}

export async function detectDuplicatesAcrossDrafts(
  targetIds?: string[]
): Promise<{
  groups: SmartAssistantDuplicateGroup[];
  drafts: SmartAssistantDraft[];
}> {
  const all = await listSmartDrafts('pending_review');
  const pool = targetIds?.length ? all.filter((d) => targetIds.includes(d.id)) : all;

  // Reset previous duplicate tags on inspected pool first
  for (const d of pool) {
    if (d.duplicate_group_id) {
      await updateSmartDraft(d.id, { duplicate_group_id: null }, { allowPriceUpdate: false });
    }
  }

  const visited = new Set<string>();
  const groups: SmartAssistantDuplicateGroup[] = [];

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (visited.has(a.id)) continue;

    const cluster = [a];
    let reason = '';

    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (visited.has(b.id)) continue;

      const exactHashMatch = a.image_hashes.some((h) => b.image_hashes.includes(h));
      let dhashMatch = false;
      if (!exactHashMatch) {
        const isDegenerateHash = (h: string) => !h || /^0+$/.test(h) || /^f+$/i.test(h);
        for (const da of a.dhashes) {
          if (isDegenerateHash(da)) continue;
          for (const db of b.dhashes) {
            if (isDegenerateHash(db)) continue;
            if (dhashHammingDistance(da, db) <= 5) {
              dhashMatch = true;
              break;
            }
          }
          if (dhashMatch) break;
        }
      }

      if (exactHashMatch || dhashMatch) {
        cluster.push(b);
        reason = exactHashMatch
          ? 'تطابق تام في بصمة الصورة (SHA-256)'
          : 'تشابه بصري مرتفع جداً بين الصور';
      }
    }

    if (cluster.length > 1) {
      // Keep priced or oldest original draft first so newer duplicate uploads are merged into it
      cluster.sort((x, y) => {
        const xPriced = x.original_price && x.original_price > 0 ? 1 : 0;
        const yPriced = y.original_price && y.original_price > 0 ? 1 : 0;
        if (xPriced !== yPriced) return yPriced - xPriced;
        return new Date(x.created_at).getTime() - new Date(y.created_at).getTime();
      });
      const groupId = `dup-${Date.now().toString(36)}-${groups.length + 1}`;
      for (const member of cluster) {
        visited.add(member.id);
        await updateSmartDraft(member.id, { duplicate_group_id: groupId }, { allowPriceUpdate: false });
      }
      groups.push({
        group_id: groupId,
        reason,
        draft_ids: cluster.map((m) => m.id),
      });
    }
  }

  const refreshed = await listSmartDrafts();
  return { groups, drafts: refreshed };
}

export interface SmartApproveItemInput {
  id: string;
  original_price?: number | null;
  discount_price?: number | null;
  stock_quantity?: number;
  title_ar?: string;
  description_ar?: string;
  category_id?: string;
  brand?: string;
  size_or_volume?: string;
  gallery_images?: string[];
}

function normalizeOptionalPublishPrice(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error('إذا تم إدخال سعر، يجب أن يكون رقماً صحيحاً غير سالب.');
  }
  return Math.round(num * 100) / 100;
}

export async function publishSmartDraft(
  draftId: string,
  adminUsername: string,
  input: Omit<SmartApproveItemInput, 'id'> & { approve?: boolean }
): Promise<{ draft: SmartAssistantDraft; product: Product }> {
  if (input.approve !== true) {
    throw new Error('لا يُسمح بالنشر إلا بعد موافقة إدارية صريحة (approve: true).');
  }

  const existing = await getSmartDraftById(draftId);
  if (!existing) {
    throw new Error('المسودة المطلوبة غير موجودة.');
  }

  const effectivePriceRaw =
    input.original_price !== undefined ? input.original_price : existing.original_price;
  const validPrice = normalizeOptionalPublishPrice(effectivePriceRaw);

  const rawDisc =
    input.discount_price !== undefined ? input.discount_price : existing.discount_price;
  const validDiscount =
    validPrice > 0 &&
    rawDisc !== null &&
    rawDisc !== undefined &&
    Number.isFinite(Number(rawDisc)) &&
    Number(rawDisc) > 0 &&
    Number(rawDisc) < validPrice
      ? Math.round(Number(rawDisc) * 100) / 100
      : null;

  const gallery = Array.isArray(input.gallery_images) && input.gallery_images.length > 0
    ? input.gallery_images
    : existing.gallery_images;
  for (const img of gallery) {
    assertNoBase64Image(img, 'publishSmartDraft');
  }

  const updatedDraft = await updateSmartDraft(
    draftId,
    {
      title_ar: input.title_ar,
      description_ar: input.description_ar,
      category_id: input.category_id,
      brand: input.brand,
      size_or_volume: input.size_or_volume,
      stock_quantity: input.stock_quantity,
      gallery_images: gallery,
      image_url: gallery[0],
      original_price: validPrice > 0 ? validPrice : null,
      discount_price: validDiscount,
    },
    { allowPriceUpdate: true }
  );

  const now = new Date().toISOString();
  const productId =
    updatedDraft.published_product_id ||
    `prod-smart-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

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
    gallery_images: updatedDraft.gallery_images,
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
    ...product,
    createdAt: now,
    updatedAt: now,
  });
  invalidateFirestoreCatalogCache();

  const publishedDraft: SmartAssistantDraft = {
    ...updatedDraft,
    price: validPrice > 0 ? validPrice : null,
    original_price: validPrice > 0 ? validPrice : null,
    discount_price: validDiscount,
    status: 'approved_published',
    published_product_id: product.id,
    approved_by: adminUsername || 'admin',
    approved_at: now,
    updated_at: now,
  };

  memorySmartDrafts.set(draftId, publishedDraft);
  saveDraftsToDisk();
  await persistSmartDraftToFirestore(publishedDraft);

  return { draft: publishedDraft, product };
}

export async function bulkPublishSmartDrafts(
  items: SmartApproveItemInput[],
  adminUsername: string,
  approve: boolean
): Promise<{ drafts: SmartAssistantDraft[]; products: Product[] }> {
  if (approve !== true) {
    throw new Error('لا يُسمح بالنشر الجماعي إلا بعد موافقة إدارية صريحة (approve: true).');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('يرجى تحديد منتج واحد على الأقل للاعتماد والنشر.');
  }

  const invalidItems: Array<{ id: string; title_ar: string; reason: string }> = [];

  for (const item of items) {
    const existing = await getSmartDraftById(item.id);
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
      normalizeOptionalPublishPrice(effectivePrice);
    } catch (priceErr: any) {
      invalidItems.push({
        id: item.id,
        title_ar: item.title_ar || existing.title_ar,
        reason: priceErr?.message || 'قيمة السعر غير صالحة.',
      });
    }
  }

  if (invalidItems.length > 0) {
    throw new BulkValidationError(
      `تعذر النشر الجماعي: يوجد (${invalidItems.length}) منتج بقيمة سعر غير صالحة.`,
      invalidItems
    );
  }

  const publishedDrafts: SmartAssistantDraft[] = [];
  const publishedProducts: Product[] = [];

  for (const item of items) {
    const result = await publishSmartDraft(item.id, adminUsername, {
      ...item,
      approve: true,
    });
    publishedDrafts.push(result.draft);
    publishedProducts.push(result.product);
  }

  return { drafts: publishedDrafts, products: publishedProducts };
}
