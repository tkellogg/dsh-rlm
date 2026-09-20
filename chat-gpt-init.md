# DSH + RLM Hack Project Handoff

## Core idea

I’m considering building a new agent project on top of **DeepSeek Harness (DSH)** rather than reviving my existing **Lanius** harness directly.

The main architectural bet is:

> **Let DSH own the runtime; build my own cognition layer on top.**

DSH provides a surprisingly thick substrate for agents: sessions, persistence, replay/forking, tools, model providers, subagents, execution environments, permissions, compaction, workflows, UI, and plugin composition via Cordis.

Rather than rebuilding all of that, I want to explore whether I can build an **RLM-native agent architecture** as an out-of-tree DSH extension/plugin/preset.

This may or may not retain the Lanius name. Conceptually it’s different enough that a new project/name may make more sense.

---

# Background: DSH vs Cordis

**Cordis** is the underlying TypeScript meta-framework. Its main idea is “spatiotemporal composability”:

* plugins have explicit lifecycles
* effects/registers/listeners clean themselves up when plugins disappear
* services are dependency-injected
* components activate/deactivate as dependencies appear/disappear
* services can be scoped/isolated, so different branches of the runtime can see different implementations
* hot replacement/config reloading is a first-class concept

Cordis is the deep framework-level idea.

**DSH** is effectively an opinionated agent-system distribution built on top of Cordis.

A useful analogy:

> Cordis : DSH :: Linux kernel : Ubuntu

or:

> Cordis : DSH :: React : Next.js

DSH takes Cordis and makes concrete agent-specific decisions about:

* model adapters
* tools
* sessions
* compaction
* execution
* subagents
* agent loops
* permissions
* workflows
* UI
* persistence
* ACP / external agent providers
* etc.

DSH is not just one giant “agent plugin”; it decomposes the agent system into many Cordis-level capabilities/services.

That decomposition is important.

---

# Why build on DSH rather than Cordis directly?

Cordis is appealing because model harnesses are already my thing; I would absolutely enjoy inventing all the agent abstractions myself.

However, DSH gives me an enormous amount for free.

The question becomes:

> **Are DSH’s seams good enough that I can own the cognition while treating the rest of the harness as infrastructure?**

Current impression: yes.

DSH explicitly treats the concrete `agent-loop` as replaceable. The public abstraction is the agent/capability seam, not a sacred central runtime.

So the initial strategy should probably be:

> **Do not fork DSH unless forced. Build out-of-tree extensions against its public seams.**

DSH moves extremely fast and breaks compatibility, so maintaining a large fork would be painful.

---

# DSH development velocity

DSH is under extremely rapid development, probably with substantial agent-assisted work.

The repo has a very high commit rate, many parallel worktrees/branches, aggressive release cadence, and frequent changes across:

* web UI
* sessions
* model adapters
* subprocess/runtime management
* CI
* desktop
* subagents
* manifests
* testing
* workflows

Cordis moves slower but has accelerated since DSH began stressing it heavily.

Importantly, DSH vendors Cordis and carries local Cordis patches. Some changes discovered/fixed inside DSH later flow upstream into Cordis.

So the relationship is approximately:

```text
Cordis upstream
    ↓
DSH vendors Cordis
    ↓
DSH stresses it under a huge agent workload
    ↓
DSH patches Cordis locally
    ↓
some improvements flow back upstream
```

That makes the vendored Cordis inside DSH particularly interesting as a source of “what broke in practice?”

---

# Proposed maintenance strategy

Because DSH changes so quickly, I don’t want to manually chase upstream changes forever.

Instead, build an **ambient compatibility agent** that watches DSH.

Conceptually:

```text
new DSH commit/release
        ↓
update dependency in test branch
        ↓
run extension test suite
        ↓
    pass → update pin
        ↓
    fail
        ↓
agent investigates API/runtime break
        ↓
compatibility patch
        ↓
PR / update
```

This is one place where an autonomous maintenance agent is genuinely justified.

The goal is for my project to remain an external extension rather than a permanent DSH fork.

---

# The major shift: I’ve become very RLM-pilled

The original RLM pitch is mostly:

> RLMs let models operate effectively over enormous contexts by inspecting/querying the context programmatically rather than attending over all of it directly.

