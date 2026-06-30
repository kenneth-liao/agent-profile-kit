---
name: the-ai-launchpad
description: Enforce The AI Launchpad brand guidelines when creating visual assets or written content. Resolves the correct design system for each asset type, applies brand voice and tone, and checks for anti-patterns. Use whenever creating, reviewing, or editing assets for The AI Launchpad.
---

# The AI Launchpad Brand Guidelines

Enforce brand identity across all visual and written assets for The AI Launchpad.

---

## 1. Brand Identity

**Name:** The AI Launchpad
**Tagline:** Actionable AI tips & techniques every Tuesday — automate repetitive stuff and focus on higher leverage problems.
**Mission:** Help solopreneurs use AI to unlock themselves, get their time back, and work on higher leverage problems.
**Value Proposition:** Practical, actionable AI automation strategies — not theory or hype, but real techniques you can implement today to automate repetitive work.

---

## 2. Voice & Tone

**Voice Traits:** Friendly & approachable, Expert & authoritative

**Friendly & approachable** — Conversational, warm, uses "you" and "we". Makes complex topics feel simple. Think: helpful friend who happens to be an expert. Write the way you'd explain something to a smart colleague over coffee — naturally, without pretension, but with real substance.

**Expert & authoritative** — Confident, precise, backs claims with evidence. Establishes trust through depth. Think: trusted advisor who's done the research. Every claim is supported by a specific tool, technique, workflow, or personal experience — never vague hand-waving.

**Tone Modifiers:** Casual vocabulary, Direct & actionable

**Casual vocabulary** — Uses everyday language, contractions, and informal phrasing. Avoids jargon unless explaining it. "Use" instead of "leverage." "Try" instead of "implement." If a sentence sounds like it belongs in a corporate whitepaper, rewrite it.

**Direct & actionable** — Focuses on what to do, not just what to know. Every piece of content has a clear takeaway or next step. The reader should finish thinking "I know exactly what to do next" — not "that was interesting, I guess."

**Voice Application Rules:**

Apply these rules whenever creating written content, alt text, captions, titles, or any text associated with The AI Launchpad assets:

1. Write like you're talking to a smart friend over coffee — use "you" and "we," contractions, and plain language. If it reads like a corporate memo, rewrite it.
2. Back up every claim with specifics — real tools, concrete steps, or personal experience. Never say "AI can help" without showing exactly how.
3. Every piece of content must end with something the reader can do right now. If there's no clear takeaway, it's not ready to publish.
4. Explain technical concepts in everyday terms first, then name the technical term. Never assume the reader knows the jargon — but don't dumb it down either.

---

## 3. Target Audiences

### Primary: Solopreneurs & Small Business Owners

- **Who they are:** Builders juggling multiple projects — a YouTube channel, a newsletter, a SaaS product, a side hustle. They're ambitious, resourceful, and perpetually short on time. They already believe AI is useful but haven't cracked how to make it work consistently in their workflows.
- **Goals:** Automate the repetitive grunt work so they can focus on creative, high-leverage activities that actually grow their business. Ship faster without hiring a team.
- **Frustrations:** Overwhelmed by AI tool noise — every day there's a new "game-changer" that turns out to be hype. Tired of tutorials that demo flashy tricks but don't show practical, day-to-day workflow integration. Don't have time to experiment endlessly.
- **What resonates:** Step-by-step tutorials with real workflows. "Here's exactly what I did" transparency. Proof over promises — show the before and after. Content that respects their time and gets to the point.
- **Platforms:** Substack, YouTube, Twitter/X, LinkedIn

### Secondary: AI-Curious Professionals

- **Who they are:** Working professionals who aren't yet proficient with AI but recognize the shift happening around them. They don't want to get left behind and are actively looking to upskill — not to become engineers, but to stay relevant and competitive in their field.
- **Goals:** Build practical AI fluency without needing a technical background. Understand which tools matter, which are hype, and how to start using AI in their existing work.
- **Frustrations:** Intimidated by the pace of change. Overwhelmed by jargon-heavy content aimed at developers. Unsure where to start — most "beginner" resources still assume too much technical knowledge.
- **What resonates:** Beginner-friendly "start here" guides. Plain-language explanations of what AI actually does. Evidence that regular professionals (not just engineers) can use these tools effectively. Encouragement without condescension.
- **Platforms:** LinkedIn, YouTube, newsletters, Google search

