---
name: sync-check
description: 检查运行时（~/.forge-hub/）和源码仓库是否同步
---

运行同步检查脚本，对比源码和运行时的差异。

## 步骤

```bash
bash scripts/check-runtime-sync.sh
```

## 输出

- 同步：报告"运行时与源码一致"
- 不同步：列出有差异的文件，并建议是否需要运行 `bash scripts/sync-to-runtime.sh` 同步
