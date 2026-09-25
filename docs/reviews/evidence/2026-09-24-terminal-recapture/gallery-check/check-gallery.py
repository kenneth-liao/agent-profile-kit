#!/usr/bin/env python3
"""Browser check of the 2026-09-24 recapture gallery (#680 / TEST-005).

Opens the dual-palette gallery in headless Chromium and asserts, from real
layout, that every frame renders ONE terminal row per line (no wrapping, no
joined rows) and that the Dark/Light toolbar switches the frames. Screenshots
of both palettes are kept beside this script as evidence.

Rerun (uv; do not pip-install into a global environment):

  uv run --with playwright python \
    docs/reviews/evidence/2026-09-24-terminal-recapture/gallery-check/check-gallery.py
"""

from __future__ import annotations

import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
EVIDENCE = HERE.parent
INDEX = EVIDENCE / "index.html"
SHOTS = HERE

# Close-up frames kept as stills in both palettes (100-column IDs).
CLOSEUPS = (
    "01-100-01-first-use",
    "07-100-P3-new-profile-context",
    "09-100-P5-new-profile-created",
    "26-100-16-details",
    "69-60-20-narrow-wrap-command",
)


def main() -> int:
    frames = json.loads((EVIDENCE / "frames.json").read_text())
    # frames.json indexes ids only; each frame's terminal rows are its .txt cells.
    expected_rows = {
        f["id"]: len((EVIDENCE / f"{f['id']}.txt").read_text().splitlines())
        for f in frames
    }
    problems: list[str] = []
    checked = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 1000}, device_scale_factor=2)
        page.goto(INDEX.as_uri())
        page.wait_for_load_state("load")

        # One terminal row per line: each frame's dark <pre> carries one text
        # row per terminal row (joined rows would drop the newlines) and its
        # rendered height is exactly rows * line-height + padding + border —
        # a wrapped row would make the block taller.
        report = page.evaluate(
            """(expected) => {
                const out = [];
                for (const section of document.querySelectorAll("section")) {
                    const pre = section.querySelector("pre.dark");
                    const id = section.id;
                    const rows = expected[id];
                    const textRows = pre.textContent.split("\\n").length;
                    const style = getComputedStyle(pre);
                    const lineHeight = parseFloat(style.lineHeight);
                    const frame = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
                        + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
                    const height = pre.getBoundingClientRect().height;
                    out.push({
                        id, rows, textRows, lineHeight,
                        whiteSpace: style.whiteSpace,
                        height, expectedHeight: rows * lineHeight + frame,
                        visualLines: (height - frame) / lineHeight,
                    });
                }
                return out;
            }""",
            expected_rows,
        )
        for row in report:
            checked += 1
            if row["whiteSpace"] != "pre":
                problems.append(f"{row['id']}: white-space is {row['whiteSpace']!r}, not 'pre'")
            if row["textRows"] != row["rows"]:
                problems.append(f"{row['id']}: {row['textRows']} text rows for {row['rows']} terminal rows")
            if abs(row["visualLines"] - row["rows"]) > 0.01:
                problems.append(f"{row['id']}: {row['visualLines']} visual lines for {row['rows']} terminal rows")
            if abs(row["height"] - row["expectedHeight"]) > 1:
                problems.append(
                    f"{row['id']}: rendered height {row['height']} != rows*line+frame {row['expectedHeight']}"
                )

        def palette_state() -> dict:
            return page.evaluate(
                """() => {
                    const first = document.querySelector("section pre.dark");
                    const light = document.querySelector("section pre.light");
                    return {
                        palette: document.documentElement.dataset.palette ?? null,
                        bodyBackground: getComputedStyle(document.body).backgroundColor,
                        darkDisplay: getComputedStyle(first).display,
                        lightDisplay: getComputedStyle(light).display,
                    };
                }"""
            )

        # Default (no button pressed yet) renders the dark frames.
        state = palette_state()
        if state["palette"] is not None or state["darkDisplay"] == "none" or state["lightDisplay"] != "none":
            problems.append(f"default palette state wrong: {state}")

        # Toggle-proof stills: the toolbar plus the first frame in each palette
        # (the close-ups below carry the readable per-frame evidence).
        page.screenshot(path=str(SHOTS / "gallery-dark-toggle.png"), clip={"x": 0, "y": 0, "width": 1200, "height": 900})
        for frame_id in CLOSEUPS:
            locator = page.locator(f"section[id='{frame_id}'] pre.dark")
            if locator.count() == 1:
                locator.screenshot(path=str(SHOTS / f"closeup-{frame_id}-dark.png"))

        page.click("button:text-is('Light')")
        page.wait_for_timeout(100)
        state = palette_state()
        if state["palette"] != "light":
            problems.append(f"Light toggle left palette={state['palette']!r}")
        if state["bodyBackground"] != "rgb(244, 244, 244)":
            problems.append(f"Light toggle body background {state['bodyBackground']} != rgb(244, 244, 244)")
        if state["darkDisplay"] != "none" or state["lightDisplay"] == "none":
            problems.append(f"Light toggle frames not switched: {state}")
        page.screenshot(path=str(SHOTS / "gallery-light-toggle.png"), clip={"x": 0, "y": 0, "width": 1200, "height": 900})
        for frame_id in CLOSEUPS:
            locator = page.locator(f"section[id='{frame_id}'] pre.light")
            if locator.count() == 1:
                locator.screenshot(path=str(SHOTS / f"closeup-{frame_id}-light.png"))

        page.click("button:text-is('Dark')")
        page.wait_for_timeout(100)
        state = palette_state()
        if state["palette"] != "dark":
            problems.append(f"Dark toggle left palette={state['palette']!r}")
        if state["bodyBackground"] != "rgb(37, 37, 37)":
            problems.append(f"Dark toggle body background {state['bodyBackground']} != rgb(37, 37, 37)")
        if state["darkDisplay"] == "none" or state["lightDisplay"] != "none":
            problems.append(f"Dark toggle frames not switched: {state}")

        browser.close()

    summary = {
        "gallery": str(INDEX.relative_to(EVIDENCE)),
        "framesChecked": checked,
        "rowsChecked": sum(expected_rows.values()),
        "closeups": list(CLOSEUPS),
        "problems": problems,
        "passed": not problems,
    }
    (HERE / "gallery-check.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
