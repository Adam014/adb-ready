import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** @param {string[]} args */
function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

const tracked = git(["ls-files", "--", "AGENTS.md", "context"]);
if (tracked !== "") {
  throw new Error(`private working documents are tracked: ${tracked.replaceAll("\n", ", ")}`);
}

const history = git(["log", "--all", "--format=%H", "--", "AGENTS.md", "context"]);
if (history !== "") {
  throw new Error("private working documents are reachable from the local Git history");
}

for (const localPath of ["AGENTS.md", "context/README.md"]) {
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", localPath], {
    cwd: root,
    shell: false,
    windowsHide: true,
  });
  if (ignored.status !== 0) {
    throw new Error(`${localPath} is not protected by .gitignore`);
  }
}

process.stdout.write(
  "✓ private research and agent context are untracked, ignored, and absent from refs\n",
);
