const greetings = {
  en: (name) => `Hi, I'm ${name}. How can I help you?`,
  'zh-CN': (name) => `你好，我是${name}，有什么可以帮你的吗？`,
  'zh-TW': (name) => `你好，我是${name}，有什麼可以幫你的嗎？`,
  es: (name) => `Hola, soy ${name}. ¿En qué puedo ayudarte?`,
  fr: (name) => `Bonjour, je m'appelle ${name}. Comment puis-je vous aider ?`,
  ja: (name) => `こんにちは、${name}です。何かお手伝いできることはありますか？`,
  ko: (name) => `안녕하세요, ${name}입니다. 무엇을 도와드릴까요?`,
  pl: (name) => `Cześć, jestem ${name}. W czym mogę pomóc?`,
  'pt-BR': (name) => `Olá, sou ${name}. Como posso ajudar?`,
  uk: (name) => `Привіт, я ${name}. Чим можу допомогти?`,
};

export function getContactGreeting(name, language) {
  const locale = typeof language === 'string' ? language.trim() : 'en';
  const greeting = Object.hasOwn(greetings, locale) ? greetings[locale] : greetings.en;
  return greeting(name);
}
