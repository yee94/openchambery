export const workspace = {
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
};

export const window = {
  activeColorTheme: { kind: 1 },
  ColorThemeKind: { Light: 1, HighContrastLight: 4 },
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
};

export const ColorThemeKind = { Light: 1, HighContrastLight: 4 };

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
  parse: (value: string) => ({ fsPath: value, scheme: 'file' }),
};

export const commands = {
  executeCommand: async () => undefined,
};

export const extensions = {
  getExtension: () => undefined,
};

export default {
  workspace,
  window,
  ColorThemeKind,
  Uri,
  commands,
  extensions,
};
