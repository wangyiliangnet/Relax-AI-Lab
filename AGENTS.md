# Relax AI Lab

- 先读 `README.md` 和 `docs/design.md`；区分已确认决策与待讨论问题。
- 本仓库用于本地联调和 prompt 实验，生产后端在相邻 `Relax-Backend`。
- 接口需对齐相邻 `Relax` 仓库当前的 Swift 请求、响应及任务参数校验；不要直接照抄旧 demo prompt 的输出格式。
- API key 通过环境配置注入；不得写入源码、日志、浏览器页面、测试数据或 Git。
- 调用记录和实验输出保存在 Git 忽略的 `data/` 中。
- 未配置 API key 时允许本地查看、校验与 mock 联调；真实模型调用应明确失败，不能伪装成成功。
- 修改模型参数前查阅 DeepSeek 官方文档。记录真实调用的 prompt 版本、请求、原始返回、校验结果、耗时和 token 用量，便于迁移与复现。
