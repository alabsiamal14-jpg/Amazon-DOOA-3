import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { requireAdmin, AuthRequest } from '../../middleware/auth.ts';
import {
  BulkValidationError,
  bulkPublishBulkImportDrafts,
  createBulkImportDraft,
  deleteBulkImportDraft,
  listBulkImportDrafts,
  optimizeAndSaveBulkImage,
  publishBulkImportDraft,
  updateBulkImportDraft,
} from '../../lib/bulk-import-store.ts';
import { INITIAL_CATEGORIES } from '../../data/initialData.ts';
import type { BulkImportDraft, BulkImportSourceType } from '../../types.ts';

const router = Router();
router.use(requireAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB max per uploaded file or ZIP archive
    files: 25,
  },
});

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_BATCH_IMAGES = 40;
const GEMINI_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];

const BULK_EXTRACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title_ar: { type: Type.STRING, description: 'اسم المنتج التسويقي بالعربية' },
    description_ar: { type: Type.STRING, description: 'وصف تسويقي جذاب ومقنع بالعربية' },
    category_name: {
      type: Type.STRING,
      description: 'التصنيف الأنسب للمنتج باللغة العربية',
    },
    brand: { type: Type.STRING, description: 'العلامة التجارية أو غير محدد' },
    size_or_volume: { type: Type.STRING, description: 'الحجم أو السعة أو قياسي' },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'كلمات مفتاحية عربية للبحث',
    },
  },
  required: ['title_ar', 'description_ar', 'category_name'],
};

const CATEGORY_LIST_STR = INITIAL_CATEGORIES.map((c) => c.name_ar).join('، ');

const STRICT_BULK_PROMPT = `أنت خبير تسويق وتصنيف منتجات لمتجر "أمازون دعاء" الإلكتروني.
قم بتحليل صورة المنتج المرفقة وتجهيز بياناته التسويقية باللغة العربية بدقة واحترافية:
1. title_ar: اسم عربي واضح وجذاب للمنتج (أقل من 80 حرف).
2. description_ar: وصف تسويقي متكامل واحترافي باللغة العربية يبرز الفوائد والمميزات.
3. category_name: اختر التصنيف الأنسب من القائمة التالية: ${CATEGORY_LIST_STR}.
4. brand: العلامة التجارية إن وُجدت على العبوة، وإلا اكتب "غير محدد".
5. size_or_volume: الحجم أو السعة إن ظهر على العبوة، وإلا "قياسي".
6. tags: 3 إلى 5 وسوم بحث عربية قصيرة.

قاعدة صارمة: لا تولّد أو تخمّن أو تذكر أي سعر نهائياً لأن التسعير يتم حصراً بواسطة الإدارة لاحقاً.`;

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

