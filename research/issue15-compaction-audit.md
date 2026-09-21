# Issue 15: compaction audit

## Scope and source findings

This audit covers the RLM preset composition and the `execute_python` text presented to the compaction tool-result pruner. No preset behavior was changed.

The RLM `compaction` row is structurally identical to the Standard preset shipped by the locally installed `@deepseek-ai/dsh-agent-presets`: one isolated group (`compaction` and `toolResultPruner`) contains `compaction-basic`, `command-compact`, and `tool-result-pruner`. The pruner budgets are exactly `thresholdChars: 8192`, `headChars: 4096`, and `tailChars: 1024`.

`execute_python` rendering places a recovery notice first, then ordinary cell output, then checkpoint failure and newly nonrecoverable-state warnings at the tail. The locally installed `@deepseek-ai/dsh-compaction-tool-result-pruner` deterministically retains 4096 Unicode code points from the head and 1024 from the tail when total text exceeds 8192, inserting its marker between them. Thus the mandatory recovery beginning and checkpoint safety tail survive a huge stdout middle in the tested case.

## Executable evidence

`test/compaction.test.js` parses both YAML files with transitive `js-yaml` (including the shipped preset's `!!js` scalar tag), deep-compares the complete compaction rows, and also asserts the expected exact structure and numeric budgets.

The rendering/pruning test calls the real `renderResult`, creates output containing 12,000 stdout characters, and imports the actual installed pruner by resolving it relative to the `dsh` executable on `PATH` (not through a hard-coded npm cache path). It invokes the installed implementation's `pruneContent` and checks the exact head/marker/tail result plus semantic survival of both safety edges. `renderResult` lives in an internal helper module so the executable contract test can import it without expanding the package root API; runtime rendering uses that same function.

## Threat-model caveat

Head/tail retention protects safety text only while the recovery notice itself fits in the retained head and the combined checkpoint warning text fits in the retained tail. Extremely long recovery notices, errors, tracebacks after stdout, or more/larger newly-skipped entries can consume those budgets. Pruning works in Unicode code points and may split grapheme clusters. This safeguard verifies current ordering and budgets; it is not a general trusted-channel guarantee against adversarially large safety metadata or changes in upstream pruner semantics.

## Pending live validation

Live `/compact` tests in the Web GUI remain pending. They should confirm manual compaction of an actual RLM session with stdout over 8192 characters, a recovery notice, checkpoint failure, and newly nonrecoverable state, including the final model-visible transcript and replay after refresh/restart. No deployment was performed.
