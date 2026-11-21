import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  CheckSquare,
  FileArchive,
  Image as ImageIcon,
  Layers,
  Loader2,
  PackageCheck,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  Square,
  Star,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import type {
  Category,
  Product,
  SmartAssistantChatMessage,
  SmartAssistantDraft,
  SmartAssistantDuplicateGroup,
  SmartAssistantStagedMedia,
  StoreSettings,
} from '../types';
import { getAuthHeadersAsync } from '../lib/storage';

interface AdminSmartAssistantPageProps {
  categories: Category[];
  settings: StoreSettings;
  onProductsPublished: (products: Product[]) => void;
  onPendingCountChange?: (count: number) => void;
}

interface SmartDraftEditState {
  title_ar: string;
  description_ar: string;
  category_id: string;
  product_type: string;
  brand: string;
  size_or_volume: string;
  stock_quantity: string;
  original_price: string;
  discount_price: string;
  gallery_images: string[];
}

const QUICK_COMMANDS: Array<{ label: string; command: string }> = [
  { label: 'حلل هذه الصور', command: 'حلل هذه الصور' },
  { label: 'استخرج من ZIP', command: 'استخرج المنتجات من هذا الملف المضغوط' },
  { label: 'اجمع صور المنتج', command: 'اجمع الصور التابعة لكل منتج' },
  { label: 'حسّن الصور', command: 'حسّن صور المنتجات' },
  { label: 'عدّل الأوصاف', command: 'عدّل أوصاف هذه المنتجات واجعلها احترافية' },
  { label: 'صنّف المنتجات', command: 'صنّف المنتجات حسب نوعها' },
  { label: 'اكتشف المكررة', command: 'راجع المنتجات واكتشف الصور المكررة' },
  { label: 'جهّز للمراجعة', command: 'جهّز المنتجات للمراجعة' },
];

const ACTION_LABELS: Record<string, string> = {
  analyze_staged: 'تحليل الصور واستخراج المنتجات',
  group_similar: 'تجميع الصور التابعة لكل منتج',
  enhance_images: 'تحسين صور المنتجات',
  rewrite_descriptions: 'تحديث الأوصاف التسويقية',
  classify_products: 'تصنيف المنتجات',
  detect_duplicates: 'اكتشاف الصور المكررة',
  deduplicate_remove: 'دمج وإزالة المكررات',
  prepare_for_review: 'تجهيز وفحص جاهزية المراجعة',
  refuse_auto_price: 'حماية قاعدة التسعير اليدوي',
  general_qa: 'استشارة ذكية',
};

