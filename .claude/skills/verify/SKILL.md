---
name: verify
description: 全模块验证菜单——类型检查 + 测试 + lint + 构建，一键跑完所有模块
---

执行 Forge Hub 完整验证菜单，逐模块运行检查并汇报结果。

## 步骤

1. Hub Server（类型检查 + 测试）：
   ```bash
   (cd hub-server && bun install && bunx tsc --noEmit && bun test)
   ```

2. Hub Client（类型检查）：
   ```bash
   (cd hub-client && bun install && bunx tsc --noEmit)
   ```

3. Forge CLI（测试）：
   ```bash
   (cd forge-cli && bun test)
   ```

4. Forge Engine（类型检查 + 测试）：
   ```bash
   (cd forge-engine && bun install && bunx tsc --noEmit && bun test)
   ```

5. Dashboard（lint + 构建）：
   ```bash
   (cd hub-dashboard && bun install && bun run lint && bun run build)
   ```

6. 集成 Harness（8 场景端到端）：
   ```bash
   bun hub-test-harness/harness.ts
   ```

## 输出

汇报摘要表：模块 | 状态（通过/失败）| 耗时。任何步骤失败时显示错误输出并停止。
