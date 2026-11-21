import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FieldPath, Firestore } from 'firebase-admin/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { adminDb } from '../src/lib/firebase-admin.ts';

export const BACKUP_COLLECTIONS = ['orders', 'products', 'users'] as const;
export type BackupCollectionName = (typeof BACKUP_COLLECTIONS)[number];

const SNAPSHOT_DIR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z$/;

export interface BackupCollectionResult {
  collection: BackupCollectionName;
  count: number;
  file: string;
  bytes: number;
}

export interface BackupManifest {
  createdAt: string;
  projectId: string;
  databaseId: string;
  backupDir: string;
  totalDocuments: number;
  durationMs: number;
  collections: BackupCollectionResult[];
}

export interface RunBackupOptions {
  db?: Firestore | any;
  rootDir?: string;
  collections?: readonly BackupCollectionName[];
  pageSize?: number;
  retentionDays?: number;
  now?: Date;
}

/**
 * Recursively convert Firestore-specific types (Timestamp, DocumentReference, GeoPoint, Buffer)
 * into plain JSON-serializable values.
 */
export function serializeFirestoreValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeFirestoreValue(item));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, any>;

    // Firestore Timestamp duck-typing
    if (typeof obj.toDate === 'function') {
      const d = obj.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : String(d);
    }

    // Firestore DocumentReference duck-typing
    if (typeof obj.path === 'string' && typeof obj.id === 'string' && obj.firestore) {
      return { __firestoreRef: obj.path };
    }

    // Firestore GeoPoint duck-typing
    if (
      typeof obj.latitude === 'number' &&
      typeof obj.longitude === 'number' &&
      Object.keys(obj).length <= 3
    ) {
      return { latitude: obj.latitude, longitude: obj.longitude };
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = serializeFirestoreValue(v);
    }
    return out;
  }

  return value;
}

export function formatSnapshotTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function writeJsonAtomicSecure(filePath: string, payload: unknown): number {
  const json = JSON.stringify(payload, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore chmod failures on filesystems that do not support POSIX permissions
  }
  return Buffer.byteLength(json, 'utf8');
}

async function fetchCollectionDocuments(db: any, collectionName: string, pageSize: number) {
  const colRef = db.collection(collectionName);
  const documents: Array<Record<string, unknown>> = [];

  // Prefer deterministic documentId() pagination when supported by Firestore Admin SDK
  if (typeof colRef.orderBy === 'function' && typeof colRef.limit === 'function') {
    let lastDoc: any = null;
    while (true) {
      let query = colRef.orderBy(FieldPath.documentId()).limit(pageSize);
      if (lastDoc && typeof query.startAfter === 'function') {
        query = query.startAfter(lastDoc);
      }
      const snap = await query.get();
      if (!snap || snap.empty || !Array.isArray(snap.docs) || snap.docs.length === 0) {
        break;
      }
      for (const docSnap of snap.docs) {
        const rawData = typeof docSnap.data === 'function' ? docSnap.data() : {};
        const serialized = serializeFirestoreValue(rawData) as Record<string, unknown>;
        documents.push({ id: docSnap.id, ...serialized });
      }
      if (snap.docs.length < pageSize) {
        break;
      }
      lastDoc = snap.docs[snap.docs.length - 1];
    }
    return documents;
  }

  const snap = await colRef.get();
  const docsList = Array.isArray(snap?.docs) ? snap.docs : [];
  for (const docSnap of docsList) {
    const rawData = typeof docSnap.data === 'function' ? docSnap.data() : {};
    const serialized = serializeFirestoreValue(rawData) as Record<string, unknown>;
    documents.push({ id: docSnap.id, ...serialized });
  }
  return documents;
}

