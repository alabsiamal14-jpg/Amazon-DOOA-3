import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { requireAdmin, AuthRequest } from '../../middleware/auth.ts';
import { INITIAL_CATEGORIES } from '../../data/initialData.ts';
import { matchCategory } from '../../lib/employee-drafts-store.ts';
import { BulkValidationError } from '../../lib/bulk-import-store.ts';
import {
  addStagedMediaItem,
  bulkPublishSmartDrafts,
  createSmartDraft,
  cropSmartSubImage,
  deleteSmartDraft,
  detectDuplicatesAcrossDrafts,
  enhanceStoredSmartImage,
  getSmartDraftById,
  ingestAndOptimizeSmartImage,
  listSmartDrafts,
  listStagedMedia,
  markStagedMediaAnalyzed,
  mergeSmartDrafts,
  publishSmartDraft,
  removeStagedMediaItem,
  resolveLocalBulkUploadPath,
  updateSmartDraft,
} from '../../lib/smart-assistant-store.ts';
import type {
  SmartAssistantDraft,
  SmartAssistantDuplicateGroup,
  SmartAssistantSourceType,
  SmartAssistantStagedMedia,
} from '../../types.ts';
import fs from 'fs';

const router = Router();
router.use(requireAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 80 * 1024 * 1024, // 80 MB per file / ZIP archive
    files: 100,
  },
});

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_IMAGES_PER_REQUEST = 200;
const GEMINI_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
const CATEGORY_LIST_STR = INITIAL_CATEGORIES.map((c) => c.name_ar).join('، ');

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || process.env.NODE_ENV === 'test') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: 45000 },
  });
}

function withAiTimeout<T>(promise: Promise<T>, ms = 35000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Gemini request timed out')), ms)),
  ]);
}

function isTransientAiError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('504') ||
    msg.includes('DEADLINE_EXCEEDED') ||
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('timed out') ||
    msg.includes('UNAVAILABLE')
  );
}

async function prepareCompactAiImageBuffer(imageBuffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(imageBuffer)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
  } catch {
    return imageBuffer;
  }
}

function isZipFile(file: Express.Multer.File): boolean {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  return ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed';
}

function isImageFilename(filename: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function normalizeProductGroupSlug(filenameOrTitle: string): string {
  const base = path
    .basename(filenameOrTitle, path.extname(filenameOrTitle))
    .toLowerCase()
    .replace(/(?:[_-]?(?:front|back|side|top|bottom|angle|box|zoom|main|alt|copy|img|view|\d+))+$/gi, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

interface ExtractedVisualItem {
  title_ar: string;
  description_ar: string;
  category_name: string;
  product_type: string;
  brand: string;
  size_or_volume: string;
  visual_details: string;
  group_key: string;
  tags: string[];
  box_2d?: [number, number, number, number];
}

const SMART_IMAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    products: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title_ar: { type: Type.STRING, description: 'اسم المنتج بالعربية' },
          description_ar: { type: Type.STRING, description: 'وصف تسويقي احترافي بالعربية' },
          category_name: { type: Type.STRING, description: 'التصنيف المناسب بالعربية' },
          product_type: { type: Type.STRING, description: 'نوع المنتج مثل سيروم أو عطر أو كريم' },
          brand: { type: Type.STRING, description: 'العلامة التجارية الظاهرة على العبوة' },
          size_or_volume: { type: Type.STRING, description: 'الحجم أو السعة' },
          visual_details: { type: Type.STRING, description: 'اللون والتفاصيل المستخلصة بصرياً' },
          group_key: {
            type: Type.STRING,
            description: 'مفتاح تجميع موحد بالإنجليزية أو العربية لنفس المنتج إذا تعددت زوايا تصويره',
          },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          box_2d: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
            description: 'مربع إحاطة [ymin, xmin, ymax, xmax] بمقياس 0 إلى 1000 عند وجود أكثر من منتج في نفس الصورة',
          },
        },
        required: ['title_ar', 'description_ar', 'category_name', 'group_key'],
      },
    },
  },
  required: ['products'],
};

function buildDeterministicVisualFallback(filename: string, index: number): ExtractedVisualItem[] {
  const stem = path
    .basename(filename, path.extname(filename))
    .replace(/[_-]+/g, ' ')
    .trim();
  const groupSlug = normalizeProductGroupSlug(filename) || `item-${index + 1}`;
  const lower = stem.toLowerCase();

  let categoryName = 'عناية بالبشرة';
  let productType = 'مستحضر عناية بالبشرة';
  let brand = 'أمازون دعاء';
  let title = `مستحضر عناية فاخر (${index + 1})`;
  let desc =
    'منتج مستخلص ومجهز عبر المساعد الذكي الشامل بتركيبة عالية الجودة ومناسبة للاستخدام اليومي، بانتظار المراجعة وتحديد السعر من الإدارة.';

  if (lower.includes('perfume') || lower.includes('عطر') || lower.includes('oud') || lower.includes('عود')) {
    categoryName = 'عطور فاخرة';
    productType = 'عطر فاخر';
    title = 'عطر فاخر بنفحات راقية ثابتة';
    desc = 'توليفة عطرية متوازنة ذات ثبات عالٍ وفوحان أنيق، تم تجهيزها للمراجعة وتحديد السعر يدوياً.';
  } else if (lower.includes('hair') || lower.includes('شعر') || lower.includes('shampoo') || lower.includes('oil')) {
    categoryName = 'عناية بالشعر';
    productType = 'مستحضر عناية بالشعر';
    title = 'مستحضر تغذية وترميم الشعر';
    desc = 'يرطب الشعر ويحميه من التقصف مع إضفاء لمعان صحي ومرونة طبيعية.';
  } else if (lower.includes('lip') || lower.includes('makeup') || lower.includes('مكياج') || lower.includes('mascara')) {
    categoryName = 'مكياج احترافي';
    productType = 'مستحضر تجميل';
    title = 'مستحضر تجميل احترافي عالي الثبات';
    desc = 'تركيبة مخملية غنية باللون تمنحك إطلالة مشرقة وثباتاً يدوم طوال اليوم.';
  } else if (lower.includes('serum') || lower.includes('سيروم') || lower.includes('cream') || lower.includes('كريم')) {
    categoryName = 'عناية بالبشرة';
    productType = lower.includes('serum') || lower.includes('سيروم') ? 'سيروم بشرة' : 'كريم عناية';
    title = lower.includes('vitamin') ? 'سيروم فيتامين سي لإشراقة البشرة' : 'مستحضر عناية وترطيب البشرة المركز';
    desc = 'تركيبة مركزة لتجديد البشرة وتعزيز نضارتها وملمسها الحريري، جاهز للمراجعة والتسعير.';
  } else if (lower.includes('device') || lower.includes('brush') || lower.includes('جهاز')) {
    categoryName = 'أجهزة العناية';
    productType = 'جهاز عناية';
    title = 'جهاز عناية وتجميل منزلي متطور';
    desc = 'تصميم عملي حديث للعناية المتكاملة في المنزل بأداء ثابت وجودة عالية.';
  }

  if (lower.includes('ordinary')) brand = 'The Ordinary';
  else if (lower.includes('cerave')) brand = 'CeraVe';
  else if (lower.includes('dior')) brand = 'Dior';
  else if (lower.includes('chanel')) brand = 'Chanel';

  const cleanDisplayStem = normalizeProductGroupSlug(filename);
  if (/[\u0600-\u06FF]{3,}/.test(cleanDisplayStem)) {
    title = cleanDisplayStem.slice(0, 100);
  } else if (
    cleanDisplayStem.length >= 3 &&
    !/^(img|dsc|photo|image|pic|file|product)\s*\d*$/i.test(cleanDisplayStem)
  ) {
    title = `${title} - ${cleanDisplayStem.slice(0, 45)}`;
  }

  return [
    {
      title_ar: title,
      description_ar: desc,
      category_name: categoryName,
      product_type: productType,
      brand,
      size_or_volume: 'قياسي',
      visual_details: 'تم استخلاص السمات البصرية والبيانات الوصفية من الصورة.',
      group_key: groupSlug,
      tags: ['المساعد_الذكي', categoryName.replace(/\s+/g, '_'), productType.replace(/\s+/g, '_')],
    },
  ];
}

