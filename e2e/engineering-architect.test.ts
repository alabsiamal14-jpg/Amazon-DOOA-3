import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const { testAdminUser } = vi.hoisted(() => {
  const user = `arch_admin_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const pass = `ArchPass_${globalThis.crypto.randomUUID()}`;
  process.env.ADMIN_USERNAME = user;
  process.env.ADMIN_PASSWORD = pass;
  process.env.ADMIN_JWT_SECRET = globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID();
  return { testAdminUser: user };
});

import app from '../server.ts';
import { createAdminToken, createEmployeeToken } from '../src/middleware/auth.ts';
import { resetEngineeringArchitectTestState } from '../src/lib/engineering-architect-store.ts';

describe('Amazon Duaa AI Engineering Architect (المستشار الهندسي الذكي) E2E', () => {
  const adminToken = createAdminToken(testAdminUser);
  const employeeToken = createEmployeeToken('EMP001');
  const tempRelPath = 'src/tmp-architect-e2e-target.ts';
  const tempAbsPath = path.resolve(process.cwd(), tempRelPath);
  const initialTempContent = `export const architectTestValue: number = 1;\n`;

  beforeAll(() => {
    resetEngineeringArchitectTestState();
    fs.writeFileSync(tempAbsPath, initialTempContent, 'utf8');
  });

  afterAll(() => {
    resetEngineeringArchitectTestState();
    if (fs.existsSync(tempAbsPath)) {
      fs.unlinkSync(tempAbsPath);
    }
  });

  it('enforces strict Admin RBAC (rejects unauthenticated and employee tokens)', async () => {
    const unauth = await request(app).get('/api/admin/engineering-architect/workspace');
    expect(unauth.status).toBe(401);

    const emp = await request(app)
      .get('/api/admin/engineering-architect/workspace')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(emp.status).toBe(403);

    const admin = await request(app)
      .get('/api/admin/engineering-architect/workspace')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
    expect(admin.body.success).toBe(true);
    expect(admin.body.protectedPolicies?.untouchedDeveloperAdvisor).toContain(
      'src/components/AdminDeveloperAdvisor.tsx'
    );
  });

  it('keeps existing Developer Advisor endpoint untouched and independent', async () => {
    const devAdvisorRes = await request(app)
      .post('/api/ai/developer-advisor')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'ملخص سريع' });
    expect(devAdvisorRes.status).toBe(200);
    expect(typeof devAdvisorRes.body.answer).toBe('string');
  });

  it('runs all 4 real codebase audits with verified evidence and transparent inaccessible sources', async () => {
    for (const scope of ['security', 'ui_design', 'performance', 'comprehensive'] as const) {
      const res = await request(app)
        .post('/api/admin/engineering-architect/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ scope });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scan.scope).toBe(scope);
      expect(res.body.scan.files_inspected_count).toBeGreaterThan(10);
      expect(Array.isArray(res.body.scan.inspected_files)).toBe(true);
      expect(Array.isArray(res.body.scan.inaccessible_sources)).toBe(true);
      expect(res.body.scan.inaccessible_sources.length).toBeGreaterThan(0);
    }

    const ws = await request(app)
      .get('/api/admin/engineering-architect/workspace')
      .set('Authorization', `Bearer ${adminToken}`);
    const findings: any[] = ws.body.findings;
    const categories = new Set(findings.map((f) => f.category));
    expect(categories.has('confirmed_issue')).toBe(true);
    expect(categories.has('potential_issue')).toBe(true);
    expect(categories.has('improvement')).toBe(true);
    expect(categories.has('verified_fixed')).toBe(true);
  });

  it('reads real project files safely while blocking secret files and path traversal', async () => {
    const okRead = await request(app)
      .post('/api/admin/engineering-architect/files/read')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filePath: 'src/App.tsx', startLine: 1, endLine: 25 });
    expect(okRead.status).toBe(200);
    expect(okRead.body.file).toBe('src/App.tsx');
    expect(okRead.body.numberedContent).toContain('1: ');

    const envBlocked = await request(app)
      .post('/api/admin/engineering-architect/files/read')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filePath: '.env' });
    expect(envBlocked.status).toBe(403);

    const traversalBlocked = await request(app)
      .post('/api/admin/engineering-architect/files/read')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filePath: '../../etc/passwd' });
    expect(traversalBlocked.status).toBe(403);

    const missing = await request(app)
      .post('/api/admin/engineering-architect/files/read')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filePath: 'src/nonexistent-file-xyz.ts' });
    expect(missing.status).toBe(404);
  });

  it('provides grounded engineering chat citing only real inspected files and disclosing unavailable targets', async () => {
    const chatRes = await request(app)
      .post('/api/admin/engineering-architect/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        message: 'راجع سلامة CheckoutPage.tsx وملف .env',
        targetFiles: ['src/components/CheckoutPage.tsx', '.env'],
      });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.assistantMessage.evidence_files).toContain('src/components/CheckoutPage.tsx');
    expect(chatRes.body.assistantMessage.evidence_files).not.toContain('.env');
    expect(
      chatRes.body.assistantMessage.uninspected_notes.some((n: string) => n.includes('.env'))
    ).toBe(true);

    const clearRes = await request(app)
      .delete('/api/admin/engineering-architect/chat')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.chatMessages.length).toBe(1);
  });

  it('protects critical files and enforces exact-match validation + explicit approval gate', async () => {
    for (const protectedFile of [
      'src/components/AdminDeveloperAdvisor.tsx',
      'firestore.rules',
      'src/lib/firebase.ts',
    ]) {
      const blocked = await request(app)
        .post('/api/admin/engineering-architect/proposals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title_ar: 'محاولة تعديل ملف محمي',
          rationale_ar: 'اختبار الحماية',
          edits: [
            {
              file_path: protectedFile,
              original_excerpt: 'import',
              proposed_excerpt: '// blocked',
            },
          ],
        });
      expect(blocked.status).toBe(400);
    }

    const mismatch = await request(app)
      .post('/api/admin/engineering-architect/proposals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title_ar: 'اختبار تطابق النص',
        rationale_ar: 'اختبار رفض نص غير مطابق',
        edits: [
          {
            file_path: tempRelPath,
            original_excerpt: 'THIS_LINE_DOES_NOT_EXIST',
            proposed_excerpt: 'export const x = 2;',
          },
        ],
      });
    expect(mismatch.status).toBe(400);

    const created = await request(app)
      .post('/api/admin/engineering-architect/proposals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title_ar: 'اختبار التعديل المعتمد',
        rationale_ar: 'التأكد من بوابة الموافقة',
        edits: [
          {
            file_path: tempRelPath,
            original_excerpt: 'export const architectTestValue: number = 1;',
            proposed_excerpt: 'export const architectTestValue: number = 2;',
          },
        ],
      });
    expect(created.status).toBe(201);
    const propId = created.body.proposal.id;

    // Cannot apply before explicit approval
    const applyWithoutApproval = await request(app)
      .post(`/api/admin/engineering-architect/proposals/${propId}/apply`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(applyWithoutApproval.status).toBe(400);

    // Cannot approve without { approve: true }
    const invalidApprove = await request(app)
      .post(`/api/admin/engineering-architect/proposals/${propId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approve: false });
    expect(invalidApprove.status).toBe(400);
  });

  it(
    'applies approved fix with real tsc verification, supports rollback, and auto-rolls back invalid TS edits',
    async () => {
      // 1. Valid approved edit -> tsc passes -> rollback restores exact original content
      const createValid = await request(app)
        .post('/api/admin/engineering-architect/proposals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title_ar: 'تحديث قيمة صالحة متوافقة مع TypeScript',
          rationale_ar: 'اختبار التنفيذ الفعلي والتحقق والرجوع',
          edits: [
            {
              file_path: tempRelPath,
              original_excerpt: 'export const architectTestValue: number = 1;',
              proposed_excerpt: 'export const architectTestValue: number = 42;',
            },
          ],
          verification_command: 'typecheck',
        });
      expect(createValid.status).toBe(201);
      const validId = createValid.body.proposal.id;

      const approved = await request(app)
        .post(`/api/admin/engineering-architect/proposals/${validId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approve: true });
      expect(approved.status).toBe(200);
      expect(approved.body.proposal.status).toBe('approved');

      const applied = await request(app)
        .post(`/api/admin/engineering-architect/proposals/${validId}/apply`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(applied.status).toBe(200);
      expect(applied.body.proposal.status).toBe('applied');
      expect(applied.body.proposal.execution_report.typecheck_passed).toBe(true);
      expect(fs.readFileSync(tempAbsPath, 'utf8')).toContain('= 42;');

      const rolledBack = await request(app)
        .post(`/api/admin/engineering-architect/proposals/${validId}/rollback`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(rolledBack.status).toBe(200);
      expect(rolledBack.body.proposal.status).toBe('rolled_back');
      expect(fs.readFileSync(tempAbsPath, 'utf8')).toBe(initialTempContent);

      // 2. Failing TS edit -> auto-rollback restores original file
      const createBad = await request(app)
        .post('/api/admin/engineering-architect/proposals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title_ar: 'تعديل خاطئ نوعياً لاختبار التراجع التلقائي',
          rationale_ar: 'التأكد من التراجع الفوري عند فشل tsc',
          edits: [
            {
              file_path: tempRelPath,
              original_excerpt: 'export const architectTestValue: number = 1;',
              proposed_excerpt: 'export const architectTestValue: number = "INVALID_STRING_FOR_NUMBER";',
            },
          ],
          verification_command: 'typecheck',
        });
      expect(createBad.status).toBe(201);
      const badId = createBad.body.proposal.id;

      await request(app)
        .post(`/api/admin/engineering-architect/proposals/${badId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approve: true });

      const failedApply = await request(app)
        .post(`/api/admin/engineering-architect/proposals/${badId}/apply`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(failedApply.status).toBe(200);
      expect(failedApply.body.proposal.status).toBe('failed');
      expect(failedApply.body.proposal.execution_report.typecheck_passed).toBe(false);
      // File on disk must remain clean original content after auto-rollback!
      expect(fs.readFileSync(tempAbsPath, 'utf8')).toBe(initialTempContent);
    },
    60000
  );

  it('distinguishes server vs client vs shared layers, suppresses server process.env false positives, and validates nested Firestore rules + confidence scores', async () => {
    const scanRes = await request(app)
      .post('/api/admin/engineering-architect/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scope: 'comprehensive' });

    expect(scanRes.status).toBe(200);
    const { scan, findings, workspace } = scanRes.body;

    // 1. Layer breakdown distinguishes server, client, shared, config_rules
    expect(scan.layer_breakdown.server).toBeGreaterThan(5);
    expect(scan.layer_breakdown.client).toBeGreaterThan(5);
    expect(scan.layer_breakdown.shared).toBeGreaterThan(0);

    // 2. Server process.env usage MUST NOT be flagged as client leaks
    expect(scan.suppressed_false_positives_count).toBeGreaterThan(0);
    expect(Array.isArray(scan.suppressed_notes_ar)).toBe(true);
    expect(
      findings.some((f: any) => String(f.rule_key).startsWith('client_secret_ref_'))
    ).toBe(false);

    // 3. Full firestore.rules structural parse + nested subcollection analysis
    expect(scan.firestore_rules_parsed_paths).toBeGreaterThanOrEqual(20);
    const nestedRuleFinding = findings.find(
      (f: any) => f.rule_key === 'firestore_nested_subcollections_verified'
    );
    expect(nestedRuleFinding).toBeTruthy();
    expect(nestedRuleFinding.category).toBe('verified_fixed');
    expect(nestedRuleFinding.confidence_score).toBeGreaterThanOrEqual(90);

    const partialOpenRule = findings.find((f: any) =>
      String(f.rule_key).startsWith('firestore_partial_open_')
    );
    expect(partialOpenRule).toBeTruthy();
    expect(partialOpenRule.diagnosis_type).toBe('confirmed_vulnerability');

    // 4. Confidence scores & Confirmed vs Suspected distinction
    for (const f of findings) {
      expect(typeof f.confidence_score).toBe('number');
      expect(f.confidence_score).toBeGreaterThan(0);
      expect(f.confidence_score).toBeLessThanOrEqual(100);
      expect(typeof f.confidence_reason_ar).toBe('string');
      expect(typeof f.diagnosis_type).toBe('string');
      for (const ev of f.evidence) {
        expect(ev.verified_from_disk).toBe(true);
        expect(fs.existsSync(path.resolve(process.cwd(), ev.file))).toBe(true);
      }
    }

    // Try/catch guarded window.open separated from unguarded window.confirm
    const guardedOpen = findings.find((f: any) => f.rule_key === 'iframe_guarded_window_open_review');
    expect(guardedOpen).toBeTruthy();
    expect(guardedOpen.diagnosis_type).toBe('suspected_needs_test');
    expect(guardedOpen.needs_runtime_test).toBe(true);

    // window.alert / window.confirm MUST NOT be classified as security vulnerabilities
    const windowDialogs = findings.find((f: any) => f.rule_key === 'iframe_window_dialogs');
    expect(windowDialogs).toBeTruthy();
    expect(windowDialogs.domain).toBe('ui_ux');
    expect(windowDialogs.diagnosis_type).toBe('design_or_perf_improvement');
    expect(windowDialogs.category).toBe('improvement');

    // @google/genai 2.32.0 matches ^2.4.0 -> MUST NOT emit false library upgrade recommendation
    expect(findings.some((f: any) => f.rule_key === 'pkg_genai_range_mismatch')).toBe(false);

    // No duplicate rule_key in workspace findings across multiple scans
    const ruleKeys = workspace.findings.map((f: any) => f.rule_key);
    expect(new Set(ruleKeys).size).toBe(ruleKeys.length);

    // 5. File reader includes runtimeDiagnostics layer classification
    const serverFileRead = await request(app)
      .post('/api/admin/engineering-architect/files/read')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filePath: 'src/middleware/auth.ts', startLine: 1, endLine: 20 });
    expect(serverFileRead.status).toBe(200);
    expect(serverFileRead.body.runtimeDiagnostics?.layer).toBe('server');

    const clientFileRead = await request(app)
      .post('/api/admin/engineering-architect/files/read')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filePath: 'src/components/Navbar.tsx', startLine: 1, endLine: 20 });
    expect(clientFileRead.status).toBe(200);
    expect(clientFileRead.body.runtimeDiagnostics?.layer).toBe('client');
    expect(clientFileRead.body.runtimeDiagnostics?.clientChain?.[0]).toBe('src/main.tsx');

    // 6. Re-verify a single finding after preparing a proposal (simulation) without deleting previous scans
    const scansCountBefore = workspace.scans.length;
    const lazyImgFinding = findings.find((f: any) => f.rule_key === 'storefront_img_lazy_loading');
    expect(lazyImgFinding).toBeTruthy();

    const prepRes = await request(app)
      .post('/api/admin/engineering-architect/proposals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ findingId: lazyImgFinding.id });
    expect(prepRes.status).toBe(201);

    const reverifyRes = await request(app)
      .post(`/api/admin/engineering-architect/findings/${lazyImgFinding.id}/reverify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proposalId: prepRes.body.proposal.id });
    expect(reverifyRes.status).toBe(200);
    expect(reverifyRes.body.verification.mode).toBe('proposal_simulation');
    expect(typeof reverifyRes.body.verification.disappeared).toBe('boolean');
    expect(reverifyRes.body.finding.last_reverification).toBeTruthy();
    // Previous scan history MUST be preserved!
    expect(reverifyRes.body.workspace.scans.length).toBe(scansCountBefore);
  });

  it('verifies import-chain secret detection, scanner exclusion, dangerouslySetInnerHTML sanitization, and non-existent file filtering directly', async () => {
    const {
      analyzeDangerouslySetInnerHtml,
      buildProjectRuntimeGraph,
      traceSecretEnvUsageInBrowserPaths,
      verifyFindingFileReferences,
    } = await import('../src/lib/engineering-static-analyzer.ts');

    const mockFiles = new Map<string, string>([
      ['src/main.tsx', `import './App';`],
      [
        'src/App.tsx',
        `import './components/LeakBox'; import './components/GuardedEnv'; import './components/SanitizedHtml'; import './components/UnsafeHtml';`,
      ],
      ['src/components/LeakBox.tsx', `export const k = process.env.GEMINI_API_KEY;`],
      [
        'src/components/GuardedEnv.tsx',
        `export function readServerOnly() { if (typeof window === 'undefined') { return process.env.GEMINI_API_KEY; } return null; }`,
      ],
      [
        'src/components/SanitizedHtml.tsx',
        `import DOMPurify from 'dompurify'; export const C = ({ raw }: any) => <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(raw) }} />;`,
      ],
      [
        'src/components/UnsafeHtml.tsx',
        `export const U = ({ raw }: any) => <div dangerouslySetInnerHTML={{ __html: raw }} />;`,
      ],
      ['src/lib/engineering-architect-store.ts', `export const pattern = process.env.GEMINI_API_KEY;`],
      ['server.ts', `import './src/server/secret';`],
      ['src/server/secret.ts', `export const s = process.env.GEMINI_API_KEY;`],
      ['src/shared/envCheck.ts', `export const isTest = process.env.NODE_ENV === 'test';`],
    ]);

    const graph = buildProjectRuntimeGraph(mockFiles);
    expect(graph.profiles.get('src/server/secret.ts')?.layer).toBe('server');
    expect(graph.profiles.get('src/components/LeakBox.tsx')?.layer).toBe('client');

    const traced = traceSecretEnvUsageInBrowserPaths(mockFiles, graph);
    expect(traced.suppressedServerEnvFiles).toContain('src/server/secret.ts');
    expect(traced.suppressedScannerFiles).toContain('src/lib/engineering-architect-store.ts');
    expect(traced.suppressedServerGuardedSharedFiles).toContain('src/components/GuardedEnv.tsx');
    expect(traced.confirmedClientLeaks.length).toBe(1);
    expect(traced.confirmedClientLeaks[0].file).toBe('src/components/LeakBox.tsx');
    expect(traced.confirmedClientLeaks[0].clientChain).toEqual([
      'src/main.tsx',
      'src/App.tsx',
      'src/components/LeakBox.tsx',
    ]);

    const xss = analyzeDangerouslySetInnerHtml(mockFiles, graph);
    const sanitizedEntry = xss.find((x) => x.file === 'src/components/SanitizedHtml.tsx');
    const unsafeEntry = xss.find((x) => x.file === 'src/components/UnsafeHtml.tsx');
    expect(sanitizedEntry?.hasSanitizer).toBe(true);
    expect(sanitizedEntry?.diagnosis).toBe('design_or_perf_improvement');
    expect(unsafeEntry?.hasSanitizer).toBe(false);
    expect(unsafeEntry?.hasUntrustedInput).toBe(true);
    expect(unsafeEntry?.diagnosis).toBe('suspected_needs_test');

    // Missing file reference must be rejected by verifyFindingFileReferences
    const filteredOut = verifyFindingFileReferences(
      {
        id: 'fake',
        rule_key: 'fake_rule',
        scan_id: 's1',
        scope: 'security',
        domain: 'security',
        category: 'confirmed_issue',
        severity: 'high',
        title_ar: 'test',
        description_ar: 'test',
        root_cause_ar: 'test',
        recommended_solution_ar: 'test',
        evidence: [{ file: 'src/does-not-exist-anywhere.tsx', line: 1, snippet: 'x', verified_from_disk: false }],
        affected_files: ['src/does-not-exist-anywhere.tsx'],
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      process.cwd(),
      new Map()
    );
    expect(filteredOut).toBeNull();

    const { parseFirestoreRulesFull } = await import('../src/lib/engineering-static-analyzer.ts');
    const rulesSummary = parseFirestoreRulesFull(
      fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8')
    );
    expect(rulesSummary.productPublicWriteNode).toBeTruthy();
    const productCreateOp = rulesSummary.productPublicWriteNode?.operations.find((op) =>
      op.verb.includes('create')
    );
    expect(productCreateOp?.requires_auth).toBe(false);
  });
});