That matters a lot at work, especially for contract analysis.

But I think the **more important architectural insight** is:

> **RLMs operate on state much better than ReAct agents.**

This matters well beyond long-context retrieval.

---

# ReAct vs RLM: the state argument

ReAct agents basically operate over a trajectory:

```text
thought
tool call
observation
thought
tool call
observation
...
```

Their working state is mostly implicit in that transcript.

That means useful structured facts get transformed like this:

```text
structured fact
    ↓
narrated observation
    ↓
opaque natural-language transcript
    ↓
later reconstructed approximately
```

For example, during a coding task, useful state might include:

```text
files already inspected
known invariants
hypotheses
test results
failed approaches
dependency graph
subagent findings
unresolved questions
patches applied
things left to verify
```

A normal ReAct agent tends to bury those in text.

Later turns must reconstruct the current world model from linguistic sediment.

Compaction makes this even more lossy.

---

# RLMs preserve structure

An RLM-style agent can instead keep state in representations appropriate to the information:

```python
state.hypotheses["race"] = {
    "location": "FooManager.start",
    "confidence": 0.75,
    "evidence": [...]
}

state.checked_files.add("src/foo.ts")

state.tests["integration_4"] = result
```

The model can then programmatically inspect, transform, filter, group, calculate over, and mutate that state.

The important RLM primitive may not actually be recursion.

The sleeper feature is the **REPL / programmable state environment**.

Instead of forcing every intermediate cognitive operation through natural language, the model can decide:

```text
this is a set → use a set
this is a graph → build a graph
this is a table → query the table
this is a filtering task → write code
this is fuzzy/semantic → invoke an LLM
```

---

# Three kinds of memory/state

A useful architecture separates three things that ReAct tends to conflate:

## 1. Event log — “What happened?”

Append-only history.

DSH is already very good at this:

```text
user messages
model turns
tool calls
tool results
subagent runs
compaction events
session history
replay/forking
```

## 2. Working state — “What do I currently know/believe/intend?”

Mutable, structured, queryable.

Examples:

```text
plans
hypotheses
indexes
maps
graphs
open questions
confidence
scratch datasets
intermediate programs
task state
```

This should be the **RLM cognition layer**.

## 3. Artifact/world state — “What actually exists?”

External reality:

```text
filesystem
git repo
processes
databases
network services
MCP
IoT devices
camera feeds
robot pose
sensor readings
etc.
```

DSH/Cordis provide natural abstractions for this.

So the architecture becomes:

```text
                     RLM
              ┌───────────────┐
              │ WORKING STATE │
              │               │
              │ hypotheses    │
              │ plans         │
              │ indexes       │
              │ scratch data  │
              │ programs      │
              └───────┬───────┘
                      │
             cognition / queries
                      │
       ┌──────────────┴─────────────┐
       ▼                            ▼

 DSH EVENT LOG                DSH/CORDIS WORLD
 "what happened"             "what exists now"

 sessions                     filesystem
 tool results                 shell
 child runs                   git
 compaction                   MCP
 replay                       IoT
                              robots
```

This separation feels very clean.

---

# Ashby + Bitter Lesson framing

The conceptual framing that emerged:

> **Use the dumbest representation that preserves the requisite variety of the problem.**

Or:

> **Use LLMs only where the problem actually demands LLM-level semantic computation; use code everywhere else.**

This is “Ashby-pilled” because the controller only needs enough expressive power/variety to match the problem at hand.

Examples:

```text
exact lookup → dictionary
filtering → code
counting → code
dependency structure → graph
AST question → AST query
clustering → statistics / embeddings
ambiguous architectural judgment → LLM
```

The RLM should continuously choose the cheapest adequate representation.

---

# Why this is also Bitter Lesson-pilled

The interesting part is that as the model becomes more capable, it becomes **better at deciding where not to use itself**.

A weak model may do:

```text
LLM everything
```

A stronger model might realize:

```text
regex handles this
parser handles that
LLM handles the ambiguous remainder
```

A very strong agent can invent new computational reductions on the fly:

```text
"This is actually a graph problem."
→ build graph
→ compute SCCs

"I don’t need to inspect these 500 files."
→ generate AST query

"These results need clustering."
→ write analysis script

"Only these 12 cases remain genuinely ambiguous."
→ call LLM on 12 cases
```

