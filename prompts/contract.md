## 固定 JSON 契约

只返回一个 JSON object，顶层为 {"plans":[{"planType":"quick_start","suggestions":[...]},{"planType":"advanced","suggestions":[...]}]}。不要生成 goalID，服务端按请求回填。planType 只用 quick_start、advanced，不使用 style、rhythm、subtitle、frequency 等旧字段。

每条 suggestion 必须符合下方 Task JSON Schema。空分组用空数组，每组最多 5 条。未知字段与非法参数会导致该条被移除。数值字段使用有限 JSON number。数字字符串、布尔值和 NaN/Infinity 均不能表示数值。null 仅用于可空字段。

- datePolicy=none：startDate/endDate 都为 null，不设置日期，可用于无日期边界的循环。
- datePolicy=goal_range_if_available：startDate/endDate 都为 null；仅当目标同时有开始、截止日期时由客户端复用，否则不设日期。
- datePolicy=explicit：startDate 必须是 yyyy-MM-dd，endDate 可为 null，或不早于 startDate。
- taskSpec=null 表示普通一次性任务。
- kind=normal 时 progress 必须为 null。kind=progress 时 progress 必填。
- recurrence 可为 null（表示 none）；非 null 时必须包含 type、weekdays、monthDays、includeLastDayOfMonth、interval、intervalUnit。
- selected_weekdays：weekdays 至少一项且不重复，用 monday 至 sunday 的英文枚举；其他循环的 weekdays=[]。
- selected_month_days：monthDays 为不重复的 1–31，或 includeLastDayOfMonth=true；其他循环 monthDays=[] 且 includeLastDayOfMonth=false。
- interval：interval 为 1–366，intervalUnit 为 day/week；其他循环这两个字段都为 null。
- 本次权益由 user JSON 的 capabilities.hasPro 给出。免费用户可选工作日、周末、指定星期、指定月日及月末。interval 和 ebbinghaus 需要 Pro。
- 新建量化任务须选择循环。startValue 和 targetValue 为业务起点和绝对目标，两者都可以带小数。通常应选择能体现实际变化的目标，因为等值时 App 会判为已经达到目标。
- dailyTarget 是按任务方向比较的有符号数，最多一位小数。为 0 时有当日记录即可。递增时当日量需达到或高于此值，递减时需达到或低于此值。例如用 update 记录剩余量且每天至少减少 0.5 时填 -0.5。使用 add_up 时记录本次增量，使用 update 时记录当前绝对值。unit 使用同一计量单位，最多 12 个用户可见字符，无单位时填空字符串。
- resetCycle=none 支持 add_up 或 update 及本次权益内的循环。有重置时必须 startValue=0、calculationType=add_up。常规周期累积选择能表达该周期实际工作量的正目标。
- resetCycle=daily/weekly 需要 recurrence=daily/selected_weekdays；monthly 需要 daily/selected_month_days。

普通单次示例：
{"title":"从已有英语材料中选一段并朗读录音","note":"选取约两分钟的材料，保留一段录音即可。","datePolicy":"none","startDate":null,"endDate":null,"taskSpec":null}

量化示例：
{"title":"每天登记阅读进度，累计完成 30 页","note":"每天累加实际阅读页数，达到 30 页即完成。","datePolicy":"goal_range_if_available","startDate":null,"endDate":null,"taskSpec":{"kind":"progress","recurrence":{"type":"daily","weekdays":[],"monthDays":[],"includeLastDayOfMonth":false,"interval":null,"intervalUnit":null},"progress":{"startValue":0,"targetValue":30,"dailyTarget":0,"unit":"页","calculationType":"add_up","resetCycle":"none"}}}
