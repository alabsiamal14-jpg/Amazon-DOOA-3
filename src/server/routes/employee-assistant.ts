import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  AuthRequest,
  VALID_EMPLOYEE_CODES,
  createEmployeeToken,
  isValidEmployeeCode,
  requireAdmin,
  requireEmployeeOrAdmin,
} from '../../middleware/auth.ts';
import {
  createEmployeeDraft,
  deleteEmployeeDraft,
  listEmployeeDrafts,
  matchCategory,
  publishEmployeeDraft,
  updateEmployeeDraft,
} from '../../lib/employee-drafts-store.ts';
import type { EmployeeDraftSourceType } from '../../types.ts';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = '/tmp/employee-assistant-uploads';
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, `emp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB for videos/images
    files: 12,
  },
});

interface ExtractedDraftCandidate {
  title_ar: string;
  description_ar: string;
  category_id: string;
  category_name: string;
  brand: string;
  size_or_volume: string;
  ingredients: string;
  how_to_use: string;
  tags: string[];
  image_url: string;
  gallery_images: string[];
  source_type: EmployeeDraftSourceType;
  price: null;
  original_price: null;
  discount_price: null;
  pricing_status_label: 'بانتظار التسعير من الإدارة';
  status: 'pending_pricing';
}

const DEFAULT_FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80';

function enforceUnpricedDraftShape(
  raw: Record<string, any>,
  images: string[],
  sourceType: EmployeeDraftSourceType
): ExtractedDraftCandidate {
  const cat = matchCategory(raw.category_id || raw.category_name);
  const cleanImages = images.filter((img) => typeof img === 'string' && img.trim() && !img.startsWith('blob:'));
  const primaryImage = cleanImages[0] || DEFAULT_FALLBACK_IMAGE;

  return {
    title_ar: String(raw.title_ar || raw.name || 'منتج تجميل وعناية جديد').trim().slice(0, 300),
    description_ar: String(
      raw.description_ar ||
        raw.description ||
        'وصف مستخرج تلقائياً عبر مساعد الموظفين الذكي ومجهز لمراجعة الإدارة.'
    ).trim().slice(0, 4000),
    category_id: cat.id,
    category_name: cat.name_ar,
    brand: String(raw.brand || 'غير محدد').trim().slice(0, 150),
    size_or_volume: String(raw.size_or_volume || raw.size || 'قياسي').trim().slice(0, 100),
    ingredients: String(raw.ingredients || 'مكونات أصلية عالية الجودة').trim().slice(0, 2000),
    how_to_use: String(raw.how_to_use || 'يُستخدم بانتظام حسب إرشادات العبوة.').trim().slice(0, 2000),
    tags: Array.isArray(raw.tags) && raw.tags.length > 0
      ? raw.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 12)
      : [cat.name_ar, 'مسودة_موظف'],
    image_url: primaryImage,
    gallery_images: cleanImages.length > 0 ? cleanImages : [primaryImage],
    source_type: sourceType,
    // Strictly null — NEVER auto-generated or guessed
    price: null,
    original_price: null,
    discount_price: null,
    pricing_status_label: 'بانتظار التسعير من الإدارة',
    status: 'pending_pricing',
  };
}

function buildFallbackExtractionFromText(
  text: string,
  images: string[],
  sourceType: EmployeeDraftSourceType
): ExtractedDraftCandidate[] {
  const cleanText = text.trim();
  if (!cleanText) {
    return [
      enforceUnpricedDraftShape(
        {
          title_ar: sourceType === 'video' ? 'منتج من فيديو كتالوج المورد' : 'منتج عناية وتجميل جديد',
          description_ar: 'تم تجهيز المسودة من الملفات المرفوعة وبانتظار تسعير الإدارة.',
          category_name: 'عناية بالبشرة',
          brand: 'ماركة أصلية',
          size_or_volume: '50 مل',
          ingredients: 'خلاصات طبيعية مرطبة ومغذية',
          how_to_use: 'يُوضع على بشرة نظيفة وجافة صباحاً ومساءً.',
          tags: ['عناية_بالبشرة', 'مسودة_موظف'],
        },
        images,
        sourceType
      ),
    ];
  }

  // Split multi-line WhatsApp catalog chat if multiple product lines exist
  const lines = cleanText
    .split(/\n+/)
    .map((l) => l.replace(/^[\-\*\d\.\)\s]+/, '').trim())
    .filter((l) => l.length >= 3);

  if (sourceType === 'whatsapp_chat' && lines.length > 1 && lines.length <= 8) {
    const productLines = lines.filter((l) => !l.endsWith(':'));
    if (productLines.length > 1) {
      return productLines.map((line, idx) => {
        const cleanTitle = line.replace(/\b\d+\s*(ر\.?س|ريال|SAR|USD|\$)\b/gi, '').trim();
        const img = images[idx] || images[0] || DEFAULT_FALLBACK_IMAGE;
        return enforceUnpricedDraftShape(
          {
            title_ar: cleanTitle.slice(0, 120),
            description_ar: `تم الاستخراج من محادثة المورد: ${cleanTitle}`,
            category_name: line,
            brand: 'حسب كتالوج المورد',
            size_or_volume: 'قياسي',
            ingredients: 'موضح على العبوة الأصلية للمورد',
            how_to_use: 'يُستخدم حسب إرشادات المنتج.',
            tags: ['واتساب_المورد', 'مسودة_موظف'],
          },
          [img],
          sourceType
        );
      });
    }
  }

  const firstLine = (lines[0] || cleanText).replace(/\b\d+\s*(ر\.?س|ريال|SAR|USD|\$)\b/gi, '').trim();
  return [
    enforceUnpricedDraftShape(
      {
        title_ar: firstLine.slice(0, 120) || 'منتج مورد جديد',
        description_ar: cleanText.slice(0, 1000),
        category_name: cleanText,
        brand: 'حسب كتالوج المورد',
        size_or_volume: 'قياسي',
        ingredients: 'مكونات أصلية معتمدة',
        how_to_use: 'يُستخدم حسب الإرشادات الموضحة على العبوة.',
        tags: ['مسودة_موظف', 'كتالوج_المورد'],
      },
      images,
      sourceType
    ),
  ];
}

const EXTRACTION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    products: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title_ar: { type: Type.STRING },
          description_ar: { type: Type.STRING },
          category_name: { type: Type.STRING },
          brand: { type: Type.STRING },
          size_or_volume: { type: Type.STRING },
          ingredients: { type: Type.STRING },
          how_to_use: { type: Type.STRING },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['title_ar', 'description_ar', 'category_name', 'brand', 'size_or_volume', 'ingredients', 'how_to_use', 'tags'],
      },
    },
  },
  required: ['products'],
};

const STRICT_NO_PRICE_PROMPT = `أنت مساعد ذكي متخصص في تحليل منتجات متجر "أمازون دعاء" للتجميل والعناية والعطور.
المطلوب: استخرج بيانات المنتج باللغة العربية بدقة واحترافية:
- title_ar (اسم المنتج الواضح)
- description_ar (وصف تسويقي واضح)
- category_name (اختر من: عناية بالبشرة، مكياج احترافي، عطور فاخرة، عناية بالشعر، أجهزة العناية)
- brand (العلامة التجارية)
- size_or_volume (الحجم أو السعة مثل 50 مل، 100 جم، أو قياسي)
- ingredients (المكونات الرئيسية)
- how_to_use (طريقة الاستخدام)
- tags (3 إلى 6 كلمات مفتاحية باللغة العربية)

