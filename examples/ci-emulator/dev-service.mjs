let stopping = false;

const keepAlive = setInterval(() => undefined, 60_000);

function stop() {
  if (stopping) return;
  stopping = true;
  process.stderr.write("CI development service stopped.\n");
  clearInterval(keepAlive);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.stderr.write("CI development service ready.\n");
