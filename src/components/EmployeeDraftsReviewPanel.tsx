import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import type { Category, EmployeeDraft, Product, StoreSettings } from '../types';
import { getAuthHeadersAsync } from '../lib/storage';

interface EmployeeDraftsReviewPanelProps {
  categories: Category[];
  settings: StoreSettings;
  onDraftPublished: (product: Product) => void;
  onPendingCountChange: (count: number) => void;
}

interface DraftEditState {
  title_ar: string;
  description_ar: string;
  category_id: string;
  brand: string;
  size_or_volume: string;
  ingredients: string;
  how_to_use: string;
  original_price: string;
  discount_price: string;
  stock_quantity: string;
}

export const EmployeeDraftsReviewPanel: React.FC<EmployeeDraftsReviewPanelProps> = ({
  categories,
  settings,
  onDraftPublished,
  onPendingCountChange,
}) => {
  const [drafts, setDrafts] = useState<EmployeeDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending_pricing' | 'published'>('pending_pricing');
  const [edits, setEdits] = useState<Record<string, DraftEditState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  const loadDrafts = async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/employee-assistant/drafts', { headers });
      if (!res.ok) {
        throw new Error('تعذر تحميل مسودات الموظفين.');
      }
      const data = await res.json();
      const list: EmployeeDraft[] = Array.isArray(data.drafts) ? data.drafts : [];
      setDrafts(list);
      onPendingCountChange(list.filter((d) => d.status === 'pending_pricing').length);

      const initialEdits: Record<string, DraftEditState> = {};
      for (const d of list) {
        initialEdits[d.id] = {
          title_ar: d.title_ar,
          description_ar: d.description_ar,
          category_id: d.category_id,
          brand: d.brand,
          size_or_volume: d.size_or_volume,
          ingredients: d.ingredients,
          how_to_use: d.how_to_use,
          original_price: d.original_price ? String(d.original_price) : '',
          discount_price: d.discount_price ? String(d.discount_price) : '',
          stock_quantity: '10',
        };
      }
      setEdits(initialEdits);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'خطأ في تحميل المسودات.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDrafts();
  }, []);

  const updateEditField = (draftId: string, field: keyof DraftEditState, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [draftId]: {
        ...prev[draftId],
        [field]: value,
      },
    }));
  };

  const handleSaveEdit = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(`/api/employee-assistant/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          title_ar: state.title_ar,
          description_ar: state.description_ar,
          category_id: state.category_id,
          brand: state.brand,
          size_or_volume: state.size_or_volume,
          ingredients: state.ingredients,
          how_to_use: state.how_to_use,
          original_price: state.original_price ? Number(state.original_price) : null,
          discount_price: state.discount_price ? Number(state.discount_price) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حفظ التعديلات.');

      setDrafts((prev) => prev.map((d) => (d.id === draftId ? data.draft : d)));
      setFeedback({ type: 'success', message: 'تم حفظ تعديلات المسودة بنجاح.' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر تحديث المسودة.' });
    } finally {
      setBusyId(null);
    }
  };

  const handlePublish = async (draftId: string) => {
    const state = edits[draftId];
    if (!state) return;

    const priceNum = Number(state.original_price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      setFeedback({
        type: 'error',
        message: 'يرجى تحديد السعر الأصلي (أكبر من صفر) قبل نشر المنتج في المتجر.',
      });
      return;
    }

    setBusyId(draftId);
    setFeedback(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(
        `/api/employee-assistant/drafts/${encodeURIComponent(draftId)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            title_ar: state.title_ar,
            description_ar: state.description_ar,
            category_id: state.category_id,
            brand: state.brand,
            size_or_volume: state.size_or_volume,
            ingredients: state.ingredients,
            how_to_use: state.how_to_use,
            original_price: priceNum,
            discount_price: state.discount_price ? Number(state.discount_price) : null,
            stock_quantity: state.stock_quantity ? Number(state.stock_quantity) : 10,
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر نشر المنتج.');

      const nextList = drafts.map((d) => (d.id === draftId ? data.draft : d));
      setDrafts(nextList);
      onPendingCountChange(nextList.filter((d) => d.status === 'pending_pricing').length);
      if (data.product) {
        onDraftPublished(data.product);
      }
      setFeedback({
        type: 'success',
        message: `تم تسعير ونشر "${data.product?.title_ar || state.title_ar}" في المتجر بنجاح!`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'تعذر نشر المسودة.' });
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
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حذف المسودة.');

      const nextList = drafts.filter((d) => d.id !== draftId);
      setDrafts(nextList);
      onPendingCountChange(nextList.filter((d) => d.status === 'pending_pricing').length);
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
                Pending Employee Drafts (مسودات المساعد الذكي للموظفين)
              </h2>
              <span className="bg-amber-500 text-white text-xs font-black px-2.5 py-0.5 rounded-full">
                {pendingCount} بانتظار التسعير
              </span>
            </div>
            <p className="text-xs text-stone-500 mt-1">
              مراجعة منتجات الموظفين (EMP001–EMP008)، تحديد السعر النهائي، ثم النشر أو التعديل أو الحذف.
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
            بانتظار التسعير ({pendingCount})
          </button>
          <button
            onClick={() => setFilter('published')}
            className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
              filter === 'published'
                ? 'bg-emerald-600 text-white'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            تم نشرها ({drafts.length - pendingCount})
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
            onClick={loadDrafts}
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
          <span>جاري تحميل مسودات الموظفين...</span>
        </div>
      ) : visibleDrafts.length === 0 ? (
        <div className="bg-white rounded-3xl border border-stone-200 p-12 text-center text-stone-500 text-sm space-y-2">
          <PackageCheck className="w-10 h-10 mx-auto text-stone-300" />
          <p className="font-bold text-stone-700">لا توجد مسودات في هذا القسم حالياً.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {visibleDrafts.map((draft) => {
            const state = edits[draft.id];
            if (!state) return null;
            const isBusy = busyId === draft.id;

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
                        بانتظار التسعير من الإدارة (price: null)
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-xs font-black px-3 py-1 rounded-full">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        تم التسعير والنشر ({draft.original_price} {settings.currency})
                      </span>
                    )}
                  </div>

                  <span className="text-[11px] text-stone-400">
                    {new Date(draft.created_at).toLocaleString('ar-YE')}
                  </span>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  {/* Images Column */}
                  <div className="lg:col-span-3 space-y-2">
                    <img
                      src={draft.image_url}
                      alt={state.title_ar}
                      className="w-full h-44 rounded-2xl object-cover border border-stone-200 bg-stone-50"
                    />
                    {draft.gallery_images.length > 1 && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {draft.gallery_images.map((img, i) => (
                          <img
                            key={i}
                            src={img}
                            alt=""
                            className="w-12 h-12 rounded-xl object-cover border border-stone-200 shrink-0"
                          />
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1 pt-1">
                      {draft.tags.slice(0, 6).map((t, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 text-[10px] bg-stone-100 text-stone-700 px-2 py-0.5 rounded-full"
                        >
                          <Tag className="w-2.5 h-2.5 text-rose-500" />
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Editable Fields & Admin Pricing */}
                  <div className="lg:col-span-9 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-bold text-stone-600 mb-1">
                          اسم المنتج
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
                          الفئة
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

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-stone-600 mb-1">
                        الوصف
                      </label>
                      <textarea
                        rows={2}
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

                    {/* Admin-Only Pricing Box */}
                    <div className="bg-amber-50/80 border border-amber-200 rounded-2xl p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-black text-amber-900 mb-1">
                          تحديد السعر الأصلي ({settings.currency}) *
                        </label>
                        <input
                          type="number"
                          min="1"
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
                          الكمية بالمخزون
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

                    {/* Action Buttons */}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDelete(draft.id)}
                        className="px-3.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>حذف المسودة</span>
                      </button>

                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSaveEdit(draft.id)}
                        className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>حفظ التعديل</span>
                      </button>

                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handlePublish(draft.id)}
                        className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black flex items-center gap-1.5 shadow-sm cursor-pointer"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {draft.status === 'published' ? 'تحديث ونشر المنتج' : 'تسعير ونشر في المتجر'}
                        </span>
                      </button>
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
