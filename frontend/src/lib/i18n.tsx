import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'es' | 'hi';
export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'hi', label: 'हिन्दी' },
];

/**
 * Interface text for navigation, the top bar, sign-in, onboarding, shortcuts and the main page headings.
 * Clinical content (notes, diagnoses, names) is data and is never translated. Missing keys fall back to English.
 */
const EN = {
  'group.overview': 'Overview', 'group.clinical': 'Clinical', 'group.operations': 'Operations', 'group.system': 'System', 'group.myCare': 'My care',
  'nav.dashboard': 'Dashboard', 'nav.patients': 'Patients', 'nav.appointments': 'Appointments', 'nav.admissions': 'Admissions', 'nav.laboratory': 'Laboratory', 'nav.pharmacy': 'Pharmacy',
  'nav.consultations': 'Consultations', 'nav.triage': 'Emergency triage', 'nav.mar': 'Medication round', 'nav.staff': 'Staff', 'nav.roster': 'Roster and leave', 'nav.departments': 'Departments',
  'nav.billing': 'Billing', 'nav.inventory': 'Inventory', 'nav.reports': 'Reports', 'nav.admin': 'Administration', 'nav.assessment': 'Assessment', 'nav.portal': 'My health',
  'common.search': 'Search', 'common.cancel': 'Cancel', 'common.save': 'Save', 'common.close': 'Close', 'common.next': 'Next', 'common.back': 'Back', 'common.skip': 'Skip', 'common.finish': 'Finish',
  'common.download': 'Download', 'common.refresh': 'Refresh', 'common.signOut': 'Sign out', 'common.loading': 'Loading', 'common.noResults': 'No results', 'common.status': 'Status', 'common.date': 'Date',
  'topbar.search': 'Search or jump to...', 'topbar.notifications': 'Notifications', 'topbar.markAll': 'Mark all as read', 'topbar.none': "You're all caught up.", 'topbar.language': 'Language',
  'topbar.help': 'Help and shortcuts', 'topbar.themeLight': 'Switch to light theme', 'topbar.themeDark': 'Switch to dark theme', 'topbar.live': 'Live', 'topbar.offline': 'Offline',
  'login.welcome': 'Welcome back', 'login.sub': 'Sign in with your account.', 'login.username': 'Username', 'login.password': 'Password', 'login.signIn': 'Sign in', 'login.forgot': 'Forgot password?',
  'login.twoTitle': 'Two-step verification', 'login.twoSub': 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.', 'login.code': 'Verification code', 'login.verify': 'Verify',
  'login.backToSignIn': 'Back to sign in',
  'tour.title': 'Quick tour', 'tour.step': 'Step {n} of {total}',
  'tour.nav.title': 'Navigation', 'tour.nav.body': 'Everything you are allowed to use is listed here, grouped by clinical work and operations.',
  'tour.search.title': 'Search anywhere', 'tour.search.body': 'Press Ctrl+K (or Cmd+K) to find patients, invoices, staff and medicines, or to jump to any page.',
  'tour.bell.title': 'Notifications', 'tour.bell.body': 'Critical results, bed changes, overdue invoices and low stock appear here. Red means act now.',
  'tour.theme.title': 'Make it yours', 'tour.theme.body': 'Switch between light and dark themes, and choose English, Spanish or Hindi.',
  'tour.help.title': 'Help is one key away', 'tour.help.body': 'Press ? at any time to see keyboard shortcuts. You can replay this tour from the help menu.',
  'shortcuts.title': 'Keyboard shortcuts', 'shortcuts.search': 'Open search', 'shortcuts.help': 'Show this help', 'shortcuts.goTo': 'Go to a page (press g, then the letter)', 'shortcuts.tour': 'Replay the quick tour',
  'shortcuts.close': 'Close dialogs and menus', 'shortcuts.hint': 'Shortcuts are paused while you are typing in a field.',
  'page.consultations': 'Consultations', 'page.triage': 'Emergency triage', 'page.mar': 'Medication round', 'page.inventory': 'Pharmacy inventory', 'page.roster': 'Roster and leave', 'page.portal': 'My health',
  'page.reports': 'Reports', 'page.billing': 'Billing', 'page.profile': 'My profile',
  'portal.overview': 'Overview', 'portal.appointments': 'Appointments', 'portal.results': 'Test results', 'portal.bills': 'Bills', 'portal.medicines': 'Medicines', 'portal.details': 'My details',
  'portal.book': 'Book an appointment', 'portal.nextAppointment': 'Next appointment', 'portal.balanceDue': 'Balance due',
} as const;
type Key = keyof typeof EN;