قواعد حاسمة:
1. لا تولّد أو تخمّن أو تكتب أي سعر نهائياً في أي حقل (السعر متروك للإدارة فقط).
2. إذا كانت الصورة واضحة أو النص مختصراً، استنتج البيانات الفنية بدقة دون إضافة أي أرقام أسعار.`;

const GEMINI_TEXT_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];

function withAiTimeout<T>(promise: Promise<T>, ms = 35000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Gemini request timed out')), ms)),
  ]);
}

async function analyzeImageWithGemini(
  ai: GoogleGenAI,
  imageParts: Array<{ inlineData: { data: string; mimeType: string } }>,
  hintText: string,
  multipleProductsHint: boolean
): Promise<any[]> {
  const prompt = `${STRICT_NO_PRICE_PROMPT}
${multipleProductsHint ? 'ملاحظة: الصور المرفقة قد تمثل منتجاً واحداً من عدة زوايا، أو عدة منتجات. استخرج المعلومات بشكل منظم.' : ''}
${hintText ? `ملاحظات الموظف: ${hintText}` : ''}`;

  for (const model of GEMINI_TEXT_MODELS) {
    try {
      const response = await withAiTimeout(
        ai.models.generateContent({
          model,
          contents: [{ parts: [...imageParts, { text: prompt }] }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: EXTRACTION_RESPONSE_SCHEMA,
            ...(model === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
          },
        }),
        35000
      );

      if (response.text) {
        const parsed = JSON.parse(response.text);
        if (Array.isArray(parsed?.products) && parsed.products.length > 0) {
          return parsed.products;
        }
      }
    } catch {
      // Try next model or fall back gracefully
    }
  }
  return [];
}

function dataUrlToInlinePart(dataUrl: string): { inlineData: { data: string; mimeType: string } } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1] || 'image/jpeg',
      data: match[2],
    },
  };
}

// ============================================================================
// 1. EMPLOYEE CODE LOGIN (EMP001 .. EMP008) — NO PIN OR PASSWORD REQUIRED
// ============================================================================
router.post('/employee/login', (req: Request, res: Response) => {
  try {
    const rawCode = String(req.body?.employeeCode || req.body?.code || '').trim().toUpperCase();
    if (!rawCode || !isValidEmployeeCode(rawCode)) {
      return res.status(401).json({
        error: 'رمز الموظف غير صالح. الرموز المعتمدة هي EMP001 إلى EMP008 فقط.',
      });
    }

    const token = createEmployeeToken(rawCode);
    return res.json({
      success: true,
      token,
      employee: {
        code: rawCode,
        displayName: `الموظف ${rawCode}`,
        role: 'employee',
      },
      allowedCodes: VALID_EMPLOYEE_CODES,
    });
  } catch (err: any) {
    return res.status(503).json({
      error: err?.message || 'تعذر إنشاء جلسة الموظف. تحقق من إعداد ADMIN_JWT_SECRET.',
    });
  }
});

router.get('/employee/verify', requireEmployeeOrAdmin, (req: AuthRequest, res: Response) => {
  return res.json({
    ok: true,
    employee: {
      code: req.user?.username || 'ADMIN',
      displayName: req.user?.displayName || 'موظف',
      role: req.user?.role,
    },
  });
});

// ============================================================================
// 2. SMART EMPLOYEE ASSISTANT GEMINI ANALYSIS (NEVER GENERATES PRICE / NEVER PUBLISHES)
// ============================================================================
router.post(
  '/employee-assistant/analyze',
  requireEmployeeOrAdmin,
  (req: AuthRequest, res: Response, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      upload.array('files', 12)(req as any, res, (err) => {
        if (err) {
          return res.status(400).json({ error: err.message || 'فشل رفع الملفات.' });
        }
        next();
      });
    } else {
      next();
    }
  },
  async (req: AuthRequest, res: Response) => {
    const uploadedFiles = ((req as any).files as Express.Multer.File[] | undefined) || [];
    const cleanupFiles = () => {
      for (const f of uploadedFiles) {
        try {
          if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        } catch {
          // Ignore temp cleanup error
        }
      }
    };

    try {
      const mode = (String(req.body?.mode || 'single_image') as EmployeeDraftSourceType);
      const chatText = String(req.body?.chatText || req.body?.text || '').trim();
      const bodyImages: string[] = Array.isArray(req.body?.images)
        ? req.body.images.filter((img: any) => typeof img === 'string' && img.trim())
        : [];

      // Convert any multipart uploaded images to data URLs for preview/storage
      const imageFiles = uploadedFiles.filter((f) => f.mimetype.startsWith('image/'));
      const videoFiles = uploadedFiles.filter((f) => f.mimetype.startsWith('video/'));

      const fileImageDataUrls: string[] = imageFiles.map((f) => {
        const buf = fs.readFileSync(f.path);
        return `data:${f.mimetype};base64,${buf.toString('base64')}`;
      });

      const allImages = [...bodyImages, ...fileImageDataUrls].filter(
        (img) => img && !img.startsWith('blob:')
      );

      if (allImages.length === 0 && videoFiles.length === 0 && !chatText) {
        cleanupFiles();
        return res.status(400).json({
          error: 'يرجى إرفاق صورة أو فيديو أو لصق محادثة واتساب للتحليل.',
        });
      }

      const apiKey = process.env.GEMINI_API_KEY?.trim();
      let extractedDrafts: ExtractedDraftCandidate[] = [];

      if (apiKey && process.env.NODE_ENV !== 'test') {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: 45000 },
        });

        if (mode === 'video' && videoFiles.length > 0) {
          const videoFile = videoFiles[0];
          let uploadedRef: any = null;
          try {
            uploadedRef = await withAiTimeout(
              ai.files.upload({
                file: videoFile.path,
                config: { mimeType: videoFile.mimetype || 'video/mp4' },
              }),
              15000
            );
            let state = await withAiTimeout(ai.files.get({ name: uploadedRef.name }), 5000);
            let attempts = 0;
            while (state.state === 'PROCESSING' && attempts < 10) {
              await new Promise((r) => setTimeout(r, 1500));
              state = await withAiTimeout(ai.files.get({ name: uploadedRef.name }), 5000);
              attempts++;
            }
            if (state.state === 'ACTIVE') {
              const videoResp = await withAiTimeout(
                ai.models.generateContent({
                  model: GEMINI_TEXT_MODELS[0],
                  contents: [
                    uploadedRef,
                    `${STRICT_NO_PRICE_PROMPT}\nحلل فيديو كتالوج المورد واستخرج كل منتج معروض في الفيديو دون أي أسعار.\n${chatText}`,
                  ],
                  config: {
                    responseMimeType: 'application/json',
                    responseSchema: EXTRACTION_RESPONSE_SCHEMA,
                  },
                }),
                15000
              );
              const parsed = videoResp.text ? JSON.parse(videoResp.text) : {};
              if (Array.isArray(parsed?.products) && parsed.products.length > 0) {
                extractedDrafts = parsed.products.map((p: any) =>
                  enforceUnpricedDraftShape(p, allImages, 'video')
                );
              }
            }
          } catch (videoErr: any) {
            console.warn('[Employee Assistant] Gemini video fallback:', videoErr?.message || videoErr);
          } finally {
            if (uploadedRef?.name) {
              ai.files.delete({ name: uploadedRef.name }).catch(() => {});
            }
          }
        } else if (mode === 'batch_images' && allImages.length > 1) {
          // Analyze each product image into its own separate draft
          const results = await Promise.all(
            allImages.map(async (img, idx) => {
              const part = dataUrlToInlinePart(img);
              if (!part) {
                return enforceUnpricedDraftShape(
                  { title_ar: `منتج رقم ${idx + 1}`, description_ar: chatText || 'منتج مرفوع دفعة واحدة' },
                  [img],
                  'batch_images'
                );
              }
              try {
                const items = await analyzeImageWithGemini(ai, [part], chatText, false);
                return enforceUnpricedDraftShape(items[0] || { title_ar: `منتج رقم ${idx + 1}` }, [img], 'batch_images');
              } catch {
                return enforceUnpricedDraftShape({ title_ar: `منتج رقم ${idx + 1}` }, [img], 'batch_images');
              }
            })
          );
          extractedDrafts = results;
        } else if (allImages.length > 0) {
          // single_image OR multi_image_single_product
          const parts = allImages
            .slice(0, 6)
            .map(dataUrlToInlinePart)
            .filter((p): p is { inlineData: { data: string; mimeType: string } } => Boolean(p));

          if (parts.length > 0) {
            try {
              const items = await analyzeImageWithGemini(ai, parts, chatText, false);
              if (items.length > 0) {
                extractedDrafts = [enforceUnpricedDraftShape(items[0], allImages, mode)];
              }
            } catch (aiErr: any) {
              console.warn('[Employee Assistant] Gemini image fallback:', aiErr?.message || aiErr);
            }
          }
        } else if (chatText) {
          // WhatsApp chat paste analysis
          for (const model of GEMINI_TEXT_MODELS) {
            try {
              const chatResp = await withAiTimeout(
                ai.models.generateContent({
                  model,
                  contents: `${STRICT_NO_PRICE_PROMPT}\nحلل نص محادثة الواتساب التالية للمورد واستخرج جميع المنتجات المذكورة بدون أي أسعار:\n\n${chatText}`,
                  config: {
                    responseMimeType: 'application/json',
                    responseSchema: EXTRACTION_RESPONSE_SCHEMA,
                    ...(model === 'gemini-4-hydrogen'
                      ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                      : {}),
                  },
                }),
                35000
              );
              const parsed = chatResp.text ? JSON.parse(chatResp.text) : {};
              if (Array.isArray(parsed?.products) && parsed.products.length > 0) {
                extractedDrafts = parsed.products.map((p: any) =>
                  enforceUnpricedDraftShape(p, allImages, 'whatsapp_chat')
                );
                break;
              }
            } catch (aiErr: any) {
              console.warn(`[Employee Assistant] Gemini chat fallback (${model}):`, aiErr?.message || aiErr);
            }
          }
        }
      }

      // Deterministic intelligent fallback when GEMINI_API_KEY is absent or external call skipped
      if (extractedDrafts.length === 0) {
        if (mode === 'batch_images' && allImages.length > 1) {
          extractedDrafts = allImages.map((img, idx) =>
            enforceUnpricedDraftShape(
              {
                title_ar: chatText ? `${chatText.slice(0, 80)} (${idx + 1})` : `منتج مستخرج رقم ${idx + 1}`,
                description_ar: 'تم تجهيز مسودة المنتج من الدفعة وبانتظار التسعير من الإدارة.',
                category_name: chatText || 'عناية بالبشرة',
                brand: 'حسب الصورة المرفقة',
                size_or_volume: 'قياسي',
                ingredients: 'مكونات أصلية معتمدة',
                how_to_use: 'يُستخدم حسب إرشادات العبوة.',
                tags: ['دفعة_منتجات', 'مسودة_موظف'],
              },
              [img],
              'batch_images'
            )
          );
        } else {
          extractedDrafts = buildFallbackExtractionFromText(chatText, allImages, mode);
        }
      }

      // Final safeguard: ensure price is ALWAYS null and status is ALWAYS pending_pricing
      const sanitized = extractedDrafts.map((d) => ({
        ...d,
        price: null,
        original_price: null,
        discount_price: null,
        pricing_status_label: 'بانتظار التسعير من الإدارة' as const,
        status: 'pending_pricing' as const,
      }));

      cleanupFiles();
      return res.json({
        success: true,
        drafts: sanitized,
        message: `تم تحليل واستخراج ${sanitized.length} مسودة منتج بنجاح (السعر فارغ - بانتظار التسعير من الإدارة).`,
      });
    } catch (err: any) {
      cleanupFiles();
      console.error('[Employee Assistant] Analysis failed:', err);
      return res.status(500).json({ error: err?.message || 'تعذر تحليل الملفات عبر المساعد الذكي.' });
    }
  }
);

// ============================================================================
// 3. DRAFTS CRUD — EMPLOYEES CAN ONLY CREATE & VIEW THEIR OWN DRAFTS
// ============================================================================
router.get('/employee-assistant/drafts', requireEmployeeOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const isEmployee = req.user?.role === 'employee';
    const drafts = await listEmployeeDrafts(isEmployee ? req.user?.username : undefined);
    const pendingCount = drafts.filter((d) => d.status === 'pending_pricing').length;
    return res.json({ drafts, pendingCount });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر جلب مسودات الموظفين.' });
  }
});

router.get('/employee-assistant/drafts/count', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const drafts = await listEmployeeDrafts();
    const pendingCount = drafts.filter((d) => d.status === 'pending_pricing').length;
    return res.json({ pendingCount });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر حساب المسودات المعلقة.' });
  }
});

router.post('/employee-assistant/drafts', requireEmployeeOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const employeeCode =
      req.user?.role === 'employee'
        ? req.user.username || 'EMP001'
        : String(req.body?.employee_code || 'ADMIN').toUpperCase();

    const itemsInput: any[] = Array.isArray(req.body?.drafts)
      ? req.body.drafts
      : req.body?.title_ar
        ? [req.body]
        : [];

    if (itemsInput.length === 0) {
      return res.status(400).json({ error: 'بيانات مسودة المنتج غير صالحة أو الاسم مفقود.' });
    }

    const savedDrafts = [];
    for (const item of itemsInput) {
      const saved = await createEmployeeDraft({
        employee_code: employeeCode,
        title_ar: item.title_ar,
        description_ar: item.description_ar,
        category_id: item.category_id,
        category_name: item.category_name,
        brand: item.brand,
        size_or_volume: item.size_or_volume,
        ingredients: item.ingredients,
        how_to_use: item.how_to_use,
        tags: item.tags,
        image_url: item.image_url,
        gallery_images: item.gallery_images,
        source_type: item.source_type,
      });
      savedDrafts.push(saved);
    }

    return res.status(201).json({
      success: true,
      drafts: savedDrafts,
      draft: savedDrafts[0],
      message: 'تم حفظ المسودة بنجاح في ai_employee_drafts (بانتظار التسعير من الإدارة).',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر حفظ مسودة المنتج.' });
  }
});

// ============================================================================
// 4. ADMIN-ONLY REVIEW, PRICING, PUBLISH & DELETE
// ============================================================================
router.patch('/employee-assistant/drafts/:draftId', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const updated = await updateEmployeeDraft(req.params.draftId, req.body || {});
    return res.json({ success: true, draft: updated });
  } catch (err: any) {
    const status = err?.message?.includes('غير موجودة') ? 404 : 400;
    return res.status(status).json({ error: err?.message || 'تعذر تحديث المسودة.' });
  }
});

router.post(
  '/employee-assistant/drafts/:draftId/publish',
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await publishEmployeeDraft(req.params.draftId, req.body || {});
      return res.json({
        success: true,
        draft: result.draft,
        product: result.product,
        message: 'تم تسعير المنتج ونشره في المتجر بنجاح!',
      });
    } catch (err: any) {
      const status = err?.message?.includes('غير موجودة') ? 404 : 400;
      return res.status(status).json({ error: err?.message || 'تعذر نشر المسودة.' });
    }
  }
);

router.delete('/employee-assistant/drafts/:draftId', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const deleted = await deleteEmployeeDraft(req.params.draftId);
    return res.json({ success: true, deleted });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر حذف المسودة.' });
  }
});

export default router;
