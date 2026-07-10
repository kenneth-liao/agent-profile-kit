# Isolate Host knowledge behind Adapters

Each supported Agent Host has one Adapter that owns its native paths, schemas, lifecycle mappings, generated bundles, launch arguments, feature detection, and compatibility behavior. A shared Installer resolves portable source and checks the Adapter's machine-readable Capability Contract, rejecting any installation whose required semantics cannot be preserved instead of spreading Host conditionals through canonical artifacts or silently weakening them.
