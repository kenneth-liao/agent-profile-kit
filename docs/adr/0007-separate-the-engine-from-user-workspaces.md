# Separate the engine from user Workspaces

The open-source Agent Profile Kit repository owns only the CLI, schemas, Installer, Adapters, documentation, and minimal non-personal fixtures, while each user owns one canonical Workspace at `~/.agents/agent-profile-kit/workspace/`. The Workspace may be a Git repository independently of the tool; generated output lives under the sibling `installations/` directory, keeping product upgrades, private content, Workspace versioning, backups, and disposable Host output independent instead of requiring users to fork and edit the tool repository.
