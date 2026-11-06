const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const weekdayNames = ["一", "二", "三", "四", "五", "六", "日"];
const numberFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 10,
});
export function numberText(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? numberFormat.format(value)
    : String(value ?? "—");
}
export function dateText(value) {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return String(value);
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (date.toISOString().slice(0, 10) !== value) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(date);
}
export function recurrenceText(recurrence) {
  switch (recurrence?.type || "none") {
    case "none":
      return "无循环";
    case "daily":
      return "每天";
    case "workdays":
      return "每周工作日";
    case "weekends":
      return "每周六、周日";
    case "selected_weekdays":
      return (
        "每周" +
        weekdays
          .filter((day) => recurrence.weekdays?.includes(day))
          .map((day) => weekdayNames[weekdays.indexOf(day)])
          .join("、")
      );
    case "selected_month_days": {
      const days = [...(recurrence.monthDays || [])]
        .sort((a, b) => a - b)
        .map((day) => `${day}日`);
      if (recurrence.includeLastDayOfMonth) days.push("最后一天");
      return "每月" + days.join("、");
    }
    case "interval":
      if (recurrence.interval === 1)
        return recurrence.intervalUnit === "week" ? "每周" : "每天";
      return `定期循环（每${numberText(recurrence.interval)}${recurrence.intervalUnit === "week" ? "周" : "天"}）`;
    case "ebbinghaus":
      return "艾宾浩斯记忆法";
    default:
      return String(recurrence.type);
  }
}
export function taskFacts(task, goal = {}) {
  const recurrence = task.taskSpec?.recurrence;
  const facts = [{ label: "循环", value: recurrenceText(recurrence) }];
  let start = null,
    end = null;
  if (task.datePolicy === "explicit") {
    start = task.startDate;
    end = task.endDate;
  } else if (
    task.datePolicy === "goal_range_if_available" &&
    goal.startDate &&
    goal.deadline
  ) {
    start = goal.startDate;
    end = goal.deadline;
  }
  if (!start) facts.push({ label: "日期", value: "不设置日期" });
  else if (
    end &&
    (end !== start || (recurrence?.type && recurrence.type !== "none"))
  ) {
    facts.push(
      { label: "开始日期", value: dateText(start) },
      { label: "结束日期", value: dateText(end) },
    );
  } else if (recurrence?.type && recurrence.type !== "none")
    facts.push(
      { label: "开始日期", value: dateText(start) },
      { label: "结束日期", value: "不设结束日期" },
    );
  else facts.push({ label: "执行日期", value: dateText(start) });
  const progress = task.taskSpec?.progress;
  if (progress) {
    const unit = progress.unit ? ` ${progress.unit}` : "";
    facts.push({
      label: "量化目标",
      value: `${numberText(progress.startValue)} → ${numberText(progress.targetValue)}${unit}`,
    });
    facts.push({
      label: "进度计算方式",
      value: progress.calculationType === "add_up" ? "求和" : "更新",
    });
    facts.push({
      label: "进度重置周期",
      value:
        { none: "不重置", daily: "每天", weekly: "每周", monthly: "每月" }[
          progress.resetCycle
        ] || progress.resetCycle,
    });
    facts.push({
      label: "每日完成条件",
      value:
        progress.dailyTarget > 0
          ? `至少 ${numberText(progress.dailyTarget)}${unit}`
          : "记录即算完成",
    });
  }
  return facts;
}
