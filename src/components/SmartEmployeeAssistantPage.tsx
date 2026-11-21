import React, { useState, useEffect, useRef } from 'react';
import {
  Bot,
  Send,
  ImagePlus,
  Images,
  Layers,
  Video,
  MessageSquareText,
  LogOut,
  ArrowRight,
  CheckCircle2,
  Clock,
  Sparkles,
  FileText,
  X,
  Loader2,
  ShieldAlert,
  UserCheck,
  PanelLeftOpen,
  Tag,
  Package,
} from 'lucide-react';
import type {
  EmployeeDraft,
  EmployeeDraftSourceType,
  EmployeeSession,
  StoreSettings,
} from '../types';
import {
  clearEmployeeSession,
  getAuthHeaders,
  getAuthHeadersAsync,
  getEmployeeAuthHeaders,
  getEmployeeSession,
  hasActiveAuthSession,
  setEmployeeSession,
} from '../lib/storage';
import { compressImageFileToDataUrl } from '../lib/imageCompression';

interface SmartEmployeeAssistantPageProps {
  settings: StoreSettings;
  onBackToStore: () => void;
  isAdminLoggedIn?: boolean;
  onDraftSaved?: () => void;
}

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  timestamp: string;
  attachments?: {
    images: string[];
    videoName?: string;
    mode: EmployeeDraftSourceType;
  };
  draftCandidates?: Array<
    Omit<EmployeeDraft, 'id' | 'employee_code' | 'created_at' | 'updated_at'> & {
      _saved?: boolean;
      _saving?: boolean;
    }
  >;
}

const VALID_CODES = [
  'EMP001',
  'EMP002',
  'EMP003',
  'EMP004',
  'EMP005',
  'EMP006',
  'EMP007',
  'EMP008',
];

const MODE_OPTIONS: Array<{
  id: EmployeeDraftSourceType;
  label: string;
  shortLabel: string;
  hint: string;
  icon: React.FC<{ className?: string }>;
}> = [
  {
    id: 'single_image',
    label: 'صورة واحدة',
    shortLabel: 'صورة واحدة',
    hint: 'ارفع صورة منتج واحد ليتم استخراج بياناته بالكامل',
    icon: ImagePlus,
  },
  {
    id: 'multi_image_single_product',
    label: 'عدة صور لنفس المنتج',
    shortLabel: 'عدة صور لمنتج',
    hint: 'ارفع زوايا متعددة لنفس المنتج وادمجها في مسودة واحدة',
    icon: Images,
  },
  {
    id: 'batch_images',
    label: 'عدة منتجات دفعة واحدة',
    shortLabel: 'دفعة منتجات',
    hint: 'ارفع صور منتجات مختلفة لتوليد مسودة منفصلة لكل منتج',
    icon: Layers,
  },
  {
    id: 'video',
    label: 'فيديو كتالوج المورد',
    shortLabel: 'فيديو كتالوج',
    hint: 'ارفع فيديو من المورد لاستخراج المنتجات المعروضة تلقائياً',
    icon: Video,
  },
  {
    id: 'whatsapp_chat',
    label: 'لصق محادثة واتساب',
    shortLabel: 'محادثة واتساب',
    hint: 'الصق رسالة أو كتالوج المورد من واتساب في خانة الدردشة',
    icon: MessageSquareText,
  },
];

