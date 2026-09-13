"""Inject TERM at the kernel-reap boundary without signalling any real PID."""
import os
import pty
import runpy
import select
import signal
import sys
from unittest.mock import patch

controller, transcript = sys.argv[1:]
main = runpy.run_path(controller)["main"]
kernel_reaped = False
attempts = []


def waitpid(pid, flags):
    global kernel_reaped
    if kernel_reaped:
        raise ChildProcessError()
    kernel_reaped = True
    # The kernel has reaped, but the caller has not received its result yet.
    handler = signal.getsignal(signal.SIGTERM)
    handler(signal.SIGTERM, None)
    handler(signal.SIGTERM, None)
    return pid, 0


def kill(pid, signum):
    attempts.append((pid, signum, kernel_reaped))


with (
    patch.object(pty, "fork", return_value=(123456, 99)),
    patch.object(select, "select", return_value=([], [], [])),
    patch.object(os, "waitpid", side_effect=waitpid),
    patch.object(os, "kill", side_effect=kill),
    patch.object(os, "close"),
    patch.object(sys, "argv", [controller, transcript, "80", "10", "unused"]),
):
    try:
        outcome = main()
    except SystemExit as error:
        outcome = error.code

assert attempts == [], f"signalled after kernel reap: {attempts}"
assert kernel_reaped
assert outcome == 143, f"TERM outcome lost: {outcome}"
