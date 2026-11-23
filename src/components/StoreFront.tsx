import React, { useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  Baby,
  Check,
  ChevronLeft,
  Crown,
  Filter,
  Flame,
  Hash,
  Heart,
  Home,
  Layers,
  LayoutGrid,
  MessageCircle,
  Palette,
  Percent,
  Plus,
  RotateCcw,
  Rows3,
  Search,
  Smartphone,
  Sparkles,
  Tag,
  Watch,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import { Category, Product, StoreSettings } from '../types';
import { ProductCard } from './ProductCard';
import { searchProducts } from '../lib/search';
import {
  buildStorefrontShelves,
  deriveEffectiveCategories,
  extractScopedSubTags,
  partitionBentoCategories,
  resolveCategoryBackgroundImage,
} from '../lib/storefront';
import { TrustBadgesBar } from './TrustBadgesBar';

import heroImg from '../assets/images/amazon_duaa_beauty_hero_1795377864380.jpg';
import catSkincareImg from '../assets/images/category_skincare_1795377863580.jpg';
import catPerfumesImg from '../assets/images/category_perfumes_1795377864376.jpg';
import catMakeupImg from '../assets/images/category_makeup_1795377864161.jpg';
import catHaircareImg from '../assets/images/category_haircare_1795377865544.jpg';

export const getCategoryIconComponent = (iconName?: string) => {
  switch (iconName) {
    case 'Sparkles':
      return Sparkles;
    case 'Waves':
      return Waves;
    case 'Flame':
      return Flame;
    case 'Palette':
      return Palette;
    case 'Heart':
      return Heart;
    case 'Zap':
      return Zap;
    case 'Smartphone':
      return Smartphone;
    case 'Watch':
      return Watch;
    case 'Home':
      return Home;
    case 'Baby':
      return Baby;
    case 'Activity':
      return Activity;
    default:
      return Tag;
  }
};

const getCategoryLocalImage = (catId: string, defaultImage?: string) => {
  switch (catId) {
    case 'skincare':
      return catSkincareImg;
    case 'perfumes':
      return catPerfumesImg;
    case 'makeup':
      return catMakeupImg;
    case 'haircare':
      return catHaircareImg;
    default:
      return defaultImage;
  }
};

interface StoreFrontProps {
  products: Product[];
  categories: Category[];
  onAddToCart: (product: Product, quantity?: number) => void;
  onQuickView: (product: Product) => void;
  onOpenDetails: (product: Product) => void;
  cartProductIds: Set<string>;
  wishlistIds?: Set<string>;
  onToggleWishlist?: (product: Product) => void;
  settings: StoreSettings;
  onOpenAdmin: () => void;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  onOpenPublicAddProduct?: () => void;
}

export const StoreFront: React.FC<StoreFrontProps> = ({
  products,
  categories,
  onAddToCart,
  onQuickView,
  onOpenDetails,
  cartProductIds,
  wishlistIds = new Set(),
  onToggleWishlist,
  settings,
  onOpenAdmin,
  searchQuery = '',
  onSearchQueryChange,
  onOpenPublicAddProduct,
}) => {
  // Multi-select categories: empty array means "الكل" (All Storefront)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState<string>('all');
  const [internalSearch, setInternalSearch] = useState('');
  const [sortBy, setSortBy] = useState<
    'featured' | 'newest' | 'price-low' | 'price-high' | 'discount'
  >('featured');
  const [viewMode, setViewMode] = useState<'shelves' | 'grid'>('shelves');

  const productsTopRef = useRef<HTMLDivElement | null>(null);

  const activeQuery =
    searchQuery !== undefined && onSearchQueryChange ? searchQuery : internalSearch;

  const handleQueryChange = (val: string) => {
    if (onSearchQueryChange) {
      onSearchQueryChange(val);
    } else {
      setInternalSearch(val);
    }
  };

  // Preserve real Firebase categories and include any extra categories found on live products
  const effectiveCategories = useMemo(
    () => deriveEffectiveCategories(categories, products),
    [categories, products]
  );

  // Partition into top 2 prominent Bento cards + remaining categories using real DB counts
  const { featuredTwo, rest: restCategories, countMap } = useMemo(
    () => partitionBentoCategories(effectiveCategories, products),
    [effectiveCategories, products]
  );

  const resolveCategoryImage = (cat: Category): string | undefined =>
    resolveCategoryBackgroundImage(cat, products, getCategoryLocalImage(cat.id));

  const resolveCategoryFallbackImage = (cat: Category): string | undefined =>
    resolveCategoryBackgroundImage(
      { id: cat.id, name_ar: cat.name_ar, image: undefined },
      products,
      getCategoryLocalImage(cat.id)
    );

  const handleToggleCategory = (catId: string) => {
    setSelectedCategories((prev) => {
      const next = prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId];
      if (selectedTag !== 'all') {
        const scoped =
          next.length === 0 ? products : products.filter((p) => next.includes(p.category_id));
        const stillExists = scoped.some(
          (p) => Array.isArray(p.tags) && p.tags.includes(selectedTag)
        );
        if (!stillExists) setSelectedTag('all');
      }
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedCategories([]);
    setSelectedTag('all');
  };

  const scrollToCatalog = () => {
    productsTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Dynamic sub-categories extracted ONLY from products inside selected categories
  const availableSubTags = useMemo(() => {
    if (selectedCategories.length === 0) return [];
    return extractScopedSubTags(products, selectedCategories);
  }, [products, selectedCategories]);

  // Multi-category + sub-tag + semantic search filtering & sorting
  const filteredProducts = useMemo(() => {
    let list = [...products];

    if (selectedCategories.length > 0) {
      list = list.filter((p) => selectedCategories.includes(p.category_id));
    }

    if (selectedTag !== 'all') {
      list = list.filter((p) => Array.isArray(p.tags) && p.tags.includes(selectedTag));
    }

    if (activeQuery.trim()) {
      const searchMatches = searchProducts(list, activeQuery);
      list = searchMatches.map((m) => m.product);
    } else {
      list.sort((a, b) => {
        const priceA = a.discount_price ?? a.original_price;
        const priceB = b.discount_price ?? b.original_price;

        if (sortBy === 'featured') {
          if (a.featured && !b.featured) return -1;
          if (!a.featured && b.featured) return 1;
          const ratingDiff = (b.rating || 0) - (a.rating || 0);
          if (ratingDiff !== 0) return ratingDiff;
          return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        }
        if (sortBy === 'newest') {
          return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        }
        if (sortBy === 'price-low') {
          return priceA - priceB;
        }
        if (sortBy === 'price-high') {
          return priceB - priceA;
        }
        if (sortBy === 'discount') {
          const discA = a.discount_price ? a.original_price - a.discount_price : 0;
          const discB = b.discount_price ? b.original_price - b.discount_price : 0;
          return discB - discA;
        }
        return 0;
      });
    }

    return list;
  }, [products, selectedCategories, selectedTag, activeQuery, sortBy]);

  // Multi-shelf catalog shown in "الكل" mode when Shelves view is active and no search/sub-tag filter narrows results
  const shelves = useMemo(
    () => buildStorefrontShelves(products, effectiveCategories, 4),
    [products, effectiveCategories]
  );

  const isAllMode = selectedCategories.length === 0;
  const shouldShowShelves =
    isAllMode && selectedTag === 'all' && !activeQuery.trim() && viewMode === 'shelves';

  return (
    <div className="pb-20">
      {/* Immersive Luxury Hero Banner */}
      <section className="relative overflow-hidden bg-stone-950 text-white py-16 sm:py-24 px-4 sm:px-8 lg:px-12 mb-10 rounded-3xl mx-4 sm:mx-6 lg:mx-8 shadow-2xl mt-4 border border-stone-800">
        <div className="absolute inset-0 z-0">
          <img
            src={heroImg}
            alt="Amazon Duaa Atelier Luxury"
            className="w-full h-full object-cover object-center opacity-45 scale-105 transform hover:scale-100 transition-transform duration-1000 ease-out"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-stone-950 via-stone-950/90 to-rose-950/70" />
        </div>

        <div className="absolute -top-32 -left-32 w-96 h-96 bg-rose-600/25 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-amber-500/20 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-4xl mx-auto text-center space-y-6">
          <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-md px-4 py-2 rounded-full text-xs font-extrabold text-rose-200 border border-white/20 shadow-lg mb-2">
            <Sparkles className="w-4 h-4 text-amber-300 animate-pulse" />
            <span>معرض أمازون دعاء الفاخر | تسوقي أحدث صيحات التجميل والعناية العالمية</span>
          </div>

          <h1 className="text-3xl sm:text-6xl font-black tracking-tight leading-tight sm:leading-tight">
            إطلالة ملكية تليق بنقاء جمالك <br className="hidden sm:inline" />
            <span className="bg-gradient-to-r from-rose-300 via-rose-100 to-amber-200 bg-clip-text text-transparent">
              عناية، عطور فاخرة، وأجهزة ذكية بأعلى معايير الجودة العالمية
            </span>
          </h1>

          <p className="text-sm sm:text-base text-stone-300 max-w-2xl mx-auto leading-relaxed">
            استمتعي بتجربة تسوق راقية مستوحاة من أشهر متاجر التجميل العالمية. منتجات أصلية 100%، توصيل سريع، ودفع عند الاستلام.
          </p>

          <div className="pt-3 flex flex-wrap items-center justify-center gap-3.5">
            {onOpenPublicAddProduct && (
              <button
                onClick={onOpenPublicAddProduct}
                className="bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white text-xs sm:text-sm font-black px-7 py-4 rounded-2xl flex items-center gap-2.5 shadow-xl shadow-rose-950/50 ring-2 ring-rose-400/40 hover:scale-[1.03] active:scale-[0.98] transition-all cursor-pointer"
              >
                <Plus className="w-4 h-4 text-rose-200" />
                <span>أضف منتجك مجاناً (بدون تسجيل) ✨</span>
              </button>
            )}

            <a
              href={`https://wa.me/${settings.whatsappNumber.replace(/\D/g, '')}?text=${encodeURIComponent(
                'مرحباً متجر أمازون دعاء، أود الاستفسار وطلب المنتجات.'
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-bold px-6 py-4 rounded-2xl flex items-center gap-2.5 shadow-xl transition-all"
            >
              <MessageCircle className="w-4 h-4 text-emerald-200" />
              <span>خدمة العملاء والطلب الفوري عبر واتساب</span>
            </a>

            <button
              onClick={onOpenAdmin}
              className="bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-bold px-6 py-4 rounded-2xl flex items-center gap-2.5 border border-white/20 backdrop-blur-sm transition-all cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-amber-300" />
              <span>لوحة الذكاء الاصطناعي للمنتجات</span>
            </button>
          </div>
        </div>
      </section>

      {/* Trust Badges Bar */}
      <TrustBadgesBar />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Luxury Bento Department Showcase (Replaces 11-col grid & duplicate pills bar) */}
        <section
          aria-label="أقسام أمازون دعاء الفاخرة"
          className="mb-8 bg-white p-5 sm:p-7 rounded-3xl border border-stone-200/90 shadow-xs space-y-4 overflow-hidden"
        >
          {/* Header + Clear Selection */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-stone-900 text-amber-300 flex items-center justify-center shadow-xs">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-black text-stone-900">
                  أقسام أمازون دعاء الفاخرة ({effectiveCategories.length} أقسام رئيسية)
                </h2>
                <p className="text-xs text-stone-500">
                  اختاري قسماً واحداً أو حددي عدة أقسام معاً لتصفح تشكيلاتك المفضلة في مكان واحد
                </p>
              </div>
            </div>

            {selectedCategories.length > 0 && (
              <button
                type="button"
                onClick={handleClearSelection}
                className="text-xs font-extrabold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 px-4 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>مسح التحديد ({selectedCategories.length})</span>
              </button>
            )}
          </div>

          {/* Card 0: Prominent "الكل" Storewide Anchor Card */}
          <button
            type="button"
            onClick={handleClearSelection}
            className={`w-full flex items-center justify-between gap-4 px-5 py-3.5 rounded-2xl border transition-all cursor-pointer text-right ${
              isAllMode
                ? 'bg-stone-950 text-white border-2 border-amber-400 ring-2 ring-amber-400/30 shadow-md'
                : 'bg-stone-50 hover:bg-stone-100 text-stone-800 border-stone-200'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  isAllMode ? 'bg-amber-400 text-stone-950' : 'bg-white border border-stone-200 text-stone-700'
                }`}
              >
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <div className="text-sm font-black">الكل — كامل متجر أمازون دعاء</div>
                <div className={`text-[11px] font-medium ${isAllMode ? 'text-stone-300' : 'text-stone-500'}`}>
                  عرض جميع الأقسام والتشكيلات الأصلية المتوفرة
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <span
                className={`text-xs font-black px-3 py-1 rounded-xl tabular-nums ${
                  isAllMode ? 'bg-white/15 text-amber-200' : 'bg-white border border-stone-200 text-stone-700'
                }`}
              >
                {products.length} منتج
              </span>
              {isAllMode && (
                <span className="w-6 h-6 rounded-full bg-amber-400 text-stone-950 flex items-center justify-center shadow-xs">
                  <Check className="w-3.5 h-3.5 stroke-[3]" />
                </span>
              )}
            </div>
          </button>

          {/* Top Row: 2 Large Featured Bento Department Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 overflow-hidden p-1.5 -m-1.5">
            {featuredTwo.map((cat) => {
              const IconComp = getCategoryIconComponent(cat.icon);
              const count = countMap.get(cat.id) || 0;
              const isSelected = selectedCategories.includes(cat.id);
              const bgImage = resolveCategoryImage(cat);

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => handleToggleCategory(cat.id)}
                  aria-pressed={isSelected}
                  title={`${cat.name_ar} — ${count} منتج`}
                  className={`bento-grid-card group relative overflow-hidden rounded-2xl h-44 sm:h-56 text-right cursor-pointer ${
                    isSelected
                      ? 'border-2 border-amber-400 ring-2 ring-amber-400/50 shadow-[0_14px_36px_-8px_rgba(245,158,11,0.45)]'
                      : 'border border-stone-200 hover:border-amber-400 hover:ring-2 hover:ring-amber-400/35 shadow-sm hover:shadow-[0_12px_32px_-8px_rgba(245,158,11,0.35)]'
                  }`}
                >
                  {bgImage ? (
                    <img
                      src={bgImage}
                      alt={cat.name_ar}
                      loading="lazy"
                      onError={(e) => {
                        const fallback = resolveCategoryFallbackImage(cat);
                        const imgEl = e.currentTarget;
                        if (fallback && imgEl.src !== fallback) {
                          imgEl.src = fallback;
                        }
                      }}
                      className="absolute inset-0 w-full h-full object-cover object-center transition-transform duration-500 ease-out motion-reduce:transition-none"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-stone-800" />
                  )}

                  {/* Enhanced high-contrast dark gradient overlay for optimal readability */}
                  <div
                    className={`absolute inset-0 transition-opacity duration-300 ${
                      isSelected
                        ? 'bg-gradient-to-t from-stone-950 via-stone-950/80 to-amber-950/45'
                        : 'bg-gradient-to-t from-stone-950 via-stone-950/75 to-stone-950/30 group-hover:from-stone-950 group-hover:via-stone-950/85 group-hover:to-stone-950/45'
                    }`}
                  />
                  {/* Subtle top vignette for crystal-clear top badge & icon contrast */}
                  <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-stone-950/70 via-stone-950/20 to-transparent pointer-events-none" />

                  {/* Interactive Hover Tooltip */}
                  <div
                    role="tooltip"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2 z-20 flex justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-all duration-200 ease-out transform -translate-y-1 group-hover:translate-y-0"
                  >
                    <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-stone-950/95 text-white border border-amber-400/60 shadow-[0_12px_32px_rgba(0,0,0,0.85)] backdrop-blur-md text-xs font-bold whitespace-nowrap">
                      <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span className="text-white font-extrabold">{cat.name_ar}</span>
                      <span className="text-white/30">·</span>
                      <span className="text-amber-300 font-black tabular-nums">{count} {count === 1 ? 'منتج' : 'منتجات'}</span>
                    </div>
                  </div>

                  {/* Top Selection / Badge Row */}
                  <div className="relative z-10 h-full p-5 flex flex-col justify-between">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-9 h-9 rounded-xl bg-white/15 backdrop-blur-md border border-white/20 text-amber-200 flex items-center justify-center">
                          <IconComp className="w-4 h-4" />
                        </span>
                        {cat.badge && (
                          <span className="text-[11px] font-extrabold px-2.5 py-1 rounded-full bg-amber-400/90 text-stone-950 shadow-xs">
                            {cat.badge}
                          </span>
                        )}
                      </div>

                      <span
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                          isSelected
                            ? 'bg-amber-400 text-stone-950 shadow-md scale-105'
                            : 'bg-white/15 border border-white/30 text-white/0 group-hover:text-white/80'
                        }`}
                      >
                        <Check className="w-4 h-4 stroke-[3]" />
                      </span>
                    </div>

                    <div>
                      <h3 className="text-lg sm:text-xl font-black text-white tracking-tight drop-shadow-md">
                        {cat.name_ar}
                      </h3>
                      <div className="mt-1 flex items-center gap-2 text-xs font-bold text-amber-200/95 tabular-nums drop-shadow-sm">
                        <span>{count} منتج أصلي</span>
                        <span className="text-white/40">•</span>
                        <span className="text-white/80 group-hover:text-amber-200 transition-colors">
                          {isSelected ? 'محدد حالياً' : 'اضغطي للتصفية'}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Second Row: 4 Symmetrical Bento Department Cards */}
          {restCategories.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 overflow-hidden p-1.5 -m-1.5">
              {restCategories.map((cat) => {
                const IconComp = getCategoryIconComponent(cat.icon);
                const count = countMap.get(cat.id) || 0;
                const isSelected = selectedCategories.includes(cat.id);
                const bgImage = resolveCategoryImage(cat);

                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handleToggleCategory(cat.id)}
                    aria-pressed={isSelected}
                    title={`${cat.name_ar} — ${count} منتج`}
                    className={`bento-grid-card group relative overflow-hidden rounded-2xl h-36 sm:h-44 text-right cursor-pointer ${
                      isSelected
                        ? 'border-2 border-amber-400 ring-2 ring-amber-400/50 shadow-[0_12px_30px_-8px_rgba(245,158,11,0.45)]'
                        : 'border border-stone-200 hover:border-amber-400 hover:ring-2 hover:ring-amber-400/35 shadow-xs hover:shadow-[0_10px_28px_-8px_rgba(245,158,11,0.32)]'
                    }`}
                  >
                    {bgImage ? (
                      <img
                        src={bgImage}
                        alt={cat.name_ar}
                        loading="lazy"
                        onError={(e) => {
                          const fallback = resolveCategoryFallbackImage(cat);
                          const imgEl = e.currentTarget;
                          if (fallback && imgEl.src !== fallback) {
                            imgEl.src = fallback;
                          }
                        }}
                        className="absolute inset-0 w-full h-full object-cover object-center transition-transform duration-500 ease-out motion-reduce:transition-none"
                      />
                    ) : (
                      <div className="absolute inset-0 bg-stone-800" />
                    )}

                    {/* Enhanced high-contrast dark gradient overlay for optimal readability */}
                    <div
                      className={`absolute inset-0 transition-opacity duration-300 ${
                        isSelected
                          ? 'bg-gradient-to-t from-stone-950 via-stone-950/80 to-amber-950/45'
                          : 'bg-gradient-to-t from-stone-950 via-stone-950/75 to-stone-950/30 group-hover:from-stone-950 group-hover:via-stone-950/85 group-hover:to-stone-950/45'
                      }`}
                    />
                    {/* Subtle top vignette for crystal-clear top badge & icon contrast */}
                    <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-stone-950/70 via-stone-950/20 to-transparent pointer-events-none" />

                    {/* Interactive Hover Tooltip */}
                    <div
                      role="tooltip"
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2 z-20 flex justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-all duration-200 ease-out transform -translate-y-1 group-hover:translate-y-0"
                    >
                      <div className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-xl bg-stone-950/95 text-white border border-amber-400/60 shadow-[0_12px_32px_rgba(0,0,0,0.85)] backdrop-blur-md text-[11px] sm:text-xs font-bold whitespace-nowrap">
                        <Layers className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-amber-400 shrink-0" />
                        <span className="text-white font-extrabold">{cat.name_ar}</span>
                        <span className="text-white/30">·</span>
                        <span className="text-amber-300 font-black tabular-nums">{count} {count === 1 ? 'منتج' : 'منتجات'}</span>
                      </div>
                    </div>

                    <div className="relative z-10 h-full p-3.5 sm:p-4 flex flex-col justify-between">
                      <div className="flex items-center justify-between gap-2">
                        <span className="w-8 h-8 rounded-xl bg-white/15 backdrop-blur-md border border-white/20 text-amber-200 flex items-center justify-center">
                          <IconComp className="w-4 h-4" />
                        </span>

                        <span
                          className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                            isSelected
                              ? 'bg-amber-400 text-stone-950 shadow-md scale-105'
                              : 'bg-white/15 border border-white/30 text-white/0 group-hover:text-white/80'
                          }`}
                        >
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                        </span>
                      </div>

                      <div>
                        <h3 className="text-sm sm:text-base font-black text-white line-clamp-1 drop-shadow-md">
                          {cat.name_ar}
                        </h3>
                        <p className="text-[11px] font-bold text-amber-200/95 tabular-nums mt-0.5 drop-shadow-sm">
                          {count} منتج
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Dynamic Sub-Categories Bar (Appears only when 1+ categories are selected, scoped strictly to selected products) */}
        {selectedCategories.length > 0 && availableSubTags.length > 0 && (
          <div className="bg-white p-3.5 sm:p-4 rounded-3xl border border-stone-200/80 mb-6 shadow-2xs">
            <div className="flex items-center justify-between gap-2 mb-2.5 px-1">
              <div className="flex items-center gap-1.5 text-xs font-bold text-stone-800">
                <Tag className="w-3.5 h-3.5 text-amber-600" />
                <span>تصنيفات فرعية من الأقسام المحددة ({availableSubTags.length}):</span>
              </div>
              {selectedTag !== 'all' && (
                <button
                  type="button"
                  onClick={() => setSelectedTag('all')}
                  className="text-[11px] font-semibold text-rose-600 hover:text-rose-700 flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                  <span>عرض كل تصنيفات القسم</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar scroll-smooth">
              <button
                type="button"
                onClick={() => setSelectedTag('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 cursor-pointer ${
                  selectedTag === 'all'
                    ? 'bg-stone-900 text-amber-300 shadow-xs'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                كل التشكيلات
              </button>

              {availableSubTags.map(({ tag, label, count }) => {
                const isSelected = selectedTag === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setSelectedTag(isSelected ? 'all' : tag)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 flex items-center gap-1.5 cursor-pointer ${
                      isSelected
                        ? 'bg-amber-500 text-stone-950 font-extrabold shadow-xs ring-2 ring-amber-300'
                        : 'bg-stone-50 hover:bg-amber-50 text-stone-700 border border-stone-200/80'
                    }`}
                  >
                    <Hash className={`w-3 h-3 ${isSelected ? 'text-stone-950' : 'text-amber-600'}`} />
                    <span>{label}</span>
                    <span
                      className={`text-[10px] px-1.5 rounded-full font-bold tabular-nums ${
                        isSelected ? 'bg-stone-950/15 text-stone-950' : 'bg-stone-200/80 text-stone-600'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Search, Sort & View Mode Switcher Bar */}
        <div
          ref={productsTopRef}
          className="bg-white p-3.5 sm:p-4 rounded-3xl border border-stone-200/80 mb-8 flex flex-col items-center gap-3 shadow-2xs scroll-mt-24"
        >
          <div className="w-full flex flex-col md:flex-row items-center justify-between gap-3">
            {/* Search Input */}
            <div className="relative w-full md:w-80">
              <input
                type="text"
                placeholder="تصفية بالكلمة أو الاحتياج..."
                value={activeQuery}
                onChange={(e) => handleQueryChange(e.target.value)}
                className="w-full text-xs p-2.5 pr-8 bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:border-rose-500 focus:outline-hidden"
              />
              <Search className="w-3.5 h-3.5 text-stone-400 absolute right-2.5 top-3" />
              {activeQuery && (
                <button
                  type="button"
                  onClick={() => handleQueryChange('')}
                  className="absolute left-2.5 top-2.5 text-stone-400 hover:text-stone-700 text-xs cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Right Controls: Product Count + Sort + View Mode Toggle */}
            <div className="flex flex-wrap items-center justify-between md:justify-end gap-2.5 w-full md:w-auto text-xs">
              <span className="text-stone-500 text-xs hidden sm:inline tabular-nums">
                عرض {filteredProducts.length} من {products.length} منتج
              </span>

              <div className="flex items-center gap-1.5">
                <ArrowUpDown className="w-3.5 h-3.5 text-stone-400" />
                <select
                  value={sortBy}
                  onChange={(e) => {
                    setSortBy(e.target.value as any);
                    if (isAllMode && viewMode === 'shelves' && e.target.value !== 'featured') {
                      setViewMode('grid');
                    }
                  }}
                  className="p-2 bg-stone-50 border border-stone-200 rounded-xl focus:outline-hidden focus:border-rose-500 text-xs font-semibold text-stone-800"
                >
                  <option value="featured">الأكثر طلباً ومميز</option>
                  <option value="newest">الأحدث وصولاً</option>
                  <option value="price-low">السعر: من الأقل للأعلى</option>
                  <option value="price-high">السعر: من الأعلى للأقل</option>
                  <option value="discount">أعلى نسبة خصم</option>
                </select>
              </div>

              {/* Shelves View vs Full Grid Toggle */}
              <div
                className="inline-flex items-center bg-stone-100 p-1 rounded-xl border border-stone-200"
                role="group"
                aria-label="تبديل طريقة العرض"
              >
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('shelves');
                    if (selectedCategories.length > 0) handleClearSelection();
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                    shouldShowShelves
                      ? 'bg-stone-900 text-amber-300 shadow-xs'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <Rows3 className="w-3.5 h-3.5" />
                  <span>عرض الرفوف</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                    !shouldShowShelves
                      ? 'bg-stone-900 text-amber-300 shadow-xs'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>العرض الشبكي</span>
                </button>
              </div>
            </div>
          </div>

          {/* Active Multi-Select & Search Filter Chips */}
          {(selectedCategories.length > 0 || selectedTag !== 'all' || activeQuery) && (
            <div className="w-full flex flex-wrap items-center gap-2 pt-2.5 border-t border-stone-100 text-xs">
              <span className="text-stone-500 font-medium text-[11px] flex items-center gap-1">
                <Filter className="w-3 h-3 text-amber-600" />
                <span>التصفية الحالية:</span>
              </span>

              {selectedCategories.map((catId) => {
                const catName = effectiveCategories.find((c) => c.id === catId)?.name_ar || catId;
                return (
                  <span
                    key={catId}
                    className="inline-flex items-center gap-1 bg-amber-50 text-amber-900 px-2.5 py-1 rounded-lg text-[11px] font-bold border border-amber-300"
                  >
                    <span>قسم: {catName}</span>
                    <button
                      type="button"
                      onClick={() => handleToggleCategory(catId)}
                      className="hover:text-rose-700 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}

              {selectedTag !== 'all' && (
                <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-700 px-2.5 py-1 rounded-lg text-[11px] font-bold border border-rose-200">
                  تصنيف فرعي: #{selectedTag.replace(/^#/, '').replace(/_/g, ' ')}
                  <button
                    type="button"
                    onClick={() => setSelectedTag('all')}
                    className="hover:text-rose-900 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}

              {activeQuery && (
                <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-700 px-2.5 py-1 rounded-lg text-[11px] font-bold border border-rose-200">
                  بحث: &quot;{activeQuery}&quot;
                  <button
                    type="button"
                    onClick={() => handleQueryChange('')}
                    className="hover:text-rose-900 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}

              <button
                type="button"
                onClick={() => {
                  handleClearSelection();
                  handleQueryChange('');
                }}
                className="text-stone-500 hover:text-rose-600 text-[11px] underline font-bold mr-auto transition-colors cursor-pointer"
              >
                مسح التحديد وإلغاء الفلاتر
              </button>
            </div>
          )}
        </div>

        {/* Display Content: Multi-Shelves View ("الكل") OR Organized Product Grid */}
        {filteredProducts.length === 0 ? (
          <div className="bg-white rounded-3xl border border-stone-200 p-12 text-center max-w-md mx-auto my-8">
            <div className="w-16 h-16 rounded-full bg-rose-50 text-rose-500 flex items-center justify-center mx-auto mb-4">
              <Search className="w-8 h-8" />
            </div>
            <h3 className="font-bold text-stone-800 text-base mb-1">
              لم نجد أي منتجات تطابق بحثك
            </h3>
            <p className="text-xs text-stone-500 mb-4">
              جربي البحث بكلمات أخرى أو مسح تحديد الأقسام لعرض كامل المتجر
            </p>
            <button
              type="button"
              onClick={() => {
                handleQueryChange('');
                handleClearSelection();
              }}
              className="bg-stone-900 text-white text-xs font-bold px-4 py-2 rounded-xl cursor-pointer"
            >
              عرض كافة المنتجات
            </button>
          </div>
        ) : shouldShowShelves ? (
          <div className="space-y-10">
            {shelves.map((shelf) => (
              <section key={shelf.id} aria-label={shelf.title} className="space-y-4">
                {/* Shelf Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 bg-white px-5 py-4 rounded-2xl border border-stone-200/80 shadow-2xs">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        shelf.kind === 'popular'
                          ? 'bg-amber-100 text-amber-700'
                          : shelf.kind === 'offers'
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-stone-100 text-stone-800'
                      }`}
                    >
                      {shelf.kind === 'popular' ? (
                        <Crown className="w-4 h-4" />
                      ) : shelf.kind === 'offers' ? (
                        <Percent className="w-4 h-4" />
                      ) : (
                        <Sparkles className="w-4 h-4 text-amber-600" />
                      )}
                    </div>
                    <div>
                      <h3 className="text-base sm:text-lg font-black text-stone-900">
                        {shelf.title}
                      </h3>
                      <p className="text-[11px] sm:text-xs text-stone-500">{shelf.subtitle}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (shelf.categoryId) {
                        setSelectedCategories([shelf.categoryId]);
                        setSelectedTag('all');
                      } else if (shelf.sortTarget) {
                        setSortBy(shelf.sortTarget);
                        setViewMode('grid');
                      }
                      scrollToCatalog();
                    }}
                    className="text-xs font-extrabold text-stone-800 hover:text-amber-800 bg-stone-100 hover:bg-amber-50 border border-stone-200 hover:border-amber-300 px-4 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-1"
                  >
                    <span>عرض الكل</span>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>

                {/* Shelf Product Grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
                  {shelf.products.map((product) => (
                    <ProductCard
                      key={`${shelf.id}-${product.id}`}
                      product={product}
                      onAddToCart={(p) => onAddToCart(p)}
                      onQuickView={onQuickView}
                      onOpenDetails={onOpenDetails}
                      settings={settings}
                      isInCart={cartProductIds.has(product.id)}
                      isWishlisted={wishlistIds.has(product.id)}
                      onToggleWishlist={onToggleWishlist}
                      onSelectTag={(tag) => setSelectedTag(tag)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {filteredProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onAddToCart={(p) => onAddToCart(p)}
                onQuickView={onQuickView}
                onOpenDetails={onOpenDetails}
                settings={settings}
                isInCart={cartProductIds.has(product.id)}
                isWishlisted={wishlistIds.has(product.id)}
                onToggleWishlist={onToggleWishlist}
                onSelectTag={(tag) => setSelectedTag(tag)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Floating WhatsApp Bubble */}
      <a
        href={`https://wa.me/${settings.whatsappNumber.replace(/\D/g, '')}?text=${encodeURIComponent(
          'مرحباً! أود الاستفسار عن منتجات متجر ' + settings.storeName
        )}`}
        target="_blank"
        rel="noopener noreferrer"
        title="تواصل معنا عبر واتساب"
        className="fixed bottom-6 left-6 z-30 bg-emerald-500 hover:bg-emerald-600 text-white w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all hover:scale-110 active:scale-95 group"
      >
        <MessageCircle className="w-7 h-7" />
        <span className="absolute right-16 bg-stone-900 text-white text-xs font-bold px-3 py-1.5 rounded-xl whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-md">
          تواصل معنا عبر واتساب
        </span>
      </a>
    </div>
  );
};
