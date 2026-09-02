// Localized scenario titles for native push (APNs / FCM). Keys match UI locales.
// Titles stay content-free (scenario only); session name is the body separately.

export const APNS_DEFAULT_LOCALE = 'en';

export const APNS_LOCALES = Object.freeze([
  'en',
  'fr',
  'zh-CN',
  'zh-TW',
  'uk',
  'es',
  'pt-BR',
  'ko',
  'pl',
  'ja',
]);

/** @typedef {'ready'|'error'|'question'|'permission'|'goal_complete'|'goal_blocked'|'goal_budget'|'update'} ApnsTitleType */

const TITLES = Object.freeze({
  en: Object.freeze({
    ready: 'Agent response is ready',
    error: 'Agent hit an error',
    question: 'Agent needs your input',
    permission: 'Agent needs permission',
    goal_complete: 'Goal complete',
    goal_blocked: 'Goal blocked',
    goal_budget: 'Goal reached its token budget',
    update: 'Agent update',
    session: 'Session',
  }),
  fr: Object.freeze({
    ready: "La réponse de l'agent est prête",
    error: "L'agent a rencontré une erreur",
    question: "L'agent a besoin de votre saisie",
    permission: "L'agent a besoin d'une autorisation",
    goal_complete: 'Objectif terminé',
    goal_blocked: 'Objectif bloqué',
    goal_budget: "L'objectif a atteint son budget de tokens",
    update: "Mise à jour de l'agent",
    session: 'Session',
  }),
  'zh-CN': Object.freeze({
    ready: '智能体回复已就绪',
    error: '智能体遇到错误',
    question: '智能体需要你的输入',
    permission: '智能体需要权限',
    goal_complete: '目标已完成',
    goal_blocked: '目标受阻',
    goal_budget: '目标已达 token 预算',
    update: '智能体更新',
    session: '会话',
  }),
  'zh-TW': Object.freeze({
    ready: '智能體回覆已就緒',
    error: '智能體遇到錯誤',
    question: '智能體需要你的輸入',
    permission: '智能體需要權限',
    goal_complete: '目標已完成',
    goal_blocked: '目標受阻',
    goal_budget: '目標已達 token 預算',
    update: '智能體更新',
    session: '工作階段',
  }),
  uk: Object.freeze({
    ready: 'Відповідь агента готова',
    error: 'Агент зіткнувся з помилкою',
    question: 'Агенту потрібне ваше введення',
    permission: 'Агенту потрібен дозвіл',
    goal_complete: 'Цілі досягнуто',
    goal_blocked: 'Цілі заблоковано',
    goal_budget: 'Ціль досягла ліміту токенів',
    update: 'Оновлення агента',
    session: 'Сесія',
  }),
  es: Object.freeze({
    ready: 'La respuesta del agente está lista',
    error: 'El agente encontró un error',
    question: 'El agente necesita tu entrada',
    permission: 'El agente necesita permiso',
    goal_complete: 'Objetivo completado',
    goal_blocked: 'Objetivo bloqueado',
    goal_budget: 'El objetivo alcanzó su presupuesto de tokens',
    update: 'Actualización del agente',
    session: 'Sesión',
  }),
  'pt-BR': Object.freeze({
    ready: 'A resposta do agente está pronta',
    error: 'O agente encontrou um erro',
    question: 'O agente precisa da sua entrada',
    permission: 'O agente precisa de permissão',
    goal_complete: 'Objetivo concluído',
    goal_blocked: 'Objetivo bloqueado',
    goal_budget: 'O objetivo atingiu o orçamento de tokens',
    update: 'Atualização do agente',
    session: 'Sessão',
  }),
  ko: Object.freeze({
    ready: '에이전트 응답이 준비되었습니다',
    error: '에이전트에서 오류가 발생했습니다',
    question: '에이전트가 입력을 요청합니다',
    permission: '에이전트가 권한이 필요합니다',
    goal_complete: '목표 완료',
    goal_blocked: '목표 차단됨',
    goal_budget: '목표가 토큰 예산에 도달했습니다',
    update: '에이전트 업데이트',
    session: '세션',
  }),
  pl: Object.freeze({
    ready: 'Odpowiedź agenta jest gotowa',
    error: 'Agent napotkał błąd',
    question: 'Agent potrzebuje Twojego wejścia',
    permission: 'Agent potrzebuje uprawnienia',
    goal_complete: 'Cel ukończony',
    goal_blocked: 'Cel zablokowany',
    goal_budget: 'Cel osiągnął budżet tokenów',
    update: 'Aktualizacja agenta',
    session: 'Sesja',
  }),
  ja: Object.freeze({
    ready: 'エージェントの応答が準備できました',
    error: 'エージェントでエラーが発生しました',
    question: 'エージェントが入力を求めています',
    permission: 'エージェントが許可を求めています',
    goal_complete: '目標完了',
    goal_blocked: '目標がブロックされました',
    goal_budget: '目標がトークン予算に達しました',
    update: 'エージェントの更新',
    session: 'セッション',
  }),
});

