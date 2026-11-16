"""Run the browser regression against a fresh, keyless local Lab.

Optional dependency: uv run --with playwright python -m scripts.check_web_ui
Uses an installed Chrome; never connects to the daily Lab or reads .env.
"""

import argparse
import json
import socket
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    args = parser.parse_args()
    output = ROOT / "data" / ("ui-phase1-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    output.mkdir(parents=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    command = (
        "from pathlib import Path; import uvicorn; "
        "from relax_ai_lab.app import create_app; from relax_ai_lab.config import Settings; "
        f"uvicorn.run(create_app(Settings(data_dir=Path({str(output / 'db')!r}), "
        f"api_key='', listen_port={port})), host='127.0.0.1', port={port})"
    )
    report = {"checks": [], "pageErrors": []}
    base = f"http://127.0.0.1:{port}"
    with (output / "server.log").open("w") as log:
        server = subprocess.Popen(["uv", "run", "python", "-c", command], cwd=ROOT, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with urlopen(base + "/health", timeout=1) as response:
                        assert json.load(response)["apiKeyConfigured"] is False
                    break
                except OSError:
                    if server.poll() is not None:
                        raise RuntimeError(f"Isolated server failed: {output / 'server.log'}") from None
                    time.sleep(0.1)
            else:
                raise RuntimeError("Isolated server did not start")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=args.chrome, headless=True)
                page = browser.new_page(viewport={"width": 1440, "height": 1100})
                page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                generation_requests = []
                profile_requests = []
                page.on(
                    "request",
                    lambda request: (
                        profile_requests.append(
                            (request.method, request.post_data_json if request.method == "PATCH" else None)
                        )
                        if request.url.endswith("/lab/profile")
                        else None
                    ),
                )
                page.on(
                    "request",
                    lambda request: (
                        generation_requests.append(request.post_data_json)
                        if request.method == "POST" and request.url.endswith("/lab/runs")
                        else None
                    ),
                )

                def nav(name):
                    page.locator(f".site-nav [data-page-link={name}]").click()

                def ready():
                    expect(page.locator("#sessionPhase")).to_have_text("待选择任务")

                def check(name):
                    report["checks"].append(name)

                page.goto(base + "/simulate")
                expect(page.locator("#openSession")).to_be_enabled()
                expect(page.locator("#restoredNotice")).to_be_hidden()
                assert page.locator("#theme").count() == 0
                page.emulate_media(color_scheme="dark")
                assert page.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light"
                check("初次访问无错误恢复提示；移除配色选择，系统暗色下仍为浅色")

                page.locator("#title").fill("   ")
                page.locator("#openSession").click()
                expect(page.locator("#goalError")).to_be_visible()
                assert len(generation_requests) == 0
                page.locator("#title").fill("英语对话回归目标")
                page.locator("#openSession").click()
                ready()
                assert page.locator("#sessionCards .task-card").count() == 4
                assert page.locator("#sessionCards input:checked").count() == 4
                page.locator("#selectAll").click()
                expect(page.locator("#addSelected")).to_be_disabled()
                page.locator("#selectAll").click()
                page.locator("#addSelected").click()
                expect(page.locator("#openSession")).to_be_hidden()
                expect(page.locator("#goalTaskCount")).to_have_text("4 条任务")
                page.locator("#resetTasks").click()
                expect(page.locator("#openSession")).to_be_visible()
                check("输入就地校验、打开自动生成、默认全选、零选择禁用、模拟添加与空态恢复")

                page.locator("#openSession").click()
                ready()
                page.locator("#currentResult summary").filter(has_text="人工评价").click()
                editor = page.locator("#currentResult .feedback-editor")
                editor.locator("select").select_option("needs_work")
                editor.locator("textarea").fill("跨页保留的未保存评价")
                page.locator("#viewCurrentInHistory").click()
                expect(page.locator("#historyDetail .feedback-editor")).to_be_attached()
                page.locator("#historyDetail summary").filter(has_text="人工评价").click()
                history_editor = page.locator("#historyDetail .feedback-editor")
                expect(history_editor.locator("textarea")).to_have_value("跨页保留的未保存评价")
                pending_feedback = []
                page.route("**/lab/runs/*/feedback", lambda route: pending_feedback.append(route))
                history_editor.get_by_role("button", name="保存评价", exact=True).click()
                expect(history_editor.locator(".feedback-state")).to_have_text("正在保存…")
                history_editor.locator("textarea").fill("保存期间的新修改")
                pending_feedback[0].fulfill(response=pending_feedback[0].fetch())
                expect(history_editor.locator(".feedback-state")).to_have_text("未保存的评价草稿")
                expect(history_editor.locator("textarea")).to_have_value("保存期间的新修改")
                page.unroute("**/lab/runs/*/feedback")
                history_editor.get_by_role("button", name="保存评价", exact=True).click()
                expect(history_editor.locator(".feedback-state")).to_have_text("评价已保存")
                nav("simulate")
                expect(editor.locator("textarea")).to_have_value("保存期间的新修改")
                expect(editor.locator(".feedback-state")).to_have_text("评价已保存")
                page.locator("#currentResult").get_by_role("button", name="设为 A", exact=True).click()
                expect(page.locator("#historyCompare")).to_be_visible()
                nav("simulate")
                page.locator("#refreshSession").click()
                ready()
                page.locator("#currentResult").get_by_role("button", name="设为 B", exact=True).click()
                expect(page.locator("#compare")).to_be_enabled()
                page.locator("#compare").click()
                expect(page.locator(".comparison-column")).to_have_count(2)
                expect(page.locator(".comparison-context")).to_contain_text("业务输入不同")
                check("评价跨页共用、保存中编辑保留、A/B 直接加入及上下文差异")
                nav("simulate")
                page.locator("#closeSession").click()
                page.locator("#viewCurrentInHistory").click()
                copy_count = len(generation_requests)
                page.locator("#historyDetail").get_by_role(
                    "button", name="复制为当前试验", exact=True
                ).click()
                expect(page.locator("#page-simulate")).to_be_visible()
                expect(page.locator("#sessionPhase")).to_have_text("未打开会话")
                assert len(generation_requests) == copy_count

                nav("prompts")
                original = page.locator("#prompt").input_value()
                draft = original + "\n\n界面回归草稿"
                page.locator("#prompt").fill(draft)
                page.locator("#reloadProfile").click()
                expect(page.locator("#prompt")).to_have_value(draft)
                expect(page.locator("#applyProfile")).to_be_disabled()
                page.locator("#preview").click()
                expect(page.locator("#promptPreview")).to_have_attribute("open", "")
                count = len(generation_requests)
                page.locator("#versionName").fill("ui-candidate")
                page.locator("#savePrompt").click()
                expect(page.locator("#promptVersion")).to_have_value("ui-candidate")
                assert len(generation_requests) == count
                profile = page.request.get(base + "/lab/profile").json()
                assert profile["options"]["promptVersion"] == "coach-v1"
                profile.update(isPro=True, usedCredits=7)
                assert page.request.put(base + "/lab/profile", data=profile).ok
                before_apply = len(profile_requests)
                page.locator("#applyProfile").click()
                expect(page.locator("#activeInfo")).to_contain_text("ui-candidate")
                assert profile_requests[before_apply:] == [
                    ("PATCH", {"options": {"promptVersion": "ui-candidate"}})
                ]
                updated = page.request.get(base + "/lab/profile").json()
                assert updated["usedCredits"] == 7 and updated["isPro"] is True
                updated["options"]["temperature"] = 0.5
                assert page.request.put(base + "/lab/profile", data=updated).ok
                nav("deployment")
                page.locator("#membership").select_option("free")
                page.locator("#usedCredits").fill("3")
                before_apply = len(profile_requests)
                page.locator("#applyEntitlement").click()
                expect(page.locator("#creditInfo")).to_contain_text("已用 3")
                assert profile_requests[before_apply:] == [("PATCH", {"isPro": False, "usedCredits": 3})]
                updated = page.request.get(base + "/lab/profile").json()
                assert updated["options"]["temperature"] == 0.5
                before_apply = len(profile_requests)
                page.locator("#applyEntitlement").click()
                expect(page.locator("#status")).to_have_text("模拟权益与服务配置一致。")
                assert len(profile_requests) == before_apply
                check("预览不生成、保存版本不应用、仅 PATCH 修改字段、未修改字段保留且一致时不提交")

                nav("prompts")
                latest_draft = page.locator("#prompt").input_value() + "\n保留候选草稿"
                page.locator("#prompt").fill(latest_draft)
                page.locator("#replaceWithShared").click()
                expect(page.locator("#prompt")).not_to_have_value(latest_draft)
                page.locator("#restoreDraft").click()
                expect(page.locator("#prompt")).to_have_value(latest_draft)
                page.locator("#promptVersion").select_option("coach-v1")
                page.locator("#promptVersion").select_option("ui-candidate")
                expect(page.locator("#prompt")).to_have_value(latest_draft)
                nav("cases")
                page.locator(".case-row input").first.check()
                page.locator("#caseSearch").fill("free-monthend")
                expect(page.locator("#caseSelectionCount")).to_contain_text("不在当前筛选中")
                page.locator(".case-row input").first.check()
                before_reload = len(generation_requests)
                page.reload()
                expect(page.locator("#caseSelectionCount")).to_contain_text("已选择 2 条")
                expect(page.locator("#restoredNotice")).to_be_visible()
                expect(page.locator("#evaluationProgress")).to_be_hidden()
                assert len(generation_requests) == before_reload
                nav("prompts")
                expect(page.locator("#prompt")).to_have_value(latest_draft)
                check("按版本保留草稿、替换共享配置可恢复、刷新恢复编辑与选择而不恢复会话或调用")

                nav("cases")
                page.locator("#caseSearch").fill("")
                page.locator("#selectVisibleCases").check()
                page.locator("#runCases").click()
                expect(page.locator("#batchHeading")).to_have_text("本批评测完成", timeout=30000)
                expect(page.locator(".count-mock b")).to_have_text("61")
                expect(page.locator(".count-rejected b")).to_have_text("3")
                page.locator("#caseResultFilter").select_option("failed")
                expect(page.locator(".case-row")).to_have_count(0)
                page.locator("#caseResultFilter").select_option("unreviewed")
                expect(page.locator(".case-row")).to_have_count(61)
                with page.expect_download() as downloaded:
                    page.locator("#exportCases").click()
                batch = json.loads(Path(downloaded.value.path()).read_text())
                assert len(batch["items"]) == 64 and len(batch["cases"]) == 64
                assert batch["configuration"]["promptText"] == latest_draft
                page.locator("#runCases").click()
                expect(page.locator("#replaceBatchNotice")).to_be_visible()
                page.locator("#cancelReplaceBatch").click()
                expect(page.locator("#replaceBatchNotice")).to_be_hidden()
                page.screenshot(path=str(output / "cases-desktop.png"), full_page=True)
                check("64 用例完整 Mock 批次、61 Mock 与 3 预期拒绝、结果筛选、导出及新批次替换提示")
                copy_count = len(generation_requests)
                page.locator("#caseDetail").get_by_role("button", name="复制为当前试验", exact=True).click()
                expect(page.locator("#page-simulate")).to_be_visible()
                expect(page.locator("#prompt")).to_have_value(latest_draft)
                expect(page.locator("#sessionPhase")).to_have_text("未打开会话")
                assert len(generation_requests) == copy_count
                nav("cases")
                check("历史与用例结果可复制目标和实际草稿；复制不自动发出生成请求")

                # Hold one real HTTP request before sending it to the isolated Mock service.
                page.locator("#caseResultFilter").select_option("all")
                page.locator("#caseSearch").fill("week")
                page.locator("#clearCases").click()
                page.locator("#selectVisibleCases").check()
                pending = []
                page.route("**/lab/batches/*/items/*/run", lambda route: pending.append(route))
                page.locator("#runCases").click()
                page.locator("#replaceBatch").click()
                expect(page.locator("#stopCases")).to_be_visible()
                page.locator("#stopCases").click()
                nav("prompts")
                expect(page.locator("#prompt")).to_be_disabled()
                pending[0].fulfill(response=pending[0].fetch())
                nav("cases")
                expect(page.locator("#batchHeading")).to_have_text("评测已停止")
                assert len(pending) == 1
                assert int(page.locator(".count-skipped b").inner_text()) > 0
                page.unroute("**/lab/batches/*/items/*/run")
                check("跨页继续、运行中配置锁定、停止仅取消后续并保留当前结果")

                # Refresh failure and manual retry must keep the refresh context.
                nav("simulate")
                page.locator("#openSession").click()
                ready()
                page.locator("#refreshSession").click()
                ready()
                failed = []

                def fail_once(route):
                    failed.append(route.request.post_data_json)
                    route.fulfill(
                        status=502,
                        json={"error": {"code": "upstream_error", "message": "隔离测试的失败响应"}},
                    )

                page.route("**/lab/runs", fail_once)
                page.locator("#refreshSession").click()
                expect(page.locator("#sessionPhase")).to_have_text("生成失败")
                expect(page.locator("#sessionCards .task-card")).to_have_count(0)
                page.unroute("**/lab/runs", fail_once)
                page.locator("#retrySession").click()
                ready()
                retried = generation_requests[-1]["request"]
                assert retried == failed[0]["request"]
                assert retried["generationMode"] == "refresh"
                page.locator("#closeSession").click()
                pending = []
                page.route("**/lab/runs", lambda route: pending.append(route))
                page.locator("#openSession").click()
                expect(page.locator("#sessionPhase")).to_have_text("生成中")
                page.locator("#closeSession").click()
                expect(page.locator("#activityText")).to_contain_text("已发送的请求仍在处理中")
                expect(page.locator("#openSession")).to_be_disabled()
                assert pending[0].request.post_data_json["request"]["generationMode"] == "initial"
                pending[0].fulfill(response=pending[0].fetch())
                expect(page.locator("#openSession")).to_be_enabled()
                expect(page.locator("#sessionPhase")).to_have_text("未打开会话")
                expect(page.locator("#sessionCards .task-card")).to_have_count(0)
                page.unroute("**/lab/runs")
                check("换批失败清空旧结果、手动重试保持模式和排重、关闭后重开 initial、迟到响应不重建会话")

                page.route(
                    "**/health", lambda route: route.fulfill(json={"busy": True, "apiKeyConfigured": False})
                )
                page.locator("#refreshHealth").click()
                expect(page.locator("#activityText")).to_contain_text("可能来自其他客户端")
                expect(page.locator("#openSession")).to_be_disabled()
                page.unroute("**/health")
                page.locator("#refreshHealth").click()
                expect(page.locator("#openSession")).to_be_enabled()
                nav("prompts")
                page.locator("#provider").select_option("deepseek")
                expect(page.locator("#providerNotice")).to_contain_text("未配置")
                nav("cases")
                page.locator("#caseSearch").fill("week")
                expect(page.locator("#runCases")).to_contain_text("运行所选用例")
                page.locator("#runCases").click()
                page.locator("#replaceBatch").click()
                expect(page.locator("#batchHeading")).to_have_text("评测已停止")
                expect(page.locator(".count-errors b")).to_have_text("1")
                expect(page.locator("#caseDetail")).to_contain_text("missing_api_key")
                check("外部服务 busy、未配置 key 明确失败、执行错误停止后续且不降级 Mock")

                nav("prompts")
                page.locator("#provider").select_option("mock")
                nav("simulate")
                nav("prompts")
                page.go_back()
                expect(page.locator("#page-simulate")).to_be_visible()
                page.go_forward()
                expect(page.locator("#page-prompts")).to_be_visible()
                direct = browser.new_page()
                direct.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                for name in ("simulate", "cases", "prompts", "history", "costs", "deployment"):
                    direct.goto(base + "/" + name)
                    expect(direct.locator("#page-" + name)).to_be_visible()
                    expect(direct.locator("#navSessionState")).to_have_text("服务空闲")
                direct.close()
                check("六页直接访问及浏览器前进后退保留页面流程")
                for width in (1440, 1024, 390, 320):
                    page.set_viewport_size({"width": width, "height": 1100})
                    for name in ("simulate", "cases", "prompts", "history", "costs", "deployment"):
                        nav(name)
                        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"), (
                            width,
                            name,
                        )
                    if width == 390:
                        page.screenshot(path=str(output / "environment-mobile.png"), full_page=True)
                page.set_viewport_size({"width": 1440, "height": 1100})
                nav("prompts")
                page.screenshot(path=str(output / "prompts-desktop.png"), full_page=True)
                assert not report["pageErrors"], report["pageErrors"]
                check("六页导航与四种宽度无横向溢出、无浏览器脚本错误")
                browser.close()
            (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({"output": str(output), **report}, ensure_ascii=False, indent=2))
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    run()
