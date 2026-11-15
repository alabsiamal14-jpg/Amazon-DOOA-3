import { db, isPostgresConfigured } from './index.ts';
import { products } from './schema.ts';
import { eq, desc } from 'drizzle-orm';
import type { Product } from '../types.ts';
import { INITIAL_PRODUCTS } from '../data/initialData.ts';

type DbProductRow = typeof products.$inferSelect;

let memoryProducts: DbProductRow[] | null = null;
let memoryIdCounter = 1;

function getMemoryProducts(): DbProductRow[] {
  if (!memoryProducts) {
    memoryProducts = INITIAL_PRODUCTS.map((p, idx) => ({
      id: idx + 1,
      productId: p.id,
      titleAr: p.title_ar,
      descriptionAr: p.description_ar || '',
      originalPrice: Number(p.original_price || 0),
      discountPrice: p.discount_price !== undefined && p.discount_price !== null ? Number(p.discount_price) : null,
      stockQuantity: Number(p.stock_quantity ?? 10),
      categoryId: p.category_id || 'skincare',
      categoryName: p.category_name || 'عناية بالبشرة',
      imageUrl: p.image_url || '',
      galleryImages: p.gallery_images || [],
      tags: p.tags || [],
      rating: Number(p.rating ?? 5.0),
      reviewsCount: Number(p.reviews_count ?? 0),
      aiGenerated: Boolean(p.ai_generated),
      featured: Boolean(p.featured),
      sizeOrVolume: p.size_or_volume || null,
      skinType: p.skin_type || null,
      keyBenefits: p.key_benefits || [],
      howToUse: p.how_to_use || null,
      ingredients: p.ingredients || null,
      badge: p.badge || null,
      status: p.status || 'published',
      creatorId: p.creator_id || null,
      createdAt: p.created_at ? new Date(p.created_at) : new Date(),
    }));
    memoryIdCounter = memoryProducts.length + 1;
  }
  return memoryProducts;
}

export async function getAllProducts() {
  if (!isPostgresConfigured) {
    return [...getMemoryProducts()].sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
  }
  try {
    const records = await db.select().from(products).orderBy(desc(products.createdAt));
    return records;
  } catch (error) {
    console.error('Database query failed:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}

export async function getProductById(productId: string) {
  if (!isPostgresConfigured) {
    return getMemoryProducts().find((p) => p.productId === productId) || null;
  }
  try {
    const records = await db.select().from(products).where(eq(products.productId, productId)).limit(1);
    return records[0] || null;
  } catch (error) {
    console.error('Database query failed:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}

export async function upsertProduct(product: Partial<Product> & { id: string; title_ar: string; category_id: string; category_name: string; original_price: number; image_url: string }) {
  if (!isPostgresConfigured) {
    const list = getMemoryProducts();
    const existingIdx = list.findIndex((p) => p.productId === product.id);
    const row: DbProductRow = {
      id: existingIdx >= 0 ? list[existingIdx].id : memoryIdCounter++,
      productId: product.id,
      titleAr: product.title_ar || 'منتج',
      descriptionAr: product.description_ar || '',
      originalPrice: Number(product.original_price || 0),
      discountPrice: product.discount_price !== undefined && product.discount_price !== null ? Number(product.discount_price) : null,
      stockQuantity: product.stock_quantity !== undefined ? Number(product.stock_quantity) : 10,
      categoryId: product.category_id || 'skincare',
      categoryName: product.category_name || 'عناية بالبشرة',
      imageUrl: product.image_url || '',
      galleryImages: product.gallery_images || [],
      tags: product.tags || [],
      rating: product.rating ?? 5.0,
      reviewsCount: product.reviews_count ?? 0,
      aiGenerated: product.ai_generated ?? false,
      featured: product.featured ?? false,
      sizeOrVolume: product.size_or_volume || null,
      skinType: product.skin_type || null,
      keyBenefits: product.key_benefits || [],
      howToUse: product.how_to_use || null,
      ingredients: product.ingredients || null,
      badge: product.badge || null,
      status: product.status || 'published',
      creatorId: product.creator_id || null,
      createdAt: existingIdx >= 0 ? list[existingIdx].createdAt : new Date(),
    };
    if (existingIdx >= 0) {
      list[existingIdx] = row;
    } else {
      list.unshift(row);
    }
    return row;
  }

  try {
    const result = await db
      .insert(products)
      .values({
        productId: product.id,
        titleAr: product.title_ar || 'منتج',
        descriptionAr: product.description_ar || '',
        originalPrice: Number(product.original_price || 0),
        discountPrice: product.discount_price !== undefined && product.discount_price !== null ? Number(product.discount_price) : null,
        stockQuantity: product.stock_quantity !== undefined ? Number(product.stock_quantity) : 10,
        categoryId: product.category_id || 'skincare',
        categoryName: product.category_name || 'عناية بالبشرة',
        imageUrl: product.image_url || '',
        galleryImages: product.gallery_images || [],
        tags: product.tags || [],
        rating: product.rating ?? 5.0,
        reviewsCount: product.reviews_count ?? 0,
        aiGenerated: product.ai_generated ?? false,
        featured: product.featured ?? false,
        sizeOrVolume: product.size_or_volume || null,
        skinType: product.skin_type || null,
        keyBenefits: product.key_benefits || [],
        howToUse: product.how_to_use || null,
        ingredients: product.ingredients || null,
        badge: product.badge || null,
        status: product.status || 'published',
        creatorId: product.creator_id || null,
      })
      .onConflictDoUpdate({
        target: products.productId,
        set: {
          titleAr: product.title_ar,
          descriptionAr: product.description_ar || '',
          originalPrice: product.original_price,
          discountPrice: product.discount_price ?? null,
          stockQuantity: product.stock_quantity ?? 10,
          categoryId: product.category_id,
          categoryName: product.category_name,
          imageUrl: product.image_url,
          galleryImages: product.gallery_images || [],
          tags: product.tags || [],
          rating: product.rating ?? 5.0,
          reviewsCount: product.reviews_count ?? 0,
          aiGenerated: product.ai_generated ?? false,
          featured: product.featured ?? false,
          sizeOrVolume: product.size_or_volume || null,
          skinType: product.skin_type || null,
          keyBenefits: product.key_benefits || [],
          howToUse: product.how_to_use || null,
          ingredients: product.ingredients || null,
          badge: product.badge || null,
          status: product.status ?? 'published',
          creatorId: product.creator_id ?? null,
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Failed to upsert product:', error);
    throw new Error('Database operation failed. Please try again later.', { cause: error });
  }
}

export async function deleteProductFromDb(productId: string) {
  if (!isPostgresConfigured) {
    const list = getMemoryProducts();
    const idx = list.findIndex((p) => p.productId === productId);
    if (idx === -1) return null;
    const [removed] = list.splice(idx, 1);
    return removed;
  }
  try {
    const result = await db.delete(products).where(eq(products.productId, productId)).returning();
    return result[0] || null;
  } catch (error) {
    console.error('Failed to delete product from database:', error);
    throw new Error('Failed to delete product from database.', { cause: error });
  }
}

export async function updateProductStockInDb(productId: string, newStock: number) {
  if (!isPostgresConfigured) {
    const item = getMemoryProducts().find((p) => p.productId === productId);
    if (!item) return null;
    item.stockQuantity = newStock;
    return item;
  }
  try {
    const result = await db.update(products).set({ stockQuantity: newStock }).where(eq(products.productId, productId)).returning();
    return result[0] || null;
  } catch (error) {
    console.error('Failed to update product stock in database:', error);
    throw new Error('Failed to update product stock in database.', { cause: error });
  }
}

