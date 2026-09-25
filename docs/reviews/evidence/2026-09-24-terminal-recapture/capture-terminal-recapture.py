#!/usr/bin/env python3
"""Terminal evidence capture for #680 / TEST-005 (method of the 2026-09-23 capture).

Drives the packed release candidate through real PTYs at 100x24 and 60x24,
interprets bytes with pyte, and writes raw provenance beside a dual-palette
HTML gallery. Adapted from the committed 2026-09-23 driver: `--agent` and
`apkit list agents` (D1), the rewritten install prompts (spec #677), the
guided Profile-creation screens P1-P5 plus cancellation and `new context`
(P6, spec #675), and full per-frame labels so those screens keep the
re-review's P-numbers.

Rerun (uv; do not pip-install into a global environment):

  bun run docs/reviews/evidence/2026-09-24-terminal-recapture/prepare-candidate.ts /private/tmp/apkit-706-candidate

  uv run --with pexpect --with pyte --with pillow python \
    docs/reviews/evidence/2026-09-24-terminal-recapture/capture-terminal-recapture.py
"""

from __future__ import annotations

import html
import json
import os
import pathlib
import re
import shutil
import time

import pexpect
import pyte

ROOT = pathlib.Path("/private/tmp/apkit-680-session")
CANDIDATE = pathlib.Path("/private/tmp/apkit-706-candidate")
OUT = pathlib.Path(__file__).resolve().parent
NODE = "/opt/homebrew/opt/node@22/bin/node"
CLI = CANDIDATE / "package" / "package" / "dist" / "cli.js"
IDENTITY = CANDIDATE / "candidate-identity.json"

COLORS = {
    "default": "#e5e5e5",
    "black": "#000000",
    "red": "#cd3131",
    "green": "#0dbc79",
    "brown": "#e5e510",
    "blue": "#2472c8",
    "magenta": "#bc3fbc",
    "cyan": "#11a8cd",
    "white": "#e5e5e5",
    "brightblack": "#666666",
    "brightred": "#f14c4c",
    "brightgreen": "#23d18b",
    "brightbrown": "#f5f543",
    "brightblue": "#3b8eea",
    "brightmagenta": "#d670d6",
    "brightcyan": "#29b8db",
    "brightwhite": "#ffffff",
}

PALETTES = {
    "dark": {
        "page": "#252525",
        "text": "#eeeeee",
        "link": "#8bd5ff",
        "frame_bg": "#141414",
        "frame_fg": "#e5e5e5",
        "border": "#555555",
        "default_fg": "#e5e5e5",
    },
    "light": {
        "page": "#f4f4f4",
        "text": "#1a1a1a",
        "link": "#0b57d0",
        "frame_bg": "#ffffff",
        "frame_fg": "#1a1a1a",
        "border": "#b0b0b0",
        "default_fg": "#1a1a1a",
    },
}

# Representative frames rendered to PNG in both palettes for readability review.
IMAGE_FRAME_LABELS = (
    "01-first-use",
    "02-setup",
    "05-first-install",
    "07-status",
    "11-selection-agent-picker",
    "11-selection-filtered-agent",
    "15-details-list",
    "17-agent-missing-warning",
    "20-narrow-wrap-command",
    "21-details-partial",
    "P1-new-profile-empty",
    "P3-new-profile-context",
    "P4-new-profile-skills",
    "P5-new-profile-created",
    "P6-new-context",
)

frames: list[dict] = []
runs: list[dict] = []
raw_streams: dict[str, str] = {}


class Sink:
    def __init__(self, screen, stream_id: str):
        self.stream = pyte.Stream(screen)
        self.stream_id = stream_id
        self.path = OUT / f"{stream_id}.ansi"
        raw_streams[stream_id] = ""
        self.file = self.path.open("w", encoding="utf-8", newline="")

    def write(self, s: str) -> int:
        raw_streams[self.stream_id] += s
        self.file.write(s)
        self.file.flush()
        self.stream.feed(s)
        return len(s)

    def flush(self) -> None:
        self.file.flush()

    def close(self) -> None:
        self.file.close()


