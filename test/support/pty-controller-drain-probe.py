"""Make the child reap between two buffered PTY chunks deterministically."""
import os
import pty
import runpy
import select
import sys
import time
from unittest.mock import patch

controller, transcript = sys.argv[1:]
main = runpy.run_path(controller)["main"]
chunks = [b"first chunk\n", b"FINAL buffered chunk\n", b""]
clock = 0


def monotonic():
    global clock
    clock += 0.1
    return clock


def readable(fds, *_args):
    return ([99] if 99 in fds else [], [], [])


def read(_fd, _size):
    return chunks.pop(0)


with (
    patch.object(pty, "fork", return_value=(123456, 99)),
    patch.object(select, "select", side_effect=readable),
    patch.object(os, "waitpid", return_value=(123456, 0)),
    patch.object(os, "read", side_effect=read),
    patch.object(os, "kill") as kill,
    patch.object(os, "close"),
    patch.object(time, "monotonic", side_effect=monotonic),
    patch.object(sys, "argv", [controller, transcript, "80", "10", "unused"]),
):
    outcome = main()

assert outcome == 0, f"unexpected controller exit: {outcome}"
assert chunks == [], f"unread buffered output: {chunks}"
assert kill.call_count == 0, "cleanup signalled a reaped child"
