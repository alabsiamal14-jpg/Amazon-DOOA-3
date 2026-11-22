import { Router, Response } from 'express';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { requireAdmin, AuthRequest } from '../../middleware/auth.ts';
import {
  appendEngineeringChatExchange,
  applyApprovedPatchProposal,
  approvePatchProposal,
  buildFixProposalFromFinding,
  clearEngineeringChatHistory,
  createPatchProposal,
  getEngineeringWorkspaceSnapshot,
  getFileDiagnosticsInfo,
  isFileProtectedFromWrite,
  listInspectableRepoFiles,
  readWorkspaceFileSafe,
  rejectPatchProposal,
  reverifySingleFinding,
  rollbackAppliedProposal,
  runRealCodebaseAudit,
} from '../../lib/engineering-architect-store.ts';
import type {
  EngineeringChatMessage,
  EngineeringScanScope,
} from '../../types.ts';

const router = Router();
router.use(requireAdmin);

const GEMINI_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
const VALID_SCOPES = new Set<EngineeringScanScope>(['comprehensive', 'security', 'ui_design', 'performance']);

function getActor(req: AuthRequest): string {
  return req.user?.username || req.user?.email || 'admin';
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || process.env.NODE_ENV === 'test') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: 25000 },
  });
}

async function withAiTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms = 20000
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Gemini request timed out'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function selectFilesForQuery(
  message: string,
  requestedTargets: string[],
  inspectableFiles: string[]
): string[] {
  const inspectableSet = new Set(inspectableFiles);
  const chosen: string[] = [];
  const pushIfInspectable = (p: string) => {
    const clean = p.replace(/^\/+/, '');
    if (inspectableSet.has(clean) && !chosen.includes(clean)) {
      chosen.push(clean);
    }
  };

  for (const t of requestedTargets) {
    if (typeof t === 'string') pushIfInspectable(t.trim());
  }

  // Extract explicit filenames mentioned inside message
  const pathMatches = message.match(/[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|html|rules|md)/g) || [];
  for (const match of pathMatches) {
    if (inspectableSet.has(match)) {
      pushIfInspectable(match);
    } else {
      const bySuffix = inspectableFiles.find((f) => f.endsWith(`/${match}`) || f === match);
      if (bySuffix) pushIfInspectable(bySuffix);
    }
  }

  const lower = message.toLowerCase();
  if (/سلة|دفع|طلب|شراء|cart|checkout|order|stock|مخزون/.test(lower)) {
    pushIfInspectable('src/components/CheckoutPage.tsx');
    pushIfInspectable('src/components/CartDrawer.tsx');
    pushIfInspectable('src/services/orderProcessor.ts');
  }
  if (/أمان|حماية|ثغرة|firebase|firestore|صلاحيات|rbac|auth|قواعد|security/.test(lower)) {
    pushIfInspectable('firestore.rules');
    pushIfInspectable('src/middleware/auth.ts');
    pushIfInspectable('src/lib/firebase.ts');
  }
  if (/واجهة|تصميم|جوال|هاتف|rtl|ui|ux|navbar|storefront|تنقل/.test(lower)) {
    pushIfInspectable('src/components/Navbar.tsx');
    pushIfInspectable('src/components/StoreFront.tsx');
    pushIfInspectable('index.html');
  }
  if (/أداء|سرعة|تحميل|performance|lazy|ذاكرة|snapshot|server/.test(lower)) {
    pushIfInspectable('src/App.tsx');
    pushIfInspectable('src/lib/lazyImports.ts');
    pushIfInspectable('server.ts');
  }

  if (chosen.length === 0) {
    pushIfInspectable('src/App.tsx');
    pushIfInspectable('server.ts');
    pushIfInspectable('firestore.rules');
  }

  return chosen.slice(0, 3);
}

