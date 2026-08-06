import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
});

try {
  const result = await thread.run("This is a connection check. Do not call tools or change files. Reply with exactly: READY");
  const response = result.finalResponse.trim();
  console.log(JSON.stringify({ ready: response === "READY", response, threadId: thread.id }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const usageMatch = message.match(/usage limit|hit your usage|try again at ([^,]+)/i);
  const authMatch = message.match(/auth|oauth|login|unauthori[sz]ed|forbidden/i);
  const reason = usageMatch
    ? `Codex usage limit reached${message.match(/try again at ([^,]+)/i)?.[1] ? `, resets ${message.match(/try again at ([^,]+)/i)[1].trim()}` : ''}`
    : authMatch
    ? `Codex auth expired`
    : `Codex connection failed: ${message.slice(-200)}`;
  console.log(JSON.stringify({ ready: false, response: reason, error: message.slice(-500) }));
  process.exitCode = 0;
}
