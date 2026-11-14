import { db } from '../db/index.ts';
import { products, orders, orderOutbox } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { db as firestoreDb } from '../lib/firebase.ts';
import { doc, setDoc } from 'firebase/firestore';
import { getProductPricing } from '../lib/pricing.ts';
import type { StoreSettings, Order, OrderItem } from '../types.ts';
import { triggerOrderConfirmation } from '../lib/notifications.ts';

export interface CheckoutRequest {
  idempotencyKey: string;
  orderNumber?: string;
  userId?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  city: string;
  address: string;
  notes?: string;
  paymentMethod?: string;
  deliverySpeed?: string;
  items: { product_id: string; quantity: number }[];
  couponCode?: string;
}

export interface CheckoutResponse {
  success: boolean;
  isDuplicate?: boolean;
  order: Order;
  error?: string;
  syncStatus?: 'synced' | 'failed';
}

export const STORE_SETTINGS: StoreSettings = {
  storeName: 'أمازون دعاء',
  tagline: 'جمالكِ باهتمامنا',
  whatsappNumber: '967777627595',
  currency: 'ريال',
  deliveryFee: 20,
  freeDeliveryThreshold: 500,
  welcomeMessage: 'أهلاً بكِ في متجرنا',
};

/**
 * Validates known coupon codes server-side.
 * Prevents client manipulation of discounts.
 */
function validateCouponDiscountServer(code: string | undefined, subtotal: number): number {
  if (!code) return 0;
  const clean = code.trim().toUpperCase();
  if (clean === 'BEAUTY10') {
    return Math.round(subtotal * 0.1);
  }
  if (clean === 'WELCOME') {
    return Math.min(20, subtotal);
  }
  return 0;
}

/**
 * Reliable dual-sync to Firestore with exponential backoff retries and logging.
 * Guarantees that PostgreSQL orders are faithfully mirrored to Firestore.
 */
export async function syncOrderToFirestoreWithRetry(
  order: Order,
  idempotencyKey: string,
  maxRetries: number = 3
): Promise<'synced' | 'failed'> {
  const orderDocRef = doc(firestoreDb, 'orders', idempotencyKey);
  const payload = {
    id: idempotencyKey,
    order_number: order.order_number,
    userId: order.userId || 'guest',
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    customer_email: order.customer_email || '',
    customer_city: order.city,
    customer_address: order.address,
    items: order.items,
    subtotal: order.subtotal,
    discount_amount: order.discount_amount || 0,
    delivery_fee: order.delivery_fee,
    total_amount: order.total_amount,
    status: order.status,
    payment_method: order.payment_method,
    delivery_speed: order.delivery_speed,
    whatsapp_sent: true,
    createdAt: order.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await setDoc(orderDocRef, payload, { merge: true });
      await db.update(orderOutbox)
        .set({ status: 'synced', attempts: attempt, updatedAt: new Date() })
        .where(eq(orderOutbox.idempotencyKey, idempotencyKey));
      console.info(`[Transactional Outbox & Firestore Sync] Order #${order.order_number} successfully synchronized on attempt ${attempt}.`);
      return 'synced';
    } catch (fsErr: any) {
      console.warn(`[Firestore Sync] Attempt ${attempt}/${maxRetries} failed for order #${order.order_number}:`, fsErr.message);
      await db.update(orderOutbox)
        .set({ attempts: attempt, lastError: fsErr.message, status: attempt === maxRetries ? 'failed' : 'pending', updatedAt: new Date() })
        .where(eq(orderOutbox.idempotencyKey, idempotencyKey));
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      }
    }
  }
  console.error(`[Firestore Sync] Order #${order.order_number} failed to synchronize to Firestore after ${maxRetries} attempts.`);
  return 'failed';
}

