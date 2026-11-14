import { Router, Response } from 'express';
import { runTransaction, doc, collection, getDocs, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../../../lib/firebase.ts';
import { requireAuth, AuthRequest } from '../../../middleware/auth.ts';
import { VideoOrderPreviewData, MatchedVideoOrderItem } from '../../../types/videoOrder.ts';
import { Order, OrderItem, OrderStatus } from '../../../types.ts';
import { triggerOrderConfirmation } from '../../../lib/notifications.ts';
import { getProductPricing } from '../../../lib/pricing.ts';

const router = Router();

// Helper to normalize Arabic strings for high-fidelity matching
const normalizeArabic = (str: string): string => {
  if (!str) return '';
  return str
    .replace(/[\u064B-\u065F]/g, '') // remove diacritics (tashkeel)
    .replace(/[أإآا]/g, 'ا')        // normalize alefs
    .replace(/ة/g, 'ه')            // normalize teh marbuta
    .replace(/ى/g, 'ي')            // normalize alef maksura
    .replace(/\s+/g, ' ')          // collapse whitespaces
    .trim()
    .toLowerCase();
};

// Endpoint: POST /api/video-orders/confirm
router.post('/confirm', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ error: 'غير مصرح: لم يتم التعرف على معرف المستخدم.' });
    }

    const {
      customer_name,
      customer_phone,
      city,
      address,
      notes,
      items, // array of { product_name_raw: string, quantity: number, resolvedProductId?: string }
      idempotencyKey,
    } = req.body;

    if (!customer_name || !customer_phone || !city || !address || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'البيانات المرسلة غير مكتملة لتأكيد الطلب.' });
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'مفتاح التكرار (idempotencyKey) مطلوب لتأمين المعاملة.' });
    }

    console.info(`[Video Confirm] Processing confirmation for user ${userId}. IdempotencyKey: ${idempotencyKey}`);

    // --- IDEMPOTENCY CHECK via Firestore Transaction ---
    // If the order with this exact idempotencyKey already exists, simply return it.
    const orderDocRef = doc(db, 'orders', idempotencyKey);
    const existingOrderSnap = await getDoc(orderDocRef);
    if (existingOrderSnap.exists()) {
      console.info(`[Video Confirm] Order already processed. Returning existing order. IdempotencyKey: ${idempotencyKey}`);
      const orderData = existingOrderSnap.data();
      
      // Re-generate WhatsApp URL
      const waNumber = '967777627595';
      const waMessage = `السلام عليكم، تم تأكيد طلبي (رقم المرجع: ${orderData.order_number}) من خلال استوديو الفيديو الذكي بنجاح!\n\n` +
        `اسم العميل: ${orderData.customer_name}\n` +
        `الهاتف: ${orderData.customer_phone}\n` +
        `العنوان: ${orderData.customer_city} - ${orderData.customer_address}\n` +
        (orderData.notes ? `الملاحظات: ${orderData.notes}\n` : '') +
        `المجموع النهائي: ${orderData.total_amount} ريال\n\n` +
        `شكراً لكم!`;
      const whatsappUrl = `https://api.whatsapp.com/send?phone=${waNumber}&text=${encodeURIComponent(waMessage)}`;

      return res.json({
        success: true,
        isDuplicate: true,
        orderId: idempotencyKey,
        order: {
          id: idempotencyKey,
          order_number: orderData.order_number,
          total_amount: orderData.total_amount,
          status: orderData.status,
        },
        whatsappUrl,
      });
    }

    // --- PRODUCT RESOLUTION, PRICING, AND CONCURRENCY TRANSACTION ---
    // Execute a secure transaction to check & decrement stock, read true prices, and write the order.
    const transactionResult = await runTransaction(db, async (transaction) => {
      // 1. Fetch all products from DB to perform safe server-side matching
      const productsSnap = await getDocs(collection(db, 'products'));
      const dbProducts = productsSnap.docs.map(d => ({ id: d.id, ...d.data() as any }));

      const resolvedItems: MatchedVideoOrderItem[] = [];
      let subtotal = 0;

      for (const reqItem of items) {
        const rawName = reqItem.product_name_raw || '';
        const normRawName = normalizeArabic(rawName);
        const reqQty = parseInt(reqItem.quantity) || 1;

        if (reqQty <= 0) {
          throw new Error(`كمية غير صالحة للمنتج: ${rawName}`);
        }

        let matchedProduct = null;

        // A. If the frontend already resolved a specific product, check it first
        if (reqItem.resolvedProductId) {
          matchedProduct = dbProducts.find(p => p.id === reqItem.resolvedProductId);
        }

        // B. Otherwise, run fuzzy-matching on titles
        if (!matchedProduct) {
          const candidates = dbProducts.filter(p => {
            const normTitle = normalizeArabic(p.title_ar);
            return normTitle.includes(normRawName) || normRawName.includes(normTitle);
          });

          if (candidates.length === 0) {
            throw new Error(`ProductNotFound:${rawName}`);
          }
          if (candidates.length > 1) {
            const namesList = candidates.map(c => c.title_ar).join(' | ');
            throw new Error(`ProductAmbiguous:${rawName}:${namesList}`);
          }
          matchedProduct = candidates[0];
        }

        // C. Fetch product current state inside transaction for concurrency safety
        const prodRef = doc(db, 'products', matchedProduct.id);
        const prodSnap = await transaction.get(prodRef);
        if (!prodSnap.exists()) {
          throw new Error(`المنتج "${matchedProduct.title_ar}" لم يعد متوفراً.`);
        }

        const prodData = prodSnap.data() as any;
        const currentStock = parseInt(prodData.stock_quantity ?? 0);
        
        // Check stock availability
        if (currentStock < reqQty) {
          throw new Error(`OutOfStock:${matchedProduct.title_ar}:${currentStock}`);
        }

        const pricing = getProductPricing({
          original_price: Number(prodData.original_price || 0),
          discount_price: prodData.discount_price !== undefined && prodData.discount_price !== null ? Number(prodData.discount_price) : null,
        });
        const price = pricing.finalPrice;

        const itemSubtotal = price * reqQty;
        subtotal += itemSubtotal;

        resolvedItems.push({
          productId: matchedProduct.id,
          productTitleAr: prodData.title_ar,
          originalPrice: pricing.originalPrice,
          discountPrice: pricing.discountPrice,
          quantity: reqQty,
          price,
          subtotal: itemSubtotal,
          outOfStock: false,
        } as any);

        // Decrement stock in transaction
        transaction.update(prodRef, {
          stock_quantity: currentStock - reqQty,
          updatedAt: new Date().toISOString(),
        });
      }

      // Calculate delivery fee dynamically based on city
      let delivery_fee = 20; // Default shipping fee
      const normCity = normalizeArabic(city);
      if (normCity.includes('صنعاء')) {
        delivery_fee = 10;
      } else if (normCity.includes('عدن') || normCity.includes('تعز')) {
        delivery_fee = 25;
      }

      const total_amount = subtotal + delivery_fee;
      const orderNumber = `VID-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

      // 2. Prepare Order Document with frozen pricing snapshot
      const newOrder: any = {
        id: idempotencyKey,
        order_number: orderNumber,
        userId: userId,
        customer_name,
        customer_phone,
        customer_city: city,
        customer_address: address,
        items: resolvedItems.map((ri: any) => ({
          productId: ri.productId,
          product_id: ri.productId,
          title_ar: ri.productTitleAr,
          original_price: ri.originalPrice,
          discount_price: ri.discountPrice,
          quantity: ri.quantity,
          price: ri.price,
          total_price: ri.subtotal,
        })),
        subtotal,
        delivery_fee,
        total_amount,
        currency: 'ريال',
        status: 'pending' as OrderStatus,
        payment_method: 'cod',
        notes: notes || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Write Order Document atomically
      transaction.set(orderDocRef, newOrder);

      return {
        order: {
          id: idempotencyKey,
          order_number: orderNumber,
          total_amount,
          status: 'pending' as OrderStatus,
        },
        delivery_fee,
        subtotal,
      };
    });

    // --- CART CLEANUP (POST-TRANSACTION) ---
    // If order creation succeeded, clear user's cart in Firestore
    try {
      const cartCol = collection(db, 'users', userId, 'cart');
      const cartSnap = await getDocs(cartCol);
      for (const d of cartSnap.docs) {
        await deleteDoc(d.ref);
      }
      console.info(`[Video Confirm] Cart cleared for user ${userId}`);
    } catch (cartErr: any) {
      console.warn('[Video Confirm] Failed to clear user cart, but order was preserved:', cartErr.message);
    }

    // --- TRIGGER AUTOMATED NOTIFICATION ---
    // This runs in the background to log and prepare the confirmation
    const settings = {
      storeName: 'أمازون دعاء',
      tagline: 'جمالكِ باهتمامنا',
      whatsappNumber: '967777627595',
      currency: 'ريال',
      deliveryFee: 20,
      freeDeliveryThreshold: 500,
      welcomeMessage: 'أهلاً بكِ في متجرنا',
    };

    triggerOrderConfirmation(transactionResult.order as any, settings as any).catch(err => {
      console.warn('[Notification Trigger] Failed to execute background trigger:', err.message);
    });

    // --- GENERATE WHATSAPP URL ---
    const waNumber = '967777627595';
    const waMessage = `السلام عليكم، تم تسجيل وتأكيد طلبي (رقم المرجع: ${transactionResult.order.order_number}) من خلال استوديو الفيديو الذكي بنجاح!\n\n` +
      `اسم العميل: ${customer_name}\n` +
      `الهاتف: ${customer_phone}\n` +
      `العنوان: ${city} - ${address}\n` +
      (notes ? `الملاحظات: ${notes}\n` : '') +
      `المجموع النهائي المعتمد: ${transactionResult.order.total_amount} ريال\n\n` +
      `⚠️ ملاحظة: هذه الرسالة هي لتأكيد وتنسيق تفاصيل الطلب وليست إيصال دفع رسمي.\n` +
      `شكراً لكم!`;
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${waNumber}&text=${encodeURIComponent(waMessage)}`;

    return res.json({
      success: true,
      orderId: idempotencyKey,
      order: transactionResult.order,
      whatsappUrl,
    });

  } catch (error: any) {
    const message = error.message || '';
    console.error('[Video Confirm] Error during confirmation:', message);

    if (message.startsWith('ProductNotFound:')) {
      const rawName = message.split('ProductNotFound:')[1];
      return res.status(404).json({
        code: 'ProductNotFound',
        message: `تعذر مطابقة المنتج: "${rawName}" مع السجلات الرسمية. يرجى مراجعته وتعديله يدوياً.`,
        productNameRaw: rawName
      });
    }

    if (message.startsWith('ProductAmbiguous:')) {
      const parts = message.split('ProductAmbiguous:')[1].split(':');
      const rawName = parts[0];
      const candidates = parts[1];
      return res.status(409).json({
        code: 'ProductAmbiguous',
        message: `تم العثور على أكثر من مطابقة للمنتج: "${rawName}". يرجى اختيار المنتج الصحيح.`,
        productNameRaw: rawName,
        candidates: candidates.split(' | ')
      });
    }

    if (message.startsWith('OutOfStock:')) {
      const parts = message.split('OutOfStock:')[1].split(':');
      const title = parts[0];
      const stock = parts[1];
      return res.status(400).json({
        code: 'OutOfStock',
        message: `المنتج "${title}" غير متوفر بالكمية المطلوبة (الكمية المتاحة حالياً: ${stock} قطع).`
      });
    }

    return res.status(500).json({ error: error.message || 'فشل تأكيد الطلب.' });
  }
});

export default router;
