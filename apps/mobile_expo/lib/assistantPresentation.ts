type AssistantPresentation = {
  avatarEmoji?: string;
  displayName: string;
};

/**
 * Hermes (RN) does not ship Intl.Segmenter — `new Intl.Segmenter(...)` throws
 * "undefined cannot be used as a constructor" and kills cold start after
 * ReactNativeJS Running main. Use a Unicode emoji regex instead (Cap/WebView
 * still has Segmenter; Expo must not rely on it at module load).
 */
const LEADING_EMOJI =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{2})/u;

/** Cap `getAssistantPresentation` — leading emoji becomes avatar, rest is title. */
export const getAssistantPresentation = (name: string): AssistantPresentation => {
  const match = name.match(LEADING_EMOJI);
  if (!match) return { displayName: name };

  return {
    avatarEmoji: match[0],
    displayName: name.slice(match[0].length).trimStart(),
  };
};