So capability gains can lead to **less LLM reasoning**, not more.

The stronger agent gets better at walking the boundary:

> as simple as possible, while preserving Ashby’s requisite variety.

Another formulation:

> **Minimize semantic computation subject to preserving requisite variety.**

This may be the deeper thesis behind the project.

---

# ReAct’s central architectural mistake

ReAct defaults to:

```text
world
  ↓
text
  ↓
text
  ↓
text
  ↓
text
```

It collapses heterogeneous state into one universal representation: natural language.

RLM-style cognition can instead look like:

```text
world
 ↕
structured state
 ↕
programs
 ↕
LLM only at irreducible semantic boundaries
```

And ideally, once an LLM produces a useful result, the agent converts that result **back into structured state** rather than leaving it buried in prose.

---

# Strong-agent hypothesis

A potentially important thesis:

> **The hallmark of a stronger agent may be its ability to reduce how much intelligence it needs to apply.**

Human expertise often works this way.

Yesterday’s hard reasoning becomes today’s:

```text
procedure
abstraction
notation
tool
checklist
invariant
```

RLMs let agents do something similar dynamically.

---

# Possible empirical test

One strong test of this architecture:

Run a long-lived agent, but periodically delete almost all conversational history.

Keep only:

* structured RLM working state
* external artifact/world access
* a short recent event window

If performance barely degrades, that suggests:

> **The transcript was never really the agent’s memory. It was only an inefficient serialization of state.**

This could make compaction much less critical.

Instead of trying to preserve the “soul” of a 150k-token trajectory in a 5k-token summary, preserve the actual structured state and summarize the old transcript only for narrative context.

---

# Initial implementation strategy

Do **not** immediately replace DSH’s agent loop.

Start with an RLM capability/tool.

Something conceptually like:

```typescript
ctx.rlm.run({
  task,
  cwd,
  budget,
  model,
})
```

Give the normal DSH agent an `rlm()` tool.

The RLM implementation gets a programmable scratch/state environment and can call into DSH capabilities.

Minimal primitives might be:

```text
llm(...)
read/query context or state
execute code
```

`llm()` could route through DSH’s model/subagent machinery.

The RLM could use:

```text
DSH models
DSH subagents
DSH filesystem
DSH shell
DSH sessions
DSH workflows
```

without recreating them.

---

# Why start as a tool/capability?

It answers an important empirical question:

> **How much of the benefit comes from RLM cognition itself, versus replacing the outer agent loop?**

If adding `rlm()` to the stock DSH agent works extremely well, that is already useful.

If the outer ReAct loop starts feeling like pointless overhead, then move toward an RLM-native agent implementation.

---

# Later-stage architecture: RLM-native agent

Eventually:

```text
user prompt
    ↓
RLM-native AgentFactory
    ↓
RLM controller
    ├── structured working state
    ├── REPL / code execution
    ├── model calls
    ├── DSH tools
    ├── DSH subagents
    └── DSH sessions
```

At that point it is no longer “a normal agent with an RLM tool.”

It becomes:

> **An RLM-native agent running on DSH infrastructure.**

That is probably the more interesting end state.

---

# Prime Agent angle

One concrete first application is a coding agent.

Port the parts of **Prime Agent** that have actually proved useful, rather than recreating Prime Agent wholesale.

Likely valuable pieces:

* RLM mechanics
* model routing
* programmatic fanout
* persistent scratch state
* code-driven decomposition
* whatever orchestration patterns empirically beat conventional coding agents

The hypothesis to test:

> **The valuable part of Prime Agent may be its cognition architecture, not its harness.**

DSH lets me test that without rebuilding another harness from scratch.

---

# Three target use cases

## 1. RLM-based coding agent

First and easiest target.

Use DSH for:

```text
tools
shell
filesystem
git
sessions
models
subagents
UI
permissions
persistence
```

Use my layer for:

```text
structured working state
RLM execution
model-routing policy
programmatic decomposition
Prime Agent-like cognition
```

This is probably the correct plane-hack starting point.

---

## 2. Ambient Strix-like agent

Same cognition architecture, but driven by events instead of only chat.

