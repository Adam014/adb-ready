#!/usr/bin/env python3
"""Run one deterministic CLI interaction in a real Unix pseudo-terminal."""

import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time


def main() -> int:
    if "--" not in sys.argv:
        raise SystemExit("usage: pty-driver.py -- COMMAND...")
    command = sys.argv[sys.argv.index("--") + 1 :]
    if not command:
        raise SystemExit("PTY command is missing")
    wait_for = os.environ["ADB_READY_PTY_WAIT_FOR"].encode()
    input_bytes = bytes.fromhex(os.environ["ADB_READY_PTY_INPUT_HEX"])
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    initial = termios.tcgetattr(slave)
    child = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=os.environ.copy(),
        close_fds=True,
    )
    captured = bytearray()
    sent = False
    deadline = time.monotonic() + 5
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    captured.extend(chunk)
                    if not sent and wait_for in captured:
                        os.write(master, input_bytes)
                        sent = True
            if child.poll() is not None:
                while True:
                    readable, _, _ = select.select([master], [], [], 0)
                    if not readable:
                        break
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    captured.extend(chunk)
                break
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            raise TimeoutError("PTY child timed out")
        if not sent:
            raise RuntimeError("PTY prompt was not observed")
        final = termios.tcgetattr(slave)
        state = {
            "echo": bool(final[3] & termios.ECHO),
            "icanon": bool(final[3] & termios.ICANON),
            "restored": final == initial,
            "exitCode": child.returncode,
        }
        sys.stdout.buffer.write(captured)
        sys.stdout.write(f"\nPTY_DRIVER_STATE {json.dumps(state, sort_keys=True)}\n")
        return 0
    finally:
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(f"PTY_DRIVER_ERROR {type(error).__name__}: {error}\n")
        raise SystemExit(1)
