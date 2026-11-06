## 固定 JSON 契约

只返回一个 JSON object，顶层为 {"plans":[{"planType":"quick_start","suggestions":[...]},{"planType":"advanced","suggestions":[...]}]}。不要生成 goalID，服务端按请求回填。planType 只用 quick_start、advanced，不使用 style、rhythm、subtitle、frequency 等旧字段。

每条 suggestion 必须符合下方 Task JSON Schema。空分组用空数组，每组最多 5 条。未知字段与非法参数会导致该条被移除。数值只允许有限 JSON number，禁止 NaN/Infinity；null 仅用于可空字段。

- datePolicy=none：startDate/endDate 都为 null，不设置日期，可用于无日期边界的循环。
- datePolicy=goal_range_if_available：startDate/endDate 都为 null；仅当目标同时有开始、截止日期时由客户端复用，否则不设日期。
- datePolicy=explicit：startDate 必须是 yyyy-MM-dd，endDate 可为 null，或不早于 startDate。
- taskSpec=null 表示普通一次性任务。
- kind=normal 时 progress 必须为 null。kind=progress 时 progress 必填。
- recurrence 可为 null（表示 none）；非 null 时必须包含 type、weekdays、monthDays、includeLastDayOfMonth、interval、intervalUnit。
- selected_weekdays：weekdays 至少一项且不重复，用 monday 至 sunday 的英文枚举；其他循环的 weekdays=[]。
- selected_month_days：monthDays 为不重复的 1–31，或 includeLastDayOfMonth=true；其他循环 monthDays=[] 且 includeLastDayOfMonth=false。
- interval：interval 为 1–366，intervalUnit 为 day/week；其他循环这两个字段都为 null。
- 本次权益由 user JSON 的 capabilities.hasPro 给出；非 Pro 不能使用 interval、ebbinghaus，不要通过改写 kind 绕过限制。
- progress：startValue!=targetValue；dailyTarget>=0 且最多一位小数；unit 最多 12 字符。
- resetCycle=none 支持 add_up 或 update、任意有效循环；有重置时必须 startValue=0、targetValue>0、calculationType=add_up。
- resetCycle=daily/weekly 需要 recurrence=daily/selected_weekdays；monthly 需要 daily/selected_month_days。

普通单次示例：
{"title":"从已有英语材料中选一段并朗读录音","note":"选取约两分钟的材料，保留一段录音即可。","datePolicy":"none","startDate":null,"endDate":null,"taskSpec":null}

量化示例：
{"title":"累计阅读 30 页目标相关材料","note":"每次累加实际完成的页数，达到 30 页即完成。","datePolicy":"none","startDate":null,"endDate":null,"taskSpec":{"kind":"progress","recurrence":{"type":"none","weekdays":[],"monthDays":[],"includeLastDayOfMonth":false,"interval":null,"intervalUnit":null},"progress":{"startValue":0,"targetValue":30,"dailyTarget":0,"unit":"页","calculationType":"add_up","resetCycle":"none"}}}
