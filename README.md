# Relax AI Lab

Relax「AI 任务灵感」本地实验服务：浏览器调 prompt，与 iOS 共用 HTTP API，成熟后迁入相邻 Java 后端 `Relax-Backend`。

Python 3.12+、FastAPI、Pydantic、HTTPX、SQLite；原生 HTML/CSS/JavaScript 调试台，无前端构建依赖。不实现生产鉴权、真实订阅或积分计费。

## 启动

首次获取并启动：

```sh
git clone https://github.com/wangyiliangnet/Relax-AI-Lab.git
cd Relax-AI-Lab
uv sync --locked
./scripts/dev.sh
```

- [项目部署](http://127.0.0.1:8765/deployment)
- [Prompt 与模型参数](http://127.0.0.1:8765/prompts)
- [目标与任务模拟](http://127.0.0.1:8765/simulate)
- [历史与对比](http://127.0.0.1:8765/history)
- [Swagger](http://127.0.0.1:8765/docs)
- [健康状态](http://127.0.0.1:8765/health)

默认使用明确标记的 Mock，只用于联调。调用 DeepSeek 时，在被 Git 忽略的 `.env` 填写 `DEEPSEEK_API_KEY`，重启服务，再从调试台选择 **DeepSeek**。`.env` 不存在时从 `.env.example` 复制。密钥不发送给 iOS 或浏览器，不进入记录。

`AI_PROVIDER` 和 `DEEPSEEK_MODEL` 仅设置新数据库的初始配置；已有配置保存在 `data/lab.sqlite3`，从调试台修改。单进程运行，每次执行一个生成请求。

### 同事部署与局域网使用

在各自电脑检出本仓库后运行 `uv sync --locked`，从 `.env.example` 复制 `.env` 并配置部署电脑的 DeepSeek key。使用以下命令允许其他设备访问（macOS / Linux / Windows 均可）：

```sh
uv run python -m relax_ai_lab --host 0.0.0.0 --port 8765
```

macOS / Linux 也可以运行 `./scripts/dev.sh --host 0.0.0.0`。可在 `.env` 配置 `LAB_HOST=0.0.0.0`、`LAB_PORT=8765`，命令行参数优先；默认仍为仅本机监听。

Web 的“项目部署”页提供监听状态、网卡地址、健康检查 URL、可复制的 Xcode 配置和排查步骤。选择手机可达的 Wi-Fi / 以太网 IPv4，不使用 `0.0.0.0` 作为连接 URL。地址变化后更新 Xcode 变量并重新 Run。

手机与电脑在同一局域网；先用手机浏览器打开 `http://电脑IP:8765/health`，确认返回 `status: ok`。防火墙需允许入站 TCP 8765，Wi-Fi 不能启用客户端隔离。服务无登录认证，只用于受信局域网；所有客户端共用一个模拟账本和服务配置，密钥只保存在部署电脑。

## 调优

四个页面可直接访问和刷新。通过顶部导航切换时保留目标、Prompt 草稿和当前 AI 会话；Prompt 与模型参数在会话期间锁定。会话操作位于任务模拟页顶部，滚动时保持可见。任务卡片使用 App 的循环、日期、量化概念，目标日期策略展开为实际日期。

本次生成的参数校验、人工评价及折叠请求记录跟随当前结果。历史与对比独立成页：支持搜索、状态/来源筛选、分页列表与单条详情，并在“对比实验”中查看 A/B 结果。历史日期按该记录的目标快照解释，历史选择不会切换当前会话。

JSON 查看器支持结构树、格式化文本、语法高亮、展开/折叠及复制。模型消息中编码的 JSON 字符串可展开为结构；长文本和 Prompt 独立折叠，导出仍保留原始调用记录。完整请求预览放在 Prompt 页。

1. 填写模拟目标标题 `goal.title`、备注 `goal.note`、日期和 App 当前界面语言 `locale`。`locale` 模拟 iOS 的 `Bundle.main.preferredLocalizations.first`，不读取浏览器语言。
2. 选择/编辑业务 prompt 和模型参数。预览 initial 请求不调用模型。页面支持 GitHub Light、GitHub Dark 和跟随系统配色。
3. 打开“AI 任务灵感”会话，自动检查权益后首次生成。目标、语言、prompt 与模型参数在该会话中锁定，成功结果默认全选。
4. “换一批”清空当前建议与选择，自动使用 `generationMode=refresh` 并累计已展示标题。失败不恢复旧结果，手动重试保留该模式和排重历史。
5. 关闭会话会丢弃建议、选择和排重历史；同一目标重新打开使用 initial。已发出的调用仍可能完成并消耗用量，迟到响应不会恢复已关闭的会话。
6. “模拟添加”将所选任务放进页面内存中的模拟目标，AI 空态入口隐藏；清空模拟任务后恢复。Web 不写 Core Data，也不代替 App 的任务数量/会员保存检查。
7. 要比较另一份 prompt，关闭会话后切换/编辑版本，保持目标 ID 不变再打开。历史快照只用于查看、评价和对比，不改变当前目标和会话。不同请求上下文的比较会明确提示。

调用记录保留完整 prompt、SHA-256、参数、输入、原始输出、校验结果、耗时及 token，支持评价与 JSON 导出；关闭 Web 会话不删除后端实验记录。模型/prompt 可只用于本次 Web 会话；保存“服务共享配置”后，iOS 下次请求才采用该版本。修改过的 prompt 需先保存新版本。

教练 prompt 在 `prompts/coach-v1.md`，固定契约在 `prompts/contract.md`，Task JSON Schema 自动追加。新版本保存在 Git 忽略的 `data/prompts/`，版本名不可覆盖。结构合法不代表建议有用，质量判断仍需人工进行。

`advanced` 表示起步后的持续行动，可循环/量化，不要求更难。每组最多 5 条，允许空组；整批至少一条有效建议。

## iOS 接入

相邻 `Relax` 已增加开发入口。在 Xcode 的 **Edit Scheme → Run → Arguments → Environment Variables** 设置：

```text
RELAX_AI_BASE_URL = http://localhost:8765
```

同机模拟器使用上面的 localhost；真机或其他电脑上的模拟器应使用部署电脑的局域网地址，例如 `http://192.168.1.20:8765`。在 Xcode 的环境变量表中新增名称 `RELAX_AI_BASE_URL`，填写 URL 后重新 Run。环境变量只在通过 Xcode 启动的开发进程生效，从桌面重新启动时应重新从 Xcode Run。

使用 `Relax` scheme / `Local Debug`，进入空目标 → AI 任务灵感。生成、换批和设置页权益查询均访问本地服务；浏览器历史的 `source=ios` 用于核对。

iOS 已加入本地网络权限用途说明（三种语言）、`NSAllowsLocalNetworking` 及回环/私有 IPv4/链路本地网段的 HTTP ATS 例外，未启用全局 `NSAllowsArbitraryLoads`。iOS 17+ 支持 IP/CIDR 例外，较早系统对这些本地 IP 默认允许 ATS 访问。首次请求时允许“本地网络”；拒绝后到系统设置 → 隐私与安全性 → 本地网络中开启 App 权限。说明依据 [Apple ATS 文档](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)。

- 入口仅在 `DEBUG` / `DEMO_APP` 生效；移除变量后恢复客户端 Mock，发布配置不受影响。
- 浏览器的会员和已用积分修改需“应用配置”后生效，与 iOS 共用模拟账本。
- 成功一批扣配置的模拟积分，失败不扣模拟积分。没有自动周期重置，`resetsAt=null`、`proResetsMonthly=false`。
- DeepSeek 失败或超时仍可能实际计费，本服务不会自动重试。
- 模拟 Pro 不改变真实 StoreKit 状态；保存仍执行现有会员和任务数量限制。
- 默认只监听回环地址；真机局域网接入按本页部署步骤启用 IPv4 LAN 监听。Release 仍不启用 AI 功能入口。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /v1/ai/entitlement` | 模拟权益与积分 |
| `POST /v1/ai/task-inspirations` | iOS 上下文 → `{goalID, plans}` |
| `GET/PUT /lab/profile` | 当前配置与模拟账本 |
| `GET /lab/connection` | 实际启动配置与局域网 IPv4 候选地址 |
| `GET/POST /lab/prompts` | 读取/创建不可覆盖的版本 |
| `POST /lab/preview` | 预览请求，不消耗 token |
| `GET/POST /lab/runs` | 历史/浏览器实验 |
| `GET /lab/runs/{id}` | 完整记录 |
| `PATCH /lab/runs/{id}/feedback` | 人工评价 |
| `GET /contracts/request`、`GET /contracts/response` | JSON Schema |

```sh
curl --fail http://127.0.0.1:8765/v1/ai/entitlement
curl --fail-with-body http://127.0.0.1:8765/v1/ai/task-inspirations \
  -H 'Content-Type: application/json' --data-binary @examples/request.json
```

响应头 `X-Lab-Run-ID` 对应调用记录。402 为模拟积分不足；409 忙碌；422 输入/配置非法；502 上游或输出失败；503 未配置 key；504 超时。错误体为 `error` 对象，含 `code/message/runID?/entitlement?`；FastAPI 输入验证的 422 使用标准 `detail` 结构。

服务回填 `goalID`、重新计算 `remainingDays`，按 iOS 规则逐条校验日期/循环/量化/Pro，移除无效、重复及超过数量上限的建议。不静默修复参数或降级 Pro 配置；全部无效时保留原始输出并返回失败。

## 检查

```sh
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv run python -m scripts.export_contracts
node --input-type=module --check < static/app.js
node --test tests/web-formatters.test.mjs
git diff --check
```

自动测试使用临时数据和替代 HTTP transport，不调用真实模型。实际验证范围见 [验证记录](docs/validation.md)。

## 参考与决策

- [设计决策](docs/design.md)、[迁入正式后端](docs/migration.md)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- iOS 契约：相邻 `Relax/RelaxCore/Features/Goal/TaskInspiration/`