const matchSupportedLocale = (value) => {
  if (!value || typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (
    normalized === 'zh-tw'
    || normalized.startsWith('zh-tw-')
    || normalized === 'zh-hk'
    || normalized.startsWith('zh-hk-')
    || normalized === 'zh-mo'
    || normalized.startsWith('zh-mo-')
    || normalized === 'zh-hant'
    || normalized.startsWith('zh-hant-')
  ) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('en')) return 'en';
  if (normalized === 'fr' || normalized.startsWith('fr-')) return 'fr';
  if (normalized === 'uk' || normalized.startsWith('uk-') || normalized === 'ua' || normalized.startsWith('ua-')) {
    return 'uk';
  }
  if (normalized === 'es' || normalized.startsWith('es-')) return 'es';
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-BR';
  if (normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
  if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja';
  if (normalized === 'pl' || normalized.startsWith('pl-')) return 'pl';
  return undefined;
};

export const normalizeApnsLocale = (value) => matchSupportedLocale(value) ?? APNS_DEFAULT_LOCALE;

const titlesFor = (locale) => TITLES[normalizeApnsLocale(locale)] || TITLES[APNS_DEFAULT_LOCALE];

/**
 * @param {string|undefined|null} type
 * @param {string|undefined|null} locale
 */
export const resolveApnsTitle = (type, locale) => {
  const dict = titlesFor(locale);
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(dict, type) && type !== 'session') {
    return dict[type];
  }
  return dict.update;
};

/**
 * @param {string|undefined|null} locale
 */
export const resolveApnsSessionFallback = (locale) => titlesFor(locale).session;

/**
 * Localize a generic native-push payload for one device locale.
 * `payload.type` selects the scenario title; `payload.sessionName` (or non-empty body) is the body.
 * Callers that already pass a fixed `title`/`body` (tests / legacy) keep that text when `type` is absent.
 *
 * @param {{ type?: string, title?: string, body?: string, sessionName?: string, badge?: number, tag?: string, data?: object }} payload
 * @param {string|undefined|null} locale
 */
export const localizeApnsPayload = (payload, locale) => {
  const type = typeof payload?.type === 'string' ? payload.type : undefined;
  const sessionName = typeof payload?.sessionName === 'string' && payload.sessionName.trim().length > 0
    ? payload.sessionName.trim()
    : '';
  const legacyBody = typeof payload?.body === 'string' && payload.body.trim().length > 0
    ? payload.body.trim()
    : '';
  const title = type
    ? resolveApnsTitle(type, locale)
    : (typeof payload?.title === 'string' && payload.title.length > 0
      ? payload.title
      : resolveApnsTitle('update', locale));
  return {
    title,
    body: sessionName || legacyBody || resolveApnsSessionFallback(locale),
    badge: payload?.badge,
    tag: payload?.tag,
    data: payload?.data,
  };
};
