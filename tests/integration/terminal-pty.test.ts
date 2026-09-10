import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const supportedPlatform = process.platform === "darwin" || process.platform === "linux";
const pythonExecutable = process.env.PYTHON ?? "python3";
const hasPythonPty = supportedPlatform
  ? spawnSync(pythonExecutable, ["-c", "import pty, termios"], { stdio: "ignore" }).status === 0
  : false;
const ptyTest = hasPythonPty ? test : test.skip;

interface PtyResult {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

async function runPty(
  command: readonly string[],
  waitFor: string,
  input: string,
): Promise<PtyResult> {
  return await new Promise<PtyResult>((resolve, reject) => {
    const child = spawn(
      pythonExecutable,
      [path.join(root, "tests", "fixtures", "pty-driver.py"), "--", ...command],
      {
        cwd: root,
        env: {
          ...process.env,
          ADB_READY_PTY_WAIT_FOR: waitFor,
          ADB_READY_PTY_INPUT_HEX: Buffer.from(input).toString("hex"),
          ADB_READY_REDUCED_MOTION: "1",
          CI: undefined,
          LANG: process.env.LANG ?? "C.UTF-8",
          NO_COLOR: "1",
          TERM: "xterm-256color",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    const receive = (chunk: Uint8Array) => {
      output += new TextDecoder().decode(chunk);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`PTY fixture timed out after 7000ms\n${output.slice(-2_000)}`));
    }, 7_000);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ output, exitCode, signal });
    });
  });
}

function expectRestored(result: PtyResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.output).toContain(
    'PTY_DRIVER_STATE {"echo": true, "exitCode": 0, "icanon": true, "restored": true}',
  );
  expect(result.output.lastIndexOf("\u001B[?25h")).toBeGreaterThan(
    result.output.lastIndexOf("\u001B[?25l"),
  );
}

ptyTest("drives a real confirmation prompt and restores the terminal", async () => {
  const result = await runPty(
    [process.execPath, "run", "scripts/ui-playground.ts", "--scenario=confirmation"],
    "Proceed with this exact action?",
    "\u001B[B\r",
  );

  expectRestored(result);
  expect(result.output).toContain("Fixture result: confirmed. No target was changed.");
});

ptyTest("restores the real terminal after Ctrl-C in raw mode", async () => {
  const result = await runPty(
    [process.execPath, "run", "scripts/ui-playground.ts", "--scenario=confirmation"],
    "Proceed with this exact action?",
    "\u0003",
  );

  expectRestored(result);
  expect(result.output).toContain("Fixture result: cancelled. No target was changed.");
});
