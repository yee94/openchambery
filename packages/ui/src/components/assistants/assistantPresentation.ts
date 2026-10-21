type AssistantPresentation = {
  displayName: string;
};

export const getAssistantPresentation = (name: string): AssistantPresentation => {
  return { displayName: name };
};
