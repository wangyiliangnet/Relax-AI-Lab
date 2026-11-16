"""Run one fixed corpus against saved Lab prompt versions through the service."""

import argparse
import json
from collections import Counter

import httpx


def evaluate(client, args):
    catalog = client.get("/lab/cases").raise_for_status().json()
    selected = [
        case
        for case in catalog
        if (args.suite is None or case["suite"] == args.suite) and (not args.case or case["id"] in args.case)
    ]
    missing = set(args.case or []) - {case["id"] for case in selected}
    if missing:
        raise ValueError("所选用例集没有这些 ID：" + ", ".join(sorted(missing)))
    if args.list:
        return selected, 0
    if not args.version:
        raise ValueError("运行用例需要 --version，可重复指定以比较版本。")
    versions = list(dict.fromkeys(args.version))
    available = {entry["name"] for entry in client.get("/lab/prompts").raise_for_status().json()}
    unknown = set(versions) - available
    if unknown:
        raise ValueError("Lab 尚未保存这些版本：" + ", ".join(sorted(unknown)))
    options = client.get("/lab/profile").raise_for_status().json()["options"]
    options.pop("promptVersion")
    options["provider"] = args.provider
    counts = {version: Counter() for version in versions}
    output = {"options": options, "versions": versions, "summary": counts, "cases": []}
    exit_code = 0
    for case in selected:
        row = {"id": case["id"], "review": case["review"], "byVersion": {}}
        output["cases"].append(row)
        for version in versions:
            try:
                response = client.post(
                    f"/lab/cases/{case['id']}/run",
                    json={"options": {**options, "promptVersion": version}},
                ).raise_for_status()
            except httpx.HTTPError as exc:
                output["stopped"] = {"caseID": case["id"], "version": version, "error": str(exc)}
                return output, 2
            report = response.json()
            verdict = report["verdict"]
            counts[version][verdict] += 1
            row["byVersion"][version] = {
                key: value
                for key, value in report.items()
                if key not in {"caseID", "suite", "version", "review"}
            }
            if verdict == "execution_error":
                output["stopped"] = {
                    "caseID": case["id"],
                    "version": version,
                    "error": report["serviceError"],
                }
                return output, 2
            if verdict not in {"passed", "mock", "expected_input_rejection"}:
                exit_code = 1
    return output, exit_code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--version", action="append", help="Lab 中已保存的版本名，可重复")
    parser.add_argument("--case", action="append", help="只运行指定的 case ID，可重复")
    parser.add_argument("--suite", choices=["main", "holdout"])
    parser.add_argument("--provider", choices=["mock", "deepseek"], default="mock")
    parser.add_argument("--list", action="store_true", help="显示所选用例与人工检查项")
    parser.add_argument("--timeout", type=float, default=180, help="单条 HTTP 请求超时秒数")
    args = parser.parse_args()
    try:
        with httpx.Client(base_url=args.base_url, timeout=args.timeout) as client:
            output, code = evaluate(client, args)
    except (httpx.HTTPError, ValueError) as exc:
        output, code = {"error": str(exc)}, 2
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
