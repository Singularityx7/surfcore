// 灵魂反思会话的安全硬边界：不提供任何工具。
//
// 反思材料会读入群聊记忆、日记和消息摘录，其中可能夹带群友写的注入文本。
// 因此这里不依赖提示词自觉：
//   1) 注册期把已知危险全局工具从 schema 隐藏（复用 QQ 守卫的唯一名单）；
//   2) 执行期对**所有**工具调用一律拒绝，包括 QQ MCP 与联网工具。
// 反思会话没有 QQ 会话令牌，但这条守卫保证即使令牌泄漏也不会从这里发出消息。
import { RESTRICTED_TOOL_NAMES } from './qq-tool-restrict.mjs'

export const name = 'soul-reflect-guard'

export const inject = ['tools']

export function apply(ctx) {
  const skipped = []
  for (const toolName of RESTRICTED_TOOL_NAMES) {
    try {
      ctx.tools.restrict({ deny: [toolName] })
    } catch {
      skipped.push(toolName)
    }
  }
  if (skipped.length) {
    console.error(`[soul-reflect-guard] 跳过 ${skipped.length}/${RESTRICTED_TOOL_NAMES.length} 个当前版本不存在的工具名（执行期仍全拒）`)
  }

  ctx.tools.guard((exec) => {
    const toolName = exec?.name
    return `灵魂反思会话不提供任何工具（收到：${typeof toolName === 'string' && toolName ? toolName : '无效工具名'}）`
  })
}
