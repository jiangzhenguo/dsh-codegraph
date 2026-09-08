# dsh-codegraph

让 DSH 会话直接使用 [CodeGraph](https://github.com/colbymchenry/codegraph)
（`@colbymchenry/codegraph`）的预索引代码知识图谱能力。

这是一个**可一键安装的 DSH 插件**（bundle）：它把 `codegraph` CLI 包装成
**模型可见的原生工具**，模型在分析代码时无需 grep/读大量文件，直接按符号、
按区域、按调用链查询索引，并能自举并维护索引（`init`/`index`/`sync`）。

> **工具面（surface）**：借鉴上游项目「`codegraph_explore` 是唯一稳定赢得模型调用的工具」
> 的实测结论（其官方 MCP server 默认只暴露 explore），本插件**默认只注册 4 个核心工具**
> （`codegraph_status` / `codegraph_init` / `codegraph_sync` / `codegraph_explore`），
> 保持模型工具列表精简、引导集中。需要全部 13 个工具时，在组合层配置
> `surface: 'full'`（见下文「配置」）。

## 提供的工具

| 工具 | 对应 CLI | 用途 |
|---|---|---|
| `codegraph_status` | `status --json` | 索引状态（是否已初始化、版本、文件/节点/边数、待同步变更、建议重建等） |
| `codegraph_init` | `init` | 初始化项目并建立初始索引（`.codegraph/`） |
| `codegraph_index` | `index` | 全量（重）索引；`status` 建议 reindex 时用 |
| `codegraph_sync` | `sync` | 增量同步索引（改代码后调用，让查询反映新代码） |
| `codegraph_uninit` | `uninit -f` | 删除项目索引 |
| `codegraph_query` | `query --json` | 按名称/子串搜索符号，返回结构化 JSON |
| `codegraph_node` | `node` | 单个符号源码 + 调用/被调用轨迹，或带行号读文件 + 依赖 |
| `codegraph_explore` | `explore` | 自然语言探索一块代码区域，直接返回相关文件源码与调用路径 |
| `codegraph_files` | `files --json` | 索引内的项目文件结构 |
| `codegraph_callers` | `callers --json` | 谁调用了某个符号 |
| `codegraph_callees` | `callees --json` | 某个符号调用了什么 |
| `codegraph_impact` | `impact --json` | 改动某个符号会波及哪些代码（重构/改名前用） |
| `codegraph_affected` | `affected --json` | 改动若干源文件后应运行哪些测试文件 |

工具名与 CodeGraph 官方 MCP 工具同名，模型的使用心智与官方文档一致。

## 前置要求

1. 已安装 [DSH](https://github.com/deepseek-ai/deepseek-harness)（本插件为 DSH bundle，随
   DSH web 应用装载）。
2. 已安装 `codegraph` CLI 且其可执行文件在 `PATH` 上（插件在运行时按名字 `codegraph`
   解析可执行文件）：

   ```bash
   npm i -g @colbymchenry/codegraph     # 或按官方 install.sh / npm thin shim 安装
   codegraph --version                  # 确认可用（≥ 1.0）
   ```

## 一键安装

在 DSH 应用的 web profile 中安装（一条命令，无需手动改任何配置文件）：

```bash
dsh plugin --profile web add github:jiangzhenguo/dsh-codegraph
```

做了什么：

- `dsh plugin` 会在 profile 目录里跑 `pnpm add github:jiangzhenguo/dsh-codegraph`；
- 因为本包的 `package.json` 声明了 `dsh.bundle.patch`，DSH 的 plugin 管理器会把它自动
  加入 profile 的 `dsh.profile.bundles` 层栈（`cordis.patch.yml` 里那一条 `insert` 就是它的
  组合层，不需要你手动加）；
- 重启 DSH 应用后，任意会话里模型即可看到 `codegraph_*` 工具（默认 core 面 4 个）。

> 其他 profile：把 `--profile web` 换成 `--profile tui` 等即可。

### 从 npm 安装（备选）

本包同样可按常规 npm 包发布/安装；若已发布到 npm，用包名替换上面开头的 `github:` 即可。

### 卸载

```bash
dsh plugin --profile web remove dsh-codegraph
```

## 一装上就会优先调用 codegraph 搜代码

插件不只是一个「把工具放出来」的包，它还会**在系统提示词里注入一条高优先级指引**
（`tool:codegraph`，`order: 98`），让模型在搜索/探索代码时**优先用 `codegraph_*` 而不是
grep / glob / read**：

- DSH 内置文件工具的指引集中在 `order 100–104`（`read`=100、`write`=101、`edit`=102、
  `glob`=103、`grep`=104）。本插件的指引放在 **98**，落在它们之前，因此模型先看到
  “优先用 codegraph_* 搜代码”。
- 指引措辞采用上游官方 MCP server instructions 的同款策略（软性 "Prefer" 会被模型忽略，
  实测会退回 grep/bash 反射路径）：**命令式**（MUST use `codegraph_explore` INSTEAD of
  grep/glob/read）+ **反模式清单**（不要先 grep「找文件」、不要用 grep 复核 codegraph
  结果——它来自完整 AST 解析）+ **未索引项目的硬停止规则**（不自行初始化时，本会话
  不再调用 codegraph 工具，索引与否是用户的决定）。
- 指引只点名 core surface 的 4 个工具：`codegraph_status` 确认索引 → 未初始化则
  `codegraph_init` → 之后用 `codegraph_explore` 一次拿到相关符号的逐行源码 + 调用链，
  改完代码用 `codegraph_sync`。

也就是说：**装上即生效，无需每个会话单独配置**——其他会话也一样会优先走 codegraph
来完成代码搜索。

## 结构化 prompt 自动前置注入（frontload，默认关闭）

提示词指引仍是「软性」的——模型可能忽略它（上游实测如此）。因此本插件实现了上游
`UserPromptSubmit` prompt-hook 的 DSH 等价物，也是上游验证过最有效的采用率手段：

- **默认关闭**（`frontload: false`）：注入的 `<codegraph_context>` 以密集原文形式
  驻留上下文窗口直至会话结束（上游残留上下文实测约 +82% token 残留），因此只在
  明确需要时开启——可在组合层配置或直接在 DSH 设置界面打开。
- 插件监听 `agent/inbox/inserted` 事件；当一条**真实用户 prompt** 进入 agent 的
  next-turn 收件箱时，按置信度分级门控：
  - **高置信**：prompt 含结构性关键词（中/英：「调用 / 流程 / 原理 / 重构 / 影响 /
    依赖 / how does / who calls / refactor / trace …」）→ 直接触发；
  - **中置信**：prompt 含代码形态 token（文件名 / camelCase / PascalCase / snake_case）
    → 先用 `codegraph query` 对照索引验证 token 是真实符号才触发；
  - 其余 prompt（如「fix this typo」）零开销静默跳过。
- 触发后在会话 cwd 向上找最近的 `.codegraph/` 索引根（找不到 = 未索引 = 静默跳过，
  **是否索引是用户的决定，插件不擅自 init**），预跑 `codegraph_explore`，把结果以
  `<codegraph_context>` 包裹 steer 进当前 turn（上限 12000 字符）。
- 于是「模型反射性 grep/read 要找的东西已经在上下文里了」——context 先于工具调用到达。
- **绝不弄坏用户 prompt**：所有失败路径（无索引、门控未命中、CLI 报错）都是静默 no-op；
  注入内容带标记，不会触发自身循环（steer 落在 next-step 边界，监听器只看 next-turn）。
- **去重**：同文 prompt 在 10 分钟内重复进入收件箱（GUI 重发排队消息、step 被拒后重新
  入队——每次消息 id 都是新的）只会注入一次，避免重复上下文。

## DSH 设置界面可配置（无需重启）

插件把三项配置注册为 **`dsh-codegraph` 用户设置命名空间**（DSH 设置 → 插件 →
「可配置插件」里的 CodeGraph 卡片），解析层级为 **用户设置 > 组合层配置 > schema 默认值**：

| 设置项 | 默认 | 说明 |
|---|---|---|
| `guideSearch` | `true` | 系统提示词里的 codegraph 优先指引 |
| `frontload` | `false` | 结构化 prompt 自动前置注入 `<codegraph_context>` |
| `surface` | `core` | 工具面：`core` 4 个 / `full` 13 个 |

设置变更**即时生效**：插件拆掉旧的提示词 section、工具面与 frontload 监听器后按新值
重挂，不需要重启 DSH。浏览器半（`client/client.js`）负责渲染该设置卡片；宿主半通过
`ctx.settings.installSection` 注册命名空间（`@deepseek-ai/dsh-settings` 0.1.2-rc.1 起，
命名空间 id 就是普通的小写连字符字符串，注册入口从独立的 `installSettingsSection` 
辅助函数改为 `settings` 服务上的方法）。

## 配置（组合层）

在组合层（如 `cordis.patch.yml` 的 insert 行）可为插件传配置（作为用户设置的 base 层）：

```yaml
- insert:
    - id: dsh-codegraph
      name: dsh-codegraph
      require: dsh-codegraph
      config:
        guideSearch: true    # 默认 true：注入上述系统提示指引；false 只注册工具
        surface: core        # 默认 core：只注册 status/init/sync/explore 共 4 个工具；
                             # 设为 full 注册全部 13 个
        frontload: false     # 默认 false：结构化 prompt 自动前置注入；true 开启
```

## 使用流程

1. 在项目目录开一个新的 DSH 会话（cwd = 项目根）。
2. 让模型先跑 `codegraph_status`：未初始化 → 跑 `codegraph_init`。
3. 之后用 `codegraph_explore` 查代码（一次调用返回相关符号源码 + 调用链）；
   `surface: 'full'` 下还可用 `codegraph_query` / `codegraph_node` /
   `codegraph_callers` / `codegraph_callees` / `codegraph_impact` 做更细的查询。
4. 改动代码后用 `codegraph_sync`，需要跑测试时用 `codegraph_affected`（full）。

所有工具默认作用于调用方会话的 cwd；也可显式传 `path` 指向其他项目。

## 为什么会话级 MCP server 不理想（本插件为何存在）

codegraph 的官方 MCP server 在工作区**未建立索引时暴露 0 个工具**（并提示模型
“不要自己索引”）。本插件始终暴露工具——包括模型自举和维护索引所需的
`init`/`index`/`sync`——因此是比 MCP 更顺手的集成方式。

## 测试

`test/run-plugin-test.mjs` 是一个自带 codegraph CLI 桩 + 桩 cordis 服务的运行时测试
harness（keyless，不依赖真实 CLI 进程——DSH 会话沙箱拒绝子进程 spawn）：加载本插件的
`lib/index.js`，挂载 `tools`/`subprocess`/`shell` 服务桩，`apply()` 后逐一调用工具的
真实 `execute`。在装好插件的 profile 里或本 checkout 直接运行：

```bash
node test/run-plugin-test.mjs            # 本 checkout
CG_PROFILE_NM=<profile>/node_modules node test/run-plugin-test.mjs
```

覆盖：mount 不抛错、**默认 frontload 关闭（无 inbox 监听器）**、**`tool:codegraph` 提示词
注入（order 98 < 100，先于 grep/glob/read）**、**默认 core surface 只注册
status/init/sync/explore 共 4 个工具**、`surface: 'full'` 下 13 个工具全部注册并逐一真实
执行（`status`→`init`→`query`→`node`→`files` 主流程、`sync`/`impact`/`affected`）、
**frontload 显式开启后的前置注入**（结构性 prompt 注入 `<codegraph_context>`、同文重发
去重、非结构性/未索引/自循环/rpc 来源静默跳过、`frontload:false` 不注册监听器）、
**无执行器服务时 apply 不抛错**（惰性解析，启动顺序安全）、**无设置服务时 apply 不抛错**
（optional-settings 契约，entry 配置独立生效）、显式 `path` 覆盖、以及「无 cwd 且无 path
时报错」的错误路径。

> 说明：`callers`/`callees` 在本机 `codegraph@1.0.1` 上返回空数组是 **CLI 侧数据/索引特性**
> （该版本的调用图边未解析到），与插件无关——插件忠实返回 CLI 的真实输出；`impact` 已能
> 返回真实的受影响节点与边。

## 仓库结构

```
├── package.json        # DSH bundle 声明（dsh.bundle.patch + dsh.client）+ peerDependencies
├── cordis.patch.yml    # 组合层 patch（把本插件的 node half 插入 host 组合）
├── lib/index.js        # 插件实现：注册 codegraph_* 工具（core 4 个 / full 13 个）+ 用户设置命名空间
├── client/client.js    # 浏览器半：设置页「插件 → 可配置插件」里的 CodeGraph 卡片
├── test/               # 运行时测试 harness（自带 CLI 桩，keyless 可跑）
└── plugin-host.js      # （旧）会话级 host-only 动态版，仅作参考
```

## 许可

MIT
