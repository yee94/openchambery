export const useSessionParts = () => [];
let errorAt: number | undefined;
export const setFixtureSessionErrorAt = (value: number | undefined) => { errorAt = value; };
export const useSessionErrorAt = () => errorAt;
export const useDirectorySync = () => false;
