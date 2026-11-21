import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  FileArchive,
  Image as ImageIcon,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Save,
  Send,
  RefreshCw,
  Loader2,
  CheckSquare,
  Square,
  PackageCheck,
  X,
} from 'lucide-react';
import type { BulkImportDraft, Category, Product, StoreSettings } from '../types';
import { getAuthHeadersAsync } from '../lib/storage';

interface AdminBulkImportPanelProps {
  categories: Category[];
  settings: StoreSettings;
  onProductsPublished: (products: Product[]) => void;
  onPendingCountChange?: (count: number) => void;
}

interface DraftEditState {
  title_ar: string;
  description_ar: string;
  category_id: string;
  brand: string;
  size_or_volume: string;
  stock_quantity: string;
  original_price: string;
  discount_price: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function isValidPriceInput(raw: string): boolean {
  if (!raw || !raw.trim()) return false;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0;
}

export const AdminBulkImportPanel: React.FC<AdminBulkImportPanelProps> = ({
  categories,
  settings,
  onProductsPublished,
  onPendingCountChange,
}) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [drafts, setDrafts] = useState<BulkImportDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'pending_review' | 'approved_published' | 'all'>('pending_review');
  const [edits, setEdits] = useState<Record<string, DraftEditState>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [invalidDraftIds, setInvalidDraftIds] = useState<Record<string, string>>({});

  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const syncEditsFromDrafts = (list: BulkImportDraft[]) => {
    setEdits((prev) => {
      const next: Record<string, DraftEditState> = {};
      for (const d of list) {
        next[d.id] = prev[d.id]
          ? prev[d.id]
          : {
              title_ar: d.title_ar,
              description_ar: d.description_ar,
              category_id: d.category_id,
              brand: d.brand,
              size_or_volume: d.size_or_volume,
              stock_quantity: String(d.stock_quantity || 10),
              original_price: d.original_price ? String(d.original_price) : '',
              discount_price: d.discount_price ? String(d.discount_price) : '',
            };
      }
      return next;
    });
  };