export function pruneOldBackups(backupsRoot: string, retentionDays: number, now: Date = new Date()): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 || !fs.existsSync(backupsRoot)) {
    return [];
  }

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_DIR_RE.test(entry.name)) {
      continue;
    }
    const isoCandidate = entry.name.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/,
      (_m, d, h, min, sec, ms) => `${d}T${h}:${min}:${sec}${ms ? '.' + ms : ''}Z`
    );
    const parsedTime = Date.parse(isoCandidate);
    if (!Number.isFinite(parsedTime) || parsedTime >= cutoffMs) {
      continue;
    }
    const fullDir = path.join(backupsRoot, entry.name);
    fs.rmSync(fullDir, { recursive: true, force: true });
    removed.push(entry.name);
  }

  return removed;
}

export function isPermissionOrCredentialsError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase();
  const code = (err as any)?.code;
  return (
    code === 7 ||
    code === 16 ||
    msg.includes('permission_denied') ||
    msg.includes('permission denied') ||
    msg.includes('unauthenticated') ||
    msg.includes('could not load the default credentials') ||
    msg.includes('insufficient permissions')
  );
}

export async function runFirestoreBackup(options: RunBackupOptions = {}): Promise<BackupManifest> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? process.cwd();
  const db = options.db ?? adminDb;
  const collections = options.collections ?? BACKUP_COLLECTIONS;
  const pageSize = Math.max(1, options.pageSize ?? 500);
  const envRetention = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
  const retentionDays = options.retentionDays ?? (Number.isFinite(envRetention) ? envRetention : 14);

  const backupsRoot = path.resolve(rootDir, 'backups');
  const snapshotName = formatSnapshotTimestamp(now);
  const snapshotDir = path.join(backupsRoot, snapshotName);

  fs.mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(backupsRoot, 0o700);
  } catch {
    // Ignore on unsupported FS
  }

  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(snapshotDir, 0o700);
  } catch {
    // Ignore on unsupported FS
  }

  const results: BackupCollectionResult[] = [];
  let totalDocuments = 0;

  try {
    for (const collectionName of collections) {
      const docs = await fetchCollectionDocuments(db, collectionName, pageSize);
      const fileName = `${collectionName}.json`;
      const targetFile = path.join(snapshotDir, fileName);
      const bytes = writeJsonAtomicSecure(targetFile, docs);

      totalDocuments += docs.length;
      results.push({
        collection: collectionName,
        count: docs.length,
        file: path.relative(rootDir, targetFile).replace(/\\/g, '/'),
        bytes,
      });
    }
  } catch (err) {
    // Clean up incomplete snapshot directory if backup failed mid-way
    try {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    projectId: firebaseConfig.projectId,
    databaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    backupDir: path.relative(rootDir, snapshotDir).replace(/\\/g, '/'),
    totalDocuments,
    durationMs: Date.now() - startedAt,
    collections: results,
  };

  writeJsonAtomicSecure(path.join(snapshotDir, 'manifest.json'), manifest);
  pruneOldBackups(backupsRoot, retentionDays, now);

  return manifest;
}

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  runFirestoreBackup()
    .then((manifest) => {
      console.log(
        `[Backup] Completed Firestore backup in ${manifest.durationMs}ms -> ${manifest.backupDir} (${manifest.totalDocuments} docs)`
      );
      for (const c of manifest.collections) {
        console.log(`  - ${c.collection}: ${c.count} documents (${c.bytes} bytes)`);
      }
      process.exit(0);
    })
    .catch((err) => {
      if (isPermissionOrCredentialsError(err)) {
        console.error(
          '[Backup] Firestore Admin access denied or missing credentials.\n' +
            '  - If this is a user-owned Google Cloud/Firebase project on a VPS, configure Application Default Credentials\n' +
            '    (e.g. GOOGLE_APPLICATION_CREDENTIALS pointing outside the repo) with roles/datastore.viewer.\n' +
            '  - If this is an AI Studio Starter Tier (Google-hosted) project, upgrade to a standard Google Cloud project\n' +
            '    at https://console.cloud.google.com/welcome to enable server-side Admin SDK Firestore access.'
        );
      } else {
        console.error('[Backup] Failed:', err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    });
}