def palette_color(name: str, palette: str) -> str:
    key = "default_fg" if name == "default" else name
    if palette == "dark":
        return COLORS.get(name, "#" + name if not name.startswith("#") else name)
    # Light palette remaps the same semantic ANSI names to readable inks.
    light_map = {
        "default": "#1a1a1a",
        "black": "#000000",
        "red": "#b3261e",
        "green": "#0f6b3a",
        "brown": "#7a5c00",
        "blue": "#0b57d0",
        "magenta": "#86208a",
        "cyan": "#006b6b",
        "white": "#1a1a1a",
        "brightblack": "#5f6368",
        "brightred": "#c5221f",
        "brightgreen": "#137333",
        "brightbrown": "#8a6d00",
        "brightblue": "#1a73e8",
        "brightmagenta": "#a11a9c",
        "brightcyan": "#007b83",
        "brightwhite": "#000000",
    }
    return light_map.get(name, "#1a1a1a")


def cell_spans(line, width: int, palette: str) -> str:
    spans: list[str] = []
    for x in range(width):
        c = line[x]
        fg = palette_color(c.fg, palette)
        bg = PALETTES[palette]["frame_bg"] if c.bg == "default" else palette_color(c.bg, palette)
        if c.reverse:
            fg, bg = bg, fg
        style = f"color:{fg};background:{bg};"
        if c.bold:
            style += "font-weight:bold;"
        if c.underscore:
            style += "text-decoration:underline;"
        spans.append('<span style="' + style + '">' + html.escape(c.data) + "</span>")
    linehtml = "".join(spans)
    while True:
        compact = re.sub(
            r'<span style="([^"]*)">([^<]*)</span><span style="\1">([^<]*)</span>',
            r'<span style="\1">\2\3</span>',
            linehtml,
        )
        if compact == linehtml:
            break
        linehtml = compact
    return linehtml


def snapshot(screen, label: str, width: int, command: str) -> None:
    lines = list(screen.history.top) + [screen.buffer[y] for y in range(screen.lines)]
    while lines and not "".join(c.data for c in lines[-1].values()).strip():
        lines.pop()
    rendered = {"dark": [], "light": []}
    plain: list[str] = []
    cell_rows: list[list[dict]] = []
    for line in lines:
        txt = ""
        row = []
        for x in range(width):
            c = line[x]
            txt += c.data
            row.append(
                {
                    "data": c.data,
                    "fg": c.fg,
                    "bg": c.bg,
                    "bold": c.bold,
                    "underscore": c.underscore,
                    "reverse": c.reverse,
                }
            )
        for palette in ("dark", "light"):
            rendered[palette].append(cell_spans(line, width, palette))
        plain.append(txt.rstrip())
        cell_rows.append(row)
    index = len(frames) + 1
    ident = f"{index:02d}-{width}-{label}"
    (OUT / f"{ident}.txt").write_text("\n".join(plain) + "\n")
    frames.append(
        {
            "id": ident,
            "label": label,
            "width": width,
            "command": command,
            "html": rendered,
            "cells": cell_rows,
            "plain": plain,
        }
    )
    print("FRAME", ident, flush=True)


def render_frame_png(frame: dict, palette: str, path: pathlib.Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    cell_w, cell_h = 8, 16
    rows = frame["cells"]
    width = frame["width"]
    height = max(1, len(rows))
    image = Image.new("RGB", (width * cell_w, height * cell_h), PALETTES[palette]["frame_bg"])
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 12)
    except OSError:
        font = ImageFont.load_default()
    for y, row in enumerate(rows):
        x = 0
        while x < width:
            cell = row[x]
            run = cell["data"]
            style = (cell["fg"], cell["bg"], cell["bold"], cell["underscore"], cell["reverse"])
            x2 = x + 1
            while x2 < width:
                nxt = row[x2]
                nxt_style = (nxt["fg"], nxt["bg"], nxt["bold"], nxt["underscore"], nxt["reverse"])
                if nxt_style != style:
                    break
                run += nxt["data"]
                x2 += 1
            fg = palette_color(cell["fg"], palette)
            bg = PALETTES[palette]["frame_bg"] if cell["bg"] == "default" else palette_color(cell["bg"], palette)
            if cell["reverse"]:
                fg, bg = bg, fg
            px, py = x * cell_w, y * cell_h
            draw.rectangle([px, py, x2 * cell_w - 1, py + cell_h - 1], fill=bg)
            draw.text((px, py), run, fill=fg, font=font)
            x = x2
    image.save(path)