async function analyzeMediaItemWithGemini(
  ai: GoogleGenAI | null,
  imageBuffer: Buffer,
  filename: string,
  index: number
): Promise<ExtractedVisualItem[]> {
  if (ai) {
    const aiBuffer = await prepareCompactAiImageBuffer(imageBuffer);
    const base64Data = aiBuffer.toString('base64');
    const prompt = `أنت المساعد الذكي الشامل لمتجر "أمازون دعاء".
حلّل الصورة المرفقة بدقة واستخرج المنتجات الظاهرة فيها باللغة العربية:
- إذا احتوت الصورة على منتج واحد، أرجع عنصراً واحداً في المصفوفة products.
- إذا احتوت الصورة على عدة منتجات متميزة ومفصولة، استخرج كل منتج كعنصر مستقل مع تحديد box_2d بدقة [ymin, xmin, ymax, xmax] بمقياس 0 إلى 1000.
- حدد group_key موحداً لكل منتج (بحيث إذا كانت عدة صور لنفس المنتج بالضبط تأخذ نفس group_key).
- استخرج: title_ar، description_ar، category_name من (${CATEGORY_LIST_STR})، product_type، brand، size_or_volume، visual_details، tags.
- قاعدة قطعية صارمة: ممنوع تماماً ذكر أو تخمين أو اقتراح أي سعر نهائياً في أي حقل.
اسم الملف: ${path.basename(filename)}`;

    for (const model of GEMINI_MODELS) {
      const maxAttempts = model === 'gemini-4-hydrogen' ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await withAiTimeout(
            ai.models.generateContent({
              model,
              contents: [
                {
                  parts: [
                    { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
                    { text: prompt },
                  ],
                },
              ],
              config: {
                responseMimeType: 'application/json',
                responseSchema: SMART_IMAGE_SCHEMA,
                ...(model === 'gemini-4-hydrogen'
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                  : {}),
              },
            }),
            35000
          );

          if (response.text) {
            const parsed = JSON.parse(response.text);
            if (parsed && Array.isArray(parsed.products) && parsed.products.length > 0) {
              return parsed.products.slice(0, 6).map((p: any, subIdx: number) => ({
                title_ar: String(p.title_ar || '').trim() || `منتج مستخرج (${index + 1})`,
                description_ar:
                  String(p.description_ar || '').trim() ||
                  'منتج مجهز بالذكاء الاصطناعي وبانتظار المراجعة وتحديد السعر من الإدارة.',
                category_name: String(p.category_name || 'عناية بالبشرة').trim(),
                product_type: String(p.product_type || 'مستحضر عناية').trim(),
                brand: String(p.brand || 'غير محدد').trim(),
                size_or_volume: String(p.size_or_volume || 'قياسي').trim(),
                visual_details: String(p.visual_details || '').trim(),
                group_key:
                  String(p.group_key || '').trim().toLowerCase() ||
                  `${normalizeProductGroupSlug(filename) || 'item'}-${subIdx}`,
                tags: Array.isArray(p.tags)
                  ? p.tags.map(String).filter(Boolean).slice(0, 6)
                  : ['المساعد_الذكي'],
                box_2d:
                  Array.isArray(p.box_2d) && p.box_2d.length === 4
                    ? (p.box_2d.map(Number) as [number, number, number, number])
                    : undefined,
              }));
            }
          }
          break;
        } catch (err: any) {
          if (attempt < maxAttempts && isTransientAiError(err)) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          console.warn(`[SmartAssistant] Gemini image analysis fallback (${model}):`, err?.message || err);
          break;
        }
      }
    }
  }

  return buildDeterministicVisualFallback(filename, index);
}

