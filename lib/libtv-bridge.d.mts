export type BridgeConfig = {
  nasRoot: string; token: string; maxBytes: number; lanTemplateId?: string | null;
  owners: Record<string, { userId: string; siteId: string; ownerId: string; templateId: string; ootdTemplateId?: string; autoQueue?: boolean }>;
};
export function bridgeConfig(env?: NodeJS.ProcessEnv): BridgeConfig;
export function authenticateBridge(authorization: string | null, config: BridgeConfig): boolean;
export function enqueueImport(root: string, config: BridgeConfig, input: unknown): Promise<unknown>;
export function importStatus(root: string, config: BridgeConfig, id: string, userId: string, siteId: string): Promise<unknown>;
export function bridgeTick(root: string, config: BridgeConfig): Promise<boolean>;
export function sharedPath(root: string, relative: string, options?: { existing?: boolean }): Promise<string>;
export function hashFile(path: string): Promise<string>;
