# CLAUDE.md

Claude Code loads this file automatically at the start of every session. That is
its entire purpose: `AGENTS.md` and `AI_WORKFLOW.md` hold this project's actual
rules, and without a `CLAUDE.md` pointing at them they are never read unless
someone names them by hand.

**Do not copy their content into this file.** A second copy drifts, and a stale
rule that reads as current is worse than no rule.

@AGENTS.md
@AI_WORKFLOW.md

If those two lines did not expand into the files' contents above — older Claude
Code versions don't support `@`-imports — then **read both files in full now,
before writing any code**:

- **`AGENTS.md`** — what this project is, and what it is *not*. In particular it
  is not a Cocos Creator / Unity / Phaser project, even though `Scene`, `Node`,
  `Component` and `res/` look familiar. Applying those engines' APIs from memory
  is the single most common source of broken code here.
- **`AI_WORKFLOW.md`** — the mandatory workflow. Rule 1 is how to ground every
  API in a real source instead of guessing it; Rule 2 is the skill-doc lookup
  table; Rule 2b covers whole tasks that span several features (replicating a
  design, adding a loading stage, spawning many objects).

The short version, if you read nothing else: every engine symbol comes from
`'noonengine'` or `'noonengine/3d'`, both barrels are listed in
`AI_WORKFLOW.md`, and if a name isn't in one of them it does not exist — no
matter how plausible it sounds. Check `skills/` before hand-rolling anything.