def run(width: int, label: str, args: list[str], steps=(), capture: bool = True, expected: int = 0, cwd=None, home_override=None):
    base = ROOT / str(width)
    home = pathlib.Path(home_override) if home_override else base / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ["NO_COLOR", "CI", "NODE_OPTIONS", "FORCE_COLOR"]
    }
    env.update(
        HOME=str(home),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_CACHE_HOME=str(home / ".cache"),
        XDG_DATA_HOME=str(home / ".local/share"),
        XDG_STATE_HOME=str(home / ".local/state"),
        TERM="xterm-256color",
        COLUMNS=str(width),
        LINES="24",
        # Full scrollback frames: long `details` output would otherwise sit in
        # `less` on a PTY. `PAGER=cat` keeps the same CLI bytes and styling
        # while letting the whole document land in the captured history.
        PAGER="cat",
        # Controlled Host stubs plus system tools only. Node is spawned as an
        # absolute path (DEC-13); node@22 is never exported onto PATH.
        PATH=str(base / "bin") + ":/usr/bin:/bin",
    )
    assert env["HOME"] == str(home)
    screen = pyte.HistoryScreen(width, 24, history=1000)
    stream_id = f"{width}-{label}"
    sink = Sink(screen, stream_id)
    p = pexpect.spawn(NODE, [str(CLI)] + args, env=env, cwd=str(cwd or base), dimensions=(24, width), encoding="utf-8", timeout=12)
    p.logfile_read = sink
    command = "apkit " + " ".join(args)
    try:
        for pattern, answer, frame in steps:
            p.expect(pattern)
            time.sleep(0.2)
            try:
                while True:
                    p.read_nonblocking(65536, timeout=0.1)
            except (pexpect.TIMEOUT, pexpect.EOF):
                pass
            # `frame` is the snapshot's full label (the 2026-09-23 driver
            # derived `f"{label}-{frame}"`; full labels keep the P1-P6
            # re-review numbers on the guided Profile screens).
            if frame:
                snapshot(screen, frame, width, command)
            p.send(answer)
        p.expect(pexpect.EOF)
        p.close()
        if capture:
            snapshot(screen, label, width, command)
        runs.append(
            {
                "width": width,
                "label": label,
                "args": args,
                "exit": p.exitstatus,
                "home": str(home),
            }
        )
        assert p.exitstatus == expected, (label, p.exitstatus, expected, screen.display)
    finally:
        if p.isalive():
            p.terminate(force=True)
        sink.close()


def write_host_stubs(base: pathlib.Path) -> None:
    hostbin = base / "bin"
    hostbin.mkdir(parents=True, exist_ok=True)
    for host, version in (
        ("codex", "codex-cli 0.145.0"),
        ("claude", "2.1.0 (Claude Code)"),
    ):
        stub = hostbin / host
        stub.write_text("#!/bin/sh\nprintf '%s\\n' '" + version + "'\n")
        stub.chmod(0o755)


def clear_host_stubs(base: pathlib.Path) -> None:
    hostbin = base / "bin"
    if hostbin.exists():
        for stub in hostbin.iterdir():
            stub.unlink()