const ES: Partial<Record<Key, string>> = {
  'group.overview': 'Resumen', 'group.clinical': 'Clínico', 'group.operations': 'Operaciones', 'group.system': 'Sistema', 'group.myCare': 'Mi atención',
  'nav.dashboard': 'Panel', 'nav.patients': 'Pacientes', 'nav.appointments': 'Citas', 'nav.admissions': 'Ingresos', 'nav.laboratory': 'Laboratorio', 'nav.pharmacy': 'Farmacia',
  'nav.consultations': 'Consultas', 'nav.triage': 'Triaje de urgencias', 'nav.mar': 'Ronda de medicación', 'nav.staff': 'Personal', 'nav.roster': 'Turnos y licencias', 'nav.departments': 'Departamentos',
  'nav.billing': 'Facturación', 'nav.inventory': 'Inventario', 'nav.reports': 'Informes', 'nav.admin': 'Administración', 'nav.assessment': 'Evaluación', 'nav.portal': 'Mi salud',
  'common.search': 'Buscar', 'common.cancel': 'Cancelar', 'common.save': 'Guardar', 'common.close': 'Cerrar', 'common.next': 'Siguiente', 'common.back': 'Atrás', 'common.skip': 'Omitir', 'common.finish': 'Finalizar',
  'common.download': 'Descargar', 'common.refresh': 'Actualizar', 'common.signOut': 'Cerrar sesión', 'common.loading': 'Cargando', 'common.noResults': 'Sin resultados', 'common.status': 'Estado', 'common.date': 'Fecha',
  'topbar.search': 'Buscar o ir a...', 'topbar.notifications': 'Notificaciones', 'topbar.markAll': 'Marcar todo como leído', 'topbar.none': 'Estás al día.', 'topbar.language': 'Idioma',
  'topbar.help': 'Ayuda y atajos', 'topbar.themeLight': 'Cambiar a tema claro', 'topbar.themeDark': 'Cambiar a tema oscuro', 'topbar.live': 'En vivo', 'topbar.offline': 'Sin conexión',
  'login.welcome': 'Bienvenido de nuevo', 'login.sub': 'Inicia sesión con tu cuenta.', 'login.username': 'Usuario', 'login.password': 'Contraseña', 'login.signIn': 'Iniciar sesión', 'login.forgot': '¿Olvidaste tu contraseña?',
  'login.twoTitle': 'Verificación en dos pasos', 'login.twoSub': 'Introduce el código de 6 dígitos de tu aplicación de autenticación o uno de tus códigos de recuperación.', 'login.code': 'Código de verificación', 'login.verify': 'Verificar',
  'login.backToSignIn': 'Volver a iniciar sesión',
  'tour.title': 'Recorrido rápido', 'tour.step': 'Paso {n} de {total}',
  'tour.nav.title': 'Navegación', 'tour.nav.body': 'Aquí aparece todo lo que puedes usar, agrupado por trabajo clínico y operaciones.',
  'tour.search.title': 'Busca en cualquier lugar', 'tour.search.body': 'Pulsa Ctrl+K (o Cmd+K) para encontrar pacientes, facturas, personal y medicamentos, o para ir a cualquier página.',
  'tour.bell.title': 'Notificaciones', 'tour.bell.body': 'Aquí aparecen los resultados críticos, los cambios de cama, las facturas vencidas y el stock bajo. El rojo significa actuar ya.',
  'tour.theme.title': 'Personalízalo', 'tour.theme.body': 'Cambia entre tema claro y oscuro, y elige inglés, español o hindi.',
  'tour.help.title': 'La ayuda está a una tecla', 'tour.help.body': 'Pulsa ? en cualquier momento para ver los atajos de teclado. Puedes repetir este recorrido desde el menú de ayuda.',
  'shortcuts.title': 'Atajos de teclado', 'shortcuts.search': 'Abrir la búsqueda', 'shortcuts.help': 'Mostrar esta ayuda', 'shortcuts.goTo': 'Ir a una página (pulsa g y luego la letra)', 'shortcuts.tour': 'Repetir el recorrido rápido',
  'shortcuts.close': 'Cerrar diálogos y menús', 'shortcuts.hint': 'Los atajos se pausan mientras escribes en un campo.',
  'page.consultations': 'Consultas', 'page.triage': 'Triaje de urgencias', 'page.mar': 'Ronda de medicación', 'page.inventory': 'Inventario de farmacia', 'page.roster': 'Turnos y licencias', 'page.portal': 'Mi salud',
  'page.reports': 'Informes', 'page.billing': 'Facturación', 'page.profile': 'Mi perfil',
  'portal.overview': 'Resumen', 'portal.appointments': 'Citas', 'portal.results': 'Resultados', 'portal.bills': 'Facturas', 'portal.medicines': 'Medicamentos', 'portal.details': 'Mis datos',
  'portal.book': 'Reservar una cita', 'portal.nextAppointment': 'Próxima cita', 'portal.balanceDue': 'Saldo pendiente',
};

