import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type {
  EngineeringAuditLogEntry,
  EngineeringChatMessage,
  EngineeringEvidenceRef,
  EngineeringFileDiff,
  EngineeringFinding,
  EngineeringFindingCategory,
  EngineeringPatchProposal,
  EngineeringReverificationResult,
  EngineeringScanReport,
  EngineeringScanScope,
} from '../types.ts';
import {
  analyzeDangerouslySetInnerHtml,
  analyzeUiDialogsWithReachability,
  buildProjectRuntimeGraph,
  isScannerEngineOrRulesFile,
  parseFirestoreRulesFull,
  traceSecretEnvUsageInBrowserPaths,
  verifyFindingFileReferences,
  verifyInstalledPackageAndAiModelCompatibility,
  type FileRuntimeProfile,
} from './engineering-static-analyzer.ts';

const execFileAsync = promisify(execFile);

interface EngineeringArchitectState {
  scans: EngineeringScanReport[];
  findings: EngineeringFinding[];
  proposals: EngineeringPatchProposal[];
  auditLogs: EngineeringAuditLogEntry[];
  chatMessages: EngineeringChatMessage[];
  backups: Record<string, Record<string, string>>; // proposalId -> { relPath: originalFileContent }
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

function getStateFilePath(): string {
  if (isTestRuntime()) {
    return path.join(os.tmpdir(), 'amazon-duaa-engineering-architect-test.json');
  }
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'engineering-architect-state.json');
}

const DEFAULT_WELCOME_CHAT: EngineeringChatMessage = {
  id: 'eng-arch-welcome',
  role: 'assistant',
  text: 'مرحباً بك في **المستشار الهندسي الذكي (Amazon Duaa AI Engineering Architect)**. أنا نظام هندسي مستقل متخصص في جودة المتجر، الأمان، سلامة واجهات المستخدم وتوافق الهواتف، الأداء، وسلامة Firebase وFirestore وتدفقات السلة والطلبات.\n\nأعتمد حصرياً على قراءة ملفات المشروع الفعلية والكود الحقيقي، وأميّز بدقة بين المشكلة المؤكدة والمحتملة والتحسين المقترح، ولا أنفذ أي تعديل إلا بعد عرض التغيير والحصول على موافقتك الصريحة.',
  evidence_files: [],
  uninspected_notes: [],
  timestamp: new Date().toISOString(),
};

let memoryState: EngineeringArchitectState | null = null;

function createEmptyState(): EngineeringArchitectState {
  return {
    scans: [],
    findings: [],
    proposals: [],
    auditLogs: [],
    chatMessages: [DEFAULT_WELCOME_CHAT],
    backups: {},
  };
}

function deduplicateFindings(items: EngineeringFinding[]): EngineeringFinding[] {
  const byRuleKey = new Map<string, EngineeringFinding>();
  const byContentKey = new Set<string>();
  for (const item of items) {
    const contentKey = `${item.domain}::${[...(item.affected_files || [])].sort().join(',')}::${item.title_ar}`;
    const existing = byRuleKey.get(item.rule_key);
    if (existing) {
      // Keep the entry with higher status priority or fresher timestamp
      const prevTs = new Date(existing.updated_at).getTime();
      const nextTs = new Date(item.updated_at).getTime();
      if (nextTs >= prevTs) {
        byRuleKey.set(item.rule_key, {
          ...item,
          last_reverification: item.last_reverification ?? existing.last_reverification ?? null,
          proposal_id: item.proposal_id ?? existing.proposal_id ?? null,
        });
      }
      continue;
    }
    if (byContentKey.has(contentKey)) continue;
    byContentKey.add(contentKey);
    byRuleKey.set(item.rule_key, item);
  }
  return Array.from(byRuleKey.values()).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

function loadState(): EngineeringArchitectState {
  if (memoryState) return memoryState;
  const filePath = getStateFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
      memoryState = {
        scans: Array.isArray(parsed.scans) ? parsed.scans : [],
        findings: deduplicateFindings(rawFindings),
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
        chatMessages:
          Array.isArray(parsed.chatMessages) && parsed.chatMessages.length > 0
            ? parsed.chatMessages
            : [DEFAULT_WELCOME_CHAT],
        backups: parsed.backups && typeof parsed.backups === 'object' ? parsed.backups : {},
      };
      return memoryState;
    } catch {
      memoryState = createEmptyState();
      return memoryState;
    }
  }
  memoryState = createEmptyState();
  return memoryState;
}

function saveState(): void {
  const state = loadState();
  const filePath = getStateFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export function resetEngineeringArchitectTestState(): void {
  if (!isTestRuntime()) return;
  memoryState = createEmptyState();
  const fp = getStateFilePath();
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
  }
}

// =========================================================================
// Security & Project Protection Policies
// =========================================================================

const SECRET_FILENAME_RE =
  /(^|\/)(\.env($|\.)|.*service[-_]?account.*\.json$|.*firebase[-_]?adminsdk.*\.json$|\.npmrc$|\.git\/)/i;

const WRITE_PROTECTED_FILES = new Set<string>([
  // Existing Developer Advisor (STRICTLY UNTOUCHABLE)
  'src/components/AdminDeveloperAdvisor.tsx',
  'src/services/codebaseScanner.ts',
  'src/services/zipProjectAnalyzer.ts',
  // Firebase / Supabase / Core DB & Secrets (Protected unless explicitly changed by owner outside architect)
  'firebase-applet-config.json',
  'firebase-blueprint.json',
  'firestore.rules',
  'src/lib/firebase.ts',
  'src/lib/firebase-admin.ts',
  'src/lib/supabase.ts',
  'package-lock.json',
  '.env',
  '.env.example',
  '.env.local',
]);

const WRITE_PROTECTED_PREFIXES = [
  'data/',
  'uploads/',
  'node_modules/',
  '.git/',
  'dist/',
  'src/lib/engineering-architect-store.ts',
  'src/server/routes/engineering-architect.ts',
];

const READ_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'uploads',
  'data',
  '.cache',
  '.aistudio',
  'Amazon-Duaa-v1',
]);

const READ_ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.rules',
  '.md',
]);

export function sanitizeSecretPatterns(content: string): string {
  return content
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/(ADMIN_PASSWORD|ADMIN_JWT_SECRET|SESSION_SECRET|GEMINI_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*[^\r\n]+/g, '$1=[REDACTED]');
}

export function normalizeRepoRelPath(rawPath: string): string {
  const cleaned = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) {
    throw new Error('مسار الملف غير صالح أو غير مسموح بتجاوز حدود المستودع.');
  }
  return cleaned;
}

export function isFileProtectedFromWrite(relPath: string): { protected: boolean; reason?: string } {
  const norm = normalizeRepoRelPath(relPath);
  if (SECRET_FILENAME_RE.test(norm)) {
    return { protected: true, reason: 'ملفات البيئة والأسرار محمية بالكامل ولا يجوز تعديلها.' };
  }
  if (WRITE_PROTECTED_FILES.has(norm)) {
    return {
      protected: true,
      reason: `الملف (${norm}) محمي بموجب سياسة حماية المشروع (المستشار البرمجي الأول أو إعدادات Firebase/Supabase/الأسرار).`,
    };
  }
  for (const prefix of WRITE_PROTECTED_PREFIXES) {
    if (norm.startsWith(prefix)) {
      return {
        protected: true,
        reason: `المسار (${norm}) محمي من التعديل المباشر للحفاظ على بيانات المتجر وسلامة النظام.`,
      };
    }
  }
  const ext = path.extname(norm).toLowerCase();
  if (!['.ts', '.tsx', '.css', '.html', '.json'].includes(ext)) {
    return {
      protected: true,
      reason: `الامتداد (${ext || 'غير محدد'}) غير مسموح بتعديله عبر التنفيذ الهندسي الآلي.`,
    };
  }
  return { protected: false };
}

export function listInspectableRepoFiles(rootDir: string = process.cwd()): {
  files: string[];
  skippedSecrets: string[];
} {
  const files: string[] = [];
  const skippedSecrets: string[] = [];

  function walk(dir: string, relBase: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (READ_IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (SECRET_FILENAME_RE.test(rel)) {
          skippedSecrets.push(rel);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (READ_ALLOWED_EXTENSIONS.has(ext) || entry.name === 'firestore.rules') {
          files.push(rel);
        }
      }
    }
  }

  walk(rootDir, '');
  files.sort();
  return { files, skippedSecrets };
}

export function readWorkspaceFileSafe(
  relPath: string,
  startLine?: number,
  endLine?: number,
  rootDir: string = process.cwd()
): {
  file: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  numberedContent: string;
  rawContent: string;
} {
  const norm = normalizeRepoRelPath(relPath);
  if (SECRET_FILENAME_RE.test(norm)) {
    throw new Error(`غير مسموح بقراءة ملفات الأسرار أو البيئة (${norm}).`);
  }
  const resolvedRoot = path.resolve(rootDir);
  const absPath = path.resolve(resolvedRoot, norm);
  if (!absPath.startsWith(resolvedRoot + path.sep) && absPath !== resolvedRoot) {
    throw new Error('محاولة الوصول إلى مسار خارج حدود المشروع مرفوضة.');
  }
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new Error(`الملف غير موجود في المستودع: ${norm}`);
  }

  const raw = sanitizeSecretPatterns(fs.readFileSync(absPath, 'utf8'));
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const s = Math.max(1, Number.isFinite(startLine) ? Number(startLine) : 1);
  const e = Math.min(totalLines, Number.isFinite(endLine) ? Number(endLine) : Math.min(totalLines, s + 249));
  const slice = lines.slice(s - 1, e);
  const numberedContent = slice.map((ln, i) => `${s + i}: ${ln}`).join('\n');

  return {
    file: norm,
    totalLines,
    startLine: s,
    endLine: e,
    numberedContent,
    rawContent: slice.join('\n'),
  };
}

// =========================================================================
// Real Codebase Engineering Auditors (Deterministic + Evidence-Verified)
// =========================================================================