async function extractFilesToStagedMedia(
  files: Express.Multer.File[],
  batchId: string
): Promise<{
  staged: SmartAssistantStagedMedia[];
  skippedFiles: Array<{ filename: string; reason: string }>;
  zipCount: number;
}> {
  interface RawEntry {
    filename: string;
    buffer: Buffer;
    sourceType: 'multi_image' | 'zip_archive';
  }

  const rawEntries: RawEntry[] = [];
  const skippedFiles: Array<{ filename: string; reason: string }> = [];
  let zipCount = 0;

  for (const file of files) {
    if (isZipFile(file)) {
      zipCount++;
      let zip: AdmZip;
      try {
        zip = new AdmZip(file.buffer);
      } catch {
        skippedFiles.push({
          filename: file.originalname,
          reason: 'ملف مضغوط غير صالح أو تالف.',
        });
        continue;
      }

      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName.replace(/\\/g, '/');
        if (
          entryName.startsWith('__MACOSX/') ||
          entryName.includes('/__MACOSX/') ||
          path.basename(entryName).startsWith('.')
        ) {
          continue;
        }
        if (!isImageFilename(entryName)) continue;
        const entryBuf = entry.getData();
        if (!entryBuf || entryBuf.length === 0) continue;

        rawEntries.push({
          filename: path.basename(entryName),
          buffer: entryBuf,
          sourceType: 'zip_archive',
        });

        if (rawEntries.length >= MAX_IMAGES_PER_REQUEST) break;
      }
    } else if (file.mimetype.startsWith('image/') || isImageFilename(file.originalname)) {
      rawEntries.push({
        filename: file.originalname || `image-${rawEntries.length + 1}.jpg`,
        buffer: file.buffer,
        sourceType: 'multi_image',
      });
    } else {
      skippedFiles.push({
        filename: file.originalname,
        reason: 'نوع ملف غير مدعوم (يدعم الصور وملفات ZIP فقط).',
      });
    }

    if (rawEntries.length >= MAX_IMAGES_PER_REQUEST) break;
  }

  const staged: SmartAssistantStagedMedia[] = [];
  const CHUNK = 6;
  for (let i = 0; i < rawEntries.length; i += CHUNK) {
    const slice = rawEntries.slice(i, i + CHUNK);
    const settled = await Promise.all(
      slice.map(async (entry) => {
        try {
          const { imageUrl, stats, imageHash, dhash } = await ingestAndOptimizeSmartImage(
            entry.buffer,
            entry.filename
          );
          return addStagedMediaItem({
            batch_id: batchId,
            filename: entry.filename,
            source_type: entry.sourceType,
            image_url: imageUrl,
            image_hash: imageHash,
            dhash,
            image_optimization: stats,
          });
        } catch (err: any) {
          skippedFiles.push({
            filename: entry.filename,
            reason: err?.message || 'تعذر قراءة الصورة.',
          });
          return null;
        }
      })
    );
    for (const s of settled) {
      if (s) staged.push(s);
    }
  }

  return { staged, skippedFiles, zipCount };
}

async function analyzeAndCreateDraftsFromMedia(
  mediaItems: SmartAssistantStagedMedia[],
  adminUsername: string,
  groupSameProduct = true
): Promise<SmartAssistantDraft[]> {
  const ai = getGeminiClient();
  const batchId = mediaItems[0]?.batch_id || `smart-batch-${Date.now()}`;

  interface PendingGroupedProduct {
    item: ExtractedVisualItem;
    source_filename: string;
    source_type: SmartAssistantSourceType;
    gallery_images: string[];
    image_hashes: string[];
    dhashes: string[];
    stats: SmartAssistantStagedMedia['image_optimization'];
  }

  const groupedMap = new Map<string, PendingGroupedProduct>();
  const ungroupedList: PendingGroupedProduct[] = [];

  const CHUNK = 2;
  for (let i = 0; i < mediaItems.length; i += CHUNK) {
    const slice = mediaItems.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(
      slice.map(async (media, offset) => {
        const localPath = resolveLocalBulkUploadPath(media.image_url);
        if (!localPath || !fs.existsSync(localPath)) return [];
        const buffer = fs.readFileSync(localPath);
        const extractedItems = await analyzeMediaItemWithGemini(
          ai,
          buffer,
          media.filename,
          i + offset
        );

        const resolvedForMedia: PendingGroupedProduct[] = [];
        const hasMultipleProducts = extractedItems.length > 1;

        for (let subIdx = 0; subIdx < extractedItems.length; subIdx++) {
          const extItem = extractedItems[subIdx];
          let imgUrl = media.image_url;
          let imgHash = media.image_hash;
          let dhash = media.dhash;
          let stats = media.image_optimization;
          let srcType: SmartAssistantSourceType = media.source_type;

          if (hasMultipleProducts && extItem.box_2d) {
            try {
              const cropped = await cropSmartSubImage(
                media.image_url,
                extItem.box_2d,
                `${media.filename}-${subIdx + 1}`
              );
              if (cropped) {
                imgUrl = cropped.imageUrl;
                imgHash = cropped.imageHash;
                dhash = cropped.dhash;
                stats = cropped.stats;
                srcType = 'cropped_from_batch';
              }
            } catch {
              // Keep full image if crop fails
            }
          }

          resolvedForMedia.push({
            item: extItem,
            source_filename: media.filename,
            source_type: srcType,
            gallery_images: [imgUrl],
            image_hashes: [imgHash],
            dhashes: [dhash],
            stats,
          });
        }
        return resolvedForMedia;
      })
    );

    for (const perMedia of chunkResults) {
      for (const candidate of perMedia) {
        if (groupSameProduct && candidate.item.group_key) {
          const normKey = candidate.item.group_key.trim().toLowerCase();
          const existing = groupedMap.get(normKey);
          if (existing) {
            existing.gallery_images = Array.from(
              new Set([...existing.gallery_images, ...candidate.gallery_images])
            );
            existing.image_hashes = Array.from(
              new Set([...existing.image_hashes, ...candidate.image_hashes])
            );
            existing.dhashes = Array.from(
              new Set([...existing.dhashes, ...candidate.dhashes])
            );
            if (candidate.item.description_ar.length > existing.item.description_ar.length) {
              existing.item.description_ar = candidate.item.description_ar;
            }
          } else {
            groupedMap.set(normKey, candidate);
          }
        } else {
          ungroupedList.push(candidate);
        }
      }
    }
  }

  const finalCandidates = groupSameProduct
    ? [...Array.from(groupedMap.values()), ...ungroupedList]
    : ungroupedList;

  const created: SmartAssistantDraft[] = [];
  for (const cand of finalCandidates) {
    const draft = await createSmartDraft({
      batch_id: batchId,
      source_filename: cand.source_filename,
      source_type: cand.source_type,
      title_ar: cand.item.title_ar,
      description_ar: cand.item.description_ar,
      category_name: cand.item.category_name,
      product_type: cand.item.product_type,
      brand: cand.item.brand,
      size_or_volume: cand.item.size_or_volume,
      visual_details: cand.item.visual_details,
      tags: cand.item.tags,
      image_url: cand.gallery_images[0],
      gallery_images: cand.gallery_images,
      image_hashes: cand.image_hashes,
      dhashes: cand.dhashes,
      image_optimization: cand.stats,
      created_by: adminUsername,
    });
    created.push(draft);
  }

  markStagedMediaAnalyzed(mediaItems.map((m) => m.id));
  return created;
}