const HI: Partial<Record<Key, string>> = {
  'group.overview': 'अवलोकन', 'group.clinical': 'क्लिनिकल', 'group.operations': 'संचालन', 'group.system': 'सिस्टम', 'group.myCare': 'मेरी देखभाल',
  'nav.dashboard': 'डैशबोर्ड', 'nav.patients': 'मरीज़', 'nav.appointments': 'अपॉइंटमेंट', 'nav.admissions': 'भर्ती', 'nav.laboratory': 'प्रयोगशाला', 'nav.pharmacy': 'फ़ार्मेसी',
  'nav.consultations': 'परामर्श', 'nav.triage': 'आपातकालीन ट्राइएज', 'nav.mar': 'दवा वितरण', 'nav.staff': 'स्टाफ़', 'nav.roster': 'ड्यूटी रोस्टर और छुट्टी', 'nav.departments': 'विभाग',
  'nav.billing': 'बिलिंग', 'nav.inventory': 'इन्वेंटरी', 'nav.reports': 'रिपोर्ट', 'nav.admin': 'प्रशासन', 'nav.assessment': 'मूल्यांकन', 'nav.portal': 'मेरा स्वास्थ्य',
  'common.search': 'खोजें', 'common.cancel': 'रद्द करें', 'common.save': 'सहेजें', 'common.close': 'बंद करें', 'common.next': 'आगे', 'common.back': 'पीछे', 'common.skip': 'छोड़ें', 'common.finish': 'समाप्त',
  'common.download': 'डाउनलोड', 'common.refresh': 'ताज़ा करें', 'common.signOut': 'साइन आउट', 'common.loading': 'लोड हो रहा है', 'common.noResults': 'कोई परिणाम नहीं', 'common.status': 'स्थिति', 'common.date': 'तारीख़',
  'topbar.search': 'खोजें या कहीं जाएँ...', 'topbar.notifications': 'सूचनाएँ', 'topbar.markAll': 'सभी को पढ़ा हुआ चिह्नित करें', 'topbar.none': 'सब कुछ देख लिया गया है।', 'topbar.language': 'भाषा',
  'topbar.help': 'सहायता और शॉर्टकट', 'topbar.themeLight': 'लाइट थीम पर जाएँ', 'topbar.themeDark': 'डार्क थीम पर जाएँ', 'topbar.live': 'लाइव', 'topbar.offline': 'ऑफ़लाइन',
  'login.welcome': 'फिर से स्वागत है', 'login.sub': 'अपने खाते से साइन इन करें।', 'login.username': 'उपयोगकर्ता नाम', 'login.password': 'पासवर्ड', 'login.signIn': 'साइन इन करें', 'login.forgot': 'पासवर्ड भूल गए?',
  'login.twoTitle': 'दो-चरणीय सत्यापन', 'login.twoSub': 'अपने ऑथेंटिकेटर ऐप का 6-अंकीय कोड या अपना कोई रिकवरी कोड दर्ज करें।', 'login.code': 'सत्यापन कोड', 'login.verify': 'सत्यापित करें',
  'login.backToSignIn': 'साइन इन पर वापस जाएँ',
  'tour.title': 'संक्षिप्त परिचय', 'tour.step': 'चरण {n} / {total}',
  'tour.nav.title': 'नेविगेशन', 'tour.nav.body': 'जो कुछ भी आप उपयोग कर सकते हैं वह यहाँ क्लिनिकल कार्य और संचालन के अनुसार सूचीबद्ध है।',
  'tour.search.title': 'कहीं भी खोजें', 'tour.search.body': 'मरीज़, बिल, स्टाफ़ और दवाएँ खोजने या किसी भी पेज पर जाने के लिए Ctrl+K (या Cmd+K) दबाएँ।',
  'tour.bell.title': 'सूचनाएँ', 'tour.bell.body': 'गंभीर परिणाम, बिस्तर में बदलाव, बकाया बिल और कम स्टॉक यहाँ दिखते हैं। लाल का मतलब है तुरंत कार्रवाई करें।',
  'tour.theme.title': 'इसे अपने अनुसार बनाएँ', 'tour.theme.body': 'लाइट और डार्क थीम के बीच बदलें, और अंग्रेज़ी, स्पेनिश या हिन्दी चुनें।',
  'tour.help.title': 'सहायता बस एक कुंजी दूर', 'tour.help.body': 'कीबोर्ड शॉर्टकट देखने के लिए कभी भी ? दबाएँ। इस परिचय को सहायता मेनू से दोबारा चला सकते हैं।',
  'shortcuts.title': 'कीबोर्ड शॉर्टकट', 'shortcuts.search': 'खोज खोलें', 'shortcuts.help': 'यह सहायता दिखाएँ', 'shortcuts.goTo': 'किसी पेज पर जाएँ (g दबाएँ, फिर अक्षर)', 'shortcuts.tour': 'संक्षिप्त परिचय दोबारा चलाएँ',
  'shortcuts.close': 'डायलॉग और मेनू बंद करें', 'shortcuts.hint': 'किसी फ़ील्ड में टाइप करते समय शॉर्टकट रुके रहते हैं।',
  'page.consultations': 'परामर्श', 'page.triage': 'आपातकालीन ट्राइएज', 'page.mar': 'दवा वितरण', 'page.inventory': 'फ़ार्मेसी इन्वेंटरी', 'page.roster': 'ड्यूटी रोस्टर और छुट्टी', 'page.portal': 'मेरा स्वास्थ्य',
  'page.reports': 'रिपोर्ट', 'page.billing': 'बिलिंग', 'page.profile': 'मेरी प्रोफ़ाइल',
  'portal.overview': 'अवलोकन', 'portal.appointments': 'अपॉइंटमेंट', 'portal.results': 'जाँच परिणाम', 'portal.bills': 'बिल', 'portal.medicines': 'दवाएँ', 'portal.details': 'मेरा विवरण',
  'portal.book': 'अपॉइंटमेंट बुक करें', 'portal.nextAppointment': 'अगला अपॉइंटमेंट', 'portal.balanceDue': 'बकाया राशि',
};

const DICT: Record<Lang, Partial<Record<Key, string>>> = { en: EN, es: ES, hi: HI };
const STORAGE_KEY = 'medicore-lang';

export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'es' || v === 'hi';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch { /* storage may be unavailable */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'en';
  return isLang(nav) ? nav : 'en';
}

/** Pure translation helper (exported for tests): English fallback, then the key itself; `{name}` placeholders are replaced. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = (DICT[lang] as Record<string, string>)[key] ?? (EN as Record<string, string>)[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
}

interface I18n { lang: Lang; setLang: (l: Lang) => void; t: (key: Key | (string & {}), vars?: Record<string, string | number>) => string }
const Ctx = createContext<I18n>({ lang: 'en', setLang: () => {}, t: (k, v) => translate('en', k, v) });
export const useT = () => useContext(Ctx);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  }, []);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const DICTIONARIES = { en: EN, es: ES, hi: HI };
