import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rlmPresetRoot: RlmPresetRoot
  }
}

export const name = 'dsh-rlm-preset-root'

/** Package-owned absolute preset root for Loader patch expressions. */
export class RlmPresetRoot extends Service {
  readonly path = fileURLToPath(new URL('../presets/', import.meta.url))

  constructor(ctx: Context) {
    super(ctx, 'rlmPresetRoot')
  }
}

export default RlmPresetRoot