router.get('/workspace', (_req: AuthRequest, res: Response) => {
  try {
    const workspace = getEngineeringWorkspaceSnapshot();
    return res.json({
      success: true,
      ...workspace,
      protectedPolicies: {
        untouchedDeveloperAdvisor: [
          'src/components/AdminDeveloperAdvisor.tsx',
          'src/services/codebaseScanner.ts',
          'src/services/zipProjectAnalyzer.ts',
          '/api/ai/developer-advisor',
          '/api/ai/analyze-project-zip',
        ],
        protectedInfrastructure: [
          'firestore.rules',
          'firebase-applet-config.json',
          'firebase-blueprint.json',
          'src/lib/firebase.ts',
          'src/lib/firebase-admin.ts',
          'src/lib/supabase.ts',
          '.env*',
        ],
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر تحميل مساحة عمل المستشار الهندسي.' });
  }
});

router.post('/scan', (req: AuthRequest, res: Response) => {
  try {
    const rawScope = String(req.body?.scope || 'comprehensive') as EngineeringScanScope;
    const scope: EngineeringScanScope = VALID_SCOPES.has(rawScope) ? rawScope : 'comprehensive';
    const actor = getActor(req);
    const result = runRealCodebaseAudit(scope, actor);
    return res.json({
      success: true,
      scan: result.scan,
      findings: result.findings,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'فشل تنفيذ الفحص الهندسي.' });
  }
});

router.post('/files/read', (req: AuthRequest, res: Response) => {
  try {
    const filePath = String(req.body?.filePath || '').trim();
    if (!filePath) {
      return res.status(400).json({ error: 'يرجى تحديد مسار الملف المطلوب قراءته.' });
    }
    const startLine = req.body?.startLine !== undefined ? Number(req.body.startLine) : undefined;
    const endLine = req.body?.endLine !== undefined ? Number(req.body.endLine) : undefined;
    const result = readWorkspaceFileSafe(filePath, startLine, endLine);
    return res.json({
      success: true,
      ...result,
      writeProtection: isFileProtectedFromWrite(result.file),
      runtimeDiagnostics: getFileDiagnosticsInfo(result.file),
    });
  } catch (err: any) {
    const msg = String(err?.message || 'تعذر قراءة الملف.');
    if (/غير مسموح|مرفوضة|الأسرار|تجاوز حدود/.test(msg)) {
      return res.status(403).json({ error: msg });
    }
    if (/غير موجود/.test(msg)) {
      return res.status(404).json({ error: msg });
    }
    return res.status(400).json({ error: msg });
  }
});

router.post('/chat', async (req: AuthRequest, res: Response) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'الرسالة مطلوبة لبدء المحادثة الهندسية.' });
    }

    const actor = getActor(req);
    const requestedTargets = Array.isArray(req.body?.targetFiles)
      ? req.body.targetFiles.filter((x: unknown): x is string => typeof x === 'string')
      : [];

    const { files: inspectableFiles, skippedSecrets } = listInspectableRepoFiles();
    const uninspectedNotes: string[] = [
      `ملفات الأسرار والبيئة محجوبة تلقائياً (${skippedSecrets.length} ملف) لحماية المفاتيح.`,
      'لم يتم تشغيل متصفح حي (Live DOM/Browser Network) ضمن هذا الرد؛ الاستنتاج مبني على قراءة الشيفرة الفعلية على القرص.',
    ];

    // Check if user requested blocked or nonexistent targets
    for (const rawTarget of requestedTargets) {
      try {
        readWorkspaceFileSafe(rawTarget, 1, 5);
      } catch (readErr: any) {
        uninspectedNotes.push(`تعذر فحص (${rawTarget}): ${readErr?.message || 'غير متاح'}`);
      }
    }

    const filesToRead = selectFilesForQuery(message, requestedTargets, inspectableFiles);
    const readFileContexts: Array<{ file: string; startLine: number; endLine: number; totalLines: number; content: string }> = [];

    for (const rel of filesToRead) {
      try {
        const snippet = readWorkspaceFileSafe(rel, 1, 90);
        readFileContexts.push({
          file: snippet.file,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          totalLines: snippet.totalLines,
          content: snippet.numberedContent.slice(0, 2600),
        });
      } catch (err: any) {
        uninspectedNotes.push(`تعذر قراءة (${rel}): ${err?.message || 'خطأ قراءة'}`);
      }
    }

    const actuallyInspected = readFileContexts.map((c) => c.file);
    const workspace = getEngineeringWorkspaceSnapshot();
    const recentFindingsSummary = workspace.findings
      .slice(0, 8)
      .map((f) => `- [${f.category} | ${f.severity}] ${f.title_ar} (${f.affected_files.join(', ')})`)
      .join('\n');

    let replyText = '';

    const ai = getGeminiClient();
    if (ai) {
      const promptText = `أنت Amazon Duaa AI Engineering Architect (المستشار الهندسي الذكي المستقل).
مهمتك مساعدة المدير في جودة المتجر، الأمان، واجهات المستخدم، الجوال، الأداء، Firebase/Firestore، وتدفقات التجارة الإلكترونية.

قواعد الصدق الصارمة (ممنوع مخالفتها):
1. استشهد فقط بالملفات التي قُرئت فعلياً في القسم أدناه. لا تدّعِ فحص أي ملف لم يُقرأ.
2. ميّز بوضوح بين: (مشكلة مؤكدة) و(مشكلة محتملة) و(تحسين مقترح) و(تم التحقق من سلامته).
3. لا تقترح تعديلاً على المستشار البرمجي الأول (AdminDeveloperAdvisor.tsx) أو ملفات الأسرار أو firestore.rules إلا كتوصية يدوية للمراجعة.
4. أجب بالعربية الفصحى الهندسية الواضحة والمختصرة.

سؤال المدير:
${message}

ملخص أحدث نتائج الفحص الحقيقي المسجلة:
${recentFindingsSummary || 'لم يُجرَ مسح كامل بعد — اعتمد على الملفات المقروءة أدناه.'}

الملفات التي تم فحصها فعلياً من القرص الآن:
${readFileContexts
  .map((c) => `=== ${c.file} (الأسطر ${c.startLine}-${c.endLine} من ${c.totalLines}) ===\n${c.content}`)
  .join('\n\n')}

مصادر غير متاحة أو لم تُفحص:
${uninspectedNotes.join('\n')}`;

      for (const model of GEMINI_MODELS) {
        try {
          const response = await withAiTimeout(
            (signal) =>
              ai.models.generateContent({
                model,
                contents: promptText,
                config: {
                  abortSignal: signal,
                  maxOutputTokens: 2048,
                  ...(model === 'gemini-4-hydrogen'
                    ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                    : {}),
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      reply_ar: { type: Type.STRING },
                      cited_files: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['reply_ar', 'cited_files'],
                  },
                },
              }),
            20000
          );

          const rawJson = response.text || '{}';
          const parsed = JSON.parse(rawJson);
          if (parsed?.reply_ar && typeof parsed.reply_ar === 'string') {
            replyText = parsed.reply_ar.trim();
            break;
          }
        } catch (aiErr: any) {
          console.info(
            `[EngineeringArchitect] Switching from ${model} to fallback (${aiErr?.message || 'unavailable'})`
          );
        }
      }
    }

    if (!replyText) {
      const inspectedBullet =
        readFileContexts.length > 0
          ? readFileContexts
              .map((c) => `• **${c.file}** (فُحص الأسطر ${c.startLine}–${c.endLine} من أصل ${c.totalLines} سطر)`)
              .join('\n')
          : '• لم يتم فتح ملفات إضافية في هذه الجولة.';

      const matchingFindings = workspace.findings
        .filter((f) =>
          readFileContexts.some((c) => f.affected_files.includes(c.file)) ||
          message.includes(f.domain)
        )
        .slice(0, 3);

      const categoryLabel: Record<string, string> = {
        confirmed_issue: 'مشكلة مؤكدة',
        potential_issue: 'مشكلة محتملة',
        improvement: 'تحسين مقترح',
        verified_fixed: 'تم التحقق من سلامته',
      };

      const findingsBullet =
        matchingFindings.length > 0
          ? matchingFindings
              .map(
                (f) =>
                  `- **[${categoryLabel[f.category] || f.category}]** ${f.title_ar}\n  السبب: ${f.root_cause_ar}\n  الحل المقترح: ${f.recommended_solution_ar}`
              )
              .join('\n')
          : '- يمكنك الضغط على «فحص شامل للموقع» أو «فحص أمني» لتحديث قائمة المشكلات المؤكدة والمحتملة والتحسينات عبر كامل المستودع.';

      replyText = `تمت قراءة وتحليل الملفات الفعلية ذات الصلة بسؤالك:\n${inspectedBullet}\n\n**الخلاصة الهندسية:**\n${findingsBullet}\n\n**ملاحظة الشفافية:** التعديل على أي ملف محظور تلقائياً قبل إعداد معاينة (قبل/بعد) والحصول على موافقتك الصريحة.`;
    }

    const userMsg: EngineeringChatMessage = {
      id: `eng-msg-u-${Date.now()}`,
      role: 'user',
      text: message,
      evidence_files: [],
      uninspected_notes: [],
      timestamp: new Date().toISOString(),
    };

    const assistantMsg: EngineeringChatMessage = {
      id: `eng-msg-a-${Date.now() + 1}`,
      role: 'assistant',
      text: replyText,
      evidence_files: actuallyInspected,
      uninspected_notes: uninspectedNotes,
      proposal_id: null,
      timestamp: new Date().toISOString(),
    };

    const chatMessages = appendEngineeringChatExchange(userMsg, assistantMsg, actor);

    return res.json({
      success: true,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      chatMessages,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'حدث خطأ أثناء المحادثة الهندسية.' });
  }
});

