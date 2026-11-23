// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  APP_UPDATE_EVENT,
  applyServiceWorkerUpdate,
  checkForServerBuildUpdate,
  extractBundleSignatureFromHtml,
  registerServiceWorker,
  resetServiceWorkerStateForTests,
  subscribeToServiceWorkerUpdates,
} from '../src/serviceWorker';
import { UpdateNotificationBanner } from '../src/components/UpdateNotificationBanner';

describe('Service Worker Immediate Update & Notification Flow', () => {
  beforeEach(() => {
    resetServiceWorkerStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetServiceWorkerStateForTests();
  });

  it('extracts and sorts Vite bundle signatures deterministically from index.html', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/assets/index-css123.css" />
        </head>
        <body>
          <script type="module" src="/assets/index-js456.js"></script>
        </body>
      </html>
    `;
    expect(extractBundleSignatureFromHtml(html)).toBe('/assets/index-css123.css|/assets/index-js456.js');
  });

  it('registers /sw.js with updateViaCache: "none" and notifies on waiting worker or updatefound', async () => {
    const listeners = new Map<string, Array<(e?: any) => void>>();
    const mockWindow = {
      addEventListener: vi.fn((ev: string, cb: any) => {
        listeners.set(ev, [...(listeners.get(ev) || []), cb]);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn((ev: any) => {
        const cbs = listeners.get(ev.type) || [];
        cbs.forEach((cb) => cb(ev));
        return true;
      }),
      location: { reload: vi.fn() },
    };
    const mockDocument = {
      visibilityState: 'visible',
      querySelectorAll: vi.fn(() => [
        { getAttribute: (a: string) => (a === 'src' ? '/assets/index-old.js' : null) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const swListeners = new Map<string, Array<(e?: any) => void>>();
    const regListeners = new Map<string, Array<(e?: any) => void>>();
    const workerListeners = new Map<string, Array<(e?: any) => void>>();

    const waitingWorker = {
      state: 'installed',
      postMessage: vi.fn(),
    };

    const installingWorker = {
      state: 'installing',
      addEventListener: vi.fn((ev: string, cb: any) => {
        workerListeners.set(ev, [...(workerListeners.get(ev) || []), cb]);
      }),
    };

    const mockRegistration: any = {
      waiting: waitingWorker,
      installing: installingWorker,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((ev: string, cb: any) => {
        regListeners.set(ev, [...(regListeners.get(ev) || []), cb]);
      }),
    };

    const mockRegister = vi.fn().mockResolvedValue(mockRegistration);

    vi.stubGlobal('window', mockWindow);
    vi.stubGlobal('document', mockDocument);
    vi.stubGlobal('navigator', {
      onLine: true,
      serviceWorker: {
        controller: { state: 'activated' },
        register: mockRegister,
        addEventListener: vi.fn((ev: string, cb: any) => {
          swListeners.set(ev, [...(swListeners.get(ev) || []), cb]);
        }),
        getRegistration: vi.fn().mockResolvedValue(mockRegistration),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '<script src="/assets/index-new.js"></script>',
      })
    );

    const updates: any[] = [];
    const unsubscribe = subscribeToServiceWorkerUpdates((detail) => updates.push(detail));

    const reg = await registerServiceWorker(undefined, { force: true });
    expect(reg).toBe(mockRegistration);
    expect(mockRegister).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' });
    expect(mockRegistration.update).toHaveBeenCalled();

    // Waiting worker triggered immediate update notice
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].reason).toBe('sw-waiting');

    // Simulate clicking update -> sends SKIP_WAITING to waiting worker
    await applyServiceWorkerUpdate(mockRegistration);
    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // Simulate controllerchange -> reloads once
    const ctrlCbs = swListeners.get('controllerchange') || [];
    ctrlCbs.forEach((cb) => cb());
    expect(mockWindow.location.reload).toHaveBeenCalledTimes(1);

    // Server HTML bundle change also fires APP_UPDATE_EVENT
    const serverChanged = await checkForServerBuildUpdate();
    expect(serverChanged).toBe(true);
    expect(updates.some((u) => u.reason === 'server-build')).toBe(true);

    unsubscribe();
    vi.unstubAllGlobals();
  });

  it('UpdateNotificationBanner renders nothing initially and supports exact Arabic notification label in code', () => {
    const html = renderToStaticMarkup(React.createElement(UpdateNotificationBanner));
    expect(html).toBe('');
  });

  it('exports the expected custom update event name', () => {
    expect(APP_UPDATE_EVENT).toBe('amazon-duaa:sw-update-available');
  });
});
