#!/bin/sh
# Produce the 0.204.0 compatibility fixtures for issue #596 (TEST-010).
# Usage: produce.sh <packed-cli-from-0.204.0> <fixture-output-dir>
# The binary must report 0.204.0 (commit 531f12f — the commit carrying
# version 0.204.0; no release tag exists), so the reproduction path is
# self-enforcing.
set -eu
APKIT="$1"; OUT="$2"
reported="$($APKIT --version)"
if [ "$reported" != "0.204.0" ]; then
  echo "produce.sh expects the 0.204.0 packed CLI; the given binary reports '$reported'" >&2
  exit 1
fi
stage="$(mktemp -d /tmp/apk-compat-0204.XXXXXX)"
stage="$(cd "$stage" && pwd -P)"
home="$stage/home"; project="$stage/project"
mkdir -p "$home/bin" "$project"
printf '#!/bin/sh\necho "codex-cli 0.145.0"\n' > "$home/bin/codex"
chmod +x "$home/bin/codex"
run() { HOME="$home" PATH="$home/bin:$PATH" "$APKIT" "$@"; }

run init
w="$home/.agents/agent-profile-kit/workspace"
mkdir -p "$w/context" "$w/skills/base-skill" "$w/skills/review-pr" "$w/profiles"
printf -- '---\nid: extra-rules\n---\nExtra rules body.\n' > "$w/context/extra-rules.md"
printf -- '---\nid: team-rules\ndependencies:\n  - type: context\n    id: extra-rules\n---\nTeam rules body.\n' > "$w/context/team-rules.md"
printf -- '---\nname: base-skill\ndescription: Shared base Skill.\n---\n\n# Base\n' > "$w/skills/base-skill/SKILL.md"
printf -- '---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n' > "$w/skills/review-pr/SKILL.md"
printf -- 'dependencies:\n  - type: skill\n    id: base-skill\n' > "$w/skills/review-pr/agent-profile-kit.yaml"
printf -- 'id: coding\ncontext: [team-rules]\nskills: [review-pr]\n' > "$w/profiles/coding.yaml"

run install coding "$project" --host codex --auto-confirm
run update

# Copy the resulting trees into the fixture layout.
mkdir -p "$OUT/home/.agents/agent-profile-kit"
cp -R "$w" "$OUT/workspace-source"
cp "$home/.agents/agent-profile-kit/config.yaml" "$OUT/home/.agents/agent-profile-kit/config.yaml"
cp -R "$home/.agents/agent-profile-kit/state" "$OUT/home/.agents/agent-profile-kit/state"
cp -R "$project" "$OUT/project"
# Replace the production-stage absolute prefix with a mechanical placeholder;
# the fixture loader substitutes the consuming test home for it at copy time.
perl -pi -e "s{\Q$stage/home\E}{__FIXTURE_HOME__}g; s{\Q$stage/project\E}{__FIXTURE_PROJECT__}g" \
  "$OUT/home/.agents/agent-profile-kit/config.yaml" \
  "$OUT/home/.agents/agent-profile-kit/state/manifest.json"
echo "fixture written to $OUT (stage path was $stage)"