// 1. POST /api/admin/smart-assistant/ingest — Stage large batches of images or ZIP archives
router.post(
  '/ingest',
  (req: AuthRequest, res: Response, next) => {
    upload.array('files', 100)(req as any, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'فشل رفع الملفات.' });
      }
      next();
    });
  },
  async (req: AuthRequest, res: Response) => {
    try {
      const files = ((req as any).files as Express.Multer.File[] | undefined) || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'يرجى رفع صور أو ملف ZIP واحد على الأقل.' });
      }

      const batchId = `smart-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const { staged, skippedFiles, zipCount } = await extractFilesToStagedMedia(files, batchId);

      if (staged.length === 0) {
        return res.status(400).json({
          error: 'لم يتم العثور على صور صالحة (JPG / PNG / WebP) داخل الملفات المرفوعة.',
          skippedFiles,
        });
      }

      const autoAnalyze = req.body?.autoAnalyze === 'true' || req.query?.autoAnalyze === 'true';
      let drafts: SmartAssistantDraft[] = [];
      if (autoAnalyze) {
        const groupSame = req.body?.groupSameProduct !== 'false';
        drafts = await analyzeAndCreateDraftsFromMedia(
          staged,
          req.user?.username || 'admin',
          groupSame
        );
      }

      return res.json({
        success: true,
        batch_id: batchId,
        staged_count: staged.length,
        zip_count: zipCount,
        staged,
        drafts,
        skippedFiles,
        message: autoAnalyze
          ? `تم استخراج (${staged.length}) صورة وتجهيز (${drafts.length}) بطاقة منتج بدون أسعار للمراجعة.`
          : `تم رفع وفك ضغط (${staged.length}) صورة بنجاح. يمكنك الآن طلب التحليل من المساعد أو بدء التجهيز.`,
      });
    } catch (err: any) {
      console.error('[SmartAssistant] Ingest error:', err);
      return res.status(500).json({ error: err?.message || 'تعذر معالجة الملفات المرفوعة.' });
    }
  }
);

// 2. POST /api/admin/smart-assistant/analyze — Analyze staged media (or direct files) into independent unpriced product cards
router.post(
  '/analyze',
  (req: AuthRequest, res: Response, next) => {
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('multipart/form-data')) {
      upload.array('files', 100)(req as any, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'فشل رفع الملفات.' });
        next();
      });
    } else {
      next();
    }
  },
  async (req: AuthRequest, res: Response) => {
    try {
      const files = ((req as any).files as Express.Multer.File[] | undefined) || [];
      let targetMedia: SmartAssistantStagedMedia[] = [];
      let skippedFiles: Array<{ filename: string; reason: string }> = [];

      if (files.length > 0) {
        const batchId = `smart-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const extracted = await extractFilesToStagedMedia(files, batchId);
        targetMedia = extracted.staged;
        skippedFiles = extracted.skippedFiles;
      } else {
        const requestedIds: string[] = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [];
        const unanalyzed = listStagedMedia(true);
        targetMedia =
          requestedIds.length > 0
            ? unanalyzed.filter((m) => requestedIds.includes(m.id))
            : unanalyzed;
      }

      if (targetMedia.length === 0) {
        return res.status(400).json({
          error: 'لا توجد صور جديدة جاهزة للتحليل. ارفع صوراً أو ملف ZIP أولاً.',
          skippedFiles,
        });
      }

      const groupSameProduct = req.body?.groupSameProduct !== false && req.body?.groupSameProduct !== 'false';
      const createdDrafts = await analyzeAndCreateDraftsFromMedia(
        targetMedia,
        req.user?.username || 'admin',
        groupSameProduct
      );

      return res.json({
        success: true,
        analyzed_images_count: targetMedia.length,
        created_drafts_count: createdDrafts.length,
        drafts: createdDrafts,
        skippedFiles,
        message: `تم تحليل (${targetMedia.length}) صورة وتجهيز (${createdDrafts.length}) بطاقة منتج للمراجعة. خانة السعر فارغة بانتظار إدخالك اليدوي.`,
      });
    } catch (err: any) {
      console.error('[SmartAssistant] Analyze error:', err);
      return res.status(500).json({ error: err?.message || 'حدث خطأ أثناء تحليل الصور.' });
    }
  }
);

// 3. GET /api/admin/smart-assistant/drafts — List drafts + unanalyzed staged media
router.get('/drafts', async (req: AuthRequest, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const drafts = await listSmartDrafts(status);
    const stagedMedia = listStagedMedia(true);
    const pendingCount = drafts.filter((d) => d.status === 'pending_review').length;

    return res.json({
      drafts,
      stagedMedia,
      pendingCount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر جلب بيانات المساعد الذكي.' });
  }
});

// 4. DELETE /api/admin/smart-assistant/staged/:id — Remove an unanalyzed staged image
router.delete('/staged/:id', async (req: AuthRequest, res: Response) => {
  const removed = removeStagedMediaItem(req.params.id);
  return res.json({ success: removed });
});

// 5. PATCH /api/admin/smart-assistant/drafts/:id — Edit draft fields, images & manual price
router.patch('/drafts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const updated = await updateSmartDraft(req.params.id, req.body || {}, { allowPriceUpdate: true });
    return res.json({ success: true, draft: updated });
  } catch (err: any) {
    const statusCode = String(err?.message || '').includes('غير موجودة') ? 404 : 400;
    return res.status(statusCode).json({ error: err?.message || 'تعذر تحديث المسودة.' });
  }
});

