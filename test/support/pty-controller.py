#!/usr/bin/env python3
"""Real-PTY controller for searchable-prompt qualification (ticket #495).

Allocates a genuine pseudo-terminal via pty.fork() and execs the given
command on it, so the child sees raw-mode keypresses, terminal width, and
redraws — never injected streams. The parent forwards its own stdin to the
pty master and appends all pty output to the transcript file.

Usage:
    pty-controller.py <transcript> <cols> <watchdog-secs> <command...>

The watchdog is absolute: on expiry the child is SIGKILLed and the
controller exits 124, so no probe can orphan a PTY child.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main() -> int:
    transcript_path = sys.argv[1]
    cols = int(sys.argv[2])
    watchdog_secs = int(sys.argv[3])
    command = sys.argv[4:]
    deadline = time.monotonic() + watchdog_secs

    pid, master = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(
                1, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0)
            )
        except OSError:
            pass
        os.execvp(command[0], command)
        os._exit(127)

    def reap_child() -> int:
        # Reap the exact owned PTY child so no zombie outlives the controller
        # and its terminal exit status is preserved as evidence.
        try:
            waited, status = os.waitpid(pid, 0)
            return status
        except ChildProcessError:
            return -1

    def kill_and_reap_child() -> None:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        reap_child()

    state = {"terminating": False}

    def on_term(_signum, _frame):
        # The executor's owned-process cleanup sends SIGTERM to this
        # controller only; the PTY child is ours to kill and reap (#542).
        if state["terminating"]:
            return
        state["terminating"] = True
        transcript = open(transcript_path, "ab", buffering=0)
        try:
            transcript.write(b"\nPTY-CONTROLLER-TERMINATED\n")
        finally:
            transcript.close()
        kill_and_reap_child()
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, on_term)

    stdin_fd = sys.stdin.fileno()
    transcript = open(transcript_path, "ab", buffering=0)
    stdin_open = True
    child_gone = False
    drain_until = 0.0

    try:
        while True:
            if time.monotonic() > deadline:
                transcript.write(b"\nPTY-CONTROLLER-WATCHDOG\n")
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
                # Reap so the watchdog kill leaves no zombie behind.
                reap_child()
                return 124
            if child_gone and time.monotonic() > drain_until:
                return 0
            readable, _, _ = select.select(
                ([stdin_fd] if stdin_open else []) + [master], [], [], 0.1
            )
            for fd in readable:
                if fd == stdin_fd:
                    try:
                        chunk = os.read(stdin_fd, 1024)
                    except OSError:
                        chunk = b""
                    if chunk == b"":
                        stdin_open = False
                    else:
                        try:
                            os.write(master, chunk)
                        except OSError:
                            pass
                else:
                    try:
                        output = os.read(master, 65536)
                    except OSError:
                        output = b""
                    if output == b"":
                        child_gone = True
                        drain_until = time.monotonic() + 0.5
                    else:
                        transcript.write(output)
            try:
                waited, _status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                # Already reaped (the first WNOHANG succeeded); nothing owed.
                waited, _status = 0, 0
            if waited == pid:
                child_gone = True
                drain_until = time.monotonic() + 0.5
    finally:
        transcript.close()
        # Best-effort owned-child cleanup on any exceptional exit path.
        kill_and_reap_child()
        try:
            os.close(master)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
