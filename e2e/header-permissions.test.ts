import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Navbar, resolveHeaderPermissions } from '../src/components/Navbar';
import { INITIAL_PRODUCTS, INITIAL_SETTINGS } from '../src/data/initialData';
import type { AdminUser, EmployeeSession, UserProfile } from '../src/types';

const noop = () => {};

function renderNavbarHtml(overrides: {
  adminUser?: AdminUser | null;
  currentUser?: UserProfile | null;
  employeeSession?: EmployeeSession | null;
  cartCount?: number;
  wishlistCount?: number;
}) {
  return renderToStaticMarkup(
    React.createElement(Navbar, {
      activeTab: 'store',
      setActiveTab: noop,
      cartCount: overrides.cartCount ?? 2,
      cartTotal: 150,
      onOpenCart: noop,
      wishlistCount: overrides.wishlistCount ?? 1,
      onOpenWishlist: noop,
      settings: INITIAL_SETTINGS,
      onChangeCurrency: noop,
      onOpenDocs: noop,
      ordersCount: 7,
      adminUser: overrides.adminUser ?? null,
      onLogoutAdmin: noop,
      products: INITIAL_PRODUCTS.slice(0, 3),
      onSelectProduct: noop,
      onAddToCart: noop,
      onSearchSubmit: noop,
      currentUser: overrides.currentUser ?? null,
      employeeSession: overrides.employeeSession ?? null,
      onOpenAuthModal: noop,
      onLogoutUser: noop,
    })
  );
}

describe('Header Role Separation & Permissions', () => {
  it('hides all admin/staff/driver/employee links for unauthenticated visitors while keeping shopping UI', () => {
    const html = renderNavbarHtml({});

    // Hidden internal/admin/staff links
    expect(html).not.toContain('<span>الطلبات</span>');
    expect(html).not.toContain('المندوب');
    expect(html).not.toContain('مساعد الموظفين');
    expect(html).not.toContain('لوحة التحكم');
    expect(html).not.toContain('بوابة الموظف');
    expect(html).not.toContain('المستشار البرمجي');
    expect(html).not.toContain('خروج الإدارة');
    expect(html).not.toContain('دخول الإدارة');
    expect(html).not.toContain('أكواد النشر');
    expect(html).not.toContain('سحابة Firebase متصلة');

    // Preserved customer storefront UI
    expect(html).toContain(INITIAL_SETTINGS.storeName);
    expect(html).toContain('اختيار العملة');
    expect(html).toContain('المفضلة');
    expect(html).toContain('تسجيل الدخول');
    expect(html).toContain('السلة');
    expect(html).toContain('المتجر');
    expect(html).toContain('فروعنا');
    expect(html).toContain('تتبع طلبك');
    expect(html).toContain('الدفع');
    expect(html).toContain('توصيل سريع وآمن لكافة المدن');
  });

  it('does NOT grant admin or driver access to a normal logged-in customer', () => {
    const customerUser: UserProfile = {
      uid: 'cust-1',
      name: 'عميلة المتجر',
      email: 'customer@example.com',
      role: 'customer',
    };

    const perms = resolveHeaderPermissions({
      adminUser: null,
      currentUser: customerUser,
      employeeSession: null,
    });

    expect(perms.isAdmin).toBe(false);
    expect(perms.canViewAdminOrders).toBe(false);
    expect(perms.canViewDriverPortal).toBe(false);
    expect(perms.canViewEmployeeAssistant).toBe(false);
    expect(perms.canViewAdminDashboard).toBe(false);
    expect(perms.canViewDevAdvisor).toBe(false);
    expect(perms.canViewAdminLogout).toBe(false);

    const html = renderNavbarHtml({ currentUser: customerUser });
    expect(html).not.toContain('لوحة التحكم');
    expect(html).not.toContain('المندوب');
    expect(html).not.toContain('مساعد الموظفين');
    expect(html).not.toContain('المستشار البرمجي');
    expect(html).not.toContain('خروج الإدارة');
    expect(html).not.toContain('مشرف');
    expect(html).toContain('عميلة المتجر');
  });

  it('rejects malformed or non-admin adminUser objects without valid admin role', () => {
    const invalidAdmin = {
      id: 'fake-1',
      username: 'fake',
      displayName: 'Fake',
      role: 'customer',
    } as unknown as AdminUser;

    const perms = resolveHeaderPermissions({
      adminUser: invalidAdmin,
      currentUser: null,
      employeeSession: null,
    });

    expect(perms.isAdmin).toBe(false);
    expect(perms.canViewAdminDashboard).toBe(false);
    expect(perms.canViewAdminLogout).toBe(false);
  });

  it('shows full admin navigation only for verified admin role', () => {
    const verifiedAdmin: AdminUser = {
      id: 'admin-super-1',
      username: 'omralabis@gmail.com',
      displayName: 'المدير العام',
      role: 'superadmin',
    };

    const html = renderNavbarHtml({ adminUser: verifiedAdmin });
    expect(html).toContain('الطلبات');
    expect(html).toContain('المندوب 🛵');
    expect(html).toContain('مساعد الموظفين 🤖');
    expect(html).toContain('لوحة التحكم');
    expect(html).toContain('المستشار البرمجي');
    expect(html).toContain('خروج الإدارة');
    expect(html).toContain('أكواد النشر');
  });

  it('shows only role-permitted links for staff, employee, and driver roles', () => {
    const staffUser: UserProfile = {
      uid: 'staff-1',
      name: 'موظفة منتجات',
      email: 'staff@example.com',
      role: 'staff',
    };
    const staffHtml = renderNavbarHtml({ currentUser: staffUser });
    expect(staffHtml).toContain('بوابة الموظف');
    expect(staffHtml).not.toContain('لوحة التحكم');
    expect(staffHtml).not.toContain('<span>الطلبات</span>');
    expect(staffHtml).not.toContain('المندوب 🛵');
    expect(staffHtml).not.toContain('مساعد الموظفين');
    expect(staffHtml).not.toContain('المستشار البرمجي');
    expect(staffHtml).not.toContain('خروج الإدارة');

    const employeeSession: EmployeeSession = {
      code: 'EMP001',
      displayName: 'موظف إدخال',
      role: 'employee',
      token: 'valid.jwt.token',
    };
    const employeeHtml = renderNavbarHtml({ employeeSession });
    expect(employeeHtml).toContain('مساعد الموظفين 🤖');
    expect(employeeHtml).not.toContain('لوحة التحكم');
    expect(employeeHtml).not.toContain('<span>الطلبات</span>');
    expect(employeeHtml).not.toContain('المندوب 🛵');
    expect(employeeHtml).not.toContain('المستشار البرمجي');
    expect(employeeHtml).not.toContain('خروج الإدارة');

    const driverUser: UserProfile = {
      uid: 'drv-1',
      name: 'الكابتن محمد',
      email: 'driver@example.com',
      role: 'driver',
    };
    const driverHtml = renderNavbarHtml({ currentUser: driverUser });
    expect(driverHtml).toContain('المندوب 🛵');
    expect(driverHtml).not.toContain('لوحة التحكم');
    expect(driverHtml).not.toContain('<span>الطلبات</span>');
    expect(driverHtml).not.toContain('مساعد الموظفين');
    expect(driverHtml).not.toContain('المستشار البرمجي');
    expect(driverHtml).not.toContain('خروج الإدارة');
  });
});
