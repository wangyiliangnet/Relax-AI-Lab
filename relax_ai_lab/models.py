import re
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PlanType = Literal["quick_start", "advanced"]
Weekday = Literal["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
Title = Annotated[str, Field(min_length=1, max_length=500)]


def date_only(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("date must use yyyy-MM-dd")
    date.fromisoformat(value)
    return value


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Goal(Contract):
    id: str
    title: Title
    note: str | None = Field(default=None, max_length=10000)
    startDate: str | None = None
    deadline: str | None = None
    remainingDays: int | None = None

    @field_validator("id")
    @classmethod
    def uuid_value(cls, value):
        UUID(value)
        return value

    @field_validator("title")
    @classmethod
    def meaningful_title(cls, value):
        if not value.strip():
            raise ValueError("title must not be blank")
        return value

    @field_validator("startDate", "deadline")
    @classmethod
    def dates(cls, value):
        return date_only(value) if value is not None else value

    @model_validator(mode="after")
    def date_range(self):
        if self.startDate and self.deadline and self.startDate > self.deadline:
            raise ValueError("goal deadline must not precede startDate")
        return self


class GenerationRequest(Contract):
    generationMode: Literal["initial", "refresh"]
    locale: str = Field(min_length=1, max_length=64)
    today: str
    goal: Goal
    existingTaskTitles: list[Title] = Field(default_factory=list, max_length=2000)
    excludedSuggestionTitles: list[Title] = Field(default_factory=list, max_length=2000)

    @field_validator("today")
    @classmethod
    def today_date(cls, value):
        return date_only(value)

    def effective(self):
        remaining = (
            (date.fromisoformat(self.goal.deadline) - date.fromisoformat(self.today)).days
            if self.goal.deadline
            else None
        )
        return self.model_copy(update={"goal": self.goal.model_copy(update={"remainingDays": remaining})})


class Recurrence(Contract):
    type: Literal[
        "none",
        "daily",
        "workdays",
        "weekends",
        "selected_weekdays",
        "selected_month_days",
        "interval",
        "ebbinghaus",
    ]
    weekdays: list[Weekday]
    monthDays: list[Annotated[int, Field(ge=1, le=31)]]
    includeLastDayOfMonth: bool
    interval: Annotated[int, Field(ge=1, le=366)] | None
    intervalUnit: Literal["day", "week"] | None

    @model_validator(mode="after")
    def parameters(self):
        if self.type == "selected_weekdays":
            if not self.weekdays or len(set(self.weekdays)) != len(self.weekdays):
                raise ValueError("selected_weekdays requires nonempty, unique weekdays")
        elif self.weekdays:
            raise ValueError("weekdays only applies to selected_weekdays")
        if self.type == "selected_month_days":
            if not self.monthDays and not self.includeLastDayOfMonth:
                raise ValueError("selected_month_days requires monthDays or the last day")
            if len(set(self.monthDays)) != len(self.monthDays):
                raise ValueError("monthDays must be unique")
        elif self.monthDays or self.includeLastDayOfMonth:
            raise ValueError("month-day options only apply to selected_month_days")
        if self.type == "interval":
            if self.interval is None or self.intervalUnit is None:
                raise ValueError("interval requires interval and intervalUnit")
        elif self.interval is not None or self.intervalUnit is not None:
            raise ValueError("interval options only apply to interval recurrence")
        return self


class Progress(Contract):
    startValue: float
    targetValue: float
    dailyTarget: float = Field(ge=0)
    unit: str = Field(max_length=12)
    calculationType: Literal["add_up", "update"]
    resetCycle: Literal["none", "daily", "weekly", "monthly"]

    @model_validator(mode="after")
    def values(self):
        if self.startValue == self.targetValue:
            raise ValueError("startValue and targetValue must differ")
        if self.dailyTarget != round(self.dailyTarget * 10) / 10:
            raise ValueError("dailyTarget supports at most one decimal place")
        if self.resetCycle != "none" and (
            self.startValue != 0 or self.targetValue <= 0 or self.calculationType != "add_up"
        ):
            raise ValueError("resetting progress must add up from zero to a positive target")
        return self


class TaskSpec(Contract):
    kind: Literal["normal", "progress"]
    recurrence: Recurrence | None = None
    progress: Progress | None = None

    @model_validator(mode="after")
    def matching_kind(self):
        if self.kind == "normal" and self.progress is not None:
            raise ValueError("normal tasks cannot contain progress")
        if self.kind == "progress":
            if self.progress is None:
                raise ValueError("progress task requires progress")
            recurrence = self.recurrence.type if self.recurrence else "none"
            cycle = self.progress.resetCycle
            if cycle in {"daily", "weekly"} and recurrence not in {"daily", "selected_weekdays"}:
                raise ValueError("daily/weekly reset requires daily or selected_weekdays recurrence")
            if cycle == "monthly" and recurrence not in {"daily", "selected_month_days"}:
                raise ValueError("monthly reset requires daily or selected_month_days recurrence")
        return self


class Task(Contract):
    title: Title
    note: str | None = Field(default=None, max_length=10000)
    datePolicy: Literal["none", "goal_range_if_available", "explicit"]
    startDate: str | None = None
    endDate: str | None = None
    taskSpec: TaskSpec | None = None

    @field_validator("title")
    @classmethod
    def title_content(cls, value):
        if not value.strip():
            raise ValueError("title must not be blank")
        return value

    @field_validator("startDate", "endDate")
    @classmethod
    def dates(cls, value):
        return date_only(value) if value is not None else value

    @model_validator(mode="after")
    def date_policy(self):
        if self.datePolicy == "explicit":
            if not self.startDate or (self.endDate and self.endDate < self.startDate):
                raise ValueError("explicit requires startDate and a non-reversed optional endDate")
        elif self.startDate is not None or self.endDate is not None:
            raise ValueError("only explicit can contain startDate/endDate")
        return self


class Plan(Contract):
    planType: PlanType
    suggestions: list[Task] = Field(max_length=5)


class GenerationResponse(Contract):
    goalID: str
    plans: list[Plan]


class Options(Contract):
    provider: Literal["mock", "deepseek"] = "mock"
    model: str = Field(default="deepseek-flash", pattern=r"^[a-zA-Z0-9._-]{1,100}$")
    temperature: float = Field(default=0.7, ge=0, le=2)
    maxTokens: int = Field(default=8192, ge=256, le=16384)
    promptVersion: str = Field(default="coach-v1", pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class Profile(Contract):
    options: Options = Field(default_factory=Options)
    isPro: bool = False
    freeCredits: float = Field(default=20, ge=0, le=1000000)
    proCredits: float = Field(default=200, ge=0, le=1000000)
    usedCredits: float = Field(default=0, ge=0, le=1000000)
    creditsPerGeneration: float = Field(default=1, gt=0, le=1000000)


class Experiment(Contract):
    request: GenerationRequest
    options: Options
    promptText: str | None = Field(default=None, min_length=1, max_length=30000)


class PromptVersion(Contract):
    name: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    content: str = Field(min_length=1, max_length=30000)
