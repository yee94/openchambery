const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emojiClusterPattern = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3)/u;

type AssistantPresentation = {
  avatarEmoji?: string;
  displayName: string;
};

export const getAssistantPresentation = (name: string): AssistantPresentation => {
  const firstSegment = emojiSegmenter.segment(name)[Symbol.iterator]().next().value?.segment;
  if (!firstSegment || !emojiClusterPattern.test(firstSegment)) return { displayName: name };

  return {
    avatarEmoji: firstSegment,
    displayName: name.slice(firstSegment.length).trimStart(),
  };
};
