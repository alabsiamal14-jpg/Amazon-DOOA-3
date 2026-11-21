import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ClipboardCheck,
  FileCode2,
  FileText,
  Gauge,
  History,
  Info,
  Layers,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type {
  EngineeringAuditLogEntry,
  EngineeringChatMessage,
  EngineeringDiagnosisType,
  EngineeringDomain,
  EngineeringFinding,
  EngineeringFindingCategory,
  EngineeringPatchProposal,
  EngineeringRuntimeLayer,
  EngineeringScanReport,
  EngineeringScanScope,
  EngineeringSeverity,
  StoreSettings,
} from '../types';
import { getAuthHeadersAsync } from '../lib/storage';

interface AdminEngineeringArchitectPageProps {
  settings: StoreSettings;
  onBackToProducts?: () => void;
}

interface WorkspaceStatePayload {
  scans: EngineeringScanReport[];
  findings: EngineeringFinding[];
  proposals: EngineeringPatchProposal[];
  auditLogs: EngineeringAuditLogEntry[];
  chatMessages: EngineeringChatMessage[];
  repoSummary: {
    inspectableCount: number;
    inspectableFiles: string[];
    protectedSecretFilesCount: number;
  };
  protectedPolicies?: {
    untouchedDeveloperAdvisor: string[];
    protectedInfrastructure: string[];
  };
}

const CATEGORY_META: Record<
  EngineeringFindingCategory,
  { label: string; textClass: string; borderClass: string }
> = {
  confirmed_issue: {
    label: 'مشكلة مؤكدة',
    textClass: 'text-rose-700',
    borderClass: 'border-rose-200',
  },
  potential_issue: {
    label: 'مشكلة محتملة',
    textClass: 'text-amber-700',
    borderClass: 'border-amber-200',
  },
  improvement: {
    label: 'تحسين مقترح',
    textClass: 'text-sky-700',
    borderClass: 'border-sky-200',
  },
  verified_fixed: {
    label: 'تم إصلاحها والتحقق منها',
    textClass: 'text-emerald-700',
    borderClass: 'border-emerald-200',
  },
};

const SEVERITY_LABELS: Record<EngineeringSeverity, string> = {
  critical: 'حرج',
  high: 'مرتفع',
  medium: 'متوسط',
  low: 'منخفض',
};

const DOMAIN_LABELS: Record<EngineeringDomain, string> = {
  errors: 'الأخطاء البرمجية',
  ui_ux: 'الواجهات والتصميم',
  mobile: 'توافق الجوال وRTL',
  performance: 'الأداء والسرعة',
  firebase: 'Firebase وFirestore',
  auth_rbac: 'الصلاحيات والمصادقة',
  security: 'الأمان والثغرات',
  commerce_flow: 'المنتجات والسلة والدفع',
  data_integrity: 'سلامة البيانات',
};

const PROPOSAL_STATUS_META: Record<
  EngineeringPatchProposal['status'],
  { label: string; textClass: string }
> = {
  pending_approval: { label: 'بانتظار موافقة المدير', textClass: 'text-amber-700' },
  approved: { label: 'معتمد وجاهز للتنفيذ', textClass: 'text-sky-700' },
  rejected: { label: 'مرفوض دون تطبيق', textClass: 'text-stone-500' },
  applied: { label: 'مُنفَّذ ومتحقق منه', textClass: 'text-emerald-700' },
  failed: { label: 'فشل التحقق وتم التراجع تلقائياً', textClass: 'text-rose-700' },
  rolled_back: { label: 'تم التراجع واستعادة الأصل', textClass: 'text-stone-700' },
};

const AUDIT_ACTION_LABELS: Record<EngineeringAuditLogEntry['action'], string> = {
  scan_executed: 'تشغيل فحص هندسي',
  proposal_created: 'إعداد عرض إصلاح',
  proposal_approved: 'اعتماد إداري',
  proposal_rejected: 'رفض عرض إصلاح',
  fix_applied: 'تطبيق إصلاح ونجاح التحقق',
  fix_failed: 'فشل التحقق وتراجع تلقائي',
  fix_rolled_back: 'تراجع يدوي',
  verification_run: 'إعادة فحص والتحقق',
  chat_analyzed: 'استشارة هندسية على الكود',
};

const RUNTIME_LAYER_LABELS: Record<EngineeringRuntimeLayer, string> = {
  server: 'خادم (Server)',
  client: 'متصفح (Browser)',
  shared: 'مشترك (Shared)',
  config_rules: 'قواعد وإعدادات',
  unreferenced: 'غير مستدعى',
};

const DIAGNOSIS_LABELS: Record<EngineeringDiagnosisType, string> = {
  confirmed_vulnerability: 'خطر أمني مؤكد',
  confirmed_bug: 'ملاحظة برمجية مؤكدة',
  suspected_needs_test: 'ملاحظة برمجية تحتاج اختبار',
  design_or_perf_improvement: 'تحسين اختياري',
  verified_control: 'ضابط متحقق من سلامته',
};

const QUICK_CHAT_PROMPTS: Array<{ label: string; prompt: string; targetFiles?: string[] }> = [
  {
    label: 'فحص تجربة السلة والدفع',
    prompt: 'افحص سلامة تدفق السلة والدفع وتطابق الأسعار والمخزون في الملفات الفعلية.',
    targetFiles: ['src/components/CheckoutPage.tsx', 'src/components/CartDrawer.tsx'],
  },
  {
    label: 'مراجعة أمان Firebase والصلاحيات',
    prompt: 'راجع قواعد Firestore ونظام الصلاحيات RBAC وأشر إلى المشكلات المؤكدة والمحتملة.',
    targetFiles: ['firestore.rules', 'src/middleware/auth.ts', 'src/lib/firebase.ts'],
  },
  {
    label: 'توافق الجوال والواجهات RTL',
    prompt: 'افحص اتجاه اللغة RTL وتوافق الهواتف وسهولة الوصول في شريط التنقل وصفحة الدخول.',
    targetFiles: ['index.html', 'src/components/Navbar.tsx', 'src/components/StoreFront.tsx'],
  },
  {
    label: 'فحص الأداء والتحميل الكسول',
    prompt: 'راجع التحميل الكسول وتنظيف اشتراكات Firestore وحجم الحزم في ملفات التطبيق.',
    targetFiles: ['src/App.tsx', 'src/lib/lazyImports.ts'],
  },
];

