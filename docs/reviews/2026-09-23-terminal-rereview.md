# Principal re-review — 2026-09-23 terminal recapture

- **Reviewed:** the 0.229.2 recapture at `e241646`
  ([gallery](evidence/2026-09-23-terminal-recapture/index.html),
  [capture report](2026-09-23-terminal-recapture.md)), under #519.
- **Verdict:** acceptance stays open. The #640 corrections landed, but the
  screens are still dense and formal, use the internal word "Host", and give a
  new user no guidance for creating a first Profile.

The principal's notes come first, unedited. The proposal after them applies
those notes to every captured screen (the 60-column frames use the same text,
wrapped). The proposed screens express intent; the corrective spec owns the
requirements.

## Principal notes

```text
In general, the spacing doesn't feel great. I think it might be more readable with deliberate spacing, being concise, and a more relaxed design rather than walls of text? I think the language can also be more casual, friendlier, and simpler. I think using the name "Host" might also be confusing because this is an agent-0profile-kit specific term that is not normally used. I think for customer facing we should just use "agent".

I also didn't see screens for actually creating a profile. I think that's important since a new user will likely have skill files and context files that they can easily drop into the new workspace, but the Profile concept will be completely new to them. And they'll need guidance on how to actually create one.

Here are some notes:


01-100-01-first-use

make more concise to:

⚠ Agent Profile Kit is not set up on this machine.

Your Workspace folder holds your Context, Skills, and Profiles. You only need one workspace for all of your Projects.

Start by naming the folder that will hold the Workspace. The second command uses the current folder instead.

Next:
- apkit init <path>
- apkit init .

Run apkit --help for the full command list.


02-100-02-setup-confirmation

Context, Skills, and Profiles will be stored in and loaded from                                           
  /private/tmp/apkit-653-session/100/workspace.                                                     

The folder does not exist yet; setup will create it and add:
- workspace.yaml
- context/
- skills/
- profiles/
-                                      
❯ Set up this folder as your Workspace? (y/N)


03-100-02-setup

Context, Skills, and Profiles will be stored in and loaded from                                           
  /private/tmp/apkit-653-session/100/workspace.                                                     

The folder does not exist yet; setup will create it and add:
- workspace.yaml
- context/
- skills/
- profiles/
-                                      
❯ Set up this folder as your Workspace? › yes                                                       

✔ Created and registered the Workspace at                       
  /private/tmp/apkit-653-session/100/workspace                                                      

# Note that I deleted the settings config line here because if they don't really need to ever go into that file, then I think we can just omit and probably have those details int he docs or something. I think everything involving the settings in that config file can be done through the CLI anyway right? Or the agent can do it for htem. But like reconfiguring a workspace can be done through the CLI so I don't think they'd ever need to manually edit that config file. Let me know if I'm wrong.

Profiles group Context and Skills for a specific kind of work, and they're reusable across projects. 

Skills are the skills you're used to and follow the open standard [link]. You can simply drop your skills into the workspace/skills/ folder to use them with a profile.

Context is just markdown files that you create in workspace/context/. Context files added to a profile are always-loaded in every agent session.

Detected Agents: claude, codex                                                                 
                                                                                                    
Next:                                                                                               
- apkit new context <context>                                                                       
- apkit new profile <name> --context <context>               


04-100-05-first-install

✔ Installed for /private/tmp/apkit-653-session/100/projects/hello                                   
  Profile: engineering                                                                              
  Agents: codex                                                                                      

Note: Context is autoloaded by agents using agent-native settings and hooks. If prompted, approve hooks trust project files for Profiles to load properly.

Optional check: start a new Codex session in /private/tmp/apkit-653-session/100/projects/hello and ask what Profile material is loaded.                                                              
                                                                                                    
Next: apkit status (see installed profiles and projects)
Details: apkit details ## Does this really need to be here? What can they get from the details? And will it be overwhelming for the average new user? If it's important, we should add a short note like I added to the previous line to say what they can do with it.
```

## Proposed screens

### Rules drawn from the notes

1. **Space out the groups.** A blank line separates each part: headline, what
   happened, what you need to know, what to do next. No wall of text.
2. **Short, casual, plain words.** One idea per sentence. "Everything is up to
   date", not "All Projects were already current".
3. **"agent", not "Host", in anything a user reads.** Commands and flags follow
   (`--agent`, `apkit list agents`). The word Host stays inside the code and
   docs for contributors (see decision D1).
