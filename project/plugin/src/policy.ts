import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

export const name = 'dsh-rlm-policy'
export const inject = ['systemPrompt', 'agents']

/** Guidance shown only to the top-level controller in RLM Mode. */
export const RLM_CONTROLLER_PROMPT = `You are the root RLM controller. Use Python as the control plane for this task.

Only call \`execute_python\` directly. Perform every other world operation and every nested model operation from Python through the structured \`runtime\` object. Do not call \`execute_python\` through \`runtime.tools.call\`; that would recursively enter this same REPL and is rejected.

Keep durable working state in named Python variables and structured values such as dictionaries, lists, dataclasses, and typed models. Reuse that state across cells. Prefer small cells that inspect, update, and validate the state over copying large observations back into prose.

Discover tools with \`await runtime.tools.list()\`. Inspect a tool's input schema before use, then call it with \`await runtime.tools.call(name, arguments)\`. Tool calls follow the normal guarded DSH execution path and return structured values.

Make nested model calls with \`await runtime.models.complete(prompt, ...)\`. A completion returns a response; it does not run tools or inherit this conversation automatically. Give it the exact context and output contract it needs, and combine or verify its result in Python.

Treat external effects explicitly. Before an operation, identify whether it can change files, processes, network services, messages, or other outside state. After it runs, check the structured result and inspect the relevant outside state when correctness depends on the effect. After cancellation, transport failure, recovery, or an uncertain result, check whether the effect already happened before retrying. Do not infer success from intent or resend blindly.

Use the persistent interpreter to decompose the task, run independent work concurrently only when safe, retain intermediate evidence, and produce the final answer only after checking the result.`

/** Whether an assembly belongs to a top-level Agent rather than a diagnostic or child. */
export function isRootAgent(ctx: Context, context: AssembleContext): boolean {
  return context.agent !== undefined && ctx.agents.roots().includes(context.agent)
}

/** Install root-only RLM guidance and keep execute_python out of child assemblies. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'rlm:controller-policy',
    order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
    text: context => isRootAgent(ctx, context) ? RLM_CONTROLLER_PROMPT : '',
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next): Promise<PromptAssembly> => {
    const assembly = await next()
    if (context.agent === undefined) return assembly
    return {
      ...assembly,
      tools: isRootAgent(ctx, context)
        ? assembly.tools.filter(tool => tool.name === 'execute_python')
        : assembly.tools.filter(tool => tool.name !== 'execute_python'),
    }
  })
}