function isOptionalPriceValid(raw: string): boolean {
  if (!raw || !raw.trim()) return true;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export const AdminSmartAssistantPage: React.FC<AdminSmartAssistantPageProps> = ({
  categories,
  settings,
  onProductsPublished,
  onPendingCountChange,
}) => {
  // Data state
  const [drafts, setDrafts] = useState<SmartAssistantDraft[]>([]);
  const [stagedMedia, setStagedMedia] = useState<SmartAssistantStagedMedia[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<SmartAssistantDuplicateGroup[]>([]);
  const [edits, setEdits] = useState<Record<string, SmartDraftEditState>>({});
  const [loading, setLoading] = useState(true);

  // Upload & batch chunking state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  // Filters & Selection
  const [filter, setFilter] = useState<'pending_review' | 'duplicates' | 'approved_published' | 'all'>(
    'pending_review'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [invalidDraftIds, setInvalidDraftIds] = useState<Record<string, string>>({});

  // Action busy states
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  // Chat Assistant state
  const [chatMessages, setChatMessages] = useState<SmartAssistantChatMessage[]>([
    {
      id: 'welcome-msg',
      role: 'assistant',
      text: 'أهلاً بك في المساعد الذكي الشامل. ارفع صور المنتجات أو ملف ZIP، ثم اطلب مني تحليل الصور، تجميع صور المنتج الواحد، تحسين الجودة، اكتشاف التكرار، أو تعديل الأوصاف. تبقى خانة السعر اختيارية (حسب رغبتك) ولا يولّد الذكاء الاصطناعي أي سعر تلقائياً.',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const perDraftImageInputRef = useRef<HTMLInputElement | null>(null);
  const [imageUploadTarget, setImageUploadTarget] = useState<{
    draftId: string;
    mode: 'append' | 'replace';
  } | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const syncEditsFromDrafts = (list: SmartAssistantDraft[], forceResetIds?: Set<string>) => {
    setEdits((prev) => {
      const next: Record<string, SmartDraftEditState> = {};
      for (const d of list) {
        const keepExisting = prev[d.id] && !forceResetIds?.has(d.id);
        next[d.id] = keepExisting
          ? {
              ...prev[d.id],
              gallery_images: d.gallery_images,
            }
          : {
              title_ar: d.title_ar,
              description_ar: d.description_ar,
              category_id: d.category_id,
              product_type: d.product_type,
              brand: d.brand,
              size_or_volume: d.size_or_volume,
              stock_quantity: String(d.stock_quantity || 10),
              // Strict requirement: empty string unless admin explicitly entered a price
              original_price: d.original_price ? String(d.original_price) : '',
              discount_price: d.discount_price ? String(d.discount_price) : '',
              gallery_images: d.gallery_images,
            };
      }
      return next;
    });
  };

  const applyServerSnapshot = (
    nextDrafts: SmartAssistantDraft[],
    nextStaged?: SmartAssistantStagedMedia[],
    forceSyncAll = false
  ) => {
    setDrafts(nextDrafts);
    if (nextStaged) setStagedMedia(nextStaged);
    syncEditsFromDrafts(
      nextDrafts,
      forceSyncAll ? new Set(nextDrafts.map((d) => d.id)) : undefined
    );
    onPendingCountChange?.(nextDrafts.filter((d) => d.status === 'pending_review').length);
  };

  const loadWorkspace = async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/smart-assistant/drafts', { headers });
      if (!res.ok) throw new Error('تعذر تحميل مساحة المساعد الذكي الشامل.');
      const data = await res.json();
      const list: SmartAssistantDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      const staged: SmartAssistantStagedMedia[] = Array.isArray(data.stagedMedia)
        ? data.stagedMedia
        : [];
      applyServerSnapshot(list, staged);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'حدث خطأ أثناء تحميل البيانات.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  const addCandidateFiles = (incoming: FileList | File[]) => {
    const allowed = Array.from(incoming).filter((file) => {
      const name = file.name.toLowerCase();
      return (
        file.type.startsWith('image/') ||
        name.endsWith('.zip') ||
        name.endsWith('.jpg') ||
        name.endsWith('.jpeg') ||
        name.endsWith('.png') ||
        name.endsWith('.webp')
      );
    });

    if (allowed.length === 0) {
      setFeedback({
        type: 'error',
        message: 'يرجى اختيار صور (JPG / PNG / WebP) أو ملفات مضغوطة بصيغة ZIP فقط.',
      });
      return;
    }

    setFeedback(null);
    setSelectedFiles((prev) => [...prev, ...allowed]);
  };

  // Supports huge batches (hundreds/thousands of files) by uploading in sequential chunks of 20
  const handleUploadSelected = async (autoAnalyze: boolean) => {
    if (selectedFiles.length === 0) {
      setFeedback({ type: 'error', message: 'يرجى اختيار صور أو ملف ZIP أولاً.' });
      return;
    }

    setIngesting(true);
    setAnalyzing(autoAnalyze);
    setFeedback(null);
    const total = selectedFiles.length;
    setUploadProgress({ done: 0, total });

    try {
      const headers = await getAuthHeadersAsync();
      const CHUNK_SIZE = 20;
      let totalStagedCount = 0;
      let totalCreatedDrafts = 0;

      for (let i = 0; i < selectedFiles.length; i += CHUNK_SIZE) {
        const chunk = selectedFiles.slice(i, i + CHUNK_SIZE);
        const formData = new FormData();
        for (const f of chunk) {
          formData.append('files', f);
        }
        formData.append('autoAnalyze', autoAnalyze ? 'true' : 'false');
        formData.append('groupSameProduct', 'true');

        const res = await fetch('/api/admin/smart-assistant/ingest', {
          method: 'POST',
          headers,
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'فشل رفع دفعة الملفات.');
        }

        totalStagedCount += Number(data.staged_count || 0);
        totalCreatedDrafts += Array.isArray(data.drafts) ? data.drafts.length : 0;
        setUploadProgress({ done: Math.min(total, i + chunk.length), total });
      }

      setSelectedFiles([]);
      await loadWorkspace();
      if (autoAnalyze) setFilter('pending_review');

      const summaryMsg = autoAnalyze
        ? `تم رفع وفك ضغط (${totalStagedCount}) صورة وتجهيز (${totalCreatedDrafts}) بطاقة منتج للمراجعة. خانات الأسعار فارغة واختيارية حسب رغبتك قبل النشر.`
        : `تم رفع وفك ضغط (${totalStagedCount}) صورة بنجاح. يمكنك الآن الضغط على "تحليل وتجهيز" أو إعطاء أمر في المحادثة.`;

      setFeedback({ type: 'success', message: summaryMsg });
      setChatMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: 'assistant',
          text: summaryMsg,
          actionExecuted: autoAnalyze ? 'analyze_staged' : undefined,
          affectedCount: autoAnalyze ? totalCreatedDrafts : totalStagedCount,
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر رفع الملفات.' });
    } finally {
      setIngesting(false);
      setAnalyzing(false);
      setUploadProgress(null);
    }
  };

  const handleAnalyzeStagedNow = async () => {
    if (stagedMedia.length === 0) {
      setFeedback({ type: 'error', message: 'لا توجد صور مرفوعة بانتظار التحليل حالياً.' });
      return;
    }

    setAnalyzing(true);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/smart-assistant/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ groupSameProduct: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تحليل الصور.');

      await loadWorkspace();
      setFilter('pending_review');
      setFeedback({ type: 'success', message: data.message });
      setChatMessages((prev) => [
        ...prev,
        {
          id: `an-${Date.now()}`,
          role: 'assistant',
          text: data.message,
          actionExecuted: 'analyze_staged',
          affectedCount: Number(data.created_drafts_count || 0),
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر تحليل الصور.' });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSendCommand = async (customText?: string) => {
    const text = (customText ?? chatInput).trim();
    if (!text || chatBusy) return;

    if (!customText) setChatInput('');
    const userMsg: SmartAssistantChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatBusy(true);
    setFeedback(null);

    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/smart-assistant/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          message: text,
          selectedDraftIds: Array.from(selectedIds),
          history: chatMessages.slice(-8).map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر تنفيذ الأمر.');

      const nextDrafts: SmartAssistantDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      const nextStaged: SmartAssistantStagedMedia[] = Array.isArray(data.stagedMedia)
        ? data.stagedMedia
        : [];
      if (Array.isArray(data.duplicateGroups)) {
        setDuplicateGroups(data.duplicateGroups);
      }
      applyServerSnapshot(nextDrafts, nextStaged, true);

      if (data.actionExecuted === 'detect_duplicates' && data.duplicateGroups?.length > 0) {
        setFilter('duplicates');
      }

      setChatMessages((prev) => [
        ...prev,
        {
          id: `ast-${Date.now()}`,
          role: 'assistant',
          text: data.reply,
          actionExecuted: data.actionExecuted,
          affectedCount: Array.isArray(data.affectedIds) ? data.affectedIds.length : 0,
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          text: err?.message || 'حدث خطأ أثناء تنفيذ الأمر.',
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  const updateField = (draftId: string, field: keyof SmartDraftEditState, value: any) => {
    setEdits((prev) => ({
      ...prev,
      [draftId]: {
        ...prev[draftId],
        [field]: value,
      },
    }));
    if (field === 'original_price' && invalidDraftIds[draftId] && isOptionalPriceValid(String(value))) {
      setInvalidDraftIds((prev) => {
        const copy = { ...prev };
        delete copy[draftId];
        return copy;
      });
    }
  };

  const handleSaveDraft = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(`/api/admin/smart-assistant/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          title_ar: state.title_ar,
          description_ar: state.description_ar,
          category_id: state.category_id,
          product_type: state.product_type,
          brand: state.brand,
          size_or_volume: state.size_or_volume,
          stock_quantity: state.stock_quantity ? Number(state.stock_quantity) : 10,
          original_price: state.original_price ? Number(state.original_price) : null,
          discount_price: state.discount_price ? Number(state.discount_price) : null,
          gallery_images: state.gallery_images,
          image_url: state.gallery_images[0],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حفظ تعديلات البطاقة.');

      setDrafts((prev) => prev.map((d) => (d.id === draftId ? data.draft : d)));
      setFeedback({ type: 'success', message: 'تم حفظ التعديلات في منطقة المراجعة (لم يُنشر بعد).' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر حفظ التعديلات.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleSetMainImage = (draftId: string, chosenUrl: string) => {
    const state = edits[draftId];
    if (!state) return;
    const reordered = [chosenUrl, ...state.gallery_images.filter((u) => u !== chosenUrl)];
    updateField(draftId, 'gallery_images', reordered);
  };

  const handleRemoveGalleryImage = (draftId: string, urlToRemove: string) => {
    const state = edits[draftId];
    if (!state || state.gallery_images.length <= 1) {
      setFeedback({ type: 'error', message: 'يجب أن يحتوي المنتج على صورة واحدة على الأقل.' });
      return;
    }
    const remaining = state.gallery_images.filter((u) => u !== urlToRemove);
    updateField(draftId, 'gallery_images', remaining);
  };

  const handleUploadDraftImages = async (files: FileList) => {
    if (!imageUploadTarget || files.length === 0) return;
    const { draftId, mode } = imageUploadTarget;
    setBusyId(draftId);
    setFeedback(null);
    try {
      const formData = new FormData();
      Array.from(files).forEach((f) => formData.append('files', f));
      formData.append('mode', mode);
      const headers = await getAuthHeadersAsync();
      const res = await fetch(
        `/api/admin/smart-assistant/drafts/${encodeURIComponent(draftId)}/images`,
        { method: 'POST', headers, body: formData }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر تحديث صور المنتج.');

      setDrafts((prev) => prev.map((d) => (d.id === draftId ? data.draft : d)));
      updateField(draftId, 'gallery_images', data.draft.gallery_images);
      setFeedback({ type: 'success', message: 'تم تحديث صور المنتج بنجاح.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر رفع الصورة.' });
    } finally {
      setBusyId(null);
      setImageUploadTarget(null);
    }
  };

  const handleEnhanceSingleDraft = async (draftId: string) => {
    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(
        `/api/admin/smart-assistant/drafts/${encodeURIComponent(draftId)}/enhance`,
        { method: 'POST', headers }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر تحسين صورة المنتج.');

      setDrafts((prev) => prev.map((d) => (d.id === draftId ? data.draft : d)));
      updateField(draftId, 'gallery_images', data.draft.gallery_images);
      setFeedback({ type: 'success', message: data.message });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر تحسين الصورة.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleMergeSelectedDrafts = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length < 2) {
      setFeedback({ type: 'error', message: 'يرجى تحديد بطاقتين على الأقل لتجميع صورهما في منتج واحد.' });
      return;
    }
    setBulkBusy(true);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/smart-assistant/drafts/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ draftIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر دمج البطاقات.');

      setSelectedIds(new Set());
      await loadWorkspace();
      setFeedback({ type: 'success', message: data.message });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر تجميع البطاقات.' });
    } finally {
      setBulkBusy(false);
    }
  };

  const handlePublishSingle = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    if (!isOptionalPriceValid(state.original_price)) {
      setInvalidDraftIds((prev) => ({
        ...prev,
        [draftId]: 'إذا تم إدخال سعر، يجب أن يكون رقماً صحيحاً غير سالب.',
      }));
      setFeedback({
        type: 'error',
        message: 'يرجى إدخال قيمة سعر صالحة (0 أو أكبر)، أو ترك خانة السعر فارغة للنشر حسب الطلب.',
      });
      return;
    }

    const parsedOriginalPrice = state.original_price.trim()
      ? Number(state.original_price)
      : null;

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(
        `/api/admin/smart-assistant/drafts/${encodeURIComponent(draftId)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            approve: true,
            title_ar: state.title_ar,
            description_ar: state.description_ar,
            category_id: state.category_id,
            brand: state.brand,
            size_or_volume: state.size_or_volume,
            stock_quantity: state.stock_quantity ? Number(state.stock_quantity) : 10,
            gallery_images: state.gallery_images,
            original_price: parsedOriginalPrice,
            discount_price: state.discount_price ? Number(state.discount_price) : null,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر اعتماد ونشر المنتج.');

      const nextList = drafts.map((d) => (d.id === draftId ? data.draft : d));
      setDrafts(nextList);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
      onPendingCountChange?.(nextList.filter((d) => d.status === 'pending_review').length);
      if (data.product) onProductsPublished([data.product]);
      setFeedback({
        type: 'success',
        message: `تم اعتماد ونشر "${data.product?.title_ar || state.title_ar}" في المتجر بنجاح.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر اعتماد ونشر المنتج.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleBulkApprovePublish = async (targetDraftIds?: string[]) => {
    const ids = targetDraftIds ?? Array.from(selectedIds);
    if (ids.length === 0) {
      setFeedback({ type: 'error', message: 'يرجى تحديد منتج واحد على الأقل للاعتماد والنشر.' });
      return;
    }

    const invalidMap: Record<string, string> = {};
    const payloadItems: any[] = [];

    for (const id of ids) {
      const state = edits[id];
      const draft = drafts.find((d) => d.id === id);
      if (!state || !draft) continue;

      if (!isOptionalPriceValid(state.original_price)) {
        invalidMap[id] = 'قيمة السعر غير صالحة (يجب أن تكون رقماً غير سالب أو تركه فارغاً).';
      } else {
        payloadItems.push({
          id,
          title_ar: state.title_ar,
          description_ar: state.description_ar,
          category_id: state.category_id,
          brand: state.brand,
          size_or_volume: state.size_or_volume,
          stock_quantity: state.stock_quantity ? Number(state.stock_quantity) : 10,
          gallery_images: state.gallery_images,
          original_price: state.original_price.trim() ? Number(state.original_price) : null,
          discount_price: state.discount_price ? Number(state.discount_price) : null,
        });
      }
    }

    if (Object.keys(invalidMap).length > 0) {
      setInvalidDraftIds((prev) => ({ ...prev, ...invalidMap }));
      setFeedback({
        type: 'error',
        message: `تعذر النشر الجماعي: يوجد (${Object.keys(invalidMap).length}) منتج بقيمة سعر غير صالحة.`,
      });
      return;
    }

    setBulkBusy(true);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/smart-assistant/drafts/bulk-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ approve: true, items: payloadItems }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (Array.isArray(data.invalidItems)) {
          const serverMap: Record<string, string> = {};
          for (const it of data.invalidItems) serverMap[it.id] = it.reason;
          setInvalidDraftIds((prev) => ({ ...prev, ...serverMap }));
        }
        throw new Error(data.error || 'تعذر الاعتماد الجماعي.');
      }

      const publishedDrafts: SmartAssistantDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      const publishedProducts: Product[] = Array.isArray(data.products) ? data.products : [];
      const byId = new Map(publishedDrafts.map((d) => [d.id, d]));
      const nextList = drafts.map((d) => byId.get(d.id) || d);
      setDrafts(nextList);
      setSelectedIds(new Set());
      onPendingCountChange?.(nextList.filter((d) => d.status === 'pending_review').length);
      if (publishedProducts.length > 0) onProductsPublished(publishedProducts);
      setFeedback({
        type: 'success',
        message: `تم اعتماد ونشر (${publishedProducts.length}) منتج بنجاح في المتجر.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر النشر الجماعي.' });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDeleteDraft = async (draftId: string) => {
    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(`/api/admin/smart-assistant/drafts/${encodeURIComponent(draftId)}`, {
        method: 'DELETE',
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حذف المسودة.');

      const nextList = drafts.filter((d) => d.id !== draftId);
      setDrafts(nextList);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
      onPendingCountChange?.(nextList.filter((d) => d.status === 'pending_review').length);
      setFeedback({ type: 'success', message: 'تم حذف بطاقة المسودة.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر حذف البطاقة.' });
    } finally {
      setBusyId(null);
    }
  };

  const pendingDrafts = drafts.filter((d) => d.status === 'pending_review');
  const duplicateDrafts = drafts.filter((d) => d.status === 'pending_review' && Boolean(d.duplicate_group_id));
  const publishedDrafts = drafts.filter((d) => d.status === 'approved_published');

  const visibleDrafts = drafts.filter((d) => {
    if (filter === 'pending_review' && d.status !== 'pending_review') return false;
    if (filter === 'approved_published' && d.status !== 'approved_published') return false;
    if (filter === 'duplicates' && (!d.duplicate_group_id || d.status !== 'pending_review')) return false;
    if (categoryFilter !== 'all' && d.category_id !== categoryFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        d.title_ar.toLowerCase().includes(q) ||
        d.brand.toLowerCase().includes(q) ||
        d.product_type.toLowerCase().includes(q) ||
        d.source_filename.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const selectablePending = visibleDrafts.filter((d) => d.status === 'pending_review');
  const allPendingSelected =
    selectablePending.length > 0 && selectablePending.every((d) => selectedIds.has(d.id));

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectablePending.map((d) => d.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div dir="rtl" className="space-y-6">
      {/* Hidden input for per-product replacement/gallery image upload */}
      <input
        ref={perDraftImageInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            handleUploadDraftImages(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Page Header */}
      <section className="bg-white rounded-2xl border border-stone-200 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-stone-900">
              المساعد الذكي الشامل – AI Smart Assistant
            </h2>
            <p className="text-xs text-stone-500 leading-relaxed max-w-3xl">
              ارفع مئات الصور أو ملفات ZIP ليقوم المساعد بفك الضغط، استخراج كل منتج، تجميع الصور المتعددة التابعة للمنتج الواحد، وتحسينها وتصنيفها عبر المحادثة. تبقى خانة السعر اختيارية حسب رغبتك ولا يُنشر أي منتج قبل موافقتك الصريحة.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600 tabular-nums shrink-0">
            <span>قيد المراجعة: {pendingDrafts.length}</span>
            <span aria-hidden="true">·</span>
            <span>صور بانتظار التحليل: {stagedMedia.length}</span>
            <span aria-hidden="true">·</span>
            <span>مكررات مرصودة: {duplicateDrafts.length}</span>
            <span aria-hidden="true">·</span>
            <span>منشورة: {publishedDrafts.length}</span>
          </div>
        </div>
      </section>

      {feedback && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs font-bold flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Main 2-Column Workspace: Left Review & Upload (8 cols) + Right Conversational Assistant (4 cols) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left Workbench: Upload + Staged + Review Cards */}
        <div className="xl:col-span-8 space-y-6">
          {/* Batch Upload & ZIP Extraction Surface */}
          <section className="bg-white rounded-2xl border border-stone-200 p-6 space-y-5">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (e.dataTransfer.files?.length) addCandidateFiles(e.dataTransfer.files);
              }}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
                isDragging
                  ? 'border-rose-500 bg-rose-50/40'
                  : 'border-stone-300 bg-stone-50/60 hover:border-stone-400'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,.zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    addCandidateFiles(e.target.files);
                    e.target.value = '';
                  }
                }}
              />

              <div className="max-w-xl mx-auto space-y-3">
                <div className="w-11 h-11 rounded-xl bg-stone-900 text-white flex items-center justify-center mx-auto">
                  <Upload className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-stone-900">
                    اسحب وأفلت آلاف الصور أو ملفات ZIP هنا
                  </p>
                  <p className="text-xs text-stone-500">
                    رفع متدرج بالدفعات · فك ضغط تلقائي · تجميع صور المنتج الواحد · السعر اختياري ولا يُفرض تلقائياً
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    اختيار صور أو ملفات ZIP
                  </button>

                  {selectedFiles.length > 0 && (
                    <>
                      <button
                        type="button"
                        disabled={ingesting}
                        onClick={() => handleUploadSelected(true)}
                        className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white text-xs font-bold whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        {ingesting && analyzing ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        <span>رفع وتحليل وتجهيز تلقائي ({selectedFiles.length})</span>
                      </button>

                      <button
                        type="button"
                        disabled={ingesting}
                        onClick={() => handleUploadSelected(false)}
                        className="px-4 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 disabled:opacity-60 text-stone-800 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                      >
                        رفع وفك الضغط فقط (لأوامر المحادثة)
                      </button>
                    </>
                  )}
                </div>

                {uploadProgress && (
                  <div className="pt-2 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-bold text-stone-700 tabular-nums">
                      <span>جاري رفع ومعالجة الملفات بالدفعات...</span>
                      <span>
                        {uploadProgress.done} / {uploadProgress.total}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-stone-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-rose-600 transition-all"
                        style={{
                          width: `${Math.round(
                            (uploadProgress.done / Math.max(1, uploadProgress.total)) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Queued Selected Files */}
            {selectedFiles.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-stone-600">
                  <span className="font-bold tabular-nums">
                    ملفات جاهزة للرفع ({selectedFiles.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedFiles([])}
                    className="text-rose-600 hover:text-rose-700 font-semibold cursor-pointer"
                  >
                    مسح القائمة
                  </button>
                </div>
                <div className="divide-y divide-stone-100 border border-stone-200 rounded-xl bg-white max-h-40 overflow-y-auto">
                  {selectedFiles.slice(0, 60).map((file, idx) => {
                    const isZip = file.name.toLowerCase().endsWith('.zip');
                    return (
                      <div
                        key={`${file.name}-${idx}`}
                        className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {isZip ? (
                            <FileArchive className="w-4 h-4 text-amber-600 shrink-0" />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-stone-500 shrink-0" />
                          )}
                          <span className="font-semibold text-stone-800 truncate">{file.name}</span>
                          <span className="text-stone-400 tabular-nums shrink-0">
                            {formatBytes(file.size)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))
                          }
                          aria-label={`إزالة ${file.name}`}
                          className="p-1 text-stone-400 hover:text-rose-600 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                  {selectedFiles.length > 60 && (
                    <div className="px-3.5 py-2 text-xs text-stone-500 text-center tabular-nums">
                      + {selectedFiles.length - 60} ملف آخر ضمن نفس الدفعة
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Staged Unanalyzed Media Notice */}
            {stagedMedia.length > 0 && (
              <div className="border border-stone-200 rounded-xl p-4 bg-stone-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-stone-900 tabular-nums">
                    يوجد ({stagedMedia.length}) صورة مرفوعة ومفكوكة الضغط بانتظار التحليل
                  </p>
                  <p className="text-xs text-stone-500">
                    يمكنك تحليلها الآن أو طلب "حلل هذه الصور" من المساعد بالمحادثة.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={analyzing}
                  onClick={handleAnalyzeStagedNow}
                  className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white text-xs font-bold whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  {analyzing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  <span>تحليل وتجهيز الكل الآن</span>
                </button>
              </div>
            )}
          </section>

          {/* Review & Full Manual Control Section */}
          <section className="bg-white rounded-2xl border border-stone-200 p-6 space-y-5">
            {/* Filter Tabs & Batch Actions */}
            <div className="space-y-4 border-b border-stone-100 pb-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-100 rounded-lg w-fit">
                  <button
                    type="button"
                    onClick={() => setFilter('pending_review')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors tabular-nums ${
                      filter === 'pending_review'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    قيد المراجعة ({pendingDrafts.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter('duplicates')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors tabular-nums ${
                      filter === 'duplicates'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    مكررات ({duplicateDrafts.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter('approved_published')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors tabular-nums ${
                      filter === 'approved_published'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    تم نشرها ({publishedDrafts.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter('all')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors tabular-nums ${
                      filter === 'all'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    الكل ({drafts.length})
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-stone-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="بحث بالاسم أو العلامة..."
                      className="pr-8 pl-3 py-1.5 border border-stone-200 rounded-lg text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden w-44"
                    />
                  </div>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    aria-label="تصفية حسب التصنيف"
                    className="px-2.5 py-1.5 border border-stone-200 rounded-lg text-xs font-semibold bg-white text-stone-700 focus:border-rose-500 focus:outline-hidden"
                  >
                    <option value="all">جميع التصنيفات</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name_ar}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={loadWorkspace}
                    disabled={loading}
                    aria-label="تحديث البيانات"
                    className="p-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-stone-600 cursor-pointer"
                  >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {selectablePending.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={toggleSelectAll}
                      className="px-3 py-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-xs font-bold text-stone-700 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {allPendingSelected ? (
                        <CheckSquare className="w-4 h-4 text-rose-600" />
                      ) : (
                        <Square className="w-4 h-4 text-stone-400" />
                      )}
                      <span>{allPendingSelected ? 'إلغاء تحديد الكل' : 'تحديد الكل'}</span>
                    </button>

                    {selectedIds.size >= 2 && (
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={handleMergeSelectedDrafts}
                        className="px-3 py-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-xs font-bold text-stone-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Layers className="w-3.5 h-3.5 text-stone-600" />
                        <span>تجميع المحددة في منتج واحد ({selectedIds.size})</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={bulkBusy || selectedIds.size === 0}
                      onClick={() => handleBulkApprovePublish()}
                      className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                    >
                      {bulkBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>اعتماد ونشر المحددة ({selectedIds.size})</span>
                    </button>

                    <button
                      type="button"
                      disabled={bulkBusy || selectablePending.length === 0}
                      onClick={() => handleBulkApprovePublish(selectablePending.map((d) => d.id))}
                      className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                    >
                      <span>الموافقة ونشر الجميع ({selectablePending.length})</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Duplicate Groups Alert Summary */}
            {duplicateGroups.length > 0 && filter === 'duplicates' && (
              <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-3">
                <span className="font-bold">
                  تم رصد ({duplicateGroups.length}) مجموعات صور مكررة أو متطابقة بصرياً.
                </span>
                <button
                  type="button"
                  disabled={chatBusy}
                  onClick={() => handleSendCommand('احذف الصور المكررة وادمجها')}
                  className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  دمج وإزالة المكررات تلقائياً
                </button>
              </div>
            )}

            {/* Product Cards List */}
            {loading ? (
              <div className="py-12 text-center text-xs text-stone-500 flex flex-col items-center gap-2">
                <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
                <span>جاري تحميل بطاقات المنتجات...</span>
              </div>
            ) : visibleDrafts.length === 0 ? (
              <div className="py-12 text-center space-y-2 text-stone-500">
                <PackageCheck className="w-10 h-10 mx-auto text-stone-300" />
                <p className="text-sm font-bold text-stone-700">
                  لا توجد منتجات في هذا العرض حالياً
                </p>
                <p className="text-xs text-stone-500">
                  ارفع صوراً أو ملف ZIP بالأعلى، أو استخدم المحادثة لتحليل الصور المرفوعة وتجهيزها للمراجعة.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-stone-200">
                {visibleDrafts.map((draft) => {
                  const state = edits[draft.id];
                  if (!state) return null;
                  const isBusy = busyId === draft.id || bulkBusy;
                  const isSelected = selectedIds.has(draft.id);
                  const priceValid = isOptionalPriceValid(state.original_price);
                  const rowError = invalidDraftIds[draft.id];
                  const isPublished = draft.status === 'approved_published';
                  const mainImg = state.gallery_images[0] || draft.image_url;

                  return (
                    <article key={draft.id} className="py-6 first:pt-2 last:pb-2 space-y-4">
                      {/* Card Metadata Line (Unboxed typographic separators) */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
                          {!isPublished && (
                            <button
                              type="button"
                              onClick={() => toggleSelectOne(draft.id)}
                              aria-label={`تحديد ${state.title_ar}`}
                              className="text-stone-700 hover:text-rose-600 cursor-pointer flex items-center"
                            >
                              {isSelected ? (
                                <CheckSquare className="w-4 h-4 text-rose-600" />
                              ) : (
                                <Square className="w-4 h-4 text-stone-400" />
                              )}
                            </button>
                          )}
                          <span className="font-bold text-stone-900">
                            {isPublished ? 'منشور في المتجر' : 'مسودة للمراجعة'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {state.gallery_images.length} صورة
                          </span>
                          {draft.enhanced && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-emerald-700 font-semibold">صور محسّنة</span>
                            </>
                          )}
                          {draft.duplicate_group_id && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-700 font-bold">تكرار مرصود</span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>{draft.source_filename}</span>
                        </div>

                        <span className="text-xs text-stone-400 tabular-nums">
                          {new Date(draft.created_at).toLocaleString('ar-YE')}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                        {/* Gallery & Image Management Column */}
                        <div className="lg:col-span-4 space-y-2.5">
                          {brokenImages.has(`${draft.id}-${mainImg}`) ? (
                            <div className="w-full aspect-4/3 rounded-xl border border-stone-200 bg-stone-100 flex flex-col items-center justify-center p-4 text-center text-stone-500 gap-2">
                              <ImageIcon className="w-6 h-6 text-stone-400" />
                              <span className="text-xs font-medium line-clamp-2">{state.title_ar}</span>
                            </div>
                          ) : (
                            <img
                              src={mainImg}
                              alt={state.title_ar}
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setBrokenImages((prev) =>
                                  new Set(prev).add(`${draft.id}-${mainImg}`)
                                )
                              }
                              className="w-full aspect-4/3 rounded-xl object-cover border border-stone-200 bg-stone-50"
                            />
                          )}

                          {/* Multi-Image Thumbnails */}
                          {state.gallery_images.length > 1 && (
                            <div className="grid grid-cols-4 gap-1.5">
                              {state.gallery_images.map((imgUrl, idx) => (
                                <div
                                  key={`${imgUrl}-${idx}`}
                                  className={`relative group rounded-lg overflow-hidden border ${
                                    idx === 0 ? 'border-rose-500' : 'border-stone-200'
                                  }`}
                                >
                                  <img
                                    src={imgUrl}
                                    alt={`${state.title_ar} - ${idx + 1}`}
                                    referrerPolicy="no-referrer"
                                    className="w-full h-12 object-cover"
                                  />
                                  {idx !== 0 && (
                                    <button
                                      type="button"
                                      onClick={() => handleSetMainImage(draft.id, imgUrl)}
                                      title="تعيين كصورة رئيسية"
                                      className="absolute bottom-0.5 right-0.5 p-0.5 rounded bg-stone-900/75 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                    >
                                      <Star className="w-3 h-3" />
                                    </button>
                                  )}
                                  {state.gallery_images.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveGalleryImage(draft.id, imgUrl)}
                                      title="إزالة الصورة"
                                      className="absolute top-0.5 left-0.5 p-0.5 rounded bg-rose-600/85 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Per-product Image Tools */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => {
                                setImageUploadTarget({ draftId: draft.id, mode: 'replace' });
                                perDraftImageInputRef.current?.click();
                              }}
                              className="px-2.5 py-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-[11px] font-bold text-stone-700 cursor-pointer"
                            >
                              استبدال الرئيسية
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => {
                                setImageUploadTarget({ draftId: draft.id, mode: 'append' });
                                perDraftImageInputRef.current?.click();
                              }}
                              className="px-2.5 py-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-[11px] font-bold text-stone-700 cursor-pointer"
                            >
                              + صورة إضافية
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleEnhanceSingleDraft(draft.id)}
                              className="px-2.5 py-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-[11px] font-bold text-stone-700 flex items-center gap-1 cursor-pointer"
                            >
                              <Wand2 className="w-3 h-3" />
                              <span>تحسين</span>
                            </button>
                          </div>
                        </div>

                        {/* Editable Product Metadata & Optional Manual Pricing */}
                        <div className="lg:col-span-8 space-y-3.5">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="sm:col-span-2">
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                اسم المنتج (عربي)
                              </label>
                              <input
                                type="text"
                                value={state.title_ar}
                                onChange={(e) => updateField(draft.id, 'title_ar', e.target.value)}
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs font-semibold text-stone-900 focus:border-rose-500 focus:outline-hidden"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                التصنيف
                              </label>
                              <select
                                value={state.category_id}
                                onChange={(e) => updateField(draft.id, 'category_id', e.target.value)}
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs font-semibold bg-white text-stone-900 focus:border-rose-500 focus:outline-hidden"
                              >
                                {categories.map((cat) => (
                                  <option key={cat.id} value={cat.id}>
                                    {cat.name_ar}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                نوع المنتج
                              </label>
                              <input
                                type="text"
                                value={state.product_type}
                                onChange={(e) =>
                                  updateField(draft.id, 'product_type', e.target.value)
                                }
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                العلامة التجارية
                              </label>
                              <input
                                type="text"
                                value={state.brand}
                                onChange={(e) => updateField(draft.id, 'brand', e.target.value)}
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                الحجم / السعة
                              </label>
                              <input
                                type="text"
                                value={state.size_or_volume}
                                onChange={(e) =>
                                  updateField(draft.id, 'size_or_volume', e.target.value)
                                }
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden"
                              />
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-bold text-stone-700 mb-1">
                              الوصف التسويقي والتفاصيل
                            </label>
                            <textarea
                              rows={2}
                              value={state.description_ar}
                              onChange={(e) =>
                                updateField(draft.id, 'description_ar', e.target.value)
                              }
                              className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden"
                            />
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                السعر ({settings.currency}) — اختياري (حسب الرغبة)
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                placeholder="اختياري — اتركه فارغاً أو أدخل السعر"
                                value={state.original_price}
                                onChange={(e) =>
                                  updateField(draft.id, 'original_price', e.target.value)
                                }
                                className={`w-full border rounded-lg px-3 py-2 text-xs font-bold tabular-nums focus:outline-hidden ${
                                  !priceValid || rowError
                                    ? 'border-rose-400 bg-rose-50/50 focus:border-rose-500'
                                    : 'border-stone-200 bg-white focus:border-rose-500'
                                }`}
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                سعر العرض (اختياري)
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                placeholder="اختياري"
                                value={state.discount_price}
                                onChange={(e) =>
                                  updateField(draft.id, 'discount_price', e.target.value)
                                }
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs font-semibold tabular-nums focus:border-rose-500 focus:outline-hidden"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-stone-700 mb-1">
                                الكمية بالمخزون
                              </label>
                              <input
                                type="number"
                                min="1"
                                value={state.stock_quantity}
                                onChange={(e) =>
                                  updateField(draft.id, 'stock_quantity', e.target.value)
                                }
                                className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs font-semibold tabular-nums focus:border-rose-500 focus:outline-hidden"
                              />
                            </div>
                          </div>

                          {(!priceValid || rowError) ? (
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700">
                              <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                              <span>
                                {rowError || 'يرجى إدخال رقم صحيح غير سالب أو ترك خانة السعر فارغة.'}
                              </span>
                            </div>
                          ) : !state.original_price.trim() ? (
                            <p className="text-[11px] text-stone-500">
                              السعر اختياري: يمكنك تركه فارغاً للنشر كـ «السعر حسب الطلب عبر واتساب» أو إدخال سعر يدوي.
                            </p>
                          ) : null}

                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleDeleteDraft(draft.id)}
                              className="px-3.5 py-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>حذف</span>
                            </button>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleSaveDraft(draft.id)}
                              className="px-4 py-2 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-800 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Save className="w-3.5 h-3.5" />
                              <span>حفظ التعديلات</span>
                            </button>

                            <button
                              type="button"
                              disabled={isBusy || !priceValid}
                              onClick={() => handlePublishSingle(draft.id)}
                              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-300 disabled:text-stone-600 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                            >
                              {isBusy ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Send className="w-3.5 h-3.5" />
                              )}
                              <span>
                                {isPublished ? 'تحديث المنتج المنشور' : 'اعتماد ونشر في المتجر'}
                              </span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Right Sticky Panel: Conversational Arabic AI Command Assistant */}
        <aside className="xl:col-span-4 xl:sticky xl:top-24 bg-white rounded-2xl border border-stone-200 flex flex-col h-[680px]">
          <div className="p-4 border-b border-stone-100 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-stone-900 text-white flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-stone-900 truncate">
                  المساعد بالمحادثة المباشرة
                </h3>
                <p className="text-[11px] text-stone-500 truncate tabular-nums">
                  {selectedIds.size > 0
                    ? `النطاق: (${selectedIds.size}) منتجات محددة`
                    : `النطاق: جميع المسودات (${pendingDrafts.length})`}
                </p>
              </div>
            </div>
          </div>

          {/* Quick Executable Command Buttons */}
          <div className="p-3 border-b border-stone-100 bg-stone-50/70">
            <p className="text-[11px] font-bold text-stone-500 mb-2">أوامر تنفيذية سريعة:</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_COMMANDS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={chatBusy}
                  onClick={() => handleSendCommand(item.command)}
                  className="px-2.5 py-1.5 rounded-lg bg-white border border-stone-200 hover:border-rose-400 hover:text-rose-700 text-[11px] font-bold text-stone-700 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Chat Thread */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatMessages.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-start' : 'items-end'}`}
                >
                  <div
                    className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                      isUser
                        ? 'bg-stone-900 text-white'
                        : 'bg-stone-100 text-stone-800 border border-stone-200'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                    {!isUser && msg.actionExecuted && (
                      <div className="mt-2 pt-1.5 border-t border-stone-200/80 text-[11px] text-stone-600 flex items-center gap-1.5 tabular-nums">
                        <span className="font-bold">
                          {ACTION_LABELS[msg.actionExecuted] || msg.actionExecuted}
                        </span>
                        {typeof msg.affectedCount === 'number' && msg.affectedCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{msg.affectedCount} عنصر</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {chatBusy && (
              <div className="flex items-center gap-2 text-xs text-stone-500">
                <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
                <span>جاري تنفيذ الأمر على المنتجات...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendCommand();
            }}
            className="p-3 border-t border-stone-100 flex items-center gap-2"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="اكتب أمراً للمساعد بالعربية..."
              disabled={chatBusy}
              className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-900 focus:border-rose-500 focus:outline-hidden"
            />
            <button
              type="submit"
              disabled={chatBusy || !chatInput.trim()}
              aria-label="إرسال الأمر"
              className="px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>تنفيذ</span>
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
};

export default AdminSmartAssistantPage;
