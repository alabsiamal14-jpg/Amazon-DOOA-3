import React, { useState, useEffect, useRef } from 'react';
import {
  Code2,
  Terminal,
  Sparkles,
  Send,
  Copy,
  Check,
  RotateCcw,
  Lightbulb,
  FileCode,
  Layers,
  ArrowRight,
  Cpu,
  Laptop,
  Flame,
  Zap,
  Bot,
  ExternalLink,
  ChevronLeft,
  BookOpen,
  X,
  Palette,
  Braces,
  GitBranch,
} from 'lucide-react';
import { StoreSettings } from '../types';
import { getAuthHeadersAsync } from '../lib/storage.ts';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  suggestions?: string[];
}

interface AdminDeveloperAdvisorProps {
  settings: StoreSettings;
  onBackToAdmin: () => void;
  onOpenStore?: () => void;
  onOpenOrders?: () => void;
}

const STORAGE_KEY = 'amazon_duaa_dev_advisor_chat_v1';

const INITIAL_WELCOME_MESSAGE: Message = {
  id: 'welcome-msg',
  role: 'assistant',
  content: `مرحباً بك! أنا **المستشار البرمجي والتقني المعتمد (Lead Software Architect & AI Senior Engineer)** لمتجر **أمازون دعاء | Amazon Duaa**.

أنا هنا لمساعدتك على مدار الأيام في كل ما يخص الجوانب التقنية والبرمجية للموقع:
- 💡 **اقتراح أحدث الإضافات والميزات** التي ترفع المبيعات ومعدل التحويل (Conversion Rate).
- 💻 **توليد الأكواد البرمجية الكاملة (Clean Production-Ready Code)** لأي ميزة تريد إضافتها مباشرة في النظام مع مسار الملف وطريقة ربطه.
- ⚡ **تحسين سرعة وأداء المتجر والسيو (SEO)** وتجربة مستخدمي الجوال.
- 🛠️ **حل أي مشكلة تقنية** أو إعادة هيكلة المكونات البرمجية.

اختر من الأسئلة السريعة أدناه أو اكتب لي ما ترغب بتطويره وسأرسل لك الكود فورياً!

### 💡 اقتراحات لتطوير المنصة والخطوات التالية:
- أرسل لي كود إضافة نظام كوبونات الخصم في السلة
- أرسل لي كود شريط العد التنازلي للعروض الخاصة (Flash Sale)
- أرسل لي كود إشعار منبثق للمشتريات الأخيرة لزيادة الثقة
- ما هي خطة التطوير المقترحة للمتجر خلال الشهر القادم؟`,
  timestamp: 'الآن',
  suggestions: [
    'أرسل لي كود نظام كوبونات الخصم في السلة',
    'أرسل لي كود شريط العد التنازلي للعروض الخاصة (Flash Sale)',
    'أرسل لي كود إشعار منبثق للمشتريات الأخيرة لزيادة الثقة',
    'ما هي أهم 3 إضافات برمجية ترفع مبيعات متجرنا الآن؟',
  ],
};

const QUICK_PROMPTS = [
  {
    title: 'نظام الكوبونات',
    desc: 'كود كامل لتطبيق كود خصم في السلة',
    prompt: 'أريد إضافة نظام كوبونات خصم وقسائم ترويجية في السلة وصفحة الدفع. زوّدني بالكود البرمجي الكامل وطريقة ربطه في المتجر.',
    icon: Flame,
  },
  {
    title: 'شريط عروض اليوم (Timer)',
    desc: 'عداد تنازلي براق أعلى الصفحة',
    prompt: 'أريد كود شريط علوي جذاب يعرض عداداً تنازلياً لعروض اليوم مع زر خصم سريع. زوّدني بالكود الكامل ومسار الملف.',
    icon: Zap,
  },
  {
    title: 'إشعار المشتريات الأخيرة',
    desc: 'Social Proof لزيادة ثقة الزبائن',
    prompt: 'أريد كود نافذة منبثقة تظهر في أسفل الصفحة تعرض مشتريات حديثة حقيقية (Social Proof) لزيادة المبيعات. كيف أضيفها؟',
    icon: Sparkles,
  },
  {
    title: 'تحسين السيو وGoogle Rich Snippets',
    desc: 'ظهور المنتجات والتقييمات في نتائج بحث جوجل',
    prompt: 'كيف نحسن ظهور منتجاتنا وتقييمات الـ 5 نجوم في نتائج بحث جوجل عبر Schema.org؟ أرسل لي الكود البرمجي اللازم.',
    icon: Laptop,
  },
];

type DevCommandCategoryId = 'css' | 'html' | 'js' | 'git';

interface DevCommandItem {
  id: string;
  code: string;
  title: string;
  level: 'أساسي' | 'متقدم';
  description: string;
  prompt: string;
}

interface DevCommandCategory {
  id: DevCommandCategoryId;
  label: string;
  badge: string;
  icon: React.FC<{ className?: string }>;
  items: DevCommandItem[];
}

