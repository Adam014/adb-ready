export type McpProfile = "debug" | "full" | "session" | "ui";

export interface McpToolMetadata {
  category: "debug" | "foundation" | "session" | "ui";
  profiles: McpProfile[];
  sensitiveData: boolean;
}

const FOUNDATION = ["doctor", "get_capabilities", "list_targets", "ensure_ready"] as const;
const APP_LIFECYCLE = [
  "resolve_app",
  "install_app",
  "launch_app",
  "restart_app",
  "open_url",
] as const;
const SESSION = ["start_dev_session", "get_dev_session", "stop_dev_session"] as const;
const DEBUG = [
  "inspect_app",
  "inspect_failures",
  "inspect_ui",
  "capture_screenshot",
  "list_sessions",
  "get_session_problems",
  "compile_debug_context",
] as const;
const UI = [
  "inspect_ui",
  "audit_ui",
  "inspect_keyboard",
  "dismiss_keyboard",
  "inspect_permission_dialog",
  "respond_to_permission_dialog",
  "find_ui",
  "get_ui",
  "assert_ui",
  "compare_ui",
  "tap_ui",
  "long_press_ui",
  "swipe_ui",
  "scroll_ui",
  "type_text_ui",
  "fill_ui",
  "clear_ui",
  "press_key_ui",
  "wait_for_ui",
  "capture_screenshot",
] as const;

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const MCP_PROFILE_TOOLS: Readonly<Record<McpProfile, readonly string[]>> = {
  session: unique([...FOUNDATION, ...SESSION, ...APP_LIFECYCLE]),
  ui: unique([...FOUNDATION, ...APP_LIFECYCLE, ...UI]),
  debug: unique([...FOUNDATION, ...APP_LIFECYCLE, ...DEBUG]),
  full: unique([...FOUNDATION, ...SESSION, ...APP_LIFECYCLE, ...DEBUG, ...UI]),
};

const SENSITIVE_TOOLS = new Set([
  "capture_screenshot",
  "compile_debug_context",
  "get_session_problems",
  "inspect_app",
  "inspect_failures",
  "inspect_ui",
  "list_sessions",
]);

function categoryFor(name: string): McpToolMetadata["category"] {
  if ((SESSION as readonly string[]).includes(name)) return "session";
  if ((UI as readonly string[]).includes(name)) return "ui";
  if ((DEBUG as readonly string[]).includes(name)) return "debug";
  return "foundation";
}

export function metadataForTool(name: string): McpToolMetadata {
  const profiles = (Object.keys(MCP_PROFILE_TOOLS) as McpProfile[]).filter((profile) =>
    MCP_PROFILE_TOOLS[profile].includes(name),
  );
  if (profiles.length === 0) throw new Error(`MCP tool ${name} is not assigned to a profile.`);
  return {
    category: categoryFor(name),
    profiles,
    sensitiveData: SENSITIVE_TOOLS.has(name),
  };
}

export function profileIncludesTool(profile: McpProfile, name: string): boolean {
  return MCP_PROFILE_TOOLS[profile].includes(name);
}

export function parseMcpProfile(value: string | undefined): McpProfile | undefined {
  return value === "debug" || value === "full" || value === "session" || value === "ui"
    ? value
    : undefined;
}

export function profileCapabilityDocument(active: McpProfile) {
  return {
    schemaVersion: 1,
    activeProfile: active,
    profiles: (Object.keys(MCP_PROFILE_TOOLS) as McpProfile[]).map((profile) => ({
      name: profile,
      tools: [...MCP_PROFILE_TOOLS[profile]],
    })),
    tasks: {
      extension: "io.modelcontextprotocol/tasks",
      advertised: false,
      compatibilityPath: ["start_dev_session", "get_dev_session", "stop_dev_session"],
      reason:
        "MCP Tasks remain disabled until interoperable capability negotiation is accepted by two supported clients.",
    },
  };
}