def inspect_picker_redraw() -> dict:
    """Inspect raw selection streams for redraw hygiene (TEST-006 extra)."""
    findings = []
    for stream_id, raw in raw_streams.items():
        # Selection streams: the interactive install plus the guided Profile
        # pickers, whose raw stream is the P5 run's (`P3`/`P4` are its frames).
        if (
            "selection" not in stream_id
            and "11-" not in stream_id
            and "P5-new-profile-created" not in stream_id
        ):
            continue
        has_settled_filter = bool(re.search(r"\x1b\[0m cod", raw))
        has_old_filter_label = "Filtered results for:" in raw
        has_instructions_block = "Instructions" in raw
        has_focus_glyph = "❯" in raw
        has_checkbox = "◻" in raw or "◼" in raw
        hide_cursor = "\x1b[?25l" in raw
        show_cursor = "\x1b[?25h" in raw
        # A leftover line would be a full-width printable row that survives a
        # clear-to-end-of-screen without being rewritten; approximate by
        # counting ED/EL use around filter updates. The optional 0–2 parameter
        # covers the bare, [0…, [1… and [2… forms of both escapes.
        erase_ops = len(re.findall(r"\x1b\[[0-2]?[JK]", raw))
        findings.append(
            {
                "stream": stream_id,
                "settledFilterLine": has_settled_filter,
                "oldFilteredResultsLabel": has_old_filter_label,
                "instructionsBlock": has_instructions_block,
                "focusGlyph": has_focus_glyph,
                "checkboxGlyph": has_checkbox,
                "hidesCursorDuringRedraw": hide_cursor,
                "restoresCursor": show_cursor,
                "eraseOperationCount": erase_ops,
                "rawBytes": len(raw),
            }
        )
    return {
        "findings": findings,
        "summary": {
            "settledFilterObserved": any(f["settledFilterLine"] for f in findings),
            "noOldFilteredResultsLabel": all(not f["oldFilteredResultsLabel"] for f in findings),
            "noInstructionsBlock": all(not f["instructionsBlock"] for f in findings),
            "cursorRestoredWhereHidden": all(
                (not f["hidesCursorDuringRedraw"]) or f["restoresCursor"] for f in findings
            ),
        },
    }


def check_identity(identity: dict) -> None:
    """Fail fast when the evidence directory's committed identity record does
    not match the candidate driving this capture (INT-1): the published
    identity and the frames must come from the same archive."""
    recorded_path = OUT / "candidate-identity.json"
    if not recorded_path.exists():
        return
    recorded = json.loads(recorded_path.read_text())
    for key in ("version", "repositoryHead", "archiveDigest"):
        if recorded.get(key) != identity.get(key):
            raise SystemExit(
                f"{recorded_path} records {key}={recorded.get(key)!r} but the capture "
                f"candidate ({IDENTITY}) has {identity.get(key)!r}; regenerate the "
                "candidate with prepare-candidate.ts and recapture so the committed "
                "identity and the frames come from the same archive"
            )


