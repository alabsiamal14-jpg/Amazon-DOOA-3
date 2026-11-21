import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import app from '../server.ts';
import {
  BACKUP_COLLECTIONS,
  isPermissionOrCredentialsError,
  pruneOldBackups,
  runFirestoreBackup,
  serializeFirestoreValue,
} from '../scripts/backup-firestore.ts';

function createMockFirestoreDb(fixtures: Record<string, Array<{ id: string; data: Record<string, any> }>>) {
  return {
    collection(name: string) {
      const items = [...(fixtures[name] || [])].sort((a, b) => a.id.localeCompare(b.id));

      const makeQuery = (startIndex: number, pageLimit: number) => ({
        limit(nextLimit: number) {
          return makeQuery(startIndex, nextLimit);
        },
        startAfter(lastDoc: { id: string }) {
          const foundIdx = items.findIndex((d) => d.id === lastDoc.id);
          return makeQuery(foundIdx >= 0 ? foundIdx + 1 : items.length, pageLimit);
        },
        async get() {
          const slice = items.slice(startIndex, startIndex + pageLimit);
          const docs = slice.map((item) => ({
            id: item.id,
            data: () => item.data,
          }));
          return { empty: docs.length === 0, docs };
        },
      });

      return {
        orderBy() {
          return makeQuery(0, items.length || 500);
        },
        async get() {
          const docs = items.map((item) => ({
            id: item.id,
            data: () => item.data,
          }));
          return { empty: docs.length === 0, docs };
        },
      };
    },
  };
}

describe('Firestore Backup Script & Public Exposure Protection', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0, tempRoots.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes Firestore Timestamp, DocumentReference, GeoPoint, and Buffers safely', () => {
    const fakeTimestamp = { toDate: () => new Date('2026-11-21T10:00:00.000Z') };
    const fakeRef = { path: 'users/u-1', id: 'u-1', firestore: {} };
    const fakeGeo = { latitude: 24.7136, longitude: 46.6753 };
    const rawBuf = Buffer.from('hello');

    const result = serializeFirestoreValue({
      createdAt: fakeTimestamp,
      userRef: fakeRef,
      location: fakeGeo,
      binary: rawBuf,
      nested: [{ ts: fakeTimestamp }],
    }) as Record<string, any>;

    expect(result.createdAt).toBe('2026-11-21T10:00:00.000Z');
    expect(result.userRef).toEqual({ __firestoreRef: 'users/u-1' });
    expect(result.location).toEqual({ latitude: 24.7136, longitude: 46.6753 });
    expect(result.binary).toBe(rawBuf.toString('base64'));
    expect(result.nested[0].ts).toBe('2026-11-21T10:00:00.000Z');
  });

  it('exports orders, products, and users into backups/<timestamp>/ with restricted permissions & pagination', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-duaa-backup-'));
    tempRoots.push(tempRoot);

    const mockDb = createMockFirestoreDb({
      orders: [
        { id: 'ord-1', data: { customer_name: 'سارة', total_amount: 180, status: 'pending' } },
        { id: 'ord-2', data: { customer_name: 'نورة', total_amount: 320, status: 'delivered' } },
        { id: 'ord-3', data: { customer_name: 'ريم', total_amount: 95, status: 'paid' } },
      ],
      products: [
        { id: 'prod-1', data: { title_ar: 'سيروم فيتامين سي', original_price: 120 } },
      ],
      users: [
        { id: 'usr-1', data: { email: 'customer@example.com', role: 'customer' } },
        { id: 'usr-2', data: { email: 'admin@example.com', role: 'admin' } },
      ],
    });

    const fixedNow = new Date('2026-11-21T21:15:00.000Z');
    const manifest = await runFirestoreBackup({
      db: mockDb,
      rootDir: tempRoot,
      pageSize: 2, // exercises multi-page pagination
      retentionDays: 14,
      now: fixedNow,
    });

    expect(manifest.collections.map((c) => c.collection)).toEqual([...BACKUP_COLLECTIONS]);
    expect(manifest.totalDocuments).toBe(6);

    const snapshotDir = path.join(tempRoot, manifest.backupDir);
    expect(fs.existsSync(path.join(snapshotDir, 'orders.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'products.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'users.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'manifest.json'))).toBe(true);

    const exportedOrders = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'orders.json'), 'utf8'));
    expect(exportedOrders).toHaveLength(3);
    expect(exportedOrders.map((o: any) => o.id)).toEqual(['ord-1', 'ord-2', 'ord-3']);

    const exportedUsers = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'users.json'), 'utf8'));
    expect(exportedUsers).toHaveLength(2);

    // Restrictive POSIX modes (0700 dirs, 0600 files) on Linux/macOS
    if (process.platform !== 'win32') {
      const backupsStat = fs.statSync(path.join(tempRoot, 'backups'));
      const fileStat = fs.statSync(path.join(snapshotDir, 'users.json'));
      expect(backupsStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it('prunes expired backup snapshots without touching recent ones or non-snapshot directories', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-duaa-prune-'));
    tempRoots.push(tempRoot);
    const backupsRoot = path.join(tempRoot, 'backups');
    fs.mkdirSync(path.join(backupsRoot, '2026-10-01T00-00-00-000Z'), { recursive: true });
    fs.mkdirSync(path.join(backupsRoot, '2026-11-20T00-00-00-000Z'), { recursive: true });
    fs.mkdirSync(path.join(backupsRoot, 'manual-archive'), { recursive: true });

    const removed = pruneOldBackups(backupsRoot, 14, new Date('2026-11-21T00:00:00.000Z'));
    expect(removed).toEqual(['2026-10-01T00-00-00-000Z']);
    expect(fs.existsSync(path.join(backupsRoot, '2026-10-01T00-00-00-000Z'))).toBe(false);
    expect(fs.existsSync(path.join(backupsRoot, '2026-11-20T00-00-00-000Z'))).toBe(true);
    expect(fs.existsSync(path.join(backupsRoot, 'manual-archive'))).toBe(true);
  });

  it('cleans up partial snapshot directory on Firestore PERMISSION_DENIED errors', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-duaa-perm-'));
    tempRoots.push(tempRoot);

    const failingDb = {
      collection() {
        return {
          async get() {
            const err: any = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
            err.code = 7;
            throw err;
          },
        };
      },
    };

    await expect(
      runFirestoreBackup({
        db: failingDb,
        rootDir: tempRoot,
        now: new Date('2026-11-21T21:16:00.000Z'),
      })
    ).rejects.toThrow(/PERMISSION_DENIED/i);

    expect(isPermissionOrCredentialsError({ code: 7, message: 'PERMISSION_DENIED' })).toBe(true);
    const snapshotDir = path.join(tempRoot, 'backups', '2026-11-21T21-16-00-000Z');
    expect(fs.existsSync(snapshotDir)).toBe(false);
  });

  it('blocks public HTTP access to /backups, /data, /scripts, and dotfiles with 403', async () => {
    for (const blockedPath of [
      '/backups',
      '/backups/',
      '/backups/2026-11-21T21-15-00-000Z/users.json',
      '/backups/manifest.json',
      '/data/employee-drafts.json',
      '/scripts/backup-firestore.ts',
      '/.env',
      '/.git/config',
    ]) {
      const res = await request(app).get(blockedPath);
      expect(res.status).toBe(403);
    }
  });
});
