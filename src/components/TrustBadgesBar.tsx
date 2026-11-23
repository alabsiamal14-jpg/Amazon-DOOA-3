import React from 'react';
import { ShieldCheck, Truck, RotateCcw, Award } from 'lucide-react';

const badges = [
  {
    icon: ShieldCheck,
    title: 'منتجات أصلية 100%',
    desc: 'مستوردة ومعتمدة بأعلى المعايير',
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
  },
  {
    icon: Truck,
    title: 'شحن سريع ومبرد',
    desc: 'حفاظ تام على جودة المنتجات',
    color: 'text-rose-600',
    bg: 'bg-rose-50',
  },
  {
    icon: RotateCcw,
    title: 'استبدال واسترجاع سهل',
    desc: 'خلال 7 أيام بكل مرونة',
    color: 'text-amber-600',
    bg: 'bg-amber-50',
  },
  {
    icon: Award,
    title: 'خدمة عملاء VIP',
    desc: 'متابعة مباشرة عبر الواتساب',
    color: 'text-indigo-600',
    bg: 'bg-indigo-50',
  },
];

export const TrustBadgesBar: React.FC = () => {
  return (
    <section className="my-12">
      <div className="max-w-7xl mx-auto px-4">
        <div className="text-center mb-8">
          <span className="inline-block px-4 py-1 rounded-full bg-stone-100 text-stone-600 text-xs font-bold tracking-wider">
            ✓ ضمان الجودة والثقة
          </span>

          <h2 className="mt-4 text-2xl md:text-3xl font-black text-stone-900">
            تجربة تسوق استثنائية من البداية للنهاية
          </h2>

          <p className="mt-2 text-sm text-stone-500">
            نلتزم بأعلى معايير الجودة والخدمة لضمان رضاك الكامل
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          {badges.map((item, index) => {
            const Icon = item.icon;

            return (
              <div
                key={index}
                className="
                  group
                  relative
                  overflow-hidden
                  rounded-3xl
                  bg-white
                  border border-stone-200/70
                  p-5
                  text-center
                  shadow-[0_8px_30px_rgba(0,0,0,0.05)]
                  transition-all
                  duration-300
                  hover:-translate-y-2
                  hover:shadow-[0_20px_50px_rgba(0,0,0,0.10)]
                "
              >
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-stone-300 to-transparent" />

                <div
                  className={`
                    ${item.bg}
                    mx-auto mb-4
                    flex h-14 w-14 items-center justify-center
                    rounded-2xl
                    transition-transform duration-300 group-hover:scale-105
                  `}
                >
                  <Icon className={`h-7 w-7 ${item.color}`} />
                </div>

                <h4 className="font-black text-sm text-stone-900 mb-2">
                  {item.title}
                </h4>

                <p className="text-xs leading-6 text-stone-500">
                  {item.desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
