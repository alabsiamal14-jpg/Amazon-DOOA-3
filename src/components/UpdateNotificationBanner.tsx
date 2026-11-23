import React, { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  applyServiceWorkerUpdate,
  subscribeToServiceWorkerUpdates,
  type ServiceWorkerUpdateDetail,
} from '../serviceWorker';

interface UpdateNotificationBannerProps {
  className?: string;
}

export const UpdateNotificationBanner: React.FC<UpdateNotificationBannerProps> = ({
  className = '',
}) => {
  const [updateDetail, setUpdateDetail] = useState<ServiceWorkerUpdateDetail | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToServiceWorkerUpdates((detail) => {
      setUpdateDetail(detail);
      setIsDismissed(false);
    });
    return unsubscribe;
  }, []);

  if (!updateDetail || isDismissed) {
    return null;
  }

  const handleApplyUpdate = async () => {
    if (isUpdating) return;
    setIsUpdating(true);
    await applyServiceWorkerUpdate(updateDetail.registration);
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      aria-label="إشعار تحديث التطبيق"
      dir="rtl"
      className={`fixed bottom-4 left-4 right-4 sm:right-auto sm:left-6 sm:max-w-md z-50 pointer-events-auto ${className}`}
    >
      <div className="bg-stone-950/95 text-stone-100 border border-rose-500/40 shadow-2xl shadow-stone-950/40 rounded-2xl p-3.5 sm:p-4 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleApplyUpdate}
            disabled={isUpdating}
            className="flex-1 flex items-center gap-3 text-right group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 rounded-xl disabled:opacity-70"
          >
            <span className="w-10 h-10 rounded-xl bg-rose-600 text-white flex items-center justify-center shrink-0 shadow-sm group-hover:bg-rose-500 transition-colors duration-200">
              <RefreshCw className={`w-4 h-4 ${isUpdating ? 'animate-spin' : ''}`} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs sm:text-sm font-bold text-white leading-snug">
                التطبيق محدث، اضغط للتحديث
              </p>
              <p className="text-[11px] text-stone-300 mt-0.5 truncate">
                {isUpdating
                  ? 'جاري تفعيل الإصدار الجديد وتحديث محتوى المتجر...'
                  : 'يتوفر إصدار جديد بمحتوى المتجر المحدّث'}
              </p>
            </div>
          </button>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleApplyUpdate}
              disabled={isUpdating}
              className="px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 active:scale-95 text-white text-xs font-bold whitespace-nowrap shrink-0 transition-all duration-200 cursor-pointer disabled:opacity-60"
            >
              {isUpdating ? 'جاري التحديث...' : 'تحديث'}
            </button>
            <button
              type="button"
              onClick={() => setIsDismissed(true)}
              className="p-2 text-stone-400 hover:text-white rounded-xl transition-colors duration-200 cursor-pointer shrink-0"
              aria-label="إغلاق إشعار التحديث"
              title="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
