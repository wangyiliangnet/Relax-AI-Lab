"""Browser regression for batch archives, recovery, pagination and paired comparison.

uv run --with playwright python -m scripts.check_batch_ui
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
    output = ROOT / "data" / ("ui-phase2-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    output.mkdir(parents=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    command = (
        "from pathlib import Path; import uvicorn; "
        "from relax_ai_lab.app import create_app; from relax_ai_lab.config import Settings; "
        f"uvicorn.run(create_app(Settings(data_dir=Path({str(output / 'db')!r}), "
        f"api_key='', listen_port={port})), host='127.0.0.1', port={port})"
    )
    report = {"checks": [], "pageErrors": []}
    with (output / "server.log").open("a") as log:

        def start():
            process = subprocess.Popen(
                ["uv", "run", "python", "-c", command], cwd=ROOT, stdout=log, stderr=log
            )
            for _ in range(100):
                try:
                    with urlopen(base + "/health", timeout=1) as response:
                        assert json.load(response)["apiKeyConfigured"] is False
                    return process
                except OSError:
                    time.sleep(0.1)
            raise RuntimeError("Isolated service failed to start")

        server = start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=args.chrome, headless=True)
                page = browser.new_page(viewport={"width": 1440, "height": 1100})
                page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                requests = []
                page.on(
                    "request",
                    lambda request: (
                        requests.append(request.url)
                        if request.method == "POST" and "/items/" in request.url
                        else None
                    ),
                )
                page.goto(base + "/cases")
                expect(page.locator("#caseCatalogCount")).to_have_text("64 / 64")

                def nav(name):
                    page.locator(f".site-nav [data-page-link={name}]").click()

                def select(case_id):
                    page.locator("#caseSearch").fill(case_id)
                    expect(page.locator(".case-row")).to_have_count(1)
                    page.locator(".case-row input").check()

                def complete():
                    expect(page.locator("#batchHeading")).to_have_text("本批评测完成", timeout=20000)
                    expect(page.locator("#runCases")).to_be_enabled()

                def open_archives():
                    page.locator("#batchArchive").evaluate("(node) => node.open = true")
                    page.locator("#reloadBatches").click()

                select("vocab")
                select("bad-day")
                page.locator("#batchName").fill("基线归档")
                page.locator("#runCases").click()
                complete()
                a = page.request.get(base + "/lab/batches").json()["items"][0]
                assert a["caseCount"] == 2
                before = len(requests)
                page.reload()
                expect(page.locator("#archiveViewNotice")).to_contain_text("基线归档")
                expect(page.locator(".count-mock b")).to_have_text("1")
                expect(page.locator(".count-rejected b")).to_have_text("1")
                expect(page.locator("#runCases")).to_be_disabled()
                assert len(requests) == before
                with page.expect_download() as downloaded:
                    page.locator("#exportCases").click()
                exported = json.loads(Path(downloaded.value.path()).read_text())
                assert exported["id"] == a["id"] and len(exported["cases"]) == 2
                report["checks"].append("完成批次刷新恢复固定快照、无 runID 的预期拒绝及导出；不重新调用")

                page.locator("#leaveArchive").click()
                nav("prompts")
                page.locator("#prompt").fill(page.locator("#prompt").input_value() + "\n对比候选草稿")
                nav("cases")
                select("weekends")
                page.locator("#batchName").fill("候选归档")
                page.locator("#runCases").click()
                complete()
                b = page.request.get(base + "/lab/batches").json()["items"][0]
                assert b["id"] != a["id"] and b["promptHash"] != a["promptHash"]
                open_archives()
                page.locator(".batch-archive-row").filter(has_text="基线归档").get_by_role(
                    "button", name="批次 A", exact=True
                ).click()
                expect(page.locator("#historyBatchCompare")).to_be_visible()
                nav("cases")
                page.locator(".batch-archive-row").filter(has_text="候选归档").get_by_role(
                    "button", name="批次 B", exact=True
                ).click()
                page.locator("#compareBatches").click()
                expect(page.locator("#batchCompareRows .batch-pair")).to_have_count(3)
                expect(page.locator("#batchCompareSummary")).to_contain_text("无可比较的真实断言共同样本")
                with page.expect_download() as downloaded:
                    page.locator("#exportBatchComparison").click()
                comparison = json.loads(Path(downloaded.value.path()).read_text())
                assert comparison["counts"] == {"mock": 1, "input_rejection": 1, "only_b": 1}
                assert comparison["quality"]["pairs"] == 0
                assert comparison["a"]["id"] == a["id"] and comparison["b"]["id"] == b["id"]
                page.locator("#batchPairFilter").select_option("only_b")
                expect(page.locator("#batchCompareRows .batch-pair")).to_have_count(1)
                expect(page.locator("#batchCompareRows")).to_contain_text("weekends")
                page.locator("#batchPairFilter").select_option("mock")
                page.locator("#batchCompareRows summary").click()
                expect(page.locator("#batchCompareRows .result-summary")).to_have_count(2)
                page.screenshot(path=str(output / "comparison-desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 1100})
                assert not page.evaluate("document.documentElement.scrollWidth > innerWidth + 1")
                page.screenshot(path=str(output / "comparison-mobile.png"), full_page=True)
                page.set_viewport_size({"width": 1440, "height": 1100})
                report["checks"].append(
                    "批次跨页 A/B 选择、用例配对、单边缺失、Mock 与拒绝单列、按需读取详情和对比导出"
                )

                nav("cases")
                # Clear the completed batch view, then pause delivery of one completed HTTP response.
                open_archives()
                page.locator("#currentCaseLibrary").click()
                page.locator("#clearCases").click()
                select("vocab")
                select("weekends")
                page.locator("#batchName").fill("刷新中断")
                pending = []

                def hold(route):
                    response = route.fetch()
                    pending.append((route, response))

                page.route("**/lab/batches/*/items/*/run", hold)
                page.locator("#runCases").click()
                expect(page.locator("#batchHeading")).to_have_text("正在评测")
                page.wait_for_function(
                    "document.querySelector('#batchProgressText').textContent.includes('0 / 2')"
                )
                assert len(pending) == 1
                before = len(requests)
                page.reload()
                expect(page.locator("#batchHeading")).to_have_text("批次已中断（未续跑）")
                expect(page.locator(".count-mock b")).to_have_text("1")
                expect(page.locator(".count-skipped b")).to_have_text("1")
                page.unroute("**/lab/batches/*/items/*/run")
                assert len(requests) == before
                report["checks"].append(
                    "响应尚未送达时刷新：已完成调用能恢复，后续用例标为未执行且不自动补跑"
                )

                # Restart the actual isolated process with one completed and one pending item.
                response = page.request.post(
                    base + "/lab/batches",
                    data={
                        "caseIDs": ["vocab", "weekends"],
                        "options": {"provider": "mock"},
                        "name": "重启恢复",
                    },
                )
                interrupted = response.json()
                assert page.request.post(base + f"/lab/batches/{interrupted['id']}/items/vocab/run").ok
                open_archives()
                page.locator(".batch-archive-row").filter(has_text="重启恢复").get_by_role(
                    "button", name="打开归档", exact=True
                ).click()
                server.terminate()
                server.wait(timeout=5)
                server = start()
                page.reload()
                expect(page.locator("#archiveViewNotice")).to_contain_text("重启恢复")
                expect(page.locator("#batchHeading")).to_have_text("批次已中断（未续跑）")
                expect(page.locator(".count-mock b")).to_have_text("1")
                expect(page.locator(".count-skipped b")).to_have_text("1")
                assert page.request.get(base + "/lab/batches/" + a["id"]).json()["phase"] == "completed"
                report["checks"].append("服务真实重启后核对已完成记录，恢复中断批次并保留完成归档")

                catalog = page.request.get(base + "/lab/cases").json()
                context = catalog[0]["context"]
                context["goal"]["title"] = "最旧历史追溯目标"
                seeded = page.request.post(
                    base + "/lab/runs", data={"request": context, "options": {"provider": "mock"}}
                )
                assert seeded.ok
                oldest = seeded.json()["id"]
                for _ in range(110):
                    assert page.request.post(
                        base + "/lab/cases/vocab/run", data={"options": {"provider": "mock"}}
                    ).ok
                assert len(page.request.get(base + "/lab/runs").json()) == 100
                nav("history")
                page.locator("#historyBrowseTab").click()
                page.locator("#historySearch").fill("最旧历史追溯目标")
                expect(page.locator("#historyCount")).to_have_text("共 1 条 · 本页 1 条")
                page.locator(".history-row-main").click()
                expect(page.locator("#historyDetail")).to_contain_text(oldest)
                page.locator("#historySearch").fill("")
                expect(page.locator("#historyList .history-row")).to_have_count(8)
                page.locator("#historyNext").click()
                expect(page.locator("#historyPage")).to_contain_text("2 /")
                page.reload()
                expect(page.locator("#historyPage")).to_contain_text("2 /")
                page.locator(".history-advanced").evaluate("(node) => node.open = true")
                page.locator("#historyCaseID").fill("vocab")
                expect(page.locator("#historyCount")).to_contain_text("共 11")
                assert "最旧历史追溯目标" not in page.locator("#historyList").inner_text()
                page.screenshot(path=str(output / "history-paged.png"), full_page=True)
                report["checks"].append(
                    "超过 100 条后的旧记录可检索、服务端分页及刷新保留页码、按用例过滤、旧数组接口兼容"
                )
                for width in (1440, 1024, 390, 320):
                    page.set_viewport_size({"width": width, "height": 1100})
                    for name in ("cases", "history"):
                        nav(name)
                        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"), (
                            width,
                            name,
                        )
                assert not report["pageErrors"], report["pageErrors"]
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
