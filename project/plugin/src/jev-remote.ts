import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JevStatus, JevTestResult } from './jev-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context { jevRemote: JevRemote }
}

/** Public Remote decorators use the Gateway's supported source-mode discovery.
 * Only two no-argument, secret-free methods are exposed, not arbitrary judging.
 */
export class JevRemote extends TypertRemoteService {
  static inject = ['jev']
  constructor(ctx: Context) { super(ctx, 'jevRemote', { namespace: 'jev' }) }

  @Remote
  async status(): Promise<JevStatus> {
    return await this.ctx.jev.status()
  }

  @Remote
  async testConnection(signal: AbortSignal): Promise<JevTestResult> {
    return await this.ctx.jev.testConnection(signal)
  }
}
export default JevRemote
