export function readJson<T>(file: string, fallback: T): Promise<T>;
export function writeJsonAtomic(file: string, value: unknown): Promise<void>;
export function withFileLock<T>(file: string, operation: () => Promise<T>, options?: { timeoutMs?: number; staleMs?: number }): Promise<T>;