router.delete('/chat', (_req: AuthRequest, res: Response) => {
  try {
    const chatMessages = clearEngineeringChatHistory();
    return res.json({ success: true, chatMessages });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'تعذر مسح سجل المحادثة الهندسية.' });
  }
});

router.post('/proposals', (req: AuthRequest, res: Response) => {
  try {
    const actor = getActor(req);
    const findingId = req.body?.findingId ? String(req.body.findingId) : '';

    const proposal = findingId
      ? buildFixProposalFromFinding(findingId, actor)
      : createPatchProposal(
          {
            finding_id: req.body?.finding_id || null,
            title_ar: String(req.body?.title_ar || ''),
            rationale_ar: String(req.body?.rationale_ar || ''),
            edits: Array.isArray(req.body?.edits) ? req.body.edits : [],
            verification_command: req.body?.verification_command || 'typecheck',
          },
          actor
        );

    return res.status(201).json({
      success: true,
      proposal,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر إنشاء عرض الإصلاح الهندسي.' });
  }
});

router.post('/proposals/:id/approve', (req: AuthRequest, res: Response) => {
  try {
    const approve = req.body?.approve === true;
    const proposal = approvePatchProposal(req.params.id, approve, getActor(req));
    return res.json({
      success: true,
      proposal,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر اعتماد عرض الإصلاح.' });
  }
});

router.post('/proposals/:id/reject', (req: AuthRequest, res: Response) => {
  try {
    const proposal = rejectPatchProposal(req.params.id, getActor(req));
    return res.json({
      success: true,
      proposal,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر رفض عرض الإصلاح.' });
  }
});

router.post('/proposals/:id/apply', async (req: AuthRequest, res: Response) => {
  try {
    const proposal = await applyApprovedPatchProposal(req.params.id, getActor(req), {
      skipVerification: req.body?.skipVerification === true,
    });
    return res.json({
      success: true,
      proposal,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر تنفيذ عرض الإصلاح.' });
  }
});

router.post('/proposals/:id/rollback', (req: AuthRequest, res: Response) => {
  try {
    const proposal = rollbackAppliedProposal(req.params.id, getActor(req));
    return res.json({
      success: true,
      proposal,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر التراجع عن التعديل.' });
  }
});

router.post('/findings/:id/reverify', (req: AuthRequest, res: Response) => {
  try {
    const proposalId = req.body?.proposalId ? String(req.body.proposalId) : undefined;
    const result = reverifySingleFinding(req.params.id, {
      proposalId,
      actor: getActor(req),
    });
    return res.json({
      success: true,
      finding: result.finding,
      verification: result.verification,
      workspace: getEngineeringWorkspaceSnapshot(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'تعذر إعادة فحص المشكلة.' });
  }
});

export default router;
