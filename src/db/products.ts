import { db } from './index.ts';
import { products, reviews } from './schema.ts';
import { eq, desc } from 'drizzle-orm';
import type { Product } from '../types.ts';

export async function getAllProducts() {
  try {
    const records = await db.select().from(products).orderBy(desc(products.createdAt));
    return records;
  } catch (error) {
    console.error('Database query failed:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}

export async function getProductById(productId: string) {
  try {
    const records = await db.select().from(products).where(eq(products.productId, productId)).limit(1);
    return records[0] || null;
  } catch (error) {
    console.error('Database query failed:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}

export async function upsertProduct(product: Partial<Product> & { id: string; title_ar: string; category_id: string; category_name: string; original_price: number; image_url: string }) {
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
  try {
    const result = await db.delete(products).where(eq(products.productId, productId)).returning();
    return result[0] || null;
  } catch (error) {
    console.error('Failed to delete product from database:', error);
    throw new Error('Failed to delete product from database.', { cause: error });
  }
}

export async function updateProductStockInDb(productId: string, newStock: number) {
  try {
    const result = await db.update(products).set({ stockQuantity: newStock }).where(eq(products.productId, productId)).returning();
    return result[0] || null;
  } catch (error) {
    console.error('Failed to update product stock in database:', error);
    throw new Error('Failed to update product stock in database.', { cause: error });
  }
}

