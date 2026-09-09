import process from "node:process";

const args = process.argv.slice(2);
const command = [
  "version",
  "host-features",
  "server-status",
  "devices",
  "mdns",
  "ro.serialno",
].find((candidate) => args.includes(candidate));
const scenario = process.env.ADB_READY_FAKE_SCENARIO ?? "ready";

if (scenario === "failure") {
  process.stderr.write("fake ADB operation failed\n");
  process.exitCode = 1;
} else if (command === "version") {
  process.stdout.write(
    "Android Debug Bridge version 1.0.41\n" +
      "Version 37.0.0-14910828\n" +
      "Installed as /fixture/android-sdk/platform-tools/adb\n",
  );
} else if (command === "host-features") {
  process.stdout.write("shell_v2,abb_exec,server_status\n");
} else if (command === "server-status") {
  process.stdout.write("USB backend: libusb\nServer version: 41\n");
} else if (command === "devices") {
  const body =
    scenario === "empty"
      ? ""
      : scenario === "mixed"
        ? "fixture-usb unauthorized model:Pixel_9 transport_id:1\nfixture-wifi offline model:Pixel_8 transport_id:2\n"
        : "fixture-usb device product:komodo model:Pixel_9 device:komodo transport_id:1\n";
  process.stdout.write(`List of devices attached\n${body}`);
} else if (command === "mdns") {
  process.stdout.write("List of discovered mdns services\n");
} else if (command === "ro.serialno") {
  process.stdout.write("fixture-hardware-serial\n");
} else {
  process.stderr.write(`unsupported fake ADB arguments: ${args.join(" ")}\n`);
  process.exitCode = 1;
}