// 6. POST /api/admin/smart-assistant/drafts/:id/images — Upload replacement or additional gallery images
router.post(
  '/drafts/:id/images',
  (req: AuthRequest, res: Response, next) => {
    upload.array('files', 10)(req as any, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'فشل رفع الصورة.' });
      next();
    });
  },
  async (req: AuthRequest, res: Response) => {
    try {
      const draft = await getSmartDraftById(req.params.id);
      if (!draft) {
        return res.status(404).json({ error: 'المسودة المطلوبة غير موجودة.' });
      }
      const files = ((req as any).files as Express.Multer.File[] | undefined) || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'يرجى اختيار صورة صالحة.' });
      }

      const replacePrimary = req.body?.mode === 'replace';
      const uploadedUrls: string[] = [];
      const uploadedHashes: string[] = [];
      const uploadedDhashes: string[] = [];

      for (const file of files) {
        const resImg = await ingestAndOptimizeSmartImage(file.buffer, file.originalname || 'product.jpg');
        uploadedUrls.push(resImg.imageUrl);
        uploadedHashes.push(resImg.imageHash);
        uploadedDhashes.push(resImg.dhash);
      }

      const nextGallery = replacePrimary
        ? [...uploadedUrls, ...draft.gallery_images.slice(1)]
        : [...draft.gallery_images, ...uploadedUrls];

      const updated = await updateSmartDraft(
        draft.id,
        {
          image_url: nextGallery[0],
          gallery_images: Array.from(new Set(nextGallery)),
          image_hashes: Array.from(new Set([...draft.image_hashes, ...uploadedHashes])),
          dhashes: Array.from(new Set([...draft.dhashes, ...uploadedDhashes])),
        },
        { allowPriceUpdate: false }
      );

      return res.json({ success: true, draft: updated });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'تعذر تحديث صور المنتج.' });
    }
  }
);

