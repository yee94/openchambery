export const buildDiffNavigationAlignKey = (input: {
    scope: string;
    navigationRequestKey?: number;
    targetFilePath?: string | null;
    targetLine?: number | null;
}): string => (
    `${input.scope}:${input.navigationRequestKey ?? ''}:${(input.targetFilePath ?? '').trim()}:${input.targetLine ?? ''}`
);

export const shouldAlignDiffNavigation = (
    lastAlignedKey: string | null,
    nextKey: string,
    targetExists: boolean,
): boolean => targetExists && lastAlignedKey !== nextKey;