4. **Lists as bullets.** Anything with more than two parts is a list.
5. **Hide what the user never needs to touch.** No settings-file path, no
   "Workspace contract", no "bound project root", no "Primary Cause".
6. **Each next step says what it does**, in a short note in brackets:
   `apkit status (see installed Profiles and Projects)`.
7. **`Details: apkit details` only when something went wrong** (a failure, a
   warning, or a partial run). A normal success does not show it (D4).
8. **Show a status next to its item on the same line** (`claude  detected`),
   not on a line of its own.

Kept as they are: the words Workspace, Profile, Context, Skills, and Project;
full Project paths in install screens (#647); state symbols and the accent
colour (#641); one footer per screen (#642).

---

### First use and setup

#### 01 first-use — `apkit`

Your version, unchanged, with the logo kept on top:

```
  /\  Agent Profile Kit
 /__\ reusable agent material

⚠ Agent Profile Kit is not set up on this machine.

Your Workspace folder holds your Context, Skills, and Profiles. You only need
one Workspace for all of your Projects.

Start by naming the folder that will hold the Workspace. The second command
uses the current folder instead.

Next:
- apkit init <path>
- apkit init .

Run apkit --help for the full command list.
```

#### 02 setup confirmation — `apkit init ./workspace`

```
Context, Skills, and Profiles will be stored in and loaded from
  /private/tmp/apkit-653-session/100/workspace

This folder doesn't exist yet. Setup will create it and add:
- workspace.yaml
- context/
- skills/
- profiles/

❯ Set up this folder as your Workspace? (y/N)
```

#### 03 setup done

```
✔ Created your Workspace at
  /private/tmp/apkit-653-session/100/workspace

Profiles group Context and Skills for one kind of work. You can reuse them
across Projects.

Skills are the skills you already use (open standard). Drop skill folders into
workspace/skills/ to use them in a Profile.

Context is plain Markdown in workspace/context/. Every agent session loads the
Context in its Profile.

Agents found: claude, codex

Next:
- apkit new profile (create your first Profile, step by step)
```

The next step changes from two commands to one guided command (see "Creating a
Profile" below and D3).

#### 20/21 setup again on a Workspace that is complete — `apkit init <path>`

```
Context, Skills, and Profiles will be stored in and loaded from
  /private/tmp/apkit-653-session/100/workspace

This folder already has everything it needs.

❯ Use this folder as your Workspace? (y/N)
```

```
✔ Connected your Workspace at
  /private/tmp/apkit-653-session/100/workspace

Agents found: claude, codex

Next: apkit install (run it inside a Project folder)
```

The Workspace already has Profiles, so this screen does not explain the
concepts again.

---

### Creating a Profile (new — not in the capture)

The capture ran `apkit new profile` but left those screens out of the gallery.
Today they look like this:

```
✔ Created Profile engineering at
  /private/tmp/apkit-653-session/100/workspace/profiles/engineering.yaml
  Context: team
Available Context Modules: team
Available Skills: none
Next: from the project you want to try, run apkit install engineering
```

Proposal: `apkit new profile` with no name guides you through it, reusing the
install pickers. Setup still does not create a Profile for you (DEC-010 stays).

#### P1 no Context or Skills yet — `apkit new profile`

```
A Profile needs at least one Context file or Skill, and your Workspace has none
yet.

Add some first:
- Put skill folders in workspace/skills/
- apkit new context <name> (create a Context file to fill in)

Then run apkit new profile again.
```

#### P2 name — `apkit new profile`

```
A Profile groups Context and Skills for one kind of work, like "engineering"
or "writing".

❯ Name your Profile › engineering
```

#### P3 pick Context

```
✔ Name › engineering

Context is loaded in every agent session that uses this Profile.

❯ Which Context?
type to filter › ↑↓ move › space toggle › enter submit
❯ ◼ team
  ◻ style
```

#### P4 pick Skills

```
✔ Name › engineering
✔ Context › team

Agents load Skills only when they need them.

❯ Which Skills?
type to filter › ↑↓ move › space toggle › enter submit
❯ ◻ review-pr
  ◻ write-tests
```

#### P5 created

```
✔ Created the engineering Profile
  Context: team
  Skills: review-pr

Change it later with apkit configure profile engineering.

Next: apkit install engineering (run it inside a Project folder)
```

#### P6 `apkit new context team`

```
✔ Created workspace/context/team.md

Open it and write the rules every agent session should follow.

Next: apkit new profile (make a Profile that uses it)
```

---

### Installing

#### 10 Profile picker — `apkit install`

```
Installing into /private/tmp/apkit-653-session/100/projects/selection

❯ Which Profile?
type to filter › ↑↓ move › enter select
❯ engineering
  writing
```

The Profile explanation moves to setup and `apkit new profile`, where you first
meet the word. Here you have already made one.

#### 11/12 agent picker

```
Installing into /private/tmp/apkit-653-session/100/projects/selection

✔ Profile › engineering

Pick the agents that should use this Profile here. apkit doesn't install the
agents themselves.

❯ Which agents?
type to filter › ↑↓ move › space toggle › enter submit
2 selected
❯ ◼ claude       detected
  ◼ codex        detected
  ◻ antigravity  not found
  ◻ grok         not found
  ◻ opencode     not found
  ◻ pi           not found
```

#### 13 confirmation

```
Installing into /private/tmp/apkit-653-session/100/projects/selection

✔ Profile › engineering
✔ Agents › claude, codex

❯ Install now? (y/N)
```

The separate "Install into … Profile … Hosts" summary is removed: the two
answers above already show it.

#### 14 declined

```
● Cancelled. Nothing was changed.
```

#### 04 first install — `apkit install engineering <path> --agent codex`

```
✔ Installed the engineering Profile
  Project: /private/tmp/apkit-653-session/100/projects/hello
  Agents: codex

Before your agents can load it:
- Start your agents from this Project folder, not a subfolder.
- Codex: approve the SessionStart hook when asked, and trust this project.

Try it: start a new Codex session in this project and ask which Profile it
loaded.

Next: apkit status (see installed Profiles and whether they're up to date)
```

Setup steps: one line that is true for every agent, then one line for each
agent that needs more (D5). Agents with nothing extra to do are left out, so
Claude has no line of its own.

#### 26 install with two agents, narrow width

```
✔ Installed the engineering Profile
  Project: ~/proj/alpha
  Agents: claude, codex

Before your agents can load it:
- Start your agents from this Project folder, not a subfolder.
- Codex: approve the SessionStart hook when asked, and trust this project.

Try it: start new Claude and Codex sessions in this project and ask which
Profile each loaded.

Skip the questions next time:
  apkit install engineering ~/'proj/alpha' --agent claude --agent codex --auto-confirm

Next: apkit status (see installed Profiles and whether they're up to date)
```

---

### Everyday use

#### 05 routine update — `apkit update`

```
● Everything is already up to date.
```

#### 17 update that changed files

```
✔ Updated 4 Projects (7 files)

Start a new agent session in a Project to use the changes.
```

#### 06/16 status — `apkit status`, `apkit status --all`

```
✔ Everything is up to date (4 Projects)

Workspace: /private/tmp/apkit-653-session/100/workspace

Project                              Status
acme-internal-analytics-pipeline-v2  up to date
alpha/my-app                         up to date
beta/my-app                          up to date
hello                                up to date
```

#### 07 validate — `apkit validate`

```
✔ Your Workspace looks good

Workspace: /private/tmp/apkit-653-session/100/workspace
Profiles: engineering, writing
Projects: 1
Agents in use: codex

Next: apkit status (check your Projects)
```

#### 15 list projects — `apkit list projects`

```
Your Projects (4)

Project                              Profile      Agents         Status
acme-internal-analytics-pipeline-v2  engineering  claude, codex  ok
alpha/my-app                         engineering  claude, codex  ok
beta/my-app                          engineering  claude, codex  ok
hello                                engineering  codex          ok

Next: apkit status (check whether they're up to date)
```

"configured" becomes "ok"; a Project with a problem still shows "problem".

#### 22 list agents — `apkit list agents` (was `list hosts`)

```
Supported agents

  claude       detected
  codex        detected
  antigravity  not found
  grok         not found
  opencode     not found
  pi           not found

"not found" means apkit couldn't find it on this machine. You can still pick it
when you install.
```

---

### When something goes wrong

#### 08 unknown Profile

```
✖ There's no Profile called 'enginering'.

Did you mean 'engineering'?
Your Profiles: engineering, writing
```

#### 09 missing Project folder

```
✖ The folder /private/tmp/apkit-653-session/100/missing doesn't exist.

Create it first, or pick a folder that exists.
```

#### 27 agent missing — `apkit update`

```
● Everything is already up to date.

⚠ Claude Code isn't installed, or isn't on your PATH.
  Used by: alpha, acme-internal-analytics-pipeline-v2, alpha/my-app, beta/my-app
  Fix: install Claude Code, then check that `claude --version` works.

⚠ Codex isn't installed, or isn't on your PATH.
  Used by: alpha, acme-internal-analytics-pipeline-v2, alpha/my-app, beta/my-app,
    hello
  Fix: install Codex, then check that `codex --version` works.

Details: apkit details (see exactly what this run checked)
```

"Used by" shows every Project up to 10 and never hides just one (D6).

#### 28 uninstall stopped partway — `apkit uninstall --all --auto-confirm`

```
✖ Uninstall stopped partway.

Couldn't write to
  /private/tmp/apkit-653-session/100/projects/acme-internal-analytics-pipeline-v2
  (permission denied)

- Done: ~/proj/alpha
- Put back as it was, where possible: acme-internal-analytics-pipeline-v2
- Not touched: alpha/my-app, beta/my-app, hello

Fix the permission, then run the same command again:
  apkit uninstall --all --auto-confirm

Details: apkit details (see exactly what changed)
```

#### 18 history — `apkit details --list`

```
Recent runs (7)

Run        When      Command  Result     Scope
op-000007  just now  update   succeeded  all Projects
op-000006  just now  install  succeeded  one Project
op-000005  just now  install  succeeded  one Project
op-000004  just now  install  succeeded  one Project
op-000003  just now  install  cancelled  one Project
op-000002  just now  update   no-op      all Projects
op-000001  just now  install  succeeded  one Project

Next: apkit details <run> (see exactly what one run changed)
```

#### 19 one run — `apkit details`

```
✔ Update op-000007 succeeded
  Today at 9:45 AM · all Projects

Changed files:
  /private/tmp/apkit-653-session/100/projects/acme-internal-analytics-pipeline-v2
    + .agent-profile-kit/codex/context.md
    + .claude/rules/agent-profile-kit.md
  /private/tmp/apkit-653-session/100/projects/hello
    + .agent-profile-kit/codex/context.md
```

#### 29 one run that stopped partway

```
⚠ Uninstall op-000010 stopped partway
  Today at 9:45 AM · all Projects

What went wrong:
  /private/tmp/apkit-653-session/100/projects/acme-internal-analytics-pipeline-v2
    permission denied

Changed files:
  ~/proj/alpha
    - .agent-profile-kit/codex/context.md
    - .claude/rules/agent-profile-kit.md
    - .codex/hooks.json

Not done:
- alpha/my-app
- beta/my-app
- hello
```

---

## Principal decisions

- **D1 — "agent" instead of "Host": accepted, words on screen and commands.**
  `--host` becomes `--agent` and `apkit list hosts` becomes `apkit list agents`.
  This is a breaking change, which is allowed before 1.0 (ADR-0014). It needs an
  ADR and a `CONTEXT.md` update, because the glossary term is "Agent Host" and a
  Profile's _Avoid_ list includes "Agent".
- **D2 — three concepts on the setup screen: accepted.** This relaxes the limit
  of two per screen from #645 for this screen only.
- **D3 — guided `apkit new profile` (P1–P5): accepted.**
  Setup still does not create a Profile, so DEC-010 from #646 still holds.
- **D4 — `Details:` only when something went wrong: accepted.** This reverses
  part of ADR-0040.
- **D5 — setup steps: accepted.** Every install says "Start your agents from
  this Project folder, not a subfolder." That is always safe, and for Codex in a
  Project without Git it is required. After that, one line for each agent that
  needs more: Codex (hook approval, trust), Antigravity and Pi (trust), and
  OpenCode (restart after a config change). Grok's line explains that it reads
  Claude's Context file.
- **D6 — never hide just one Project: accepted.** List up to 10, then
  "… and N more".

## Answers to the questions in the notes

- **Can every setting be changed through the CLI?** Almost. `init` sets the
  Workspace, `install` and `uninstall` add and remove Projects and agents, and
  `configure profile` changes a Profile. One case still needs a hand edit of
  `~/.agents/agent-profile-kit/config.yaml`: to stop managing a Project but
  keep its files (`docs/guides/workspace.md`). The setup screen can drop the
  settings path.
- **What does `apkit details` give a user?** The files that one run wrote or
  removed in each Project, its failures, and the work it left undone. That
  helps when something went wrong and adds little after a normal success,
  hence D4.
- **Why does only Codex need the start-folder step?** Claude looks for its
  files upward from the folder where it starts, so a subfolder works. Codex
  looks upward only to the top of the Git repo. Without Git, it reads only the
  folder where it starts, so a subfolder misses the Profile. D5 replaces that
  Codex-only step with one line for every agent.
