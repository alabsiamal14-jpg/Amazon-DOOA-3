import React, { useState, useEffect } from 'react';
import { Settings, Save, Check, Phone, DollarSign, Truck, RotateCcw, Coins } from 'lucide-react';
import { CurrencyConfig, StoreSettings } from '../types';
import { getEffectiveCurrencies } from '../lib/currency';

interface AdminSettingsProps {
  settings: StoreSettings;
  onSaveSettings: (settings: StoreSettings) => void;
  onResetData: () => void;
  onUpdateUserRole?: (email: string, role: 'staff' | 'user') => Promise<void>;
}

export const AdminSettings: React.FC<AdminSettingsProps> = ({
  settings,
  onSaveSettings,
  onResetData,
  onUpdateUserRole,
}) => {
  const [formData, setFormData] = useState<StoreSettings>(() => ({
    ...settings,
    currencies: getEffectiveCurrencies(settings),
    activeCurrency: settings.activeCurrency || 'SAR',
  }));
  const [saved, setSaved] = useState(false);
  const [staffEmail, setStaffEmail] = useState('');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  useEffect(() => {
    setFormData({
      ...settings,
      currencies: getEffectiveCurrencies(settings),
      activeCurrency: settings.activeCurrency || 'SAR',
    });
  }, [settings]);

  const currenciesMap = getEffectiveCurrencies(formData);

  const handleCurrencyChange = (code: string, patch: Partial<CurrencyConfig>) => {
    setFormData((prev) => {
      const current = getEffectiveCurrencies(prev);
      return {
        ...prev,
        currencies: {
          ...current,
          [code]: {
            ...current[code],
            ...patch,
          },
        },
      };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      ...formData,
      currencies: getEffectiveCurrencies(formData),
      activeCurrency: formData.activeCurrency || 'SAR',
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-8 border border-stone-200 shadow-sm mt-8">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-stone-100">
        <div>
          <h3 className="text-lg sm:text-xl font-black text-stone-900 flex items-center gap-2">
            <Settings className="w-5 h-5 text-rose-600" />
            <span>إعدادات المتجر ونظام الواتساب</span>
          </h3>
          <p className="text-xs text-stone-500 mt-0.5">
            ضبط رقم استقبال الطلبات على واتساب، رسوم التوصيل، واسم المتجر
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 text-xs sm:text-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Store Name */}
          <div>
            <label className="block font-bold text-stone-700 mb-1.5">اسم المتجر</label>
            <input
              type="text"
              required
              value={formData.storeName}
              onChange={(e) => setFormData({ ...formData, storeName: e.target.value })}
              className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl focus:bg-white focus:border-rose-500 focus:outline-hidden"
            />
          </div>

          {/* Tagline */}
          <div>
            <label className="block font-bold text-stone-700 mb-1.5">الشعار التسويقي (Tagline)</label>
            <input
              type="text"
              value={formData.tagline}
              onChange={(e) => setFormData({ ...formData, tagline: e.target.value })}
              className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl focus:bg-white focus:border-rose-500 focus:outline-hidden"
            />
          </div>

          {/* WhatsApp Phone */}
          <div>
            <label className="block font-bold text-stone-700 mb-1.5 flex items-center gap-1.5">
              <Phone className="w-4 h-4 text-emerald-600" />
              رقم الواتساب لاستقبال الطلبات (مع الكود الدولي بدون + أو أصفار)
            </label>
            <input
              type="text"
              required
              value={formData.whatsappNumber}
              onChange={(e) => setFormData({ ...formData, whatsappNumber: e.target.value })}
              placeholder="مثال: 966501234567 أو 967780187409"
              className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl focus:bg-white focus:border-rose-500 focus:outline-hidden font-mono"
            />
            <span className="text-[11px] text-stone-400 mt-1 block">
              سيتم توجيه العملاء إلى wa.me/{formData.whatsappNumber.replace(/\D/g, '')}
            </span>
          </div>

          {/* Currency */}
          <div>
            <label className="block font-bold text-stone-700 mb-1.5 flex items-center gap-1.5">
              <DollarSign className="w-4 h-4 text-rose-600" />
              رمز العملة
            </label>
            <input
              type="text"
              required
              value={formData.currency}
              onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
              placeholder="ريال"
              className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl focus:bg-white focus:border-rose-500 focus:outline-hidden"
            />
          </div>

          {/* Delivery Fee */}
          <div>
            <label className="block font-bold text-stone-700 mb-1.5 flex items-center gap-1.5">
              <Truck className="w-4 h-4 text-stone-600" />
              رسوم التوصيل العادية ({formData.currency})
            </label>
            <input
              type="number"
              min="0"
              required
              value={formData.deliveryFee}
              onChange={(e) => setFormData({ ...formData, deliveryFee: Number(e.target.value) })}
              className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl focus:bg-white focus:border-rose-500 focus:outline-hidden"
            />
          </div>

          {/* Free Delivery Threshold */}
          <div>
            <label className="block font-bold text-stone-700 mb-1.5">
              الحد الأدنى للشحن المجاني ({formData.currency})
            </label>
            <input
              type="number"
              min="0"
              required
              value={formData.freeDeliveryThreshold}
              onChange={(e) => setFormData({ ...formData, freeDeliveryThreshold: Number(e.target.value) })}
              className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl focus:bg-white focus:border-rose-500 focus:outline-hidden"
            />
          </div>
        </div>

        {/* Multi-Currency Exchange Rates Management */}
        <div className="pt-6 border-t border-stone-100 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h4 className="text-sm sm:text-base font-black text-stone-900 flex items-center gap-2">
                <Coins className="w-4 h-4 text-rose-600" />
                <span>إدارة العملات وأسعار الصرف (السوق اليمني والخليجي)</span>
              </h4>
              <p className="text-[11px] text-stone-500 mt-0.5">
                أسعار المنتجات الأساسية محفوظة بالريال السعودي (SAR = 1)، ويتم تحويل الأسعار تلقائياً للعملاء حسب سعر الصرف هنا.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-stone-700 shrink-0">العملة الافتراضية:</label>
              <select
                value={formData.activeCurrency || 'SAR'}
                onChange={(e) => setFormData({ ...formData, activeCurrency: e.target.value })}
                className="p-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-bold focus:border-rose-500 focus:outline-hidden"
              >
                {Object.values(currenciesMap)
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name_ar || c.code}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.values(currenciesMap).map((cur) => (
              <div
                key={cur.code}
                className={`p-4 rounded-2xl border transition-all space-y-3 ${
                  cur.active ? 'bg-stone-50/70 border-stone-200' : 'bg-stone-100/50 border-stone-200/60 opacity-65'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-black text-stone-900 text-xs sm:text-sm block">
                      {cur.name_ar || cur.code}
                    </span>
                    <span className="text-[10px] font-mono text-stone-400">{cur.code}</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs font-bold text-stone-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cur.active}
                      disabled={cur.code === 'SAR'}
                      onChange={(e) => handleCurrencyChange(cur.code, { active: e.target.checked })}
                      className="rounded text-rose-600 focus:ring-rose-500"
                    />
                    <span>مفعل</span>
                  </label>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <label className="block text-[11px] font-bold text-stone-600 mb-1">سعر الصرف (× SAR)</label>
                    <input
                      type="number"
                      step="0.0001"
                      min="0.0001"
                      disabled={cur.code === 'SAR'}
                      value={cur.rate}
                      onChange={(e) =>
                        handleCurrencyChange(cur.code, {
                          rate: Math.max(0.0001, Number(e.target.value) || 1),
                        })
                      }
                      className="w-full p-2 bg-white border border-stone-200 rounded-xl font-mono text-xs focus:border-rose-500 focus:outline-hidden disabled:bg-stone-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-stone-600 mb-1">الرمز المعروض</label>
                    <input
                      type="text"
                      value={cur.symbol}
                      onChange={(e) => handleCurrencyChange(cur.code, { symbol: e.target.value })}
                      className="w-full p-2 bg-white border border-stone-200 rounded-xl text-xs focus:border-rose-500 focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-stone-600 mb-1">الكسور العشرية</label>
                    <input
                      type="number"
                      min="0"
                      max="4"
                      value={cur.decimals}
                      onChange={(e) =>
                        handleCurrencyChange(cur.code, {
                          decimals: Math.max(0, Math.min(4, Math.floor(Number(e.target.value) || 0))),
                        })
                      }
                      className="w-full p-2 bg-white border border-stone-200 rounded-xl font-mono text-xs focus:border-rose-500 focus:outline-hidden"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-stone-100">
          <button
            type="submit"
            className="bg-stone-900 hover:bg-stone-800 text-white px-6 py-3 rounded-2xl font-bold transition-all shadow-md flex items-center gap-2"
          >
            {saved ? (
              <>
                <Check className="w-4 h-4 text-emerald-400" />
                <span>تم حفظ التغييرات بنجاح</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>حفظ إعدادات المتجر</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              if (window.confirm('هل تريد استعادة البيانات الافتراضية للمتجر والمنتجات؟')) {
                onResetData();
              }
            }}
            className="text-stone-400 hover:text-rose-600 text-xs font-semibold flex items-center gap-1.5 transition-colors p-2"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>استعادة المنتجات والإعدادات الافتراضية</span>
          </button>
        </div>
      </form>

      {/* Staff Management Section */}
      <div className="mt-12 pt-8 border-t border-stone-100">
        <div className="flex items-center gap-2 mb-4">
          <Truck className="w-5 h-5 text-indigo-600" />
          <h3 className="text-lg font-black text-stone-900">إدارة صلاحيات الموظفين (عن بُعد)</h3>
        </div>
        <p className="text-xs text-stone-500 mb-6">
          يمكنك تعيين موظفين لمساعدتك في رفع المنتجات. سيتمكن الموظف من رفع الصور والبيانات كـ "مسودة" فقط، ولن يتمكن من رؤية الطلبات أو الإحصائيات.
        </p>

        <div className="bg-indigo-50/50 border border-indigo-100 p-6 rounded-2xl">
          <label className="block text-xs font-black text-indigo-900 mb-2">إضافة موظف جديد (بالبريد الإلكتروني)</label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="email"
              value={staffEmail}
              onChange={(e) => setStaffEmail(e.target.value)}
              placeholder="example@gmail.com"
              className="flex-1 p-3 bg-white border border-stone-200 rounded-2xl focus:border-indigo-500 focus:outline-hidden text-sm"
            />
            <button
              type="button"
              disabled={!staffEmail || isUpdatingRole}
              onClick={async () => {
                if (!onUpdateUserRole) return;
                setIsUpdatingRole(true);
                try {
                  await onUpdateUserRole(staffEmail, 'staff');
                  setStaffEmail('');
                  alert('تمت ترقية المستخدم إلى موظف بنجاح! سيتمكن الآن من دخول بوابة الموظفين.');
                } catch (err: any) {
                  alert(err.message || 'فشل تحديث الصلاحيات. تأكد من أن المستخدم مسجل مسبقاً في الموقع.');
                } finally {
                  setIsUpdatingRole(false);
                }
              }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-black text-sm transition-all shadow-md disabled:opacity-50"
            >
              {isUpdatingRole ? 'جاري التحديث...' : 'تعيين كموظف'}
            </button>
            <button
              type="button"
              disabled={!staffEmail || isUpdatingRole}
              onClick={async () => {
                if (!onUpdateUserRole) return;
                setIsUpdatingRole(true);
                try {
                  await onUpdateUserRole(staffEmail, 'user');
                  setStaffEmail('');
                  alert('تم إلغاء صلاحيات الموظف وتحويله إلى مستخدم عادي.');
                } catch (err: any) {
                  alert(err.message || 'فشل تحديث الصلاحيات.');
                } finally {
                  setIsUpdatingRole(false);
                }
              }}
              className="text-stone-500 hover:text-rose-600 px-4 py-3 rounded-2xl font-bold text-xs transition-colors"
            >
              إلغاء الصلاحية
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminSettings;