async function prepareCompactAiImageBuffer(optimizedJpegBuffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(optimizedJpegBuffer)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
  } catch {
    return optimizedJpegBuffer;
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

function buildDeterministicArabicFallback(filename: string, index: number): {
  title_ar: string;
  description_ar: string;
  category_name: string;
  brand: string;
  size_or_volume: string;
  tags: string[];
} {
  const baseName = path
    .basename(filename, path.extname(filename))
    .replace(/[_-]+/g, ' ')
    .trim();

  const lower = baseName.toLowerCase();
  let categoryName = 'عناية بالبشرة';
  let defaultTitle = `منتج عناية فاخر مستورد (${index + 1})`;
  let defaultDesc =
    'تركيبة أصلية عالية الجودة تمنحك نتائج ملموسة ومظهراً أنيقاً يدوم طوال اليوم، جاهز للمراجعة والتسعير من الإدارة.';

  if (lower.includes('perfume') || lower.includes('عطر') || lower.includes('oud')) {
    categoryName = 'عطور فاخرة';
    defaultTitle = 'عطر فاخر بتركيبة ثابتة';
    defaultDesc = 'توليفة عطرية أنيقة بنفحات شرقية وفرنسية راقية وثبات يدوم لساعات طويلة.';
  } else if (lower.includes('hair') || lower.includes('شعر') || lower.includes('shampoo')) {
    categoryName = 'عناية بالشعر';
    defaultTitle = 'مستحضر تغذية وترميم الشعر الفاخر';
    defaultDesc = 'يغذي خصلات الشعر بعمق ويمنحها لمعاناً صحياً وانسيابية طبيعية.';
  } else if (lower.includes('lip') || lower.includes('makeup') || lower.includes('مكياج')) {
    categoryName = 'مكياج وتجميل';
    defaultTitle = 'مستحضر تجميل احترافي عالي الثبات';
    defaultDesc = 'لون غني وملمس مخملي ناعم يبرز جمالك الطبيعي طوال اليوم.';
  }

  const hasReadableLetters = /[a-zA-Z\u0600-\u06FF]{3,}/.test(baseName);
  const title_ar =
    hasReadableLetters && /[\u0600-\u06FF]/.test(baseName)
      ? baseName.slice(0, 120)
      : hasReadableLetters && !/^img|dsc|photo|image|product/i.test(baseName)
        ? `${defaultTitle} - ${baseName.slice(0, 40)}`
        : defaultTitle;

  return {
    title_ar,
    description_ar: defaultDesc,
    category_name: categoryName,
    brand: 'أمازون دعاء',
    size_or_volume: 'قياسي',
    tags: ['استيراد_ذكي', categoryName.replace(/\s+/g, '_'), 'جودة_عالية'],
  };
}

async function analyzeImageWithGemini(
  ai: GoogleGenAI | null,
  optimizedJpegBuffer: Buffer,
  filename: string,
  index: number
): Promise<{
  title_ar: string;
  description_ar: string;
  category_name: string;
  brand: string;
  size_or_volume: string;
  tags: string[];
}> {
  if (ai && process.env.NODE_ENV !== 'test') {
    const aiBuffer = await prepareCompactAiImageBuffer(optimizedJpegBuffer);
    const base64Data = aiBuffer.toString('base64');

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
                    {
                      inlineData: {
                        mimeType: 'image/jpeg',
                        data: base64Data,
                      },
                    },
                    {
                      text: `${STRICT_BULK_PROMPT}\nاسم الملف المرجعي: ${path.basename(filename)}`,
                    },
                  ],
                },
              ],
              config: {
                responseMimeType: 'application/json',
                responseSchema: BULK_EXTRACT_SCHEMA,
                ...(model === 'gemini-4-hydrogen'
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                  : {}),
              },
            }),
            35000
          );

          if (response.text) {
            const parsed = JSON.parse(response.text);
            if (parsed && typeof parsed.title_ar === 'string' && parsed.title_ar.trim()) {
              return {
                title_ar: parsed.title_ar.trim(),
                description_ar:
                  String(parsed.description_ar || '').trim() ||
                  'وصف تسويقي احترافي جاهز للمراجعة الإدارية.',
                category_name: String(parsed.category_name || 'عناية بالبشرة').trim(),
                brand: String(parsed.brand || 'غير محدد').trim(),
                size_or_volume: String(parsed.size_or_volume || 'قياسي').trim(),
                tags: Array.isArray(parsed.tags)
                  ? parsed.tags.map(String).filter(Boolean).slice(0, 6)
                  : ['استيراد_ذكي'],
              };
            }
          }
          break;
        } catch (err: any) {
          if (attempt < maxAttempts && isTransientAiError(err)) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          console.warn(`[BulkImport] Gemini fallback for ${filename} (${model}):`, err?.message || err);
          break;
        }
      }
    }
  }

  return buildDeterministicArabicFallback(filename, index);
}

