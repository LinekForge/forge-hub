# Hub Dashboard

Forge Hub 的本地 Dashboard。

它主要提供三类能力：

- 看当前在线实例、通道健康和 Hub 概览
- 在浏览器里处理审批队列
- 通过 `Homeland` 和当前接手实例对话（需先授权 `local://operator`）

## 当前定位

- **experimental，但已经进入 install 默认部署面**
- `forge-hub install` 会部署 dashboard 源码并自动构建 `hub-dashboard/dist`
- 在仓库工作区单独 `bun run build` 后，`hub-server` 也同样会静态托管这个产物
- 如果 Hub 开启了 `HUB_API_TOKEN`，Dashboard 首次读取数据时会提示输入 token；成功后由 Hub 写入 HttpOnly cookie，后续 API 与 SSE 自动复用

也就是说：

- 对开源仓库开发者：这是 repo 内置的本地 Web UI
- 对默认安装用户：装完即可直接使用，不再需要手工补 dashboard 产物
- 对 Native Client 用户：`hub-app/` 的 WKWebView 加载同一套 UI，通过 JS bridge 获得会话管理能力。详见 [hub-app/README.md](../hub-app/README.md)

## 本地开发

先确保本地 Hub 已经在 `localhost:9900` 跑起来。

```bash
cd hub-dashboard
bun install
bun run dev
```

Vite dev server 默认跑在 `http://localhost:5173`，并通过 `vite.config.ts` 里的 proxy 把：

- `/api/*` 转到 `http://localhost:9900`
- `/ws` 转到 `ws://localhost:9900`

## 构建

```bash
cd hub-dashboard
bun install
bun run build
```

构建后会生成：

- `hub-dashboard/dist/`

当 `hub-server` 在仓库工作区里运行时，会把这个目录作为静态前端产物托管。

## 当前数据面

Dashboard 目前主要依赖这些 Hub 端点：

- `/api/overview`
- `/api/status`
- `/api/pending`
- `/api/pending/:id/approve`
- `/api/pending/:id/deny`
- `/api/pending/:id/dismiss`
- `/api/homeland/send`
- `/api/homeland/stream`
- `/api/homeland/presence`

Hub server 同时兼容这些端点的根路径别名，方便脚本和旧调用方继续直接打 `/overview`、`/pending` 这一类路径。

## 备注

当前 Dashboard 正在从设计 handoff 形态收口到单一实现。代码里如果看到和旧 UI 方案相关的说明，请以当前挂载到 `App.tsx` 的实现为准。