---

## 4. Design System Resolution

When creating a visual asset for The AI Launchpad, resolve the correct design system using the mapping table below.

### Asset Type → Design System Mapping

| Asset Type | Design System | Path |
|------------|---------------|------|
| YouTube thumbnails | Launchpad Thumbnails | `~/.claude/.context/design-systems/launchpad-thumbnails/launchpad-thumbnails-design-system.md` |
| Social media posts | Ink & Ember | `~/.claude/.context/design-systems/ink-and-ember/ink-and-ember-design-system.md` |
| Blog/newsletter headers | Ink & Ember | `~/.claude/.context/design-systems/ink-and-ember/ink-and-ember-design-system.md` |
| Course/product assets | Ink & Ember | `~/.claude/.context/design-systems/ink-and-ember/ink-and-ember-design-system.md` |

### Resolution Logic

When asked to create an asset for The AI Launchpad:

1. **Identify the asset type** from the request (e.g., "make a YouTube thumbnail" → YouTube thumbnails)
2. **Look up the mapping** in the table above
3. **If a design system is mapped:** Load the design system document at the specified path. Apply all visual rules (colors, typography, line work, composition, character system) from that document.
4. **If mapped to "Create new":** Inform the user that a new design system was flagged for this asset type but hasn't been created yet. Offer to create one using the branding-kit:design-system skill, or ask the user to assign an existing design system.
5. **If mapped to "Decide later":** Inform the user that no design system is assigned for this asset type. List available design systems from `~/.claude/.context/design-systems/` and offer to assign one, or offer to create a new one using the branding-kit:design-system skill.
6. **If no matching asset type:** Ask the user which design system to use, or whether to create a new category.

---

## 5. How To Apply

Follow this procedure whenever creating any asset for The AI Launchpad:

### Step 1: Identify the asset type
Determine what kind of asset is being created from the user's request. Match it to one of the asset types in the mapping table above.

### Step 2: Resolve the design system
Use the resolution logic in Section 4 to find the correct design system document for this asset type.

### Step 3: Load the design system
Read the design system document at the resolved path. Extract all visual specifications: color palette, line work rules, composition approach, character system, typography, and the prompt library.

### Step 4: Apply brand voice
For any text content in or accompanying the asset (titles, captions, alt text, descriptions), apply the voice application rules from Section 2. Ensure the tone matches the brand personality.

### Step 5: Apply visual identity
Use the design system's specifications to create the visual asset. Follow the prompt library templates if generating images with AI tools.

### Step 6: Check anti-patterns
Before finalizing, review the asset against the anti-patterns in Section 6. Flag and fix any violations.

---

## 6. Brand Anti-Patterns

These are things The AI Launchpad should **NEVER** do. Check every asset against this list before delivery.

1. **Never use cold, corporate, or impersonal language.** This brand is friendly and approachable — if it sounds like a corporate memo, it's off-brand. No jargon walls, no formal third-person constructions, no language that creates distance between the brand and the reader.
2. **Never be wishy-washy or non-committal.** This brand is an expert authority — back claims with evidence and take clear positions. Avoid hedging language ("maybe", "sort of", "it depends"), unsupported claims, or content that lacks depth.
3. **Never publish content without a clear actionable takeaway.** Every post, caption, newsletter, or asset should give the audience something they can do right now. If it's just "interesting" without being useful, it's not ready.
4. **Never use jargon without explaining it.** Casual and accessible always — if a term needs a glossary, rewrite the sentence. Respect the AI-curious professional who's reading alongside the expert solopreneur.
5. **Never mix design systems across a single asset.** Each asset type has one assigned design system — use it consistently.
6. **Never create visual assets without loading the design system first.** Always resolve the correct design system document and apply its full specification.
