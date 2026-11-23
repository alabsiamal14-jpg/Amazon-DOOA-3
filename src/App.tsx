import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import {
  Sparkles,
  Layers,
  Bot,
  Percent,
  ShieldCheck,
  Code,
  Code2,
  Package,
  Settings,
  LogOut,
  Store,
  BarChart3,
  Upload,
  Video,
  UserCheck,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  DollarSign,
  Plus,
  ArrowRight,
  Loader2,
  Clock,
  ChevronLeft,
  Landmark,
} from 'lucide-react';

import {
  Product,
  Category,
  StoreSettings,
  CartItem,
  Order,
  OrderStatus,
  AdminUser,
  UserProfile,
} from './types';
import { INITIAL_CATEGORIES, INITIAL_PRODUCTS, INITIAL_SETTINGS } from './data/initialData';
import {
  getStoredProducts,
  saveStoredProducts,
  upsertStoredProduct,
  upsertStoredProducts,
  removeStoredProduct,
  getStoredOrders,
  saveStoredOrders,
  getStoredSettings,
  saveStoredSettings,
  saveStoredActiveCurrency,
  getStoredCart,
  saveStoredCart,
  getStoredWishlist,
  saveStoredWishlist,
  getAdminSession,
  setAdminSession,
  clearAdminSession,
  getAuthHeadersAsync,
  resetToDefaults,
} from './lib/storage';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import {
  auth,
  db,
  fetchProductsFirestore,
  saveProductFirestore,
  deleteProductFirestore,
  createOrderFirestore,
  fetchOrdersFirestore,
  updateOrderStatusFirestore,
  updateOrderDriverFirestore,
  syncEmployeeDraftFirestore,
  fetchEmployeeDraftsFirestore,
} from './lib/firebase';

// Standard Components
import { Navbar } from './components/Navbar';
import { StoreFront } from './components/StoreFront';
import { CartDrawer } from './components/CartDrawer';
import { AuthModal } from './components/AuthModal';
import { PublicAddProductModal } from './components/PublicAddProductModal';
import { DriverPortal } from './components/DriverPortal';
import { AdminSalesChart } from './components/AdminSalesChart';
import { OfflineStatusIndicator } from './components/OfflineStatusIndicator';
import { UpdateNotificationBanner } from './components/UpdateNotificationBanner';

// Resilient Lazy Loaded Components
import {
  ProductDetailsPage,
  CheckoutPage,
  CustomerOrderTrackingPage,
  QuickViewModal,
  WishlistDrawer,
  AdminDeveloperAdvisor,
  AdminOrders,
  AdminProductForm,
  AdminProductList,
  AdminSettings,
  AdminLogin,
  SupabaseCodeModal,
  AdminCopilotModal,
  WhatsAppSupplierDashboard,
  PricingAIDashboard,
  AISupplierIntelligenceCenter,
  BranchStoreLocator,
  SmartEmployeeAssistantPage,
  EmployeeDraftsReviewPanel,
  AdminBulkImportPanel,
  AdminSmartAssistantPage,
  AdminEngineeringArchitectPage,
  AdminAccountingSystem,
  StaffDashboard,
} from './lib/lazyImports';

export type MainTab =
  | 'store'
  | 'admin'
  | 'orders'
  | 'checkout'
  | 'product-detail'
  | 'dev-advisor'
  | 'track-order'
  | 'branches'
  | 'driver'
  | 'employee-assistant';

export type AdminSubTab =
  | 'products'
  | 'analytics'
  | 'accounting'
  | 'center'
  | 'bulk-import'
  | 'smart-assistant'
  | 'employee-drafts'
  | 'pricing-ai'
  | 'whatsapp-supplier'
  | 'settings'
  | 'engineering-architect';

export type AdminTabGroup = 'operations' | 'ai' | 'pricing' | 'config';

function mapApiProductToProduct(raw: any): Product {
  return {
    id: String(raw.productId || raw.id || ''),
    title_ar: String(raw.title_ar ?? raw.titleAr ?? ''),
    description_ar: String(raw.description_ar ?? raw.descriptionAr ?? ''),
    original_price: Number(raw.original_price ?? raw.originalPrice ?? 0),
    discount_price:
      raw.discount_price !== undefined
        ? raw.discount_price
        : raw.discountPrice !== undefined
          ? raw.discountPrice
          : null,
    stock_quantity: Number(raw.stock_quantity ?? raw.stockQuantity ?? 0),
    category_id: String(raw.category_id ?? raw.categoryId ?? 'skincare'),
    category_name: String(raw.category_name ?? raw.categoryName ?? 'عناية بالبشرة'),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    image_url: String(raw.image_url ?? raw.imageUrl ?? ''),
    gallery_images: Array.isArray(raw.gallery_images ?? raw.galleryImages)
      ? (raw.gallery_images ?? raw.galleryImages)
      : undefined,
    video_url: raw.video_url ?? raw.videoUrl ?? undefined,
    video_duration: raw.video_duration ?? raw.videoDuration ?? undefined,
    size_or_volume: raw.size_or_volume ?? raw.sizeOrVolume ?? undefined,
    skin_type: raw.skin_type ?? raw.skinType ?? undefined,
    key_benefits: Array.isArray(raw.key_benefits ?? raw.keyBenefits)
      ? (raw.key_benefits ?? raw.keyBenefits)
      : undefined,
    how_to_use: raw.how_to_use ?? raw.howToUse ?? undefined,
    ingredients: raw.ingredients ?? undefined,
    badge: raw.badge ?? undefined,
    ai_generated: Boolean(raw.ai_generated ?? raw.aiGenerated),
    rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : 5.0,
    reviews_count: Number.isFinite(Number(raw.reviews_count ?? raw.reviewsCount))
      ? Number(raw.reviews_count ?? raw.reviewsCount)
      : 0,
    featured: Boolean(raw.featured),
    status: raw.status === 'draft' ? 'draft' : 'published',
    creator_id: raw.creator_id ?? raw.creatorId ?? undefined,
    created_at:
      typeof raw.created_at === 'string'
        ? raw.created_at
        : raw.createdAt
          ? new Date(raw.createdAt).toISOString()
          : new Date().toISOString(),
  };
}

function mapApiOrderToOrder(raw: any): Order {
  return {
    id: String(raw.id ?? raw.orderNumber ?? raw.order_number ?? ''),
    order_number: String(raw.order_number ?? raw.orderNumber ?? ''),
    userId: raw.userId ?? raw.user_id ?? undefined,
    customer_name: String(raw.customer_name ?? raw.customerName ?? ''),
    customer_phone: String(raw.customer_phone ?? raw.customerPhone ?? ''),
    customer_email: raw.customer_email ?? raw.customerEmail ?? undefined,
    city: String(raw.city ?? ''),
    address: String(raw.address ?? ''),
    notes: raw.notes ?? undefined,
    items: Array.isArray(raw.items) ? raw.items : [],
    subtotal: Number(raw.subtotal ?? 0),
    discount_amount: Number(raw.discount_amount ?? raw.discountAmount ?? 0),
    coupon_code: raw.coupon_code ?? raw.couponCode ?? undefined,
    delivery_fee: Number(raw.delivery_fee ?? raw.deliveryFee ?? 0),
    total_amount: Number(raw.total_amount ?? raw.totalAmount ?? 0),
    status: (raw.status as OrderStatus) || 'pending',
    whatsapp_sent: Boolean(raw.whatsapp_sent ?? raw.whatsappSent),
    payment_method: raw.payment_method ?? raw.paymentMethod ?? undefined,
    delivery_speed: raw.delivery_speed ?? raw.deliverySpeed ?? undefined,
    driver_name: raw.driver_name ?? raw.driverName ?? undefined,
    driver_phone: raw.driver_phone ?? raw.driverPhone ?? undefined,
    driver_id: raw.driver_id ?? raw.driverId ?? undefined,
    cod_collected: raw.cod_collected ?? raw.codCollected ?? undefined,
    cod_collected_amount: raw.cod_collected_amount ?? raw.codCollectedAmount ?? undefined,
    driver_notes: raw.driver_notes ?? raw.driverNotes ?? undefined,
    delivered_at:
      typeof raw.delivered_at === 'string'
        ? raw.delivered_at
        : raw.deliveredAt
          ? new Date(raw.deliveredAt).toISOString()
          : undefined,
    created_at:
      typeof raw.created_at === 'string'
        ? raw.created_at
        : raw.createdAt
          ? new Date(raw.createdAt).toISOString()
          : new Date().toISOString(),
    updated_at:
      typeof raw.updated_at === 'string'
        ? raw.updated_at
        : raw.updatedAt
          ? new Date(raw.updatedAt).toISOString()
          : undefined,
  };
}

