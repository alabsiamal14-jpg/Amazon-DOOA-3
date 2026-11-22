import type { CurrencyConfig, StoreSettings } from '../types.ts';
import { getProductPricing } from './pricing.ts';

export const FALLBACK_CURRENCIES: Record<string, CurrencyConfig> = {
  SAR: {
    code: 'SAR',
    name_ar: 'ريال سعودي (الأساس)',
    symbol: 'ريال',
    rate: 1,
    decimals: 0,
    badgeColor: 'rose',
    active: true,
  },
  YER_OLD: {
    code: 'YER_OLD',
    name_ar: 'ريال يمني (صنعاء - قديم)',
    symbol: 'ر.ي (صنعاء)',
    rate: 142,
    decimals: 0,
    badgeColor: 'amber',
    active: true,
  },
  YER_NEW: {
    code: 'YER_NEW',
    name_ar: 'ريال يمني (عدن - جديد)',
    symbol: 'ر.ي (عدن)',
    rate: 440,
    decimals: 0,
    badgeColor: 'emerald',
    active: true,
  },
  USD: {
    code: 'USD',
    name_ar: 'دولار أمريكي',
    symbol: '$',
    rate: 0.2667,
    decimals: 2,
    badgeColor: 'sky',
    active: true,
  },
};

export function getEffectiveCurrencies(settings?: Partial<StoreSettings>): Record<string, CurrencyConfig> {
  const custom = settings?.currencies;
  if (!custom || typeof custom !== 'object' || Object.keys(custom).length === 0) {
    return FALLBACK_CURRENCIES;
  }
  const merged: Record<string, CurrencyConfig> = { ...FALLBACK_CURRENCIES };
  for (const [key, cfg] of Object.entries(custom)) {
    if (cfg && typeof cfg === 'object') {
      merged[key] = {
        ...(FALLBACK_CURRENCIES[key] || { code: key, symbol: key, rate: 1, decimals: 0, active: true }),
        ...cfg,
        code: cfg.code || key,
        rate: Number.isFinite(Number(cfg.rate)) && Number(cfg.rate) > 0 ? Number(cfg.rate) : 1,
        decimals: Number.isFinite(Number(cfg.decimals)) && Number(cfg.decimals) >= 0 ? Number(cfg.decimals) : 0,
      };
    }
  }
  return merged;
}

export function getActiveCurrencyCode(settings?: Partial<StoreSettings>, overrideCode?: string): string {
  const currencies = getEffectiveCurrencies(settings);
  const candidate = overrideCode || settings?.activeCurrency || 'SAR';
  if (currencies[candidate]?.active) {
    return candidate;
  }
  const firstActive = Object.values(currencies).find((c) => c.active);
  return firstActive?.code || 'SAR';
}

export function resolveCurrencyConfig(
  currencyCode?: string,
  settings?: Partial<StoreSettings>
): CurrencyConfig {
  const currencies = getEffectiveCurrencies(settings);
  const code = getActiveCurrencyCode(settings, currencyCode);
  const resolved = currencies[code] || currencies.SAR || FALLBACK_CURRENCIES.SAR;
  if (code === 'SAR' && settings?.currency && settings.currency.trim()) {
    return { ...resolved, symbol: settings.currency.trim() };
  }
  return resolved;
}

export function convertAmount(
  amountBase: number,
  currencyCode?: string,
  settings?: Partial<StoreSettings>
): number {
  const safeBase = Number.isFinite(Number(amountBase)) ? Number(amountBase) : 0;
  const currency = resolveCurrencyConfig(currencyCode, settings);
  const converted = safeBase * currency.rate;
  if (currency.decimals === 0) {
    return Math.round(converted);
  }
  const factor = Math.pow(10, currency.decimals);
  return Math.round(converted * factor) / factor;
}

export function formatCurrency(
  amountBase: number,
  currencyCode?: string,
  settings?: Partial<StoreSettings>
): string {
  const currency = resolveCurrencyConfig(currencyCode, settings);
  const converted = convertAmount(amountBase, currency.code, settings);

  const formattedNumber =
    currency.decimals === 0
      ? converted.toLocaleString('en-US')
      : converted.toLocaleString('en-US', {
          minimumFractionDigits: currency.decimals,
          maximumFractionDigits: currency.decimals,
        });

  return `${formattedNumber} ${currency.symbol}`;
}

export interface CurrencyOrderTotals {
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  rateApplied: number;
  currencyCode: string;
  symbol: string;
}

export function calculateTotals(
  items: Array<{
    price?: number;
    quantity: number;
    product?: { original_price: number; discount_price?: number | null };
  }>,
  shippingBase: number,
  currencyCode?: string,
  settings?: Partial<StoreSettings>,
  discountBase: number = 0
): CurrencyOrderTotals {
  const currency = resolveCurrencyConfig(currencyCode, settings);

  const subtotalBase = items.reduce((sum, item) => {
    const unit =
      typeof item.price === 'number'
        ? item.price
        : item.product
          ? getProductPricing(item.product).finalPrice
          : 0;
    const qty = Math.max(0, Number(item.quantity) || 0);
    return sum + unit * qty;
  }, 0);

  const safeDiscountBase = Math.max(0, Math.min(subtotalBase, Number(discountBase) || 0));
  const safeShippingBase = Math.max(0, Number(shippingBase) || 0);
  const totalBase = Math.max(0, subtotalBase - safeDiscountBase + safeShippingBase);

  return {
    subtotal: convertAmount(subtotalBase, currency.code, settings),
    discount: convertAmount(safeDiscountBase, currency.code, settings),
    shipping: convertAmount(safeShippingBase, currency.code, settings),
    total: convertAmount(totalBase, currency.code, settings),
    rateApplied: currency.rate,
    currencyCode: currency.code,
    symbol: currency.symbol,
  };
}

export function getSuggestedCurrencyForCity(city: string): string | null {
  const clean = String(city || '').trim();
  if (!clean) return null;
  if (/صنعاء|ذمار|إب|عمران|صعدة|حجة|المحويت|الحديدة/.test(clean)) {
    return 'YER_OLD';
  }
  if (/عدن|تعز|حضرموت|المكلا|مأرب|شبوة|لحج|أبين|المهرة/.test(clean)) {
    return 'YER_NEW';
  }
  if (/الرياض|جدة|مكة|الدمام|المدينة|الخبر/.test(clean)) {
    return 'SAR';
  }
  return null;
}
