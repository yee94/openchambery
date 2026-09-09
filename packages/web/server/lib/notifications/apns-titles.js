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

/** @typedef {'ready'|'error'|'question'|'permission'|'goal_complete'|'goal_blocked'|'goal_budget'|'task_complete'|'task_error'|'update'} ApnsTitleType */

const TITLES = Object.freeze({
  en: Object.freeze({
    ready: 'Task completed',
    error: 'Something went wrong',
    question: 'Needs your answer',
    permission: 'Needs permission',
    goal_complete: 'Goal completed',
    goal_blocked: 'Goal blocked',
    goal_budget: 'Token budget reached',
    task_complete: 'Scheduled task completed',
    task_error: 'Scheduled task failed',
    update: 'Update',
    session: 'Session',
  }),
  fr: Object.freeze({
    ready: 'Tâche terminée',
    error: "Une erreur s'est produite",
    question: 'Besoin de votre réponse',
    permission: 'Autorisation requise',
    goal_complete: 'Objectif atteint',
    goal_blocked: 'Objectif bloqué',
    goal_budget: 'Budget de tokens atteint',
    task_complete: 'Tâche planifiée terminée',
    task_error: 'Échec de la tâche planifiée',
    update: 'Mise à jour',
    session: 'Session',
  }),
  'zh-CN': Object.freeze({
    ready: '任务已完成',
    error: '出现错误',
    question: '需要你回答',
    permission: '需要你授权',
    goal_complete: '目标已完成',
    goal_blocked: '目标受阻',
    goal_budget: '已达用量上限',
    task_complete: '定时任务已完成',
    task_error: '定时任务失败',
    update: '有新进展',
    session: '会话',
  }),
  'zh-TW': Object.freeze({
    ready: '任務已完成',
    error: '出現錯誤',
    question: '需要你回答',
    permission: '需要你授權',
    goal_complete: '目標已完成',
    goal_blocked: '目標受阻',
    goal_budget: '已達用量上限',
    task_complete: '排程任務已完成',
    task_error: '排程任務失敗',
    update: '有新進展',
    session: '工作階段',
  }),
  uk: Object.freeze({
    ready: 'Завдання виконано',
    error: 'Сталася помилка',
    question: 'Потрібна ваша відповідь',
    permission: 'Потрібен дозвіл',
    goal_complete: 'Цілі досягнуто',
    goal_blocked: 'Цілі заблоковано',
    goal_budget: 'Досягнуто ліміт токенів',
    task_complete: 'Заплановане завдання виконано',
    task_error: 'Заплановане завдання не вдалося',
    update: 'Оновлення',
    session: 'Сесія',
  }),
  es: Object.freeze({
    ready: 'Tarea completada',
    error: 'Se produjo un error',
    question: 'Necesita tu respuesta',
    permission: 'Necesita permiso',
    goal_complete: 'Objetivo completado',
    goal_blocked: 'Objetivo bloqueado',
    goal_budget: 'Presupuesto de tokens alcanzado',
    task_complete: 'Tarea programada completada',
    task_error: 'La tarea programada falló',
    update: 'Actualización',
    session: 'Sesión',
  }),
  'pt-BR': Object.freeze({
    ready: 'Tarefa concluída',
    error: 'Ocorreu um erro',
    question: 'Precisa da sua resposta',
    permission: 'Precisa de permissão',
    goal_complete: 'Objetivo concluído',
    goal_blocked: 'Objetivo bloqueado',
    goal_budget: 'Orçamento de tokens atingido',
    task_complete: 'Tarefa agendada concluída',
    task_error: 'A tarefa agendada falhou',
    update: 'Atualização',
    session: 'Sessão',
  }),
  ko: Object.freeze({
    ready: '작업 완료',
    error: '오류가 발생했습니다',
    question: '답변이 필요합니다',
    permission: '권한이 필요합니다',
    goal_complete: '목표 완료',
    goal_blocked: '목표 차단됨',
    goal_budget: '토큰 한도 도달',
    task_complete: '예약 작업 완료',
    task_error: '예약 작업 실패',
    update: '업데이트',
    session: '세션',
  }),
  pl: Object.freeze({
    ready: 'Zadanie ukończone',
    error: 'Wystąpił błąd',
    question: 'Potrzebna twoja odpowiedź',
    permission: 'Potrzebne uprawnienie',
    goal_complete: 'Cel ukończony',
    goal_blocked: 'Cel zablokowany',
    goal_budget: 'Osiągnięto limit tokenów',
    task_complete: 'Zadanie zaplanowane ukończone',
    task_error: 'Zadanie zaplanowane nie powiodło się',
    update: 'Aktualizacja',
    session: 'Sesja',
  }),
  ja: Object.freeze({
    ready: 'タスク完了',
    error: 'エラーが発生しました',
    question: '回答が必要です',
    permission: '許可が必要です',
    goal_complete: '目標完了',
    goal_blocked: '目標がブロックされました',
    goal_budget: 'トークン上限に達しました',
    task_complete: 'スケジュールタスクが完了しました',
    task_error: 'スケジュールタスクに失敗しました',
    update: '更新',
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