const DEV_COMMAND_CATEGORIES: DevCommandCategory[] = [
  {
    id: 'html',
    label: '1. أوامر ووسوم HTML (الهيكل والواجهات)',
    badge: 'HTML5',
    icon: FileCode,
    items: [
      {
        id: 'html-headings',
        code: '<h1>العنوان الرئيسي للمتجر</h1>\n<h2>عنوان القسم الفرعي</h2>\n<h3>عنوان البطاقة</h3>',
        title: '<h1> إلى <h6> (العناوين)',
        level: 'أساسي',
        description: 'لإنشاء العناوين الرئيسية والفرعية (<h1> هو الأكبر والأهم لمحركات البحث والسيو).',
        prompt: 'كيف نرتب وسوم العناوين <h1> إلى <h3> في صفحات متجر أمازون دعاء لتحسين السيو (SEO) وإمكانية الوصول؟',
      },
      {
        id: 'html-p',
        code: '<p>وصف واضح ومختصر لمميزات المنتج وطريقة استخدامه.</p>',
        title: '<p> (الفقرة النصية)',
        level: 'أساسي',
        description: 'لكتابة فقرة نصية منظمة داخل الصفحة أو تفاصيل المنتج.',
        prompt: 'ما أفضل تنسيق للفقرات النصية <p> في وصف المنتجات لضمان سهولة القراءة على الجوال؟',
      },
      {
        id: 'html-anchor',
        code: '<a href="/products/serum-1">تصفح تفاصيل المنتج</a>',
        title: '<a href="الرابط"> (الرابط التشعبي)',
        level: 'أساسي',
        description: 'لإنشاء رابط تشعبي ينقل المستخدم لصفحة أو موقع آخر.',
        prompt: 'كيف نستخدم <a href="..."> بشكل آمن وسريع للتنقل أو لروابط التواصل الخارجي في المتجر؟',
      },
      {
        id: 'html-img',
        code: '<img src="/images/product.webp" alt="سيروم فيتامين سي للبشرة" loading="lazy" />',
        title: '<img src="مسار_الصورة" alt="وصف">',
        level: 'أساسي',
        description: 'لإدراج صورة داخل الصفحة مع نص بديل مهم للسيو وقارئات الشاشة.',
        prompt: 'كيف نحسّن صور المنتجات عبر <img> مع alt وصفي و loading="lazy" لتسريع المتجر؟',
      },
      {
        id: 'html-layout',
        code: '<header>شريط التنقل العلوي</header>\n<section>\n  <div>محتوى القسم</div>\n</section>\n<footer>تذييل المتجر</footer>',
        title: '<div> و <section> و <header> و <footer>',
        level: 'أساسي',
        description: 'لتقسيم الصفحة إلى حاويات وأقسام دلالية (رأس الصفحة، محتوى، تذييل).',
        prompt: 'اشرح لي كيفية تنظيم تخطيط الصفحة دلالياً باستخدام <header> و <section> و <footer> في مكونات React.',
      },
      {
        id: 'html-form',
        code: '<form>\n  <input type="text" placeholder="ابحث عن منتج..." />\n  <button type="submit">بحث</button>\n</form>',
        title: '<form> و <input> و <button>',
        level: 'أساسي',
        description: 'لإنشاء النماذج التفاعلية، حقول الإدخال، والأزرار.',
        prompt: 'كيف نبني نموذج بحث أو تسجيل طلب احترافي باستخدام <form> و <input> و <button> في React؟',
      },
      {
        id: 'html-lists',
        code: '<ul>\n  <li>توصيل سريع خلال 24 ساعة</li>\n  <li>منتجات أصلية مضمونة</li>\n</ul>',
        title: '<ul> / <ol> و <li> (القوائم)',
        level: 'أساسي',
        description: 'لإنشاء القوائم النقطية (<ul>) أو المرقمة (<ol>) وعناصرها (<li>).',
        prompt: 'كيف نعرض مميزات المنتج أو خطوات الطلب باستخدام <ul> / <ol> و <li> بتنسيق حديث؟',
      },
      {
        id: 'html-email',
        code: '<input type="email" required placeholder="name@example.com">',
        title: 'حقل البريد الإلكتروني بالتحقق التلقائي',
        level: 'متقدم',
        description: 'حقل إدخال يتحقق تلقائياً من صيغة البريد ويمنع الإرسال إذا كان فارغاً.',
        prompt: 'أريد إضافة نموذج اشتراك بريدي في المتجر يستخدم <input type="email" required placeholder="name@example.com"> مع ربطه بـ React.',
      },
      {
        id: 'html-select',
        code: '<select>\n  <option value="riyadh">الرياض</option>\n  <option value="jeddah">جدة</option>\n</select>',
        title: 'القائمة المنسدلة (<select> و <option>)',
        level: 'متقدم',
        description: 'إنشاء قائمة منسدلة يختار منها المستخدم قيمة واحدة.',
        prompt: 'أعطني مثالاً نظيفاً لقائمة منسدلة لاختيار المدينة أو الفرز باستخدام <select> و <option> في React.',
      },
      {
        id: 'html-textarea',
        code: '<textarea rows="4" placeholder="اكتب ملاحظاتك هنا..."></textarea>',
        title: 'مربع النص متعدد الأسطر (<textarea>)',
        level: 'متقدم',
        description: 'مربع نص متعدد الأسطر (مثل رسائل التواصل أو الملاحظات).',
        prompt: 'كيف نضيف حقل ملاحظات الطلب أو تواصل معنا باستخدام <textarea rows="4"> مع حد أقصى للأحرف؟',
      },
      {
        id: 'html-video',
        code: '<video controls src="video.mp4"></video>',
        title: 'مشغّل الفيديو المدمج (<video controls>)',
        level: 'متقدم',
        description: 'تضمين مقطع فيديو مع أزرار التشغيل والصوت.',
        prompt: 'كيف نعرض فيديو تعريفي للمنتج داخل صفحة التفاصيل باستخدام <video controls src="..."> بشكل متجاوب وسريع؟',
      },
      {
        id: 'html-details',
        code: '<details>\n  <summary>كم يستغرق توصيل الطلب؟</summary>\n  <p>يصل الطلب خلال 24 إلى 48 ساعة.</p>\n</details>',
        title: 'العنصر القابل للفتح والطي (<details> و <summary>)',
        level: 'متقدم',
        description: 'إنشاء عنصر قابل للفتح والطي (مثل الأسئلة الشائعة FAQ) بدون كتابة جافاسكريبت.',
        prompt: 'أريد إنشاء قسم الأسئلة الشائعة (FAQ) في المتجر باستخدام وسوم <details> و <summary> وتنسيق أنيق.',
      },
    ],
  },
  {
    id: 'css',
    label: '2. أوامر وخصائص CSS (التنسيق والتجاوب والحركة)',
    badge: 'CSS3',
    icon: Palette,
    items: [
      {
        id: 'css-colors',
        code: 'color: #1c1917;\nbackground-color: #fff1f2;',
        title: 'color و background-color',
        level: 'أساسي',
        description: 'لتحديد لون النص ولون الخلفية وتباينهما الواضح.',
        prompt: 'ما أفضل تدرجات الألوان (color و background-color) لمتجر مستحضرات تجميل فاخرة مع ضمان وضوح القراءة؟',
      },
      {
        id: 'css-typography',
        code: 'font-size: 16px;\nfont-family: "Cairo", sans-serif;',
        title: 'font-size و font-family',
        level: 'أساسي',
        description: 'للتحكم بحجم الخط ونوعه في العناوين والفقرات.',
        prompt: 'كيف نضبط التسلسل الهرمي للخطوط (font-size و font-family) باللغة العربية في المشروع؟',
      },
      {
        id: 'css-spacing',
        code: 'margin: 16px auto;\npadding: 12px 20px;',
        title: 'margin و padding',
        level: 'أساسي',
        description: 'للتحكم بالمسافات الخارجية (حول العنصر) والداخلية (داخل العنصر).',
        prompt: 'اشرح لي قاعدة استخدام margin و padding بانتظام في بطاقات المنتجات وتفاصيل الطلب.',
      },
      {
        id: 'css-flex-grid',
        code: 'display: flex;\njustify-content: space-between;\nalign-items: center;\n/* أو للشبكات: */\ndisplay: grid;\ngrid-template-columns: repeat(3, 1fr);\ngap: 16px;',
        title: 'display: flex و display: grid',
        level: 'أساسي',
        description: 'لتوزيع العناصر وترتيبها بمرونة في صفوف أو أعمدة أو شبكات متناسقة.',
        prompt: 'متى نستخدم display: flex ومتى نستخدم display: grid في شبكة منتجات المتجر وشريط التنقل؟',
      },
      {
        id: 'css-border',
        code: 'border: 1px solid #e7e5e4;\nborder-radius: 16px;',
        title: 'border و border-radius',
        level: 'أساسي',
        description: 'لإضافة حدود للعناصر وتدوير زواياها بمظهر عصري.',
        prompt: 'أعطني أفضل نسب border و border-radius لبطاقات المنتجات والأزرار في المتجر.',
      },
      {
        id: 'css-media',
        code: '@media (max-width: 768px) {\n  .products-grid {\n    grid-template-columns: repeat(2, 1fr);\n  }\n}',
        title: '@media (max-width: 768px) (التجاوب)',
        level: 'أساسي',
        description: 'لجعل التصميم متجاوباً (Responsive) على الهواتف والأجهزة اللوحية.',
        prompt: 'كيف نضمن تجاوب شبكة المنتجات والسلة على الهواتف عبر @media (max-width: 768px) أو نقاط توقف Tailwind؟',
      },
      {
        id: 'css-root',
        code: ':root { --main-color: #1e40af; }',
        title: 'تعريف متغيرات CSS العامة (:root)',
        level: 'متقدم',
        description: 'تعريف متغيرات ألوان أو مقاسات لاستخدامها في كامل الموقع وتعديلها من مكان واحد.',
        prompt: 'كيف أستخدم متغيرات :root و var(--main-color) لتوحيد ألوان متجر أمازون دعاء وتسهيل تعديلها من مكان واحد؟',
      },
      {
        id: 'css-var',
        code: 'var(--main-color)',
        title: 'استدعاء قيمة المتغير',
        level: 'متقدم',
        description: 'استدعاء قيمة المتغير الذي عرّفته مسبقاً داخل أي عنصر أو قاعدة تنسيق.',
        prompt: 'أعطني مثالاً عملياً لاستخدام var(--main-color) مع Tailwind CSS v4 أو index.css في المشروع.',
      },
      {
        id: 'css-transition',
        code: 'transition: all 0.3s ease;',
        title: 'الانتقالات الناعمة (Transition)',
        level: 'متقدم',
        description: 'جعل التغير في اللون أو الحجم أو الظل ناعماً ومتدرجاً بدلاً من أن يكون مفاجئاً (مفيد جداً مع :hover).',
        prompt: 'أريد تحسين حركة الأزرار وبطاقات المنتجات باستخدام transition: all 0.3s ease وتأثيرات :hover احترافية.',
      },
      {
        id: 'css-keyframes',
        code: `@keyframes pulseGlow {\n  0%, 100% { transform: scale(1); }\n  50% { transform: scale(1.04); }\n}\n.element {\n  animation: pulseGlow 2s infinite ease-in-out;\n}`,
        title: '@keyframes و animation',
        level: 'متقدم',
        description: 'إنشاء حركات مخصصة مستمرة (مثل اهتزاز زر، دوران أيقونة، أو دخول عنصر).',
        prompt: 'اكتب لي حركة مخصصة بـ @keyframes و animation لزر الشراء أو شارة العروض الحصرية في المتجر.',
      },
      {
        id: 'css-sticky',
        code: 'position: sticky;\ntop: 0;',
        title: 'التثبيت الذكي أثناء التمرير (Sticky)',
        level: 'متقدم',
        description: 'تثبيت عنصر (مثل شريط التنقل أو رأس جدول) عند الوصول إليه أثناء التمرير.',
        prompt: 'كيف نثبّت شريط الفئات أو ملخص السلة أثناء التمرير باستخدام position: sticky; top: 0 بشكل متوافق مع الجوال؟',
      },
      {
        id: 'css-shadow',
        code: 'box-shadow: 0 4px 12px rgba(0,0,0,0.1);',
        title: 'الظلال الناعمة (Box Shadow)',
        level: 'متقدم',
        description: 'إضافة ظل ناعم يعطي عمقاً للبطاقات والأزرار.',
        prompt: 'كيف نطبّق ظلالاً ناعمة مثل box-shadow: 0 4px 12px rgba(0,0,0,0.1) على بطاقات المنتجات لرفع جودتها البصرية؟',
      },
    ],
  },
  {
    id: 'js',
    label: '3. أوامر JavaScript (التفاعل والبيانات والنماذج)',
    badge: 'JS / DOM',
    icon: Braces,
    items: [
      {
        id: 'js-queryselector',
        code: 'const btn = document.querySelector(".class-name");',
        title: 'document.querySelector(".class-name")',
        level: 'أساسي',
        description: 'للوصول إلى عنصر معين في الصفحة والتحكم به برمجياً.',
        prompt: 'اشرح لي متى نستخدم document.querySelector في JavaScript ومتى نستخدم useRef في React.',
      },
      {
        id: 'js-addeventlistener',
        code: 'element.addEventListener("click", () => {\n  console.log("تم النقر على العنصر");\n});',
        title: 'element.addEventListener("click", ...)',
        level: 'أساسي',
        description: 'للاستماع لأحداث المستخدم مثل النقر على زر أو تعبئة حقل.',
        prompt: 'كيف تعمل آلية الأحداث addEventListener وكيف تقابلها onClick / onChange في مكونات React؟',
      },
      {
        id: 'js-classlist-toggle',
        code: 'element.classList.toggle("active");',
        title: 'element.classList.toggle("active")',
        level: 'أساسي',
        description: 'لإضافة أو إزالة صنف تنسيق (مثل فتح وإغلاق قائمة الجوال).',
        prompt: 'أعطني مثالاً لفتح وإغلاق قائمة الجوال الجانبية باستخدام classList.toggle أو state في React.',
      },
      {
        id: 'js-fetch',
        code: 'const res = await fetch("/api/products");\nconst data = await res.json();',
        title: 'fetch("API_URL")',
        level: 'أساسي',
        description: 'لجلب البيانات من خادم أو واجهة برمجية دون إعادة تحميل الصفحة.',
        prompt: 'كيف نستخدم fetch("API_URL") مع try/catch و credentials: "include" بشكل آمن في متجر أمازون دعاء؟',
      },
      {
        id: 'js-localstorage',
        code: 'localStorage.setItem("key", "value");\nconst val = localStorage.getItem("key");',
        title: 'التخزين المحلي في المتصفح (localStorage)',
        level: 'متقدم',
        description: 'حفظ بيانات بسيطة في متصفح المستخدم (مثل الوضع الليلي أو سلة مؤقتة) وتبقى حتى بعد إغلاق المتصفح.',
        prompt: 'كيف نستخدم localStorage.setItem و localStorage.getItem بأمان في React لحفظ تفضيلات الزائر مثل الوضع الليلي أو آخر المنتجات المشاهدة؟',
      },
      {
        id: 'js-prevent-default',
        code: 'event.preventDefault();',
        title: 'منع إعادة تحميل الصفحة (preventDefault)',
        level: 'متقدم',
        description: 'منع السلوك الافتراضي (مثل منع النموذج form من إعادة تحميل الصفحة عند الضغط على إرسال).',
        prompt: 'اشرح لي كيفية استخدام event.preventDefault() في نماذج الدفع والتسجيل داخل React لمنع إعادة تحميل الصفحة.',
      },
      {
        id: 'js-textcontent',
        code: 'element.textContent = "نص جديد";',
        title: 'تعديل النص الداخلي بأمان (textContent)',
        level: 'متقدم',
        description: 'تغيير النص الداخلي لعنصر بأمان دون مخاطر حقن HTML (XSS).',
        prompt: 'لماذا يُفضّل استخدام element.textContent بدلاً من innerHTML عند تحديث النصوص ديناميكياً؟',
      },
      {
        id: 'js-disabled',
        code: 'element.setAttribute("disabled", "true");\nelement.removeAttribute("disabled");',
        title: 'تعطيل وتفعيل العناصر أثناء التحميل (disabled)',
        level: 'متقدم',
        description: 'تعطيل أو تفعيل عنصر (مثل تعطيل زر الإرسال أثناء التحميل لمنع التكرار).',
        prompt: 'كيف نمنع تكرار إرسال الطلبات عند النقر المتكرر على زر التأكيد عبر تعطيل الزر أثناء التحميل؟',
      },
    ],
  },
  {
    id: 'git',
    label: '4. أوامر Terminal و Git (تشغيل المشروع وسير العمل)',
    badge: 'Git / CLI',
    icon: GitBranch,
    items: [
      {
        id: 'npm-init',
        code: 'npm init -y',
        title: 'تهيئة مشروع Node.js جديد (npm init -y)',
        level: 'أساسي',
        description: 'لتهيئة مشروع جديد وإنشاء ملف package.json لإدارة الحزم.',
        prompt: 'اشرح لي بنية ملف package.json الذي ينشئه npm init -y وأهم السكربتات في مشروعنا.',
      },
      {
        id: 'npm-run-dev',
        code: 'npm run dev',
        title: 'تشغيل خادم التطوير المحلي (npm run dev)',
        level: 'أساسي',
        description: 'لتشغيل خادم التطوير المحلي ومعاينة الموقع مباشرة.',
        prompt: 'ماذا يحدث خلف الكواليس عند تشغيل npm run dev في متجر أمازون دعاء مع Express و Vite؟',
      },
      {
        id: 'git-commit-flow',
        code: 'git status\ngit add .\ngit commit -m "وصف التعديل"',
        title: 'git status / git add . / git commit -m',
        level: 'أساسي',
        description: 'لفحص حالة الملفات وحفظ وتتبع التعديلات على الكود محلياً.',
        prompt: 'ما هي أفضل طريقة لصياغة رسائل git commit وفحص git status قبل حفظ التعديلات؟',
      },
      {
        id: 'git-branch',
        code: 'git checkout -b feature/new-feature\n# أو بالإصدار الحديث:\ngit switch -c feature/new-feature',
        title: 'إنشاء فرع جديد للتطوير (Branch)',
        level: 'متقدم',
        description: 'إنشاء فرع جديد لتجربة ميزة دون التأثير على الكود الأساسي.',
        prompt: 'اشرح لي خطوات العمل الآمن بفروع Git باستخدام git checkout -b أو git switch -c قبل تعديل المتجر.',
      },
      {
        id: 'git-push',
        code: 'git push origin main',
        title: 'رفع التعديلات للمستودع البعيد (Push)',
        level: 'متقدم',
        description: 'رفع التعديلات المحفوظة إلى المستودع البعيد (مثل GitHub).',
        prompt: 'ما الخطوات الكاملة لحفظ التعديلات في المشروع ورفعها بأمان عبر git push origin main؟',
      },
      {
        id: 'git-pull',
        code: 'git pull',
        title: 'سحب التحديثات من المستودع (Pull)',
        level: 'متقدم',
        description: 'سحب أحدث التحديثات من المستودع البعيد إلى جهازك.',
        prompt: 'كيف أسحب التحديثات الجديدة عبر git pull وأتعامل مع أي تعارض ملفات إن ظهر؟',
      },
      {
        id: 'npm-install',
        code: 'npm install package-name',
        title: 'تثبيت حزمة أو مكتبة جديدة (npm install)',
        level: 'متقدم',
        description: 'تثبيت مكتبة أو حزمة جديدة داخل المشروع.',
        prompt: 'ما هي أفضل الممارسات عند تثبيت حزمة جديدة عبر npm install داخل مشروع React + Express؟',
      },
    ],
  },
];

