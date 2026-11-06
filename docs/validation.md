# 验证记录

日期：2026-11-06。

## 已通过

- `uv run pytest -q`：36 项通过。覆盖任务日期/循环/量化、部分/全部无效、排重与数量、模拟积分、prompt 配置、预览、评价、并发、上游失败、LAN 配置，以及四个子页面直达和根路径跳转。
- Ruff、Python 编译、JavaScript 语法、JSON Schema 导出与 `git diff --check`。
- 使用系统 Chrome 的独立 headless 会话验证加载、4 条 Mock 卡片、版本保存、应用配置、请求预览、人工评价、排重换批、缺失 key 的失败展示和历史并排对比；390px 窄屏无横向溢出，无 JavaScript 页面错误。
- 实际 `LocalAITaskInspirationService` 与 Core 契约/校验通过 Swift 类型检查和 SwiftLint；工程 plist 通过。
- Xcode 26.6，`Relax` / `Local Debug` / arm64 iOS Simulator 构建成功；日志 `/tmp/relax-ai-lab-ios-build.log`。项目有既有告警，新增网络适配器无编译告警。
- 将实际 Swift 网络适配器编译为临时 macOS 检查程序并连接 `http://localhost:8765`：权益获取、生成 4 条、UUID 回填、现有任务校验、用量增加均通过。这是实际 HTTP 请求，不是替代网络实现。
- 实际 HTTP 402 已通过 Swift 适配器映射为带权益的 `insufficientCredits`；检查后恢复本地 Mock 配置和 0 用量。未授权的 DeepSeek `/models` 连通检查返回预期的 401，未调用模型。

iOS 仓库运行的 SwiftLint 命令如下，结果为 0 问题：

```sh
swiftlint lint --config .swiftlint.yml --no-cache --force-exclude \
  Relax/Services/API/TaskInspiration/LocalAITaskInspirationService.swift \
  'Relax/Features/Goal/Goal Detail/Task Inspiration/AITaskInspirationEnvironment.swift' --quiet
```

测试有一条第三方 Starlette TestClient 的 HTTPX 弃用提醒，不影响结果。自动测试使用临时数据与替代 HTTP transport，未消耗模型额度。

## 尚未验证

- 用户已配置 API key，已通过鉴权的 `/models` 连通检查（HTTP 200）。本轮布局验证未发起真实生成；默认 prompt 的建议质量仍需按目标样本人工评估。
- 本轮未在 App 页面完成端到端点击验证。原生界面工具连续超时，安装时模拟器已处于 Shutdown；独立 Swift HTTP 检查不等同于 App UI 验证。
- 真机局域网、真实购买、生产鉴权/积分/计费不在本地实验实现范围。

配置 key 后，保持输入、模型参数和权益一致，对比两个 prompt；优先评估领域相关性、具体行动对象、起步门槛、执行节奏、时间/量化一致性和语义排重，不只看 JSON 能否解析或任务数量。

## Web 流程与局域网支持更新

- 使用隔离数据库在 `0.0.0.0:8766` 启动验证服务，并从本机实际局域网 IPv4 URL 访问。Chrome 报告 `isSecureContext=false`、`crypto.randomUUID` 不存在，页面通过 `getRandomValues` 生成 UUID 并正常工作。
- 浏览器验证：打开自动生成、默认全选/零选择禁用、换批、失败后重试、关闭/重开、模拟添加与空态恢复、生成中关闭后忽略迟到响应、历史查看不改变会话，以及关闭后切换 prompt。记录的 generationMode / 排重数依次为 `initial/0 → refresh/4 → refresh/8（失败）→ refresh/8（重试）`；重开恢复 `initial/0`。
- GitHub Light / Dark 实际渲染检查完成；390px 窄屏无横向溢出，浏览器无页面异常。样例与检查记录仅写入隔离临时目录，未修改日常服务账本。
- 实际 Swift 网络适配器通过本机局域网 IPv4 URL 完成权益查询、生成 4 条、解码及任务校验，并读取用量增量。
- iOS 模拟器再次构建成功，日志 `/tmp/relax-ai-lab-lan-build.log`。读取构建产物确认 ATS 回环/私有 IPv4/链路本地 CIDR 例外、NSAllowsLocalNetworking 和三种语言的权限用途说明均已打包，未启用 NSAllowsArbitraryLoads。
- 日常服务以 `./scripts/dev.sh --host 0.0.0.0` 重启在 8765；Web 的连接帮助显示实际监听配置与可复制的 iOS 环境变量。

尚未使用实体 iPhone 完成跨设备联调；手机权限、防火墙和 Wi-Fi 隔离仍需按 Web 中的健康检查步骤在部署现场确认。当前测试证明本机通过真实 LAN URL 的协议与浏览器支持，不将其等同于真机验证。

## 三个子页面与布局调整

- `/deployment`、`/prompts`、`/simulate` 均可直接访问及刷新；根路径转到任务模拟页。
- 浏览器验证通过：页面导航、前进后退、Prompt 草稿及模型参数保留、会话中配置锁定、生成时切换页面后接收结果，以及关闭后忽略迟到响应。
- 复验了首次生成、零选择禁用、换批排重、失败重试、历史查看与当前会话隔离、模拟添加、清空任务恢复入口、版本保存和共享配置保存。
- 请求预览保留在 Prompt 页，不跳转或创建生成记录。实时会话与折叠调试区分开，任务按起步/持续推进分组展示。
- 桌面、390px 窄屏和 GitHub Light / Dark 实际渲染检查通过，三个页面均无横向溢出，未发现 JavaScript 页面错误。全部生成检查使用隔离数据库和 Mock，未调用真实模型。

## 会话操作、任务参数和历史层级调整

- 会话操作上移到模拟页的吸顶操作栏；任务参数对齐 iOS 的循环名称、日期类型、量化计算和重置周期，历史日期使用记录自己的目标快照。量化次要参数在历史卡片中折叠保留。
- 当前结果下展示指标、参数校验和人工评价，请求/响应折叠。独立 `/history` 支持搜索、状态/来源筛选、每页 8 条摘要、单条详情与单独 A/B 对比视图。
- 36 项 Python 测试、7 项 Node 格式化测试通过，覆盖四个路径、历史摘要和任务/日期/JSON 表示；Ruff 和前端语法检查通过。
- Chrome 在实际 LAN HTTP 地址及隔离数据库验证四页直达/刷新、前进后退、草稿保留、会话锁定、默认选择、换批/失败/重试、模拟添加、跨页等待与关闭后忽略迟到响应。
- 验证历史分页/搜索、当前与历史评价分离、历史目标日期解析、A/B 对比与同记录禁用；JSON 树展开/折叠、格式化文本、高亮及 HTML 字符按文字展示。
- 检查桌面和 390px 窄屏的 GitHub Light/Dark，四页无横向溢出，无 JavaScript 页面错误。所有本轮生成和历史样本只写入 `/tmp` 隔离数据库，未消耗 DeepSeek 额度或修改日常账本。

- 补充验证：历史未保存评价在导航后保留，显式刷新能读取外部评价更新；状态/来源筛选、390px A/B 对比及展开的 JSON、LAN HTTP 复制均通过。模拟添加后的日期使用添加时的目标快照，后续编辑目标日期不会改变已添加条目。
- 日常服务已在 `0.0.0.0:8765` 启动，健康状态为 `ok`、`apiKeyConfigured=true`；四个页面加载通过。保留原有服务共享配置和模拟账本，未发起日常服务生成请求。