def main() -> None:
    if ROOT.exists():
        shutil.rmtree(ROOT)
    ROOT.mkdir()
    for stale in OUT.glob("*.ansi"):
        stale.unlink()
    for stale in OUT.glob("*.txt"):
        stale.unlink()
    images_dir = OUT / "images"
    if images_dir.exists():
        shutil.rmtree(images_dir)
    images_dir.mkdir()

    identity = json.loads(IDENTITY.read_text())
    check_identity(identity)
    print("CANDIDATE", identity["version"], identity["repositoryHead"], identity["archiveDigest"], flush=True)

    for width in (100, 60):
        base = ROOT / str(width)
        base.mkdir(exist_ok=True)
        write_host_stubs(base)
        home = base / "home"
        workspace = base / "workspace"

        run(width, "01-first-use", [])
        run(
            width,
            "02-setup",
            ["init", "./workspace"],
            [(r"\?[^\r\n]*\(y/N\)", "y\r", "02-setup-confirmation")],
        )

        # Guided Profile creation (US-004, D3). P1 runs on the fresh Workspace
        # with no Context or Skills; P6 creates the journey's `team` Context
        # Module and is the captured form of the old silent seed.
        run(width, "P1-new-profile-empty", ["new", "profile"])
        run(width, "P6-new-context", ["new", "context", "team"])
        # Uncaptured seeds, exactly P1's own guidance: more material so the
        # guided pickers have choices (the rereview P3/P4 mockups show two).
        run(width, "seed-context-style", ["new", "context", "style"], capture=False)
        run(width, "seed-skill-review-pr", ["new", "skill", "review-pr"], capture=False)
        run(width, "seed-skill-write-tests", ["new", "skill", "write-tests"], capture=False)
        # P2-P5: name, Context picker (toggled, as in the P3 mockup), Skills
        # picker (open state, as in the P4 mockup), receipt with both members.
        # Context options sort alphabetically (`style`, `team`), so the toggle
        # moves down one row first to select `team` — the journey's Context.
        run(
            width,
            "P5-new-profile-created",
            ["new", "profile"],
            [
                (r"Name your Profile", "engineering", None),
                (r"engineering", "\r", "P2-new-profile-name"),
                (r"Which Context?", "\x1b[B ", None),
                (r"1 selected", "\r", "P3-new-profile-context"),
                (r"Which Skills?", " ", "P4-new-profile-skills"),
                (r"1 selected", "\r", None),
            ],
        )
        # Keyboard cancellation (TEST-002): Ctrl-C at the name prompt, the
        # shared cancelled statement, nothing written, exit 1.
        run(
            width,
            "P5b-new-profile-cancel",
            ["new", "profile"],
            [(r"Name your Profile", "\x03", None)],
            expected=1,
        )
        run(width, "04-create-second-profile", ["new", "profile", "writing", "--context", "team"], capture=False)

        hello = base / "projects" / "hello"
        hello.mkdir(parents=True, exist_ok=True)
        run(
            width,
            "05-first-install",
            ["install", "engineering", str(hello), "--agent", "codex", "--auto-confirm"],
        )
        run(width, "06-routine", ["update"])
        run(width, "07-status", ["status"], cwd=hello)
        run(width, "08-validate", ["validate"])
        run(
            width,
            "09-failure",
            ["install", "enginering", str(hello), "--agent", "codex", "--auto-confirm"],
            expected=1,
        )
        run(
            width,
            "10-invalid-target",
            ["install", "engineering", str(base / "missing"), "--agent", "codex", "--auto-confirm"],
            expected=1,
        )

        choice = base / "projects" / "selection"
        choice.mkdir(parents=True, exist_ok=True)
        # Interactive install: detected-agent preselection, filtered multi-select,
        # the two settled answers over the removed summary, then a plain decline
        # (neutral cancellation). The settled filter line is `›` + ANSI + ` cod…`;
        # match the raw bytes after the reset, not the plain `› cod` transcript
        # (DEC-12).
        run(
            width,
            "11-selection",
            ["install"],
            [
                (r"Which Profile", "\r", "11-selection-profile-picker"),
                (r"Which agents", "cod", "11-selection-agent-picker"),
                (r"\x1b\[0m cod", "\x1b[B\r", "11-selection-filtered-agent"),
                (r"Install now", "n\r", "11-selection-install-confirmation"),
            ],
            expected=1,
            cwd=choice,
        )

        for n in ("alpha/my-app", "beta/my-app", "acme-internal-analytics-pipeline-v2"):
            target = base / "projects" / n
            target.mkdir(parents=True, exist_ok=True)
            run(
                width,
                "seed-" + n.replace("/", "-"),
                ["install", "engineering", str(target), "--agent", "codex", "--agent", "claude", "--auto-confirm"],
                capture=False,
            )
        run(width, "12-fleet-inventory", ["list", "projects"])
        run(width, "13-fleet-status", ["status", "--all"])
        # Edit the `team` Context Module body (id comes from the file name, so
        # the scaffold's shape is preserved) to give `update` a real change.
        context = workspace / "context" / "team.md"
        context.write_text("\n# team\n\nUse clear, concise language. Explain each result briefly.\n")
        run(width, "14-fleet-update", ["update"])
        run(width, "15-details-list", ["details", "--list"])
        run(width, "16-details", ["details"])

        # Setup routing when Profiles already exist (US-002 / DEC-005).
        side_home = base / "home-connect"
        run(
            width,
            "18-setup-routing-with-profiles",
            ["init", str(workspace)],
            [(r"\?[^\r\n]*\(y/N\)", "y\r", "18-setup-routing-with-profiles-confirmation")],
            home_override=side_home,
        )

        # Agent inventory wording check (picker and `list agents` must both
        # say 'detected' / 'not found' — #669; label renamed for D1).
        run(width, "19-list-agents", ["list", "agents"])

        # Narrow-wrap command quoting: guided install of a Project under HOME
        # so the completed equivalent command carries shellQuoteArg output
        # (~/'proj/alpha') and must stay unbroken at 60 columns (US-009).
        home_proj = home / "proj" / "alpha"
        home_proj.mkdir(parents=True, exist_ok=True)
        run(
            width,
            "20-narrow-wrap-command",
            ["install"],
            [
                (r"Which Profile", "\r", "20-narrow-wrap-command-profile-picker"),
                (r"Which agents", "\r", "20-narrow-wrap-command-agent-picker"),
                (r"Install now", "y\r", "20-narrow-wrap-command-confirmation"),
            ],
            cwd=home_proj,
        )

        # Missing-agent warning naming Projects (US-011, D6): remove stubs
        # while the fleet is still installed (keeps label 17 for compare).
        clear_host_stubs(base)
        run(width, "17-agent-missing-warning", ["update"])

        # Partial outcome: one Project commits, one fails under a read-only
        # root, then details shows What went wrong / Changed / Not done (US-008).
        acme = base / "projects" / "acme-internal-analytics-pipeline-v2"
        os.chmod(acme, 0o500)
        try:
            run(width, "21-details-partial", ["uninstall", "--all", "--auto-confirm"], expected=1)
        finally:
            os.chmod(acme, 0o700)
        run(width, "21b-details-partial", ["details"])

    (OUT / "runs.json").write_text(json.dumps(runs, indent=2) + "\n")
    # Publish the identity record beside the frames so the committed
    # provenance always names the exact candidate the frames came from.
    (OUT / "candidate-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    (OUT / "frames.json").write_text(
        json.dumps(
            [{k: v for k, v in f.items() if k not in ("html", "cells", "plain")} for f in frames],
            indent=2,
        )
        + "\n"
    )

    # Representative stills in both palettes for light/dark readability review.
    image_manifest = []
    for frame in frames:
        if frame["label"] not in IMAGE_FRAME_LABELS and not frame["label"].startswith("21"):
            continue
        for palette in ("dark", "light"):
            name = f"{frame['id']}-{palette}.png"
            path = images_dir / name
            render_frame_png(frame, palette, path)
            image_manifest.append({"frame": frame["id"], "palette": palette, "path": f"images/{name}"})
    (OUT / "images.json").write_text(json.dumps(image_manifest, indent=2) + "\n")

    redraw = inspect_picker_redraw()
    (OUT / "picker-redraw-findings.json").write_text(json.dumps(redraw, indent=2) + "\n")

    write_gallery(identity)
    print("DONE", len(frames), "frames", flush=True)