Possible event sources:

```text
filesystem
git commits
calendar
email
camera
MQTT
Home Assistant
robot telemetry
webhooks
timers
etc.
```

The agent has ongoing goals/interests/state.

The RLM working state could track:

```text
active experiments
unresolved questions
long-running projects
things noticed over time
interesting anomalies
plans
confidence
state of external systems
```

This is conceptually related to my earlier Strix/boredom work, but with much better state handling.

---

## 3. IoT / robotics harness

The same runtime can expose physical capabilities.

The laptop remains the main brain.

Devices become Cordis/DSH capability providers:

```text
ctx.devices
ctx.motion
ctx.vision
ctx.robotArm
ctx.homeAutomation
ctx.audio
ctx.sensors
```

Different agents can receive different capability scopes:

```text
coding agent:
  filesystem
  git
  shell

house agent:
  lights
  sensors
  cameras

robot agent:
  motion
  arm
  camera
  emergency stop
```

Cordis scoped services make this especially attractive.

---

# Why these three use cases are actually one project

Initially they look separate:

```text
coding agent
ambient agent
robot/IoT agent
```

But the common architecture is:

> **A persistent RLM cognition engine operating over structured working state and a set of DSH/Cordis-provided capabilities.**

Only the external capabilities differ.

Coding:

```text
world = repo + shell + git
```

Ambient:

```text
world = events + services + files + communications
```

Robotics:

```text
world = devices + sensors + actuators + physical environment
```

The cognition architecture can remain similar.

---

# Dynamic workflows and subagents

DSH already has useful primitives for programmatic orchestration.

Its workflow layer allows orchestration logic to run outside the parent model’s token-by-token loop.

Conceptually:

```javascript
const results = await parallel(
  targets.map(t => () => agent(`Investigate ${t}`))
)
```

rather than:

```text
LLM → spawn A
LLM ← A
LLM → spawn B
LLM ← B
...
```

This matters because orchestration itself can become deterministic code.

DSH’s subagent layer is provider-neutral enough that child workers can potentially be:

```text
in-process DSH
Codex
Claude Code
ACP
other runtimes
```

So the RLM layer can treat child-agent invocation as another computational primitive.

---

# Important distinction: dynamic workflow vs RLM

DSH dynamic workflows are useful, but they are not themselves the full RLM idea.

Dynamic workflow:

> compile orchestration decisions into code.

RLM:

> make the model operate over programmable structured state and recursively invoke semantic computation only where needed.

They overlap strongly, but the RLM layer should own more of the **working-state abstraction**, not just fanout.

---

# What I should probably build first

A deliberately small experiment:

```text
@my-project/dsh-rlm
```

with something like:

```typescript
ctx.rlm.run(...)
```

and a normal DSH tool:

```text
rlm(task)
```

Then test it against one difficult coding task where I already know how Prime Agent or another RLM-style harness behaves.

Measure whether the RLM capability improves:

```text
state continuity
task decomposition
context efficiency
recovery from failed hypotheses
subagent use
cost
latency
quality
```

Do not start with IoT, Strix, a new UI, or a giant framework rewrite.

The first meaningful result is simply:

> **Can an RLM cognition layer inhabit DSH cleanly and outperform the stock trajectory-centric loop on a task where structured state matters?**

If yes, then progressively replace more of the default loop.

---

# Naming / project identity

This may not be Lanius anymore.

Lanius’s original center of gravity was:

```text
event hub
messaging patterns
subagent dispatch
distributed-systems framing
```

This project’s center of gravity is closer to:

> **RLM-native cognition running on a composable agent/physical-world runtime.**

Lanius concepts may still be useful, especially eventing and agent communication, but the new project is philosophically different enough that keeping the name should be optional.

---

# Architectural slogan

The shortest useful summary is:

> **DSH owns the body. RLM owns the mind.**

A slightly more precise version:

> **DSH/Cordis provides durable capabilities and external-world interfaces; the RLM layer maintains structured working state and decides when computation requires code, data structures, child agents, or an LLM.**

And the deeper thesis:

> **Strong agents should not turn everything into text. They should preserve structure whenever possible and use semantic intelligence only where requisite variety demands it.**

That’s the project I want to explore.