function getInitialMainTab(): MainTab {
  if (typeof window === 'undefined') return 'store';
  const path = window.location.pathname.replace(/\/+$/, '').toLowerCase();
  if (path === '/admin') return 'admin';
  if (path === '/orders') return 'orders';
  if (path === '/driver') return 'driver';
  if (path === '/employee-assistant') return 'employee-assistant';
  if (path === '/dev-advisor') return 'dev-advisor';
  if (path === '/track-order') return 'track-order';
  if (path === '/branches') return 'branches';
  if (path === '/checkout') return 'checkout';
  return 'store';
}

export const App: React.FC = () => {
  // Core Store State
  const [categories] = useState<Category[]>(INITIAL_CATEGORIES);
  const [products, setProducts] = useState<Product[]>(() => getStoredProducts());
  const [orders, setOrders] = useState<Order[]>(() => getStoredOrders());
  const [settings, setSettings] = useState<StoreSettings>(() => getStoredSettings());
  const [cart, setCart] = useState<CartItem[]>(() => getStoredCart());
  const [wishlist, setWishlist] = useState<string[]>(() => getStoredWishlist());

  // Navigation State
  const [activeTab, setActiveTab] = useState<MainTab>(getInitialMainTab);
  const [adminSubTab, setAdminSubTab] = useState<AdminSubTab>('products');
  const [adminTabGroup, setAdminTabGroup] = useState<AdminTabGroup>('operations');
  const [adminProductViewMode, setAdminProductViewMode] = useState<'list' | 'add'>('list');

  // Authentication State
  const [adminUser, setAdminUser] = useState<AdminUser | null>(() => getAdminSession());
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Selected Entities & Modals
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [quickViewProduct, setQuickViewProduct] = useState<Product | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isWishlistOpen, setIsWishlistOpen] = useState(false);
  const [isDocsOpen, setIsDocsOpen] = useState(false);
  const [isCopilotOpen, setIsCopilotOpen] = useState(false);
  const [isPublicAddProductOpen, setIsPublicAddProductOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Pending Drafts Counters for Admin Badges
  const [pendingBulkImportCount, setPendingBulkImportCount] = useState(0);
  const [pendingSmartAssistantCount, setPendingSmartAssistantCount] = useState(0);
  const [pendingEmployeeDraftsCount, setPendingEmployeeDraftsCount] = useState(0);
  const [employeeDraftsRefreshTrigger, setEmployeeDraftsRefreshTrigger] = useState(0);

  // Synchronize admin tab group automatically when sub-tab changes
  useEffect(() => {
    if (adminSubTab === 'products' || adminSubTab === 'analytics' || adminSubTab === 'accounting') {
      setAdminTabGroup('operations');
    } else if (
      adminSubTab === 'center' ||
      adminSubTab === 'smart-assistant' ||
      adminSubTab === 'bulk-import' ||
      adminSubTab === 'employee-drafts'
    ) {
      setAdminTabGroup('ai');
    } else if (adminSubTab === 'pricing-ai' || adminSubTab === 'whatsapp-supplier') {
      setAdminTabGroup('pricing');
    } else if (adminSubTab === 'settings' || adminSubTab === 'engineering-architect') {
      setAdminTabGroup('config');
    }
  }, [adminSubTab]);

  // Firebase Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (fbUser) {
        const isSovereign = fbUser.email === 'omralabis@gmail.com';
        let userRole: 'customer' | 'user' | 'admin' | 'staff' | 'driver' = isSovereign ? 'admin' : 'customer';

        try {
          const userDocRef = doc(db, 'users', fbUser.uid);
          const docSnap = await getDoc(userDocRef);
          if (docSnap.exists()) {
            const data = docSnap.data();
            if (data?.role) {
              userRole = isSovereign ? 'admin' : data.role;
            }
          } else {
            await setDoc(
              userDocRef,
              {
                uid: fbUser.uid,
                name: fbUser.displayName || fbUser.email?.split('@')[0] || 'مستخدم',
                email: fbUser.email || '',
                role: userRole,
                createdAt: new Date().toISOString(),
              },
              { merge: true }
            );
          }
        } catch (err) {
          console.warn('[Auth] User profile read fallback:', err);
        }

        const profile: UserProfile = {
          uid: fbUser.uid,
          name: fbUser.displayName || fbUser.email?.split('@')[0] || 'مستخدم',
          email: fbUser.email || '',
          photoURL: fbUser.photoURL || undefined,
          role: userRole,
        };
        setCurrentUser(profile);

        if (isSovereign || userRole === 'admin') {
          const adminObj: AdminUser = {
            id: fbUser.uid,
            username: fbUser.email || 'omralabis@gmail.com',
            displayName: fbUser.displayName || 'المدير العام',
            role: 'superadmin',
          };
          setAdminUser(adminObj);
          setAdminSession(adminObj);
        }
      } else {
        setCurrentUser(null);
      }
    });

    return () => unsubscribe();
  }, []);

  // Fetch remote catalog and orders on initial load
  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      const authHeaders = adminUser || currentUser ? await getAuthHeadersAsync() : {};

      // 1. Fetch remote catalog from server or Firestore
      try {
        const res = await fetch('/api/db/products', {
          credentials: 'include',
          headers: authHeaders,
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0 && isMounted) {
            const mapped = data.map(mapApiProductToProduct).filter((p) => p.id && p.title_ar);
            if (mapped.length > 0) {
              setProducts(mapped);
              saveStoredProducts(mapped);
            }
          }
        } else {
          const fsRes = await fetchProductsFirestore();
          if (fsRes.products && fsRes.products.length > 0 && isMounted) {
            setProducts(fsRes.products);
            saveStoredProducts(fsRes.products);
          }
        }
      } catch (e) {
        console.warn('[Catalog] Using cached products:', e);
      }

      // 2. Fetch orders only for authenticated users (prevents unauthenticated 401 noise on public visits)
      if (!adminUser && !currentUser) {
        return;
      }
      try {
        const res = await fetch('/api/db/orders', { credentials: 'include', headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && isMounted) {
            const mappedOrders = data.map(mapApiOrderToOrder);
            setOrders(mappedOrders);
            saveStoredOrders(mappedOrders);
          }
        } else {
          const fsOrdersRes = await fetchOrdersFirestore(currentUser?.uid, Boolean(adminUser));
          if (fsOrdersRes.orders && fsOrdersRes.orders.length > 0 && isMounted) {
            setOrders(fsOrdersRes.orders);
            saveStoredOrders(fsOrdersRes.orders);
          }
        }
      } catch (e) {
        console.warn('[Orders] Using cached orders:', e);
      }
    }

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [adminUser, currentUser?.uid]);

  // Refresh pending counts for drafts
  const refreshPendingCounts = useCallback(async () => {
    try {
      const authHeaders = await getAuthHeadersAsync();

      // Bulk import drafts
      try {
        const res = await fetch('/api/admin/bulk-import/drafts', {
          credentials: 'include',
          headers: authHeaders,
        });
        if (res.ok) {
          const data = await res.json();
          const drafts = Array.isArray(data) ? data : Array.isArray(data?.drafts) ? data.drafts : [];
          setPendingBulkImportCount(drafts.filter((d: any) => d.status === 'pending_review').length);
        }
      } catch {
        // Fallback
      }

      // Smart assistant drafts
      try {
        const res = await fetch('/api/admin/smart-assistant/drafts', {
          credentials: 'include',
          headers: authHeaders,
        });
        if (res.ok) {
          const data = await res.json();
          const drafts = Array.isArray(data) ? data : Array.isArray(data?.drafts) ? data.drafts : [];
          setPendingSmartAssistantCount(drafts.filter((d: any) => d.status === 'pending_review').length);
        }
      } catch {
        // Fallback
      }

      // Employee drafts
      try {
        const res = await fetch('/api/employee-assistant/drafts', {
          credentials: 'include',
          headers: authHeaders,
        });
        if (res.ok) {
          const data = await res.json();
          const drafts = Array.isArray(data) ? data : Array.isArray(data?.drafts) ? data.drafts : [];
          setPendingEmployeeDraftsCount(drafts.filter((d: any) => d.status === 'pending_pricing').length);
        } else {
          const fsDrafts = await fetchEmployeeDraftsFirestore();
          setPendingEmployeeDraftsCount(fsDrafts.filter((d) => d.status === 'pending_pricing').length);
        }
      } catch {
        try {
          const fsDrafts = await fetchEmployeeDraftsFirestore();
          setPendingEmployeeDraftsCount(fsDrafts.filter((d) => d.status === 'pending_pricing').length);
        } catch {
          // Fallback
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    if (adminUser) {
      refreshPendingCounts();
      const interval = setInterval(refreshPendingCounts, 30000);
      return () => clearInterval(interval);
    }
  }, [adminUser, refreshPendingCounts]);

  // Cart Operations
  const handleAddToCart = useCallback((product: Product, quantity = 1) => {
    setCart((prevCart) => {
      const existing = prevCart.find((item) => item.product.id === product.id);
      let updated: CartItem[];
      if (existing) {
        updated = prevCart.map((item) =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + quantity } : item
        );
      } else {
        updated = [...prevCart, { product, quantity }];
      }
      saveStoredCart(updated);
      return updated;
    });
    setIsCartOpen(true);
  }, []);

  const handleUpdateQuantity = useCallback((productId: string, delta: number) => {
    setCart((prevCart) => {
      const updated = prevCart
        .map((item) => {
          if (item.product.id === productId) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[];
      saveStoredCart(updated);
      return updated;
    });
  }, []);

  const handleRemoveCartItem = useCallback((productId: string) => {
    setCart((prevCart) => {
      const updated = prevCart.filter((item) => item.product.id !== productId);
      saveStoredCart(updated);
      return updated;
    });
  }, []);

  const handleClearCart = useCallback(() => {
    setCart([]);
    saveStoredCart([]);
  }, []);

  // Wishlist Operations
  const handleToggleWishlist = useCallback((product: Product) => {
    setWishlist((prevWishlist) => {
      const exists = prevWishlist.includes(product.id);
      const updated = exists ? prevWishlist.filter((id) => id !== product.id) : [...prevWishlist, product.id];
      saveStoredWishlist(updated);
      return updated;
    });
  }, []);

  const wishlistProducts = useMemo(() => {
    const ids = new Set(wishlist);
    return products.filter((p) => ids.has(p.id));
  }, [products, wishlist]);

  const cartProductIds = useMemo(() => new Set(cart.map((item) => item.product.id)), [cart]);
  const wishlistIdsSet = useMemo(() => new Set(wishlist), [wishlist]);

  // Product Selection Handlers
  const handleSelectProduct = useCallback((product: Product) => {
    setSelectedProduct(product);
    setActiveTab('product-detail');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleQuickView = useCallback((product: Product) => {
    setQuickViewProduct(product);
  }, []);

  const handleSearchSubmit = useCallback((q: string) => {
    setSearchQuery(q);
    setActiveTab('store');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Admin & Product Mutating Handlers
  const handleProductCreated = useCallback(async (newProduct: Product) => {
    setProducts((prev) => {
      const filtered = prev.filter((p) => p.id !== newProduct.id);
      const next = [newProduct, ...filtered];
      saveStoredProducts(next);
      return next;
    });

    try {
      const authHeaders = await getAuthHeadersAsync();
      await fetch('/api/db/products', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(newProduct),
      });
    } catch (err) {
      console.warn('[Product Create API] fallback:', err);
    }

    try {
      await saveProductFirestore(newProduct);
    } catch (err) {
      console.warn('[Firestore Sync Product] fallback:', err);
    }
  }, []);

  const handleProductsCreated = useCallback(async (newProducts: Product[]) => {
    if (!newProducts || newProducts.length === 0) return;
    setProducts((prev) => {
      const newIds = new Set(newProducts.map((p) => p.id));
      const filtered = prev.filter((p) => !newIds.has(p.id));
      const next = [...newProducts, ...filtered];
      saveStoredProducts(next);
      return next;
    });

    for (const p of newProducts) {
      try {
        await saveProductFirestore(p);
      } catch {
        // Continue
      }
    }
  }, []);

  const handleDeleteProduct = useCallback(async (productId: string) => {
    setProducts((prev) => {
      const next = prev.filter((p) => p.id !== productId);
      saveStoredProducts(next);
      return next;
    });
    removeStoredProduct(productId);

    try {
      const authHeaders = await getAuthHeadersAsync();
      await fetch(`/api/db/products/${encodeURIComponent(productId)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: authHeaders,
      });
    } catch (err) {
      console.warn('[Product Delete API] fallback:', err);
    }

    try {
      await deleteProductFirestore(productId);
    } catch (err) {
      console.warn('[Firestore Delete Product] fallback:', err);
    }
  }, []);

  const handleUpdateStock = useCallback(async (productId: string, newStock: number) => {
    const safeStock = Math.max(0, Math.floor(newStock));
    let targetProduct: Product | null = null;
    setProducts((prev) => {
      const next = prev.map((p) => {
        if (p.id === productId) {
          targetProduct = { ...p, stock_quantity: safeStock };
          return targetProduct;
        }
        return p;
      });
      saveStoredProducts(next);
      return next;
    });

    try {
      const authHeaders = await getAuthHeadersAsync();
      await fetch(`/api/db/products/${encodeURIComponent(productId)}/stock`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ stock_quantity: safeStock }),
      });
    } catch (err) {
      console.warn('[Product Stock API] fallback:', err);
    }

    if (targetProduct) {
      try {
        await saveProductFirestore(targetProduct);
      } catch (err) {
        console.warn('[Firestore Stock Update] fallback:', err);
      }
    }
  }, []);

  const handleToggleFeatured = useCallback(async (productId: string) => {
    let updatedProduct: Product | null = null;
    setProducts((prev) => {
      const next = prev.map((p) => {
        if (p.id === productId) {
          const featured = !p.featured;
          updatedProduct = { ...p, featured };
          return updatedProduct;
        }
        return p;
      });
      saveStoredProducts(next);
      return next;
    });

    if (updatedProduct) {
      try {
        await saveProductFirestore(updatedProduct);
      } catch (err) {
        console.warn('[Firestore Featured Toggle] fallback:', err);
      }
    }
  }, []);

  const handleUpdateProductPrice = useCallback(
    async (productId: string, originalPrice: number, discountPrice: number | null) => {
      let updatedProduct: Product | null = null;
      setProducts((prev) => {
        const next = prev.map((p) => {
          if (p.id === productId) {
            updatedProduct = { ...p, original_price: originalPrice, discount_price: discountPrice };
            return updatedProduct;
          }
          return p;
        });
        saveStoredProducts(next);
        return next;
      });

      try {
        const authHeaders = await getAuthHeadersAsync();
        await fetch(`/api/db/products/${encodeURIComponent(productId)}/price`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ original_price: originalPrice, discount_price: discountPrice }),
        });
      } catch (err) {
        console.warn('[Product Price API] fallback:', err);
      }

      if (updatedProduct) {
        try {
          await saveProductFirestore(updatedProduct);
        } catch (err) {
          console.warn('[Firestore Price Update] fallback:', err);
        }
      }
    },
    []
  );

  const handleBulkUpdateDiscount = useCallback(
    async (productIds: string[], discountPercent: number | null) => {
      const idsSet = new Set(productIds);
      const affectedProducts: Product[] = [];
      setProducts((prev) => {
        const next = prev.map((p) => {
          if (idsSet.has(p.id)) {
            const discountPrice =
              discountPercent !== null && discountPercent > 0
                ? Math.round(p.original_price * (1 - discountPercent / 100))
                : null;
            const updated = { ...p, discount_price: discountPrice };
            affectedProducts.push(updated);
            return updated;
          }
          return p;
        });
        saveStoredProducts(next);
        return next;
      });

      for (const p of affectedProducts) {
        try {
          await saveProductFirestore(p);
        } catch {
          // Continue
        }
      }
    },
    []
  );

  const handleBulkDeduplicate = useCallback(
    async (groups: { masterId: string; newStock: number; deleteIds: string[] }[]) => {
      const allDeleteIds = new Set<string>();
      const stockUpdates = new Map<string, number>();

      groups.forEach((g) => {
        stockUpdates.set(g.masterId, g.newStock);
        g.deleteIds.forEach((id) => allDeleteIds.add(id));
      });

      const updatedMasters: Product[] = [];
      setProducts((prev) => {
        const next = prev
          .filter((p) => !allDeleteIds.has(p.id))
          .map((p) => {
            if (stockUpdates.has(p.id)) {
              const updated = { ...p, stock_quantity: stockUpdates.get(p.id)! };
              updatedMasters.push(updated);
              return updated;
            }
            return p;
          });
        saveStoredProducts(next);
        return next;
      });

      for (const delId of allDeleteIds) {
        try {
          await deleteProductFirestore(delId);
        } catch {
          // Continue
        }
      }

      for (const master of updatedMasters) {
        try {
          await saveProductFirestore(master);
        } catch {
          // Continue
        }
      }
    },
    []
  );

  const handlePublishProduct = useCallback(async (productId: string) => {
    let publishedProduct: Product | null = null;
    setProducts((prev) => {
      const next = prev.map((p) => {
        if (p.id === productId) {
          publishedProduct = { ...p, status: 'published' as const };
          return publishedProduct;
        }
        return p;
      });
      saveStoredProducts(next);
      return next;
    });

    if (publishedProduct) {
      try {
        await saveProductFirestore(publishedProduct);
      } catch {
        // Continue
      }
    }
  }, []);

  // Order Handlers
  const handleOrderPlaced = useCallback(
    async (newOrder: Order): Promise<Order> => {
      let resolvedOrder = newOrder;
      setOrders((prev) => {
        const next = [newOrder, ...prev.filter((o) => o.id !== newOrder.id)];
        saveStoredOrders(next);
        return next;
      });
      setCart([]);
      saveStoredCart([]);

      try {
        const authHeaders = await getAuthHeadersAsync();
        const res = await fetch('/api/orders/checkout', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            idempotencyKey: newOrder.id,
            orderNumber: newOrder.order_number,
            userId: currentUser?.uid || newOrder.userId || 'guest',
            customerName: newOrder.customer_name,
            customerPhone: newOrder.customer_phone,
            customerEmail: newOrder.customer_email || '',
            city: newOrder.city,
            address: newOrder.address,
            notes: newOrder.notes || '',
            paymentMethod: newOrder.payment_method,
            deliverySpeed: newOrder.delivery_speed,
            couponCode: newOrder.coupon_code,
            items: (newOrder.items || []).map((i) => ({
              product_id: i.product_id,
              quantity: i.quantity,
            })),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.order && data.order.order_number) {
            resolvedOrder = data.order;
            setOrders((prev) => {
              const next = [resolvedOrder, ...prev.filter((o) => o.order_number !== resolvedOrder.order_number)];
              saveStoredOrders(next);
              return next;
            });
          }
        }
      } catch (err) {
        console.warn('[Order API Create] fallback:', err);
      }

      try {
        await createOrderFirestore(resolvedOrder, currentUser?.uid);
      } catch (err) {
        console.warn('[Firestore Order Create] fallback:', err);
      }

      return resolvedOrder;
    },
    [currentUser?.uid]
  );

  const handleUpdateOrderStatus = useCallback(async (orderId: string, status: OrderStatus) => {
    let targetOrderNumber = orderId;
    setOrders((prev) => {
      const next = prev.map((o) => {
        if (o.id === orderId || o.order_number === orderId) {
          targetOrderNumber = o.order_number || orderId;
          return { ...o, status, updated_at: new Date().toISOString() };
        }
        return o;
      });
      saveStoredOrders(next);
      return next;
    });

    try {
      await updateOrderStatusFirestore(orderId, status);
    } catch (err) {
      console.warn('[Firestore Order Status] fallback:', err);
    }

    try {
      const authHeaders = await getAuthHeadersAsync();
      await fetch(`/api/db/orders/${encodeURIComponent(targetOrderNumber)}/status`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      console.warn('[Order Status API] fallback:', err);
    }
  }, []);

  const handleAssignDriver = useCallback(
    async (
      orderId: string,
      orderNumber: string,
      driver: { driverName: string; driverPhone: string }
    ) => {
      setOrders((prev) => {
        const next = prev.map((o) =>
          o.id === orderId
            ? {
                ...o,
                driver_name: driver.driverName,
                driver_phone: driver.driverPhone,
                status: 'shipped' as const,
                updated_at: new Date().toISOString(),
              }
            : o
        );
        saveStoredOrders(next);
        return next;
      });

      try {
        await updateOrderDriverFirestore(orderId, {
          driver_name: driver.driverName,
          driver_phone: driver.driverPhone,
        });
      } catch (err) {
        console.warn('[Firestore Driver Assign] fallback:', err);
      }

      try {
        const authHeaders = await getAuthHeadersAsync();
        await fetch(`/api/db/orders/${encodeURIComponent(orderNumber || orderId)}/driver`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            driver_name: driver.driverName,
            driver_phone: driver.driverPhone,
            order_number: orderNumber,
          }),
        });
      } catch (err) {
        console.warn('[Driver Assign API] fallback:', err);
      }
    },
    []
  );

  const handleUpdateDeliveryStatus = useCallback(
    async (
      orderId: string,
      orderNumber: string,
      status: OrderStatus,
      extraData?: {
        cod_collected?: boolean;
        cod_collected_amount?: number;
        driver_notes?: string;
        driver_name?: string;
        driver_phone?: string;
      }
    ) => {
      setOrders((prev) => {
        const next = prev.map((o) =>
          o.id === orderId
            ? {
                ...o,
                status,
                ...(extraData || {}),
                updated_at: new Date().toISOString(),
              }
            : o
        );
        saveStoredOrders(next);
        return next;
      });

      try {
        await updateOrderStatusFirestore(orderId, status, extraData);
      } catch (err) {
        console.warn('[Firestore Delivery Update] fallback:', err);
      }

      try {
        const authHeaders = await getAuthHeadersAsync();
        await fetch(`/api/db/orders/${encodeURIComponent(orderNumber || orderId)}/delivery`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            status,
            order_number: orderNumber,
            ...(extraData || {}),
          }),
        });
      } catch (err) {
        console.warn('[Delivery Status API] fallback:', err);
      }
    },
    []
  );

  // Settings & Storage Handlers
  const handleSaveSettings = useCallback((newSettings: StoreSettings) => {
    setSettings(newSettings);
    saveStoredSettings(newSettings);
  }, []);

  const handleChangeCurrency = useCallback((currencyCode: string) => {
    setSettings((prev) => {
      const next: StoreSettings = {
        ...prev,
        activeCurrency: currencyCode,
      };
      saveStoredSettings(next);
      return next;
    });
    saveStoredActiveCurrency(currencyCode);
  }, []);

  const handleResetData = useCallback(() => {
    resetToDefaults();
    saveStoredActiveCurrency('SAR');
    setProducts(INITIAL_PRODUCTS);
    setOrders([]);
    setSettings(INITIAL_SETTINGS);
    setCart([]);
    setWishlist([]);
    clearAdminSession();
    setAdminUser(null);
    setActiveTab('store');
  }, []);

  const handleUpdateUserRole = useCallback(async (email: string, role: 'staff' | 'user') => {
    try {
      const authHeaders = await getAuthHeadersAsync();
      const res = await fetch(`/api/db/users/${encodeURIComponent(email)}/role`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'فشل تحديث الصلاحية');
      }
    } catch (err: any) {
      console.warn('[User Role API] fallback:', err?.message || err);
    }
  }, []);

  // Auth Modal & Admin Login Handlers
  const handleLoginSuccess = useCallback((user: AdminUser) => {
    setAdminUser(user);
    setAdminSession(user);
    setActiveTab('admin');
  }, []);

  const handleLogoutAdmin = useCallback(async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Ignore
    }
    clearAdminSession();
    setAdminUser(null);
    setActiveTab('store');
  }, []);

  const handleAuthSuccess = useCallback((profile: UserProfile) => {
    setCurrentUser(profile);
    setIsAuthModalOpen(false);
  }, []);

  const handleLogoutUser = useCallback(async () => {
    try {
      await auth.signOut();
    } catch {
      // Ignore
    }
    setCurrentUser(null);
  }, []);

  // Total cart calculation
  const cartTotal = useMemo(() => {
    return cart.reduce((sum, item) => {
      const price = item.product.discount_price ?? item.product.original_price ?? 0;
      return sum + price * item.quantity;
    }, 0);
  }, [cart]);

  // Loading indicator for Suspense fallback
  const suspenseFallback = (
    <div className="min-h-[50vh] flex flex-col items-center justify-center py-20 px-4 text-center">
      <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600 animate-spin mb-4 shadow-sm">
        <Loader2 className="w-6 h-6" />
      </div>
      <p className="text-sm font-bold text-stone-700">جاري تحميل المحتوى فائق الجودة...</p>
      <span className="text-xs text-stone-400 mt-1">متجر Amazon Duaa الفاخر</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-['Cairo',sans-serif] flex flex-col antialiased selection:bg-rose-100 selection:text-rose-900" dir="rtl">
      {/* Offline Status & App Update Banners */}
      <OfflineStatusIndicator />
      <UpdateNotificationBanner />

      {/* Global Navigation Bar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        cartCount={cart.reduce((sum, i) => sum + i.quantity, 0)}
        cartTotal={cartTotal}
        onOpenCart={() => setIsCartOpen(true)}
        wishlistCount={wishlist.length}
        onOpenWishlist={() => setIsWishlistOpen(true)}
        settings={settings}
        onChangeCurrency={handleChangeCurrency}
        onOpenDocs={() => setIsDocsOpen(true)}
        ordersCount={orders.length}
        adminUser={adminUser}
        onLogoutAdmin={handleLogoutAdmin}
        products={products}
        onSelectProduct={handleSelectProduct}
        onAddToCart={handleAddToCart}
        onSearchSubmit={handleSearchSubmit}
        currentUser={currentUser}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        onLogoutUser={handleLogoutUser}
      />

      {/* Main Page Routing */}
      <main className="flex-1 w-full">
        {activeTab === 'store' && (
          <StoreFront
            products={products}
            categories={categories}
            onAddToCart={handleAddToCart}
            onQuickView={handleQuickView}
            onOpenDetails={handleSelectProduct}
            cartProductIds={cartProductIds}
            wishlistIds={wishlistIdsSet}
            onToggleWishlist={handleToggleWishlist}
            settings={settings}
            onOpenAdmin={() => setActiveTab('admin')}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onOpenPublicAddProduct={() => setIsPublicAddProductOpen(true)}
          />
        )}

        {activeTab === 'product-detail' && selectedProduct && (
          <Suspense fallback={suspenseFallback}>
            <ProductDetailsPage
              product={selectedProduct}
              allProducts={products}
              onBackToStore={() => setActiveTab('store')}
              onAddToCart={handleAddToCart}
              onOpenCheckout={() => {
                setIsCartOpen(false);
                setActiveTab('checkout');
              }}
              onSelectProduct={handleSelectProduct}
              settings={settings}
              isWishlisted={wishlist.includes(selectedProduct.id)}
              onToggleWishlist={handleToggleWishlist}
              onUpdateProduct={handleProductCreated}
            />
          </Suspense>
        )}

        {activeTab === 'checkout' && (
          <Suspense fallback={suspenseFallback}>
            <CheckoutPage
              cartItems={cart}
              products={products}
              settings={settings}
              onChangeCurrency={handleChangeCurrency}
              onUpdateQuantity={handleUpdateQuantity}
              onRemoveItem={handleRemoveCartItem}
              onOrderPlaced={handleOrderPlaced}
              onBackToStore={() => setActiveTab('store')}
            />
          </Suspense>
        )}

        {activeTab === 'orders' && (
          <Suspense fallback={suspenseFallback}>
            <div className="max-w-7xl mx-auto px-4 py-8">
              <AdminOrders
                orders={orders}
                onUpdateStatus={handleUpdateOrderStatus}
                onAssignDriver={handleAssignDriver}
                settings={settings}
                onBackToAdmin={() => setActiveTab('admin')}
                onOpenDriverPortal={() => setActiveTab('driver')}
              />
            </div>
          </Suspense>
        )}

        {activeTab === 'track-order' && (
          <Suspense fallback={suspenseFallback}>
            <CustomerOrderTrackingPage
              orders={orders}
              settings={settings}
              onBackToStore={() => setActiveTab('store')}
              onAddToCart={handleAddToCart}
              allProducts={products}
            />
          </Suspense>
        )}

        {activeTab === 'branches' && (
          <Suspense fallback={suspenseFallback}>
            <BranchStoreLocator
              settings={settings}
              onBackToStore={() => setActiveTab('store')}
            />
          </Suspense>
        )}

        {activeTab === 'driver' && (
          <DriverPortal
            orders={orders}
            onUpdateDeliveryStatus={handleUpdateDeliveryStatus}
            settings={settings}
            currentUser={currentUser}
            onBackToStore={() => setActiveTab('store')}
            onOpenAdmin={() => setActiveTab('admin')}
          />
        )}

        {activeTab === 'employee-assistant' && (
          <Suspense fallback={suspenseFallback}>
            <SmartEmployeeAssistantPage
              settings={settings}
              onBackToStore={() => setActiveTab('store')}
              isAdminLoggedIn={Boolean(adminUser)}
              onDraftSaved={() => {
                setEmployeeDraftsRefreshTrigger((prev) => prev + 1);
                refreshPendingCounts();
              }}
            />
          </Suspense>
        )}

        {activeTab === 'dev-advisor' && (
          <Suspense fallback={suspenseFallback}>
            <AdminDeveloperAdvisor
              settings={settings}
              onBackToAdmin={() => setActiveTab('admin')}
              onOpenStore={() => setActiveTab('store')}
              onOpenOrders={() => setActiveTab('orders')}
            />
          </Suspense>
        )}

        {/* Admin Dashboard Area */}
        {activeTab === 'admin' && (
          <>
            {!adminUser && currentUser?.role !== 'staff' && (
              <Suspense fallback={suspenseFallback}>
                <AdminLogin
                  settings={settings}
                  onLoginSuccess={handleLoginSuccess}
                  onBackToStore={() => setActiveTab('store')}
                />
              </Suspense>
            )}

            {currentUser?.role === 'staff' && !adminUser && (
              <Suspense fallback={suspenseFallback}>
                <StaffDashboard
                  currentUser={currentUser}
                  products={products}
                  settings={settings}
                  onLogout={handleLogoutUser}
                  onProductCreated={handleProductCreated}
                  onProductsCreated={handleProductsCreated}
                />
              </Suspense>
            )}

            {adminUser && (
              <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
                {/* Admin Top Header Banner */}
                <div className="bg-stone-900 text-white rounded-3xl p-6 sm:p-8 shadow-xl border border-stone-800 relative overflow-hidden">
                  <div className="absolute top-0 right-0 -mt-10 -mr-10 w-72 h-72 bg-gradient-to-br from-rose-500/20 to-amber-500/10 rounded-full blur-3xl pointer-events-none" />
                  <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="w-10 h-10 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 font-black shadow-inner">
                          AD
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white">
                              لوحة الإدارة والتحكم الشاملة
                            </h1>
                            <span className="bg-rose-500/20 border border-rose-500/30 text-rose-300 text-[11px] font-extrabold px-2.5 py-0.5 rounded-full">
                              Amazon Duaa
                            </span>
                          </div>
                          <p className="text-xs text-stone-400 mt-1 flex items-center gap-2">
                            <span>المدير العام: {adminUser.username}</span>
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-emerald-400 font-bold">جلسة سيادية نشطة ومحمية</span>
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Quick Top Actions */}
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        onClick={() => setActiveTab('store')}
                        className="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-xl border border-white/10 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <Store className="w-4 h-4 text-rose-300" />
                        <span>معاينة المتجر</span>
                      </button>
                      <button
                        onClick={() => setActiveTab('orders')}
                        className="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-xl border border-white/10 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <Package className="w-4 h-4 text-amber-300" />
                        <span>الطلبات ({orders.length})</span>
                      </button>
                      <button
                        onClick={handleLogoutAdmin}
                        className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 border border-rose-500/30 text-xs font-bold px-4 py-2.5 rounded-xl transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>تسجيل الخروج</span>
                      </button>
                    </div>
                  </div>

                  {/* Categorized Tab System (User Request: Clean tabs to eliminate clutter) */}
                  <div className="mt-8 pt-6 border-t border-stone-800 space-y-4">
                    {/* Primary Categorized Groups */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {/* Sub-Tabs Selector */}
                      <div className="flex flex-wrap items-center gap-1.5 bg-stone-950/80 p-1.5 rounded-2xl border border-stone-800">
                        {/* 1. Operations: Products & Inventory */}
                        <button
                          onClick={() => setAdminSubTab('products')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'products'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Layers className="w-4 h-4 text-rose-300" />
                          <span>المنتجات والمخزون</span>
                        </button>

                        {/* 2. Analytics */}
                        <button
                          onClick={() => setAdminSubTab('analytics')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'analytics'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <BarChart3 className="w-4 h-4 text-emerald-300" />
                          <span>الإحصائيات والأداء</span>
                        </button>

                        {/* 2b. Accounting & Financial Audit System */}
                        <button
                          onClick={() => setAdminSubTab('accounting')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'accounting'
                              ? 'bg-emerald-600 text-white shadow-lg font-black ring-2 ring-emerald-300'
                              : 'text-emerald-300 hover:text-white hover:bg-emerald-500/10'
                          }`}
                        >
                          <Landmark className="w-4 h-4 text-emerald-300" />
                          <span>النظام المحاسبي والتدقيق</span>
                        </button>

                        {/* 3. AI Supplier Center */}
                        <button
                          onClick={() => setAdminSubTab('center')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'center'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Sparkles className="w-4 h-4 text-amber-300 animate-pulse" />
                          <span>مركز الموردين الشامل (AI)</span>
                        </button>

                        {/* 4. Smart Assistant */}
                        <button
                          onClick={() => setAdminSubTab('smart-assistant')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'smart-assistant'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Bot className="w-4 h-4 text-rose-300" />
                          <span>المساعد الذكي</span>
                          {pendingSmartAssistantCount > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-black bg-amber-400 text-stone-950 tabular-nums">
                              {pendingSmartAssistantCount}
                            </span>
                          )}
                        </button>

                        {/* 5. Bulk Import */}
                        <button
                          onClick={() => setAdminSubTab('bulk-import')}
                          className={`text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'bulk-import'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Upload className="w-4 h-4 text-sky-300" />
                          <span>الاستيراد بالجملة</span>
                          {pendingBulkImportCount > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-black bg-amber-400 text-stone-950 tabular-nums">
                              {pendingBulkImportCount}
                            </span>
                          )}
                        </button>

                        {/* 6. Employee Drafts */}
                        <button
                          onClick={() => setAdminSubTab('employee-drafts')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'employee-drafts'
                              ? 'bg-amber-500 text-stone-950 shadow-lg font-black ring-2 ring-amber-300'
                              : 'text-amber-300 hover:bg-amber-500/10'
                          }`}
                        >
                          <Bot className="w-4 h-4 text-amber-400" />
                          <span>منتجات مساعد الموظفين</span>
                          <span
                            className={`px-1.5 py-0.5 rounded-full text-[10px] font-black ${
                              adminSubTab === 'employee-drafts'
                                ? 'bg-stone-950 text-amber-300'
                                : 'bg-amber-400 text-stone-950'
                            }`}
                          >
                            {pendingEmployeeDraftsCount}
                          </span>
                        </button>

                        {/* 7. Pricing AI */}
                        <button
                          onClick={() => setAdminSubTab('pricing-ai')}
                          className={`text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'pricing-ai'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Percent className="w-4 h-4 text-rose-300" />
                          <span>ذاكرة التسعير AI</span>
                        </button>

                        {/* 8. WhatsApp Video AI */}
                        <button
                          onClick={() => setAdminSubTab('whatsapp-supplier')}
                          className={`text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'whatsapp-supplier'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Video className="w-4 h-4 text-purple-300" />
                          <span>فيديوهات الموردين</span>
                        </button>

                        {/* 9. Settings */}
                        <button
                          onClick={() => setAdminSubTab('settings')}
                          className={`text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'settings'
                              ? 'bg-rose-600 text-white shadow-lg font-black ring-2 ring-rose-400'
                              : 'text-stone-300 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          <Settings className="w-4 h-4 text-stone-300" />
                          <span>الإعدادات</span>
                        </button>

                        {/* 10. Engineering Architect */}
                        <button
                          onClick={() => setAdminSubTab('engineering-architect')}
                          className={`text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminSubTab === 'engineering-architect'
                              ? 'bg-emerald-600 text-white shadow-lg font-black ring-2 ring-emerald-300'
                              : 'text-emerald-300 hover:bg-emerald-500/10'
                          }`}
                        >
                          <ShieldCheck className="w-4 h-4 text-emerald-400" />
                          <span>المستشار الهندسي</span>
                        </button>
                      </div>

                      {/* Floating Smart Tools */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setActiveTab('dev-advisor')}
                          className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3.5 py-2 rounded-xl shadow-md transition-all flex items-center gap-1.5 cursor-pointer"
                        >
                          <Code2 className="w-4 h-4 text-indigo-200" />
                          <span>المستشار البرمجي</span>
                        </button>
                        <button
                          onClick={() => setIsDocsOpen(true)}
                          className="bg-white/10 hover:bg-white/20 text-rose-200 border border-white/20 text-xs font-bold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                        >
                          <Code className="w-4 h-4 text-rose-300" />
                          <span>أكواد النشر</span>
                        </button>
                        <button
                          onClick={() => setIsCopilotOpen(true)}
                          className="bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 text-xs font-bold px-3.5 py-2 rounded-xl transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
                        >
                          <Bot className="w-4 h-4 text-rose-400" />
                          <span>المساعد الإداري</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* SubTab 1: Products & Inventory */}
                {adminSubTab === 'products' && (
                  <div className="space-y-6">
                    {/* View Switcher Bar for Products */}
                    <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-stone-200 shadow-xs">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setAdminProductViewMode('list')}
                          className={`text-xs font-bold px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminProductViewMode === 'list'
                              ? 'bg-rose-600 text-white font-extrabold shadow-sm'
                              : 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                          }`}
                        >
                          <Layers className="w-4 h-4" />
                          <span>قائمة المنتجات ({products.length})</span>
                        </button>

                        <button
                          onClick={() => setAdminProductViewMode('add')}
                          className={`text-xs font-bold px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer ${
                            adminProductViewMode === 'add'
                              ? 'bg-rose-600 text-white font-extrabold shadow-sm'
                              : 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                          }`}
                        >
                          <Plus className="w-4 h-4" />
                          <span>إضافة منتج جديد / استيراد سريع</span>
                        </button>
                      </div>

                      <div className="text-xs text-stone-500 font-medium">
                        إجمالي المخزون النشط:{' '}
                        <span className="font-bold text-stone-900">
                          {products.reduce((acc, curr) => acc + (curr.stock_quantity || 0), 0)} قطعة
                        </span>
                      </div>
                    </div>

                    {adminProductViewMode === 'list' && (
                      <Suspense fallback={suspenseFallback}>
                        <AdminProductList
                          products={products}
                          categories={categories}
                          onDeleteProduct={handleDeleteProduct}
                          onUpdateStock={handleUpdateStock}
                          onToggleFeatured={handleToggleFeatured}
                          onUpdatePrice={handleUpdateProductPrice}
                          onBulkUpdateDiscount={handleBulkUpdateDiscount}
                          onBulkDeduplicate={handleBulkDeduplicate}
                          onPublishProduct={handlePublishProduct}
                          settings={settings}
                        />
                      </Suspense>
                    )}

                    {adminProductViewMode === 'add' && (
                      <Suspense fallback={suspenseFallback}>
                        <AdminProductForm
                          categories={categories}
                          onProductCreated={(p) => {
                            handleProductCreated(p);
                            setAdminProductViewMode('list');
                          }}
                          onProductsCreated={(pList) => {
                            handleProductsCreated(pList);
                            setAdminProductViewMode('list');
                          }}
                          settings={settings}
                          currentUser={currentUser}
                        />
                      </Suspense>
                    )}
                  </div>
                )}

                {/* SubTab 2: Analytics & Sales Chart */}
                {adminSubTab === 'analytics' && (
                  <div className="space-y-6">
                    {/* KPI Quick Cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs">
                        <div className="flex items-center justify-between text-stone-500 text-xs font-bold mb-2">
                          <span>إجمالي المبيعات</span>
                          <DollarSign className="w-4 h-4 text-rose-500" />
                        </div>
                        <div className="text-2xl font-black text-stone-900">
                          {orders.reduce((sum, o) => sum + (o.total_amount || 0), 0).toLocaleString()} {settings.currency}
                        </div>
                        <span className="text-[11px] text-emerald-600 font-bold mt-1 inline-block">
                          نشط ومباشر من قواعد البيانات
                        </span>
                      </div>

                      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs">
                        <div className="flex items-center justify-between text-stone-500 text-xs font-bold mb-2">
                          <span>عدد الطلبات</span>
                          <Package className="w-4 h-4 text-amber-500" />
                        </div>
                        <div className="text-2xl font-black text-stone-900">{orders.length}</div>
                        <span className="text-[11px] text-stone-500 mt-1 inline-block">
                          {orders.filter((o) => o.status === 'delivered').length} طلب مكتمل
                        </span>
                      </div>

                      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs">
                        <div className="flex items-center justify-between text-stone-500 text-xs font-bold mb-2">
                          <span>المنتجات المعروضة</span>
                          <Layers className="w-4 h-4 text-sky-500" />
                        </div>
                        <div className="text-2xl font-black text-stone-900">{products.length}</div>
                        <span className="text-[11px] text-stone-500 mt-1 inline-block">
                          {products.filter((p) => (p.stock_quantity || 0) < 5).length} منتجات قاربت على النفاد
                        </span>
                      </div>

                      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs">
                        <div className="flex items-center justify-between text-stone-500 text-xs font-bold mb-2">
                          <span>متوسط قيمة الطلب</span>
                          <TrendingUp className="w-4 h-4 text-emerald-500" />
                        </div>
                        <div className="text-2xl font-black text-stone-900">
                          {orders.length > 0
                            ? Math.round(orders.reduce((sum, o) => sum + (o.total_amount || 0), 0) / orders.length)
                            : 0}{' '}
                          {settings.currency}
                        </div>
                        <span className="text-[11px] text-stone-500 mt-1 inline-block">معدل تحويل العملاء</span>
                      </div>
                    </div>

                    {/* Chart Container */}
                    <div className="bg-white p-6 rounded-3xl border border-stone-200 shadow-xs">
                      <AdminSalesChart orders={orders} settings={settings} />
                    </div>
                  </div>
                )}

                {/* SubTab 2b: Integrated Accounting & Financial Audit System */}
                {adminSubTab === 'accounting' && (
                  <Suspense fallback={suspenseFallback}>
                    <AdminAccountingSystem
                      orders={orders}
                      products={products}
                      settings={settings}
                      adminName={adminUser?.displayName || currentUser?.name || 'admin'}
                    />
                  </Suspense>
                )}

                {/* SubTab 3: AI Supplier Intelligence Center */}
                {adminSubTab === 'center' && (
                  <Suspense fallback={suspenseFallback}>
                    <AISupplierIntelligenceCenter />
                  </Suspense>
                )}

                {/* SubTab 4: Smart Assistant Page */}
                {adminSubTab === 'smart-assistant' && (
                  <Suspense fallback={suspenseFallback}>
                    <AdminSmartAssistantPage
                      categories={categories}
                      settings={settings}
                      onProductsPublished={handleProductsCreated}
                      onPendingCountChange={setPendingSmartAssistantCount}
                    />
                  </Suspense>
                )}

                {/* SubTab 5: Bulk Import Panel */}
                {adminSubTab === 'bulk-import' && (
                  <Suspense fallback={suspenseFallback}>
                    <AdminBulkImportPanel
                      categories={categories}
                      settings={settings}
                      onProductsPublished={handleProductsCreated}
                      onPendingCountChange={setPendingBulkImportCount}
                    />
                  </Suspense>
                )}

                {/* SubTab 6: Employee Drafts Review */}
                {adminSubTab === 'employee-drafts' && (
                  <Suspense fallback={suspenseFallback}>
                    <EmployeeDraftsReviewPanel
                      categories={categories}
                      settings={settings}
                      onDraftPublished={handleProductCreated}
                      onPendingCountChange={setPendingEmployeeDraftsCount}
                      refreshTrigger={employeeDraftsRefreshTrigger}
                    />
                  </Suspense>
                )}

                {/* SubTab 7: Pricing AI Dashboard */}
                {adminSubTab === 'pricing-ai' && (
                  <Suspense fallback={suspenseFallback}>
                    <PricingAIDashboard />
                  </Suspense>
                )}

                {/* SubTab 8: WhatsApp Supplier Videos AI */}
                {adminSubTab === 'whatsapp-supplier' && (
                  <Suspense fallback={suspenseFallback}>
                    <WhatsAppSupplierDashboard />
                  </Suspense>
                )}

                {/* SubTab 9: Admin Settings */}
                {adminSubTab === 'settings' && (
                  <Suspense fallback={suspenseFallback}>
                    <AdminSettings
                      settings={settings}
                      onSaveSettings={handleSaveSettings}
                      onResetData={handleResetData}
                      onUpdateUserRole={handleUpdateUserRole}
                    />
                  </Suspense>
                )}

                {/* SubTab 10: Engineering Architect */}
                {adminSubTab === 'engineering-architect' && (
                  <Suspense fallback={suspenseFallback}>
                    <AdminEngineeringArchitectPage
                      settings={settings}
                      onBackToProducts={() => setAdminSubTab('products')}
                    />
                  </Suspense>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* Slide-over Cart Drawer */}
      <CartDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        cartItems={cart}
        onUpdateQuantity={handleUpdateQuantity}
        onRemoveItem={handleRemoveCartItem}
        onClearCart={handleClearCart}
        settings={settings}
        onOrderPlaced={handleOrderPlaced}
        onOpenFullCheckout={() => {
          setIsCartOpen(false);
          setActiveTab('checkout');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      {/* Slide-over Wishlist Drawer */}
      <Suspense fallback={null}>
        <WishlistDrawer
          isOpen={isWishlistOpen}
          onClose={() => setIsWishlistOpen(false)}
          wishlistProducts={wishlistProducts}
          onRemoveFromWishlist={handleToggleWishlist}
          onAddToCart={handleAddToCart}
          onClearWishlist={() => {
            setWishlist([]);
            saveStoredWishlist([]);
          }}
          onOpenDetails={handleSelectProduct}
          settings={settings}
        />
      </Suspense>

      {/* Quick View Modal */}
      {quickViewProduct && (
        <Suspense fallback={null}>
          <QuickViewModal
            product={quickViewProduct}
            onClose={() => setQuickViewProduct(null)}
            onAddToCart={handleAddToCart}
            settings={settings}
            isInCart={cart.some((item) => item.product.id === quickViewProduct.id)}
          />
        </Suspense>
      )}

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onAuthSuccess={handleAuthSuccess}
      />

      {/* Public Add Product Modal */}
      <PublicAddProductModal
        isOpen={isPublicAddProductOpen}
        onClose={() => setIsPublicAddProductOpen(false)}
        categories={categories}
        settings={settings}
        onProductAdded={handleProductCreated}
      />

      {/* Supabase / Code Export Modal */}
      <Suspense fallback={null}>
        <SupabaseCodeModal isOpen={isDocsOpen} onClose={() => setIsDocsOpen(false)} />
      </Suspense>

      {/* Admin Copilot Assistant Modal */}
      <Suspense fallback={null}>
        <AdminCopilotModal
          isOpen={isCopilotOpen}
          onClose={() => setIsCopilotOpen(false)}
          products={products}
          orders={orders}
          settings={settings}
        />
      </Suspense>

      {/* Global Luxury Customer Footer */}
      <footer className="bg-stone-950 text-stone-400 border-t border-stone-800 text-xs py-12 mt-16 font-['Cairo',sans-serif]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8 mb-8 pb-8 border-b border-stone-900">
            <div className="space-y-3 sm:col-span-2 md:col-span-1">
              <div className="flex items-center gap-2">
                <span className="w-8 h-8 rounded-xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white font-black text-sm shadow-sm">
                  AD
                </span>
                <span className="text-white font-black text-base">{settings.storeName}</span>
              </div>
              <p className="text-stone-400 text-xs leading-relaxed">{settings.tagline}</p>
              <p className="text-stone-500 text-[11px]">
                منتجات تجميل وعناية أصلية 100% مختارة بعناية فائقة لتلبي أعلى المعايير العالمية.
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="text-white font-bold text-xs">روابط سريعة</h4>
              <ul className="space-y-1.5 text-stone-400 text-xs">
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveTab('store')}
                    className="hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    المتجر والمنتجات
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveTab('track-order')}
                    className="hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    تتبع الشحنات والطلبات
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveTab('branches')}
                    className="hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    فروعنا ومواقع الأتيليه
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setIsPublicAddProductOpen(true)}
                    className="hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    طلب إدراج منتج جديد
                  </button>
                </li>
              </ul>
            </div>

            <div className="space-y-2">
              <h4 className="text-white font-bold text-xs">خدمة العملاء والسياسات</h4>
              <ul className="space-y-1.5 text-stone-400 text-xs">
                <li>
                  <a
                    href={`https://wa.me/${settings.whatsappNumber.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-emerald-400 transition-colors"
                  >
                    خدمة عملاء واتساب: {settings.whatsappNumber}
                  </a>
                </li>
                <li>شحن وتوصيل فوري لجميع المدن</li>
                <li>ضمان استرجاع واستبدال مرن وفق الشروط</li>
                <li>دفع عند الاستلام وبطاقات مدى والتحويل البنكي</li>
              </ul>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-stone-500 text-[11px] text-center sm:text-right">
            <div>
              جميع الحقوق محفوظة © {new Date().getFullYear()} {settings.storeName}. تجربة تسوق عالمية فاخرة.
            </div>
            <div className="flex items-center gap-3 text-stone-400">
              <span>منتجات أصلية 100%</span>
              <span>•</span>
              <span>تسوق آمن وخدمة عملاء متواصلة</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;