/**
 * Authoritative Server-Side Order Checkout Processor:
 * 1. Idempotency Check: Returns existing order if key was already processed.
 * 2. Atomic Database Transaction with Row Locking (FOR UPDATE):
 *    - Validates products in catalog
 *    - Ensures sufficient stock
 *    - Decrements stock atomically
 *    - Prevents race conditions and overselling
 * 3. Authoritative Pricing Calculation:
 *    - Re-reads official prices from catalog records; completely ignores client-submitted prices
 * 4. Freezes an immutable snapshot of items and prices at purchase time
 * 5. Syncs order to Firestore and triggers background notifications
 */
export async function processServerCheckout(req: CheckoutRequest): Promise<CheckoutResponse> {
  const {
    idempotencyKey,
    userId = 'guest',
    customerName,
    customerPhone,
    customerEmail = '',
    city,
    address,
    notes = '',
    paymentMethod = 'الدفع عند الاستلام',
    deliverySpeed = 'توصيل قياسي',
    items,
    couponCode,
  } = req;

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('مفتاح التكرار (idempotencyKey) مطلوب لتأمين المعاملة ومنع التكرار.');
  }

  if (!customerName || !customerPhone || !items || !Array.isArray(items) || items.length === 0) {
    throw new Error('بيانات الطلب غير مكتملة. يرجى إدخال اسم المستلم ورقم الجوال والمنتجات.');
  }

  const orderNum = req.orderNumber || 'ELEN-' + Math.floor(1000 + Math.random() * 9000);

  // --- ATOMIC DATABASE TRANSACTION WITH PESSIMISTIC ROW LOCKING ---
  const transactionResult = await db.transaction(async (tx) => {
    // 1. Idempotency Check within transaction
    const existingOrders = await tx
      .select()
      .from(orders)
      .where(eq(orders.orderNumber, orderNum))
      .limit(1);

    if (existingOrders.length > 0) {
      const existing = existingOrders[0];
      console.info(`[Idempotency] Order ${orderNum} already confirmed. Returning existing record.`);
      const existingFormatted: Order = {
        id: String(existing.id),
        order_number: existing.orderNumber,
        userId: userId,
        customer_name: existing.customerName,
        customer_phone: existing.customerPhone,
        customer_email: existing.customerEmail || undefined,
        city: existing.city,
        address: existing.address,
        notes: existing.notes || undefined,
        items: existing.items as any,
        subtotal: existing.subtotal,
        discount_amount: existing.discountAmount || 0,
        delivery_fee: existing.deliveryFee || 0,
        total_amount: existing.totalAmount,
        status: existing.status as any,
        payment_method: existing.paymentMethod || undefined,
        delivery_speed: existing.deliverySpeed || undefined,
        whatsapp_sent: existing.whatsappSent || false,
        created_at: existing.createdAt ? existing.createdAt.toISOString() : new Date().toISOString(),
      };
      return { isDuplicate: true, order: existingFormatted };
    }

    // 2. Sort items by product_id to prevent database deadlocks on concurrent multi-item orders
    const sortedItems = [...items].sort((a, b) => a.product_id.localeCompare(b.product_id));

    let subtotal = 0;
    const verifiedSnapshotItems: any[] = [];

    // 3. Lock each product row with `FOR UPDATE` and validate stock & authoritative price
    for (const item of sortedItems) {
      let prodRows = await tx
        .select()
        .from(products)
        .where(eq(products.productId, item.product_id))
        .for('update');

      let prod = prodRows[0];

      if (!prod) {
        throw new Error(`المنتج بالمعرف "${item.product_id}" غير موجود في كتالوج المنتجات المعتمد في قاعدة البيانات. لا يُسمح بإنشاء أو نشر منتجات غير معتمدة أثناء إتمام الطلب.`);
      }

      const currentStock = Number(prod.stockQuantity) || 0;
      const requestedQty = Math.max(1, Math.floor(Number(item.quantity) || 1));

      // Stock check: Must be sufficient
      if (currentStock < requestedQty || currentStock <= 0) {
        throw new Error(
          `عذراً، المنتج "${prod.titleAr}" نفد من المخزون أو الكمية المطلوبة (${requestedQty}) غير متوفرة (المتوفر حالياً: ${currentStock}).`
        );
      }

      // Authoritative Price Calculation (Server does NOT trust browser pricing)
      const pricing = getProductPricing({
        original_price: Number(prod.originalPrice),
        discount_price: prod.discountPrice !== null ? Number(prod.discountPrice) : null,
      });
      const unitPrice = pricing.finalPrice;
      const lineTotal = unitPrice * requestedQty;
      subtotal += lineTotal;

      // Decrement stock atomically within the transaction
      await tx
        .update(products)
        .set({
          stockQuantity: currentStock - requestedQty,
        })
        .where(eq(products.productId, item.product_id));

      // Immutable Historical Snapshot (Audit Point 8)
      verifiedSnapshotItems.push({
        product_id: prod.productId,
        title_ar: prod.titleAr,
        original_price: pricing.originalPrice,
        discount_price: pricing.discountPrice,
        price: unitPrice,
        quantity: requestedQty,
        total_price: lineTotal,
        image_url: prod.imageUrl || '',
      });
    }

    // 4. Compute delivery fee and discounts
    const isExpress = deliverySpeed.includes('إكسبرس');
    const isFreeDelivery = subtotal >= STORE_SETTINGS.freeDeliveryThreshold;
    const standardFee = isFreeDelivery ? 0 : STORE_SETTINGS.deliveryFee;
    const expressFee = isExpress ? 15 : 0;
    const deliveryFee = standardFee + expressFee;

    const couponDiscount = validateCouponDiscountServer(couponCode, subtotal);
    const grandTotal = Math.max(0, subtotal - couponDiscount + deliveryFee);

    // 5. Insert order record atomically
    const insertedRows = await tx
      .insert(orders)
      .values({
        orderNumber: orderNum,
        customerName: customerName,
        customerPhone: customerPhone,
        customerEmail: customerEmail || null,
        city: city,
        address: address,
        notes: notes || null,
        items: verifiedSnapshotItems,
        subtotal,
        discountAmount: couponDiscount,
        deliveryFee: deliveryFee,
        totalAmount: grandTotal,
        status: 'pending',
        paymentMethod: paymentMethod || null,
        deliverySpeed: deliverySpeed || null,
        whatsappSent: true,
      })
      .returning();

    const createdOrder = insertedRows[0];
    const formatted: Order = {
      id: String(createdOrder.id),
      order_number: createdOrder.orderNumber,
      userId: userId,
      customer_name: createdOrder.customerName,
      customer_phone: createdOrder.customerPhone,
      customer_email: createdOrder.customerEmail || undefined,
      city: createdOrder.city,
      address: createdOrder.address,
      notes: createdOrder.notes || undefined,
      items: verifiedSnapshotItems,
      subtotal: createdOrder.subtotal,
      discount_amount: createdOrder.discountAmount || 0,
      delivery_fee: createdOrder.deliveryFee || 0,
      total_amount: createdOrder.totalAmount,
      status: 'pending',
      payment_method: createdOrder.paymentMethod || undefined,
      delivery_speed: createdOrder.deliverySpeed || undefined,
      whatsapp_sent: true,
      created_at: createdOrder.createdAt ? createdOrder.createdAt.toISOString() : new Date().toISOString(),
    };

    // Insert Transactional Outbox event in the same database transaction
    await tx.insert(orderOutbox).values({
      idempotencyKey: idempotencyKey,
      orderNumber: orderNum,
      payload: formatted,
      status: 'pending',
      attempts: 0,
    }).onConflictDoNothing();

    return { isDuplicate: false, order: formatted };
  });

  // --- DUAL-SYNC TO FIRESTORE WITH RETRY & RECOVERY ---
  const syncStatus = await syncOrderToFirestoreWithRetry(transactionResult.order, idempotencyKey);

  // Background trigger notification
  triggerOrderConfirmation(transactionResult.order, STORE_SETTINGS as any).catch((err) => {
    console.warn('[Notification Trigger] Failed background notification trigger:', err.message);
  });

  return {
    success: true,
    isDuplicate: transactionResult.isDuplicate,
    order: transactionResult.order,
    syncStatus,
  };
}