// 1. POST /api/admin/bulk-import/analyze — Multi-image OR ZIP bulk import into independent unpriced drafts
router.post(
  '/analyze',
  (req: AuthRequest, res: Response, next) => {
    upload.array('files', 25)(req as any, res, (err) => {
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
        return res.status(400).json({
          error: 'يرجى رفع عدة صور للمنتجات أو ملف ZIP يحتوي على صور.',
        });
      }

      interface QueuedImageEntry {
        filename: string;
        buffer: Buffer;
        sourceType: BulkImportSourceType;
      }

      const imageEntries: QueuedImageEntry[] = [];

      for (const file of files) {
        if (isZipFile(file)) {
          let zip: AdmZip;
          try {
            zip = new AdmZip(file.buffer);
          } catch {
            return res.status(400).json({
              error: `تعذر قراءة ملف ZIP (${file.originalname}). تأكد من أن الملف مضغوط بصيغة ZIP صالحة.`,
            });
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

            imageEntries.push({
              filename: path.basename(entryName),
              buffer: entryBuf,
              sourceType: 'zip_archive',
            });

            if (imageEntries.length >= MAX_BATCH_IMAGES) break;
          }
        } else if (
          file.mimetype.startsWith('image/') ||
          isImageFilename(file.originalname)
        ) {
          imageEntries.push({
            filename: file.originalname || `image-${imageEntries.length + 1}.jpg`,
            buffer: file.buffer,
            sourceType: 'multi_image',
          });
        }

        if (imageEntries.length >= MAX_BATCH_IMAGES) break;
      }

      if (imageEntries.length === 0) {
        return res.status(400).json({
          error: 'لم يتم العثور على صور صالحة (JPG / PNG / WebP) داخل الملفات المرفوعة أو ملف ZIP.',
        });
      }

      const apiKey = process.env.GEMINI_API_KEY?.trim();
      const ai =
        apiKey && process.env.NODE_ENV !== 'test'
          ? new GoogleGenAI({
              apiKey,
              httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: 45000 },
            })
          : null;

      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const createdDrafts: BulkImportDraft[] = [];
      const skippedFiles: Array<{ filename: string; reason: string }> = [];

      // Process in bounded concurrency chunks (up to 2 at once to avoid Gemini deadline saturation)
      const CHUNK_SIZE = 2;
      for (let i = 0; i < imageEntries.length; i += CHUNK_SIZE) {
        const chunk = imageEntries.slice(i, i + CHUNK_SIZE);
        const results = await Promise.all(
          chunk.map(async (entry, offset) => {
            const index = i + offset;
            try {
              const { imageUrl, optimizedBuffer, stats } = await optimizeAndSaveBulkImage(
                entry.buffer,
                entry.filename
              );
              const extracted = await analyzeImageWithGemini(
                ai,
                optimizedBuffer,
                entry.filename,
                index
              );
              const draft = await createBulkImportDraft({
                batch_id: batchId,
                source_filename: entry.filename,
                source_type: entry.sourceType,
                title_ar: extracted.title_ar,
                description_ar: extracted.description_ar,
                category_name: extracted.category_name,
                brand: extracted.brand,
                size_or_volume: extracted.size_or_volume,
                tags: extracted.tags,
                image_url: imageUrl,
                image_optimization: stats,
                created_by: req.user?.username || 'admin',
              });
              return draft;
            } catch (imgErr: any) {
              skippedFiles.push({
                filename: entry.filename,
                reason: imgErr?.message || 'صورة غير صالحة أو تالفة',
              });
              return null;
            }
          })
        );

        for (const r of results) {
          if (r) createdDrafts.push(r);
        }
      }

      if (createdDrafts.length === 0) {
        return res.status(400).json({
          error: 'فشل معالجة جميع الصور المرفوعة. يرجى التأكد من سلامة ملفات الصور.',
          skippedFiles,
        });
      }

      const totalOriginalBytes = createdDrafts.reduce(
        (sum, d) => sum + d.image_optimization.original_bytes,
        0
      );
      const totalOptimizedBytes = createdDrafts.reduce(
        (sum, d) => sum + d.image_optimization.optimized_bytes,
        0
      );

      return res.json({
        success: true,
        batch_id: batchId,
        imported_count: createdDrafts.length,
        drafts: createdDrafts,
        skippedFiles,
        optimization_summary: {
          original_bytes: totalOriginalBytes,
          optimized_bytes: totalOptimizedBytes,
          saved_percent:
            totalOriginalBytes > 0
              ? Math.max(
                  0,
                  Math.round(((totalOriginalBytes - totalOptimizedBytes) / totalOriginalBytes) * 100)
                )
              : 0,
        },
        message: `تم استخراج وتجهيز (${createdDrafts.length}) مسودة منتج بالذكاء الاصطناعي في منطقة المسودات. يرجى تحديد الأسعار واعتماد النشر.`,
      });
    } catch (err: any) {
      console.error('[BulkImport] Analyze error:', err);
      return res.status(500).json({
        error: err?.message || 'حدث خطأ أثناء معالجة الاستيراد الذكي بالجملة.',
      });
    }
  }
);

// 2. GET /api/admin/bulk-import/drafts — Persisted independent drafts list
router.get('/drafts', async (req: AuthRequest, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const drafts = await listBulkImportDrafts(status);
    const pendingCount = drafts.filter((d) => d.status === 'pending_review').length;
    return res.json({
      drafts,
      pendingCount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر جلب مسودات الاستيراد.' });
  }
});

// 3. PATCH /api/admin/bulk-import/drafts/:id — Edit draft fields & price (does NOT publish)
router.patch('/drafts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updated = await updateBulkImportDraft(id, req.body || {});
    return res.json({ success: true, draft: updated });
  } catch (err: any) {
    const statusCode = String(err?.message || '').includes('غير موجودة') ? 404 : 400;
    return res.status(statusCode).json({ error: err?.message || 'تعذر تحديث المسودة.' });
  }
});

// 4. DELETE /api/admin/bulk-import/drafts/:id — Delete draft without affecting published products
router.delete('/drafts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await deleteBulkImportDraft(id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر حذف المسودة.' });
  }
});

// 5. POST /api/admin/bulk-import/drafts/bulk-publish — Explicit admin approval + per-product price check
router.post('/drafts/bulk-publish', async (req: AuthRequest, res: Response) => {
  try {
    const approve = req.body?.approve === true;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const result = await bulkPublishBulkImportDrafts(
      items,
      req.user?.username || 'admin',
      approve
    );
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
    return res.status(400).json({ error: err?.message || 'تعذر النشر الجماعي للمسودات.' });
  }
});

// 6. POST /api/admin/bulk-import/drafts/:id/publish — Individual explicit approval + strict price > 0 guard
router.post('/drafts/:id/publish', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await publishBulkImportDraft(id, req.user?.username || 'admin', {
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
    const msg = err?.message || 'تعذر اعتماد ونشر المسودة.';
    const statusCode = msg.includes('غير موجودة') ? 404 : 400;
    return res.status(statusCode).json({ error: msg });
  }
});

export default router;
