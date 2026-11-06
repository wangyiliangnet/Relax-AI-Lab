# 设计决策

更新日期：2026-11-06

## 已确认

1. 仓库为 [wangyiliangnet/Relax-AI-Lab](https://github.com/wangyiliangnet/Relax-AI-Lab)，本地与 iOS 和正式后端项目并列。
2. 定位为本地实验服务，用于 iOS 联调和 prompt 调优；成熟后迁入现有 Java 后端。
3. 使用 DeepSeek API，通过部署电脑的环境变量配置 API key，凭据不进入仓库。
4. 以附件《目标 AI 任务灵感 AI 输入和返回（iOS demo 版）》作为初稿，并对齐已实现的 iOS 契约。
5. 提供浏览器调试台，并让本地 iOS App 接入 HTTP API。
6. `advanced` 表示起步后的持续行动，可循环/量化，不要求难度升级。
7. 两组各最多 5 条，允许少给或空组，整批至少一条有效建议。
8. Web 使用 GitHub Primer 风格配色和面向开发者的字段语义文案；locale 表示 App 当前界面语言。
9. Web 生成流程对齐 App 会话：打开自动生成、默认全选、换批自动排重、关闭清空、模拟添加后隐藏空态入口。生成记录与模拟目标状态分开。
10. 支持同事在各自电脑部署并使用 IPv4 局域网联调；Web 展示监听信息、连接地址和 iOS 配置步骤，iOS 提供本地网络权限与对应 ATS 支持。
11. Web 按 `/deployment`、`/prompts`、`/simulate`、`/history` 分页，导航保留会话与未保存输入。会话按钮位于模拟页顶部；任务用 App 概念展示循环、解析后的日期、量化目标及计算/重置设置。
12. 当前生成的校验、评价、请求与响应属于本次结果；历史浏览与 A/B 对比独立成页。历史按目标/版本/状态/来源筛选，分页显示摘要，一次读取一条详情；请求和次要参数默认折叠。JSON 提供结构树、格式化文本、高亮和复制，嵌套 JSON 字符串可按结构查看，原始导出不变。

## 已发现的契约差异

- 附件旧 prompt 返回 `style: quick_start / rhythm` 与 `title / subtitle / frequency`；附件后面的正式结构及 iOS 代码使用 `planType: quick_start / advanced` 与完整 `TaskCreationSpec`。后者应作为联调基线。
- `goalID` 由服务按请求中的目标 ID 回填，不要求模型生成 UUID。
- 日期采用严格的 `yyyy-MM-dd`；目标时间、当前日期、已有标题与已展示标题均由请求提供。
- iOS 已支持单条建议独立解析与校验，需要明确服务端如何处理部分无效输出。
- `interval / ebbinghaus` 在当前 iOS 需要 Pro。实验服务的权益需可模拟，不代表真实付费授权。

## 官方接入事实

2026-11-06 查阅 DeepSeek 官方文档：

- JSON Output 使用 `response_format: {"type":"json_object"}`；prompt 需包含 `json` 和期望输出的示例。
- 需要处理内容为空白、输出截断、解析失败和业务字段非法。合法 JSON 不等于符合任务契约。
- 官方当前推荐的 Flash 模型名是 `deepseek-flash`；模型名称与参数应可配置，不在业务层固定旧别名。
- 文档：[JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)、[首次调用](https://api-docs.deepseek.com/zh-cn/)。

## 实现取舍

- FastAPI + Pydantic 校验、HTTPX 直连 DeepSeek、SQLite 存储本地实验，无外部数据库。
- 每次最多一次模型请求，不自动重试或修复；逐条过滤后有结果即可返回，全部无效则失败。
- 权益共用一个本地模拟账本，无周期重置；实际 StoreKit 和保存规则由 App 原入口执行。
- 提供版本、原始请求/响应、校验原因、耗时、token、人工评价与并排对比。
- API key 已配置并通过鉴权连通检查；本轮界面验证使用隔离 Mock，未额外调用模型，真实建议质量仍需在实验中人工评估。
