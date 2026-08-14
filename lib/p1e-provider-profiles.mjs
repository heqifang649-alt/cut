export const P1E_PROVIDER_PROFILE_SCHEMA_VERSION = "p1e-provider-profile.v1";

const PROVIDERS = Object.freeze({
  gemini: Object.freeze({
    id: "gemini",
    displayName: "Gemini API",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocolMode: "chat_completions",
    candidateModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
    nativeVideoSupport: "UNVERIFIED",
    notes: "OpenAI-compatible Chat Completions path. P1E begins with Cutflow multi-frame inputs; a native-video route requires separate real evidence before use.",
  }),
  qwen25vl: Object.freeze({
    id: "qwen25vl",
    displayName: "Qwen2.5-VL API",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocolMode: "chat_completions",
    candidateModels: ["qwen2.5-vl-72b-instruct", "qwen2.5-vl-32b-instruct", "qwen2.5-vl-7b-instruct"],
    nativeVideoSupport: "UNVERIFIED",
    notes: "OpenAI-compatible Chat Completions path. P1E begins with Cutflow multi-frame inputs; a native-video route requires separate real evidence before use.",
  }),
});

function cloneProfile(profile) {
  return profile ? { ...profile, candidateModels: [...profile.candidateModels] } : null;
}

export function p1eProviderProfiles() {
  return Object.values(PROVIDERS).map(cloneProfile);
}

export function p1eProviderProfile(id) {
  return cloneProfile(PROVIDERS[typeof id === "string" ? id.trim().toLowerCase() : ""]);
}

export function p1eProviderConfig(profile, { apiKey, model, requestTimeoutMs = 30_000, maxConcurrency = 1, requestCap = 32, retryLimit = 1 } = {}) {
  if (!profile) throw new Error("A known P1E Provider profile is required.");
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error(`${profile.displayName} API key is required for a real P1E request.`);
  return {
    providerName: profile.displayName,
    baseUrl: profile.baseUrl,
    apiKey: apiKey.trim(),
    protocolMode: profile.protocolMode,
    candidateModels: [...profile.candidateModels],
    fastModel: typeof model === "string" ? model.trim() : "",
    strongModel: "",
    requestTimeoutMs,
    maxConcurrency,
    pilotRequestCap: requestCap,
    retryLimit,
  };
}
