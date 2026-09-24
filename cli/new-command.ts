import type { Readable, Writable } from "node:stream";

import { COMMANDS } from "./command-help.js";
import { errorDiagnosticDocument } from "./error-wording.js";
import {
  emptyWorkspaceProfileCreationDocument,
  newArtifactReceiptDocument,
  newProfileCancelledDocument,
  newProfileContextNoteDocument,
  newProfileExplanationDocument,
  newProfileSkillsNoteDocument,
} from "./receipts.js";
import {
  createTextPrompt,
  createSearchableMultiSelectPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
import { writeHumanDocument } from "./presentation-document.js";
import {
  terminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import { createContextModule } from "../installer/create-context-module.js";
import { createProfile } from "../installer/create-profile.js";
import { createSkill } from "../installer/create-skill.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { requireArtifactId } from "../schemas/dependencies.js";

export interface NewCommandRequest {
  readonly home: string;
  readonly arguments: readonly string[];
  readonly stdout: Writable & TerminalStream;
  readonly stderr: Writable & TerminalStream;
  readonly input: Readable;
  readonly clock?: PromptClock;
}

export interface NewCommandOutcome {
  readonly exitCode: 0 | 1;
}

const newCommandSyntax = COMMANDS.find((command) => command.name === "new")!.syntax;
const newProfileExplicitSyntax = "new profile <profile> [--context <context>]... [--skill <skill>]...";

function sanitizeCommandToken(token: string): string {
  return token.replace(/[\r\n\t]/g, " ").trim();
}

function positionalArgument(command: string, description: string, value: string): string {
  if (value.startsWith("-")) {
    throw new Error(`${command} does not accept flag '${value}' as ${description}`);
  }
  return value;
}

function parseNewProfileSelections(
  arguments_: readonly string[],
): { readonly contexts: readonly string[]; readonly skills: readonly string[] } {
  const contexts: string[] = [];
  const skills: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]!;
    const selectsContext = flag === "--context";
    if (!selectsContext && flag !== "--skill") {
      throw new Error(`new profile does not accept argument '${flag}'`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(`new profile requires a value for '${flag}'`);
    }
    index += 1;
    const selected = selectsContext ? contexts : skills;
    if (selected.includes(value)) {
      throw new Error(
        `new profile selects ${selectsContext ? "Context Module" : "Skill"} '${sanitizeCommandToken(value)}' more than once`,
      );
    }
    selected.push(value);
  }
  return { contexts, skills };
}

/**
 * Orchestrates the `apkit new` command: creating Skills, Context Modules, and
 * Profiles in the Workspace.
 *
 * `apkit new profile` without a name guides a newcomer through their first
 * Profile: concept explanation, name prompt (reusing existing Artifact ID
 * validation), and searchable Context and Skill pickers. An empty Workspace
 * receives guidance on how to add material and writes nothing.
 *
 * The explicit form `apkit new profile <name> --context … --skill …` stays
 * scriptable with no prompts. Both forms share the single `createProfile`
 * writer.
 */
export async function runNewCommand(request: NewCommandRequest): Promise<NewCommandOutcome> {
  const stdoutContext = terminalPresentationContext(request.stdout);
  const stderrContext = terminalPresentationContext(request.stderr);
  const arguments_ = request.arguments;

  if (arguments_.length === 0) {
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(
        new Error("new requires an artifact kind; supported kinds: skill, context, profile"),
        { usage: newCommandSyntax },
      ),
      stderrContext,
    );
    return { exitCode: 1 };
  }

  const kind = arguments_[0]!;
  if (kind !== "skill" && kind !== "context" && kind !== "profile") {
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(
        new Error(
          `new does not support kind '${sanitizeCommandToken(kind)}'; supported kinds: skill, context, profile`,
        ),
        { usage: newCommandSyntax },
      ),
      stderrContext,
    );
    return { exitCode: 1 };
  }

  if (kind === "skill") {
    if (arguments_.length < 2 || arguments_[1]!.startsWith("--")) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(new Error("new skill requires a Skill name"), {
          usage: newCommandSyntax,
        }),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    if (arguments_.length > 2) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          new Error(`new skill does not accept argument '${arguments_[2]}'`),
          { usage: newCommandSyntax },
        ),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    try {
      const name = positionalArgument("new skill", "a Skill name", arguments_[1]!);
      const result = await createSkill({ home: request.home, name });
      writeHumanDocument(
        request.stdout,
        newArtifactReceiptDocument({ artifactType: "Skill", id: result.id, path: result.path }),
        stdoutContext,
      );
      return { exitCode: 0 };
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return { exitCode: 1 };
    }
  }

  if (kind === "context") {
    if (arguments_.length < 2 || arguments_[1]!.startsWith("--")) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(new Error("new context requires a Context Module name"), {
          usage: newCommandSyntax,
        }),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    if (arguments_.length > 2) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          new Error(`new context does not accept argument '${arguments_[2]}'`),
          { usage: newCommandSyntax },
        ),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    try {
      const name = positionalArgument("new context", "a Context Module name", arguments_[1]!);
      const result = await createContextModule({ home: request.home, name });
      writeHumanDocument(
        request.stdout,
        newArtifactReceiptDocument({
          artifactType: "Context Module",
          id: result.id,
          path: result.path,
        }),
        stdoutContext,
      );
      return { exitCode: 0 };
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return { exitCode: 1 };
    }
  }

  // Profile creation
  const hasNameArgument = arguments_.length >= 2 && !arguments_[1]!.startsWith("--");
  const interactive = isInteractiveInput(request.input);

  if (!hasNameArgument) {
    if (!interactive) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(new Error("new profile requires a Profile name"), {
          usage: newProfileExplicitSyntax,
        }),
        stderrContext,
      );
      return { exitCode: 1 };
    }

    // Guided Profile creation flow (US-004, DEC-008)
    let workspace;
    try {
      workspace = await ingestSelectedWorkspace(request.home);
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return { exitCode: 1 };
    }

    const availableContexts = [...workspace.contexts.keys()].sort();
    const availableSkills = [...workspace.skills.keys()].sort();

    // Screen P1: Empty Workspace guidance
    if (availableContexts.length === 0 && availableSkills.length === 0) {
      writeHumanDocument(
        request.stdout,
        emptyWorkspaceProfileCreationDocument(),
        stdoutContext,
      );
      return { exitCode: 0 };
    }

    // Screen P2: Profile explanation and name prompt
    writeHumanDocument(request.stdout, newProfileExplanationDocument(), stdoutContext);
    const namePrompt = createTextPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    });
    const nameAnswer = await namePrompt("Name your Profile", { settledLabel: "Name" });
    if (nameAnswer.kind === "cancelled") {
      writeHumanDocument(request.stderr, newProfileCancelledDocument(), stderrContext);
      return { exitCode: 1 };
    }

    let profileId: string;
    try {
      profileId = requireArtifactId(nameAnswer.value.trim(), "new profile name");
      if (workspace.profiles.has(profileId)) {
        throw new InstallerToolError({
          kind: "duplicate-artifact-name",
          artifactType: "Profile",
          id: profileId,
          path: workspace.profiles.get(profileId)!.path,
          stage: "creation",
        });
      }
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return { exitCode: 1 };
    }

    // Screen P3: Context selection
    let selectedContexts: string[] = [];
    if (availableContexts.length > 0) {
      writeHumanDocument(request.stdout, newProfileContextNoteDocument(), stdoutContext);
      const contextPrompt = createSearchableMultiSelectPrompt({
        input: request.input,
        output: request.stdout,
        ...(request.clock === undefined ? {} : { clock: request.clock }),
      });
      const contextAnswer = await contextPrompt(
        "Which Context?",
        availableContexts.map((id) => ({ title: id, value: id })),
        {
          min: availableSkills.length === 0 ? 1 : 0,
          settledLabel: "Context",
        },
      );
      if (contextAnswer.kind === "cancelled") {
        writeHumanDocument(request.stderr, newProfileCancelledDocument(), stderrContext);
        return { exitCode: 1 };
      }
      selectedContexts = [...contextAnswer.values];
    }

    // Screen P4: Skill selection
    let selectedSkills: string[] = [];
    if (availableSkills.length > 0) {
      writeHumanDocument(request.stdout, newProfileSkillsNoteDocument(), stdoutContext);
      const skillPrompt = createSearchableMultiSelectPrompt({
        input: request.input,
        output: request.stdout,
        ...(request.clock === undefined ? {} : { clock: request.clock }),
      });
      const skillAnswer = await skillPrompt(
        "Which Skills?",
        availableSkills.map((id) => ({ title: id, value: id })),
        {
          min: selectedContexts.length === 0 ? 1 : 0,
          settledLabel: "Skills",
        },
      );
      if (skillAnswer.kind === "cancelled") {
        writeHumanDocument(request.stderr, newProfileCancelledDocument(), stderrContext);
        return { exitCode: 1 };
      }
      selectedSkills = [...skillAnswer.values];
    }

    // Screen P5: Commit through the one writer
    try {
      const result = await createProfile({
        home: request.home,
        name: profileId,
        contexts: selectedContexts,
        skills: selectedSkills,
      });
      writeHumanDocument(
        request.stdout,
        newArtifactReceiptDocument({
          artifactType: "Profile",
          id: result.id,
          path: result.path,
          selectedContexts,
          selectedSkills,
          availableContexts: result.availableContexts,
          availableSkills: result.availableSkills,
        }),
        stdoutContext,
      );
      return { exitCode: 0 };
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return { exitCode: 1 };
    }
  }

  // Explicit Profile creation form
  try {
    const name = positionalArgument("new profile", "a Profile name", arguments_[1]!);
    const selections = parseNewProfileSelections(arguments_.slice(2));
    const result = await createProfile({
      home: request.home,
      name,
      contexts: selections.contexts,
      skills: selections.skills,
    });
    writeHumanDocument(
      request.stdout,
      newArtifactReceiptDocument({
        artifactType: "Profile",
        id: result.id,
        path: result.path,
        selectedContexts: selections.contexts,
        selectedSkills: selections.skills,
        availableContexts: result.availableContexts,
        availableSkills: result.availableSkills,
      }),
      stdoutContext,
    );
    return { exitCode: 0 };
  } catch (error) {
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(error, { usage: newCommandSyntax }),
      stderrContext,
    );
    return { exitCode: 1 };
  }
}
