import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  calculateTotals,
  getSuggestedCurrencyForCity,
  getActiveCurrencyCode,
} from '../src/lib/currency';
import { buildWhatsAppMessage } from '../src/lib/whatsapp';
import { INITIAL_SETTINGS, INITIAL_PRODUCTS } from '../src/data/initialData';

describe('Multi-Currency Architecture & Geo-Routing', () => {
  it('formats SAR, YER_OLD (Sanaa), YER_NEW (Aden), and USD accurately', () => {
    expect(formatCurrency(100, 'SAR', INITIAL_SETTINGS)).toBe('100 ريال');
    expect(formatCurrency(100, 'YER_OLD', INITIAL_SETTINGS)).toBe('14,200 ر.ي (صنعاء)');
    expect(formatCurrency(100, 'YER_NEW', INITIAL_SETTINGS)).toBe('44,000 ر.ي (عدن)');
    expect(formatCurrency(100, 'USD', INITIAL_SETTINGS)).toBe('26.67 $');
  });

  it('falls back safely to SAR or first active currency if inactive or unknown code passed', () => {
    const customSettings = {
      ...INITIAL_SETTINGS,
      currencies: {
        ...INITIAL_SETTINGS.currencies!,
        YER_NEW: { ...INITIAL_SETTINGS.currencies!.YER_NEW, active: false },
      },
    };
    expect(getActiveCurrencyCode(customSettings, 'YER_NEW')).toBe('SAR');
    expect(formatCurrency(50, 'UNKNOWN_CODE', customSettings)).toBe('50 ريال');
  });

  it('calculates order totals and applied exchange rate snapshot properly', () => {
    const items = [
      { price: 120, quantity: 2 },
      { price: 60, quantity: 1 },
    ];
    // subtotal = 300 SAR, discount = 30 SAR, shipping = 0 SAR -> total = 270 SAR
    const totalsYerOld = calculateTotals(items, 0, 'YER_OLD', INITIAL_SETTINGS, 30);
    expect(totalsYerOld.currencyCode).toBe('YER_OLD');
    expect(totalsYerOld.rateApplied).toBe(142);
    expect(totalsYerOld.subtotal).toBe(42600);
    expect(totalsYerOld.discount).toBe(4260);
    expect(totalsYerOld.total).toBe(38340);

    const totalsUsd = calculateTotals(items, 25, 'USD', INITIAL_SETTINGS, 0);
    expect(totalsUsd.currencyCode).toBe('USD');
    expect(totalsUsd.rateApplied).toBe(0.2667);
    expect(totalsUsd.subtotal).toBe(80.01);
    expect(totalsUsd.shipping).toBe(6.67);
    expect(totalsUsd.total).toBe(86.68);
  });

  it('routes cities to appropriate Yemeni or Saudi currency', () => {
    expect(getSuggestedCurrencyForCity('صنعاء')).toBe('YER_OLD');
    expect(getSuggestedCurrencyForCity('ذمار')).toBe('YER_OLD');
    expect(getSuggestedCurrencyForCity('عدن')).toBe('YER_NEW');
    expect(getSuggestedCurrencyForCity('حضرموت')).toBe('YER_NEW');
    expect(getSuggestedCurrencyForCity('الرياض')).toBe('SAR');
    expect(getSuggestedCurrencyForCity('')).toBeNull();
  });

  it('formats WhatsApp order messages in active selected currency with base reference', () => {
    const cart = [{ product: INITIAL_PRODUCTS[0], quantity: 1 }];
    const yerSettings = { ...INITIAL_SETTINGS, activeCurrency: 'YER_OLD' };
    const msg = buildWhatsAppMessage(cart, yerSettings, {
      customerName: 'دعاء',
      phone: '777627595',
      city: 'صنعاء',
      address: 'شارع حدة',
      notes: '',
    });
    expect(msg).toContain('YER_OLD');
    expect(msg).toContain('ر.ي (صنعاء)');
    expect(msg).toContain('سعر الصرف المطبق: 142');
  });
});