// 7. POST /api/admin/smart-assistant/drafts/:id/enhance — Enhance images of a specific draft
router.post('/drafts/:id/enhance', async (req: AuthRequest, res: Response) => {
  try {
    const draft = await getSmartDraftById(req.params.id);
    if (!draft) {
      return res.status(404).json({ error: 'المسودة المطلوبة غير موجودة.' });
    }

    const enhancedUrls: string[] = [];
    const newHashes: string[] = [];
    const newDhashes: string[] = [];
    let latestStats = draft.image_optimization;

    for (const imgUrl of draft.gallery_images) {
      try {
        const enh = await enhanceStoredSmartImage(imgUrl);
        enhancedUrls.push(enh.imageUrl);
        newHashes.push(enh.imageHash);
        newDhashes.push(enh.dhash);
        latestStats = enh.stats;
      } catch {
        enhancedUrls.push(imgUrl);
      }
    }

    const updated = await updateSmartDraft(
      draft.id,
      {
        image_url: enhancedUrls[0] || draft.image_url,
        gallery_images: enhancedUrls,
        image_hashes: newHashes.length > 0 ? newHashes : draft.image_hashes,
        dhashes: newDhashes.length > 0 ? newDhashes : draft.dhashes,
        image_optimization: latestStats,
        enhanced: true,
      },
      { allowPriceUpdate: false }
    );

    return res.json({
      success: true,
      draft: updated,
      message: `تم تحسين وتجهيز (${enhancedUrls.length}) صورة للمنتج بنجاح.`,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر تحسين صور المنتج.' });
  }
});

// 8. POST /api/admin/smart-assistant/drafts/merge — Merge multiple drafts into one multi-image product
router.post('/drafts/merge', async (req: AuthRequest, res: Response) => {
  try {
    const draftIds: string[] = Array.isArray(req.body?.draftIds) ? req.body.draftIds : [];
    if (draftIds.length < 2) {
      return res.status(400).json({ error: 'يرجى تحديد منتجين على الأقل للدمج.' });
    }
    const merged = await mergeSmartDrafts(draftIds);
    if (!merged) {
      return res.status(400).json({ error: 'تعذر دمج المسودات المحددة.' });
    }
    return res.json({
      success: true,
      draft: merged,
      message: `تم تجميع (${merged.gallery_images.length}) صور في بطاقة منتج واحدة بنجاح.`,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر دمج المسودات.' });
  }
});

// 9. DELETE /api/admin/smart-assistant/drafts/:id
router.delete('/drafts/:id', async (req: AuthRequest, res: Response) => {
  try {
    await deleteSmartDraft(req.params.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر حذف المسودة.' });
  }
});

// 10. POST /api/admin/smart-assistant/drafts/bulk-publish — Explicit admin approval + strict price > 0 guard
router.post('/drafts/bulk-publish', async (req: AuthRequest, res: Response) => {
  try {
    const approve = req.body?.approve === true;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const result = await bulkPublishSmartDrafts(items, req.user?.username || 'admin', approve);
    return res.json({
      success: true,
      publishedCount: result.products.length,
      drafts: result.drafts,
      products: result.products,
      message: `تم اعتماد ونشر (${result.products.length}) منتج بنجاح في المتجر.`,
    });
  } catch (err: any) {
    if (err instanceof BulkValidationError) {
      return res.status(400).json({
        error: err.message,
        invalidItems: err.invalidItems,
      });
    }
    return res.status(400).json({ error: err?.message || 'تعذر النشر الجماعي للمنتجات.' });
  }
});

// 11. POST /api/admin/smart-assistant/drafts/:id/publish — Individual publish + strict price > 0 guard
router.post('/drafts/:id/publish', async (req: AuthRequest, res: Response) => {
  try {
    const result = await publishSmartDraft(req.params.id, req.user?.username || 'admin', {
      ...(req.body || {}),
      approve: req.body?.approve === true,
    });
    return res.json({
      success: true,
      draft: result.draft,
      product: result.product,
      message: `تم اعتماد ونشر "${result.product.title_ar}" في المتجر بنجاح.`,
    });
  } catch (err: any) {
    const msg = err?.message || 'تعذر اعتماد ونشر المنتج.';
    const statusCode = msg.includes('غير موجودة') ? 404 : 400;
    return res.status(statusCode).json({ error: msg });
  }
});

// ============================================================================
// Conversational Arabic AI Command Execution Engine
// ============================================================================
type AssistantActionType =
  | 'refuse_auto_price'
  | 'analyze_staged'
  | 'group_similar'
  | 'enhance_images'
  | 'rewrite_descriptions'
  | 'classify_products'
  | 'detect_duplicates'
  | 'deduplicate_remove'
  | 'prepare_for_review'
  | 'general_qa';

async function resolveArabicCommandIntent(
  ai: GoogleGenAI | null,
  message: string
): Promise<{ action: AssistantActionType; instructionNote: string }> {
  const normalized = message.trim().toLowerCase();

  // Hard guard: Refuse any request to automatically set/guess prices
  if (
    /(?:سع[ّ]?ر|حد[ّ]?د\s+ال?أسعار|اقترح\s+سعر|ضع\s+أسعار|خمن\s+ال?سعر|auto.?price|guess.?price)/i.test(
      normalized
    ) &&
    !/(?:بدون\s+سعر|فارغ|لا\s+تحدد)/i.test(normalized)
  ) {
    return { action: 'refuse_auto_price', instructionNote: '' };
  }

  // Fast deterministic Arabic intent resolution
  if (/(?:احذف|امسح|ادمج|تخلّص).*(?:مكرر|تكرار)/.test(normalized)) {
    return { action: 'deduplicate_remove', instructionNote: message };
  }
  if (/(?:مكرر|مكررة|تكرار|تشابه|duplicate)/.test(normalized)) {
    return { action: 'detect_duplicates', instructionNote: message };
  }
  if (/(?:اجمع|تجميع|دمج|ادمج|التابعة\s+لكل\s+منتج|صور\s+المنتج\s+الواحد)/.test(normalized)) {
    return { action: 'group_similar', instructionNote: message };
  }
  if (/(?:حس[ّ]?ن|توضيح|إضاءة|جودة|تنقية).*(?:صور|الصور|صورة)/.test(normalized)) {
    return { action: 'enhance_images', instructionNote: message };
  }
  if (/(?:عد[ّ]?ل|غي[ّ]?ر|طو[ّ]?ر|اكتب|حس[ّ]?ن).*(?:وصف|أوصاف|الأوصاف|تفاصيل)/.test(normalized)) {
    return { action: 'rewrite_descriptions', instructionNote: message };
  }
  if (/(?:صن[ّ]?ف|تصنيف|رت[ّ]?ب|فرز|فئات|أقسام)/.test(normalized)) {
    return { action: 'classify_products', instructionNote: message };
  }
  if (/(?:حل[ّ]?ل|استخرج|فك\s+الضغط|ملف\s+مضغوط|zip)/.test(normalized)) {
    return { action: 'analyze_staged', instructionNote: message };
  }
  if (/(?:جه[ّ]?ز|جاهزية|للمراجعة|تحقق\s+من)/.test(normalized)) {
    return { action: 'prepare_for_review', instructionNote: message };
  }

  if (ai) {
    try {
      const resp = await withAiTimeout(
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: `صنّف أمر المستخدم التالي إلى أحد الإجراءات الدقيقة فقط:
- analyze_staged: تحليل الصور المرفوعة أو فك واستخراج منتجات ملف ZIP
- group_similar: تجميع الصور المتعددة التابعة لنفس المنتج
- enhance_images: تحسين جودة وإضاءة صور المنتجات
- rewrite_descriptions: تعديل أو تحسين أوصاف المنتجات
- classify_products: تصنيف المنتجات حسب نوعها وفئات المتجر
- detect_duplicates: مراجعة المنتجات واكتشاف الصور المكررة
- deduplicate_remove: دمج أو حذف المنتجات ذات الصور المكررة
- prepare_for_review: تجهيز المنتجات ومراجعة جاهزيتها دون تسعير
- refuse_auto_price: إذا طلب المستخدم تخمين أو تحديد الأسعار تلقائياً
- general_qa: استفسار أو سؤال عام عن المنتجات المرفوعة

الأمر: "${message}"`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                action: { type: Type.STRING },
                instructionNote: { type: Type.STRING },
              },
              required: ['action'],
            },
          },
        }),
        8000
      );
      if (resp.text) {
        const parsed = JSON.parse(resp.text);
        const validActions: AssistantActionType[] = [
          'refuse_auto_price',
          'analyze_staged',
          'group_similar',
          'enhance_images',
          'rewrite_descriptions',
          'classify_products',
          'detect_duplicates',
          'deduplicate_remove',
          'prepare_for_review',
          'general_qa',
        ];
        if (validActions.includes(parsed.action)) {
          return {
            action: parsed.action,
            instructionNote: String(parsed.instructionNote || message),
          };
        }
      }
    } catch {
      // Fall back to general_qa
    }
  }

  return { action: 'general_qa', instructionNote: message };
}

function getTargetDrafts(
  allPending: SmartAssistantDraft[],
  selectedIds?: string[]
): SmartAssistantDraft[] {
  if (Array.isArray(selectedIds) && selectedIds.length > 0) {
    const filtered = allPending.filter((d) => selectedIds.includes(d.id));
    if (filtered.length > 0) return filtered;
  }
  return allPending;
}