function formatDateTimeAr(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ar-SA', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export const AdminEngineeringArchitectPage: React.FC<AdminEngineeringArchitectPageProps> = ({
  onBackToProducts,
}) => {
  const [workspace, setWorkspace] = useState<WorkspaceStatePayload>({
    scans: [],
    findings: [],
    proposals: [],
    auditLogs: [],
    chatMessages: [],
    repoSummary: {
      inspectableCount: 0,
      inspectableFiles: [],
      protectedSecretFilesCount: 0,
    },
  });

  const [loading, setLoading] = useState(true);
  const [scanningScope, setScanningScope] = useState<EngineeringScanScope | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Active workspace section
  const [activeSection, setActiveSection] = useState<'issues' | 'proposals' | 'history' | 'files'>('issues');

  // Findings filters
  const [categoryFilter, setCategoryFilter] = useState<'all' | EngineeringFindingCategory>('all');
  const [domainFilter, setDomainFilter] = useState<'all' | EngineeringDomain>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showTransparencyDetails, setShowTransparencyDetails] = useState(false);

  // Proposal actions & custom diff composer
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [creatingFromFindingId, setCreatingFromFindingId] = useState<string | null>(null);
  const [reverifyingFindingId, setReverifyingFindingId] = useState<string | null>(null);
  const [showCustomComposer, setShowCustomComposer] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [customRationale, setCustomRationale] = useState('');
  const [customFilePath, setCustomFilePath] = useState('');
  const [customOriginal, setCustomOriginal] = useState('');
  const [customProposed, setCustomProposed] = useState('');
  const [customVerification, setCustomVerification] = useState<'typecheck' | 'typecheck_and_tests'>('typecheck');
  const [submittingCustom, setSubmittingCustom] = useState(false);

  // Safe file reader
  const [selectedFileToRead, setSelectedFileToRead] = useState('src/App.tsx');
  const [readStartLine, setReadStartLine] = useState('1');
  const [readEndLine, setReadEndLine] = useState('120');
  const [fileContentPreview, setFileContentPreview] = useState<{
    file: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    numberedContent: string;
    writeProtection?: { protected: boolean; reason?: string };
    runtimeDiagnostics?: {
      layer: EngineeringRuntimeLayer;
      reachability: string;
      clientChain: string[] | null;
      serverChain: string[] | null;
    } | null;
  } | null>(null);
  const [readingFile, setReadingFile] = useState(false);

  // Engineering Chat
  const [chatInput, setChatInput] = useState('');
  const [chatTargetFile, setChatTargetFile] = useState('');
  const [sendingChat, setSendingChat] = useState(false);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/workspace', { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر تحميل مساحة عمل المستشار الهندسي.');
      setWorkspace(data);
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'حدث خطأ في الاتصال بالخادم.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const handleRunScan = async (scope: EngineeringScanScope) => {
    setScanningScope(scope);
    setBanner(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'فشل تشغيل الفحص.');
      setWorkspace(data.workspace);
      setActiveSection('issues');
      setBanner({ type: 'success', text: data.scan.summary_ar });
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر إتمام الفحص الهندسي.' });
    } finally {
      setScanningScope(null);
    }
  };

  const handleReverifyFinding = async (findingId: string, proposalId?: string | null) => {
    setReverifyingFindingId(findingId);
    setBanner(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(`/api/admin/engineering-architect/findings/${findingId}/reverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(proposalId ? { proposalId } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر إعادة فحص المشكلة.');
      setWorkspace(data.workspace);
      setBanner({
        type: data.verification?.disappeared ? 'success' : 'info',
        text: data.verification?.summary_ar || 'تمت إعادة الفحص.',
      });
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'فشل إعادة فحص المشكلة.' });
    } finally {
      setReverifyingFindingId(null);
    }
  };

  const handleReadFile = async (targetPath?: string, sLine = 1, eLine = 140) => {
    const fileToOpen = targetPath || selectedFileToRead;
    if (!fileToOpen.trim()) return;
    setSelectedFileToRead(fileToOpen);
    setReadStartLine(String(sLine));
    setReadEndLine(String(eLine));
    setReadingFile(true);
    setActiveSection('files');
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          filePath: fileToOpen.trim(),
          startLine: sLine,
          endLine: eLine,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر قراءة الملف.');
      setFileContentPreview(data);
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر قراءة الملف المحدد.' });
    } finally {
      setReadingFile(false);
    }
  };

  const handleCreateProposalFromFinding = async (findingId: string) => {
    setCreatingFromFindingId(findingId);
    setBanner(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ findingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر إعداد عرض الإصلاح.');
      setWorkspace(data.workspace);
      setActiveSection('proposals');
      setBanner({
        type: 'info',
        text: `تم إعداد عرض الإصلاح (${data.proposal.title_ar}). راجع الفرق (قبل / بعد) ثم وافق صراحةً قبل التنفيذ.`,
      });
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر إعداد عرض الإصلاح لهذه الملاحظة.' });
    } finally {
      setCreatingFromFindingId(null);
    }
  };

  const handleSubmitCustomProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingCustom(true);
    setBanner(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          title_ar: customTitle,
          rationale_ar: customRationale,
          verification_command: customVerification,
          edits: [
            {
              file_path: customFilePath,
              original_excerpt: customOriginal,
              proposed_excerpt: customProposed,
            },
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر إنشاء عرض التعديل.');
      setWorkspace(data.workspace);
      setShowCustomComposer(false);
      setCustomTitle('');
      setCustomRationale('');
      setCustomOriginal('');
      setCustomProposed('');
      setBanner({
        type: 'success',
        text: `تم إعداد عرض الإصلاح (${data.proposal.title_ar}) وهو بانتظار موافقتك الصريحة.`,
      });
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'فشل التحقق من مطابقة النص الأصلي أو الملف محمي.' });
    } finally {
      setSubmittingCustom(false);
    }
  };

  const handleProposalAction = async (
    proposalId: string,
    action: 'approve' | 'reject' | 'apply' | 'rollback'
  ) => {
    setBusyProposalId(proposalId);
    setBanner(null);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch(`/api/admin/engineering-architect/proposals/${proposalId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(action === 'approve' ? { approve: true } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'فشل تنفيذ الإجراء.');
      setWorkspace(data.workspace);

      if (action === 'approve') {
        setBanner({ type: 'info', text: 'تم اعتماد الإصلاح إدارياً. اضغط «تنفيذ الإصلاح المعتمد وتشغيل التحقق» للتطبيق.' });
      } else if (action === 'reject') {
        setBanner({ type: 'info', text: 'تم رفض العرض دون أي تعديل على ملفات المتجر.' });
      } else if (action === 'apply') {
        const appliedOk = data.proposal?.status === 'applied';
        setBanner({
          type: appliedOk ? 'success' : 'error',
          text: data.proposal?.execution_report?.summary_ar || 'اكتمل التنفيذ.',
        });
      } else {
        setBanner({ type: 'success', text: 'تم التراجع واستعادة النسخة الأصلية للملفات بنجاح.' });
      }
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'حدث خطأ أثناء معالجة العرض.' });
    } finally {
      setBusyProposalId(null);
    }
  };

  const handleSendChat = async (overrideText?: string, overrideTargets?: string[]) => {
    const text = (overrideText ?? chatInput).trim();
    if (!text || sendingChat) return;
    setSendingChat(true);
    setBanner(null);
    const targetFiles = overrideTargets || (chatTargetFile ? [chatTargetFile] : []);
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ message: text, targetFiles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر إرسال الاستشارة الهندسية.');
      setWorkspace(data.workspace);
      if (!overrideText) setChatInput('');
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'فشل الاتصال بالمستشار الهندسي.' });
    } finally {
      setSendingChat(false);
    }
  };

  const handleClearChat = async () => {
    try {
      const headers = await getAuthHeadersAsync();
      const res = await fetch('/api/admin/engineering-architect/chat', {
        method: 'DELETE',
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذر مسح المحادثة.');
      setWorkspace((prev) => ({ ...prev, chatMessages: data.chatMessages }));
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر مسح المحادثة.' });
    }
  };

  const counts = useMemo(() => {
    return {
      confirmed_issue: workspace.findings.filter((f) => f.category === 'confirmed_issue').length,
      potential_issue: workspace.findings.filter((f) => f.category === 'potential_issue').length,
      improvement: workspace.findings.filter((f) => f.category === 'improvement').length,
      verified_fixed: workspace.findings.filter((f) => f.category === 'verified_fixed').length,
    };
  }, [workspace.findings]);

  const filteredFindings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return workspace.findings.filter((f) => {
      if (categoryFilter !== 'all' && f.category !== categoryFilter) return false;
      if (domainFilter !== 'all' && f.domain !== domainFilter) return false;
      if (q) {
        const hay = `${f.title_ar} ${f.description_ar} ${f.affected_files.join(' ')} ${f.root_cause_ar}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [workspace.findings, categoryFilter, domainFilter, searchQuery]);

  const latestScan = workspace.scans[0] || null;
  const pendingApprovalCount = workspace.proposals.filter(
    (p) => p.status === 'pending_approval' || p.status === 'approved'
  ).length;

  return (
    <div dir="rtl" className="space-y-5 text-stone-900">
      {/* Header & Primary Engineering Audit Controls */}
      <section className="rounded-2xl border border-stone-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-stone-200 pb-5">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold text-rose-700 mb-1.5">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>نظام مستقل لجودة الموقع والأمان الهندسي · معزول عن المستشار البرمجي الأول</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-stone-900 tracking-tight">
              المستشار الهندسي الذكي — Amazon Duaa AI Engineering Architect
            </h2>
            <p className="text-xs sm:text-sm text-stone-600 mt-1 max-w-3xl leading-relaxed">
              يفحص ملفات المشروع الفعلية، يميّز بين المشكلات المؤكدة والمحتملة والتحسينات، ويعرض التغييرات الدقيقة للموافقة الإدارية قبل أي تنفيذ مع التحقق الآلي والتراجع الآمن.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={loadWorkspace}
              disabled={loading}
              className="px-3 py-2 rounded-xl border border-stone-200 bg-stone-50 hover:bg-stone-100 text-xs font-bold text-stone-700 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>تحديث</span>
            </button>
            {onBackToProducts && (
              <button
                type="button"
                onClick={onBackToProducts}
                className="px-3.5 py-2 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-xs font-bold text-stone-700 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span>العودة للمنتجات</span>
              </button>
            )}
          </div>
        </div>

        {/* 4 Dedicated Scan Buttons */}
        <div className="pt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={scanningScope !== null}
              onClick={() => handleRunScan('comprehensive')}
              className="px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white text-xs font-bold flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              {scanningScope === 'comprehensive' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 text-rose-400" />
              )}
              <span>فحص شامل للموقع</span>
            </button>

            <button
              type="button"
              disabled={scanningScope !== null}
              onClick={() => handleRunScan('security')}
              className="px-4 py-2.5 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 disabled:opacity-60 text-rose-800 text-xs font-bold flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              {scanningScope === 'security' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ShieldAlert className="w-4 h-4" />
              )}
              <span>فحص أمني</span>
            </button>

            <button
              type="button"
              disabled={scanningScope !== null}
              onClick={() => handleRunScan('ui_design')}
              className="px-4 py-2.5 rounded-xl border border-stone-200 bg-stone-50 hover:bg-stone-100 disabled:opacity-60 text-stone-800 text-xs font-bold flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              {scanningScope === 'ui_design' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Layers className="w-4 h-4 text-stone-600" />
              )}
              <span>فحص الواجهات والتصميم</span>
            </button>

            <button
              type="button"
              disabled={scanningScope !== null}
              onClick={() => handleRunScan('performance')}
              className="px-4 py-2.5 rounded-xl border border-stone-200 bg-stone-50 hover:bg-stone-100 disabled:opacity-60 text-stone-800 text-xs font-bold flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              {scanningScope === 'performance' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Gauge className="w-4 h-4 text-stone-600" />
              )}
              <span>فحص الأداء</span>
            </button>
          </div>

          <div className="text-xs text-stone-500 font-medium tabular-nums flex items-center gap-2">
            <span>ملفات قابلة للفحص: {workspace.repoSummary.inspectableCount}</span>
            <span>·</span>
            <span>ملفات أسرار محجوبة: {workspace.repoSummary.protectedSecretFilesCount}</span>
          </div>
        </div>
      </section>

      {/* Inline Status Banner */}
      {banner && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 flex items-start justify-between gap-3 text-xs sm:text-sm font-medium ${
            banner.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : banner.type === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-900'
              : 'border-sky-200 bg-sky-50 text-sky-900'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {banner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            ) : banner.type === 'error' ? (
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span>{banner.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="إغلاق التنبيه"
            className="text-current/70 hover:text-current cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 4 Real Finding Category Counters (Zero Fake Telemetry Scores) */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => { setCategoryFilter('confirmed_issue'); setActiveSection('issues'); }}
          className="text-right rounded-xl border border-stone-200 bg-white p-4 hover:border-rose-300 transition-colors cursor-pointer"
        >
          <div className="text-xs font-bold text-rose-700">مشكلات مؤكدة</div>
          <div className="text-2xl font-black text-stone-900 mt-1 tabular-nums">{counts.confirmed_issue}</div>
          <div className="text-[11px] text-stone-500 mt-0.5">موثقة بدليل من القرص</div>
        </button>

        <button
          type="button"
          onClick={() => { setCategoryFilter('potential_issue'); setActiveSection('issues'); }}
          className="text-right rounded-xl border border-stone-200 bg-white p-4 hover:border-amber-300 transition-colors cursor-pointer"
        >
          <div className="text-xs font-bold text-amber-700">مشكلات محتملة</div>
          <div className="text-2xl font-black text-stone-900 mt-1 tabular-nums">{counts.potential_issue}</div>
          <div className="text-[11px] text-stone-500 mt-0.5">تستحق المراجعة والتدقيق</div>
        </button>

        <button
          type="button"
          onClick={() => { setCategoryFilter('improvement'); setActiveSection('issues'); }}
          className="text-right rounded-xl border border-stone-200 bg-white p-4 hover:border-sky-300 transition-colors cursor-pointer"
        >
          <div className="text-xs font-bold text-sky-700">تحسينات مقترحة</div>
          <div className="text-2xl font-black text-stone-900 mt-1 tabular-nums">{counts.improvement}</div>
          <div className="text-[11px] text-stone-500 mt-0.5">تجربة المستخدم والأداء</div>
        </button>

        <button
          type="button"
          onClick={() => { setCategoryFilter('verified_fixed'); setActiveSection('issues'); }}
          className="text-right rounded-xl border border-stone-200 bg-white p-4 hover:border-emerald-300 transition-colors cursor-pointer"
        >
          <div className="text-xs font-bold text-emerald-700">متحقق من سلامتها</div>
          <div className="text-2xl font-black text-stone-900 mt-1 tabular-nums">{counts.verified_fixed}</div>
          <div className="text-[11px] text-stone-500 mt-0.5">تم إصلاحها أو فحصها بنجاح</div>
        </button>
      </section>

      {/* Latest Scan Groundedness & Inaccessible Sources Disclosure */}
      {latestScan && (
        <section className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-stone-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">
              <span className="font-bold text-stone-900">آخر فحص:</span> {latestScan.summary_ar} ·{' '}
              <span className="tabular-nums text-stone-500">{formatDateTimeAr(latestScan.completed_at)}</span>
            </div>
            <button
              type="button"
              onClick={() => setShowTransparencyDetails((v) => !v)}
              className="font-bold text-rose-700 hover:text-rose-800 cursor-pointer whitespace-nowrap shrink-0"
            >
              {showTransparencyDetails ? 'إخفاء تفاصيل النطاق' : 'عرض الملفات المفحوصة والمحجوبة'}
            </button>
          </div>
          {showTransparencyDetails && (
            <div className="mt-3 pt-3 border-t border-stone-200 space-y-3">
              {latestScan.layer_breakdown && (
                <div className="text-[11px] font-medium text-stone-700 tabular-nums flex flex-wrap gap-3">
                  <span>تصنيف الطبقات:</span>
                  <span>ملفات خادم: {latestScan.layer_breakdown.server}</span>
                  <span>·</span>
                  <span>ملفات متصفح: {latestScan.layer_breakdown.client}</span>
                  <span>·</span>
                  <span>ملفات مشتركة: {latestScan.layer_breakdown.shared}</span>
                  <span>·</span>
                  <span>قواعد/إعدادات: {latestScan.layer_breakdown.config_rules}</span>
                  {typeof latestScan.firestore_rules_parsed_paths === 'number' && latestScan.firestore_rules_parsed_paths > 0 && (
                    <>
                      <span>·</span>
                      <span>مسارات firestore.rules المحللة: {latestScan.firestore_rules_parsed_paths}</span>
                    </>
                  )}
                </div>
              )}

              {(latestScan.suppressed_notes_ar?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-2.5 text-[11px] text-emerald-900 space-y-1">
                  <div className="font-bold">تصفية الإنذارات الكاذبة حسب مسارات الاستيراد وسياق الخادم/العميل:</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {(latestScan.suppressed_notes_ar ?? []).map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="font-bold text-stone-900 mb-1">
                    ملفات قُرئت فعلياً ({latestScan.files_inspected_count}):
                  </div>
                  <div dir="ltr" className="max-h-36 overflow-y-auto rounded-lg border border-stone-200 bg-white p-2 text-[11px] font-mono text-stone-600 space-y-0.5">
                    {latestScan.inspected_files.map((f) => (
                      <div key={f}>{f}</div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="font-bold text-stone-900 mb-1">مصادر غير متاحة / محجوبة أمنياً:</div>
                  <ul className="rounded-lg border border-stone-200 bg-white p-2.5 text-[11px] text-stone-600 space-y-1 list-disc list-inside">
                    {latestScan.inaccessible_sources.map((src, i) => (
                      <li key={i}>{src}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Main Split Workspace: Engineering Centers (7/12) + Smart Chat (5/12) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Left/Right Main Engineering Centers */}
        <div className="xl:col-span-7 space-y-4">
          {/* Segmented Section Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-stone-200 bg-white p-1.5">
            <button
              type="button"
              onClick={() => setActiveSection('issues')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                activeSection === 'issues' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>مركز المشكلات والاقتراحات ({workspace.findings.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('proposals')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                activeSection === 'proposals' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'
              }`}
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span>
                الإصلاحات المعتمدة والمقترحة ({workspace.proposals.length}
                {pendingApprovalCount > 0 ? ` · ${pendingApprovalCount} نشط` : ''})
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('history')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                activeSection === 'history' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>سجل الفحوصات والتعديلات ({workspace.auditLogs.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('files')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                activeSection === 'files' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'
              }`}
            >
              <FileCode2 className="w-3.5 h-3.5" />
              <span>فاحص الملفات الآمن</span>
            </button>
          </div>

          {/* SECTION 1: Discovered Issues & Engineering Suggestions Center */}
          {activeSection === 'issues' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-stone-200 bg-white p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-stone-400 absolute right-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="ابحث في المشكلات أو الملفات..."
                    className="w-full pr-8 pl-3 py-2 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-stone-400"
                  />
                </div>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as any)}
                  className="px-3 py-2 rounded-lg border border-stone-200 text-xs font-medium bg-white"
                >
                  <option value="all">كل التصنيفات</option>
                  <option value="confirmed_issue">مشكلة مؤكدة</option>
                  <option value="potential_issue">مشكلة محتملة</option>
                  <option value="improvement">تحسين مقترح</option>
                  <option value="verified_fixed">تم إصلاحها والتحقق منها</option>
                </select>
                <select
                  value={domainFilter}
                  onChange={(e) => setDomainFilter(e.target.value as any)}
                  className="px-3 py-2 rounded-lg border border-stone-200 text-xs font-medium bg-white"
                >
                  <option value="all">كل المجالات الهندسية</option>
                  {Object.entries(DOMAIN_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              {filteredFindings.length === 0 ? (
                <div className="rounded-xl border border-stone-200 bg-white p-8 text-center">
                  <ShieldCheck className="w-8 h-8 text-stone-400 mx-auto mb-2" />
                  <p className="text-sm font-bold text-stone-800">لا توجد نتائج مطابقة حالياً</p>
                  <p className="text-xs text-stone-500 mt-1">
                    اضغط على «فحص شامل للموقع» أو «فحص أمني» أعلاه لقراءة ملفات المشروع وتحديث النتائج.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredFindings.map((finding) => {
                    const cat = CATEGORY_META[finding.category];
                    return (
                      <article
                        key={finding.id}
                        className="rounded-xl border border-stone-200 bg-white p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2.5">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                            <span className={cat.textClass}>{cat.label}</span>
                            {finding.diagnosis_type && (
                              <>
                                <span className="text-stone-300">·</span>
                                <span className="text-stone-800">{DIAGNOSIS_LABELS[finding.diagnosis_type]}</span>
                              </>
                            )}
                            <span className="text-stone-300">·</span>
                            <span className="text-stone-700">الخطورة: {SEVERITY_LABELS[finding.severity]}</span>
                            <span className="text-stone-300">·</span>
                            <span className="text-stone-500">{DOMAIN_LABELS[finding.domain]}</span>
                            {finding.runtime_layer && (
                              <>
                                <span className="text-stone-300">·</span>
                                <span className="text-stone-600">{RUNTIME_LAYER_LABELS[finding.runtime_layer]}</span>
                              </>
                            )}
                            {typeof finding.confidence_score === 'number' && (
                              <>
                                <span className="text-stone-300">·</span>
                                <span className="text-stone-900 tabular-nums">الثقة: {finding.confidence_score}%</span>
                              </>
                            )}
                          </div>
                          <span className="text-[11px] font-medium text-stone-500 tabular-nums">
                            {formatDateTimeAr(finding.updated_at)}
                          </span>
                        </div>

                        <div>
                          <h3 className="text-sm font-black text-stone-900">{finding.title_ar}</h3>
                          <p className="text-xs text-stone-700 mt-1 leading-relaxed">{finding.description_ar}</p>
                          {finding.confidence_reason_ar && (
                            <p className="text-[11px] text-stone-500 mt-1">
                              <span className="font-bold text-stone-700">أساس التقييم: </span>
                              {finding.confidence_reason_ar}
                            </p>
                          )}
                          {(finding.import_chain?.length ?? 0) > 0 && (
                            <p className="text-[11px] text-stone-500 mt-1">
                              <span className="font-bold text-stone-700">مسار الاستيراد الفعلي: </span>
                              <span dir="ltr" className="font-mono">
                                {(finding.import_chain ?? []).join(' -> ')}
                              </span>
                            </p>
                          )}
                          {finding.needs_runtime_test && finding.runtime_test_hint_ar && (
                            <p className="text-[11px] text-amber-800 mt-1">
                              <span className="font-bold">اختبار تشغيل مطلوب: </span>
                              {finding.runtime_test_hint_ar}
                            </p>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-stone-50 rounded-lg border border-stone-200 p-3">
                          <div>
                            <div className="font-bold text-stone-800 mb-0.5">السبب الجذري:</div>
                            <div className="text-stone-600 leading-relaxed">{finding.root_cause_ar}</div>
                          </div>
                          <div>
                            <div className="font-bold text-stone-800 mb-0.5">الحل المقترح:</div>
                            <div className="text-stone-600 leading-relaxed">{finding.recommended_solution_ar}</div>
                          </div>
                        </div>

                        {finding.last_reverification && (
                          <div
                            className={`rounded-lg border px-3 py-2 text-xs ${
                              finding.last_reverification.disappeared
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                : 'border-amber-200 bg-amber-50 text-amber-900'
                            }`}
                          >
                            <span className="font-bold">نتيجة إعادة الفحص ({finding.last_reverification.mode === 'proposal_simulation' ? 'محاكاة العرض المعدّ' : 'القرص الفعلي'}): </span>
                            <span>{finding.last_reverification.summary_ar}</span>
                          </div>
                        )}

                        {finding.evidence.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="text-[11px] font-bold text-stone-600">
                              أدلة موثقة من ملفات المشروع:
                            </div>
                            <div className="space-y-1">
                              {finding.evidence.slice(0, 3).map((ev, idx) => (
                                <div
                                  key={idx}
                                  dir="ltr"
                                  className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-950 text-stone-100 px-3 py-1.5 text-[11px] font-mono overflow-x-auto"
                                >
                                  <span className="truncate">
                                    <span className="text-rose-400">{ev.file}:{ev.line ?? 1}</span>{' '}
                                    <span className="text-stone-300">{ev.snippet}</span>
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleReadFile(ev.file, Math.max(1, (ev.line ?? 1) - 15), (ev.line ?? 1) + 35)}
                                    className="text-sky-300 hover:text-sky-200 shrink-0 cursor-pointer font-sans text-[11px] font-bold"
                                  >
                                    فتح السطر
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <div className="text-[11px] text-stone-500 font-mono" dir="ltr">
                            {finding.affected_files.join(', ')}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {finding.affected_files[0] && (
                              <button
                                type="button"
                                onClick={() => handleReadFile(finding.affected_files[0], 1, 140)}
                                className="px-3 py-1.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-xs font-bold text-stone-700 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                معاينة الملف
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={reverifyingFindingId === finding.id}
                              onClick={() => handleReverifyFinding(finding.id, finding.proposal_id)}
                              className="px-3 py-1.5 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-100 disabled:opacity-60 text-xs font-bold text-stone-800 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {reverifyingFindingId === finding.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
                              <span>
                                {finding.category === 'verified_fixed' || finding.status === 'applied'
                                  ? 'إعادة فحص بعد الإصلاح'
                                  : 'إعادة فحص المشكلة'}
                              </span>
                            </button>
                            {finding.category !== 'verified_fixed' && !finding.proposal_id && (
                              <button
                                type="button"
                                disabled={creatingFromFindingId === finding.id}
                                onClick={() => handleCreateProposalFromFinding(finding.id)}
                                className="px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {creatingFromFindingId === finding.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Wrench className="w-3.5 h-3.5" />
                                )}
                                <span>إعداد عرض إصلاح للموافقة</span>
                              </button>
                            )}
                            {finding.proposal_id && (
                              <button
                                type="button"
                                onClick={() => setActiveSection('proposals')}
                                className="px-3 py-1.5 rounded-lg border border-sky-200 bg-sky-50 text-sky-800 text-xs font-bold cursor-pointer whitespace-nowrap shrink-0"
                              >
                                عرض الإصلاح المرتبط
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* SECTION 2: Approval-Gated Fix Proposals, Diff Previews & Execution Reports */}
          {activeSection === 'proposals' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-stone-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black text-stone-900">
                    بوابة الموافقة والتنفيذ الآمن (Approval-Gated Execution)
                  </h3>
                  <p className="text-xs text-stone-500 mt-0.5">
                    يُمنع تعديل أي ملف قبل معاينة الفرق (قبل / بعد) وموافقة المدير الصريحة، مع تشغيل TypeScript تلقائياً والتراجع الفوري عند الفشل.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCustomComposer((v) => !v)}
                  className="px-3.5 py-2 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-100 text-xs font-bold text-stone-800 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {showCustomComposer ? 'إغلاق المحرر' : '+ إعداد عرض تعديل مخصص'}
                </button>
              </div>

              {showCustomComposer && (
                <form
                  onSubmit={handleSubmitCustomProposal}
                  className="rounded-xl border border-stone-200 bg-white p-4 space-y-3"
                >
                  <div className="text-xs font-black text-stone-900">إنشاء عرض تعديل دقيق (بانتظار الموافقة)</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-stone-600 mb-1">عنوان الإصلاح</label>
                      <input
                        type="text"
                        required
                        value={customTitle}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        placeholder="مثال: تحسين تحميل الصور في الواجهة"
                        className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-stone-600 mb-1">مسار الملف الفعلي</label>
                      <input
                        type="text"
                        dir="ltr"
                        required
                        value={customFilePath}
                        onChange={(e) => setCustomFilePath(e.target.value)}
                        placeholder="src/components/..."
                        className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-stone-600 mb-1">السبب الهندسي</label>
                    <input
                      type="text"
                      required
                      value={customRationale}
                      onChange={(e) => setCustomRationale(e.target.value)}
                      placeholder="شرح مختصر لسبب التعديل وأثره المتوقع"
                      className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-stone-600 mb-1">
                        النص الأصلي المطابق حرفياً في الملف (قبل)
                      </label>
                      <textarea
                        dir="ltr"
                        rows={4}
                        required
                        value={customOriginal}
                        onChange={(e) => setCustomOriginal(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-stone-600 mb-1">
                        النص المقترح البديل (بعد)
                      </label>
                      <textarea
                        dir="ltr"
                        rows={4}
                        required
                        value={customProposed}
                        onChange={(e) => setCustomProposed(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <select
                      value={customVerification}
                      onChange={(e) => setCustomVerification(e.target.value as any)}
                      className="px-3 py-2 rounded-lg border border-stone-200 text-xs bg-white"
                    >
                      <option value="typecheck">فحص TypeScript بعد التنفيذ (tsc --noEmit)</option>
                      <option value="typecheck_and_tests">فحص TypeScript + اختبارات الصحة</option>
                    </select>
                    <button
                      type="submit"
                      disabled={submittingCustom}
                      className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      {submittingCustom && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>حفظ العرض للمراجعة والموافقة</span>
                    </button>
                  </div>
                </form>
              )}

              {workspace.proposals.length === 0 ? (
                <div className="rounded-xl border border-stone-200 bg-white p-8 text-center">
                  <Wrench className="w-8 h-8 text-stone-400 mx-auto mb-2" />
                  <p className="text-sm font-bold text-stone-800">لا توجد عروض إصلاح مجهزة بعد</p>
                  <p className="text-xs text-stone-500 mt-1">
                    اختر أي ملاحظة من «مركز المشكلات» واضغط «إعداد عرض إصلاح للموافقة» أو أنشئ عرضاً مخصصاً.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {workspace.proposals.map((prop) => {
                    const st = PROPOSAL_STATUS_META[prop.status];
                    const isBusy = busyProposalId === prop.id;
                    return (
                      <article
                        key={prop.id}
                        className="rounded-xl border border-stone-200 bg-white p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2.5">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                            <span className={st.textClass}>{st.label}</span>
                            <span className="text-stone-300">·</span>
                            <span dir="ltr" className="font-mono text-stone-600">
                              {prop.affected_files.join(', ')}
                            </span>
                          </div>
                          <span className="text-[11px] text-stone-500 tabular-nums">
                            {formatDateTimeAr(prop.updated_at)}
                          </span>
                        </div>

                        <div>
                          <h4 className="text-sm font-black text-stone-900">{prop.title_ar}</h4>
                          <p className="text-xs text-stone-600 mt-1 leading-relaxed">{prop.rationale_ar}</p>
                        </div>

                        {/* Diff Previews */}
                        <div className="space-y-2">
                          {prop.file_diffs.map((diff, i) => (
                            <div key={i} className="rounded-lg border border-stone-200 overflow-hidden">
                              <div
                                dir="ltr"
                                className="bg-stone-100 px-3 py-1.5 text-[11px] font-mono font-bold text-stone-700 border-b border-stone-200"
                              >
                                {diff.file_path}
                              </div>
                              <pre
                                dir="ltr"
                                className="bg-stone-950 text-stone-100 p-3 text-[11px] font-mono overflow-x-auto leading-relaxed whitespace-pre-wrap"
                              >
                                {diff.diff_preview}
                              </pre>
                            </div>
                          ))}
                        </div>

                        {/* Execution Report */}
                        {prop.execution_report && (
                          <div
                            className={`rounded-lg border p-3 text-xs space-y-1.5 ${
                              prop.execution_report.success
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                : 'border-rose-200 bg-rose-50 text-rose-900'
                            }`}
                          >
                            <div className="font-bold">{prop.execution_report.summary_ar}</div>
                            <div className="text-[11px] flex flex-wrap gap-3 tabular-nums">
                              <span>
                                فحص TypeScript:{' '}
                                {prop.execution_report.typecheck_passed ? 'ناجح' : 'فشل'}
                              </span>
                              {prop.execution_report.tests_passed !== null && (
                                <span>
                                  الاختبارات: {prop.execution_report.tests_passed ? 'ناجحة' : 'فشلت'}
                                </span>
                              )}
                            </div>
                            {prop.execution_report.command_output && (
                              <pre
                                dir="ltr"
                                className="mt-1.5 max-h-28 overflow-y-auto rounded bg-white/80 border border-current/15 p-2 text-[10px] font-mono text-stone-800 whitespace-pre-wrap"
                              >
                                {prop.execution_report.command_output}
                              </pre>
                            )}
                          </div>
                        )}

                        {/* Explicit Admin Approval & Execution Actions */}
                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                          {prop.finding_id && (
                            <button
                              type="button"
                              disabled={reverifyingFindingId === prop.finding_id}
                              onClick={() => handleReverifyFinding(prop.finding_id!, prop.id)}
                              className="px-3.5 py-2 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-100 disabled:opacity-60 text-xs font-bold text-stone-800 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {reverifyingFindingId === prop.finding_id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
                              <span>إعادة فحص المشكلة</span>
                            </button>
                          )}

                          {prop.status === 'pending_approval' && (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleProposalAction(prop.id, 'reject')}
                                className="px-3.5 py-2 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-xs font-bold text-stone-700 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                رفض التعديل
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleProposalAction(prop.id, 'approve')}
                                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                <span>موافقة واعتماد الإصلاح</span>
                              </button>
                            </>
                          )}

                          {prop.status === 'approved' && (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleProposalAction(prop.id, 'reject')}
                                className="px-3.5 py-2 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-xs font-bold text-stone-700 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                إلغاء قبل التنفيذ
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleProposalAction(prop.id, 'apply')}
                                className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                <span>تنفيذ الإصلاح المعتمد وتشغيل التحقق</span>
                              </button>
                            </>
                          )}

                          {prop.status === 'applied' && prop.execution_report?.rollback_available && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleProposalAction(prop.id, 'rollback')}
                              className="px-3.5 py-2 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 disabled:opacity-60 text-rose-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                              <span>تراجع واستعادة النسخة الأصلية</span>
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* SECTION 3: Scan History & Executed Edits Audit Log */}
          {activeSection === 'history' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-stone-200 bg-white p-4 space-y-3">
                <h3 className="text-sm font-black text-stone-900">سجل الفحوصات السابقة</h3>
                {workspace.scans.length === 0 ? (
                  <p className="text-xs text-stone-500">لم تُسجّل عمليات فحص سابقة بعد.</p>
                ) : (
                  <div className="space-y-2">
                    {workspace.scans.map((scan) => (
                      <div
                        key={scan.id}
                        className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 font-bold text-stone-900">
                          <span>{scan.summary_ar}</span>
                          <span className="text-[11px] text-stone-500 tabular-nums">
                            {formatDateTimeAr(scan.completed_at)}
                          </span>
                        </div>
                        <div className="text-[11px] text-stone-600 tabular-nums">
                          ملفات مقروءة: {scan.files_inspected_count} · مؤكدة: {scan.counts.confirmed_issue} · محتملة:{' '}
                          {scan.counts.potential_issue} · تحسينات: {scan.counts.improvement}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-stone-200 bg-white p-4 space-y-3">
                <h3 className="text-sm font-black text-stone-900">سجل التعديلات المنفذة والتدقيق وتقارير النجاح والفشل</h3>
                {workspace.auditLogs.length === 0 ? (
                  <p className="text-xs text-stone-500">لا توجد أحداث مسجلة في السجل بعد.</p>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {workspace.auditLogs.map((log) => (
                      <div key={log.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs">
                        <div>
                          <div className="flex items-center gap-2 font-bold">
                            <span className={log.success ? 'text-emerald-700' : 'text-rose-700'}>
                              {log.success ? 'ناجح' : 'فشل'}
                            </span>
                            <span className="text-stone-300">·</span>
                            <span className="text-stone-900">{AUDIT_ACTION_LABELS[log.action]}</span>
                            <span className="text-stone-300">·</span>
                            <span className="text-stone-500 font-medium">{log.actor}</span>
                          </div>
                          <div className="text-stone-700 mt-0.5">{log.summary_ar}</div>
                          {log.affected_files.length > 0 && (
                            <div dir="ltr" className="text-[11px] font-mono text-stone-500 mt-0.5">
                              {log.affected_files.join(', ')}
                            </div>
                          )}
                        </div>
                        <div className="text-[11px] text-stone-500 tabular-nums shrink-0">
                          {formatDateTimeAr(log.timestamp)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SECTION 4: Safe Read-Only Workspace File Inspector */}
          {activeSection === 'files' && (
            <div className="rounded-xl border border-stone-200 bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-end gap-2.5">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    اختر ملفاً لقراءته مباشرة من المستودع
                  </label>
                  <select
                    dir="ltr"
                    value={selectedFileToRead}
                    onChange={(e) => setSelectedFileToRead(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs font-mono bg-white"
                  >
                    {workspace.repoSummary.inspectableFiles.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-20">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">من سطر</label>
                  <input
                    type="number"
                    min={1}
                    value={readStartLine}
                    onChange={(e) => setReadStartLine(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-lg border border-stone-200 text-xs tabular-nums"
                  />
                </div>
                <div className="w-20">
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">إلى سطر</label>
                  <input
                    type="number"
                    min={1}
                    value={readEndLine}
                    onChange={(e) => setReadEndLine(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-lg border border-stone-200 text-xs tabular-nums"
                  />
                </div>
                <button
                  type="button"
                  disabled={readingFile}
                  onClick={() =>
                    handleReadFile(selectedFileToRead, Number(readStartLine) || 1, Number(readEndLine) || 140)
                  }
                  className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {readingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                  <span>قراءة الملف</span>
                </button>
              </div>

              {fileContentPreview && (
                <div className="rounded-xl border border-stone-200 overflow-hidden">
                  <div className="bg-stone-50 px-3.5 py-2 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-mono font-bold text-stone-800">
                        {fileContentPreview.file} ({fileContentPreview.startLine}–{fileContentPreview.endLine} /{' '}
                        {fileContentPreview.totalLines})
                      </span>
                      {fileContentPreview.runtimeDiagnostics && (
                        <>
                          <span className="text-stone-300">·</span>
                          <span className="font-bold text-stone-700">
                            {RUNTIME_LAYER_LABELS[fileContentPreview.runtimeDiagnostics.layer]}
                          </span>
                        </>
                      )}
                    </div>
                    {fileContentPreview.writeProtection?.protected ? (
                      <span className="text-rose-700 font-bold flex items-center gap-1">
                        <Lock className="w-3.5 h-3.5" />
                        <span>محمي من التعديل الآلي</span>
                      </span>
                    ) : (
                      <span className="text-emerald-700 font-bold">قابل لإعداد عروض تعديل معتمدة</span>
                    )}
                  </div>
                  <pre
                    dir="ltr"
                    className="bg-stone-950 text-stone-100 p-3.5 text-[11px] font-mono max-h-[440px] overflow-auto leading-relaxed"
                  >
                    {fileContentPreview.numberedContent}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Side Column: Grounded Engineering Chat */}
        <aside className="xl:col-span-5 rounded-2xl border border-stone-200 bg-white flex flex-col overflow-hidden">
          <div className="px-4 py-3.5 border-b border-stone-200 flex items-center justify-between gap-2 bg-stone-50">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-rose-600 shrink-0" />
              <div>
                <h3 className="text-sm font-black text-stone-900">المحادثة الهندسية الذكية</h3>
                <p className="text-[11px] text-stone-500">مرتكزة على قراءة الملفات الفعلية دون اختلاق</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClearChat}
              title="مسح سجل المحادثة"
              className="p-1.5 rounded-lg text-stone-500 hover:text-rose-700 hover:bg-stone-100 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* Quick Engineering Prompts */}
          <div className="px-3.5 py-2.5 border-b border-stone-200 bg-white flex flex-wrap gap-1.5">
            {QUICK_CHAT_PROMPTS.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={sendingChat}
                onClick={() => handleSendChat(q.prompt, q.targetFiles)}
                className="px-2.5 py-1.5 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-100 text-[11px] font-bold text-stone-700 cursor-pointer whitespace-nowrap shrink-0"
              >
                {q.label}
              </button>
            ))}
          </div>

          {/* Chat Thread */}
          <div className="p-4 space-y-3 max-h-[480px] min-h-[300px] overflow-y-auto bg-stone-50/50">
            {workspace.chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-xl border p-3 text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'border-stone-800 bg-stone-900 text-white mr-6'
                    : 'border-stone-200 bg-white text-stone-800 ml-2'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-[10px] opacity-75 mb-1">
                  <span className="font-bold">
                    {msg.role === 'user' ? 'المدير' : 'المستشار الهندسي الذكي'}
                  </span>
                  <span className="tabular-nums">{formatDateTimeAr(msg.timestamp)}</span>
                </div>
                <div className="whitespace-pre-wrap">{msg.text}</div>

                {msg.role === 'assistant' && ((msg.evidence_files?.length ?? 0) > 0 || (msg.uninspected_notes?.length ?? 0) > 0) && (
                  <div className="mt-2.5 pt-2 border-t border-stone-100 space-y-1 text-[11px]">
                    {(msg.evidence_files?.length ?? 0) > 0 && (
                      <div className="text-emerald-800">
                        <span className="font-bold">ملفات فُحصت فعلياً: </span>
                        <span dir="ltr" className="font-mono">
                          {(msg.evidence_files ?? []).join(', ')}
                        </span>
                      </div>
                    )}
                    {(msg.uninspected_notes?.length ?? 0) > 0 && (
                      <div className="text-stone-500">
                        <span className="font-bold">مصادر غير متاحة: </span>
                        <span>{(msg.uninspected_notes ?? []).join(' · ')}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {sendingChat && (
              <div className="rounded-xl border border-stone-200 bg-white p-3 text-xs text-stone-600 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
                <span>جاري قراءة الملفات الفعلية وتحليل الطلب هندسياً...</span>
              </div>
            )}
          </div>

          {/* Chat Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChat();
            }}
            className="p-3.5 border-t border-stone-200 bg-white space-y-2.5"
          >
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-bold text-stone-600 shrink-0">ملف مستهدف (اختياري):</label>
              <select
                dir="ltr"
                value={chatTargetFile}
                onChange={(e) => setChatTargetFile(e.target.value)}
                className="flex-1 px-2.5 py-1.5 rounded-lg border border-stone-200 text-[11px] font-mono bg-white"
              >
                <option value="">تحديد تلقائي حسب سؤالك</option>
                {workspace.repoSummary.inspectableFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="اسأل المستشار الهندسي عن خطأ برمجي، أمان Firestore، تصميم الجوال، أو اطلب مراجعة ملف معين..."
                className="flex-1 px-3 py-2 rounded-xl border border-stone-200 text-xs resize-none focus:outline-none focus:border-stone-400"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || sendingChat}
                className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>إرسال</span>
              </button>
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
};

export default AdminEngineeringArchitectPage;
