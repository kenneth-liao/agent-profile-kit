#!/usr/bin/env python3
"""Real-PTY controller for searchable-prompt qualification (ticket #495).

Allocates a genuine pseudo-terminal via pty.fork() and execs the given
command on it, so the child sees raw-mode keypresses, terminal width, and
redraws — never injected streams. The parent forwards its own stdin to the
pty master and appends all pty output to the transcript file.

Usage:
    pty-controller.py <transcript> <cols> <watchdog-secs> <command...>

Lifecycle contract (#542 review):
- The watchdog is absolute and measured in SECONDS: on expiry the child is
  SIGKILLed, reaped, the `PTY-CONTROLLER-WATCHDOG` marker is recorded, and
  the controller exits 124 — no probe can orphan a PTY child.
- Exactly one authoritative ownership record decides cleanup: the child is
  unreaped until ANY successful wait, and once reaped no signal is ever sent
  to the numeric PID again (OS pid reuse makes a blind second kill unsafe).
  TERM, watchdog, and finally cleanup are idempotent through that record.
- A natural child exit stops master polling, drains output once (a single
  finite window), records `PTY-CONTROLLER-EXIT status=<n> signals=<k>`, and
  propagates the child's own outcome as this controller's exit status — the
  child is never reported as a false 0.
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

    # Single authoritative ownership record for the owned PTY child. The pid
    # is unsafe to signal once reaped (the OS may reuse it), so every cleanup
    # path consults this record and never signals a reaped child.
    ownership = {"reaped": False, "status": None}
    signals = 0
    state = {"terminating": False}
    def decoded_status(raw_status: int) -> int:
        if os.WIFEXITED(raw_status):
            return os.WEXITSTATUS(raw_status)
        if os.WIFSIGNALED(raw_status):
            return 128 + os.WTERMSIG(raw_status)
        return raw_status

    def reap(block: bool):
        """The one reap boundary. Returns None when still alive, otherwise
        the child's decoded terminal status. Any successful wait clears
        ownership; later calls observe the recorded status without waiting."""
        if ownership["reaped"]:
            return ownership["status"]
        try:
            waited, raw_status = os.waitpid(
                pid, 0 if block else os.WNOHANG
            )
        except ChildProcessError:
            # Already reaped by another path of this controller; ownership
            # was cleared there. Never touch the numeric pid again.
            ownership["reaped"] = True
            return ownership["status"]
        if not block and waited == 0:
            return None
        ownership["reaped"] = True
        ownership["status"] = decoded_status(raw_status)
        return ownership["status"]

    def note_reaped_cleanup_skipped():
        """Instrumentation: a cleanup path found the child already reaped and
        sent no signal — the no-signal-after-reap guarantee, observable in
        the transcript (PROD-1)."""
        if not state["terminating"]:
            transcript.write(b"\nPTY-CONTROLLER-CLEANUP-SKIPPED-REAPED\n")

    def on_term(_signum, _frame):
        # The executor's owned-process cleanup sends SIGTERM to this
        # controller only; the PTY child is ours to kill and reap (#542).
        # A TERM landing after the watchdog fired must not overwrite the
        # watchdog's 124 exit contract; a TERM after a completed reap must
        # not signal the (possibly reused) pid.
        if state["terminating"]:
            return
        state["terminating"] = True
        if not ownership["reaped"]:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
        else:
            note_reaped_cleanup_skipped()
        reap(block=True)
        transcript = open(transcript_path, "ab", buffering=0)
        try:
            transcript.write(b"\nPTY-CONTROLLER-TERMINATED\n")
        finally:
            transcript.close()
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, on_term)

    stdin_fd = sys.stdin.fileno()
    transcript = open(transcript_path, "ab", buffering=0)
    stdin_open = True
    child_gone = False
    drain_deadline = None

    try:
        while True:
            if time.monotonic() > deadline:
                state["terminating"] = True
                if not ownership["reaped"]:
                    try:
                        os.kill(pid, 9)
                    except ProcessLookupError:
                        pass
                reap(block=True)
                # Reap recorded before the evidence marker; the watchdog's
                # 124 contract is not overwritten by a late TERM.
                transcript.write(b"\nPTY-CONTROLLER-WATCHDOG\n")
                return 124
            if child_gone and drain_deadline is not None:
                if time.monotonic() > drain_deadline:
                    status = ownership["status"]
                    if status is None:
                        # Defensive: ownership cleared without a recorded
                        # status can only mean an external reap; report it.
                        transcript.write(
                            b"\nPTY-CONTROLLER-EXIT status=unknown\n"
                        )
                        return 1
                    transcript.write(
                        f"\nPTY-CONTROLLER-EXIT status={status} signals={signals}\n".encode()
                    )
                    if status == 0:
                        return 0
                    # Propagate the child's own outcome — never a false 0.
                    # (Watchdog 124 and TERM 143 are controller-owned
                    # contracts, recorded by their own markers.)
                    return status
            readable = []
            if stdin_open:
                readable.append(stdin_fd)
            if not child_gone:
                # Stop polling a closed master: after EOF/EIO there is no
                # further output to drain.
                readable.append(master)
            readable, _, _ = select.select(readable, [], [], 0.1)
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
                        # macOS raises EIO once the slave side is closed.
                        output = b""
                    if output == b"":
                        child_gone = True
                        if drain_deadline is None:
                            drain_deadline = time.monotonic() + 0.5
                    else:
                        transcript.write(output)
            wait_result = reap(block=False)
            if wait_result is not None:
                # Reaped now (or ownership already cleared): the child is
                # terminal; start the one finite drain window.
                child_gone = True
                if drain_deadline is None:
                    drain_deadline = time.monotonic() + 0.5
    finally:
        # Best-effort owned-child cleanup on any exceptional exit path;
        # never signals a child that any successful wait already reaped.
        if not ownership["reaped"]:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
        else:
            note_reaped_cleanup_skipped()
        reap(block=True)
        transcript.close()
        try:
            os.close(master)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())