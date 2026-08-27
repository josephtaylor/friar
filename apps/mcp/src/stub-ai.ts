// Build-time stub for the optional "ai" (Vercel AI SDK) dependency of the agents
// package. Only reached via McpAgent client paths (getAITools) this worker never calls.
export function jsonSchema(): never {
  throw new Error("the 'ai' package is not bundled in friar-mcp");
}