function findLineMatches(
  content: string,
  regex: RegExp,
  maxMatches = 4
): Array<{ line: number; snippet: string }> {
  const lines = content.split(/\r?\n/);
  const matches: Array<{ line: number; snippet: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({
        line: i + 1,
        snippet: lines[i].trim().slice(0, 180),
      });
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

function loadRepoText(files: string[], rootDir = process.cwd()): Map<string, string> {
  const map = new Map<string, string>();
  const resolvedRoot = path.resolve(rootDir);
  for (const rel of files) {
    try {
      const abs = path.resolve(resolvedRoot, rel);
      const stat = fs.statSync(abs);
      if (stat.size > 400_000) continue;
      map.set(rel, fs.readFileSync(abs, 'utf8'));
    } catch {
      // Skip unreadable file
    }
  }
  return map;
}

function buildUnifiedDiffPreview(filePath: string, original: string, proposed: string): string {
  const oldLines = original.split(/\r?\n/).map((l) => `- ${l}`);
  const newLines = proposed.split(/\r?\n/).map((l) => `+ ${l}`);
  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...oldLines, ...newLines].join('\n');
}

function appendAuditLog(entry: Omit<EngineeringAuditLogEntry, 'id' | 'timestamp'>): EngineeringAuditLogEntry {
  const state = loadState();
  const full: EngineeringAuditLogEntry = {
    ...entry,
    id: `eng-audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
  };
  state.auditLogs.unshift(full);
  state.auditLogs = state.auditLogs.slice(0, 200);
  saveState();
  return full;
}

function evaluateCodebaseFindings(
  scope: EngineeringScanScope,
  scanId: string,
  rootDir: string,
  virtualFileOverrides?: Map<string, string>
): {
  discovered: EngineeringFinding[];
  inspectedFiles: string[];
  skippedSecrets: string[];
  layerBreakdown: { server: number; client: number; shared: number; config_rules: number; unreferenced: number };
  firestoreParsedPathsCount: number;
  suppressedFalsePositivesCount: number;
  suppressedNotesAr: string[];
  profiles: Map<string, FileRuntimeProfile>;
} {
  const { files, skippedSecrets } = listInspectableRepoFiles(rootDir);
  const fileTexts = loadRepoText(files, rootDir);
  if (virtualFileOverrides) {
    for (const [rel, overrideContent] of virtualFileOverrides.entries()) {
      fileTexts.set(rel, overrideContent);
    }
  }

  const inspectedFiles = Array.from(fileTexts.keys());
  const graph = buildProjectRuntimeGraph(fileTexts);

  const rawDiscovered: EngineeringFinding[] = [];
  const suppressedNotesAr: string[] = [];
  let suppressedFalsePositivesCount = 0;
  let firestoreParsedPathsCount = 0;

  const now = new Date().toISOString();
  let seq = 1;

  const pushFinding = (
    item: Omit<EngineeringFinding, 'id' | 'scan_id' | 'status' | 'proposal_id' | 'created_at' | 'updated_at'>
  ) => {
    const primaryFile = item.affected_files[0];
    const primaryProfile = primaryFile ? graph.profiles.get(primaryFile) : undefined;
    const candidate: EngineeringFinding = {
      ...item,
      runtime_layer: item.runtime_layer ?? primaryProfile?.layer ?? 'config_rules',
      reachability: item.reachability ?? primaryProfile?.reachability ?? 'config_or_rules',
      import_chain:
        item.import_chain ??
        primaryProfile?.clientChain ??
        primaryProfile?.serverChain ??
        undefined,
      id: `eng-find-${scanId.slice(-6)}-${seq++}`,
      scan_id: scanId,
      status: 'open',
      proposal_id: null,
      created_at: now,
      updated_at: now,
    };

    // Rule #1 & #4: Never allow scanner/rules files as vulnerability targets unless explicitly appropriate,
    // and strictly verify existence of EVERY referenced file on disk before emitting!
    if (
      item.diagnosis_type === 'confirmed_vulnerability' &&
      item.affected_files.every((f) => isScannerEngineOrRulesFile(f))
    ) {
      return;
    }
    const verified = verifyFindingFileReferences(candidate, rootDir, fileTexts);
    if (verified && !rawDiscovered.some((r) => r.rule_key === verified.rule_key)) {
      rawDiscovered.push(verified);
    }
  };

  const includeSecurity = scope === 'comprehensive' || scope === 'security';
  const includeUi = scope === 'comprehensive' || scope === 'ui_design';
  const includePerf = scope === 'comprehensive' || scope === 'performance';

  // ---- 1. SECURITY, AUTH/RBAC & FULL STRUCTURAL FIRESTORE RULES ----
  if (includeSecurity) {
    const rules = fileTexts.get('firestore.rules');
    if (rules) {
      const parsedRules = parseFirestoreRulesFull(rules);
      firestoreParsedPathsCount = parsedRules.totalMatchBlocks;

      // 1A. Recursive wildcard {document=**} open read/write rules
      if (parsedRules.openWildcardNodes.length > 0) {
        pushFinding({
          rule_key: 'firestore_open_write_rules',
          scope,
          domain: 'firebase',
          category: 'confirmed_issue',
          severity: 'critical',
          diagnosis_type: 'confirmed_vulnerability',
          confidence_score: 97,
          confidence_reason_ar: `تم تحليل كامل شجرة firestore.rules (${parsedRules.totalMatchBlocks} مساراً) ورصد ${parsedRules.openWildcardNodes.length} مسارات عامة بنطاق متداخل {document=**} تسمح بالكتابة دون مصادقة (if true).`,
          runtime_layer: 'config_rules',
          reachability: 'config_or_rules',
          needs_runtime_test: false,
          title_ar: 'قواعد Firestore مفتوحة للكتابة دون تحقق هوية في مجموعات الذكاء والموردين',
          description_ar: `كشف المحلل البنيوي لـ firestore.rules وجود ${parsedRules.openWildcardNodes.length} مساراً متداخلاً ({document=**}) تطبّق allow read, write: if true (${parsedRules.openWildcardNodes.map((n) => n.path).slice(0, 6).join('، ')}...).`,
          root_cause_ar: 'استخدام allow read, write: if true مع النطاق المتداخل {document=**} يتيح الكتابة والتعديل والحذف عبر عميل Firestore مباشرة دون التحقق من isAdmin() أو isStaff().',
          recommended_solution_ar: 'تقييد القراءة والكتابة للمجموعات الإدارية بصلاحيات isStaff() / isAdmin() بعد التأكد من اعتماد العمليات الإدارية على مصادقة موثقة أو Firebase Admin على الخادم.',
          evidence: parsedRules.openWildcardNodes.slice(0, 6).map((n) => ({
            file: 'firestore.rules',
            line: n.line,
            snippet: `match ${n.path} -> allow ${n.operations.map((o) => `${o.verb}: if ${o.expression}`).join('; ')}`,
            verified_from_disk: true,
          })),
          affected_files: ['firestore.rules'],
        });
      }

      // 1B. Partial open rules (e.g. ai_employee_drafts/{draftId}: guarded create, unguarded update/delete)
      for (const partial of parsedRules.partialOpenNodes) {
        pushFinding({
          rule_key: `firestore_partial_open_${partial.node.path.replace(/[^a-z0-9]+/gi, '_')}`,
          scope,
          domain: 'firebase',
          category: 'confirmed_issue',
          severity: 'high',
          diagnosis_type: 'confirmed_vulnerability',
          confidence_score: 95,
          confidence_reason_ar: `المسار ${partial.node.path} يفرض شروطاً صارمة على (${partial.guardedVerbs.join(', ')}) بينما يفتح (${partial.openVerbs.join(', ')}) عبر if true دون قيد.`,
          runtime_layer: 'config_rules',
          reachability: 'config_or_rules',
          needs_runtime_test: false,
          title_ar: `تضارب حماية في قاعدة Firestore للمسار ${partial.node.path} (الإنشاء محمي والتعديل/الحذف مفتوح)`,
          description_ar: `أظهر الفحص الكامل لقاعدة ${partial.node.path} أن عمليات (${partial.guardedVerbs.join('، ')}) محمية بشروط حقول/هوية، لكن عمليات (${partial.openVerbs.join('، ')}) مضبوطة على if true مما يسمح بتجاوز حماية القاعدة عبر التعديل أو الحذف المباشر.`,
          root_cause_ar: 'إتاحة allow update, delete: if true لتسهيل إدارة المسودات من الواجهة دون اشتراط isAdmin().',
          recommended_solution_ar: 'حصر update و delete في isAdmin() أو تنفيذها حصراً عبر مسارات Express الموثقة.',
          evidence: [
            {
              file: 'firestore.rules',
              line: partial.node.line,
              snippet: `match ${partial.node.path}: open(${partial.openVerbs.join(',')}) vs guarded(${partial.guardedVerbs.join(',')})`,
              verified_from_disk: true,
            },
          ],
          affected_files: ['firestore.rules'],
        });
      }

      // 1C. Public product write rule with schema validation (Suspicion needing runtime/flow decision)
      if (parsedRules.productPublicWriteNode) {
        const writeOp = parsedRules.productPublicWriteNode.operations.find((o) =>
          o.verb.includes('create') || o.verb.includes('update')
        );
        if (writeOp && !writeOp.requires_auth && writeOp.role_guard && writeOp.field_validation) {
          pushFinding({
            rule_key: 'firestore_public_product_write',
            scope,
            domain: 'security',
            category: 'potential_issue',
            severity: 'high',
            diagnosis_type: 'suspected_needs_test',
            confidence_score: 84,
            confidence_reason_ar: 'القاعدة تتضمن تحققاً من صحة الحقول (title_ar, original_price > 0) مع شرط isStaff() || (...)، لذا هي اشتباه يحتاج التحقق من استمرار الحاجة للإضافة العامة مقابل حصرها في الموظفين.',
            runtime_layer: 'config_rules',
            reachability: 'config_or_rules',
            needs_runtime_test: true,
            runtime_test_hint_ar: 'اختبر عبر محاكي القواعد (Firestore Rules Emulator) محاولة كتابة وثيقة منتج من مستخدم مجهول وتحديد هل ميزة الإضافة العامة ما زالت مطلوبة.',
            title_ar: 'السماح المشروط بإنشاء/تعديل المنتجات في Firestore دون اشتراط موظف/مدير',
            description_ar: 'المسار /products/{productId} يطبق تحققاً على نوع السعر والعنوان، لكنه يسمح بالكتابة خارج صلاحية isStaff() إذا تحققت شروط الحقول.',
            root_cause_ar: 'تسهيل قاعدة create, update لدعم ميزة الإضافة العامة في المتجر.',
            recommended_solution_ar: 'إذا لم تعد الإضافة العامة للزوار مفعّلة، احصر create, update في isStaff() فقط.',
            evidence: [
              {
                file: 'firestore.rules',
                line: parsedRules.productPublicWriteNode.line,
                snippet: `allow ${writeOp.verb}: if ${writeOp.expression.slice(0, 140)}`,
                verified_from_disk: true,
              },
            ],
            affected_files: ['firestore.rules'],
          });
        }
      }

      // 1D. Nested Permissions & Subcollection Path Analysis (/users/{userId} -> cart & favorites)
      if (parsedRules.usersParentNode && parsedRules.nestedSubcollectionNodes.length > 0) {
        const updateOp = parsedRules.usersParentNode.operations.find((o) => o.verb.includes('update'));
        const hasRoleEscalationBlock = Boolean(updateOp?.expression.includes("hasAny(['role'])"));
        const allSubcollectionsRequireOwner = parsedRules.nestedSubcollectionNodes.every((sub) =>
          sub.operations.every((op) => op.requires_auth && Boolean(op.ownership_guard))
        );
        const firebaseTs = fileTexts.get('src/lib/firebase.ts') || '';
        const usesNestedCartOrFav = /users\/\$\{userId\}|collection\(db,\s*['"]users['"],\s*userId,\s*['"](?:cart|favorites)['"]/.test(
          firebaseTs
        );

        if (hasRoleEscalationBlock && allSubcollectionsRequireOwner) {
          pushFinding({
            rule_key: 'firestore_nested_subcollections_verified',
            scope,
            domain: 'firebase',
            category: 'verified_fixed',
            severity: 'low',
            diagnosis_type: 'verified_control',
            confidence_score: 94,
            confidence_reason_ar: `تم فحص المسار الأب /users/{userId} والمسارات الفرعية المتداخلة (${parsedRules.nestedSubcollectionNodes.map((n) => n.path).join('، ')}) والتأكد من منع ترقية حقل role وعزل السلة والمفضلة بصلاحية request.auth.uid == userId.`,
            runtime_layer: 'config_rules',
            reachability: usesNestedCartOrFav ? 'reachable_from_client' : 'config_or_rules',
            needs_runtime_test: false,
            title_ar: 'عزل الصلاحيات المتداخلة في /users/{userId} والمجموعات الفرعية (cart/favorites) متحقق منه',
            description_ar: `تمنع قاعدة /users/{userId} تعديل حقل role من المستخدم نفسه، كما تفرض المجموعات الفرعية المتداخلة (${parsedRules.nestedSubcollectionNodes.map((n) => n.path).join('، ')}) ملكية UID كاملة دون تسرب صلاحيات غير مقصود.`,
            root_cause_ar: 'تطبيق عزل المجموعات الفرعية ومنع تصعيد الصلاحيات على مستوى affectedKeys().',
            recommended_solution_ar: 'الإبقاء على هيكل القواعد المتداخلة الحالي لـ users و cart و favorites.',
            evidence: [
              {
                file: 'firestore.rules',
                line: parsedRules.usersParentNode.line,
                snippet: `match /users/{userId} -> children: ${parsedRules.nestedSubcollectionNodes.map((c) => c.path).join(', ')}`,
                verified_from_disk: true,
              },
              ...parsedRules.nestedSubcollectionNodes.map((sub) => ({
                file: 'firestore.rules',
                line: sub.line,
                snippet: `match ${sub.path} -> ${sub.operations.map((o) => o.expression).join('; ')}`,
                verified_from_disk: true,
              })),
            ],
            affected_files: ['firestore.rules'],
          });
        }
      }
    }

    // Check Firebase Config & Firestore databaseId wiring
    const firebaseTs = fileTexts.get('src/lib/firebase.ts');
    const appletCfg = fileTexts.get('firebase-applet-config.json');
    if (firebaseTs && appletCfg) {
      const hasDbIdWiring = /getFirestore\(\s*app\s*,\s*firebaseConfig\.firestoreDatabaseId|initializeFirestore\([\s\S]*targetDbId/.test(
        firebaseTs
      );
      const hasTimeoutWrapper = /withFirestoreTimeout/.test(firebaseTs);
      if (hasDbIdWiring && hasTimeoutWrapper) {
        pushFinding({
          rule_key: 'firebase_db_id_verified',
          scope,
          domain: 'firebase',
          category: 'verified_fixed',
          severity: 'low',
          diagnosis_type: 'verified_control',
          confidence_score: 96,
          confidence_reason_ar: 'التحليل البنيوي لـ src/lib/firebase.ts أثبت تمرير targetDbId/firestoreDatabaseId من firebase-applet-config.json واستخدام غلاف المهلة withFirestoreTimeout.',
          needs_runtime_test: false,
          title_ar: 'ربط معرف قاعدة Firestore وحماية مهلة الاتصال متحقق منها',
          description_ar: 'ملف src/lib/firebase.ts يمرر معرف القاعدة المحدد في firebase-applet-config.json صراحةً ويستخدم غلاف المهلة والتعامل المهيكل مع أخطاء الاتصال.',
          root_cause_ar: 'تم تطبيق التهيئة الصحيحة للاتصال بقاعدة Firestore الخاصة بالتطبيق.',
          recommended_solution_ar: 'الاستمرار على نفس التهيئة وعدم تعديل firebaseConfig.firestoreDatabaseId.',
          evidence: findLineMatches(firebaseTs, /getFirestore\(|initializeFirestore\(/, 2).map((m) => ({
            file: 'src/lib/firebase.ts',
            line: m.line,
            snippet: m.snippet,
            verified_from_disk: true,
          })),
          affected_files: ['src/lib/firebase.ts', 'firebase-applet-config.json'],
        });
      }
    }

    // Check Server RBAC & Admin Secret guards
    const authTs = fileTexts.get('src/middleware/auth.ts');
    if (authTs) {
      const hasTimingSafe = /crypto\.timingSafeEqual/.test(authTs);
      const hasEmployeeIsolation = /decoded\.role\s*===\s*'employee'/.test(authTs);
      if (hasTimingSafe && hasEmployeeIsolation) {
        pushFinding({
          rule_key: 'rbac_hmac_isolation_verified',
          scope,
          domain: 'auth_rbac',
          category: 'verified_fixed',
          severity: 'low',
          diagnosis_type: 'verified_control',
          confidence_score: 97,
          confidence_reason_ar: 'الملف مصنّف كملف خادم معزول (server) ويستخدم crypto.timingSafeEqual مع عزل صريح لرموز الموظفين عن الإدارة.',
          needs_runtime_test: false,
          title_ar: 'التحقق الآمن من رموز الإدارة وعزل صلاحيات الموظفين مفعّل',
          description_ar: 'نظام المصادقة في src/middleware/auth.ts يستخدم timingSafeEqual للتحقق من HMAC-SHA256 ويرفض تماماً قبول رموز الموظفين (EMP001..EMP008) في مسارات الإدارة.',
          root_cause_ar: 'عزل verifyEmployeeToken عن verifyAdminToken عبر فحص decoded.role.',
          recommended_solution_ar: 'الإبقاء على فحص requireAdmin الصارم لجميع المسارات الحساسة.',
          evidence: findLineMatches(authTs, /verifyAdminToken|timingSafeEqual/, 2).map((m) => ({
            file: 'src/middleware/auth.ts',
            line: m.line,
            snippet: m.snippet,
            verified_from_disk: true,
          })),
          affected_files: ['src/middleware/auth.ts'],
        });
      }
    }

    // 1E. Context-Aware Import-Graph Secret & Env Verification (NEVER falsely flag server or scanner files!)
    const secretTrace = traceSecretEnvUsageInBrowserPaths(fileTexts, graph);
    if (secretTrace.suppressedScannerFiles.length > 0) {
      suppressedFalsePositivesCount += secretTrace.suppressedScannerFiles.length;
      suppressedNotesAr.push(
        `استُثنيت ملفات محرك الفحص وقواعد الاكتشاف (${secretTrace.suppressedScannerFiles.length}) من اعتبار نصوص القواعد داخلها ثغرات فعلية.`
      );
    }
    if (secretTrace.suppressedServerEnvFiles.length > 0) {
      suppressedFalsePositivesCount += secretTrace.suppressedServerEnvFiles.length;
      suppressedNotesAr.push(
        `استُبعد (${secretTrace.suppressedServerEnvFiles.length}) ملف خادم يستخدم process.env.* بشكل آمن لعدم وجود مسار استيراد يصل إلى المتصفح (${secretTrace.suppressedServerEnvFiles.slice(0, 4).join('، ')}...).`
      );
    }
    if (secretTrace.suppressedServerGuardedSharedFiles.length > 0) {
      suppressedFalsePositivesCount += secretTrace.suppressedServerGuardedSharedFiles.length;
      suppressedNotesAr.push(
        `استُبعدت ملفات (${secretTrace.suppressedServerGuardedSharedFiles.join('، ')}) لأن قراءة المتغير محمية بحارس تشغيل خادمي (typeof window === 'undefined') ولا تصل إلى المتصفح.`
      );
    }
    if (secretTrace.sharedNonSecretEnvFiles.length > 0) {
      suppressedFalsePositivesCount += secretTrace.sharedNonSecretEnvFiles.length;
      suppressedNotesAr.push(
        `استُبعدت فحوصات NODE_ENV/VITEST غير السرية في (${secretTrace.sharedNonSecretEnvFiles.join('، ')}) لأنها ثوابت بيئة بناء وليست مفاتيح أسرار.`
      );
    }

    for (const leak of secretTrace.confirmedClientLeaks) {
      pushFinding({
        rule_key: `client_secret_ref_${leak.file}_${leak.varName}`,
        scope,
        domain: 'security',
        category: 'confirmed_issue',
        severity: 'critical',
        diagnosis_type: 'confirmed_vulnerability',
        confidence_score: 96,
        confidence_reason_ar: `تم تتبع مسار الاستيراد الفعلي من نقطة دخول المتصفح (${leak.clientChain.join(' -> ')}) وإثبات وصول كود المتصفح إلى قراءة المتغير السري ${leak.varName} دون حارس خادم.`,
        runtime_layer: leak.layer,
        reachability: leak.layer === 'shared' ? 'reachable_from_both' : 'reachable_from_client',
        import_chain: leak.clientChain,
        needs_runtime_test: false,
        title_ar: `تسرب مؤكد لمتغير خادم سري (${leak.varName}) في مسار يصل إلى المتصفح (${leak.file})`,
        description_ar: `تتبع مسار الاستيراد (${leak.clientChain.join(' ← ')}) وصول هذا الملف إلى حزمة المتصفح مع احتوائه على process.env.${leak.varName}.`,
        root_cause_ar: 'استيراد وحدة تحتوي على مفاتيح خادم سرية من شجرة المتصفح (client/shared).',
        recommended_solution_ar: 'نقل استدعاء المتغير السري إلى مسار خادم معزول (src/server/routes/*) وفصله عن ملفات العميل.',
        evidence: [
          {
            file: leak.file,
            line: leak.line,
            snippet: leak.snippet,
            verified_from_disk: true,
          },
        ],
        affected_files: [leak.file],
      });
    }

    // 1F. Context-Aware dangerouslySetInnerHTML analysis (sanitizer + untrusted input + client reachability)
    const xssMatches = analyzeDangerouslySetInnerHtml(fileTexts, graph);
    for (const xm of xssMatches) {
      const isRisky = xm.isReachableFromClient && !xm.hasSanitizer && xm.hasUntrustedInput;
      pushFinding({
        rule_key: `xss_dangerous_html_${xm.file}`,
        scope,
        domain: isRisky ? 'security' : 'ui_ux',
        category: isRisky ? 'potential_issue' : xm.hasSanitizer ? 'verified_fixed' : 'improvement',
        severity: isRisky ? 'high' : 'low',
        diagnosis_type: xm.hasSanitizer
          ? 'verified_control'
          : isRisky
          ? 'suspected_needs_test'
          : 'design_or_perf_improvement',
        confidence_score: isRisky ? 82 : xm.hasSanitizer ? 91 : 60,
        confidence_reason_ar: xm.hasSanitizer
          ? 'فحص النطاق أكد وجود دالة تعقيم/تسلسل آمن (DOMPurify/sanitize/JSON.stringify) قبل dangerouslySetInnerHTML.'
          : isRisky
          ? 'المكون قابل للوصول من المتصفح ويمرر تعبيراً ديناميكياً إلى __html دون تعقيم ظاهر، لذا يُصنف اشتباهاً يتطلب اختبار مصدر المدخلات.'
          : 'التعبير الممرر ثابت أو غير متصل بنقطة دخول المتصفح، لذا لا يمثل ثغرة XSS فعلية.',
        runtime_layer: graph.profiles.get(xm.file)?.layer || 'client',
        reachability: xm.isReachableFromClient ? 'reachable_from_client' : 'unreachable_or_dead',
        import_chain: xm.clientChain || undefined,
        needs_runtime_test: isRisky,
        runtime_test_hint_ar: isRisky
          ? 'اختبر حقن حمولة HTML اختبارية في مصدر البيانات للتأكد من التعقيم الفعلي.'
          : undefined,
        title_ar: `تحليل dangerouslySetInnerHTML في ${xm.file}${xm.hasSanitizer ? ' (تعقيم متحقق منه)' : ''}`,
        description_ar: `رُصد استخدام dangerouslySetInnerHTML في ${xm.file}؛ تم فحص التعقيم وإمكانية وصول محتوى غير موثوق قبل التقييم.`,
        root_cause_ar: 'حقن HTML داخل DOM عبر React.',
        recommended_solution_ar: xm.hasSanitizer
          ? 'الإبقاء على التعقيم الحالي والتأكد من تغطية كل المدخلات.'
          : 'التحقق من تعقيم المدخلات عبر DOMPurify أو استبدالها بعرض نصي آمن.',
        evidence: [
          {
            file: xm.file,
            line: xm.line,
            snippet: xm.snippet,
            verified_from_disk: true,
          },
        ],
        affected_files: [xm.file],
      });
    }

    // 1G. Verified Library & AI Model Compatibility Check (Req #7)
    const compatAudit = verifyInstalledPackageAndAiModelCompatibility(rootDir, fileTexts);
    if (compatAudit.notesAr.length > 0) {
      suppressedFalsePositivesCount += compatAudit.notesAr.length;
      suppressedNotesAr.push(...compatAudit.notesAr);
    }
    if (compatAudit.shouldFlagLegacyServerModels && compatAudit.legacyServerRoutesLines.length > 0) {
      pushFinding({
        rule_key: 'server_nonstandard_gemini_models',
        scope,
        domain: 'errors',
        category: 'potential_issue',
        severity: 'medium',
        diagnosis_type: 'suspected_needs_test',
        confidence_score: 83,
        confidence_reason_ar: `تم التحقق أولاً من نسخة @google/genai المثبتة فعلياً (${compatAudit.genaiInstalledVersion}) وتوافقها، ومن النماذج المعتمدة في المسارات النشطة (${compatAudit.activeConfiguredModels.join('، ')}) قبل اقتراح مواءمة أسماء النماذج الاحتياطية في server.ts.`,
        runtime_layer: 'server',
        reachability: 'reachable_from_server',
        import_chain: ['server.ts'],
        needs_runtime_test: true,
        runtime_test_hint_ar: 'اختبر استدعاء المسار الاحتياطي في server.ts أمام Gemini API قبل أي تعديل.',
        title_ar: 'ملاحظة توافق نماذج Gemini الاحتياطية في server.ts (بعد التحقق من SDK)',
        description_ar: `بعد التحقق من @google/genai (${compatAudit.genaiInstalledVersion}) وتوافر (${compatAudit.activeConfiguredModels.join('، ')}) في المسارات الحديثة، تبيّن أن بعض مسارات server.ts ما زالت تدرج أسماء احتياطية مثل gemini-flash-latest أو gemini-3.8-flash.`,
        root_cause_ar: 'بقايا أسماء نماذج سابقة قبل توحيد قائمة النماذج الفعّالة في المسارات الجديدة.',
        recommended_solution_ar: 'مواءمة قائمة النماذج الاحتياطية في server.ts مع النماذج المتحققة في المشروع عند الاختبار، دون المساس بالمستشار البرمجي الأول.',
        evidence: compatAudit.legacyServerRoutesLines.slice(0, 4).map((m) => ({
          file: 'server.ts',
          line: m.line,
          snippet: m.snippet,
          verified_from_disk: true,
        })),
        affected_files: ['server.ts'],
      });
    }
  }

  // ---- 2. UI / UX / REACHABILITY-VERIFIED DIALOGS & MOBILE / COMMERCE CHECKS ----
  if (includeUi) {
    const dialogs = analyzeUiDialogsWithReachability(fileTexts, graph);

    if (dialogs.unreachableDialogs.length > 0) {
      suppressedFalsePositivesCount += dialogs.unreachableDialogs.length;
      suppressedNotesAr.push(
        `تم خفض تصنيف (${dialogs.unreachableDialogs.length}) استدعاء لنوافذ المتصفح داخل مكونات غير متصلة بشجرة الواجهة الفعّالة (${Array.from(new Set(dialogs.unreachableDialogs.map((d) => d.file))).join('، ')}).`
      );
    }

    if (dialogs.unguardedBlockingDialogs.length > 0) {
      const groupedFiles = Array.from(new Set(dialogs.unguardedBlockingDialogs.map((d) => d.file)));
      const firstChain = dialogs.unguardedBlockingDialogs.find((d) => d.clientChain)?.clientChain || undefined;
      pushFinding({
        rule_key: 'iframe_window_dialogs',
        scope,
        domain: 'ui_ux',
        category: 'improvement',
        severity: 'medium',
        diagnosis_type: 'design_or_perf_improvement',
        confidence_score: 92,
        confidence_reason_ar: `تم التحقق عبر شجرة الاستيراد من وجود window.confirm/alert في ${groupedFiles.length} مكونات متصلة بالواجهة؛ هذا السلوك ليس ثغرة أمنية وإنما ملاحظة توافق وتجربة مستخدم داخل إطار المعاينة iFrame.`,
        runtime_layer: 'client',
        reachability: 'reachable_from_client',
        import_chain: firstChain,
        needs_runtime_test: false,
        title_ar: `ملاحظة توافق وتجربة مستخدم: استخدام window.confirm/alert في ${groupedFiles.length} مكونات (يتأثر داخل iFrame)`,
        description_ar: `رُصدت استدعاءات لـ window.confirm / window.alert داخل مكونات متصلة (${groupedFiles.join('، ')}). هذه ليست ثغرة أمنية، ولكنها ملاحظة تجربة مستخدم وتوافق لأن iFrame قد يحجب النوافذ الأصلية للمتصفح.`,
        root_cause_ar: 'استخدام نوافذ تأكيد المتصفح الافتراضية بدلاً من حالة تأكيد مدمجة داخل React UI.',
        recommended_solution_ar: 'تحسين اختياري: استبدال window.confirm/alert بمكون تأكيد مدمج (Inline Confirm / Toast) لتحسين التوافق داخل iFrame والهواتف.',
        evidence: dialogs.unguardedBlockingDialogs.slice(0, 6).map((d) => ({
          file: d.file,
          line: d.line,
          snippet: d.snippet,
          verified_from_disk: true,
        })),
        affected_files: groupedFiles,
      });
    }

    if (dialogs.tryCatchGuardedOpens.length > 0) {
      const guardedFiles = Array.from(new Set(dialogs.tryCatchGuardedOpens.map((d) => d.file)));
      pushFinding({
        rule_key: 'iframe_guarded_window_open_review',
        scope,
        domain: 'ui_ux',
        category: 'potential_issue',
        severity: 'medium',
        diagnosis_type: 'suspected_needs_test',
        confidence_score: 74,
        confidence_reason_ar: 'الاستدعاءات في هذه الملفات محمية بكتلة try/catch لتفادي توقف الصفحة، لذا لا تُعد عطلاً مؤكداً بل اشتباهاً يحتاج تجربة رابط احتياطي ظاهر في iFrame.',
        runtime_layer: 'client',
        reachability: 'reachable_from_client',
        import_chain: dialogs.tryCatchGuardedOpens[0]?.clientChain || undefined,
        needs_runtime_test: true,
        runtime_test_hint_ar: 'اختبر النقر على زر واتساب/الاتصال داخل إطار iFrame للتأكد من إظهار رابط مباشر عند حجب window.open.',
        title_ar: `مراجعة بديل window.open المحمي بـ try/catch داخل ${guardedFiles.length} مكونات في iFrame`,
        description_ar: `المكونات (${guardedFiles.join('، ')}) تغلف window.open داخل try/catch بشكل سليم، لكن المتصفح داخل iFrame قد يحجب التبويب الجديد صمتاً دون إظهار رابط بديل للمستخدم.`,
        root_cause_ar: 'حجب window.open الصامت في بعض إطارات sandbox/iFrame بدون رمي استثناء دائماً.',
        recommended_solution_ar: 'توفير عنصر <a href="..." target="_blank" rel="noopener noreferrer"> أو نسخ الرابط عند فتح واتساب بدلاً من الاعتماد على window.open فقط.',
        evidence: dialogs.tryCatchGuardedOpens.slice(0, 5).map((d) => ({
          file: d.file,
          line: d.line,
          snippet: d.snippet,
          verified_from_disk: true,
        })),
        affected_files: guardedFiles,
      });
    }

    // Check <img> resilience ONLY across reachable client components
    const imgNoFallbackFiles: Array<{ file: string; chain: string[] | null; evidence: EngineeringEvidenceRef[] }> = [];
    for (const [rel, text] of fileTexts.entries()) {
      if (!rel.startsWith('src/components/') || !rel.endsWith('.tsx')) continue;
      const prof = graph.profiles.get(rel);
      if (!prof?.clientChain) continue; // Reachability verified!

      const clean = text;
      if (/<img\s/i.test(clean) && !/onError\s*=/.test(clean)) {
        const imgLines = findLineMatches(clean, /<img\b/i, 2);
        if (imgLines.length > 0) {
          imgNoFallbackFiles.push({
            file: rel,
            chain: prof.clientChain,
            evidence: imgLines.map((m) => ({
              file: rel,
              line: m.line,
              snippet: m.snippet,
              verified_from_disk: true,
            })),
          });
        }
      }
    }

    if (imgNoFallbackFiles.length > 0) {
      pushFinding({
        rule_key: 'img_missing_onerror_fallback',
        scope,
        domain: 'ui_ux',
        category: 'improvement',
        severity: 'medium',
        diagnosis_type: 'design_or_perf_improvement',
        confidence_score: 86,
        confidence_reason_ar: `فُحصت ${imgNoFallbackFiles.length} مكونات متصلة فعلياً بالواجهة وتأكد وجود وسم <img> دون معالج خطأ التحميل onError.`,
        runtime_layer: 'client',
        reachability: 'reachable_from_client',
        import_chain: imgNoFallbackFiles[0]?.chain || undefined,
        needs_runtime_test: false,
        title_ar: `صور في ${imgNoFallbackFiles.length} مكونات فعّالة تفتقد معالج خطأ التحميل (onError fallback)`,
        description_ar: 'بعض وسوم <img> داخل مكونات متصلة بشجرة التطبيق لا تحتوي على onError لعرض بديل مرئي عند تعذر تحميل الصورة.',
        root_cause_ar: 'عدم ربط حدث onError بحالة عرض بديلة عند فشل رابط الصورة.',
        recommended_solution_ar: 'إضافة onError و referrerPolicy="no-referrer" وحاوية بديلة أنيقة في المكونات المستهدفة.',
        evidence: imgNoFallbackFiles.flatMap((d) => d.evidence).slice(0, 6),
        affected_files: imgNoFallbackFiles.map((d) => d.file),
      });
    }

    // Check CheckoutPage & CartDrawer for commerce integrity
    const checkoutTsx = fileTexts.get('src/components/CheckoutPage.tsx');
    if (checkoutTsx) {
      const hasStockGuard = /isOutOfStock|stock_quantity|serverCheckout|\/api\/orders/.test(checkoutTsx);
      if (!hasStockGuard) {
        pushFinding({
          rule_key: 'checkout_flow_review',
          scope,
          domain: 'commerce_flow',
          category: 'potential_issue',
          severity: 'medium',
          diagnosis_type: 'suspected_needs_test',
          confidence_score: 76,
          confidence_reason_ar: 'لم يظهر تحقق صريح بالأسماء القياسية داخل CheckoutPage.tsx؛ يتطلب اختباراً حياً لعملية إتمام الطلب أمام الخادم.',
          needs_runtime_test: true,
          runtime_test_hint_ar: 'نفّذ طلب checkout لمنتج بكمية أكبر من المخزون وتأكد من استجابة الخادم.',
          title_ar: 'مراجعة التحقق من المخزون وتدفق إتمام الطلب في صفحة الدفع',
          description_ar: 'يُنصح بمراجعة التحقق من حالة المخزون والأسعار الخلفية في CheckoutPage.tsx لضمان تطابق الفاتورة مع الخادم.',
          root_cause_ar: 'الحاجة لتأكيد التحقق الثنائي بين السلة والخادم قبل تأكيد الطلب.',
          recommended_solution_ar: 'اعتماد الإجمالي والأسعار من استجابة مسار الخادم /api/orders بشكل كامل.',
          evidence: findLineMatches(checkoutTsx, /handleSubmit|onOrderPlaced|fetch\(/, 2).map((m) => ({
            file: 'src/components/CheckoutPage.tsx',
            line: m.line,
            snippet: m.snippet,
            verified_from_disk: true,
          })),
          affected_files: ['src/components/CheckoutPage.tsx'],
        });
      }
    }

    // Check index.html & metadata.json sync + RTL
    const indexHtml = fileTexts.get('index.html');
    const metadataJson = fileTexts.get('metadata.json');
    if (indexHtml && !/dir="rtl"/.test(indexHtml)) {
      pushFinding({
        rule_key: 'html_rtl_attribute_missing',
        scope,
        domain: 'mobile',
        category: 'confirmed_issue',
        severity: 'high',
        diagnosis_type: 'confirmed_bug',
        confidence_score: 98,
        confidence_reason_ar: 'فحص ملف index.html الجذري أكد غياب سمة dir="rtl" على عنصر <html>.',
        runtime_layer: 'config_rules',
        reachability: 'reachable_from_client',
        needs_runtime_test: false,
        title_ar: 'غياب سمة dir="rtl" عن العنصر الجذري في index.html',
        description_ar: 'العنصر <html> لا يحدد اتجاه اللغة العربية RTL افتراضياً مما قد يسبب ارتداداً بصرياً أثناء التحميل.',
        root_cause_ar: 'عدم تعيين dir="rtl" lang="ar" في index.html.',
        recommended_solution_ar: 'إضافة dir="rtl" lang="ar" إلى وسم <html> في index.html.',
        evidence: [{ file: 'index.html', line: 1, snippet: indexHtml.split('\n')[0] || '', verified_from_disk: true }],
        affected_files: ['index.html'],
      });
    }

    if (indexHtml && metadataJson) {
      try {
        const meta = JSON.parse(metadataJson);
        const hasTitle = /<title>([^<]+)<\/title>/.exec(indexHtml)?.[1] || '';
        if (meta?.name && !hasTitle.includes(meta.name) && !hasTitle.includes('أمازون دعاء')) {
          pushFinding({
            rule_key: 'metadata_title_sync',
            scope,
            domain: 'ui_ux',
            category: 'improvement',
            severity: 'low',
            diagnosis_type: 'design_or_perf_improvement',
            confidence_score: 85,
            confidence_reason_ar: 'مقارنة <title> في index.html مع حقل name في metadata.json على القرص.',
            needs_runtime_test: false,
            title_ar: 'توحيد عنوان المتجر في index.html مع metadata.json',
            description_ar: `عنوان <title> الحالي (${hasTitle}) لا يتطابق نصياً مع اسم التطبيق في metadata.json (${meta.name}).`,
            root_cause_ar: 'اختلاف النص التسويقي في index.html عن metadata.json.',
            recommended_solution_ar: 'مراجعة العنوان ووصف OpenGraph ليكونا متسقين مع هوية Amazon Duaa.',
            evidence: [
              { file: 'index.html', line: 6, snippet: `<title>${hasTitle}</title>`, verified_from_disk: true },
              { file: 'metadata.json', line: 2, snippet: `"name": "${meta.name}"`, verified_from_disk: true },
            ],
            affected_files: ['index.html', 'metadata.json'],
          });
        }
      } catch {
        // Ignore parse error
      }
    }

    const navbarTsx = fileTexts.get('src/components/Navbar.tsx');
    if (navbarTsx && !/focus-visible/.test(navbarTsx)) {
      pushFinding({
        rule_key: 'navbar_focus_visible_accessibility',
        scope,
        domain: 'mobile',
        category: 'improvement',
        severity: 'low',
        diagnosis_type: 'design_or_perf_improvement',
        confidence_score: 89,
        confidence_reason_ar: 'شريط التنقل Navbar.tsx متصل بنقطة الدخول الرئيسية ويفتقر إلى فئات focus-visible للوصول بلوحة المفاتيح.',
        needs_runtime_test: false,
        title_ar: 'تحسين مؤشرات التركيز البصري (focus-visible) وسهولة الوصول في شريط التنقل',
        description_ar: 'أزرار التنقل في src/components/Navbar.tsx لا تعتمد أنماط focus-visible واضحة لسهولة الوصول عبر لوحة المفاتيح والقارئات.',
        root_cause_ar: 'الاعتماد على focus العادي أو hover فقط.',
        recommended_solution_ar: 'إضافة فئات focus-visible:ring-2 focus-visible:ring-rose-500 على روابط وأزرار التنقل الأساسية.',
        evidence: findLineMatches(navbarTsx, /<nav|<header|<button/, 2).map((m) => ({
          file: 'src/components/Navbar.tsx',
          line: m.line,
          snippet: m.snippet,
          verified_from_disk: true,
        })),
        affected_files: ['src/components/Navbar.tsx'],
      });
    }
  }

  // ---- 3. PERFORMANCE, BUNDLE & LISTENER HYGIENE CHECKS ----
  if (includePerf) {
    const appTsx = fileTexts.get('src/App.tsx');
    if (appTsx) {
      if (/from '\.\/lib\/lazyImports'/.test(appTsx)) {
        pushFinding({
          rule_key: 'lazy_loading_verified',
          scope,
          domain: 'performance',
          category: 'verified_fixed',
          severity: 'low',
          diagnosis_type: 'verified_control',
          confidence_score: 96,
          confidence_reason_ar: 'رُصد استيراد فعلي من ./lib/lazyImports واستخدام React.lazy مع retryImport في نقطة دخول الواجهة src/App.tsx.',
          needs_runtime_test: false,
          title_ar: 'التحميل الكسول (Code Splitting) للمكونات الثقيلة مفعّل في src/App.tsx',
          description_ar: 'يتم تحميل صفحات الإدارة والتفاصيل والدفع عبر React.lazy مع retryImport من src/lib/lazyImports.ts مما يقلل حجم الحزمة الابتدائية للمتجر.',
          root_cause_ar: 'تطبيق فصل الشيفرة عبر lazyImports.',
          recommended_solution_ar: 'الاستمرار في تسجيل أي صفحة إدارية جديدة داخل src/lib/lazyImports.ts.',
          evidence: findLineMatches(appTsx, /lazyImports/, 2).map((m) => ({
            file: 'src/App.tsx',
            line: m.line,
            snippet: m.snippet,
            verified_from_disk: true,
          })),
          affected_files: ['src/App.tsx', 'src/lib/lazyImports.ts'],
        });
      }

      if (/cartUnsubscribeRef\.current/.test(appTsx)) {
        pushFinding({
          rule_key: 'onsnapshot_cleanup_verified',
          scope,
          domain: 'data_integrity',
          category: 'verified_fixed',
          severity: 'low',
          diagnosis_type: 'verified_control',
          confidence_score: 95,
          confidence_reason_ar: 'تحقق ساكن على App.tsx يثبت تخزين دالة الإلغاء وتنظيف مستمع onSnapshot عند تبديل المستخدم.',
          needs_runtime_test: false,
          title_ar: 'إلغاء اشتراك مستمعات onSnapshot في السلة متحقق منه لتفادي تسرب الذاكرة',
          description_ar: 'يتم تخزين دالة الإلغاء في cartUnsubscribeRef وتنفيذها عند تغيير المستخدم أو الخروج.',
          root_cause_ar: 'مراقبة دورة حياة المستمعات داخل useEffect.',
          recommended_solution_ar: 'الإبقاء على تنظيف المستمعات عند كل إعادة ربط.',
          evidence: findLineMatches(appTsx, /cartUnsubscribeRef/, 2).map((m) => ({
            file: 'src/App.tsx',
            line: m.line,
            snippet: m.snippet,
            verified_from_disk: true,
          })),
          affected_files: ['src/App.tsx'],
        });
      }
    }

    const storeFrontTsx = fileTexts.get('src/components/StoreFront.tsx');
    if (storeFrontTsx) {
      const eagerImgs = findLineMatches(storeFrontTsx, /<img(?![^>]*loading=)/, 3);
      if (eagerImgs.length > 0) {
        pushFinding({
          rule_key: 'storefront_img_lazy_loading',
          scope,
          domain: 'performance',
          category: 'improvement',
          severity: 'medium',
          diagnosis_type: 'design_or_perf_improvement',
          confidence_score: 88,
          confidence_reason_ar: 'المكون StoreFront.tsx متصل بواجهة المتجر الرئيسية وتأكد غياب loading="lazy" عن وسوم <img> المرصودة.',
          needs_runtime_test: false,
          title_ar: 'صور في StoreFront.tsx لا تستخدم loading="lazy" لتحسين سرعة التحميل الأولي',
          description_ar: 'توجد صور ضمن واجهة المتجر لا تحدد loading="lazy" و decoding="async"، ما يؤثر على سرعة LCP واستهلاك البيانات على الجوال.',
          root_cause_ar: 'عدم إضافة خصائص التحميل الكسول للصور غير الحرجة.',
          recommended_solution_ar: 'إضافة loading="lazy" decoding="async" للصور الثانوية في البطاقات والأقسام السفلية.',
          evidence: eagerImgs.map((m) => ({
            file: 'src/components/StoreFront.tsx',
            line: m.line,
            snippet: m.snippet,
            verified_from_disk: true,
          })),
          affected_files: ['src/components/StoreFront.tsx'],
        });
      }
    }

    // Package compatibility verification (Req #7): only flag when verified incompatible or missing on disk
    const perfCompatAudit = verifyInstalledPackageAndAiModelCompatibility(rootDir, fileTexts);
    if (perfCompatAudit.notesAr.length > 0 && !includeSecurity) {
      suppressedFalsePositivesCount += perfCompatAudit.notesAr.length;
      suppressedNotesAr.push(...perfCompatAudit.notesAr);
    }
    if (perfCompatAudit.genaiDeclaredRange && !perfCompatAudit.genaiRangeCompatible) {
      pushFinding({
        rule_key: 'pkg_genai_range_mismatch',
        scope,
        domain: 'errors',
        category: 'potential_issue',
        severity: 'medium',
        diagnosis_type: 'suspected_needs_test',
        confidence_score: 88,
        confidence_reason_ar: `تم فحص node_modules/@google/genai/package.json الفعلي (${perfCompatAudit.genaiInstalledVersion || 'غير مثبت'}) ومقارنته مع package.json (${perfCompatAudit.genaiDeclaredRange}).`,
        needs_runtime_test: true,
        runtime_test_hint_ar: 'تحقق من توافق الإصدار المثبت بعد npm install.',
        title_ar: 'عدم تطابق بين نطاق @google/genai في package.json والإصدار المثبت فعلياً',
        description_ar: `النطاق المعلن "${perfCompatAudit.genaiDeclaredRange}" لا يطابق النسخة المثبتة (${perfCompatAudit.genaiInstalledVersion || 'غير متوفرة'}).`,
        root_cause_ar: 'اختلاف بين package.json و node_modules.',
        recommended_solution_ar: 'مواءمة نطاق package.json مع الإصدار المثبت المتوافق بعد التحقق.',
        evidence: findLineMatches(fileTexts.get('package.json') || '', /@google\/genai/, 1).map((m) => ({
          file: 'package.json',
          line: m.line,
          snippet: m.snippet,
          verified_from_disk: true,
        })),
        affected_files: ['package.json'],
      });
    }
  }

  return {
    discovered: rawDiscovered,
    inspectedFiles,
    skippedSecrets,
    layerBreakdown: graph.layerCounts,
    firestoreParsedPathsCount,
    suppressedFalsePositivesCount,
    suppressedNotesAr,
    profiles: graph.profiles,
  };
}

export function getFileDiagnosticsInfo(
  relPath: string,
  rootDir: string = process.cwd()
): FileRuntimeProfile | null {
  try {
    const norm = normalizeRepoRelPath(relPath);
    const { files } = listInspectableRepoFiles(rootDir);
    const fileTexts = loadRepoText(files, rootDir);
    const graph = buildProjectRuntimeGraph(fileTexts);
    return graph.profiles.get(norm) || null;
  } catch {
    return null;
  }
}

export function runRealCodebaseAudit(
  scope: EngineeringScanScope,
  actor = 'admin',
  rootDir: string = process.cwd()
): {
  scan: EngineeringScanReport;
  findings: EngineeringFinding[];
} {
  const startedAt = new Date().toISOString();
  const scanId = `eng-scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const evalResult = evaluateCodebaseFindings(scope, scanId, rootDir);
  const inaccessibleSources: string[] = [
    ...evalResult.skippedSecrets.map((s) => `${s} (محجوب أمنياً لحماية الأسرار وبيانات البيئة)`),
    'بيئة المتصفح الحية (DOM / Network Runtime) — تُفحص من خلال الكود وشجرة الاستيراد على الخادم وتُوسم الحالات التي تحتاج اختبار تشغيل حي صراحةً',
  ];

  // Merge findings into state WITHOUT deleting previous scans or resolved history
  const now = new Date().toISOString();
  const state = loadState();
  const existingByRule = new Map(state.findings.map((f) => [f.rule_key, f]));
  const finalFindingsForScan: EngineeringFinding[] = [];

  for (const item of evalResult.discovered) {
    const prev = existingByRule.get(item.rule_key);
    if (prev && (prev.status === 'applied' || prev.status === 'approved' || prev.status === 'proposal_ready')) {
      const preserved: EngineeringFinding = {
        ...item,
        id: prev.id,
        category: prev.status === 'applied' ? 'verified_fixed' : item.category,
        status: prev.status,
        proposal_id: prev.proposal_id,
        last_reverification: prev.last_reverification ?? null,
        created_at: prev.created_at,
        updated_at: now,
      };
      existingByRule.set(item.rule_key, preserved);
      finalFindingsForScan.push(preserved);
    } else {
      const merged: EngineeringFinding = prev?.last_reverification
        ? { ...item, last_reverification: prev.last_reverification }
        : item;
      existingByRule.set(item.rule_key, merged);
      finalFindingsForScan.push(merged);
    }
  }

  state.findings = deduplicateFindings(Array.from(existingByRule.values()));

  const counts = {
    confirmed_issue: finalFindingsForScan.filter((f) => f.category === 'confirmed_issue').length,
    potential_issue: finalFindingsForScan.filter((f) => f.category === 'potential_issue').length,
    improvement: finalFindingsForScan.filter((f) => f.category === 'improvement').length,
    verified_fixed: finalFindingsForScan.filter((f) => f.category === 'verified_fixed').length,
  };

  const completedAt = new Date().toISOString();
  const scopeLabels: Record<EngineeringScanScope, string> = {
    comprehensive: 'الفحص الهندسي الشامل',
    security: 'الفحص الأمني وفحص الصلاحيات',
    ui_design: 'فحص الواجهات والتصميم وتجربة الجوال',
    performance: 'فحص الأداء والسرعة وسلامة الموارد',
  };

  const scan: EngineeringScanReport = {
    id: scanId,
    scope,
    started_at: startedAt,
    completed_at: completedAt,
    files_inspected_count: evalResult.inspectedFiles.length,
    inspected_files: evalResult.inspectedFiles,
    inaccessible_sources: inaccessibleSources,
    layer_breakdown: evalResult.layerBreakdown,
    firestore_rules_parsed_paths: evalResult.firestoreParsedPathsCount,
    suppressed_false_positives_count: evalResult.suppressedFalsePositivesCount,
    suppressed_notes_ar: evalResult.suppressedNotesAr,
    summary_ar: `تم تنفيذ ${scopeLabels[scope]} عبر قراءة (${evalResult.inspectedFiles.length}) ملفاً (خادم: ${evalResult.layerBreakdown.server}، متصفح: ${evalResult.layerBreakdown.client}، مشترك: ${evalResult.layerBreakdown.shared}): ${counts.confirmed_issue} مشكلة مؤكدة، ${counts.potential_issue} اشتباه/محتمل، ${counts.improvement} تحسين، و${counts.verified_fixed} عنصر سليم (واستبعاد ${evalResult.suppressedFalsePositivesCount} إنذاراً كاذباً).`,
    counts,
    finding_ids: finalFindingsForScan.map((f) => f.id),
  };

  // Preserve all previous scan reports (prepend newest)
  state.scans.unshift(scan);
  state.scans = state.scans.slice(0, 50);
  saveState();

  appendAuditLog({
    action: 'scan_executed',
    actor,
    target_id: scan.id,
    summary_ar: scan.summary_ar,
    affected_files: [],
    success: true,
    details: `scope=${scope}, inspected=${evalResult.inspectedFiles.length}, suppressed=${evalResult.suppressedFalsePositivesCount}`,
  });

  return { scan, findings: finalFindingsForScan };
}

export function reverifySingleFinding(
  findingId: string,
  options?: {
    proposalId?: string | null;
    actor?: string;
    rootDir?: string;
  }
): {
  finding: EngineeringFinding;
  verification: EngineeringReverificationResult;
} {
  const actor = options?.actor || 'admin';
  const rootDir = options?.rootDir || process.cwd();
  const resolvedRoot = path.resolve(rootDir);
  const state = loadState();

  const fIdx = state.findings.findIndex((f) => f.id === findingId);
  if (fIdx === -1) {
    throw new Error('المشكلة المطلوب إعادة فحصها غير موجودة.');
  }
  const finding = state.findings[fIdx];

  const targetProposalId = options?.proposalId ?? finding.proposal_id ?? null;
  const proposal = targetProposalId
    ? state.proposals.find((p) => p.id === targetProposalId) || null
    : null;

  let mode: 'disk_live' | 'proposal_simulation' = 'disk_live';
  const virtualOverrides = new Map<string, string>();

  if (proposal && (proposal.status === 'pending_approval' || proposal.status === 'approved')) {
    mode = 'proposal_simulation';
    for (const diff of proposal.file_diffs) {
      const absPath = path.resolve(resolvedRoot, diff.file_path);
      if (fs.existsSync(absPath)) {
        const currentText = fs.readFileSync(absPath, 'utf8');
        if (currentText.includes(diff.original_excerpt)) {
          virtualOverrides.set(
            diff.file_path,
            currentText.replace(diff.original_excerpt, diff.proposed_excerpt)
          );
        }
      }
    }
  }

  const evalResult = evaluateCodebaseFindings(
    finding.scope,
    `reverify-${Date.now()}`,
    rootDir,
    mode === 'proposal_simulation' ? virtualOverrides : undefined
  );

  const matchedNow = evalResult.discovered.find((d) => d.rule_key === finding.rule_key);
  const disappeared = !matchedNow || matchedNow.category === 'verified_fixed';
  const now = new Date().toISOString();

  const verification: EngineeringReverificationResult = {
    checked_at: now,
    mode,
    proposal_id: proposal?.id || null,
    disappeared,
    summary_ar: disappeared
      ? mode === 'proposal_simulation'
        ? `تمت محاكاة تطبيق العرض (${proposal?.title_ar}) وتأكد اختفاء المشكلة عند إعادة الفحص.`
        : 'أُعيد فحص الملفات الفعلية على القرص وتأكد اختفاء المشكلة بالكامل.'
      : mode === 'proposal_simulation'
      ? `تمت محاكاة العرض (${proposal?.title_ar}) وما زالت المشكلة قائمة في الكود المحاكى وتحتاج تعديلاً إضافياً.`
      : 'أُعيد فحص الملفات الفعلية على القرص وما زالت المشكلة مرصودة حتى الآن.',
    details: matchedNow
      ? `rule=${matchedNow.rule_key}, category=${matchedNow.category}, confidence=${matchedNow.confidence_score ?? 0}%`
      : `rule=${finding.rule_key} not triggered after recheck`,
  };

  const updatedFinding: EngineeringFinding = {
    ...finding,
    last_reverification: verification,
    ...(mode === 'disk_live' && disappeared
      ? {
          category: 'verified_fixed' as EngineeringFindingCategory,
          diagnosis_type: 'verified_control',
          status: 'applied' as const,
        }
      : mode === 'disk_live' && !disappeared && matchedNow
      ? {
          category: matchedNow.category,
          diagnosis_type: matchedNow.diagnosis_type,
          confidence_score: matchedNow.confidence_score,
          confidence_reason_ar: matchedNow.confidence_reason_ar,
          evidence: matchedNow.evidence,
          status: finding.status === 'applied' ? ('open' as const) : finding.status,
        }
      : {}),
    updated_at: now,
  };

  state.findings[fIdx] = updatedFinding;
  state.findings = deduplicateFindings(state.findings);
  saveState();

  appendAuditLog({
    action: 'verification_run',
    actor,
    target_id: updatedFinding.id,
    summary_ar: `${verification.summary_ar} (${updatedFinding.title_ar})`,
    affected_files: updatedFinding.affected_files,
    success: disappeared,
    details: verification.details,
  });

  return { finding: updatedFinding, verification };
}

// =========================================================================
// Proposal Creation, Approval, Guarded Execution, Verification & Rollback
// =========================================================================

export function createPatchProposal(
  input: {
    finding_id?: string | null;
    title_ar: string;
    rationale_ar: string;
    edits: Array<{
      file_path: string;
      original_excerpt: string;
      proposed_excerpt: string;
    }>;
    verification_command?: 'typecheck' | 'tests' | 'typecheck_and_tests';
  },
  actor = 'admin',
  rootDir: string = process.cwd()
): EngineeringPatchProposal {
  if (!input.title_ar?.trim()) {
    throw new Error('عنوان عرض الإصلاح الهندسي مطلوب.');
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error('يجب أن يحتوي عرض الإصلاح على تعديل واحد على الأقل لملف فعلي.');
  }

  const resolvedRoot = path.resolve(rootDir);
  const fileDiffs: EngineeringFileDiff[] = [];
  const affectedFiles: string[] = [];

  for (const edit of input.edits) {
    const normPath = normalizeRepoRelPath(edit.file_path);
    const guard = isFileProtectedFromWrite(normPath);
    if (guard.protected) {
      throw new Error(guard.reason || `الملف ${normPath} محمي ولا يجوز تعديله.`);
    }

    const absPath = path.resolve(resolvedRoot, normPath);
    if (!absPath.startsWith(resolvedRoot + path.sep) || !fs.existsSync(absPath)) {
      throw new Error(`الملف المستهدف غير موجود في المشروع: ${normPath}`);
    }

    const originalText = fs.readFileSync(absPath, 'utf8');
    if (!edit.original_excerpt || !originalText.includes(edit.original_excerpt)) {
      throw new Error(
        `تعذر مطابقة النص الأصلي حرفياً داخل الملف (${normPath}). يرجى قراءة الملف الفعلي أولاً والتحقق من المقتطف المطابق.`
      );
    }

    affectedFiles.push(normPath);
    fileDiffs.push({
      file_path: normPath,
      original_excerpt: edit.original_excerpt,
      proposed_excerpt: edit.proposed_excerpt,
      diff_preview: buildUnifiedDiffPreview(normPath, edit.original_excerpt, edit.proposed_excerpt),
      verified_match: true,
    });
  }

  const now = new Date().toISOString();
  const proposal: EngineeringPatchProposal = {
    id: `eng-prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    finding_id: input.finding_id || null,
    title_ar: input.title_ar.trim(),
    rationale_ar: (input.rationale_ar || '').trim() || 'تحسين وإصلاح هندسي مُراجع قبل التنفيذ.',
    affected_files: Array.from(new Set(affectedFiles)),
    file_diffs: fileDiffs,
    verification_command: input.verification_command || 'typecheck',
    status: 'pending_approval',
    approved_by: null,
    approved_at: null,
    applied_by: null,
    applied_at: null,
    execution_report: null,
    created_at: now,
    updated_at: now,
  };

  const state = loadState();
  state.proposals.unshift(proposal);

  if (proposal.finding_id) {
    state.findings = state.findings.map((f) =>
      f.id === proposal.finding_id
        ? { ...f, status: 'proposal_ready', proposal_id: proposal.id, updated_at: now }
        : f
    );
  }

  saveState();

  appendAuditLog({
    action: 'proposal_created',
    actor,
    target_id: proposal.id,
    summary_ar: `تم إعداد عرض إصلاح هندسي (${proposal.title_ar}) بانتظار موافقة المدير.`,
    affected_files: proposal.affected_files,
    success: true,
  });

  return proposal;
}

export function approvePatchProposal(
  proposalId: string,
  approve: boolean,
  actor = 'admin'
): EngineeringPatchProposal {
  if (approve !== true) {
    throw new Error('ممنوع اعتماد الإصلاح بدون موافقة إدارية صريحة (approve: true).');
  }
  const state = loadState();
  const idx = state.proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error('عرض الإصلاح المطلوب غير موجود.');
  }
  const current = state.proposals[idx];
  if (current.status === 'applied') {
    throw new Error('تم تنفيذ هذا الإصلاح مسبقاً.');
  }

  const now = new Date().toISOString();
  const updated: EngineeringPatchProposal = {
    ...current,
    status: 'approved',
    approved_by: actor,
    approved_at: now,
    updated_at: now,
  };
  state.proposals[idx] = updated;

  if (updated.finding_id) {
    state.findings = state.findings.map((f) =>
      f.id === updated.finding_id ? { ...f, status: 'approved', updated_at: now } : f
    );
  }

  saveState();

  appendAuditLog({
    action: 'proposal_approved',
    actor,
    target_id: updated.id,
    summary_ar: `وافق المدير (${actor}) على تنفيذ الإصلاح: ${updated.title_ar}`,
    affected_files: updated.affected_files,
    success: true,
  });

  return updated;
}

export function rejectPatchProposal(proposalId: string, actor = 'admin'): EngineeringPatchProposal {
  const state = loadState();
  const idx = state.proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error('عرض الإصلاح المطلوب غير موجود.');
  }
  const current = state.proposals[idx];
  if (current.status === 'applied') {
    throw new Error('لا يمكن رفض تعديل تم تطبيقه بالفعل؛ استخدم التراجع (Rollback) بدلاً من ذلك.');
  }
  const now = new Date().toISOString();
  const updated: EngineeringPatchProposal = {
    ...current,
    status: 'rejected',
    updated_at: now,
  };
  state.proposals[idx] = updated;
  if (updated.finding_id) {
    state.findings = state.findings.map((f) =>
      f.id === updated.finding_id ? { ...f, status: 'dismissed', updated_at: now } : f
    );
  }
  saveState();

  appendAuditLog({
    action: 'proposal_rejected',
    actor,
    target_id: updated.id,
    summary_ar: `تم رفض عرض الإصلاح (${updated.title_ar}) دون أي تعديل على الملفات.`,
    affected_files: updated.affected_files,
    success: true,
  });

  return updated;
}

async function runVerificationCommands(
  mode: 'typecheck' | 'tests' | 'typecheck_and_tests',
  rootDir: string
): Promise<{ typecheckPassed: boolean; testsPassed: boolean | null; output: string }> {
  const logs: string[] = [];
  let typecheckPassed = true;
  let testsPassed: boolean | null = null;

  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: rootDir,
      timeout: 45000,
    });
    logs.push(`[tsc --noEmit] PASS\n${stdout || ''}${stderr || ''}`.trim());
  } catch (err: any) {
    typecheckPassed = false;
    logs.push(`[tsc --noEmit] FAIL\n${err?.stdout || ''}\n${err?.stderr || err?.message || ''}`.trim());
  }

  if (typecheckPassed && (mode === 'tests' || mode === 'typecheck_and_tests')) {
    try {
      const { stdout, stderr } = await execFileAsync(
        'npx',
        ['vitest', 'run', 'e2e/api-health.test.ts'],
        {
          cwd: rootDir,
          timeout: 60000,
          env: { ...process.env, NODE_ENV: 'test' },
        }
      );
      testsPassed = true;
      logs.push(`[vitest api-health] PASS\n${(stdout || '').slice(-1000)}${stderr ? `\n${stderr.slice(-400)}` : ''}`.trim());
    } catch (err: any) {
      testsPassed = false;
      logs.push(`[vitest api-health] FAIL\n${err?.stdout || ''}\n${err?.stderr || err?.message || ''}`.trim());
    }
  }

  return {
    typecheckPassed,
    testsPassed,
    output: logs.join('\n\n').slice(0, 4000),
  };
}

export async function applyApprovedPatchProposal(
  proposalId: string,
  actor = 'admin',
  options?: { skipVerification?: boolean; rootDir?: string }
): Promise<EngineeringPatchProposal> {
  const rootDir = options?.rootDir || process.cwd();
  const resolvedRoot = path.resolve(rootDir);
  const state = loadState();
  const idx = state.proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error('عرض الإصلاح المطلوب غير موجود.');
  }

  const proposal = state.proposals[idx];
  if (proposal.status !== 'approved' || !proposal.approved_by) {
    throw new Error('لا يُسمح بتنفيذ أي تعديل قبل اعتماده صراحةً من المدير.');
  }

  // Re-verify protection policy & exact match before touching disk
  const backupMap: Record<string, string> = {};
  for (const diff of proposal.file_diffs) {
    const guard = isFileProtectedFromWrite(diff.file_path);
    if (guard.protected) {
      throw new Error(guard.reason || `الملف ${diff.file_path} محمي.`);
    }
    const absPath = path.resolve(resolvedRoot, diff.file_path);
    if (!fs.existsSync(absPath)) {
      throw new Error(`الملف غير موجود أثناء التنفيذ: ${diff.file_path}`);
    }
    const content = fs.readFileSync(absPath, 'utf8');
    if (!content.includes(diff.original_excerpt)) {
      throw new Error(
        `تغيّر محتوى الملف (${diff.file_path}) منذ إعداد العرض ولم يعد المقتطف مطابقاً. أعد الفحص لتوليد عرض محدّث.`
      );
    }
    backupMap[diff.file_path] = content;
  }

  // Apply edits atomically with rollback on error
  const modifiedFiles: string[] = [];
  try {
    state.backups[proposal.id] = backupMap;
    for (const diff of proposal.file_diffs) {
      const absPath = path.resolve(resolvedRoot, diff.file_path);
      const currentContent = fs.readFileSync(absPath, 'utf8');
      const nextContent = currentContent.replace(diff.original_excerpt, diff.proposed_excerpt);
      fs.writeFileSync(absPath, nextContent, 'utf8');
      modifiedFiles.push(diff.file_path);
    }
  } catch (writeErr: any) {
    // Immediate rollback
    for (const [rel, orig] of Object.entries(backupMap)) {
      fs.writeFileSync(path.resolve(resolvedRoot, rel), orig, 'utf8');
    }
    throw new Error(`فشل تطبيق التعديل وتم استرجاع النسخة الأصلية: ${writeErr?.message}`);
  }

  // Run real verification (tsc --noEmit + optional tests)
  const verification = options?.skipVerification
    ? { typecheckPassed: true, testsPassed: null, output: 'تم تخطي الفحص بناءً على خيار التشغيل.' }
    : await runVerificationCommands(proposal.verification_command, resolvedRoot);

  const passed = verification.typecheckPassed && verification.testsPassed !== false;
  const now = new Date().toISOString();

  if (!passed) {
    // Auto-rollback on verification failure!
    for (const [rel, orig] of Object.entries(backupMap)) {
      fs.writeFileSync(path.resolve(resolvedRoot, rel), orig, 'utf8');
    }

    const failedProposal: EngineeringPatchProposal = {
      ...proposal,
      status: 'failed',
      execution_report: {
        success: false,
        summary_ar: 'فشلت اختبارات التحقق بعد التطبيق وتمت استعادة الملفات الأصلية تلقائياً لحماية المتجر.',
        files_modified: modifiedFiles,
        typecheck_passed: verification.typecheckPassed,
        tests_passed: verification.testsPassed,
        command_output: verification.output,
        executed_at: now,
        rollback_available: false,
      },
      updated_at: now,
    };
    state.proposals[idx] = failedProposal;
    if (failedProposal.finding_id) {
      state.findings = state.findings.map((f) =>
        f.id === failedProposal.finding_id ? { ...f, status: 'failed', updated_at: now } : f
      );
    }
    saveState();

    appendAuditLog({
      action: 'fix_failed',
      actor,
      target_id: failedProposal.id,
      summary_ar: `فشل التحقق بعد تطبيق (${failedProposal.title_ar}) وتم التراجع التلقائي بأمان.`,
      affected_files: modifiedFiles,
      success: false,
      details: verification.output.slice(0, 500),
    });

    return failedProposal;
  }

  const appliedProposal: EngineeringPatchProposal = {
    ...proposal,
    status: 'applied',
    applied_by: actor,
    applied_at: now,
    execution_report: {
      success: true,
      summary_ar: `تم تطبيق التعديل بنجاح على (${modifiedFiles.join('، ')}) واجتياز فحص TypeScript بنجاح.`,
      files_modified: modifiedFiles,
      typecheck_passed: verification.typecheckPassed,
      tests_passed: verification.testsPassed,
      command_output: verification.output,
      executed_at: now,
      rollback_available: true,
    },
    updated_at: now,
  };

  state.proposals[idx] = appliedProposal;
  if (appliedProposal.finding_id) {
    state.findings = state.findings.map((f) =>
      f.id === appliedProposal.finding_id
        ? {
            ...f,
            status: 'applied',
            category: 'verified_fixed' as EngineeringFindingCategory,
            updated_at: now,
          }
        : f
    );
  }
  saveState();

  appendAuditLog({
    action: 'fix_applied',
    actor,
    target_id: appliedProposal.id,
    summary_ar: appliedProposal.execution_report!.summary_ar,
    affected_files: modifiedFiles,
    success: true,
    details: verification.output.slice(0, 500),
  });

  return appliedProposal;
}

export function rollbackAppliedProposal(
  proposalId: string,
  actor = 'admin',
  rootDir: string = process.cwd()
): EngineeringPatchProposal {
  const resolvedRoot = path.resolve(rootDir);
  const state = loadState();
  const idx = state.proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error('عرض الإصلاح المطلوب غير موجود.');
  }
  const proposal = state.proposals[idx];
  const backupMap = state.backups[proposalId];
  if (!backupMap || Object.keys(backupMap).length === 0) {
    throw new Error('لا توجد نسخة احتياطية محفوظة للتراجع عن هذا التعديل.');
  }

  for (const [rel, originalContent] of Object.entries(backupMap)) {
    const absPath = path.resolve(resolvedRoot, rel);
    fs.writeFileSync(absPath, originalContent, 'utf8');
  }

  const now = new Date().toISOString();
  const rolledBack: EngineeringPatchProposal = {
    ...proposal,
    status: 'rolled_back',
    execution_report: proposal.execution_report
      ? {
          ...proposal.execution_report,
          rollback_available: false,
          summary_ar: `${proposal.execution_report.summary_ar} (تم التراجع واستعادة النسخة الأصلية).`,
        }
      : null,
    updated_at: now,
  };
  state.proposals[idx] = rolledBack;

  if (rolledBack.finding_id) {
    state.findings = state.findings.map((f) =>
      f.id === rolledBack.finding_id
        ? { ...f, status: 'open', category: 'confirmed_issue', updated_at: now }
        : f
    );
  }
  saveState();

  appendAuditLog({
    action: 'fix_rolled_back',
    actor,
    target_id: rolledBack.id,
    summary_ar: `تم التراجع عن التعديل (${rolledBack.title_ar}) واستعادة الحالة الأصلية للملفات.`,
    affected_files: Object.keys(backupMap),
    success: true,
  });

  return rolledBack;
}

// =========================================================================
// Safe Proposal Template Generator for Discovered Findings
// =========================================================================

export function buildFixProposalFromFinding(
  findingId: string,
  actor = 'admin',
  rootDir: string = process.cwd()
): EngineeringPatchProposal {
  const state = loadState();
  const finding = state.findings.find((f) => f.id === findingId);
  if (!finding) {
    throw new Error('المشكلة المطلوبة غير موجودة.');
  }

  const resolvedRoot = path.resolve(rootDir);

  // Build real, verified exact-match diffs for supported auto-draftable findings
  if (finding.rule_key === 'html_rtl_attribute_missing') {
    const html = fs.readFileSync(path.resolve(resolvedRoot, 'index.html'), 'utf8');
    const match = html.match(/<html[^>]*>/i);
    if (match) {
      const orig = match[0];
      const next = orig.includes('dir=') ? orig : orig.replace('<html', '<html lang="ar" dir="rtl"');
      return createPatchProposal(
        {
          finding_id: finding.id,
          title_ar: 'ضبط اتجاه العربية RTL في index.html',
          rationale_ar: finding.recommended_solution_ar,
          edits: [{ file_path: 'index.html', original_excerpt: orig, proposed_excerpt: next }],
          verification_command: 'typecheck',
        },
        actor,
        rootDir
      );
    }
  }

  if (finding.rule_key === 'storefront_img_lazy_loading') {
    const targetFile = 'src/components/StoreFront.tsx';
    const content = fs.readFileSync(path.resolve(resolvedRoot, targetFile), 'utf8');
    const lineMatch = content.split(/\r?\n/).find((ln) => /<img(?![^>]*loading=)/.test(ln));
    if (lineMatch) {
      const orig = lineMatch;
      const next = lineMatch.replace('<img', '<img loading="lazy" decoding="async"');
      return createPatchProposal(
        {
          finding_id: finding.id,
          title_ar: 'إضافة التحميل الكسول للصور في StoreFront.tsx',
          rationale_ar: finding.recommended_solution_ar,
          edits: [{ file_path: targetFile, original_excerpt: orig, proposed_excerpt: next }],
          verification_command: 'typecheck',
        },
        actor,
        rootDir
      );
    }
  }

  if (finding.rule_key === 'server_nonstandard_gemini_models') {
    const targetFile = 'server.ts';
    const content = fs.readFileSync(path.resolve(resolvedRoot, targetFile), 'utf8');
    const excerpt = "const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];";
    if (content.includes(excerpt)) {
      return createPatchProposal(
        {
          finding_id: finding.id,
          title_ar: 'توحيد نماذج Gemini المعتمدة في server.ts لتجنب أخطاء 404',
          rationale_ar: finding.recommended_solution_ar,
          edits: [
            {
              file_path: targetFile,
              original_excerpt: excerpt,
              proposed_excerpt: "const modelsToTry = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];",
            },
          ],
          verification_command: 'typecheck',
        },
        actor,
        rootDir
      );
    }
  }

  // If target file is protected (e.g., firestore.rules, AdminDeveloperAdvisor.tsx), explicitly reject automatic patch creation
  for (const rel of finding.affected_files) {
    const guard = isFileProtectedFromWrite(rel);
    if (guard.protected) {
      throw new Error(
        `هذه الملاحظة تمس ملفاً محمياً (${rel}): ${guard.reason} يُعرض التوصية الهندسية هنا للمراجعة اليدوية فقط حفاظاً على أمان النظام.`
      );
    }
  }

  throw new Error(
    'تتطلب هذه الملاحظة صياغة مقتطف تعديل دقيق عبر المحادثة الهندسية أو محرر العرض قبل الاعتماد والتنفيذ.'
  );
}

// =========================================================================
// Workspace Accessors & Chat Persistence
// =========================================================================

export function getEngineeringWorkspaceSnapshot(rootDir: string = process.cwd()) {
  const state = loadState();
  const { files, skippedSecrets } = listInspectableRepoFiles(rootDir);
  return {
    scans: state.scans,
    findings: state.findings,
    proposals: state.proposals,
    auditLogs: state.auditLogs,
    chatMessages: state.chatMessages,
    repoSummary: {
      inspectableCount: files.length,
      inspectableFiles: files,
      protectedSecretFilesCount: skippedSecrets.length,
    },
  };
}

export function appendEngineeringChatExchange(
  userMsg: EngineeringChatMessage,
  assistantMsg: EngineeringChatMessage,
  actor = 'admin'
): EngineeringChatMessage[] {
  const state = loadState();
  state.chatMessages.push(userMsg, assistantMsg);
  if (state.chatMessages.length > 80) {
    state.chatMessages = [state.chatMessages[0], ...state.chatMessages.slice(-79)];
  }
  saveState();

  appendAuditLog({
    action: 'chat_analyzed',
    actor,
    target_id: assistantMsg.id,
    summary_ar: `استشارة هندسية: ${userMsg.text.slice(0, 90)}`,
    affected_files: assistantMsg.evidence_files || [],
    success: true,
  });

  return state.chatMessages;
}

export function clearEngineeringChatHistory(): EngineeringChatMessage[] {
  const state = loadState();
  state.chatMessages = [
    {
      ...DEFAULT_WELCOME_CHAT,
      id: `eng-arch-welcome-${Date.now()}`,
      timestamp: new Date().toISOString(),
    },
  ];
  saveState();
  return state.chatMessages;
}