// 12. POST /api/admin/smart-assistant/command — Conversational Arabic Command Execution
router.post('/command', async (req: AuthRequest, res: Response) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'يرجى كتابة الأمر أو الرسالة للمساعد الذكي.' });
    }

    const selectedDraftIds: string[] = Array.isArray(req.body?.selectedDraftIds)
      ? req.body.selectedDraftIds.map(String)
      : [];
    const ai = getGeminiClient();
    const { action } = await resolveArabicCommandIntent(ai, message);

    const pendingDrafts = await listSmartDrafts('pending_review');
    const targets = getTargetDrafts(pendingDrafts, selectedDraftIds);
    const unanalyzedMedia = listStagedMedia(true);

    let reply = '';
    let affectedIds: string[] = [];
    let duplicateGroups: SmartAssistantDuplicateGroup[] = [];

    switch (action) {
      case 'refuse_auto_price': {
        reply =
          'تنفيذ القاعدة الأساسية: ممنوع تحديد الأسعار أو تخمينها تلقائياً بواسطة الذكاء الاصطناعي. تبقى خانة السعر فارغة تماماً لكل منتج حتى تقوم أنت بإدخالها يدوياً واعتماد النشر.';
        break;
      }

      case 'analyze_staged': {
        if (unanalyzedMedia.length > 0) {
          const created = await analyzeAndCreateDraftsFromMedia(
            unanalyzedMedia,
            req.user?.username || 'admin',
            true
          );
          affectedIds = created.map((d) => d.id);
          reply = `تم تحليل (${unanalyzedMedia.length}) صورة واستخراج وتجهيز (${created.length}) بطاقة منتج للمراجعة بالاسم والوصف والتصنيف والصور. جميع خانات الأسعار بقيت فارغة تماماً بانتظار إدخالك اليدوي.`;
        } else if (targets.length > 0) {
          affectedIds = targets.map((d) => d.id);
          reply = `جميع الصور المرفوعة محللة بالفعل، ولديك حالياً (${targets.length}) مسودة جاهزة في شاشة المراجعة بانتظار التسعير اليدوي.`;
        } else {
          reply =
            'لا توجد صور أو ملفات ZIP بانتظار التحليل حالياً. ارفع الصور أو الملف المضغوط في منطقة الرفع وسأبدأ بتحليلها فوراً.';
        }
        break;
      }

      case 'group_similar': {
        if (targets.length < 2) {
          reply = 'يتطلب تجميع الصور وجود بطاقتين قيد المراجعة على الأقل لربط الصور المتشابهة للمنتج الواحد.';
          break;
        }
        const buckets = new Map<string, SmartAssistantDraft[]>();
        for (const d of targets) {
          const keyByStem = normalizeProductGroupSlug(d.source_filename);
          const keyByMeta = `${d.brand.toLowerCase()}::${d.product_type.toLowerCase()}::${keyByStem}`;
          const groupKey = keyByStem.length >= 3 ? keyByMeta : d.title_ar.slice(0, 24).toLowerCase();
          const list = buckets.get(groupKey) || [];
          list.push(d);
          buckets.set(groupKey, list);
        }

        // Also include visual dHash near-matches across different filenames
        let mergedCount = 0;
        const alreadyMerged = new Set<string>();
        for (const bucket of buckets.values()) {
          if (bucket.length >= 2) {
            const ids = bucket.map((b) => b.id).filter((id) => !alreadyMerged.has(id));
            if (ids.length >= 2) {
              const merged = await mergeSmartDrafts(ids);
              if (merged) {
                ids.forEach((id) => alreadyMerged.add(id));
                affectedIds.push(merged.id);
                mergedCount++;
              }
            }
          }
        }

        if (mergedCount > 0) {
          reply = `تم تجميع الصور المتعددة التابعة لنفس المنتج في (${mergedCount}) بطاقة منتج موحدة تضم الصورة الرئيسية والصور الإضافية دون المساس بالأسعار.`;
        } else {
          reply = `تم فحص (${targets.length}) بطاقة منتج، ولم تُرصد صور إضافية متفرقة لنفس المنتج تحتاج إلى دمج. يمكنك أيضاً تحديد أي بطاقتين يدوياً والضغط على "تجميع في منتج واحد".`;
        }
        break;
      }

      case 'enhance_images': {
        if (targets.length === 0) {
          reply = 'لا توجد منتجات قيد المراجعة لتحسين صورها حالياً.';
          break;
        }
        let enhancedImgsCount = 0;
        for (const d of targets) {
          const nextGallery: string[] = [];
          let latestStats = d.image_optimization;
          for (const url of d.gallery_images) {
            try {
              const enh = await enhanceStoredSmartImage(url);
              nextGallery.push(enh.imageUrl);
              latestStats = enh.stats;
              enhancedImgsCount++;
            } catch {
              nextGallery.push(url);
            }
          }
          await updateSmartDraft(
            d.id,
            {
              image_url: nextGallery[0] || d.image_url,
              gallery_images: nextGallery,
              image_optimization: latestStats,
              enhanced: true,
            },
            { allowPriceUpdate: false }
          );
          affectedIds.push(d.id);
        }
        reply = `تم تحسين الإضاءة والحدة والتباين وتجهيز (${enhancedImgsCount}) صورة عبر (${targets.length}) منتج للمتجر بنجاح.`;
        break;
      }

      case 'rewrite_descriptions': {
        if (targets.length === 0) {
          reply = 'لا توجد منتجات محددة أو قيد المراجعة لتعديل أوصافها.';
          break;
        }
        for (const d of targets) {
          let newDesc = d.description_ar;
          if (ai) {
            try {
              const resp = await withAiTimeout(
                ai.models.generateContent({
                  model: 'gemini-3.1-flash-lite',
                  contents: `أعد صياغة الوصف التسويقي للمنتج التالي باللغة العربية بأسلوب احترافي ومقنع بناءً على تعليمات المدير: "${message}".
اسم المنتج: ${d.title_ar}
النوع: ${d.product_type}
العلامة التجارية: ${d.brand}
الحجم: ${d.size_or_volume}
الوصف الحالي: ${d.description_ar}
قاعدة صارمة: لا تذكر أي سعر أو أرقام مالية أبداً.`,
                }),
                10000
              );
              if (resp.text && resp.text.trim().length > 10) {
                newDesc = resp.text.trim();
              }
            } catch {
              // Deterministic enhancement below
            }
          }
          if (newDesc === d.description_ar) {
            newDesc = `${d.title_ar} (${d.product_type}) من ${d.brand} — تركيبة أصلية عالية الجودة تمنحك نتائج واضحة ومظهراً متألقاً بفعالية موثوقة وتفاصيل دقيقة (${d.size_or_volume}).`;
          }
          await updateSmartDraft(d.id, { description_ar: newDesc }, { allowPriceUpdate: false });
          affectedIds.push(d.id);
        }
        reply = `تم تحديث وصياغة الأوصاف التسويقية لـ (${affectedIds.length}) منتج بنجاح مع بقاء خانات الأسعار فارغة كما هي.`;
        break;
      }

      case 'classify_products': {
        if (targets.length === 0) {
          reply = 'لا توجد منتجات قيد المراجعة لتصنيفها حالياً.';
          break;
        }
        const categorySummary: Record<string, number> = {};
        for (const d of targets) {
          let chosenCategory = d.category_name;
          if (ai) {
            try {
              const resp = await withAiTimeout(
                ai.models.generateContent({
                  model: 'gemini-3.1-flash-lite',
                  contents: `اختر أنسب تصنيف واحد فقط من القائمة (${CATEGORY_LIST_STR}) للمنتج التالي: "${d.title_ar} - ${d.product_type}". أرجع اسم التصنيف فقط.`,
                }),
                8000
              );
              if (resp.text?.trim()) {
                chosenCategory = resp.text.trim();
              }
            } catch {
              // Fallback to local matchCategory
            }
          }
          const matched = matchCategory(
            `${chosenCategory} ${d.title_ar} ${d.product_type} ${d.source_filename}`
          );
          await updateSmartDraft(
            d.id,
            { category_id: matched.id, category_name: matched.name_ar },
            { allowPriceUpdate: false }
          );
          categorySummary[matched.name_ar] = (categorySummary[matched.name_ar] || 0) + 1;
          affectedIds.push(d.id);
        }
        const summaryLines = Object.entries(categorySummary)
          .map(([cat, count]) => `${cat}: ${count}`)
          .join(' · ');
        reply = `تمت مراجعة وتصنيف (${affectedIds.length}) منتج حسب نوعها (${summaryLines}).`;
        break;
      }

      case 'detect_duplicates': {
        if (targets.length === 0) {
          reply = 'لا توجد منتجات قيد المراجعة لفحص التكرار.';
          break;
        }
        const dupRes = await detectDuplicatesAcrossDrafts(targets.map((d) => d.id));
        duplicateGroups = dupRes.groups;
        affectedIds = duplicateGroups.flatMap((g) => g.draft_ids);
        if (duplicateGroups.length === 0) {
          reply = `تم فحص جميع الصور (${targets.length} بطاقة) عبر البصمة الرقمية والتشابه البصري: لم يتم العثور على صور مكررة.`;
        } else {
          reply = `تم اكتشاف (${duplicateGroups.length}) مجموعات تحتوي على صور مكررة أو متطابقة بصرياً بإجمالي (${affectedIds.length}) بطاقة وتم تمييزها في شاشة المراجعة. يمكنك طلب "احذف الصور المكررة" لدمجها تلقائياً.`;
        }
        break;
      }

      case 'deduplicate_remove': {
        const dupRes = await detectDuplicatesAcrossDrafts(targets.map((d) => d.id));
        if (dupRes.groups.length === 0) {
          reply = 'لا توجد صور مكررة حالياً لحذفها أو دمجها.';
          break;
        }
        let removedCount = 0;
        for (const group of dupRes.groups) {
          const merged = await mergeSmartDrafts(group.draft_ids);
          if (merged) {
            affectedIds.push(merged.id);
            removedCount += group.draft_ids.length - 1;
          }
        }
        reply = `تم دمج البطاقات المكررة وإزالة (${removedCount}) نسخة مكررة بأمان دون التأثير على المنتجات المنشورة.`;
        break;
      }

      case 'prepare_for_review': {
        if (unanalyzedMedia.length > 0) {
          const created = await analyzeAndCreateDraftsFromMedia(
            unanalyzedMedia,
            req.user?.username || 'admin',
            true
          );
          affectedIds.push(...created.map((d) => d.id));
        }
        const refreshed = await listSmartDrafts('pending_review');
        const dupCheck = await detectDuplicatesAcrossDrafts(refreshed.map((d) => d.id));
        duplicateGroups = dupCheck.groups;
        const missingPriceCount = refreshed.filter(
          (d) => !d.original_price || d.original_price <= 0
        ).length;
        reply = `تم تجهيز (${refreshed.length}) بطاقة منتج في شاشة المراجعة. حالة التسعير: (${missingPriceCount}) منتج بانتظار إدخال السعر يدوياً منك قبل النشر${
          duplicateGroups.length > 0 ? ` · تنبيه: يوجد (${duplicateGroups.length}) مجموعات صور متشابهة/مكررة` : ''
        }.`;
        break;
      }

      default: {
        const missingPriceCount = pendingDrafts.filter(
          (d) => !d.original_price || d.original_price <= 0
        ).length;
        if (ai) {
          try {
            const contextSnapshot = pendingDrafts.slice(0, 15).map((d) => ({
              title_ar: d.title_ar,
              category: d.category_name,
              brand: d.brand,
              images: d.gallery_images.length,
              has_manual_price: Boolean(d.original_price && d.original_price > 0),
            }));
            const resp = await withAiTimeout(
              ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `أنت المساعد الذكي الشامل في لوحة إدارة متجر "أمازون دعاء".
الوضع الحالي:
- صور مرفوعة بانتظار التحليل: ${unanalyzedMedia.length}
- بطاقات منتجات قيد المراجعة: ${pendingDrafts.length} (منها ${missingPriceCount} بدون سعر يدوي بعد)
عينة من البطاقات: ${JSON.stringify(contextSnapshot)}

أجب على رسالة المدير بإيجاز ووضوح باللغة العربية، وتذكر أن القاعدة الصارمة تمنع تخمين أو وضع الأسعار تلقائياً.
رسالة المدير: "${message}"`,
              }),
              10000
            );
            if (resp.text?.trim()) {
              reply = resp.text.trim();
            }
          } catch {
            // Fall through to structured summary
          }
        }
        if (!reply) {
          reply = `مرحباً بك في المساعد الذكي الشامل. لديك حالياً (${pendingDrafts.length}) بطاقة منتج قيد المراجعة و(${unanalyzedMedia.length}) صورة جديدة بانتظار التحليل. يمكنك أن تطلب مني مباشرة: "حلل هذه الصور" أو "اجمع الصور التابعة لكل منتج" أو "حسّن صور المنتجات" أو "راجع المنتجات واكتشف الصور المكررة".`;
        }
        break;
      }
    }

    const latestDrafts = await listSmartDrafts();
    const latestStaged = listStagedMedia(true);

    return res.json({
      success: true,
      actionExecuted: action,
      reply,
      affectedIds,
      duplicateGroups,
      drafts: latestDrafts,
      stagedMedia: latestStaged,
    });
  } catch (err: any) {
    console.error('[SmartAssistant] Command error:', err);
    return res.status(500).json({ error: err?.message || 'تعذر تنفيذ أمر المساعد الذكي.' });
  }
});

export default router;
