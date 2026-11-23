import type { Category, Product } from '../types.ts';

export interface StorefrontShelf {
  id: string;
  kind: 'popular' | 'offers' | 'category';
  title: string;
  subtitle: string;
  categoryId?: string;
  sortTarget?: 'featured' | 'discount';
  products: Product[];
  totalAvailable: number;
}

/**
 * Combines base categories with any additional real category IDs present on fetched
 * Firestore products, preserving existing IDs without inventing synthetic categories.
 */
export function deriveEffectiveCategories(
  baseCategories: Category[],
  products: Product[]
): Category[] {
  const result = [...baseCategories];
  const seenIds = new Set(baseCategories.map((c) => c.id));

  for (const prod of products) {
    const cid = String(prod.category_id || '').trim();
    if (!cid || seenIds.has(cid)) continue;
    seenIds.add(cid);
    result.push({
      id: cid,
      name_ar: String(prod.category_name || cid).trim(),
      slug: cid,
      icon: 'Tag',
      image: prod.image_url || undefined,
    });
  }

  return result;
}

/**
 * Resolves the background image URL for a category card:
 * 1. Direct non-empty valid `category.image` from the database.
 * 2. Fallback to the first real product image (`image_url` or `gallery_images[0]`)
 *    matching this category's `id` or `name_ar` in the live store catalog.
 * 3. Optional bundled local category image asset fallback.
 */
export function resolveCategoryBackgroundImage(
  category: Pick<Category, 'id' | 'name_ar' | 'image'>,
  products: Product[],
  localFallbackImage?: string
): string | undefined {
  const isUsableUrl = (val?: string | null): val is string => {
    if (typeof val !== 'string') return false;
    const trimmed = val.trim();
    return trimmed.length > 0 && !trimmed.startsWith('blob:');
  };

  if (isUsableUrl(category.image)) {
    return category.image.trim();
  }

  const catIdLower = String(category.id || '').trim().toLowerCase();
  const catNameLower = String(category.name_ar || '').trim().toLowerCase();

  for (const product of products) {
    const prodCatId = String(product.category_id || '').trim().toLowerCase();
    const prodCatName = String(product.category_name || '').trim().toLowerCase();
    const matchesCategory =
      (catIdLower && prodCatId === catIdLower) ||
      (catNameLower && prodCatName === catNameLower);

    if (!matchesCategory) continue;
    if (isUsableUrl(product.image_url)) return product.image_url.trim();
    if (Array.isArray(product.gallery_images)) {
      const galleryHit = product.gallery_images.find((img) => isUsableUrl(img));
      if (galleryHit) return galleryHit.trim();
    }
  }

  return isUsableUrl(localFallbackImage) ? localFallbackImage.trim() : undefined;
}

/**
 * Partitions categories into the first 2 main store categories (2 large Bento cards)
 * and the subsequent categories (4 symmetrical Bento cards) with exact live product counts.
 */
export function partitionBentoCategories(
  categories: Category[],
  products: Product[]
): {
  featuredTwo: Category[];
  rest: Category[];
  countMap: Map<string, number>;
} {
  const countMap = new Map<string, number>();
  for (const c of categories) countMap.set(c.id, 0);
  for (const p of products) {
    const cid = p.category_id;
    if (cid) countMap.set(cid, (countMap.get(cid) || 0) + 1);
  }

  const featuredTwo = categories.slice(0, 2);
  const rest = categories.slice(2);

  return { featuredTwo, rest, countMap };
}

/**
 * Dynamically extracts sub-category tags solely from products within the selected
 * categories (or all products when none selected).
 */
