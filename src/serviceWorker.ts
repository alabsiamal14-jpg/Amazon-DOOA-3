export interface ServiceWorkerUpdateDetail {
  registration: ServiceWorkerRegistration | null;
  reason: 'sw-waiting' | 'sw-updatefound' | 'server-build';
}

export type ServiceWorkerUpdateHandler = (detail: ServiceWorkerUpdateDetail) => void;

export const APP_UPDATE_EVENT = 'amazon-duaa:sw-update-available';

const UPDATE_CHECK_INTERVAL_MS = 60_000;

let activeRegistration: ServiceWorkerRegistration | null = null;
let latestUpdateDetail: ServiceWorkerUpdateDetail | null = null;
let baselineBundleSignature: string | null = null;
let controllerChangeAttached = false;
let isReloading = false;
let updateCheckIntervalId: ReturnType<typeof setInterval> | null = null;
let cleanupListeners: (() => void) | null = null;

const DEV_SW_CLEANED_KEY = 'amazon_duaa_dev_sw_cleaned_v1';

function isTestMode(): boolean {
  const metaEnv = (import.meta as unknown as { env?: { MODE?: string } })?.env;
  return metaEnv?.MODE === 'test';
}

function isTestOrDevDisabled(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return true;
  }
  const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean; MODE?: string } })?.env;
  if (metaEnv?.MODE === 'test') {
    return false;
  }
  if (metaEnv?.DEV) {
    return true;
  }
  return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
}

async function cleanupStaleServiceWorkersInDev(): Promise<void> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (isTestMode()) return;

  try {
    let hadActiveController = false;
    let unregisteredAny = false;

    if ('serviceWorker' in navigator) {
      hadActiveController = Boolean(navigator.serviceWorker.controller);
      if (typeof navigator.serviceWorker.getRegistrations === 'function') {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length > 0) {
          await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
          unregisteredAny = true;
        }
      }
    }

    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      const staleKeys = keys.filter(
        (key) => key.startsWith('amazon-duaa') || key.startsWith('elen-beauty')
      );
      if (staleKeys.length > 0) {
        await Promise.all(staleKeys.map((key) => caches.delete(key).catch(() => false)));
      }
    }

    if ((hadActiveController || unregisteredAny) && typeof sessionStorage !== 'undefined') {
      if (!sessionStorage.getItem(DEV_SW_CLEANED_KEY)) {
        sessionStorage.setItem(DEV_SW_CLEANED_KEY, '1');
        window.location.reload();
      }
    }
  } catch {
    // Ignore dev cleanup errors
  }
}

export function extractBundleSignatureFromHtml(html: string): string {
  const matches = html.match(/\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)/g);
  if (!matches || matches.length === 0) return '';
  return Array.from(new Set(matches)).sort().join('|');
}

function getCurrentDocumentSignature(): string {
  if (typeof document === 'undefined') return '';
  const refs: string[] = [];
  document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach((el) => {
    const attr = el.getAttribute('src') || el.getAttribute('href') || '';
    if (attr.includes('/assets/')) {
      refs.push(attr);
    }
  });
  return Array.from(new Set(refs)).sort().join('|');
}

function notifyUpdateAvailable(
  detail: ServiceWorkerUpdateDetail,
  callback?: ServiceWorkerUpdateHandler
): void {
  latestUpdateDetail = detail;
  if (callback) {
    callback(detail);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ServiceWorkerUpdateDetail>(APP_UPDATE_EVENT, { detail }));
  }
}

export function subscribeToServiceWorkerUpdates(listener: ServiceWorkerUpdateHandler): () => void {
  if (latestUpdateDetail) {
    listener(latestUpdateDetail);
  }

  if (typeof window === 'undefined') {
    return () => {};
  }

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<ServiceWorkerUpdateDetail>;
    if (customEvent.detail) {
      listener(customEvent.detail);
    }
  };

  window.addEventListener(APP_UPDATE_EVENT, handler);
  return () => {
    window.removeEventListener(APP_UPDATE_EVENT, handler);
  };
}