const TOTAL_DEV_COMMANDS = DEV_COMMAND_CATEGORIES.reduce(
  (sum, category) => sum + category.items.length,
  0
);

type ContentPart =
  | { type: 'text'; content: string; key: string }
  | { type: 'code'; langOrPath: string; code: string; key: string };

export const AdminDeveloperAdvisor: React.FC<AdminDeveloperAdvisorProps> = ({
  settings,
  onBackToAdmin,
  onOpenStore,
  onOpenOrders,
}) => {
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load chat history:', e);
    }
    return [INITIAL_WELCOME_MESSAGE];
  });

  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [zipReport, setZipReport] = useState<any | null>(null);
  const [showZipReportModal, setShowZipReportModal] = useState(false);
  const [zipAnalyzing, setZipAnalyzing] = useState(false);
  const [uploadedProjectFiles, setUploadedProjectFiles] = useState<Record<string, string> | null>(null);
  const [showCommandsLibrary, setShowCommandsLibrary] = useState(false);
  const [activeCommandCategory, setActiveCommandCategory] = useState<DevCommandCategoryId>('html');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (!file.name.endsWith('.zip')) {
        const warnMsg: Message = {
          id: 'msg-' + Date.now(),
          role: 'assistant',
          content: '⚠️ **تنبيه:** الرجاء اختيار ملف مضغوط بصيغة ZIP صالح.',
          timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => [...prev, warnMsg]);
        return;
      }
      setZipAnalyzing(true);
      try {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64 = event.target?.result as string;
          const authHeaders = await getAuthHeadersAsync();
          const res = await fetch('/api/ai/analyze-project-zip', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders
            },
            body: JSON.stringify({ fileData: base64, fileName: file.name })
          });
          const data = await res.json();
          if (res.ok) {
            setZipReport(data);
            setUploadedProjectFiles(data.fileIndex || null);
            setShowZipReportModal(true);
            const sysMsg: Message = {
              id: 'msg-' + Date.now(),
              role: 'assistant',
              content: `📦 **تم تحليل المشروع المضغوط (${file.name}) بنجاح!**\n- عدد الملفات: ${data.totalFiles}\n- نوع المشروع: ${data.projectType}\n- التقنيات المكتشفة: ${data.detectedTechnologies.join(', ')}\n- تم رصد ${data.issues.length} ملاحظة وتنبيه.\n\nيمكنك الآن سؤالي عن أي جزء في المشروع (مثلاً: "لماذا المنتجات تتكرر؟" أو "افحص Firebase").`,
              timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })
            };
            setMessages(prev => [...prev, sysMsg]);
          } else {
            const failMsg: Message = {
              id: 'msg-' + Date.now(),
              role: 'assistant',
              content: `❌ **تعذر تحليل المشروع:** ${data.error || 'فشل استخراج محتوى الملف المضغوط'}`,
              timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })
            };
            setMessages(prev => [...prev, failMsg]);
          }
          setZipAnalyzing(false);
        };
        reader.readAsDataURL(file);
      } catch (err: any) {
        console.error(err);
        const errSysMsg: Message = {
          id: 'msg-' + Date.now(),
          role: 'assistant',
          content: '❌ **حدث خطأ غير متوقع أثناء معالجة ورفع الملف المضغوط.**',
          timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => [...prev, errSysMsg]);
        setZipAnalyzing(false);
      }
    }
  };

  // Save messages to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (e) {
      console.warn('Failed to save chat history:', e);
    }
  }, [messages]);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Extract suggestions from assistant content if present
  const extractSuggestions = (text: string): string[] => {
    const suggestions: string[] = [];
    const match = text.match(/### 💡 اقتراحات لتطوير المنصة والخطوات التالية:([\s\S]*)$/);
    if (match && match[1]) {
      const lines = match[1].split('\n');
      for (const line of lines) {
        const cleaned = line.replace(/^[-*•\d.]+\s*/, '').trim();
        if (cleaned.length > 5 && cleaned.length < 90) {
          suggestions.push(cleaned);
        }
      }
    }
    return suggestions.slice(0, 4);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputMessage).trim();
    if ((!query && !selectedFile) || loading) return;

    const userMsg: Message = {
      id: 'msg-' + Date.now(),
      role: 'user',
      content: selectedFile ? `${query} (الملف المرفق: ${selectedFile.name})` : query,
      timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInputMessage('');
    
    // Convert file to base64 if selected
    let fileBase64 = null;
    if (selectedFile) {
      const reader = new FileReader();
      fileBase64 = await new Promise((resolve) => {
        reader.onload = (e) => resolve(e.target?.result);
        reader.readAsDataURL(selectedFile);
      });
    }
    
    setSelectedFile(null);
    setLoading(true);

    try {
      // Build conversation history for context
      const history = newMessages.slice(-8).map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        text: m.content,
      }));

      const authHeaders = await getAuthHeadersAsync();
      const res = await fetch('/api/ai/developer-advisor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify({
          message: query,
          history,
          file: fileBase64 ? { data: fileBase64, name: selectedFile?.name, type: selectedFile?.type } : null,
          uploadedProjectFiles,
          context: {
            storeName: settings.storeName,
            whatsappNumber: settings.whatsappNumber,
            platform: 'React 19 + TypeScript + Tailwind v4 + Express + Vercel + Supabase',
          },
        }),
      });

      if (!res.ok) {
        throw new Error('فشل الاتصال بخدمة المستشار البرمجي');
      }

      const data = await res.json();
      const answer = data.answer || 'تمت معالجة الاستشارة بنجاح.';
      const suggestions = extractSuggestions(answer);

      const assistantMsg: Message = {
        id: 'msg-' + (Date.now() + 1),
        role: 'assistant',
        content: answer,
        timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: Message = {
        id: 'msg-' + (Date.now() + 1),
        role: 'assistant',
        content: `عذراً، حدث خطأ أثناء الاتصال بالمستشار: ${err.message || 'خطأ غير متوقع'}. يرجى التحقق من اتصال الإنترنت أو مفتاح GEMINI_API_KEY.`,
        timestamp: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = () => {
    if (window.confirm('هل تريد مسح سجل المحادثات مع المستشار البرمجي والبدء من جديد؟')) {
      setMessages([INITIAL_WELCOME_MESSAGE]);
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const handleCopyCode = (code: string, blockId: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeId(blockId);
    setTimeout(() => setCopiedCodeId(null), 2500);
  };

  // Format message content with enhanced code blocks
  const renderMessageContent = (content: string, msgId: string) => {
    // Split by markdown code blocks (```language ... ```)
    const codeBlockRegex = /```([a-zA-Z0-9_\-\.\/]*)\n([\s\S]*?)```/g;
    const parts: ContentPart[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let blockIndex = 0;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Text before code block
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: content.substring(lastIndex, match.index),
          key: `text-${lastIndex}`,
        });
      }

      // Code block
      const langOrPath = (match[1] || '').trim() || 'typescript';
      const code = match[2] || '';
      parts.push({
        type: 'code',
        langOrPath,
        code,
        key: `code-${blockIndex++}`,
      });

      lastIndex = match.index + match[0].length;
    }

    // Remaining text after last code block
    if (lastIndex < content.length) {
      parts.push({
        type: 'text',
        content: content.substring(lastIndex),
        key: `text-${lastIndex}`,
      });
    }

    return (
      <div className="space-y-4">
        {parts.map((part) => {
          if (part.type === 'code') {
            const blockId = `${msgId}-${part.key}`;
            const isCopied = copiedCodeId === blockId;
            return (
              <div
                key={part.key}
                className="my-3 rounded-2xl overflow-hidden bg-stone-950 border border-stone-800 shadow-xl font-mono text-xs text-left"
                dir="ltr"
              >
                {/* Code Header Bar */}
                <div className="bg-stone-900/90 px-4 py-2.5 border-b border-stone-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block" />
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block" />
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block" />
                    </div>
                    <span className="text-[11px] font-bold text-stone-300 ml-2">
                      {part.langOrPath.includes('/') ? `📁 ${part.langOrPath}` : part.langOrPath}
                    </span>
                  </div>

                  <button
                    onClick={() => handleCopyCode(part.code, blockId)}
                    className="flex items-center gap-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 hover:text-white px-3 py-1 rounded-xl text-[11px] font-bold transition-all shadow-sm cursor-pointer"
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">تم النسخ!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-stone-400" />
                        <span>نسخ الكود الكامل</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Code Content */}
                <pre className="p-4 text-emerald-300/90 overflow-x-auto selection:bg-rose-900/50 leading-relaxed font-mono">
                  <code>{part.code}</code>
                </pre>
              </div>
            );
          }

          // Plain text rendering with basic markdown formatting
          const paragraphs = part.content.split('\n\n');
          return (
            <div key={part.key} className="space-y-2.5 leading-relaxed text-xs sm:text-sm">
              {paragraphs.map((p, pIdx) => {
                if (p.startsWith('### ')) {
                  return (
                    <h3 key={pIdx} className="text-base sm:text-lg font-black text-amber-300 pt-3 pb-1 border-b border-stone-800/80 flex items-center gap-2">
                      <Lightbulb className="w-5 h-5 text-amber-400" />
                      <span>{p.replace('### ', '')}</span>
                    </h3>
                  );
                }
                if (p.startsWith('## ')) {
                  return (
                    <h2 key={pIdx} className="text-lg font-black text-rose-300 pt-2">
                      {p.replace('## ', '')}
                    </h2>
                  );
                }
                if (p.startsWith('- ') || p.startsWith('* ')) {
                  const items = p.split('\n');
                  return (
                    <ul key={pIdx} className="space-y-1.5 pr-2">
                      {items.map((item, iIdx) => (
                        <li key={iIdx} className="flex items-start gap-2 text-stone-200">
                          <span className="text-rose-400 font-bold mt-0.5">•</span>
                          <span>{item.replace(/^[-*]\s*/, '')}</span>
                        </li>
                      ))}
                    </ul>
                  );
                }

                return (
                  <p key={pIdx} className="text-stone-200 whitespace-pre-line">
                    {p}
                  </p>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Top Banner Navigation */}
      <div className="bg-gradient-to-r from-stone-950 via-indigo-950 to-stone-900 text-white p-6 sm:p-8 rounded-3xl shadow-xl border border-indigo-900/50 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-2.5 mb-2">
            <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 text-xs font-black px-3 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
              <Code2 className="w-4 h-4 text-indigo-400" />
              المستشار البرمجي والمعماري المعتمد للمنصة
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-2.5 py-0.5 rounded-full font-bold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              جاهز لتوليد الأكواد
            </span>
          </div>

          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white flex items-center gap-2">
            <span>مستشار تطوير المنصة وكبير المطورين</span>
            <span className="text-xs bg-indigo-600 px-2 py-0.5 rounded-lg text-white font-sans">AI Senior Architect</span>
          </h1>

          <p className="text-xs sm:text-sm text-stone-300 mt-2 max-w-2xl leading-relaxed">
            استشر مهندس النظام في أي وقت حول ما يحتاجه المتجر من تطويرات أو إضافات لزيادة الأرباح، واطلب منه كود أي ميزة ليرسله لك جاهزاً ومباشراً للإدراج في المشروع مع توضيح مسار الملف والخطوات.
          </p>

          <div className="flex flex-wrap items-center gap-2 mt-4 text-[11px] font-mono text-indigo-200/80">
            <span className="bg-stone-900/80 px-2.5 py-1 rounded-lg border border-stone-800">React 19</span>
            <span className="bg-stone-900/80 px-2.5 py-1 rounded-lg border border-stone-800">TypeScript</span>
            <span className="bg-stone-900/80 px-2.5 py-1 rounded-lg border border-stone-800">Tailwind CSS v4</span>
            <span className="bg-stone-900/80 px-2.5 py-1 rounded-lg border border-stone-800">Vercel & Express</span>
            <span className="bg-stone-900/80 px-2.5 py-1 rounded-lg border border-stone-800">Supabase DB</span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            onClick={() => setShowCommandsLibrary((prev) => !prev)}
            className={`text-xs font-bold px-4 py-2.5 rounded-2xl border transition-all flex items-center gap-1.5 cursor-pointer ${
              showCommandsLibrary
                ? 'bg-amber-500 text-stone-950 border-amber-400 shadow-md'
                : 'bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-100 border-indigo-400/40'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span>مكتبة الأوامر والخصائص ({TOTAL_DEV_COMMANDS})</span>
          </button>

          <button
            onClick={onBackToAdmin}
            className="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-2xl border border-white/20 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 rotate-180" />
            <span>إدارة المنتجات</span>
          </button>

          {onOpenOrders && (
            <button
              onClick={onOpenOrders}
              className="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-2xl border border-white/20 transition-all cursor-pointer"
            >
              الطلبات
            </button>
          )}

          {onOpenStore && (
            <button
              onClick={onOpenStore}
              className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-4 py-2.5 rounded-2xl shadow-md transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <span>معاينة المتجر</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Interactive Developer Commands & Properties Reference Library */}
      {showCommandsLibrary && (
        <div className="bg-stone-950 text-white rounded-3xl border border-indigo-800/60 shadow-2xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-800 pb-4">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-2xl bg-amber-500/15 border border-amber-400/30 text-amber-300 flex items-center justify-center">
                <Terminal className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-black text-sm sm:text-base text-white">
                  مرجع الأوامر والخصائص الاحترافية لتطوير المواقع
                </h3>
                <p className="text-[11px] text-stone-400">
                  انسخ أي أمر مباشرة أو اضغط «اسأل المستشار» لتطبيقه داخل متجر أمازون دعاء
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowCommandsLibrary(false)}
              className="p-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 hover:text-white transition-colors cursor-pointer"
              title="إغلاق المكتبة"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Category Tabs */}
          <div className="flex flex-wrap gap-2">
            {DEV_COMMAND_CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isActive = activeCommandCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCommandCategory(cat.id)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-2xl text-xs font-bold border transition-all cursor-pointer ${
                    isActive
                      ? 'bg-indigo-600 text-white border-indigo-400 shadow-md'
                      : 'bg-stone-900 text-stone-300 border-stone-800 hover:border-stone-700 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{cat.label}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-black/30 font-mono">
                    {cat.items.length}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Active Category Items */}
          {(() => {
            const currentCat =
              DEV_COMMAND_CATEGORIES.find((c) => c.id === activeCommandCategory) ||
              DEV_COMMAND_CATEGORIES[0];
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {currentCat.items.map((item) => {
                  const cmdBlockId = `ref-cmd-${item.id}`;
                  const isCopied = copiedCodeId === cmdBlockId;
                  return (
                    <div
                      key={item.id}
                      className="bg-stone-900/90 border border-stone-800 hover:border-indigo-500/40 rounded-2xl p-4 flex flex-col justify-between gap-3 transition-colors"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="font-black text-xs sm:text-sm text-amber-300">
                            {item.title}
                          </h4>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border ${
                                item.level === 'أساسي'
                                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/30'
                                  : 'bg-amber-950/80 text-amber-300 border-amber-500/30'
                              }`}
                            >
                              {item.level}
                            </span>
                            <span className="text-[10px] font-mono bg-indigo-950 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-lg">
                              {currentCat.badge}
                            </span>
                          </div>
                        </div>
                        <p className="text-xs text-stone-300 leading-relaxed">
                          {item.description}
                        </p>
                        <pre
                          dir="ltr"
                          className="bg-stone-950 border border-stone-800 rounded-xl p-3 text-[11px] font-mono text-emerald-300 overflow-x-auto leading-relaxed"
                        >
                          <code>{item.code}</code>
                        </pre>
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-stone-800/80">
                        <button
                          type="button"
                          onClick={() => handleCopyCode(item.code, cmdBlockId)}
                          className="flex items-center gap-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-colors cursor-pointer"
                        >
                          {isCopied ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                              <span className="text-emerald-400">تم النسخ</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 text-stone-400" />
                              <span>نسخ الأمر</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            setShowCommandsLibrary(false);
                            handleSendMessage(item.prompt);
                          }}
                          className="flex items-center gap-1.5 bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-all cursor-pointer disabled:opacity-50"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>اسأل المستشار عنه</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* Quick Ideas & Prompt Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {QUICK_PROMPTS.map((card, idx) => {
          const Icon = card.icon;
          return (
            <button
              key={idx}
              onClick={() => handleSendMessage(card.prompt)}
              disabled={loading}
              className="group text-right p-4 rounded-3xl bg-white hover:bg-indigo-50/50 border border-stone-200/90 hover:border-indigo-300 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between cursor-pointer disabled:opacity-50"
            >
              <div>
                <div className="w-9 h-9 rounded-2xl bg-indigo-50 group-hover:bg-indigo-600 text-indigo-600 group-hover:text-white flex items-center justify-center mb-3 transition-colors shadow-2xs">
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="font-black text-stone-900 text-xs sm:text-sm mb-1 group-hover:text-indigo-900 transition-colors">
                  {card.title}
                </h4>
                <p className="text-[11px] text-stone-500 leading-relaxed">
                  {card.desc}
                </p>
              </div>

              <div className="mt-3 pt-2 border-t border-stone-100 flex items-center justify-between text-[11px] font-bold text-indigo-600">
                <span>طلب الكود الآن</span>
                <ArrowRight className="w-3.5 h-3.5 rotate-180 transform group-hover:-translate-x-1 transition-transform" />
              </div>
            </button>
          );
        })}
      </div>

      {/* Chat Workspace */}
      <div className="bg-stone-900 rounded-3xl border border-stone-800 shadow-2xl overflow-hidden flex flex-col min-h-[600px] h-[720px]">
        {/* Chat Header */}
        <div className="bg-stone-950 px-6 py-4 border-b border-stone-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-rose-600 text-white flex items-center justify-center shadow-md">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-black text-white text-sm">محادثة المستشار البرمجي</span>
                <span className="text-[10px] text-emerald-400 bg-emerald-950/80 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                  متصل ومدرك لكامل هيكلية المتجر
                </span>
              </div>
              <p className="text-[11px] text-stone-400">
                اطلب كود أي ميزة وسيقوم ببرمجتها لك فورياً متوافقة مع React 19 و Tailwind v4
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={zipInputRef}
              onChange={handleZipUpload}
              className="hidden"
              accept=".zip"
            />
            <button
              onClick={() => zipInputRef.current?.click()}
              disabled={zipAnalyzing}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="رفع وتحليل مشروع ZIP"
            >
              <FileCode className="w-4 h-4" />
              <span>{zipAnalyzing ? 'جاري تحليل ZIP...' : '📦 تحليل مشروع ZIP'}</span>
            </button>

            <button
              onClick={handleClearHistory}
              className="text-stone-400 hover:text-rose-400 hover:bg-stone-800/70 p-2 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer"
              title="مسح سجل المحادثة"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">محادثة جديدة</span>
            </button>
          </div>
        </div>

        {/* Message Feed */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 custom-scrollbar bg-stone-900/90">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 sm:gap-4 ${
                msg.role === 'user' ? 'justify-start flex-row-reverse' : 'justify-start'
              }`}
            >
              {/* Avatar */}
              <div
                className={`w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 shadow-md ${
                  msg.role === 'user'
                    ? 'bg-rose-600 text-white font-bold text-xs'
                    : 'bg-gradient-to-br from-indigo-500 to-indigo-700 text-white'
                }`}
              >
                {msg.role === 'user' ? 'أنت' : <Code2 className="w-4 h-4" />}
              </div>

              {/* Message Bubble */}
              <div
                className={`max-w-[90%] sm:max-w-[85%] rounded-3xl p-5 shadow-sm ${
                  msg.role === 'user'
                    ? 'bg-rose-700 text-white rounded-tr-xs'
                    : 'bg-stone-950/90 text-stone-200 border border-stone-800/90 rounded-tl-xs'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-stone-400 mb-2 pb-1 border-b border-white/10">
                  <span className="font-bold text-white">
                    {msg.role === 'user' ? 'طلبك البرمجي' : 'استشارة المهندس وكود الحل'}
                  </span>
                  <span>{msg.timestamp}</span>
                </div>

                {/* Content */}
                {renderMessageContent(msg.content, msg.id)}

                {/* Interactive Suggestion Pills (Next Steps) */}
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div className="mt-5 pt-4 border-t border-stone-800">
                    <span className="text-[11px] font-bold text-amber-400 block mb-2 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span>اقتراحات لتطوير المنصة يمكنك طلب كودها الآن:</span>
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {msg.suggestions.map((sug, sIdx) => (
                        <button
                          key={sIdx}
                          onClick={() => handleSendMessage(sug)}
                          disabled={loading}
                          className="bg-stone-900 hover:bg-indigo-900/60 text-indigo-300 hover:text-white border border-indigo-500/30 hover:border-indigo-400 text-xs font-bold px-3 py-1.5 rounded-xl transition-all shadow-xs flex items-center gap-1.5 cursor-pointer text-right disabled:opacity-50"
                        >
                          <span>{sug}</span>
                          <ArrowRight className="w-3 h-3 rotate-180 shrink-0" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Loading Indicator */}
          {loading && (
            <div className="flex gap-4 items-start">
              <div className="w-9 h-9 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shrink-0 animate-pulse shadow-md">
                <Code2 className="w-4 h-4" />
              </div>
              <div className="bg-stone-950 p-4 rounded-3xl border border-stone-800 text-xs text-indigo-300 flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-400 animate-ping" />
                <span>جاري دراسة بنية المتجر وتوليد الكود البرمجي المقترح مع التوصيات...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="bg-stone-950 p-4 border-t border-stone-800">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex items-center gap-2 bg-stone-900 rounded-2xl border border-stone-800 p-2 focus-within:border-indigo-500 transition-colors"
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
              accept=".zip,.rar,.tar,.gz,.pdf,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.mp4,.mov"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-2 text-stone-500 hover:text-indigo-400 transition-colors cursor-pointer"
              title="إرفاق ملف"
            >
              <FileCode className="w-5 h-5" />
            </button>
            <textarea
              ref={textareaRef}
              rows={2}
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={selectedFile ? `تم اختيار الملف: ${selectedFile.name}` : "اطلب استشارة تقنية..."}
              className="flex-1 bg-transparent border-none text-white text-xs sm:text-sm px-3 py-1.5 focus:outline-hidden resize-none placeholder-stone-500"
              disabled={loading}
            />

            <button
              type="submit"
              disabled={loading || !inputMessage.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-3 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4 rotate-180" />
              <span className="hidden sm:inline">إرسال واستشارة</span>
            </button>
          </form>

          <div className="flex items-center justify-between text-[11px] text-stone-500 mt-2 px-2">
            <span>اضغط Enter للإرسال، و Shift+Enter لسطر جديد.</span>
            <span className="text-indigo-400 font-bold">✨ كل كود يتم توليده جاهز للتطبيق في مشروع أمازون دعاء مباشرة</span>
          </div>
        </div>
      </div>

      {/* ZIP Report Modal */}
      {showZipReportModal && zipReport && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-stone-900 border border-stone-800 rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6 text-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-stone-800 pb-4 mb-6">
              <div>
                <h3 className="text-lg font-black flex items-center gap-2">
                  <span>📦 تقرير تحليل المشروع المضغوط:</span>
                  <span className="text-indigo-400">{zipReport.projectName}</span>
                </h3>
                <p className="text-xs text-stone-400 mt-1">
                  نوع المشروع: <span className="text-emerald-400 font-bold">{zipReport.projectType}</span> | الملفات: {zipReport.totalFiles} | المجلدات: {zipReport.totalFolders}
                </p>
              </div>
              <button
                onClick={() => setShowZipReportModal(false)}
                className="bg-stone-800 hover:bg-stone-700 text-stone-300 px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer"
              >
                إغلاق التقرير
              </button>
            </div>

            <div className="space-y-6">
              <div>
                <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2">التقنيات المكتشفة</h4>
                <div className="flex flex-wrap gap-2">
                  {zipReport.detectedTechnologies.map((tech: string, idx: number) => (
                    <span key={idx} className="bg-indigo-950/80 border border-indigo-500/30 text-indigo-300 px-3 py-1 rounded-xl text-xs font-bold">
                      {tech}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-3">الملاحظات والتنبيهات المكتشفة ({zipReport.issues.length})</h4>
                <div className="space-y-3">
                  {zipReport.issues.map((issue: any, idx: number) => (
                    <div key={idx} className="bg-stone-950 border border-stone-800 rounded-2xl p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                          issue.category === 'critical' || issue.severity === 'high' ? 'bg-rose-950 text-rose-400 border border-rose-500/30' :
                          issue.category === 'warning' ? 'bg-amber-950 text-amber-400 border border-amber-500/30' :
                          'bg-emerald-950 text-emerald-400 border border-emerald-500/30'
                        }`}>
                          {issue.category.toUpperCase()} ({issue.severity})
                        </span>
                        <span className="text-xs text-stone-400 font-mono">📂 {issue.file}</span>
                      </div>
                      <h5 className="font-bold text-sm text-stone-200">{issue.title}</h5>
                      <p className="text-xs text-stone-400 leading-relaxed">{issue.explanation}</p>
                      {issue.solution && (
                        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3 text-xs text-emerald-300 font-medium">
                          <strong>الحل المقترح:</strong> {issue.solution}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminDeveloperAdvisor;