export const SmartEmployeeAssistantPage: React.FC<SmartEmployeeAssistantPageProps> = ({
  settings,
  onBackToStore,
  isAdminLoggedIn = false,
  onDraftSaved,
}) => {
  const [employeeSession, setLocalEmployeeSession] = useState<EmployeeSession | null>(
    getEmployeeSession
  );
  const [codeInput, setCodeInput] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [mode, setMode] = useState<EmployeeDraftSourceType>('single_image');
  const [inputText, setInputText] = useState('');
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const [myDrafts, setMyDrafts] = useState<EmployeeDraft[]>([]);
  const [isDraftsDrawerOpen, setIsDraftsDrawerOpen] = useState(false);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-1',
      role: 'assistant',
      timestamp: new Date().toISOString(),
      text: `أهلاً بك في 🤖 المساعد الذكي للموظفين بمتجر "${settings.storeName}".\nاختر طريقة الإدخال أدناه (صورة واحدة، عدة صور لنفس المنتج، دفعة منتجات، فيديو كتالوج المورد، أو محادثة واتساب)، وسأقوم بتحليلها بـ Gemini AI وتجهيز بيانات المنتج بدون سعر — وتظهر تلقائياً في قسم «منتجات مساعد الموظفين» بلوحة تحكم المدير للمراجعة والتسعير والنشر.`,
    },
  ]);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const effectiveAuthHeaders = (): Record<string, string> => {
    const empHeaders = getEmployeeAuthHeaders();
    if (empHeaders.Authorization) return empHeaders;
    if (isAdminLoggedIn) return getAuthHeaders();
    return {};
  };

  const effectiveAuthHeadersAsync = async (): Promise<Record<string, string>> => {
    const empHeaders = getEmployeeAuthHeaders();
    if (empHeaders.Authorization) return empHeaders;
    if (isAdminLoggedIn) return await getAuthHeadersAsync();
    return {};
  };

  const hasAccess = Boolean(employeeSession?.token || isAdminLoggedIn);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAnalyzing]);

  const fetchMyDrafts = async () => {
    const headers = await effectiveAuthHeadersAsync();
    if (!headers.Authorization && !(isAdminLoggedIn && hasActiveAuthSession())) return;
    setLoadingDrafts(true);
    try {
      const res = await fetch('/api/employee-assistant/drafts', {
        credentials: 'include',
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        setMyDrafts(Array.isArray(data.drafts) ? data.drafts : []);
      }
    } catch {
      // Ignore network blip
    } finally {
      setLoadingDrafts(false);
    }
  };

  useEffect(() => {
    if (hasAccess) {
      fetchMyDrafts();
    }
  }, [employeeSession?.token, isAdminLoggedIn]);

  const handleEmployeeLogin = async (codeToSubmit: string) => {
    const normalized = codeToSubmit.trim().toUpperCase();
    if (!normalized) {
      setLoginError('يرجى إدخال رمز الموظف (مثال: EMP001).');
      return;
    }

    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/employee/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeCode: normalized }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        setLoginError(data.error || 'رمز الموظف غير معتمد (EMP001 إلى EMP008 فقط).');
        return;
      }

      const session: EmployeeSession = {
        code: data.employee.code,
        displayName: data.employee.displayName,
        role: 'employee',
        token: data.token,
      };
      setEmployeeSession(session);
      setLocalEmployeeSession(session);
      setCodeInput('');
    } catch {
      setLoginError('تعذر الاتصال بالخادم لتسجيل دخول الموظف.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleEmployeeLogout = () => {
    clearEmployeeSession();
    setLocalEmployeeSession(null);
    setMyDrafts([]);
  };

  const handleImagesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const compressed: string[] = [];
    for (const file of files.slice(0, 10)) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await compressImageFileToDataUrl(file, {
        maxDimension: 900,
        maxDataUrlLength: 260_000,
        initialQuality: 0.78,
      });
      compressed.push(dataUrl);
    }

    if (mode === 'single_image') {
      setSelectedImages(compressed.slice(0, 1));
    } else {
      setSelectedImages((prev) => [...prev, ...compressed].slice(0, 10));
    }
    e.target.value = '';
  };

  const handleVideoSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedVideo(file);
      setMode('video');
    }
    e.target.value = '';
  };

  const handleSendToAssistant = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isAnalyzing) return;

    const trimmedText = inputText.trim();
    if (selectedImages.length === 0 && !selectedVideo && !trimmedText) {
      return;
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      timestamp: new Date().toISOString(),
      text:
        trimmedText ||
        (selectedVideo
          ? `تحليل فيديو كتالوج المورد: ${selectedVideo.name}`
          : `تحليل ${selectedImages.length} صورة بوضع (${MODE_OPTIONS.find((m) => m.id === mode)?.label})`),
      attachments: {
        images: [...selectedImages],
        videoName: selectedVideo?.name,
        mode,
      },
    };

    setMessages((prev) => [...prev, userMsg]);
    const currentImages = [...selectedImages];
    const currentVideo = selectedVideo;
    const currentMode = mode;

    setInputText('');
    setSelectedImages([]);
    setSelectedVideo(null);
    setIsAnalyzing(true);

    try {
      const headers = await effectiveAuthHeadersAsync();
      let res: Response;

      if (currentVideo) {
        const fd = new FormData();
        fd.append('mode', currentMode);
        fd.append('chatText', trimmedText);
        fd.append('files', currentVideo);
        res = await fetch('/api/employee-assistant/analyze', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: fd,
        });
      } else {
        res = await fetch('/api/employee-assistant/analyze', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          credentials: 'include',
          body: JSON.stringify({
            mode: currentMode,
            chatText: trimmedText,
            images: currentImages,
          }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'تعذر تحليل البيانات.');
      }

      const candidates = Array.isArray(data.drafts) ? data.drafts : [];
      const assistantMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        text:
          data.message ||
          `تم استخراج ${candidates.length} مسودة منتج بنجاح (السعر فارغ — بانتظار التسعير من الإدارة). راجع البطاقات واضغط حفظ للإرسال إلى الإدارة.`,
        draftCandidates: candidates.map((d: any) => ({ ...d, _saved: false, _saving: false })),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toISOString(),
          text: `⚠️ حدث خطأ أثناء التحليل: ${err?.message || 'حاول مرة أخرى'}`,
        },
      ]);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSaveCandidateDraft = async (msgId: string, candidateIndex: number) => {
    const targetMsg = messages.find((m) => m.id === msgId);
    const candidate = targetMsg?.draftCandidates?.[candidateIndex];
    if (!candidate || candidate._saved || candidate._saving) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.draftCandidates
          ? {
              ...m,
              draftCandidates: m.draftCandidates.map((c, idx) =>
                idx === candidateIndex ? { ...c, _saving: true } : c
              ),
            }
          : m
      )
    );

    try {
      const headers = await effectiveAuthHeadersAsync();
      const res = await fetch('/api/employee-assistant/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        credentials: 'include',
        body: JSON.stringify({
          title_ar: candidate.title_ar,
          description_ar: candidate.description_ar,
          category_id: candidate.category_id,
          category_name: candidate.category_name,
          brand: candidate.brand,
          size_or_volume: candidate.size_or_volume,
          ingredients: candidate.ingredients,
          how_to_use: candidate.how_to_use,
          tags: candidate.tags,
          image_url: candidate.image_url,
          gallery_images: candidate.gallery_images,
          source_type: candidate.source_type,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'تعذر حفظ المسودة.');
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.draftCandidates
            ? {
                ...m,
                draftCandidates: m.draftCandidates.map((c, idx) =>
                  idx === candidateIndex ? { ...c, _saving: false, _saved: true } : c
                ),
              }
            : m
        )
      );

      await fetchMyDrafts();
      if (onDraftSaved) onDraftSaved();
    } catch (err: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.draftCandidates
            ? {
                ...m,
                draftCandidates: m.draftCandidates.map((c, idx) =>
                  idx === candidateIndex ? { ...c, _saving: false } : c
                ),
              }
            : m
        )
      );
      setMessages((prev) => [
        ...prev,
        {
          id: `save-err-${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toISOString(),
          text: `⚠️ تعذر حفظ المسودة: ${err?.message || 'حاول مجدداً'}`,
        },
      ]);
    }
  };

  const handleSaveAllCandidatesInMessage = async (msgId: string) => {
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg?.draftCandidates) return;
    for (let i = 0; i < targetMsg.draftCandidates.length; i++) {
      if (!targetMsg.draftCandidates[i]._saved) {
        await handleSaveCandidateDraft(msgId, i);
      }
    }
  };

  // =========================================================================
  // LOGIN GATE — CODE ONLY (EMP001 .. EMP008) — NO PIN, NO PASSWORD
  // =========================================================================
  if (!hasAccess) {
    return (
      <div
        dir="rtl"
        className="min-h-screen bg-stone-950 text-stone-100 flex flex-col justify-between p-4 sm:p-6 font-['Cairo',sans-serif]"
      >
        <div className="max-w-lg w-full mx-auto my-auto bg-stone-900 border border-stone-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shadow-lg">
                <Bot className="w-7 h-7 text-white" />
              </div>
              <div>
                <h1 className="text-lg sm:text-xl font-black text-white">
                  المساعد الذكي للموظفين
                </h1>
                <p className="text-xs text-stone-400">
                  Smart Employee Assistant • {settings.storeName}
                </p>
              </div>
            </div>

            <button
              onClick={onBackToStore}
              className="flex items-center gap-1 text-xs font-bold text-stone-300 hover:text-white bg-stone-800 hover:bg-stone-700 px-3 py-2 rounded-xl transition-colors cursor-pointer"
            >
              <ArrowRight className="w-4 h-4" />
              <span>المتجر</span>
            </button>
          </div>

          <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-3.5 text-xs text-amber-200 leading-relaxed flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-300 mb-0.5">دخول برمز الموظف فقط (بدون كلمة مرور)</p>
              <p>
                صلاحيات الموظف مقتصرة على رفع صور وفيديوهات ومحادثات الموردين لإنشاء مسودات بدون أسعار (تنتقل للإدارة للتسعير والنشر).
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleEmployeeLogin(codeInput);
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs font-bold text-stone-300 mb-2">
                أدخل رمز الموظف (EMP001 إلى EMP008)
              </label>
              <input
                type="text"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                placeholder="مثال: EMP001"
                dir="ltr"
                className="w-full bg-stone-950 border border-stone-700 focus:border-rose-500 rounded-2xl px-4 py-3 text-center text-base font-black tracking-widest text-white focus:outline-hidden uppercase"
              />
            </div>

            {loginError && (
              <div className="bg-rose-500/15 border border-rose-500/40 text-rose-300 text-xs font-bold p-3 rounded-xl">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 disabled:opacity-60 text-white font-black py-3.5 rounded-2xl shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              {loginLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <UserCheck className="w-5 h-5" />
              )}
              <span>دخول المساعد الذكي</span>
            </button>
          </form>

          <div>
            <p className="text-[11px] font-bold text-stone-400 mb-2">اختيار سريع لرمز الموظف:</p>
            <div className="grid grid-cols-4 gap-2" dir="ltr">
              {VALID_CODES.map((code) => (
                <button
                  key={code}
                  type="button"
                  disabled={loginLoading}
                  onClick={() => handleEmployeeLogin(code)}
                  className="bg-stone-800 hover:bg-rose-600 text-stone-200 hover:text-white border border-stone-700 hover:border-rose-500 rounded-xl py-2 text-xs font-black transition-all cursor-pointer"
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // CHATGPT-STYLE STANDALONE ASSISTANT WORKSPACE
  // =========================================================================
  const activeIdentityLabel = employeeSession
    ? `${employeeSession.code}`
    : 'مدير المتجر';

  const DraftsSidebarContent = () => (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-stone-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black text-white flex items-center gap-2">
            <FileText className="w-4 h-4 text-amber-400" />
            <span>مسوداتي ({myDrafts.length})</span>
          </h2>
          <p className="text-[11px] text-stone-400 mt-0.5">
            تُحفظ في ai_employee_drafts
          </p>
        </div>
        <button
          onClick={fetchMyDrafts}
          className="text-[11px] font-bold text-rose-400 hover:text-rose-300 bg-stone-800 px-2.5 py-1 rounded-lg cursor-pointer"
        >
          تحديث
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {loadingDrafts ? (
          <div className="text-center py-8 text-stone-400 text-xs flex flex-col items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-rose-400" />
            <span>جاري تحميل المسودات...</span>
          </div>
        ) : myDrafts.length === 0 ? (
          <div className="text-center py-10 px-3 text-stone-500 text-xs space-y-2">
            <Package className="w-8 h-8 mx-auto text-stone-700" />
            <p>لا توجد مسودات محفوظة بعد.</p>
            <p className="text-[11px]">ارفع صورة أو ألصق محادثة ثم اضغط "حفظ كمسودة".</p>
          </div>
        ) : (
          myDrafts.map((draft) => (
            <div
              key={draft.id}
              className="bg-stone-900 border border-stone-800 rounded-2xl p-2.5 flex gap-2.5 items-start"
            >
              <img
                src={draft.image_url}
                alt={draft.title_ar}
                className="w-12 h-12 rounded-xl object-cover shrink-0 bg-stone-800"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-white line-clamp-1">
                  {draft.title_ar}
                </p>
                <p className="text-[10px] text-stone-400 mt-0.5">
                  {draft.category_name} • {draft.employee_code}
                </p>
                <div className="mt-1.5">
                  {draft.status === 'published' ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                      <CheckCircle2 className="w-3 h-3" />
                      تم النشر
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                      <Clock className="w-3 h-3" />
                      بانتظار التسعير من الإدارة
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 bg-stone-950 text-stone-100 flex overflow-hidden font-['Cairo',sans-serif]"
    >
      {/* Desktop Sidebar: Employee Saved Drafts */}
      <aside className="hidden lg:flex w-80 bg-stone-950 border-l border-stone-800 flex-col shrink-0">
        <DraftsSidebarContent />
      </aside>

      {/* Mobile Drawer for Saved Drafts */}
      {isDraftsDrawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setIsDraftsDrawerOpen(false)}
          />
          <div className="relative w-80 max-w-[85vw] bg-stone-950 border-l border-stone-800 h-full z-10 flex flex-col">
            <button
              onClick={() => setIsDraftsDrawerOpen(false)}
              className="absolute top-3 left-3 p-1.5 rounded-lg bg-stone-800 text-stone-300"
              aria-label="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
            <DraftsSidebarContent />
          </div>
        </div>
      )}

      {/* Main ChatGPT-style Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-stone-900">
        {/* Top Bar */}
        <header className="h-14 sm:h-16 px-3 sm:px-6 border-b border-stone-800 bg-stone-950/90 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => setIsDraftsDrawerOpen(true)}
              className="lg:hidden p-2 rounded-xl bg-stone-800 text-stone-200 hover:bg-stone-700"
              title="مسوداتي"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-black text-white truncate">
                المساعد الذكي للموظفين
              </h1>
              <p className="text-[10px] sm:text-[11px] text-amber-300 truncate">
                مسودات فقط • السعر فارغ (بانتظار التسعير من الإدارة)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="inline-flex items-center gap-1 bg-stone-800 border border-stone-700 text-emerald-300 text-xs font-black px-2.5 py-1.5 rounded-xl">
              <UserCheck className="w-3.5 h-3.5" />
              <span>{activeIdentityLabel}</span>
            </span>

            {employeeSession && (
              <button
                onClick={handleEmployeeLogout}
                className="p-2 sm:px-3 sm:py-1.5 rounded-xl bg-stone-800 hover:bg-rose-900/50 text-stone-300 hover:text-rose-300 text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer"
                title="تغيير رمز الموظف"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">خروج</span>
              </button>
            )}

            <button
              onClick={onBackToStore}
              className="px-3 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-white text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              <span>العودة للمتجر</span>
            </button>
          </div>
        </header>

        {/* Chat Messages Feed */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5 space-y-5">
          <div className="max-w-3xl mx-auto space-y-5">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${
                  msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                }`}
              >
                <div
                  className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center shrink-0 font-black text-xs ${
                    msg.role === 'assistant'
                      ? 'bg-gradient-to-br from-rose-500 to-amber-500 text-white'
                      : 'bg-stone-700 text-stone-100'
                  }`}
                >
                  {msg.role === 'assistant' ? <Bot className="w-4 h-4" /> : activeIdentityLabel.slice(0, 3)}
                </div>

                <div
                  className={`flex-1 max-w-[90%] space-y-3 ${
                    msg.role === 'user' ? 'text-left' : 'text-right'
                  }`}
                >
                  <div
                    className={`inline-block rounded-2xl px-4 py-3 text-xs sm:text-sm leading-relaxed whitespace-pre-line text-right ${
                      msg.role === 'user'
                        ? 'bg-rose-600/90 text-white'
                        : 'bg-stone-800 border border-stone-700/80 text-stone-100'
                    }`}
                  >
                    {msg.attachments && msg.attachments.images.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2.5">
                        {msg.attachments.images.map((src, i) => (
                          <img
                            key={i}
                            src={src}
                            alt={`مرفق ${i + 1}`}
                            className="w-16 h-16 rounded-xl object-cover border border-white/20"
                          />
                        ))}
                      </div>
                    )}
                    {msg.attachments?.videoName && (
                      <div className="mb-2 inline-flex items-center gap-1.5 bg-black/30 px-2.5 py-1 rounded-lg text-[11px]">
                        <Video className="w-3.5 h-3.5 text-amber-300" />
                        <span>{msg.attachments.videoName}</span>
                      </div>
                    )}
                    <div>{msg.text}</div>
                  </div>

                  {/* Extracted Draft Cards inside Assistant Message */}
                  {msg.draftCandidates && msg.draftCandidates.length > 0 && (
                    <div className="space-y-3">
                      {msg.draftCandidates.length > 1 && (
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleSaveAllCandidatesInMessage(msg.id)}
                            className="bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>حفظ جميع المسودات ({msg.draftCandidates.length}) للإدارة</span>
                          </button>
                        </div>
                      )}

                      {msg.draftCandidates.map((draft, idx) => (
                        <div
                          key={`${msg.id}-cand-${idx}`}
                          className="bg-stone-950 border border-stone-700 rounded-2xl p-4 space-y-3 text-right shadow-lg"
                        >
                          <div className="flex flex-col sm:flex-row gap-3">
                            <img
                              src={draft.image_url}
                              alt={draft.title_ar}
                              className="w-full sm:w-24 h-40 sm:h-24 rounded-xl object-cover bg-stone-800 shrink-0"
                            />
                            <div className="flex-1 min-w-0 space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-sm sm:text-base font-black text-white">
                                  {draft.title_ar}
                                </h3>
                                <span className="inline-flex items-center gap-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-black px-2.5 py-1 rounded-full">
                                  <Clock className="w-3.5 h-3.5" />
                                  بانتظار التسعير من الإدارة
                                </span>
                              </div>

                              <div className="flex flex-wrap gap-1.5 text-[11px] text-stone-300">
                                <span className="bg-stone-800 px-2 py-0.5 rounded-lg">
                                  الفئة: {draft.category_name}
                                </span>
                                <span className="bg-stone-800 px-2 py-0.5 rounded-lg">
                                  العلامة: {draft.brand}
                                </span>
                                <span className="bg-stone-800 px-2 py-0.5 rounded-lg">
                                  الحجم: {draft.size_or_volume}
                                </span>
                                <span className="bg-stone-800 text-amber-300 px-2 py-0.5 rounded-lg font-bold">
                                  السعر: فارغ (null)
                                </span>
                              </div>

                              <p className="text-xs text-stone-300 leading-relaxed">
                                {draft.description_ar}
                              </p>
                            </div>
                          </div>

                          {draft.gallery_images && draft.gallery_images.length > 1 && (
                            <div className="flex items-center gap-2 overflow-x-auto pb-1">
                              {draft.gallery_images.map((gUrl, gi) => (
                                <img
                                  key={gi}
                                  src={gUrl}
                                  alt={`صورة ${gi + 1}`}
                                  className="w-12 h-12 rounded-lg object-cover border border-stone-700 shrink-0"
                                />
                              ))}
                            </div>
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] bg-stone-900/80 p-3 rounded-xl border border-stone-800">
                            <div>
                              <span className="font-bold text-stone-400">المكونات: </span>
                              <span className="text-stone-200">{draft.ingredients}</span>
                            </div>
                            <div>
                              <span className="font-bold text-stone-400">طريقة الاستخدام: </span>
                              <span className="text-stone-200">{draft.how_to_use}</span>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <div className="flex flex-wrap gap-1">
                              {draft.tags.slice(0, 5).map((tag, ti) => (
                                <span
                                  key={ti}
                                  className="inline-flex items-center gap-1 text-[10px] bg-stone-800 text-stone-300 px-2 py-0.5 rounded-full"
                                >
                                  <Tag className="w-2.5 h-2.5 text-rose-400" />
                                  {tag}
                                </span>
                              ))}
                            </div>

                            <button
                              type="button"
                              disabled={draft._saved || draft._saving}
                              onClick={() => handleSaveCandidateDraft(msg.id, idx)}
                              className={`px-4 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 transition-all cursor-pointer ${
                                draft._saved
                                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 cursor-default'
                                  : 'bg-rose-600 hover:bg-rose-500 text-white shadow-md'
                              }`}
                            >
                              {draft._saving ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  <span>جاري الحفظ...</span>
                                </>
                              ) : draft._saved ? (
                                <>
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>تم الحفظ في «منتجات مساعد الموظفين»</span>
                                </>
                              ) : (
                                <>
                                  <FileText className="w-3.5 h-3.5" />
                                  <span>حفظ كمسودة (بانتظار التسعير)</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isAnalyzing && (
              <div className="flex gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0">
                  <Loader2 className="w-4 h-4 text-white animate-spin" />
                </div>
                <div className="bg-stone-800 border border-stone-700 rounded-2xl px-4 py-3 text-xs sm:text-sm text-stone-300">
                  جاري تحليل الملفات عبر Gemini AI واستخراج بيانات المنتج بدون سعر...
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>
        </div>

        {/* ChatGPT-style Bottom Composer */}
        <div className="border-t border-stone-800 bg-stone-950 p-3 sm:p-4 shrink-0">
          <div className="max-w-3xl mx-auto space-y-2.5">
            {/* Mode Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
              {MODE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = mode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setMode(opt.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold shrink-0 transition-all cursor-pointer ${
                      active
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="sm:hidden">{opt.shortLabel}</span>
                    <span className="hidden sm:inline">{opt.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Selected Media Previews */}
            {(selectedImages.length > 0 || selectedVideo) && (
              <div className="flex items-center gap-2 overflow-x-auto py-1">
                {selectedImages.map((img, i) => (
                  <div key={i} className="relative shrink-0">
                    <img
                      src={img}
                      alt={`معاينة ${i + 1}`}
                      className="w-14 h-14 rounded-xl object-cover border border-stone-700"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedImages((prev) => prev.filter((_, idx) => idx !== i))
                      }
                      className="absolute -top-1.5 -right-1.5 bg-rose-600 text-white rounded-full p-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {selectedVideo && (
                  <div className="flex items-center gap-2 bg-stone-800 border border-stone-700 px-3 py-2 rounded-xl text-xs text-amber-300">
                    <Video className="w-4 h-4" />
                    <span className="max-w-[160px] truncate">{selectedVideo.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedVideo(null)}
                      className="text-stone-400 hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Input Form */}
            <form
              onSubmit={handleSendToAssistant}
              className="bg-stone-900 border border-stone-700 focus-within:border-rose-500 rounded-2xl p-2 flex items-end gap-2"
            >
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple={mode !== 'single_image'}
                onChange={handleImagesSelected}
                className="hidden"
              />
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                onChange={handleVideoSelected}
                className="hidden"
              />

              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="p-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 transition-colors shrink-0 cursor-pointer"
                title="رفع صورة أو عدة صور"
              >
                <ImagePlus className="w-4 h-4 text-rose-400" />
              </button>

              <button
                type="button"
                onClick={() => videoInputRef.current?.click()}
                className="p-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 transition-colors shrink-0 cursor-pointer"
                title="رفع فيديو كتالوج المورد"
              >
                <Video className="w-4 h-4 text-amber-400" />
              </button>

              <textarea
                rows={2}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendToAssistant();
                  }
                }}
                placeholder={
                  MODE_OPTIONS.find((m) => m.id === mode)?.hint ||
                  'ألصق محادثة واتساب أو أضف ملاحظة مع الصورة...'
                }
                className="flex-1 bg-transparent text-xs sm:text-sm text-white placeholder-stone-500 resize-none focus:outline-hidden py-2 px-1 max-h-32"
              />

              <button
                type="submit"
                disabled={
                  isAnalyzing ||
                  (selectedImages.length === 0 && !selectedVideo && !inputText.trim())
                }
                className="p-2.5 sm:px-4 sm:py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white font-bold text-xs flex items-center gap-1.5 shrink-0 transition-all cursor-pointer"
              >
                {isAnalyzing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">تحليل</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SmartEmployeeAssistantPage;