export function extractScopedSubTags(
  products: Product[],
  selectedCategoryIds: string[]
): Array<{ tag: string; label: string; count: number }> {
  const scoped =
    selectedCategoryIds.length === 0
      ? products
      : products.filter((p) => selectedCategoryIds.includes(p.category_id));

  const tagMap = new Map<string, number>();
  for (const p of scoped) {
    if (!Array.isArray(p.tags)) continue;
    const perProductSeen = new Set<string>();
    for (const raw of p.tags) {
      const clean = String(raw || '').trim();
      if (!clean || perProductSeen.has(clean)) continue;
      perProductSeen.add(clean);
      tagMap.set(clean, (tagMap.get(clean) || 0) + 1);
    }
  }

  return Array.from(tagMap.entries())
    .map(([tag, count]) => ({
      tag,
      label: tag.replace(/^#/, '').replace(/_/g, ' '),
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Builds the curated multi-shelf view for "الكل" mode in strict order:
 * 1. الأكثر طلباً
 * 2. العروض المميزة
 * 3. قسم العناية بالبشرة (skincare)
 * 4. قسم المكياج (makeup)
 * 5. قسم العطور (perfumes)
 * 6. بقية الأقسام الموجودة في قاعدة البيانات
 *
 * Ensures deterministic cross-shelf deduplication across highlight shelves and
 * prioritizes unseen category products to avoid accidental repetition.
 */
export function buildStorefrontShelves(
  products: Product[],
  categories: Category[],
  maxPerShelf = 4
): StorefrontShelf[] {
  if (products.length === 0) return [];

  const shelves: StorefrontShelf[] = [];
  const usedHighlightIds = new Set<string>();

  // 1. رف الأكثر طلباً
  const popularSorted = [...products].sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    const ratingDiff = (b.rating || 0) - (a.rating || 0);
    if (ratingDiff !== 0) return ratingDiff;
    return (b.reviews_count || 0) - (a.reviews_count || 0);
  });
  const popularItems = popularSorted.slice(0, maxPerShelf);
  for (const p of popularItems) usedHighlightIds.add(p.id);

  if (popularItems.length > 0) {
    shelves.push({
      id: 'shelf-popular',
      kind: 'popular',
      title: 'الأكثر طلباً',
      subtitle: 'المنتجات الأعلى تقييماً والأكثر اقتناءً لدى عميلاتنا',
      sortTarget: 'featured',
      products: popularItems,
      totalAvailable: products.length,
    });
  }

  // 2. رف العروض المميزة (منتجات بخصم حقيقي وغير مكررة من الرف السابق)
  const allDiscounted = [...products]
    .filter((p) => p.discount_price !== null && p.discount_price > 0 && p.discount_price < p.original_price)
    .sort((a, b) => {
      const pctA = ((a.original_price - (a.discount_price ?? a.original_price)) / a.original_price);
      const pctB = ((b.original_price - (b.discount_price ?? b.original_price)) / b.original_price);
      return pctB - pctA;
    });

  const nonOverlappingOffers = allDiscounted.filter((p) => !usedHighlightIds.has(p.id));
  const offerItems = nonOverlappingOffers.slice(0, maxPerShelf);
  for (const p of offerItems) usedHighlightIds.add(p.id);

  if (offerItems.length > 0) {
    shelves.push({
      id: 'shelf-offers',
      kind: 'offers',
      title: 'العروض المميزة',
      subtitle: 'خصومات حصرية وتخفيضات مباشرة على منتجات أصلية',
      sortTarget: 'discount',
      products: offerItems,
      totalAvailable: allDiscounted.length,
    });
  }

  // 3..6. أقسام المتجر بالترتيب المحدد: العناية بالبشرة -> المكياج -> العطور -> بقية الأقسام
  const priorityCategoryOrder = ['skincare', 'makeup', 'perfumes'];
  const orderedCategories = [
    ...priorityCategoryOrder
      .map((id) => categories.find((c) => c.id === id))
      .filter((c): c is Category => Boolean(c)),
    ...categories.filter((c) => !priorityCategoryOrder.includes(c.id)),
  ];

  for (const cat of orderedCategories) {
    const allInCategory = products.filter((p) => p.category_id === cat.id);
    if (allInCategory.length === 0) continue;

    // Prefer non-highlighted items in category shelves to minimize repetition across shelves;
    // if all items in a small category appeared above, keep authentic category items so the shelf still shows its real products.
    const unseenInCat = allInCategory.filter((p) => !usedHighlightIds.has(p.id));
    const shelfProducts = (unseenInCat.length > 0 ? unseenInCat : allInCategory).slice(0, maxPerShelf);

    shelves.push({
      id: `shelf-cat-${cat.id}`,
      kind: 'category',
      title: `قسم ${cat.name_ar}`,
      subtitle: `تشكيلة ${cat.name_ar} الأصلية (${allInCategory.length} منتج)`,
      categoryId: cat.id,
      products: shelfProducts,
      totalAvailable: allInCategory.length,
    });
  }

  return shelves;
}
