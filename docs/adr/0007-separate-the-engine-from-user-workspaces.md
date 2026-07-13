# Separate the engine from user Workspaces

The open-source Agent Profile Kit repository owns only the CLI, schemas, Installer, Adapters, documentation, and minimal non-personal fixtures, while each user owns one canonical Workspace at `~/.agents/agent-profile-kit/workspace/`. The Workspace may be a Git repository independently of the tool; keeping product code, private content, Workspace versioning, backups, and disposable Host output separate avoids requiring users to fork and edit the tool repository.

ADR-0010 supersedes this decision's original placement of generated output under a sibling `installations/` directory. Project-bound output now lives in exclusively owned paths inside bound projects, with machine-local ownership records under application state.