  const loadDrafts = async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/bulk-import/drafts', { headers });
      if (!res.ok) {
        throw new Error('تعذر تحميل مسودات الاستيراد بالجملة.');
      }
      const data = await res.json();
      const list: BulkImportDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      setDrafts(list);
      syncEditsFromDrafts(list);
      onPendingCountChange?.(list.filter((d) => d.status === 'pending_review').length);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'حدث خطأ أثناء تحميل المسودات.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDrafts();
  }, []);

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
        message: 'يرجى اختيار ملفات صور (JPG, PNG, WebP) أو ملف مضغوط بصيغة ZIP فقط.',
      });
      return;
    }

    setFeedback(null);
    setSelectedFiles((prev) => [...prev, ...allowed].slice(0, 25));
  };

  const handleAnalyzeAndStageDrafts = async () => {
    if (selectedFiles.length === 0) {
      setFeedback({ type: 'error', message: 'يرجى اختيار صور منتجات أو ملف ZIP أولاً.' });
      return;
    }

    setUploading(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      for (const file of selectedFiles) {
        formData.append('files', file);
      }

      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/bulk-import/analyze', {
        method: 'POST',
        headers,
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'فشل تحليل الصور وتجهيز المسودات.');
      }

      const newDrafts: BulkImportDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      setSelectedFiles([]);
      setFilter('pending_review');

      const mergedList = [...newDrafts, ...drafts.filter((d) => !newDrafts.some((n) => n.id === d.id))];
      setDrafts(mergedList);
      setEdits((prev) => {
        const next = { ...prev };
        for (const d of newDrafts) {
          next[d.id] = {
            title_ar: d.title_ar,
            description_ar: d.description_ar,
            category_id: d.category_id,
            brand: d.brand,
            size_or_volume: d.size_or_volume,
            stock_quantity: String(d.stock_quantity || 10),
            original_price: '',
            discount_price: '',
          };
        }
        return next;
      });
      onPendingCountChange?.(mergedList.filter((d) => d.status === 'pending_review').length);

      const savedPct = Number(data.optimization_summary?.saved_percent || 0);
      setFeedback({
        type: 'success',
        message: `${data.message}${savedPct > 0 ? ` (تم ضغط الصور بنسبة ${savedPct}%)` : ''}`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر معالجة ملفات الاستيراد.' });
    } finally {
      setUploading(false);
    }
  };

  const updateField = (draftId: string, field: keyof DraftEditState, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [draftId]: {
        ...prev[draftId],
        [field]: value,
      },
    }));
    if (field === 'original_price' && invalidDraftIds[draftId] && isValidPriceInput(value)) {
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
      const res = await fetch(`/api/admin/bulk-import/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          title_ar: state.title_ar,
          description_ar: state.description_ar,
          category_id: state.category_id,
          brand: state.brand,
          size_or_volume: state.size_or_volume,
          stock_quantity: state.stock_quantity ? Number(state.stock_quantity) : 10,
          original_price: state.original_price ? Number(state.original_price) : null,
          discount_price: state.discount_price ? Number(state.discount_price) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حفظ تعديلات المسودة.');

      setDrafts((prev) => prev.map((d) => (d.id === draftId ? data.draft : d)));
      setFeedback({ type: 'success', message: 'تم حفظ المسودة في منطقة المراجعة دون نشرها بعد.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر حفظ المسودة.' });
    } finally {
      setBusyId(null);
    }
  };

  const handlePublishSingle = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    if (!isValidPriceInput(state.original_price)) {
      setInvalidDraftIds((prev) => ({
        ...prev,
        [draftId]: 'السعر إلزامي: يجب إدخال سعر أكبر من صفر قبل الاعتماد والنشر.',
      }));
      setFeedback({
        type: 'error',
        message: 'يُمنع نشر أي منتج بدون تحديد سعر صحيح أكبر من صفر.',
      });
      return;
    }

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(
        `/api/admin/bulk-import/drafts/${encodeURIComponent(draftId)}/publish`,
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
            original_price: Number(state.original_price),
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
      if (data.product) {
        onProductsPublished([data.product]);
      }
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

  const handleBulkApprovePublish = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setFeedback({ type: 'error', message: 'يرجى تحديد مسودة واحدة على الأقل للاعتماد الجماعي.' });
      return;
    }

    // Validate each selected item's price individually
    const invalidMap: Record<string, string> = {};
    const payloadItems: any[] = [];

    for (const id of ids) {
      const state = edits[id];
      const draft = drafts.find((d) => d.id === id);
      if (!state || !draft) continue;

      if (!isValidPriceInput(state.original_price)) {
        invalidMap[id] = 'السعر مفقود أو غير صالح (يجب أن يكون أكبر من صفر).';
      } else {
        payloadItems.push({
          id,
          title_ar: state.title_ar,
          description_ar: state.description_ar,
          category_id: state.category_id,
          brand: state.brand,
          size_or_volume: state.size_or_volume,
          stock_quantity: state.stock_quantity ? Number(state.stock_quantity) : 10,
          original_price: Number(state.original_price),
          discount_price: state.discount_price ? Number(state.discount_price) : null,
        });
      }
    }

    if (Object.keys(invalidMap).length > 0) {
      setInvalidDraftIds((prev) => ({ ...prev, ...invalidMap }));
      setFeedback({
        type: 'error',
        message: `لا يمكن إتمام النشر الجماعي: يوجد (${Object.keys(invalidMap).length}) منتج بدون سعر صحيح أكبر من صفر. يرجى تسعير كل منتج محدد أولاً.`,
      });
      return;
    }

    setBulkBusy(true);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/bulk-import/drafts/bulk-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          approve: true,
          items: payloadItems,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (Array.isArray(data.invalidItems)) {
          const serverMap: Record<string, string> = {};
          for (const item of data.invalidItems) {
            serverMap[item.id] = item.reason;
          }
          setInvalidDraftIds((prev) => ({ ...prev, ...serverMap }));
        }
        throw new Error(data.error || 'تعذر الاعتماد الجماعي للمنتجات.');
      }

      const publishedDrafts: BulkImportDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      const publishedProducts: Product[] = Array.isArray(data.products) ? data.products : [];

      const byId = new Map(publishedDrafts.map((d) => [d.id, d]));
      const nextList = drafts.map((d) => byId.get(d.id) || d);
      setDrafts(nextList);
      setSelectedIds(new Set());
      onPendingCountChange?.(nextList.filter((d) => d.status === 'pending_review').length);
      if (publishedProducts.length > 0) {
        onProductsPublished(publishedProducts);
      }
      setFeedback({
        type: 'success',
        message: `تم اعتماد ونشر (${publishedProducts.length}) منتج دفعة واحدة في المتجر بنجاح.`,
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
      const res = await fetch(`/api/admin/bulk-import/drafts/${encodeURIComponent(draftId)}`, {
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
      setFeedback({ type: 'success', message: 'تم حذف المسودة من منطقة المراجعة.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر حذف المسودة.' });
    } finally {
      setBusyId(null);
    }
  };

  const pendingDrafts = drafts.filter((d) => d.status === 'pending_review');
  const publishedDrafts = drafts.filter((d) => d.status === 'approved_published');
  const visibleDrafts = drafts.filter((d) => (filter === 'all' ? true : d.status === filter));

  const selectableVisiblePending = visibleDrafts.filter((d) => d.status === 'pending_review');
  const allVisiblePendingSelected =
    selectableVisiblePending.length > 0 &&
    selectableVisiblePending.every((d) => selectedIds.has(d.id));

  const toggleSelectAllPending = () => {
    if (allVisiblePendingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableVisiblePending.map((d) => d.id)));
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
      {/* Header & Upload Dropzone Surface */}
      <section className="bg-white rounded-2xl border border-stone-200 p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-stone-100 pb-4">
          <div>
            <h2 className="text-lg font-bold text-stone-900">
              الاستيراد الذكي للمنتجات بالجملة
            </h2>
            <p className="text-xs text-stone-500 mt-1">
              ارفع عدة صور دفعة واحدة أو أرشيف ZIP ليتم ضغطها وتحليلها وتجهيز مسودات عربية مستقلة بانتظار تسعير الإدارة واعتمادها.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-stone-600 tabular-nums shrink-0">
            <span>قيد المراجعة: {pendingDrafts.length}</span>
            <span aria-hidden="true">·</span>
            <span>منشورة: {publishedDrafts.length}</span>
          </div>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files?.length) {
              addCandidateFiles(e.dataTransfer.files);
            }
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

          <div className="max-w-lg mx-auto space-y-3">
            <div className="w-11 h-11 rounded-xl bg-stone-900 text-white flex items-center justify-center mx-auto">
              <Upload className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-bold text-stone-900">
                اسحب وأفلت صور المنتجات أو ملف ZIP هنا
              </p>
              <p className="text-xs text-stone-500">
                يدعم JPG / PNG / WebP متعددة أو ملف أرشيف ZIP · الحد الأقصى 40 صورة لكل دفعة
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                اختيار صور أو ملف ZIP
              </button>
              {selectedFiles.length > 0 && (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={handleAnalyzeAndStageDrafts}
                  className="px-5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white text-xs font-bold whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer transition-colors"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>جاري ضغط الصور والتحليل وتجهيز المسودات...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>بدء التحليل وتجهيز المسودات ({selectedFiles.length})</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Selected Files Queue */}
        {selectedFiles.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-stone-600">
              <span className="font-bold">الملفات الجاهزة للتحليل ({selectedFiles.length})</span>
              <button
                type="button"
                onClick={() => setSelectedFiles([])}
                className="text-rose-600 hover:text-rose-700 font-semibold cursor-pointer"
              >
                مسح القائمة
              </button>
            </div>
            <div className="divide-y divide-stone-100 border border-stone-200 rounded-xl bg-white max-h-48 overflow-y-auto">
              {selectedFiles.map((file, idx) => {
                const isZip = file.name.toLowerCase().endsWith('.zip');
                return (
                  <div
                    key={`${file.name}-${idx}`}
                    className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
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
            </div>
          </div>
        )}
      </section>

      {/* Feedback Banner */}
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

      {/* Independent Drafts Review Section */}
      <section className="bg-white rounded-2xl border border-stone-200 p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stone-100 pb-4">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-100 rounded-lg w-fit">
            <button
              type="button"
              onClick={() => setFilter('pending_review')}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                filter === 'pending_review'
                  ? 'bg-white text-stone-900 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              بانتظار المراجعة والتسعير ({pendingDrafts.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('approved_published')}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                filter === 'approved_published'
                  ? 'bg-white text-stone-900 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              تم اعتمادها ونشرها ({publishedDrafts.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                filter === 'all'
                  ? 'bg-white text-stone-900 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              الكل ({drafts.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectableVisiblePending.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleSelectAllPending}
                  className="px-3 py-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-xs font-bold text-stone-700 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {allVisiblePendingSelected ? (
                    <CheckSquare className="w-4 h-4 text-rose-600" />
                  ) : (
                    <Square className="w-4 h-4 text-stone-400" />
                  )}
                  <span>
                    {allVisiblePendingSelected ? 'إلغاء تحديد الكل' : 'تحديد كل المسودات'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={handleBulkApprovePublish}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  {bulkBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>اعتماد ونشر المحددة ({selectedIds.size})</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={loadDrafts}
              disabled={loading}
              aria-label="تحديث المسودات"
              className="p-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-stone-600 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs text-stone-500 flex flex-col items-center gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
            <span>جاري تحميل مسودات الاستيراد بالجملة...</span>
          </div>
        ) : visibleDrafts.length === 0 ? (
          <div className="py-12 text-center space-y-2 text-stone-500">
            <PackageCheck className="w-10 h-10 mx-auto text-stone-300" />
            <p className="text-sm font-bold text-stone-700">
              لا توجد مسودات في هذا العرض حالياً
            </p>
            <p className="text-xs text-stone-500">
              ارفع صوراً متعددة أو ملف ZIP بالأعلى لإنشاء مسودات مستقلة جاهزة للمراجعة والتسعير.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-stone-200">
            {visibleDrafts.map((draft) => {
              const state = edits[draft.id];
              if (!state) return null;
              const isBusy = busyId === draft.id || bulkBusy;
              const isSelected = selectedIds.has(draft.id);
              const priceOk = isValidPriceInput(state.original_price);
              const rowError = invalidDraftIds[draft.id];
              const isPublished = draft.status === 'approved_published';

              return (
                <article
                  key={draft.id}
                  className="py-6 first:pt-2 last:pb-2 space-y-4"
                >
                  {/* Row Metadata Header (Unboxed typographic separators) */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-stone-600">
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
                        {isPublished ? 'تم الاعتماد والنشر' : 'مسودة بانتظار المراجعة والتسعير'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {draft.source_type === 'zip_archive' ? 'أرشيف ZIP' : 'صور متعددة'}:{' '}
                        {draft.source_filename}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {formatBytes(draft.image_optimization.original_bytes)} ←{' '}
                        {formatBytes(draft.image_optimization.optimized_bytes)}
                        {draft.image_optimization.saved_percent > 0
                          ? ` (ضغط ${draft.image_optimization.saved_percent}%)`
                          : ''}
                      </span>
                    </div>

                    <span className="text-xs text-stone-400 tabular-nums">
                      {new Date(draft.created_at).toLocaleString('ar-YE')}
                    </span>
                  </div>

                  {/* Main Row Grid */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    {/* Image Column */}
                    <div className="lg:col-span-3 space-y-2">
                      {brokenImages.has(draft.id) ? (
                        <div className="w-full aspect-4/3 rounded-xl border border-stone-200 bg-stone-100 flex flex-col items-center justify-center p-4 text-center text-stone-500 gap-2">
                          <ImageIcon className="w-6 h-6 text-stone-400" />
                          <span className="text-xs font-medium line-clamp-2">{state.title_ar}</span>
                        </div>
                      ) : (
                        <img
                          src={draft.image_url}
                          alt={state.title_ar}
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setBrokenImages((prev) => new Set(prev).add(draft.id))
                          }
                          className="w-full aspect-4/3 rounded-xl object-cover border border-stone-200 bg-stone-50"
                        />
                      )}
                    </div>

                    {/* Editable Fields Column */}
                    <div className="lg:col-span-9 space-y-4">
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

                      <div>
                        <label className="block text-xs font-bold text-stone-700 mb-1">
                          الوصف التسويقي
                        </label>
                        <textarea
                          rows={2}
                          value={state.description_ar}
                          onChange={(e) => updateField(draft.id, 'description_ar', e.target.value)}
                          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs font-bold text-stone-700 mb-1">
                            السعر الإلزامي ({settings.currency}) *
                          </label>
                          <input
                            type="number"
                            min="0.01"
                            step="any"
                            placeholder="أدخل سعراً أكبر من 0"
                            value={state.original_price}
                            onChange={(e) =>
                              updateField(draft.id, 'original_price', e.target.value)
                            }
                            className={`w-full border rounded-lg px-3 py-2 text-xs font-bold tabular-nums focus:outline-hidden ${
                              !priceOk
                                ? 'border-amber-400 bg-amber-50/60 focus:border-rose-500'
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

                        <div>
                          <label className="block text-xs font-bold text-stone-700 mb-1">
                            العلامة / الحجم
                          </label>
                          <input
                            type="text"
                            value={state.brand}
                            onChange={(e) => updateField(draft.id, 'brand', e.target.value)}
                            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-800 focus:border-rose-500 focus:outline-hidden"
                          />
                        </div>
                      </div>

                      {(!priceOk || rowError) && (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                          <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          <span>
                            {rowError ||
                              'السعر حقل إلزامي: لا يمكن اعتماد أو نشر هذا المنتج قبل تحديد سعر صحيح أكبر من صفر.'}
                          </span>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDeleteDraft(draft.id)}
                          className="px-3.5 py-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>حذف المسودة</span>
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
                          disabled={isBusy || !priceOk}
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
  );
};

export default AdminBulkImportPanel;
