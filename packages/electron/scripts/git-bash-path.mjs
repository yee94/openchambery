export const toGitBashPath = (filePath) => {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
};
