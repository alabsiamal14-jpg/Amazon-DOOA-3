import { describe, it, expect } from 'vitest';
import {
  buildStorefrontShelves,
  deriveEffectiveCategories,
  extractScopedSubTags,
  partitionBentoCategories,
  resolveCategoryBackgroundImage,
} from '../src/lib/storefront';
import { INITIAL_CATEGORIES, INITIAL_PRODUCTS } from '../src/data/initialData';

describe('Luxury Bento Departments, Multi-Select & Storefront Shelves', () => {
  it('preserves existing category IDs without creating fake categories and handles extra Firebase categories', () => {
    const base = deriveEffectiveCategories(INITIAL_CATEGORIES, INITIAL_PRODUCTS);
    expect(base.map((c) => c.id)).toEqual([
      'skincare',
      'perfumes',
      'makeup',
      'haircare',
      'bodycare',
      'devices',
    ]);

    const withExtraProduct = [
      ...INITIAL_PRODUCTS,
      {
        ...INITIAL_PRODUCTS[0],
        id: 'extra-fb-1',
        category_id: 'organic_oils',
        category_name: 'زيوت عضوية',
      },
    ];
    const merged = deriveEffectiveCategories(INITIAL_CATEGORIES, withExtraProduct);
    expect(merged.some((c) => c.id === 'organic_oils' && c.name_ar === 'زيوت عضوية')).toBe(true);
  });

  it('partitions categories into the first 2 main Bento cards + remaining 4 balanced cards using real counts', () => {
    const { featuredTwo, rest, countMap } = partitionBentoCategories(
      INITIAL_CATEGORIES,
      INITIAL_PRODUCTS
    );
    expect(featuredTwo).toHaveLength(2);
    expect(featuredTwo.map((c) => c.id)).toEqual(['skincare', 'perfumes']);
    expect(rest).toHaveLength(4);
    expect(rest.map((c) => c.id)).toEqual(['makeup', 'haircare', 'bodycare', 'devices']);
    const totalFromCounts = Array.from(countMap.values()).reduce((sum, n) => sum + n, 0);
    expect(totalFromCounts).toBe(INITIAL_PRODUCTS.length);
  });

  it('extracts sub-category tags strictly from products inside the selected categories', () => {
    const selectedOnlyPerfumes = extractScopedSubTags(INITIAL_PRODUCTS, ['perfumes']);
    const perfumeTags = new Set(
      INITIAL_PRODUCTS.filter((p) => p.category_id === 'perfumes').flatMap((p) => p.tags)
    );
    for (const row of selectedOnlyPerfumes) {
      expect(perfumeTags.has(row.tag)).toBe(true);
    }

    const multiSelected = extractScopedSubTags(INITIAL_PRODUCTS, ['skincare', 'perfumes']);
    const combinedTags = new Set(
      INITIAL_PRODUCTS.filter((p) => p.category_id === 'skincare' || p.category_id === 'perfumes').flatMap(
        (p) => p.tags
      )
    );
    expect(multiSelected.length).toBeGreaterThan(0);
    for (const row of multiSelected) {
      expect(combinedTags.has(row.tag)).toBe(true);
    }
  });

  it('builds shelves in exact required order without duplicating products between highlight shelves', () => {
    const shelves = buildStorefrontShelves(INITIAL_PRODUCTS, INITIAL_CATEGORIES, 4);
    expect(shelves.length).toBeGreaterThanOrEqual(4);

    // Check strict initial ordering: الأكثر طلباً -> العروض المميزة -> العناية بالبشرة -> المكياج -> العطور -> بقية الأقسام
    expect(shelves[0].id).toBe('shelf-popular');
    expect(shelves[1].id).toBe('shelf-offers');

    const popularIds = new Set(shelves[0].products.map((p) => p.id));
    for (const offerProd of shelves[1].products) {
      expect(popularIds.has(offerProd.id)).toBe(false);
    }

    const categoryShelfOrder = shelves
      .filter((s) => s.kind === 'category')
      .map((s) => s.categoryId);

    const idxSkin = categoryShelfOrder.indexOf('skincare');
    const idxMakeup = categoryShelfOrder.indexOf('makeup');
    const idxPerfumes = categoryShelfOrder.indexOf('perfumes');
    const idxHair = categoryShelfOrder.indexOf('haircare');

    if (idxSkin !== -1 && idxMakeup !== -1) expect(idxSkin).toBeLessThan(idxMakeup);
    if (idxMakeup !== -1 && idxPerfumes !== -1) expect(idxMakeup).toBeLessThan(idxPerfumes);
    if (idxPerfumes !== -1 && idxHair !== -1) expect(idxPerfumes).toBeLessThan(idxHair);
  });

  it('resolves category image directly or falls back to the first real product image in that category', () => {
    const withDirectImage = resolveCategoryBackgroundImage(
      INITIAL_CATEGORIES[0],
      INITIAL_PRODUCTS
    );
    expect(withDirectImage).toBe(INITIAL_CATEGORIES[0].image);

    const noDirectImageCat = { ...INITIAL_CATEGORIES[0], image: '' };
    const expectedFirstProductImg = INITIAL_PRODUCTS.find(
      (p) => p.category_id === noDirectImageCat.id && p.image_url
    )?.image_url;
    const fallbackResolved = resolveCategoryBackgroundImage(
      noDirectImageCat,
      INITIAL_PRODUCTS
    );
    expect(fallbackResolved).toBe(expectedFirstProductImg);

    const noMatchCat = { id: 'nonexistent', name_ar: 'غير موجود', image: '' };
    expect(resolveCategoryBackgroundImage(noMatchCat, INITIAL_PRODUCTS)).toBeUndefined();
  });
});

