import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bot,
  Clock,
  CheckCircle2,
  Trash2,
  Save,
  Send,
  RefreshCw,
  Loader2,
  AlertCircle,
  Tag,
  PackageCheck,
  ImagePlus,
  Link as LinkIcon,
  Star,
  X,
} from 'lucide-react';
import type { Category, EmployeeDraft, Product, StoreSettings } from '../types';
import { getAuthHeadersAsync } from '../lib/storage';
import { compressImageFileToDataUrl } from '../lib/imageCompression';
import {
  deleteEmployeeDraftFirestore,
  fetchEmployeeDraftsFirestore,
  syncEmployeeDraftFirestore,
} from '../lib/firebase';

interface EmployeeDraftsReviewPanelProps {
  categories: Category[];
  settings: StoreSettings;
  onDraftPublished: (product: Product) => void;
  onPendingCountChange: (count: number) => void;
  refreshTrigger?: number;
}

interface DraftEditState {
  title_ar: string;
  description_ar: string;
  category_id: string;
  brand: string;
  size_or_volume: string;
  ingredients: string;
  how_to_use: string;
  tags_text: string;
  image_url: string;
  gallery_images: string[];
  original_price: string;
  discount_price: string;
  stock_quantity: string;
}

function buildEditStateFromDraft(d: EmployeeDraft): DraftEditState {
  const primary = d.image_url || d.gallery_images?.[0] || '';
  const gallery =
    Array.isArray(d.gallery_images) && d.gallery_images.length > 0
      ? d.gallery_images
      : primary
        ? [primary]
        : [];
  return {
    title_ar: d.title_ar || '',
    description_ar: d.description_ar || '',
    category_id: d.category_id || 'skincare',
    brand: d.brand || '',
    size_or_volume: d.size_or_volume || '',
    ingredients: d.ingredients || '',
    how_to_use: d.how_to_use || '',
    tags_text: Array.isArray(d.tags) ? d.tags.join('، ') : '',
    image_url: primary,
    gallery_images: gallery,
    original_price: d.original_price ? String(d.original_price) : '',
    discount_price: d.discount_price ? String(d.discount_price) : '',
    stock_quantity:
      d.stock_quantity !== undefined && d.stock_quantity !== null
        ? String(d.stock_quantity)
        : '10',
  };
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(/[،,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function isSafeImageInput(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('blob:')) return false;
  return (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('/') ||
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(trimmed)
  );
}

function getDraftCompletionStatus(state: DraftEditState): {
  isComplete: boolean;
  missingLabels: string[];
  discountError: string | null;
} {
  const missing: string[] = [];
  if (!state.title_ar.trim()) missing.push('اسم المنتج');
  if (!state.category_id.trim()) missing.push('التصنيف');
  if (!state.description_ar.trim()) missing.push('الوصف');

  const hasValidImage =
    isSafeImageInput(state.image_url) ||
    state.gallery_images.some((img) => isSafeImageInput(img));
  if (!hasValidImage) missing.push('صورة واحدة على الأقل');

  const priceNum = Number(state.original_price);
  if (!state.original_price.trim() || !Number.isFinite(priceNum) || priceNum <= 0) {
    missing.push('السعر الأصلي');
  }

  const stockNum = Number(state.stock_quantity);
  if (!state.stock_quantity.trim() || !Number.isFinite(stockNum) || stockNum < 1) {
    missing.push('المخزون (1 على الأقل)');
  }

  let discountError: string | null = null;
  if (state.discount_price.trim()) {
    const discNum = Number(state.discount_price);
    if (!Number.isFinite(discNum) || discNum <= 0) {
      discountError = 'سعر الخصم يجب أن يكون أكبر من صفر';
    } else if (Number.isFinite(priceNum) && priceNum > 0 && discNum >= priceNum) {
      discountError = 'سعر الخصم يجب أن يكون أقل من السعر الأصلي';
    }
  }

  return {
    isComplete: missing.length === 0 && !discountError,
    missingLabels: missing,
    discountError,
  };
}

export const EmployeeDraftsReviewPanel: React.FC<EmployeeDraftsReviewPanelProps> = ({
  categories,
  settings,
  onDraftPublished,
  onPendingCountChange,
  refreshTrigger = 0,
}) => {
  const [drafts, setDrafts] = useState<EmployeeDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending_pricing' | 'published'>('pending_pricing');
  const [edits, setEdits] = useState<Record<string, DraftEditState>>({});
  const [imageUrlInputs, setImageUrlInputs] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  // Track which drafts have unsaved local edits so background polling never overwrites user input
  const dirtyIdsRef = useRef<Set<string>>(new Set());

  const loadDrafts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/employee-assistant/drafts', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        const errPayload = await res.json().catch(() => null);
        if (res.status === 401 || res.status === 403) {
          throw new Error(
            errPayload?.error ||
              'تعذر التحقق من جلسة الإدارة لتحميل منتجات مساعد الموظفين. يرجى إعادة تسجيل الدخول.'
          );
        }
        throw new Error(errPayload?.error || `تعذر تحميل منتجات مساعد الموظفين (رمز الحالة: ${res.status}).`);
      }
      const data = await res.json();
      const serverList: EmployeeDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      const byId = new Map<string, EmployeeDraft>();
      for (const item of serverList) {
        if (item?.id) byId.set(item.id, item);
      }

      // Merge any Firestore-only drafts when a Firebase Admin session is active
      if (!silent || serverList.length === 0) {
        const fsDrafts = await fetchEmployeeDraftsFirestore().catch(() => []);
        for (const fsItem of fsDrafts) {
          if (fsItem?.id && !byId.has(fsItem.id)) {
            byId.set(fsItem.id, fsItem);
          }
        }
      }

      const list = Array.from(byId.values()).sort((a, b) => {
        const tb = new Date(b.created_at).getTime();
        const ta = new Date(a.created_at).getTime();
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      });

      setDrafts(list);
      onPendingCountChange(list.filter((d) => d.status === 'pending_pricing').length);
      setFeedback((prev) => (prev?.type === 'error' ? null : prev));

      setEdits((prev) => {
        const next: Record<string, DraftEditState> = {};
        for (const d of list) {
          if (dirtyIdsRef.current.has(d.id) && prev[d.id]) {
            next[d.id] = prev[d.id];
          } else {
            next[d.id] = buildEditStateFromDraft(d);
          }
        }
        return next;
      });
    } catch (err: any) {
      if (!silent) {
        setFeedback({ type: 'error', message: err?.message || 'خطأ في تحميل منتجات مساعد الموظفين.' });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onPendingCountChange]);

  useEffect(() => {
    loadDrafts(false);
  }, [loadDrafts, refreshTrigger]);

  // Auto-sync newly saved employee products automatically without manual transfer
  useEffect(() => {
    const onFocus = () => {
      loadDrafts(true);
    };
    window.addEventListener('focus', onFocus);
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadDrafts(true);
      }
    }, 15000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [loadDrafts]);

  const updateEditField = <K extends keyof DraftEditState>(
    draftId: string,
    field: K,
    value: DraftEditState[K]
  ) => {
    dirtyIdsRef.current.add(draftId);
    setEdits((prev) => ({
      ...prev,
      [draftId]: {
        ...prev[draftId],
        [field]: value,
      },
    }));
  };

  const handleUploadDraftImages = async (
    draftId: string,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    try {
      const compressed: string[] = [];
      for (const file of files.slice(0, 6)) {
        if (!file.type.startsWith('image/')) continue;
        const dataUrl = await compressImageFileToDataUrl(file, {
          maxDimension: 900,
          maxDataUrlLength: 240_000,
          initialQuality: 0.78,
        });
        compressed.push(dataUrl);
      }
      if (compressed.length === 0) return;

      dirtyIdsRef.current.add(draftId);
      setEdits((prev) => {
        const cur = prev[draftId];
        if (!cur) return prev;
        const mergedGallery = Array.from(new Set([...cur.gallery_images, ...compressed])).slice(0, 10);
        const nextPrimary = isSafeImageInput(cur.image_url) ? cur.image_url : mergedGallery[0];
        return {
          ...prev,
          [draftId]: {
            ...cur,
            image_url: nextPrimary,
            gallery_images: mergedGallery,
          },
        };
      });
    } catch {
      setFeedback({ type: 'error', message: 'تعذر ضغط أو إضافة الصورة المختارة.' });
    }
  };

  const handleAddImageUrl = (draftId: string) => {
    const raw = (imageUrlInputs[draftId] || '').trim();
    if (!isSafeImageInput(raw)) {
      setFeedback({
        type: 'error',
        message: 'يرجى إدخال رابط صورة صالح يبدأ بـ https:// أو http://.',
      });
      return;
    }
    dirtyIdsRef.current.add(draftId);
    setEdits((prev) => {
      const cur = prev[draftId];
      if (!cur) return prev;
      const mergedGallery = Array.from(new Set([...cur.gallery_images, raw])).slice(0, 10);
      return {
        ...prev,
        [draftId]: {
          ...cur,
          image_url: isSafeImageInput(cur.image_url) ? cur.image_url : raw,
          gallery_images: mergedGallery,
        },
      };
    });
    setImageUrlInputs((prev) => ({ ...prev, [draftId]: '' }));
    setFeedback(null);
  };

  const handleSetPrimaryImage = (draftId: string, imgUrl: string) => {
    dirtyIdsRef.current.add(draftId);
    setEdits((prev) => {
      const cur = prev[draftId];
      if (!cur) return prev;
      const reordered = [imgUrl, ...cur.gallery_images.filter((g) => g !== imgUrl)];
      return {
        ...prev,
        [draftId]: {
          ...cur,
          image_url: imgUrl,
          gallery_images: reordered,
        },
      };
    });
  };

  const handleRemoveImage = (draftId: string, imgUrl: string) => {
    dirtyIdsRef.current.add(draftId);
    setEdits((prev) => {
      const cur = prev[draftId];
      if (!cur) return prev;
      const remaining = cur.gallery_images.filter((g) => g !== imgUrl);
      const nextPrimary = cur.image_url === imgUrl ? (remaining[0] || '') : cur.image_url;
      return {
        ...prev,
        [draftId]: {
          ...cur,
          image_url: nextPrimary,
          gallery_images: remaining,
        },
      };
    });
  };

  const handleSaveEdit = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    if (state.discount_price.trim() && state.original_price.trim()) {
      const p = Number(state.original_price);
      const d = Number(state.discount_price);
      if (Number.isFinite(p) && Number.isFinite(d) && d >= p) {
        setFeedback({ type: 'error', message: 'سعر الخصم يجب أن يكون أقل من السعر الأصلي.' });
        return;
      }
    }

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const selectedCat = categories.find((c) => c.id === state.category_id);
      const res = await fetch(`/api/employee-assistant/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          title_ar: state.title_ar,
          description_ar: state.description_ar,
          category_id: state.category_id,
          category_name: selectedCat?.name_ar,
          brand: state.brand,
          size_or_volume: state.size_or_volume,
          ingredients: state.ingredients,
          how_to_use: state.how_to_use,
          tags: parseTagsInput(state.tags_text),
          image_url: state.image_url,
          gallery_images: state.gallery_images,
          original_price: state.original_price ? Number(state.original_price) : null,
          discount_price: state.discount_price ? Number(state.discount_price) : null,
          stock_quantity: state.stock_quantity ? Math.max(0, Math.floor(Number(state.stock_quantity))) : 10,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حفظ التعديلات.');

      dirtyIdsRef.current.delete(draftId);
      const updatedDraft: EmployeeDraft = data.draft;
      setDrafts((prev) => prev.map((d) => (d.id === draftId ? updatedDraft : d)));
      setEdits((prev) => ({ ...prev, [draftId]: buildEditStateFromDraft(updatedDraft) }));
      syncEmployeeDraftFirestore(updatedDraft).catch(() => {});
      setFeedback({ type: 'success', message: 'تم حفظ تعديلات المنتج في قاعدة البيانات بنجاح.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر تحديث بيانات المنتج.' });
    } finally {
      setBusyId(null);
    }
  };

  const handlePublish = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    const completion = getDraftCompletionStatus(state);
    if (!completion.isComplete) {
      setFeedback({
        type: 'error',
        message:
          completion.discountError ||
          `يرجى استكمال البيانات التالية قبل النشر: ${completion.missingLabels.join('، ')}`,
      });
      return;
    }

    const priceNum = Number(state.original_price);
    const stockNum = Math.max(1, Math.floor(Number(state.stock_quantity)));

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const selectedCat = categories.find((c) => c.id === state.category_id);
      const res = await fetch(
        `/api/employee-assistant/drafts/${encodeURIComponent(draftId)}/publish`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            title_ar: state.title_ar,
            description_ar: state.description_ar,
            category_id: state.category_id,
            category_name: selectedCat?.name_ar,
            brand: state.brand,
            size_or_volume: state.size_or_volume,
            ingredients: state.ingredients,
            how_to_use: state.how_to_use,
            tags: parseTagsInput(state.tags_text),
            image_url: state.image_url,
            gallery_images: state.gallery_images,
            original_price: priceNum,
            discount_price: state.discount_price ? Number(state.discount_price) : null,
            stock_quantity: stockNum,
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر نشر المنتج.');

      dirtyIdsRef.current.delete(draftId);
      const updatedDraft: EmployeeDraft = data.draft;
      const nextList = drafts.map((d) => (d.id === draftId ? updatedDraft : d));
      setDrafts(nextList);
      setEdits((prev) => ({ ...prev, [draftId]: buildEditStateFromDraft(updatedDraft) }));
      onPendingCountChange(nextList.filter((d) => d.status === 'pending_pricing').length);
      syncEmployeeDraftFirestore(updatedDraft).catch(() => {});

      if (data.product) {
        onDraftPublished(data.product);
      }
      setFeedback({
        type: 'success',
        message: `تم اعتماد ونشر "${data.product?.title_ar || state.title_ar}" في المتجر مباشرة!`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر نشر المنتج.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (draftId: string) => {
    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(`/api/employee-assistant/drafts/${encodeURIComponent(draftId)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حذف المنتج.');

      dirtyIdsRef.current.delete(draftId);
      const nextList = drafts.filter((d) => d.id !== draftId);
      setDrafts(nextList);
      onPendingCountChange(nextList.filter((d) => d.status === 'pending_pricing').length);
      deleteEmployeeDraftFirestore(draftId).catch(() => {});
      setFeedback({ type: 'success', message: 'تم حذف المسودة بنجاح.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر حذف المسودة.' });
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = drafts.filter((d) => d.status === 'pending_pricing').length;
  const visibleDrafts = drafts.filter((d) => (filter === 'all' ? true : d.status === filter));

  return (
    <div dir="rtl" className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white rounded-3xl border border-stone-200 p-5 sm:p-6 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <Bot className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-black text-stone-900">
                منتجات مساعد الموظفين
              </h2>
              <span className="bg-amber-500 text-white text-xs font-black px-2.5 py-0.5 rounded-full">
                {pendingCount} بانتظار الاعتماد والنشر
              </span>
            </div>
            <p className="text-xs text-stone-500 mt-1">
              تظهر هنا تلقائياً جميع المنتجات المحفوظة من مساعد الموظفين. أكمل السعر والصور والمخزون والوصف والتصنيف ثم اضغط «نشر المنتج».
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFilter('pending_pricing')}
            className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
              filter === 'pending_pricing'
                ? 'bg-amber-600 text-white'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            بانتظار المراجعة ({pendingCount})
          </button>
          <button
            onClick={() => setFilter('published')}
            className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
              filter === 'published'
                ? 'bg-emerald-600 text-white'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            منشورة بالمتجر ({drafts.length - pendingCount})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
              filter === 'all'
                ? 'bg-stone-900 text-white'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            الكل ({drafts.length})
          </button>
          <button
            onClick={() => loadDrafts(false)}
            disabled={loading}
            className="p-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 cursor-pointer"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-2xl border text-xs font-bold flex items-center gap-2 ${
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

      {loading ? (
        <div className="bg-white rounded-3xl border border-stone-200 p-12 text-center text-stone-500 text-xs flex flex-col items-center gap-2">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span>جاري تحميل منتجات مساعد الموظفين...</span>
        </div>
      ) : visibleDrafts.length === 0 ? (
        <div className="bg-white rounded-3xl border border-stone-200 p-12 text-center text-stone-500 text-sm space-y-2">
          <PackageCheck className="w-10 h-10 mx-auto text-stone-300" />
          <p className="font-bold text-stone-700">لا توجد منتجات في هذا القسم حالياً.</p>
          <p className="text-xs text-stone-400">
            أي منتج يتم حفظه من صفحة مساعد الموظفين سيظهر هنا تلقائياً ومباشرة.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {visibleDrafts.map((draft) => {
            const state = edits[draft.id];
            if (!state) return null;
            const isBusy = busyId === draft.id;
            const completion = getDraftCompletionStatus(state);
            const currentTags = parseTagsInput(state.tags_text);

            return (
              <div
                key={draft.id}
                className="bg-white rounded-3xl border border-stone-200 p-5 shadow-xs space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-stone-100">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="bg-stone-900 text-white text-xs font-black px-2.5 py-1 rounded-xl">
                      {draft.employee_code}
                    </span>
                    <span className="bg-stone-100 text-stone-700 text-[11px] font-bold px-2.5 py-1 rounded-xl">
                      المصدر: {draft.source_type}
                    </span>
                    {draft.status === 'pending_pricing' ? (
                      <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 text-xs font-black px-3 py-1 rounded-full">
                        <Clock className="w-3.5 h-3.5" />
                        غير معتمد (مخفي عن العملاء)
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-xs font-black px-3 py-1 rounded-full">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        منشور في المتجر ({draft.original_price} {settings.currency})
                      </span>
                    )}
                  </div>

                  <span className="text-[11px] text-stone-400">
                    {new Date(draft.created_at).toLocaleString('ar-YE')}
                  </span>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  {/* Editable Images Column */}
                  <div className="lg:col-span-4 space-y-3">
                    <div className="relative">
                      {state.image_url ? (
                        <img
                          src={state.image_url}
                          alt={state.title_ar}
                          className="w-full h-48 rounded-2xl object-cover border border-stone-200 bg-stone-50"
                        />
                      ) : (
                        <div className="w-full h-48 rounded-2xl border-2 border-dashed border-stone-300 bg-stone-50 flex flex-col items-center justify-center text-stone-400 text-xs gap-1">
                          <ImagePlus className="w-6 h-6" />
                          <span>لا توجد صورة رئيسية</span>
                        </div>
                      )}
                      <span className="absolute top-2 right-2 bg-stone-900/80 text-white text-[10px] font-bold px-2 py-0.5 rounded-lg">
                        الصورة الرئيسية
                      </span>
                    </div>

                    {/* Gallery Images with Set-Primary & Remove */}
                    {state.gallery_images.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {state.gallery_images.map((img, i) => {
                          const isPrimary = state.image_url === img;
                          return (
                            <div
                              key={`${draft.id}-img-${i}`}
                              className={`relative group rounded-xl overflow-hidden border-2 ${
                                isPrimary ? 'border-rose-500' : 'border-stone-200'
                              }`}
                            >
                              <img
                                src={img}
                                alt={`صورة ${i + 1}`}
                                className="w-14 h-14 object-cover bg-stone-50"
                              />
                              <button
                                type="button"
                                onClick={() => handleSetPrimaryImage(draft.id, img)}
                                title="تعيين كصورة رئيسية"
                                className={`absolute bottom-0.5 right-0.5 p-0.5 rounded-md text-[10px] cursor-pointer ${
                                  isPrimary
                                    ? 'bg-rose-600 text-white'
                                    : 'bg-black/60 text-white hover:bg-rose-600'
                                }`}
                              >
                                <Star className="w-2.5 h-2.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemoveImage(draft.id, img)}
                                title="حذف الصورة"
                                className="absolute top-0.5 left-0.5 p-0.5 rounded-md bg-black/65 hover:bg-rose-600 text-white cursor-pointer"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Upload Image File or Add URL */}
                    <div className="space-y-2 bg-stone-50 border border-stone-200 rounded-2xl p-3">
                      <label className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-white hover:bg-rose-50 border border-stone-200 hover:border-rose-300 text-stone-700 hover:text-rose-700 text-xs font-bold cursor-pointer transition-colors">
                        <ImagePlus className="w-3.5 h-3.5" />
                        <span>إضافة / رفع صور من الجهاز</span>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => handleUploadDraftImages(draft.id, e)}
                          className="hidden"
                        />
                      </label>

                      <div className="flex gap-1.5">
                        <input
                          type="url"
                          dir="ltr"
                          placeholder="https://... رابط صورة إضافية"
                          value={imageUrlInputs[draft.id] || ''}
                          onChange={(e) =>
                            setImageUrlInputs((prev) => ({
                              ...prev,
                              [draft.id]: e.target.value,
                            }))
                          }
                          className="flex-1 bg-white border border-stone-200 rounded-xl px-2.5 py-1.5 text-[11px] focus:border-rose-500 focus:outline-hidden"
                        />
                        <button
                          type="button"
                          onClick={() => handleAddImageUrl(draft.id)}
                          className="px-2.5 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-900 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer shrink-0"
                        >
                          <LinkIcon className="w-3 h-3" />
                          <span>إضافة</span>
                        </button>
                      </div>
                    </div>

                    {currentTags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {currentTags.slice(0, 6).map((t, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 text-[10px] bg-stone-100 text-stone-700 px-2 py-0.5 rounded-full"
                          >
                            <Tag className="w-2.5 h-2.5 text-rose-500" />
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Editable Fields & Admin Pricing */}
                  <div className="lg:col-span-8 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          اسم المنتج *
                        </label>
                        <input
                          type="text"
                          value={state.title_ar}
                          onChange={(e) => updateEditField(draft.id, 'title_ar', e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs font-bold focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          التصنيف *
                        </label>
                        <select
                          value={state.category_id}
                          onChange={(e) => updateEditField(draft.id, 'category_id', e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs font-bold bg-white focus:border-rose-500 focus:outline-hidden"
                        >
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name_ar}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          العلامة التجارية
                        </label>
                        <input
                          type="text"
                          value={state.brand}
                          onChange={(e) => updateEditField(draft.id, 'brand', e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          الحجم / السعة
                        </label>
                        <input
                          type="text"
                          value={state.size_or_volume}
                          onChange={(e) =>
                            updateEditField(draft.id, 'size_or_volume', e.target.value)
                          }
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          الوسوم (مفصولة بفاصلة)
                        </label>
                        <input
                          type="text"
                          value={state.tags_text}
                          onChange={(e) => updateEditField(draft.id, 'tags_text', e.target.value)}
                          placeholder="مثال: عناية، أصلي، سيروم"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-stone-600 mb-1">
                        الوصف *
                      </label>
                      <textarea
                        rows={3}
                        value={state.description_ar}
                        onChange={(e) => updateEditField(draft.id, 'description_ar', e.target.value)}
                        className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-rose-500 focus:outline-hidden"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          المكونات
                        </label>
                        <input
                          type="text"
                          value={state.ingredients}
                          onChange={(e) => updateEditField(draft.id, 'ingredients', e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          طريقة الاستخدام
                        </label>
                        <input
                          type="text"
                          value={state.how_to_use}
                          onChange={(e) => updateEditField(draft.id, 'how_to_use', e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    {/* Admin-Only Pricing & Stock Box */}
                    <div className="bg-amber-50/80 border border-amber-200 rounded-2xl p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-black text-amber-900 mb-1">
                          السعر الأصلي ({settings.currency}) *
                        </label>
                        <input
                          type="number"
                          min="1"
                          step="0.01"
                          placeholder="أدخل السعر..."
                          value={state.original_price}
                          onChange={(e) =>
                            updateEditField(draft.id, 'original_price', e.target.value)
                          }
                          className="w-full bg-white border border-amber-300 rounded-xl px-3 py-2 text-xs font-black focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-stone-700 mb-1">
                          سعر العرض / الخصم (اختياري)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="اختياري"
                          value={state.discount_price}
                          onChange={(e) =>
                            updateEditField(draft.id, 'discount_price', e.target.value)
                          }
                          className="w-full bg-white border border-stone-200 rounded-xl px-3 py-2 text-xs font-bold focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-stone-700 mb-1">
                          الكمية بالمخزون *
                        </label>
                        <input
                          type="number"
                          min="1"
                          value={state.stock_quantity}
                          onChange={(e) =>
                            updateEditField(draft.id, 'stock_quantity', e.target.value)
                          }
                          className="w-full bg-white border border-stone-200 rounded-xl px-3 py-2 text-xs font-bold focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    {/* Completion Status & Action Buttons */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                      <div className="text-[11px] font-bold">
                        {completion.isComplete ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>البيانات مكتملة — جاهز للنشر في المتجر</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-xl">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>
                              {completion.discountError ||
                                `أكمل للتمكن من النشر: ${completion.missingLabels.join('، ')}`}
                            </span>
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDelete(draft.id)}
                          className="px-3.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>حذف</span>
                        </button>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleSaveEdit(draft.id)}
                          className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>حفظ التعديلات</span>
                        </button>

                        <button
                          type="button"
                          disabled={isBusy || !completion.isComplete}
                          onClick={() => handlePublish(draft.id)}
                          title={
                            !completion.isComplete
                              ? completion.discountError ||
                                `أكمل: ${completion.missingLabels.join('، ')}`
                              : 'نشر المنتج في المتجر مباشرة'
                          }
                          className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-300 disabled:text-stone-500 text-white text-xs font-black flex items-center gap-1.5 shadow-sm cursor-pointer disabled:cursor-not-allowed transition-colors"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {draft.status === 'published' ? 'تحديث ونشر المنتج' : 'نشر المنتج'}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default EmployeeDraftsReviewPanel;
