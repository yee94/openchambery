import { LYNX_TABS, type LynxTabId } from '../shell/tabs';

/**
 * Lynx-local catalog. Tab / nav keys reuse Cap `mobile.tabs.*` and
 * `mobile.nav.*` copy. New keys are scaffold-only stub labels.
 */
export const LYNX_LOCALES = [
  'en',
  'es',
  'fr',
  'ja',
  'ko',
  'pl',
  'pt-BR',
  'uk',
  'zh-CN',
  'zh-TW',
] as const;

export type LynxLocale = typeof LYNX_LOCALES[number];

export type LynxMessageKey =
  | 'mobile.nav.aria'
  | 'mobile.nav.secondaryPageAria'
  | 'mobile.tabs.projects'
  | 'mobile.tabs.assistant'
  | 'mobile.tabs.scheduled'
  | 'mobile.tabs.settings'
  | 'lynx.shell.back'
  | 'lynx.shell.chat.title'
  | 'lynx.shell.stub.body'
  | 'lynx.shell.stub.openChat'
  | 'lynx.shell.chat.stub'
  | 'lynx.shell.settings.stub';

type LynxDictionary = Record<LynxMessageKey, string>;

const en: LynxDictionary = {
  'mobile.nav.aria': 'Mobile navigation',
  'mobile.nav.secondaryPageAria': 'Detail page',
  'mobile.tabs.projects': 'Projects',
  'mobile.tabs.assistant': 'Agent',
  'mobile.tabs.scheduled': 'Schedule',
  'mobile.tabs.settings': 'Settings',
  'lynx.shell.back': 'Back',
  'lynx.shell.chat.title': 'Chat',
  'lynx.shell.stub.body': 'This surface is a labeled stub. It is not connected to OpenChamber APIs.',
  'lynx.shell.stub.openChat': 'Open stub chat page',
  'lynx.shell.chat.stub': 'Chat is a pushed page. The 1.19 LegendList transcript is another track.',
  'lynx.shell.settings.stub': 'Settings editors are another track. These slugs are listed only.',
};

const es: LynxDictionary = {
  'mobile.nav.aria': 'Navegación móvil',
  'mobile.nav.secondaryPageAria': 'Página de detalle',
  'mobile.tabs.projects': 'Proyectos',
  'mobile.tabs.assistant': 'Agente',
  'mobile.tabs.scheduled': 'Tareas',
  'mobile.tabs.settings': 'Ajustes',
  'lynx.shell.back': 'Atrás',
  'lynx.shell.chat.title': 'Chat',
  'lynx.shell.stub.body': 'Esta superficie es un stub etiquetado. No está conectada a las API de OpenChamber.',
  'lynx.shell.stub.openChat': 'Abrir la página de chat de stub',
  'lynx.shell.chat.stub': 'El chat es una página empujada. La transcripción LegendList 1.19 es otra pista.',
  'lynx.shell.settings.stub': 'Los editores de ajustes son otra pista. Aquí solo se listan los slugs.',
};

const fr: LynxDictionary = {
  'mobile.nav.aria': 'Navigation mobile',
  'mobile.nav.secondaryPageAria': 'Page de détail',
  'mobile.tabs.projects': 'Projets',
  'mobile.tabs.assistant': 'Agent',
  'mobile.tabs.scheduled': 'Tâches',
  'mobile.tabs.settings': 'Réglages',
  'lynx.shell.back': 'Retour',
  'lynx.shell.chat.title': 'Chat',
  'lynx.shell.stub.body': 'Cette surface est un gabarit étiqueté. Elle n’est pas connectée aux API OpenChamber.',
  'lynx.shell.stub.openChat': 'Ouvrir la page de chat gabarit',
  'lynx.shell.chat.stub': 'Le chat est une page poussée. La transcription LegendList 1.19 est une autre piste.',
  'lynx.shell.settings.stub': 'Les éditeurs de réglages sont une autre piste. Seuls les identifiants sont listés ici.',
};

const ja: LynxDictionary = {
  'mobile.nav.aria': 'モバイルナビゲーション',
  'mobile.nav.secondaryPageAria': '詳細ページ',
  'mobile.tabs.projects': '案件',
  'mobile.tabs.assistant': '助手',
  'mobile.tabs.scheduled': '予定',
  'mobile.tabs.settings': '設定',
  'lynx.shell.back': '戻る',
  'lynx.shell.chat.title': 'チャット',
  'lynx.shell.stub.body': 'この画面は明示されたスタブです。OpenChamber API には未接続です。',
  'lynx.shell.stub.openChat': 'スタブのチャットページを開く',
  'lynx.shell.chat.stub': 'チャットはプッシュされた下位ページです。1.19 LegendList の会話リストは別トラックです。',
  'lynx.shell.settings.stub': '設定エディタは別トラックです。ここではスラッグのみを列挙します。',
};

const ko: LynxDictionary = {
  'mobile.nav.aria': '모바일 내비게이션',
  'mobile.nav.secondaryPageAria': '상세 페이지',
  'mobile.tabs.projects': '프로젝트',
  'mobile.tabs.assistant': '도우미',
  'mobile.tabs.scheduled': '작업',
  'mobile.tabs.settings': '설정',
  'lynx.shell.back': '뒤로',
  'lynx.shell.chat.title': '채팅',
  'lynx.shell.stub.body': '이 화면은 표시된 스텁입니다. OpenChamber API에 연결되지 않았습니다.',
  'lynx.shell.stub.openChat': '스텁 채팅 페이지 열기',
  'lynx.shell.chat.stub': '채팅은 푸시된 하위 페이지입니다. 1.19 LegendList 대화 목록은 다른 트랙입니다.',
  'lynx.shell.settings.stub': '설정 편집기는 다른 트랙입니다. 여기에는 슬러그만 나열됩니다.',
};