export async function checkForServerBuildUpdate(
  callback?: ServiceWorkerUpdateHandler
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  if (baselineBundleSignature === null) {
    baselineBundleSignature = getCurrentDocumentSignature();
  }

  try {
    const res = await fetch('/index.html', {
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) return false;

    const html = await res.text();
    const serverSignature = extractBundleSignatureFromHtml(html);

    if (
      baselineBundleSignature &&
      serverSignature &&
      serverSignature !== baselineBundleSignature
    ) {
      notifyUpdateAvailable(
        { registration: activeRegistration, reason: 'server-build' },
        callback
      );
      return true;
    }
  } catch {
    // Ignore transient offline/network errors
  }

  return false;
}

export async function checkForServiceWorkerUpdate(
  callback?: ServiceWorkerUpdateHandler
): Promise<void> {
  try {
    if (activeRegistration) {
      await activeRegistration.update();
      if (activeRegistration.waiting) {
        notifyUpdateAvailable(
          { registration: activeRegistration, reason: 'sw-waiting' },
          callback
        );
        return;
      }
    }
  } catch {
    // Ignore update check failure when offline
  }

  await checkForServerBuildUpdate(callback);
}

function attachRegistrationListeners(
  registration: ServiceWorkerRegistration,
  callback?: ServiceWorkerUpdateHandler
): void {
  activeRegistration = registration;

  if (registration.waiting) {
    notifyUpdateAvailable({ registration, reason: 'sw-waiting' }, callback);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker?.controller) {
        notifyUpdateAvailable({ registration, reason: 'sw-updatefound' }, callback);
      }
    });
  });
}

export async function registerServiceWorker(
  onUpdateAvailable?: ServiceWorkerUpdateHandler,
  options?: { swUrl?: string; force?: boolean }
): Promise<ServiceWorkerRegistration | null> {
  if (!options?.force && isTestOrDevDisabled()) {
    await cleanupStaleServiceWorkersInDev();
    return null;
  }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  baselineBundleSignature = getCurrentDocumentSignature();

  if (!controllerChangeAttached && typeof navigator.serviceWorker.addEventListener === 'function') {
    controllerChangeAttached = true;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (isReloading) return;
      isReloading = true;
      window.location.reload();
    });
  }

  const swUrl = options?.swUrl || '/sw.js';

  try {
    const registration = await navigator.serviceWorker.register(swUrl, {
      updateViaCache: 'none',
    });

    attachRegistrationListeners(registration, onUpdateAvailable);

    // Check immediately for updates after registration
    void registration.update().catch(() => {});

    // Set up automatic update detection on tab focus, network recovery, and periodic polling
    if (cleanupListeners) {
      cleanupListeners();
    }

    const handleVisibilityOrFocus = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void checkForServiceWorkerUpdate(onUpdateAvailable);
      }
    };

    const handleOnline = () => {
      void checkForServiceWorkerUpdate(onUpdateAvailable);
    };

    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    if (updateCheckIntervalId) {
      clearInterval(updateCheckIntervalId);
    }
    updateCheckIntervalId = setInterval(() => {
      void checkForServiceWorkerUpdate(onUpdateAvailable);
    }, UPDATE_CHECK_INTERVAL_MS);

    cleanupListeners = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleVisibilityOrFocus);
        window.removeEventListener('online', handleOnline);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      }
      if (updateCheckIntervalId) {
        clearInterval(updateCheckIntervalId);
        updateCheckIntervalId = null;
      }
    };

    return registration;
  } catch (err) {
    console.warn('Service worker registration failed:', err);
    return null;
  }
}

export async function applyServiceWorkerUpdate(
  registration?: ServiceWorkerRegistration | null
): Promise<void> {
  const targetReg =
    registration ||
    activeRegistration ||
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration().catch(() => undefined)
      : undefined);

  latestUpdateDetail = null;

  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {
      // Ignore cache cleanup errors
    }
  }

  if (targetReg?.waiting) {
    targetReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // Safety fallback reload if controllerchange does not fire rapidly
    setTimeout(() => {
      if (!isReloading && typeof window !== 'undefined') {
        isReloading = true;
        window.location.reload();
      }
    }, 800);
    return;
  }

  if (typeof window !== 'undefined') {
    isReloading = true;
    window.location.reload();
  }
}

export async function unregisterServiceWorker(): Promise<void> {
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }
  latestUpdateDetail = null;
  activeRegistration = null;

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.unregister();
      }
    } catch {
      // Ignore unregister errors
    }
  }
}

export function resetServiceWorkerStateForTests(): void {
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }
  activeRegistration = null;
  latestUpdateDetail = null;
  baselineBundleSignature = null;
  controllerChangeAttached = false;
  isReloading = false;
}
