/**
 * Beacon Whitelist Tool for OpenCode
 * Allow indexing in otherwise-blacklisted directories
 * Replaces: /whitelist command from Claude Code version
 */

import { tool } from "@opencode-ai/plugin";

export default tool({
  description:
    "Manage whitelist - allow indexing in specific directories even if they match blacklist patterns",
  args: {
    action: tool.schema
      .enum(["list", "add", "remove"])
      .optional()
      .describe("Action: 'list' to show whitelist, 'add'/'remove' to modify"),
    path: tool.schema
      .string()
      .optional()
      .describe("Directory path to add or remove from whitelist"),
  },
  async execute(args, context): Promise<string> {
    try {
      // TODO: Implement whitelist management
      // This will:
      // 1. Read .opencode/whitelist.json
      // 2. Add/remove paths as requested
      // 3. Re-validate after changes
      return JSON.stringify({
        status: "placeholder",
        message:
          "Whitelist tool initialized (database integration coming soon)",
        action: args.action ?? "list",
        path: args.path,
      });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Whitelist operation failed: ${errorMessage}`,
      });
    }
  },
});