const pl: LynxDictionary = {
  'mobile.nav.aria': 'Nawigacja mobilna',
  'mobile.nav.secondaryPageAria': 'Strona szczegółów',
  'mobile.tabs.projects': 'Projekty',
  'mobile.tabs.assistant': 'Agent',
  'mobile.tabs.scheduled': 'Zadania',
  'mobile.tabs.settings': 'Ustaw',
  'lynx.shell.back': 'Wstecz',
  'lynx.shell.chat.title': 'Czat',
  'lynx.shell.stub.body': 'Ten ekran to oznaczony szkielet. Nie jest podłączony do API OpenChamber.',
  'lynx.shell.stub.openChat': 'Otwórz szkieletową stronę czatu',
  'lynx.shell.chat.stub': 'Czat to wypchnięta strona. Transkrypcja LegendList 1.19 to inny tor.',
  'lynx.shell.settings.stub': 'Edytory ustawień to inny tor. Tutaj wypisane są tylko identyfikatory.',
};

const ptBR: LynxDictionary = {
  'mobile.nav.aria': 'Navegação móvel',
  'mobile.nav.secondaryPageAria': 'Página de detalhes',
  'mobile.tabs.projects': 'Projetos',
  'mobile.tabs.assistant': 'Assist.',
  'mobile.tabs.scheduled': 'Tarefas',
  'mobile.tabs.settings': 'Ajustes',
  'lynx.shell.back': 'Voltar',
  'lynx.shell.chat.title': 'Chat',
  'lynx.shell.stub.body': 'Esta superfície é um stub rotulado. Não está conectada às APIs do OpenChamber.',
  'lynx.shell.stub.openChat': 'Abrir a página de chat stub',
  'lynx.shell.chat.stub': 'O chat é uma página empurrada. A transcrição LegendList 1.19 é outra trilha.',
  'lynx.shell.settings.stub': 'Os editores de configurações são outra trilha. Aqui só listamos os slugs.',
};

const uk: LynxDictionary = {
  'mobile.nav.aria': 'Мобільна навігація',
  'mobile.nav.secondaryPageAria': 'Сторінка деталей',
  'mobile.tabs.projects': 'Проєкти',
  'mobile.tabs.assistant': 'Асист.',
  'mobile.tabs.scheduled': 'Задачі',
  'mobile.tabs.settings': 'Опції',
  'lynx.shell.back': 'Назад',
  'lynx.shell.chat.title': 'Чат',
  'lynx.shell.stub.body': 'Ця поверхня — позначена заглушка. Вона не підключена до API OpenChamber.',
  'lynx.shell.stub.openChat': 'Відкрити заглушку чату',
  'lynx.shell.chat.stub': 'Чат — це виштовхнута сторінка. Транскрипт LegendList 1.19 — інша гілка.',
  'lynx.shell.settings.stub': 'Редактори налаштувань — інша гілка. Тут лише перелік ідентифікаторів.',
};

const zhCN: LynxDictionary = {
  'mobile.nav.aria': '移动导航',
  'mobile.nav.secondaryPageAria': '详情页',
  'mobile.tabs.projects': '项目',
  'mobile.tabs.assistant': '助理',
  'mobile.tabs.scheduled': '计划',
  'mobile.tabs.settings': '设置',
  'lynx.shell.back': '返回',
  'lynx.shell.chat.title': '聊天',
  'lynx.shell.stub.body': '此界面是已标注的占位。尚未接入 OpenChamber API。',
  'lynx.shell.stub.openChat': '打开占位聊天页',
  'lynx.shell.chat.stub': '聊天是推入的二级页。1.19 LegendList 会话列表由另一条轨道实现。',
  'lynx.shell.settings.stub': '设置编辑器由另一条轨道实现。这里只列出页面标识。',
};

const zhTW: LynxDictionary = {
  'mobile.nav.aria': '行動導覽',
  'mobile.nav.secondaryPageAria': '詳細資料頁',
  'mobile.tabs.projects': '專案',
  'mobile.tabs.assistant': '助理',
  'mobile.tabs.scheduled': '計劃',
  'mobile.tabs.settings': '設定',
  'lynx.shell.back': '返回',
  'lynx.shell.chat.title': '聊天',
  'lynx.shell.stub.body': '此畫面是已標示的占位。尚未接上 OpenChamber API。',
  'lynx.shell.stub.openChat': '開啟占位聊天頁',
  'lynx.shell.chat.stub': '聊天是推入的次級頁。1.19 LegendList 對話列表由另一條軌道實作。',
  'lynx.shell.settings.stub': '設定編輯器由另一條軌道實作。這裡只列出頁面識別碼。',
};

export const LYNX_MESSAGES: Record<LynxLocale, LynxDictionary> = {
  en,
  es,
  fr,
  ja,
  ko,
  pl,
  'pt-BR': ptBR,
  uk,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

export function resolveLynxLocale(value: string | undefined): LynxLocale {
  if (value && (LYNX_LOCALES as readonly string[]).includes(value)) {
    return value as LynxLocale;
  }
  return 'en';
}

export function lynxT(locale: string, key: LynxMessageKey): string {
  return LYNX_MESSAGES[resolveLynxLocale(locale)][key];
}

export function tabLabel(locale: string, tabId: LynxTabId): string {
  const tab = LYNX_TABS.find((item) => item.id === tabId);
  return tab ? lynxT(locale, tab.labelKey) : tabId;
}
