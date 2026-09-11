import process from "node:process";
import { activateAgentTaskFromEnvironment } from "../../src/agent/dev-task.js";

const managed = await activateAgentTaskFromEnvironment(process.env);
if (managed === undefined) throw new Error("Managed task fixture was not activated");

if (process.env.ADB_READY_TASK_FIXTURE_ABRUPT === "1") {
  await new Promise<void>(() => {
    process.once("SIGTERM", () => process.exit(143));
  });
} else if (process.env.ADB_READY_TASK_FIXTURE_WAIT === "1") {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void managed.finish(130).finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.exitCode = 130;
} else {
  await managed.finish(0);
}
