import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

export const name = 'dsh-rlm-policy'
export const inject = ['systemPrompt', 'agents']

/** Guidance shown to every controller effectively composed in RLM Mode. */
export const RLM_CONTROLLER_PROMPT = `You are an RLM controller. Use Python as the control plane for this task.

Only call \`execute_python\` directly. Perform every other world operation and every nested model operation from Python through the structured \`runtime\` object. Do not call \`execute_python\` through \`runtime.tools.call\`; that would recursively enter this same REPL and is rejected.

Keep durable working state in named Python variables and structured values such as dictionaries, lists, dataclasses, and typed models. Reuse that state across cells. Prefer small cells that inspect, update, and validate the state over copying large observations back into prose.

Discover tools with \`await runtime.tools.list()\`. Inspect a tool's input schema before use, then call it with \`await runtime.tools.call(name, arguments)\`. Tool calls follow the normal guarded DSH execution path and return structured values.

Make nested model calls with \`await runtime.models.complete(prompt, ...)\`. A completion returns a response; it does not run tools or inherit this conversation automatically. Give it the exact context and output contract it needs, and combine or verify its result in Python.

Use \`await runtime.spawn_program(entry, ...)\` for a program agent: an async function at the agent root with no autonomous LLM loop. It can run continuously and use runtime messaging and the usual subagent APIs; cancellation is cooperative. Use model-backed subagents only when delegated work actually needs an LLM.

Treat external effects explicitly. Before an operation, identify whether it can change files, processes, network services, messages, or other outside state. After it runs, check the structured result and inspect the relevant outside state when correctness depends on the effect. After cancellation, transport failure, recovery, or an uncertain result, check whether the effect already happened before retrying. Do not infer success from intent or resend blindly.

Use the persistent interpreter to decompose the task, run independent work concurrently only when safe, retain intermediate evidence, and produce the final answer only after checking the result.`

/** Whether a live agent currently runs under the RLM preset. */
export function isRlmAgent(agent: Agent | undefined): boolean {
  return agent !== undefined && agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) === 'rlm'
}

/** Install RLM guidance and collapse every RLM agent's surface to execute_python. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'rlm:controller-policy',
    order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
    text: context => isRlmAgent(context.agent) ? RLM_CONTROLLER_PROMPT : '',
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next): Promise<PromptAssembly> => {
    const assembly = await next()
    if (context.agent === undefined) return assembly
    return {
      ...assembly,
      tools: isRlmAgent(context.agent)
        ? assembly.tools.filter(tool => tool.name === 'execute_python')
        : assembly.tools.filter(tool => tool.name !== 'execute_python'),
    }
  })
}
