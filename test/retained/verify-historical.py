"""Validate retained neutral fixtures against already-built historical CLIs.

Usage: python3 test/retained/verify-historical.py <scratch-checkout-parent>
No Skill package script is executed by this helper. Only the specified
historical CLI bundles run, using Node in fresh homes.
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

retained = Path(__file__).resolve().parent
checkouts = Path(sys.argv[1]).resolve()
for version, fixture in [
    ("0.20.0", "compat-0.20.0/minimal"),
    ("0.20.0", "compat-0.20.0/partial"),
    ("0.95.0", "compat-0.95.0"),
]:
    with tempfile.TemporaryDirectory(prefix="apkit-historical-") as home:
        app = Path(home) / ".agents" / "agent-profile-kit"
        app.mkdir(parents=True)
        workspace = app / "workspace"
        shutil.copytree(retained / fixture, workspace)
        config = (
            "schema_version: 1\nbindings: []\n"
            if version == "0.20.0"
            else f"schema_version: 2\nworkspace: '{workspace.as_posix()}'\nbindings: []\n"
        )
        (app / "config.yaml").write_text(config)
        env = {**os.environ, "HOME": home, "USERPROFILE": home}
        # These old engines read their own Local Configuration, not today's.
        for name in ["APKIT_HOME", "AGENT_PROFILE_KIT_HOME"]:
            env.pop(name, None)
        result = subprocess.run(
            ["node", str(checkouts / version / "dist" / "cli.js"), "validate"],
            cwd=home, env=env, text=True, capture_output=True, timeout=30,
        )
        print(f"{version} {fixture}: exit {result.returncode}")
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        if result.returncode != 0:
            sys.exit(result.returncode)