def write_gallery(identity: dict) -> None:
    version = identity["version"]
    parts: list[str] = []
    parts.append(
        "<!doctype html><meta charset=\"utf-8\">"
        f"<title>apkit {html.escape(version)} — terminal recapture</title>"
        "<style>"
        ":root, [data-palette='dark']{"
        "--page:#252525;--text:#eeeeee;--link:#8bd5ff;--frame-bg:#141414;--frame-fg:#e5e5e5;--border:#555555;"
        "}"
        "[data-palette='light']{"
        "--page:#f4f4f4;--text:#1a1a1a;--link:#0b57d0;--frame-bg:#ffffff;--frame-fg:#1a1a1a;--border:#b0b0b0;"
        "}"
        "body{background:var(--page);color:var(--text);font:16px system-ui;margin:32px}"
        "a{color:var(--link)}"
        "section{margin:40px 0}"
        "pre{font:14px/20px Menlo,monospace;background:var(--frame-bg);color:var(--frame-fg);"
        "padding:20px;width:max-content;border:1px solid var(--border);white-space:pre}"
        "nav a{margin-right:12px}"
        "h2{font-size:20px}"
        "code{font:14px Menlo,monospace}"
        ".toolbar{margin:0 0 24px}"
        "button{font:14px system-ui;padding:6px 12px;margin-right:8px}"
        ":root:not([data-palette='light']) pre.light,[data-palette='light'] pre.dark{display:none}"
        "</style>"
        "<div class='toolbar'>"
        "<button type='button' onclick=\"document.documentElement.dataset.palette='dark'\">Dark</button>"
        "<button type='button' onclick=\"document.documentElement.dataset.palette='light'\">Light</button>"
        "</div>"
    )
    parts.append(f"<h1>apkit {html.escape(version)} — terminal recapture</h1>")
    parts.append(
        "<p>Real PTY output, terminal-emulated with ANSI colors and cursor redraws. "
        "100 and 60 columns, 24-row viewport with scrollback. "
        "Dark and light palettes. Principal acceptance stays on #519.</p>"
        f"<p>Revision <code>{html.escape(str(identity.get('repositoryHead')))}</code> · "
        f"Archive SHA-256 <code>{html.escape(identity.get('archiveDigest', ''))}</code></p>"
    )
    parts.append("<nav>")
    for f in frames:
        parts.append(f"<a href='#{f['id']}'>{f['id']}</a> ")
    parts.append("</nav>")
    for f in frames:
        parts.append(f"<section id='{f['id']}'><h2>{f['id']}</h2>")
        parts.append(f"<p><code>{html.escape(f['command'])}</code></p>")
        # Each palette's rows carry inline colors, so the toggle swaps whole frames.
        for palette in ("dark", "light"):
            parts.append(f"<pre class='{palette}'>{chr(10).join(f['html'][palette])}</pre>")
        parts.append("</section>")
    (OUT / "index.html").write_text("".join(parts))

    # Static both-palette files so each palette is available without scripting.
    for palette in ("dark", "light"):
        static = []
        static.append(
            "<!doctype html><meta charset=\"utf-8\">"
            f"<title>apkit {html.escape(version)} — terminal recapture ({palette})</title>"
            "<style>"
            f"body{{background:{PALETTES[palette]['page']};color:{PALETTES[palette]['text']};"
            "font:16px system-ui;margin:32px}"
            f"a{{color:{PALETTES[palette]['link']}}}"
            "section{margin:40px 0}"
            f"pre{{font:14px/20px Menlo,monospace;background:{PALETTES[palette]['frame_bg']};"
            f"color:{PALETTES[palette]['frame_fg']};padding:20px;width:max-content;"
            f"border:1px solid {PALETTES[palette]['border']};white-space:pre}}"
            "nav a{margin-right:12px}h2{font-size:20px}code{font:14px Menlo,monospace}"
            "</style>"
        )
        static.append(f"<h1>apkit {html.escape(version)} — terminal recapture ({palette})</h1>")
        static.append("<nav>")
        for f in frames:
            static.append(f"<a href='#{f['id']}'>{f['id']}</a> ")
        static.append("</nav>")
        for f in frames:
            static.append(f"<section id='{f['id']}'><h2>{f['id']}</h2>")
            static.append(f"<p><code>{html.escape(f['command'])}</code></p>")
            static.append(f"<pre>{chr(10).join(f['html'][palette])}</pre>")
            static.append("</section>")
        (OUT / f"index-{palette}.html").write_text("".join(static))


if __name__ == "__main__":
    main()
