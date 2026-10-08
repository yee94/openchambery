export type ConfigObject = Record<string, unknown>;
export type ConfigDocument = { path: string; scope: 'user' | 'project' | 'custom'; config: ConfigObject };
export type ConfigLayers = {
  userConfig: ConfigObject; projectConfig: ConfigObject; customConfig: ConfigObject; mergedConfig: ConfigObject;
  userLayers: ConfigDocument[]; projectLayers: ConfigDocument[]; documents: ConfigDocument[];
  paths: { userPath: string; projectPath: string | null; customPath: string | null };
};
export function getGlobalConfigDirectory(): string;
export function isPlainObject(value: unknown): value is ConfigObject;
export function readConfigFile(filePath?: string | null): ConfigObject;
export function readConfigLayers(workingDirectory?: string): ConfigLayers;
export function readConfig(workingDirectory?: string): ConfigObject;
export function getConfigForPath(layers: ConfigLayers, targetPath?: string | null): ConfigObject;
export function getJsonEntrySource(layers: ConfigLayers, sectionKey: string, entryName: string): { section: unknown; config: ConfigObject | null; path: string | null; exists: boolean };
export function getJsonWriteTarget(layers: ConfigLayers, preferredScope: string): { config: ConfigObject; path: string };
export function writeConfig(config: ConfigObject, filePath?: string): void;
export function writeConfigText(content: string, filePath: string): void;
