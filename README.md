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

- [实验台 · 快速模拟](http://127.0.0.1:8765/simulate)
- [实验台 · 固定用例](http://127.0.0.1:8765/cases)
- [Prompt 版本](http://127.0.0.1:8765/prompts)
- [记录与对比](http://127.0.0.1:8765/history)
- [开支](http://127.0.0.1:8765/costs)
- [连接与环境](http://127.0.0.1:8765/deployment)
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

Web 的“连接与环境”页提供监听状态、网卡地址、健康检查 URL、可复制的 Xcode 配置和排查步骤。选择手机可达的 Wi-Fi / 以太网 IPv4，不使用 `0.0.0.0` 作为连接 URL。地址变化后更新 Xcode 变量并重新 Run。

手机与电脑在同一局域网；先用手机浏览器打开 `http://电脑IP:8765/health`，确认返回 `status: ok`。防火墙需允许入站 TCP 8765，Wi-Fi 不能启用客户端隔离。服务无登录认证，只用于受信局域网；所有客户端共用一个模拟账本和服务配置，密钥只保存在部署电脑。

## 调优

六个页面可直接访问和刷新。桌面侧栏将快速模拟、固定用例归入实验台，窄屏使用可换行导航。统一使用浅色界面。站内导航保留目标、Prompt 草稿、当前 AI 会话及用例评测状态；Prompt 与模型参数在会话或评测运行期间锁定。会话操作位于快速模拟页顶部，滚动时保持可见。任务卡片使用 App 的循环、日期、量化概念，目标日期策略展开为实际日期。

配置摘要区分当前试验配置、未保存草稿与服务共享配置。保存新版本只创建 Prompt 版本；在 Prompt 页“应用生成配置到共享服务”后，后续 iOS 请求才使用该配置。“连接与环境”页单独应用模拟权益。两类应用均通过 PATCH /lab/profile 只提交本次修改的字段；服务保留未提交的配置和权益。原 GET/PUT 接口继续兼容，按本次范围不实现修订号或并发冲突检测。

本标签页的目标输入、按版本的 Prompt 草稿、用例选择与筛选、历史浏览位置及未保存评价通过 sessionStorage 恢复。刷新不恢复 AI 会话、排重集合或已模拟添加任务；评测批次按保存的 ID 从服务归档恢复，不自动续跑，也不会重新发出模型调用。读取共享配置不会替换当前草稿；显式替换后可恢复原版本草稿。活动条区分本浏览器会话、已发送请求和服务忙碌，生成中关闭会话仍可查看请求活动。

模拟、固定用例、历史和 A/B 共用结果详情，提供运行概览、任务建议、自动检查、人工评价及折叠原始记录。评价草稿按调用 ID 跨页面保留，保存期间的新编辑不会被旧提交覆盖。结果可直接设为 A/B，或明确复制目标、语言与生成配置为新试验；复制不带入旧会话排重，草稿的固定契约已变化时须手动核对。历史使用服务端全量检索与分页，每页 8 条，支持来源、状态、调用方式、用例及批次筛选；开支同样覆盖全部记录。无分页参数的旧历史接口仍返回最近 100 条数组。历史查看不会切换当前会话。

JSON 查看器支持结构树、格式化文本、语法高亮、展开/折叠及复制。模型消息中编码的 JSON 字符串可展开为结构；长文本和 Prompt 独立折叠，导出仍保留原始调用记录。完整请求预览放在 Prompt 页。

1. 填写模拟目标标题 `goal.title`、备注 `goal.note`、日期和 App 当前界面语言 `locale`。`locale` 模拟 iOS 的 `Bundle.main.preferredLocalizations.first`，不读取浏览器语言。
2. 选择/编辑业务 prompt 和模型参数。预览 initial 请求不调用模型，并显示目标、日期与 App 语言上下文。
3. 打开“AI 任务灵感”会话，自动检查权益后首次生成。目标、语言、prompt 与模型参数在该会话中锁定，成功结果默认全选。
4. “换一批”清空当前建议与选择，自动使用 `generationMode=refresh` 并累计已展示标题。失败不恢复旧结果，手动重试保留该模式和排重历史。
5. 关闭会话会丢弃建议、选择和排重历史；同一目标重新打开使用 initial。已发出的调用仍可能完成并消耗用量，迟到响应不会恢复已关闭的会话。
6. “模拟添加”将所选任务放进页面内存中的模拟目标，AI 空态入口隐藏；清空模拟任务后恢复。Web 不写 Core Data，也不代替 App 的任务数量/会员保存检查。
7. 要比较另一份 prompt，关闭会话后切换/编辑版本，保持目标 ID 不变再打开。历史快照只用于查看、评价和对比，不改变当前目标和会话。不同请求上下文的比较会明确提示。

调用记录保留完整 prompt、SHA-256、参数、输入、原始输出、校验结果、耗时及 token，支持评价与 JSON 导出；关闭 Web 会话不删除后端实验记录。模型/prompt 可只用于本次 Web 试验；“应用生成配置到共享服务”后，iOS 下次请求才采用该版本。修改过的 prompt 需先保存新版本。

教练 prompt 在 `prompts/coach-v1.md`，固定契约在 `prompts/contract.md`，Task JSON Schema 自动追加。新版本保存在 Git 忽略的 `data/prompts/`，版本名不可覆盖。结构合法不代表建议有用，质量判断仍需人工进行。

`advanced` 表示起步后的持续行动，可循环/量化，不要求更难。每组最多 5 条，允许空组；整批至少一条有效建议。

## 固定用例与版本比较

用例保留业务输入、模拟会员身份、自动断言和人工检查项。主集有 54 条，历史留出组有 10 条。历史留出组曾用于调优，统计时保留原分组。用例清单在 [examples/task-inspirations](examples/task-inspirations)。编辑用例后重启服务以加载新清单。

**人工验证**　在「Prompt 版本」选择版本或编辑草稿，点击「用固定用例评测」进入「固定用例」页。按关键词或主集 / 历史留出组筛选，勾选多条或全选筛选结果；切换筛选保留已选用例，并显示隐藏的选择数量。点击名称可预览固定输入、权益、断言和人工检查项。真实调用前显示预计最多调用数，不虚构 token 金额预算。

点击「运行所选用例」（Mock 时为「运行 Mock 联调」）后，先创建服务归档，固定完整 Prompt（含契约及 Schema）、输入、权益、断言、人工检查项及判定规则指纹，再按固定顺序逐条运行，顶部显示进度，并分别统计断言通过、断言失败、Mock、预期输入拒绝、执行错误和未执行。断言失败继续执行；上游或连接错误停止后续用例，不自动重试。「停止后续用例」会等待当前请求完成并保留结果，已发送的真实调用仍可能计费。页面导航不打断批次；刷新或关闭页面会停止后续提交，已发出的请求仍可能完成。刷新读取归档，保留已完成结果，并将剩余用例列为未执行，不自动补跑。关闭时停止通知可能因断网未送达，归档可显示等待客户端；打开归档后可手动停止，服务重启时也会核对记录并标为中断。

运行后可按断言失败、执行错误、未执行或待人工评价筛选结果；点击用例阅读建议、保存人工评价、查看原始记录，或进入「记录与对比」做版本对比。本批结果可导出 JSON，包含固定配置、用例快照、判定和调用 ID。再次运行创建新批次，旧批次与调用均保留。可填写批次名称，从“评测批次归档”分页打开、导出或设为批次 A/B；归档使用当时的用例快照，返回当前用例库后准备新批次。目标模拟会话与用例评测互斥运行；自行填写目标仍走「快速模拟」中的「打开 AI 任务灵感」流程。

**批次对比**　在“记录与对比 → 批次对比”选择两个归档，或在归档列表分别设为批次 A/B。按 caseID 配对后核对输入、断言、权益及判定规则指纹；口径变化、仅 A、仅 B、未执行、执行错误、Mock 和预期输入拒绝单列。只有口径一致且双方均完成的真实 passed / failed 断言进入共同样本，显示新增失败、已修复、仍失败和共同通过。逐条展开才读取两次完整记录，支持人工评价、查看参数和对比导出。

每批每个用例只执行一次；同一条目重复提交会返回原判定，不重新调用模型。重跑创建新批次，不把多次采样混成一个结果。汇总费用、token 与耗时基于实际记录，未知项单列；即使某侧多选了用例，也不把缺失项当成失败。批次执行仍由浏览器逐条提交，服务负责快照、原子条目领取和结果持久化，没有脱离页面的后台续跑器。

**Agent 调用**　启动 Lab 后在仓库根目录运行以下命令。`--list` 输出用例 JSON；`--case`、`--version` 均可重复。省略 `--case` 时执行所选组的全部用例，省略 `--suite` 时使用两组。CLI 固定本批次启动时的模型和采样参数。

```sh
uv run python -m scripts.evaluate_cases --list --suite main
uv run python -m scripts.evaluate_cases --case free-monthend --version coach-v1

# 先在 Lab 保存 candidate 版本。每个有效用例、每个版本各调用一次 DeepSeek。
uv run python -m scripts.evaluate_cases --case free-monthend --case weekends \
  --version coach-v1 --version candidate --provider deepseek > data/comparison.json
```

程序也可以用 `GET /lab/cases` 取清单，再调用 `POST /lab/cases/{id}/run`。请求体含 `options` 和可选草稿 `promptText`，与人工入口共用执行器。每条用例使用自身的模拟权益；真实调用的费用进入 Lab 的开支统计。

```json
{"options":{"provider":"deepseek","promptVersion":"coach-v1"}}
```

CLI 将各版本的结果按用例并排输出为 JSON。每条包含 `verdict`、`issues`、`runID`；有调用记录时可用 `GET /lab/runs/{runID}` 取实际消息、原始输出、过滤原因和 token。自动评分会检查两组输出、被过滤的条目、任务参数，以及用例要求的分组、日期或循环命中。每日总负担、同义重复和语言自然度按 `review` 单独判断。

- `passed` / `failed` 表示真实模型的自动断言结果。用例要求双空组时，模型可以通过，同时服务会报告 `no_valid_tasks`。
- `mock` 表示仅使用固定模拟输出。三个日期非法的用例预期得到 `expected_input_rejection`，在发送模型请求前结束。这两类都单独计数。
- CLI 退出码 0 表示所选检查完成，1 表示出现断言或输入预期失败，2 表示配置或执行错误。遇到上游或连接错误时输出已完成部分并停止。每个版本都有独立调用，结果可能有采样波动。

## AI 开支

打开 [AI 开支](http://127.0.0.1:8765/costs)，按模型配置当前适用的人民币单价：缓存命中输入、缓存未命中输入和输出，单位均为元 / 百万 tokens。单价可填字符串小数，服务使用 Decimal 计算并以字符串返回金额。配置及费用记录保存在被 Git 忽略的 `data/lab.sqlite3`。

内置 **DeepSeek 高峰期、DeepSeek 空闲时段、全时段** 三种单价版本。根据 [DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 于 2026-11-07 核对并内置以下人民币单价（元 / 百万 tokens）：

| 模型 | 时段 | 输入缓存命中 | 输入缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-flash | 高峰 | 0.04 | 2 | 8 |
| deepseek-flash | 空闲 | 0.02 | 1 | 4 |
| deepseek-v4-pro | 高峰 | 0.30 | 9 | 27 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |

按调用开始时间转换到北京时间：周一至周五（中国法定节假日除外）09:00–12:00、14:00–18:00 为高峰，其余为空闲，周末补班仍为空闲。`chinese-calendar` 锁定版本提供 2004–2027 年日历；缺少对应年份日历的工作日高峰窗口不推测价格，需升级日历或配置全时段单价。全时段为每天 00:00–24:00 的自定义固定价格，不预填不存在的 DeepSeek 全时段报价。优先级为自定义时段 > 自定义全时段 > 内置时段。官方调价后需更新价格。

- 每次调用固定当时的模型、时段、单价快照及版本标签；后续调价不改变旧记录。价格绑定部署服务的上游地址，修改 `DEEPSEEK_BASE_URL` 后需重新保存单价。
- 已配置的内置及自定义价格均可删除，按模型、时段和上游地址定位；刷新或重启后保持删除，也不会回退到同一条内置价格。删除仅影响新调用，历史价格快照及费用保留；新调用使用剩余匹配价格，无匹配价格时为未知。重新填写并保存相同模型和时段可重新启用。
- 汇总覆盖全部记录，按 provider、prompt 版本、模型及 prompt 指纹分组；草稿单独标记。显示调用数、输入/输出 token 和已知估算费用。
- 有用量且可计算的失败调用也计费，与模拟积分是否扣除无关。Mock 和明确未发出的请求为零；超时、用量缺失/非法、没有配置价格或无价格快照的历史调用为未知，不作为零元计入已知费用。
- 缓存用量需要能从上游返回中确定；若命中/未命中均缺失且两者单价不同，费用标为未知。金额是 token 费用估算，最终扣费以 Provider 账单为准。

当前结果、历史详情和 A/B 对比显示单次费用；请求记录可展开查看价格快照，JSON 导出包含相同字段。本次内置价格版本在服务启动时一次性应用到已有官方 DeepSeek Flash / Pro 调用，按记录时间选择高峰/空闲并重新估算；`costRevisions` 保留原价格和原费用，`pricing.appliedToHistory` 明确标记历史回填。旧版未区分时段的 Flash 手工单价由内置时段价格接替。其他上游地址、模型及无法确定时间/用量的记录不会凭空产生金额。

## iOS 接入

相邻 `Relax` 已增加开发入口。在 Xcode 的 **Edit Scheme → Run → Arguments → Environment Variables** 设置：

```text
RELAX_AI_BASE_URL = http://localhost:8765
```

同机模拟器使用上面的 localhost；真机或其他电脑上的模拟器应使用部署电脑的局域网地址，例如 `http://192.168.1.20:8765`。在 Xcode 的环境变量表中新增名称 `RELAX_AI_BASE_URL`，填写 URL 后重新 Run。环境变量只在通过 Xcode 启动的开发进程生效，从桌面重新启动时应重新从 Xcode Run。

使用 `Relax` scheme / `Local Debug`，进入空目标 → AI 任务灵感。生成、换批和设置页权益查询均访问本地服务；浏览器历史的 `source=ios` 用于核对。

iOS 已加入本地网络权限用途说明（三种语言）、`NSAllowsLocalNetworking` 及回环/私有 IPv4/链路本地网段的 HTTP ATS 例外，未启用全局 `NSAllowsArbitraryLoads`。iOS 17+ 支持 IP/CIDR 例外，较早系统对这些本地 IP 默认允许 ATS 访问。首次请求时允许“本地网络”；拒绝后到系统设置 → 隐私与安全性 → 本地网络中开启 App 权限。说明依据 [Apple ATS 文档](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)。

- 入口仅在 `DEBUG` / `DEMO_APP` 生效；移除变量后恢复客户端 Mock，发布配置不受影响。
- “连接与环境”中的会员和已用积分修改需“应用模拟权益”后生效，与 iOS 共用模拟账本。
- 成功一批扣配置的模拟积分，失败不扣模拟积分。没有自动周期重置，`resetsAt=null`、`proResetsMonthly=false`。
- DeepSeek 失败或超时仍可能实际计费，本服务不会自动重试。
- 模拟 Pro 不改变真实 StoreKit 状态；保存仍执行现有会员和任务数量限制。
- 默认只监听回环地址；真机局域网接入按本页部署步骤启用 IPv4 LAN 监听。Release 仍不启用 AI 功能入口。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /v1/ai/entitlement` | 模拟权益与积分 |
| `POST /v1/ai/task-inspirations` | iOS 上下文 → `{goalID, plans}` |
| `GET/PUT /lab/profile` | 当前配置与模拟账本，保留原完整读写方式 |
| `PATCH /lab/profile` | 只更新指定字段；options 支持嵌套局部更新，返回完整 Profile |
| `GET /lab/connection` | 实际启动配置与局域网 IPv4 候选地址 |
| `GET/POST /lab/prompts` | 读取/创建不可覆盖的版本 |
| `POST /lab/preview` | 预览请求，不消耗 token |
| `GET/POST /lab/runs` | 历史/浏览器实验；GET 带 page 时返回全量分页对象，无 page 保留旧数组 |
| `GET/POST /lab/batches` | 分页查询归档 / 创建固定配置与用例快照的批次 |
| `GET /lab/batches/{id}` | 批次完整快照、状态与判定 |
| `POST /lab/batches/{id}/items/{caseID}/run` | 按批次顺序执行一条；重复提交不重复调用 |
| `POST /lab/batches/{id}/stop` | 停止后续，保留当前已发出的调用 |
| `GET /lab/batches/compare?a=...&b=...` | 按相同用例与判定口径配对比较 |
| `GET /lab/runs/{id}` | 完整记录 |
| `GET /lab/costs` | 全部记录的费用与 token 汇总 |
| `GET/PUT /lab/pricing` | 读取内置及自定义单价 / 保存某模型、时段和上游地址的新单价 |
| `DELETE /lab/pricing` | 删除指定 provider、model、period、baseURL 对应的价格（JSON 请求体），保留历史快照 |
| `GET /lab/pricing-periods` | 三种时段定义、服务器北京时间对应时段及内置价格来源 |
| `PATCH /lab/runs/{id}/feedback` | 人工评价 |
| `GET /contracts/request`、`GET /contracts/response` | JSON Schema |

```sh
curl --fail http://127.0.0.1:8765/v1/ai/entitlement
curl --fail-with-body http://127.0.0.1:8765/v1/ai/task-inspirations \
  -H 'Content-Type: application/json' --data-binary @examples/request.json
```

共享配置支持字段级更新，例如 PATCH /lab/profile 提交 {"options":{"promptVersion":"coach-v1"}} 只更新版本，提交 {"isPro":false,"usedCredits":0} 只更新模拟权益。未提交字段保持不变，false 和 0 均作为明确更新保留；不接受空请求、空 options、null 或未知字段，类型和范围沿用现有 Profile / Options 校验。修改后返回完整 Profile，无需先读取再拼接完整对象。原 GET/PUT 请求及返回结构不变。

全量历史 GET 使用 page（从 1 开始）、pageSize（1–100，默认 8）、q、status、source，可选 provider、promptVersion、model、promptHash、caseID、batchID；返回 items、total、page、pageSize、totalPages。摘要包含草稿、完整指纹、用例、判定和批次 ID，不包含 Prompt 正文或原始响应。无 page 时保留旧行为，返回最近 100 条数组，旧单条用例及 iOS 接口不变。

创建归档的请求示例（本步不调用模型），执行时无需重传配置：

```json
{"caseIDs":["vocab","bad-day"],"options":{"provider":"mock","promptVersion":"coach-v1"},"source":"agent","name":"候选版本验证"}
```

随后按上述 caseIDs 顺序 POST /lab/batches/{id}/items/{caseID}/run。预期输入拒绝也保存在条目中，其 runID 为 null。停止可提交 {"reason":"user"}；刷新恢复使用 browser_refresh，关闭或连接中断使用 browser_closed。原 scripts.evaluate_cases CLI 仍走兼容的单条接口，不推测合并成归档；Agent 如需归档可使用这组新增接口。

响应头 `X-Lab-Run-ID` 对应调用记录。402 为模拟积分不足；409 忙碌；422 输入/配置非法；502 上游或输出失败；503 未配置 key；504 超时。错误体为 `error` 对象，含 `code/message/runID?/entitlement?`；FastAPI 输入验证的 422 使用标准 `detail` 结构。

服务回填 `goalID`、重新计算 `remainingDays`，按 iOS 规则逐条校验日期/循环/量化/Pro，移除无效、重复及超过数量上限的建议。不静默修复参数或降级 Pro 配置；全部无效时保留原始输出并返回失败。

## 检查

```sh
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv run python -m scripts.export_contracts
node --input-type=module --check < static/app.js
node --test tests/web-*.test.mjs
git diff --check
```

自动测试使用临时数据和替代 HTTP transport，不调用真实模型。实际验证范围见 [验证记录](docs/validation.md)。

可选浏览器回归会自动启动无 key 的隔离 Mock 服务，并在 data/ 保存报告与截图：

```sh
uv run --with playwright python -m scripts.check_web_ui
uv run --with playwright python -m scripts.check_batch_ui
# 其他系统可通过 --chrome 指定已有 Chrome / Chromium 可执行文件
```

## 参考与决策

- [设计决策](docs/design.md)、[界面与流程整合方案](docs/ux-integration-proposal.md)、[迁入正式后端](docs/migration.md)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- iOS 契约：相邻 `Relax/RelaxCore/Features/Goal/TaskInspiration/`
